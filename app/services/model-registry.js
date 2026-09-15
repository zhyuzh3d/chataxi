(function (app) {
  "use strict";

  var VERSION = "2026.09.15.1";
  var AGGREGATORS = { openrouter: true, siliconflow: true, together: true, fireworks: true };
  var LOCAL = { ollama: true, lmstudio: true, vllm: true, sglang: true, llmserver: true, "vllm-omni": true, "fish-tts": true };
  var FIXED_LLM_FAMILIES = {
    openai: "openai", anthropic: "anthropic", gemini: "gemini", xai: "xai",
    deepseek: "deepseek", qwen: "qwen", kimi: "kimi", glm: "glm",
    tokenhub: "hunyuan", "hunyuan-legacy": "hunyuan", ark: "doubao",
    mistral: "mistral", minimax: "minimax", baidu: "baidu"
  };
  var LLM_FAMILIES = [
    { id: "openai", name: "OpenAI / GPT", pattern: /(?:^|\/)(?:gpt-|chatgpt-|o[1-9](?:-|$))/i },
    { id: "anthropic", name: "Anthropic / Claude", pattern: /(?:^|\/)(?:claude[-_.])/i },
    { id: "gemini", name: "Google / Gemini", pattern: /(?:^|\/)(?:gemini[-_.])/i },
    { id: "xai", name: "xAI / Grok", pattern: /(?:^|\/)(?:grok[-_.])/i },
    { id: "deepseek", name: "DeepSeek", pattern: /(?:^|\/)(?:deepseek(?:[-_.\/]|$))/i },
    { id: "kimi", name: "Kimi / Moonshot", pattern: /(?:^|\/)(?:kimi[-_.\/]|moonshot[-_.])/i },
    { id: "qwen", name: "Qwen", pattern: /(?:^|\/)(?:qwen(?:[-_.\/]|$))/i },
    { id: "glm", name: "GLM", pattern: /(?:^|\/)(?:glm[-_.])/i },
    { id: "hunyuan", name: "腾讯混元", pattern: /(?:^|\/)(?:hunyuan|hy[-_])/i },
    { id: "llama", name: "Meta / Llama", pattern: /(?:^|\/)(?:llama[-_.]|meta-llama\/)/i },
    { id: "mistral", name: "Mistral", pattern: /(?:^|\/)(?:mistral|ministral|codestral|magistral)(?:[-_.]|$)/i },
    { id: "minimax", name: "MiniMax", pattern: /(?:^|\/)(?:minimax[-_.]|abab[-_.])/i },
    { id: "doubao", name: "豆包 / Seed", pattern: /(?:^|\/)(?:doubao[-_.]|seed[-_.])/i },
    { id: "baidu", name: "百度 / ERNIE", pattern: /(?:^|\/)(?:ernie[-_.])/i },
    { id: "unknown", name: "未知系列" }
  ];
  var SPECIALIST = {
    tts: /(?:^|[-_.\/])(?:tts|speech-synthesis|text-to-speech)(?:$|[-_.\/])|gpt-.*-tts|cosyvoice/i,
    asr: /(?:^|[-_.\/])(?:asr|whisper|transcrib|speech-to-text|paraformer|scribe)(?:$|[-_.\/])/i,
    other: /embedding|moderation|rerank|image-generation|dall-e|text-to-image|video-generation/i
  };

  function providerId(service) { return String(service && (service.providerPresetId || service.family || service.type) || "custom"); }
  function sourceMode(service) {
    var id = providerId(service);
    if (LOCAL[id]) return "local";
    if (AGGREGATORS[id] || id === "custom") return "aggregator";
    return "official";
  }
  function transportCodec(kind, service) {
    var id = providerId(service), definition = app.services.catalog && app.services.catalog[kind === "llm" ? "llmFamilies" : kind === "tts" ? "ttsFamilies" : "asrFamilies"].find(function (item) { return item.id === id; }) || {};
    if (kind === "llm") return service && service.apiStyle || definition.apiStyle || "openai-chat";
    return service && service.protocol || definition.protocol || definition.type || id;
  }
  function suggestFamily(kind, modelId, service) {
    var id = String(modelId || "");
    if (kind !== "llm") return providerId(service);
    var fixed = FIXED_LLM_FAMILIES[providerId(service)];
    if (fixed && sourceMode(service) === "official") return fixed;
    for (var index = 0; index < LLM_FAMILIES.length - 1; index += 1) if (LLM_FAMILIES[index].pattern.test(id)) return LLM_FAMILIES[index].id;
    return "unknown";
  }
  function familyItems(kind) {
    if (kind !== "llm") return [];
    return LLM_FAMILIES.map(function (item) { return { id: item.id, name: item.name }; });
  }
  function explicitKind(item) {
    var value = String(item && (item.kind || item.modelKind || item.model_type || item.type) || "").toLowerCase();
    if (/tts|text.to.speech|speech.synthesis/.test(value)) return "tts";
    if (/asr|speech.to.text|transcri/.test(value)) return "asr";
    if (/chat|language|llm|completion/.test(value)) return "llm";
    return "";
  }
  function classify(kind, item, service) {
    var id = String(item && item.id || ""), declared = explicitKind(item), family = suggestFamily(kind, id, service), source = item && item.capabilitySource || "unknown";
    var inferred = SPECIALIST.tts.test(id) ? "tts" : SPECIALIST.asr.test(id) ? "asr" : SPECIALIST.other.test(id) ? "other" : family !== "unknown" ? "llm" : "";
    var matches = declared ? declared === kind : inferred ? inferred === kind : false;
    var group = "unknown";
    if ((declared || inferred) && !matches) group = "excluded";
    if (matches && (declared || source === "service-directory" || source === "account-directory" || source === "runtime-directory" || source === "reviewed-registry" || source === "service-directory+reviewed-registry")) group = "recommended";
    else if (matches) group = "possible";
    return Object.assign({}, item, {
      selectionGroup: group,
      modelFamilySuggestion: family,
      classificationSource: declared ? "provider-directory" : inferred ? "reviewed-rule" : "unknown",
      classificationVersion: VERSION
    });
  }
  function groupModels(kind, items, service) {
    var ranks = { recommended: 0, possible: 1, unknown: 2 };
    return (items || []).map(function (item) { return classify(kind, item, service); }).filter(function (item) { return item.selectionGroup !== "excluded"; }).sort(function (left, right) {
      return ranks[left.selectionGroup] - ranks[right.selectionGroup] || String(left.name || left.id).localeCompare(String(right.name || right.id), "zh-CN");
    });
  }
  function normalizeSingle(kind, service, model, familyId) {
    var next = Object.assign({}, service), item = Object.assign({}, model || { id: service.externalModelId || service.model || service.defaultModelId || "" });
    next.singleModelVersion = 1;
    next.providerPresetId = providerId(next);
    next.sourceMode = sourceMode(next);
    next.transportCodecId = transportCodec(kind, next);
    next.externalModelId = item.id;
    next.model = item.id;
    next.defaultModelId = item.id;
    next.models = item.id ? [item] : [];
    next.enabledModelIds = item.id ? [item.id] : [];
    next.modelFamilyId = familyId || next.modelFamilyId || suggestFamily(kind, item.id, next);
    next.familySelectionSource = familyId ? "user" : next.sourceMode === "official" ? "fixed" : "rule";
    next.capabilitySnapshot = item.id ? item : null;
    delete next.catalogModels;
    delete next.directorySourceId;
    return next;
  }
  function capabilityState(value) { return value === true ? "supported" : value === false ? "unsupported" : "unknown"; }
  function resolvedCapabilities(kind, service, model) {
    model = model || {};
    return {
      modelProfileId: service && service.id || "",
      connectionRevision: service && service.connectionRevision || "",
      registryRevision: app.services.catalog && app.services.catalog.registryVersion || VERSION,
      capabilities: {
        imageInput: capabilityState(model.imageInput),
        videoInput: capabilityState(model.videoInput),
        imageGeneration: capabilityState(model.imageGeneration),
        audioStreaming: capabilityState(model.audioStreaming),
        textStreaming: capabilityState(model.textStreaming)
      },
      parameters: {
        temperature: model.temperature === true ? "supported" : model.temperature === false ? "unsupported" : "unknown",
        maxOutputTokens: model.maxOutputTokens || (model.supportedParameters || []).some(function (name) { return /max.*tokens/i.test(name); }) ? "supported" : "unknown",
        topP: (model.supportedParameters || []).indexOf("top_p") >= 0 ? "supported" : "unknown",
        topK: (model.supportedParameters || []).indexOf("top_k") >= 0 ? "supported" : "unknown",
        reasoning: (model.reasoning || []).length || model.thinkingMode ? "supported" : "unknown"
      },
      optionDomains: {
        reasoning: { source: (model.reasoning || []).length ? "official-registry" : "none", status: (model.reasoning || []).length ? "ready" : "unknown", values: (model.reasoning || []).slice() },
        voices: { source: service && service.voicesDiscovered ? "provider-directory" : "official-registry", status: service && (service.voices || []).length ? "ready" : "unknown", values: service && service.voices || [] }
      },
      transport: transportCodec(kind, service),
      evidence: model.capabilityEvidence || null,
      conflicts: []
    };
  }

  app.services = app.services || {};
  app.services.modelRegistry = {
    version: VERSION,
    sourceMode: sourceMode,
    transportCodec: transportCodec,
    suggestFamily: suggestFamily,
    familyItems: familyItems,
    classify: classify,
    groupModels: groupModels,
    normalizeSingle: normalizeSingle,
    resolvedCapabilities: resolvedCapabilities
  };
})(window.chataxi);
