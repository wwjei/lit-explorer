# AGENTS.md

给在这个仓库里干活的编码 agent 的说明。人写的文档在 [README.md](README.md)（怎么用）与
[FEATURES.md](FEATURES.md)（产品行为定义，带编号与验收标准）。

## 这是什么

lit explorer：Electron 写的本地项目文件浏览器。左侧 macOS Finder 风格的多栏目录导航，
右侧即时预览（代码高亮 / Markdown / HTML 迷你浏览器 / 图片 / Word / PPT / PDF），
双击文件用系统默认程序打开。

| 位置 | 说明 |
| --- | --- |
| `src/main/` | 主进程：窗口、`pv://` 协议、IPC、右键菜单、只读文件系统层 |
| `src/renderer/` | 渲染进程：多栏导航、预览窗格、查找、高亮客户端、Markdown |
| `scripts/` | 构建脚本：`build-renderer.mjs`（esbuild）、`build-icons.mjs`（图标） |
| `index.html`（根目录） | **早期设计原型，不是程序的一部分**，只作为视觉基线参考 |
| `sample-project/` | 示例工作区，打包时作为 extraResources 一起分发 |

## 常用命令

```bash
npm install        # 依赖（Electron 二进制走 .npmrc 里的 npmmirror 镜像）
npm start          # 启动（prestart 会先构建）
npm run dev        # 启动并开 DevTools
npm run build      # 只构建渲染进程产物
npm run dist       # 出 Windows 安装包 + 免安装版到 dist/
```

`start` / `dev` / `shot` / `dist` 都有 `pre*` 钩子会自动跑 `npm run build`，
所以改完 `src/renderer/highlight/worker.js` 或 `src/renderer/docpreview.js` 后不必手动构建。

### 必须构建的两处

`src/renderer/vendor/` 与 `build/icons/` 都是**生成物**（已在 `.gitignore` 里），不要手改、不要提交：

- `highlight/worker.js` → Shiki 分词 Worker。Shiki 产物用裸模块名（`@shikijs/core`），
  浏览器无法解析，必须用 esbuild 打包并 `--splitting` 切成按需 chunk。
- `docpreview.js` → docx / pptx 预览。同样因为裸模块名（`docx-preview`、`pptx-preview`），
  打成 IIFE 挂到 `window.PV.docpreview`，由 `index.html` 直接 `<script>` 加载。

## 硬性约定

### 改依赖必须同步 package-lock.json

**这是本仓库反复踩到的坑，务必遵守。**

本项目所有依赖都放在 `devDependencies`，`dependencies` 是空的——主进程只用 electron 与 node
内置模块，而 shiki / docx-preview / pptx-preview / jszip 都由 esbuild 打包进 `vendor/`，
运行时不需要 `node_modules`。这样 electron-builder 就不会把 `node_modules` 打进 `app.asar`
——`dependencies` 非空时会打进去（pptx-preview 依赖的 echarts + zrender 一项就有约 55 MB），
实测 `app.asar` 从 4.5 MB 涨到 81 MB。

因此，**任何对 `package.json` 依赖的改动都必须让 lock 跟上**：

```bash
# 只改依赖后（增删依赖、或调整 dependencies / devDependencies 的位置）
npm install                    # 会同步 package-lock.json

# 不想动 node_modules 时
npm install --package-lock-only

# 提交前自检，必须 exit 0
npm ci --dry-run
```

漏掉这一步的后果：CI 里的 `npm ci` 会以
`npm ci can only install packages when your package.json and package-lock.json are in sync`
直接失败，而**本地 `npm run dist` 完全正常**（它不跑 `npm ci`），所以只在本机验证是发现不了的。

同理，**不要只改 `package.json` 的依赖字段就提交**，哪怕只是把某个包从 `dependencies`
挪到 `devDependencies`——根包位置变了，lock 里对应的 `dev` 标记也要变。

### 发版

```bash
npm version <新版本> --no-git-tag-version   # 同时更新 package.json 与 package-lock.json
npm run dist                                # 可选：本机先出包验证
git add -A && git commit
git push origin main
git tag -a v<新版本> -m "lit explorer v<新版本>"
git push origin refs/tags/v<新版本>          # 推送 tag 即触发 CI
```

- 只有 `v*` 开头的 tag 会触发 [.github/workflows/release.yml](.github/workflows/release.yml)：
  在 `windows-latest` 上 `npm ci` → `npm run dist` → `softprops/action-gh-release` 发布 Release。
- tag 名里带连字符（如 `-alpha` / `-beta`）会被自动标记为预发布。
- **不要给 `electron-builder` 加发布能力**：`dist` 脚本里的 `--publish never` 是必需的。
  tag 构建时 electron-builder 会尝试「隐式发布」并因缺少 `GH_TOKEN` 而失败（包已经构建成功，
  只是最后一步报错退出）。发布统一交给 workflow 里的 action-gh-release。
- 没有明确要求时**不要打 tag**，推 `main` 不会触发任何构建。

### 安全边界

渲染进程没有 Node 能力（`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`），
只能调用 preload 白名单里的方法。主进程是唯一的系统访问入口，且**只提供读操作**。

新增任何文件系统相关能力时：

- 路径必须过 `assertAllowed()`，只能访问已登记为工作区的根目录内部；
- 不要在 `preload.js` 里暴露任何写、删除、移动或执行任意命令的接口；
- 预览用的 HTML 走 `pv://` 协议（`standard + secure + corsEnabled`），每次请求都要过
  `assertAllowed()`，不要为了图省事换成 `file://`。

## 验证

主进程带了一个调试用截图钩子，可以在不改代码的情况下驱动界面并截屏：

```bash
npm run shot -- --open="./sample-project" --shot=".tmp/shot.png" --shot-js=".tmp/probe.js"
```

- `--open=<dir>` 启动时打开指定工作区
- `--shot=<file>` 加载完成后截图并退出
- `--shot-js=<file>` 截图前先在页面里执行该 JS 文件（可返回对象，会打印到 stdout）
- `--shot-delay=<ms>` 等待时长

装到本机试用时（安装包是 NSIS，`perMachine: false`，装到 `%LOCALAPPDATA%\Programs\Lit Explorer`）：

```bash
taskkill //IM "Lit Explorer.exe" //F      # 必须先关掉：安装要释放文件占用
./dist/Lit-Explorer-Setup-<版本>.exe //S  # /S 静默安装
```

程序有单实例锁，同时只能跑一个；验证用的临时实例会和用户正在用的实例抢 `userData`，
所以不要贸然结束用户正在用的进程。

## 约定

- 代码注释与文档用中文，风格对齐现有文件。
- 改动涉及产品行为时同步更新 `FEATURES.md`：新增条目要带编号、行为定义、优先级与状态；
  行为发生变化时改掉原条目而不是另加一条。
- 高亮相关的方案、阈值与实测数据记在 [docs/highlighting.md](docs/highlighting.md)。
