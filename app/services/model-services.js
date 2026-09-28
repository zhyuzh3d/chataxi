(function (app) {
  "use strict";
  var catalog = app.services.catalog;

  function families(kind) {
    return catalog[kind === "llm" ? "llmFamilies" : kind === "tts" ? "ttsFamilies" : kind === "asr" ? "asrFamilies" : "imageFamilies"] || [];
  }

  // 兜底要三层：指定 id → "custom" 家族 → 列表第一项。第三层是给绘图用的 —— imageFamilies
  // 里没有 "custom"，少了它 family() 会返回 undefined，随后读 definition.models 就炸。
  function family(kind, id) {
    var list = families(kind);
    return list.find(function (item) { return item.id === id; }) || list.find(function (item) { return item.id === "custom"; }) || list[0] || {};
  }

  // CVP 插件地址归一化：允许用户填到 /cvp 或旧名 /hamdraw 为止，客户端都退回它前面的根。
  // 与 hamdraw/plans/cvp-spec.md 的客户端约定一致（规范承诺路径不变，这里的容错只为省心）。
  function cvpBase(endpoint) {
    var value = String(endpoint || "").replace(/\/+$/, ""), marker = value.search(/\/(?:cvp|hamdraw)(?:\/|$)/i);
    return marker > 0 ? value.slice(0, marker) : value;
  }

  function unique(items) {
    var seen = {};
    return (items || []).map(function (item) { return typeof item === "string" ? { id: item, name: item } : item; }).filter(function (item) {
      var id = item && String(item.id || "").trim();
      if (!id || seen[id]) return false;
      item.id = id; seen[id] = true; return true;
    });
  }

  function mergeKnown(kind, definition, item) {
    var known = (definition.models || []).find(function (entry) { return entry.id === item.id; });
    var merged = Object.assign({}, known || {}, item);
    if (known) {
      ["maxOutputTokens", "temperature", "imageInput", "videoInput", "imageGeneration", "thinkingMode", "temperatureWhen", "reasoningWhen", "voicePrompt", "speechRate", "pitchRate", "loudnessRate", "audioStreaming", "textStreaming"].forEach(function (key) {
        if (item[key] == null && known[key] != null) merged[key] = known[key];
      });
      if ((!Array.isArray(item.reasoning) || !item.reasoning.length) && Array.isArray(known.reasoning)) merged.reasoning = known.reasoning.slice();
      if ((!Array.isArray(item.supportedParameters) || !item.supportedParameters.length) && Array.isArray(known.supportedParameters)) merged.supportedParameters = known.supportedParameters.slice();
      if (!merged.capabilityEvidence && known.capabilityEvidence) merged.capabilityEvidence = known.capabilityEvidence;
    }
    merged.capabilitySource = item.capabilitySource || known && known.capabilitySource || (kind === "llm" ? "service-directory" : "reviewed-registry");
    return merged;
  }

  function allModels(kind, service) {
    var definition = family(kind, service && (service.family || service.type));
    var stored = service && service.models || [];
    var legacy = service && service.model ? [{ id: service.model, name: service.model, capabilitySource: "legacy" }] : [];
    if (service && service.singleModelVersion === 1) {
      var selected = service.externalModelId || service.model || service.defaultModelId;
      return unique(stored.concat(legacy)).filter(function (item) { return item.id === selected; }).map(function (item) { return mergeKnown(kind, definition, item); });
    }
    var source = service && service.modelsDiscovered ? stored.concat(legacy) : stored.concat(definition.models || [], legacy);
    return unique(source).map(function (item) { return mergeKnown(kind, definition, item); });
  }

  function models(kind, service) {
    var result = allModels(kind, service);
    if (!service || !Array.isArray(service.enabledModelIds)) return result;
    return result.filter(function (item) { return service.enabledModelIds.indexOf(item.id) >= 0; });
  }

  function allVoices(service) {
    var definition = family("tts", service && (service.family || service.type));
    var stored = service && service.voices || [];
    var legacy = service && service.voice ? [{ id: service.voice, name: service.voice }] : [];
    return unique(stored.concat(definition.voices || [], legacy));
  }

  function voices(service, modelId) {
    var definition = family("tts", service && (service.family || service.type));
    var result = allVoices(service);
    if (!modelId || definition.id === "elevenlabs") return result;
    return result.filter(function (item) {
      return !Array.isArray(item.compatibleModelIds) || !item.compatibleModelIds.length || item.compatibleModelIds.indexOf(modelId) >= 0;
    });
  }

  function voiceCompatibility(service, modelId, voiceId) {
    var definition = family("tts", service && (service.family || service.type));
    var verification = service && service.combinationVerifications && service.combinationVerifications[modelId + "\n" + voiceId];
    if (verification && verification.connectionRevision && verification.connectionRevision !== service.connectionRevision) verification = null;
    if (verification && verification.ok) return { available: true, mode: "confirmed", note: "该模型与音色组合已试听验证" };
    if (verification && verification.ok === false) return { available: false, mode: "unsupported", note: verification.message || "该模型与音色组合验证失败" };
    var selected = voices(service, modelId).some(function (item) { return item.id === voiceId; });
    return {
      available: definition.id === "elevenlabs" ? true : selected,
      mode: definition.id === "elevenlabs" ? "native" : "unverified",
      note: definition.id === "elevenlabs" ? "ElevenLabs 允许账户音色直接使用 v3 等所选 TTS 模型；实际可用性仍以当前账户试听结果为准" : selected ? "该组合尚未试听验证" : "该音色未声明支持所选模型"
    };
  }

  function recordTtsVerification(service, modelId, voiceId, ok, message) {
    if (!service || !modelId) return null;
    service.combinationVerifications = Object.assign({}, service.combinationVerifications || {});
    var record = {
      ok: Boolean(ok), modelId: modelId, voiceId: voiceId || "", checkedAt: Date.now(),
      connectionRevision: service.connectionRevision || "", message: message ? app.utils.cleanError(message) : ""
    };
    service.combinationVerifications[modelId + "\n" + (voiceId || "")] = record;
    return record;
  }

  function requiredCredentialMessage(definition, service) {
    if (definition.keyOptional || definition.auth === "none") return "";
    if (definition.auth === "aws-sigv4") {
      if (!service.accessKeyId) return "缺少 Access Key ID";
      if (!service.apiKey) return "缺少 Secret Access Key";
      if (!service.region) return "缺少 AWS 区域";
      return "";
    }
    if (definition.auth === "azure" && !service.region && !service.resourceEndpoint) return "缺少 Azure 区域或资源 Endpoint";
    return service.apiKey ? "" : "缺少 API Key";
  }

  function serviceStatus(kind, service) {
    if (!service) return "服务不存在";
    if (service.enabled === false) return "已停用";
    var definition = family(kind, service.family || service.type);
    if (definition.type === "system") return "";
    if (!service.endpoint && !computedEndpoint(kind, service)) return "缺少服务地址";
    return requiredCredentialMessage(definition, service);
  }

  function computedEndpoint(kind, service) {
    var definition = family(kind, service && (service.family || service.type));
    if (definition.id === "qwen" && service && service.workspaceId && service.region && (!service.endpoint || service.endpoint === definition.endpoint)) {
      if (!/^[A-Za-z0-9-]+$/.test(service.workspaceId) || !/^[A-Za-z0-9-]+$/.test(service.region)) return service.endpoint || definition.endpoint || "";
      return "https://" + service.workspaceId + "." + service.region + ".maas.aliyuncs.com/compatible-mode/v1/chat/completions";
    }
    if (service && service.endpoint) return service.endpoint;
    if (definition.id === "azure-tts" && service && service.region) {
      return "https://" + service.region + ".tts.speech.microsoft.com/cognitiveservices/v1";
    }
    if (definition.id === "aws-polly" && service && service.region) {
      return "https://polly." + service.region + ".amazonaws.com/v1/speech";
    }
    return definition.endpoint || "";
  }

  function modelDefinition(kind, service, modelId) {
    var definition = family(kind, service && (service.family || service.type));
    var listed = allModels(kind, service).find(function (item) { return item.id === modelId; });
    var known = (definition.models || []).find(function (item) { return item.id === modelId; });
    var reviewed = kind === "llm" && catalog.reviewedLlmModels && catalog.reviewedLlmModels[definition.id] && catalog.reviewedLlmModels[definition.id][String(modelId || "").toLowerCase()];
    var result = Object.assign({
      id: modelId,
      name: modelId,
      maxOutputTokens: null,
      temperature: false,
      reasoning: [],
      thinkingMode: null,
      imageInput: false,
      videoInput: false,
      imageGeneration: false,
      voicePrompt: false,
      speechRate: false,
      pitchRate: false,
      loudnessRate: false,
      supportedParameters: [],
      streaming: definition.streaming === true,
      audioStreaming: null,
      textStreaming: null,
      capabilitySource: "unknown"
    }, reviewed || {}, known || {}, listed || {});
    if (kind === "llm") applyReviewedRules(definition.id, result);
    return result;
  }

  function conditionSatisfied(condition, role) {
    if (!condition) return true;
    if (condition === "thinking-enabled") return Boolean(role && role.thinkingEnabled);
    if (condition === "thinking-disabled") return !(role && role.thinkingEnabled);
    return false;
  }

  function parameterAvailable(model, parameter, role) {
    if (!model) return false;
    if (parameter === "temperature") return model.temperature === true && conditionSatisfied(model.temperatureWhen, role);
    if (parameter === "reasoning") return Array.isArray(model.reasoning) && model.reasoning.length > 0 && conditionSatisfied(model.reasoningWhen, role);
    return (model.supportedParameters || []).indexOf(parameter) >= 0;
  }

  function resolveLlm(service, role) {
    var definition = family("llm", service.family || service.type);
    var modelId = service.singleModelVersion === 1 ? service.externalModelId || service.model || service.defaultModelId : role.model || service.defaultModelId || service.model || (models("llm", service)[0] || {}).id || "";
    var info = modelDefinition("llm", service, modelId);
    var rawMax = role.maxOutputTokens != null ? role.maxOutputTokens : service.maxOutputTokens;
    var maximum = Number(info.maxOutputTokens || 0);
    var maxSupported = maximum > 0 || (info.supportedParameters || []).some(function (name) { return /max.*tokens/i.test(name); });
    var maxOutput = !maxSupported || rawMax == null || rawMax === "" ? "" : Number(rawMax);
    if (maximum > 0 && maxOutput > maximum) maxOutput = maximum;
    var resolved = Object.assign({}, service, {
      family: definition.id,
      provider: definition.provider || definition.id,
      apiStyle: service.apiStyle || definition.apiStyle,
      endpoint: computedEndpoint("llm", service),
      model: modelId,
      modelInfo: info,
      temperature: parameterAvailable(info, "temperature", role) && role.temperature != null ? role.temperature : "",
      topP: parameterAvailable(info, "top_p", role) && role.topPOverride && role.topP != null ? Number(role.topP) : "",
      topK: parameterAvailable(info, "top_k", role) && role.topKOverride && role.topK != null ? Number(role.topK) : "",
      maxOutputTokens: maxOutput,
      reasoningEffort: parameterAvailable(info, "reasoning", role) && (info.reasoning || []).indexOf(role.reasoningEffort) >= 0 ? role.reasoningEffort : "",
      thinkingEnabled: role.thinkingEnabled,
      thinkingBudget: role.thinkingBudget,
      allowImageGeneration: info.imageGeneration === true && Boolean(role.allowImageGeneration),
      streaming: info.streaming !== false
    });
    resolved.resolvedCapabilities = app.services.modelRegistry.resolvedCapabilities("llm", resolved, info);
    resolved.systemRoleMode = resolved.resolvedCapabilities.systemRoleMode;
    return resolved;
  }

  function resolveTts(service, role, settings) {
    var definition = family("tts", service.family || service.type);
    var modelId = service.externalModelId || service.model || service.defaultModelId || role && role.ttsModel || (models("tts", service)[0] || {}).id || "";
    var modelInfo = modelDefinition("tts", service, modelId);
    var voiceId = role && role.ttsVoice || service.defaultVoiceId || service.voice || (voices(service, modelId)[0] || {}).id || "";
    var compatibility = voiceCompatibility(service, modelId, voiceId);
    return Object.assign({}, service, {
      family: definition.id,
      type: service.type || definition.type,
      endpoint: computedEndpoint("tts", service),
      streamEndpoint: service.streamEndpoint || definition.streamEndpoint || computedEndpoint("tts", service),
      protocol: service.protocol || definition.protocol || service.type || definition.type,
      model: modelId,
      modelInfo: modelInfo,
      modelSelection: definition.modelSelection !== false,
      voice: voiceId,
      voiceCompatibilityMode: compatibility.mode,
      instructions: modelInfo.voicePrompt && role ? role.voicePrompt || "" : "",
      language: definition.id === "system" ? service.language || "" : role && role.ttsLanguage || service.language || settings.language || "",
      rate: role && role.ttsRate || service.rate || 1,
      pitch: role && role.ttsPitch || service.pitch || 1,
      speechRate: modelInfo.speechRate && role && role.ttsSpeechRate != null ? Number(role.ttsSpeechRate) : Number(service.speechRate || 0),
      pitchRate: modelInfo.pitchRate && role && role.ttsPitchRate != null ? Number(role.ttsPitchRate) : Number(service.pitchRate || 0),
      loudnessRate: modelInfo.loudnessRate && role && role.ttsLoudnessRate != null ? Number(role.ttsLoudnessRate) : Number(service.loudnessRate || 0),
      sampleRate: Number(service.sampleRate || 24000),
      format: service.format || (modelInfo.formats || [])[0] || "mp3",
      streaming: modelInfo.audioStreaming === true
    });
  }

  function resolveAsr(service, conversation, settings) {
    var definition = family("asr", service.family || service.type);
    return Object.assign({}, service, {
      family: definition.id,
      type: service.type || definition.type,
      endpoint: computedEndpoint("asr", service),
      model: service.externalModelId || service.model || service.defaultModelId || conversation && conversation.asrModel || (models("asr", service)[0] || {}).id || "system",
      language: definition.id === "system" ? conversation && conversation.asrLanguage || service.language || "" : conversation && conversation.asrLanguage || service.language || settings.language || ""
    });
  }

  function authHeaders(kind, service) {
    var definition = family(kind, service.family || service.type), key = service.apiKey || "", result = {};
    if (definition.auth === "anthropic") {
      if (key) result["x-api-key"] = key;
      result["anthropic-version"] = service.anthropicVersion || "2023-06-01";
      return result;
    }
    if (definition.auth === "gemini") return key ? { "x-goog-api-key": key } : {};
    if (definition.auth === "elevenlabs") return key ? { "xi-api-key": key } : {};
    if (definition.auth === "doubao") return key ? { "X-Api-Key": key } : {};
    if (definition.auth === "azure") return key ? { "Ocp-Apim-Subscription-Key": key } : {};
    if ((definition.auth === "bearer" || definition.auth === "bearer-optional") && key) result.Authorization = "Bearer " + key;
    return result;
  }

  function deriveModelsEndpoint(service) {
    if (!service || !service.endpoint) return "";
    try {
      var url = new URL(service.endpoint), path = url.pathname;
      if (/\/api\/chat\/?$/i.test(path)) path = path.replace(/\/api\/chat\/?$/i, "/api/tags");
      else if (/\/(?:responses|chat\/completions|messages)\/?$/i.test(path)) path = path.replace(/(?:responses|chat\/completions|messages)\/?$/i, "models");
      else return "";
      url.pathname = path; url.search = ""; url.hash = ""; return url.toString();
    } catch (_) { return ""; }
  }

  function discoveryUrls(kind, service) {
    var definition = family(kind, service && (service.family || service.type));
    var modelsUrl = service && service.modelsEndpoint || definition.modelsEndpoint || "";
    var voicesUrl = service && service.voicesEndpoint || definition.voicesEndpoint || "";
    if (definition.customEndpoint && service && service.endpoint) {
      try {
        var runtimeOrigin = new URL(service.endpoint);
        if (!service.modelsEndpoint && definition.modelsEndpoint) { var modelTemplate = new URL(definition.modelsEndpoint); modelTemplate.protocol = runtimeOrigin.protocol; modelTemplate.host = runtimeOrigin.host; modelsUrl = modelTemplate.toString(); }
        if (!service.voicesEndpoint && definition.voicesEndpoint) { var voiceTemplate = new URL(definition.voicesEndpoint); voiceTemplate.protocol = runtimeOrigin.protocol; voiceTemplate.host = runtimeOrigin.host; voicesUrl = voiceTemplate.toString(); }
      } catch (_) {}
    }
    if (definition.id === "qwen" && service && service.workspaceId && service.region && (!service.modelsEndpoint || service.modelsEndpoint === definition.modelsEndpoint) && /^[A-Za-z0-9-]+$/.test(service.workspaceId) && /^[A-Za-z0-9-]+$/.test(service.region)) {
      modelsUrl = "https://" + service.workspaceId + "." + service.region + ".maas.aliyuncs.com/api/v1/models?page_no=1&page_size=100";
    }
    if ((!modelsUrl || definition.discovery === "ollama") && (definition.discovery === "derived-openai" || definition.discovery === "ollama")) modelsUrl = deriveModelsEndpoint(service) || modelsUrl;
    if (definition.id === "azure-tts") {
      var root = service && service.resourceEndpoint || "";
      voicesUrl = root ? root.replace(/\/$/, "") + "/tts/cognitiveservices/voices/list" : "";
    }
    if (definition.id === "aws-polly" && service && service.region) voicesUrl = "https://polly." + service.region + ".amazonaws.com/v1/voices";
    return { models: modelsUrl, voices: voicesUrl };
  }

  function discoveryUrl(kind, service) {
    var urls = discoveryUrls(kind, service); return urls.models || urls.voices || "";
  }

  function parameterNames(item) {
    var parameters = item.supported_parameters || item.supportedParameters || item.parameters || [];
    return Array.isArray(parameters) ? parameters.map(String) : [];
  }

  function modalityList(item, keyA, keyB) {
    var value = item[keyA] || item[keyB] || [];
    return Array.isArray(value) ? value.map(function (entry) { return String(entry).toLowerCase(); }) : [];
  }

  function discoveredModel(item, definition) {
    var id = String(item.id || item.model || item.model_id || item.baseModelId || item.name || "").replace(/^models\//, "");
    var parameters = parameterNames(item), input = modalityList(item, "input_modalities", "inputModalities");
    var output = modalityList(item, "output_modalities", "outputModalities");
    var architecture = item.architecture || {}, inference = item.inference_metadata || {}, info = item.model_info || {};
    if (!input.length) input = modalityList(architecture, "input_modalities", "inputModalities");
    if (!input.length && Array.isArray(inference.request_modality)) input = inference.request_modality.map(function (x) { return String(x).toLowerCase(); });
    if (!output.length) output = modalityList(architecture, "output_modalities", "outputModalities");
    var capabilities = item.capabilities || {}, thinking = capabilities.thinking || {}, reasoningCapability = capabilities.reasoning || {}, effort = capabilities.effort || {};
    var efforts = item.reasoning_efforts || item.reasoningEfforts || thinking.levels || [];
    if (!Array.isArray(efforts)) efforts = Object.keys(effort).filter(function (key) { return effort[key] && effort[key].supported !== false; });
    if (!efforts.length && Array.isArray(reasoningCapability.allowed_options)) efforts = reasoningCapability.allowed_options.map(String);
    var contextLength = Number(item.context_length || item.contextLength || item.inputTokenLimit || item.max_input_tokens || info.context_length || info.max_input_tokens || 0);
    var max = Number(item.max_output_tokens || item.maxOutputTokens || item.outputTokenLimit || item.max_tokens || item.max_completions_tokens || info.max_output_tokens || 0);
    var next = {
      id: id,
      name: item.displayName || item.display_name || item.name || id,
      description: item.description || "",
      supportedParameters: parameters,
      temperature: parameters.length ? parameters.indexOf("temperature") >= 0 : item.temperature != null ? Boolean(item.temperature) : null,
      imageInput: input.length ? input.indexOf("image") >= 0 : capabilityFlag(capabilities, ["image_input", "vision"], item.supports_image_in),
      videoInput: input.length ? input.indexOf("video") >= 0 : capabilityFlag(capabilities, ["video_input"], item.supports_video_in),
      imageGeneration: output.length ? output.indexOf("image") >= 0 : parameters.some(function (value) { return /image.*generation/i.test(value); }) || null,
      reasoning: efforts.map(String),
      streaming: item.streaming == null ? definition.streaming !== false : Boolean(item.streaming),
      contextLength: contextLength > 0 ? contextLength : null,
      maxOutputTokens: max > 0 ? max : null,
      provider: item.provider || item.owned_by || "",
      inferenceProvider: item.inference_provider || "",
      status: item.status || "",
      capabilitySource: "service-directory",
      fetchedAt: Date.now(),
      rawCapabilities: capabilities
    };
    next.kind = item.kind || item.modelKind || item.model_type || item.type || "";
    next.supportsReasoning = item.supports_reasoning === true || item.supportsReasoning === true;
    if (definition.id === "anthropic") {
      var thinkingTypes = Array.isArray(thinking.types) ? thinking.types.map(String) : [];
      next.thinkingMode = thinkingTypes.indexOf("adaptive") >= 0 ? "adaptive" : thinkingTypes.indexOf("enabled") >= 0 ? "enabled" : null;
      if (!next.reasoning.length && effort && typeof effort === "object") next.reasoning = Object.keys(effort).filter(function (key) { return effort[key] && effort[key].supported !== false; });
    }
    if (definition.id === "lmstudio" && reasoningCapability && (reasoningCapability.supported === true || efforts.length)) next.thinkingMode = "optional";
    applyReviewedRules(definition.id, next);
    return mergeKnown("llm", definition, next);
  }

  async function enrichOllamaModels(models, url, headers) {
    var showUrl = String(url || "").replace(/\/api\/tags(?:\?.*)?$/, "/api/show");
    if (!showUrl || showUrl === url) return models;
    var enriched = await Promise.all(models.slice(0, 100).map(async function (model) {
      try {
        var result = await app.platform.network.requestJson({ url: showUrl, method: "POST", headers: headers, bodyText: JSON.stringify({ model: model.id }), contentType: "application/json", timeoutMs: 45000 });
        var data = result.data || {}, flags = Array.isArray(data.capabilities) ? data.capabilities.map(function (value) { return String(value).toLowerCase(); }) : [];
        model.imageInput = flags.indexOf("vision") >= 0;
        model.videoInput = false;
        model.imageGeneration = false;
        model.thinkingMode = flags.indexOf("thinking") >= 0 ? "optional" : null;
        model.temperature = true;
        model.supportedParameters = ["temperature"];
        model.capabilitySource = "runtime-directory";
        model.capabilityEvidence = { kind: "runtime-model-details", endpoint: showUrl, fetchedAt: Date.now() };
        model.rawCapabilities = flags;
        return model;
      } catch (_) { return model; }
    }));
    return enriched.concat(models.slice(100));
  }

  function capabilityFlag(capabilities, keys, direct) {
    if (direct === true || direct === false) return direct;
    for (var index = 0; index < keys.length; index += 1) {
      var value = capabilities[keys[index]];
      if (value === true || value === false) return value;
      if (value && typeof value === "object" && (value.supported === true || value.supported === false)) return value.supported;
    }
    return null;
  }

  function applyReviewedRules(provider, model) {
    var id = String(model.id || "").toLowerCase(), rules = catalog.reviewedLlmModels && catalog.reviewedLlmModels[provider], rule = rules && rules[id];
    if (!rule) return model;
    var weakSource = !model.capabilitySource || model.capabilitySource === "unknown" || model.capabilitySource === "legacy";
    ["maxOutputTokens", "temperature", "imageInput", "videoInput", "imageGeneration", "thinkingMode", "temperatureWhen", "reasoningWhen"].forEach(function (key) {
      if ((model[key] == null || weakSource) && rule[key] != null) model[key] = rule[key];
    });
    if ((!Array.isArray(model.reasoning) || !model.reasoning.length) && Array.isArray(rule.reasoning)) model.reasoning = rule.reasoning.slice();
    if ((!Array.isArray(model.supportedParameters) || !model.supportedParameters.length) && Array.isArray(rule.supportedParameters)) model.supportedParameters = rule.supportedParameters.slice();
    model.capabilityEvidence = model.capabilityEvidence || rule.capabilityEvidence;
    if (model.capabilitySource === "service-directory" && rule.capabilityEvidence) model.capabilitySource = "service-directory+reviewed-registry";
    return model;
  }

  function normalizeModelList(data, definition) {
    var raw;
    if (definition.discovery === "ollama") raw = data.models || [];
    else if (definition.discovery === "qwen") raw = data.output && data.output.models || [];
    else if (definition.discovery === "xai") raw = data.models || data.data || [];
    else if (definition.discovery === "openai-array") raw = Array.isArray(data) ? data : data.data || [];
    else if (definition.discovery === "baidu") raw = data.data || data.models || data.result || [];
    else if (definition.discovery === "lmstudio") raw = data.models || data.data || [];
    else raw = Array.isArray(data) ? data : data.data || data.models || data.items || [];
    return (raw || []).filter(function (item) { return conversationModel(item, definition); }).map(function (item) {
      if (definition.discovery === "ollama") item = Object.assign({}, item, { id: item.name || item.model, displayName: item.name || item.model });
      return discoveredModel(item, definition);
    }).filter(function (item) { return item.id; });
  }

  function conversationModel(item, definition) {
    item = item || {};
    var id = String(item.id || item.model || item.model_id || item.name || "").replace(/^models\//, "").toLowerCase();
    if (!id) return false;
    if (definition.discovery === "gemini" && Array.isArray(item.supportedGenerationMethods)) {
      return item.supportedGenerationMethods.some(function (method) { return /generatecontent|interact/i.test(String(method)); });
    }
    if (definition.id === "mistral" && item.capabilities && item.capabilities.completion_chat === false) return false;
    if (definition.id === "together" && item.type && !/chat|language|serverless/i.test(String(item.type))) return false;
    if (/embedding|moderation|rerank|transcrib|whisper|(?:^|[-_.])tts(?:$|[-_.])|speech-to|image-generation|(?:^|[-_.])dall-e(?:$|[-_.])|(?:^|[-_.])realtime(?:$|[-_.])/.test(id)) return false;
    return true;
  }

  function nextModelsUrl(url, data, definition, page) {
    if (page >= 19) return "";
    if (definition.discovery === "gemini" && data.nextPageToken) {
      var gemini = new URL(url); gemini.searchParams.set("pageToken", data.nextPageToken); return gemini.toString();
    }
    if (definition.discovery === "anthropic" && data.has_more && data.last_id) {
      var claude = new URL(url); claude.searchParams.set("after_id", data.last_id); return claude.toString();
    }
    if (definition.discovery === "qwen" && data.output && Number(data.output.total || 0) > (page + 1) * 100) {
      var qwen = new URL(url); qwen.searchParams.set("page_no", String(page + 2)); return qwen.toString();
    }
    if (definition.discovery === "openrouter" && data.links && data.links.next) return data.links.next;
    return "";
  }

  async function discoverLlm(service, definition, urls, headers) {
    if (definition.discovery === "registry" || definition.discovery === "none" && !urls.models) {
      return { models: allModels("llm", service), catalogState: "reviewed-registry", discovered: false };
    }
    if (!urls.models) return { models: allModels("llm", service), catalogState: "unavailable", discovered: false };
    var output = [], next = urls.models, page = 0;
    try {
      while (next && page < 20) {
        var result = await app.platform.network.requestJson({ url: next, method: "GET", headers: headers, timeoutMs: 45000 });
        output = output.concat(normalizeModelList(result.data, definition));
        next = nextModelsUrl(next, result.data, definition, page);
        page += 1;
      }
    } catch (error) {
      if (definition.discovery !== "openai-optional") throw error;
      var fallback = allModels("llm", service);
      return { models: fallback, catalogState: "reviewed-registry", discovered: false, warnings: ["服务未开放通用模型目录，已保留应用内审核候选并继续执行指定模型验证"] };
    }
    output = unique(output);
    if (definition.discovery === "ollama") output = await enrichOllamaModels(output, urls.models, headers);
    return { models: output, catalogState: "fetched", discovered: true, warnings: [] };
  }

  function discoveredTtsModel(item, definition) {
    var id = String(item.model_id || item.id || item.name || "");
    var known = (definition.models || []).find(function (entry) { return entry.id === id; });
    return Object.assign({}, known || {}, {
      id: id,
      name: item.name || item.display_name || id,
      kind: "tts",
      description: item.description || "",
      streaming: item.streaming == null ? definition.streaming === true : Boolean(item.streaming),
      audioStreaming: item.streaming == null ? (known ? known.audioStreaming !== false : definition.streaming === true) : Boolean(item.streaming),
      textStreaming: known && known.textStreaming === true,
      maxCharacters: Number(item.maximum_text_length_per_request || item.max_characters_request_subscribed_user || item.max_characters_request_free_user || known && known.maxCharacters || 0) || null,
      languages: (item.languages || []).map(function (language) { return language.language_id || language.id || language.name; }).filter(Boolean),
      voiceStyle: item.can_use_style === true,
      speakerBoost: item.can_use_speaker_boost === true,
      capabilitySource: "service-directory"
    });
  }

  async function requestVoicePages(url, headers, parser) {
    var output = [], next = url, page = 0;
    while (next && page < 20) {
      var result = await app.platform.network.requestJson({ url: next, method: "GET", headers: headers, timeoutMs: 45000 });
      var parsed = parser(result.data || {});
      output = output.concat(parsed.voices || []);
      next = parsed.next || "";
      page += 1;
    }
    return unique(output);
  }

  function elevenVoiceParser(baseUrl) {
    return function (data) {
      var output = (data.voices || []).map(function (item) {
        return {
          id: item.voice_id || item.id,
          name: item.name || item.voice_id || item.id,
          category: item.category || "",
          highQualityModelIds: (item.high_quality_base_model_ids || []).slice(),
          verifiedLanguages: (item.verified_languages || []).map(function (entry) { return { language: entry.language || entry.locale || "", modelId: entry.model_id || "" }; }),
          verifiedModelIds: (item.verified_languages || []).map(function (entry) { return entry.model_id || ""; }).filter(Boolean),
          fineTuningStates: Object.assign({}, item.fine_tuning && item.fine_tuning.state || {}),
          capabilitySource: "account-directory"
        };
      });
      var next = "";
      if (data.has_more && data.next_page_token) {
        var parsed = new URL(baseUrl); parsed.searchParams.set("page_size", "100"); parsed.searchParams.set("next_page_token", data.next_page_token); next = parsed.toString();
      }
      return { voices: output, next: next };
    };
  }

  function flatVoice(item) {
    return {
      id: item.voice_id || item.id || item.ShortName || item.short_name || item.name,
      name: item.display_name || item.DisplayName || item.LocalName || item.name || item.voice_id || item.id,
      locale: item.locale || item.Locale || "",
      styles: item.styles || item.StyleList || [],
      compatibleModelIds: item.supported_engines || item.SupportedEngines || item.compatibleModelIds || [],
      category: item.category || item.voice_type || "",
      capabilitySource: "service-directory"
    };
  }

  async function discoverTts(service, definition, urls, headers) {
    var nextModels = null, nextVoices = null, warnings = [], succeeded = 0;
    if (urls.models) {
      nextModels = Promise.resolve().then(async function () {
        var result = await discoveryRequest(definition, service, { url: urls.models, method: "GET", headers: headers, timeoutMs: 45000 });
        var raw = Array.isArray(result.data) ? result.data : result.data.data || result.data.models || [];
        if (definition.id === "openai" || definition.id === "gemini-tts") {
          var registryIds = (definition.models || []).map(function (item) { return item.id; });
          raw = raw.filter(function (item) {
            var id = String(item.id || item.name || "").replace(/^models\//, "");
            return registryIds.indexOf(id) >= 0 || /tts|speech/i.test(id);
          });
        }
        if (definition.id === "elevenlabs") raw = raw.filter(function (item) { return item.can_do_text_to_speech !== false; });
        return unique(raw.map(function (item) {
          if (String(item.name || "").indexOf("models/") === 0 && !item.id) item = Object.assign({}, item, { id: String(item.name).replace(/^models\//, "") });
          return discoveredTtsModel(item, definition);
        }).filter(function (item) { return item.id; }));
      });
    }
    if (urls.voices) {
      nextVoices = Promise.resolve().then(async function () {
        if (definition.id === "elevenlabs") return requestVoicePages(urls.voices, headers, elevenVoiceParser(urls.voices));
        if (definition.id === "minimax-tts") {
          var mini = await discoveryRequest(definition, service, { url: urls.voices, method: "POST", headers: headers, bodyText: JSON.stringify({ voice_type: "all" }), contentType: "application/json", timeoutMs: 45000 });
          var data = mini.data && mini.data.data || mini.data || {}, lists = ["system_voice", "voice_cloning", "voice_generation", "voice_cloning_list", "voice_generation_list"];
          var merged = []; lists.forEach(function (key) { if (Array.isArray(data[key])) merged = merged.concat(data[key]); });
          return unique(merged.map(flatVoice));
        }
        if (definition.id === "qwen-tts") {
          var qwen = await discoveryRequest(definition, service, { url: urls.voices, method: "POST", headers: headers, bodyText: JSON.stringify({ model: "qwen-voice-enrollment", input: { action: "list" } }), contentType: "application/json", timeoutMs: 45000 });
          var qwenItems = qwen.data && qwen.data.output && (qwen.data.output.voice_list || qwen.data.output.voices) || [];
          return unique(qwenItems.map(function (item) {
            var voice = flatVoice(item); if (item.target_model) voice.compatibleModelIds = [item.target_model]; return voice;
          }));
        }
        var result = await discoveryRequest(definition, service, { url: urls.voices, method: "GET", headers: headers, timeoutMs: 45000 });
        var raw = Array.isArray(result.data) ? result.data : result.data.voices || result.data.data || result.data.items || [];
        return unique(raw.map(flatVoice));
      });
    }
    var settled = await Promise.all([settle(nextModels), settle(nextVoices)]);
    if (settled[0].status === "fulfilled" && settled[0].value) { service.models = settled[0].value; service.modelsDiscovered = true; succeeded += 1; }
    else if (nextModels) {
      warnings.push(definition.id === "elevenlabs" ? "模型目录暂时不可读，已使用内置 ElevenLabs 模型目录" : "模型目录暂时不可读，保留审核目录或上次成功结果");
      if (definition.models && definition.models.length) service.modelsDiscovered = false;
    }
    if (settled[1].status === "fulfilled" && settled[1].value) {
      service.voices = unique((definition.voices || []).concat(settled[1].value)); service.voicesDiscovered = true; succeeded += 1;
    } else if (nextVoices) warnings.push("音色目录暂时不可读，保留上次成功结果");
    if (!nextModels && !nextVoices) {
      service.models = allModels("tts", service); service.voices = allVoices(service);
      return { models: service.models, voices: service.voices, catalogState: "reviewed-registry", warnings: warnings, discovered: false };
    }
    if (!succeeded) {
      var failure = settled[1].status === "rejected" ? settled[1].reason : settled[0].reason;
      failure.discoveryWarnings = warnings; throw failure;
    }
    return { models: allModels("tts", service), voices: allVoices(service), catalogState: "fetched", warnings: warnings, discovered: true };
  }

  async function discoverAsr(service, definition, urls, headers) {
    if (definition.discovery === "registry" || definition.discovery === "none" || !urls.models) {
      var registry = (definition.models || []).slice();
      return { models: registry, voices: [], catalogState: "reviewed-registry", warnings: [], discovered: false };
    }
    var response = await discoveryRequest(definition, service, { url: urls.models, method: "GET", headers: headers, timeoutMs: 45000 });
    var raw = Array.isArray(response.data) ? response.data : response.data && (response.data.data || response.data.models) || [];
    var models = unique(raw.map(function (item) { return discoveredModel(item, definition); }).filter(function (item) {
      var id = String(item.id || "");
      return item.kind === "asr" || /transcrib|whisper|speech[-_ ]?to[-_ ]?text|\bstt\b|scribe/i.test(id);
    }));
    if (!models.length && definition.models && definition.models.length) models = definition.models.slice();
    return { models: models, voices: [], catalogState: "fetched", warnings: [], discovered: true };
  }

  // 绘图（CVP）：一次 /cvp/info 就够 —— 它公开、不带密码也会返回（密码对不对由 auth.authorized 说），
  // 而且同时给出能力清单、每项能力的输入需求 / 忽略字段 / 默认值 / 允许画幅。chataxi 把每个
  // category 含 "render" 的能力映射成一张单模型卡片（卡片 = 能力，不是 checkpoint 文件名）。
  // 只收 "render"：它才是"重画成品图"，与"在对话里画一张照片"这件事对得上；
  // quick / inpaint / upscale 是画布工具，本轮不做（见 plans 的「明确不做」）。
  //
  // 不保存原始 /cvp/info：能力里已经带上画幅 / 步数 / 默认值与模型挂载点，draw.js 从
  // modelDefinition("image", …) 就能拿到全部要用的东西，省得再存一份可能超 63 KB 的记录。
  async function discoverImage(service, definition) {
    var base = cvpBase(service.endpoint);
    if (!base) throw new Error("请填写 CVP 插件的地址（ComfyUI 的地址，插件装在里面）");
    var headers = authHeaders("image", service);
    Object.assign(headers, app.utils.parseHeaders(service.customHeaders));
    var result = await app.platform.network.requestJson({ url: base + "/cvp/info", method: "GET", headers: headers, timeoutMs: 30000 });
    var document = result.data || {};
    if (!document.spec) throw new Error("这个地址不是 CVP 服务：请在 ComfyUI 中确认已安装 HamDraw 插件并重启");
    var auth = document.auth || {};
    if (auth.required && auth.authorized === false) throw new Error("访问密码不正确，请在 ComfyUI 的 HamDraw 配置节点里核对密码");
    var capabilities = (document.capabilities || []).filter(function (item) { return item && item.id && (item.category || []).indexOf("render") >= 0; });
    if (!capabilities.length) throw new Error("插件没有提供成品图（category: render）能力，请升级插件");
    service.plugin = document.plugin || {};
    var models = capabilities.map(function (item) {
      var label = item.label || {}, description = item.description || {};
      return {
        id: String(item.id),
        name: label.zh || label.en || String(item.id),
        description: app.i18n.pick(description.zh || description.en || "", description.en || description.zh || ""),
        aliases: (item.aliases || []).map(String),
        ready: item.ready !== false,
        roles: (item.models || []).map(function (entry) { return { role: String(entry.role || ""), name: String(entry.name || ""), ready: entry.ready !== false }; }),
        promptLanguage: (item.prompt || {}).language || "",
        needs: item.needs || {},
        ignores: (item.ignores || []).map(String),
        defaults: item.defaults || {},
        sizes: ((item.values || {}).size || []).map(function (pair) { return [Number(pair[0]), Number(pair[1])]; }),
        steps: ((item.values || {}).steps || []).map(Number),
        typicalSeconds: Number(item.typical_seconds || 0),
        capabilitySource: "capability-directory"
      };
    });
    return { models: models, voices: [], catalogState: "fetched", warnings: [], discovered: true };
  }

  function settle(value) {
    if (!value) return Promise.resolve({ status: "skipped", value: null });
    return Promise.resolve(value).then(function (result) { return { status: "fulfilled", value: result }; }, function (reason) { return { status: "rejected", reason: reason }; });
  }

  function discoveryRequest(definition, service, request) {
    if (definition.auth === "aws-sigv4") {
      request.headers = Object.assign({}, request.headers || {}, app.services.awsSigV4.sign({
        method: request.method || "GET", url: request.url, body: request.bodyText || "", contentType: request.contentType || "application/json",
        region: service.region, service: "polly", accessKeyId: service.accessKeyId,
        secretAccessKey: service.apiKey, sessionToken: service.sessionToken || ""
      }));
    }
    return app.platform.network.requestJson(request);
  }

  async function discover(kind, service, options) {
    var definition = family(kind, service.family || service.type);
    var urls = discoveryUrls(kind, service), headers = authHeaders(kind, service), result;
    Object.assign(headers, app.utils.parseHeaders(service.customHeaders));
    if (kind === "image") result = await discoverImage(service, definition);
    else if (kind === "tts") result = await discoverTts(service, definition, urls, headers);
    else if (kind === "asr") result = await discoverAsr(service, definition, urls, headers);
    else result = await discoverLlm(service, definition, urls, headers);
    if (kind === "llm" || kind === "asr" || kind === "image") {
      service.models = result.models;
      service.modelsDiscovered = result.discovered;
    }
    service.catalogState = result.catalogState;
    service.registryVersion = catalog.registryVersion;
    service.discoveredAt = Date.now();
    service.discoveryWarnings = result.warnings || [];
    if (!options || options.persist !== false) await app.data.store.put(kind + "-profiles", service.id, service);
    return {
      models: allModels(kind, service),
      voices: kind === "tts" ? allVoices(service) : [],
      discovered: result.discovered,
      catalogState: result.catalogState,
      warnings: service.discoveryWarnings
    };
  }

  function ttsCapabilities(service, modelId) {
    if (!service || service.enabled === false) return { streaming: false, audioStreaming: false, textStreaming: false, reason: "朗读服务不可用" };
    var selected = modelId || service.defaultModelId || service.model || (models("tts", service)[0] || {}).id || "";
    var definition = modelDefinition("tts", service, selected);
    var audioStreaming = definition.audioStreaming === true;
    return {
      streaming: audioStreaming,
      audioStreaming: audioStreaming,
      textStreaming: definition.textStreaming === true,
      modelId: selected,
      reason: audioStreaming ? "" : definition.audioStreaming === false ? "所选朗读模型不支持流式音频输出" : "尚未验证该模型的流式音频能力"
    };
  }

  function parameterProfile(kind, service) {
    var list = allModels(kind, service).map(function (item) { return modelDefinition(kind, service, item.id); });
    var names = list.map(function (item) {
      var result = (item.supportedParameters || []).slice();
      if (item.temperature === true && result.indexOf("temperature") < 0) result.push("temperature");
      if (item.maxOutputTokens && result.indexOf("max_output_tokens") < 0) result.push("max_output_tokens");
      if ((item.reasoning || []).length && result.indexOf("reasoning_effort") < 0) result.push("reasoning_effort");
      if (item.thinkingMode && result.indexOf("thinking") < 0) result.push("thinking");
      if (item.imageInput === true && result.indexOf("image_input") < 0) result.push("image_input");
      if (item.videoInput === true && result.indexOf("video_input") < 0) result.push("video_input");
      if (item.imageGeneration === true && result.indexOf("image_generation") < 0) result.push("image_generation");
      return result;
    });
    var common = names.length ? names[0].filter(function (name) { return names.every(function (values) { return values.indexOf(name) >= 0; }); }) : [];
    return {
      common: common,
      models: list.map(function (item, index) {
        return { id: item.id, parameters: names[index], special: names[index].filter(function (name) { return common.indexOf(name) < 0; }) };
      })
    };
  }

  function selectionGroups(kind, items, service) {
    return app.services.modelRegistry.groupModels(kind, items || [], service || {});
  }

  function toSingleProfile(kind, service, modelId, modelFamilyId) {
    var source = service.catalogModels || service.models || [];
    var item = source.find(function (entry) { return (typeof entry === "string" ? entry : entry.id) === modelId; });
    if (typeof item === "string") item = { id: item, name: item };
    if (!item) item = { id: modelId, name: modelId, capabilitySource: "unknown" };
    return app.services.modelRegistry.normalizeSingle(kind, service, mergeKnown(kind, family(kind, service.family || service.type), item), modelFamilyId);
  }

  app.services.modelServices = {
    families: families,
    family: family,
    allModels: allModels,
    models: models,
    voices: voices,
    allVoices: allVoices,
    cvpBase: cvpBase,
    voiceCompatibility: voiceCompatibility,
    recordTtsVerification: recordTtsVerification,
    serviceStatus: serviceStatus,
    computedEndpoint: computedEndpoint,
    resolveLlm: resolveLlm,
    resolveTts: resolveTts,
    resolveAsr: resolveAsr,
    authHeaders: authHeaders,
    discoveryUrl: discoveryUrl,
    discoveryUrls: discoveryUrls,
    discover: discover,
    modelDefinition: modelDefinition,
    parameterProfile: parameterProfile,
    parameterAvailable: parameterAvailable,
    ttsCapabilities: ttsCapabilities,
    requiredCredentialMessage: requiredCredentialMessage,
    selectionGroups: selectionGroups,
    toSingleProfile: toSingleProfile,
    resolvedCapabilities: function (kind, service, modelId) { return app.services.modelRegistry.resolvedCapabilities(kind, service, modelDefinition(kind, service, modelId)); }
  };
})(window.chataxi);
