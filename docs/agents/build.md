# 构建

## 生成物

`src/renderer/vendor/`、`build/icons/` 与 `assets/icon.svg` 是生成物，已在 `.gitignore` 里，
不要手改、不要提交。`npm start` / `dev` / `shot` / `dist` 都带 `pre*` 钩子会自动先构建。

`src/renderer/` 下这两处必须过 esbuild，因为它们的依赖是裸模块名，浏览器无法解析：

- `highlight/worker.js` → Shiki 分词 Worker。用 `--splitting` 切成按需 chunk，
  保持「只加载用到的那一种语言」。
- `docpreview.js` → docx / pptx 预览。打成 IIFE 挂到 `window.PV.docpreview`，
  由 `index.html` 直接 `<script>` 加载。

图标的几何定义在 `scripts/build-icons.mjs`（自带 SDF 光栅化与 PNG / ICO 编码，无第三方依赖）。
改图标改脚本，不要改产物。

## 打包内容

`build.files` 只收 `src/**`、`assets/**`、`package.json`；`extraResources` 另外放
`FEATURES.md`、`docs/**`、`sample-project/**` 供安装后查阅。
`docs/agents/**` 是给贡献者的，已从 `extraResources` 排除，不要让它进安装包。
