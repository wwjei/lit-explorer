# AGENTS.md

lit explorer：Electron 写的本地项目文件浏览器（多栏目录导航 + 内嵌预览）。

未做的事分四个池子，别混：想做的功能与要拍板的决策在
[further_notes.md](further_notes.md)；小 bug 与顺手清理在 [PENDING.md](PENDING.md)
（**发版前必须清空**）；已知但无可行修法的依赖 / 安全问题在
[docs/security-debt.md](docs/security-debt.md)；已排期与明确不做的都在
[FEATURES.md](FEATURES.md)（第 8 节 / 第 2 节）。产品行为定义在
[FEATURES.md](FEATURES.md)，用法在 [README.md](README.md)。

## 按场景读

| 你的场景 | 读这个 |
| --- | --- |
| 增删依赖，或在 `dependencies` / `devDependencies` 之间挪包 | [docs/agents/dependencies.md](docs/agents/dependencies.md) |
| 改 `src/renderer/` 下的界面代码（含 pane / preview-body / find / projects / app 的分层）、动构建脚本或图标 | [docs/agents/build.md](docs/agents/build.md) |
| 加文件系统能力，改 preload / IPC / 自定义协议 | [docs/agents/security.md](docs/agents/security.md) |
| 改版本号、打 tag、发 Release | [docs/agents/release.md](docs/agents/release.md) |
| 跑测试、写界面探针、装包验证改动 | [docs/agents/verify.md](docs/agents/verify.md) |
| 改产品行为，写文档与注释 | [docs/agents/conventions.md](docs/agents/conventions.md) |
| 想做的功能、要拍板的事 | [further_notes.md](further_notes.md) |
| 顺手要清的小问题 | [PENDING.md](PENDING.md) |
| 已知的依赖 / 安全债，以及什么时候要重新看 | [docs/security-debt.md](docs/security-debt.md) |
| 想弄清某个设计为什么是这样（如高亮的阈值） | [docs/highlighting.md](docs/highlighting.md) 这类设计文档 |
| 看未实施功能的调研与方案 | [docs/design/](docs/design/) 下按主题分的文档 |
| 看历史审查记录（为什么有某些防御代码） | [docs/audits/](docs/audits/) 下按日期归档的记录 |
| 改 CI、发版流程、依赖更新策略 | [.github/workflows/](.github/workflows/) 与 [.github/dependabot.yml](.github/dependabot.yml) |

## 红线

1. 改依赖必须同步 `package-lock.json`，否则 CI 的 `npm ci` 会失败，而本地毫无异常。
2. `src/renderer/vendor/`、`build/icons/`、`build/notices/` 是生成物，不要手改、不要提交。
3. `dist` 脚本里的 `--publish never` 不能去掉，发布统一交给 CI。
4. 没有明确要求时不要打 tag；**打 tag 前 [PENDING.md](PENDING.md) 必须是空的**。
5. **新增一类信息（新文档、新测试、新待办池）要同步上面那张索引**——下一个会话是从
   这张表进门的，索引里没有的东西等于不存在。
6. 不要动用户正在运行的应用：跑起来验证一律用独立的 `--user-data-dir`（`npm run probe`
   已经默认这么做），也不要结束你自己没起的进程。
7. 加依赖之后要重跑 `npm run notices`（`predist` 里已经串上），否则随包分发的第三方
   许可声明会漏掉新引入的包。
8. **同一件事只放一个池子。** 功能进 further_notes，小问题进 PENDING，依赖债进
   security-debt，排期进 FEATURES 第 8 节——两边都写一遍，改了一边忘了另一边，
   下一个会话就会照着过期的那份做事。
