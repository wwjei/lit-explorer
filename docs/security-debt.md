# 安全与依赖债

已知、但**决定先不处理**的安全与依赖问题。共同点是：该做的都做完了，卡在上游或卡在
没有可行的修法，只能记下来并写清复查触发条件。

## 这份文件怎么用

- **进这里**：已知的依赖漏洞、已知的安全权衡，且当前**没有可行修法**。每条必须有
  「够不够得着」的判断和「什么时候要重新看」。
- **不进这里**：能修的小问题 → [PENDING.md](../PENDING.md)；要人拍板的取舍 →
  [further_notes.md](../further_notes.md)；历史审查的完整记录 → [audits/](audits/)。
- 修掉了就删掉整条。这里是活账本，不是档案。

`npm run build && npm run audit` 可以复现下面这份底账。那个脚本只回答「这个包进不进
产物」，**可达性要人看**，结论就写在这里。

---

## D1 · 三条进产物的 moderate 漏洞：实测都够不着

**底账**（2026-10-19，第一次成功跑成 `npm audit` 的结果。上一轮审查那次因
`registry.npmjs.org` DNS 失败没跑成，所以这个盲区一直没被看见）：

`npm audit` 报 11 项 moderate。8 项在构建工具链里（`electron-builder` → `global-agent`
→ `roarr` → `sprintf-js` 那条），不随程序分发，不在这里记。**3 项会进安装包：**

| 包 | 影响范围 | 公告 |
| --- | --- | --- |
| `echarts` | `<6.1.0` | GHSA-fgmj-fm8m-jvvx —— Lines 系列的 tooltip 用 innerHTML 渲染 `series.data[i].name`，构造过的 pptx 图表能借此在宿主页里执行脚本 |
| `uuid` | `<11.1.1` | GHSA-w5hq-g745-h8pq —— v3 / v5 / v6 在传 `buf` 时缺缓冲区边界检查 |
| `pptx-preview` | `>=0.0.6` | 只因上面两个被牵连，自身没有独立公告 |

**够不够得着：都够不着。**

- pptx-preview 只产出 `pie` / `line` / `bar` 三种系列（`dist/pptx-preview.es.js` 里
  `type:"pie"`、`type:"line"`、`type:"bar"` 各一处），而公告要求的 **Lines** 系列
  根本不会出现；
- pptx-preview 只 `import{v4 as s}from"uuid"`，而受影响的是 v3 / v5 / v6。

**为什么「升一下就完了」不成立**：pptx-preview 把依赖钉成 `echarts: ^5.5.1`，永远解析不到
修好的 6.x。`npm audit fix --force` 的提议是把 pptx-preview 降到 1.0.0——那是破坏性降级，
比现状更糟。

**什么时候要重新看这条**：

- pptx-preview 放宽 `echarts` 的版本范围，或自己开始用 Lines 系列；
- pptx-preview 开始用 uuid 的 v3 / v5 / v6；
- `scripts/audit-report.mjs` 让 CI 在「进产物的包出现 high / critical」时失败——但
  **moderate 不会被它拦下**，可达性得人判断，所以这条要留着。
