# 构建

## 生成物

`src/renderer/vendor/`、`build/icons/` 与 `build/icon.ico` 是生成物，已在 `.gitignore` 里，
不要手改、不要提交。`npm run build` 会先生成图标，再构建渲染进程；
`npm start` / `dev` / `shot` / `dist` 都会先走这一步。

`src/renderer/` 下这两处必须过 esbuild，因为它们的依赖是裸模块名，浏览器无法解析：

- `highlight/worker.js` → Shiki 分词 Worker。用 `--splitting` 切成按需 chunk，
  保持「只加载用到的那一种语言」。
- `docpreview.js` → docx / pptx 预览。打成 IIFE 挂到 `window.PV.docpreview`，
  由 `index.html` 直接 `<script>` 加载。

图标源文件是 `assets/icon-source.png`（正方形、8 位 RGBA、非交错 PNG），
README 与界面直接使用它。`scripts/build-icons.mjs` 自带 PNG 解码、预乘 alpha 的面积缩放
与 PNG / ICO 编码，无第三方依赖；改图标时替换源图，再运行 `npm run icons`，不要改产物。

## 渲染进程的模块分层

除上面两处打包产物，`src/renderer/` 下都是**普通脚本**：各是一个 IIFE，往 `window.PV`
上挂东西，由 `index.html` 按固定顺序 `<script>` 加载，没有模块系统：

```
src/shared/contracts.js（主进程 require，渲染进程先加载）
paths.js → icons.js → highlight.js → markdown.js → vendor/docpreview.js
         → pane.js → preview-body.js → webview.js → svgedit.js → find.js → projects.js → app.js
```

**加载顺序是契约**：后加载的文件可以在函数体里引用前面的（`PV.pane` / `PV.body` /
`PV.web` / `PV.svgedit` / `PV.find` / `PV.projects`），反过来只在运行时引用、不在加载时引用。

| 文件 | 管什么 |
| --- | --- |
| `src/shared/contracts.js` | 两个进程必须一致的数量上限与可固定类型白名单。主进程 `require`，渲染进程由 `index.html` 先加载成 `PV.contracts`；两边读同一份，避免上限 / 类型名单各写一遍后漂移 |
| `paths.js`（`PV.paths`） | 界面层的路径比较与展示：Windows 大小写不敏感、`\` 与 `/` 等价、相对工作区根的各段与副标题。主进程 `fs-api.js` 的真实路径校验是另一件事，不要合并 |
| `pane.js`（`PV.pane`） | 预览窗格作为一个单元的全部事情：内容身份 `bodyKey`、渲染任务身份 `reqId` / `pending`、创建与销毁、固定 / 分屏时的正文迁移、列模型（一列 1–2 个窗格，列宽与上下比例）、抓手换位 / 下 1/3 分屏 / 临时列右拖自动固定 |
| `preview-body.js`（`PV.body`） | 正文与头部**画成什么样**：按类型分派（Markdown / 代码视图 / 图片与连续预览 / HTML 迷你浏览器 / PDF / docx / pptx / 网页 / SVG 编辑）、头部副标题与元信息、缩放档位 |
| `webview.js`（`PV.web`） | 内嵌网页的几何同步：把每个网页预览列当前该占的矩形声明给主进程（`web:sync`），用 rAF 合并拖动与缩放；弹层打开时先 `setOccluded(true)`、拖动列 / 分隔条 / 窗格时先 `setDragHidden(true)` 把原生视图藏起来（松手后按新矩形回来） |
| `svgedit.js`（`PV.svgedit`） | SVG 编辑模式的正文：解析与安全清洗、选择、拖动（矩形带框内文字）、矩形八向缩放、文字单行编辑、删除、撤销重做、自动保存；它自己管 `pane.view.destroy` 清理监听与 ResizeObserver |
| `find.js`（`PV.find`） | 预览内查找：查找条、命中标记、在命中之间跳转 |
| `projects.js`（`PV.projects`） | 项目切换条：最多 5 个项目、图标目录与图标选择、每项目浏览位置与固定列布局的持久化；打开 / 切换由 `app.js` 通过 `PV.projects.init()` 注入 |
| `app.js` | 目录导航（多栏、虚拟滚动、快速访问与网页条目）、键盘 / 指针 / 主进程事件接线，以及把上面几个模块接起来 |

分层是为了把「异步任务与界面归属」收在一处：正文**只能通过任务对象写**
（`task.write` / `task.replace`，见 `pane.js` 的 `beginTask`），晚到的旧任务写不动，
所以每个渲染分支不必各自记着比对 key 或请求编号——C1 / C2 / C4 那类「旧响应盖住新内容」
就是从这里漏出去的。

接线的方向是**单向**的：`app.js` 调 `PV.body.init()` 与 `PV.pane.init()`，把
`PV.body.head / render / key` 三个口子装到窗格上，同时把两边都需要的应用状态注入进去
（`selection` / `mode` / `root` / `previewPrefs` / `itemsInDir` / `toast`）。窗格只决定
「什么时候画」，`PV.body` 决定「画成什么样」，`app.js` 提供「画什么」。

`PV.projects` 反过来：它自己管列表、图标与持久化，只把「切换到这个项目」「打开一个新项目」
两个动作交回 `app.js`（`PV.projects.init({ switchTo, openNew, toast })`）。切换前的导航快照
与切换后的逐级恢复在 `app.js` 里，因为只有它知道 `state.path` 与各栏的加载状态。

网页视图的创建与安全策略不在渲染进程：`src/main/web-views.js` 按 `web:sync` 的声明增删
`WebContentsView`，`src/main/web-url.js` 是两个进程共用的地址白名单。`PV.web` 只负责
「按现在的布局，每个网页列该占哪块矩形」，不直接碰主进程的视图对象。

SVG 编辑的写文件不在渲染进程：`PV.svgedit` 只调 `pv.writeSvg()`，真正落盘的是
`src/main/fs-api.js` 的 `writeSvgFile()`。它只接受工作区内已存在的 `.svg`、要版本基线
（size / mtime）并在不一致时返回 `CONFLICT`，写临时文件后原子替换；边界见
[security.md](security.md#svg-编辑的写入通道)。

动这个分层时，`test/integration.test.cjs` 的 C1 / C2 / C4 / F1 / P1 / P3 / P4 / E1 / E2 / E3 / W1
就是它的回归网。

## 打包内容

`build.files` 只收 `src/**`、`assets/**`、`package.json`；`extraResources` 另外放
`FEATURES.md`、`docs/**`、`sample-project/**` 供安装后查阅。
`docs/agents/**` 是给贡献者的，已从 `extraResources` 排除，不要让它进安装包。
