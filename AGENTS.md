# chataxi 项目开发总则

chataxi 是 HaminnApp 中运行的普通 happ，不是 HaminnUI，也不拥有宿主管理权限。每项任务开始时先明确本轮对象、动作和验收点，只处理该边界。

## 仓库与发布边界

- 本目录是独立 Git 仓库，唯一规范远程为 `git@github.com:zhyuzh3d/chataxi.git`。不得与 `haminnapp`、`haminnweb` 合并提交、互相嵌套或改作 subtree/submodule。
- 提交或推送前必须执行 `git rev-parse --show-toplevel` 与 `git remote get-url origin`，确认顶层目录以 `/chataxi` 结尾且远程精确匹配。
- `docs/`、`plans/`、`tools/`、`tests/` 不属于 happ 运行包；发布包只包含 `index.html`、`haminn.json`、`app/` 与 `styles/`。
- 不提交真实 API Key、访问令牌、录音、对话数据或设备私有信息。

## 页面技术基线

- 使用纯原生 HTML、CSS、JavaScript，源文件可直接运行；不得引入 React、Vue、Vite、Webpack、npm 运行依赖、CDN、远程字体或运行时下载模块。
- 组件以保守语法的 IIFE 注册到 `window.chataxi`，不用 ES Modules、Shadow DOM 或新 Web API 作为唯一运行路径。
- `components/` 只负责 DOM 与语义事件，`features/` 负责编排用例，`services/` 负责业务适配，`platform/` 是 Haminn Bridge 与网络的唯一入口，依赖保持单向。
- 页面同时支持 `haminnready` 和即时 `window.haminn.isReady`。优先使用 Haminn 的逐 happ 数据、系统 TTS、系统语音识别和原生网络接口；普通浏览器仅作为开发降级环境。
- URL 来源记为线上来源，局域网实时加载使用 `runtimeMode=live`；不得用一个 `mode` 混淆来源与运行方式。

## 产品与安全边界

- OpenAI Responses 是统一首选协议；Chat Completions、Anthropic Messages、Gemini GenerateContent 通过显式适配器转换。供应商地址和模型名必须可编辑。
- 默认不执行模型返回的代码、HTML、工具或链接。模型文本以纯文本安全渲染；图片只接受明确的数据 URL 或 HTTPS URL。
- API Key 只在用户明确保存后写入本 happ 的数据区，并始终遮罩显示。页面代码仍能在调用时读取密钥，所以线上实时运行只允许加载用户信任的代码来源。
- 外部网络请求必须由用户逐 Origin 授权。HTTP 仅用于可信局域网；公网服务应使用 HTTPS。
- 多角色群聊每次用户发送只触发用户选定角色各一次响应，不建立无界自主互聊，避免不可控成本和循环。

## 验证原则

- 用户要求修改 happ，且明确要求“智能体开发模式”或“更新后查看结果”时，本轮必须使用 `haminn-agent.py develop-dir` 同步当前工作目录并等待设备渲染确认（一次性核实同步是否落地用等价的 `sync-dir`，它有 `changedPaths`/`revision` 输出，更适合确认结果）；同时要求更新版本或部署到设备时，还必须统一版本、完成直接相关验证、生成对应的不可变发布 ZIP，再用 `haminn-agent.py update-dir` 安装到原实例并核对稳定通道与数据保持。除非用户明确只要源码或设备出现真实连接阻塞，不得停在源码修改、测试或 DEV 预览阶段，也不得把工作树中已有但尚未收尾的版本状态当作拒绝部署的理由。
- 验证强度与改动相称（以上级 `AGENTS.md` 第 8 节为准）：简单的界面或功能修改只做**与改动直接相关的必要验证**——相关的那个测试文件或合同检查，必要时一次真机确认即可；不默认全跑 `tests/`、`check-i18n`、`tools/package.py --check`。`package.py`、发布打包与安装只在用户明确要求发版，或改动触及发布产物时执行。
- 真机验收分级：涉及部署、发版或宿主能力（Bridge、数据持久化、系统语音、真实模型请求）的改动，才按「服务可达 → happ 安装/打开 → Bridge 就绪 → 数据持久化 → 系统语音 → 至少一次真实模型请求」逐项确认；纯界面/前端改动只需确认改动本身在设备上生效。没有真实供应商凭据时必须如实标记相应项未验收。
- 同一批代码未变化时不重复构建、打包、安装或启动。
