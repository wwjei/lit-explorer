# 后续笔记

「想过、调研过，但还没做」的事：**需要人拍板的决策**，与**方案已就绪、只差排期的功能**。

## 这份文件怎么用

只收两类：

1. **待拍板** —— 需要维护者做选择才能推进的事。写明选项与各自的代价，别只写「以后再说」。
2. **待排期** —— 方案已经调研清楚，只差优先级的功能。细节放 [docs/design/](docs/design/)。

**不进这里**（各有各的地方）：

| 东西 | 去哪 |
| --- | --- |
| 小 bug、瑕疵、顺手清理 | [PENDING.md](PENDING.md)——**发版前必须清空** |
| 已知但没有可行修法的依赖 / 安全问题 | [docs/security-debt.md](docs/security-debt.md) |
| 已经做出来的行为 | [FEATURES.md](FEATURES.md) |
| **已排进版本规划的功能** | [FEATURES.md](FEATURES.md) 第 8 节 |
| 明确不做的（非目标） | [FEATURES.md](FEATURES.md) 第 2 节 |
| 操作手册 | [docs/agents/](docs/agents/) |
| 一次性调试记录 | 留在提交信息里 |

- **详细方案放 [docs/design/](docs/design/)**，这里只留结论和一句为什么。本文件是要被
  反复读的索引，不该堆成长文。
- **做完了就把整条删掉**，别在这里维护「已完成」列表——它一旦变成流水账就没人读了。
- 条目编号 `N`，新的排在前面。

---

## 待拍板

### N5 · 自动更新

`electron-builder` 已经在为 NSIS 目标生成 `app-update.yml` 与 `.blockmap`，但应用里没接
`electron-updater`，等于白生成。

两个前置条件，都要先定：

1. **代码签名**（见 N4）。给未签名的包做自动更新，等于每次更新都让用户再吃一遍
   SmartScreen 警告，比不更新更糟。
2. **隐私立场**。更新检查会向服务器发请求，那 README「隐私与联网」里「应用自身不发起
   任何请求」这句就要跟着改，[SECURITY.md](SECURITY.md) 里「不算漏洞」的清单也要跟着调。

**在这两件事定下来之前不要动。**

---

### N4 · 代码签名

安装包未签名，Windows SmartScreen 会提示「未知发布者」。用户目前唯一能自己核对产物
完整性的手段是 Release 里附带的 `SHA256SUMS.txt`。

三条路，成本与门槛差很多：

- **Azure Trusted Signing** —— 约 $10/月，需要组织身份验证（个人开发者过审有条件），
  性价比最高，适合长期做下去；
- **EV 证书** —— 一年几百到上千美元，好处是立刻拿到 SmartScreen 信誉；
- **继续不签** —— 那就把「下载后核对 SHA256」当作正式流程（README 的发布一节已经这么
  写了），不把它当缺陷。

顺带一提：exe 的 `CompanyName` 现在由 `package.json` 的 `author.name` 决定（之前没设，
一直显示成 Electron 原版的 `GitHub, Inc.`，已修）；签名之后安装程序里的「发布者」也会
显示成同一个名字。

---

## 待排期（方案已就绪）

### N3 · Markdown 编辑能力

源码编辑 / 实时预览分屏 / 所见即所得三种形态的取舍，8 个编辑器库的体积与依赖对比，
以及「改一句话却重排全文」的成因与两条破解思路（块级源映射、CodeMirror 6 即时渲染），
都在 **[docs/design/markdown-editing.md](docs/design/markdown-editing.md)**。

结论：**先别引依赖。** 下一步是拿 `FEATURES.md` 实测「解析 → 不动任何东西 → 序列化回去」
的字节 diff，零 diff 的方案才有资格进入下一轮。

**注意这条和路线图是冲突的：** [FEATURES.md](FEATURES.md) 第 2 节把「文件编辑、保存、
重命名、删除、移动」列为 **v1 明确不做**，第 8 节的 v2.0 里也没有它。所以要么承认它只是
「长期才可能翻案」，要么先改掉那句非目标——**别在没改 FEATURES.md 之前动手做**，
否则等于悄悄推翻了已经写下来的产品边界。

---

### N2 · 代码视图里的 Ctrl+F

原因（代码视图虚拟滚动，DOM 里只有可见的几十行，DOM 查找最多只能命中当前视口）、
修法（查找走 `state.lines` 文本模型，在 Shiki 的 token span 边界内套命中）与规模，
都在 **[docs/design/codeview-find.md](docs/design/codeview-find.md)**。

**这条其实已经排进 v1.2 了。** [FEATURES.md](FEATURES.md) 第 8 节的 v1.2 写着
「源码/代码视图的查找、查找大小写与整词选项」，说的就是它。所以它不该待在「待排期」里——
要么按 v1.2 推进，要么从路线图里拿掉。留在这里只因为本文档的方案比路线图那一行具体：
真要动手时按 [docs/design/codeview-find.md](docs/design/codeview-find.md) 做，做完把
两边一起删。
