# 贡献指南

感谢你愿意为 **chataxi** 出力。chataxi 是运行在 Haminn 宿主里的原生页面 happ,本文件说明提 Issue,提 Pull Request,本地开发与自检,代码风格与红线。动手前请先读一遍,并顺带读一下仓库里的 `AGENTS.md` 与 `guid.md`。

## 提 Issue

- 到 <https://github.com/zhyuzh3d/chataxi/issues> 新建 Issue,优先使用仓库提供的模板：`.github/ISSUE_TEMPLATE/bug_report.yml`(缺陷)与 `feature_request.yml`(功能建议)。
- 缺陷请写清：复现步骤,期望结果,实际结果,chataxi 版本(见 `haminn.json`),Haminn 版本,Android 与 WebView 版本,所用模型供应商(如相关),以及截图或日志。
- **不要**在 Issue 里粘贴真实 API Key,访问令牌或任何隐私对话内容,需要展示时请自行打码或改写。

## 提 Pull Request

1. Fork 本仓库并从 `main` 切出特性分支。分支名建议 `fix/短描述`,`feat/短描述`,`doc/短描述`。
2. 一个 PR 只做一件事,只改与目标直接相关的文件。
3. 提交前跑与改动相称的自检(见下),在 PR 描述里写清：改了什么,为什么,怎么验证的。
4. 向 `main` 发起 PR,描述里关联相关 Issue(如 `Closes #12`)。

## 分支与提交信息风格

- 分支：从 `main` 切出,合并回 `main`。
- 提交信息参考仓库既有历史,推荐使用一句话主题行(可用半角前缀)：
  - `feat: 一句话说清新能力`
  - `fix: 一句话说清修了什么`
  - `doc:` / `chore:` / `refactor:` / `test:` 分别对应文档,构建杂项,不改行为的重构与测试
  - 也可以用中文直接描述,例如「群聊：修正主持人固定排序」。
- 主题行尽量控制在 72 字符以内,需要时在正文说明动机,影响面与验证方式。

## 本地跑起来

chataxi 是纯原生页面,**没有构建步骤**,源文件直接运行。

```sh
python3 tools/serve.py --port 4180
```

然后在 Haminn 里用「从网址」添加 `http://<开发机局域网IP>:4180/`,即可用线上实时运行的方式预览。开发服务只适合可信局域网。普通浏览器也能打开,但用的是独立 localStorage 预览数据,不会自动迁入 Haminn 实例。

需要真机热更新时(设备开发地址与密码见手机 Haminn 的「开发配置」)：

```sh
python3 ~/.workbuddy/skills/haminn-dev-plugin/haminn-agent.py develop-dir <目录> --quiet
```

## 自检

按改动范围选择,验证强度与改动相称：

```sh
node tools/verify.mjs              # 主自检:清单,引用,静态断言与纯逻辑测试
node tools/check-i18n.mjs          # 只改文案时:中英对照检查
python3 tools/check-secrets.py     # 提交前:确认没有凭据泄漏
python3 tools/package.py --check   # 只在改动触及发布产物时:校验打包结果
```

本仓库使用 `.githooks/pre-commit`(扫描暂存快照)与 `.githooks/pre-push`(扫描全部历史)。首次克隆后运行：

```sh
git config core.hooksPath .githooks
```

## 代码风格与红线

- **依赖方向固定** `core → platform → services → components → features`,**只有 `app/platform/` 直接接触 Haminn Bridge 与网络**,其余模块不得直接调用宿主或发网络请求。
- 使用纯原生 HTML / CSS / JavaScript,组件以保守语法的 IIFE 注册到 `window.chataxi`,**不引入** React,Vue,Vite,Webpack,npm 运行依赖,CDN,远程字体或运行时下载模块,不用 ES Modules 作为唯一运行路径。
- 兼容 Android 10 与旧厂商 WebView：该类设备上 flex 的 `gap` 不生效,横向间距一律用相邻兄弟 `margin` 或 grid。
- 新增界面文案**必须**同步补 `app/data/i18n-en.js`,否则 `tools/check-i18n.mjs` 会失败。
- 角色模板走生成链路：`templates/char/*.json` 是源,`app/data/role-templates.js` 与 `app/assets/role-templates/` 是生成物,用 `python3 tools/sync-role-templates.mjs` 同步,不要手改生成物。
- 安全边界：默认不执行模型返回的代码,HTML,工具或链接,模型文本按纯文本安全渲染,外部请求由用户逐 Origin 授权,公网必须 HTTPS,HTTP 只允许可信局域网。角色设定与历史上下文按既定分层组装,不建立无界自主互聊。
- 运行包(发布 ZIP)只包含 `index.html`,`haminn.json`,`guid.md`,`app/` 与 `styles/`,`docs/`,`plans/`,`tools/`,`tests/`,`templates/` 不进包。
- 修改运行内容后必须递增版本,版本号同步 `haminn.json`,`app/core/namespace.js` 与 `README.md`,已有版本 ZIP 不能被不同内容覆盖。

## 不要提交

- 真实 API Key,密码,访问令牌,它们只能保存在你自己的 Haminn 数据区。
- 录音,真实对话数据或设备私有信息。
- 本地预览残留与临时产物(`.server-state/`,`*.log`,`*.pid` 已在 `.gitignore` 中忽略)。

## License

提交即表示你同意你的贡献以本仓库的 [MIT License](./LICENSE) 授权。
