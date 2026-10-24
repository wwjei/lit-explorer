# 发版

## 发版前检查清单

按顺序过一遍，前两步没过就别往下走：

1. **清空 [PENDING.md](../../PENDING.md)。** 那里是「稍晚一点处理」的小问题池，
   发版前它必须是空的。清不掉的逐条写明为什么可以带着发，并挪到该去的地方
   （要拍板的进 [further_notes.md](../../further_notes.md)，等上游的进
   [docs/security-debt.md](../security-debt.md)）。
2. **本地跑一次 `npm test`。** CI 也会跑，但等一轮要一分多钟，本地先跑更快。
   全绿不等于可以发版（界面观感没进断言），改了预览的话自己看一眼。
3. 看一眼 [docs/security-debt.md](../security-debt.md)：里面的复查触发条件有没有被
   这次改动碰到。
4. 按下面的流程发。

## 流程

```bash
npm version <新版本> --no-git-tag-version   # 同时更新 package.json 与 package-lock.json
git add -A && git commit
git push origin main                        # 推 main 只跑测试（ci.yml），不构建
git tag -a v<新版本> -m "lit explorer v<新版本>"
git push origin refs/tags/v<新版本>          # 推 tag 才触发 release.yml
```

只有 `v*` 开头的 tag 会触发 [.github/workflows/release.yml](../../.github/workflows/release.yml)：
先跑 [ci.yml](../../.github/workflows/ci.yml) 那套测试（单元 + 集成），**过了才**在
`windows-latest` 上 `npm ci` → `npm run dist` → 生成校验和 → `softprops/action-gh-release`
发布 Release。测试挂了就不会产出安装包，也不会建 Release。

tag 名里带连字符（`-alpha` / `-beta`）会被自动标记为预发布。**没有明确要求时不要打 tag。**

发布出来的产物：

| 文件 | 说明 |
| --- | --- |
| `Lit-Explorer-Setup-<版本>.exe` | NSIS 安装包，可选安装目录 |
| `Lit-Explorer-<版本>-portable.exe` | 免安装版 |
| `Lit-Explorer-Setup-<版本>.exe.blockmap` | electron-builder 生成的差分块图 |
| `SHA256SUMS.txt` | 上面两个 exe 的校验和 |

## 校验和不能省

没有代码签名，`SHA256SUMS.txt` 是用户唯一能自己核对「下载到的就是 CI 构建出来的那一份」
的手段，Release 说明里也据此给出了 `sha256sum -c` 的用法。由
`scripts/build-checksums.mjs` 生成，只收录**当前版本号**的 exe——本地 `dist/` 里往往还
堆着以前几次打包的产物，不按版本号过滤会把不相干的旧包也列进去。

## 不要让 electron-builder 自己发布

`dist` 脚本里的 `--publish never` 不能去掉：在 tag 上构建时 electron-builder 会尝试
「隐式发布」，并因缺少 `GH_TOKEN` 报错退出——包其实已经构建成功，失败只发生在最后一步。
发布统一交给 workflow 里的 action-gh-release。

## Release 正文

`softprops/action-gh-release@v3` 里装文字的是 `body`（或 `body_path`），不是
`append_body`——后者是布尔开关，表示「追加到已有 Release 正文」。开启
`generate_release_notes` 时，`body` 会**前置**在自动生成的说明之前，所以不需要为了保留
自动说明而改用它；把多行说明写到 `append_body` 上会让正文丢失。

## 签名与自动更新

都还没做，原因和选项记在 [further_notes.md](../../further_notes.md) 的 N4 / N5。
**签名之前不要接自动更新**：给未签名的包做自动更新，等于每次更新都让用户再吃一遍
SmartScreen 警告。
