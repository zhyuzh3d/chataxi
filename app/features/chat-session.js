(function (app) {
  "use strict";
  var store = app.data.store;
  var tasks = {};
  // 正在跑的绘图任务，按对话 id 索引。它**不属于** tasks[id]：绘图是这一轮结束之后的
  // 收尾动作，不能占着"当前对话正在回复"的位置（否则用户要等几分钟才能说下一句），
  // 也不能拖住自动朗读。要放弃它只有一条路：用户在**那一条图片消息**上按「停止」
  // （走 cancelDraw）。对话级的 stop() 不碰它 —— 见下面 stop() 的注释。
  var drawTasks = {};

  function changed(id, phase, detail) { app.events.emit("chat:changed", Object.assign({ conversationId: id, phase: phase }, detail || {})); }
  function cancelled() { var error = new Error("本轮已停止"); error.cancelled = true; return error; }

  function contextBefore(messages, targetId) {
    var index = messages.findIndex(function (message) { return message.id === targetId; });
    if (index < 0) throw new Error("找不到待重试的消息");
    return messages.slice(0, index).filter(function (message) { return message.status === "done"; });
  }

  async function outputImages(images) {
    var media = [];
    try {
      for (var i = 0; i < (images || []).length; i += 1) {
        var item = images[i];
        if (!app.utils.isAllowedImageUrl(item.dataUrl)) continue;
        var parts = app.utils.dataUrlToParts(item.dataUrl);
        if (parts) {
          var record = await app.data.media.put(app.utils.base64ToBlob(parts.data, parts.mime), { name: "ai-image", mime: parts.mime });
          media.push({ mediaId: record.id, mime: parts.mime, alt: item.alt || "AI 图片" });
        } else media.push({ url: item.dataUrl, alt: item.alt || "AI 图片" });
      }
      return media;
    } catch (error) {
      for (var j = 0; j < media.length; j += 1) if (media[j].mediaId) await app.data.media.remove(media[j].mediaId).catch(function () {});
      throw error;
    }
  }

  async function refreshPreview(id) {
    var conversation = await store.get("conversations", id);
    if (!conversation) return;
    var messages = await store.messages(id);
    var last = messages.filter(function (message) { return message.status === "done"; }).pop();
    conversation.lastMessage = last ? (last.text || "[图片]").slice(0, 160) : "";
    conversation.updatedAt = Date.now();
    await store.put("conversations", id, conversation);
  }

  // 执行一条绘图动作。位置动作的语义：一个模型回复会被拆成「文本消息 + 图片消息」两条，
  // 这一条永远是新插入的 assistant 消息（text 恒为空 ⇒ 不朗读、不进下一轮的图片字节）。
  // 这里是**分离的异步任务**（调用方不 await），所以每一步都要自己落到库里。
  async function runDraw(id, role, anchor, action, existing, rawText) {
    var conversation = await store.get("conversations", id);
    if (!conversation) return;
    var messages = await store.messages(id);
    var timestamp = Math.max(Date.now(), messages.length ? messages[messages.length - 1].createdAt + 1 : 0);
    // 先定下"用哪张卡片、哪一项能力"，再建消息 —— 要把它们**记进消息本身**（业主 2026-09-27：
    // 重新生成要照当初那张画）。重新绘制优先用消息里记下的那张：用户中途换了默认卡片、或插件
    // 目录变了，也照原样重来；旧消息没记、卡片被删了才退到当前可用的第一张。
    // 只记卡片与能力，不记画幅 / 步数 / 参考强度 —— 那几项由插件的能力目录说了算，
    // 抄一份进消息只会变成第二份真相，插件一改就会打架。
    var card = null;
    try { card = existing && existing.draw && existing.draw.profileId ? await app.services.draw.resolveCard(existing.draw.profileId, existing.draw.modelId) : await app.services.draw.available(); } catch (_) { card = null; }
    var recorded = { prompt: action.prompt, selfPortrait: Boolean(action.selfPortrait), profileId: card ? String(card.profile.id || "") : "", modelId: card ? String(card.modelId || "") : "" };
    var message = existing || {
      id: app.utils.id("message"),
      conversationId: id,
      kind: "assistant",
      roleId: role.id,
      roleName: role.name,
      replyTo: (anchor && anchor.replyTo) || "",
      text: "",
      // 模型写下的**原文**（含动作块）。正文为空时这条绘图消息就是它的唯一载体，
      // 上下文组装要靠它把"我当初是怎么写的"原样交给模型（见 plan §⑲）。
      rawText: String(rawText || ""),
      media: [],
      draw: recorded,
      status: "drawing",
      error: "",
      createdAt: timestamp
    };
    if (existing) {
      // 重画沿用同一条消息：用户看到的是同一个图片位在重新出图，而不是又长出一条记录。
      message.status = "drawing"; message.error = ""; message.media = [];
      message.draw = recorded;
    }
    await store.putMessage(message);
    changed(id, "updated", { message: message });

    function fail(reason) {
      message.status = reason && reason.cancelled ? "cancelled" : "error";
      message.error = reason && reason.cancelled ? "本轮已停止" : app.utils.cleanError(reason);
      return store.putMessage(message).then(function () { return refreshPreview(id); }).then(function () { changed(id, "updated", { message: message }); });
    }

    if (!card) return fail(new Error("这一轮要求画图，但当前没有可用的绘图模型，请先在模型页配置一张绘图卡片"));

    // 参考图不由模型决定：它只说"画我自己"，定妆照由这里顶上去。没有定妆照就退化成纯文生图。
    // 但读取失败**不能**静默吞掉（业主 2026-09-27 要求确认定妆照真的发出去了）：一旦读不到就
    // 悄悄当成"没有参考图"，画出来是另一张脸，而界面上只会显示插件回的 bad_image，
    // 用户根本猜不到问题出在定妆照上。所以这里失败就地报错，说清是哪一步断了。
    // 位置也重要：这一步必须在 drawTasks[id] 占位之前，否则提前 return 会把这个对话永久锁成"正在绘制"。
    var reference = "";
    if (action.selfPortrait && role.portraitMediaId) {
      // 文案写成「前缀 + 原因」两段，和绘图错误同一套写法：翻译表里一条键配一条规则就够，
      // 拆在括号两侧会让提取器把后半句单独算成未覆盖文案。
      try { reference = await app.services.draw.portraitReference(role.portraitMediaId); }
      catch (error) { return fail(new Error("定妆照没能读出来，请重新设置一张再试：" + app.utils.cleanError(error))); }
      if (!reference) return fail(new Error("定妆照没能读出来，请重新设置一张再试：这张定妆照的记录已经不存在了"));
    }
    var task = app.services.draw.newTask();
    drawTasks[id] = task;
    var lastProgress = "";
    try {
      var produced = await app.services.draw.generate({
        profile: card.profile,
        modelId: card.modelId,
        prompt: action.prompt,
        referenceDataUrl: reference,
        task: task,
        onProgress: function (text) {
          // 同一句话不重复播报：否则每次轮询都会重建整个消息列表。
          if (!text || text === lastProgress) return;
          lastProgress = text; changed(id, "media", { text: text });
        }
      });
      var record = await app.data.media.put(produced.blob, { name: "ai-image", mime: produced.mime });
      message.media = [{ mediaId: record.id, mime: produced.mime || "image/png", alt: action.prompt }];
      message.draw.reference = Boolean(reference);
      message.draw.jobId = String((produced.job && produced.job.id) || "");
      message.status = "done";
      message.error = "";
    } catch (error) {
      delete drawTasks[id];
      return fail(error);
    }
    delete drawTasks[id];
    // 绘图现在可能比"这个对话还开着"活得更久（action 不受对话控制）, 于是"画到一半对话被删掉"
    // 成为真的可能。那种情况下这条消息不该再落库: 否则会留下一条指向已删对话的孤儿记录,
    // 而它刚上传的图片字节也没有任何地方会去释放。
    if (!(await store.get("conversations", id))) { await store.releaseMedia(message.media); return; }
    await store.putMessage(message);
    await refreshPreview(id);
    changed(id, "updated", { message: message });
  }

  // 图片消息的「重新绘制」：动作本身已经存在消息里（draw.prompt / selfPortrait），
  // 不用再问模型一遍 —— 直接照原样重跑，只是会得到另一张图。
  async function retryDraw(conversationId, messageId) {
    if (drawTasks[conversationId]) throw new Error("这个对话正在绘制图片，请稍候");
    var messages = await store.messages(conversationId);
    var message = messages.filter(function (item) { return item.id === messageId; })[0];
    if (!message || !message.draw || !message.draw.prompt) throw new Error("这条图片消息没有可以重画的要求");
    var role = await store.get("roles", message.roleId);
    if (!role) throw new Error("这条消息的角色已不存在，无法确定是否使用定妆照");
    var action = { type: "draw", prompt: message.draw.prompt, selfPortrait: Boolean(message.draw.selfPortrait) };
    await runDraw(conversationId, role, message, action, message);
  }

  async function run(id, options) {
    if (tasks[id]) throw new Error("当前对话正在回复，请等待或停止本轮");
    var task = { cancelled: false, label: "正在准备…", phase: "preparing" };
    task.stopPromise = new Promise(function (resolve) { task.resolveStop = resolve; });
    tasks[id] = task;
    var pending = null;
    var lastSuccessful = null;
    try {
      var conversation = await store.get("conversations", id);
      if (!conversation) throw new Error("对话不存在");
      var messages = await store.messages(id);
      var roles = await store.list("roles");
      var profiles = await store.list("llm-profiles");
      var settings = await store.get("meta", "settings");
      var globalUserProfile = await store.get("meta", "user-profile") || { name: "我", introduction: "", avatarMediaId: "" };
      var resolvedUserProfile = app.services.profiles.userForConversation(conversation, globalUserProfile);
      var userContext = { name: resolvedUserProfile.name, introduction: resolvedUserProfile.introduction };
      var retry = options.retryId ? messages.find(function (message) { return message.id === options.retryId; }) : null;
      var resume = options.resumeUserId ? messages.find(function (message) { return message.id === options.resumeUserId && message.kind === "user"; }) : null;
      if (options.resumeUserId && !resume) throw new Error("找不到要继续生成的用户消息");
      if (options.retryId && (!retry || retry.kind !== "assistant" || ["error", "cancelled"].indexOf(retry.status) < 0)) throw new Error("这条消息不需要重试");
      var participants = conversation.roleIds.map(function (roleId) { return roles.find(function (item) { return item.id === roleId; }); }).filter(Boolean);
      var roleIds = retry ? [retry.roleId] : conversation.roleIds.filter(function (roleId) { return (options.roleIds || conversation.roleIds).indexOf(roleId) >= 0; });
      var timestamp = Math.max(Date.now(), messages.length ? messages[messages.length - 1].createdAt + 1 : 0);
      var userMessage = resume || null;
      if (!retry && !resume && conversation.kind === "group" && conversation.autoSelectRole) {
        if (participants.length !== conversation.roleIds.length) throw new Error("自动选角前请先修复对话中缺失的参与角色");
        participants.forEach(function (role) {
          var reason = app.services.profiles.roleStatus(role, profiles);
          if (reason) throw new Error(role.name + "：" + reason + "，自动选角只会使用当前全部可用的参与角色");
        });
        var moderatorId = conversation.moderatorRoleId && conversation.roleIds.indexOf(conversation.moderatorRoleId) >= 0 ? conversation.moderatorRoleId : conversation.roleIds[0];
        var moderator = participants.find(function (role) { return role.id === moderatorId; });
        if (!moderator) throw new Error("当前对话没有可用主持人，请重新保存基础设定");
        var proposedText = String(options.text || "").trim();
        if (!proposedText && options.continueOnly) proposedText = "请你们自主回答。";
        if (!proposedText && !(options.media || []).length) throw new Error("请输入文字或选择图片、视频");
        userMessage = { id: options.userMessageId || app.utils.id("message"), conversationId: id, kind: "user", text: proposedText, media: options.media || [], status: "done", createdAt: timestamp++ };
        await store.putMessage(userMessage);
        messages.push(userMessage);
        changed(id, "accepted", { message: userMessage });
        await store.remove("drafts", id);
        await refreshPreview(id);
        task.phase = "routing";
        task.label = "正在请主持人 " + moderator.name + " 选择回复角色";
        task.generateLabel = task.label;
        changed(id, "routing", { moderatorRoleId: moderator.id, moderatorRoleName: moderator.name });
        var routingStartedAt = Date.now(), routedRole, routingFallback = false, routingError = "";
        try {
          routedRole = await Promise.race([
            app.services.llm.selectRole(moderator, participants, messages, task, conversation, userContext),
            task.stopPromise.then(function () { throw cancelled(); })
          ]);
        } catch (error) {
          if (error.cancelled || task.cancelled) throw error;
          routedRole = participants[Math.floor(Math.random() * participants.length)];
          routingFallback = true;
          routingError = app.utils.cleanError(error);
        }
        if (task.cancelled) throw cancelled();
        var routingTrace = task.routingTrace || {}, routingCompletedAt = Date.now();
        await store.putMessage({
          id: app.utils.id("routing"),
          conversationId: id,
          kind: "routing",
          status: routingFallback ? "error" : "done",
          moderatorRoleId: moderator.id,
          moderatorRoleName: moderator.name,
          candidateRoleIds: participants.map(function (role) { return role.id; }),
          candidateRoleNames: participants.map(function (role) { return role.name; }),
          selectedRoleId: routedRole.id,
          selectedRoleName: routedRole.name,
          fallback: routingFallback,
          text: String(routingTrace.outputText || ""),
          error: routingError,
          serviceId: routingTrace.serviceId || moderator.llmProfileId || "",
          serviceName: routingTrace.serviceName || "",
          modelId: routingTrace.modelId || moderator.model || "",
          protocol: routingTrace.protocol || "",
          responseId: routingTrace.responseId || "",
          usage: routingTrace.usage || null,
          userMessageId: userMessage.id,
          startedAt: routingStartedAt,
          completedAt: routingCompletedAt,
          durationMs: Math.max(0, routingCompletedAt - routingStartedAt),
          createdAt: timestamp++
        });
        roleIds = [routedRole.id];
        conversation.activeRoleIds = roleIds.slice();
        conversation.updatedAt = Date.now();
        await store.put("conversations", id, conversation);
        changed(id, "routed", { roleId: routedRole.id, roleName: routedRole.name, moderatorRoleId: moderator.id, fallback: routingFallback, error: routingError });
      }
      if (!roleIds.length || (conversation.kind === "single" && roleIds.length !== 1)) throw new Error("请选择本轮回复角色");
      var selected = roleIds.map(function (roleId) {
        var role = roles.find(function (item) { return item.id === roleId; });
        var reason = role ? app.services.profiles.roleStatus(role, profiles) : "角色不存在";
        if (reason) throw new Error((role ? role.name + "：" : "") + reason + "，请在角色页修复");
        return role;
      });
      var autoSpeak = (conversation.autoSpeak == null ? Boolean(settings.autoSpeak) : Boolean(conversation.autoSpeak)) && !conversation.ttsMuted;
      function canAutoSpeak() { return autoSpeak && !(app.services.tts.isMuted && app.services.tts.isMuted()) && app.state.activeConversationId === id; }
      if (task.cancelled) throw cancelled();
      if (!retry && !resume && !userMessage) {
        var text = String(options.text || "").trim();
        if (!text && options.continueOnly) text = selected.map(function (role) { return "@" + role.name; }).join(" ") + " 请继续回答。";
        if (!text && !(options.media || []).length) throw new Error("请输入文字或选择图片、视频");
        userMessage = { id: options.userMessageId || app.utils.id("message"), conversationId: id, kind: "user", text: text, media: options.media || [], status: "done", createdAt: timestamp++ };
        await store.putMessage(userMessage);
        messages.push(userMessage);
        // The accepted user message owns its attachments, even if clearing the draft fails.
        changed(id, "accepted", { message: userMessage });
        await store.remove("drafts", id);
        await refreshPreview(id);
      }
      for (var i = 0; i < selected.length; i += 1) {
        if (task.cancelled) break;
        var role = selected[i];
        var history = retry ? contextBefore(messages, retry.id) : messages.filter(function (message) { return message.status === "done"; });
        pending = retry ? Object.assign({}, retry, { status: "pending", error: "" }) : { id: app.utils.id("message"), conversationId: id, kind: "assistant", roleId: role.id, roleName: role.name, replyTo: userMessage && userMessage.id || "", text: "", media: [], status: "pending", createdAt: timestamp++ };
        await store.putMessage(pending);
        task.label = "正在等待 " + role.name + " · " + (i + 1) + "/" + selected.length;
        task.generateLabel = task.label;
        task.onMediaState = function (text) { task.label = text; changed(id, "media", { text: text }); };
        task.phase = "generating";
        changed(id, "generating", { message: pending, roleId: role.id, roleName: role.name });
        var voiceStream = null, spokenLength = 0;
        if (canAutoSpeak() && i === selected.length - 1) {
          try { voiceStream = await app.services.tts.createStream(role, pending.id, { autoPlay: true, minBufferSeconds: 3 }); }
          catch (voiceError) { changed(id, "notice", { text: "流式朗读不可用，将在回复完成后处理：" + app.utils.cleanError(voiceError) }); }
        }
        task.onStreamRetry = async function () {
          if (!pending || task.cancelled) return;
          clearTimeout(task.partialSaveTimer); task.partialSaveTimer = null;
          pending.text = ""; spokenLength = 0;
          changed(id, "delta", { messageId: pending.id, text: "", fallback: false });
          await store.putMessage(pending);
          if (voiceStream) await app.services.tts.stop().catch(function () {});
          voiceStream = null;
          changed(id, "notice", { text: "网络连接意外中断，正在自动重试一次" });
          if (canAutoSpeak() && i === selected.length - 1) {
            try { voiceStream = await app.services.tts.createStream(role, pending.id, { autoPlay: true, minBufferSeconds: 3 }); }
            catch (voiceError) { changed(id, "notice", { text: "流式朗读不可用，将在回复完成后处理：" + app.utils.cleanError(voiceError) }); }
          }
        };
        task.onDelta = function (update) {
          if (!pending || task.cancelled) return;
          pending.text = update.text || "";
          changed(id, "delta", { messageId: pending.id, text: pending.text, fallback: Boolean(update.fallback) });
          clearTimeout(task.partialSaveTimer);
          task.partialSaveTimer = setTimeout(function () { if (pending && !task.cancelled) store.putMessage(pending).catch(function () {}); }, 350);
          if (voiceStream && pending.text.length > spokenLength) { voiceStream.append(pending.text.slice(spokenLength)); spokenLength = pending.text.length; }
        };
        var action = null;
        try {
          var result = await Promise.race([
            app.services.llm.complete(role, history, task, conversation, participants, userContext),
            task.stopPromise.then(function () { throw cancelled(); })
          ]);
          if (task.cancelled) throw cancelled();
          pending.text = result.text;
          // **原文必须跟着一起落库**（含动作块）。`settle()` 把「切过的正文 text」和「模型原文 rawText」
          // 都交给了我们，只抄 text 就等于把「我当初是怎么写动作块的」这份唯一的自我范例**在内存里丢掉** ——
          // 2026-09-27 实测踩中：模型第一轮凭 systemPrompt 写出了块、正常出图（147 token），第二轮起
          // 再也不写（输出掉到 49~65 token），因为历史里那条正例被抽掉了「因」（plan §㉑）。
          // 显示 / 朗读 / 预览读的是 text，所以这一行不影响任何界面。
          pending.rawText = String(result.rawText == null ? result.text : result.rawText);
          // 畸形动作块（JSON 解析不出来）会被静默丢弃, 落库后与「模型压根没写」长得一模一样。
          // 记下来是为了**判得出来**：设备上一读就知道这一轮是"没写"还是"写了没解析出来"。
          // （根治畸形块不在本轮范围; 这里只保证记录说的是实话。）
          pending.actionBroken = Boolean(result.actionBroken);
          pending.usage = result.usage;
          pending.reasoning = result.reasoning || "";
          pending.finishReason = result.finishReason || "";
          pending.providerState = result.providerState || null;
          pending.streamed = Boolean(result.streamed);
          pending.streamFallback = Boolean(task.streamingFallback);
          pending.contextTrimmed = result.contextTrimmed;
          pending.contextCompressed = result.contextCompressed;
          pending.media = await outputImages(result.images);
          if (task.cancelled) {
            await store.releaseMedia(pending.media);
            pending.media = []; pending.text = ""; throw cancelled();
          }
          pending.status = "done"; pending.error = "";
          if (result.action && result.action.type === "draw") action = result.action;
          if (voiceStream) voiceStream.finish(result.text).catch(function (error) {
            var fallback = !voiceStream.started;
            changed(id, "notice", { text: (fallback ? "流式朗读不可用，已改用完整音频：" : "流式朗读中断：") + app.utils.cleanError(error) });
            if (fallback && !task.cancelled && canAutoSpeak()) app.services.tts.speak(result.text, role).catch(function (fallbackError) { changed(id, "notice", { text: "自动朗读失败：" + app.utils.cleanError(fallbackError) }); });
          });
          lastSuccessful = { message: pending, role: role, voiceStream: voiceStream };
        } catch (error) {
          if (voiceStream) await app.services.tts.stop().catch(function () {});
          pending.status = error.cancelled ? "cancelled" : "error";
          pending.error = error.cancelled ? "本轮已停止" : app.utils.cleanError(error);
          if (error.cancelled) pending.text = "";
        }
        clearTimeout(task.partialSaveTimer); task.partialSaveTimer = null; task.onDelta = null; task.onStreamRetry = null; task.onMediaState = null; task.streamingFallback = false;
        var completedMessage = pending;
        // 正文为空且这一轮带绘图动作：不产生文本消息，只留下即将出现的图片消息。
        // （模型本来就是一条回复拆两条；正文为空只是不生成第一条。）
        // **但原文不能跟着一起丢**：它是那条动作块在历史里的唯一载体，下面交给绘图消息一起存。
        // 注意 pending 必须先留着：下面任何一次写库失败都会走外层 catch，靠它把消息落成
        // "可重试"的状态；提前置空就会留下一条永远 "pending" 的死消息。
        var carryRaw = "";
        if (action && !completedMessage.text && completedMessage.status === "done") {
          carryRaw = String(completedMessage.rawText || "");
          await store.removeMessage(completedMessage);
          if (!retry) {
            var index = messages.map(function (item) { return item.id; }).indexOf(completedMessage.id);
            if (index >= 0) messages.splice(index, 1);
          }
          changed(id, "removed", { messageId: completedMessage.id });
        } else {
          await store.putMessage(completedMessage);
          if (!retry) messages.push(completedMessage);
          await refreshPreview(id);
          changed(id, "updated", { message: completedMessage });
        }
        pending = null;
        // 绘图不 await：它要跑几十秒到几分钟，占住 tasks[id] 会让用户没法说下一句，
        // 也会把最后一条的自动朗读一直压住。进度与结果都通过 chat:changed 回来。
        if (action && completedMessage.status === "done") {
          changed(id, "media", { text: "正在按这一轮的要求绘制图片…" });
          runDraw(id, role, completedMessage, action, null, carryRaw).catch(function (error) {
            changed(id, "notice", { text: "绘图失败：" + app.utils.cleanError(error) });
          });
        }
      }
      if (!task.cancelled && canAutoSpeak() && lastSuccessful && !lastSuccessful.voiceStream && lastSuccessful.message.text) {
        app.services.tts.speak(lastSuccessful.message.text, lastSuccessful.role).catch(function (error) { changed(id, "notice", { text: "自动朗读失败：" + app.utils.cleanError(error) }); });
      }
    } catch (error) {
      if (pending) {
        pending.status = task.cancelled ? "cancelled" : "error";
        pending.error = app.utils.cleanError(error);
        await store.putMessage(pending).catch(function () {});
      }
      if (!error.cancelled) throw error;
    } finally {
      clearTimeout(task.partialSaveTimer);
      delete tasks[id];
      changed(id, "idle", { stopped: task.cancelled });
    }
  }

  function stop(id) {
    // **绘图（action）不受对话控制**（业主 2026-09-27: "action 不受对话控制, 不因对话停止而终止
    // 行为"）。这里曾经顺手把 drawTasks[id] 也取消掉, 那等于让一次要跑几十秒到几分钟的出图
    // 跟着"点一下停止"或"退出这个对话"一起死掉, 而用户看到的只是图片再也没出来。
    // 绘图有自己的生命周期: 它跑完就把结果落库, 下次打开对话照样看得见; 要中途放弃这一张,
    // 只有**那一条图片消息**上的「停止」（cancelDraw）或让它自己失败。所以 stop() 只停文本
    // 生成与朗读, drawTasks 一律不碰 —— 这也是"绘图不占 tasks[id]"这条设计的另一半
    // （见文件头的 drawTasks 注释）。
    var task = tasks[id];
    if (!task) return;
    task.cancelled = true;
    if (task.controller) task.controller.abort();
    task.resolveStop();
    changed(id, "stopping");
  }

  // 只取消绘图, 不碰文本生成 —— 生图消息气泡上的那个「停止」按的就是这一条。
  // 与 stop() 的分工是刻意的: 两条任务本来就有各自的生命周期（见文件头 drawTasks 注释）,
  // 而且它们**可以同时在跑**（正文还在流式输出时, 上一轮的图已经在画了）—— 一个按钮不该
  // 顺手把另一条也掐掉。返回 false 表示此刻没有正在跑的绘图（那张图多半刚好画完了）。
  function cancelDraw(id) {
    var task = drawTasks[id];
    if (!task) return false;
    task.cancelled = true;
    if (task.controller) task.controller.abort();
    return true;
  }

  // 打开对话时的对账：把"还写着 drawing / pending 但实际已经没有人在做"的消息判成中断。
  // 这是"程序退出 / 无法继续"那一档唯一该出现的提示（业主 2026-09-27）。
  async function recover(id, knownMessages) {
    if (tasks[id]) return;
    var messages = knownMessages || await store.messages(id);
    // 绘图是**分离**的任务: tasks[id] 空着不代表没有活在跑（见文件头注释）。漏判这一条,
    // "退出对话 → 再进来看看画好没有"就会把一张正在画的图当场判成"已中断", 而且之后绘图真的
    // 完成时还会覆盖掉这条判断 —— 界面先报错再突然变出图片。
    var drawing = Boolean(drawTasks[id]);
    for (var i = 0; i < messages.length; i += 1) {
      var status = messages[i].status;
      if (status === "drawing" && drawing) continue;
      if (status === "pending" || status === "drawing") {
        messages[i].status = "error";
        messages[i].error = status === "drawing" ? "上次绘图已中断，可以重新绘制这一条" : "上次生成已中断，可重试这条消息";
        await store.putMessage(messages[i]);
      }
    }
  }

  app.features = app.features || {};
  app.features.chatSession = { run: run, stop: stop, cancelDraw: cancelDraw, retryDraw: retryDraw, active: function (id) { return tasks[id] || null; }, drawing: function (id) { return drawTasks[id] || null; }, contextBefore: contextBefore, recover: recover, refreshPreview: refreshPreview };
})(window.chataxi);
