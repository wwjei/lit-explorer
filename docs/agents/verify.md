# 验证改动

## 自动化测试

```bash
npm test                  # 单元 + Electron 集成
npm run test:unit         # 只跑不需要 Electron 的那部分
npm run test:integration  # 只跑集成套件
```

- `test/unit.test.cjs`：工作区路径边界（`assertAllowed` 按真实路径比较、junction
  越界被拒、前缀相同的兄弟目录被拒）、Markdown 渲染（链接协议白名单、属性转义、
  行内代码不能落进 `href`、普通语法不退化），以及渲染进程设置的白名单
  （窗口只取几何字段、项目路径必须是主进程给过的、网页条目只接受 `http(s)` 且不带 `path`）。
- `test/integration.test.cjs`：隐藏窗口 + 可控 IPC 桩，跑不可信 docx 渲染
  （altChunk、`javascript:` 与制表符混淆的超链接都不执行脚本）、预览异步结果的归属
  （加载中固定、旧文档解析失败、同文件重新读取、晚到的旧图片请求不污染缩放）、
  预览内查找（命中与计数、切到不支持查找的列时自动关、固定时查询词跟到新列、
  代码块异步高亮后命中不丢）、抓手拖动换位与临时列右拖自动固定（P3）、列下 1/3
  分屏 / 取消一格恢复单格 / 临时列直接分屏（P4）、SVG 编辑
  （改字、拖动带框内文字、矩形缩放、删除与撤销、自动保存走 `fs:write-svg` 桩、
  `sendInputEvent` 的真实双击能打开输入框）、含脚本 SVG 的只读清洗、高亮 Worker
  并发初始化、并发切换工作区只留一个授权根、`pv://` 协议边界，以及网页视图的
  生命周期（只接受 `http(s)`、不可见时保留、移出同步列表即销毁）。

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
npm run test:integration -- --only=F1      # 改了预览内查找
npm run test:integration -- --only=E1,E3   # 改了 SVG 编辑 / 清洗
npm run test:integration -- --only=E2      # 改了 SVG 保存通道
npm run test:integration -- --only=E4      # 改了 SVG 双击 / 指针手势
npm run test:integration -- --only=P3      # 改了抓手换位 / 临时列自动固定
npm run test:integration -- --only=P4      # 改了列内分屏
npm run test:integration -- --only=W1      # 改了内嵌网页视图
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
  读或解析延迟，断言前再留 2～3 倍余量，为的是机器一忙也不假红。F1 没有可注入的桩
  延迟，它的开销就是那一串「等界面落定」的等待（每步 60～500ms）。想提速，旋钮是
  `test/integration.test.cjs` 顶部的 `DELAY`，代价是抗抖动变差。

首次运行、或刚 `npm run build` 之后会明显慢一些（文件缓存冷），不是用例的问题。

### 收益与边界

这些用例锁住的是「正常使用看不出来」的问题：注入类的要打开一份构造过的文件才触发，
异步类的要靠特定时序才复现——手动验证每次都得现写一遍探针脚本（这轮修复过程中写了
十来个，全在被 gitignore 的 `.tmp/` 下，随时可能被清掉）。它也已经抓到过一次真实
退化：改 Markdown 链接解析时把「链接文字里的行内代码」弄坏了，人工核对多半会漏掉。

代价是执行要花时间、挑范围要多想一步，所以本地什么时候跑、跑到哪一段由你决定。
CI（[.github/workflows/ci.yml](../../.github/workflows/ci.yml)）在**开 PR 时**跑全量，
合并进 `main` 时再跑一次；`release.yml` 发版前也会先复用同一套。但别因此就把「本地不跑」
当默认——等 CI 要一轮，本地先跑一遍更快。

**它不覆盖什么。** 断言用的是可控的 IPC 桩，钉住的是逻辑（晚到的响应必须被丢弃），
不是真实磁盘时序；界面行为仍然只有截图钩子能验——**列宽拖动的像素、固定列的阅读位置、
连续预览、项目切换条、预览变更提示**完全没进断言，**抓手换位与临时列自动固定**进了
顺序、临时列收起与提示（P3），**列内上下分屏**进了列数、上下顺序、两格同宽、取消一格
恢复单格与临时列直接分屏（P4；分屏分隔条的手感与落点提示的观感仍靠探针），**图片缩放**
进了档位与晚到请求（P1/P2），**查找**进了开关、计数、固定迁移
与代码高亮后的命中（F1/F2），**SVG 编辑**进了改字 / 拖动 / 缩放 / 删除 / 撤销与保存
内容（E1）、真实磁盘上的写入边界与冲突（E2）、不安全 SVG 的只读清洗（E3）、
`sendInputEvent` 的真实双击（E4——合成 `dblclick` 测不出指针捕获把点击目标改掉的问题），
但选中框、手柄手感、文字输入框对齐仍要靠探针看。高亮配色、滚动到视口中间这些观感
同样要靠看。`npm test` 全绿不等于可以发版。

内嵌网页的**实际页面内容不在截图里**：`capturePage()` 只拍宿主页面，拍不到叠在上面的
`WebContentsView`。W1 只钉住视图的创建 / 保留 / 销毁与地址白名单；网页列的观感、
登录态、站点兼容性必须手工验证（或者改用系统级截图）。

预览变更提示（每 5 s 轮询、变更后把刷新按钮变红、重新读取后恢复）也靠探针：先选中一个文件，
再由外部进程改写它，等按钮出现 `is-changed` 后再点刷新核对正文。目录提示同理：外部进程在根目录
新增文件后，等 `[data-rescan].is-changed` 出现，再点它核对列表里出现新条目。写探针时注意截图
窗口的 `document.hidden` 必须为 `false` 且窗口要有焦点（轮询在窗口不可见、或连续 10 分钟
没有回到前台时会暂停）。

项目切换条（5 个项目上限、悬停路径、图标选择、切换后恢复目录与选中文件、当前项下方的
灰色短线与切换动画、右键不弹目录菜单、文字图标最多两个字符）目前靠探针验证：在独立
`--user-data-dir` 的 `state.json` 里预置 5 个项目，启动后按 `.proj-tile` / `.pj-cell` /
`.pj-text-in` 等选择器驱动并截图；动画可以看 `is-line-move` 与 `::after` 的
`getComputedStyle` 变换。要进回归网，得按 F1 的方式把 IPC 桩换成可控的
`workspace:open` 与 `getState`。

## 界面探针

界面行为里没进断言的那部分（列宽拖动的像素、分屏分隔条比例、分屏落点提示、图片缩放、
连续预览，以及查找的观感）靠探针驱动。主进程的截图钩子能在不改代码的情况下驱动界面并截屏（参数见
`npm run shot -- --help`），但每次都从零写选择器与等待太费，所以骨架与 runner 都在仓库里：

```bash
npm run probe -- .tmp/my-probe.js --open=.tmp/panews --shot=.tmp/p.png
```

- `test/probe-harness.js` 是骨架，挂在 `window.H` 上：`H.pick / H.temp / H.pin /
  H.vis / H.cols / H.layout / H.scrollTop / H.anchor / H.click / H.type / H.key / H.toast`。
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
