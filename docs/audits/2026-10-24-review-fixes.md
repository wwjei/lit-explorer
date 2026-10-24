# 2026-10-24 另一会话审查的修复记录

- 审查范围：2026-10-17 至 2026-10-24 的变更，截止 `cb4b1cd`。
- 本次记录了审查发现的 9 项问题、逐项核对结论与修复方式。全部修复，未留待办。
- 基线：`cb4b1cd`（PR #5 之前）；修复后单测 54 项、集成 46 项全绿。

## 发现与处理

| 编号 | 优先级 | 问题 | 处理 | 回归 |
| --- | --- | --- | --- | --- |
| 1 | P1 | Markdown 行内代码占位符在 `href` 生成后回填，代码里的引号可逃出属性 | 链接地址正则排除 `\u0000`，行内代码文本额外转义引号；`safeHref` 拒绝控制字符 | 单测 S2 |
| 2 | P1 | DOCX 超链接 `java&#9;script:` 被当成相对路径放行 | `safeDocUrl()` 拒绝 C0 控制字符（浏览器解析 URL 时会忽略制表符 / 换行） | 集成 S1（新增 `TABLINK`） |
| 3 | P1 | `app:set-state` 接受任意字段，可持久化 `window.webPreferences` 与任意 `projects[].path` | 新增 `src/main/state-sanitize.js`：设置字段白名单、窗口只取 `{x,y,width,height}`、项目路径必须 `isOfferedRoot()`；启动时同样走 `windowBounds()` | 单测 S6 |
| 4 | P2 | 并发切换工作区时 `resetAllowedRoots()` 与异步 `realpath` 交错，留下两个授权根 | `openWorkspace()` 先 `resolveReal()`，再用 `workspaceSeq` 判断自己是否已被取代，最后同步「清空 + `allowResolvedRoot()`」 | 集成 S6 |
| 5 | P2 | 旧图片请求在 `task.replace()` 判断过期前改写 `pane.images` | `newImage()` 不再直接写 `pane.images`；单张与连续预览都在正文落地后才赋值 | 集成 P2 |
| 6 | P2 | 代码块异步高亮用 `innerHTML` 整块替换，吞掉查找 `<mark>`，计数还指着旧节点 | `highlightFences()` 收尾时调 `PV.find.refreshIn()`，按原命中序号重落高亮 | 集成 F2（5000 行 Lua 块确保查找先落点） |
| 7 | P2 | 许可声明只收包根 `LICENSE`，漏掉 ECharts 的 `NOTICE` 与 `licenses/LICENSE-d3` | `build-notices.mjs` 收集 `NOTICE*` 与 `licenses/` 下的许可原文，按包输出 | 手工核对生成物 |
| 8 | P2 | 漏洞扫描只把 esbuild 输入当「进安装包」，Electron 漏洞被归为仅构建期 | `electron` 显式计入 shipped 集合；新增 `AUDIT_JSON` 注入入口便于复现 | 注入 critical 样例退出码 1；真实 audit 0 |
| 9 | P2 | Release 的自定义说明写在布尔参数 `append_body` 上 | 改为 `body:`（`generate_release_notes` 开启时会前置在自动说明之前） | 工作流检查 |

## 连带处理

补上第 8 条后，真实 `npm run audit` 立刻报出 Electron 的 high 公告
（GHSA-jr5w-w6x2-84p9，影响 44.0.0-alpha.1 – 44.9.0）。已把 `electron` 从 44.9.0
升到 44.9.3，`package-lock.json` 同步；`npm run audit` 恢复 0 退出。剩余 3 条
进产物的 moderate 与可达性判断不变，见 [security-debt.md](../security-debt.md)。

## 验证方式

- 第 1、2 条先确认修复前可复现：Markdown 的 `onclick` 属性、DOCX 制表符链接；
- 第 5、6 条的回归测试都在修复前临时回退实现跑过，确认会红（图片宽度为空 / 命中数
  从 2 变 1、计数仍显示 1/2），恢复实现后转绿；
- 第 4 条用两种顺序并发调用 `workspace:open`，断言 `allowedRootList()` 只有一个根；
- 未修改用户正在运行的应用；测试使用独立 `userData` 与 `.tmp/` 夹具。
