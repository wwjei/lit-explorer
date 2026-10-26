# 内嵌网页预览 · 安全与实现审查

- 审查日期：2026-10-25。
- 范围：快速访问的网页条目（A18）、`src/main/web-views.js`、`src/main/web-url.js`、
  `src/main/state-sanitize.js` 的 favorites 分支，以及渲染进程的 `webview.js` /
  `preview-body.js` / `app.js` 接线。
- 结论：没有已知的未修复问题；下面是这次审查确认的边界与残留风险。

## 威胁模型

网页预览加载的是用户主动添加的任意在线页面，属于**不可信远程内容**。它和文件预览
最大的区别是：页面由站点控制、能联网、能写自己的 cookie，所以不能让它碰到宿主桥接
或本机文件。

## 控制

| 风险 | 控制 | 位置 |
| --- | --- | --- |
| 地址是 `file:` / `javascript:` / `data:` / 自定义协议 | 只接受 `http(s)`，拒绝 C0 控制字符与带账号密码的地址；渲染进程与主进程各校验一次 | `src/main/web-url.js`、`state-sanitize.js` 的 `sanitizeFavorites` |
| 页面拿到 Node / 宿主 `pv` 桥接 | 独立 `persist:web-docs` 会话，不挂 preload，`sandbox` + `contextIsolation`；宿主的 `pv://` 处理器不在该会话，会话层再取消 `pv://` / `file://` 请求 | `web-views.js` 的 `create` / `configureSession` |
| 页面申请摄像头 / 定位 / 通知 | 权限默认拒绝；只放行复制用的 `clipboard-sanitized-write` | `configureSession` |
| 页面静默下载文件 | `will-download` 直接取消，并给一条轻提示 | `configureSession` |
| 页面打开新窗口 / 跳到本机协议 | `window.open` 转系统浏览器；`will-navigate` / `will-redirect` 拦非 `http(s)` | `create` |
| 渲染进程伪造视图位置 | `web:sync` 的矩形夹在窗口内容区内；地址重新校验；最多 8 个视图 | `web-views.js` 的 `clampRect` / `sync` |
| 原生视图盖住宿主浮层 | 表单与项目图标选择器打开时 `PV.web.setOccluded(true)`；隐藏视图时把焦点还给宿主 | `webview.js`、`web-views.js` 的 `apply` |

## 残留风险

- 站点能联网、能写自己的 cookie、能被站点跟踪。这是内嵌浏览器的正常行为，
  边界写在 README 的「隐私与联网」与 SECURITY.md。
- Google 账号等站点会拒绝嵌入式登录，企业 SSO 可能依赖弹窗。这类站点会在视图里显示
  自己的拒绝页（不是加载失败），用户可用列头部的「在浏览器中打开」；不做 UA 伪装或
  弹窗代登。
- 网页列不支持预览内查找；页面里的下载被拦截。都是当前刻意限制。
- 远程页面仍可能向内网 / localhost 发起请求（Electron 默认关闭了 Local Network
  Access 检查）。网页视图本质上是一个浏览器，这一点与浏览器一致；要收紧的话，
  需要在会话层按发起方过滤，而不是禁止用户添加本地地址。
- 页面里的 `mailto:` 链接会交给系统默认邮件程序（浏览器的常见行为），没有做用户手势校验；
  如果将来只想放行用户主动点击，需要在渲染层记录交互时序。
- `win.webContents.capturePage()` 拍不到网页内容，截图钩子只能验证宿主界面；
  实际页面需要系统级截图或手工看。
- 独立会话的登录态目前没有清除入口；要换账号时可以在设置目录里删掉
  `Partitions/web-docs`（后续可以补一个菜单项）。

## 验证

- 单测 S6：网页地址白名单、收藏条目去重、网页条目不能带 `path`。
- 集成 W1：`http(s)` 才创建视图；网页会话没有宿主的 `pv://` 处理器；不可见 /
  矩形无效时保留视图；移出同步列表即销毁；非法地址不留下视图。
- 界面探针：添加条目 → 内嵌打开 → 固定，`web:state` 收到
  `loading → navigated → title → loaded`；固定后没有第二次 `loading`（视图按地址复用）。
  系统级截图确认页面正文（`WEB_PAGE_OK`）出现在预览列里。
- 打开网页表单时 `has-web` 变 false（视图隐藏），关闭后恢复；`javascript:` 地址在表单层
  被拒绝。
