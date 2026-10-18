# 安全边界

渲染进程没有 Node 能力（`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`），
只能调用 preload 暴露的白名单方法。主进程是唯一的系统访问入口，且**只提供读操作**。

新增文件系统相关能力时：

- 路径必须过 `assertAllowed()`（`src/main/fs-api.js`），只能访问已登记为工作区的根目录内部；
- 不要在 `preload.js` 暴露写、删除、移动或执行任意命令的接口；
- 预览 HTML 走 `pv://` 协议（`standard + secure + corsEnabled`），每次请求都要过
  `assertAllowed()`，不要图省事换成 `file://`；
- 整份读取（如给 docx / pptx 用的 `fs:read-bytes`）要有体积上限，超限直接拒绝而非部分读取。
