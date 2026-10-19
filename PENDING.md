# 待处理（发版前必须清空）

「稍晚一点处理」的问题池：小 bug、明显的瑕疵、临时的绕过、该顺手做掉的清理。
共同点是**都很小、都已知、都不该拖过一个版本**。

## 规则

- **打 tag 之前这个文件必须是空的。** 发版检查清单里有这一步，见
  [docs/agents/release.md](docs/agents/release.md)。
- 清不掉就逐条写明为什么可以带着发，并把它挪到该去的地方：要人拍板的进
  [further_notes.md](further_notes.md)，要等上游的进
  [docs/security-debt.md](docs/security-debt.md)，属于产品取舍的写进
  [FEATURES.md](FEATURES.md)。
- 每条写清：现象、影响、怎么修（没查清就写「先查清什么」）、为什么现在不做。
- 修完直接删掉整条，别在这里维护「已完成」列表。
- **这不是需求池。** 想做的功能进 [further_notes.md](further_notes.md)，
  已排期的进 [FEATURES.md](FEATURES.md) 第 8 节。

---

## T3 · 本地 `dist/` 会累积历次打包的安装包

**现象**：`npm run dist` 不清 `dist/`，历次打包的 exe 都留在那里。实测本地 `dist/`
里同时躺着 0.0.1 到 0.0.4 四个版本的安装包与 blockmap。

**影响**：用 `dist/Lit-Explorer-Setup-*.exe` 做装包验证时容易装到旧版本。本轮已经踩到
一次：`scripts/build-checksums.mjs` 最初把四个版本的 exe 全列进了 `SHA256SUMS.txt`，
后来改成按当前版本号过滤才算对。CI 上 `dist/` 每次都是新的，所以只有本地会踩。

**怎么修**：`dist` 脚本前面加一步清空 `dist/`（`SHA256SUMS.txt` 在打包之后生成，
不受影响）。只在文档里写「验证前先删 dist/」治不了根。

**为什么现在不做**：改 `dist` 脚本动的是发版路径，想和签名（N4）一起过一遍。

---

## T2 · `.npmrc` 的 `electron_mirror` 每次安装都告警，下个 npm 主版本会失效

**现象**：每次 `npm install` / `npm ci` 都打一行
`npm warn Unknown project config "electron_mirror". This will stop working in the next major version of npm.`

**影响**：现在还能用——npm 会把未知配置作为 `npm_config_*` 传给生命周期脚本，@electron/get
读的就是它。但 npm 下个主版本不再传递，届时镜像静默失效，国内 `npm install` 会退回去从
GitHub 拉 Electron 二进制并超时。**静默失效**是这里真正的问题：不会报错，只会变慢到超时。

**怎么修**：先查清 npm 停止传递未知配置后 @electron/get 认哪个变量（`ELECTRON_MIRROR`
环境变量，还是别的），再决定用 `.npmrc` 的另一种写法，还是改成只在安装时生效的形式。
README 的「依赖安装慢 / 卡在下载 Electron」一节要跟着改。

**为什么现在不做**：要实测，且不影响当前功能。

---

## T1 · `fs-api.js` 有两个导出没人用

**现象**：`allowedRootList()` 与 `offeredRootList()`（`src/main/fs-api.js`）定义并导出，
但 `src/`、`test/`、`scripts/` 里都没有调用点。

**影响**：无功能影响。只是导出的 API 面比实际需要的大——后面有人看到会以为它们是被依赖
的接口，改动时不敢动。

**怎么修**：先确认没有计划中的用途（比如探针或调试要读），确认没有就删掉定义与导出。

**为什么现在不做**：属于顺手清理，攒着和别的改动一起过。
