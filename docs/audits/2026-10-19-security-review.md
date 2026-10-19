# 代码与安全审查记录

- 审查日期：2026-10-19。
- 基线提交：`9d7ab0d0fe30179bc2e86930729219456672d24d`。
- 范围：`src/main/`、`src/renderer/`、构建脚本、发布工作流和相关预览依赖的调用方式。根目录 `index.html` 是历史原型，不作为正式程序入口。
- 本次仅审查和复现，以下问题均未修复；没有改动应用源码、依赖或产品行为。
- 优先级：P1 为应优先处理的安全边界问题；P2 为影响正常操作的正确性问题。此处优先级不是 CVSS 评分。

> **后续状态（2026-10-19 补记）**：下面七条发现已全部修复（`ad96bb2`），并补了对应的
> 回归测试（`a2ce5a9`、`npm test`）。末尾「设计层面的改进意见」五条也已处理完，包括
> 最后那条「HTML 预览的数据读取策略」——取舍已定并落地（保留读当前工作区与联网，
> 收掉「能读此前打开过的工作区」，实现是 `openWorkspace()` 里的 `resetAllowedRoots()`），
> 边界写在 [README 的隐私与联网一节](../../README.md#隐私与联网)。这份审查已没有遗留待办。
>
> **以下正文保持审查当时的原样**：其中的状态描述（「均未修复」）与那些行号链接都指的是
> 审查当时的快照（基线 `9d7ab0d`）。注意那些链接是相对仓库根写的，**从本文件所在目录
> 解析不到，点开是断的**，这是有意保留的——它们记的是「当时哪一行的代码」，不是导航入口。
> 要找某段逻辑，按正文里写的函数名去现在的代码里搜。
> 这是一份记录，不是待办清单——找活干请看 [PENDING.md](../../PENDING.md) 与
> [further_notes.md](../../further_notes.md)。

## 发现汇总

| 编号 | 优先级 | 类型 | 问题 | 验证状态 |
| --- | --- | --- | --- | --- |
| S1 | P1 | 安全 | Word altChunk 中的脚本自动执行并访问宿主桥接 API | 隔离样例实测 |
| S2 | P1 | 安全 | Markdown 链接地址可注入宿主事件处理器 | 隔离样例实测 |
| S3 | P1 | 安全 | junction / 符号链接绕过工作区路径边界 | Windows junction 实测 |
| C1 | P2 | 正确性 | 文件加载完成前固定，固定列一直停在加载状态 | 延迟读取实测 |
| C2 | P2 | 正确性 | 旧文档解析失败覆盖新文件的预览 | 注入延迟解析失败实测 |
| C3 | P2 | 正确性 | Worker 并发初始化导致已加载语言集合与实例不一致 | 真实构建产物实测 |
| C4 | P2 | 正确性 | 同文件重新读取时，旧响应覆盖新内容 | 乱序读取实测 |

## 安全审查

### S1：Word altChunk 可自动执行脚本并访问宿主 API

位置：[src/renderer/docpreview.js:17](src/renderer/docpreview.js#L17)。

`renderDocx()` 在宿主页面内调用 `docx-preview.renderAsync()`，没有覆盖依赖默认开启的 `renderAltChunks`。本地安装的 `docx-preview@0.4.1` 会把 altChunk HTML 写入没有 `sandbox` 属性的 iframe 的 `srcdoc`。该 iframe 继承宿主源，脚本能够访问父页面的 `pv` 对象。

触发条件：用户选择预览一份包含 HTML altChunk 的不可信 `.docx`，并且 Word 内嵌预览开启（默认开启）。不需要再点击文档中的链接。

复现方式：构造最小 DOCX，`word/document.xml` 的正文含 `<w:altChunk r:id="rIdChunk"/>`，对应关系使用 `http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk`，指向 `word/chunk.html`。HTML 内容为：

```html
<script>parent.__auditDocx = typeof(parent.pv.openRoot)</script>
```

实测：通过项目的 `PV.docpreview.renderDocx()` 渲染后，父页面 `__auditDocx` 为 `"function"`，生成的 iframe 没有 sandbox。此复现使用真实预览库，没有替换 DOCX 渲染函数。

影响：不可信文档跨入宿主页面的权限范围。宿主桥接提供 `openRoot()`、文件读取和 `openPath()`；其中 `workspace:open` 允许传入任意现存目录并登记为授权根，因此不能指望现有工作区检查在宿主被注入后继续限制读取范围。调用系统打开接口也不再需要正常的双击操作。实际验证仅检查 API 可达性，没有读取真实敏感文件、启动程序或测试完整命令执行链。

建议：先显式设置 `renderAltChunks: false`；若确需支持 HTML 部件，应放入没有宿主 API、不能访问父页面的隔离环境。文档渲染整体也应与应用界面隔离，避免将第三方解析器的输出直接置于有桥接权限的页面。

### S2：Markdown 链接可注入宿主事件处理器

位置：[src/renderer/markdown.js:11](src/renderer/markdown.js#L11)；转义函数见 [src/renderer/highlight.js:75](src/renderer/highlight.js#L75)。

`inline()` 先用 `escapeHtml()` 处理文本，再把链接地址拼入带双引号的 `href` 属性。该函数只转义 `&`、`<`、`>`，没有转义引号；适合 HTML 文本节点的处理不足以保护属性上下文。

触发条件：用户预览不可信 Markdown，并点击注入了事件处理器的链接。

复现内容：

```markdown
[click](#"onclick="window.__auditMarkdown=window.pv.platform)
```

输出包含：

```html
<a href="#" onclick="window.__auditMarkdown=window.pv.platform" target="_blank" rel="noopener">click</a>
```

实测：点击后宿主变量 `__auditMarkdown` 为 `"win32"`。`target="_blank"` 与 `rel="noopener"` 不会隔离链接元素自身的事件处理器。

影响：脚本在宿主页面执行，可访问与 S1 相同的桥接权限。与 S1 不同，本次载荷需要用户点击链接。

建议：通过 DOM API 创建链接和设置属性，或使用经过验证的 Markdown 渲染与净化方案；对链接协议建立白名单。分别处理文本与属性上下文，并增加覆盖引号、实体和危险协议的回归用例。宿主 CSP 可作为额外防线。

### S3：junction / 符号链接绕过工作区边界

位置：[src/main/fs-api.js:131](src/main/fs-api.js#L131)。

`assertAllowed()` 只做 `path.resolve()` 和字符串前缀检查；文件系统随后会跟随链接，实际访问的目标可能位于根目录外。目录枚举还会把链接目录识别为可进入的目录。

触发条件：工作区内部存在指向外部目录的 junction 或符号链接，且外部目标对当前用户可读。

复现结构：

```text
audit-fixture/             已授权工作区
  linked/                 junction，指向 ../audit-outside
audit-outside/            未授权目录
  marker.txt              AUDIT_OUTSIDE_MARKER
```

实测：仅授权 `audit-fixture` 后，`readFileForPreview(audit-fixture/linked/marker.txt)` 返回 `AUDIT_OUTSIDE_MARKER`，没有返回 `EACCES_ROOT`。

影响：文件读取和目录枚举可越过登记的工作区边界；`pv://` 协议与系统打开接口复用了相同检查，存在同类绕过。它不会自行绕过操作系统的文件权限，但违反了项目定义的授权根边界。

建议：统一解析并校验根目录和最终目标的真实路径，明确禁止或单独授权指向根外的链接；使用路径分段关系判断边界，并处理 Windows 大小写及盘符根路径。还应考虑校验后链接被替换的竞态，避免将单次 `realpath` 检查视为完整解决方案。

## 普通代码审查

### C1：加载完成前固定，固定列永久停在“读取中…”

位置：[src/renderer/app.js:1016](src/renderer/app.js#L1016)，`adoptPaneBody()`。

该函数把 DOM 和 `bodyKey` 搬入固定列，随后清空原列的 `bodyKey`。未完成的读取任务仍捕获原列；响应回来时，被原列的 `stale()` 检查丢弃。固定列继承了正确的内容 key，`renderPane()` 又认为它不需要重新渲染，因此没有任何任务会填充固定列。

复现：让 Markdown 读取延迟 500ms，选中文件 50ms 后点击图钉。等待读取结束后，固定列仍是 `读取中…`，刷新该列才能恢复。

建议：为 pane 明确记录加载状态和任务归属。固定时转移任务归属，或在任务未完成时使新列重新发起渲染；不要仅依据相同的内容 key 判断正文已经就绪。

### C2：旧文档解析错误覆盖新文件预览

位置：[src/renderer/app.js:743](src/renderer/app.js#L743)，`renderDocPreview()` 的异常分支。

成功分支在解析完成后检查了 `stale()`，异常分支却直接改写共享的 `pane.body`。如果用户已切换文件，旧文档稍后抛出的解析异常会用旧文件的失败卡片覆盖新内容，头部与正文也会不一致。

复现：在隔离测试中将 `PV.docpreview.renderDocx()` 替换为 500ms 后拒绝的 Promise，以确定性模拟解析失败；打开 `bad.docx`，50ms 后选中 `good.md`。记录结果：

```text
旧文档失败前：AUDIT_NEW_PREVIEW
旧文档失败后：bad.docx预览失败：AUDIT_OLD_DOC_FAILURE用默认程序打开
```

这里验证的是应用对解析失败的处理，没有声称该测试使用的字节样例会在真实解析器中恰好延迟 500ms 失败。

建议：异常路径在修改 DOM 前执行与成功路径相同的任务有效性检查；后续清理、提示和元信息更新也应遵循同一规则。

### C3：高亮 Worker 并发初始化导致语言状态错误

位置：[src/renderer/highlight/worker.js:74](src/renderer/highlight/worker.js#L74)，`ensure()`。

`self.onmessage` 是异步函数，多个消息可以在 `await` 期间交错执行。首次并发请求不同语言时，两次 `ensure()` 都能看到 `highlighter === null`，各自创建实例并覆盖全局引用；共享的 `loaded` 集合却累计了两个实例各自加载的语言。最终实例通常只包含其中一种语言，但集合声称两种都已加载。

复现：在真实构建的 `vendor/highlight-worker.js` 中并发发送 CSS、Python 高亮请求；完成后再请求这两种语言。第一次两者成功，第二次 CSS 成功，Python 返回：

```text
Language `python` not found, you may need to load it first
```

具体丢失哪一种语言取决于初始化完成顺序。多窗格首次高亮、快速切换不同语言文件等操作可能触发并发请求，随后客户端会回落到纯文本。

建议：缓存唯一的初始化 Promise，让所有消息共享同一个实例；语言加载也按语言缓存 Promise，避免重复加载。`loaded` 必须只反映当前实例中实际可用的语言。

### C4：同一文件重新读取时，旧响应覆盖新内容

位置：[src/renderer/app.js:1158](src/renderer/app.js#L1158)、[src/renderer/app.js:1172](src/renderer/app.js#L1172)。

`renderPaneBody()` 用 `pane.bodyKey !== key` 判定任务是否过期，但 key 只描述路径、模式与预览开关，不区分同一内容的不同请求。“重新读取”强制发起新任务时，key 不变，因此前后两个响应都被视为有效。

复现：第一次读取 500ms 后返回 `AUDIT_OLD_CONTENT`；50ms 后点击重新读取，第二次在 20ms 后返回 `AUDIT_LATEST_CONTENT`。界面先显示新内容，随后退回旧内容：

```text
第二次请求完成后：AUDIT_LATEST_CONTENT
第一次请求晚到后：AUDIT_OLD_CONTENT
```

影响：用户主动重新读取文件后，界面最终可能展示过期内容；A → B → A 的切换也有类似的 key 重用风险。

建议：将内容缓存 key 和请求身份分开。每次强制刷新、切换文件及销毁窗格时推进单调递增的请求编号；所有异步成功、失败与后处理都验证编号。

## 设计层面的改进意见

以下建议与上面的可复现缺陷分开记录，不额外计算漏洞数量。

1. **统一 pane 生命周期。** C1、C2、C4 都涉及异步任务与界面归属不一致。建议集中管理请求编号、加载状态、销毁和迁移，减少各渲染器自行维护零散的 `stale()` 检查。拆分 `app.js` 时优先沿 pane 生命周期、目录导航和查找功能边界拆分。
2. **区分内容身份与任务身份。** 内容 key 用于复用已完成的结果，请求编号用于拒绝旧响应；不要由同一个字段同时承担两种职责。
3. **给关键异步交错补回归测试。** 最有价值的是延迟读取后固定、失败后切换、同文件乱序刷新以及 Worker 首次并发请求，测试应验证用户看到的最终结果。
4. **缩小宿主权限入口。** IPC 目前缺少统一的发送者和参数校验，`workspace:open` 也没有验证目录是否来自受信任的选择流程。应由主进程维护授权决策，避免渲染器任意扩大授权根。发送者校验本身无法阻止已经在合法宿主页面执行的 S1/S2 脚本，仍须先修复注入入口。
5. **明确 HTML 预览的数据读取策略。** `pv://` 当前返回 `Access-Control-Allow-Origin: *`，且授权根在进程内累计。实测不透明源 iframe 可以读取已授权工作区标记文件。这与现有 HTML fetch 功能相符，本次不将其单独判为已证实漏洞；但需要明确不可信预览是否应读取整个工作区、此前工作区，以及是否允许联网。建议按预览或工作区隔离会话与资源授权。

Electron 的 IPC 来源校验、CSP 和隔离建议参考：[官方安全文档](https://www.electronjs.org/docs/latest/tutorial/security/)。

## 验证记录与限制

- `npm run build`：通过；本次未修改构建源码。
- Windows / Electron 44.9.0：使用隐藏窗口、独立临时 userData 和临时标记文件复现上述问题，没有接管或关闭用户正在运行的实例。
- S1、S2 仅验证脚本执行及桥接 API 可达性；没有执行系统程序、访问真实敏感文件或发送网络数据。
- C1、C2、C4 使用可控的 IPC 响应或解析失败桩，验证实际渲染代码的异步行为；C3 使用项目真实构建出的 Worker。
- `npm audit --json`：失败，原因是 `registry.npmjs.org` DNS 解析报 `ENOTFOUND`。不能据此判断依赖没有已知漏洞。
- 没有进行安装包验证、全量手工交互回归、内存压力测试或完整渗透测试。
- 临时复现脚本：`.tmp/security-review.cjs`；原始输出：`.tmp/audit-results.txt`。两者位于被 Git 忽略的临时目录，可能被清理；本文已保存主要触发条件和结果。

建议修复顺序：S1 / S2 → S3 → C1 / C2 / C4 的 pane 生命周期问题 → C3 的 Worker 初始化问题。
