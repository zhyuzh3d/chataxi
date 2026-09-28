(function (app) {
  "use strict";

  // 画出来的图片**不以字节进上下文**：字节是几 MB, 塞进每一轮请求既慢又没用。
  // 但"上一轮到底发生了什么"必须**如实**告诉模型, 因为回执就是它的因果证据。
  //
  // 旧版这里写的是 `[系统附注] 你的上一条回复附了一张已生成的图片, 画面：<prompt>`,
  // 它是**那条绘图消息自己的文本**, 挂在 assistant 名下 ⇒ 模型把它读成"我自己说过的话";
  // 而它所指的"上一条回复"里其实只有一句「我画一张给你看吧」, 没有任何动作。**因果整个是反的**：
  // 实测 11 组这样的正例把模型的归纳钉死成"我说一句话 → 系统就给我一行有图的附注",
  // 于是它只需要说, 不需要写动作块 —— 这就是"画几次之后死也不画"的来源（见 plan §⑲）。
  //
  // 现在改成**本机程序对那条动作块的回执**, 三条硬要求：
  //   1. **user 身份, 不是 system。** system 会被 `providers.mapSystemMessages` 抽出来集中拼到
  //      请求最前面, 位置全丢, 回执就跟它要说明的那条动作块脱开了。user 身份位置准确, 而且
  //      不会被 assistant 读成"我自己说过的话"（业主 2026-09-27 的判断）。
  //   2. **三态都要有**。只有成功留痕的话, 「写了块但失败」和「根本没写块」在历史里长得一样,
  //      模型学不到区别 —— 而那正是它最需要区分的。取消也一样要写。
  //   3. **不给图像地址。** `/__haminn/files/<id>` 这个可复制的 URL 形态, 正是模型抄进正文
  //      当图片的那半截（业主 2026-09-27 现场：「发送了一个图片：23岁……还带文件地址 /haminn/…」）。
  //      模型并不需要用地址做任何事, 它只需要知道"图已经出来了"。
  function drawReceipt(message) {
    var drawn = message && message.draw && message.draw.prompt;
    if (!drawn || message.status === "drawing") return "";
    // 回执说的是「你上一条消息里的动作块」, 所以**只有我们确实为那一轮留了原文**时才敢这么说。
    // v0.7.39 之前的记录一个字段都没留(rawText 不存在), 对它们发回执等于用历史当场把提示词里
    // 「只有你写了动作块的回合才会有这条回执」这条规则证伪 —— 而旧对话恰恰是最容易被拿来试的
    // 地方。旧记录一律不发, 它们与改动前完全一样(不迁移, 不伪造)。
    if (!Object.prototype.hasOwnProperty.call(message, "rawText")) return "";
    if (message.status === "error") return "[本机系统消息] 执行你上一条消息里的绘图动作块时出错: " + (String(message.error || "").trim() || "未知原因") + "。图片没有生成。";
    if (message.status === "cancelled") return "[本机系统消息] 你上一条消息里的绘图动作块已被取消, 没有生成图片。";
    return "[本机系统消息] 系统已经成功执行你上一条消息里的绘图动作块, 图片已经生成并显示在对话里。";
  }

  async function hydrateMessages(messages, settings, activeRole, service, profile, task) {
    var hydrated = [];
    for (var index = 0; index < messages.length; index += 1) {
      var message = messages[index];
      var system = message.kind === "system" || message.role === "system";
      var assistant = message.kind === "assistant";
      var activeHistory = assistant && (!activeRole || message.roleId === activeRole.id || (!message.roleId && message.roleName === activeRole.name));
      var output = {
        role: system ? "system" : activeHistory ? "assistant" : "user",
        roleName: activeHistory ? message.roleName || "" : "",
        speakerKind: system ? message.systemType || "system" : assistant ? (activeHistory ? "active-role-history" : "other-role-history") : "user",
        systemType: system ? message.systemType || "system" : "",
        text: assistant && !activeHistory ? "其他角色「" + (message.roleName || "未命名角色") + "」的历史发言（仅作上下文参考，禁止模仿、代替或续写该角色）：\n" + (message.text || "") : message.text || "",
        images: [],
        videos: []
      };
      if (!assistant) {
        var sourceMedia = message.media || [];
        for (var mediaIndex = 0; mediaIndex < sourceMedia.length; mediaIndex += 1) {
          var prepared = await app.services.mediaPrep.hydrate(service, profile, sourceMedia[mediaIndex], settings, task);
          if ((prepared.kind || "").toLowerCase() === "video") output.videos.push(prepared);
          else output.images.push(prepared);
        }
      } else {
        // 助手消息进上下文一律用**原文**（含动作块）—— 这是模型唯一的「我当初是怎么做的」样本，
        // 拆掉它模型就只能自己编因果。显示/朗读/预览走的是另一份切过的 text，互不影响。
        var raw = String(message.rawText || message.text || "");
        if (raw) output.text = activeHistory ? raw : "其他角色「" + (message.roleName || "未命名角色") + "」的历史发言（仅作上下文参考，禁止模仿、代替或续写该角色）：\n" + raw;
        else output = null;
      }
      if (output) hydrated.push(output);
      // 绘图动作的执行回执：紧跟在那条消息之后。三态都发（成功 / 失败 / 取消）——
      // 只有成功留痕的话，"写了块但失败"与"根本没写块"在历史里长得一样，模型学不到区别。
      var receipt = assistant ? drawReceipt(message) : "";
      if (receipt) hydrated.push({ role: "user", roleName: "", speakerKind: "draw-receipt", systemType: "", text: receipt, images: [], videos: [] });
    }
    return hydrated;
  }

  function truncate(messages, limit) {
    var selected = messages.slice(-Math.min(50, Math.max(5, Number(limit || 10))));
    var remaining = 48000, output = [];
    for (var index = selected.length - 1; index >= 0 && remaining > 0; index -= 1) {
      var message = selected[index], text = String(message.text || "");
      if (text.length > remaining) {
        message = Object.assign({}, message, { text: text.slice(-remaining), contextTruncated: true });
        output.unshift(message); break;
      }
      remaining -= text.length; output.unshift(message);
    }
    return output;
  }

  function roleNames(roleName, participantRoles) {
    var names = [roleName].concat((participantRoles || []).map(function (item) { return item && item.name; })).map(function (name) { return String(name || "").trim(); }).filter(Boolean);
    return names.filter(function (name, index) { return names.indexOf(name) === index; });
  }

  function inspectSpeaker(text, roleName, participantRoles) {
    var value = String(text || ""), leading = value.replace(/^\s+/, ""), names = roleNames(roleName, participantRoles), candidates = [];
    names.forEach(function (name) {
      ["[" + name + "]", "【" + name + "】", name + "：", name + ":"].forEach(function (token) { candidates.push({ name: name, token: token }); });
    });
    for (var i = 0; i < candidates.length; i += 1) {
      if (leading.indexOf(candidates[i].token) === 0) return { status: candidates[i].name === String(roleName || "").trim() ? "self" : "other", name: candidates[i].name, text: leading.slice(candidates[i].token.length).replace(/^\s+/, "") };
    }
    if (leading && candidates.some(function (candidate) { return candidate.token.indexOf(leading) === 0; })) return { status: "partial", text: "" };
    return { status: "none", text: value };
  }

  function enforceSpeaker(text, roleName, participantRoles, streaming) {
    var inspected = inspectSpeaker(text, roleName, participantRoles);
    if (inspected.status === "other") { var error = new Error("模型试图以其他角色「" + inspected.name + "」发言，本次回复已拦截，请重新生成"); error.speakerMismatch = true; throw error; }
    if (inspected.status === "partial" && streaming) return "";
    return inspected.status === "self" ? inspected.text.trim() : streaming ? inspected.text : String(inspected.text || "").trim();
  }

  function removeRoleEcho(text, roleName, participantRoles) {
    return enforceSpeaker(text, roleName, participantRoles, false);
  }

  function partialText(text, roleName, participantRoles) {
    return enforceSpeaker(text, roleName, participantRoles, true);
  }

  function routeTurn(messages, role) {
    return messages.concat([{ role: "user", roleName: "", speakerKind: "routing", images: [], text: "本轮身份路由：只有「" + role.name + "」被点名回答。请直接回答用户最后提出的问题；只扮演「" + role.name + "」，不得代替、模拟、续写其他角色或替他们编写台词，也不要输出任何角色署名。" }]);
  }

  function parseRoleChoice(text, roles) {
    var raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    var name = raw;
    try {
      var value = JSON.parse(raw);
      if (value && typeof value.role === "string") name = value.role.trim();
    } catch (_) {}
    name = String(name || "").trim();
    var matches = (roles || []).filter(function (role) { return String(role.name || "").trim() === name; });
    if (matches.length !== 1) throw new Error("主持人没有返回唯一且有效的参与角色名称，请重试或关闭自动选角");
    return matches[0];
  }

  function sceneModeInstruction(mode) {
    var instructions = {
      "闲聊": "以轻松自然的日常交流为核心，设计一个具体但不夸张的小事件、共同活动或偶遇，让人物关系和性格自然显现。可以适度描写天气、光线、声音等氛围细节，增强故事感，但不要预先替任何人说话或规定谈话结果。",
      "思辨": "以一个清晰、值得讨论且存在多种立场的主题为核心，交代讨论缘起、关键前提、现实约束或观点张力，并把问题开放给用户。场所与氛围最多用一两句简要交代，不渲染环境，不预设结论，也不要让角色提前发表完整观点。",
      "学习": "以正式、专注的学习讨论为核心，优先依据用户补充关键词和人物资料确定学科、知识点或技能任务；明确学习目标、已有材料或认知基础，以及当前需要分析、理解或解决的具体问题。环境最多用一两句简述，不写校园生活故事，不渲染氛围，保持严谨、专业、可继续深入提问的语气。",
      "工作": "以正式、专业的工作讨论为核心，优先依据用户补充关键词和人物资料确定项目、业务问题或专业任务；明确目标、参与者职责、已有信息、进展、约束，以及当前需要讨论或决策的关键事项。环境最多用一两句简述，不写办公室戏剧，不渲染氛围，不使用空泛的会议套话。",
      "倾诉": "以安全、私密且富有共情空间的交流为核心，通过一个具体的生活片段、情绪触发点或关系处境建立故事感，并适度描写环境与氛围来承托情绪。不要诊断、说教、急于给建议或替用户下结论，要保留用户决定说什么以及如何表达的主动权。"
    };
    return instructions[String(mode || "").trim()] || "结合人物关系设计自然、具体且便于继续交流的场景；环境描写保持克制，不替用户或角色预设台词与结论。";
  }

  async function selectRole(moderator, candidateRoles, messages, task, conversation, userProfile) {
    var names = {}, duplicate = "";
    (candidateRoles || []).forEach(function (role) { var name = String(role.name || "").trim(); if (names[name]) duplicate = name; names[name] = true; });
    if (duplicate) throw new Error("自动选角要求参与角色名称唯一，请先修改重复名称「" + duplicate + "」");
    if (!candidateRoles || !candidateRoles.length) throw new Error("当前对话没有可供主持人选择的角色");
    var service = await app.data.store.get("llm-profiles", moderator.llmProfileId);
    if (!service || service.enabled === false) throw new Error("主持人绑定的模型服务不存在或已停用");
    var profile = app.services.modelServices.resolveLlm(service, moderator);
    if (!profile.model) throw new Error("主持人没有选择具体模型");
    if (task) task.routingTrace = {
      serviceId: service.id || "",
      serviceName: service.name || "",
      modelId: profile.model,
      protocol: profile.apiStyle || "",
      outputText: "",
      responseId: "",
      usage: null
    };
    profile = Object.assign({}, profile, { allowImageGeneration: false, maxOutputTokens: 96, temperature: 0 });
    var settings = await app.data.store.get("meta", "settings");
    var context = await app.services.context.prepare(conversation, moderator, messages, settings, candidateRoles, userProfile);
    // 压缩是后台任务：如果它恰好在本轮启动，本轮状态仍然属于路由，不要被改写。
    // 候选角色一并带上行为指导：主持人据此判断谁更适合接这一轮。
    var roleReference = candidateRoles.map(function (role) {
      return app.services.context.roleReference(role);
    }).join("\n\n");
    var user = userProfile || {}, userName = String(user.name || "用户").trim() || "用户";
    var prompt = "你是群聊主持人「" + moderator.name + "」，本次只负责选择下一位最适合回答的参与角色，不要回答用户的问题。\n" +
      "必须且只能输出一行严格 JSON，格式为 {\"role\":\"完整角色名称\"}。role 的值必须逐字等于下面候选角色之一；不要输出 Markdown、解释、标点或其他字段。\n\n" +
      "<candidate_roles>\n" + roleReference + "\n</candidate_roles>\n\n" +
      "<conversation_user>\n名称：「" + userName + "」\n自我介绍：" + (String(user.introduction || "").trim() || "未设置") + "\n</conversation_user>";
    var hydrated = await hydrateMessages(app.services.context.requestMessages(context), settings, moderator, service, profile, task);
    if (task && task.cancelled) { var stopped = new Error("本轮已停止"); stopped.cancelled = true; throw stopped; }
    var request = app.services.middleware.compileLlm(profile, Object.assign({}, moderator, { systemPrompt: prompt }), hydrated, { stream: false });
    var bodyText = JSON.stringify(request.body);
    if (new TextEncoder().encode(bodyText).length > 900 * 1024) throw new Error("自动选角请求超过 900 KiB，请减少图片或新建对话");
    var result = await app.platform.network.requestJson({ url: request.url, method: "POST", headers: request.headers, bodyText: bodyText, contentType: "application/json", timeoutMs: 120000, task: task });
    var parsed = app.services.providers.parse(profile, result.data);
    if (task && task.routingTrace) {
      task.routingTrace.outputText = String(parsed.text || "").slice(0, 8000);
      task.routingTrace.responseId = parsed.rawId || "";
      task.routingTrace.usage = parsed.usage || null;
    }
    return parseRoleChoice(parsed.text, candidateRoles);
  }

  async function generateScene(moderator, participantRoles, conversation, userProfile, modes, guidance, task) {
    if (!moderator || moderator.enabled === false) throw new Error("当前对话的主持人角色不可用，请先检查基础设定");
    var roles = (participantRoles || []).filter(Boolean);
    if (!roles.length) throw new Error("当前对话没有可用于生成场景的角色");
    var service = await app.data.store.get("llm-profiles", moderator.llmProfileId);
    if (!service || service.enabled === false) throw new Error("主持人绑定的模型服务不存在或已停用");
    var profile = app.services.modelServices.resolveLlm(service, moderator);
    if (!profile.model) throw new Error("主持人没有选择具体模型");
    profile = Object.assign({}, profile, { allowImageGeneration: false, maxOutputTokens: 500, temperature: 0.75 });
    var roleReference = roles.map(function (role) {
      return app.services.context.roleReference(role);
    }).join("\n\n");
    var user = userProfile || {}, userName = String(user.name || "用户").trim() || "用户";
    var selectedMode = (modes || []).map(function (mode) { return String(mode || "").trim(); }).filter(Boolean)[0] || "";
    var extra = String(guidance || "").trim();
    var systemPrompt = "你是对话主持人「" + (String(moderator.name || "主持人").trim() || "主持人") + "」，现在只负责为这场尚未开始的对话创作一段中文场景开场白。\n" +
      "开场白会作为消息历史中的第一条系统消息。请结合用户与全部角色资料，交代自然且具体的时间、地点、环境、人物状态或共同处境，并留下便于用户开始说话的空间。\n" +
      "只输出可直接使用的场景正文，不要写标题、Markdown、分析、说明、对话台词、角色署名或对用户行为的强制安排；不要把角色设定复述成档案。正文控制在 100 个汉字左右，绝对不能超过 200 个汉字。\n\n" +
      "<conversation>\n标题：" + (String(conversation && conversation.title || "未命名对话").trim() || "未命名对话") + "\n</conversation>\n\n" +
      "<conversation_user>\n名称：「" + userName + "」\n自我介绍：" + (String(user.introduction || "").trim() || "未设置") + "\n</conversation_user>\n\n" +
      "<participant_roles>\n" + roleReference + "\n</participant_roles>";
    var requestText = "请生成场景开场白。\n场景模式：" + (selectedMode || "通用") + "\n模式策划要求：" + sceneModeInstruction(selectedMode) + "\n补充关键词：" + (extra || "无");
    var request = app.services.middleware.compileLlm(profile, Object.assign({}, moderator, { systemPrompt: systemPrompt }), [{ role: "user", roleName: userName, speakerKind: "user", text: requestText, images: [], videos: [] }], { stream: false });
    var bodyText = JSON.stringify(request.body);
    if (new TextEncoder().encode(bodyText).length > 900 * 1024) throw new Error("场景生成请求超过 900 KiB，请精简角色或个人介绍");
    var response = await app.platform.network.requestJson({
      url: request.url,
      method: "POST",
      headers: request.headers,
      bodyText: bodyText,
      contentType: "application/json",
      timeoutMs: 120000,
      task: task
    });
    var parsed = app.services.providers.parse(profile, response.data), text = String(parsed.text || "").trim();
    if (!text) throw new Error("主持人模型没有生成可用的场景开场白");
    var characters = Array.from(text);
    if (characters.length > 200) {
      text = characters.slice(0, 200).join("");
      var boundary = Math.max(text.lastIndexOf("。"), text.lastIndexOf("！"), text.lastIndexOf("？"), text.lastIndexOf("；"));
      if (boundary >= 80) text = text.slice(0, boundary + 1);
      text = text.trim();
    }
    return { text: text, usage: parsed.usage || null, rawId: parsed.rawId || null, profileName: profile.name || service.name || "" };
  }

  function appendImages(target, additions) {
    (additions || []).forEach(function (item) {
      if (item && item.dataUrl && !target.some(function (existing) { return existing.dataUrl === item.dataUrl; })) target.push(item);
    });
  }

  function retryableStreamFailure(error) {
    return Boolean(error && !error.cancelled && !error.speakerMismatch && error.code === "E_NETWORK" && error.retryable === true);
  }

  async function stream(profile, request, task, role, participantRoles) {
    var text = "", reasoning = "", images = [], usage = null, emitted = false, done = false, finishReason = "", providerState = null;
    var streamMethod = request.streamFormat === "ndjson" ? app.platform.network.requestNdjson : app.platform.network.requestSse;
    if (!streamMethod) { var absent = new Error("当前运行环境没有流式网络接口"); absent.streamUnavailable = true; throw absent; }
    await streamMethod({
      url: request.url,
      method: "POST",
      headers: request.headers,
      bodyText: JSON.stringify(request.body),
      contentType: "application/json",
      timeoutMs: 120000,
      task: task,
      onEvent: async function (event) {
        var update = app.services.providers.parseStreamEvent(profile, event);
        if (update.delta) {
          text += update.delta; emitted = true;
          if (task && task.onDelta) {
            // 动作块对用户不可见：流式阶段只要看见哨兵（含半个哨兵）就整段遮住。
            try { task.onDelta({ delta: update.delta, text: app.services.actions.visible(partialText(text, role.name, participantRoles)) }); }
            catch (error) { if (error.speakerMismatch && task.controller) task.controller.abort(); throw error; }
          }
        }
        if (update.reasoningDelta) reasoning += update.reasoningDelta;
        if (update.done) { done = true; finishReason = update.finishReason || finishReason; }
        if (update.usage) usage = update.usage;
        if (update.providerState) providerState = update.providerState;
        appendImages(images, update.images);
      }
    });
    if (!text.trim() && !images.length) throw new Error(emitted ? "模型流没有返回可显示内容" : "模型服务结束了流式连接，但没有返回内容");
    if (!done) throw new Error("模型流在明确完成事件前中断；已显示的部分内容不会自动重发，请手动重试");
    return { text: text, reasoning: reasoning, images: images, usage: usage, rawId: null, streamed: true, finishReason: finishReason, providerState: providerState };
  }

  async function complete(role, messages, task, conversation, participantRoles, userProfile) {
    var service = await app.data.store.get("llm-profiles", role.llmProfileId);
    if (!service || service.enabled === false) throw new Error("角色绑定的模型服务不存在或已停用");
    var profile = app.services.modelServices.resolveLlm(service, role);
    if (!profile.model) throw new Error("角色没有选择具体模型");
    var settings = await app.data.store.get("meta", "settings");
    // 压缩由 context 内部挑选主持人角色并异步执行，这里只需要把全部参与角色交出去。
    var context = conversation
      ? await app.services.context.prepare(conversation, role, messages, settings, participantRoles, userProfile)
      : { summary: null, recent: truncate(messages, 10) };
    var selected = app.services.context.requestMessages(context);
    var hydrated = routeTurn(await hydrateMessages(selected, settings, role, service, profile, task), role);
    if (task && task.cancelled) { var stopped = new Error("本轮已停止"); stopped.cancelled = true; throw stopped; }
    // 只有确实配置了可用的绘图卡片时才教角色写动作块 —— 否则它会写一个永远不会被执行的动作。
    // 顺序要紧：**先算 drawing, 再 applyToRole** —— 工具纪律必须并进行为指导那一段（context.js 的
    // applyToRole 第 4 个参数），所以得赶在 systemPrompt 组装之前算出来。
    // 而绘图格式说明仍然 append 在最后：规则 1 要求动作块写在正文之后，它得贴着生成点。
    // applyToRole 返回的是新对象，直接挂到它的 systemPrompt 上；流式失败回退重编译时同样生效。
    var drawing = null;
    if (app.services.draw && app.services.drawPrompt) drawing = await app.services.draw.available();
    var appliedRole = app.services.context.applyToRole(role, participantRoles, userProfile,
      drawing ? app.services.drawPrompt.behaviorGuidance() : "");
    if (drawing) appliedRole.systemPrompt += "\n\n" + app.services.drawPrompt.instruction(Boolean(role.portraitMediaId));
    // 正文与动作块分离。动作块交给 chat-session 去执行，正文照常存库、朗读、进下一轮上下文。
    function settle(value) {
      var cut = app.services.actions.split(value.text);
      // **保留模型写下的原文**（含动作块）。它是模型在历史里唯一的「我当初是怎么做的」样本 ——
      // 以前这里把动作块切掉，历史里就只剩下一句承诺，模型只能自己编因果（见 plan §⑲）。
      // 显示 / 朗读 / 预览 / 搜索仍然用切过的 text，所以那些地方一个字都不用改。
      value.rawText = String(value.text == null ? "" : value.text);
      value.text = cut.text;
      value.action = cut.action || null;
      value.actionBroken = Boolean(cut.invalid);
      return value;
    }
    var request = app.services.middleware.compileLlm(profile, appliedRole, hydrated, { stream: profile.streaming !== false });
    var bodyText = JSON.stringify(request.body);
    var bodyBytes = new TextEncoder().encode(bodyText).length;
    if (bodyBytes > 900 * 1024) throw new Error("请求内容超过 900 KiB，请减少图片或新建对话");
    var parsed;
    if (request.streaming) {
      var retryCount = 0;
      while (!parsed && request.streaming) {
        try { parsed = await stream(profile, request, task, role, participantRoles); }
        catch (error) {
          if (error.streamUnavailable) {
            if (task && task.cancelled) throw error;
            request = app.services.middleware.compileLlm(profile, appliedRole, hydrated, { stream: false });
            bodyText = JSON.stringify(request.body);
            if (task) task.streamingFallback = true;
            break;
          }
          if (retryCount === 0 && retryableStreamFailure(error) && !(task && task.cancelled)) {
            retryCount += 1;
            if (task) {
              task.streamingRetried = true;
              if (typeof task.onStreamRetry === "function") await task.onStreamRetry(error);
            }
            continue;
          }
          throw error;
        }
      }
    }
    if (!parsed) {
      var result = await app.platform.network.requestJson({
        url: request.url,
        method: "POST",
        headers: request.headers,
        bodyText: bodyText,
        contentType: "application/json",
        timeoutMs: 120000,
        task: task
      });
      parsed = app.services.providers.parse(profile, result.data);
      parsed.streamed = false;
      parsed.text = removeRoleEcho(parsed.text, role.name, participantRoles);
      settle(parsed);
      if (task && task.onDelta && parsed.text) task.onDelta({ delta: parsed.text, text: parsed.text, fallback: true });
    }
    if (parsed.streamed) { parsed.text = removeRoleEcho(parsed.text, role.name, participantRoles); settle(parsed); }
    if (parsed.providerState) parsed.providerState = Object.assign({}, parsed.providerState, {
      serviceId: service.id,
      connectionRevision: service.connectionRevision || "",
      modelId: profile.model,
      protocol: profile.apiStyle || "",
      roleId: role.id || "",
      policy: "local-text-rebuild"
    });
    parsed.profileName = profile.name;
    parsed.contextTrimmed = Boolean(context.summary) || context.recent.length < messages.length || selected.some(function (message) { return message.contextTruncated; });
    parsed.contextCompressed = Boolean(context.summary);
    parsed.summaryUpdatedAt = context.summary && context.summary.updatedAt;
    return parsed;
  }

  async function test(service, modelId) {
    var role = { systemPrompt: "只执行连接测试。", model: modelId || service.defaultModelId || service.model || (app.services.modelServices.models("llm", service)[0] || {}).id };
    var profile = app.services.modelServices.resolveLlm(service, role);
    profile = Object.assign({}, profile, { allowImageGeneration: false, maxOutputTokens: 256 });
    if (!profile.model) throw new Error("服务还没有可用模型，请先获取模型列表或填写模型 ID");
    var request = app.services.middleware.compileLlm(profile, role, [{ role: "user", text: "仅回复 OK。", images: [] }]);
    var result = await app.platform.network.requestJson({
      url: request.url,
      method: "POST",
      headers: request.headers,
      bodyText: JSON.stringify(request.body),
      contentType: "application/json",
      timeoutMs: 60000
    });
    return app.services.providers.parse(profile, result.data);
  }

  app.services.llm = { complete: complete, selectRole: selectRole, generateScene: generateScene, sceneModeInstruction: sceneModeInstruction, parseRoleChoice: parseRoleChoice, test: test, truncate: truncate, hydrateMessages: hydrateMessages, removeRoleEcho: removeRoleEcho, partialText: partialText, inspectSpeaker: inspectSpeaker, routeTurn: routeTurn };
})(window.chataxi);
