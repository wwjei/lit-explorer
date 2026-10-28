# 代码高亮方案

只读预览场景下的语法高亮：选型、渲染管线、降级阈值。

## 1. 选型

| 项 | 决定 |
| --- | --- |
| 引擎 | Shiki `4.5.0`（MIT） |
| 正则引擎 | `createJavaScriptRegexEngine({ forgiving: true })`，**不用** oniguruma |
| 主题 | 双主题 + CSS 变量（`defaultColor: false`） |
| 运行位置 | Web Worker，主线程只做 DOM 渲染 |

选 Shiki 而不是 tree-sitter：预览只需要"看起来对、跨行结构正确"，Shiki 自带 VS Code 同款 TextMate 语法和主题，不用自己编译 wasm 语法、不用管 query 谓词。等要做代码折叠、大纲、结构导航时再引入 `web-tree-sitter`。

正则引擎选 JS 版是为了**不带 wasm 资源**（oniguruma 引擎要额外分发一个较大的 wasm 文件）。代价是它对无法转换的 Oniguruma 模式默认抛错，所以要开 `forgiving: true`；Shiki 3.9.1 起内置语言全部支持 JS 引擎。若某个语法出现高亮错乱，再对该语言单独切回 `createOnigurumaEngine`。

许可证：Shiki 是 MIT。高亮规则**不要从 Zed 抄**（其内置语言所在 crate 是 GPL-3.0-or-later）；需要额外语言的 query 时从 nvim-treesitter（Apache-2.0）取或自己写。

## 2. 接入

按需加载，不要一次引入全部语言和主题：

```js
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

const hl = await createHighlighterCore({
  themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark')],
  langs: [import('@shikijs/langs/typescript'), import('@shikijs/langs/markdown')],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
})
```

双主题输出，切主题不重新分词：

```js
const html = hl.codeToHtml(code, {
  lang: 'typescript',
  themes: { light: 'github-light', dark: 'github-dark' },
  defaultColor: false,   // 输出 --shiki-light / --shiki-dark 变量
})
```

需要自己控制每行 DOM 时用 `codeToTokens(code, options)`，返回 `tokens: Token[][]`（一维是行）。

## 3. 渲染管线

```
选中文件
  → 读文件（流式读前 N 字节，超过上限即截断）
  → postMessage 给 Worker {jobId, code, lang, themes, maxLines}
  → Worker: codeToTokens 一次分词
  → 回传 tokens（结构化，不是 HTML）
  → 主线程按可见窗口渲染 DOM 行
```

三个关键点：

- **分词必须一次做完，不能按窗口分段。** TextMate 语法是有状态的（跨行注释、模板字符串），分段独立分词会丢状态导致高亮错乱。所以"只处理前 x 行"是**截断输入**，不是分段处理。
- **DOM 行用窗口渲染**，与截断是两件事：截断控制 CPU/内存，窗口控制滚动性能。
- **切文件要能取消**：Worker 带 `jobId`，主线程只接受最新 `jobId` 的结果，旧结果直接丢弃。

缓存：LRU，key = `路径 + mtime + 主题模式 + 截断行数`，value = tokens。命中缓存时首屏只花渲染时间。

## 4. 降级阈值

初始值，按实测调整。

**文件级**

| 条件 | 行为 |
| --- | --- |
| 文件 > 5 MB | 不高亮，纯文本 + 行号，顶部给「仍然高亮」按钮 |
| 文件 > 1 MB 或 > 50k 行 | 只分词前 3000 行，顶部横幅「已高亮前 3000 行」+「继续加载」 |
| 最长行 > 5000 字符 | 判定为压缩/单行文件，整份退纯文本，提示原因 |
| 行数 > 3000 | DOM 只渲染可见窗口 ±200 行 |
| 单次分词输入 > 1 MB | 按行截断到 1 MB 以内 |

**行级**

| 条件 | 行为 |
| --- | --- |
| 单行 > 2000 字符 | 该行跳过高亮，纯文本显示（避免 TextMate 在超长行上回溯爆炸） |
| 单行 > 20000 字符 | 截断到 20000 字符显示，尾部加 `…` |
| 任意行 | 默认不自动换行（`white-space: pre` + 横向滚动），否则超长行会撑爆布局；提供「自动换行」开关 |

单行阈值参考 VS Code 的 `editor.maxTokenizationLineLength`（默认 20000），这里取 2000 作为高亮门槛更保守——压缩后的 JS/JSON 单行动辄几万字符，跳过它的收益远大于损失。

## 5. 预期表现

验收指标（不是实测值，实现后按此验收）：

| 指标 | 目标 |
| --- | --- |
| ≤ 200 KB 文件首屏高亮 | < 120 ms（含 Worker 往返） |
| 1 MB 文件（截断 3000 行） | < 200 ms |
| 切换主题 | < 16 ms（只换 CSS 变量，不重新分词） |
| 滚动 | 稳定 60 fps，DOM 内行数 ≤ 400 |
| 主线程单次任务 | < 8 ms |
| 首次打开高亮面板 | 只加载该语言 + 2 个主题的模块 |

测量方式：`performance.mark/measure` 打点，开发调试数据通过 `PV.highlight.stats` 查看；日常界面仅显示文件大小与行数。

### 实测记录（v0.1 实现，Windows 11 / Electron 44 / Shiki 4.5.0）

| 场景 | 实测 |
| --- | --- |
| 首次分词（含语法规则编译） | 136–628 ms，每种语言只付一次 |
| 稳态分词（46 行 JS） | 6–9 ms |
| 稳态分词（密集代码） | ≈ 0.25 ms/行 |
| 60k 行 / 2.9 MB，截断 3000 行 | 536 ms；DOM 121 行；滚动高度 120 万 px |
| 继续加载到 6000 行 | 754 ms |
| 6.4 MB 文件 | 默认纯文本 +「仍然高亮」；手动后 968 ms（含冷编译），部分高亮 |
| 单行 330k 字符（压缩产物） | 直接纯文本，无 token，提示原因 |
| 切换明暗主题 | 不重新分词（token 耗时不变），只换 CSS 变量 |

与文档的两处偏差，均为实测后的主动调整：

1. **缓存 key 不含「主题模式」**（§3）：双主题 token 自带 `--shiki-light/--shiki-dark`，主题不进 key 才能满足 §5「切主题 < 16 ms」。已验证切主题时 token 耗时不变。
2. **超长行阈值交给引擎**：`tokenizeMaxLineLength: 2000` 由 TextMate 跳过超长行（返回单 token 纯文本），比在渲染层跳过更安全——分词状态机不会被打断。

关于引擎：按 §1 选了 JS 正则引擎（不带 wasm）。实测对比（同一 46 行文件，Node 24）：

| 引擎 | 初始化 | 首次分词 | 稳态 |
| --- | --- | --- | --- |
| JS 正则 | 14 ms | 628 ms | 12–15 ms |
| WASM（oniguruma） | 55 ms | 177 ms | 4–6 ms |

WASM 快约 3 倍，但要额外分发 600 KB 的 `.wasm`。桌面端分发体积不敏感，若后续觉得首次分词偏慢，换成 `createOnigurumaEngine(import('shiki/wasm'))` 即可，其余代码不用动。

## 6. 降级阶梯

按顺序逐级退让，任何一级都保证可读、可选中复制：

1. **完整高亮** — 全文件分词 + 窗口渲染
2. **截断高亮** — 只分词前 3000 行，底部可继续加载
3. **纯文本 + 行号** — 不调用 Shiki，直接转义输出
4. **纯文本片段** — 超大文件只读前 200 KB，顶部说明

降级必须**显式告知用户**并给出「仍然高亮」的手动入口，不要静默降级。

## 7. 明确不做

- 不做编辑、不做 diff 视图（需要时另开设计）
- 不做增量/流式高亮（预览场景一次分词足够，复杂度不划算）
- 不做行内注入语言（Vue/JSX 里的 CSS/JS 高亮），Shiki 支持但会让阈值策略复杂化，留到需要时再加
- 不自己写高亮器（demo 里那个手写正则版仅用于原型，逐行处理无法正确处理跨行结构）
