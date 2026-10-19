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

## 依赖更新走 Dependabot

[.github/dependabot.yml](../../.github/dependabot.yml) 每周检查 npm、每月检查 GitHub Actions。
它改依赖会同时改 `package.json` 与 `package-lock.json`，所以不会踩上面那个锁文件坑；
CI 里的 `npm ci` 是最后一道校验。Electron 的大版本升级被显式忽略——sandbox、自定义协议、
`webPreferences` 的行为都可能变，要人工过一遍。

## 漏洞扫描要分两堆看

`npm run audit`（`scripts/audit-report.mjs`）读 `vendor/meta.json`，把 `npm audit` 的结果
按「会不会进安装包」分开：被 esbuild 打进 `src/renderer/vendor/` 的包跟着安装包分发，
electron-builder / electron / esbuild 那一系只在构建机上跑。

**退出码只由「会进安装包」且 high / critical 的项决定。** moderate 与「仅构建期」一律只
报告——它们常常没有可用的修复（上游把范围钉死了，比如 pptx-preview 钉的 `echarts ^5.5.1`
永远解析不到修好的 6.x），卡住所有构建没有意义。CI 里跑的就是这一步。

它只回答「这个包进不进产物」，**不回答「这段代码在我们这里跑不跑得到」**，后者要人看。
例如 echarts 那条 XSS（GHSA-fgmj-fm8m-jvvx）需要 Lines 系列，而 pptx-preview 只产出
pie / line / bar；uuid 那条（GHSA-w5hq-g745-h8pq）只影响 v3/v5/v6 带 `buf` 的调用，
而 pptx-preview 只 import 了 `v4`。两条都够不着，结论记在
[further_notes.md](../../further_notes.md)。
