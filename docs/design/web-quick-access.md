# 网页快速访问（在线文档入口）

> 状态：**已实施（v1.2）——在预览列里内嵌网页，不做「点击后用系统浏览器打开」**。
> 2026-10-25
> 相关：[FEATURES.md](../../FEATURES.md) 的 A18；仓库里的 README「隐私与联网」与
> `docs/agents/security.md` 的「内嵌网页视图」（这两份不进安装包）。

## 一句话

给项目加一个**受限的小浏览器**：快速访问里的网页条目，单击后在右侧预览列里打开，
可以固定住，和本地文件并排看。它不是完整的浏览器，只是「这个项目常用页面」的入口。

## 1. 你会得到什么

- 网页条目和文件/文件夹一样进快速访问，**按工作区分组**，随项目切换；
- 单击 → 页面直接出现在预览列里，可以滚动、点链接、在页面里正常操作；
- 可以点图钉固定，和代码 / Markdown 并排；最多仍然是 3 个固定列；
- 列头部保留「刷新 / 在浏览器中打开 / 固定 / 关闭」；
- 登录一次后，重启应用仍然保持登录（独立会话，见第 3 节）。

## 2. 它不是什么

- 没有标签页、地址栏、书签、历史记录、扩展、下载；
- 一次只显示一个页面，换页面就是换预览内容；
- 页面碰不到本地文件，也拿不到宿主的 `pv` 桥接；
- 不能替代系统浏览器。日常查资料、多标签浏览仍然用浏览器，这里是「写文档时把目标
  文档钉在旁边」的场景。

## 3. 实际影响

### 3.1 登录要重来一次

内嵌页面跑在独立的 `persist:web-docs` 会话里，和系统浏览器的 cookie 不共享。
所以第一次打开飞书 / Notion / 语雀时，需要在应用里登录一次；之后重启仍然在线。

风险是**部分站点的登录流程会拒绝嵌入式浏览器**：Google 系账号经常直接拦，
企业 SSO 可能依赖弹窗。这类站点通常会在视图里显示自己的拒绝页（不是加载失败），
列头部的「在浏览器中打开」是出口——不要把外开当主路径。

### 3.2 每个网页预览 = 一个 Chromium 进程

内存和 CPU 占用跟浏览器里多开一个标签页差不多，普通文档大约几十到两三百 MB。
关掉预览列、切换项目、取消固定时都会销毁对应视图；但固定两三个重页面时，占用会
明显高于纯本地预览。

### 3.3 它是「浮」在界面上的原生视图

`WebContentsView` 不是 DOM 元素，而是叠在窗口上的原生子视图，所以：

- 位置和大小要跟着窗格布局手动同步（拖动分界线、窗口缩放、固定/取消固定）；
- 它会盖住所有 HTML 浮层。应用里任何可能压到预览区的弹层（项目图标选择器、
  添加网页表单、toast）打开时，都要先把网页视图隐藏；
- 拖动列宽时可能有一瞬间的空白或滞后；实现时用 `requestAnimationFrame` 合并更新。

### 3.4 焦点和快捷键会被页面拿走

点进网页后，`Ctrl+F`、`Esc`、`↑↓` 这些宿主快捷键收不到。处理方式二选一：
把 `Ctrl+F` 转成页面自己的查找，或者明确「网页列不支持预览内查找」。
`Ctrl+B`（显示/隐藏预览）、`Ctrl+O` 这类应用级快捷键会在焦点回到宿主后恢复。

### 3.5 截图和自动化验证看不到网页

现有 `npm run probe` / `--shot` 用 `win.webContents.capturePage()`，它只截宿主页面，
拍不到 `WebContentsView` 里的内容。以后网页预览的验收要靠手工，或者改用系统级截图；
自动化测试只能验证「视图被创建 / 销毁 / 地址被拒绝」这类行为。

### 3.6 安全边界变了

以前应用只读本地工作区，现在多了一个访问任意 `http(s)` 地址的浏览视图。做法是把它
关在笼子里：

- 只接受 `http(s)`，拒绝 `file:` / `javascript:` / `data:` / 自定义协议；
- 独立会话、无 preload、`sandbox: true`、`contextIsolation: true`；
- 默认拒绝摄像头 / 麦克风 / 定位 / 通知等权限；
- 页面里的 `window.open` 一律转系统浏览器；下载默认拦截；
- 页面拿不到本地文件，也拿不到宿主的任何桥接。

即便如此，它仍然是一个能联网、能存 cookie 的浏览器视图，README 的隐私说明和
`SECURITY.md` 的边界都要跟着改。

### 3.7 兼容性不承诺

没有扩展、没有广告拦截，UA 会去掉 `Electron/xx`。站点如果检测到嵌入式浏览器并拒绝，
只能走兜底提示。内嵌预览的质量取决于站点，不取决于我们。

## 4. 数据与校验

```js
// state.json -> favorites（按工作区根分组）
{
  "c:/users/me/project": [
    { "path": "C:\\Users\\me\\project\\README.md", "name": "README.md", "isDir": false, "kind": "md" },
    { "url": "https://example.feishu.cn/docx/xxxx", "name": "接口设计", "kind": "web", "isDir": false }
  ]
}
```

- 身份是规范化后的 `url`；同一工作区里重复 URL 拒绝添加；
- 网页条目**不写 `path`**，避免被按路径分派的代码误当成文件；
- 名称上限 120 字符，URL 上限 2048 字符。

主进程 `src/main/state-sanitize.js` 的 `sanitizeFavorites()` 是唯一写入闸门，现在
没有 `path` 的条目会被直接丢掉，必须增加分支：

```js
function sanitizeWebUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > MAX_URL_CHARS) return '';
  if (/[\u0000-\u001f\u007f]/.test(s)) return '';       // C0 控制字符
  let u;
  try { u = new URL(s); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  if (u.username || u.password) return '';              // 不把凭据写进设置
  return u.toString();
}
```

`localhost` / 内网地址允许：开发服务器预览是合理场景，地址由用户主动添加。

## 5. 预览集成

- 新增主进程模块 `src/main/web-views.js`，持有 `Map<url, { view, rect, visible, loaded, failed }>`；
- 新增 `kind: 'web'` 的预览节点；`preview-body.js` 只画一个加载 / 失败占位区和头部，
  真实页面由主进程的 `WebContentsView` 覆盖在窗格正文上；
- 渲染进程通过 `web:sync` 声明式提交
  `[{ url, visible, rect: { x, y, width, height } | null }]`，主进程负责增删、
  `loadURL`、`setBounds`、`setVisible`；
- 每次渲染、列宽拖动、窗口缩放、预览收起后各同步一次，用 rAF 合并（`webview.js`）；
- **视图按地址认，不按窗格 id 认**：固定一列时窗格换了、地址没换，视图原地留下，
  文档滚动位置与登录态都不丢，因此不需要额外的转交 IPC；
- 头部按钮：重新加载、在浏览器中打开、固定、关闭；网页列的「在资源管理器中显示」
  隐藏，「复制路径」变成「复制链接」（复制的是当前地址）；
- 网页列不参与文件变更轮询、不写 `pane.known`、不参与「预览 / 源码」切换；
- 内嵌加载失败时给一张卡片：「无法在应用内加载这个页面」+「重新加载 / 在浏览器中打开」。

坐标：窗口是 `frame: false`，渲染进程视口原点就是窗口内容区原点，
`getBoundingClientRect()` 可以直接当 DIP 用；窗口缩放 / 分界线拖动后要重算。
主进程会把矩形夹在窗口内容区内，视图在「加载完成、没失败、渲染进程要求显示」三者
同时成立时才真正露出来。

## 6. 安全基线

- 独立 session：`persist:web-docs`，可单独清登录态；
- `webPreferences`：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、
  **不挂 preload**；
- `setPermissionRequestHandler` 默认拒绝；`will-attach-webview` 拒绝；
- `will-navigate` 只放行 `http(s)`；页面内链接留在视图里，`window.open` 转系统浏览器；
- 下载默认取消并提示；
- 去掉 UA 里的 `Electron/x.y.z`；
- 更新 `README` 的隐私一节、`SECURITY.md` 的边界，并在 `docs/audits/` 留一次审查记录。

## 7. 实施顺序

1. 持久化与校验：`state-sanitize.js` + 单测 S6；
2. 快速访问里的网页条目：规范化、渲染、添加 / 编辑 / 移除、「网页 +」浮层；
3. 主进程视图管理：创建 / 销毁 / 导航 / 坐标同步 / 权限与导航策略；
4. 预览分支：`kind: 'web'`、头部动作、固定时按地址复用、失败卡片；
5. 文档：FEATURES A18、README、SECURITY.md；
6. 手工验收（登录、固定、拖动、缩放、切换项目）。

预计 2–3 天 MVP，另加一轮安全审查与站点兼容性实测。

## 8. 验收

1. 项目 A 添加在线文档链接，重启后仍在；项目 B 看不到。
2. 单击后在预览列里打开，不会拉起系统浏览器。
3. 页面内可以滚动、点站内链接；`Ctrl+F` 的行为有明确定义（转发或提示不支持）。
4. 固定该列后与本地 Markdown 并排；取消固定后视图销毁；切换项目后旧视图不残留。
5. 拖动列宽、缩放窗口、最大化 / 还原时，网页始终贴合窗格正文，不盖住头部或相邻列。
6. 打开项目图标选择器 / 添加网页表单时，网页视图被隐藏，浮层可见。
7. `javascript:` / `file:` / `data:` / 带账号密码的 URL 在表单与主进程两层都被拒。
8. 关闭应用后重新启动，登录态仍在；`state.json` 里网页条目没有 `path` 字段。

## 9. 待实测

- 飞书文档、Google Docs、Notion、语雀、Confluence 在 `WebContentsView` 里的登录与
  渲染表现；结果决定兜底文案和默认 UA；
- Windows 125% / 150% 缩放下的坐标对齐；
- 两三个网页固定列同时打开时的内存占用。
