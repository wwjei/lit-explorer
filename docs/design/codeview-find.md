# 代码视图里的 Ctrl+F（未实施）

> 状态：原因已查清、修法已想好，未实施。优先级取决于用代码视图读代码的频率，
> 目前看是次要功能。要不要做看 [further_notes.md](../../further_notes.md)。

## 现象

在 Go / JS 这类文件的预览（源码视图）里按 Ctrl+F，不会打开查找条，而是弹一句
「这一列不支持查找：Markdown 与 Word / PPT 预览里可以用 Ctrl+F」。

## 这是有意排除的，不是漏了

`PV.find.canFind()`（`src/renderer/find.js`）明确把带 `.codeview` 的窗格排除在外，
`app.js` 里 `Ctrl+F` 的分支据此给出提示。

## 为什么当初排除

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

## 修法思路

查找要走文本模型，不走 DOM。

- `PV.highlight.mount()` 内部持有 `state.lines`（整份文本按行切好），但对外只返回
  `{ destroy }`（`src/renderer/highlight.js:420`）。需要给它加一个 `find(query)` →
  `[{ line, start, end }]` 的接口，在 `state.lines` 上做大小写不敏感的匹配。
- 高亮不能像 Markdown 那样拆文本节点——代码行里是 Shiki 的 token `<span>` 结构，拆了会
  毁掉着色。改为在 `buildRow(i)` 渲染时按行号查命中区间，在 token 边界内套
  `<span class="find-hit">`。
- `stepFind` 只需要改 `.cv-scroll` 的 `scrollTop` 把目标行带进视口（`.cv-scroll` 已经在
  `src/renderer/pane.js` 的 `PANE_SCROLLERS` 里）。
- `PV.find.canFind()` 要改成按能力判断（这一列的内容支不支持查找），而不是按 DOM 里有
  没有 `.codeview` 判断。
- 代码视图的命中数不该受 `FIND_MAX = 2000` 的 DOM 上限约束，可以直接报真实值。

## 规模

比 Markdown 的查找大一档，难点是「在 token span 里套命中」和虚拟滚动下的命中维护
（滚出视口的行会被回收重建，重建时要重新套上命中）。
