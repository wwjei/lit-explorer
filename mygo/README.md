# lit explorer · MyGo 移植实验

用 [MyGo](https://github.com/egoist/mygo)（Go + 系统 WebView2）承载同一份
`src/renderer` 界面，验证「不打包 Chromium」能省多少体积、会丢哪些能力。

**这是实验分支上的原型，未合入主线，也不是发布路径。** 结论与实测数据见
[docs/design/mygo-port.md](../docs/design/mygo-port.md)。

## 结果速览

| 指标 | Electron 版 | MyGo 版 |
| --- | --- | --- |
| 产物 | 安装包 122.4 MB / 免安装 111.3 MB | 单文件 exe **18.6 MB** |
| 安装后占用 | Electron 运行时约 369 MB + 应用 | 18.6 MB（WebView2 运行时由系统提供） |
| 启动到窗口 | 1.66 s | 2.17 s（冷启动 WebView2） |
| 内存（工作集 / 私有） | 473 MB / 392 MB，4 进程 | 602 MB / 400 MB，8 进程 |

功能全部跑通，包括内嵌网页——后者靠 fork 出来的 `ChildWebView` 补上（见下）。
逐项对照见设计文档。

## 构建

需要 Go 1.27+ 与 Windows 的 WebView2 Runtime（Windows 11 自带）。

```bash
npm run build                      # 先生成 src/renderer/vendor 与 docpreview
node mygo/stage-frontend.mjs       # 把渲染层/资源拷进 mygo/frontend（已 gitignore）
cd mygo
go build -trimpath -ldflags "-s -w" -o ../.tmp/litexplorer-mygo.exe .
```

运行：

```bash
.tmp/litexplorer-mygo.exe --open=./sample-project
```

调试用参数：`--eval=<js 文件> --delay=<ms> --hold=<ms>`（执行一段 JS，打印返回值，
`--hold` 让窗口多留一会儿供截图）。`MYGO_DEBUG=1` 会打印预览服务的每个请求。

Go 单测：`cd mygo && go test ./...`。

## 结构

| 文件 | 作用 |
| --- | --- |
| `main.go` | 窗口、菜单、单实例、预览服务、`App.*` 绑定方法 |
| `fsapi.go` | 对应 `src/main/fs-api.js`：授权根、真实路径校验、类型/MIME、读与 SVG 保存 |
| `statefile.go` | 对应 `store.js` + `state-sanitize.js`（含 web 固定列） |
| `bridge.js` | 注入页面的 `window.pv`，与 `src/main/preload.js` 同形 |
| `stage-frontend.mjs` | 生成 `mygo/frontend/`（`go:embed` 的输入） |
| `fsapi_test.go` | 路径边界、图片地址清洗、状态收敛、SVG 保存基线 |

## 依赖 fork

内嵌网页需要 MyGo 原版没有的能力：在页窗口上按矩形叠一个 webview。这里用了
[wwjei/mygo](https://github.com/wwjei/mygo) 的 `v0.7.1-lit.2`（fork 自 v0.7.1），
新增 `Window.NewChildWebView()`：

```go
web, _ := win.NewChildWebView(mygo.ChildWebViewOptions{
    URL:  "https://example.com",
    Rect: mygo.Rectangle{X: 800, Y: 100, Width: 420, Height: 600},
})
web.SetRect(...)        // 窗格移动 / 窗口缩放时
web.SetVisible(false)   // 被欢迎页、菜单盖住时
web.OnState(...)        // loading / loaded / error / gone / popup
web.Destroy()           // 窗格移出同步列表时
```

`mygo/go.mod` 用 `replace github.com/egoist/mygo => github.com/wwjei/mygo v0.7.1-lit.2`
指过去；fork 的模块路径保持原样，上游升级时把 fork rebase 到新 tag 再改版本号即可。

Windows 实现是「子 HWND + 独立 WebView2 经典控制器」：控制器挂在页窗口的子窗口上，
用 `SetWindowPos` 保持页面之上，坐标按 DPI 从 DIP 换算成物理像素。微软并未官方支持
同一窗口叠加两个 WebView2 控制器，实测可工作，但升级 WebView2 / 移动窗口到不同 DPI
显示器时需要复测。

## 与 Electron 版的差异

- **内嵌网页**：已通过 fork 的 `ChildWebView` 实现，`webSync` / `webReload` /
  `onWebState` 与 Electron 版同形。与 Electron 的差别：子 webview 与主页面共用
  应用级 profile（登录态仍持久，但没有独立分区）；`target=_blank` 与 Electron 一样
  交给系统浏览器；剪贴板读取等站点权限没有做按站询问，交给 WebView2 默认策略。
- **预览地址走本机回环服务**：WebView2 的自定义 scheme 只把主框架请求交给 Go，
  HTML 预览里的相对 CSS/JS 到不了处理器。改为 `127.0.0.1:<随机端口>/<随机令牌>/…`
  的预览服务，工作区白名单仍逐请求校验。这是原型里最需要复核的一处。
- 设置文件在 `%APPDATA%\litexplorer-mygo\state.json`（Electron 版在
  `userData/state.json`，两者不共享）。
- 原生菜单、文件夹/图片选择框用 MyGo 的 `Menu` / `Dialog` 重新实现；本机无可见
  桌面，弹层与对话框未能自动截图确认，需人工点一次。
