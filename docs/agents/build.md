# 构建

## 两处必须打包的源码

`src/renderer/vendor/` 是生成物（已在 `.gitignore` 里），不要手改、不要提交：

- `src/renderer/highlight/worker.js` → Shiki 分词 Worker。Shiki 产物用裸模块名
  （`@shikijs/core` 等），浏览器无法解析，必须用 esbuild 打包，并用 `--splitting`
  切成按需 chunk，保持「只加载用到的那一种语言」。
- `src/renderer/docpreview.js` → docx / pptx 预览。同样因为裸模块名
  （`docx-preview`、`pptx-preview`、`jszip`），打成 IIFE 挂到 `window.PV.docpreview`，
  由 `index.html` 直接 `<script>` 加载。

`build/icons/` 与 `assets/icon.svg` 由 `scripts/build-icons.mjs` 生成（含自带 SDF 光栅化与
PNG / ICO 编码，无第三方依赖）。改图标改脚本里的几何定义，而不是改产物。

## 命令

| 命令 | 做什么 |
| --- | --- |
| `npm run build` | 只构建渲染进程产物（esbuild 两条通道） |
| `npm run icons` | 生成 SVG 母版与各尺寸 ICO |
| `npm start` / `npm run dev` | 启动（`prestart` 自动先 build） |
| `npm run dist` | 出 Windows 安装包与免安装版到 `dist/`（`predist` 自动先 build + icons） |

`start` / `dev` / `shot` / `dist` 都带 `pre*` 钩子，改完上面两个入口后不必手动构建。

## 打包内容

`package.json` 的 `build.files` 只收 `src/**`、`assets/**`、`package.json`；
`extraResources` 另外放 `FEATURES.md`、`docs/**`、`sample-project/**` 供安装后查阅。
`docs/agents/**` 是给贡献者的，已从 `extraResources` 里排除，不要让它进安装包。
