# 安全边界

渲染进程没有 Node 能力（`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`），
只能调用 preload 暴露的白名单方法。主进程是唯一的系统访问入口，默认只读；唯一的写操作是
保存 SVG 编辑结果（见下面「SVG 编辑的写入通道」）。

新增文件系统相关能力时：

- 路径必须过 `assertAllowed()`（`src/main/fs-api.js`），只能访问已登记为工作区的根目录内部。
  它比较的是 **`realpath` 之后的真实路径**：junction / 符号链接会指向根目录之外，
  而读写由文件系统跟随链接，只做字符串前缀判断挡不住。新增入口时不要绕开它，
  也不要自己写 `startsWith` 判断。
- 已授权根**只有当前工作区一个**：`openWorkspace()` 在登记新根之前会调
  `resetAllowedRoots()` 清掉上一个。不要把它改成只增不减的集合——那样在 A 里打开过的
  目录，切到 B 之后仍然可读。清空与登记必须像现在这样「先异步 `resolveReal()`，再用
  `allowResolvedRoot()` 同步登记」，并用 `workspaceSeq` 丢掉被后一次切换取代的请求；
  否则两次切换交错时，先发起的那次会在后一次清空之后把自己的根加回去，留下两个授权根。
- **渲染进程能写进设置的东西必须过白名单**（`src/main/state-sanitize.js`）。`app:set-state`
  不能直接 `store.patch(changes)`：`state.window` 会在下次启动时当 `BrowserWindow` 参数，
  `projects[].path` 会在下次启动时被 `offerRoot`。窗口只取 `{x,y,width,height}`，
  项目路径必须 `isOfferedRoot()`，其余字段逐个校验类型与范围。新增可持久化字段时，
  同时改 `sanitizePatch()` 与测试（单测 S6）。`projects[].nav.layout` 里的固定列路径
  同样不是授权依据：恢复时渲染进程只保留当前工作区内的路径（`PV.paths.partsUnder()`），
  实际读取仍过 `assertAllowed()`；网页格只接受规范化后的 `http(s)`。
- 不要在 `preload.js` 暴露通用的写、删除、移动或执行任意命令的接口；目前只有
  `writeSvg()` 这一个写入口，不要再加「写任意文件」的变体；
- 授权决策留在主进程。渲染进程只能打开主进程**给过**的目录（`fs-api.js` 的
  `offerRoot` / `isOfferedRoot`），新增「打开某个目录」的入口时，路径要先由主进程
  提供（示例项目、最近打开、已打开过的）或者来自 `dialog`，不要直接把渲染进程传来的
  路径交给 `allowRoot`；
- 项目图标图片也只从 `dialog` 选：主进程用 `nativeImage` 读入、缩到 64px 后以 data URL
  交给渲染进程，不把原始路径暴露出去，也不接受渲染进程传来的任意图片路径；
- 预览 HTML 走 `pv://` 协议（`standard + secure + corsEnabled`），每次请求都要过
  `assertAllowed()`，不要图省事换成 `file://`；
- 整份读取（如给 docx / pptx 用的 `fs:read-bytes`）要有体积上限，超限直接拒绝而非部分读取。

## SVG 编辑的写入通道

`fs:write-svg` → `fsApi.writeSvgFile()` 是应用里唯一的写文件路径，改它之前先看这几条：

- 路径仍然过 `assertAllowed()`，并且**扩展名必须是 `.svg`**、目标必须是已经存在的普通文件；
  不要把它改成「不存在就新建」，那会把任意路径变成可写面；
- 调用方必须带上读取时的 `{ size, mtime }`。磁盘上已经变化时返回 `CONFLICT`，不覆盖——
  agent / 编辑器重新导出 SVG 很常见，静默盖掉别人的修改是数据丢失；
- 先写同目录的临时文件再 `rename`，失败时删掉临时文件；不要改成直接 `writeFile`，
  中途崩溃会留下半个文件；
- 体积上限 `MAX_SVG_WRITE_BYTES` 按 UTF-8 字节算，超限拒绝；
- 渲染进程只能传当前预览节点的 `path`，不要把用户输入或剪贴板内容当路径拼进去；
  主进程的校验是最后一道，但不能因此省掉渲染侧的来源检查。

`src/renderer/svgedit.js` 在把 SVG 挂进宿主 DOM 前会做清洗（脚本、`foreignObject`、
SMIL、事件属性、`javascript:` / 危险 `data:` 链接、`file:` / 相对资源引用，以及 CSS 里的
`@import` / 外部 `url()`）。**一旦摘掉了东西，这个文件就标成只读，禁止保存**——否则用户的
一次正常编辑会把原文件里的脚本 / 动画悄悄删掉。新增允许的标签或属性时，同时问一句
「它能不能执行脚本或把窗口导航走」。

## 预览里的不可信内容

预览的内容来自用户的文件，一律按不可信处理。宿主页面持有 `pv` 桥接（能读工作区、
能用默认程序打开文件），所以任何第三方解析器的输出都不能直接把脚本带进宿主：

- docx 的 altChunk 会被写进没有 sandbox 的 iframe `srcdoc`，必须传
  `renderAltChunks: false`；docx / pptx 渲染完还要过 `sanitizeDocDom()`
  （删脚本类节点、行内事件属性，危险协议地址一律去掉）。新增文档解析器时照此处理；
- 地址里的 **C0 控制字符（尤其制表符 / 换行）一律拒绝**：浏览器解析 URL 时会忽略它们，
  `java\tscript:` 仍会被当成脚本协议。`safeDocUrl()` 与 Markdown 的 `safeHref()` 都做了
  这条检查，新增地址入口时别漏；
- Markdown 渲染器同时处理文本与属性两种上下文：`escapeHtml()` 只保护文本，
  链接地址要单独判断协议（只放行 http(s) / mailto / 相对路径）并处理引号。
  行内代码用 NUL 占位符回填，**占位符不能出现在链接地址里**（正则已排除 `\u0000`），
  否则回填的 `<code>` 会落进 `href` 属性中间；
- SVG 编辑模式把内容直接插进宿主页面。`svgedit.js` 的清洗规则是「宁可只读，也不放行」：
  摘掉脚本 / `foreignObject` / SMIL / 事件属性 / 危险链接，并把文件标成只读；
  编辑模式里点击 `<a>` 一律 `preventDefault()`，避免把应用窗口导航走。预览模式下 SVG
  仍然走 `<img>`，不执行脚本；
- 不要为了省事把第三方解析器放进带 `allow-same-origin` 的 iframe，那样沙箱形同虚设。
  需要更强隔离时应放进不透明源、通过 postMessage 传数据。

## 内嵌网页视图

网页预览（快速访问里的 `kind: 'web'` 条目）不是文件预览：它加载的是任意在线页面。
边界如下：

- 地址只接受 `http(s)`（`src/main/web-url.js`）。渲染进程与主进程各校验一次，
  `web:sync` 里的每个地址都重新过一遍；`file:` / `javascript:` / `data:` /
  其他自定义协议与带账号密码的地址一律拒绝。页面里的 `mailto:` 是例外：
  只交给系统邮件程序，不进入视图；
- 独立的 `persist:web-docs` 会话，**不挂 preload**，`sandbox: true`、
  `contextIsolation: true`、`nodeIntegration: false`；页面拿不到 `pv` 桥接。
  宿主的 `pv://` 处理器不在这个会话里，另外在会话层取消 `pv://` / `file://` 请求；
- 权限默认拒绝（只放行 `clipboard-sanitized-write`，在线文档的复制按钮要用）。
  `clipboard-read`（右键粘贴 / 页面粘贴按钮）按 `requestingUrl` 的 origin 弹一次原生确认，
  决定只在本次运行内记住；拒绝后 `Ctrl+V` 仍然可用。`setPermissionCheckHandler` 对
  `clipboard-read` 返回 true 只是让页面的 `permissions.query` 报告 granted（否则在线
  文档会认为剪贴板被禁用、不显示粘贴入口），**真正的读取仍会走 request handler 询问**——
  不要把这个 check 改成对所有权限返回 true；
  下载一律拦截；`window.open` 转系统浏览器；`will-attach-webview` 拒绝；
- 页面内部导航允许 `http(s)`，其他协议由 `will-navigate` / `will-redirect` 拦下；
- 不要给主窗口打开 `webviewTag`，不要在网页视图里挂 preload，也不要把它改成
  带 `allow-same-origin` 的 iframe；
- 原生视图会盖住 HTML：弹层打开时 `PV.web.setOccluded(true)` 先藏起来，关掉再恢复；
  隐藏视图时主进程会把焦点还给宿主，否则表单收不到键盘。

网页内容能联网、能写自己的 cookie、能被站点跟踪，这是浏览器的正常行为，不算越界；
但它不能读工作区、不能调宿主 IPC；除了页面里的 `mailto:` 会交给系统邮件程序，
不能启动本机程序。

## MyGo 版的系统边界

MyGo 版（`mygo/`）与 Electron 版共用渲染层，但系统边界要各自实现：

- **文件与状态的白名单在 `mygo/fsapi.go` / `mygo/statefile.go`。** 它们对应
  `src/main/fs-api.js` / `state-sanitize.js`，同样做 `realpath` 后的根目录校验、
  读取上限、SVG 的 size+mtime 基线与状态字段白名单。新增文件系统能力时两份都要加，
  不要只改 Electron 侧让 MyGo 版静默少一道校验。磁盘项目先校验结构、再登记候选根；
  页面提交的项目仍须通过 `isOfferedRoot()`。切换工作区的序号检查与授权提交保持原子，
  避免并发 RPC 把旧根重新登记。SVG 临时文件用同目录随机名称独占创建，写入失败时清理。
- **系统打开交给 `mygo.Shell`。** 路径与 URL 中的 `&` 等字符可被命令解释器执行，
  文件打开、外部链接与网页弹窗都直接调用系统 Shell API。
- **HTML 预览走本机回环服务**（`startPreviewServer()`）：只绑 `127.0.0.1` 的随机端口，
  路径前缀是进程级 32 字节随机令牌，每个请求仍过 `assertAllowed()`。不要改成
  `0.0.0.0`、固定端口或固定令牌；令牌不要写进日志或持久化文件
  （`MYGO_DEBUG=1` 只打印路径，不打印令牌前缀）。这是比 `pv://` 多出来的一个本机
  监听面，改服务时要按「局域网也能访问」的假设重审。
- **子 webview**（fork 的 `NewChildWebView`）与主页面共用应用级 WebView2 profile，
  没有 Electron 的独立 `persist:web-docs` 分区；站点权限走 WebView2 默认策略，
  没有按站询问剪贴板读取。`WebSync` 里的地址仍过 `validWebURL()`（只放行 `http(s)`、
  拒绝控制字符与带账号密码的地址）。不要图省事把 `pv` 桥接注入子 webview。
