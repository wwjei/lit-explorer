# AGENTS.md

Lit Explorer：Windows / macOS 原生项目文件浏览器。唯一产品宿主在 `mygo/`（Go + WebView2 / WKWebView），
渲染层在 `src/renderer/`。MyGo 是技术框架名，只出现在技术说明与许可中，不作产品名称。
Electron 仅用于开发期界面测试，Node 契约宿主在 `test/host/`，绝不进入发行产物。

先读 [CODEMAP.md](CODEMAP.md) 找业务入口。

| 场景 | 入口 |
| --- | --- |
| 产品行为 | [FEATURES.md](FEATURES.md)、[README.md](README.md) |
| 构建与渲染分层 | [docs/agents/build.md](docs/agents/build.md) |
| 依赖与许可 | [docs/agents/dependencies.md](docs/agents/dependencies.md) |
| 测试与探针 | [docs/agents/verify.md](docs/agents/verify.md) |
| 原生宿主 | [mygo/README.md](mygo/README.md)、`mygo/main.go` |
| 路径授权与凭据 | [docs/agents/security.md](docs/agents/security.md) |
| 安装身份、迁移与发布 | `src/shared/product.json`、`mygo/product_data.go`、`build/installer.nsi`、`scripts/verify-macos.mjs`、[docs/agents/release.md](docs/agents/release.md) |
| 文档与注释 | [docs/agents/conventions.md](docs/agents/conventions.md) |
| 生命周期与取消 | [docs/design/renderer-lifecycles.md](docs/design/renderer-lifecycles.md) |
| 云目录 | [docs/design/external-directory-plugins.md](docs/design/external-directory-plugins.md) |
| 飞书授权 | [docs/design/feishu-client-authorization.md](docs/design/feishu-client-authorization.md) |
| 金山授权 | [docs/design/kdocs-directory-plugin.md](docs/design/kdocs-directory-plugin.md) |
| 高亮 | [docs/highlighting.md](docs/highlighting.md) |
| 其他技术设计 / 历史审查 | [docs/design/](docs/design/)、[docs/audits/](docs/audits/) |
| 需求 / 小问题 / 无法修复的安全债 | [further_notes.md](further_notes.md)、[PENDING.md](PENDING.md)、[docs/security-debt.md](docs/security-debt.md) |

## 红线

1. 改 npm 依赖同步 package-lock.json；改 Go 依赖同步 go.sum。
2. `src/renderer/vendor/`、`build/icons/`、`build/notices/`、`mygo/frontend/` 是生成物，勿手改或提交。
3. 发布仅由 CI 完成；只构建 Lit Explorer 安装包与便携包，不恢复其他产品宿主。
4. 用户明确要求才打标签；发版前清空 PENDING 中的未完成条目，按发版说明测试。
5. 新文档、组件或测试更新索引。`npm run check:docs` 必须通过。
6. 验证只使用独立用户数据与临时目录，不动用户正在运行的程序。原生启动支持 `--user-data-dir=`。
7. 依赖许可由 staging 按实际链接代码生成，不得删除第三方必要署名。
8. 旧技术标识仅为兼容性保留，不可显示在产品名、安装路径、快捷方式、菜单或发布说明中。
