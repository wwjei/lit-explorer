# lit explorer · MyGo 版

用 [MyGo](https://github.com/egoist/mygo)（Go + 系统 WebView2）承载同一份
`src/renderer` 界面，是随 Release 一起发布的第二个 Windows 版本。与 Electron 版功能
一致、共用界面代码，但不打包 Chromium，安装包从约 122 MB 降到约 5.5 MB。

实测数据（体积、启动、内存）与能力对照见
[docs/design/mygo-port.md](../docs/design/mygo-port.md)。

## 产物

| 指标 | Electron 版 | MyGo 版 |
| --- | --- | --- |
| 安装包 | 122.4 MB（NSIS）/ 111.3 MB（portable） | **5.5 MB**（NSIS）/ **17.8 MB**（portable） |
| 运行时 | 自带 Electron | 系统 WebView2（Win11 自带，Win10 一般随 Edge） |
| 启动到窗口 | 1.66 s | 2.17 s（冷启动 WebView2） |
| 内存（工作集 / 私有） | 473 MB / 392 MB | 602 MB / 400 MB |

两个版本可以并存：安装目录、卸载项与用户数据目录各自独立
（Electron 用 `Lit Explorer`，MyGo 用 `Lit Explorer MyGo`）。

## 构建

需要 Go 1.27+。打包走仓库根目录的脚本，不要直接调 `mygo build`（它不会生成前端资源、
也不会把产物改名为发布用的名字）：

```bash
npm run dist:mygo   # predist:mygo 先 build + notices，再 stage → 编译 → 安装包 → dist/
npm run dist:all    # Electron + MyGo；顺序固定，Electron 的 clean-dist 会清空 dist/
```

CLI 默认用 `go run github.com/egoist/mygo/cmd/mygo@v0.7.1`；本机已装 `mygo` 时可用
`MYGO_CLI=mygo` 覆盖。缺 NSIS 时 CLI 会自己下载，离线环境可把 electron-builder 缓存里的
`makensis.exe` 目录放进 `PATH`。国内网络拉不动 `proxy.golang.org` 时设
`GOPROXY=https://goproxy.cn,direct`。

手工调试构建：

```bash
npm run build                       # 生成 src/renderer/vendor 与 docpreview
node mygo/stage-frontend.mjs        # 把渲染层/资源拷进 mygo/frontend（gitignore）
cd mygo
go test ./... && go build -trimpath -ldflags "-s -w" -o ../.tmp/litexplorer-mygo.exe .
```

`go:embed` 依赖 `mygo/frontend/`，所以 `go test` / `go build` 之前必须先 stage。

运行：

```bash
.tmp/litexplorer-mygo.exe --open=./sample-project
```

调试用参数：`--eval=<js 文件> --delay=<ms> --hold=<ms>`（执行一段 JS，打印返回值，
`--hold` 让窗口多留一会儿供截图）。`MYGO_DEBUG=1` 会打印预览服务的每个请求。

## 结构

| 文件 | 作用 |
| --- | --- |
| `main.go` | 窗口、菜单、单实例、预览服务、`App.*` 绑定方法 |
| `fsapi.go` | 对应 `src/main/fs-api.js`：授权根、真实路径校验、类型/MIME、读与 SVG 保存 |
| `statefile.go` | 对应 `store.js` + `state-sanitize.js`；web 固定列按 `kind` + `url` 保留 |
| `bridge.js` | 注入页面的 `window.pv`，与 `src/main/preload.js` 同形；`capabilities.webPane = true` |
| `stage-frontend.mjs` | 生成 `mygo/frontend/`（`go:embed` 的输入） |
| `fsapi_test.go` | 路径边界、图片地址清洗、状态收敛、SVG 保存基线 |

## 与 Electron 版的差异

- **预览地址走本机回环服务。** WebView2 的自定义 scheme 只把主框架请求交给 Go，
  HTML 预览 iframe 里的相对 CSS/JS 到不了处理器。改为
  `127.0.0.1:<随机端口>/<随机令牌>/…` 的预览服务，工作区白名单仍逐请求校验。
- **内嵌网页靠 fork 支持。** 上游 MyGo 的 `NewWebView` 只允许 native UI 窗口；
  `go.mod` 的 `replace` 指向 `wwjei/mygo v0.7.1-lit.2`，它在主窗口上叠加子 HWND +
  WebView2 经典控制器（`Window.NewChildWebView()`）。微软不官方支持同窗口叠加控制器，
  升级 MyGo / WebView2 时要复测网页列。
- **渲染内核跟随系统 Edge。** docx / pptx / PDF 的渲染一致性要按 WebView2 版本回归。
- 设置文件在 `%APPDATA%\Lit Explorer MyGo\state.json`，与 Electron 版不共享。
- `FEATURES.md` 与第三方许可声明编在 exe 里；菜单「功能特性说明」「第三方许可」首次
  打开时解到用户数据目录再交给系统默认程序。
