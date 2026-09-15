(function (app) {
  "use strict";
  var store = app.data.store;
  var tasks = {};

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
        if (autoSpeak && i === selected.length - 1 && app.state.activeConversationId === id) {
          try { voiceStream = await app.services.tts.createStream(role, pending.id, { autoPlay: true, minBufferSeconds: 3 }); }
          catch (voiceError) { changed(id, "notice", { text: "流式朗读不可用，将在回复完成后处理：" + app.utils.cleanError(voiceError) }); }
        }
        task.onDelta = function (update) {
          if (!pending || task.cancelled) return;
          pending.text = update.text || "";
          changed(id, "delta", { messageId: pending.id, text: pending.text, fallback: Boolean(update.fallback) });
          clearTimeout(task.partialSaveTimer);
          task.partialSaveTimer = setTimeout(function () { if (pending && !task.cancelled) store.putMessage(pending).catch(function () {}); }, 350);
          if (voiceStream && pending.text.length > spokenLength) { voiceStream.append(pending.text.slice(spokenLength)); spokenLength = pending.text.length; }
        };
        try {
          var result = await Promise.race([
            app.services.llm.complete(role, history, task, conversation, participants, userContext),
            task.stopPromise.then(function () { throw cancelled(); })
          ]);
          if (task.cancelled) throw cancelled();
          pending.text = result.text;
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
          if (voiceStream) voiceStream.finish(result.text).catch(function (error) {
            var fallback = !error.streamReceived;
            changed(id, "notice", { text: (fallback ? "流式朗读不可用，已改用完整音频：" : "流式朗读中断：") + app.utils.cleanError(error) });
            if (fallback && !task.cancelled && app.state.activeConversationId === id) app.services.tts.speak(result.text, role).catch(function (fallbackError) { changed(id, "notice", { text: "自动朗读失败：" + app.utils.cleanError(fallbackError) }); });
          });
          lastSuccessful = { message: pending, role: role, voiceStream: voiceStream };
        } catch (error) {
          if (voiceStream) await app.services.tts.stop().catch(function () {});
          pending.status = error.cancelled ? "cancelled" : "error";
          pending.error = error.cancelled ? "本轮已停止" : app.utils.cleanError(error);
          if (error.cancelled) pending.text = "";
        }
        clearTimeout(task.partialSaveTimer); task.partialSaveTimer = null; task.onDelta = null; task.onMediaState = null; task.streamingFallback = false;
        await store.putMessage(pending);
        if (!retry) messages.push(pending);
        var completedMessage = pending;
        pending = null;
        await refreshPreview(id);
        changed(id, "updated", { message: completedMessage });
      }
      if (!task.cancelled && autoSpeak && lastSuccessful && !lastSuccessful.voiceStream && lastSuccessful.message.text && app.state.activeConversationId === id) {
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
    var task = tasks[id];
    if (!task) return;
    task.cancelled = true;
    if (task.controller) task.controller.abort();
    task.resolveStop();
    changed(id, "stopping");
  }

  async function recover(id, knownMessages) {
    if (tasks[id]) return;
    var messages = knownMessages || await store.messages(id);
    for (var i = 0; i < messages.length; i += 1) {
      if (messages[i].status === "pending") {
        messages[i].status = "error"; messages[i].error = "上次生成已中断，可重试这条消息";
        await store.putMessage(messages[i]);
      }
    }
  }

  app.features = app.features || {};
  app.features.chatSession = { run: run, stop: stop, active: function (id) { return tasks[id] || null; }, contextBefore: contextBefore, recover: recover, refreshPreview: refreshPreview };
})(window.chataxi);
