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

## 渲染进程的模块分层

除上面两处打包产物，`src/renderer/` 下都是**普通脚本**：各是一个 IIFE，往 `window.PV`
上挂东西，由 `index.html` 按固定顺序 `<script>` 加载，没有模块系统：

```
icons.js → highlight.js → markdown.js → vendor/docpreview.js
         → pane.js → preview-body.js → find.js → app.js
```

**加载顺序是契约**：后加载的文件可以在函数体里引用前面的（`PV.pane` / `PV.body` /
`PV.find`），反过来只在运行时引用、不在加载时引用。

| 文件 | 管什么 |
| --- | --- |
| `pane.js`（`PV.pane`） | 预览窗格作为一个单元的全部事情：内容身份 `bodyKey`、渲染任务身份 `reqId` / `pending`、创建与销毁、固定时的正文迁移、每列的宽度与排列 |
| `preview-body.js`（`PV.body`） | 正文与头部**画成什么样**：按类型分派（Markdown / 代码视图 / 图片与连续预览 / HTML 迷你浏览器 / PDF / docx / pptx）、头部副标题与元信息、缩放档位 |
| `find.js`（`PV.find`） | 预览内查找：查找条、命中标记、在命中之间跳转 |
| `app.js` | 目录导航（多栏、虚拟滚动、快速访问）、键盘 / 指针 / 主进程事件接线，以及把上面三个模块接起来 |

分层是为了把「异步任务与界面归属」收在一处：正文**只能通过任务对象写**
（`task.write` / `task.replace`，见 `pane.js` 的 `beginTask`），晚到的旧任务写不动，
所以每个渲染分支不必各自记着比对 key 或请求编号——C1 / C2 / C4 那类「旧响应盖住新内容」
就是从这里漏出去的。

接线的方向是**单向**的：`app.js` 调 `PV.body.init()` 与 `PV.pane.init()`，把
`PV.body.head / render / key` 三个口子装到窗格上，同时把两边都需要的应用状态注入进去
（`selection` / `mode` / `root` / `previewPrefs` / `itemsInDir` / `toast`）。窗格只决定
「什么时候画」，`PV.body` 决定「画成什么样」，`app.js` 提供「画什么」。

动这个分层时，`test/integration.test.cjs` 的 C1 / C2 / C4 / F1 / P1 就是它的回归网。

## 打包内容

`build.files` 只收 `src/**`、`assets/**`、`package.json`；`extraResources` 另外放
`FEATURES.md`、`docs/**`、`sample-project/**` 供安装后查阅。
`docs/agents/**` 是给贡献者的，已从 `extraResources` 排除，不要让它进安装包。
