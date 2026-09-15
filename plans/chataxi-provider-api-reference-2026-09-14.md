# chataxi LLM、TTS 与多模态接口适配资料

本资料与[升级开发方案](chataxi-llm-tts-upgrade-plan-2026-09-14.md)配套，供后续编写适配器、能力目录与测试夹具使用。核验日期为 **2026-09-14**。以下端点和字段来自该日期读取的官方文档或官方源码；具体模型名用于说明差异，不是永久默认模型清单。

## 1. 证据范围与使用方式

文档证据、源码证据、本地配置证据和实际调用验证分别记录。本轮查阅 chataxi 0.4.19 的 `catalog/model-services/providers/llm/tts`、服务与角色编辑流程，以及 Hermit 的 `NativeHttpClient` 和公共 SDK。没有进行付费推理、合成或手机新版本验收。因此“官方支持”只代表接口合同，不能写成“当前账号下全部模型已经可用”。

查证快照与发布日期不同。来源未标注更新时间时，仅保留查证日期；预览型号、即将迁移的域名和互相冲突的文档在相关条目注明。无法获取正式网页正文时，以已读取的官方 SDK/示例作为次一级证据，并列出尚待确认的合同，不用第三方教程填补事实。

### 本地成功配置的非敏感参考

已读取 `xagent/aicore/config/xconfig.yaml` 的相关结构，只提取地址、模型、协议和资源信息：

| 用途 | 配置事实 | 可以推导的结论 |
| --- | --- | --- |
| Ark 对话 | Base URL 为 `https://ark.cn-beijing.volces.com/api/v3`；大部分任务使用 `/responses`，部分使用 `/chat/completions`；存在 API Key | 应支持 Ark 的两种协议，不能要求 App ID；这不是全部模型权限的实测证明 |
| Ark 示例模型 | `doubao-seed-2-1-pro-260628`、`doubao-seed-2-0-lite-260215` | 可与官方 SDK 示例交叉定位，不能代替账号目录或写成所有用户默认值 |
| 豆包语音 | `wss://openspeech.bytedance.com/api/v3/tts/bidirection`，`resourceId=seed-tts-2.0`，`sampleRate=24000`，存在 API Key，无 App ID | 新 Key 路径是已有配置方向；应补齐双向协议及模型资源与音色映射 |

配置文件里的成功使用情况由现有项目提供，本轮没有使用其凭据重放调用。实际密钥、账号专属音色和个人配置均未进入本文或 chataxi 源码。

### 当前工程限制

chataxi 的普通请求走 Native 完整响应，SSE/TTS 流目前直接使用页面 Fetch/WS；Native 请求体上限 1 MiB，chataxi 自限 900 KiB。现有消息只水合最后一条用户消息的图片，没有视频上传链路。下文的接口能力要配合开发方案中的流式 Bridge、文件上传与消息内容块改造后，才成为端到端产品能力。

## 2. 国际官方 LLM 与 OpenRouter

### OpenAI 官方 API
- 地址与认证：`https://api.openai.com/v1`，`Authorization: Bearer <key>`；`GET /models`，对话优先 `POST /responses`，保留 `/chat/completions` 兼容既有模型。组织/项目绑定 Key 通常只需 Key；旧用户 Key、多组织场景可需 `OpenAI-Organization`、`OpenAI-Project`，放更多设置。认证与调试[^1]
- 目录返回 `data[]`，含 `id/created/object/owned_by/shutdown_date?`。**不返回通用的上下文上限、温度约束、推理枚举、完整模态和工具 schema**。不能据 `owned_by`、名字包含 `gpt` 或“可列出”就确定是文本对话模型；目录与官方能力注册表交叉分类，未知模型先保持基础文本配置、标记未验证。Models API[^2]
- Responses 基本请求：`{model,input:[...],instructions?,stream:true,store:false,max_output_tokens?,reasoning:{effort}?}`。Chat 对应 `messages`、`max_completion_tokens` 等。输出上限包括推理与非可见 token，低到只能耗尽推理预算时可能没有最终文字，不能因此说服务没模型。推理枚举及采样参数必须按精确模型/版本规则，不把所有家族映射到一个 0~2 温度参数；默认不发送用户没改过的参数。保留本角色、本服务返回的 provider 私有输出项，用于协议要求的后续回传；不能把加密 reasoning 放进可见文字或 TTS。推理与状态[^3]
- SSE 使用具名事件，正文是 `response.output_text.delta`；还要处理 completed/incomplete/failed/error/拒答，不能仅看 HTTP 200 或等待 `[DONE]`。调用内置工具时可能产生多种输出项。流式响应[^4]
- 视觉输入使用 `input_image`，支持图片 URL、data URL 或 Files ID；图片理解与图片生成是不同能力。Responses 的 `tools:[{type:'image_generation'}]` 与单独 Images API 不能等同任意聊天模型的 `allowImage` 开关。当前抓取的官方 GPT-6 Astra 模型卡明确输入为 text,image，输出为 text；本轮未找到 OpenAI 通用聊天接口接受完整视频文件的明确合同，因此不得仅因为支持视觉就开启原生 MP4 上传。可另做明确标为“视频关键帧分析”的图片抽帧路径，注明只观察选取帧、可能漏掉帧间事件且没有音轨；保留时间戳也不等同原生音画视频理解。需要原生视频时可让用户显式选择已配置的视频能力角色，不能私自换服务。Sora 视频生成和Realtime语音均不改变此判断。模型卡[^5]图像与视觉[^6]

### Google Gemini Developer API

- 使用 `https://generativelanguage.googleapis.com/v1beta`，`x-goog-api-key`，读取 `/models` 并遍历 `nextPageToken`。`models/*` 名称、input/output token limit、supportedGenerationMethods、thinking、默认/最高 temperature、topP/topK 可从目录得到；topK 缺失时官方明确不可传。目录仍不是全部媒体限制/推理档位 schema。模型目录[^7]
- **当前官网（2026-09-04 更新）已经把 Interactions API 列为 2026-06 GA、新项目推荐接口**。`generateContent` 仍完全支持但标记 legacy；新模型和能力优先发布在 Interactions。建议新增 `gemini-interactions`，保留 `gemini-generate-content` 旧适配，不强制把旧配置重置。默认 `store:false`，应用自己保持概要与未压缩历史；不混用服务器历史和本地完整历史，避免重复上下文。接口状态与迁移边界[^8]
- 新接口 `POST /interactions?alt=sse`，header 如上，请求 `{model,input,system_instruction?,generation_config?,stream:true,store:false}`；流式解析 `step.start/step.delta/step.stop`，仅 `delta.type==='text'` 的正文进入气泡，thought/signature独立保存，`interaction.completed` 与 incomplete/失败独立处理。旧接口是 `/models/{id}:streamGenerateContent?alt=sse`、`contents/systemInstruction/generationConfig`，不得混用字段命名。入门与 SSE 合同[^9]
- Interactions 的推理为 `generation_config.thinking_level`，不同模型支持档位不同；不能把 `minimal` 当真正不推理，也不能把固定“关闭”选项给所有模型。`max_output_tokens` 包含 thought tokens。无状态模式需按合同保存并原样回传 thought blocks 与 signatures；这要求消息附带私有 provider state，并在编辑、再生成、压缩后按因果边界作废，不能只持久化 `text`。推理与签名[^10]
- 支持图片与视频的模型应走原生多模态。新接口媒体项如 `{type:'video',uri:<file URI>,mime_type:'video/mp4'}` 或 base64 `data`；总请求大于 20MB、长视频/重复使用走 Files API，等待文件处理到可用状态再推理；不能把手机 file:// 或内网暂存 URL 交给云端。协议的原生视频、抽帧图片模式分开记录。视频输入[^11]
- AI Studio Key 绑定项目；当前文档新增 auth key 与旧 standard key 的区分，未限制的旧 Key 可能被拒绝/封停，不能统一误报 Key 字符串错误。API 可用地区、计费档位/额度限制仍存在。Google Cloud Vertex 是独立产品入口，不能用 Developer API 的 Key、host、model 名套上去。Key[^12]、地区[^13]

### Anthropic Claude 官方

- `https://api.anthropic.com/v1`，`x-api-key` + `anthropic-version: 2023-06-01`。读取 `/models`，按 `has_more/last_id/after_id` 翻页。**当前目录已经增加 capabilities 与 max_input_tokens/max_tokens**；capabilities 可含 image_input、pdf_input、thinking.types、effort 每个档位 supported、structured_outputs 等。应优先读这些实时字段，不沿用“目录只有 id/name”的旧假设；null、缺失或示例中的 0 均不能当实际有效上限。Models[^14]
- `POST /messages`：`{model,max_tokens,messages:[{role:'user'|'assistant',content:...}],system?,stream:true,thinking?,output_config?}`；system 是顶层字段。推理适配旧 `thinking:{type:'enabled',budget_tokens:...}` 与模型支持的 `adaptive`，effort 实际位置 `output_config.effort`。**官方当前明确 Opus 4.6 之后发布模型不支持任意 temperature/top_p/top_k；兼容常量有特殊放行但不应据此展示滑竿。**不能向整个 Claude 家族无条件注入 temperature=0.7。Messages 参数[^15]
- 正文 SSE 使用 `content_block_delta` 的 `text_delta`；thinking、签名、工具 JSON 增量与正文分开，message_stop 才是结束。需能处理 HTTP 200 后的 error，别把“流关闭”当正常完成。Messages streaming[^16]
- 图片 block 是 `{type:'image',source:{type:'base64',media_type,data}}` 或 URL/Files引用。直连 Claude 文档当前上限单张10MB（base64后）；Bedrock/Google Cloud是5MB，不能混用；标准请求32MB更可能先到顶。JPEG/PNG/GIF/WebP，动画只首帧。未核验到通用 Messages 的原生视频内容类型，因此视频按钮不能因 image_input=true 自动显示。Vision[^17]
- Claude 直连 Key 通常足够；Bedrock/Vertex 是另一个服务入口、认证与区域集合，应晚于直连适配，禁止拿其模型 ID 去打 api.anthropic.com。

### xAI Grok 官方

- `https://api.x.ai/v1` + Bearer Key；LLM目录优先 `/language-models`，**顶层为 `models[]`，不是 OpenAI 的 `data[]`**；再以 `/models` 作为基础目录降级。扩展目录含 input/output_modalities、aliases、fingerprint、价格，但不含完整参数约束。避免旧错误：严格用 data[] 解析后误报没有模型、只允许固化的 Grok 名称前缀、把 image-generation 模型放入角色聊天列表。模型目录合同[^18]
- 当前官方优先 Responses API：`POST /responses`，`model/input/stream:true/store:false`；Chat Completions保留legacy兼容。应用已有本地历史/概要，不应启用默认服务器状态再重复发送同一历史。文本生成[^19]
- 推理实际参数是 Responses `reasoning.effort`。当前示例：grok-4.6 支持 low/medium/high/xhigh，grok-4.5无xhigh；不能关闭推理；presence/frequency penalty和stop不适用于推理模型。这里必须做版本规则，不能永久断言“所有Grok没有推理参数”或“所有有”。multi-agent 模型同名 effort 控制的是代理数量，不能用普通推理滑竿含义直接解释。推理[^20]
- 图像理解 `input_image` 可URL或data URL，当前文档图像只列 JPEG/PNG、单张20MiB。没有从当前文本API核验到原生视频理解合同；Imagine的视频生成/编辑不能视为聊天视频理解。图像理解[^21]、Imagine产品边界[^22]

### OpenRouter

- 建议正式支持，但明示它是聚合服务，模型作者与实际执行提供方分离。`https://openrouter.ai/api/v1`，Bearer Key，`GET /models`，`POST /chat/completions` + stream。`HTTP-Referer`、`X-OpenRouter-Title`是可选应用归属，不是认证必填；不要让用户填。Quickstart[^23]
- 目录 `data[]` 可含 canonical_slug、context_length、architecture.input/output_modalities、supported_parameters、default_parameters、top_provider.max_completion_tokens、pricing、expiration_date。当前支持可选offset/limit分页与links.next；不分页默认全量。比 OpenAI目录丰富，但模型层能力不能无条件保证每个下游endpoint相同。Models[^24]
- 读取 `/models/{author}/{slug}/endpoints` 细化路由元数据。发送用户实际启用的参数时建议 `provider.require_parameters:true`，否则默认可路由到忽略该参数的提供方；不要在失败时静默换模型、更换计费服务，provider fallback仅按保存的路由策略发生。Endpoints[^25]、路由行为[^26]
- 支持视频的模型/路由可用 `{type:'video_url',video_url:{url:<URL或data URL>}}`；URL支持因上游不同，例如官方文档给Google AI Studio仅YouTube链接的限制，不应把通用公网MP4 URL当所有上游都能用。参数 `processing:agentic/static` 也是模型/上游能力。模型目录中 `video` 才能启用原生视频入口。Video[^27]
- 公共目录能读取不等于Key有效/余额足够；连接必须另做授权范围和短对话验证。价格与可用endpoint会变，不能保存一次后永久标记“已接通所有模型”。

## 3. 国内官方 LLM

### 官方服务配置和发现入口
以下 Base URL 为推理前缀，路径不要靠全局“末尾补 /v1”算法猜测。均使用 HTTPS、JSON、Bearer Key（表内特别说明除外）。

|服务预设|推理 Base URL / 首选协议|发现模型和元数据|最低配置及限制|
|---|---|---|---|
|DeepSeek 官方|`https://api.deepseek.com`；Chat `/chat/completions`，也已提供 Responses `/responses`|`GET /models`；基础 ID/owner 目录，完整能力需官方规则补齐|有效 DeepSeek API Key；不要从旧 `deepseek-chat/reasoner` 名字推断当前能力|
|阿里云百炼 / Qwen|推荐 `https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1`；Chat。北京兼容老地址 `https://dashscope.aliyuncs.com/compatible-mode/v1`|独立目录路径 `/api/v1/models`，**不是**在 compatible-mode 后拼 models；分页 `page_no/page_size`，解析 `output.models`|Key + 正确地域；生产推荐业务空间 API Host。旧默认域名可简化已存在账号，但新版能力不应无限依赖它|
|Kimi / Moonshot 中国站|`https://api.moonshot.cn/v1`；Chat|`GET /v1/models`，返回 `context_length/supports_image_in/supports_video_in/supports_reasoning`|中国站 Key；国际站为 `api.moonshot.ai`，站点 Key 不互通|
|智谱 BigModel 中国站|`https://open.bigmodel.cn/api/paas/v4`；Chat|本轮官方索引没有找到完整的 models API 合同；`GET .../models` 可作为实现阶段受控探测项，失败必须降级至官方型号目录；**不能把待验证端点写成必然存在**|通用 API Key；GLM Coding Plan 是专用产品/地址，应明确分离；国际 Z.AI 也不能当同一账号|
|腾讯 TokenHub（混元首选新预设）|中国 `https://tokenhub.tencentmaas.com/v1`，新加坡 `https://tokenhub-intl.tencentmaas.com/v1`；Chat 优先；按具体模型可用 Responses/Messages|`GET /v1/models`，已官方公开，返回 ID/name/status。管控面的 `DescribeModelList` 有更多能力但属于另一种云鉴权合同，不要求手机用户提供云 AK/SK|TokenHub API Key + 服务已开通 + 正确站点/地域；不要混用旧混元/LKEAP/Token Plan Key|
|腾讯混元旧服务（兼容保留）|`https://api.hunyuan.cloud.tencent.com/v1`；Chat|旧文档指向产品模型表，无本轮核证的完整动态参数目录|旧 API Key 保留；官方明确迁移 TokenHub，停止新购/不再新增模型能力；不作为新用户默认入口|
|火山方舟 Ark / 豆包|`https://ark.cn-beijing.volces.com/api/v3`；新建优先 Responses `/responses`，保留 Chat `/chat/completions`|不能把 `/api/v3/models` 当已支持的 OpenAI 目录。基础模型管理目录与运行时推理分开；无可用公开运行时目录时用官方规则目录 + 当前 model ID 验证|运行时 API Key 即可鉴权，不需要 App ID；预置模型可直接 model ID；自定义部署保留 `ep-...` 推理接入点。API Key 对应项目/模型授权仍必须成立|
|MiniMax（建议纳入）|查证时的官方新文档使用 `https://api.minimax.cn/v1`；历史为 `api.minimaxi.com`；国际另设区域预设|`GET /v1/models` 和单模型详情已有官方文档。基本条目仍不足以提供全部参数 UI|API Key；旧域名迁移应独立验证，不能把带凭据的任意重定向当自动可靠迁移；LLM 与其 TTS 使用同厂商身份、不同能力适配|
|百度千帆（建议第二批纳入）|`https://qianfan.baidubce.com/v2`；Chat；另有 Responses|`GET /v2/models`，ID/type/context/输入输出模态/价格/输出约束等，字段命名有专属差异|新版 API Key Bearer；不能套旧 OAuth API Key + Secret Key 取 access_token 流程；需有对应能力授权|

出处：DeepSeek Models[^28]、DeepSeek Responses[^29]、百炼目录[^30]、百炼地域与域名[^31]、Kimi 中国目录[^32]、智谱鉴权[^33]、腾讯 TokenHub API[^34]、旧混元迁移公告所在页[^35]、Ark 官方 SDK[^36]、MiniMax 目录[^37]、千帆目录[^38]。均于 2026-09-14 查证。

#### 百炼需要单独设计的地域/业务空间分支

当前官方明确将业务空间专属域名作为推荐路径，旧 DashScope 域名自 **2026-09-30 起不再支持新特性**。北京、新加坡、香港、东京、法兰克福、弗吉尼亚各有独立 Key 和模型范围。新目录北京/东京/法兰克福/弗吉尼亚要求 WorkspaceId；新加坡/香港文档也给出固定 DashScope 目录域名。不要把 Key 发到多个区域做碰撞式尝试。表单可以默认“中国北京”，当选中接口必需时直接显示 API Host/业务空间；若用户复制的是官方完整配置片段，可解析 Host，但不得从 Key 字符串编造 WorkspaceId。地域说明[^31]

目录字段应保留：`model`、`provider`（作者）与 `inference_provider`（推理商）、`capabilities`、`features`、`inference_metadata.request_modality/response_modality`、`model_info` 中 context/max_input/max_output/max_reasoning 及 thinking 变体限制、`equivalent_snapshot`。`null` 不等于 0，也不宜当无限能力开放参数。需要翻完 `output.total` 指示的所有分页。该目录没有给出 temperature、thinking 枚举等完整 JSON Schema，仍须本地适配规则。目录 Schema[^30]

### 各家参数差异：采用条件规则，不使用万能请求体

|家族/部署|统一 UI 语义 → 线上字段|必须隐藏或转换的情况|
|---|---|---|
|DeepSeek 官方 Chat|思考开关 → `thinking.type`；努力程度 → `reasoning_effort`；输出预算 → `max_tokens`；回答流 → `delta.content`，推理流 → `delta.reasoning_content`|思考开启时 temperature/top_p/frequency/presence 不生效，应隐藏。当前型号努力档位为 low/high/max，兼容 medium/xhigh 映射并不等于独立真实档位|
|DeepSeek Responses|思考/努力 → `reasoning.effort`；预算 → `max_output_tokens`；解析 Responses 语义事件|最终状态 `completed/incomplete/failed`，不能等待 Chat 的 `[DONE]`；更不能把 reasoning 当可朗读正文|
|Qwen / 百炼 Chat|思考 → `enable_thinking`；部分型号预算 → `thinking_budget`；最终生成预算按该型号 `max_tokens` 合同；`reasoning_content` 与 content 分流|混合思考、强制思考、无思考型号不同；商业版与开源部署默认不同；部分模型开启思考只支持 stream。尤其百炼 Kimi/DeepSeek 不应沿用作者官方请求字段|
|Kimi K2.5/K2.6 官方|`thinking:{type:enabled|disabled}`；`max_tokens`；推理独立返回|已公开该两代思考 temperature 固定 1.0、非思考固定 0.6，top_p 固定 0.95；错误值会被拒绝，应该不显示温度滑杆。更后代参数必须查自己的规则，不继承此开关|
|GLM 官方|思考 → `thinking.type`；新型号努力 → `reasoning_effort`；预算 → `max_tokens`|GLM 5.2 与 5.3 的有效档位不同，5.3/Flash 强制思考、仅 low/high/max；不能用“GLM≥4.5全一样”。正式Chat schema当前temperature为0~1、step0.01，5.x/4.6/4.7默认1，4.5默认0.6；do_sample=false时隐藏temperature/top_p。通用教程声称开区间(0,1)与正式schema冲突，以schema+验证为准|
|腾讯 TokenHub|Chat/Responses/Messages 按选定协议序列化；同一 model 的可用协议受平台支持表限制|聚合转发的 DeepSeek/GLM 等必须用 TokenHub 合同；不要在 Chat 全局发送 `enable_enhancement`（旧混元专属），也不要为所有模型发送 reasoning_effort|
|Ark Responses|`thinking.type`、`reasoning.effort`、`max_output_tokens`、`temperature`；具体型号约束由 Ark 规则决定|SDK通用 enum 含多档不证明所有模型支持所有档；与 Chat 的 `reasoning_effort/max_completion_tokens/max_tokens` 不应混发；推荐保留 Responses 原生能力|
|MiniMax|Chat建议 `reasoning_split:true`，推理进入 reasoning_details/reasoning_content；M3 `thinking.type=adaptive|disabled`，预算新用 `max_completion_tokens`，temperature 0~2|M2.x不能关闭thinking；reasoning_split只分离格式、不控制开关；未分离时content含think标签，禁止直接送TTS。M3支持图像/视频，不把能力扩给全部M系列|
|百度千帆|Chat 基础字段 + 千帆专属约束；目录 `max_completions_tokens`（复数）须正规化|发现响应字段不是请求字段；不直接把 `max_completions_tokens` 原样透传给 Chat 请求，也不把不同模型 max_tokens/max完成预算混为一项|

参数证据：DeepSeek Chat API[^39]、DeepSeek Thinking[^40]、Qwen 深度思考[^41]、Kimi K2.6 约束表[^42]、智谱核心参数[^43]、GLM5.2 型号文档[^44]、TokenHub 协议说明[^45]、Ark Chat 参数源码[^46]、Ark Responses 参数源码[^47]。2026-09-14。

GLM参数补充来源：正式Chat OpenAPI文档[^48]，通过官方Markdown成功读取，明确video_url示例与采样范围。MiniMax参数补充来源：官方OpenAI接入Markdown[^49]，2026-09-14成功读取。M3多模态采用image_url/video_url；大视频用Files上传后mm_file://引用，不能沿用Kimi的ms://。该文档示例reasoning_details有累计内容处理，流事件规范应携带delta/snapshot语义，防止前端追加出重复推理文本。

推荐 `ParameterDefinition` 至少记录：`key/type/ui/range/enum/default/sendDefault/visibleWhen/requiredWhen/conflictsWith/wirePath`。对未知模型，选项默认保守并注明未确认；不要按名字含“pro”“reasoner”“vision”就推断完整能力。正文生成成功而只返回 reasoning 并不等于模型完成回答；需区分预算耗尽、截断、正常完成。

### 多模态要实现端到端传输，而不只是显示上传按钮

图片与视频应存成消息的结构化 content parts，至少保留本地原文件、MIME、大小、图片尺寸/视频时长、来源、上传状态。发送时由适配器构造真实协议，绝不把 JSON 数组 stringify 成普通文本，也不能把本地 `file://` 或 `content://` 路径直接传给云模型。压缩历史可保留经验证的视觉摘要，但当前未压缩消息按其附件真实传输能力发送；不要静默丢弃附件。

|服务|图片|视频|实现注意|
|---|---|---|---|
|DeepSeek 当前 Vision|Chat `image_url.url` data URL/公网 URL，或 `file` 引用；Responses `input_image`|本次官方 Vision 文档未证实原生视频输入，默认不开放|官方现在有图片模型，旧“全 DeepSeek 文本-only”推断过时。按模型目录/型号规则限制。官方最新页面仍可能与旧型号列表更新不同步，型号别名须实际验证|
|Qwen / 百炼|兼容 Chat `image_url`，data URL/公网 URL|`video_url` 与图像帧列表 `video` 为不同输入结构；可带 fps|VL 只看画面与 Omni 看画面+音频不等同；只有明确支持视频的具体型号显示入口；不要把 Omni 的音轨能力赋给 VL|
|Kimi 官方|`image_url`；data URL 或文件上传引用|先 Files `purpose=video`，再 `video_url.url="ms://<file-id>"`；官方视觉文档可直接指导|不同站点 Key 不共用；目录明确有图片/视频能力旗标，可用于精确门控；文件需与当前服务绑定|
|GLM|vision型号 Chat content parts|API整体支持视频，但具体型号、格式/限制必须读相应VLM文档|不能因为 GLM 文本API宣称多模态就为每个GLM型号开放；官方llms.txt索引给出精确对话API与VLM文档入口|
|TokenHub|按图片理解模型选择|平台有视频理解模型；不同型号有的含音频，有的仅画面|模型名单/能力以当前目录+官方专页，不能以旧 HunyuanVision 型号名推定|
|Ark / 豆包|Chat `image_url`，Responses `input_image`|Chat `video_url` part；Responses `input_video` part；Files 上传预处理后引用|推荐 Responses + Files 完整路径，详情见下一节；不要借用 OpenAI Responses 对视频的限制来关闭 Ark 视频扩展|

多模态证据：DeepSeek Vision[^50]、百炼 Chat 多模态结构[^51]、百炼视觉能力指南[^52]、Kimi 图片/视频指南[^53]、GLM 官方 API 索引[^54]、腾讯多模态指南入口[^55]。2026-09-14。

#### Ark 的可直接开发实现的文件/视频流程

1. 在 `https://ark.cn-beijing.volces.com/api/v3/files` multipart 上传，`purpose=user_data`，可指定 `preprocess_configs.video.fps`。
2. `GET /files/{id}` 轮询，只有 `status=active` 才可生成；`failed` 明确展示错误；超时/取消与重试不能留下无限loading。
3. Responses 发送 `input` 消息中 `content:[{type:"input_video",file_id:...},{type:"input_text",text:...}]`，`stream:true`。URL/inline 路径是 `{type:"input_video",video_url:<string>,fps:...}`。
4. Chat 路径是 `{type:"video_url",video_url:{url:<string>,fps:...,file_id:...}}`；不要与 Responses 的扁平字段混用。URL与file_id到底哪些组合允许，以专属契约+最小实测为准，默认选择一种源。
5. 建立上传句柄缓存：`provider-instance + credential-revision + file-hash + preprocessing-config`。Key/地域变更、文件过期须重新上传；文件有过期时间与 DELETE，删除会影响历史复用，必须与本地文件生命周期一致。

官方 SDK 的视频实例为 `doubao-seed-2-1-pro-260628`，与前述本地配置中的型号一致。其示例证明 API Key + Responses + Files 无需 App ID；但无推理凭据的源码查证不能证明用户账号下全部其他型号也可用。官方SDK生成 TypedDict 将 `input_video.video_url` 标为 Required，官方示例却只传 file_id；**这是文档/类型内部差异**，序列化应按实际允许的输入源 union 设计，并通过这两个实际路径分别测试，不盲目照抄类型。

源码：视频上传后对话示例[^56]、Files 资源实现[^57]、Responses 视频参数[^58]、Chat 视频参数[^59]、官方预设域名[^60]。2026-09-14 读取原始源码核证。SDK只供合同参考，chataxi不用引入其运行依赖。

## 4. 本地 LLM 推理运行时

| 引擎 | 默认开发地址（手机应填电脑局域网IP） | 目录/补充信息 | 推理协议 |
| --- | --- | --- | --- |
| Ollama | `http://<LAN-IP>:11434` | GET `/api/tags` → POST `/api/show` | 原生 POST `/api/chat` NDJSON；亦有 `/v1/chat/completions` |
| LM Studio | `http://<LAN-IP>:1234` | `/api/v1/models` 丰富；`/v1/models`兼容 | `/v1/chat/completions` SSE；现也有 Responses/Messages |
| vLLM | `http://<LAN-IP>:8000` | `/v1/models`、`/version`，部署能力规则 | `/v1/chat/completions` SSE，版本允许时Responses |
| SGLang | `http://<LAN-IP>:30000` | `/v1/models`按安装版探测；`/get_model_info` | `/v1/chat/completions` SSE |

`localhost`在手机上是手机，不是用户电脑。选择本地服务后URL应直接显示为必填；Key可选，原生无认证时不发送虚构 `Bearer EMPTY`。远程开启认证的引擎/反代使用其自己的Key。应用只消费已有推理服务，不默认下载权重、加载新模型或执行服务器管理操作。

### Ollama

原生本地API无需认证；云Ollama、私有模型访问另有账号行为。GET tags包含model/name/digest/size/details；POST show包含capabilities、model_info、parameters（文本，不是JSON Schema）、template。用capabilities识别vision/thinking/tools，不能从qwen/deepseek名称猜能力。模型固有context_length与实际num_ctx不同。认证[^61]、Tags[^62]、Show[^63]

优先原生 `/api/chat`：messages内images为base64，stream默认true，返回逐行JSON、message.content、独立thinking、done与最终usage；options中映射temperature/top_p/top_k/num_predict/num_ctx，think是模型支持的boolean或分档。不要用SSE parser解析NDJSON。OpenAI兼容路径不能按标准参数改变上下文大小，原生路径更适合明确设置num_ctx。Chat[^64]、兼容限制[^65]

### LM Studio

新 `/api/v1/models` 返回models[]，有type/publisher/key/display_name/quantization/loaded_instances.config.context_length/max_context_length/capabilities.vision/trained_for_tool_use/reasoning.allowed_options+default。这是值得专门适配的真实元数据，不能只GET `/v1/models`丢掉。兼容目录在JIT加载开启时可能含未载入模型，列出不意味着冷启动延迟为零。原生目录[^66]、兼容目录[^67]

当前原生API v1是0.4.0后能力，旧安装先保留兼容入口并提示元数据有限；可配置token，默认是否认证以实际安装为准。新原生chat缺少“请求中包含assistant消息”的能力，chataxi要自己重组概要/群聊历史，所以优先兼容Chat/Responses推理，用原生目录增强发现。端点能力对照[^68]

### vLLM

以 `/v1/models` 发现部署提供的模型；本轮未核验到跨版本稳定的完整模型参数发现schema，因此本地引擎版本、模型配置/自定义规则和最小试调用共同决定能力。支持OpenAI Chat/Responses但需chat template；temperature/top_k等可来自服务端generation_config.json，未修改的参数应省略。原生HTTP的扩展参数直接放JSON顶层，`extra_body`只是SDK约定，不能原样发成嵌套对象。目录/版本[^69]、OpenAI兼容参数[^70]

支持相应VLM时图像为image_url，视频为video_url；视频decoder与模型架构须已在服务端配置，不能默认所有Qwen都接收视频。具体帧率/帧数/像素限制取部署级规则；vLLM支持视频不等同Qwen文本模型支持视频。多模态[^71]

### SGLang

GET `/get_model_info`可补充is_generation、has_image_understanding、has_audio_understanding、model_type、architectures、preferred_sampling_params等；该值不等于完整schema；`/server_info`有部署限制但可能敏感/受限，不应强依赖。原生元数据[^72]

Chat Completions支持SSE，图像多张可使用image_url且取决于模型。sampling defaults可能来自generation_config.json；Qwen启用思考之类应是确定引擎/模板规则而非全局enable_thinking乱发。本次未核验当前SGLang统一原生video_url合同，将视频列为“部署验证后启用”，不冒充已经完整支持。Chat[^73]、Vision[^74]、采样规则[^75]

## 5. TTS 服务与本地声音模型

| 服务预设 | 最少真实输入 | 模型/音色发现 | 音频输出流 | 增量文字输入 |
|---|---|---|---|---|
| OpenAI Speech | API Key | `/v1/models` 补充可见模型；内置音色来自官方目录，不假造通用 voices API | HTTP bytes；新 TTS 也支持 SSE | Speech Endpoint 无同会话增量输入；分段请求可实现提前朗读 |
| ElevenLabs | API Key | `/v1/models` + 分页 `/v2/voices` | HTTP bytes/带时间戳 JSON | 非 v3 TTS WS；v3 TTD WS |
| 火山豆包语音 | 新语音控制台 API Key | 系统模型/资源/音色主要靠版本目录；账户专属音色能力另外核实 | V3 HTTP SSE/Chunked、WS | V3 bidirection |
| xAI TTS | API Key | `/v1/tts/voices`；自定义音色另端点 | HTTP bytes | `/v1/tts` WS |
| 阿里百炼 Qwen/CosyVoice | API Key + 区域预设 | 官方系统目录 + 专属音色查询 | HTTP SSE/专用 WS | Qwen Realtime；CosyVoice 专用协议 |
| MiniMax 官方 | API Key + 国内/国际预设 | `/v1/get_voice`；模型版本目录 | HTTP SSE hex 音频 | T2A WS |
| Azure Speech/MAI | Speech Key + 区域或 Endpoint | 资源 Endpoint 的 voices/list 提供音色元数据 | REST/SDK 音频流 | Speech V2 WS/SDK 能力另确认 |
| AWS Polly | 区域 + IAM凭据/临时凭据 | DescribeVoices，音色包含 SupportedEngines | SynthesizeSpeech | generative 的 HTTP/2 EventStream |
| Gemini TTS | Gemini API Key | 模型列表 + 官方音色目录 | 3.1起支持 | 当前普通TTS完整输入，不能把 Live 当精确朗读器替换 |
| 本地 TTS | LAN Base URL，按部署可选 Key | 以真实部署接口/显式能力清单为准 | 看运行时 | 看运行时 |
| Android 系统朗读 | 无 | 系统实际安装引擎/音色 | 系统播放器托管 | 不暴露为云端字节流 |

上表概括接入条件，开发批次以配套方案为准。国内用户网络直达能力还取决于设备网络，不能把海外模型不可达统一报“Key 错误”。

### OpenAI Speech
官方主路径为 `POST https://api.openai.com/v1/audio/speech`，Bearer Key。关键字段 `model`、`input`、`voice`，可选 `instructions`、`response_format`、`speed`、`stream_format`。当前指南仍以 `gpt-4o-mini-tts` 为主要模型，兼容 `tts-1`、`tts-1-hd`。`instructions` 是发声风格指令，不是给任意模型创建永久新音色；旧 tts-1 系列不支持该能力。`stream_format` 可选 audio/SSE，而 tts-1/tts-1-hd 不支持 SSE。[^88][^89]

当前官方内置音色共 13 个：alloy、ash、ballad、coral、echo、fable、nova、onyx、sage、shimmer、verse、marin、cedar；旧模型仅支持其中子集，必须按模型过滤。内置音色应保存为版本化目录；`GET /v1/models` 不是音色/参数完整 schema 接口。自定义音色是额外资格能力，不应对每个账号默认显示可用。[^88]

音频格式可选 MP3、Opus、AAC、FLAC、WAV、PCM。HTTP body 可以在完整音频结束前消费。`stream_format` 表达输出事件封装，不表示可以追加 `input` 文本；对 LLM 段落提前朗读，可将已经定稿的段落序列化为独立 Speech 请求，但必须称为“分段提交”，不能声称是服务端同会话双向流。[^88][^89]

推荐连接：读取可见模型并结合官方目录 → 明确显示目录/权限状态 → 用户发起一次短试听验证具体 model+voice → 保存。目录权限不足不能自动推断合成权限不存在，也不能仅凭静态目录标记“合成验证成功”。

### ElevenLabs：目录、模型、音色兼容必须拆开

基础认证使用 `xi-api-key`，目录 `GET https://api.elevenlabs.io/v1/models`。应读取 `can_do_text_to_speech`、`can_use_style`、`can_use_speaker_boost`、`serves_pro_voices`、长度限制、语言和并发类别；字段缺失表示未知，不表示默认支持。音色用 `GET /v2/voices`，处理 `has_more` 与 `next_page_token`，不要只读首屏。音色保存 `voice_id`、显示名、类别、权限、`high_quality_base_model_ids`、`verified_languages`、finetuning等原始必要证据。[^90][^91]

`high_quality_base_model_ids` 说明高质量基础模型，`verified_languages[].model_id` 说明某种语言验证证据；它们都不是官方定义的“唯一允许模型白名单”。音色 Jane/Jessica/Lulu 等名字也不是稳定身份，必须以 voice_id 为主键，显示名只展示。音色属于 Professional 类别，也不足以单独推导“v3 一定拒绝”或“v3 一定与 v2 同质量”。

#### v3 与 PVC：保留不确定性，但不要继续发错参数

现行官方页面存在口径差异：帮助中心仍写 v3 不支持 Professional Voice Clones；v3 发布页说 PVC 尚未充分优化、质量可能低于旧模型；Voice Library 指南又允许用包括 v3 在内的模型生成声音预览。这些证据不足以推导“所有 PVC 都不能调用 v3”，也不能合成“每个 PVC 在 v3 都有同质量原生支持”。[^92][^93][^94]

更明确的是，官方 changelog 在 2025-03-17 已将 `use_pvc_as_ivc` 标为 deprecated；当前 Speech schema 没有它。**chataxi 不应自行发送该字段，不应靠一个客户端虚构的兼容标志解释服务器内部回退。** 若官方服务内部决定降级，那是服务器的行为；客户端只应记录返回事实。[^95][^96]

建议兼容状态采用 `confirmed / unsupported / unverified`，并另设 `qualityNotice`。明确模型能力排除的组合可禁用；仅缺某项 metadata 不应直接禁用。无法证实的 v3+PVC 组合可选但标“需试听确认”，只在用户试听时做一次实际合成，把 modelId+voiceId+endpointVersion+credentialIdentity 的结果缓存。400 只影响该组合，401/403按认证或权限分类；不能因 Jane 失败删除 Jessica，更不能自动换另一个声音冒充成功。

#### 两套 WebSocket 与 HTTP

- HTTP：`POST /v1/text-to-speech/{voice_id}/stream`，完整 text 输入，二进制流输出；JSON 正文使用 text、model_id、voice_settings，output_format 放在 URL 查询参数。模型能力支持才传 style/speaker_boost等，已废弃的 latency参数不作为默认设置。[^95]
- 非 v3 增量文字：`wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input`，单个 voice 固定于URL，首消息初始化，后续text/flush；可调chunk schedule。[^97]
- v3 增量文字：`wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input`，首消息注册 voices，后续 `inputs:[{text,voice_id,new_turn?}]`，flush/close_socket/keep_alive；v3_conversational只允许1声，普通eleven_v3最多10声。默认缓冲和并发计法不同，不共用旧协议编码器。[^97][^98]

群聊仍建议每条 AI 消息固定一个实际角色音色，即便厂商提供多声对话接口，也不能让TTS自行推断正文中的姓名而切换角色。已有可用v3专用TTD实现应保留并纳入统一适配，不应因旧资料说“v3无WebSocket”而删掉。

### 火山豆包语音：新 Key 方案正确，但资源和音色不能混配

ByteDance 官方样例明确使用：`POST https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse`，`X-Api-Key`，`X-Api-Resource-Id: seed-tts-2.0`，独立UUID请求ID，speaker示例 `zh_female_vv_uranus_bigtts`。没有要求AppID。对于新控制台的这一路径，强制要求AppID是不正确的。旧AppID+AccessKey方案应作为已有用户的显式兼容模式保留，不能与新API Key同时混发。[^99]

核心数据结构需要独立保存：`credentialScheme`、`resourceId`（产品/计费资源）、`modelVariant`（仅当该接口实际支持）、`speakerId`、`protocolVersion`、`audioFormat`、`sampleRate`。即便界面将资源对应的“豆包语音合成2.0”放在模型选择层，也不能在代码里把resourceId、任意model字符串、voice所属模型族三个概念混在一起。尤其不能让所有内置音色共享所有seed资源。

证据充分的最低初始配置可以只提供 `seed-tts-2.0 + zh_female_vv_uranus_bigtts` 作为默认组合，其余1.0、2.0、复刻、并发产品按照官方音色表建立明确映射，逐步补全。不能仅凭 `_mars`、`_uranus`、`_saturn` 后缀生成永远正确的规则；后缀最多作为未核实提示。旧版接口官方页明确说明不支持2.0的部分音色，应使用v3。[^100][^99]

#### 传输与参数待核点

前述本地配置的非敏感结构是：新语音API Key存在，`wss://openspeech.bytedance.com/api/v3/tts/bidirection`，`resourceId=seed-tts-2.0`，`sampleRate=24000`，请求超时60秒，没有AppID。这支持保留新Key路径，但不是所有声线/参数的独立验收证据。

官方ByteDance SSE样例将 `sample_rate` 放在 `req_params` 一级，同时 `audio_params` 包含format/speech_rate/loudness_rate/bit_rate。因此现有chataxi同结构不能仅凭常见SDK把采样率放进audio_params的习惯就判为错误。V3不同传输的正式文档当前打开遇到JS/页面安全限制，**采样率字段的位置是否跨传输一致、是否被忽略，需要实施时取完整官方schema与一次指定24000/另一采样率的音频元数据测试交叉确认**。应记录请求字段与实际响应采样率，避免请求成功但PCM按错误采样率播放。[^99][^101][^102][^103][^104][^105]

V3 HTTP SSE便于稳定接入；bidirection才是同会话持续文字输入。官方新 `/api/v3/tts/create` 音频生成页面在此次无法读取正文，不据第三方文章直接替换已工作的SSE/WS。也未找到已读取的官方“单个新Key一请求返回所有系统模型、所有系统音色和全参数”的通用目录API；因此应如实使用“官方内置目录+可用组合验证”，不要在UI说已经从服务器拉取了所有模型。

### xAI / Grok TTS

官方支持 `POST https://api.x.ai/v1/tts`，Bearer Key。核心输入是 `text`、`voice_id`、`language`，不是OpenAI的 `model/input/voice`；语言必需，可用auto。提供输出格式对象、speed等参数。`GET /v1/tts/voices` 返回系统声音；`GET /v1/custom-voices` 返回账户自定义声音，后者不在系统音色清单中。自定义声音创建本身存在地区/企业资格限制，但普通TTS不能因此被整体隐藏。[^106][^107]

同路径 `wss://api.x.ai/v1/tts` 用query设voice/language/format，Bearer在握手header。客户端发送text.delta/text.done，接收audio.delta/base64与audio.done。可在一条连接上做多个utterance，并有clear机制。直接的浏览器WebSocket不能随意设置Authorization header；Hermit需新增受控 Native WebSocket 公共合同，或采用另一个确有官方支持的认证方式，不应把长期Key拼入URL。[^107]

没有必要给这个TTS预设伪造一个“grok-4”模型下拉。若官方TTS没有暴露可选model字段，角色页面只选择服务和音色，隐藏模型二级项。聊天LLM和TTS可引用同一个用户提供的Key，但认证、目录、可用性分别验证。

### Microsoft Azure Speech 与 MAI-Voice

Azure Speech最低配置是资源Key加区域，或用户复制资源Endpoint。推荐 `Ocp-Apim-Subscription-Key`；它不是OpenAI Bearer。区域不应默默设为eastus后向用户保证任意Key可用。仅包含区域名的 Endpoint 才能解析区域；资源名称域名不一定包含区域信息，不能从资源名或 Key 猜测。常规合成是 `POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`，SSML body，`X-Microsoft-OutputFormat`选择真实音频格式。当前官方音色目录为 `https://{YourResourceName}.cognitiveservices.azure.com/tts/cognitiveservices/voices/list`，不要把资源域名路径与传统区域域名路径混拼；该目录返回ShortName/Locale/StyleList等数据。[^108]

MAI-Voice-2与2-Flash当前为public preview，采用相同Azure Speech REST与SSML；例子中的声音ID带 `:MAI-Voice-2` 或 `:MAI-Voice-2-Flash`。这意味着可复用azure-speech适配器，在具体声音/模型能力层过滤区域和preview状态。不能依赖2025年的MAI-Voice-1发布新闻得出“没有API”，也不能把preview包装为所有区域GA。已有许可的voice prompting/instant clone另有gated准入，不默认开放。[^109]

Azure有V2 WebSocket输入文本流功能，官方低延时指南明确列C#/C++/Python SDK支持，且文本流不支持SSML，Azure内的OpenAI TTS声音也不支持这一路径。不能仅因MAI属于Azure就自动宣称MAI所有声音支持同样的原始WS文字协议；实施时须逐model/voice确认。建议第一步稳定REST音频流，第二步再增加有文档合同和宿主运行时支撑的文本输入流。[^110]

不把非官方edge-tts/浏览器朗读逆向接口当“微软官方API Key服务”，它们不提供本项目所需的稳定公开合同。

### Amazon Polly

Polly采用区域端点与IAM SigV4认证；需要Access Key ID/Secret Access Key，临时凭据还要Session Token，或者通过受控服务端凭据代理。不能将AWS SecretAccessKey单独填进普通Bearer输入框后声称可直连。[^111]

`DescribeVoices`支持按引擎/语言查询与分页，声音返回 `SupportedEngines`；engine可见不等于每个voice支持。应映射为“模型/引擎→音色”，只展示真实SupportedEngines交集，并按区域缓存。[^112]

`SynthesizeSpeech`完整文本请求，输出body会在首字节可用后开始流式传回，支持standard/neural/long-form/generative。新增 `StartSpeechSynthesisStream` 是HTTP/2双向EventStream，`POST /v1/synthesisStream`，发送TextEvent与CloseStreamEvent，接收AudioEvent/StreamClosedEvent，当前仅generative。它不是SSE，也不是JSON WebSocket，不能让现有fetch JSON循环直接处理。建议将普通Polly音频流列第二批；HTTP/2增量文字先做宿主/代理可行性验证。[^113][^114]

### 阿里百炼 Qwen-TTS / CosyVoice

同一个“阿里百炼朗读”服务预设可以包含多个声学模型族，但协议标识必须独立。区域先选择北京/新加坡等已验证入口；不同区域Key不同。官方现行文档推荐业务空间专属域名，旧dashscope域名仍可用。因此默认key-only可继续使用区域公共域名，更多设置允许Workspace Endpoint；不能强迫用户为了理论统一先填写未知Workspace ID。[^115][^116]

Qwen非实时：`POST /api/v1/services/aigc/multimodal-generation/generation`，Bearer Key，model+input.text/voice/language_type；开 `X-DashScope-SSE: enable` 得音频增量。即便指南叫“非实时”，也可能支持音频流输出：它指输入方式，不能据标题禁用流式播放。[^115][^117]

Qwen Realtime：`wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=...`（国际使用对应intl主机），session.update配置，input_text_buffer.append/commit推进文字，audio delta持续返回。应区分 `qwen3-tts-flash-realtime`、instruct、VC、VD等模型：普通系统音色、声音复刻、声音设计各有目标模型，不可交叉使用。只有instruct模型显示发声指令。[^118]

专属音色可通过 `/api/v1/services/audio/tts/customization` 查询：Qwen用model=qwen-voice-enrollment、action=list；CosyVoice用model=voice-enrollment、action=list_voice。Qwen记录中有target_model，必须与合成模型一致。系统音色仍从官方音色目录维护；这个专属音色查询并不自动返回所有系统音色。不要以“可以list专属音色”为由假设整个TTS模型目录可同一次发现。[^116]

CosyVoice云服务与Qwen的Realtime事件协议不同，即使云服务商、Key、音色显示界面相同，也需要独立encoder/decoder。云端cosyvoice版本与本地Fun-CosyVoice权重版本也不能建立字符串等价。实际部署时从官方版本目录选定并锁定首批测试模型，避免全量猜测支持所有采样率、SSML、情绪、提示词。

### MiniMax

官方国际基础 `https://api.minimax.io`，国内官方入口单独预设并用对应站点Key验证。HTTP为 `POST /v1/t2a_v2`，Bearer Key，模型如当前文档speech-2.8-hd/turbo、2.6、02等；正文text、voice_setting、audio_setting、stream。模型目录不能永远写死为旧speech-02，也不能因为列到模型就表示账号已有额度。[^119]

音色发现 `POST /v1/get_voice`，`{"voice_type":"all"}`，得到system_voice/voice_cloning/voice_generation等。模型参数来自官方版本化目录，音色可动态发现。HTTP stream返回hex编码音频，业务错误还可能在base_resp中；仅看HTTP200会漏判失败。[^119][^120]

双向文字使用 `wss://api.minimax.io/ws/v1/t2a_v2`，认证header，task_start→task_started→连续task_continue→task_finish；不能套用Eleven text字段。输出格式和音效特性需要组合验证，例如voice_modify的流式输出限定MP3，非流式可有WAV/FLAC。建议默认MP3，更多参数按模型schema显隐。[^119][^121]

### Gemini TTS 与本地 TTS 的范围

Gemini API当前TTS指南使用 `POST https://generativelanguage.googleapis.com/v1beta/interactions`，x-goog-api-key；示例 `gemini-3.1-flash-tts-preview`，input、response_format.type=audio、generation_config.speech_config。3.1起支持stream=true音频流；应锁定Api-Revision并实现实际content事件解析，不能将旧generateContent或LLM文字流decoder直接重用。声音目录如Kore等由官方模型指南给出。这里的流是输出，不等于给现有一次生成持续append正文。TTS带可表达发声方式的自然语言内容，需保持朗读文本边界，不让系统把它变成另一个替角色回答的LLM。[^122]

#### 本地模型候选

| 候选 | 已核实情况 | chataxi接入建议 |
|---|---|---|
| Qwen3-TTS | 官方0.6B/1.7B；CustomVoice、Base克隆、VoiceDesign变体；9个内置声线；模型支持流式；官方Python get_supported_speakers/languages | 优先本地候选；实际API server有流式才启用；0.6B不显示1.7B才支持的instruct能力 |
| CosyVoice | 官方项目现跳转QwenAudio/CosyVoice，提供推理/部署，模型跨版本 | 优先中文，固定部署版本；使用公开真实服务器协议，兼容网关可统一成OpenAI Speech但能力由网关声明 |
| Kokoro-82M | 作者HF权重为82M、Apache-2.0；轻量多语言、固定voices资产 | 轻量候选；不默认暴露任意克隆/voice-design，服务端可提供专用voices清单 |
| Fish Speech/S2 | 官方有服务器模式，HTTP/WS云接口与本地服务器需区别；当前仓库Research License，对商业使用需单独许可 | 支持用户已有运行实例，不把全部模型归为无条件Apache开源；按服务器合约实现专门适配 |

本地模型不是“手机里自动跑模型”。chataxi在手机中配置的是局域网或自托管推理服务地址；`localhost`是手机自身，不是用户电脑。任何桌面服务须监听可访问地址且端口可达。不要为了表面key-only隐藏地址输入，也不应默认向整段局域网扫描。[^123][^124][^125][^126][^127][^128]

推荐支持两种本地接入：一是明确版本的OpenAI Speech兼容服务器，二是专门的本地TTS适配。可以为自有网关设计可选capabilities/voices发现合同，但必须标成chataxi约定，不能说它是所有开源项目官方标准。Ollama的LLM兼容不能被外推成Ollama可以原生托管所有这些TTS。

### 本地 TTS 运行时的具体接口

应优先为 **vLLM-Omni** 增加独立运行时预设，不能把 Qwen3-TTS 的权重名字当作 HTTP 服务协议。当前官方服务提供 `POST /v1/audio/speech`、`GET /v1/audio/voices` 和 `WS /v1/audio/speech/stream`。HTTP 音频流当前只支持 PCM/WAV，speed 固定为 1；这些限制应该直接约束界面。WS 用 `input.text/input.done/session.close`，默认收齐至 input.done 才合成；sentence/clause 模式才按边界推进，`stream_audio` 又是独立的音频输出开关。支持 WebSocket 不能自动推导默认会逐段合成。[^129][^130]

同一运行时下，Qwen3-TTS、Fish S2 Pro 和 CosyVoice3 也有不同语义。CosyVoice3 在此路径没有预置声音，需要参考音频和参考文本；不能凭 voices 列表为空就报服务损坏。Qwen3-TTS 官方项目自身主要给出 Python/Gradio，vLLM-Omni 则提供可接入的服务合同；若两份说明更新时间不同，应以所选运行时当前版本为准。[^129][^130]

Fish 自带服务器 `tools/api_server.py` 默认端口 8080，公开 `GET /v1/health`、`POST /v1/tts`，可由启动参数开启 Bearer Key；`reference_id` 指已保存的声音，模型由服务启动时加载，不应每个请求显示一个虚构的模型切换列表。云端 Fish 的 WebSocket 不能直接外推到这个本地 server。[^128]

CosyVoice 自带 FastAPI 示例默认端口 50000，使用 Form/multipart：`/inference_sft`、`/inference_zero_shot`、`/inference_cross_lingual`、`/inference_instruct`、`/inference_instruct2`，返回 int16 PCM。示例的 StreamingResponse 不能单独证明模型真正逐片推理：调用未启用 stream=True，而对应推理函数默认 stream=False。该示例未提供通用 voices-list、OpenAI Speech 或 WebSocket 路由，应锁定部署提交再实现专用适配。[^131][^132]

## 6. 其余值得纳入的官方与聚合服务

### Mistral

建议作为第二批独立官方适配，Bearer Key，`https://api.mistral.ai/v1`。`GET /models` 返回 `capabilities.completion_chat/vision/function_calling` 等以及 `max_context_length`、aliases；只将可对话模型放入角色列表，模型文件存在或可训练不等于可聊天。`POST /chat/completions` 的通用结构可以复用 Chat 编码器，精确模型的采样、推理和多模态限制仍由自身规则决定。Mistral Models[^76]、Mistral Chat[^77]

### 硅基流动 SiliconFlow

国内聚合入口建议优先选它作为 OpenRouter 之外的补充。`https://api.siliconflow.cn/v1`，Bearer Key；`GET /models?sub_type=chat` 可直接筛选聊天模型，响应为 `data[]`，基础字段是 ID/owner 等；不要据目录中 `type=video` 就推断聊天视频理解，那也可能是视频生成。图像模型输入按平台自己的多模态文档适配。SiliconFlow Models[^78]、SiliconFlow 多模态[^79]

TTS 用 `/audio/speech`，字段 `model/input/voice/response_format/stream`，有自己的 speed/gain/sample_rate；音色 ID 可以包含模型命名空间。`GET /audio/voice/list` 返回用户自定义音色，不能当成所有系统声音清单。CosyVoice 的指令内嵌方式与 OpenAI instructions 不相同；MOSS 的双人脚本与单角色朗读也不同，默认不让它根据群聊全文自行扮演多个人。文档对采样率的描述与默认示例存在不一致，不能把它们写成无条件默认值。Speech schema[^80]、用户音色列表[^81]、TTS 指南[^82]

### Together AI

可放扩展批次：`https://api.together.ai/v1`，Bearer Key；`GET /models` 是顶层数组，含 type、context_length、pricing 等；Chat 用 `/chat/completions`。服务托管多个作者的模型，不是原厂账号，模型 ID 保留命名空间。官方兼容文档说明某些参数会被接受但忽略，如 store/service_tier；因此“HTTP 200”不能证明用户设置生效。先实现文本/图片和目录适配，TTS 与特定部署后续逐项验收。Together Models[^83]、Together OpenAI compatibility[^84]

### Fireworks AI

推理基址为 `https://api.fireworks.ai/inference/v1`，Bearer Key，Chat Completions。当前已读取的完整模型目录是管理路径 `GET https://api.fireworks.ai/v1/accounts/{account_id}/models`，带 nextPageToken；不要凭惯例把它改成推理目录 `/inference/v1/models` 并保证存在。需要区分全量模型资产、serverless 可用模型和已部署实例；模型资源名为 `accounts/.../models/...`。目录/部署映射复杂度高于首批通用入口，建议后续完善；没有实际可推理部署时不展示“全部可用”。Fireworks 兼容接口[^85]、Fireworks List Models[^86]、模型与部署概念[^87]

## 7. 开发时使用的协议检查表

| 类别 | 应保存/编译的信息 | 不可采用的捷径 |
| --- | --- | --- |
| 鉴权 | 供应商、站点、地区、工作空间、精确 Header、凭据版本 | 将一把 Key 试发到所有地区，或跟随跨域跳转携带密钥 |
| 模型目录 | 分页方式、原始 ID、模态、参数证据、生命周期、快照来源 | 写死 data[]；目录失败就清空模型；名字含 vision 就开放视频 |
| LLM 请求 | 选定协议、当前模型参数、顶层 system/instructions、媒体内容块 | 全部发送 temperature/max_tokens/reasoning_effort；把 SDK extra_body 当线上嵌套字段 |
| 思考 | 开关/档位/预算、签名与私有 state、delta/snapshot、最终文本分流 | 将 reasoning 当正文朗读；把不同供应商的私有块拼进别家上下文 |
| 媒体 | 本地引用、上传 ID、处理状态、过期、区域、预处理参数 | 直接给云服务 file:// 或 blob:；视频整体 Base64 穿过小型 Bridge JSON |
| TTS 输入 | 完整文字或增量文字、段落提交序号、模型/音色/资源绑定 | 将拆段多次 HTTP 调用描述为同会话文字双向流 |
| TTS 输出 | 封装、codec、container、采样率、声道、正常终止与错误 | 所有流当 24 kHz PCM；每块 MP3 当独立文件播放 |
| 可用性 | 精确模型/音色/参数/账号的验证记录 | 一次试听证明全部模型、全部音色可用 |
| 错误与重试 | 业务错误码、Retry-After、requestId、请求是否已接受 | 401统一解释成目录权限；部分成功后无提示重发整段 |

### 必须保留的未决事项

GLM 的通用目录与 Ark 的运行时模型目录没有获得足以承诺通用可用的正式合同；火山语音正式文档有正文访问限制，双向帧细节、各资源音色映射及采样率需补核；Eleven v3 与 PVC 的官方口径冲突必须落实为精确组合验证。MAI 的区域和预览准入、Polly 的 HTTP/2 签名与实际播放器、各本地 TTS 部署的服务合同，也都需要进入各自实施验收，不能在本轮标记为完成。

新增服务前先采集脱敏目录/事件夹具，再验证一个明确模型的实际请求。完整开发阶段与验收清单见配套方案；不自动遍历所有模型发起计费探测。

## 8. 官方来源与查证记录

以下为文中编号对应的原始来源。访问日期均为 2026-09-14；未明确发布日期的动态文档不补造发布日期。标注“未获取完整正文”的火山入口仅用于补核，不能作为已确认参数的唯一依据。GitHub main 分支链接属于会变化的官方源码，实施时应记录所用提交版本。

[^1]: 认证与调试。发布者：`developers.openai.com`。[原始页面](https://developers.openai.com/api/reference/overview)。查证：2026-09-14。

[^2]: Models API。发布者：`developers.openai.com`。[原始页面](https://developers.openai.com/api/reference/resources/models/methods/list)。查证：2026-09-14。

[^3]: 推理与状态。发布者：`developers.openai.com`。[原始页面](https://developers.openai.com/api/docs/guides/reasoning)。查证：2026-09-14。

[^4]: 流式响应。发布者：`developers.openai.com`。[原始页面](https://developers.openai.com/api/docs/guides/streaming-responses)。查证：2026-09-14。

[^5]: 模型卡。发布者：`developers.openai.com`。[原始页面](https://developers.openai.com/api/docs/models/gpt-6-astra)。查证：2026-09-14。

[^6]: 图像与视觉。发布者：`developers.openai.com`。[原始页面](https://developers.openai.com/api/docs/guides/images-vision)。查证：2026-09-14。

[^7]: 模型目录。发布者：`ai.google.dev`。[原始页面](https://ai.google.dev/api/models)。查证：2026-09-14。

[^8]: 接口状态与迁移边界。发布者：`ai.google.dev`。[原始页面](https://ai.google.dev/gemini-api/docs/interactions-overview)。查证：2026-09-14。

[^9]: 入门与 SSE 合同。发布者：`ai.google.dev`。[原始页面](https://ai.google.dev/gemini-api/docs/get-started)。查证：2026-09-14。

[^10]: 推理与签名。发布者：`ai.google.dev`。[原始页面](https://ai.google.dev/gemini-api/docs/thinking)。查证：2026-09-14。

[^11]: 视频输入。发布者：`ai.google.dev`。[原始页面](https://ai.google.dev/gemini-api/docs/video-understanding)。查证：2026-09-14。

[^12]: Key。发布者：`ai.google.dev`。[原始页面](https://ai.google.dev/gemini-api/docs/api-key)。查证：2026-09-14。

[^13]: 地区。发布者：`ai.google.dev`。[原始页面](https://ai.google.dev/gemini-api/docs/available-regions)。查证：2026-09-14。

[^14]: Models。发布者：`platform.claude.com`。[原始页面](https://platform.claude.com/docs/en/api/models/list)。查证：2026-09-14。

[^15]: Messages 参数。发布者：`platform.claude.com`。[原始页面](https://platform.claude.com/docs/en/api/messages/create)。查证：2026-09-14。

[^16]: Messages streaming。发布者：`platform.claude.com`。[原始页面](https://platform.claude.com/docs/en/build-with-claude/streaming)。查证：2026-09-14。

[^17]: Vision。发布者：`platform.claude.com`。[原始页面](https://platform.claude.com/docs/en/build-with-claude/vision)。查证：2026-09-14。

[^18]: 模型目录合同。发布者：`docs.x.ai`。[原始页面](https://docs.x.ai/developers/rest-api-reference/inference/models)。查证：2026-09-14。

[^19]: 文本生成。发布者：`docs.x.ai`。[原始页面](https://docs.x.ai/developers/model-capabilities/text/generate-text)。查证：2026-09-14。

[^20]: 推理。发布者：`docs.x.ai`。[原始页面](https://docs.x.ai/developers/model-capabilities/text/reasoning)。查证：2026-09-14。

[^21]: 图像理解。发布者：`docs.x.ai`。[原始页面](https://docs.x.ai/developers/model-capabilities/images/understanding)。查证：2026-09-14。

[^22]: Imagine产品边界。发布者：`docs.x.ai`。[原始页面](https://docs.x.ai/developers/model-capabilities/imagine)。查证：2026-09-14。

[^23]: Quickstart。发布者：`openrouter.ai`。[原始页面](https://openrouter.ai/docs/quickstart)。查证：2026-09-14。

[^24]: Models。发布者：`openrouter.ai`。[原始页面](https://openrouter.ai/docs/guides/overview/models)。查证：2026-09-14。

[^25]: Endpoints。发布者：`openrouter.ai`。[原始页面](https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints)。查证：2026-09-14。

[^26]: 路由行为。发布者：`openrouter.ai`。[原始页面](https://openrouter.ai/docs/guides/routing/provider-selection)。查证：2026-09-14。

[^27]: Video。发布者：`openrouter.ai`。[原始页面](https://openrouter.ai/docs/guides/overview/multimodal/videos)。查证：2026-09-14。

[^28]: DeepSeek Models。发布者：`api-docs.deepseek.com`。[原始页面](https://api-docs.deepseek.com/api/list-models/)。查证：2026-09-14。

[^29]: DeepSeek Responses。发布者：`api-docs.deepseek.com`。[原始页面](https://api-docs.deepseek.com/guides/responses_api/)。查证：2026-09-14。

[^30]: 百炼目录。发布者：`help.aliyun.com`。[原始页面](https://help.aliyun.com/zh/model-studio/list-models)。查证：2026-09-14。

[^31]: 百炼地域与域名。发布者：`help.aliyun.com`。[原始页面](https://help.aliyun.com/zh/model-studio/regions/)。查证：2026-09-14。

[^32]: Kimi 中国目录。发布者：`platform.kimi.com`。[原始页面](https://platform.kimi.com/docs/api/list-models)。查证：2026-09-14。

[^33]: 智谱鉴权。发布者：`docs.bigmodel.cn`。[原始页面](https://docs.bigmodel.cn/cn/api/introduction)。查证：2026-09-14。

[^34]: 腾讯 TokenHub API。发布者：`cloud.tencent.com`。[原始页面](https://cloud.tencent.com/document/product/1823/130078)。查证：2026-09-14。

[^35]: 旧混元迁移公告所在页。发布者：`cloud.tencent.com`。[原始页面](https://cloud.tencent.com/document/product/1729/111008)。查证：2026-09-14。

[^36]: Ark 官方 SDK。发布者：`github.com`。[原始页面](https://github.com/volcengine/ark-runtime-python)。查证：2026-09-14。

[^37]: MiniMax 目录。发布者：`platform.minimax.cn`。[原始页面](https://platform.minimax.cn/docs/api-reference/models/openai/list-models)。查证：2026-09-14。

[^38]: 千帆目录。发布者：`cloud.baidu.com`。[原始页面](https://cloud.baidu.com/doc/qianfan-api/s/Dmba8k71y)。查证：2026-09-14。

[^39]: DeepSeek Chat API。发布者：`api-docs.deepseek.com`。[原始页面](https://api-docs.deepseek.com/api/create-chat-completion/)。查证：2026-09-14。

[^40]: DeepSeek Thinking。发布者：`api-docs.deepseek.com`。[原始页面](https://api-docs.deepseek.com/guides/thinking_mode/)。查证：2026-09-14。

[^41]: Qwen 深度思考。发布者：`help.aliyun.com`。[原始页面](https://help.aliyun.com/zh/model-studio/deep-thinking)。查证：2026-09-14。

[^42]: Kimi K2.6 约束表。发布者：`platform.kimi.ai`。[原始页面](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart)。查证：2026-09-14。

[^43]: 智谱核心参数。发布者：`docs.bigmodel.cn`。[原始页面](https://docs.bigmodel.cn/cn/guide/start/concept-param)。查证：2026-09-14。

[^44]: GLM5.2 型号文档。发布者：`docs.bigmodel.cn`。[原始页面](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2)。查证：2026-09-14。

[^45]: TokenHub 协议说明。发布者：`cloud.tencent.com`。[原始页面](https://cloud.tencent.com/document/product/1823/130079)。查证：2026-09-14。

[^46]: Ark Chat 参数源码。发布者：`github.com`。[原始页面](https://github.com/volcengine/ark-runtime-python/blob/main/src/arkruntime/types/chat/chat_completion_request_param.py)。查证：2026-09-14。

[^47]: Ark Responses 参数源码。发布者：`github.com`。[原始页面](https://github.com/volcengine/ark-runtime-python/blob/main/src/arkruntime/types/responses/responses_request_param.py)。查证：2026-09-14。

[^48]: 正式Chat OpenAPI文档。发布者：`docs.bigmodel.cn`。[原始页面](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8.md)。查证：2026-09-14。

[^49]: 官方OpenAI接入Markdown。发布者：`platform.minimax.cn`。[原始页面](https://platform.minimax.cn/docs/api-reference/text-openai-api.md)。查证：2026-09-14。

[^50]: DeepSeek Vision。发布者：`api-docs.deepseek.com`。[原始页面](https://api-docs.deepseek.com/guides/vision/)。查证：2026-09-14。

[^51]: 百炼 Chat 多模态结构。发布者：`help.aliyun.com`。[原始页面](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)。查证：2026-09-14。

[^52]: 百炼视觉能力指南。发布者：`help.aliyun.com`。[原始页面](https://help.aliyun.com/zh/model-studio/vision-model)。查证：2026-09-14。

[^53]: Kimi 图片/视频指南。发布者：`platform.kimi.com`。[原始页面](https://platform.kimi.com/docs/guide/use-kimi-vision-model)。查证：2026-09-14。

[^54]: GLM 官方 API 索引。发布者：`docs.bigmodel.cn`。[原始页面](https://docs.bigmodel.cn/llms.txt)。查证：2026-09-14。

[^55]: 腾讯多模态指南入口。发布者：`cloud.tencent.com`。[原始页面](https://cloud.tencent.com/document/product/1823/130988)。查证：2026-09-14。

[^56]: 视频上传后对话示例。发布者：`github.com`。[原始页面](https://github.com/volcengine/ark-runtime-python/blob/main/examples/volc/responses/async_video.py)。查证：2026-09-14。

[^57]: Files 资源实现。发布者：`github.com`。[原始页面](https://github.com/volcengine/ark-runtime-python/blob/main/src/arkruntime/resources/files/files.py)。查证：2026-09-14。

[^58]: Responses 视频参数。发布者：`github.com`。[原始页面](https://github.com/volcengine/ark-runtime-python/blob/main/src/arkruntime/types/responses/content_item_video_param.py)。查证：2026-09-14。

[^59]: Chat 视频参数。发布者：`github.com`。[原始页面](https://github.com/volcengine/ark-runtime-python/blob/main/src/arkruntime/types/chat/chat_completion_content_part_video_video_url_param.py)。查证：2026-09-14。

[^60]: 官方预设域名。发布者：`github.com`。[原始页面](https://github.com/volcengine/ark-runtime-python/blob/main/src/arkruntime/_constants.py)。查证：2026-09-14。

[^61]: 认证。发布者：`docs.ollama.com`。[原始页面](https://docs.ollama.com/api/authentication)。查证：2026-09-14。

[^62]: Tags。发布者：`docs.ollama.com`。[原始页面](https://docs.ollama.com/api/tags)。查证：2026-09-14。

[^63]: Show。发布者：`docs.ollama.com`。[原始页面](https://docs.ollama.com/api-reference/show-model-details)。查证：2026-09-14。

[^64]: Chat。发布者：`docs.ollama.com`。[原始页面](https://docs.ollama.com/api/chat)。查证：2026-09-14。

[^65]: 兼容限制。发布者：`docs.ollama.com`。[原始页面](https://docs.ollama.com/api/openai-compatibility)。查证：2026-09-14。

[^66]: 原生目录。发布者：`lmstudio.ai`。[原始页面](https://lmstudio.ai/docs/developer/rest/list)。查证：2026-09-14。

[^67]: 兼容目录。发布者：`lmstudio.ai`。[原始页面](https://lmstudio.ai/docs/developer/openai-compat/models)。查证：2026-09-14。

[^68]: 端点能力对照。发布者：`lmstudio.ai`。[原始页面](https://lmstudio.ai/docs/developer/rest)。查证：2026-09-14。

[^69]: 目录/版本。发布者：`docs.vllm.ai`。[原始页面](https://docs.vllm.ai/en/latest/serving/online_serving/)。查证：2026-09-14。

[^70]: OpenAI兼容参数。发布者：`docs.vllm.ai`。[原始页面](https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/)。查证：2026-09-14。

[^71]: 多模态。发布者：`docs.vllm.ai`。[原始页面](https://docs.vllm.ai/en/latest/features/multimodal_inputs/)。查证：2026-09-14。

[^72]: 原生元数据。发布者：`docs.sglang.io`。[原始页面](https://docs.sglang.io/docs/basic_usage/native_api)。查证：2026-09-14。

[^73]: Chat。发布者：`docs.sglang.io`。[原始页面](https://docs.sglang.io/docs/basic_usage/openai_api_completions)。查证：2026-09-14。

[^74]: Vision。发布者：`docs.sglang.io`。[原始页面](https://docs.sglang.io/docs/basic_usage/openai_api_vision)。查证：2026-09-14。

[^75]: 采样规则。发布者：`docs.sglang.io`。[原始页面](https://docs.sglang.io/docs/basic_usage/sampling_params)。查证：2026-09-14。

[^76]: Mistral Models。发布者：`docs.mistral.ai`。[原始页面](https://docs.mistral.ai/api/endpoint/models)。查证：2026-09-14。

[^77]: Mistral Chat。发布者：`docs.mistral.ai`。[原始页面](https://docs.mistral.ai/api/endpoint/chat)。查证：2026-09-14。

[^78]: SiliconFlow Models。发布者：`docs.siliconflow.cn`。[原始页面](https://docs.siliconflow.cn/docs/api/models-get)。查证：2026-09-14。

[^79]: SiliconFlow 多模态。发布者：`docs.siliconflow.cn`。[原始页面](https://docs.siliconflow.cn/docs/userguide/capabilities/multimodal-vision)。查证：2026-09-14。

[^80]: Speech schema。发布者：`docs.siliconflow.cn`。[原始页面](https://docs.siliconflow.cn/docs/api/audio-speech-post)。查证：2026-09-14。

[^81]: 用户音色列表。发布者：`docs.siliconflow.cn`。[原始页面](https://docs.siliconflow.cn/docs/api/audio-voice-list-get)。查证：2026-09-14。

[^82]: TTS 指南。发布者：`docs.siliconflow.cn`。[原始页面](https://docs.siliconflow.cn/docs/userguide/capabilities/text-to-speech)。查证：2026-09-14。

[^83]: Together Models。发布者：`docs.together.ai`。[原始页面](https://docs.together.ai/reference/models)。查证：2026-09-14。

[^84]: Together OpenAI compatibility。发布者：`docs.together.ai`。[原始页面](https://docs.together.ai/docs/inference/openai-compatibility)。查证：2026-09-14。

[^85]: Fireworks 兼容接口。发布者：`docs.fireworks.ai`。[原始页面](https://docs.fireworks.ai/tools-sdks/openai-compatibility)。查证：2026-09-14。

[^86]: Fireworks List Models。发布者：`docs.fireworks.ai`。[原始页面](https://docs.fireworks.ai/api-reference/list-models)。查证：2026-09-14。

[^87]: 模型与部署概念。发布者：`docs.fireworks.ai`。[原始页面](https://docs.fireworks.ai/models/overview)。查证：2026-09-14。

[^88]: OpenAI, Text to speech。发布者：`developers.openai.com`。[原始页面](https://developers.openai.com/api/docs/guides/text-to-speech)。查证：2026-09-14。

[^89]: OpenAI, Create speech schema。发布者：`developers.openai.com`。[原始页面](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)。查证：2026-09-14。

[^90]: ElevenLabs, List models。发布者：`elevenlabs.io`。[原始页面](https://elevenlabs.io/docs/api-reference/models/list)。查证：2026-09-14。

[^91]: ElevenLabs, List voices v2。发布者：`elevenlabs.io`。[原始页面](https://elevenlabs.io/docs/api-reference/voices/search)。查证：2026-09-14。

[^92]: ElevenLabs, What is Voice Design (仍称v3不支持PVC)。发布者：`elevenlabs.io`。[原始页面](https://elevenlabs.io/docs/help-center/product/voices/voice-design/what-is-voice-design)。查证：2026-09-14。

[^93]: ElevenLabs, v3发布页 (PVC质量未充分优化)。发布者：`elevenlabs.io`。[原始页面](https://elevenlabs.io/blog/eleven-v3)。查证：2026-09-14。

[^94]: ElevenLabs, Voice Library (允许包括v3的模型生成预览)。发布者：`elevenlabs.io`。[原始页面](https://elevenlabs.io/docs/eleven-creative/voices/voice-library)。查证：2026-09-14。

[^95]: ElevenLabs, Stream speech。发布者：`elevenlabs.io`。[原始页面](https://elevenlabs.io/docs/api-reference/text-to-speech/stream)。查证：2026-09-14。

[^96]: ElevenLabs, 2025-03-17 changelog (use_pvc_as_ivc弃用)。发布者：`elevenlabs.io`。[原始页面](https://elevenlabs.io/docs/changelog/2025/3/17)。查证：2026-09-14。

[^97]: ElevenLabs, TTS vs TTD WebSockets。发布者：`elevenlabs.io`。[原始页面](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets)。查证：2026-09-14。

[^98]: ElevenLabs, TTD WebSocket contract。发布者：`elevenlabs.io`。[原始页面](https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-websocket)。查证：2026-09-14。

[^99]: ByteDance官方agentkit-samples, V3新Key SSE样例。发布者：`github.com`。[原始页面](https://github.com/bytedance/agentkit-samples/blob/main/skills/byted-text-to-speech/scripts/text_to_speech.py)。查证：2026-09-14。

[^100]: 火山引擎, 旧协议说明 (可检索正文含2.0音色限制)。发布者：`www.volcengine.com`。[原始页面](https://www.volcengine.com/docs/6561/2228192?lang=zh)。查证：2026-09-14。

[^101]: 火山引擎正式页面 (此次JS/页面限制，未获取完整正文，需补核) 1。发布者：`www.volcengine.com`。[原始页面](https://www.volcengine.com/docs/6561/1598757)。查证：2026-09-14。

[^102]: 火山引擎正式页面 (此次JS/页面限制，未获取完整正文，需补核) 2。发布者：`www.volcengine.com`。[原始页面](https://www.volcengine.com/docs/6561/1329505)。查证：2026-09-14。

[^103]: 火山引擎正式页面 (此次JS/页面限制，未获取完整正文，需补核) 3。发布者：`www.volcengine.com`。[原始页面](https://www.volcengine.com/docs/6561/2532486)。查证：2026-09-14。

[^104]: 火山引擎正式页面 (此次JS/页面限制，未获取完整正文，需补核) 4。发布者：`www.volcengine.com`。[原始页面](https://www.volcengine.com/docs/6561/2550782)。查证：2026-09-14。

[^105]: 火山引擎正式页面 (此次JS/页面限制，未获取完整正文，需补核) 5。发布者：`www.volcengine.com`。[原始页面](https://www.volcengine.com/docs/6561/1257544)。查证：2026-09-14。

[^106]: xAI, Text to Speech guide。发布者：`docs.x.ai`。[原始页面](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech)。查证：2026-09-14。

[^107]: xAI, Voice REST and WS schema。发布者：`docs.x.ai`。[原始页面](https://docs.x.ai/developers/rest-api-reference/inference/voice)。查证：2026-09-14。

[^108]: Microsoft Learn, Text to speech REST。发布者：`learn.microsoft.com`。[原始页面](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech)。查证：2026-09-14。

[^109]: Microsoft Learn, What is MAI-Voice (preview)。发布者：`learn.microsoft.com`。[原始页面](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-voices)。查证：2026-09-14。

[^110]: Microsoft Learn, Lower synthesis latency/Input text streaming。发布者：`learn.microsoft.com`。[原始页面](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-lower-speech-synthesis-latency)。查证：2026-09-14。

[^111]: AWS IAM, Signature Version 4。发布者：`docs.aws.amazon.com`。[原始页面](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html)。查证：2026-09-14。

[^112]: AWS, DescribeVoices。发布者：`docs.aws.amazon.com`。[原始页面](https://docs.aws.amazon.com/polly/latest/APIReference/API_DescribeVoices.html)。查证：2026-09-14。

[^113]: AWS, StartSpeechSynthesisStream。发布者：`docs.aws.amazon.com`。[原始页面](https://docs.aws.amazon.com/polly/latest/APIReference/API_StartSpeechSynthesisStream.html)。查证：2026-09-14。

[^114]: AWS, SynthesizeSpeech and StartSpeechSynthesisStream compared。发布者：`docs.aws.amazon.com`。[原始页面](https://docs.aws.amazon.com/polly/latest/dg/bidirectional-streaming-choosing.html)。查证：2026-09-14。

[^115]: 阿里云百炼, 非实时语音合成。发布者：`help.aliyun.com`。[原始页面](https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide)。查证：2026-09-14。

[^116]: 阿里云百炼, 声音复刻HTTP API及音色查询。发布者：`help.aliyun.com`。[原始页面](https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api)。查证：2026-09-14。

[^117]: 阿里云百炼, Qwen-TTS API。发布者：`help.aliyun.com`。[原始页面](https://help.aliyun.com/zh/model-studio/qwen-tts-api)。查证：2026-09-14。

[^118]: 阿里云百炼, 实时语音合成。发布者：`help.aliyun.com`。[原始页面](https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide)。查证：2026-09-14。

[^119]: MiniMax, T2A HTTP。发布者：`platform.minimax.io`。[原始页面](https://platform.minimax.io/docs/api-reference/speech-t2a-http)。查证：2026-09-14。

[^120]: MiniMax, Get Voice。发布者：`platform.minimax.io`。[原始页面](https://platform.minimax.io/docs/api-reference/voice-management-get)。查证：2026-09-14。

[^121]: MiniMax, T2A WebSocket。发布者：`platform.minimax.io`。[原始页面](https://platform.minimax.io/docs/api-reference/speech-t2a-websocket)。查证：2026-09-14。

[^122]: Google AI, Text-to-speech generation。发布者：`ai.google.dev`。[原始页面](https://ai.google.dev/gemini-api/docs/speech-generation)。查证：2026-09-14。

[^123]: QwenLM官方, Qwen3-TTS。发布者：`github.com`。[原始页面](https://github.com/QwenLM/Qwen3-TTS)。查证：2026-09-14。

[^124]: CosyVoice官方。发布者：`github.com`。[原始页面](https://github.com/QwenAudio/CosyVoice)。查证：2026-09-14。

[^125]: Kokoro作者模型卡。发布者：`huggingface.co`。[原始页面](https://huggingface.co/hexgrad/Kokoro-82M)。查证：2026-09-14。

[^126]: Fish Speech官方与许可 1。发布者：`github.com`。[原始页面](https://github.com/fishaudio/fish-speech)。查证：2026-09-14。

[^127]: Fish Speech官方与许可 2。发布者：`github.com`。[原始页面](https://github.com/fishaudio/fish-speech/blob/main/LICENSE)。查证：2026-09-14。

[^128]: Fish Speech本地Server。发布者：`speech.fish.audio`。[原始页面](https://speech.fish.audio/server/)。查证：2026-09-14。


[^129]: vLLM，vLLM-Omni Speech API。[原始页面](https://docs.vllm.ai/projects/vllm-omni/en/latest/serving/speech_api/)。查证：2026-09-14。

[^130]: vLLM，Online serving text to speech。[原始页面](https://docs.vllm.ai/projects/vllm-omni/en/latest/user_guide/examples/online_serving/text_to_speech/)。查证：2026-09-14。

[^131]: QwenAudio，CosyVoice FastAPI 示例。[原始页面](https://github.com/QwenAudio/CosyVoice/blob/main/runtime/python/fastapi/server.py)。查证：2026-09-14。

[^132]: QwenAudio，CosyVoice 推理默认参数。[原始页面](https://github.com/QwenAudio/CosyVoice/blob/main/cosyvoice/cli/cosyvoice.py)。查证：2026-09-14。
