# chataxi 模型服务配置与运行机制升级方案

本方案面向 chataxi 0.5.0，核对基线为 2026-09-14 的现有源码、Haminn 公共合同与供应商官方资料。状态是**代码实现、自动合同与协议夹具、发布构建和指定实体设备部署均已完成**；它不等于所有供应商均已经用真实付费账号逐项验收。配套的[接口与适配资料](chataxi-provider-api-reference-2026-09-14.md)记录端点、字段、来源及待验证事项。范围包括 LLM、TTS、图片和视频输入，不包含 ASR、模型训练、云端账号系统或任意工具执行。

实施记录：chataxi 为 0.5.0/versionCode 35，配套 HaminnApp 为 1.9.0/versionCode 31、Bridge API 1.8。chataxi 的 67 项自动检查、Haminn 的 16 项公共合同检查、Debug Kotlin 编译、签名 Release 构建和 APK 校验均通过；Honor CMA-AN00 已覆盖安装新版宿主，并从局域网实时地址重新读取 0.5.0 的入口、样式和全部 33 个 JavaScript 模块。未使用用户密钥执行付费服务调用，真实账号的模型权限、地域、额度及音色授权仍应按第 11 节逐服务验收。

## 1. 结论与产品边界

应采用“统一操作流程、独立供应商适配、共同传输和播放基础设施”的方案。服务页只负责连接服务商及启用模型；角色页选择具体模型和声音，并按能力显示参数；对话页继续使用相同的消息、艾特、流式输出和朗读交互。供应商差异不能继续挤进一个 OpenAI 兼容请求模板。

多数个人 API 服务可以做到“选择服务商 → 粘贴密钥 → 连接 → 保存”，但不能承诺任何密钥都能列出所有模型并成功推理。账号开通、模型权限、余额、地域和实际网络可达是独立条件；Azure 需要资源区域，部分百炼接口需要工作空间，AWS 使用 IAM 签名，本地服务至少需要服务器地址。**必要信息必须直接显示，不能为了表面上的 key-only 把必填项藏起来。**

模型目录也不是完整、统一的参数说明书。有的目录只给 ID，有的已经给出模态、上下文和思考能力；即使字段较丰富，也通常不能覆盖音色权限、参数组合限制和设备流式播放能力。因此必须合并三种证据：供应商当前目录、随应用发布且有来源的适配规则、限定范围的实际调用结果。未知能力保持未知，不能靠型号字符串猜出支持。

OpenAI Responses 继续作为优先支持的协议，但“优先”不等于把每家服务都强制转换成 Responses。Anthropic、Gemini、Ollama 和语音服务使用各自得到验证的接口；OpenAI 兼容服务复用通用编解码，同时保留供应商的鉴权、目录和参数覆盖层。

## 2. 现有实现需要修正的具体问题

下表是源码审查结论，不以旧计划里的“已支持”文字替代真实实现。

| 位置 | 当前行为与风险 | 改造目标 |
| --- | --- | --- |
| `app/services/catalog.js` | 提供商、协议、内置模型、能力和音色放在同一表中；有默认输出上限和整家族流式标记 | 拆成供应商描述、协议能力和带来源的模型规则；内置目录是后备候选，不是假定已开通的账号清单 |
| `app/services/model-services.js:discoveredModel` | 只读少量通用字段，未完整转换 Claude、Gemini、百炼等结构；把 `supported_parameters` 当作模态证据 | 每家实现目录解析；参数、输入模态和输出模态分别归一化 |
| `modelDefinition` / `parameterProfile` | 缺失上限默认 8192；“共同参数”主要是参数名求交集 | 不把应用默认值显示为模型真实上限；共同设置还必须具有相同语义和合法取值交集 |
| `discoveryUrls` / `authHeaders` | 部分目录固定走官方地址；自定义请求地址和 Header 未与目录形成一致作用域 | 连接域、目录域、上传域明确配置并分别授权；自定义配置在发现与推理中一致使用 |
| `app/features/models.js:connect` | LLM 主要取目录，TTS 只测试首个模型和首个音色；成功文案却笼统写“连接与合成验证成功” | 目录、文本验证、指定模型音色验证分别记录和显示；一次验证不能扩散到全部模型 |
| 服务重新连接 | 当前会把返回的模型全部重新选中 | 保留已启用/已关闭选择；新模型作为可选项出现，已消失模型保留引用并标注状态 |
| `app/services/providers.js:build` | Chat 分支统一发 `max_tokens`，未分别落实 reasoning/thinking；Gemini 统一映射 thinkingLevel；温度主要靠 UI 隐藏 | 同一个能力解析结果同时约束 UI 和请求编译；未支持字段在发送前剔除，依赖条件执行于适配器 |
| `app/platform/network.js:requestSse` | Fetch 无可读流时读完整正文后解析，仍可能标记为 streamed；SSE 主要由页面直接联网 | 真流式必须以完成前收到增量为准；优先新增 Native 流式通道，旧环境如实标注完整响应降级 |
| `app/services/llm.js:stream` | 解析器返回的终止信息未形成完整的流状态机 | 明确成功完成、截断、拒答、失败和意外断流；有部分文字不等于成功完成 |
| `llm.js:hydrateMessages` | 仅水合最后一条用户消息的图片；消息内部模型是 `text/images` | 支持摘要边界后的多条消息媒体引用、文件生命周期以及不同类型的内容块 |
| `llm.js` / `chat.js` | 请求上限 900 KiB、每条最多四张图片，没有视频入口或上传流程 | 小图沿用内联；视频与较大媒体通过有界文件上传，不把视频整体塞进 Bridge JSON |
| `app/services/tts.js` | 协议、分段、网络、PCM 解码、WebSocket、播放和缓存高度集中；部分音色和资源共用列表 | 拆开供应商协议与音频播放；按模型、音色、资源和输出编码共同决定可用路径 |
| ElevenLabs 兼容性 | 已将质量元数据与白名单分离，也已有 v3 专用 Dialogue WebSocket | 保留正确修复，用官方合同和回归夹具保护；不再回退到按声音名称或质量列表猜兼容 |
| Haminn `NativeHttpClient.kt` / `sdk/haminn-api.d.ts` | `network.request` 完整响应后返回，请求体最多 1 MiB；没有公开流式、带 Header 的 WebSocket、逻辑文件上传合同 | 把通用传输补齐列为前置工程；不能只靠新增服务商菜单声称支持跨域流式和视频 |

这些问题优先级高于增加一长串服务商名称。当前正确的头像、全宽 Sheet、统一开关、个人设定覆盖、唯一角色发言和增量摘要边界均保留。

## 3. 服务商与接入顺序

| 批次 | 对话模型 | 朗读模型 | 完成条件 |
| --- | --- | --- | --- |
| 基础与首批 | OpenAI、Claude、Gemini、xAI、DeepSeek、Qwen 百炼、Kimi、GLM、腾讯混元/TokenHub、豆包 Ark、OpenRouter；Ollama 和通用本地兼容服务 | Android 系统、OpenAI、ElevenLabs、豆包语音合成 2.0/1.0 及已授权复刻资源 | 每家至少一个真实模型通过“连接—保存—角色选择—对话”闭环；视频能力单独验收 |
| 第二批 | Mistral、MiniMax、百度千帆、硅基流动；vLLM、LM Studio、SGLang 的专用发现补充 | xAI TTS、Qwen TTS、Gemini TTS、MiniMax、Azure Speech；本地 vLLM-Omni 优先，补充 Qwen3-TTS/CosyVoice/Kokoro/Fish 的明确服务接口 | 使用同一能力与传输框架，增加各自夹具和真实路径验收 |
| 按独立门槛交付 | Together、Fireworks及额外企业入口 | AWS Polly、MAI-Voice 预览型号、更多声音设计/复刻管理 | 凭据、区域、预览资格、签名及音频格式分别验证，不冒充第一批已覆盖 |

OpenRouter 作为首个海外聚合入口：它能提供有用的模型、参数和模态元数据，但聚合后的路由能力必须按 OpenRouter 合同解析，不能冒充模型原厂接口。硅基流动作为后续国内聚合入口。Together、Fireworks 可在通用机制稳定后加入，无需第一阶段同时维护多个相近的聚合入口。

“本地 Qwen/DeepSeek”按**部署运行时**配置，而不是按云厂商选择：Ollama、vLLM 等服务端加载什么权重，chataxi 就使用该端点实际暴露的模型。手机不会因此获得本地推理能力，应用也不负责下载权重或启动推理服务器。

## 4. 数据结构：服务、模型、参数与验证分离

建议继续使用原生 IIFE 模块和本地数据，不引入运行时 SDK、框架或远程执行代码。下面是拟议合同，字段名尚未进入运行版本。

```js
// 用户连接的一个具体服务实例
ServiceConnection = {
  id, kind, providerId, displayName,
  deployment: { region, workspaceId, baseUrl, protocolId },
  credentialsRef, credentialRevision,
  endpointOverrides, headerOverrides,
  enabledModelIds, catalogRevision, enabled
};

// 当前账号/区域/协议下观察到的模型快照
ModelDescriptor = {
  id, displayName, modelFamily, aliases,
  serviceId, protocolId, lifecycle,
  inputModalities, outputModalities,
  contextWindow, maxInputTokens, maxOutputTokens, deploymentLimits,
  parameters, transport, voicesPolicy,
  provenance, fetchedAt
};

ParameterSpec = {
  name, type, supported, defaultMode, defaultValue,
  min, max, step, values, unit,
  appliesWhen, conflictsWith, wirePath, source
};

ValidationRecord = {
  connectionRevision, modelId, voiceId, protocolId,
  operation, transport, format, status,
  checkedAt, errorCode, providerRequestId
};
```

`supported` 使用 `true / false / unknown`，输入图片、原生视频、视频抽帧、音频输出、增量文字会话也分别表达。分别保存模型标称窗口、独立输入上限、输出上限和部署实际配置的上限；按具体协议逐项检查，不能一律用“总窗口减预留输出”替代独立输入约束。Ollama 的实际 num_ctx、LM Studio 实例窗口不一定等于模型最大窗口。单独保留应用的保守默认值，UI 不把这个默认值标成官方上限。

`provenance` 最少包括来源类别、原始字段路径或官方 URL、规则版本、核验日期和适用模型范围。对整个模型名称做宽泛正则匹配只能生成“待核验提示”，不能因此启用视频或输出参数。

能力合并按具体字段处理：相同服务与具体模型的实时结构化声明优先于过时后备目录；官方明确的协议禁用条件仍然必须执行；已知限制不会被一个基础文本探测推翻。模型对话成功只能证明该请求参数组合可用，不能顺便证明图片、视频、全部音色和所有 reasoning 档位。发现相互矛盾证据时降为未确认，并保留来源供修订。

供应商列表中的“共同配置”应改为只读的家族概览。真正控制温度、思考和输出长度的仍是角色所选具体模型；仅当单位、语义、依赖和取值域都一致时才归为共用控制，避免“都叫 reasoning，所以都用 low/medium/high”的错误。

模型 ID、音色 ID、资源 ID 原样保存。展示别名不能替代请求 ID，同名音色不能跨服务复用。模型别名更新、下架或者访问被收回时保留原角色引用并说明原因，不自动改成另一模型或厂商。

## 5. 统一连接与角色配置流程

### 服务连接

服务 Sheet 默认展示供应商、必要的地区/资源字段、密钥及“连接服务”。地址、协议版本、目录地址、自定义 Header、超时等放在“更多设置”；本地地址、Azure 区域等真正必填项直接显示。密钥继续使用中间掩码和复制按钮，替换输入框留空保留原值。

连接先校验配置与授权，再读取可获取的模型/声音目录；没有目录的服务使用已审核的官方后备目录，并明确说明来源。随后对一个适合文本验证的候选模型，或一个明确的 TTS 模型与音色组合执行小样本验证。按钮附近说明连接测试会进行一次简短调用，可能产生少量费用；不批量试遍所有模型、声音或地区。

状态至少区分“已获取目录”“指定模型已验证”“已配置，待验证”“目录暂不可读”“密钥/权限错误”“额度不足”“网络不可达”。界面可以简洁，但数据中必须分开。目录读取失败不应把能用的历史配置清空；HTTP 401 也不能一概翻译成“缺少目录权限”，要解析厂商错误码。

对于目录无权限但可推理的账号，允许使用已缓存或官方后备模型进行有限验证；后备候选本身不显示为已验证。新服务至少要选定一个可用候选才能保存为启用服务，未验证草稿可保存但不得显示“接通成功”。不能为了保存而发送伪造的默认模型 ID。

连接验证与保存共用不可变的规范化草稿。身份包括 provider、region/workspace、各端点、鉴权版本和协议；用于校验的 key 只通过内存引用/凭据版本关联，不进入签名日志。改名称和模型开关不使连接失效；改连接身份使测试失效。异步请求通过草稿版本号丢弃迟到结果。重新连接保留既有启用选择，不能全部重新打开；保存为一次原子提交，避免再次出现“刚连接成功又说连接信息改变”。

### 角色配置

保持“角色档案、语言模型、朗读发音”三个子页。LLM 路径为服务 → 模型 Sheet → 参数；TTS 路径为服务 → 必要时选择模型 → 音色 Sheet → 支持的声音参数 → 试听。上级变化后立即重新求值，下级不存在的选项隐藏或禁用并提示如何修复，不把无效旧值发到 API。

温度和最大输出使用带数值的滑杆，但默认是“使用模型默认”；只有用户明确覆盖时才发可选参数。思考设置按真实语义分为模式开关、离散强度或 token 预算，不能强制映射为同一条线性滑杆。要求 `max_tokens` 的协议由适配器填入经验证的合法默认值。用户旧设置失效时标明“该模型不支持，使用默认”，保留原始数据以便返回旧模型。

声音提示词、语速、音调、稳定度和情感只在所选模型、音色及协议支持时出现。系统朗读不显示不存在的模型和账号音色层。试听与聊天调用完全复用同一请求构建、流式通道和播放器，防止“设置试听正常，对话失败”的两套逻辑漂移。

## 6. 适配层与请求编译

建议在现有 `services/` 下按职责逐步提取模块，不为拆文件而改动所有功能。供应商模块只实现差异，通用协议模块处理共性。

```text
features/models + features/roles + features/chat-session
                    ↓
service connections / catalog resolver / validation
                    ↓
conversation request compiler       speech session
                    ↓                    ↓
provider adapters + protocol codecs + media preparation
                    ↓
platform/network + platform/files + audio player
                    ↓
Haminn public Bridge / browser capability fallback
```

适配器统一提供 `discoverModels`、必要时 `discoverVoices`、`resolveCapabilities`、`validateOptions`、`buildRequest`、`parseEvent`、`normalizeError` 和可选 `prepareMedia`。它们不读取 DOM、不直接写持久化、不自行切换角色或其他供应商。

共享的 Chat Completions 编码器只处理基本消息结构。DeepSeek、Kimi、GLM、Qwen、TokenHub、OpenRouter 仍分别处理 thinking、输出 token 字段、特殊 Header、目录分页、模态和错误。Claude 思考与温度约束由其适配器实现；Gemini 新旧协议分别有标识，迁移要通过相同多轮对话夹具，不能只替换 URL。

Gemini 当前推荐的 Interactions 应新增为独立 `gemini-interactions` 适配；原有 `generateContent` 仍可保留，达到多轮历史、流事件、媒体及状态回传等价验收后再用于新连接。百炼的工作空间域名迁移也要单列兼容策略：旧可用连接不强制改址，新增能力按官方新域名合同验证，不能从 Key 推测 WorkspaceId。

统一内部消息改成内容块：`text`、`image`、`video`，保留 messageId、speakerId、speakerKind、附件引用和供应商无关的说明。摘要和参与者设定仍由现有 context 服务生成；发言者路由与个人设定逐字段覆盖规则保持不变。供应商端会话 ID 只是可丢弃的优化，不成为聊天历史的唯一真相；默认由本地历史构造请求，避免编辑/压缩后继续携带远端旧消息。

供应商要求回传的签名、加密 reasoning 和私有内容块单独保存在 `providerState`，绑定服务、模型、协议、发言角色、消息修订与因果链；不显示、不朗读、不传给另一厂商或另一角色冒充其输出。发生编辑、重新生成、角色模型切换或摘要边界推进时按协议重新构建状态，不能简单删掉必需签名后沿用同一远端会话。若协议允许用纯文字重建新链，则显式采用该路径。

统一输出事件包含 `text.delta`、`reasoning.delta`、`media`、`usage`、`finish`、`error`。协议层先区分增量和累计快照，累计文本不能被重复追加。思考内容与面向用户的最终文字分离，默认不送入 TTS；终止原因保留截断/拒答/失败等状态。显式成功事件或协议合法终止才完成消息，EOF 不一概等于成功。已经显示或播放部分内容后，不自动重发整条请求，也不跨模型补答。

## 7. 稳定流式与 Haminn 公共能力

当前 Fetch/SSE/WebSocket 路径受 WebView、CORS、混合内容和握手鉴权限制；仅在 JavaScript 里继续加供应商特例，无法保证国内普通手机全部稳定流式。应先在 HaminnApp 增加**通用、按 happ 隔离的前台流式网络与文件上传能力**，供应商业务代码仍在 chataxi。

拟议 Native 合同采用可背压读取：`network.openStream` 返回状态、Header 与流 ID，`network.readStream` 读取有界字节块，`network.closeStream` 取消并关闭。名字和结构需要在正式开发时写入 `api/`、SDK 和宿主合同测试；这些 API 当前不存在。以 32–64 KiB 的读取块为初始设计，按传输类型设定总量、空闲超时和前台生命周期，而不是把整条无限响应塞进一个 Bridge 消息。

对于需要自定义鉴权 Header 或二进制帧的 TTS WebSocket，增加独立通用连接、发送、读取和关闭合同，覆盖实例/运行代次隔离、可控队列与取消。它不允许后台常驻。Polly HTTP/2 EventStream/签名不能用普通浏览器 WebSocket 假装兼容；应单独实现明确客户端适配或使用用户自有网关。

文件上传通过已授权的 `logicalFileId` 流式读取，支持原始文件体以及明确的 multipart 部分。不能把宿主 1 MiB JSON 限制粗暴改成数百 MiB。视频导入、上传进度、取消、远端文件轮询和过期重传都必须可观测。

所有通道沿用 Origin 和私网授权、DNS 校验、HTTPS 要求、重定向约束及实例隔离。跨 Origin 时不得沿用 Authorization、API key、自定义敏感 Header 或上传凭据；新地址重新授权。现有 Native 客户端对跨域重定向只显式剥离部分标准鉴权 Header，新合同应覆盖实际供应商鉴权字段。

传输选择为：支持对应新合同的 Haminn Native → 确认有可读流且服务允许的浏览器通道 → 明示的完整响应降级。流式首片前失败也不天然允许自动重发：若请求可能已经被服务接收，应提示重试或使用供应商可验证的幂等能力，避免重复计费；一旦有内容或音频，绝不自动整段重放。

## 8. TTS：统一播放，区分文字流与音频流

TTS 能力至少拆为“完整文字输入”“增量文字会话”“流式音频输出”“输出格式/采样率/声道”。HTTP 响应持续返回音频，不代表同一个请求还能持续追加文字；按段发多个请求也不能标为双向文字流。

默认策略保持自动选择：支持音频流就用流式音频；支持增量文字会话就将 LLM 的完整段落持续写入同一会话；只支持完整文字请求的模型按自然段有序发起请求，避免并发造成声音乱序。系统朗读或不支持音频流的模型继续走完整文本路径。

输入分段器应处理空行、句末标点、模型长度上限和最终残段，避免拆开 Unicode 字符、音频标签或 SSML。单次回复仅拥有一个 TTS 会话，取消、修改、重新生成、离开对话和迟到结果都关联 messageId 与 generationId。内存队列有上限；长回复音频按块存为逻辑文件，防止全部 PCM 和 Base64 常驻内存。不要静默截断 10000 字符后假装整条已朗读。

播放器必须根据实际格式解码：PCM 声明位宽、字节序、采样率和声道；WAV 处理容器头；MP3/Opus 使用能持续解码的路径。不能将任意音频响应视作 24 kHz PCM。开始播放以真实已解码音频时长约三秒为缓冲门槛；短音频结束时立即播放。播放追上生成后按现有约定等待用户点击继续，不擅自更改这个行为。

首选可持续调度的 PCM 路径；MP3/Opus 必须使用经过目标设备验证的渐进解码能力，否则补充通用 Native 流播放器，或如实降级为完整音频播放。Native 收到分块不等于旧 WebView 能播放分块，阶段 B/C 的完成条件必须包含解码与首音早于响应结束。vLLM-Omni 可作为本地 TTS 的优先服务预设，但它支持的声音列表、参考音频要求和文字分段模式要按安装版本核对，不能把传统 vLLM 的 LLM 接口能力直接外推给 TTS。

自动朗读静音只阻止新自动朗读，不终止当前播放，手动播放始终可用。顶部图标播放时变绿色的语义保留。播完的音频按消息和有效 TTS 配置缓存，手动重播优先读取缓存；模型/音色/声音参数或消息文字改变后才失效。

ElevenLabs 必须以 voice_id 识别声音；`high_quality_base_model_ids` 不是兼容白名单，Jane/Jessica 等名称也不是兼容规则。v3 与传统 TTS WebSocket 是不同接口；某个模型音色试听成功只确认该组合。豆包则将 model family、资源 ID、服务版本与 speaker ID 分开保存，官方公用音色和账户复刻音色也分别处理。

## 9. 图片、视频与上下文

上传入口沿用统一 Sheet，提供所选角色实际支持的“图片/视频”。是否允许发送由**本轮被艾特角色**的模型决定，不取群聊所有模型能力的交集，也不因为另一角色能看视频就暗中替换发言者。

检查对象包括本轮附件和实际进入上下文的全部未压缩历史附件。下一轮艾特不能处理这些媒体的角色时，默认阻止不完整请求并提供明确选择：使用已有文字分析作为替代、选择支持的角色，或调整附件处理方式。文字替代必须标记为转述，不能伪装成该角色亲自看过原始媒体；没有已有分析时不得编造。用户明确选择后可按对话保存该处理偏好。

图片支持沿用小图压缩，但按模型请求限制计算尺寸、文件数、编码后字节量及估算 token。透明图片、文字截图和普通照片可使用不同压缩策略；不能只靠“总共四张”保证所有服务合法。已经在未压缩历史中的附件应该通过本地文件或有效远端引用继续提供，不能仅保留最后一次上传的图片。

视频必须区分原生视频理解与抽帧辅助理解。Gemini、Ark 及其他明确支持视频的模型按对应协议上传文件/传引用，并等待远端处理就绪。OpenAI 等接口如果当前没有对应的视频输入合同，就不能发送杜撰的 `input_video` 字段；可以提供标明限制的“抽帧分析”，它不能声称理解原始音轨或连续动作。未经用户选择，不把视频发送给别的供应商。

附件记录保存 `kind/mime/size/duration/width/height/localRef`；另表保存绑定 serviceId、完整 connectionRevision、contentHash 和预处理参数的远端文件 ID、状态与过期时间。connectionRevision 覆盖区域、项目/工作空间、端点、协议和凭据变更；上传结果再绑定附件 ID 与准备任务版本，取消、删除、编辑后到达的旧结果不得重新挂回消息。云端文件过期时由本地源重新上传；本地源缺失要明确报错，不静默丢掉附件。`blob:`、本机路径和局域网 URL 不可直接当作云服务可读取的文件地址。

摘要边界之前的媒体可由对话摘要描述辅助理解，但摘要必须指出哪些事实来自图像/视频分析。摘要边界之后的消息和媒体继续参与上下文；如果媒体预算不够，提示缩小、抽帧或压缩，而不是悄悄省略。自动压缩仍保留至少 N 条完整消息，固定用群聊第一位角色的模型；若该压缩模型不能看媒体，采用已有文字分析/附件描述并明确该限制，不能伪造视觉结论。

视频上线的验收包括选取、预览、上传进度、取消、处理中、请求引用、跨轮追问、过期重传、删除回收与普通手机内存上限。仅 API 能接收一个公开视频 URL 不算手机视频上传完成。

## 10. 数据迁移、维护与开发任务

保留现有 serviceId、roleId、conversationId、凭据、消息和概要。首先迁移结构并保留旧字段读取，随后在服务下次连接时生成新能力快照；已有模型和声音不自动换掉。迁移可重复执行，失败时回退旧读取路径；不要通过清空用户配置完成升级。

发布的适配数据记录 `registryVersion/checkedAt/sourceUrls`，只有经过审核的数据随应用更新进入正式目录，不从远端下载 JavaScript 执行。服务目录按用户连接/刷新获取，使用分页、防循环、长度上限和去重；TTL 到期只提示资料较旧，不阻断已经验证过的日常聊天。新目录失败保留上次成功快照。默认模型和全量快照分离，目录规模大时分批渲染和搜索，避免 Sheet 卡顿。

开发顺序建议如下，前三阶段属于稳定性主线，不能被更多厂商预设抢占。

| 阶段 | 主要改动 | 可交付检查 |
| --- | --- | --- |
| A：合同与数据 | 拆 provider/protocol/model/voice/validation；整理错误和连接事务；现有数据迁移 | 旧配置保留、未知能力不发送、重新连接不改选择、保存无签名误判 |
| B：传输基础 | Haminn 通用流式 HTTP、取消和逻辑文件上传；必要的 WS 合同 | 跨域真实增量、断流识别、取消无迟到写入、媒体不经过大 JSON；宿主独立发布验收 |
| C：已用服务闭环 | OpenAI、ElevenLabs、豆包语音、现有 LLM 修正；统一试听/对话路径 | 精确模型/音色组合、首音频早于响应结束、重播无重复合成、旧角色可继续用 |
| D：首批目录扩充 | Qwen/Kimi/GLM/TokenHub/Ark/OpenRouter/Ollama 及国际 LLM 原生差异 | 逐家完整连接与多轮对话，参数依赖由 UI 到请求一致 |
| E：多模态 | 所有已支持模型图片链路；具备视频能力的型号逐项实现，首验 Gemini/Ark，随后百炼 Qwen/Kimi，GLM/TokenHub/MiniMax/本地运行时按各自型号合同纳入；OpenAI按实际合同处理 | 真实附件上传和跨轮追问、错误提示、过期重传及内存限制；不能只验两家就宣称所有多模态服务完成 |
| F：扩展 | 其余 TTS、聚合、本地推理运行时、预览/签名服务 | 每个新增入口达到相同门槛才标为正式支持 |

拟改动的 chataxi 范围包括 `services/catalog.js`、`model-services.js`、`providers.js`、`llm.js`、`tts.js`、`images.js`，以及 `platform/network.js`、`features/models.js`、`roles.js`、`chat-session.js`、媒体存储与对应合同测试。Haminn 的 Native 传输在独立仓库实施并更新公开 API；不把供应商业务逻辑搬进宿主，也不修改 HaminnUI 来绕过权限。

## 11. 验收标准与尚待确认事项

自动检查要针对错误类型，而不是复制请求构建代码。保存脱敏的供应商目录/流事件夹具，覆盖分页、空目录、目录权限不足、未知字段、错误包、SSE 跨字节边界、Unicode、明确完成与意外 EOF、音频奇数字节块、短音频、背压和取消。测试具体协议输出的禁止字段和依赖关系，例如不支持温度的模型不能携带 temperature。

真实账号验收单独记录 provider、区域、modelId、voiceId、协议、参数组合、宿主/WebView 能力、首文字/首音频与完成时间及结果；不保存密钥或个人消息。只使用明确授权的凭据和小样本，不能根据一家的测试给全部服务打勾。普通手机验证必须覆盖 Native 流式、播放解锁和视频内存，不以桌面浏览器通过替代。

每个正式支持服务必须完成：新建连接 → 目录/候选正确 → 保存并重开 → 角色选择 → 实际对话或朗读 → 取消/错误恢复 → 重新连接保留配置。多模态、增量文字和额外音频格式为独立能力验收，未通过的设置保持隐藏、禁用或明确标记未验证。

尚需在开发时获取当前官方完整合同并实测的项目包括：账号与区域限定的模型目录；火山语音各资源的 speaker 对应和 V3 双向帧细节；MAI-Voice 预览资源资格；AWS 新流式签名/编码路径；本地 TTS 服务所选实现的真实 HTTP/WS 接口。不能把这些待确认项编造成通用默认值。配套资料的来源和证据等级是实现入口，开发前仍需针对所选具体版本做一次定点复核。

0.5.0 已完成供应商注册表、目录与参数归一化、原生/兼容协议编译、流式状态机、第三方 TTS、媒体准备和大目录外置存储；HaminnApp 同步增加通用流式 HTTP、逻辑文件上传与带 Header 的 WebSocket 合同。自动测试使用脱敏夹具，不使用配置文件中的密钥，也不能替代账号权限、区域、余额和真实网络条件下的逐供应商验收。

## 12. 关键决策的官方依据

模型发现与能力规则需要分离，是因为 OpenAI 目录与 Claude 当前目录暴露的信息明显不同；Gemini 接口迁移和百炼域名迁移也不能用通用兼容猜测处理。[^1][^2][^3][^4] OpenRouter 路由的参数保障需要自己的策略。[^5] Ark 的视频上传链路与本地语音运行时均有官方代码或接口依据。[^6][^7] ElevenLabs 两类 WebSocket、MAI 预览入口和 Polly 双向流应分别适配。[^8][^9][^10] 更完整的逐字段证据、冲突与来源编号见配套资料。

[^1]: OpenAI，[Models API](https://developers.openai.com/api/reference/resources/models/methods/list)，查证 2026-09-14。
[^2]: Anthropic，[List Models](https://platform.claude.com/docs/en/api/models/list)，查证 2026-09-14。
[^3]: Google，[Interactions overview](https://ai.google.dev/gemini-api/docs/interactions-overview)，查证 2026-09-14。
[^4]: 阿里云，[地域与域名](https://help.aliyun.com/zh/model-studio/regions/)，查证 2026-09-14。
[^5]: OpenRouter，[Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)，查证 2026-09-14。
[^6]: 火山引擎，[Ark 官方视频上传示例](https://github.com/volcengine/ark-runtime-python/blob/main/examples/volc/responses/async_video.py)，查证 2026-09-14。
[^7]: vLLM，[vLLM-Omni Speech API](https://docs.vllm.ai/projects/vllm-omni/en/latest/serving/speech_api/)，查证 2026-09-14。
[^8]: ElevenLabs，[TTS 与 TTD WebSockets](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets)，查证 2026-09-14。
[^9]: Microsoft，[MAI-Voice](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-voices)，查证 2026-09-14。
[^10]: AWS，[StartSpeechSynthesisStream](https://docs.aws.amazon.com/polly/latest/APIReference/API_StartSpeechSynthesisStream.html)，查证 2026-09-14。
