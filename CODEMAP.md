# CODEMAP

产品：Lit Explorer，Windows x64 / macOS 13+ 通用包，唯一宿主为 Go + 系统 WebView。Electron 只作为界面测试工具。

## 启动、安装与状态

- `mygo/main.go`：应用、窗口、桥接、工作区提交、网页视图、原生菜单与预览服务。
- `src/shared/product.json`：产品名称、构建 slug、稳定技术标识。
- `mygo/product_data.go`：首次升级迁移设置与兼容密文；不覆盖新数据或复制不兼容凭据。
- `mygo/statefile.go`：设置白名单、项目、收藏、布局与原子持久化。
- `mygo/fsapi.go`：真实路径授权、文件列表、读取、SVG 版本冲突保存。
- `mygo/bridge.js`：`window.pv` 契约，原生 RPC 与事件。
- `build/installer.nsi` / `build/close-app.ps1`：安装目录、旧安装接管、快捷方式、卸载、文件夹右键菜单；只请求关闭目标应用，不强杀。
- `scripts/build-mygo.mjs`：生成框架配置、staging、原生编译及产品安装器；`scripts/verify-installer.ps1` 在 Windows CI 验证安装/升级/卸载；`scripts/verify-macos.mjs` 验证 DMG、通用架构、临时签名与真实 WKWebView 启动。

## 渲染层

普通 IIFE，加载顺序在 `src/renderer/index.html`：
`contracts → paths → icons → highlight → markdown → pane → preview-body → webview → save-queue → svgedit → find → projects → changes → cloud-directories → app`。

| 模块 | 入口与职责 |
| --- | --- |
| `app.js` | `openRoot/loadColumn/selectNode/restoreNav/rescan`，工作区代次、导航事务、目录列与接线 |
| `pane.js` | `createPane/renderPane/beginTask/destroyPane`，alive/destroyed、reqId、正文身份、固定、分屏、拖动与滚动 |
| `preview-body.js` | `RENDERERS/renderPaneBody/bodyKeyFor`，内容分派、图片、Markdown、文档组件按需加载 |
| `save-queue.js` | `PV.saveQueue.create/submit/dispose/state`，期望/在途/已落盘版本、串行最新写入 |
| `svgedit.js` | 编辑、历史、手势取消回滚、保存队列及资源清理 |
| `webview.js` | 几何同步、`acquireOcclusion/acquireDragHide` 的独立遮挡租约 |
| `find.js` | 查找条、全文命中、迁移及重渲染后重落高亮 |
| `projects.js` | 项目条、布局快照、图标 picker session 和异步结果归属 |
| `changes.js` | stat 基线与变更检测，工作区/任务/保存版本隔离 |
| `cloud-directories.js` | 授权表单、目录、分页、详情、快捷项、`refreshFolder/closeContextMenu` |
| `highlight.js` / `highlight/worker.js` | Worker 分词、缓存、虚拟列表、降级 |
| `markdown.js` / `docpreview.js` | Markdown / Office DOM 渲染与安全清洗 |
| `paths.js` / `icons.js` / `styles.css` | 路径展示、图标、布局与视觉 |

## 云目录

- `src/shared/directory-providers.json`：版本化声明、固定 API 域名、目录根与节点映射。
- `mygo/directory_plugins.go`：`DirectoryCall`、会话/已发现节点/游标授权；48 小时、128 页缓存；刷新文件夹失效其全部分页，版本检查阻止旧响应回填。
- `mygo/feishu_auth.go` / `src/shared/feishu-auth.json`：实验设备授权、注册、令牌刷新与取消。
- `mygo/kdocs_plugin.go` / `kdocs_protection_windows.go` / `kdocs_protection_darwin.go` / `src/shared/kdocs-skill.json`：官方浏览器授权、四个读取工具、DPAPI / 钥匙串保护。
- `mygo/references.go`：原生目录选择授权与项目只读参考根。
- `pv.list(dir, requestId=0)` 的元信息事件带 requestId，只有当前列接受。

## 测试与构建

- `test/unit.test.cjs`：渲染纯逻辑、Node 测试宿主契约及 S14–S16 并发回归。
- `test/integration.test.cjs`：真实 DOM + 受控 IPC，C/P/E/F/R/D/W/L 段落。
- `test/host/`：仅测试用的 Node 适配与 preload，不是第二个产品；`main.js` 不包含产品窗口/生命周期。
- `mygo/*_test.go`：原生授权、安全边界、凭据、缓存、工作区提交、数据迁移、窗口状态。
- `mygo/stage-frontend.mjs`：仅复制 renderer/shared/资源/产品文档，生成 Go + npm 第三方许可；不复制测试宿主。
- `scripts/run-native.mjs`：Windows / macOS 开发启动；`scripts/run-probe.mjs`：独立 profile 的原生探针。

规则与验证：[AGENTS.md](AGENTS.md)、[docs/agents/verify.md](docs/agents/verify.md)。
状态契约：[docs/design/renderer-lifecycles.md](docs/design/renderer-lifecycles.md)。
