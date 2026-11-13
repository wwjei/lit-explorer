# 依赖与许可

产品运行时不需要 npm 或 Electron；Go 宿主和预先构建的渲染层编入一个 EXE。
所有 npm 包放在 devDependencies，构建输入中的 Shiki / Office 解析器随产品分发，
Electron 仅用于界面测试。不得恢复 electron-builder 或第二个产品打包配置。

改 npm 依赖同步 `package-lock.json`，用 `npm ci --dry-run` 校验；改 Go 依赖同步
`mygo/go.sum`，不能只改模块版本或 replace。

`mygo/stage-frontend.mjs` 调 `scripts/build-mygo-notices.mjs`，根据目标平台主程序实际
`go list -deps` 的结果，合并 npm、Go 模块、替换模块与标准库许可。
技术组件的真实名称与版权声明必须保留，产品品牌统一不能删掉法律署名。

`npm run audit` 依 esbuild 的 meta.json 判断哪些 npm 包进入产品，只有随产品分发的
high/critical 项阻止 CI。测试工具漏洞仍需维护，但不应被描述为用户安装包中的运行时。
已知依赖债在 [security-debt](../security-debt.md)。

Go 使用 `github.com/wwjei/mygo v0.7.1-lit.2` 替换上游，保留 ChildWebView 能力。
这是技术实现，不属于产品名称；升级时复测子窗口生命周期与安全隔离。
