# 验证改动

## 自动化测试

```bash
npm test                  # 单元 + Electron 集成
npm run test:unit         # 只跑不需要 Electron 的那部分
npm run test:integration  # 只跑集成套件
```

- `test/unit.test.cjs`：工作区路径边界（`assertAllowed` 按真实路径比较、junction
  越界被拒、前缀相同的兄弟目录被拒）与 Markdown 渲染（链接协议白名单、属性转义、
  普通语法不退化）。
- `test/integration.test.cjs`：隐藏窗口 + 可控 IPC 桩，跑不可信 docx 渲染
  （altChunk 与超链接不执行脚本）、预览异步结果的归属（加载中固定、旧文档解析
  失败、同文件重新读取）、高亮 Worker 并发初始化、`pv://` 协议边界。

两个套件都用 `.tmp/test/` 下的临时夹具与独立 `userData`，不碰用户正在用的实例。
`test/` 不在 `electron-builder` 的 `files` 里，不进安装包。

加用例时用 `test/helpers.cjs` 的 `run(id, title, fn) / ok / eq / eqJson / done`：
断言要打印出实际值（失败信息就是排错线索），改坏的既有行为要能直接反映成红。

### 迭代时只跑相关的那一段

`--list` 看段落 id，`--only` / `--skip` 挑范围：

```bash
npm run test:unit -- --only=S2             # 改了 Markdown 渲染
npm run test:unit -- --only=S3             # 改了路径校验
npm run test:integration -- --only=C4      # 改了预览渲染 / 异步归属
npm run test:integration -- --skip=C1,C2   # 其余都跑，跳过这两段
```

被 `--only` 跳过的段落**连准备动作一起跳过**（建夹具、开窗口都不做），所以挑一段跑
不会为别的段落白付开销。但集成套件每段都要付一次 Electron 启动的固定成本，这个跑
不掉——**纯逻辑改动优先用 `test:unit`**，它不需要窗口。

建议：改哪儿跑哪儿，**提交前再跑一次全量**。全量是给「改了公共代码 / 准备提交」用的，
不是每次保存都跑。

### 耗时模型

三个量级，够用来决定跑哪一段。**具体数字以 `done()` 打印的那张表为准，本文不抄**
（抄了就会过期，而且不会有人记得回来改）：

- **单元套件是毫秒级**：它不启动 Electron。改了 Markdown 渲染或路径校验就只跑它。
- **集成套件是秒级，而且每段都要付一次 Electron 启动的固定成本**——这个下限跑不掉，
  所以段落分得再细也不会归零；挑一段跑省下的是那一段自身的开销。
- **集成套件里大部分是刻意注入的等待**，不是真实工作：C1 / C2 / C4 各注入 500ms 的
  读或解析延迟，断言前再留 2～3 倍余量，为的是机器一忙也不假红。想提速，旋钮是
  `test/integration.test.cjs` 顶部的 `DELAY`，代价是抗抖动变差。

首次运行、或刚 `npm run build` 之后会明显慢一些（文件缓存冷），不是用例的问题。

### 收益与边界

这些用例锁住的是「正常使用看不出来」的问题：注入类的要打开一份构造过的文件才触发，
异步类的要靠特定时序才复现——手动验证每次都得现写一遍探针脚本（这轮修复过程中写了
十来个，全在被 gitignore 的 `.tmp/` 下，随时可能被清掉）。它也已经抓到过一次真实
退化：改 Markdown 链接解析时把「链接文字里的行内代码」弄坏了，人工核对多半会漏掉。

代价是执行要花时间、挑范围要多想一步，所以它不参与任何自动流程（没接 CI），
由你决定什么时候跑、跑到哪一段。

**它不覆盖什么。** 断言用的是可控的 IPC 桩，钉住的是逻辑（晚到的响应必须被丢弃），
不是真实磁盘时序；界面行为（布局、固定列、查找、图片缩放、连续预览）仍然只有截图
钩子能验。`npm test` 全绿不等于可以发版。

## 界面探针

界面行为（布局、固定列、查找、图片缩放、连续预览）自动化测试覆盖不到，靠探针驱动。
主进程的截图钩子能在不改代码的情况下驱动界面并截屏（参数见 `npm run shot -- --help`），
但每次都从零写选择器与等待太费，所以骨架与 runner 都在仓库里：

```bash
npm run probe -- .tmp/my-probe.js --open=.tmp/panews --shot=.tmp/p.png
```

- `test/probe-harness.js` 是骨架，挂在 `window.H` 上：`H.pick / H.temp / H.pin /
  H.panes / H.layout / H.scrollTop / H.anchor / H.click / H.type / H.key / H.toast`。
  **文件顶部那份选择器清单是界面的约定**——改界面结构时先更新它，别让每个探针
  各自硬编码选择器。
- `scripts/run-probe.mjs` 把骨架与探针拼成一个脚本交给 `--shot-js`，默认带上独立的
  `--user-data-dir`（不碰用户正在用的实例），并走 `npm run shot` 以便先 build，
  不会拿到过期产物。
- 探针文件是一个返回对象的 IIFE，返回值以 `[shot-js] {...}` 打到 stdout。

一次性探针写 `.tmp/`（被 gitignore）；要长期当回归依据的，写进 `test/`，或者转成
`test/integration.test.cjs` 里的一段。

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
