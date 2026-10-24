# lit explorer

<img src="assets/icon-source.png" width="88" height="88" alt="lit explorer">

面向开发者的本地项目文件浏览器：左侧多栏目录导航，右侧即时预览，双击文件用系统默认程序打开。

只支持 **Windows**（x64），没有 macOS / Linux 的构建目标，也没有跨平台适配的计划。

图标以黑白灰层叠窗格表现多栏浏览与文件预览，使用透明背景的
`assets/icon-source.png` 原图；`scripts/build-icons.mjs` 从它生成各尺寸 PNG 与 ICO。

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
| 多栏导航 | 点击文件夹在右侧展开新的一栏，路径上的各级保持浅色轨迹高亮；根目录栏固定在左侧，横向滚动时不消失。列表每行是「类型图标 + 名称」，目录多一个进入箭头（悬停或选中时出现），行尾是快速访问的闪电图标——文件与目录的闪电对齐在同一列，行内不显示文件大小 |
| 快速访问 | 右键或行尾闪电图标把文件/文件夹加入快速访问；面板占最左栏下半部分（默认 1/3），条目从顶部往下排，与另一个面板之间的分隔条可拖动调比例（比例跟位置走，交换上下不影响它） |
| 项目切换 | 最左栏底部最多放 5 个项目，按添加顺序排列、切换时不重排；当前工作区的图标彩色、其余去色，悬停出项目名与完整路径；点击切换并恢复该项目上次的目录层级、选中文件与预览模式；右键可换图标（内置图标 / 图片）或移除，`+` 打开新项目（满 5 个时提示先移除一个） |
| 多窗格预览 | 预览头部的图钉按钮可把当前预览固定到右侧（最多 3 个），新固定的排在已有固定列的左边；**固定时「正在看的那一屏」整块搬过去**——连续预览滚到第几张、文档读到哪一段、图片缩放到几档、查找词与高亮都跟着走，不会跳回第一张图或文首；临时预览只在选中「没被固定住的文件」时才更新，已固定的内容不会重复展示，最多四列并行，各自独立的文件与「预览 / 源码」模式；切换临时预览时固定列的内容、宽度与滚动位置都不变 |
| 预览列调宽 | 每个预览列左侧的边界都能拖，分界线跟着指针走：往左拖时左边那一列同时变窄（最左那一列由栏区让位，栏区最窄 260px）；空间不够时先压固定列、最后才压临时预览列，且只压显示宽度、不改你拖出来的宽度（关掉几列后自动恢复）；手拖过一次之后各列就以拖出来的宽度为准；列窄到 400px 以下时头部按钮换行并靠右 |
| 收起临时预览 | 临时预览列的 ✕ / `Ctrl+B`（「⋯」菜单里也有）只收放临时预览列，**固定列留在原处**；没有固定列时才是整块收起，单击文件即恢复 |
| 无边框窗口 | 没有 Windows 原生标题栏与菜单栏；标题栏与工具条合并为一行，窗口控制按钮自绘 |
| HTML 预览 | 带地址栏的迷你浏览器窗口，`.html/.htm/.xhtml` 均可预览，**相对路径的样式、经典脚本、ES module 与 fetch 正常工作** |
| Markdown 预览 | 渲染为排版正文，可切「预览 / 源码」 |
| 预览内查找 | 预览里按 `Ctrl+F` 展开查找条：输入即高亮全部命中并定位到第 1 个，`⏎` / `Shift+⏎` 在命中间循环跳转，右侧显示「当前 / 总数」，`Esc` 关闭并逐字还原正文。支持 Markdown 预览与 Word / PPT 内嵌预览；指针在哪一列就查哪一列 |
| Word 预览 | `.docx` 用 docx-preview 纯前端解压渲染成分页正文，可在「⋯」菜单里单独关闭 |
| PPT 预览 | `.pptx` 用 pptx-preview 逐页渲染（文字、形状、图片、图表），可在「⋯」菜单里单独关闭；对「部件声明指向不存在部件」的不规范文件做了容错，预览前会摘掉这类陈旧声明并在预览区顶部说明 |
| PDF 预览 | 交给 Chromium 内置 PDF 阅读器，缩放 / 翻页 / 下载 / 打印都在预览面板里 |
| 代码查看 | Shiki 有状态分词 + 行号，跨行注释/模板字符串整段正确着色；大文件按阶梯降级 |
| 图片查看 | SVG/PNG/JPG 等等比显示，透明区棋盘格；默认适应窗口，预览头可用 `− [适应/150%] +` 或 `Ctrl+滚轮` 缩放（25%–800%），放大后横竖都能滚 |
| 连续预览 | 图片预览头右侧的向下箭头：把同目录里排在当前图片后面的图片竖着排下来，向下滚动即看下一张，每张的紧下方标注「第几张 / 共几张」与文件名（说明贴着它上面那张图，不会看成下一张的标题）；懒加载，一次最多 300 张 |
| 大目录 | 单栏超过 120 项自动切换虚拟滚动，数千项也不卡 |
| 搜索 | 按名称过滤当前已展开的各栏，显示「命中 / 总数」 |
| 系统集成 | 双击用默认程序打开、在资源管理器中显示、复制路径、右键菜单 |
| 点文件开关 | 根目录栏头部的眼睛图标可隐藏/显示以 `.` 开头的文件与文件夹 |
| 界面 | 明暗主题、预览列拖拽调宽与收起（收起的是临时预览列，固定列不受影响；单击文件自动重新展开）、最左栏两个面板的上下互换与比例拖动、窗口位置与设置自动记忆 |

完整的**产品行为定义**（含验收标准与版本规划）见 [FEATURES.md](FEATURES.md)；
代码高亮的选型、渲染管线与降级阈值见 [docs/highlighting.md](docs/highlighting.md)。

## 快捷键

| 按键 | 行为 |
| --- | --- |
| `↑` `↓` | 焦点在栏区：当前栏内上下移动选中项；焦点在预览列（点过或滚轮滚过那一列）：滚动该列内容，不动选中项 |
| `→` | 进入选中的文件夹 |
| `←` | 回到上一级 |
| `⏎` | 用默认程序打开 |
| `Esc` | 清空搜索 / 清空选中 |
| `/` | 聚焦搜索框 |
| `F5` | 重新扫描当前目录 |
| `Ctrl+O` | 打开文件夹 |
| `Ctrl+B` | 显示 / 隐藏预览面板 |
| `Ctrl+F` | 在预览内查找关键字（Markdown / Word / PPT）；当前列不支持查找时给出提示，没有可查找的预览时聚焦搜索框 |
| 查找条内 `⏎` / `Shift+⏎` | 跳到下一个 / 上一个命中（循环） |
| `Ctrl+Shift+L` | 切换明暗主题 |
| `Ctrl`+滚轮（图片上） | 缩放当前图片 |
| 图片预览头的向下箭头 | 进入 / 退出连续预览（同目录后续图片） |
| `F12` | 开发者工具 |

原生菜单栏已移除，这些快捷键由渲染进程自己接管，行为与菜单项一致。
原来状态栏里的按键图例收进了「⋯ → 快捷键」子菜单，不再占界面。

## 目录结构

只列需要知道的东西，完整清单看仓库。文档各管一件事，分工见 [AGENTS.md](AGENTS.md)。

```
project_viewer/
├── README.md / README.en.md   # 用法（中文 / 英文简版）
├── FEATURES.md                # 产品行为定义、版本规划、明确的非目标
├── CONTRIBUTING.md            # 参与开发（含几条红线）
├── SECURITY.md                # 安全策略与报告渠道
├── AGENTS.md                  # 文档索引：什么场景读哪份
├── further_notes.md           # 想做的功能、要拍板的事
├── PENDING.md                 # 顺手要清的小问题（发版前必须为空）
├── index.html                 # 设计原型（单文件，仅用于视觉评审）
├── docs/
│   ├── highlighting.md        # 代码高亮方案（选型、管线、降级阈值、实测）
│   ├── security-debt.md       # 已知但没有可行修法的依赖 / 安全问题
│   ├── agents/                # 操作手册，按场景分文件
│   ├── design/                # 未实施功能的调研与方案
│   └── audits/                # 历史审查记录，按日期归档
├── scripts/
│   ├── build-renderer.mjs     # esbuild 打包高亮 Worker（按需分包）与 docpreview
│   ├── build-icons.mjs        # 由 SVG 母版生成各尺寸 ICO
│   ├── build-notices.mjs      # 生成随包分发的第三方许可声明
│   ├── build-checksums.mjs    # 生成发布产物的 SHA256SUMS.txt
│   └── audit-report.mjs       # 漏洞扫描，按「进不进安装包」分开看
├── src/
│   ├── main/                  # 主进程：唯一的系统访问入口，只读
│   │   ├── main.js            # 无边框窗口、IPC、pv:// 协议、菜单
│   │   ├── fs-api.js          # 文件系统访问层（带路径授权校验）
│   │   ├── store.js           # 界面偏好持久化（userData/state.json）
│   │   └── preload.js         # contextBridge 白名单 API
│   └── renderer/              # 渲染进程（无 Node 能力）
│       ├── index.html         # 界面结构（标题栏含自绘窗口控制）
│       ├── styles.css         # 样式（设计变量与原型一致）
│       ├── app.js             # 编排：导航、快捷键、事件接线
│       ├── pane.js            # 分栏与列：虚拟滚动、固定列、列宽
│       ├── preview-body.js    # 预览正文：各类型的渲染与降级
│       ├── find.js            # 预览内查找
│       ├── projects.js        # 项目切换条、图标选择与每个项目的浏览位置
│       ├── icons.js           # 图标与文件类型映射
│       ├── markdown.js        # Markdown 渲染
│       ├── highlight.js       # 高亮客户端：Worker 调度、降级、窗口渲染
│       ├── highlight/worker.js# Shiki 分词（源文件，需打包）
│       ├── docpreview.js      # docx / pptx 预览入口（需打包成 vendor/docpreview.js）
│       └── vendor/            # 打包产物（npm start 前自动生成）
├── test/                      # 单元与集成测试、界面探针骨架
└── sample-project/            # 示例工作区
```

`src/renderer/` 的四层是有意的分工：`app.js` 只做编排，`pane.js` 管分栏与列的生命周期，
`preview-body.js` 管「这个东西怎么渲染」，`find.js` 管查找。加功能前先看清该落在哪一层。

### 构建

Shiki 的产物用裸模块名（`@shikijs/core`），docx-preview / pptx-preview 同样如此，
浏览器无法直接解析，所以这两处都要先打包：

```bash
npm run build     # 生成 src/renderer/vendor/（高亮 Worker 按需 chunk + docpreview.js）
```

`npm start` / `npm run dev` / `npm run shot` 都会通过 `pre*` 钩子自动先构建。
`vendor/` 已加入 `.gitignore`，克隆后直接 `npm start` 即可。

### 为什么运行时依赖是空的

`dependencies` 是空的，`shiki` / `docx-preview` / `pptx-preview` / `jszip` 都放在 `devDependencies`：
主进程只用 `electron` 与 Node 内置模块，这几个库已经被 esbuild 打进 `src/renderer/vendor/`，
运行时不会再 `require` 它们。electron-builder 默认把 production 依赖整棵拷进 `app.asar`，
而 pptx-preview 会拖进 `echarts` + `zrender`（约 55 MB）——放在 `dependencies` 里会让
`app.asar` 从 4.5 MB 涨到 81 MB。**新增依赖时注意：只有运行时真的 require 的才放 `dependencies`。**

## 架构要点

### 安全模型

渲染进程没有 Node 能力：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，
只能调用 preload 暴露的白名单方法。主进程是唯一的系统访问入口，且**只提供读操作**——
没有重命名、删除、移动、执行任意命令的接口。

所有路径都要通过 `assertAllowed()`：只能访问已登记为工作区的根目录内部。它比较的是
`realpath` 之后的真实路径——工作区里指向外部的 junction / 符号链接同样越不过去。实测：

```
pv.read('C:\Windows\win.ini')            → EACCES_ROOT
pv.openPath('...\calc.exe')              → EACCES_ROOT（不会真的启动）
pv.read('<root>/../../package.json')     → EACCES_ROOT（目录穿越被拦下）
pv.read('<root>/linked/marker.txt')      → EACCES_ROOT（junction 指向外部）
```

预览内容一律按不可信处理：docx 的 altChunk 不渲染，文档渲染完会清掉脚本类节点、
行内事件属性与危险协议；Markdown 链接只放行 `http(s)` / `mailto` / 相对地址，
地址里的引号会被转义，事件处理器注入不进去。

可读范围只有**当前打开的那一个工作区**：切换工作区时会清掉上一个的授权，
在 A 里读过的目录不会因为切到 B 而继续可读。

### 隐私与联网

没有账号、没有遥测、没有崩溃上报，不往任何服务器发数据，也没有内置的更新检查。

网络请求只有一个来源：**你自己预览的文件**。HTML 预览里的脚本、Markdown 里的外链图片、
`fetch()` 都会照常联网——它们跑在 Chromium 里，行为和浏览器一致。除此之外应用自身不发起
任何请求，`pv://` 协议只解析本机文件。

可读范围就是工作区，边界见上面「安全模型」；不可信 HTML 预览能读到**当前工作区**内的文件
（这是「HTML 预览要能引用相对资源」的直接结果），当时怎么权衡的记在
[docs/audits/2026-10-19-security-review.md](docs/audits/2026-10-19-security-review.md) 末尾。

### 为什么预览用自定义 `pv://` 协议

直接用 `file://` 加载预览页有两个问题：一是相对路径的样式表/脚本解析受限，二是会把整块磁盘暴露给预览页。
`pv://local/<绝对路径>` 注册为标准 + 安全协议，每次请求都过 `assertAllowed()`，
同时因为它是标准协议，HTML 里的 `href="styles.css"` 能正常解析。预览的 iframe 还带 `sandbox`，
页面脚本跑在隔离环境里，碰不到宿主界面。协议开启了 `corsEnabled` 并返回
`Access-Control-Allow-Origin: *`，所以预览页里的 ES module 和 `fetch()` 不会被 CORS 拦下。

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

## 开发辅助：测试

```bash
npm test                  # 单元 + Electron 集成
npm run test:unit         # 只跑不需要 Electron 的那部分（毫秒级）
npm run test:integration  # 只跑集成套件
```

覆盖工作区路径边界（符号链接 / junction 越界）、Markdown 链接的协议白名单与属性
转义、不可信 docx 不执行脚本、预览异步结果的归属（加载中固定、旧文档解析失败、
同文件重新读取）、高亮 Worker 并发初始化、`pv://` 协议边界。夹具与 `userData` 都
在 `.tmp/test/` 下，不会碰你正在用的实例；`test/` 不进安装包。

集成套件偏慢，所以支持挑着跑：`--list` 看段落 id，`--only=S2` / `--skip=C1,C2` 选范围，
被跳过的段落连准备动作一起跳过。**改哪儿跑哪儿，提交前再跑一次全量**；纯逻辑改动
（Markdown 渲染、路径校验）用 `npm run test:unit`，不需要开窗口。每次运行都会打印
各段耗时——那才是准数，文档里不抄数字。

换来的是这些「正常使用看不出来」的问题——注入类要打开构造过的文件才触发，异步类
要靠特定时序才复现——从「每次现写探针脚本」变成一条命令。但它用的是可控 IPC 桩，
钉住的是逻辑而非真实磁盘时序，界面行为仍然只有截图钩子能验：全绿不等于可以发版。
用法与取舍见 [docs/agents/verify.md](docs/agents/verify.md)。

## 开发辅助：界面探针

界面行为（布局、固定列、查找、图片缩放、连续预览）自动化测试覆盖不到，靠探针驱动。
主进程有一个调试用截图钩子，可以在不改代码的情况下驱动界面并截屏；写探针不用从零
开始，骨架与 runner 都在仓库里：

```bash
npm run probe -- .tmp/my-probe.js --open=.tmp/panews --shot=.tmp/p.png
```

`test/probe-harness.js` 把常用的选择器与等待挂在 `window.H` 上（`H.pick / H.temp /
H.pin / H.layout / H.scrollTop / H.anchor / H.type / H.key / H.toast`），文件顶部那份
清单就是界面的约定。探针文件是一个返回对象的 IIFE，返回值以 `[shot-js] {...}` 打到
stdout。`npm run probe` 默认带独立的 `userData`，不会碰你正在用的实例。

只用原始截图钩子（参数见 `npm run shot -- --help`）：

```bash
npm run shot -- --open="./sample-project" --shot=".tmp/shot.png" --shot-js=".tmp/probe.js"
```

- `--open=<dir>` 启动时打开指定工作区
- `--shot=<file>` 加载完成后截图并退出
- `--shot-js=<file>` 截图前先在页面里执行该 JS 文件（可返回对象，会打印到 stdout）
- `--shot-delay=<ms>` 等待时长

## 发布

推送 `v` 开头的 tag 会触发 [.github/workflows/release.yml](.github/workflows/release.yml)：
先在 `windows-latest` 上跑一遍 [.github/workflows/ci.yml](.github/workflows/ci.yml) 的测试，
过了才构建 NSIS 安装包与免安装版，然后创建 Release 并上传产物。
tag 里带连字符（如 `v0.0.1-alpha`）会自动标记为预发布。

```bash
git tag v0.0.4-alpha
git push origin v0.0.4-alpha
```

日常提交不需要打 tag：推 `main` 只跑测试，不构建。

本地打包（产物在 `dist/`）：

```bash
npm run dist      # predist 会先生成高亮 Worker、图标与第三方许可声明
node scripts/build-checksums.mjs   # 生成 SHA256SUMS.txt
```

- `Lit-Explorer-Setup-<version>.exe` —— NSIS 安装包，可选安装目录
- `Lit-Explorer-<version>-portable.exe` —— 免安装版
- `SHA256SUMS.txt` —— 上面两个的校验和

**未配置代码签名**，Windows SmartScreen 会提示「未知发布者」。下载后可以核对校验和：

```bash
sha256sum -c SHA256SUMS.txt
```

安装目录的 `resources/` 下附带 `LICENSE`、`FEATURES.md`、`docs/` 与第三方许可声明
`notices/THIRD-PARTY-NOTICES.md`。

## 已知限制

- 拖放打开文件夹尚未实现（Electron 32+ 需要用 `webUtils.getPathForFile`）
- 文件内容被外部修改时预览不会自动刷新；预览头每 5 秒检查一次，发现变化时刷新按钮会变红，点它重新读取
- 目录列表也不会自动重载；展开中的每栏目录每 5 秒检查一次，有增删 / 改名时左栏的重新扫描按钮会变红
- 窗口在后台连续 10 分钟没有回到前台时，以上两项检查都会暂停；重新聚焦时立刻恢复并补查一次
- 工作区内指向外部的符号链接 / junction 会在列表里显示为不可用（删除线），
  点开会提示「超出已授权的工作区范围」；指向工作区内部的链接照常可用
- 自绘的最大化按钮不支持 Windows 11 贴靠布局（Snap Layouts），需要分屏时用 `Win + 方向键`
- 首次预览某种语言时有一次性的语法规则编译开销（约 140–600 ms，之后稳定在 10 ms 内）；
  代码视图会先显示纯文本再上色，不会白屏等待
- 高亮已覆盖 40 种常见语言与配置文件；未收录的语言按纯文本展示
- docx / pptx 是纯前端解析，不是 Office 的排版引擎：docx 版式接近但非像素级，
  pptx 保证文字、形状、图片与图表，动画、切换、SmartArt、嵌入对象会丢失；
  超过 25 MB 或解析不出内容时回落到「用默认程序打开」的卡片
- pptx 解析器是严格按 `[Content_Types].xml` 取部件的，而 PowerPoint 是按关系图取部件。
  转换工具导出的文件常留下指向不存在部件的陈旧声明（PowerPoint 能打开、解析器会整体放弃），
  应用会先把这类声明摘掉再预览并在顶部说明；如果仍然解析不出，说明是别的结构问题，
  这时请用卡片上的「用默认程序打开」
- 固定住的预览列只在本次运行内有效（重启不恢复）；收起预览面板时固定列一并隐藏，展开后原样回来
- 点击文件夹不会产生「文件夹预览」，预览区只呈现文件内容；选中文件夹时当前预览保持不动，
  点下一个文件才被顶掉
- 临时预览列只在「选中的文件没被固定住」时更新：固定了 A、临时列在看 B 时点回 A，B 会留着
- 多列并行时预览列按比例自动压缩，但压缩只影响显示宽度：先压固定列、最后才压临时预览列，
  你拖出来的宽度会被记住，关掉几列后自动恢复；手动拖过分界线之后，各列就以拖动结束时的
  宽度为准（栏区让到不低于 260px），不再回弹到更早的设定值
- 预览内查找目前只覆盖「渲染成真实 DOM」的预览（Markdown 预览、Word / PPT 内嵌预览）：
  源码/代码视图是按可视窗口渲染的（DOM 里只有几十行），图片、PDF、HTML 在 iframe 里，
  这几类暂不支持 `Ctrl+F`，按键时会给出提示而不是静默失效
- 预览内查找大小写不敏感、无整词选项，单次最多标记 2000 处命中
- 连续预览一次最多列 300 张（超出会在末尾说明还剩多少张），图片走原生懒加载；
  直接拖到长列表最底部时，最后几张可能要等一下才加载出来
- 多选（Ctrl/Shift）尚未实现
- 未配置代码签名，分发时 Windows 会提示未知发布者

## 许可与参与

以 [MIT 许可](LICENSE)发布。产物里打包压缩过的第三方代码（shiki、docx-preview、
pptx-preview 等，压缩后版权头不可读）各自的许可，由 `npm run notices` 生成成一份
第三方许可声明，随安装包放在 `resources/notices/THIRD-PARTY-NOTICES.md`。

想改代码请看 [CONTRIBUTING.md](CONTRIBUTING.md)；报告安全漏洞请看 [SECURITY.md](SECURITY.md)，
不要开公开 issue。已经做出来的行为在 [FEATURES.md](FEATURES.md)，想过但没做的在
[further_notes.md](further_notes.md)。
