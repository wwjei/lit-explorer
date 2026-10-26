# 参与开发

先说范围：这个项目**只支持 Windows**，没有 macOS / Linux 的构建目标，也没有做跨平台
适配的计划。提改动前请按 Windows 验证。

## 跑起来

```bash
npm install     # Electron 二进制走 npmmirror 镜像，见 README 的说明
npm start       # 启动（prestart 会先构建渲染进程产物）
npm run dev     # 启动并打开开发者工具
```

## 改完要跑的

```bash
npm test                    # 单元 + 集成，全跑
npm run test:unit           # 毫秒级，迭代时先跑这个
npm run test:integration    # 要起 Electron，约 10 秒
npm run test:integration -- --list              # 看有哪些段落
npm run test:integration -- --only=C4           # 只跑一段
```

改了预览行为的话，`npm run shot` 能截一张图看效果（`npm run shot -- --help` 有参数）。

## 几条容易踩的红线

这几条都是出过事故才写下来的，PR 里被指出来不用意外：

1. **锁文件必须同步。** 动了 `package.json` 的依赖就必须跑
   `npm install --package-lock-only`，并且 `npm ci --dry-run` 要能过。CI 里第一步
   `npm ci` 就是校验这个，不同步直接失败。
2. **`src/renderer/vendor/` 和 `build/icons/` 是生成产物，不要手改、也不要提交。**
   它们由 `npm run build` / `npm run icons` 生成。
3. **`npm run dist` 里的 `--publish never` 不能去掉。** 发布统一交给
   `.github/workflows/release.yml` 里的 action-gh-release。
4. **不要自己打 tag。** 推 `main` 不触发任何构建，只有 `v*` 的 tag 会。打 tag 意味着
   发版，由维护者决定。

## 代码与文档放哪

- `src/main/` —— 主进程，唯一的系统访问入口。改这里的路径处理前先读
  [docs/agents/security.md](docs/agents/security.md)。
- `src/renderer/` —— 渲染进程。`app.js` 是编排，`pane.js` / `preview-body.js` /
  `find.js` 是分出来的三层，加功能前先看清该落在哪一层。
- `docs/agents/` —— 给编码 agent 看的操作手册，按场景分文件，`AGENTS.md` 是索引。
  这里的内容会因为改代码而过期，改动相关的部分要顺手更新。
- `docs/design/` —— 未实施功能的调研与方案。
- `docs/security-debt.md` —— 已知但当前没有可行修法的依赖 / 安全问题。
- `further_notes.md` —— 想做的功能与要拍板的事，只放结论，细节指向 `docs/design/`。
- `PENDING.md` —— 顺手要清的小问题，**发版前必须是空的**。
- `FEATURES.md` —— 已经做出来的行为、明确的非目标。
- `README.md` —— 使用者视角。

同一件事只放一个池子。两边都写一遍，改了一边忘了另一边，下一个来的人就会照着过期的那份做事。

## 提交

提交信息用中文，一句话说清改了什么。一个提交只做一件事——需要拆就拆开。
