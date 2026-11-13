# 构建与渲染分层

产品只有一个原生宿主，Go + WebView2（Windows）/ WKWebView（macOS） 位于 `mygo/`。框架名是技术细节，产品身份来自
`src/shared/product.json`，发布文件与窗口均使用 Lit Explorer。

## 生成物

`npm run build` 生成图标、高亮 Worker 和 Office 预览 IIFE。
`src/renderer/vendor/`、`build/icons/`、`build/notices/`、`mygo/frontend/` 不手改、不提交。

渲染器普通脚本使用 IIFE + `window.PV`，加载顺序由 `index.html` 决定。
正文分派在 preview-body，窗格生命周期与布局在 pane，查找在 find，项目与 picker 在 projects，
版本监测在 changes，云目录在 cloud-directories，app 只负责导航和接线。
详细入口见 [CODEMAP](../../CODEMAP.md)，异步不变量见
[生命周期设计](../design/renderer-lifecycles.md)。

## 构建和运行

```bash
npm ci
npm run build
npm start                    # Windows / macOS，Go 原生启动
node mygo/stage-frontend.mjs
cd mygo && go test ./...
```

staging 先准备 go:embed 输入，再按实际链接依赖生成合并许可；首次编译前必须执行。
`npm run dist` 清空 dist：Windows 编译唯一产品并调用仓库 NSIS 脚本；macOS 编译 darwin/universal，使用 lipo 合并双架构，签名并创建拖入 Applications 的 DMG。
需要 Go 1.27+；Windows 需要 NSIS，macOS 使用系统 Xcode 命令行工具 / codesign / hdiutil；发布中不启动或分发 Electron。`MYGO_CLI` 可指定本地构建工具，
`MAKENSIS` 可指定 NSIS 编译器，都是技术构建选项。

安装脚本负责默认目录、旧安装接管、快捷方式、卸载登记与文件夹菜单。
不把 SDK 的框架默认名称当成产品身份。安装/升级/卸载验证在 Windows CI 的独立步骤执行。

## 界面测试

Electron 只作为开发期 DOM 测试工具。`test/host` 包含受控 Node 契约宿主，不在产品源代码、
打包输入或用户文档中提供启动入口。原生边界以 Go 实现和测试为准，修改桥接同时维护契约夹具。
`scripts/verify-macos.mjs` 在 macOS CI 验证 DMG、原生启动与 Markdown 本地链接。
界面测试不代替真实 WebView2 / WKWebView 的焦点、DPI、权限及登录体验验收。
