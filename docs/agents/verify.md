# 验证

```bash
npm run build
npm test                    # 渲染器纯逻辑 + Electron 测试工具中的真实 DOM
npm run check:docs
node mygo/stage-frontend.mjs
cd mygo && go test ./... && go build .
```

测试宿主只在 `test/host/`；产品系统边界以 Go 测试为准。Linux 可运行渲染回归与 Go 核心测试，
原生窗口、WebView2、文件名大小写与安装行为须由 Windows CI / 独立实例验证。
TestWithin 按当前平台验证路径边界和大小写规则，所有平台均完整执行。

两套 JS 测试支持 `--only=<id,...>` / `--skip=<id,...>`，只执行选中的准备步骤。
界面用例使用隐藏窗口、独立临时目录及受控 IPC；条件等待，不为成功路径增加固定 sleep。

- S2–S16：Markdown、路径、契约、目录/授权、保存队列与版本检测、48 小时目录缓存。
- C/P/E/F/R/D/W/L：渲染竞态、布局、SVG、查找、刷新、云目录及界面所有权。
- L1–L4：销毁窗格、保存中撤销、导航代次、遮挡和 picker 归属。
- D4 / S16 / TestDirectoryFolderCacheRefresh：单文件夹刷新、分页失效与旧请求隔离。
- TestProductDataMigration / TestProductMigrationFromFormerRuntime / TestProductMigrationDoesNotCopyLinks：
  升级迁移、保留新数据、不恢复退出凭据、不导入不兼容密文、不复制链接或提交半成品。
- scripts/verify-installer.ps1：CI 临时安装目录中验证产品身份、安装、升级及卸载。

Windows 安装器验证不运行产品，不触碰用户实例；其他手工验收也必须使用独立数据目录。
全绿不代表已验收真实云账号授权、WebView2 焦点/DPI、拖动与站点兼容性。
更多入口见 [CODEMAP](../../CODEMAP.md)。

macOS CI 执行全部 Go 测试并构建通用 DMG。`scripts/verify-macos.mjs` 挂载真实镜像，核对签名、Apple Silicon / Intel 切片、产品身份，在独立 profile 启动 WKWebView，验证 Markdown、本地链接、越界拒绝和网络添加入口。
