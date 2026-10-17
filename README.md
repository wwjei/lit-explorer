# lit explorer

<img src="assets/icon.svg" width="88" height="88" alt="lit explorer">

面向开发者的本地项目文件浏览器：左侧多栏目录导航，右侧即时预览，双击文件用系统默认程序打开。

图标是黑底白色字标，三个竖笔同时是 `l` `i` `T`，也对应界面里的多栏结构——
几何定义在 `scripts/build-icons.mjs`，SVG 母版与各尺寸 ICO 都由它生成。

界面基线来自 `index.html`（早期设计原型），正式程序在 `src/`（Electron）。

## 运行

```bash
npm install      # 安装依赖（见下方镜像说明）
npm start        # 启动程序
npm run dev      # 启动并打开开发者工具
```

首次启动若没有历史记录，会显示欢迎页，可以直接「打开示例项目」（`sample-project/`）试用。

### 依赖安装慢 / 卡在下载 Electron

Electron 的二进制默认从 GitHub 下载，国内经常超时。项目已带 `.npmrc` 指向 npmmirror 镜像：

```ini
electron_mirror=https://npmmirror.com/mirrors/electron/
```

如果 `node_modules/electron/dist/electron.exe` 不存在，说明二进制没下下来，手动补一次：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

## 功能

| 能力 | 说明 |
| --- | --- |
| 多栏导航 | 点击文件夹在右侧展开新的一栏，路径上的各级保持浅色轨迹高亮 |
| 无边框窗口 | 没有 Windows 原生标题栏与菜单栏；标题栏与工具条合并为一行，窗口控制按钮自绘 |
| HTML 预览 | 带地址栏的迷你浏览器窗口，**相对路径的样式与脚本正常工作** |
| Markdown 预览 | 渲染为排版正文，可切「预览 / 源码」 |
| 代码查看 | Shiki 有状态分词 + 行号，跨行注释/模板字符串整段正确着色；大文件按阶梯降级 |
| 图片查看 | SVG/PNG/JPG 等等比显示，透明区棋盘格 |
| 文件夹摘要 | 选中文件夹时显示条目数与子项列表 |
| 大目录 | 单栏超过 120 项自动切换虚拟滚动，数千项也不卡 |
| 搜索 | 按名称过滤当前已展开的各栏，显示「命中 / 总数」 |
| 系统集成 | 双击用默认程序打开、在资源管理器中显示、复制路径、右键菜单 |
| 界面 | 明暗主题、预览面板拖拽调宽与收起、窗口位置与设置自动记忆 |

完整的**产品行为定义**（含验收标准与版本规划）见 [FEATURES.md](FEATURES.md)；
代码高亮的选型、渲染管线与降级阈值见 [docs/highlighting.md](docs/highlighting.md)。

## 快捷键

| 按键 | 行为 |
| --- | --- |
| `↑` `↓` | 当前栏内上下移动选中项 |
| `→` | 进入选中的文件夹 |
| `←` | 回到上一级 |
| `⏎` | 用默认程序打开 |
| `Esc` | 清空搜索 / 清空选中 |
| `/` | 聚焦搜索框 |
| `F5` | 重新扫描当前目录 |
| `Ctrl+O` | 打开文件夹 |
| `Ctrl+B` | 显示 / 隐藏预览面板 |
| `Ctrl+F` | 聚焦搜索框 |
| `Ctrl+Shift+L` | 切换明暗主题 |
| `F12` | 开发者工具 |

原生菜单栏已移除，这些快捷键由渲染进程自己接管，行为与菜单项一致。

## 目录结构

```
project_viewer/
├── index.html              # 设计原型（单文件，仅用于视觉评审）
├── FEATURES.md             # 产品功能特性定义
├── docs/highlighting.md    # 代码高亮方案（选型、管线、降级阈值、实测）
├── scripts/
│   └── build-renderer.mjs  # 用 esbuild 打包高亮 Worker（按需分包）
├── src/
│   ├── main/
│   │   ├── main.js         # 主进程：无边框窗口、IPC、pv:// 协议、菜单
│   │   ├── fs-api.js       # 文件系统访问层（只读，带路径授权校验）
│   │   ├── store.js        # 界面偏好持久化（userData/state.json）
│   │   └── preload.js      # contextBridge 白名单 API
│   └── renderer/
│       ├── index.html      # 界面结构（标题栏含自绘窗口控制）
│       ├── styles.css      # 样式（设计变量与原型一致）
│       ├── app.js          # 多栏导航、预览分派、虚拟滚动、交互
│       ├── icons.js        # 图标与文件类型映射
│       ├── highlight.js    # 高亮客户端：Worker 调度、降级、窗口渲染
│       ├── highlight/
│       │   └── worker.js   # Shiki 分词（源文件，需打包）
│       ├── vendor/         # Worker 打包产物（npm start 前自动生成）
│       └── markdown.js     # Markdown 渲染
└── sample-project/         # 示例工作区
```

### 构建

Shiki 的产物用裸模块名（`@shikijs/core`），浏览器无法直接解析，所以高亮 Worker 需要打包：

```bash
npm run build     # 生成 src/renderer/vendor/（62 个产物，按需 chunk）
```

`npm start` / `npm run dev` / `npm run shot` 都会通过 `pre*` 钩子自动先构建。
`vendor/` 已加入 `.gitignore`，克隆后直接 `npm start` 即可。

## 架构要点

### 安全模型

渲染进程没有 Node 能力：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，
只能调用 preload 暴露的白名单方法。主进程是唯一的系统访问入口，且**只提供读操作**——
没有重命名、删除、移动、执行任意命令的接口。

所有路径都要通过 `assertAllowed()`：只能访问已登记为工作区的根目录内部。实测：

```
pv.read('C:\Windows\win.ini')            → EACCES_ROOT
pv.openPath('...\calc.exe')              → EACCES_ROOT（不会真的启动）
pv.read('<root>/../../package.json')     → EACCES_ROOT（目录穿越被拦下）
```

### 为什么预览用自定义 `pv://` 协议

直接用 `file://` 加载预览页有两个问题：一是相对路径的样式表/脚本解析受限，二是会把整块磁盘暴露给预览页。
`pv://local/<绝对路径>` 注册为标准 + 安全协议，每次请求都过 `assertAllowed()`，
同时因为它是标准协议，HTML 里的 `href="styles.css"` 能正常解析。预览的 iframe 还带 `sandbox`，
页面脚本跑在隔离环境里，碰不到宿主界面。

### 性能取舍

- **`readdir` 与 `stat` 分离**：先返回条目名让首屏立刻可交互，大小/修改时间由主进程并发补发（`fs:meta`），
  渲染进程只更新可见行的文本，不重绘整列
- **虚拟滚动**：单栏超过 120 项时只渲染可视窗口（2520 项的目录实测 DOM 只有 45 行）
- **逐栏增量渲染**：切换选中项时只重建真正变化的那一栏及其右侧各栏，
  已有栏不重建——不重放动画、不重置滚动位置、不产生空白帧
- **目录按需扫描**：只有被展开的那一栏才读磁盘，不递归

### 无边框窗口

窗口用 `frame: false` 创建，Windows 原生标题栏和菜单栏都不出现：

- 最上面一行同时是标题栏和工具条，空白处带 `-webkit-app-region: drag`，所有按钮/输入框标 `no-drag`
- 最小化 / 最大化 / 关闭是自绘按钮，通过 IPC 调 `win.minimize() / maximize() / close()`；
  最大化状态由主进程推回界面，用于切换图标并去掉窗口描边
- 应用菜单不再占一行：高频操作留成标题栏按钮，其余收进「⋯」弹出的原生菜单
- 快捷键（`Ctrl+O` `Ctrl+B` `Ctrl+F` `F5` `F12` 等）改由渲染进程接管，
  否则移除菜单后快捷键会一起失效
- 代价：Windows 11 的「贴靠布局」（悬停最大化按钮出现分屏网格）只对原生按钮生效，自绘按钮没有这个功能

### 代码高亮

按 [docs/highlighting.md](docs/highlighting.md) 实现：Shiki + JS 正则引擎（不带 wasm），
分词在 Worker 里一次完成（TextMate 语法有状态，不能分段），主线程只渲染可见窗口的 DOM。
语言与主题按需加载（esbuild 切成独立 chunk），双主题 token 用 CSS 变量输出，切主题不重新分词。

## 开发辅助：命令行截图

主进程带了一个调试用截图钩子，可以在不改代码的情况下驱动界面并截屏，便于回归验证：

```bash
npm run shot -- --open="./sample-project" --shot=".tmp/shot.png" --shot-js=".tmp/probe.js"
```

- `--open=<dir>` 启动时打开指定工作区
- `--shot=<file>` 加载完成后截图并退出
- `--shot-js=<file>` 截图前先在页面里执行该 JS 文件（可返回对象，会打印到 stdout）
- `--shot-delay=<ms>` 等待时长

## 发布

推送 `v` 开头的 tag 会触发 [.github/workflows/release.yml](.github/workflows/release.yml)：
在 `windows-latest` 上安装依赖、构建 NSIS 安装包与免安装版，然后创建 Release 并上传产物。
tag 里带连字符（如 `v0.0.1-alpha`）会自动标记为预发布。

```bash
git tag v0.0.2-alpha
git push origin v0.0.2-alpha
```

本地打包（产物在 `dist/`）：

```bash
npm run dist      # predist 会先生成高亮 Worker 与图标
```

- `Lit-Explorer-Setup-<version>.exe` —— NSIS 安装包，可选安装目录
- `Lit-Explorer-<version>-portable.exe` —— 免安装版

未配置代码签名，Windows SmartScreen 会提示未知发布者。

## 已知限制

- 拖放打开文件夹尚未实现（Electron 32+ 需要用 `webUtils.getPathForFile`）
- 文件内容被外部修改时预览不会自动刷新，需点预览头的刷新按钮
- 自绘的最大化按钮不支持 Windows 11 贴靠布局（Snap Layouts），需要分屏时用 `Win + 方向键`
- 首次预览某种语言时有一次性的语法规则编译开销（约 140–600 ms，之后稳定在 10 ms 内）；
  代码视图会先显示纯文本再上色，不会白屏等待
- 高亮已覆盖 40 种常见语言与配置文件；未收录的语言按纯文本展示
- 多选（Ctrl/Shift）尚未实现
- 未配置代码签名，分发时 Windows 会提示未知发布者
