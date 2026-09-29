(function (app) {
  "use strict";

  var REGISTRY_VERSION = "2026.09.15.1";

  function llmModel(id, name, options) {
    return Object.assign({
      id: id,
      name: name || id,
      maxOutputTokens: null,
      temperature: null,
      reasoning: [],
      thinkingMode: null,
      imageInput: null,
      videoInput: null,
      imageGeneration: null,
      streaming: true,
      supportedParameters: [],
      capabilitySource: "reviewed-registry"
    }, options || {});
  }

  function ttsModel(id, name, options) {
    return Object.assign({
      id: id,
      name: name || id,
      kind: "tts",
      voicePrompt: false,
      audioStreaming: true,
      textStreaming: false,
      streaming: true,
      formats: ["mp3"],
      capabilitySource: "reviewed-registry"
    }, options || {});
  }

  function voice(id, name, modelIds, options) {
    return Object.assign({ id: id, name: name || id, compatibleModelIds: modelIds || [] }, options || {});
  }

  function reviewed(sourceUrl, values) {
    return Object.assign({
      capabilitySource: "reviewed-registry",
      capabilityEvidence: { kind: "official-documentation", url: sourceUrl, checkedAt: "2026-09-14" }
    }, values || {});
  }

  /* Exact IDs only: provider model-list APIs often return IDs without a
     parameter schema, so prefix matching would invent capabilities for later models. */
  var reviewedLlmModels = {
    deepseek: {
      "deepseek-v4-flash": reviewed("https://api-docs.deepseek.com/api/create-chat-completion/", { thinkingMode: "optional", reasoning: ["low", "high", "max"], reasoningWhen: "thinking-enabled", temperature: true, temperatureWhen: "thinking-disabled" }),
      "deepseek-v4-pro": reviewed("https://api-docs.deepseek.com/api/create-chat-completion/", { thinkingMode: "optional", reasoning: ["low", "high", "max"], reasoningWhen: "thinking-enabled", temperature: true, temperatureWhen: "thinking-disabled" }),
      "deepseek-v4-flash-vision-exp": reviewed("https://api-docs.deepseek.com/api/create-response/", { thinkingMode: "optional", reasoning: ["low", "high", "max"], reasoningWhen: "thinking-enabled", temperature: true, temperatureWhen: "thinking-disabled", imageInput: true })
    },
    kimi: {
      "kimi-k2.5": reviewed("https://platform.kimi.ai/docs/models", { thinkingMode: "optional", temperature: false, imageInput: true, videoInput: false }),
      "kimi-k2.6": reviewed("https://platform.kimi.ai/docs/models", { thinkingMode: "optional", temperature: false, imageInput: true, videoInput: false })
    },
    xai: {
      "grok-4.5": reviewed("https://docs.x.ai/developers/model-capabilities/text/reasoning", { thinkingMode: "forced", reasoning: ["low", "medium", "high"], imageInput: true }),
      "grok-4.6": reviewed("https://docs.x.ai/developers/model-capabilities/text/reasoning", { thinkingMode: "forced", reasoning: ["low", "medium", "high", "xhigh"], imageInput: true })
    }
  };

  var llmFamilies = [
    {
      id: "openai", name: "OpenAI", description: "官方 Responses API；模型目录与能力规则分别校验",
      provider: "openai", apiStyle: "openai-responses", endpoint: "https://api.openai.com/v1/responses",
      modelsEndpoint: "https://api.openai.com/v1/models", discovery: "openai", auth: "bearer", streaming: true,
      models: []
    },
    {
      id: "anthropic", name: "Anthropic Claude", description: "Claude Messages API；读取官方模型能力目录",
      provider: "anthropic", apiStyle: "anthropic-messages", endpoint: "https://api.anthropic.com/v1/messages",
      modelsEndpoint: "https://api.anthropic.com/v1/models?limit=1000", discovery: "anthropic", auth: "anthropic", streaming: true,
      models: []
    },
    {
      id: "gemini", name: "Google Gemini", description: "默认使用 Interactions；保留 GenerateContent 兼容",
      provider: "gemini", apiStyle: "gemini-interactions", endpoint: "https://generativelanguage.googleapis.com/v1beta/interactions",
      modelsEndpoint: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", discovery: "gemini", auth: "gemini", streaming: true,
      models: []
    },
    {
      id: "xai", name: "xAI / Grok", description: "官方 Responses API 与 language-models 目录",
      provider: "xai", apiStyle: "openai-responses", endpoint: "https://api.x.ai/v1/responses",
      modelsEndpoint: "https://api.x.ai/v1/language-models", discovery: "xai", auth: "bearer", streaming: true,
      models: []
    },
    {
      id: "deepseek", name: "DeepSeek", description: "官方 Chat API；思考与采样参数按模型编译",
      provider: "deepseek", apiStyle: "openai-chat", endpoint: "https://api.deepseek.com/chat/completions",
      modelsEndpoint: "https://api.deepseek.com/models", discovery: "openai", auth: "bearer", streaming: true,
      models: []
    },
    {
      id: "qwen", name: "阿里云百炼 / Qwen", description: "默认中国北京公共域名；业务空间与地域可在更多设置调整",
      provider: "qwen", apiStyle: "openai-chat", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      modelsEndpoint: "https://dashscope.aliyuncs.com/api/v1/models?page_no=1&page_size=100", discovery: "qwen", auth: "bearer", streaming: true,
      regionField: true, workspaceField: true, models: []
    },
    {
      id: "kimi", name: "Kimi / Moonshot", description: "Moonshot 中国站；目录提供图像、视频与推理能力",
      provider: "kimi", apiStyle: "openai-chat", endpoint: "https://api.moonshot.cn/v1/chat/completions",
      modelsEndpoint: "https://api.moonshot.cn/v1/models", discovery: "kimi", auth: "bearer", streaming: true,
      models: []
    },
    {
      id: "glm", name: "GLM / 智谱", description: "BigModel 官方 Chat API；目录不可用时使用审核目录并逐模型验证",
      provider: "glm", apiStyle: "openai-chat", endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      modelsEndpoint: "https://open.bigmodel.cn/api/paas/v4/models", discovery: "openai-optional", auth: "bearer", streaming: true,
      models: [
        llmModel("glm-5", "GLM-5", { reasoning: ["low", "high", "max"], thinkingMode: "forced", temperature: true, imageInput: false }),
        llmModel("glm-4.7", "GLM-4.7", { reasoning: ["low", "medium", "high"], thinkingMode: "optional", temperature: true, imageInput: false }),
        llmModel("glm-4.6v", "GLM-4.6V", { reasoning: ["low", "high"], thinkingMode: "optional", temperature: true, imageInput: true, videoInput: true })
      ]
    },
    {
      id: "tokenhub", name: "腾讯 TokenHub / 混元", description: "腾讯新统一模型服务；默认中国站",
      provider: "tokenhub", apiStyle: "openai-chat", endpoint: "https://tokenhub.tencentmaas.com/v1/chat/completions",
      modelsEndpoint: "https://tokenhub.tencentmaas.com/v1/models", discovery: "openai", auth: "bearer", streaming: true,
      regionField: true, models: []
    },
    {
      id: "hunyuan-legacy", name: "腾讯混元旧服务", description: "仅保留已有账号兼容；新配置建议 TokenHub",
      provider: "hunyuan-legacy", apiStyle: "openai-chat", endpoint: "https://api.hunyuan.cloud.tencent.com/v1/chat/completions",
      customEndpoint: true, editableProtocol: false, discovery: "none", auth: "bearer", streaming: true, models: []
    },
    {
      id: "ark", name: "火山方舟 / 豆包", description: "官方 Responses API；新控制台仅需 API Key，不需要 App ID",
      provider: "ark", apiStyle: "openai-responses", endpoint: "https://ark.cn-beijing.volces.com/api/v3/responses",
      discovery: "registry", auth: "bearer", streaming: true,
      models: [
        llmModel("doubao-seed-2-1-pro-260628", "豆包 Seed 2.1 Pro", { reasoning: ["low", "medium", "high"], thinkingMode: "optional", temperature: true, imageInput: true, videoInput: true, maxOutputTokens: 65536 }),
        llmModel("doubao-seed-2-0-lite-260215", "豆包 Seed 2.0 Lite", { reasoning: ["low", "medium", "high"], thinkingMode: "optional", temperature: true, imageInput: true, videoInput: true, maxOutputTokens: 32768 })
      ]
    },
    {
      id: "minimax", name: "MiniMax", description: "中国站官方 API；M3 与旧 M2 参数分别适配",
      provider: "minimax", apiStyle: "openai-chat", endpoint: "https://api.minimax.cn/v1/chat/completions",
      modelsEndpoint: "https://api.minimax.cn/v1/models", discovery: "openai", auth: "bearer", streaming: true, models: []
    },
    {
      id: "baidu", name: "百度千帆", description: "千帆 v2 API；使用新版 Bearer API Key",
      provider: "baidu", apiStyle: "openai-chat", endpoint: "https://qianfan.baidubce.com/v2/chat/completions",
      modelsEndpoint: "https://qianfan.baidubce.com/v2/models", discovery: "baidu", auth: "bearer", streaming: true, models: []
    },
    {
      id: "openrouter", name: "OpenRouter", description: "聚合服务；可按参数约束实际执行提供方",
      provider: "openrouter", apiStyle: "openai-chat", endpoint: "https://openrouter.ai/api/v1/chat/completions",
      modelsEndpoint: "https://openrouter.ai/api/v1/models", discovery: "openrouter", auth: "bearer", streaming: true, models: []
    },
    {
      id: "mistral", name: "Mistral AI", description: "Mistral 官方 OpenAI 风格接口",
      provider: "mistral", apiStyle: "openai-chat", endpoint: "https://api.mistral.ai/v1/chat/completions",
      modelsEndpoint: "https://api.mistral.ai/v1/models", discovery: "openai", auth: "bearer", streaming: true, models: []
    },
    {
      id: "siliconflow", name: "硅基流动 SiliconFlow", description: "国内聚合模型服务",
      provider: "siliconflow", apiStyle: "openai-chat", endpoint: "https://api.siliconflow.cn/v1/chat/completions",
      modelsEndpoint: "https://api.siliconflow.cn/v1/models?sub_type=chat", discovery: "openai", auth: "bearer", streaming: true, models: []
    },
    {
      id: "together", name: "Together AI", description: "托管开源模型聚合服务",
      provider: "together", apiStyle: "openai-chat", endpoint: "https://api.together.xyz/v1/chat/completions",
      modelsEndpoint: "https://api.together.xyz/v1/models", discovery: "openai-array", auth: "bearer", streaming: true, models: []
    },
    {
      id: "fireworks", name: "Fireworks AI", description: "托管与自定义部署模型",
      provider: "fireworks", apiStyle: "openai-chat", endpoint: "https://api.fireworks.ai/inference/v1/chat/completions",
      modelsEndpoint: "https://api.fireworks.ai/inference/v1/models", discovery: "openai", auth: "bearer", streaming: true, models: []
    },
    {
      id: "ollama", name: "Ollama 本地服务", description: "局域网原生 NDJSON 接口；地址必须是电脑的局域网 IP",
      provider: "ollama", apiStyle: "ollama-chat", endpoint: "http://192.168.1.2:11434/api/chat",
      modelsEndpoint: "http://192.168.1.2:11434/api/tags", discovery: "ollama", auth: "none", keyOptional: true,
      customEndpoint: true, streaming: true, models: []
    },
    {
      id: "lmstudio", name: "LM Studio 本地服务", description: "优先读取原生模型目录，推理使用兼容 Chat",
      provider: "lmstudio", apiStyle: "openai-chat", endpoint: "http://192.168.1.2:1234/v1/chat/completions",
      modelsEndpoint: "http://192.168.1.2:1234/api/v1/models", discovery: "lmstudio", auth: "bearer-optional", keyOptional: true,
      customEndpoint: true, streaming: true, models: []
    },
    {
      id: "vllm", name: "vLLM 本地服务", description: "OpenAI 兼容推理服务器",
      provider: "vllm", apiStyle: "openai-chat", endpoint: "http://192.168.1.2:8000/v1/chat/completions",
      modelsEndpoint: "http://192.168.1.2:8000/v1/models", discovery: "openai", auth: "bearer-optional", keyOptional: true,
      customEndpoint: true, streaming: true, models: []
    },
    {
      id: "sglang", name: "SGLang 本地服务", description: "OpenAI 兼容推理；目录不足时读取服务模型信息",
      provider: "sglang", apiStyle: "openai-chat", endpoint: "http://192.168.1.2:30000/v1/chat/completions",
      modelsEndpoint: "http://192.168.1.2:30000/v1/models", discovery: "openai", auth: "bearer-optional", keyOptional: true,
      customEndpoint: true, streaming: true, models: []
    },
    {
      id: "llmserver", name: "llmserver", description: "局域网统一网关",
      provider: "llmserver", apiStyle: "openai-responses", endpoint: "http://192.168.1.2:4815/v1/responses",
      discovery: "derived-openai", auth: "bearer-optional", customEndpoint: true, editableProtocol: true, keyOptional: true,
      streaming: true, models: []
    },
    {
      id: "custom", name: "自定义兼容服务", description: "用户明确提供的 OpenAI、Claude、Gemini 或 Ollama 风格端点",
      provider: "custom", apiStyle: "openai-responses", endpoint: "", discovery: "derived-openai",
      auth: "bearer-optional", customEndpoint: true, editableProtocol: true, keyOptional: true, streaming: true, models: []
    }
  ];

  var openAiAllVoices = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"];
  var openAiLegacyVoices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

  var ttsFamilies = [
    {
      id: "system", name: "Android 系统朗读", description: "使用设备安装的语音引擎",
      type: "system", protocol: "system", auth: "none", keyOptional: true, modelSelection: false,
      models: [ttsModel("system", "系统语音引擎", { streaming: false, audioStreaming: false, formats: [] })], voices: []
    },
    {
      id: "openai", name: "OpenAI TTS", description: "官方 Speech API；音频响应默认流式读取",
      type: "openai", protocol: "openai-speech", auth: "bearer", endpoint: "https://api.openai.com/v1/audio/speech",
      modelsEndpoint: "https://api.openai.com/v1/models", discovery: "openai-tts", streaming: true,
      models: [
        ttsModel("gpt-4o-mini-tts", "GPT-4o mini TTS", { voicePrompt: true, formats: ["pcm", "wav", "mp3", "opus", "aac", "flac"] }),
        ttsModel("tts-1", "TTS-1", { formats: ["pcm", "wav", "mp3", "opus", "aac", "flac"] }),
        ttsModel("tts-1-hd", "TTS-1 HD", { formats: ["pcm", "wav", "mp3", "opus", "aac", "flac"] })
      ],
      voices: openAiAllVoices.map(function (id) {
        return voice(id, id, id === "marin" || id === "cedar" || ["ballad", "verse", "ash", "coral", "sage"].indexOf(id) >= 0 ? ["gpt-4o-mini-tts"] : ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"]);
      }).concat(openAiLegacyVoices.filter(function (id) { return openAiAllVoices.indexOf(id) < 0; }).map(function (id) { return voice(id, id, ["tts-1", "tts-1-hd"]); }))
    },
    {
      id: "elevenlabs", name: "ElevenLabs", description: "动态读取账户模型与音色；组合在试听后确认",
      type: "elevenlabs", protocol: "elevenlabs", auth: "elevenlabs",
      endpoint: "https://api.elevenlabs.io/v1/text-to-speech/{voice}/stream",
      streamEndpoint: "https://api.elevenlabs.io/v1/text-to-speech/{voice}/stream",
      modelsEndpoint: "https://api.elevenlabs.io/v1/models", voicesEndpoint: "https://api.elevenlabs.io/v2/voices?page_size=100",
      discovery: "elevenlabs", streaming: true,
      models: [
        ttsModel("eleven_multilingual_v2", "Eleven Multilingual v2", { textStreaming: true, formats: ["pcm_24000", "mp3_44100_128"] }),
        ttsModel("eleven_flash_v2_5", "Eleven Flash v2.5", { textStreaming: true, maxCharacters: 40000, formats: ["pcm_24000", "mp3_44100_128"] }),
        ttsModel("eleven_v3", "Eleven v3", { textStreaming: true, maxCharacters: 5000, formats: ["pcm_24000", "mp3_44100_128"] })
      ], voices: []
    },
    {
      id: "doubao", name: "豆包语音", description: "火山引擎 V3 新 API Key；资源、模型与音色分别保存",
      type: "doubao", protocol: "doubao-speech-v3", auth: "doubao",
      endpoint: "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse",
      streamEndpoint: "https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse",
      discovery: "registry", streaming: true,
      models: [
        ttsModel("seed-tts-2.0", "豆包语音合成 2.0", { resourceId: "seed-tts-2.0", formats: ["pcm", "mp3"], speechRate: true, pitchRate: true, loudnessRate: true })
      ],
      voices: [voice("zh_female_vv_uranus_bigtts", "Vivi 2.0 · 活泼女声", ["seed-tts-2.0"], { verified: true })]
    },
    {
      id: "xai-tts", name: "xAI TTS", description: "官方 xAI 语音接口；服务没有模型二级选择",
      type: "xai-tts", protocol: "xai-tts", auth: "bearer", endpoint: "https://api.x.ai/v1/tts",
      voicesEndpoint: "https://api.x.ai/v1/tts/voices", discovery: "xai-tts", modelSelection: false, streaming: true,
      models: [ttsModel("xai-tts", "xAI TTS", { textStreaming: true, formats: ["pcm", "wav", "mp3"] })], voices: []
    },
    {
      id: "qwen-tts", name: "阿里百炼朗读", description: "Qwen TTS；默认北京公共域名，可配置地域",
      type: "qwen-tts", protocol: "qwen-tts", auth: "bearer",
      endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
      voicesEndpoint: "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization",
      discovery: "qwen-tts", regionField: true, streaming: true,
      models: [
        ttsModel("qwen3-tts-flash", "Qwen3 TTS Flash", { formats: ["pcm", "wav", "mp3"] }),
        ttsModel("qwen3-tts-flash-realtime", "Qwen3 TTS Flash Realtime", { textStreaming: true, formats: ["pcm"] })
      ],
      voices: [
        voice("Cherry", "Cherry", ["qwen3-tts-flash", "qwen3-tts-flash-realtime"]),
        voice("Serena", "Serena", ["qwen3-tts-flash", "qwen3-tts-flash-realtime"]),
        voice("Ethan", "Ethan", ["qwen3-tts-flash", "qwen3-tts-flash-realtime"]),
        voice("Chelsie", "Chelsie", ["qwen3-tts-flash", "qwen3-tts-flash-realtime"])
      ]
    },
    {
      id: "minimax-tts", name: "MiniMax 语音", description: "官方 T2A；动态读取系统与账户音色",
      type: "minimax-tts", protocol: "minimax-tts", auth: "bearer", endpoint: "https://api.minimax.cn/v1/t2a_v2",
      voicesEndpoint: "https://api.minimax.cn/v1/get_voice", discovery: "minimax-tts", streaming: true,
      models: [
        ttsModel("speech-2.8-hd", "Speech 2.8 HD", { formats: ["mp3", "pcm", "wav", "flac"] }),
        ttsModel("speech-2.8-turbo", "Speech 2.8 Turbo", { formats: ["mp3", "pcm", "wav", "flac"] }),
        ttsModel("speech-2.6-hd", "Speech 2.6 HD", { formats: ["mp3", "pcm", "wav", "flac"] }),
        ttsModel("speech-2.6-turbo", "Speech 2.6 Turbo", { formats: ["mp3", "pcm", "wav", "flac"] })
      ], voices: []
    },
    {
      id: "azure-tts", name: "Microsoft Azure Speech / MAI", description: "需要 Speech Key 与区域或完整资源 Endpoint",
      type: "azure-tts", protocol: "azure-speech", auth: "azure", endpoint: "",
      discovery: "azure-tts", regionField: true, resourceEndpointField: true, customEndpoint: true, streaming: true,
      models: [ttsModel("azure-speech", "Azure Speech", { formats: ["pcm", "wav", "mp3"] })], voices: []
    },
    {
      id: "aws-polly", name: "Amazon Polly", description: "需要区域、Access Key ID 与 Secret Access Key；使用 SigV4",
      type: "aws-polly", protocol: "aws-polly", auth: "aws-sigv4", endpoint: "",
      discovery: "aws-polly", regionField: true, accessKeyField: true, sessionTokenField: true, customEndpoint: true, streaming: true,
      models: [
        ttsModel("generative", "Generative", { formats: ["pcm", "mp3", "ogg_vorbis"] }),
        ttsModel("long-form", "Long-form", { formats: ["pcm", "mp3", "ogg_vorbis"] }),
        ttsModel("neural", "Neural", { formats: ["pcm", "mp3", "ogg_vorbis"] }),
        ttsModel("standard", "Standard", { formats: ["pcm", "mp3", "ogg_vorbis"] })
      ], voices: []
    },
    {
      id: "gemini-tts", name: "Google Gemini TTS", description: "Gemini Interactions 音频输出",
      type: "gemini-tts", protocol: "gemini-tts", auth: "gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/interactions", modelsEndpoint: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      discovery: "gemini-tts", streaming: true,
      models: [ttsModel("gemini-3.1-flash-tts-preview", "Gemini 3.1 Flash TTS Preview", { voicePrompt: true, formats: ["pcm"] })],
      voices: ["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"].map(function (id) { return voice(id, id, ["gemini-3.1-flash-tts-preview"]); })
    },
    {
      id: "siliconflow-tts", name: "硅基流动语音", description: "SiliconFlow Speech API 与账户音色",
      type: "siliconflow-tts", protocol: "openai-speech", auth: "bearer", endpoint: "https://api.siliconflow.cn/v1/audio/speech",
      modelsEndpoint: "https://api.siliconflow.cn/v1/models?sub_type=audio", voicesEndpoint: "https://api.siliconflow.cn/v1/audio/voice/list",
      discovery: "siliconflow-tts", streaming: true, models: [], voices: []
    },
    {
      id: "vllm-omni", name: "vLLM-Omni 本地语音", description: "局域网 Speech API；声音与能力取决于实际运行版本",
      type: "vllm-omni", protocol: "vllm-omni", auth: "bearer-optional", keyOptional: true,
      endpoint: "http://192.168.1.2:8000/v1/audio/speech", voicesEndpoint: "http://192.168.1.2:8000/v1/audio/voices",
      discovery: "vllm-omni", customEndpoint: true, streaming: true,
      models: [ttsModel("server-model", "服务端已加载模型", { formats: ["pcm", "wav"] })], voices: []
    },
    {
      id: "fish-tts", name: "Fish Speech 本地服务", description: "连接用户已有 Fish API Server；模型在服务端加载",
      type: "fish-tts", protocol: "fish-tts", auth: "bearer-optional", keyOptional: true,
      endpoint: "http://192.168.1.2:8080/v1/tts", healthEndpoint: "http://192.168.1.2:8080/v1/health",
      discovery: "fish-tts", customEndpoint: true, modelSelection: false, voiceOptional: true, streaming: true,
      models: [ttsModel("server-model", "服务端已加载模型", { formats: ["pcm", "wav", "mp3"] })], voices: []
    },
    {
      id: "custom", name: "自定义 TTS", description: "OpenAI Speech 兼容接口；能力由用户或网关声明",
      type: "custom", protocol: "openai-speech", auth: "bearer-optional", keyOptional: true,
      endpoint: "", discovery: "none", customEndpoint: true, streaming: false, models: [], voices: []
    }
  ];

  var asrFamilies = [
    {
      id: "system", name: "Android 系统语音识别", description: "仅在当前设备真实提供语音识别能力时可用",
      type: "system", protocol: "system", auth: "none", keyOptional: true, modelSelection: false,
      models: [{ id: "system", name: "系统语音识别", capabilitySource: "device-runtime" }]
    },
    {
      id: "openai", name: "OpenAI 语音识别", description: "官方 Transcriptions API",
      type: "openai", protocol: "openai-transcriptions", auth: "bearer",
      endpoint: "https://api.openai.com/v1/audio/transcriptions", modelsEndpoint: "https://api.openai.com/v1/models",
      discovery: "openai-asr", models: [
        { id: "gpt-4o-transcribe", name: "GPT-4o Transcribe", capabilitySource: "reviewed-registry" },
        { id: "gpt-4o-mini-transcribe", name: "GPT-4o mini Transcribe", capabilitySource: "reviewed-registry" },
        { id: "whisper-1", name: "Whisper", capabilitySource: "reviewed-registry" }
      ]
    },
    {
      id: "elevenlabs-asr", name: "ElevenLabs Scribe", description: "ElevenLabs Speech-to-Text API",
      type: "elevenlabs-asr", protocol: "elevenlabs-scribe", auth: "elevenlabs",
      endpoint: "https://api.elevenlabs.io/v1/speech-to-text", discovery: "registry",
      models: [{ id: "scribe_v1", name: "Scribe v1", capabilitySource: "reviewed-registry" }]
    },
    {
      id: "custom", name: "自定义语音识别", description: "用户提供的 OpenAI Transcriptions 兼容接口",
      type: "custom", protocol: "openai-transcriptions", auth: "bearer-optional", endpoint: "",
      discovery: "derived-openai", customEndpoint: true, keyOptional: true, models: []
    }
  ];

  // ---------------------------------------------------------------- 绘图（image）
  // 目前只有 CHP 一种合同（CHP 插件那套 `chp/2`，见 hamdraw/plans/chp-spec.md）。
  // 这里**不内置任何模型清单**：能画什么由信息接口的 `rules`（场景）与 `abilities`（能跑的文件组）
  // 自报，chataxi 只把 `render` 这一个场景映射成一张单模型卡片（卡片 = 场景，不是模型名）。
  // 理由与规范第 0 条一致 —— 插件换模型不该让客户端改代码，所以卡片认的是 `category` 而不是
  // checkpoint 文件名；画幅也来自插件手写的帧表，客户端只选不算。
  var imageFamilies = [
    {
      id: "chp", name: "CHP 插件", description: "ComfyUI Haminn Protocol：连接后由插件自报可用的绘图场景与画幅",
      type: "chp", protocol: "chp", auth: "bearer", keyOptional: true, customEndpoint: true,
      // 插件跑在局域网里，没有可用的公共默认地址。这里保持空串：本字段代表「服务商预设」，
      // 填了它，输入框清空就会自动变回默认值，「请填写服务地址」的校验也就永远触发不了。
      // 真正的默认地址放在 model-single-editor.js 的 CHP_DEFAULT_ENDPOINT（卡片初值那一层）。
      endpoint: "", discovery: "chp", models: []
    }
  ];

  app.services = app.services || {};
  app.services.catalog = {
    registryVersion: REGISTRY_VERSION,
    checkedAt: "2026-09-15",
    sourceUrls: [
      "https://platform.openai.com/docs/api-reference/models",
      "https://docs.anthropic.com/en/api/models-list",
      "https://ai.google.dev/api/models",
      "https://docs.x.ai/docs/api-reference",
      "https://api-docs.deepseek.com/api/list-models",
      "https://openrouter.ai/docs/api-reference/list-available-models",
      "https://elevenlabs.io/docs/api-reference/models/list",
      "https://docs.aws.amazon.com/polly/latest/dg/API_DescribeVoices.html"
    ],
    llmFamilies: llmFamilies,
    reviewedLlmModels: reviewedLlmModels,
    ttsFamilies: ttsFamilies,
    imageFamilies: imageFamilies,
    asrFamilies: asrFamilies,
    apiStyles: [
      { id: "openai-responses", name: "OpenAI Responses" },
      { id: "openai-chat", name: "OpenAI Chat Completions" },
      { id: "anthropic-messages", name: "Anthropic Messages" },
      { id: "gemini-interactions", name: "Gemini Interactions" },
      { id: "gemini-generate-content", name: "Gemini GenerateContent" },
      { id: "ollama-chat", name: "Ollama Chat NDJSON" }
    ]
  };
})(window.chataxi);
