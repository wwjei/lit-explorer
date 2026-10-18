# 依赖与 lock 文件

## 依赖都放 devDependencies

`dependencies` 是空的。主进程只用 electron 与 node 内置模块；shiki、docx-preview、
pptx-preview、jszip 都由 esbuild 打包进 `src/renderer/vendor/`，运行时不需要 `node_modules`。

`dependencies` 非空时 electron-builder 会把 `node_modules` 打进 `app.asar`
（pptx-preview 依赖的 echarts + zrender 一项就约 55 MB，实测 `app.asar` 从 4.5 MB 涨到 81 MB）。
新增依赖请放进 `devDependencies`。

## 改依赖必须同步 package-lock.json

任何对 `package.json` 依赖的改动——增删依赖，或只是把包在 `dependencies` 与
`devDependencies` 之间挪位置——都要让 lock 跟上：

```bash
npm install                       # 同步 package-lock.json
npm install --package-lock-only   # 不想动 node_modules 时

npm ci --dry-run                  # 提交前自检，必须 exit 0
```

漏掉这一步的后果：CI 里的 `npm ci` 会以
`npm ci can only install packages when your package.json and package-lock.json are in sync` 失败，
而**本地 `npm run dist` 完全正常**（它不跑 `npm ci`），所以只在本机验证是发现不了的。
