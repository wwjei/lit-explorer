# CODEMAP

面向 Agent 与新会话的代码入口索引：**先查这张表，再决定读哪几个文件**。产品行为以
[FEATURES.md](FEATURES.md) 为准，施工约束见 [AGENTS.md](AGENTS.md)，本文只记结构与入口，
不重复需求细节。

维护规则：新增业务组件、关键方法、IPC / 协议 / DOM 约定时同步本表；只列稳定入口，
不列随时会改的私有小函数。表里的「搜索」列是改代码时最省事的落点。

## 1. 进程与启动

- `src/main/main.js`：主进程。`createWindow()`、`registerPreviewProtocol()`（`pv://`）、
  `registerIpc()`、`openWorkspace()`、`showContextMenu()`、`showAppMenu()`。
- `src/main/preload.js`：`contextBridge` 只暴露 `pv.*`；渲染进程所有读写都从这里过。
- `src/shared/contracts.js`：主进程与渲染进程共用的数量上限与可固定类型白名单
  （`MAX_PINS`、`MAX_PROJECTS`、`MAX_FAV_ITEMS`、`MAX_URL_CHARS`、`PINNED_KINDS`…）。
- `src/renderer/index.html` → `app.js`：界面编排。模块是 IIFE + `window.PV`，加载顺序是契约：
  `shared/contracts → paths → icons → highlight → markdown → pane → preview-body → webview →
  svgedit → find → projects → app`。`vendor/docpreview` 不在这条链上，由 `PV.body.loadDocPreview()`
  在第一次打开 docx / pptx 时按需注入。
- `src/renderer/vendor/`、`build/icons/`、`build/notices/` 是生成物，不手改。

## 2. 按任务找入口

| 要改什么 | 先看 | 关键方法 / 选择器 | 搜索关键字 |
| --- | --- | --- | --- |
| 窗口、标题栏、原生菜单、文件右键菜单 | `src/main/main.js`、`src/renderer/app.js` | `createWindow()`、`showContextMenu()`、`showAppMenu()`、`ui:context-menu` | `app:rescan`、`window:minimize`、`showItemInFolder` |
| 打开工作区、路径授权边界 | `main.js`、`src/main/fs-api.js` | `openWorkspace()`、`offerRoot()`、`allowRoot()`、`assertAllowed()`、`isInsideAnyRoot()` | `EACCES_ROOT`、`NOT_OFFERED`、`workspace:open`、`workspace:opened` |
| 文件列表、多栏导航、虚拟滚动 | `src/renderer/app.js` | `loadColumn()`、`buildColumn()`、`renderColumns()`、`renderColumnWindow()`、`selectNode()`、`itemsOf()`、`restoreNav()` | `state.path`、`state.cols`、`nav`、`revealPreview`、`.col-list`、`.row`、`ensureVisible` |
| 预览区布局、宽度、固定列、分屏、项目布局快照 | `src/renderer/pane.js`、`src/renderer/styles.css` | `createColumn()`、`layoutColumn()`、`renderPreview()`、`pinCurrent()`、`makePinPaneFromTemp()`、`applySplit()`、`applyInsert()`、`dropInfo()`、`paneBudget()`、`unpinPane()`、`layoutSnapshot()`、`restoreLayout()` | `bodyKey`、`reqId`、`pending`、`MAX_PINS`、`MAX_PANES_PER_COL`、`nav.layout`、`mainFloor`、`.pane-col`、`.pane-stack`、`.pane-split`、`.pv-grip` |
| 路径比较 / 相对工作区的显示路径 | `src/renderer/paths.js` | `same()`、`within()`、`partsUnder()`、`relUnder()`、`compareNodes()`、`baseName()` | `PV.paths` |
| 跨进程上限与可固定类型 | `src/shared/contracts.js` | `MAX_PINS`、`MAX_PANES_PER_COL`、`MAX_PROJECTS`、`MAX_FAV_ITEMS`、`MAX_URL_CHARS`、`MAX_MD_IMAGES`、`PINNED_KINDS` | `PV.contracts` |
| 预览正文按类型分派、头部按钮 | `src/renderer/preview-body.js` | `RENDERERS`、`pickRenderer()`、`capabilities()`、`renderPaneBody()`、`bodyKeyFor()`、`paneHeadHtml()`、`webHeadHtml()`、`loadDocPreview()`、`noteLoaded()` | `PV.body`、`RENDERERS`、`match`、`capabilities`、`pane.mode`、`pane.svgEdit`、`loadingState`、`fallbackCard` |
| Markdown 渲染、链接与图片白名单 | `src/renderer/markdown.js` | `toHtml()`、`imageSources()`、`safeHref()`、`safeImgSrc()` | `javascript:`、`markdown`、`inline()`、`md-img-missing` |
| 代码高亮、降级与 Worker | `src/renderer/highlight.js`、`src/renderer/highlight/` | `mount()`、`plan()`、`tokenize()`、`tokenHtml()`、`highlightFences()` | `PV.highlight`、`shiki`、`cacheGet`、`getWorker` |
| Word / PPT 内嵌预览 | `src/renderer/docpreview.js`、`preview-body.js` | `renderDocx()`、`renderPptx()`、`renderDocPreview()`、`loadDocPreview()`、`sanitizeDocDom()` | `docx-preview`、`pptx-preview`、`altChunk`、`PV.docpreview`、按需加载 |
| 图片 / HTML / PDF 的协议预览地址 | `src/main/main.js`、`preview-body.js` | `toPreviewUrl()`、`registerPreviewProtocol()`、`resolveImageTargets()`、`renderImageView()`、`renderImageSeq()` | `pv://local`、`fs:preview-url`、`fs:resolve-images`、`?v=<mtime>-<size>`、`cache-control: no-store` |
| 图片缩放、连续预览 | `preview-body.js`、`pane.js` | `renderImageView()`、`renderImageSeq()`、`setZoom()`、`toggleSeq()`、`paneScrollKeep()` | `pane.zoom`、`pane.continuous`、`.imgseq`、`.img-wrap` |
| 网页快速访问 / 内嵌网页 | `app.js`、`src/renderer/webview.js`、`src/main/web-views.js`、`src/main/web-url.js` | `openWebFavorite()`、`openWebForm()`、`handleWebState()`、`PV.web.sync()`、`webViews.sync()`、`normalizeWebUrl()`、`configureSession()`、`clipboardAllowed()`、`askClipboard()` | `web:sync`、`WebContentsView`、`favs`、`pane.webCurrentUrl`、`setOccluded`、`setDragHidden`、`clipboard-read`、`clipboard-sanitized-write`、`permissions.query` |
| 预览内查找 | `src/renderer/find.js` | `open()`、`refresh()`、`carryFrom()`、`afterRender()`、`markMatches()` | `PV.find`、`.find-bar`、`mark.find-hit`、`Ctrl+F` |
| SVG 编辑与受限保存 | `src/renderer/svgedit.js`、`preview-body.js`、`src/main/fs-api.js` | `mount()`、`parseSvg()`、`sanitize()`、`createEditor()`、`writeSvgFile()`、`pv.writeSvg` | `fs:write-svg`、`pane.svgEdit`、`pane.view`、`CONFLICT`、`MAX_SVG_WRITE_BYTES` |
| 项目切换条、项目图标、下划线动画 | `src/renderer/projects.js`、`styles.css` | `renderDock()`、`markActive()`、`rememberLine()`、`applyLineMove()`、`openPicker()`、`quickHtml()`、`setIcon()`、`applyTextIcon()`、`sanitizeIcon()`、`navOf()`、`saveNav()` | `PV.projects`、`nav`、`.proj-dock`、`.proj-tile`、`is-line-move`、`--proj-line-from`、`.pj-pop`、`.pj-text-in` |
| 设置持久化与白名单 | `src/main/store.js`、`src/main/state-sanitize.js` | `load()`、`patch()`、`sanitizePatch()`、`sanitizeProjects()`、`sanitizeNav()`、`sanitizeLayout()`、`sanitizeIcon()`、`sanitizeFavorites()` | `app:get-state`、`app:set-state`、`state.json`、`DEFAULTS`、`nav.layout` |
| 外部变更监测、重新扫描提示 | `app.js` | `startChangeWatch()`、`pollPane()`、`pollOpenDirs()`、`rescan()`、`PV.pane.renderPane()` | `dirtyDirs`、`dirKnown`、`is-changed`、`[data-rescan]`、`setInterval` |
| 主题、窗口几何、面板比例 | `app.js`、`main.js`、`src/main/state-sanitize.js`、`styles.css` | `applyTheme()`、`setPreviewVisible()`、`swapLeftPanels()`、`applyLeftSplit()`、`windowBounds()` | `[data-theme]`、`previewOpen`、`leftSplitRatio`、`favTop`、`window` |
| 单元 / 集成 / 界面测试 | `test/unit.test.cjs`、`test/integration.test.cjs`、`test/probe-harness.js`、`scripts/run-probe.mjs` | `run()`、`ok()`、`eq()`、`done()`、`H.pick / H.temp / H.cols / H.pins` | `--only`、`--skip`、`npm run probe`、`[shot-js]` |

## 3. 关键数据与 DOM 契约

- **文件节点 `node`**：`{ path, name, isDir, kind, size, mtime }`；网页节点另有
  `{ kind:'web', url, webCurrentUrl, webError }`。`kind` 由 `fs-api.kindFor()` 与
  `app.js` 的网页条目共同决定。
- **窗格 `pane`**：`bodyKey`（内容身份）、`reqId` / `pending`（异步任务身份）、`node`、
  `mode`、`view`、`svgEdit`、`zoom`、`continuous`、`changed`、`known`、`col`、`findEl`。
- **列 `column`**：`{ el, stack, splitEl, panes:[pane…], w, split, temp }`。宽度和上下比例
  属于列，不属于单个窗格；一列最多 2 个窗格。
- **项目 `project`**：`{ path, name, icon, nav }`；`icon` 只接受
  `{type:'glyph',id}`、`{type:'image',data}`、`{type:'text',text}` 或 `null`（名字首字）。
- **`state.json`**：`theme / previewOpen / previewWidth / lastRoot / window / recentRoots /
  projects / hideDot / favorites / favTop / leftSplitRatio / previewDocx / previewPptx`。
  渲染进程只能通过 `app:set-state` 写白名单字段。
- **DOM / CSS 契约**：`.pane-col > .pane-stack > .pane`、`.pane-split`、`.pv-grip`、
  `.proj-dock > .proj-tile`、`.proj-tile.is-on::after`、`.pj-pop`；改结构先更新
  `test/probe-harness.js` 顶部的选择器约定与 [docs/agents/build.md](docs/agents/build.md)。

## 4. 主要链路

- **打开工作区**：`openWorkspace()`（main）→ `workspace:opened` → `app.openRoot()` →
  `PV.projects.setActive/noteOpened()`（记录旧下划线位置）→ `render()` 重建第一栏 →
  `PV.projects.mount()` / `renderDock()` → `applyLineMove()`。
- **预览渲染**：`app.render()` → `PV.pane.renderPreview()` → `renderPane()` →
  `runTask()` → `PV.body.render()` → `task.write/replace`（晚到的旧任务因 `reqId` 丢弃）→
  `afterLayout()` → `PV.web.schedule()`。
- **固定 / 分屏**：`.pv-grip` pointerdown → `dropInfo()` 决定 `split` 或 `insert` →
  `makePinPaneFromTemp()` / `adoptPaneBody()` → `applySplit()` / `applyInsert()` →
  `renderPreview()` → `restorePaneTop()`。
- **查找**：`Ctrl+F` → `PV.find.open()`；渲染完成后 `afterRender()` 重落高亮；固定 / 分屏迁移时
  `carryFrom()` 把查询词带到新窗格。
- **SVG 保存**：`PV.svgedit.mount()` → 编辑动作 → 自动保存队列 → `pv.writeSvg()` →
  `fs:write-svg` → `writeSvgFile()`（校验真实路径 / 扩展名 / size+mtime 基线，临时文件原子替换）。
- **项目切换**：`.proj-tile` click → `switchProject()` → `pv.openRoot()` → 主进程
  `openWorkspace()` → `workspace:opened` → `app.openRoot()`。

## 5. 测试与探针

- 纯逻辑：`npm run test:unit`（`test/unit.test.cjs`，S2–S7 等）。
- Electron 集成：`npm run test:integration -- --only=P3,P4`（`test/integration.test.cjs`）；
  全部用例 id 在文件头。
- 界面截图：`npm run probe -- .tmp/my-probe.js --open=.tmp/ws`；探针骨架是
  `test/probe-harness.js`，`H.*` 选择器与等待都在里面，**改界面结构要先改骨架**。
- 文档索引：`npm run check:docs`（`scripts/check-docs.mjs`）检查 `docs/` 下的文档都进了
  AGENTS.md / CODEMAP.md，且相对链接没有死链；CI 在开 PR 与合并进 main 时跑。
- 会受原生 `WebContentsView` 影响的网页列，`capturePage()` 拍不到页面内容；只截图宿主 UI。

## 6. MyGo 移植实验（分支 `spike/mygo`，未合入主线）

用 Go + 系统 WebView2 承载同一份 `src/renderer`，只重写主进程能力。结论见
[docs/design/mygo-port.md](docs/design/mygo-port.md)。

| 要改什么 | 先看 | 关键入口 | 搜索关键字 |
| --- | --- | --- | --- |
| 窗口、菜单、单实例、预览服务 | `mygo/main.go` | `createWindow()`、`startPreviewServer()`、`OpenContextMenu()`、`OpenAppMenu()`、`App.*` 绑定方法 | `mygo.BindAs`、`previewBase`、`Frameless` |
| 文件系统授权边界与 SVG 保存 | `mygo/fsapi.go` | `assertAllowed()`、`realPath()`、`listDir()`、`writeSvgFile()`、`kindFor()` | `EACCES_ROOT`、`CONFLICT`、`cachedError` |
| 设置持久化与白名单 | `mygo/statefile.go` | `loadState()`、`patchFromPage()`、`sanitizeLayout()` | `state.json`、`web` 固定列被丢弃 |
| 渲染层桥接 | `mygo/bridge.js` | `window.pv`、`capabilities.webPane` | `mygo.call`、`on('pv:…')` |
| 前端资源打包 | `mygo/stage-frontend.mjs` | 生成 `mygo/frontend/`（gitignore）供 `go:embed` | `stage-frontend` |

网页内嵌能力在 MyGo 版没有对应物：`app.js` 的 `openWebFavorite()` 按
`pv.capabilities.webPane === false` 改为系统浏览器打开；`webSync` / `webReload` /
`onWebState` 是空实现。

## 7. 文档地图

| 文档 | 用途 |
| --- | --- |
| [FEATURES.md](FEATURES.md) | 产品行为、明确的非目标 |
| [README.md](README.md) | 用户用法与已知限制 |
| [AGENTS.md](AGENTS.md) | 施工红线、按场景读的索引 |
| [docs/agents/build.md](docs/agents/build.md) | renderer 分层、构建、加载顺序 |
| [docs/agents/verify.md](docs/agents/verify.md) | 测试 / 探针 / 安装包验证 |
| [docs/agents/security.md](docs/agents/security.md) | preload、IPC、自定义协议、写入通道 |
| [docs/security-debt.md](docs/security-debt.md) | 已知但暂无可行修法的依赖 / 安全问题 |
| [further_notes.md](further_notes.md) / [PENDING.md](PENDING.md) | 想做的功能 / 顺手清的小问题 |
