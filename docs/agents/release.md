# 发版

1. 清空 [PENDING](../../PENDING.md) 中的未完成小问题。
2. 本地执行构建、`npm test`、文档检查和 Go 测试；查看 [安全债](../security-debt.md) 的复查条件。
3. 变更通过 PR 的 Windows / macOS CI 后合并，版本号同步 package.json / package-lock.json。
4. 在合并提交创建 `v<版本>` 标签并推送，等待发布流水线实际完成后核对附件。

只有一个产品：**Lit Explorer**。不提供 Electron、备用版或以框架命名的产品。

## 构建与验证

release.yml 复用 ci.yml 测试，然后 Windows / macOS 分别执行 `npm run dist`。
macOS 构建 darwin/universal（Apple Silicon + Intel），原生单元测试和 `scripts/verify-macos.mjs` 验证 DMG、签名、双架构和真实 WKWebView 预览后上传。
两个平台全部成功后统一汇总产物、生成校验和并创建 Release，避免发布半套包。
构建脚本根据 `src/shared/product.json` 生成技术配置，原生编译后用
`build/installer.nsi` 创建产品安装器。`scripts/verify-installer.ps1` 在一次性 Windows CI 账户的默认目录
验证上一版迁移、安装、同目录升级、卸载及可执行文件/注册表的产品名称。

默认安装目录 `%LOCALAPPDATA%\Programs\Lit Explorer`；产品 EXE、快捷方式与卸载登记均为
Lit Explorer。历史技术标识仅用于升级兼容。旧版本设置和兼容密文由 `product_data.go`
在首次运行原子迁移到 `%APPDATA%\Lit Explorer`；原目录保留，新设置不覆盖。

发布仅由 CI 完成；不要在本地构建命令隐式上传。

| 产物 | 说明 |
| --- | --- |
| `Lit-Explorer-Setup-<版本>.exe` | 安装版 |
| `Lit-Explorer-<版本>-portable.exe` | 便携版 |
| `Lit-Explorer-<版本>-macOS-universal.dmg` | macOS 12+ 通用包 |
| `SHA256SUMS.txt` | 上述三个包的校验和 |

脚本严格要求当前版本三个产物齐全。不得上传旧备用包或 blockmap。
标签带 `-alpha` / `-beta` 时发布为预发布。保留实际依赖许可，未签名的产品会收到
SmartScreen 未知发布者提示；签名与更新策略见 [further_notes](../../further_notes.md)。

macOS 当前使用临时签名，未配置 Developer ID 与公证；发布说明必须如实注明 Gatekeeper 限制及系统设置允许入口。macOS 网页与云文档内容由默认浏览器打开，不宣称内嵌远程网页。
