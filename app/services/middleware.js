(function (app) {
  "use strict";

  function compact(value) {
    if (Array.isArray(value)) return value.map(compact).filter(function (item) { return item !== undefined; });
    if (!value || typeof value !== "object") return value;
    var output = {};
    Object.keys(value).forEach(function (key) {
      var item = compact(value[key]);
      if (item !== undefined && item !== null && item !== "") output[key] = item;
    });
    return output;
  }
  function canonicalLlm(profile, role, messages, options) {
    var capabilities = profile.resolvedCapabilities || app.services.modelRegistry.resolvedCapabilities("llm", profile, profile.modelInfo || {}), generation = {};
    if (capabilities.parameters.maxOutputTokens === "supported" && profile.maxOutputTokens !== "") generation.maxOutputTokens = profile.maxOutputTokens;
    if (capabilities.parameters.temperature === "supported" && profile.temperature !== "") generation.temperature = profile.temperature;
    if (capabilities.parameters.topP === "supported" && role.topPOverride && role.topP != null) generation.topP = Number(role.topP);
    if (capabilities.parameters.topK === "supported" && role.topKOverride && role.topK != null) generation.topK = Number(role.topK);
    if (capabilities.parameters.reasoning === "supported" && (profile.reasoningEffort || profile.thinkingEnabled)) generation.reasoning = { effort: profile.reasoningEffort, enabled: profile.thinkingEnabled, budgetTokens: profile.thinkingBudget };
    generation.imageGeneration = capabilities.capabilities.imageGeneration === "supported" && profile.allowImageGeneration === true;
    return compact({
      modelProfileId: profile.id,
      externalModelId: profile.model,
      instructions: role.systemPrompt || "",
      input: (messages || []).map(function (message) {
        var content = [];
        if (message.text) content.push({ type: "input_text", text: message.text });
        (message.images || []).forEach(function (image) { content.push({ type: "input_image", source: image }); });
        (message.videos || []).forEach(function (video) { content.push({ type: "input_video", source: video }); });
        return { role: message.role, speakerKind: message.speakerKind, systemType: message.systemType, content: content };
      }),
      generation: generation,
      stream: !options || options.stream !== false,
      systemRoleMode: profile.systemRoleMode || profile.resolvedCapabilities && profile.resolvedCapabilities.systemRoleMode || "native"
    });
  }
  function compileLlm(profile, role, messages, options) {
    var canonical = canonicalLlm(profile, role, messages, options);
    var safeRole = Object.assign({}, role, {
      topP: canonical.generation.topP,
      topK: canonical.generation.topK
    });
    var request = app.services.providers.build(profile, safeRole, messages, options || {});
    request.canonical = canonical;
    return request;
  }
  function canonicalSpeech(profile, text) {
    return compact({ modelProfileId: profile.id, input: text, voiceId: profile.voice, instructions: profile.instructions, responseFormat: profile.format, speed: profile.speed || profile.rate, stream: profile.streaming === true });
  }
  function canonicalTranscription(profile, audio) {
    return compact({ modelProfileId: profile.id, audio: audio, language: profile.language, prompt: profile.prompt, responseFormat: profile.responseFormat, stream: profile.streaming === true });
  }

  app.services = app.services || {};
  app.services.middleware = { canonicalLlm: canonicalLlm, compileLlm: compileLlm, canonicalSpeech: canonicalSpeech, canonicalTranscription: canonicalTranscription };
})(window.chataxi);
