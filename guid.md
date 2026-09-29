# guid.md — Chataxi（写给插件的短说明）

开发这个 happ 之前读一遍就够了。这里只讲这个项目本身：技术思路、目录、注意事项、怎么自检。

## 技术思路

- 定位：HaminnApp 里的个人 AI 对话 happ。重心是真人感的流式语音和真正的多角色群聊 —— 比 chatbox 更强大，比 chatterUI 更好用。
- 形态：纯原生 HTML / CSS / JavaScript，无框架、无 npm 运行依赖、无编译步骤，源文件直接运行。
- 配置极简：粘贴 API Key 就能接通模型。地址、模型名始终可编辑；数据、密钥、录音都留在本机 happ 隔离区。
- 一张模型卡只代表一个具体模型：`API Key → 获取目录 → 选模型 → 连接测试 → 保存`。旧版"一个服务含多个模型"的数据会幂等拆成多张单模型卡。
- 协议：OpenAI Responses 首选，Chat Completions / Anthropic Messages / Gemini GenerateContent / Ollama Chat 走显式适配器；无法确认 system 能力的模型降级为带 `[角色与用户设定]` 标记的 user 内容。
- 语音：Android 系统朗读与系统语音识别是默认服务；第三方走 ElevenLabs、OpenAI Speech、豆包等流式通道。
- 角色有两个独立字段：**身份性格**（`systemPrompt`，描述"是谁"）与**行为指导**（`behaviorGuidance`，约束"怎么说话、怎么推进对话"）。模板自带行为指导，主持人选人时也会读到它。两者不要合并。

## 目录结构

```
index.html            入口
haminn.json           包清单（schema 2，happId life.airen.chataxi）
guid.md               本文件
app/app.js            启动与装配
app/core/             namespace / events / i18n / utils，纯逻辑不碰 DOM 与宿主
app/data/             store / i18n-en / role-templates（生成物）/ media
app/features/         chat / chat-session / conversations / roles / models /
                      model-single-editor / me / settings，按用例编排
app/platform/         haminn.js（Bridge 唯一出口）/ network.js
app/services/         llm / tts / asr / context（压缩）/ providers / model-registry /
                      model-services / middleware / catalog / profiles / images /
                      media-prep / aws-sigv4
app/components/ui.js  弹窗、Sheet、Toast、图标等通用组件
styles/               tokens / base / components / app
```

不进运行包：`templates/`（角色模板源 JSON 与拼图）、`tools/`、`tests/`、`docs/`、`plans/`、`release/`。
运行包只有 `index.html`、`haminn.json`、`guid.md`、`app/`、`styles/` —— 清单在 `tools/package.py` 的 `RUNTIME_ROOTS`。

## 开发注意

- 依赖方向固定 `core → platform → services → components → features`；`components/` 只管 DOM 与语义事件，`features/` 管编排，`services/` 管适配，**只有 `platform/` 碰 Bridge 与网络**。
- 对话历史严格是「压缩概要 + 最近 k 条」。k 不逐对话配置：每轮从最新一条往前累加字数，刚超过设置里的「压缩保留字数」（默认 4000，2000–10000）就是 k，最少 2 条。角色与用户设定每轮重新组装，**不参与压缩**。
- 群聊每轮只触发用户选定的那一个角色一次，不建立无界自主互聊；主持人固定排在角色列表首位。
- 旧 Android WebView 兼容：**flex 的 `gap` 在这类设备上不生效**，横向间距一律用相邻兄弟 `margin` 或 grid。
- 模型返回的文本按纯文本安全渲染；不执行模型返回的代码、HTML、工具或链接。外部请求由用户逐 Origin 授权，公网必须 HTTPS，HTTP 只允许可信局域网。
- API Key 只在用户明确保存后写入本 happ 数据区，永远遮罩显示，不写入源码、日志、文档、测试或提交。
- 新增界面文案必须同时补 `app/data/i18n-en.js`，否则 `tools/check-i18n.mjs` 会失败。
- 改角色模板走生成链路：`templates/char/*.json` 是源，`app/data/role-templates.js` 与 `app/assets/role-templates/` 是生成物，用 `tools/sync-role-templates.mjs` 同步，不要手改生成物。
- 所有编辑、菜单、枚举都用横向铺满的底部 Sheet，不调用系统原生列表菜单。

## 自检

- 改完先跑 `node tools/verify.mjs`；只改文案时跑 `node tools/check-i18n.mjs`；提交前跑 `python3 tools/check-secrets.py` 确认没有凭据泄漏。
- 发布：`python3 tools/package.py` 生成 `release/Chataxi-v<版本>.zip` 并同步 `haminn-install.json` 的路径与 sha256；版本号要同步 `haminn.json`、`app/core/namespace.js` 与 `README.md`。
- 真机：`python3 haminn-agent.py --address <设备地址> develop-dir <目录> --quiet` 同步，`update-dir ... --bump patch` 装稳定包。本仓 `AGENTS.md` 有完整验收口径。
