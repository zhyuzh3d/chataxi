# Chataxi

Chataxi 是运行在 [Haminn](https://haminn.airen.life/) 宿主里的个人 AI 对话 happ。它用纯原生 HTML,CSS,JavaScript 写成,不依赖任何运行时框架,npm 或编译步骤,源文件就是可直接运行的页面。

产品定位是「比 chatbox 更强大,比 chatterUI 更好用」：重心是真实的流式真人感语音和真正的多角色群聊,配置上只要粘贴 API Key 就能接通模型,模型和数据放在哪里由你自己决定。

> 产品网站：<https://chataxi.airen.life/> · 应用广场：<https://haminn.airen.life/pages/happs.html> · 源码仓库：<https://github.com/zhyuzh3d/chataxi> · [GitHub Releases](https://github.com/zhyuzh3d/chataxi/releases) · [MIT License](./LICENSE)

- happ id：`life.airen.chataxi`
- 当前源码版本：`0.7.55`(versionCode `134`,见 `haminn.json`)
- 形态：HaminnApp 的普通 happ,不能脱离宿主单独安装

## 特性亮点

- **真人感流式语音**：Android 系统朗读与系统语音识别是默认服务,第三方走 ElevenLabs,OpenAI Speech,豆包等流式通道。OpenAI Speech,ElevenLabs HTTP Streaming 与豆包 V3 SSE 会在响应未结束时持续读取 PCM 音频,约三秒缓冲后通过已解锁的 Web Audio 队列开始播放,首片不可用时回退完整音频。
- **真正的多角色群聊**：每轮用户发送只为选定的角色触发一次回复(不建立无界自主互聊),第一个参与角色保存为主持人并固定排在列表首位。输入区的魔法棒可让主持人先按完整上下文决定下一个发言者,预选输出不写入消息历史。
- **一张模型卡只代表一个具体模型**：接入路径是「API Key → 获取目录 → 选择模型 → 连接测试 → 保存」。相同凭据通过本机引用复用,供应商目录单独缓存,复制模型卡可快速选择同账号下的另一个模型。
- **多协议适配**：OpenAI Responses 是统一首选协议,Chat Completions,Anthropic Messages,Gemini GenerateContent 与 Ollama Chat 通过显式适配器转换,无法确认 system 能力的模型统一降级为带 `[角色与用户设定]` 等标记的 user 内容。
- **可控的上下文压缩**：对话历史严格是「压缩概要 + 最近 k 条」。k 不逐对话配置——每轮从最新一条往前累加字数,刚超过设置里的「压缩保留字数」时的条数就是 k(最少 2 条),保证最新的问答始终以原文参与上下文,主持人角色在后台压缩更早的消息,不等待,不打断本轮回复。
- **丰富的角色与场景**：27 个角色模板(全部 / 男性 / 女性 / 其他四类),人物卡展示头像,名称,职业,年龄和性别,每个对话可设「场景设定」,支持手工填写或按闲聊,思辨,学习,工作,倾诉五种模式自动生成开场白。角色有独立字段「身份性格」(`systemPrompt`)与「行为指导」(`behaviorGuidance`),互不合并。
- **本地优先与隐私**：API Key,对话,录音,头像都留在本机 happ 的隔离数据区,密钥永远遮罩显示,只在用户明确保存后写入。外部网络请求由用户逐 Origin 授权,公网必须 HTTPS,HTTP 仅用于可信局域网。
- **对话内生图(CHP)**：角色可以在回复里写一个绘图动作块,由 ComfyUI 的 CHP 插件出图,成图作为单独的图片消息留在对话里。模型卡只填一次插件地址与密码,**走哪条绘制场景由有没有定妆照决定**:角色有定妆照就按图重画,没有就从零画一张,不需要在卡片上选。画幅与参考强度都取插件自报的帧表与默认值,客户端只选不算;接口地址一律从插件的信息文档里读,不许自己拼。
- **安全渲染**：默认不执行模型返回的代码,HTML,工具或链接,模型文本按纯文本安全渲染,图片只接受明确的数据 URL 或 HTTPS URL。
- **整包备份**：系统页提供「备份软件和数据」,调用宿主 `app.backup`,把当前 happ 连同全部记录,附件和本地代码整包导出。
- **中英双语**：界面文案随系统语言切换,新增文案必须同步补齐英文。

## 对话功能视频

点击封面观看 Chataxi 的多角色群聊、自然语音、对话内图片生成与背景灯光演示（YouTube Shorts）：

<a href="https://www.youtube.com/shorts/7vFBZkaJjUM"><img src="docs/assets/chataxi-dialogue-short-thumbnail.jpg" alt="观看 Chataxi 对话功能视频" width="240"></a>

### 界面示意

- 所有编辑,菜单和枚举选择都使用横向铺满屏幕的底部 Sheet,不调用系统原生列表菜单。
- 对话中的角色与用户头像均为圆形,浅黄气泡采用接近常见即时通讯的左右布局与小尖角,点角色头像打开「编辑角色」,点用户头像打开「本对话个人设定」。
- 头像在浅色背景上保留细轮廓,未设置时显示名称首字符,名称为空时显示用户图标。

> 截图位置：此处可放对话页,群聊页与模型配置页的真机截图(仓库暂未内置静态截图文件)。

## 安装使用

Chataxi 是 HaminnApp 的 happ,**不能脱离宿主单独安装**。

1. 先安装 Haminn：[下载页](https://haminn.airen.life/pages/download.html)(Android 10 及以上),或到 [Releases](https://github.com/zhyuzh3d/haminnapp/releases) 取 APK。
2. 再添加 Chataxi：打开 [应用广场](https://haminn.airen.life/pages/happs.html) 找到 Chataxi,扫描二维码,或复制它的官方安装清单地址(形如 `https://haminn.airen.life/downloads/happs/<happId>/haminn-install.json`,`<happId>` 以应用广场页面显示的为准),回到 Haminn 点「从网址」粘贴。产品网站 <https://chataxi.airen.life/> 也提供同一套二维码与安装地址。

## 快速上手

1. 打开 Chataxi,进入「模型」页新建一张模型卡。
2. 选择供应商并粘贴 API Key,点「重新连接并更新目录」获取模型目录。
3. 挑选一个具体模型,做一次连接测试,保存。
4. 到「角色」页创建角色：可套用角色模板(只填入头像,名称和角色提示词,不覆盖模型与声音),或手写「身份性格」与「行为指导」。
5. 回到对话开始聊天,需要群聊时在输入区用 `@` 选择参与角色,想自动选发言者就打开魔法棒。
6. 朗读与语音输入默认使用 Android 系统服务,可在设置里改语言,音色,语速与音调。

## 项目结构

```text
index.html            入口
haminn.json           包清单(schema 2,happId life.airen.chataxi)
guid.md               写给智能体插件的短说明
app/app.js            启动与装配
app/core/             纯逻辑,不碰 DOM 与宿主:namespace / events / i18n / utils
app/data/             store / i18n-en / role-templates(生成物)/ media
app/features/         chat / conversations / roles / models / settings 等用例编排
app/platform/         haminn.js(Bridge 唯一出口)/ network.js
app/services/         llm / tts / asr / context(压缩)/ providers / model-registry 等
app/components/ui.js  弹窗,Sheet,Toast,图标等通用组件
styles/               tokens / base / components / app
```

依赖方向固定 `core → platform → services → components → features`,只有 `platform/` 直接接触 Bridge 与网络。运行包(发布 ZIP)只包含 `index.html`,`haminn.json`,`guid.md`,`app/` 与 `styles/`,`docs/`,`plans/`,`tools/`,`tests/`,`templates/` 不进运行包。

## 开发与验证

本仓库使用纯原生页面,没有构建步骤。改完代码先跑自检：

```sh
node tools/verify.mjs              # 主自检:清单,引用,静态断言与纯逻辑测试
node tools/check-i18n.mjs          # 只改文案时:中英对照检查
python3 tools/check-secrets.py     # 提交前:确认没有凭据泄漏
```

本地预览与发布打包：

```sh
python3 tools/serve.py --port 4180   # 局域网预览(在 Haminn 里用「从网址」加 http://<开发机IP>:4180/)
python3 tools/package.py             # 生成 release/Chataxi-v<版本>.zip 并同步 haminn-install.json 的路径与 sha256
python3 tools/package.py --check     # 只校验不写入
```

角色模板走生成链路：`templates/char/*.json` 是源,`app/data/role-templates.js` 与 `app/assets/role-templates/` 是生成物,用 `python3 tools/sync-role-templates.mjs` 同步,不要手改生成物。

仓库使用 `.githooks/pre-commit` 与 `.githooks/pre-push` 在提交前扫描暂存快照,推送前扫描全部 Git 历史,扫描范围包含发布 ZIP 内的文本文件。首次克隆后运行 `git config core.hooksPath .githooks` 启用本地钩子。GitHub 仓库同时开启 Secret Scanning 与 Push Protection。

真机热更新(需要设备开发地址与密码,见手机 Haminn 的「开发配置」)：

```sh
python3 ~/.workbuddy/skills/haminn-dev-plugin/haminn-agent.py develop-dir <目录> --quiet
python3 ~/.workbuddy/skills/haminn-dev-plugin/haminn-agent.py update-dir  <目录> --bump patch
```

版本号需同步 `haminn.json`,`app/core/namespace.js` 与 `README.md`,修改运行内容后必须递增版本,已有版本 ZIP 不能被不同内容覆盖。

## Haminn 家族

**Haminn 家族 —— 一个安卓宿主 + 若干可自由改造的应用**

- **Haminn**(宿主,先装这个)：<https://haminn.airen.life/> · <https://github.com/zhyuzh3d/haminnapp>
- **Chataxi**(多角色 AI 群聊)：<https://chataxi.airen.life/> · <https://github.com/zhyuzh3d/chataxi> —— **本仓库**
- **HamDraw**(实时 AI 绘图)：<https://hamdraw.airen.life/> · <https://github.com/zhyuzh3d/hamdraw>
- **PoseGi**(3D 摆姿生图)：<https://posegi.airen.life/> · <https://github.com/zhyuzh3d/PoseGi>

三个 happ 都必须先装 Haminn 宿主,再在[应用广场](https://haminn.airen.life/pages/happs.html)添加。Chataxi 与 HamDraw,PoseGi 互不依赖,只做相互推荐——你可以只装 Chataxi,也可以用 HamDraw 画图,用 PoseGi 摆姿后再对话。

## 贡献

欢迎提交 Issue 与 Pull Request。请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)：其中说明了提 Issue / 提 PR 的流程,分支与提交信息风格,如何在本地跑起来与自检,代码风格与红线,以及不要提交哪些内容(真实 API Key,令牌,录音,对话数据等)。

## License

本项目以 [MIT License](./LICENSE) 发布,Copyright (c) 2026 zhyuzh。

## 免责与支持

- Chataxi 对自己的代码,服务器,账号,令牌和业务内容负责,模型费用由你使用的供应商按量计费,请自行留意。
- 线上实时运行只允许加载你信任的代码来源——页面代码在调用时可以读取已保存的密钥。
- 遇到问题请到 <https://github.com/zhyuzh3d/chataxi/issues> 反馈。
