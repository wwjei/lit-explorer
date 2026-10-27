# 依赖与 lock 文件

## 依赖都放 devDependencies

`dependencies` 是空的：主进程只用 electron 与 node 内置模块，shiki / docx-preview /
pptx-preview / jszip 都由 esbuild 打包进 `src/renderer/vendor/`，运行时不需要 `node_modules`。
`dependencies` 非空时 electron-builder 会把 `node_modules` 打进 `app.asar`
（pptx-preview 依赖的 echarts + zrender 一项就约 55 MB，实测 `app.asar` 从 4.5 MB 涨到 81 MB）。

## 改依赖必须同步 package-lock.json

增删依赖、或只是把包在 `dependencies` 与 `devDependencies` 之间挪位置，都要跑 `npm install`
（不想动 `node_modules` 时用 `npm install --package-lock-only`），提交前用 `npm ci --dry-run`
自检，必须 exit 0。

漏掉的后果：CI 里的 `npm ci` 会以
`npm ci can only install packages when your package.json and package-lock.json are in sync` 失败，
而**本地 `npm run dist` 完全正常**（它不跑 `npm ci`），所以只在本机验证是发现不了的。

## 加完依赖要重跑许可声明

`npm run notices`（`scripts/build-notices.mjs`）读 `src/renderer/vendor/meta.json`——
`npm run build` 留下的「这次真正打进了哪些文件」清单——反查所属的 npm 包，把各自的许可
原文汇成 `build/notices/THIRD-PARTY-NOTICES.md`，随安装包放进 `resources/notices/`。

包名单是**推导出来的，不是手写的**，所以换依赖不用改这个脚本；但脚本会在两种情况下直接
失败并说明原因：某个包没有 `license` 字段，或者它是 Apache-2.0 却在包里找不到许可原文
（Apache-2.0 要求随分发附上原文，找不到就不能装作合规）。

`predist` 里已经串上这一步，正常打包不用管。手工改过 `src/renderer/vendor/` 或想单独
确认声明时，`npm run build && npm run notices` 重跑一次即可。

## MyGo shell 的 Go 依赖

`mygo/` 是独立的 Go module（`mygo/go.mod` / `mygo/go.sum`）。改 Go 依赖、或调整
`replace` 指向的 fork 时，要跑 `cd mygo && go mod tidy` 并提交 `go.sum`；CI 用
`go-version-file: mygo/go.mod` 装 Go，缺 `go.sum` 条目会直接失败。

`replace github.com/egoist/mygo => github.com/wwjei/mygo v0.7.1-lit.2` 指向带
`Window.NewChildWebView()` 的 fork（内嵌网页列）。这个 tag 不在 sum.golang.org 上，
第一次拉取时需要 `GOPRIVATE=github.com/wwjei/mygo go mod tidy` 生成校验条目；之后
普通构建不受影响。国内网络拉 `proxy.golang.org` 超时时可用
`GOPROXY=https://goproxy.cn,direct`。fork 的维护方式见
[build.md](build.md#两个-shell-electron-与-mygo)。

## 依赖更新走 Dependabot

[.github/dependabot.yml](../../.github/dependabot.yml) 每周检查 npm、每月检查 GitHub Actions。
它改依赖会同时改 `package.json` 与 `package-lock.json`，所以不会踩上面那个锁文件坑；
CI 里的 `npm ci` 是最后一道校验。Electron 的大版本升级被显式忽略——sandbox、自定义协议、
`webPreferences` 的行为都可能变，要人工过一遍。

## 漏洞扫描要分两堆看

`npm run audit`（`scripts/audit-report.mjs`）读 `vendor/meta.json`，把 `npm audit` 的结果
按「会不会进安装包」分开：被 esbuild 打进 `src/renderer/vendor/` 的包跟着安装包分发；
**Electron 也算进这一堆**——它的 JS 包不经过 esbuild，但运行时二进制由 electron-builder
原样随包分发；electron-builder / esbuild 那一系才只在构建机上跑。

**退出码只由「会进安装包」且 high / critical 的项决定。** moderate 与「仅构建期」一律只
报告——它们常常没有可用的修复（上游把范围钉死了，比如 pptx-preview 钉的 `echarts ^5.5.1`
永远解析不到修好的 6.x），卡住所有构建没有意义。CI 里跑的就是这一步。

它只回答「这个包进不进产物」，**不回答「这段代码在我们这里跑不跑得到」**，后者要人看。
当前那三条进产物的 moderate 漏洞的可达性结论（都够不着）与复查触发条件，记在
[docs/security-debt.md](../security-debt.md)。

想验证分类逻辑而不改网络状态时，可以把一份 `npm audit --json` 的结果放进文件，用
`AUDIT_JSON=<文件> node scripts/audit-report.mjs` 跑；Electron 的 high / critical 必须
让退出码变成 1（这条在 2026-10-24 的审查里补上）。
