(function (app) {
  "use strict";

  async function hydrateMessages(messages, settings, activeRole, service, profile, task) {
    var hydrated = [];
    for (var index = 0; index < messages.length; index += 1) {
      var message = messages[index];
      var assistant = message.kind === "assistant";
      var activeHistory = assistant && (!activeRole || message.roleId === activeRole.id || (!message.roleId && message.roleName === activeRole.name));
      var output = {
        role: activeHistory ? "assistant" : "user",
        roleName: activeHistory ? message.roleName || "" : "",
        speakerKind: assistant ? (activeHistory ? "active-role-history" : "other-role-history") : "user",
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
      }
      hydrated.push(output);
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
    var context = await app.services.context.prepare(conversation, moderator, messages, settings, task || {}, candidateRoles, userProfile);
    if (task && task.phase === "compressing") {
      task.phase = "routing";
      task.label = task.generateLabel || "正在请主持人 " + moderator.name + " 选择回复角色";
      app.events.emit("chat:changed", { conversationId: conversation.id, phase: "routing" });
    }
    var roleReference = candidateRoles.map(function (role) {
      return "角色「" + role.name + "」：\n" + (String(role.systemPrompt || "").trim() || "未设置角色介绍");
    }).join("\n\n");
    var user = userProfile || {}, userName = String(user.name || "用户").trim() || "用户";
    var prompt = "你是群聊主持人「" + moderator.name + "」，本次只负责选择下一位最适合回答的参与角色，不要回答用户的问题。\n" +
      "必须且只能输出一行严格 JSON，格式为 {\"role\":\"完整角色名称\"}。role 的值必须逐字等于下面候选角色之一；不要输出 Markdown、解释、标点或其他字段。\n\n" +
      "<candidate_roles>\n" + roleReference + "\n</candidate_roles>\n\n" +
      "<conversation_user>\n名称：「" + userName + "」\n自我介绍：" + (String(user.introduction || "").trim() || "未设置") + "\n</conversation_user>";
    if (context.summary && context.summary.text) prompt += "\n\n<conversation_summary>\n" + context.summary.text + "\n</conversation_summary>";
    var hydrated = await hydrateMessages(context.recent, settings, moderator, service, profile, task);
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

  function appendImages(target, additions) {
    (additions || []).forEach(function (item) {
      if (item && item.dataUrl && !target.some(function (existing) { return existing.dataUrl === item.dataUrl; })) target.push(item);
    });
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
            try { task.onDelta({ delta: update.delta, text: partialText(text, role.name, participantRoles) }); }
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
    var compressionRole = participantRoles && participantRoles.length ? participantRoles[0] : role;
    var context = conversation
      ? await app.services.context.prepare(conversation, compressionRole, messages, settings, task || {}, participantRoles, userProfile)
      : { summary: null, recent: truncate(messages, 10) };
    if (task && task.phase === "compressing") { task.phase = "generating"; task.label = task.generateLabel || "正在等待 " + role.name; app.events.emit("chat:changed", { conversationId: conversation.id, phase: "generating" }); }
    var selected = context.recent;
    var hydrated = routeTurn(await hydrateMessages(selected, settings, role, service, profile, task), role);
    if (task && task.cancelled) { var stopped = new Error("本轮已停止"); stopped.cancelled = true; throw stopped; }
    var appliedRole = app.services.context.applyToRole(role, context.summary, participantRoles, userProfile);
    var request = app.services.middleware.compileLlm(profile, appliedRole, hydrated, { stream: profile.streaming !== false });
    var bodyText = JSON.stringify(request.body);
    var bodyBytes = new TextEncoder().encode(bodyText).length;
    if (bodyBytes > 900 * 1024) throw new Error("请求内容超过 900 KiB，请减少图片或新建对话");
    var parsed;
    if (request.streaming) {
      try { parsed = await stream(profile, request, task, role, participantRoles); }
      catch (error) {
        if (!error.streamUnavailable) throw error;
        if (task && task.cancelled) throw error;
        request = app.services.middleware.compileLlm(profile, appliedRole, hydrated, { stream: false });
        bodyText = JSON.stringify(request.body);
        if (task) task.streamingFallback = true;
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
      if (task && task.onDelta && parsed.text) task.onDelta({ delta: parsed.text, text: parsed.text, fallback: true });
    }
    if (parsed.streamed) parsed.text = removeRoleEcho(parsed.text, role.name, participantRoles);
    if (parsed.providerState) parsed.providerState = Object.assign({}, parsed.providerState, {
      serviceId: service.id,
      connectionRevision: service.connectionRevision || "",
      modelId: profile.model,
      protocol: profile.apiStyle || "",
      roleId: role.id || "",
      policy: "local-text-rebuild"
    });
    parsed.profileName = profile.name;
    parsed.contextTrimmed = Boolean(context.summary) || selected.length < messages.length || selected.some(function (message) { return message.contextTruncated; });
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

  app.services.llm = { complete: complete, selectRole: selectRole, parseRoleChoice: parseRoleChoice, test: test, truncate: truncate, hydrateMessages: hydrateMessages, removeRoleEcho: removeRoleEcho, partialText: partialText, inspectSpeaker: inspectSpeaker, routeTurn: routeTurn };
})(window.chataxi);
