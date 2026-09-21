import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const window = {
  chataxi: {},
  crypto: globalThis.crypto,
  URL,
  Blob,
  TextEncoder,
  Uint8Array,
  setTimeout,
  clearTimeout,
  btoa,
  atob
};
const context = vm.createContext({ window, URL, Blob, TextEncoder, Uint8Array, FileReader: class {}, btoa, atob, console, setTimeout, clearTimeout });
for (const relative of ["app/core/namespace.js", "app/core/utils.js", "app/services/catalog.js", "app/services/model-registry.js", "app/services/aws-sigv4.js", "app/services/model-services.js", "app/services/providers.js", "app/services/middleware.js", "app/services/llm.js", "app/services/tts.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, relative), "utf8"), context, { filename: relative });
}
const providers = window.chataxi.services.providers;
const llm = window.chataxi.services.llm;
const modelServices = window.chataxi.services.modelServices;
const tts = window.chataxi.services.tts;
const registry = window.chataxi.services.modelRegistry;
const middleware = window.chataxi.services.middleware;
const image = "data:image/png;base64,iVBORw0KGgo=";
const messages = [
  { role: "user", text: "看图", images: [{ dataUrl: image, detail: "auto" }] },
  { role: "assistant", roleName: "小岚", text: "我看到了。", images: [] }
];
const role = { systemPrompt: "简洁回答。" };

test("builds OpenAI Responses multimodal request", () => {
  const request = providers.build({ apiStyle: "openai-responses", endpoint: "http://192.168.1.2:4815/v1/responses", model: "terra", apiKey: "token", maxOutputTokens: 256 }, role, messages);
  assert.equal(request.headers.Authorization, "Bearer token");
  assert.equal(request.body.input[0].content[1].type, "input_image");
  assert.equal(request.body.instructions, role.systemPrompt);
});

test("builds OpenAI Chat Completions request", () => {
  const request = providers.build({ apiStyle: "openai-chat", endpoint: "https://api.example/v1/chat/completions", model: "chat", apiKey: "token", maxOutputTokens: 256, temperature: "" }, role, messages);
  assert.equal(request.body.messages[0].role, "system");
  assert.equal(request.body.messages[1].content[1].type, "image_url");
});

test("builds Anthropic base64 image request", () => {
  const request = providers.build({ apiStyle: "anthropic-messages", endpoint: "https://api.anthropic.com/v1/messages", model: "claude", apiKey: "token", maxOutputTokens: 256, temperature: "" }, role, messages);
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  assert.equal(request.body.messages[0].content[0].source.media_type, "image/png");
  assert.equal(request.body.system, role.systemPrompt);
});

test("builds Gemini inline image request", () => {
  const request = providers.build({ apiStyle: "gemini-generate-content", endpoint: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", model: "gemini-test", apiKey: "token", maxOutputTokens: 256, temperature: "" }, role, messages);
  assert.match(request.url, /models\/gemini-test:generateContent$/);
  assert.equal(request.headers["x-goog-api-key"], "token");
  assert.equal(request.body.contents[0].parts[0].inline_data.mime_type, "image/png");
});

test("all six language protocols keep scene and summary in their native system channel", () => {
  const history = [
    { role: "system", systemType: "scene", text: "夜雨中的旧车站" },
    { role: "system", systemType: "summary", text: "两人已经交换暗号" },
    { role: "user", text: "继续" }
  ];
  const profiles = [
    { apiStyle: "openai-responses", endpoint: "https://example.com/v1/responses", model: "r" },
    { apiStyle: "openai-chat", endpoint: "https://example.com/v1/chat/completions", model: "c" },
    { apiStyle: "anthropic-messages", endpoint: "https://example.com/v1/messages", model: "a" },
    { apiStyle: "gemini-interactions", endpoint: "https://example.com/v1/interactions", model: "gi" },
    { apiStyle: "gemini-generate-content", endpoint: "https://example.com/v1beta/models/{model}:generateContent", model: "gg" },
    { apiStyle: "ollama-chat", endpoint: "http://127.0.0.1:11434/api/chat", model: "o" }
  ];
  const built = profiles.map(profile => providers.build({ ...profile, systemRoleMode: "native", maxOutputTokens: 256, temperature: "" }, role, history));
  const nativePrompts = [
    built[0].body.instructions,
    built[1].body.messages[0].content,
    built[2].body.system,
    built[3].body.system_instruction,
    built[4].body.systemInstruction.parts[0].text,
    built[5].body.messages[0].content
  ];
  nativePrompts.forEach(prompt => {
    assert.match(prompt, /简洁回答/);
    assert.match(prompt, /\[场景设定\][\s\S]*旧车站/);
    assert.match(prompt, /\[历史概要\][\s\S]*交换暗号/);
  });
});

test("unknown-model fallback converts persistent and historical system content to one tagged user message", () => {
  const request = providers.build({ apiStyle: "openai-responses", endpoint: "https://example.com/v1/responses", model: "future-model", systemRoleMode: "tagged-user", maxOutputTokens: 256 }, role, [
    { role: "system", systemType: "scene", text: "场景正文" },
    { role: "system", systemType: "summary", text: "概要正文" },
    { role: "user", text: "用户发言" }
  ]);
  assert.equal(request.body.instructions, undefined);
  assert.equal(request.body.input[0].role, "user");
  assert.match(request.body.input[0].content, /^\[角色与用户设定\]/);
  assert.match(request.body.input[0].content, /\[场景设定\][\s\S]*场景正文/);
  assert.match(request.body.input[0].content, /\[历史概要\][\s\S]*概要正文/);
  assert.equal(request.body.input[1].content, "用户发言");
});

test("model registry selects native system handling for mapped families and tagged-user for an unmapped model", () => {
  assert.equal(registry.resolvedCapabilities("llm", { family: "custom", modelFamilyId: "openai" }, { id: "gpt-5" }).systemRoleMode, "native");
  assert.equal(registry.resolvedCapabilities("llm", { family: "custom" }, { id: "vendor/future-model" }).systemRoleMode, "tagged-user");
  assert.equal(registry.resolvedCapabilities("llm", { family: "custom", systemRoleMode: "native" }, { id: "vendor/future-model" }).systemRoleMode, "native");
});

test("parses all supported text response shapes", () => {
  assert.equal(providers.parse({ apiStyle: "openai-responses" }, { output_text: "R" }).text, "R");
  assert.equal(providers.parse({ apiStyle: "openai-chat" }, { choices: [{ message: { content: "C" } }] }).text, "C");
  assert.equal(providers.parse({ apiStyle: "anthropic-messages" }, { content: [{ type: "text", text: "A" }] }).text, "A");
  assert.equal(providers.parse({ apiStyle: "gemini-generate-content" }, { candidates: [{ content: { parts: [{ text: "G" }] } }] }).text, "G");
});

test("extracts Responses image generation output", () => {
  const result = providers.parse({ apiStyle: "openai-responses" }, { output: [{ type: "image_generation_call", result: "AA==" }] });
  assert.equal(result.images[0].dataUrl, "data:image/png;base64,AA==");
});

test("removes a leading role marker from display text", () => {
  assert.equal(llm.removeRoleEcho("[Alice] Generated.", "Alice"), "Generated.");
  assert.equal(llm.removeRoleEcho("[Alice]", "Alice"), "");
  assert.equal(llm.removeRoleEcho("Keep [Alice] inside", "Alice"), "Keep [Alice] inside");
  assert.equal(llm.partialText("【兰", "兰兰", [{ name: "兰兰" }, { name: "爱丽丝" }]), "");
  assert.throws(() => llm.removeRoleEcho("[爱丽丝] 我来回答", "兰兰", [{ name: "兰兰" }, { name: "爱丽丝" }]), /已拦截/);
});

test("other role history is submitted as labelled reference instead of active assistant output", async () => {
  const hydrated = await llm.hydrateMessages([
    { kind: "user", text: "问题" },
    { kind: "assistant", roleId: "alice", roleName: "爱丽丝", text: "爱丽丝的回答" },
    { kind: "assistant", roleId: "lanlan", roleName: "兰兰", text: "兰兰以前的回答" }
  ], {}, { id: "lanlan", name: "兰兰" });
  assert.deepEqual(Array.from(hydrated, item => item.role), ["user", "user", "assistant"]);
  const routed = llm.routeTurn(hydrated, { name: "兰兰" });
  const request = providers.build({ apiStyle: "openai-responses", endpoint: "https://example.com/v1/responses", model: "fixture", maxOutputTokens: 256 }, role, routed);
  assert.match(request.body.input[1].content, /其他角色「爱丽丝」的历史发言.*禁止模仿/);
  assert.match(request.body.input.at(-1).content, /只有「兰兰」被点名回答/);
});

test("Anthropic uses the API key header and structured image URLs are parsed", () => {
  assert.equal(providers.headers({ apiStyle: "anthropic-messages", apiKey: "fixture" })["x-api-key"], "fixture");
  const result = providers.parse({ apiStyle: "openai-chat" }, { choices: [{ message: { content: [{ type: "text", text: "图片" }, { type: "image_url", image_url: { url: image } }] } }] });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].dataUrl, image);
});

test("ordinary links and annotations are not silently loaded as images", () => {
  const result = providers.parse({ apiStyle: "openai-responses" }, { output_text: "参考链接", annotations: [{ url: "https://example.com/tracker" }], images: [{ url: "https://example.com/image.png" }] });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].dataUrl, "https://example.com/image.png");
});

test("Gemini inline images and Responses image output formats are retained", () => {
  assert.equal(providers.parse({ apiStyle: "gemini-generate-content" }, { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: "AA==" } }] } }] }).images[0].dataUrl, "data:image/jpeg;base64,AA==");
  assert.equal(providers.parse({ apiStyle: "openai-responses" }, { output: [{ type: "image_generation_call", output_format: "webp", result: "AA==" }] }).images[0].dataUrl, "data:image/webp;base64,AA==");
});

test("context clipping observes both count and character budget without mutating records", () => {
  const messages = [{ kind: "user", text: "早期" }, { kind: "assistant", text: "长".repeat(60000) }];
  const clipped = llm.truncate(messages, 40);
  assert.equal(clipped.length, 1); assert.equal(clipped[0].text.length, 48000);
  assert.equal(clipped[0].contextTruncated, true); assert.equal(messages[1].text.length, 60000);
});

test("model selection groups keep specialist and unknown models out of recommended chat results", () => {
  const grouped = registry.groupModels("llm", [
    { id: "openai/gpt-5", name: "GPT", capabilitySource: "service-directory" },
    { id: "openai/gpt-audio-tts", name: "TTS", capabilitySource: "service-directory" },
    { id: "vendor/new-model", name: "Unknown", capabilitySource: "service-directory" }
  ], { family: "openrouter" });
  assert.equal(grouped.find(item => item.id === "openai/gpt-5").selectionGroup, "recommended");
  assert.equal(grouped.some(item => item.id === "openai/gpt-audio-tts"), false);
  assert.equal(grouped.at(-1).id, "vendor/new-model");
});

test("canonical middleware removes generation fields that current capability evidence does not support", () => {
  const profile = {
    id: "single", model: "unknown", apiStyle: "openai-chat", endpoint: "https://example.com/v1/chat/completions",
    modelInfo: { temperature: null, imageGeneration: null, supportedParameters: [], reasoning: [] },
    temperature: 0.7, topP: 0.9, topK: 40, maxOutputTokens: "", allowImageGeneration: true
  };
  const canonical = middleware.canonicalLlm(profile, { systemPrompt: "回答", topPOverride: true, topP: 0.9, topKOverride: true, topK: 40 }, [{ role: "user", text: "你好" }]);
  assert.equal(canonical.generation.temperature, undefined); assert.equal(canonical.generation.topP, undefined); assert.equal(canonical.generation.topK, undefined); assert.equal(canonical.generation.imageGeneration, false);
});

test("model capabilities require an exact official rule or structured directory evidence", () => {
  const refreshed = { family: "openai", apiStyle: "openai-responses", models: [{ id: "gpt-5.1", name: "GPT-5.1 from API" }] };
  const known = modelServices.modelDefinition("llm", refreshed, "gpt-5.1");
  assert.equal(known.name, "GPT-5.1 from API"); assert.equal(known.temperature, false); assert.deepEqual(Array.from(known.reasoning), []); assert.equal(known.imageGeneration, false);
  const unknown = modelServices.modelDefinition("llm", refreshed, "future-model");
  assert.equal(unknown.imageGeneration, false); assert.deepEqual(Array.from(unknown.reasoning), []);
  assert.equal(unknown.temperature, false);
  const grok = modelServices.modelDefinition("llm", { family: "xai", models: [{ id: "grok-4.6", capabilitySource: "service-directory" }] }, "grok-4.6");
  assert.deepEqual(Array.from(grok.reasoning), ["low", "medium", "high", "xhigh"]); assert.equal(grok.thinkingMode, "forced"); assert.equal(grok.imageInput, true);
  const futureGrok = modelServices.modelDefinition("llm", { family: "xai", models: [{ id: "grok-4.7", capabilitySource: "service-directory" }] }, "grok-4.7");
  assert.deepEqual(Array.from(futureGrok.reasoning), []); assert.equal(futureGrok.imageInput, false);
});

test("conditional model parameters disappear from requests when their precondition is false", () => {
  const service = { family: "deepseek", apiStyle: "openai-chat", models: [{ id: "deepseek-v4-pro", capabilitySource: "service-directory" }], defaultModelId: "deepseek-v4-pro" };
  const thinking = modelServices.resolveLlm(service, { model: "deepseek-v4-pro", thinkingEnabled: true, temperature: 0.7, reasoningEffort: "high" });
  assert.equal(thinking.temperature, ""); assert.equal(thinking.reasoningEffort, "high");
  const instant = modelServices.resolveLlm(service, { model: "deepseek-v4-pro", thinkingEnabled: false, temperature: 0.7, reasoningEffort: "high" });
  assert.equal(instant.temperature, 0.7); assert.equal(instant.reasoningEffort, "");
});

test("discovers model metadata and only exposes enabled models to roles", async () => {
  let requested;
  window.chataxi.platform = { network: { requestJson: async request => { requested = request; return { data: { data: [
    { id: "known", supported_parameters: ["temperature", "max_output_tokens"], max_output_tokens: 12000 },
    { id: "reasoner", supported_parameters: ["max_output_tokens"], reasoning_efforts: ["low", "high"] }
  ] } }; } } };
  window.chataxi.data = { store: { put: async () => { throw Error("persist:false must not write"); } } };
  const service = { id: "custom", family: "custom", endpoint: "https://models.example/v1/responses", apiStyle: "openai-responses", apiKey: "secret", models: [] };
  const result = await modelServices.discover("llm", service, { persist: false });
  assert.equal(requested.url, "https://models.example/v1/models");
  assert.equal(requested.headers.Authorization, "Bearer secret");
  assert.equal(result.models[0].maxOutputTokens, 12000);
  assert.equal(result.models[0].temperature, true);
  assert.deepEqual(Array.from(result.models[1].reasoning), ["low", "high"]);
  const profile = modelServices.parameterProfile("llm", service);
  assert.deepEqual(Array.from(profile.common), ["max_output_tokens"]);
  service.enabledModelIds = ["reasoner"];
  assert.deepEqual(Array.from(modelServices.models("llm", service), item => item.id), ["reasoner"]);
});

test("Ollama reads each installed model's real runtime capabilities", async () => {
  const requested = [];
  window.chataxi.platform = { network: { requestJson: async request => {
    requested.push(request);
    if (request.url.endsWith('/api/tags')) return { data: { models: [{ name: 'qwen-local:latest' }] } };
    return { data: { capabilities: ['completion', 'vision', 'thinking'] } };
  } } };
  window.chataxi.data = { store: { put: async () => { throw Error('persist:false must not write'); } } };
  const service = { id: 'ollama', family: 'ollama', endpoint: 'http://192.168.1.8:11434/api/chat', models: [] };
  const result = await modelServices.discover('llm', service, { persist: false }), model = result.models[0];
  assert.equal(requested[1].url, 'http://192.168.1.8:11434/api/show');
  assert.equal(JSON.parse(requested[1].bodyText).model, 'qwen-local:latest');
  assert.equal(model.imageInput, true); assert.equal(model.videoInput, false); assert.equal(model.thinkingMode, 'optional'); assert.equal(model.temperature, true);
  const profile = modelServices.resolveLlm(service, { model: model.id, thinkingEnabled: true, temperature: 0.5 });
  const request = providers.build(profile, {}, [], { stream: true });
  assert.equal(request.body.think, true); assert.equal(request.body.options.temperature, 0.5);
});

test("xAI discovery uses the language model endpoint and reads its capability metadata", async () => {
  let requested;
  window.chataxi.platform = { network: { requestJson: async request => { requested = request; return { data: { models: [
    { id: "grok-fixture", input_modalities: ["text", "image"], output_modalities: ["text"], context_length: 131072 }
  ] } }; } } };
  window.chataxi.data = { store: { put: async () => { throw Error("persist:false must not write"); } } };
  const service = { id: "xai", family: "xai", apiKey: "fixture", models: [] };
  const result = await modelServices.discover("llm", service, { persist: false });
  assert.equal(requested.url, "https://api.x.ai/v1/language-models");
  assert.equal(requested.headers.Authorization, "Bearer fixture");
  assert.deepEqual(Array.from(result.models, model => model.id), ["grok-fixture"]);
  assert.equal(result.models[0].imageInput, true);
  assert.equal(result.models[0].imageGeneration, false);
  assert.equal(result.models[0].contextLength, 131072);
});

test("conversation discovery filters non-chat models and Qwen workspace endpoints stay explicit", async () => {
  window.chataxi.platform = { network: { requestJson: async request => ({ data: { data: [
    { id: "gpt-chat" }, { id: "text-embedding-3-small" }, { id: "whisper-1" }
  ] }, response: request }) } };
  window.chataxi.data = { store: { put: async () => {} } };
  const service = { id: "openai-filter", family: "openai", apiKey: "fixture", models: [] };
  const result = await modelServices.discover("llm", service, { persist: false });
  assert.deepEqual(Array.from(result.models, item => item.id), ["gpt-chat"]);
  const qwen = { family: "qwen", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", workspaceId: "ws123", region: "cn-beijing" };
  assert.equal(modelServices.computedEndpoint("llm", qwen), "https://ws123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(modelServices.discoveryUrls("llm", qwen).models, "https://ws123.cn-beijing.maas.aliyuncs.com/api/v1/models?page_no=1&page_size=100");
});

test("all supported language protocols request native streaming and parse text deltas", () => {
  const profiles = [
    { apiStyle: "openai-responses", endpoint: "https://example.com/v1/responses", model: "r" },
    { apiStyle: "openai-chat", endpoint: "https://example.com/v1/chat/completions", model: "c" },
    { apiStyle: "anthropic-messages", endpoint: "https://api.anthropic.com/v1/messages", model: "a" },
    { apiStyle: "gemini-generate-content", endpoint: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", model: "g" }
  ];
  const built = profiles.map(profile => providers.build({ ...profile, maxOutputTokens: 256 }, role, messages, { stream: true }));
  assert.equal(built[0].body.stream, true); assert.equal(built[1].body.stream, true); assert.equal(built[2].body.stream, true);
  assert.match(built[3].url, /:streamGenerateContent\?alt=sse$/);
  assert.equal(providers.parseStreamEvent(profiles[0], { data: '{"type":"response.output_text.delta","delta":"R"}' }).delta, "R");
  assert.equal(providers.parseStreamEvent(profiles[1], { data: '{"choices":[{"delta":{"content":"C"}}]}' }).delta, "C");
  assert.equal(providers.parseStreamEvent(profiles[2], { data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"A"}}' }).delta, "A");
  assert.equal(providers.parseStreamEvent(profiles[3], { data: '{"candidates":[{"content":{"parts":[{"text":"G"}]}}]}' }).delta, "G");
});

test("ElevenLabs discovery reads TTS models and every paged account voice", async () => {
  const requested = [];
  window.chataxi.platform = { network: { requestJson: async request => {
    requested.push(request);
    if (request.url.includes('/v1/models')) return { data: [
      { model_id: 'speech-model', name: 'Speech', can_do_text_to_speech: true, maximum_text_length_per_request: 5000 },
      { model_id: 'voice-conversion-only', can_do_text_to_speech: false }
    ] };
    if (request.url.includes('next_page_token=next')) return { data: { voices: [{ voice_id: 'v2', name: 'Voice 2' }], has_more: false } };
    return { data: { voices: [{ voice_id: 'v1', name: 'Voice 1', category: 'professional', high_quality_base_model_ids: ['eleven_multilingual_v2'], verified_languages: [{ model_id: 'eleven_multilingual_v2' }], fine_tuning: { state: { eleven_multilingual_v2: 'fine_tuned' } } }], has_more: true, next_page_token: 'next' } };
  } } };
  window.chataxi.data = { store: { put: async () => { throw Error('persist:false must not write'); } } };
  const service = { id: 'eleven', family: 'elevenlabs', apiKey: 'secret', models: [], voices: [] };
  const result = await modelServices.discover('tts', service, { persist: false });
  assert.deepEqual(Array.from(result.models, item => item.id), ['speech-model']);
  assert.deepEqual(Array.from(result.voices, item => item.id), ['v1', 'v2']);
  assert.deepEqual(Array.from(result.voices[0].highQualityModelIds), ['eleven_multilingual_v2']);
  assert.deepEqual(Array.from(result.voices[0].verifiedModelIds), ['eleven_multilingual_v2']);
  assert.equal(result.voices[0].fineTuningStates.eleven_multilingual_v2, 'fine_tuned');
  assert.ok(requested.every(request => request.headers['xi-api-key'] === 'secret'));
  assert.equal(modelServices.ttsCapabilities(service, 'speech-model').streaming, true);
});

test("ElevenLabs keeps account voices usable when a restricted key cannot read the model directory", async () => {
  window.chataxi.platform = { network: { requestJson: async request => {
    if (request.url.includes('/v1/models')) { const error = Error('missing permission models_read'); error.status = 401; throw error; }
    return { data: { voices: [{ voice_id: 'account-voice', name: 'Account voice' }], has_more: false } };
  } } };
  window.chataxi.data = { store: { put: async () => { throw Error('persist:false must not write'); } } };
  const service = { id: 'restricted', family: 'elevenlabs', apiKey: 'fixture', models: [], modelsDiscovered: true, voices: [] };
  const result = await modelServices.discover('tts', service, { persist: false });
  assert.deepEqual(Array.from(result.models, item => item.id), ['eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_v3']);
  assert.deepEqual(Array.from(result.voices, item => item.id), ['account-voice']);
  assert.equal(service.modelsDiscovered, false);
  assert.match(result.warnings.join(' '), /内置 ElevenLabs 模型目录/);
});

test("ElevenLabs quality metadata never hides Jane and v3 never invents a deprecated PVC fallback", () => {
  const service = { family: 'elevenlabs', voices: [
    { id: 'ordinary', name: 'Ordinary', category: 'cloned', highQualityModelIds: ['eleven_multilingual_v2'] },
    { id: 'jane', name: 'Jane', category: 'professional', highQualityModelIds: ['eleven_multilingual_v2'], verifiedModelIds: ['eleven_multilingual_v2'], fineTuningStates: { eleven_multilingual_v2: 'fine_tuned' } }
  ] };
  assert.deepEqual(Array.from(modelServices.voices(service, 'eleven_v3'), item => item.id), ['ordinary', 'jane']);
  assert.deepEqual(Array.from(modelServices.voices(service, 'eleven_v3_conversational'), item => item.id), ['ordinary', 'jane']);
  assert.deepEqual(Array.from(modelServices.voices(service, 'unlisted-model'), item => item.id), ['ordinary', 'jane']);
  const v3 = modelServices.resolveTts(service, { ttsModel: 'eleven_v3', ttsVoice: 'jane' }, { language: 'zh-CN' });
  assert.equal(v3.voiceCompatibilityMode, 'native');
  assert.equal('usePvcAsIvc' in v3, false);
  assert.match(modelServices.voiceCompatibility(service, 'eleven_v3', 'jane').note, /允许.*直接使用 v3/);
  assert.deepEqual(JSON.parse(JSON.stringify(tts.requestBody(v3, '你好'))), { text: '你好', model_id: 'eleven_v3' });
  const v2 = modelServices.resolveTts(service, { ttsModel: 'eleven_multilingual_v2', ttsVoice: 'jane' }, { language: 'zh-CN' });
  assert.equal(v2.voiceCompatibilityMode, 'native');
  assert.equal('use_pvc_as_ivc' in tts.requestBody(v2, '你好'), false);
});

test("Doubao Speech V3 uses one API key, the selected resource and SSE audio chunks", async () => {
  const profile = { type: 'doubao', protocol: 'doubao-speech-v3', apiKey: 'fixture', model: 'seed-tts-2.0', voice: 'zh_female_vv_uranus_bigtts', speechRate: 12, pitchRate: -3, loudnessRate: 8, sampleRate: 24000, format: 'mp3' };
  const headers = tts.headers(profile);
  assert.equal(headers['X-Api-Key'], 'fixture');
  assert.equal(headers['X-Api-Resource-Id'], 'seed-tts-2.0');
  assert.equal(headers.Authorization, undefined);
  assert.match(headers['X-Api-Request-Id'], /^[0-9a-f-]{36}$/);
  const body = tts.requestBody(profile, '你好');
  assert.equal(body.req_params.speaker, profile.voice);
  assert.equal(body.req_params.audio_params.speech_rate, 12);
  assert.equal(JSON.parse(body.req_params.additions).post_process.pitch, -3);
  const audio = tts.parseDoubaoSse('data: {"code":20000000,"data":"SUQz"}\n\ndata: {"code":0,"data":"BAUG"}\n', 'mp3');
  assert.equal(audio.type, 'audio/mpeg');
  assert.deepEqual(Array.from(new Uint8Array(await audio.arrayBuffer())), [73, 68, 51, 4, 5, 6]);
  assert.throws(() => tts.parseDoubaoSse('data: {"code":45000000,"message":"denied"}\n', 'mp3'), /45000000.*denied/);
});

test("provider-specific TTS bodies do not reuse the OpenAI schema", () => {
  const xai = tts.requestBody({ protocol: 'xai-tts', voice: 'ara', language: 'auto', sampleRate: 24000 }, '你好', 'pcm');
  assert.equal(xai.text, '你好'); assert.equal(xai.voice_id, 'ara'); assert.equal(xai.model, undefined); assert.equal(xai.output_format.sample_rate, 24000);
  const qwen = tts.requestBody({ protocol: 'qwen-tts', model: 'qwen3-tts-flash', voice: 'Cherry', language: 'Chinese', sampleRate: 24000 }, '你好', 'pcm');
  assert.equal(qwen.input.text, '你好'); assert.equal(qwen.input.voice, 'Cherry'); assert.equal(qwen.parameters.format, 'pcm');
  const minimax = tts.requestBody({ protocol: 'minimax-tts', model: 'speech-2.8-hd', voice: 'voice-id', sampleRate: 24000 }, '你好', 'pcm');
  assert.equal(minimax.stream, true); assert.equal(minimax.voice_setting.voice_id, 'voice-id'); assert.equal(minimax.audio_setting.format, 'pcm');
  const polly = tts.requestBody({ protocol: 'aws-polly', model: 'neural', voice: 'Zhiyu', language: 'cmn-CN', sampleRate: 24000 }, '你好', 'pcm');
  assert.equal(polly.Engine, 'neural'); assert.equal(polly.VoiceId, 'Zhiyu'); assert.equal(polly.OutputFormat, 'pcm');
});

test("AWS SigV4 signs Polly without putting the secret in headers", () => {
  const signed = window.chataxi.services.awsSigV4.sign({ method: 'POST', url: 'https://polly.us-east-1.amazonaws.com/v1/speech', body: '{}', contentType: 'application/json', region: 'us-east-1', service: 'polly', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-example', date: new Date('2026-09-14T00:00:00Z') });
  assert.match(signed.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260914\/us-east-1\/polly\/aws4_request,/);
  assert.equal(signed['x-amz-date'], '20260914T000000Z'); assert.equal(signed.Authorization.includes('secret-example'), false);
});

test("unknown language model capabilities suppress optional request parameters", () => {
  const service = { family: 'custom', endpoint: 'https://example.com/v1/chat/completions', apiStyle: 'openai-chat', models: [{ id: 'unknown' }] };
  const resolved = modelServices.resolveLlm(service, { model: 'unknown', temperature: 1.2, maxOutputTokens: 4096, reasoningEffort: 'high', allowImageGeneration: true });
  assert.equal(resolved.temperature, ''); assert.equal(resolved.maxOutputTokens, ''); assert.equal(resolved.reasoningEffort, ''); assert.equal(resolved.allowImageGeneration, false);
});

test("service defaults drive LLM and TTS resolution when a role has no override", () => {
  const llmService = {
    family: "custom", endpoint: "https://example.com/v1/chat/completions", apiStyle: "openai-chat",
    models: [{ id: "first" }, { id: "preferred" }], enabledModelIds: ["first", "preferred"], defaultModelId: "preferred"
  };
  assert.equal(modelServices.resolveLlm(llmService, {}).model, "preferred");
  const ttsService = {
    family: "openai", type: "openai", endpoint: "https://api.openai.com/v1/audio/speech",
    models: [{ id: "tts-1" }, { id: "gpt-4o-mini-tts" }], enabledModelIds: ["tts-1", "gpt-4o-mini-tts"],
    voices: [{ id: "alloy" }, { id: "coral" }], defaultModelId: "gpt-4o-mini-tts", defaultVoiceId: "coral"
  };
  const resolved = modelServices.resolveTts(ttsService, {}, { language: "zh-CN" });
  assert.equal(resolved.model, "gpt-4o-mini-tts"); assert.equal(resolved.voice, "coral");
});
