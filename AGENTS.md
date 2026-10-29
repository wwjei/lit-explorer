# AGENTS.md

lit explorer：本地项目文件浏览器（多栏目录导航 + 内嵌预览）。同一份 `src/renderer`
由两个 shell 承载：Electron（`src/main/`）与 MyGo（`mygo/`，Go + 系统 WebView2）。

**先找入口**：[CODEMAP.md](CODEMAP.md) 按业务组件列出文件、关键方法与可搜索关键字，
比从头翻源码快；改业务组件、关键方法、IPC / DOM 约定时同步维护它。

未做的事分三个池子，别混：想做的功能与要拍板的决策在
[further_notes.md](further_notes.md)；小 bug 与顺手清理在 [PENDING.md](PENDING.md)
（**发版前必须清空**）；已知但无可行修法的依赖 / 安全问题在
[docs/security-debt.md](docs/security-debt.md)。明确不做的在
[FEATURES.md](FEATURES.md) 第 2 节。产品行为定义在
[FEATURES.md](FEATURES.md)，用法在 [README.md](README.md)。

## 按场景读

| 你的场景 | 读这个 |
| --- | --- |
| 想知道某个功能在哪个文件 / 方法，或该搜什么关键字 | [CODEMAP.md](CODEMAP.md) |
| 增删依赖、调整 MyGo fork、生成第三方许可，或在 `dependencies` / `devDependencies` 之间挪包 | [docs/agents/dependencies.md](docs/agents/dependencies.md) |
| 改 `src/renderer/` 下的界面代码（含 pane / preview-body / find / projects / app 的分层）、动构建脚本或图标、改双 shell 的共用与分叉 | [docs/agents/build.md](docs/agents/build.md) |
| 改 MyGo 版的主进程能力（`mygo/*.go`）、bridge、预览服务、fork 的 ChildWebView | [mygo/README.md](mygo/README.md)、[docs/design/mygo-port.md](docs/design/mygo-port.md) |
| 加文件系统能力，改 preload / IPC / 自定义协议 | [docs/agents/security.md](docs/agents/security.md) |
| 改版本号、打 tag、发 Release | [docs/agents/release.md](docs/agents/release.md) |
| 跑测试（含 MyGo 文件 / 主进程回归）、写界面探针、装包验证改动 | [docs/agents/verify.md](docs/agents/verify.md) |
| 改产品行为，写文档与注释 | [docs/agents/conventions.md](docs/agents/conventions.md) |
| 飞书客户端授权（设备流程实验版） | `src/main/feishu-auth.js`、`mygo/feishu_auth.go`、`src/shared/feishu-auth.json`、[方案与实测准备](docs/design/feishu-client-authorization.md) |
| 外部参考目录与云目录插件 | `src/main/reference-dirs.js`、`src/main/directory-plugins.js`、`src/shared/directory-providers.json`、`mygo/references.go`、`mygo/directory_plugins.go`、[插件契约与接入方案](docs/design/external-directory-plugins.md) |
| 想做的功能、要拍板的事 | [further_notes.md](further_notes.md) |
| 顺手要清的小问题 | [PENDING.md](PENDING.md) |
| 已知的依赖 / 安全债，以及什么时候要重新看 | [docs/security-debt.md](docs/security-debt.md) |
| Windows 文件夹右键菜单 | `src/main/folder-menu.js`、`build/installer.nsh`、`mygo/main.go` |
| 想弄清某个设计为什么是这样（如高亮的阈值） | [docs/highlighting.md](docs/highlighting.md) 这类设计文档 |
| 看未实施功能的调研与方案 | [docs/design/](docs/design/) 下按主题分的文档 |
| 看 MyGo 移植的实测数据与能力差异（体积、启动、内存、内嵌网页） | [docs/design/mygo-port.md](docs/design/mygo-port.md) |
| 看历史审查记录（为什么有某些防御代码） | [docs/audits/](docs/audits/) 下按日期归档的记录 |
| 改 CI、发版流程、依赖更新策略 | [.github/workflows/](.github/workflows/) 与 [.github/dependabot.yml](.github/dependabot.yml) |

## 红线

1. 改 npm 依赖必须同步 `package-lock.json`；改 MyGo 的依赖（`mygo/go.mod`）必须同步
   `mygo/go.sum`。否则 CI 的 `npm ci` / `go build` 会失败，而本地毫无异常。
2. `src/renderer/vendor/`、`build/icons/`、`build/notices/`、`mygo/frontend/` 是生成物，
   不要手改、不要提交。
3. `dist` 脚本里的 `--publish never` 不能去掉，发布统一交给 CI。
4. 没有明确要求时不要打 tag；**打 tag 前 [PENDING.md](PENDING.md) 必须是空的**。
5. **新增一类信息（新文档、新测试、新待办池）要同步上面那张索引**——下一个会话是从
   这张表进门的，索引里没有的东西等于不存在。`docs/` 下的文档漏登记（或改名后留下
   死链）会让 CI 的 `npm run check:docs` 失败。
6. 不要动用户正在运行的应用：跑起来验证一律用独立的 `--user-data-dir`（`npm run probe`
   已经默认这么做），也不要结束你自己没起的进程。
7. 加 npm 依赖之后要重跑 `npm run notices`（`predist` 里已经串上）；Go 依赖许可由
   MyGo staging 收集。两条生成链见 [docs/agents/dependencies.md](docs/agents/dependencies.md)。
