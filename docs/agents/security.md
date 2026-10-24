# 安全边界

渲染进程没有 Node 能力（`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`），
只能调用 preload 暴露的白名单方法。主进程是唯一的系统访问入口，且**只提供读操作**。

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
  同时改 `sanitizePatch()` 与测试（单测 S6）。
- 不要在 `preload.js` 暴露写、删除、移动或执行任意命令的接口；
- 授权决策留在主进程。渲染进程只能打开主进程**给过**的目录（`fs-api.js` 的
  `offerRoot` / `isOfferedRoot`），新增「打开某个目录」的入口时，路径要先由主进程
  提供（示例项目、最近打开、已打开过的）或者来自 `dialog`，不要直接把渲染进程传来的
  路径交给 `allowRoot`；
- 项目图标图片也只从 `dialog` 选：主进程用 `nativeImage` 读入、缩到 64px 后以 data URL
  交给渲染进程，不把原始路径暴露出去，也不接受渲染进程传来的任意图片路径；
- 预览 HTML 走 `pv://` 协议（`standard + secure + corsEnabled`），每次请求都要过
  `assertAllowed()`，不要图省事换成 `file://`；
- 整份读取（如给 docx / pptx 用的 `fs:read-bytes`）要有体积上限，超限直接拒绝而非部分读取。

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
- 不要为了省事把第三方解析器放进带 `allow-same-origin` 的 iframe，那样沙箱形同虚设。
  需要更强隔离时应放进不透明源、通过 postMessage 传数据。
