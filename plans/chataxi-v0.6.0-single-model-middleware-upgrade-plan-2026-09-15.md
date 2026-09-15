# chataxi 0.6.0 单模型接入与统一中间层升级计划

本计划基于 2026-09-15 的 chataxi 0.5.20 源码、[现有模型升级方案](chataxi-llm-tts-upgrade-plan-2026-09-14.md)、[供应商接口资料](chataxi-provider-api-reference-2026-09-14.md)及供应商官方文档制定，并已在 chataxi 0.6.0 中完成核心实现。若本文与 0.5.0 方案中的“一个服务包含多个模型”设计冲突，以本文为准；上一版资料中的官方端点、字段证据和流式传输前置工作继续有效。真实账号、地区权限和供应商在线状态仍需按每个账号分别验收，不能由本地测试扩大推断。

本次目标是把模型接入收敛为三个稳定层次：

1. 用户看到和选择的每个模型卡片只代表一个具体模型；
2. chataxi 内部使用固定的 LLM、TTS、ASR 中间合同；
3. 供应商、传输协议、模型系列、精确能力和参数映射全部由带来源的本地注册表决定。

完成后，官方服务的主要流程应是“选择服务商 → 输入 API Key → 拉取目录 → 选择一个模型 → 连接测试 → 保存”；聚合服务和本地运行时可以多一个地址及模型系列确认步骤。模型连接页不再承担角色运行参数配置。

## 1. 关键结论

### 1.1 一个模型卡片只对应一个模型

当前 `ServiceConnection` 保存一组 `models`、`enabledModelIds` 和 `defaultModelId`，角色再从服务内选模型。这导致模型卡片的连接状态、默认模型、参数能力和真实验证对象彼此错位。0.6.0 改为：

```text
一个模型卡片 = 一个 ModelProfile = 一个外部 model id + 一个确定的调用适配器
```

同一个 API Key 可以通过凭据引用被多个模型卡片复用，但卡片本身不能包含第二个模型。卡片上的“复制添加”会打开新增 Sheet，复用供应商、地址、凭据引用和已缓存目录，清空具体模型选择，让用户快速选择另一个模型并重新测试；它不能静默复制成两个指向同一模型的卡片。

TTS 的音色目录不是模型目录。一个 TTS 模型卡片可以缓存该模型实际可用的多个音色，但角色最终只选择一个模型和一个音色组合。

### 1.2 模型系列与传输协议必须分开

聚合平台返回的 `openai/gpt-*`、`anthropic/claude-*`、`deepseek/*` 等名称可以用来推荐“模型系列”，但不能据此改变聚合平台的线协议。例如，通过 OpenRouter 调用 Claude 时，外层仍按 OpenRouter 已声明的 OpenAI 兼容接口发送，不能把请求直接编译成 Anthropic Messages。

因此数据中必须区分：

- `providerPresetId`：OpenAI、OpenRouter、Ollama 等连接入口；
- `transportCodecId`：该入口实际接受的请求与流事件协议；
- `modelFamilyId`：GPT、Claude、Gemini、DeepSeek、Qwen、Llama 等语义系列；
- `externalModelId`：目录返回并原样发送的具体模型 ID。

官方服务预设通常同时固定供应商和协议。聚合平台自动推荐 `modelFamilyId`，并允许用户在测试前修改；`transportCodecId` 仍由聚合平台预设固定，仅当某个平台官方确实提供多套接口时才在“更多设置”中允许选择。用户修改模型系列后，旧验证记录立即失效，必须重新连接测试。

### 1.3 不能把三类接口说成一个完整的 OpenAI 标准

OpenAI 的 Responses、Speech 和 Transcriptions 是三套不同合同，视频输入也没有一个可无条件套到所有供应商的共同字段。chataxi 将采用三套**OpenAI 风格的内部合同**：

- LLM：以 Responses 的内容块和增量事件思想为基线；
- TTS：以 `/v1/audio/speech` 的输入、模型、音色、格式思想为基线；
- ASR：以 `/v1/audio/transcriptions` 的文件、模型、语言和转录结果思想为基线。

`input_video`、实时 ASR 音频块、连续文字输入 TTS 等缺口使用明确标记的 chataxi 扩展，不能在代码或文档中冒充 OpenAI 标准字段。外部接口必须先经过适配器转换，聊天功能只调用内部合同，不直接拼装供应商请求。

### 1.4 正则只负责分类，不负责创造能力

模型目录中的明确类型和能力字段优先；其次是本应用带来源的精确模型规则；正则只用于生成模型种类和模型系列的候选建议。正则命中不能单独启用图片、视频、推理强度、`top_k`、声音提示词或任何线协议字段。

无法可靠分类的目录项放在选择 Sheet 底部的“未知能力”分区。用户可以选择，但界面必须说明“服务未提供足够的能力信息；连接测试只验证当前选定用途”。保存前至少完成一次该用途的最小调用。未知模型默认只拥有本次实际验证成功的最小能力，不从相似名称继承其他能力。

### 1.5 参数与音色属于角色，不属于模型卡片

模型页只配置连接身份、具体模型、模型系列建议以及连接测试，不显示 `max output tokens`、`temperature`、`top_p`、`top_k`、推理强度或图片生成开关。模型能力注册表仍保存这些参数是否可用、合法范围、相互约束和请求映射，角色页据此按需呈现控件。

LLM 角色配置保存具体参数覆盖；TTS 角色配置保存音色、语速、稳定度、风格或声音提示词等覆盖。模型对象仅保留一组通过连接测试的 `validationBaseline`。角色第一次选择模型时可以用该基线生成初始值，随后由角色独立保存，不能反向修改模型卡片或其他角色。

若 TTS 测试必须提供音色，连接流程可以自动选取供应商明确的默认音色，或让用户在测试步骤临时选择一个音色。这个值记录为验证目标，不是所有角色的全局音色设置。

## 2. 产品流程

### 2.1 官方服务

适用于 OpenAI、Anthropic、Gemini、xAI、DeepSeek、Kimi、Qwen、GLM、腾讯混元/TokenHub、豆包 Ark、Mistral 等预设。

1. 选择服务商，应用固定官方基础地址、鉴权方式、目录解析器和协议适配器；
2. 输入或编辑 API Key，必要的区域、工作空间或资源 ID 直接显示；
3. 点击“获取模型”，读取当前账号实际可访问的目录；
4. 在全宽 Sheet 中选择一个符合当前页用途的模型；
5. 应用根据官方目录和精确注册表确定模型系列与能力，不让用户选择无意义的协议；
6. 点击“连接并测试”，执行一次最小、可审计的真实调用；
7. 保存为一个模型卡片。

目录读取成功不等于模型调用成功，二者状态分别记录。供应商没有目录、目录权限不足或目录仅返回 ID 时，可以使用带版本与来源的官方后备条目，但必须显示“官方后备目录”，并仍以实际调用测试为准。

### 2.2 聚合服务

首批预设为 OpenRouter、硅基流动和通用 OpenAI 兼容聚合服务。302.AI、Requesty、Together、Fireworks 等在完成官方接口核验与夹具后按同一机制增加，不通过在 UI 中堆名称来宣称支持。

1. 选择聚合平台；自定义平台需填写基础地址；
2. 输入 API Key 并读取平台目录；
3. 先按平台元数据过滤 LLM、TTS 或 ASR；元数据不足时使用分类规则；
4. 选择一个具体模型；
5. 自动推荐模型系列，用户可以修改；
6. 协议由平台预设决定；模型系列只参与能力匹配、角色 UI 和必要的提供商参数约束；
7. 以平台接口测试所选模型，保存为单模型卡片。

OpenRouter 的 `architecture`、输入/输出模态和 `supported_parameters` 可以作为平台能力证据；启用可选参数时应使用它的参数路由约束，避免平台将请求路由到会忽略参数的后端。其他聚合平台若只返回模型 ID，不能复制 OpenRouter 的元数据语义。

### 2.3 本地运行时

本地接入分为 Ollama、LM Studio 和自定义 OpenAI 兼容服务。模型系列描述模型权重，运行时描述协议，两者不能混为一项。

1. 输入局域网地址，API Key 仅在运行时要求时显示；
2. 读取运行时实际加载或暴露的模型；
3. 选择一个模型，应用推荐 Qwen、DeepSeek、Llama、Mistral 等系列；
4. 读取运行时可用的部署信息。Ollama 可进一步查询模型详情，LM Studio 或 vLLM 的实际上下文设置不能从权重名称推断；
5. 执行最小调用并保存单模型卡片。

手机只是客户端，不负责下载权重、启动推理服务或把“本地模型”解释为手机本机推理。HTTP 只允许用户明确授权的可信局域网地址。

## 3. 模型选择 Sheet 与分类规则

目录列表固定分成以下顺序：

1. “推荐用于对话/朗读/语音输入”：目录明确声明或精确注册表确认；
2. “可能可用”：高置信正则分类，但目录未给出明确类型；
3. “未知能力”：无法分类或证据冲突，始终放在底部。

每一项显示名称、原始 ID、模型系列建议、证据来源和状态。列表允许搜索，但不隐藏所属分区。未知项被选择时显示一次明确提示；测试失败后保留在目录中并标记错误，不能删除目录项或把失败扩散到其他模型。

### 3.1 判定优先级

```text
供应商目录的结构化类型/模态
  > providerPreset + externalModelId 的精确注册表
  > providerPreset 限定范围内的有序正则
  > 全局保守正则
  > unknown
```

目录字段也必须由供应商解析器明确映射，不能因为字段名碰巧叫 `capabilities` 就直接信任任意自定义服务。冲突时采用更保守结果并记录 `conflict`，例如目录称模型支持图片、精确规则却注明当前端点不接受图片时，图片入口保持关闭，直到注册表修订。

### 3.2 正则规则合同

规则必须是有序数据，不散落在 UI 代码：

```js
ClassificationRule = {
  id,
  scope: { providerPresetIds: [], sourceModes: [] },
  priority,
  include: [/.../i],
  exclude: [/.../i],
  result: { kind: "llm|tts|asr", modelFamilyId: "..." },
  confidence: "high|medium",
  evidenceUrl,
  reviewedAt
};
```

分类顺序先识别 TTS、ASR、Embedding、Rerank、图像/视频生成等专用模型，再识别通用 LLM，防止 `gpt-*-tts` 因 `gpt-` 前缀误入对话模型。首批系列规则只覆盖有稳定命名边界的 GPT、Claude、Gemini、Grok、DeepSeek、Kimi/Moonshot、Qwen、GLM、Hunyuan、Llama、Mistral；不能用包含式的宽泛关键词把未知模型强行归类。

`modelFamilyId` 的自动结果标记 `source="rule"`；用户改选后标记 `source="user"` 并保存命中的规则版本。用户改选只改变系列匹配，不自动开启该系列全部能力。后续目录刷新若发现更高等级的官方证据，UI 提示重新确认，不能静默覆盖用户选择。

## 4. 统一中间合同

中间合同是 chataxi 内部的纯数据对象和事件流，不是单独部署的代理服务器。它继续使用原生 IIFE 模块，不引入 SDK、框架、构建器或运行时 CDN。

### 4.1 LLM 请求与响应

```js
CanonicalLlmRequest = {
  modelProfileId,
  instructions,
  input: [{
    role: "user|assistant",
    content: [
      { type: "input_text", text },
      { type: "input_image", source: { kind: "data_url|https_url|file_ref", value }, detail },
      { type: "input_file", source: { kind: "file_ref", value }, mimeType },
      { type: "input_video", source: { kind: "https_url|file_ref", value }, mimeType }
    ]
  }],
  generation: {
    maxOutputTokens, temperature, topP, topK,
    reasoning: { mode, effort, budgetTokens },
    imageGeneration
  },
  stream: true
};
```

`input_video` 是 chataxi 扩展。编译器在适配前删除值为空的项；能力为 `false` 或 `unknown` 的项不进入请求。若上下文中已有当前模型无法接收的媒体，发送前必须提示用户处理或使用已有文字分析，不能静默丢掉媒体后假装模型已经看过。

统一事件至少包含：

```text
response.started
output_text.delta
reasoning.delta
output_media.added
usage.updated
response.completed
response.failed
```

适配器必须区分增量片段和累计快照，保留完成、截断、拒答、取消和意外断流。原生思考块、签名或加密 reasoning 另存到 `providerState`，绑定连接版本、模型、角色、消息修订和因果链；它们不能混入可见文字、TTS、其他角色或其他供应商的上下文。

### 4.2 TTS 请求与音频事件

```js
CanonicalSpeechRequest = {
  modelProfileId,
  input,
  voiceId,
  instructions,
  responseFormat,
  speed,
  providerOptions,
  stream: true
};
```

统一输出为 `audio.started`、`audio.delta`、`audio.completed`、`audio.failed`。`audio.delta` 只说明收到了音频字节；能否三秒后播放还取决于 PCM、MP3、Opus 等格式是否具备真实的渐进解码和播放路径。模型能力、网络流、解码器和播放器四者都满足时才能显示“流式播放”。

连续向 TTS 提交增量文字使用独立扩展 `speech.input_text.append/commit`。只有 ElevenLabs WebSocket、豆包、Qwen 或本地服务的具体接口已由官方合同和真实夹具确认时才启用。普通 HTTP 流式响应只能证明音频边生成边返回，不能被标记为支持文字持续提交。

### 4.3 ASR 请求与转录事件

```js
CanonicalTranscriptionRequest = {
  modelProfileId,
  audio: { kind: "logical_file|pcm_stream", value, mimeType, sampleRate, channels },
  language,
  prompt,
  responseFormat,
  stream
};
```

统一事件为 `transcript.started`、`transcript.text.delta`、`transcript.segment`、`transcript.completed`、`transcript.failed`。批量文件转录和实时 PCM/WebSocket 是两种传输，不因同属一个模型系列而互相推断。Android 系统语音识别通过 Hermit Bridge 适配为同一结果事件，但可用语言必须来自设备查询结果。

## 5. 注册表设计

### 5.1 供应商入口表 `ProviderPresetRegistry`

负责连接事实：

```js
ProviderPreset = {
  id, kind, sourceMode: "official|aggregator|local",
  displayName,
  authSchema,
  requiredConnectionFields,
  defaultEndpoints,
  catalogAdapterId,
  transportCodecId,
  alternateTransportCodecIds,
  networkPolicy,
  evidence
};
```

API Key、区域、工作空间和地址是否出现由 `requiredConnectionFields` 决定。不存在的字段不显示。官方服务不让用户误选其他协议；自定义聚合服务才显示经过支持的协议选项。

### 5.2 协议编解码表 `TransportCodecRegistry`

负责精确的线协议转换，首批至少包括：

- `openai-responses-v1`；
- `openai-chat-completions-v1`；
- `anthropic-messages-2023-06-01`；
- `gemini-generate-content-v1beta`，Interactions 在完成等价夹具后作为独立 codec；
- `ollama-chat-v1`；
- `openai-speech-v1`、`elevenlabs-tts-v1`、`doubao-speech-v3`、`qwen-tts-*`、`minimax-t2a-*`、`android-tts-bridge`；
- `openai-transcriptions-v1`、`elevenlabs-scribe-v1`、`qwen-paraformer-*`、`android-asr-bridge`。

每个 codec 明确鉴权、端点、请求字段、响应字段、SSE/WebSocket/HTTP 解析、错误归一化、取消和流结束条件。不能用一个 `openai-compatible` 布尔值跳过供应商差异。

### 5.3 模型能力表 `ModelCapabilityRegistry`

```js
ModelCapabilityProfile = {
  match: { providerPresetId, externalModelId, modelRevision },
  kind,
  modelFamilyId,
  inputModalities,
  outputModalities,
  maxInputTokens,
  maxOutputTokens,
  contextWindow,
  parameters: {
    temperature: ParameterSpec,
    topP: ParameterSpec,
    topK: ParameterSpec,
    maxOutputTokens: ParameterSpec,
    reasoning: ParameterSpec
  },
  mediaMappings,
  streaming,
  evidence,
  status: "draft|reviewed|live-verified"
};
```

`ParameterSpec` 包含类型、合法范围或枚举、依赖、互斥、线字段以及来源。参数即使存在于注册表中也只在角色页显示；模型页只显示简洁的能力摘要和验证状态。

能力使用 `true / false / unknown`，不能用缺失值同时表示“不支持”和“尚未查明”。精确数值只在官方目录或官方文档提供时填写；应用自己的保守默认值另存，不能显示为官方模型上限。

### 5.4 能力解析与冲突规则

最终可用能力不是并集，而是约束交集：

```text
协议 codec 能表达
∩ 当前供应商入口允许
∩ 当前目录明确声明或精确模型注册表确认
∩ 当前设备传输/文件/音频能力可以完成
∩ 用户本次验证没有否定
```

目录只给模型 ID 时，精确注册表可以补充有官方依据的能力；正则只补充种类和系列建议。基础文字测试成功只把“文字生成”标为本连接已验证，不证明图片、视频、全部参数或所有音色可用。连接身份、模型 ID、系列选择、协议或凭据修订变化都会使验证记录失效。

### 5.5 能力来源

每条注册表记录必须带：

```js
Evidence = {
  sourceType: "provider-directory|official-doc|official-sdk-fixture|live-test",
  sourceUrl,
  sourceField,
  reviewedAt,
  appliesTo,
  notes
};
```

注册表不接受没有出处的“常识字段”。官方文档变化时更新规则版本；已保存模型保留旧快照并提示重新连接，不在后台静默改变角色行为。

### 5.6 功能驱动界面是强制合同

所有模型、角色、对话、试听和录音 Sheet 都必须由同一个 `ResolvedCapabilitySnapshot` 生成界面，禁止页面各自维护一套供应商名称判断。请求编译器也只接受这份快照，因此“页面能操作”和“请求会发送”来自同一个事实源。

```js
ResolvedCapabilitySnapshot = {
  modelProfileId,
  connectionRevision,
  registryRevision,
  capabilities,
  parameters,
  optionDomains,
  transport,
  deviceSupport,
  evidence,
  conflicts
};

OptionDomain = {
  source: "provider-directory|device-query|official-registry|none",
  status: "ready|loading|failed|unknown",
  values: [{ id, label, capabilities }],
  fetchedAt,
  connectionRevision
};
```

控件状态使用以下统一规则：

| 情况 | 界面行为 | 请求行为 |
| --- | --- | --- |
| 明确不支持 | 默认完全隐藏 | 字段必须缺失 |
| 支持且前置条件满足 | 显示并可操作 | 用户设置后按 codec 编译 |
| 支持但前置条件暂未满足 | 显示为禁用，旁边给出具体原因和完成前置条件的方法 | 不发送 |
| 能力未知 | 普通界面隐藏；只在明确的“未知能力/实验”入口说明 | 不发送未验证的可选字段 |
| 旧数据中存在、当前模型不再支持 | 只读禁用并提示“当前模型不支持”，允许清除或切回原模型 | 保留本地数据但不发送 |
| 这是完成任务的必需能力但当前不可用 | 保留任务入口并禁用主操作，明确指出缺少的能力 | 阻止调用，不能伪降级 |

禁用只用于让用户理解可恢复的依赖关系，例如“先选择音色”“当前设备未授予麦克风”“需要重新连接目录”。永久不支持的字段不占界面空间。仅有开发价值的未知参数不直接暴露给普通用户。

下拉 Sheet 的候选值也受能力驱动：

- 模型来自当前连接实际目录或带来源的官方后备目录；
- TTS 音色来自当前账号目录、设备查询或精确的模型—音色注册表，并先按具体模型过滤；
- 系统 TTS 的语言、音色和 ASR 的识别语言只来自 Hermit Bridge 对当前设备的查询结果；
- 推理强度、声音风格、输出格式等枚举只来自当前精确模型的 `ParameterSpec`；
- 目录失败时不显示预先堆叠的猜测选项。可以保留旧选择为不可用状态，但不能把它当作当前可选值。

每次上层值变化都重新计算完整快照：供应商变化清空目录与模型；模型变化重新计算参数、模态和音色；音色变化重新计算声音参数；设备能力或权限变化重新计算系统选项。异步目录结果必须匹配当前 `connectionRevision` 才能更新 UI，避免旧请求覆盖新选择。

界面渲染和请求编译各有一组对应断言：凡是可见且可操作的参数，都必须能在当前 codec 中得到合法映射；凡是编译后出现的可选字段，都必须能反查到当前页面的有效用户值或明确的协议必需默认值。自动测试逐项比较这两个集合，阻止功能和界面漂移。

## 6. 首批供应商与协议边界

### 6.1 对话模型

| 入口 | 来源 | 目录与协议策略 | 模型系列处理 |
| --- | --- | --- | --- |
| OpenAI | 官方 | Models 目录；Responses codec 优先 | GPT/o 系列由精确表决定参数与模态 |
| Anthropic Claude | 官方 | Models 目录；原生 Messages codec | 固定 Claude 系列，保留 thinking/signature 状态 |
| Google Gemini | 官方 | Models 目录提供生成方法和部分参数上限；GenerateContent codec | 固定 Gemini 系列；图片、视频和 Files 路径逐模型登记 |
| xAI / Grok | 官方 | 使用 xAI 官方模型目录与 Responses/官方兼容路径 | 固定 Grok 系列；模态读官方目录，不猜名称 |
| DeepSeek | 官方 | Models 目录；按精确模型选择经验证的官方兼容 codec | 固定 DeepSeek 系列，reasoner/chat 差异单列 |
| Kimi / Moonshot | 官方 | 目录元数据优先；官方兼容接口 | 固定 Kimi 系列；图片、视频能力逐 ID 登记 |
| Qwen / 百炼 | 官方 | 百炼目录、区域/工作空间规则和兼容接口 | 固定 Qwen 系列；视频模型与普通视觉模型分开 |
| GLM | 官方 | 官方目录可用时读取，否则仅用审核后备表；官方兼容接口 | 固定 GLM 系列，参数按具体型号登记 |
| 腾讯混元 / TokenHub | 官方平台 | 使用普通 API Key 可访问的 TokenHub 模型目录和推理协议；不混用 TC3 管理 API | 目录中的底层系列可推荐，外层协议保持 TokenHub |
| 豆包 / Ark | 官方 | Ark 的 Responses/文件路径；API Key 接入 | 固定 Doubao/Seed 系列；视频输入按精确模型登记 |
| Mistral | 官方 | Models 目录；Mistral 官方 Chat 协议适配 | 固定 Mistral 系列 |
| OpenRouter | 聚合 | 平台 Models 元数据 + OpenAI 兼容协议 | 自动推荐系列、允许修改；平台参数约束参与交集 |
| 硅基流动 | 聚合 | 平台目录 + 官方 OpenAI 兼容协议 | 自动推荐系列、允许修改 |
| Ollama | 本地 | `/api/tags` + `/api/show` + 原生 chat | 自动推荐权重系列；部署能力优先 |
| LM Studio | 本地 | `/v1/models` + OpenAI 兼容协议 | 自动推荐权重系列；上下文上限按部署事实 |
| 自定义 OpenAI 兼容 | 聚合/本地 | 用户地址 + `/v1/models`；只支持已实现 codec | 自动推荐、允许修改；未知项保持最小能力 |

Meta/Llama 是模型系列，不应在没有独立、稳定且已核验的官方推理入口时伪装成一个“Meta 官方 API”服务商。通过 OpenRouter、硅基流动、Ollama、LM Studio 等入口选择 Llama 更符合真实调用链。

### 6.2 朗读模型

首批稳定入口为 Android 系统朗读、OpenAI Speech、ElevenLabs、豆包语音、Qwen/CosyVoice 和 MiniMax。Azure Speech（含 MAI-Voice 预览音色）、xAI TTS、AWS Polly、本地 vLLM-Omni、Fish Speech、CosyVoice 自带服务按各自真实鉴权、签名和传输合同加入第二批，不能为了菜单完整套用 OpenAI Speech 请求体。

ElevenLabs 的模型目录、账号音色目录和“模型—音色”实际组合验证必须分开。音色名称用于展示，`voice_id` 原样发送；连接测试选中的组合只证明该组合可用。v3、v2.5、Professional Voice、IVC/PVC 规则以当前官方接口为准，禁止再次根据音色名称猜兼容性。

豆包语音 V3 使用新版 API Key 方案，但资源 ID、模型 ID、音色 ID 和请求头仍是不同事实。它们由模型注册表绑定，不能把“只需要 API Key”误解为可以省略请求所需的资源或音色字段。

### 6.3 语音输入模型

首批为 Android 系统语音识别、OpenAI Transcriptions、Qwen Paraformer、ElevenLabs Scribe 和自定义 OpenAI Transcriptions 兼容入口。系统入口只展示设备真实返回的可用状态和语言；不可用时隐藏测试和编辑按钮。

OpenAI 文件转录、ElevenLabs 批量转录、ElevenLabs 实时 WebSocket、Paraformer 文件转录和实时 WebSocket 都是独立传输能力。模型卡片只测试一种明确用途；对话的录音配置依据所选模型的 `batch`/`realtime` 能力显示。

## 7. 严格的字段映射

### 7.1 LLM

| 内部字段 | OpenAI Responses | OpenAI Chat | Anthropic Messages | Gemini GenerateContent | 无映射时 |
| --- | --- | --- | --- | --- | --- |
| `instructions` | `instructions` | system/developer message，按模型规则 | 顶层 `system` | `systemInstruction` | 阻止或按明确 codec 规则降级 |
| `input_text` | `input_text` | text content | text block | text part | 阻止 |
| `input_image` | `input_image` + URL/data/file | `image_url`，仅已确认模型 | image source block | `inlineData`/`fileData` | 发送前提示不支持 |
| `input_video` | 不作通用映射 | 不作通用映射 | 不作通用映射 | 仅精确模型和已确认 Files/part 映射 | 发送前提示不支持 |
| `maxOutputTokens` | `max_output_tokens` | `max_completion_tokens` 或供应商明确字段 | 必需的 `max_tokens` | `generationConfig.maxOutputTokens` | 使用 codec 合法默认或省略 |
| `temperature/topP/topK` | 逐模型允许后发送；无通用 `top_k` | 按平台与模型交集 | 按 Claude 约束 | 对应 generationConfig，逐模型约束 | 省略 |
| `reasoning` | 精确模型的 reasoning 配置 | 供应商扩展 | thinking 配置与签名 | thinkingConfig 与 thought signature | 不显示、不发送 |

百炼 Qwen、Kimi 和 Ark 已有官方证据支持的图片或视频输入应进入多模态阶段验收，不能只验证 Gemini 和 Ark。每个视频路径还要覆盖上传、轮询、文件过期、上下文历史复用和不兼容角色切换。

### 7.2 TTS

| 内部字段 | OpenAI Speech | ElevenLabs | 豆包 V3 | Qwen/CosyVoice | Android |
| --- | --- | --- | --- | --- | --- |
| `modelProfileId` | 外部 `model` | `model_id` | 注册表绑定的模型/资源 | 具体 API 的 `model` | 不适用 |
| `voiceId` | `voice` | URL 中 `voice_id` | 注册表绑定的音色字段 | 模型兼容音色 | 系统返回的 voice 标识 |
| `instructions` | 仅模型支持时 | 对应 voice settings/模型能力 | 对应模型真实字段 | 对应模型真实字段 | 不发送 |
| `speed` | 仅合法模型范围 | `voice_settings.speed`，若该模型允许 | 对应真实倍率字段 | 对应真实字段 | Bridge rate |
| `stream` | HTTP 音频流，格式受模型约束 | HTTP stream 或经确认的 WebSocket | SSE/WebSocket 具体协议 | HTTP/WebSocket 具体协议 | 系统回调 |

适配器只接收已解析的角色参数。供应商字段不存在时省略，不能发送占位 `null`、随意的默认枚举或从另一供应商借来的参数名。

### 7.3 ASR

| 内部字段 | OpenAI Transcriptions | ElevenLabs Scribe | Qwen Paraformer | Android |
| --- | --- | --- | --- | --- |
| 文件/音频 | multipart `file` | multipart `file` 或明确实时流 | 文件异步或实时 WebSocket 的各自合同 | Bridge 录音输入 |
| 模型 | `model` | `model_id` | `model` | 系统实现 |
| 语言 | 模型允许时发送 | `language_code` | 具体模型支持的语言 | 仅设备返回候选 |
| 增量 | 仅具体模型/接口支持 | Realtime 模型的 WebSocket | realtime 型号的 WebSocket | 系统 partial result |

## 8. 数据结构与角色配置

```js
CredentialRecord = {
  id, providerScope, secret,
  revision, createdAt, updatedAt
};

ModelProfile = {
  id,
  kind: "llm|tts|asr",
  displayName,
  providerPresetId,
  sourceMode,
  transportCodecId,
  modelFamilyId,
  familySelectionSource: "fixed|directory|rule|user",
  externalModelId,
  connection: { baseUrl, region, workspaceId, resourceId, endpointOverrides },
  credentialRef,
  catalogSnapshotRef,
  capabilitySnapshot,
  validationBaseline,
  validationRecord,
  connectionRevision,
  enabled
};

RoleModelSettings = {
  modelProfileId,
  maxOutputTokens,
  temperature,
  topP,
  topK,
  reasoningMode,
  reasoningEffort,
  reasoningBudgetTokens,
  allowImageGeneration
};

RoleSpeechSettings = {
  modelProfileId,
  voiceId,
  instructions,
  speed,
  stability,
  similarity,
  style,
  providerOptions
};
```

凭据不能因复制模型而复制明文。修改共享凭据时，所有引用它的模型卡片都标记“需要重新验证”；若用户只想替换一个卡片的凭据，先创建新 `CredentialRecord` 再切换引用。

角色页面根据 `capabilitySnapshot` 和 codec 约束动态生成控件。`max output tokens` 滑杆上限取模型、协议和部署上限中的最严格值；`top_k` 只在具体模型与当前传输都确认支持时出现。角色旧值在切换模型后不删除，但不会发送；返回原模型时可以恢复。

ASR 没有角色归属时，具体语言、实时/批量模式和提示词保存在对话语音输入设置。系统默认仍来自通用设置，对话值优先。

## 9. 连接测试与状态

连接过程使用不可变草稿版本。每次改变供应商、地址、凭据、具体模型、模型系列或协议都会增加 `connectionRevision`；迟到的目录和测试结果若版本不匹配则丢弃，避免再次出现“刚测试成功却因连接信息已改变而无法保存”。

状态至少分为：

- `catalog-loaded`：目录已读取；
- `catalog-fallback`：使用审核后的官方后备目录；
- `model-selected`：已选择一个具体模型；
- `validated`：该模型的最小调用成功；
- `validation-failed`：保留标准错误类别和供应商 request id；
- `stale`：连接身份或注册表版本变化，需要重测；
- `unavailable`：目录明确下架或权限收回。

LLM 最小测试只发送一句短文本，并要求极短输出；TTS 使用短试听文本和一个临时验证音色；ASR 使用内置短音频夹具或用户明确触发的录音测试。测试可能产生少量费用，按钮旁应说明。任何测试日志都不能包含完整 API Key、请求音频、角色提示词或用户聊天数据。

“默认配置可用”表示 `validationBaseline` 这一个最小组合通过，不表示所有角色参数、全部音色、多模态或流式模式都已经验证。角色设置使用了新的参数组合时，编译器仍先做本地合法性检查；供应商拒绝后只标记该组合失败，不污染模型的基础连接状态。

## 10. 旧数据迁移

迁移版本使用单独的 `modelProfileMigrationVersion`，过程必须幂等：

1. 为每个旧服务创建一个凭据记录和连接快照；
2. 对旧 `enabledModelIds` 中每个模型创建一个 `ModelProfile`；若只有 `defaultModelId/model`，只创建该模型；
3. 将角色的 `serviceId + modelId` 精确改写为 `modelProfileId`；
4. 将角色已有 LLM 参数迁入 `RoleModelSettings`，TTS 模型、音色和声音参数迁入 `RoleSpeechSettings`；
5. 旧默认模型只决定哪个迁移卡片优先显示，不再保留“一组模型的默认模型”语义；
6. 目录已消失但仍被角色引用的模型保留为 `stale`，不自动替换；
7. 保存迁移前快照，成功后原子切换，失败继续使用旧数据并允许重试。

复制添加、迁移和目录刷新都以 `providerPresetId + normalizedBaseUrl + credentialRef + externalModelId` 检测重复。用户可以确认保留同模型的两个独立配置，但默认提示复用现有卡片。

## 11. 实施顺序

### 阶段 A：冻结合同与测试夹具

- 为三套内部合同、统一错误、流事件和三态能力写数据合同；
- 从官方文档保存不含密钥的请求/响应夹具；
- 建立 `ProviderPresetRegistry`、`TransportCodecRegistry`、分类规则和精确能力表；
- 给每条规则增加来源、核验日期和状态检查。

完成条件：不加载 UI 即可根据一个 `ModelProfile` 编译或拒绝请求；未知能力不会生成线字段。

### 阶段 B：单模型数据层与迁移

- 重构 `app/services/catalog.js` 与 `app/services/model-services.js`；
- 增加凭据引用、单模型对象、验证修订和幂等迁移；
- 保留旧版本回读直到迁移验证通过。

完成条件：旧数据中的每个已启用模型形成独立卡片，全部角色引用保持一致，没有密钥复制或默认模型漂移。

### 阶段 C：模型页新流程

- 重写 `app/features/models.js` 的官方、聚合、本地连接 Sheet；
- 实现目录分区、系列自动推荐与可编辑选择、未知能力提示；
- 实现“复制添加”、连接测试、失效和重测；
- 删除模型页的角色运行参数与多模型开关。

完成条件：一次保存只能产生一个模型对象，页面无横向溢出，所有列表使用全宽自定义 Sheet。

### 阶段 D：角色参数与统一中间层

- 将 LLM 参数全部集中到角色“语言模型”；
- 将 TTS 音色与发音参数全部集中到角色“朗读发音”；
- 对话语音输入保存 ASR 的会话级参数；
- 让聊天、试听、自动朗读和录音测试只调用统一中间合同。

完成条件：同一角色配置在设置试听和真实对话中编译为相同供应商请求；不支持或未知参数不显示、不发送。

### 阶段 E：多模态、流式和 Native 前置能力

- 完成 Hermit 前台流式网络、可取消文件上传及需要鉴权 Header 的 WebSocket 合同；
- 验收 OpenAI、Gemini、Ark、Qwen、Kimi 的已登记图片/视频模型；
- 验收 TTS 音频分块、真实渐进解码、三秒起播、暂停续播和中断；
- 验收实时 ASR 音频块和部分结果。

完成条件：收到增量数据、完成前渲染/播放和正确结束状态都有证据；完整响应降级不能显示成“流式”。

### 阶段 F：真实账号和设备验收

每个稳定预设至少使用一个真实账号或本地运行时完成：目录读取、单模型测试、保存、角色选择、真实对话或语音闭环、重启后持久化。缺少真实凭据的适配器只能保持 `reviewed`/实验状态，不进入默认推荐。

## 12. 自动检查与验收矩阵

### 12.1 必须自动化的检查

- 每个官方入口只能引用已注册 codec，端点和鉴权字段有合同快照；
- 目录解析夹具覆盖分页、空目录、401/403/429、字段缺失和未知模型；
- 正则顺序确保 TTS/ASR/Embedding 等不会误入 LLM；
- 精确能力表中每个可发送字段都有 `wirePath` 和来源；
- 不支持、未知和互斥参数在编译结果中缺失；
- OpenAI、Anthropic、Gemini、聚合平台、Ollama 的请求与流事件有快照夹具；
- TTS 模型—音色组合不会跨模型混用；
- 模型系列用户修改后旧测试失效；
- 旧多模型服务迁移为多个单模型对象且角色引用不变；
- API Key 不出现在 DOM 明文、日志、错误、导出和测试快照中。

### 12.2 真机验收场景

| 场景 | 验收点 |
| --- | --- |
| 官方 LLM | 只填必要凭据即可读目录；选一个模型、测试、保存、对话成功 |
| 聚合 LLM | 目录正确分组；系列可改；外层协议不随底层系列错误切换 |
| 未知模型 | 位于底部分区；提示后可选；只获得测试证实的最小能力 |
| 本地模型 | 局域网地址授权清楚；目录和实际部署模型一致；断网错误可理解 |
| 角色 LLM 参数 | 只显示当前模型真实参数；切换模型后无非法残值被发送 |
| TTS | 模型页只证明连接；角色页选择名称化音色并试听；聊天复用同一路径 |
| ASR | 系统不可用时无测试/编辑；第三方批量和实时能力分别呈现 |
| 多模态 | 当前完整未压缩上下文中的所有媒体都在发送前做兼容检查 |
| 流式 | 首个增量时间、结束状态、取消、断流、音频渐进解码均可观察 |
| 数据迁移 | 原角色、对话、密钥引用、模型和音色选择无丢失、无重复明文 |

## 13. 明确不做的事

- 不让用户在普通官方服务中选择任意线协议；
- 不把聚合平台下的 Claude 模型直接改走 Anthropic 官方接口；
- 不根据型号正则启用多模态或高级参数；
- 不在模型卡片上配置角色的生成参数和音色；
- 不把目录读取成功、基础文字成功或某个音色试听成功扩大成整家族已验证；
- 不把视频扩展、实时 ASR 或文字增量 TTS 称为 OpenAI 标准；
- 不为新增供应商引入远程 SDK、CDN、框架或构建依赖；
- 不在本计划阶段修改运行代码、打包或部署设备。

## 14. 0.6.0 实施结果

2026-09-15 已完成阶段 A–D 的核心实现，并沿用此前已经具备测试证据的流式和多模态路径：

- 新增供应商入口、传输协议、模型系列、保守分类和三态能力注册表；专业模型先于通用 LLM 分类，错误用途不会进入推荐列表，证据不足的条目进入“未知能力”；
- 新增 LLM、TTS、ASR 三套内部合同，现有对话、压缩、朗读和转录入口先构造内部请求，再由现有供应商适配器编译；能力为不支持或未知的可选字段会在编译前删除；
- 数据结构升级到单模型卡片、共享凭据引用和独立模型目录。旧多模型服务会确定性拆分，角色与默认设置按原服务和模型精确重映射；
- 模型页实现官方、聚合和本地三类能力驱动流程，每次保存只产生一个具体模型卡片；复制添加复用连接信息但清空模型选择；
- 角色页统一为“角色档案、语言模型、朗读发音”，LLM 参数与 TTS 音色只在具体角色中按当前模型能力显示；
- 自动测试覆盖目录分类、能力裁剪、旧数据迁移、共享凭据、OpenAI 风格中间合同、ElevenLabs Scribe 鉴权，以及完整模型—角色—对话 DOM 流程。

阶段 E 中已有实现的原生 LLM 流、第三方 TTS 音频流、ElevenLabs/Qwen/xAI 文字增量通道和媒体请求继续回归通过。本版本没有凭空宣布所有供应商账号均已验收；阶段 F 仍需使用各用户自己的真实权限、区域和余额逐项确认。未获得这类证据的高级能力继续隐藏或保持未知状态。

## 15. 官方依据

本计划的协议边界和首批注册表应以以下官方资料及现有[供应商接口资料](chataxi-provider-api-reference-2026-09-14.md)中的逐项来源为准：

- [OpenAI Models](https://platform.openai.com/docs/api-reference/models/list)、[Responses](https://developers.openai.com/api/reference/responses/create)、[Speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)、[Transcriptions](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)；
- [Anthropic Models](https://platform.claude.com/docs/en/api/models/list)、[Messages](https://platform.claude.com/docs/en/api/messages/create)、[Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)、[Thinking](https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking)；
- [Gemini Models](https://ai.google.dev/api/models)、[GenerateContent](https://ai.google.dev/api/generate-content)、[Thinking](https://ai.google.dev/gemini-api/docs/thinking)；
- [xAI Models](https://docs.x.ai/developers/rest-api-reference/inference/models)；
- [DeepSeek Models](https://api-docs.deepseek.com/api/list-models/)；
- [Qwen/百炼模型列表](https://help.aliyun.com/zh/model-studio/list-models)、[Qwen TTS](https://help.aliyun.com/zh/model-studio/qwen-tts-api)、[Qwen 音色兼容列表](https://help.aliyun.com/en/model-studio/qwen-audio-tts-voice-list)；
- [GLM 对话补全](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)、[腾讯 TokenHub 模型列表](https://cloud.tencent.com/document/api/1823/132614)；
- [Mistral Models](https://docs.mistral.ai/api/endpoint/models)、[OpenRouter Models](https://openrouter.ai/docs/api/api-reference/models/get-models)、[OpenRouter Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)；
- [Ollama Models](https://docs.ollama.com/api/tags)、[Ollama Vision](https://docs.ollama.com/capabilities/vision)、[Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)、[LM Studio Models](https://lmstudio.ai/docs/developer/openai-compat/models)；
- [ElevenLabs Models](https://elevenlabs.io/docs/api-reference/models/list)、[Voices](https://elevenlabs.io/docs/api-reference/voices/search)、[Streaming TTS](https://elevenlabs.io/docs/api-reference/text-to-speech/stream)、[Speech to Text](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)；
- [阿里云 Paraformer](https://help.aliyun.com/en/isi/developer-reference/api-details)、[Azure Speech REST](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech)、[MAI-Voice](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-voices)、[AWS Polly](https://docs.aws.amazon.com/polly/latest/APIReference/API_SynthesizeSpeech.html)；
- [vLLM-Omni Speech API](https://docs.vllm.ai/projects/vllm-omni/en/latest/serving/speech_api/)、[Fish Speech Server](https://speech.fish.audio/server/)、[CosyVoice FastAPI 示例](https://github.com/QwenAudio/CosyVoice/blob/main/runtime/python/fastapi/server.py)。

官方文档只证明接口合同，不证明某个用户账号已开通、某个地区可用或某个聚合平台会完整转发字段。稳定预设必须同时通过合同夹具和真实连接验收；否则保持实验状态或隐藏。
