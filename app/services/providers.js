(function (app) {
  "use strict";
  var utils = app.utils;

  function trimSlash(value) { return String(value || "").replace(/\/+$/, ""); }

  function endpoint(profile, streaming) {
    var value = String(profile.endpoint || "").replace(/\{model\}/g, encodeURIComponent(profile.model || ""));
    if (profile.apiStyle === "gemini-generate-content") {
      value = value.replace(/:generateContent(?:\?.*)?$/, streaming ? ":streamGenerateContent?alt=sse" : ":generateContent");
      if (value.indexOf("{model}") < 0 && !/\/models\/[^/]+:/.test(value)) {
        value = trimSlash(value) + "/models/" + encodeURIComponent(profile.model) + (streaming ? ":streamGenerateContent?alt=sse" : ":generateContent");
      }
    }
    if (profile.apiStyle === "gemini-interactions" && streaming) value += (value.indexOf("?") >= 0 ? "&" : "?") + "alt=sse";
    return value;
  }

  function headers(profile) {
    var result = { "Content-Type": "application/json" };
    Object.assign(result, app.services.modelServices.authHeaders("llm", profile));
    if (profile.apiStyle === "anthropic-messages") {
      if (profile.apiKey) result["x-api-key"] = profile.apiKey;
      result["anthropic-version"] = profile.anthropicVersion || "2023-06-01";
      delete result.Authorization;
    } else if (/^gemini-/.test(profile.apiStyle || "")) {
      if (profile.apiKey) result["x-goog-api-key"] = profile.apiKey;
      delete result.Authorization;
    }
    Object.assign(result, utils.parseHeaders(profile.customHeaders));
    return result;
  }

  function transcriptText(message) {
    var text = String(message.text || "");
    if (message.role !== "assistant" && message.roleName && message.speakerKind !== "routing") return "[" + message.roleName + "] " + text;
    return text;
  }

  function imageParts(message) { return message.images || []; }
  function videoParts(message) { return message.videos || []; }

  function openAiMediaParts(message, profile, responses) {
    var parts = [];
    imageParts(message).forEach(function (image) {
      var url = image.dataUrl || image.remoteUrl || (image.fileId ? "file:" + image.fileId : "");
      if (!url) return;
      parts.push(responses ? { type: "input_image", image_url: url, detail: image.detail || "auto" } : { type: "image_url", image_url: { url: url, detail: image.detail || "auto" } });
    });
    if (profile.modelInfo && profile.modelInfo.videoInput === true) {
      videoParts(message).forEach(function (video) {
        var ref = video.fileId || video.remoteUrl || video.dataUrl;
        if (!ref) return;
        if (responses) {
          var responsePart = { type: "input_video" };
          if (video.fileId) responsePart.file_id = video.fileId;
          else responsePart.video_url = ref;
          parts.push(responsePart);
        } else {
          parts.push({ type: "video_url", video_url: { url: ref } });
        }
      });
    }
    return parts;
  }

  function responseInput(messages, profile) {
    var result = [];
    messages.forEach(function (message) {
      var mappedRole = message.role === "assistant" ? "assistant" : "user";
      var media = mappedRole === "user" ? openAiMediaParts(message, profile, true) : [];
      var text = transcriptText(message);
      if (media.length) {
        result.push({ role: mappedRole, content: [{ type: mappedRole === "assistant" ? "output_text" : "input_text", text: text }].concat(media) });
      } else result.push({ role: mappedRole, content: text });
    });
    return result;
  }

  function chatMessages(role, messages, profile) {
    var result = [];
    if (role.systemPrompt) result.push({ role: "system", content: role.systemPrompt });
    messages.forEach(function (message) {
      var mappedRole = message.role === "assistant" ? "assistant" : "user";
      var media = mappedRole === "user" ? openAiMediaParts(message, profile, false) : [];
      var text = transcriptText(message);
      if (media.length) {
        result.push({ role: mappedRole, content: [{ type: "text", text: text }].concat(media) });
      } else result.push({ role: mappedRole, content: text });
    });
    return result;
  }

  function anthropicMessages(messages) {
    return messages.map(function (message) {
      var mappedRole = message.role === "assistant" ? "assistant" : "user";
      if (mappedRole === "user" && imageParts(message).length) {
        var content = [];
        imageParts(message).forEach(function (image) {
          var parsed = utils.dataUrlToParts(image.dataUrl);
          if (parsed) content.push({ type: "image", source: { type: "base64", media_type: parsed.mime, data: parsed.data } });
          else if (image.remoteUrl) content.push({ type: "image", source: { type: "url", url: image.remoteUrl } });
        });
        content.push({ type: "text", text: transcriptText(message) });
        return { role: mappedRole, content: content };
      }
      return { role: mappedRole, content: transcriptText(message) };
    });
  }

  function geminiParts(message, interactions) {
    var parts = [];
    imageParts(message).forEach(function (image) {
      var parsed = utils.dataUrlToParts(image.dataUrl);
      if (interactions) {
        if (parsed) parts.push({ type: "image", data: parsed.data, mime_type: parsed.mime });
        else if (image.remoteUrl) parts.push({ type: "image", uri: image.remoteUrl, mime_type: image.mime || "image/jpeg" });
      } else {
        if (parsed) parts.push({ inline_data: { mime_type: parsed.mime, data: parsed.data } });
        else if (image.remoteUrl) parts.push({ file_data: { mime_type: image.mime || "image/jpeg", file_uri: image.remoteUrl } });
      }
    });
    videoParts(message).forEach(function (video) {
      var uri = video.remoteUrl || video.fileUri;
      if (!uri) return;
      if (interactions) parts.push({ type: "video", uri: uri, mime_type: video.mime || "video/mp4" });
      else parts.push({ file_data: { mime_type: video.mime || "video/mp4", file_uri: uri } });
    });
    if (interactions) parts.push({ type: "text", text: transcriptText(message) });
    else parts.push({ text: transcriptText(message) });
    return parts;
  }

  function geminiContents(messages) {
    return messages.map(function (message) {
      return { role: message.role === "assistant" ? "model" : "user", parts: geminiParts(message, false) };
    });
  }

  function geminiInput(messages) {
    return messages.map(function (message) {
      return { role: message.role === "assistant" ? "model" : "user", content: geminiParts(message, true) };
    });
  }

  function ollamaMessages(role, messages) {
    var output = [];
    if (role.systemPrompt) output.push({ role: "system", content: role.systemPrompt });
    messages.forEach(function (message) {
      var entry = { role: message.role === "assistant" ? "assistant" : "user", content: transcriptText(message) };
      var encoded = [];
      imageParts(message).forEach(function (image) {
        var parsed = utils.dataUrlToParts(image.dataUrl); if (parsed) encoded.push(parsed.data);
      });
      if (encoded.length) entry.images = encoded;
      output.push(entry);
    });
    return output;
  }

  function putMax(body, profile, key) {
    if (profile.maxOutputTokens !== "" && Number(profile.maxOutputTokens) > 0) body[key] = Number(profile.maxOutputTokens);
  }

  function putTemperature(body, profile) {
    if (profile.temperature !== "" && profile.temperature != null && profile.modelInfo && profile.modelInfo.temperature === true) {
      body.temperature = Number(profile.temperature);
    }
    if (profile.topP !== "" && profile.topP != null) body.top_p = Number(profile.topP);
    if (profile.topK !== "" && profile.topK != null) body.top_k = Number(profile.topK);
  }

  function putProviderParameters(body, profile) {
    var provider = profile.provider || profile.family, info = profile.modelInfo || {};
    if (provider === "deepseek") {
      if (info.thinkingMode && profile.thinkingEnabled != null) body.thinking = { type: profile.thinkingEnabled ? "enabled" : "disabled" };
      if (profile.reasoningEffort) body.reasoning_effort = profile.reasoningEffort;
      if (!profile.thinkingEnabled) putTemperature(body, profile);
    } else if (provider === "qwen") {
      if (info.thinkingMode && profile.thinkingEnabled != null) body.enable_thinking = Boolean(profile.thinkingEnabled);
      if (profile.thinkingBudget) body.thinking_budget = Number(profile.thinkingBudget);
      putTemperature(body, profile);
    } else if (provider === "kimi") {
      if (info.thinkingMode && profile.thinkingEnabled != null) body.thinking = { type: profile.thinkingEnabled ? "enabled" : "disabled" };
    } else if (provider === "glm") {
      if (info.thinkingMode === "optional" && profile.thinkingEnabled != null) body.thinking = { type: profile.thinkingEnabled ? "enabled" : "disabled" };
      if (profile.reasoningEffort) body.reasoning_effort = profile.reasoningEffort;
      putTemperature(body, profile);
    } else if (provider === "minimax") {
      body.reasoning_split = true;
      if (/^minimax-m3/i.test(profile.model || "") && profile.thinkingEnabled != null) body.thinking = { type: profile.thinkingEnabled ? "adaptive" : "disabled" };
      putTemperature(body, profile);
    } else {
      if (profile.reasoningEffort) body.reasoning_effort = profile.reasoningEffort;
      putTemperature(body, profile);
    }
    if (provider === "openrouter" && profile.requireParameters !== false) {
      var optionalSent = profile.temperature !== "" || profile.reasoningEffort || profile.maxOutputTokens !== "";
      if (optionalSent) body.provider = Object.assign({}, body.provider || {}, { require_parameters: true });
    }
  }

  function build(profile, role, messages, options) {
    var body, streaming = Boolean(options && options.stream);
    if (profile.apiStyle === "openai-responses") {
      body = { model: profile.model, input: responseInput(messages, profile), stream: streaming, store: false };
      putMax(body, profile, "max_output_tokens");
      if (role.systemPrompt) body.instructions = role.systemPrompt;
      if (profile.allowImageGeneration) body.tools = [{ type: "image_generation" }];
      if (profile.reasoningEffort) body.reasoning = { effort: profile.reasoningEffort };
      if ((profile.provider || profile.family) === "ark" && profile.modelInfo && profile.modelInfo.thinkingMode === "optional" && profile.thinkingEnabled != null) {
        body.thinking = { type: profile.thinkingEnabled ? "enabled" : "disabled" };
      }
      putTemperature(body, profile);
    } else if (profile.apiStyle === "openai-chat") {
      body = { model: profile.model, messages: chatMessages(role, messages, profile), stream: streaming };
      putMax(body, profile, (profile.provider || profile.family) === "minimax" && /^minimax-m3/i.test(profile.model || "") ? "max_completion_tokens" : "max_tokens");
      putProviderParameters(body, profile);
    } else if (profile.apiStyle === "anthropic-messages") {
      body = { model: profile.model, messages: anthropicMessages(messages), stream: streaming };
      putMax(body, profile, "max_tokens");
      if (!body.max_tokens) body.max_tokens = Math.min(4096, Number(profile.modelInfo && profile.modelInfo.maxOutputTokens || 4096));
      if (role.systemPrompt) body.system = role.systemPrompt;
      if (profile.modelInfo && profile.modelInfo.thinkingMode && profile.thinkingEnabled) body.thinking = { type: profile.modelInfo.thinkingMode === "adaptive" ? "adaptive" : "enabled", budget_tokens: Number(profile.thinkingBudget || 2048) };
      if (profile.reasoningEffort) body.output_config = { effort: profile.reasoningEffort };
      if (!body.thinking) putTemperature(body, profile);
    } else if (profile.apiStyle === "gemini-interactions") {
      body = { model: profile.model, input: geminiInput(messages), stream: streaming, store: false };
      if (role.systemPrompt) body.system_instruction = role.systemPrompt;
      var config = {};
      if (profile.maxOutputTokens !== "" && Number(profile.maxOutputTokens) > 0) config.max_output_tokens = Number(profile.maxOutputTokens);
      if (profile.temperature !== "") config.temperature = Number(profile.temperature);
      if (profile.topP !== "") config.top_p = Number(profile.topP);
      if (profile.topK !== "") config.top_k = Number(profile.topK);
      if (profile.reasoningEffort) config.thinking_level = String(profile.reasoningEffort).toLowerCase();
      if (Object.keys(config).length) body.generation_config = config;
    } else if (profile.apiStyle === "gemini-generate-content") {
      body = { contents: geminiContents(messages), generationConfig: {} };
      if (role.systemPrompt) body.systemInstruction = { parts: [{ text: role.systemPrompt }] };
      if (profile.maxOutputTokens !== "" && Number(profile.maxOutputTokens) > 0) body.generationConfig.maxOutputTokens = Number(profile.maxOutputTokens);
      if (profile.temperature !== "") body.generationConfig.temperature = Number(profile.temperature);
      if (profile.topP !== "") body.generationConfig.topP = Number(profile.topP);
      if (profile.topK !== "") body.generationConfig.topK = Number(profile.topK);
      if (profile.reasoningEffort) body.generationConfig.thinkingConfig = { thinkingLevel: String(profile.reasoningEffort).toUpperCase() };
    } else if (profile.apiStyle === "ollama-chat") {
      body = { model: profile.model, messages: ollamaMessages(role, messages), stream: streaming };
      if (profile.modelInfo && profile.modelInfo.thinkingMode) body.think = Boolean(profile.thinkingEnabled);
      var ollamaOptions = {};
      if (profile.maxOutputTokens !== "" && Number(profile.maxOutputTokens) > 0) ollamaOptions.num_predict = Number(profile.maxOutputTokens);
      if (profile.temperature !== "") ollamaOptions.temperature = Number(profile.temperature);
      if (profile.topP !== "") ollamaOptions.top_p = Number(profile.topP);
      if (profile.topK !== "") ollamaOptions.top_k = Number(profile.topK);
      if (Object.keys(ollamaOptions).length) body.options = ollamaOptions;
    } else throw new Error("不支持的模型协议：" + profile.apiStyle);
    return {
      url: endpoint(profile, streaming),
      headers: headers(profile),
      body: body,
      streaming: streaming,
      streamFormat: profile.apiStyle === "ollama-chat" ? "ndjson" : "sse"
    };
  }

  function collectImages(value, output, imageContext) {
    if (!value) return;
    if (Array.isArray(value)) { value.forEach(function (item) { collectImages(item, output, imageContext); }); return; }
    if (typeof value !== "object") return;
    function add(url, alt) {
      if (utils.isAllowedImageUrl(url) && !output.some(function (item) { return item.dataUrl === url; })) output.push({ dataUrl: url, alt: alt || "AI 图片" });
    }
    if (value.type === "image_generation_call" && typeof value.result === "string") {
      var format = ["jpeg", "webp", "png"].indexOf(value.output_format) >= 0 ? value.output_format : "png";
      add("data:image/" + format + ";base64," + value.result, "AI 生成图片");
    }
    if (value.image_url) add(typeof value.image_url === "string" ? value.image_url : value.image_url.url);
    if (imageContext && typeof value.url === "string") add(value.url);
    var inline = value.inlineData || value.inline_data;
    if (inline && inline.data) add("data:" + (inline.mimeType || inline.mime_type) + ";base64," + inline.data);
    Object.keys(value).forEach(function (key) {
      if (["result", "image_url", "url", "inlineData", "inline_data", "usage", "usageMetadata"].indexOf(key) < 0) collectImages(value[key], output, key === "images" || value.type === "image");
    });
  }

  function textFromParts(parts) {
    var text = "";
    (parts || []).forEach(function (part) {
      if (part && (part.type === "text" || part.type === "output_text") && part.text) text += (text ? "\n" : "") + part.text;
    });
    return text;
  }

  function parse(profile, data) {
    if (!data || typeof data !== "object") throw new Error("模型返回的内容不是有效对象");
    if (data.error) throw new Error(utils.cleanError(data.error.message || data.error.code || "模型服务返回错误"));
    var text = "", reasoning = "";
    if (profile.apiStyle === "openai-responses") {
      text = data.output_text || "";
      (data.output || []).forEach(function (item) {
        if (item.type === "message") text += (text ? "\n" : "") + textFromParts(item.content);
        if (/reasoning/i.test(item.type || "") && item.summary) reasoning += textFromParts(item.summary);
      });
    } else if (profile.apiStyle === "openai-chat") {
      var choice = data.choices && data.choices[0], message = choice && choice.message || {};
      if (typeof message.content === "string") text = message.content;
      else text = textFromParts(message.content);
      reasoning = message.reasoning_content || message.reasoning || textFromParts(message.reasoning_details) || "";
    } else if (profile.apiStyle === "anthropic-messages") {
      (data.content || []).forEach(function (part) {
        if (part.type === "text" && part.text) text += (text ? "\n" : "") + part.text;
        if (part.type === "thinking" && part.thinking) reasoning += part.thinking;
      });
    } else if (profile.apiStyle === "gemini-generate-content") {
      var parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      (parts || []).forEach(function (part) { if (part.text && !part.thought) text += (text ? "\n" : "") + part.text; else if (part.text) reasoning += part.text; });
    } else if (profile.apiStyle === "gemini-interactions") {
      text = data.output_text || data.text || textFromParts(data.outputs || data.output || data.content);
    } else if (profile.apiStyle === "ollama-chat") {
      text = data.message && data.message.content || data.response || "";
      reasoning = data.message && data.message.thinking || data.thinking || "";
    }
    var images = []; collectImages(data, images);
    if (!String(text).trim() && !images.length) throw new Error(reasoning ? "模型只返回了推理内容，没有生成最终回答" : "模型响应中没有可显示的文本或图片");
    return {
      text: String(text).trim(),
      reasoning: String(reasoning || ""),
      images: images,
      usage: data.usage || data.usageMetadata || data.usage_metadata || null,
      rawId: data.id || data.response_id || null,
      providerState: privateState(profile, data)
    };
  }

  function privateState(profile, data) {
    if (profile.apiStyle === "gemini-interactions") {
      var signatures = [];
      collectByKey(data, ["thought_signature", "thoughtSignature", "signature"], signatures);
      return signatures.length ? { protocol: profile.apiStyle, signatures: signatures } : null;
    }
    return null;
  }

  function collectByKey(value, keys, output) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(function (item) { collectByKey(item, keys, output); }); return; }
    Object.keys(value).forEach(function (key) {
      if (keys.indexOf(key) >= 0 && value[key]) output.push({ key: key, value: value[key] });
      else collectByKey(value[key], keys, output);
    });
  }

  function parseStreamEvent(profile, event) {
    var raw = event && event.data;
    if (!raw || raw === "[DONE]") return { done: raw === "[DONE]", finishReason: raw === "[DONE]" ? "done" : "" };
    var data = event.json || utils.safeJsonParse(raw, null);
    if (!data) return {};
    if (data.error || data.type === "error" || data.type === "interaction.failed") {
      var source = data.error || data;
      throw new Error(utils.cleanError(source.message || source.code || source.type || "模型流返回错误"));
    }
    var delta = "", reasoningDelta = "", done = false, finishReason = "", usage = null, images = [];
    if (profile.apiStyle === "openai-responses") {
      if (data.type === "response.output_text.delta" || data.type === "response.refusal.delta") delta = data.delta || "";
      if (/reasoning.*delta/i.test(data.type || "")) reasoningDelta = data.delta || data.text || "";
      done = data.type === "response.completed" || data.type === "response.failed" || data.type === "response.incomplete";
      finishReason = done ? data.type.replace("response.", "") : "";
      var response = data.response || null; usage = response && response.usage || null;
      if (response) collectImages(response, images);
      if (data.type === "response.failed") throw new Error(utils.cleanError(response && response.error && response.error.message || "模型生成失败"));
    } else if (profile.apiStyle === "openai-chat") {
      var choice = data.choices && data.choices[0], content = choice && choice.delta && choice.delta.content;
      if (typeof content === "string") delta = content;
      else if (Array.isArray(content)) content.forEach(function (part) { if (part && part.text) delta += part.text; });
      reasoningDelta = choice && choice.delta && (choice.delta.reasoning_content || choice.delta.reasoning) || "";
      done = Boolean(choice && choice.finish_reason);
      finishReason = choice && choice.finish_reason || "";
      usage = data.usage || null; collectImages(data, images);
    } else if (profile.apiStyle === "anthropic-messages") {
      if (data.type === "content_block_delta" && data.delta && data.delta.type === "text_delta") delta = data.delta.text || "";
      if (data.type === "content_block_delta" && data.delta && /thinking/i.test(data.delta.type || "")) reasoningDelta = data.delta.thinking || data.delta.text || "";
      done = data.type === "message_stop"; finishReason = data.type === "message_stop" ? "stop" : "";
      usage = data.usage || data.message && data.message.usage || null;
    } else if (profile.apiStyle === "gemini-generate-content") {
      var parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      (parts || []).forEach(function (part) { if (part.text && !part.thought) delta += part.text; else if (part.text) reasoningDelta += part.text; });
      done = Boolean(data.candidates && data.candidates[0] && data.candidates[0].finishReason);
      finishReason = data.candidates && data.candidates[0] && data.candidates[0].finishReason || "";
      usage = data.usageMetadata || null; collectImages(data, images);
    } else if (profile.apiStyle === "gemini-interactions") {
      var type = data.type || event.event || "";
      var payload = data.delta || data.content || data.output || {};
      if (type === "step.delta" || /text.*delta/i.test(type)) {
        if (typeof payload === "string") delta = payload;
        else if (payload.type === "text") delta = payload.text || payload.delta || "";
        else delta = data.text || "";
      }
      if (/thought.*delta|reasoning.*delta/i.test(type)) reasoningDelta = data.text || payload.text || payload.delta || "";
      done = type === "interaction.completed" || type === "interaction.incomplete";
      finishReason = done ? type.replace("interaction.", "") : "";
      usage = data.usage || data.interaction && data.interaction.usage || null;
    } else if (profile.apiStyle === "ollama-chat") {
      delta = data.message && data.message.content || data.response || "";
      reasoningDelta = data.message && data.message.thinking || data.thinking || "";
      done = Boolean(data.done); finishReason = data.done_reason || (data.done ? "stop" : "");
      usage = data.done ? { prompt_tokens: data.prompt_eval_count, completion_tokens: data.eval_count } : null;
    }
    return { delta: delta, reasoningDelta: reasoningDelta, done: done, finishReason: finishReason, usage: usage, images: images, providerState: privateState(profile, data) };
  }

  app.services.providers = {
    build: build,
    parse: parse,
    parseStreamEvent: parseStreamEvent,
    headers: headers,
    endpoint: endpoint
  };
})(window.chataxi);
