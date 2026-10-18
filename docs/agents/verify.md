# 验证改动

## 截图钩子

主进程带了一个调试用钩子，可以在不改代码的情况下驱动界面并截屏：

```bash
npm run shot -- --open="./sample-project" --shot=".tmp/shot.png" --shot-js=".tmp/probe.js"
```

| 参数 | 作用 |
| --- | --- |
| `--open=<dir>` | 启动时打开指定工作区 |
| `--shot=<file>` | 加载完成后截图并退出 |
| `--shot-js=<file>` | 截图前先在页面里执行该 JS 文件（可返回对象，打印到 stdout） |
| `--shot-delay=<ms>` | 等待时长 |

## 用构建出的安装包验证（仅 Windows）

这一步只在 Windows 上、且需要验证「打包后的程序」时才做；跑 `npm start` 验证渲染层改动不需要它。

安装包是 NSIS、`perMachine: false`，装到 `%LOCALAPPDATA%\Programs\Lit Explorer`：

```bash
taskkill //IM "Lit Explorer.exe" //F      # 先关掉正在运行的实例：安装要释放文件占用
./dist/Lit-Explorer-Setup-<版本>.exe //S  # /S 静默安装
```

注意：

- 程序有单实例锁（`src/main/main.js` 里的 `requestSingleInstanceLock`），同时只能跑一个。
- 验证用的临时实例会和用户正在用的实例抢 `userData`，GPU 缓存目录会报
  `Unable to create cache: 拒绝访问`——属正常降级，不是故障。
- **不要贸然结束用户正在用的进程**，先确认那是不是你自己起的。

装完可以确认产物里确实是当前代码：

```bash
grep -qa "<某个新符号>" "$LOCALAPPDATA/Programs/Lit Explorer/resources/app.asar" && echo found
```
