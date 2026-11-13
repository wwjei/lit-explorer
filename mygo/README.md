# Lit Explorer 原生宿主

技术实现使用 [MyGo](https://github.com/egoist/mygo)（Go + WebView2 / WKWebView）；产品名只用 Lit Explorer。
本目录是唯一产品主进程。`test/host/` 的 Node 代码仅供跨平台渲染契约测试。

```bash
npm run build
node mygo/stage-frontend.mjs
cd mygo && go test ./... && go build .
```

发布执行根目录 `npm run dist`，需要 Go 1.27+；Windows 使用 NSIS，macOS 使用系统工具创建通用 DMG。
产品配置来自 `src/shared/product.json`；`scripts/build-mygo.mjs` 生成框架配置，
`build/installer.nsi` 管理产品安装，`product_data.go` 处理旧设置升级。
编入的 `frontend/` 为生成物，不提交、不手改。

- `main.go`：窗口、菜单、RPC、单实例与网页子窗口。
- `fsapi.go` / `statefile.go`：权限、读写及持久化白名单。
- `directory_plugins.go` / `feishu_auth.go` / `kdocs_plugin.go`：云目录、缓存与授权。
- `product_data.go`：旧项目及兼容凭据迁移，不覆盖新数据。
- `bridge.js`：渲染器的唯一 pv 契约。

运行支持 `--open=`、独立 `--user-data-dir=`，探针支持 `--eval=`、`--delay=`、`--hold=`。
技术移植背景见 [历史设计](../docs/design/mygo-port.md)。

macOS 网页子视图尚未实现，`bridge.js` 按编译平台声明能力，网页与云文档交给系统浏览器。金山授权通过 `kdocs_protection_darwin.go` 用钥匙串保护 AES-GCM 密钥。
