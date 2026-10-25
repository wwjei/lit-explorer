# 安全策略

## 报告问题

请**不要**用公开 issue 报告安全漏洞。

优先用 GitHub 的私密漏洞报告：仓库 **Security** 标签页 → **Report a vulnerability**。
如果那里没有这个入口（该功能需要在仓库设置里开启），就先开一个不含细节的 issue，
只说明「有一个安全问题想私下报告」，我们再换渠道。

报告里请写清楚：受影响的版本、触发条件、能造成什么后果。能附最小复现文件最好
（比如一份带 altChunk 的 docx、一段注入用的 Markdown）。

## 支持范围

项目还在 alpha，只修**最新一个 Release** 上的问题。提之前请先确认它在最新版本上
仍然能复现。

## 这个程序的安全模型

lit explorer 是「读本机文件的工具」，所以威胁模型的重点不是「本机用户能不能读到自己的
文件」，而是**不可信的文件内容不能越过边界**：

- 渲染进程没有 Node 能力（`contextIsolation: true`、`nodeIntegration: false`、
  `sandbox: true`），只能调用 preload 暴露的白名单方法；
- 主进程是唯一的系统访问入口，默认只读；唯一的写操作是保存 SVG 编辑结果——
  只能覆盖当前工作区内**已存在的 `.svg`**，调用方要带上读取时的 size / mtime，
  磁盘上已经变化就拒绝（`CONFLICT`），先写临时文件再原子替换。路径仍然要过
  `assertAllowed()` 的 `realpath` 校验，junction / 符号链接绕不过去；
- 预览内容一律按不可信处理：docx / pptx 渲染后过 `sanitizeDocDom()`，
  Markdown 链接走协议白名单，HTML 预览放在不透明源 iframe 里；SVG 编辑模式在挂进
  宿主 DOM 前摘掉脚本、`foreignObject`、SMIL、事件属性、`javascript:` / 危险
  `data:` 链接与 `file:` / 相对资源引用，摘掉了东西的文件只读显示，不保存。

按这个模型，下面这些**算漏洞**：

- 预览一份恶意文件（docx / pptx / Markdown / HTML / SVG…）能让脚本在宿主页面里执行，
  或者能读到工作区之外的文件；
- 用 junction、符号链接或路径写法绕过工作区边界；
- 通过 `pv://` 协议或 IPC 拿到主进程没打算给的能力；
- 通过 `fs:write-svg` 写到工作区之外、写到非 `.svg`，或者在磁盘版本已经变化时
  仍然覆盖别人的修改。

下面这些**不算漏洞**，是已知且有意的行为：

- 不可信 HTML 预览能读到**当前工作区**里的文件、能发起网络请求——这是「HTML 预览要能
  引用相对资源」的直接结果，边界写在 [README 的隐私与联网一节](README.md#隐私与联网)；
- 在 SVG 编辑模式里改字、删除、拖动或缩放会**立刻写回**那份 SVG——这是编辑功能本身，
  用户可以在同一次编辑里用 `Ctrl+Z` 撤销；
- 安装包没有代码签名，Windows 会提示「未知发布者」——见
  [README 的发布一节](README.md#发布)；
- 工作区内指向外部的符号链接在列表里显示为不可用（删除线）——这是刻意的限制。

已经修过的历史问题与当时的复现手法记在 [docs/audits/](docs/audits/)；
已知但**当前没有可行修法**的依赖漏洞记在 [docs/security-debt.md](docs/security-debt.md)。
