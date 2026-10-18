# AGENTS.md

lit explorer：Electron 写的本地项目文件浏览器（多栏目录导航 + 内嵌预览）。
人看的文档：[README.md](README.md) 是用法，[FEATURES.md](FEATURES.md) 是产品行为定义。

## 按场景读

| 你的场景 | 读这个 |
| --- | --- |
| 增删依赖，或在 `dependencies` / `devDependencies` 之间挪包 | [docs/agents/dependencies.md](docs/agents/dependencies.md) |
| 改 `src/renderer/` 下要打包的源码、动构建脚本或图标 | [docs/agents/build.md](docs/agents/build.md) |
| 加文件系统能力，改 preload / IPC / 自定义协议 | [docs/agents/security.md](docs/agents/security.md) |
| 改版本号、打 tag、发 Release | [docs/agents/release.md](docs/agents/release.md) |
| 验证改动（截图钩子、在 Windows 上装构建出的包） | [docs/agents/verify.md](docs/agents/verify.md) |
| 改产品行为，写文档与注释 | [docs/agents/conventions.md](docs/agents/conventions.md) |

## 红线

1. 改依赖必须同步 `package-lock.json`，否则 CI 的 `npm ci` 会失败，而本地毫无异常。
2. `src/renderer/vendor/` 与 `build/icons/` 是生成物，不要手改、不要提交。
3. `dist` 脚本里的 `--publish never` 不能去掉，发布统一交给 CI。
4. 没有明确要求时不要打 tag。
