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
  目录，切到 B 之后仍然可读。
- 不要在 `preload.js` 暴露写、删除、移动或执行任意命令的接口；
- 授权决策留在主进程。渲染进程只能打开主进程**给过**的目录（`fs-api.js` 的
  `offerRoot` / `isOfferedRoot`），新增「打开某个目录」的入口时，路径要先由主进程
  提供（示例项目、最近打开、已打开过的）或者来自 `dialog`，不要直接把渲染进程传来的
  路径交给 `allowRoot`；
- 预览 HTML 走 `pv://` 协议（`standard + secure + corsEnabled`），每次请求都要过
  `assertAllowed()`，不要图省事换成 `file://`；
- 整份读取（如给 docx / pptx 用的 `fs:read-bytes`）要有体积上限，超限直接拒绝而非部分读取。

## 预览里的不可信内容

预览的内容来自用户的文件，一律按不可信处理。宿主页面持有 `pv` 桥接（能读工作区、
能用默认程序打开文件），所以任何第三方解析器的输出都不能直接把脚本带进宿主：

- docx 的 altChunk 会被写进没有 sandbox 的 iframe `srcdoc`，必须传
  `renderAltChunks: false`；docx / pptx 渲染完还要过 `sanitizeDocDom()`
  （删脚本类节点、行内事件属性，危险协议地址一律去掉）。新增文档解析器时照此处理；
- Markdown 渲染器同时处理文本与属性两种上下文：`escapeHtml()` 只保护文本，
  链接地址要单独判断协议（只放行 http(s) / mailto / 相对路径）并处理引号；
- 不要为了省事把第三方解析器放进带 `allow-same-origin` 的 iframe，那样沙箱形同虚设。
  需要更强隔离时应放进不透明源、通过 postMessage 传数据。
