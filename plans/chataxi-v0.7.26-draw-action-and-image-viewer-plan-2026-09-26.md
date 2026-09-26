# chataxi 对话内调用生图模型（Action · draw）与图片全屏查看开发计划

日期：2026-09-26（第三版：按业主 5 条修订重写，并按追加要求把「角色头像 / 个人头像 / 对话头像必须一并走 `hermit.files` 并计入备份恢复验收」写成 §5.5 与 §9.2 验收项）
状态：**已实现，待真机验收**（P1–P6 落地，本地四套测试全绿；实施记录与偏差见 §12）；只涉及 `chataxi/`，不动 hermitapp / hermitweb / vibedraw，不构建 APK
上位依据：chataxi 0.7.25 现行源码（逐文件核对）、`hermitapp/sdk/hermit-api.d.ts`、`hermitapp/docs/webapp-authoring.md`、`hermitapp/docs/hermitapp-product-technical-design.md` §11、`vibedraw/plans/cvp-spec.md`、`vibedraw/comfyui-plugin/vibedraw_comfy/capabilities.py`、技能 `a1x-comfy-device`
实验模型：A1X 掌机 `http://192.168.124.31:8189` 的 CVP 能力 **`render`**（别名 `qwen`，family `qwen_image_21`）

---

## 0. 业主本轮的五条修订（本版的行为契约）

| # | 修订 | 落点 |
|---|---|---|
| R1 | 动作块插图时**不打断当前（下一个）数据流,也不打断 TTS 播放** | §3.1 三条硬不变量 + §7 P5 |
| R2 | 图片**必须走 `hermit.files`,必须进备份**（含现有头像）——"恢复备份时这些图片要都在" | §5 媒体层改造（新增 P2）+ §9 备份往返验收 |
| R3 | 图片消息**只以文字形式进上下文,真图不进**：`角色-发送了一个图片：（提示词），文件地址是：xxx。` | §6 上下文编解码 |
| R4 | **允许正文为空只有动作**——一条模型输出本就该拆成"文本消息 + 生图消息"两条,没正文就不生成第一条 | §7 P5 空正文路径 |
| R5 | **每轮最多 1 张参考图、只生成 1 张图**;参考图不由模型决定,模型只输出"是否画角色自己的照片",是则由 action 机制把定妆照当参考图 | §4 动作协议 + §8 参考图规则 |

---

## 1. 目标与边界

### 1.1 目标

对话模型在正文（可空）之后追加一个受约束的绘图动作块。chataxi 解析它、调配置好的生图模型、把结果**以发起绘图角色的身份**作为一条图片消息写回对话。配套：绘图模型配置（仅 CVP + 仅 `render`）、角色定妆照、气泡图片全屏手势查看、**媒体字节迁到宿主文件库以进入备份**。

### 1.2 硬边界

- 只改 `chataxi/`。宿主合同 / Bridge / manifest / 错误码都不动 ⇒ 不构建 APK。
- 绘图协议**只支持 CVP**（`cvp/1`），**只做 `render` 能力**；`quick` / `inpaint` / `upscale` 不做。
- 分辨率 / 步数 / 参考强度不接受用户配置，按插件 `defaults` 锁定（§8）。
- 不注册供应商原生 tool / function call（§3.2），不改 `providers.js` 的 6 种 `apiStyle`。
- **不新增任何宿主能力**：媒体入库用现成的 `files.beginWrite` / `appendBytes` / `finishWrite`；字节回读用同源 `<img>` + canvas（§5.4）。

---

## 2. 已核对的现状（本计划的锚点）

| 位置 | 事实 |
|---|---|
| `app/features/models.js:4` | 模型页只有 `{llm, tts, asr}` 三个 Tab，集合名固定 `kind + "-profiles"` |
| `app/services/catalog.js:66,213,343,390` | 三张 family 表 + `apiStyles`，末尾统一导出 |
| `app/services/model-services.js:5,117,133,247,626,691` | `families(kind)` 是三元表达式；`computedEndpoint` / `modelDefinition` / `authHeaders` / `discover` / `toSingleProfile` 全部按 kind 分派 |
| `app/features/model-single-editor.js` | 单卡片编辑器**通用**：kind 相关分支都判 `kind === "llm"` |
| `app/data/store.js:5,243,322,485,514` | 三处 profile 集合白名单；**已有 `removeMessage(message)`**；**`releaseMedia()` 已同时理解 `mediaId` 与 `logicalFileId`** 两种引用 |
| `app/services/profiles.js:32,63` | `remove` / `validateEnabled` 的 else 分支把非 llm/tts 当 asr ⇒ 新增 kind 必须显式分派 |
| `app/services/llm.js:226,255,297,300` | 流式累积原始 `text`，显示出口只有 `partialText()`；提示词注入点是 `appliedRole.systemPrompt`；返回前过 `removeRoleEcho()` |
| `app/features/chat-session.js:162-164,212,231` | 主循环：`pending` 先落库 → `llm.complete` → `outputImages` → `putMessage` → `changed(id,"updated")` |
| `app/services/context.js:169` / `chat-session.js:162` | 注入上下文 / 压缩范围都只取 `status === "done"` ⇒ 占位消息不进提示词 |
| `app/features/chat.js:14,127-165,218,247-289,340` | `rememberMessage` 按 id 替换；`delta` 走 DOM 增量、其余相位走 `renderMessages()`（带 `messageCache` 签名复用节点）；朗读按钮对 `assistant && status==='done'` 无条件渲染 |
| `app/features/chat.js:681-690,905` | **对话背景已经走宿主文件**：新记录存 `url` + `logicalFileId`，老记录 `mediaId` 走 `media.toDataUrl` 兜底 —— 本计划要照抄的迁移范式 |
| `app/features/chat.js:842` | 注释明写"旧版记录只有 `mediaId`，新版只有 `logicalFileId`；两种都要能释放" ⇒ 迁宿主文件是**本仓库既定方向** |
| `app/features/chat.js:33` | `mediaKey(media) = media.mediaId || media.logicalFileId` |
| `app/data/media.js` | **只有 IndexedDB**（`chataxi-media-v1`），`put/get/remove/toDataUrl` |
| `app/features/me.js:6,10-13,27-34` | **个人头像**：\`media.put(stagedBlob,{name:"user-avatar.jpg"})\` → \`profile.avatarMediaId\`；成功后 \`releaseMedia([旧 id])\`，失败 \`media.remove(created.id)\` 回滚 |
| `app/features/conversations.js:160,185-195,209,212` | **对话头像**：编辑弹窗里 \`media.put(…"conversation-user-avatar.jpg")\` → \`userAvatarMediaId\`；旧 id 交 \`releaseMedia\`；失败回滚 |
| `app/features/roles.js:138,183-190,192` | **角色头像**：默认 \`avatarMediaId:""\`；\`pickLocalImage → cropAvatar → media.put\`；删角色时 \`media.remove(avatarMediaId)\` |
| `app/features/settings.js:37,48-49` | 危险操作会清空角色 / 个人资料 ⇒ 一并清 \`avatarMediaId\`（新字段要挂进这两处） |
| `app/data/store.js:170,518-521` | \`releaseMedia()\` 登记表：roles 只登 \`avatarMediaId\`（:518）；conversations 登 \`userAvatarMediaId\` + \`background.*\`（:520）；user-profile 只登 \`avatarMediaId\`（:521）⇒ **新字段必须在这三处补登记** |
| `app/services/tts-cache.js:64-73,110-122` | **TTS 音频缓存**只在 \`clip.blob\` 时 \`media.put\`，\`clipOf\` 要求 \`stored.blob\`（Web Audio 混响只能吃内存里的 blob）⇒ **本计划明确不动它**（例外，见 §5.5） |
| `app/services/media-prep.js:182` | 发给模型的图片靠 `media.toDataUrl(mediaId)`（data URL）；视频靠 `logicalFileId` 走 multipart |
| `app/platform/network.js:52,129-135,204` | `request()` / `requestByteStream()` 都会 **`options.task.controller = controller`** ⇒ 传入主 task 会抢走 LLM 流的中断句柄 |
| `hermitapp/sdk/hermit-api.d.ts:46-59` | `files.import / pickImage / pickInline / writeText / beginWrite / appendBytes / finishWrite / abortWrite / readText / list / export / delete / share` |
| `hermitapp/docs/webapp-authoring.md:210-224` | 单次调用上限 **256 KiB**；大对象走 `beginWrite` → `appendBytes`（每块 ≤ 64 KiB Base64）→ `finishWrite` 原子提交；中途放弃用 `abortWrite`；**写句柄只属于创建它的页面会话** |
| `hermitapp/.../LocalContentGateway.kt:104` | 页面 CSP = `default-src 'self' data: blob:; connect-src 'none'; …` ⇒ 同源 `/__hermit/files/…` 的 `<img>` **可显示**，`fetch` 被禁 |
| `hermitapp/.../FileStore.kt:379` | `objectUrl(logicalFileId) = "/__hermit/files/<id>"` ⇒ URL 是 logicalFileId 的确定函数 |
| `hermitapp/docs/hermitapp-product-technical-design.md:415,530,536,538` | IndexedDB **明文写在备份边界之外**；备份包含"记录数据、附件"；**恢复保留实例域内 `logicalFileId`，使任意 JSON 中的附件引用仍成立** |
| `capabilities.py` | `render`：`needs {prompt:true, image:true, mask:false}`、`ignores ["negative_prompt"]`、`defaults {size [1024,1024], steps 20, ref_strength 0.95}`、`typical_seconds 45`、`prompt.language "any"` |
| `tools/check-i18n.mjs:43` | `PROMPT_FILES` 白名单免英文审计；其余文件新增中文界面文案必须补 `app/data/i18n-en.js` |

---

## 3. 三条硬不变量（R1 的可执行定义）

### 3.1 不变量

**I1 — 不打断对话数据流。** 绘图链路上的所有网络调用必须用**私有的影子 task**：

```js
var drawTask = { cancelled: false, controller: null, label: "正在绘制…" };
```

理由有据：`network.js:52` 与 `:129-135` 会 `options.task.controller = controller`。若把主 `task` 传进去，绘图请求会**覆写 LLM 流的中断句柄**，用户点"停止"时被 abort 的是绘图请求、而 LLM 流继续跑 —— 这正是"打断数据流"最隐蔽的一种。同理，绘图整体不得读写主 task 的 `onDelta` / `onStreamRetry` / `onMediaState` / `partialSaveTimer`。

**I2 — 不打断 TTS。** 绘图链路**不得调用任何 `app.services.tts.*`**（尤其 `stop()` / `speak()` / `createStream()`），也不得构造可朗读的文本：绘图消息 `text` 恒为空串（§6），因此既不会触发自动朗读，也不会让 chat.js 的朗读按钮（`chat.js:340`）有内容可播。附带修正：该按钮需要补 `message.text` 条件，否则空文本消息会出现一个点了没反应的"朗读"按钮。

**I3 — 不污染他人 DOM 状态。** 占位消息与完成消息都通过 `changed()` 事件更新。`chat.js` 的 `renderMessages()` 用 `JSON.stringify(message)+state` 做 `messageCache` 签名，未变消息复用原节点，所以重绘期间正在流式的消息**文本不丢**（`delta` 相位只改 `messageSnapshot` 与 DOM，且 `applyMessageDelta` 找不到行时自动退回整表重绘）。已知代价：重绘会让正在流式那条消息的"打字"指示器消失一次，属可接受。

### 3.2 为什么不注册供应商原生 tools

注册原生 `tools` 要改 6 种 `apiStyle` 的请求体形状与 `middleware.canonicalLlm` 的 `input` 结构，而各网关对流式 `tool_calls` 的增量分片与 `finish_reason` 时机并不一致（`parseStreamEvent` 现在只抽文本 / 推理 / 图片）。纯文本约定对现有链路零侵入：正文照旧流式，动作块在结尾被摘掉。已否决的备选：`json_schema` / `response_format`（会毁掉流式正文）。

---

## 4. 动作块协议（R4 / R5 的最小 schema）

### 4.1 格式

```text
（正文，可空；有正文时正常流式显示）
<<<chataxi-action
{"type":"draw","prompt":"…","selfPortrait":false}
>>>
```

- 起始行 `<<<chataxi-action`，结束行 `>>>`，中间是**单个 JSON 对象**；
- **字段只有三个**（按 R5 收敛）：`type`（`"draw"`）、`prompt`（8–400 字，中文可直接写）、`selfPortrait`（布尔，默认 `false`）；
- 没有"参考图"字段、没有"张数"字段、没有尺寸字段 —— 这些**不由模型决定**；
- 提示词要求：整块对用户不可见；只能出现在正文之后；每轮最多一次；外面不要再套 Markdown 围栏。

### 4.2 解析与流式遮罩（`app/services/actions.js`）

| 函数 | 职责 |
|---|---|
| `split(text)` | 摘出块，返回 `{ text, action, raw, invalid }`；JSON 破损 ⇒ `action=null, invalid=true`（正文保留、块丢弃、提示一次） |
| `visible(text)` | 流式显示的唯一出口：已见哨兵截到哨兵之前；末尾是**半个哨兵**（`<<<chat`）也一并遮住 |
| `parse(block)` | 校验 `type === "draw"`、`prompt` 非空且 ≤ 400 字；容忍块外多一层 ```json 围栏 |
| `describe(action)` | 生成一行状态文案（"正在绘制…"） |

接线（`app/services/llm.js`）：

- `stream()` 的 `onDelta`：`text: actions.visible(partialText(text, role.name, participantRoles))`
- `complete()` 末尾：`var split = actions.split(removeRoleEcho(parsed.text, …)); parsed.text = split.text; parsed.action = split.action;`
- 注入指令：仅当 `app.services.draw.available()` 非空时 `appliedRole.systemPrompt += "\n\n" + drawPrompt.instruction(...)`

### 4.3 空正文路径（R4）

`complete()` 不做判断，把 `text` 与 `action` 一起交给上层。`chat-session` 的规则：

- `text` 非空 ⇒ 照现状落文本消息，然后（若有动作）执行绘图；
- `text` 为空且**有动作** ⇒ **删掉那条空的占位消息**（用现成的 `store.removeMessage(pending)`），直接执行绘图 ⇒ 本轮对话里只多出一条图片消息；
- `text` 为空且无动作 ⇒ 保持现状报错（模型什么都没给）。

因为 `pending` 是先落库的，删除后需要让界面也知道，故新增一个 `chat:changed` 相位：

```js
changed(id, "removed", { messageId: pending.id });
```

`chat.js` 侧处理：从 `messageSnapshot` 过滤掉该条、`delete target.messageCache[messageId]`、`revoke` 其 URL、`renderMessages(target)`。这是本次唯一新增的事件相位，成本可控且可测。

---

## 5. 媒体层迁到宿主文件库（R2）

> 这是本计划唯一改动**存量行为**的部分（头像、对话背景、用户发过的图），所以单列一个阶段并要求独立验收。

### 5.1 为什么必须做（证据链）

1. `media.js` 只写 IndexedDB；宿主设计文档 `:415` 明确"IndexedDB 等 Web 存储……须接受其**备份边界**"，`:530` 备份只含"记录数据、附件"，`:536` 归档"文件和文件清单"。
2. `:538` 恢复时**保留实例域内 `logicalFileId`**，"使任意 JSON 中的附件引用仍成立" ⇒ 只要引用是 logicalFileId，恢复后图片就都在。
3. `FileStore.objectUrl(id) = "/__hermit/files/<id>"` ⇒ 对象地址是 logicalFileId 的确定函数，无需入库保存也能重建。
4. chataxi 自己的对话背景**已经这么做了**（`chat.js:681-690,905`），`chat.js:842` 的注释也把这件事写成既定方向。本计划只是把这个方向落实到全部媒体。

### 5.2 `app/data/media.js` 重写（对外 API 不变）

保持 `put(blob, metadata) → record` / `get(id)` / `remove(id)` / `toDataUrl(id)` 四个签名，实现改为**宿主文件优先**：

| 步骤 | 说明 |
|---|---|
| `put` | 在 Hermit 中：`files.beginWrite({name, mime})` → 按 `maxChunkBytes` 分块 `appendBytes({chunkBase64})`（每块 ≤ 64 KiB Base64，遵守 256 KiB 单调用上限）→ `finishWrite` 得 `HermitFile`；然后把**索引记录**写进宿主集合 `media`：`{id, logicalFileId, url, name, mime, kind, size, sha256, width, height, duration, createdAt}`。无 Bridge（浏览器预览）⇒ 退回 IndexedDB，行为不变。 |
| `get` | 先查索引记录；没有则查 IndexedDB（老记录）⇒ 命中就**惰性搬迁**到宿主文件并补索引（引用 id 不变，所以 `role.avatarMediaId` / `message.media[].mediaId` 都不用改）。 |
| `remove` | 删宿主文件（按索引里的 `logicalFileId`）+ 删索引 + 删 IndexedDB 副本。 |
| `toDataUrl` | 索引记录 ⇒ 同源 `<img src="{url}">` 载入 → canvas → `toDataURL('image/jpeg', 0.92)`。**不能 fetch**：页面 CSP 是 `connect-src 'none'`（`:104`），同源图片走 `img-src`（被 `default-src 'self'` 覆盖）没问题。 |
| `migrate()` | 启动时跑一次的**一次性搬迁**：`indexedDB.getAll()` 逐条 import 到宿主文件 + 写索引，成功后删掉 IndexedDB 副本，并置标记（宿主集合 `meta`）。保证"从没被打开过的头像/图片"也进备份，而不是只能等被读到才搬。 |

`store.js` 需要同步三处：`collections` 加 `"media"`；`releaseMedia()` 的 `used` 判断对"有索引记录的 mediaId"也去删宿主文件（最省事的做法是让 `media.remove()` 自己负责删文件，`releaseMedia` 逻辑不动）；`collections` 里 `media` 不进 `profileCollection`（不是模型卡片）。

### 5.3 写入路径的必测点（实施第一步就探针）

- `hermit.files.beginWrite` 在**当前安装的 APK** 上是否存在。代码侧已确认：实现在 `MainActivity.kt:2223-2231` + `FileStore.kt:87/112/130`，由提交 `57d79a0` 引入，**含在宿主 v1.11.0 及以上**（本机主线当前 1.11.1）。仍按纪律在设备上探一条（能力清单 + 一次真实写入），失败即明确降级到 IndexedDB 并告诉用户"宿主版本过旧，图片不会进备份"，**不静默**。
- 一次 2 MiB 图片的入库耗时（44 次 `appendBytes`）与配额表现。若单张 1024² PNG 约 1.5–2 MiB，200 张就是 300–400 MB ⇒ 要**如实告知配额风险**，并在 `E_QUOTA` 时给可读错误 + 指路"删除旧对话可释放"（`releaseMedia` 已有链路）。若配额成为实际瓶颈，再改为入库前转 JPEG q0.92（≈200–400 KB/张）——**先量再定，不预设**。

### 5.4 与既有引用的兼容

- 消息 `media[]`：新记录写 `{mediaId, logicalFileId, url, mime, name, size, sha256, kind, alt}`；老记录只有 `mediaId`，读取路径不变（`media.get` 内部搬迁）。
- 头像：`role.avatarMediaId` / `userProfile.avatarMediaId` / `conversation.userAvatarMediaId` 值不变，指向的媒体记录自动进宿主文件。
- 对话背景：**已经**是 `url + logicalFileId`，不动。
- 释放：`releaseMedia()` 已同时理解两种引用（`:517-527`），`media.remove()` 补上删文件即可。

### 5.5 全部"用户媒体"必须一并迁走（业主追加要求，本版显式列为验收项）

业主原话：「你要确保一并修改**角色头像和个人头像**机制, 确保使用 `hermit.files` 机制, 会被正确备份和恢复。」

`media.js` 对外 API 不变，所以只要 §5.2 落地，所有走 `media.put` 的东西**自动**进宿主文件库。但"自动"不等于"验收过了"，因此把清单写死，逐项在 §9.2 第 2 条验收：

| # | 媒体 | 写入点 | 引用字段 |
|---|---|---|---|
| M1 | **角色头像** | `roles.js:183-190` | `role.avatarMediaId` |
| M2 | **个人头像（我的）** | `me.js:27-31` | `userProfile.avatarMediaId` |
| M3 | **对话头像（我的）** | `conversations.js:185-195` | `conversation.userAvatarMediaId` |
| M4 | 对话背景图 | `chat.js:905`（已是宿主文件，只做回归） | `background.url` + `logicalFileId` |
| M5 | 用户发的图 / 视频 | `chat.js:458,466` | `message.media[].mediaId` |
| M6 | 新生成图 | P5 `runDraw` | `message.media[].mediaId` |
| M7 | **角色定妆照**（新） | P6 `roles.js` | `role.portraitMediaId` |

配套改动（不做这三处，头像字节搬了但**引用登记**会漏，释放时留下孤儿文件）：

1. `store.js:5` `collections` 加 `"media"`（索引记录的宿主集合名，**不进** `profileCollection` 白名单）。
2. `store.js:514-527` `releaseMedia()` 的 `used` 判断补 `role.portraitMediaId`（roles 分支 :518）—— M1/M2/M3 的字段已在内，不用动。
3. `settings.js:37,48-49` 两个危险操作：清空角色时补收集 `portraitMediaId`；重置个人资料时 `avatarMediaId` 已在列，确认新档案默认值仍为空串。

**明确例外 —— TTS 音频缓存不迁（M8 不做）。** 理由有据、不是省事：

- `tts-cache.js:64-73` 的 `clipOf()` **要求 `stored.blob`**，且 `kind === "file"` 一律判未命中 —— 混响链是 Web Audio 的 `decodeAudioData` + `ConvolverNode`，必须拿到内存里的 ArrayBuffer，宿主文件的对象地址喂不进这条链；
- 它是**本地临时缓存**（`tts-cache` 不在 `collections` 的持久数据语义里），现在本来也不进备份，迁走换不来备份收益，只会把混响弄坏；
- 因此 `media.js` 重写时必须**保留 blob 分支**：`put(blob, metadata)` 带 `metadata.transient === true` 时仍写 IndexedDB、不写宿主文件。`tts-cache.js` 只加这一个参数（一行），其余不动。

> 判据收敛：**"用户看得见、丢了会心疼"的字节进宿主文件库；纯本机可再生/临时缓存留在 IndexedDB。** 这条线只画一次，以后新加的媒体按它归类。

---

## 6. 上下文编解码（R3）

### 6.1 图片消息进上下文的形式

`hydrateMessages()`（`llm.js:4`）里对**带 `draw` 的助手消息**改为产出文字：

```text
发送了一个图片：（提示词），文件地址是：/__hermit/files/<logicalFileId>
```

- 其余角色看到时，外面仍套现有那句"其他角色「X」的历史发言（仅作上下文参考，禁止模仿、代替或续写该角色）："；
- `output.images` 保持为空 —— **真图不进上下文**（现有代码本来也只对非助手消息注入图片，此处是显式写死这条规则，避免以后被"顺手修好"）；
- `prompt` 截到 400 字；`url` 用**相对对象地址**：它是 logicalFileId 的确定函数，恢复备份后仍成立；若写成含端口的具体地址，换机恢复后就是错的。
- 诚实备注：这个地址只有**当前应用页面**能读（`:427` 只向当前页面发布当前 appId/dataGeneration 的对象 URL），远程模型打不开它。它进上下文的作用是"让模型知道有一张图、引用是它"，以及让模型能在后续发言里指代这张图。

### 6.2 用户发的图不受影响

用户消息仍按 `mediaPrep.hydrate()` 送真图；其 `dataUrl` 由新的 `media.toDataUrl()`（canvas 路径）产出。

---

## 7. 实施阶段

### P1 绘图模型配置（kind = `image`，只含 CVP）

`catalog.js` 加 `imageFamilies = [cvp]`；`model-services.js` 的 `families()` 改映射 + `discoverImage()` 打 `/cvp/info` 把能力列表映射成模型条目 + `authHeaders` 的 cvp 分支；`model-registry.js` 里 `kind === "image"` 直接归 `recommended`（否则 `text-to-image` 这类 id 会被 LLM 的 SPECIALIST 规则判成 `other` 而 `excluded`）；`models.js` 加第四个 Tab「绘图模型」；`model-single-editor.js` 加 `labels.image`、默认 family 取列表第一个；`store.js` / `profiles.js` 的白名单与删除分派。

判据：能添加 CVP 卡片（`http://192.168.124.31:8189` + 密码）→ 获取目录出现 `render` → 测试通过 → 卡片显示"已验证"。

### P2 媒体层迁宿主文件（R2，独立验收）

按 §5 重写 `media.js`（宿主文件优先 + `transient` 仍走 IndexedDB）+ `store.js` 三处（`collections` 加 `media`、`releaseMedia` 补 `portraitMediaId`、`profileCollection` 不加）+ 启动一次性迁移。判据：**导出一份备份 → 换新实例恢复 → §5.5 的 M1–M7 全在**（角色头像 / 个人头像 / 对话头像 / 对话背景 / 历史图片 / 生成图 / 定妆照，这是 R2 唯一算数的验收，见 §9.2）。浏览器预览下行为不变。

实施第一步先探针（§5.3）：设备上 `hermit.files.beginWrite` 是否存在 + 一次真实写入 → 不存在就按降级路径走并如实告知"图片不会进备份"。

### P3 CVP 客户端 `app/services/draw.js`

- `available()`：取 `image-profiles` 中第一个 `enabled !== false` 且有 `externalModelId` 的卡片；没有 ⇒ `null`（不注入提示词、不执行动作）。
- `info(profile)`：`GET <base>/cvp/info`，60 s 缓存；`base` 用 vibedraw 同款截断规则。
- `capability(profile, id)`：按 id / aliases 找（`render` ↔ `qwen`）。
- `generate(profile, input)`：`POST /cvp/jobs` → 700 ms 轮询 `/progress` → 完成后读一次 `/jobs/{id}` → `GET outputs[0].url` 取字节。
- 请求体：`{capability:"render", prompt, seed, size, steps, ref_strength}`（值取 §8 的锁定规则），有参考图时加 `image_base64`；**不发送** `ignores` 里声明的字段。
- 进度：只在 `queue_position > 0` 时显示"前面还有 N 个任务"，**不假装有百分比**。
- 超时：`typical_seconds × 4` 与 240 s 取小；用**私有 drawTask** 中断（I1），放弃时尽力 `POST /cvp/jobs/{id}/cancel`。
- 错误归一化：`unauthorized / no_model(409) / busy(429) / bad_image / E_QUOTA / 超时` → 中文可读文案（补 i18n）。

### P4 动作块与提示词注入

新增 `app/services/actions.js`、`app/services/draw-prompt.js`（并把它加进 `tools/check-i18n.mjs` 的 `PROMPT_FILES`，理由与 `context.js` / `llm.js` 同类：只拼模型指令、不进 DOM）；`llm.js` 三处接线（§4.2）。

`draw-prompt.instruction()` 至少覆盖：三字段 schema；必须在正文之后、正文可空但**若为空则不产生文本消息**；整块用户不可见；每轮最多一次；提示词设计说明（先判断这张图该画什么：镜头远近、环境、时间与光线、姿势动作、衣着与外貌、正在做的事；不要复述系统设定、不要写参数）；`selfPortrait=true` 的语义（"画这个角色自己的照片"，用于唤起定妆照参考图，且**只有 role 有定妆照时才会真的带上参考图**）。

### P5 Action 执行（`chat-session.js`）

- 新增 `runDraw(conversationId, role, action, openedAt)`，与 `outputImages` 并列。
- 触发点：主循环 `pending` 处理完之后，`if (result.action && result.action.type === "draw")`，且 `app.services.draw.available()` 非空。
- 空正文：先 `store.removeMessage(pending)` + `changed(id,"removed",…)`，再走绘图（R4）。
- 占位消息：

```js
{ kind: "assistant", roleId, roleName, text: "", media: [], status: "drawing",
  draw: { capability: "render", prompt, selfPortrait, reference: "none|portrait|unsupported",
          profileId, modelId, seed, size, steps, startedAt } }
```

- 完成 ⇒ 同一条消息改 `status:"done"` + `media:[{mediaId, logicalFileId, url, mime, name, size, kind:"image", alt}]` + `draw.jobId/completedAt/durationMs`；失败 ⇒ `status:"error"` + 可读错误。两次都只发 `changed(id,"updated")` 与 `refreshPreview(id)`。
- **不 await**：绘图与发言循环解耦 ⇒ 群聊不因 45 s 的出图卡住（§7 P5 与 §3.1 共同保证 R1）。
- 全程只用私有 drawTask，不碰主 task，不碰 tts（I1 / I2）。

### P6 全屏看图 + 定妆照

- `app/components/image-viewer.js`：全屏层（`position: fixed; inset: 0`）、深色底、关闭按钮 + 背景点击关闭、pointer 手势（单指 pan / 双指 pinch 以中点为锚）、`scale ∈ [1,8]`、`clampOffset()`、双击复原、Esc 关闭；打开时锁 `body.overflow`，**关闭时必须还原**（与项目"跨页面状态类要在 close() 清掉"同一纪律）。`chat.js:323` 的气泡图片点击改调它。
- 显示宿主文件图片：`<img src="{media.url}">`（同源，CSP 允许），不再 `URL.createObjectURL(blob)` ⇒ 顺带消掉对象 URL 生命周期那类 bug。
- 定妆照：`ui.js` 加薄封装 `cropPortrait(source, onCropped)` = 现成的通用取景弹窗 `cropPicture(source, {aspect: 3/4, outputWidth: 768, quality: 0.9, labels:{…}})`（`cropAvatar` 只是它 1:1 的特例）；`roles.js` 在角色档案面板底部加「添加角色定妆照」（预览 / 更换 / 移除），流程照头像：`pickLocalImage()` → `cropPortrait` → `media.put` → 暂存 id → 提交写 `portraitMediaId`；取消与替换清暂存；删除角色一并释放。
- 小修：`chat.js:340` 的朗读按钮补 `message.text` 条件（空文本不渲染）；为 `status:"drawing"/"error"` 的图片消息做骨架与错误态样式。

### P7 版本、门禁、验收

四处同步版本（`hermit.json` / `app/core/namespace.js` / `README.md` / `~/hermit/happ-dev.json`）→ 热更新到设备 → 本地四套测试 + i18n 门禁 → §9 真机人工验收。**不出 zip、不打 tag**（除非明确要求发版）。

---

## 8. 参考图与参数锁定（R5）

| 项 | 规则 |
|---|---|
| 参考图张数 | **最多 1 张**，且**只可能来自 `role.portraitMediaId`**（定妆照） |
| 触发条件 | `action.selfPortrait === true` **且** 角色有定妆照 ⇒ 把定妆照作为唯一参考图；没有定妆照 ⇒ 不带参考图，**不报错** |
| 能力判断 | 读 `/cvp/info` 的该能力 `needs.image`：`=== true` ⇒ 带上；不等 ⇒ 不带，`draw.reference = "unsupported"`，给一次轻提示（不阻断），因为"画出来不像"比"直接失败"更值得让人知道 |
| 其他协议 | 本计划只支持 CVP；"其他默认支持、出错报错"这条作为将来扩展时的口径写在注释里 |
| 出图张数 | 恒 1 张（取 `outputs[0]`） |
| 尺寸 / 步数 | 从 `/cvp/info` 的 `defaults` **显式发送**（`size` / `steps` / `ref_strength`），拿不到 info 就不提交并提示"请先在模型页测试连接" |
| 负向提示词 | `render` 的 `ignores` 里有 `negative_prompt` ⇒ 不发 |
| 参考图强度 | 先用插件默认 `ref_strength 0.95`（它把参考图当"要贴近的图"），**然后在真机上对比 0.95 与约 0.6 两种效果再定**——这是唯一需要调参的地方，用实测决定，不猜 |
| 参考图预算 | 定妆照从媒体层读出后重编码为长边 ≤ 1024 的 JPEG，并受 `hermit.messageChars` 约束（同 vibedraw `image-engine.js` 的算法）；**不改用户原图** |

---

## 9. 测试与验收

### 9.1 本地

- `tools/verify.mjs` 新增源码门禁：动作块哨兵常量；`onDelta` 用了 `visible()`；`chat-session` 有 `runDraw` 且**没有**把主 task 传进绘图链路；`draw.js` 只出现 `/cvp/` 路径；`image-profiles` 与 `media` 已在白名单；`media.js` 调用了 `beginWrite/appendBytes/finishWrite`**且保留了 `transient`→IndexedDB 分支**；`roles.js` 有 `portraitMediaId` 且 `store.releaseMedia` 登记了它；`tts-cache.js` 仍要求 `stored.blob`（M8 例外不被顺手改掉）；`image-viewer` 手势关键串；`cropPortrait` 的 3:4 参数；`i18n-en.js` 含新词条。
- `tests/runtime.test.mjs`（linkedom）：`actions.split/visible` 表驱动（正常块 / 无块 / 半个哨兵 / 缺 `>>>` / 被围栏包裹 / JSON 破损 / 正文为空 / 块在中间 / prompt 超长）。
- 新增 `tests/media-host.test.mjs`：假 `hermit.files` 覆盖 `put → get → toDataUrl → remove` 与**惰性搬迁**、`E_QUOTA` 失败、`beginWrite` 不存在时的降级。
- 新增 `tests/draw.test.mjs`：假网络覆盖提交 / 排队 / 完成 / 失败 / 超时 / 取字节 / 私有 task 不被主 task 影响。
- `tests/ui-flow.mjs`：第四个 Tab 存在；角色编辑窗口有定妆照控件；点气泡图片打开全屏层、Esc 后 `body.overflow` 还原；空文本绘图消息不渲染朗读按钮。
- `tools/check-i18n.mjs --check` + `tests/i18n-ui.mjs`。

### 9.2 真机人工（手势与真出图只能人工；设备工具集没有触摸注入能力）

1. CVP 卡片配置成功（`http://192.168.124.31:8189` + 密码），获取目录出现 `render`；
2. **R2 决定性验收**（业主追加要求的验收项，逐项点名）：备份导出 → **换一个新实例**恢复 → 下列 M1–M7 **全部还在且能显示**：
   - M1 角色头像、M2 个人头像（"我的"）、M3 对话头像、M4 对话背景、M5 历史图片消息、M6 新生成的图片、M7 定妆照；
   - 恢复后还要能**被送进模型**（canvas 取字节 → `media-prep`）与**被用作定妆照参考图**（P5 链路）。
   - 同时确认 M8（TTS 音频缓存）**不进备份是预期行为**，恢复后首次朗读重新合成即可。
3. 正常聊一轮：正文流式正常，末尾看不到动作块；**边流式边出图**时正文不中断、TTS 朗读不断（这是 R1 的正面验收：绘图完成的 `updated` 恰好落在下一位角色流式中）；
4. 要求画图：出现"正在绘制"占位气泡 → 45 s ± 变成图片消息，说话人是发起绘图的角色；
5. **R4 验收**：让模型"只画不说"（明确要求先出图不要文字）⇒ 对话里只多出图片消息，没有空气泡；
6. **R3 验收**：让另一个角色接着"评论刚才那张图" ⇒ 它能引用到提示词与文件地址（说明文字形态进上下文生效）；
7. 点图 → 全屏：双指放大 / 单指拖动 / 双击复原 / 关闭后页面可滚动；
8. 加定妆照后要"画一张你自己的照片" ⇒ 图与定妆照同人（参考图生效）；再对比 `ref_strength` 0.95 与 0.6 的差异，定下默认；
9. 停 CVP / 填错密码 ⇒ 错误气泡可读，对话其余部分不受影响。

---

## 10. 已知限制与待裁决

1. **配额**：宿主是单应用总量配额，1024² PNG 每张 1.5–2 MiB ⇒ 图片一多就会顶到 `E_QUOTA`。本计划先按原图入库（不二次压缩，避免"我的图被压了"的意外），把"入库前转 JPEG q0.92"作为**待实测后再决定**的开关点。
2. **写句柄的会话归属**：`beginWrite` 的句柄只属于创建它的页面会话；绘图完成时若页面已重载 ⇒ 入库失败。响应：明确报错 + 不留半成品（遵守宿主"中途放弃 abortWrite"），重试路径留作可选。
3. **URL 的可用范围**：进上下文的是应用页内对象地址，远程模型打不开（§6.1 已如实说明）。
4. **图片不进模型视野**：按 R3 有意如此；模型只从文字描述得知"画过什么"。
5. **每轮一次、并发出图排队**：多个角色同时要画会排队，占位气泡等待较久。
6. **角色级开关**：本轮"有启用的绘图模型就全体可画"。学习类角色若不想画图，需要后续加 `role.drawEnabled`。
7. **中文提示词直发**：`render` 声明 `prompt.language: "any"`，翻译归插件；chataxi 不做二次翻译。
8. **A1X 是共享生图机**：跑绘图时会挤占 ComfyUI（技能 `a1x-comfy-device` 已记录）。
9. **老 IndexedDB 数据只在迁移跑成功后才删**：迁移失败要保留原数据并如实报告，绝不静默丢弃。

---

## 11. 明确不做

- `quick` / `inpaint` / `upscale`，以及任何非 CVP 的绘图协议；
- 绘图参数面板（尺寸 / 步数 / 参考强度 / 负向提示词）；
- 多张出图、多张参考图、模型自选参考图；
- 角色级绘图开关与绘图历史画廊；
- 供应商原生 tool / function call 通道；
- 任何 hermitapp / hermitweb / vibedraw 侧改动，任何 APK 构建与覆盖安装。

---

## 12. 实施记录（2026-09-26 落地，第四版增补）

状态：**P1–P6 全部实现完毕，本地四套测试全绿；P7 的版本同步已完成，热更新待设备确认。**

### 12.1 实际改动清单

| 文件 | 性质 | 要点 |
|---|---|---|
| `app/services/actions.js` | 新建 | 哨兵 `<<<chataxi-action` … `>>>` 的唯一定义处；`split()` 切正文/动作（容忍围栏、破损 JSON、缺 `>>>`）、`visible()` 遮罩（含半截哨兵）、`parse()` 校验三字段、`describe()` |
| `app/services/draw-prompt.js` | 新建 | `instruction(hasPortrait)`：三字段 schema + 六条规则；无定妆照时改口径（要求自己在 prompt 里写容貌） |
| `app/services/draw.js` | 新建 | CVP 客户端：`available()` 取第一张启用的绘图卡片、`generate()`（提交 → 700 ms 轮询 `/progress` → 读一次 job → 取字节）、`portraitReference()`（长边 ≤ 1024 的 JPEG 副本）、`readable()` 按规范 §6 翻译错误码；三条不变量写在文件头 |
| `app/services/catalog.js` | 改 | 新增 `imageFamilies`（单条 CVP 家族，`discovery:"cvp"`，`keyOptional:true`，`customEndpoint:true`） |
| `app/services/model-services.js` | 改 | `families/family` 扩到四种 kind（`family()` 三层兜底）；新增 `cvpBase()`、`discoverImage()`（读 `/cvp/info` → 只留 `category` 含 `render` 的能力） |
| `app/services/model-registry.js` | 改 | `LOCAL` 加 `cvp`；`transportCodec` 加 `imageFamilies`；`groupModels` 对 `kind==="image"` 直接归 `recommended`（绕开会把 `text-to-image` 判成 llm 的 SPECIALIST 规则） |
| `app/services/profiles.js` | 改 | `remove` 显式分派 image；`validateEnabled` 对 image 早退（绘图卡片没有"角色绑定"这回事） |
| `app/data/media.js` | 重写 | 宿主文件库优先；`transient === true` 或宿主不可用 ⇒ 走 IndexedDB。`displayUrl()` 给同源对象地址；`migrate()` 启动一次性全量搬迁（失败不置标记、下次重试） |
| `app/data/store.js` | 改 | 白名单加 `"image-profiles"` 与 `"media"`；`profileCollection` 加 `image-profiles`；`releaseMedia` 登记 `portraitMediaId`；`seed()` 给老角色补 `portraitMediaId` |
| `app/services/tts-cache.js` | 改 | 写入时显式 `transient: true`（**唯一不进备份的用户媒体**，另加注释说明为什么搬不过去） |
| `app/services/llm.js` | 改 | `drawNote()` 把绘图消息变成「发送了一个图片：提示词, 文件地址是：/__hermit/files/<id>」且不给字节；`stream()` 的 `onDelta` 走 `actions.visible()`；`complete()` 在有可用绘图卡片时注入 `drawPrompt.instruction()`，末尾 `settle()` 切出 `parsed.action` |
| `app/features/chat-session.js` | 改 | 新增 `runDraw()`（**分离的异步任务**，进度去重，失败落成可读错误）与 `retryDraw()`；空正文那轮 `removeMessage` + 新增 `"removed"` 相位；`stop()` 一并取消在跑的绘图；`recover()` 把 `drawing` 也归为可重试的 error |
| `app/features/chat.js` | 改 | 绘图占位骨架；图片点击改走全屏看图；图片下方回显提示词（带「参考定妆照」徽章）；图片消息的重试按钮 = 重新绘制；处理 `"removed"` 相位 |
| `app/components/image-viewer.js` | 新建 | 全屏看图：单指 pan / 双指 pinch（以中点为锚） / 双击切换 / Esc / 点背景关闭；`scale ∈ [1,8]`，平移有边界；打开锁 `body.overflow`、关闭**无条件还原** |
| `app/components/ui.js` | 改 | `hydrateAvatars` 改 `displayUrl`；新增 `cropPortrait`（3:4 / 768 / q0.9 的 `cropPicture` 薄封装） |
| `app/features/roles.js` | 改 | 角色档案面板加定妆照区（预览 / 选择 / 移除），提交写 `portraitMediaId`，替换与删除角色时释放旧文件 |
| `app/features/settings.js` | 改 | 清空白名单补 `portraitMediaId`；模型清空按 `profileCollections` 循环（不再硬编码前 3 个） |
| `app/features/models.js` / `model-single-editor.js` | 改 | 第四分区「绘图模型」；地址 / 密码 / 能力选择；测试按钮走 `discoverImage` |
| `app/app.js` | 改 | 启动后触发 `media.migrate()`（不 await），失败给一条 toast |
| `styles/app.css` | 改 | `.message-draw` 骨架、`.message-caption`、`.image-viewer*`（舞台自己 `touch-action: none` 接管手势） |
| `index.html` | 改 | 装载 `actions.js` / `draw.js` / `draw-prompt.js` / `image-viewer.js` |
| `app/data/i18n-en.js` | 改 | +77 条字典键、+7 条拼装句规则（绘图、定妆照、宿主文件库、全屏看图） |
| `tools/verify.mjs` | 改 | 新增 24 条源码门禁（§12.3）；修掉一条把"登记过"和"恰好末位"绑在一起的旧断言 |
| `tests/runtime.test.mjs` | 改 | 沙箱补装 `actions.js`（llm.js 现在依赖它） |
| `tests/ui-flow.mjs` | 改 | 模型页分区断言补上「绘图模型」 |

### 12.2 与计划的偏差（都是收窄，不是放弃）

1. **没有新建 `tests/media-host.test.mjs` 与 `tests/draw.test.mjs`**：业主本轮明确「只进行必要的技术测试和调试」。等价覆盖改由 `tools/verify.mjs` 的源码门禁承担（字节必须走三件套 + `transient` 分支必须保留 + `draw.js` 三条不变量 + 哨兵只有两处）。真正的字节与出图只能在真机上验，这两件事本来就无法用假宿主证明。
2. **占位消息的 `draw` 字段比计划瘦**：只留 `{prompt, selfPortrait, reference, jobId}`。计划里的 `capability / profileId / modelId / seed / size / steps / startedAt` 都可由 `runnableRef` 与消息时间反推，存下来只会产生第二份真相 —— 而它们没有任何一处被读取。
3. **删除角色的确认文案改了一句**（加"定妆照"），因为删除确实会连定妆照一起删掉。
4. **`ref_strength` 仍照插件默认 0.95 发**：计划里"真机对比 0.6"这一步必须在设备上做，代码留了单点（`draw.js` 的 `body.ref_strength`）。
5. **`chat.js:340` 那个小修不成立**：朗读按钮本来就包在 `if (message.text)` 里，空文本的绘图消息不会渲染它。计划里的这一条已经作废。

### 12.3 `tools/verify.mjs` 新增的门禁（全部可机械复核）

1. `media.js` 必须 `beginWrite → appendBytes → finishWrite`，且中途失败必须 `abortWrite`；
2. 三件套先探测再使用（老宿主降级而不是崩）；
3. `options.transient === true || !hostReady()` 这条 IndexedDB 分支必须保留，`tts-cache.js` 必须标 `transient` 且必须要求 `stored.blob`；
4. `roles.js` 有 `portraitMediaId`，`store.releaseMedia` 登记了它；
5. `store.js` 白名单登记了 `"image-profiles"` 与 `"media"`，`app.js` 启动触发 `media.migrate()`；
6. `llm.js` 的 `drawNote()` 走宿主对象地址，且只有非助手消息才把字节交给模型；
7. 绘图指令按「有没有可用卡片」注入；
8. 哨兵字面量只允许出现在 `actions.js` 与 `draw-prompt.js`；`llm.js` 必须用 `visible()` 与 `split()`；
9. `draw.js` 不许出现 `task.onDelta / onMediaState / stopPromise`，不许调用 `app.services.tts.*`，不许 `querySelector / innerHTML`；
10. `drawTasks` 与 `tasks` 分开，`runDraw(...)` 必须是 `.catch(...)` 形式的分离任务；
11. 空正文那轮必须 `removeMessage`；`pending` 必须活到落库之后（否则写库失败会留下永远 "pending" 的死消息）；
12. `chat.js` 必须有 `drawing` 与 `removed` 两个分支，图片消息的重试必须走 `retryDraw`；
13. 气泡图片必须走 `imageViewer`，看图不再借通用弹窗；关闭必须还原 `body.overflow`；`.image-viewer-stage` 必须 `touch-action: none`。

### 12.4 本地验证结果（2026-09-26）

- `node tools/verify.mjs` ✅ —— 112 项 runtime 断言 + 47 个 JS `--check` + 44 条运行时引用 + 源码门禁 + Python 打包测试，`fail 0`；
- `node tests/ui-flow.mjs` ✅（`CHATAXI_DOM_MODULE` 指向隔离的 linkedom）；
- `node tests/i18n-ui.mjs` ✅；
- `node tools/check-i18n.mjs --check` ✅ 退出码 0（字典 1039 键 / 82 条规则，"未覆盖界面文案"清零）。

版本已同步四处：`hermit.json` `0.7.26` / code `105`、`app/core/namespace.js`、`README.md`、`~/hermit/happ-dev.json`。

### 12.5 设备部署（2026-09-27）

- 设备：`http://192.168.124.30:8766`（服务端 1.11.0），实例 appId `6651080b-4d5f-42ec-b4d0-571dadbc25b3`，happId `life.airen.chataxi`，dev 通道；
- `sync-dir` → `commitState: committed` / `refreshState: runtime-recreated` / **revision 33**；
- `hermit_wait_dev_render` → `state: "rendered"`；
- 设备树上出现四个新文件（`app/services/actions.js`、`draw.js`、`draw-prompt.js`、`app/components/image-viewer.js`）——顺带证明 `hermit-install.json` 指向旧 ZIP 并不会漏掉新文件（它的作用是裁掉 docs / tests / 历史包，不是精确文件清单）；
- 剩下的全是 §9.2 的真机人工项：CVP 卡片配置 + `/cvp/info` 目录、备份往返（M1–M7）、边流式边出图不打断 TTS、空正文只有图、跨角色引用提示词、全屏手势、定妆照参考效果与 `ref_strength` 定值、错误路径。

### 12.6 真机反馈后的六处修复（2026-09-27 第二批）

业主在设备上试过之后逐条报回来的问题,全部已修并推上设备（**devRev 88**）。

| # | 现象 | 根因 / 改法 |
|---|---|---|
| 1 | 一发消息就抛 `id is not defined` | `chat.js` 的图片消息分支里写了裸 `id`,而 `messageElement` 的作用域里没有这个变量；会话 id 必须从 `target` 上取。已加门禁（§12.8 第 14 条） |
| 2 | 全屏看图默认没充满高度 | 基线从「适应宽高」改成「**高度充满**」：一打开图片高度就等于屏幕高,宽度按比例 |
| 3 | 系统返回（侧滑）关不掉看图,反而退了页面 | 手势自己接管：打开时 `body.overflow` 上锁,返回键 / 侧滑只 `close()` 看图,且关闭时**无条件还原** `body.overflow` |
| 4 | 大模型认为"发照片"和"画图"是两件事 | 提示词里把两者明确合并：用户索要照片 ⇒ 直接走绘图动作；并新增**角色自己的照片要特殊标明**（`action.selfPortrait`）,由 `draw.js` 把定妆照顶上去当参考图 |
| 5 | 定妆照读不出来时静默失败 | `portraitReference()` 的异常不再吞掉,失败落成可读的错误消息 |
| 6 | 图片消息不能改提示词 / 重新生成 / 删除 | 图片消息记下当时用的卡片与能力（`draw.profileId` / `draw.modelId`）,`retryDraw` 才能"照当初那张画"；编辑弹窗里可改 `draw.prompt`（正文与字节都不动）,删除按钮移到编辑弹窗底部（不在消息上直接给） |

第 6 条顺带定了两条不变量：

- `retryDraw` 走 `resolveCard(profileId, modelId)` —— 卡片还在就用它,即使它已经不是当前默认的那张；卡片被删了才退到当前可用的第一张。所以 `draw.js` 的 `pickSize(model, defaults.size)` 里那个 `model` 必须是**重建出来的那张**。
- 删除入口**只在编辑弹窗底部**,不在消息气泡上（业主明确要求）。

### 12.7 画幅规格：9:16 / 约 1MP,以及插件 2.3.0（2026-09-27 第三批）

业主规格原文（照抄）：

> 画幅 9:16 原生高质量约 1MP,qwen-image 2.1 官方 20 步,提示词强度 1,qwen2.1 模式（带定妆照用参考图编辑,不带用文生图）,参考图编码边长 512,前缀缓存 自动,前缀缓存精度 int8
> —— chataxi 默认参考上面的这个规格发起请求绘图（有些参数 cvp 如果已经默认就不必重复发起）。

**七项逐条对账**（"不改也对"的三项不动,需要动的四项已落地）：

| 规格项 | 归属 | 结论 |
|---|---|---|
| 20 步 | 插件 `defaults.steps` | **已满足**,chataxi 照 `defaults.steps` 发,不重复声明 |
| 提示词强度 1 | `ref_strength` 上限 0.95 | **已满足**（`ref_strength` 上限就是 0.95,本地先夹一次） |
| 前缀缓存 自动 | 插件家族选项 `cache_device` | **已满足**（设备侧 = `auto`） |
| 前缀缓存精度 int8 | 插件家族选项 `cache_dtype` | **已满足**（设备侧 = `int8`。插件出厂默认是 `default`,权宜值只写进设备设置文件） |
| 9:16 / 约 1MP | **两边都要** | 插件 2.3.0 公布 `render` 的 `[768, 1344]`（1,032,192 px）；chataxi `PREFERRED_SIZE` 改成 `[768, 1344]` |
| 带定妆照=参考图编辑,不带=文生图 | **插件** | `render.needs.image = false`：带 `image_base64` 走参考图编辑,不带就是纯文生图（核心节点 `TextEncodeQwenImage21` 的 `images` 是 `min=0`,这条路径本来就是合法的） |
| 参考图编码边长 512 | **插件（设备侧）** | 插件新增家族选项 `reference_edge`,按画幅比例算成编码框；设备侧设 `512` ⇒ 768×1344 画幅下是 **384×672**。chataxi 侧不重复实现,它的 `REFERENCE_MAX_EDGE = 1024` 只是**上传上限** |

**"约 1MP + 9:16"的唯一对应**：设备 `native` 档的 `[768, 1344]`。同一份能力表里 `fast` 档是 576×1024（0.59MP）,差一半,不取。

配套改动（vibedraw 仓库,插件 2.3.0）：`capabilities.py` 用 `size` 域（对齐步长 / 最短边 / 最长边 / 像素预算 / 建议比例）**算出**推荐枚举并播报 `size_domain`,四个能力都不再锁死手写清单；`validate_values` 按域判而不是按清单判。**枚举语义保留** —— 老客户端只读 `values.size`,只取 `sizes[0]`,所以 `quick`/`inpaint` 首项仍是 512²,`upscale` 仍是 `[[1024,1024],[2048,2048]]`,`render` 首项仍是 1:1,历史纹理没有被破坏。

**A1X 部署实测**（`/cvp/info` 抄回来的真实值）：`plugin.version 2.3.0` / `render.needs.image=false` / `render.values.size` 含 `[768,1344]` / 四个能力都有 `size_domain`。设备插件源码备份在 `custom_nodes/vibedraw_comfy/.bak-20260927/`。

**连带发现（未处置）**：vibedraw app 假定画幅是方的 —— `app/services/providers.js` 的 `value.width = value.height = sizes[0]`,`cvpSizes()` 只取 `pair[0]`,`app/components/settings.js` 把标签硬写成 `1:1`。非方形条目进来后它不会报错（768×768 仍落在 `render` 的域里）,但标签与实发画幅会对不上。**待业主裁决是否本轮一起收掉。**

### 12.8 本地验证与设备部署（2026-09-27 第三批）

- `node tools/verify.mjs` ✅ —— 114 项 runtime 断言（含新增的 `[768,1344]` 命中断言）+ 47 个 JS `--check` + 44 条运行时引用 + Python 打包测试,`fail 0`；
- `node tests/ui-flow.mjs` ✅ —— 17 段全 passed（含"编辑绘图提示词 / 重新绘制 / 确认后删除"）；
- `node tests/i18n-ui.mjs` ✅；`node tools/check-i18n.mjs --check` ✅ 退出码 0（字典 **1056** 键 / **83** 条规则）；
- 版本同步四处：`hermit.json` `0.7.28` / code `107`,`app/core/namespace.js`,`README.md`,`~/hermit/happ-dev.json`；
- 设备：`http://192.168.124.35:8766`,实例 appId `d8d07eda-c391-49db-81e7-fe8153634e96`,devRev **88 → 89**,`commitState: committed`；设备侧报的差异正好是三个运行期文件（`hermit.json` / `app/core/namespace.js` / `app/services/draw.js`）；
- `hermit_read_dev_file` 回读 `app/services/draw.js`,确认 `var PREFERRED_SIZE = [768, 1344];` **已在设备开发树里**（不是"部署成功即算数"）。

**测试桩的一条经验**：`retryDraw` → `runDraw` 里 `existing.draw.profileId` 会走 `app.services.draw.resolveCard(...)`,而它内部的兜底 `available` 是模块内部引用,**桩打在 `available` 上打不到它** ⇒ 测试必须把 `resolveCard` 也一起接管,否则"重新绘制"会以为卡片没了,页面直接报"当前没有可用的绘图模型"。已写进 `tests/ui-flow.mjs` 第三段的注释里。

### 12.9 「画的还是方图 / 比例不对」= 两条独立根因（2026-09-27 第六批, v0.7.29）

业主要求：「把定妆照的裁切改为 9:16,同时把生图也锁定 9:16 的 1.03M 的那个分辨率」,并追加「定妆照强行裁切到 9:16 比例,并且压缩到高度 1024,而且所有角色的定妆照都应该是 9:16 并且压缩到高度 1024,这样统一标准」。**要改的两处都只是"标准",两个真根因不在这两处。**

| # | 根因 | 判据（实测） | 修法 |
|---|---|---|---|
| A | **参考图被压扁**：vibedraw 插件 2.3.0 新加的预缩节点用了 `ImageScale` + `crop:"disabled"` = **强制拉伸**,而 `reference_box()` 又拿**画幅的比例**算框 ⇒ 3:4 的定妆照被压进方框 | 读容器内源码:`TextEncodeQwenImage21.execute()` 自己用 `ratio = samples.shape[3]/samples.shape[2]`（参考图**自身**比例）+ `common_upscale(..., "disabled")`;2.2.0 的家族文件**没有参考图这条路径**（`git show 2705ef0:…/qwen_image.py` 156 行）⇒ 是 2.3.0 引入的 | 插件侧（vibedraw 仓）:新增 `graph.scale_to_pixels` = `ImageScaleToTotalPixels` + `resolution_steps:32`（按**面积**缩、保比例）,`reference_box` → `reference_megapixels(edge)`。见 `vibedraw/plans/cvp-plan.md` §5.7 |
| B | **还在请求方形画幅**：卡片上的能力目录是**发现当时**的快照,`discoverImage()` 只在测试连接时读 `/cvp/info` | A1X 出图记录 `render_00005..00013` **全部 1024×1024**,含插件升级**之后** 01:59 那张 | `app/services/draw.js` 新增 `refreshCatalogs()`:启动时静默重读一次 image 卡片目录（`persist:true`,插件没开/没网一律静默）;`app/app.js` 不 `await` 地调它 |

**定妆照统一标准（`app/components/ui.js`）**：`cropPortrait` = `aspect: 9/16, outputWidth: 576, outputHeight: 1024`;`cropPicture` 新增 `outputHeight`（取景框是整数像素,由它反算会漂零点几像素,统一标准必须写死）。三个数各有来由:9:16 = 生图画幅比例;长边 1024 = `REFERENCE_MAX_EDGE`（不再被重编码一次）;0.59MP 比原来的 3:4@768（0.79MP）**更小**。取景框仍可拖动缩放 —— "强行"的是**比例**,不是构图。**存量 3:4 定妆照不自动重裁**（那会丢掉用户当时的取景）;插件修好后它们不再被拉变形,只是构图比例与画幅不同。

**顺带补的闸（§7 的预算约束一直没实现）**：协议 v1 原文「Messages larger than 256 KiB … are rejected … answered with `E_QUOTA` … Large binary data moves through logical file IDs … `network.request({bodyLogicalFileId})`」。`app/services/draw.js` 的 `downscale` → `encodeWithin(image, maxEdge, budget)`,按 **`toDataURL` 的真实串长**判 `REFERENCE_BUDGET = 240 KiB`,超了把画幅 ×0.85、质量 −0.08,最多六次（数学上必然收敛）。它同时保护**存量**的 0.79MP 定妆照。

**设备侧（A1X）**：`families.qwen_image_21.reference_edge` 由 `"512"` 改为 `"1024"`（业主直接定,不做对比测试）。代价已如实上报:参考图 latent token 由约 4032 → 16128（**4×**）;且 0.59MP 的定妆照会被**放大**到约 1MP 预算（插值不出新细节）。要吃满 1MP 需同时把定妆照提到 768×1344 **且**传输改走 `bodyLogicalFileId`。

**验证**：`verify.mjs` 114 断言 / 47 JS / 44 引用 / `package.test.py` 3 tests / `ui-flow.mjs` 17 段 / `i18n-ui.mjs` / `check-i18n --check`（退出码 0）全绿;设备侧回读 `ui.js` 与 `draw.js` 确认特征串在场。新增门禁 6 条:定妆照必须 9:16 且尺寸写死、`cropPicture` 必须认 `outputHeight`、`REFERENCE_BUDGET` 必须在、预算必须按真实串长判、`refreshCatalogs` 必须导出且启动时被调用。



### 12.10 沉浸模式要"有背景图"才成立 + 关闭按钮的反色阴影（2026-09-27 第七批, v0.7.30）

两条都是业主当场提的观感修订,分别落在 `app/features/chat.js` 与 `styles/tokens.css` + `styles/app.css`。

**① 沉浸模式的前置条件**（业主原文:「如果对话界面没有背景图片,点击空地就不要隐藏 UI 元素。只在有背景图的时候才有隐藏控件和显示控件的机制」）

- 原来 `setChromeHidden(target, hidden)` 无条件接受 `hidden`,只认"点的是不是空白"。没有背景图时把控件全收掉,只剩一块空色 —— 没有任何可看的东西,纯负收益。
- 修法:`var next = Boolean(hidden) && hasBackgroundImage();`。新增 `hasBackgroundImage()` = `Boolean(appliedBackground && appliedBackground.kind === 'image')`。
- **判据放在 `setChromeHidden` 里,而不是监听器里**:恢复与清理两条路径传的都是 `false`,`false && …` 恒为 `false` ⇒ 无论有没有背景图,"恢复"和"离开对话时清掉"都能成立。放进监听器则会漏掉清理路径,把隐形状态带到下一页。
- `hasBackgroundImage` 只认 `kind === 'image'`;**内置渐变不算** —— 那一档同样没有照片可看。它是函数声明、会被提升,供 `applyAppBackground()` 里赋值的 `appliedBackground` 之后调用没有问题。

**② 全屏看图关闭按钮的反色阴影**（业主原文:「右上角的关闭按钮要有反色阴影,你确保纯黑纯白底图上正常可见」）

- 单一方向的描边必然有一端看不见 —— 纯白图吞掉白描边、纯黑图吞掉黑描边 —— 所以两圈**缺一不可**:`1px` 的深色实心圈紧贴字形（纯白图上把白字形勾出来）+ `2px` 的浅色实心圈在它外面（纯黑图上把按钮托出来）。两圈都是"向外扩的实心描边"（与 `--text-halo-shadow` 同一条形状规矩,不用模糊光晕）。
- 它与已有的 `--text-halo` / `--text-halo-shadow` **不是一套,不许合并**:后者**跟主题走**（明暗两块各覆盖一次 `--text-halo`）;这套**不跟主题走** —— 看图那一层恒为深底、按钮又压在图片上,两侧都可能撞色。所以 `--viewer-halo-invert` / `--viewer-halo-contrast` 只在 `:root` 基础块定义一次,**深色主题块不许覆盖**（一覆盖就退回单方向）。
- `text-shadow` 可继承 ⇒ 设在 `.image-viewer-close` 上,内部字体图标 `<i class="fa-solid fa-xmark">` 自动吃到。

**新增静态门禁 5 条**（`tools/verify.mjs` §6b）:关闭按钮必须吃 `var(--viewer-halo-shadow)`；该变量必须含 1px 深色向与 2px 浅色向（两圈都在）；`--viewer-halo-invert` / `--viewer-halo-contrast` 的定义各自**只能有一处**（深色块不许覆盖）。

**验证**：`verify.mjs`（114 subtests,fail 0）/ `ui-flow.mjs`（沉浸模式段改成"没有背景图时点空地什么都不发生 → 设了背景图才隐/恢复"）/ `i18n-ui.mjs` / `check-i18n --check`（退出码 0）全绿;设备 `.26` 回读 `chat.js` HIT `function hasBackgroundImage()` 与 `var next = Boolean(hidden) && hasBackgroundImage();`、`tokens.css` HIT 两个新变量且**定义计数各为 1**、`app.css` HIT `text-shadow: var(--viewer-halo-shadow);`。

### 12.11 看图工具栏 / 缩略图 2/3 / 长按藏控件 / 绘图与对话解耦 / 生成中的停止按钮（2026-09-27 第八批, v0.7.31）

> 本节覆盖 §12.10 ②：业主当天又提「右上角关闭按钮去掉」，那个按钮连同它的反色阴影一起作废（`--viewer-halo-*` 三个变量已从 `tokens.css` 删除）。§12.10 ② 留在上面只作历史记录。

业主原话（同一条里说了四件事）：「生成图的气泡中的缩略图变小一些,变为现在的2/3高度左右。全屏查看生成图界面,右上角关闭按钮去掉。底部提示词去掉,底部增加一个磨砂背景的工具栏,三个icon-文字按钮:下载、设为背景、关闭。另外,我发觉定妆照裁切之后点保存,会卡住,但背景选图片裁切就不卡,请你看看定妆照操作是不是哪里需要优化。」后面又追加了三条（长按藏控件 / 退出对话不停绘图 / 生成中加停止按钮）。

#### ① 缩略图 2/3 → `213px`（`styles/app.css`）

`.message-image img { max-height: 213px }`（原 320）。顺带**与「画图中」的 216px 占位方块对齐** —— 真图 320 一出来列表要跳一下，213 与 216 基本同高，出图时那一条不再长高。

#### ② 看图只剩一条工具栏（`app/components/image-viewer.js` + `styles/app.css`）

- 改动前：右上角一个 `.image-viewer-close`，底部一行 `.image-viewer-caption`（提示词/alt 文本）。
- 现在：底部一条 `.image-viewer-toolbar`（磨砂底 `backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate))`），里面三个 `.image-viewer-action`（icon 在上、文字在下）：`download` / `background` / `close`。`settings.onDownload` / `onSetBackground` 缺哪个就把哪个 `hidden`（**不留点了没反应的按钮**）。**当天第三轮又把它从"铺满底边的横条"改成"浮在画面上的小工具箱"，见本节 ⑧。**
- `settings.caption` / `settings.closeLabel` 已从组件里**整条删掉**，`grep caption` 在组件内为 0。
- **在途闸**：`var acting = false; function runAction(handler) { if (!handler || acting) return; acting = true; … }`。下载要唤起宿主的系统选择器、设为背景要写库，连点两下会开出两个选择器。
- 图标与文字之间显式 `gap: 0` + `margin-right`：本项目 WebView 是老 Chrome，flex 的 `gap` 不可靠，写死 margin 才不会因环境变成"贴着字"或"两倍间距"。

#### ③ 两个新动作（`app/features/chat.js`）

- `exportMediaImage(media)`：先 `mediaLogicalFileId(media)`（生成图在 `message.media[]` 里只有 `{ mediaId }` ⇒ 先 `app.data.media.get()` 取记录再读 `logicalFileId`），再 `api.files.export({ logicalFileId })` = 系统 `ACTION_CREATE_DOCUMENT`，让用户自己挑保存位置，**字节由宿主直写、不经过页面**。
- `useMediaAsBackground(media)`：**只写 `mediaId`、不写 `url`**，`layout: null`。理由：`backgroundImageUrl()` 见到 `url` 才会按取景参数算 `size`/`position`，而这里根本没有取景参数 —— 写了 `url` 就会被按 1:1 推出一个放大过头的尺寸。只给 `mediaId` 时 `backgroundImageUrl` 返回空串 ⇒ size/position 都不写，落到 CSS 的 `cover / center`。`store.releaseMedia` 是**引用计数**：消息仍引用时复用同一文件不会误删。
- **闭包陷阱（本轮主动发现）**：`messageElement` 的 `for (var i…)` 里 `var media = message.media[i]` 是函数作用域 ⇒ 监听器直接引用会让所有图片按钮拿到最后一条。原监听器只读 `event.currentTarget` 所以一直没露头；现在要把 `media` 交给下载/设背景，必须 IIFE 定住：`imageButton.addEventListener('click', (function (entry) { return function (event) {…}; })(media));`

#### ④ 沉浸模式改成不对称手势（`app/features/chat.js`）

业主原文：「对话界面点按空白隐藏UI控件,改为长按空白处隐藏,恢复显示只要点击不需长按」

- 藏 = `LONG_PRESS_MS = 500`（`pointerdown` 起计时）；恢复 = 轻点（`pointerup` 时若还隐着就显示）。原来是一点就藏 ⇒ 滚动时手指落下的那一下、想点气泡边缘却点空的那一下都会把界面收掉。
- `PRESS_SLOP = 12`：`pointermove` 超过容差就 `cancelPress()`（当成滚动）。`pointercancel` 同样清计时器。
- `contextmenu` 只对空白处 `preventDefault()`（长按空白不该顺带弹系统菜单；气泡上的长按仍留给系统复制）。
- 判"空白"的黑名单选择器不变；`setChromeHidden` 里"必须有背景图"的前置条件（§12.10 ①）不变。

#### ⑤ 绘图（action）与对话彻底解耦（`app/features/chat-session.js` + `app/services/draw.js`）

业主原话：「退出对话并不主动停止绘图,绘图应该继续运行,绘制成功后自动填充数据,下次打开时候可以正常看到。除非程序退出或无法继续,才显示失败或停止之类信息。」「action不受对话控制,不因对话停止而终止行为。」

- `stop(id)` **不再碰 `drawTasks`**，只停文本生成与朗读。这是"绘图不占 `tasks[id]`"那条设计的另一半。
- `recover(id)`：`var drawing = Boolean(drawTasks[id]);`，`if (status === "drawing" && drawing) continue;`。漏这一条 ⇒「退出对话 → 再进来看看画好没有」会把正在画的图当场判成"已中断"，之后真画完还会覆盖这个判断（界面先报错再突然变出图片）。
- `runDraw()` 落库前查对话是否还在：`if (!(await store.get("conversations", id))) { await store.releaseMedia(message.media); return; }`。绘图现在活得比对话久，"画到一半对话被删"成为真可能，不加这行会留下孤儿记录与没人释放的字节。
- 新增 `cancelDraw(id)`（**只**取消绘图，不碰文本）：`task.cancelled = true; task.controller.abort();`，返回 `false` 表示此刻没有在跑的绘图。导出为 `app.features.chatSession.cancelDraw`。
- `app/services/draw.js`：用户取消时**尽力通知插件取消**（`POST /cvp/jobs/<id>/cancel`，不 `await`）—— 否则本地已经放弃，显卡还会继续烧到画完。超时那条路本来就在做同一件事，两处不能合并（这里是主动放弃，那里是等不到结果）。

#### ⑥ 生成中那一条下面的「停止」按钮（`app/features/chat.js` + `styles/app.css`）

业主原话：「生成过程中的生图消息气泡下面增加停止按钮,角色消息在生成的过程中下面也增加停止按钮,都是用来停止模型生成的。」

- 位置：`message.status === 'pending' || 'drawing'` 时，在 `.message-meta`（时间旁边）追加 `.button.ghost.message-stop`，`data-stop-generation` = `pending` / `drawing`。
- **为什么放 `.message-meta` 而不是气泡里**：流式增量走 `applyMessageDelta`，它会把新建的 `.message-text` **追加到气泡末尾** ⇒ 按钮若在气泡里，正文会长到它下面去。meta 就在气泡下方，与「重试」按钮同一层语义。
- 两条路径**各走各的开关**（这是把按钮分成两处的全部理由）：`pending` → `session.stop(id)`（顺手停自动朗读）；`drawing` → `session.cancelDraw(id)`。而且两者**可以同时在跑**（正文还在流式输出时，上一轮那张图已经在画），一个按钮不该顺手掐掉另一条。
- `.message-stop { gap: 0; min-height: 32px; padding: 5px 12px; font-size: 12px; }` —— 跟着 meta 这一行的 32px 走，**不用** `.button` 默认的 44px：消息一完成这一行就从 44 掉回 32，列表会跳一下。

#### ⑦ 定妆照保存卡顿（`app/features/roles.js`）

- 起因（业主）：「定妆照裁切之后点保存,会卡住,但背景选图片裁切就不卡」。根因是**两条路的成本差**：背景走 `mode:'framing' + keepSource:true`，**不编码、不上传**，只交出 `{ zoom, imageAspect, frameAspect, panX, panY }` ⇒ 点保存瞬时；定妆照必须编码 576×1024 JPEG + 整张 `uploadBlob`（`beginWrite`→`appendBytes`×N→`finishWrite`）+ 把同一份字节 `blobToDataUrl` 成 base64 **仅用于预览**。
- 修法（`stagePortrait(output)`）：先用本地 `URL.createObjectURL` **立刻**预览，上传在后台跑，落地后换宿主地址；**不再 `blobToDataUrl`**（那一整份 base64 只为了预览，纯浪费）。`objectURL` 在换成宿主地址后 `revoke`。
- `[data-choose-portrait]` 监听器与 `onSubmit` 都先 `await portraitUpload.catch(...)` 再继续 —— 上传不挡预览，但提交/重选必须等它落地，否则会漏下一份字节。

#### 验证（全绿）

`node tools/verify.mjs` **114 subtests / fail 0**；`CHATAXI_DOM_MODULE=… node tests/ui-flow.mjs` **18 段**；`CHATAXI_DOM_MODULE=… node tests/i18n-ui.mjs`；`node tools/check-i18n.mjs --check`（退出码 0，**1068 键 / 83 规则，UNCOVERED 0**）。

- **换掉的悬空门禁**：`verify.mjs` §6b 原来 5 条断言守的是 `--viewer-halo-*` 与 `.image-viewer-close`；按钮被撤掉后它们仍然"存在且会红"，但语义已经作废 ⇒ 整段换成工具栏 / 缩略图 / 停止按钮门禁。**教训：删掉选择器时必须同时删掉守它的断言**，否则要么永远红（噪声），要么被顺手注释掉（等于没有）。
- **新增运行时验证（`tests/ui-flow.mjs`）**：看图段改为断言工具栏三个 `data-viewer-action` 就是 `['download','background','close']`、`.image-viewer-caption` 与 `.image-viewer-close` 都不存在、没给回调时只剩 `close`；沉浸模式段从 `click` 改成**真实 pointer 手势**（`pointerdown` + 真等 580ms + `pointerup`），覆盖"轻点不藏 / 长按才藏 / 轻点恢复 / 挪动取消 / 长按消息不算"；新增一段"点生图消息上的停止 ⇒ 假插件真的收到 `task.cancelled`、消息落成 `cancelled`、按钮消失"+"正文那一条的停止**不许**掐掉同时在跑的绘图"。
- **设备 `.26` 回读**（`hermit_read_dev_file`，revision **38**）：`chat.js` HIT `message-stop` / `session.cancelDraw` / `停止生成` / `dataset.stopGeneration`；`chat-session.js` HIT `function cancelDraw`；`app.css` HIT `message-stop` / `max-height: 213px`；`i18n-en.js` HIT `正在停止绘制` / `Stop generating`；`draw.js` HIT `/cancel` 通知；`hermit.json` / `namespace.js` HIT `0.7.31`；`image-viewer.js` HIT `image-viewer-toolbar` / `data-viewer-action`；`roles.js` HIT `stagePortrait`。
- **版本四处同步**：`hermit.json` / `app/core/namespace.js` / `README.md` / `~/hermit/happ-dev.json` 一致 = **`0.7.31` / code `110`**。

#### ⑧ 第三轮补丁：底部工具栏改成浮起的小工具箱（v0.7.32）

业主原话：「全屏查看生成图界面,底部三个按钮要放到一个圆角矩形容器里面,紧凑横向排列,一个小工具箱浮在画面上面。」

**只改 CSS，组件与事件一行未动** —— 三个按钮的 DOM（`.image-viewer-toolbar` + 三个 `.image-viewer-action` + `data-viewer-action`）与回调契约本来就是这一轮要的形状。

- 横条 → 浮层：`right: 0; bottom: 0; left: 0`（铺满底边）改为 `left: 50%; transform: translateX(-50%); bottom: calc(16px + var(--safe-bottom));`，**宽度由内容决定**。加 `border-radius: 18px` + `padding: 4px` + `box-shadow: 0 8px 26px #00000052`（浅色画面上玻璃边会消失，投影把它托起来）；底色 `#101210a6 → #101210c4`（浮层面积小了，得稍微实一点才压得住照片）。
- 紧凑横排：每个按钮 `flex: 0 0 auto; min-width: 68px`（兜住「设为背景」四个字），图标 18 → 17px、文字 12 → 11px、内边距收紧；**相邻按钮之间 `margin-left: 2px` 而不是 flex `gap`**（老 WebView 红线，与 §12.11 ② 同一个理由）。
- **门禁同步换掉**：原来那条断言写的是 `.image-viewer-toolbar { … bottom: 0; … var(--safe-bottom)` —— 形状改了它就永久红。换成三条：圆角浮层（`border-radius: 18px`）、让开安全区（`bottom: calc(16px + var(--safe-bottom))`）、居中靠 `left:50% + translateX(-50%)`；外加一条**反向**断言 `doesNotMatch /\.image-viewer-toolbar \{[^}]*left: 0;/`，防止哪天又写回铺满底边的横条。两条几何断言拆开写、不串成一条 —— 声明顺序不该被门禁锁死（串起来的第一版就是这么红的）。
- 验证：`verify.mjs` 114 / fail 0，`ui-flow.mjs` 全绿（看图段断言三个 `data-viewer-action` 仍是 `['download','background','close']`，与容器形状无关，所以不用改）。设备回读 `app.css` HIT `border-radius: 18px` / `bottom: calc(16px + var(--safe-bottom))` / `min-width: 68px` / `.image-viewer-action + .image-viewer-action`。版本 → **`0.7.32` / code `111`**，四处同步。

#### ⑨ 第三轮补丁：「设为背景」必须先确认（v0.7.33）

业主原话：「全屏看图界面,设为背景按钮需要弹窗提示确认后生效。」

- `useMediaAsBackground(media)` 里先 `await ui.confirm({ title: '设为对话背景？', message: '这张图片会成为当前对话的背景, 铺满整个界面。', confirmText: '设为背景' })`，`if (!confirmed) return;` 之后才 `saveChatBackground(...)`。理由：它改的是**对话设置**，而且一设就铺满整个界面 —— 在看图时误触一次，用户得再进对话设置里换回来。取消就什么都不做，看图这一层照旧开着。
- **顺带发现并修掉一个看不见的层级缺陷**：`.image-viewer` 原来是 `z-index: 80`，比弹窗（`.modal-backdrop` 50）与叠在弹窗上的一层（`.subsheet-backdrop` 55）**都高** ⇒ 确认框会开在照片背后。代码上完全看不出来（组件各写各的层级），只能靠"算出来的不等式"拦。改成 **45**（内容层），并写死阶梯：`.app-shell` 0 / 顶栏 20 / 输入区 25 / **看图 45** / 弹窗 50 / 叠弹窗 55 / 提示条 70。**判据：看图自己的动作一旦需要弹窗，这一层就只能在弹窗之下。**
- 门禁（`verify.mjs`）：① `confirm` 必须出现在 `saveChatBackground` **之前** —— 顺序才是这条要求的全部，只判"出现过 ui.confirm"，一个"先写库再问"的实现也能过；② 三条**从 CSS 里读出来**的层级不等式（`viewerLayer > 25`、`viewerLayer < dialogLayer && < subsheetLayer`、`dialogLayer >= 50 && subsheetLayer > dialogLayer`），两边都取 CSS 里的真值而不是把数字再抄一遍 —— 抄一遍的断言，改回去照样绿。任一选择器被改名 ⇒ 读到 `NaN` ⇒ 同样在这里失败。
- 运行时验证（`tests/ui-flow.mjs` 新增第 4 段）：真的点开气泡缩略图 → 按「设为背景」→ 断言确认框标题；**取消路径**用 `click('.modal-backdrop')` 让 promise 落回 `false`，断言"看图还开着 + 对话记录一字未改"；**确认路径**走 `submit()`，断言背景真写进去、`mediaId` 对、`url` 为 `undefined`（写了 url 会被按 1:1 取景推出放大尺寸）、看图自己收起来、提示条出现。
- **写这段测试踩到的两个坑**（都不是源码问题，是测试自身的）：① `renderMessages` 按**消息签名**做节点缓存（`chat.js:313`）⇒ 等渲染完再装 `displayUrl` 桩，缩略图那一格仍然是"图片不可用"；**桩必须赶在这一段的第一次渲染之前装上**。② 这一段故意留下了对话背景，而后面有"没有背景图时长按空地也不许收控件"的段落依赖"当前对话没有背景" ⇒ **结束时必须还原 `background` 并 `refreshAppBackground()`**，否则错误会报在别人那一行上，查起来极易跑偏。

#### ⑩ 第四轮补丁：停止按钮去轮廓 + 工具箱更透（v0.7.33）

业主原话（两条，同一批）：「气泡下面那个停止按钮不要有轮廓。」「全屏看图底部工具箱的背景更透明一些。」

- **去轮廓要在两处各扣一半，缺一处就原样回来**：① `chat.js` 不再挂 `ghost` —— 那是唯一给它上边框的东西（`.button` 自己只有 `border: 1px solid transparent`，只给宽度、不给颜色）；② `app.css` 的规则必须写成 **`.button.message-stop`**，只写 `.message-stop` 是 `(0,1,0)`，压不过 `components.css` 的 `.button.ghost { border-color: var(--border); }`（`(0,2,0)`）—— 而 `app.css` 排在 `components.css` 之后，**同权重才轮得到顺序说话**。1px 的宽度仍在，所以行高逐像素不变、消息完成时列表不跳。
- 视觉理由也记一笔：那一行里另外几个动作（编辑 / 重新生成 / 删除）都是无框的 `icon-button`，只有停止按钮一个带框，看着像另一个物种。
- 工具箱底色 `#101210c4`（196/255 ≈ 77%）→ **`#10121099`（≈ 60%）**。再往下调就要动文字可读性了：标签是 `#f2f2ee` 的 11px，压在浅色照片上本来就靠这层深底撑着 —— 60% 是"看得见画面、又还能读字"的平衡点。代码里留了这句，继续降之前先在真机上对着亮图看一眼。
- 门禁（`verify.mjs`）：`assert.match(chatSource, /className = 'button message-stop'/)`；`assert.match(styles, /\.button\.message-stop \{[^}]*border-color: transparent;/)` **必须用这个等权选择器**；透明度的判据是**读出来的 alpha 比原来小**（`parseInt(hex,16) < 0xc4`，取不到就是 `NaN` ⇒ 也失败），不是把新数值再抄一遍。
- 验证（全绿）：`verify.mjs` **114 / fail 0**；`ui-flow.mjs` **18 段**；`i18n-ui.mjs`；`check-i18n --check` 退出码 0。设备 `.26` `sync-dir` ⇒ **revision 40** / `committed` / `runtime-recreated`，差异集 5 个文件（`app/core/namespace.js`、`app/data/i18n-en.js`、`app/features/chat.js`、`hermit.json`、`styles/app.css` —— 含上一批未推的 i18n 六键）；`hermit_read_dev_file` 回读 `hermit.json` HIT `0.7.33` / `112`，`app.css` HIT `#10121099` / `.button.message-stop` / `border-color: transparent`，`chat.js` HIT `button message-stop` / `设为对话背景？` / `if (!confirmed) return;`，`i18n-en.js` HIT `设为对话背景？`。版本 → **`0.7.33` / code `112`**，四处同步。

#### ⑪ 生图提示词重写：堵死「用文字代替照片」（v0.7.34）

业主原话：「还是要研究一下措辞，要让大模型知道用户向它要照片、想看它的样子、让它拍照、画它的样子……决不能用文字描述替代照片，如果要响应用户的要求，就应该调用生图工具来实现生图，撰写提示词。（你来规划如何引导她撰写简明扼要但又高效的提示词）」。现场症状：「它仍然经常会用文字回复说 XXXX, 发送了一个图片：23岁……还带文件地址 /hermit/….」

**根因不是提示词写得不够狠，是模型在自己的历史里看到了那句样板。** `llm.js` 的 `drawNote()` 把一条绘图消息写进 assistant 的历史：

```
发送了一个图片：<prompt>, 文件地址是：/__hermit/files/<id>
```

模型读到的是「我上一次发图时说的就是这句话」，于是下一轮要图时**照抄**它 —— 用户拿到一段文字加一个地址。所以修法必须是两处一起，只改提示词挡不住（提示词说「要画图」，历史里摆着一个现成的「发图句式」）。

- **`llm.js` `drawNote()`：断掉样板。** 改成 `[系统附注] 你的上一条回复附了一张已生成的图片, 画面：<prompt>`。两件事：① 用方括号标明这是**系统附注而不是模型说的话**；② **不给地址** —— `/__hermit/files/<id>` 那个 URL 形态本身就是被抄走的那半截，而模型并没有任何事需要用它（它要知道的只是「上一轮有张图、画的是什么」，提示词已经说全）。**代价：模型不再知道那张图"存在哪"；这是有意的取舍，因为它从来也没法取用。**
- **`draw-prompt.js` `instruction()`：把判定写成二值的，并点名禁掉伪交付。** 新增的核心是「**每一轮只有两个选项，没有第三个**」：A 不需要画面 ⇒ 正常回话；B 要给画面 ⇒ **必须写动作块**；**没有 C** —— 把画面用文字描写一遍、写「发送了一个图片：…」、附地址或编号来充当照片，全部算错。规则 5 逐条点名：「发送了一个图片：…」「图片地址是：…」、任何 `/hermit/…` 路径或附件编号、`(图片)`、`[图片]`、`见下图`、`图片已生成`、`我已经发给你了`；并明说 `[系统附注]` 那几行是**系统写的、不许照搬**。触发词表也补全了「拍张照」「你长什么样」。
- **prompt 撰写法（业主点名要的那部分）：从"一个字数区间"升级成"一套写法"。** 四段骨架 —— **谁在做什么**（具体到容貌、发型、穿着、表情、动作）→ **在哪、周围有什么** → **光与色调** → **画风**（一个短语）；核心判据是「**信息密度比长度重要** —— 宁可 60 个字全是具体名词，也不要 120 个字都是漂亮的空话」；另外四条硬要求：具体名词压过抽象形容词（「白色吊带连衣裙」而不是「很好看的衣服」）、一个主体一个动作、**不写否定句**（要「短发」不要「不要长发」；绘图模型对否定项处理很差，经常照画）、同一角色的容貌与穿着始终用**同一套词**（否则每张图看起来像换了一个人）。
- 标点按业主规范（2026-09-23）把整个文件统一成半角逗号。
- 门禁（`verify.mjs`）：`drawNote` 的判定只切**函数体**（它的说明注释在函数之前，从 `function drawNote(message) {` 往后切就全是代码），断言里面既没有那句样板也没有地址形态，并带一条"切出来的范围越界"的自检；提示词侧 11 条 —— 二值判定、点名禁止、`[系统附注]` 不许照搬、四段骨架、密度判据、具体名词、不写否定句、同一套词。**换掉了两条旧门禁**（原来是 `/"发送了一个图片：" \+ prompt/` 与 drawNote→`objectAddress`），它们守的正是要删掉的那两样东西。

#### ⑫ 消息列表缩略图懒加载（v0.7.34）

业主原话：「消息列表图片很多的时候，进入对话会因为图片太多而比较慢，需要懒加载，只要保障消息内缩略图 9:16 正常高度占位符就可以。」

- **慢在哪**：`messageElement` 里对每一条 media 都 `await app.data.media.displayUrl(media)`（每次都要读一次库），而整条渲染链是**串联**的 ⇒ 进对话要先等 O(N) 次读库才画出第一屏；紧接着所有 `<img>` 一起开抢。所以只加 `loading="lazy"` 是没用的 —— 它只管网络，管不住前面那 O(N) 次读库。
- **改法**：渲染时只摆一个占位盒（`data-media-pending="1"`），地址与 `src` 都挪到 `loadThumb(button)` 里，由 `IntersectionObserver`（`rootMargin: 600px 0px`，上下各留一屏多的余量）在快进视口时驱动。观察器是**单例**；没有 IntersectionObserver 时 `imageLazy()` 返回 `null` **且不缓存**，`watchThumbs` 退化成"立刻加载"（老的 WebView 不能因为新增的能力缺失就永远不出图）。取过的立刻 `unobserve`，并顺手把已经下线的节点摘掉，别让观察器攥着它。
- **占位盒只能长在按钮上**：`213 × 9 ÷ 16 = 119.8` ⇒ `.message-image[data-media-pending] { width: 120px; height: 213px; }`。**不能靠 `<img>` 的 `width`/`height` 属性占位** —— 还没赋 `src` 的 img 没有内在比例，属性只会退化成默认的 300×150 盒子，`max-height: 213px` 再一压就成了 2:1，比加载完跳得还厉害。非 9:16 的用户照片在 `image.onload` 摘掉属性之后回到基础规则（宽度按自身比例算，仍占满 213px 高）。
- 「取不到地址」从"渲染时"挪到了"进视口时"（`unavailableThumb` 换成原来那行说明）—— 没看到的那几张，用户本来也不知道它们坏没坏。
- 门禁（`verify.mjs`）：`loadThumb` 里必须有 `displayUrl`；必须有 `new IntersectionObserver` 与 `rootMargin`；必须有"没有观察器就立刻加载"的降级分支；渲染完必须有 `watchThumbs(inner)`；CSS 两条占位几何；外加**反向**断言 —— 消息媒体渲染循环里不许再出现 `displayUrl`（循环边界用注释锚点卡死、先滤掉行注释，因为循环内的说明正引用了这个名字）。
- **运行时验证（`ui-flow.mjs` 新增第 5 段，两条静态门禁证明不了的）**：给沙箱补一个假的 `IntersectionObserver`，数 `displayUrl` 被调了几次 —— 渲染完 **0 次**、喂一次相交变 **1 次**、之后再滚动不会重复取。**写这段时踩到的坑**：① 沙箱里本来没有 IntersectionObserver，前面几轮渲染已经走降级路把这张缩略图加载过了（标记从 `1` 变 `2`），观察器不会再选它 ⇒ 必须先让记录真的变一次（改 `updatedAt`）逼出**新**节点；② `renderMessages` 按消息签名复用节点，签名不变就没有新缩略图可观察。
- 验证（全绿）：`verify.mjs` **114 / fail 0**；`ui-flow.mjs` 全段；`i18n-ui.mjs`；`check-i18n --check` 退出码 0。设备 `.26` `sync-dir` ⇒ **revision 41** / `committed` / `runtime-recreated`，差异集 6 个文件（`namespace.js`、`chat.js`、`draw-prompt.js`、`llm.js`、`hermit.json`、`app.css`）；回读 `hermit.json` HIT `0.7.34` / `113`，`draw-prompt.js` HIT `没有 C。` / `正文里绝对不许出现这些写法` / `信息密度比长度重要` / `不是你自己说过的话`，`llm.js` HIT `[系统附注]`，`chat.js` HIT `IntersectionObserver` / `data-media-pending` / `rootMargin: LAZY_ROOT_MARGIN` / `watchThumbs(inner)`，`app.css` HIT `120px; height: 213px`。版本 → **`0.7.34` / code `113`**，四处同步。
