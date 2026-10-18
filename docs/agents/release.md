# 发版

```bash
npm version <新版本> --no-git-tag-version   # 同时更新 package.json 与 package-lock.json
git add -A && git commit
git push origin main
git tag -a v<新版本> -m "lit explorer v<新版本>"
git push origin refs/tags/v<新版本>          # 推送 tag 即触发 CI
```

只有 `v*` 开头的 tag 会触发 `.github/workflows/release.yml`（`windows-latest` 上
`npm ci` → `npm run dist` → `softprops/action-gh-release` 发布 Release）；tag 名里带连字符
（`-alpha` / `-beta`）会被自动标记为预发布。**没有明确要求时不要打 tag**，推 `main`
不会触发任何构建。

## 不要让 electron-builder 自己发布

`dist` 脚本里的 `--publish never` 不能去掉：在 tag 上构建时 electron-builder 会尝试
「隐式发布」，并因缺少 `GH_TOKEN` 报错退出——包其实已经构建成功，失败只发生在最后一步。
发布统一交给 workflow 里的 action-gh-release。
