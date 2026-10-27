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

功能上除「内嵌网页」外全部跑通；逐项对照见设计文档。

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
| `statefile.go` | 对应 `store.js` + `state-sanitize.js`；加载时丢弃 web 固定列 |
| `bridge.js` | 注入页面的 `window.pv`，与 `src/main/preload.js` 同形 |
| `stage-frontend.mjs` | 生成 `mygo/frontend/`（`go:embed` 的输入） |
| `fsapi_test.go` | 路径边界、图片地址清洗、状态收敛、SVG 保存基线 |

## 与 Electron 版的差异

- **内嵌网页不可用**：没有 `WebContentsView`。网页快捷访问点击后用系统浏览器打开
  并提示；保存过的 web 固定列在加载设置时丢弃；`webSync` / `webReload` /
  `onWebState` 是空实现。
- **预览地址走本机回环服务**：WebView2 的自定义 scheme 只把主框架请求交给 Go，
  HTML 预览里的相对 CSS/JS 到不了处理器。改为 `127.0.0.1:<随机端口>/<随机令牌>/…`
  的预览服务，工作区白名单仍逐请求校验。这是原型里最需要复核的一处。
- 设置文件在 `%APPDATA%\litexplorer-mygo\state.json`（Electron 版在
  `userData/state.json`，两者不共享）。
- 原生菜单、文件夹/图片选择框用 MyGo 的 `Menu` / `Dialog` 重新实现；本机无可见
  桌面，弹层与对话框未能自动截图确认，需人工点一次。
