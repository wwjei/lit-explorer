# 验证改动

主进程带了一个截图钩子，可以在不改代码的情况下驱动界面并截屏；参数见
`npm run shot -- --help`。

```bash
npm run shot -- --open="./sample-project" --shot=".tmp/shot.png" --shot-js=".tmp/probe.js"
```

## 用构建出的安装包验证（仅 Windows）

只在需要验证「打包后的程序」时做；跑 `npm start` 验证渲染层改动不需要它。
安装包是 NSIS、`perMachine: false`，装到 `%LOCALAPPDATA%\Programs\Lit Explorer`：

```bash
taskkill //IM "Lit Explorer.exe" //F      # 先关掉正在运行的实例：安装要释放文件占用
./dist/Lit-Explorer-Setup-<版本>.exe //S  # /S 静默安装
```

程序有单实例锁，同时只能跑一个；验证用的临时实例会和用户正在用的实例抢 `userData`
（GPU 缓存目录报 `Unable to create cache: 拒绝访问` 属正常降级）。**不要贸然结束
用户正在用的进程**，先确认那是不是你自己起的。

装完可确认产物里确实是当前代码：
`grep -qa "<新符号>" "$LOCALAPPDATA/Programs/Lit Explorer/resources/app.asar"`。
