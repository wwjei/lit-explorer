# 后续笔记

这里记「已经想过、但还没做」的事：动机、调研数据、结论与下一步。

## 这份文件怎么用

- **进这里**：想清楚了但暂时不做的功能（要带调研结论，不能只有一句话）、已知但决定
  先不修的缺陷、从审查或复盘里带出来又没落地的建议（**标出处**）。
- **不进这里**：已经做出来的行为（进 [FEATURES.md](FEATURES.md)）、操作手册（进
  [docs/agents/](docs/agents/)）、一次性的调试记录（留在提交信息里）。
- **做完了就把整条删掉**，别在这里维护「已完成」列表——它一旦变成流水账就没人读了。
- 条目编号 `N`，新的排在前面。

---

## N3 · 安全审查里没落地的三条设计建议（未实施）

出处：`security-review.md`（2026-10-19 审查，基线 `9d7ab0d`）末尾「设计层面的改进意见」。
七条可复现的发现已经全部修掉并补了回归测试（`ad96bb2`、`a2ce5a9`），但同一份审查里
另有五条设计建议，其中两条顺带覆盖了，剩下三条仍然悬着。**审查文件本身已入库，但它的
正文是审查当时的快照，只有下面这三条还活着——所以在这里留一份，免得下一个人以为全都
做完了。**

### 已覆盖

- 「区分内容身份与任务身份」→ pane 上的 `reqId` / `pending` 就是这件事：内容 key 决定
  「该显示什么」，请求编号决定「这是不是我那一次」。
- 「给关键异步交错补回归测试」→ `test/integration.test.cjs` 的 C1 / C2 / C4。

### 仍悬着

1. **统一 pane 生命周期。** C1 / C2 / C4 都属于「异步任务与界面归属不一致」，现在是在
   `renderPane` 里用一个请求编号兜住，各渲染分支仍各自维护自己的检查。`src/renderer/
   app.js` 已经 2200 行，pane 生命周期、目录导航、查找三块混在一个文件里；真要拆，
   就按这三块切，并把请求编号、加载状态、销毁与迁移集中到一处。
2. **缩小宿主权限入口。** IPC 缺统一的发送者与参数校验；`workspace:open` 不验证目录
   是否来自受信任的选择流程——渲染进程可以把它能构造出的任意现存目录登记成授权根。
   注意发送者校验拦不住「已经在合法宿主页面里跑起来的脚本」，所以它不能替代注入防线，
   只是多一层。
3. **明确 HTML 预览的数据读取策略。** `pv://` 返回 `Access-Control-Allow-Origin: *`，
   授权根在进程内累计，实测不透明源 iframe 能读已授权工作区里的标记文件。这和「HTML
   预览要能 fetch 相对资源」是同一个设计带来的，所以没被单独判为漏洞；但要明确：
   不可信预览该不该读到整个工作区、该不该读到**此前**打开过的工作区、该不该联网。
   要收紧的话，方向是按预览或工作区隔离会话与资源授权。

---

## N2 · 代码视图里的 Ctrl+F（未实施）

### 现象

在 Go / JS 这类文件的预览（源码视图）里按 Ctrl+F，不会打开查找条，而是弹一句
「这一列不支持查找：Markdown 与 Word / PPT 预览里可以用 Ctrl+F」。

### 这是有意排除的，不是漏了

`paneFindable()`（`src/renderer/app.js:1426`）明确把带 `.codeview` 的窗格排除在外，
Ctrl+F 的分支（`src/renderer/app.js:2012`）据此给出提示。

### 为什么当初排除

查找是纯 DOM 实现：`collectTextNodes()` 用 TreeWalker 收集文本节点，`markMatches()`
把命中处原地包成 `<mark>`。而代码视图是虚拟滚动的，`.cv-win` 里只挂可见窗口那几十行。

实测一个 1187 行的 Go 文件（`.tmp/gows/main.go`，第 5 行与第 1150 行各有一个
`ZEBRAFISH` 标记）：

```text
状态条：1187 行 · 57.9 KB · 分词 332ms · 渲染 6ms · DOM 119 行 · 完整高亮
firstMarkerInDom: true      secondMarkerInDom: false
domTextNodes: 2296          domZebraNodes: 1
```

DOM 里只有 119 行、两个标记只找得到一个。也就是说 DOM 查找最多只能命中当前可见的那几行，
做成「能搜」反而是误导。

### 修法思路

查找要走文本模型，不走 DOM。

- `PV.highlight.mount()` 内部持有 `state.lines`（整份文本按行切好），但对外只返回
  `{ destroy }`（`src/renderer/highlight.js:420`）。需要给它加一个 `find(query)` →
  `[{ line, start, end }]` 的接口，在 `state.lines` 上做大小写不敏感的匹配。
- 高亮不能像 Markdown 那样拆文本节点——代码行里是 Shiki 的 token `<span>` 结构，拆了会
  毁掉着色。改为在 `buildRow(i)` 渲染时按行号查命中区间，在 token 边界内套
  `<span class="find-hit">`。
- `stepFind` 只需要改 `.cv-scroll` 的 `scrollTop` 把目标行带进视口（`.cv-scroll` 已经在
  `PANE_SCROLLERS` 里）。
- `paneFindable()` 要改成按能力判断（这一列的内容支不支持查找），而不是按 DOM 里有没有
  `.codeview` 判断。
- 代码视图的命中数不该受 `FIND_MAX = 2000` 的 DOM 上限约束，可以直接报真实值。

### 规模

比 Markdown 的查找大一档，难点是「在 token span 里套命中」和虚拟滚动下的命中维护
（滚出视口的行会被回收重建，重建时要重新套上命中）。优先级取决于用代码视图读代码的频率，
目前看是次要功能。

---

## N1 · Markdown 编辑能力（未实施）

### 动机

应用现在只能读 Markdown：渲染预览 + 源码视图，两者都是只读。而文件浏览器最常打开的恰好是这类文档——在仓库里读 README / FEATURES，看到错字或想补一句，只能切到外部编辑器。就地编辑省掉这一次切换，是这个功能唯一的价值来源；如果只是想要"能改文件"，用系统默认程序打开更快。

### 现状约束（都来自代码，决定了方案的形状）

- **只读是写死的。** `src/main/preload.js` 与 `src/main/fs-api.js` 的注释、`docs/agents/security.md` 都明确写着"不暴露写、删除、移动接口"。加编辑 = 重新划定写面，并同步改掉那份文档，不是加个按钮。
- **渲染器是有损的。** `src/renderer/markdown.js` 是 141 行手写渲染器，只认标题 / 段落 / 列表 / 引用 / 分割线 / 表格 / 代码块，不认图片、任务列表、脚注、HTML 块、引用式链接。HTML 生成出去就回不来了。
- **读取路径本身不可逆。** `readFileForPreview()` 做了三件对写回有毒的事：超过 5 MB 只读前 5 MB 并标记 `truncated`；UTF-8 解不出来时用 GBK 兜底解码并标记 `lossy`；渲染前把 `\r\n` 归一成 `\n`。直接拿显示出来的文本写回去，分别会截掉文件尾巴、把 GBK 文件写成乱码、把整个 CRLF 文件改成 LF。

### 必须新建的地基（与选哪种编辑形态无关）

- 一个 `fs:write` IPC：复用 `assertAllowed()`；只接受文本类；原子写（同目录临时文件 → `fsync` → `rename`）；带 `baseMtime` 的乐观并发，磁盘已变则返回磁盘内容让用户选「覆盖 / 放弃我的」；EOL 与 BOM 原样还原。
- **`truncated` 与 `lossy` 的文件禁止编辑。** 前者写回即截断；后者更麻烦——`TextEncoder` 只有 UTF-8、没有 GBK 编码器，写回必然损坏原文，只能提供显式的「另存为 UTF-8」，不能悄悄保存。
- 渲染进程：pane 增加 `dirty / draft / baseMtime / eol / bom`；`adoptPaneBody()` 搬家时要一起搬，否则编辑中按图钉会丢草稿；`PANE_SCROLLERS` 加编辑器的滚动容器；切换文件 / 关列 / 关窗口要有未保存守卫（`window:close` 目前直接 `win.close()`，得改成先问渲染进程）。
- 保存后的一致性：重发该目录的 `fs:meta` 刷新头部的大小与时间；同一文件同时开在临时列和固定列时，另一列要重新渲染但保住滚动位置。

### 编辑形态

1. **源码编辑。** CodeMirror 6 + `@codemirror/lang-markdown`，走 `scripts/build-renderer.mjs` 里 `docOptions` 那条 IIFE 流水线打成 `vendor/editor.js`。有高亮、行号、撤销栈、列表续行，`EditorState.lineSeparator` 正好解决 CRLF 问题，约 +300 KB。裸 `<textarea>` 是零依赖替代品，但没有高亮和续行。
2. **源码 + 实时预览分屏。** 复用现成的 `mdToHtml`，防抖重渲染，几乎零新依赖。对开发者体感提升最大，性价比最高，适合作为第 1 步的加料。
3. **所见即所得。** 见下面的库调研。

### 库调研（2026-10，体积为 bundlephobia 实测 gzip）

| 库 | 增量体积 | 依赖负担 | 备注 |
| --- | --- | --- | --- |
| Tiptap v3 + `@tiptap/markdown` | 106 + 19 KB（+marked 约 30 KB） | 无框架运行时 | v3.32 才有的官方 markdown 扩展；块拖拽 / slash 菜单有官方扩展 |
| Lexical + `@lexical/markdown` | 63 + 83 KB | 无框架运行时 | 只有 `@lexical/react` 需要 React |
| ProseMirror + `prosemirror-markdown` | 70 KB | 无 | 最可控，UI 全自己搭；走 markdown-it，token 自带源码行号 |
| Milkdown Crepe | 461 KB | **Vue 3.5** | 开箱 Notion 式界面，但给 vanilla 项目引入第二个框架运行时 |
| Vditor | 核心约 700 KB（包 23.6 MB 含资源） | diff-match-patch | 一个组件直接给 wysiwyg / ir / svd 三种模式；默认从 unpkg 拉 highlight.js / KaTeX / Mermaid，离线必须自建 cdn |
| Toast UI Editor | 约 1 MB | ProseMirror | 最后发布 2023-02，事实停更 |
| Cherry Markdown | 1.39 MB | 含 jsdom | 太重 |
| BlockNote / MDXEditor | 大 | **要 React** | 与 vanilla 项目不合 |

### 关键结论：没有一个库解决「改一句话却重排全文」

它们都是同一个套路——解析成自己的文档模型、在模型上编辑、保存时**整篇重新序列化**回 markdown。所以编辑手感是白送的，往返保真度各家不同，但没有任何一家提供"只重写被动过的块"。用它们编辑 git 仓库里的文档，改一行可能换来全文件 diff（`*` 变 `-`、表格重新对齐、段落重新折行）。

**破解办法是块级源映射。** 解析阶段把每个顶层块的源码行范围截留下来（remark 的 mdast 节点自带 `position.start.line / end.line`；markdown-it 的 token 自带 `map`；库在转成自己模型时通常会丢掉位置，所以要在这之前截住），保存时对比编辑前后的顶层块，**只对改动过的块做序列化，其余逐字节抄原文**。这样 Notion 式手感与"diff 只有那一行"可以兼得。三条路线的接入难度：prosemirror-markdown 走 markdown-it，最好接；remark 系（Milkdown）位置信息最完整；Tiptap 走 marked，位置要自己从 `token.raw` 推。

**另一条彻底绕开序列化的路：CodeMirror 6 即时渲染**（Typora / Obsidian 的活字模式）。文档本身始终是 markdown 文本，只做装饰——光标不在那一行时把 `**`、`#` 淡出，内容按标题字号渲染。保存就是保存文本，往返零损失，而且 `@codemirror/lang-markdown` 本来就在方案 1 的依赖里。代价是复杂块（表格、图片、嵌套列表）的即时渲染要做不少活，观感大约能到 Notion 的七成。

### 未决与下一步

保真度只能实测，文档说了不算。下一步是拿 `FEATURES.md` 分别过一遍「解析 → 不动任何东西 → 序列化回去」，比字节 diff：零 diff 的才有资格进入下一轮，否则直接上 CodeMirror 6 即时渲染。在此之前不建议引入任何编辑器依赖。
