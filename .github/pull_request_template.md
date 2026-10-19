## 改了什么

<!-- 一句话说清。一个 PR 只做一件事，需要拆就拆。 -->

## 怎么验证的

<!-- 跑了哪些测试；改了预览或界面的话，说清看了什么（截图更好）。 -->

- [ ] `npm test` 通过
- [ ] 动了依赖的话，`npm ci --dry-run` 通过（`package-lock.json` 已同步）
- [ ] 没有提交 `src/renderer/vendor/`、`build/icons/` 这类生成产物
- [ ] 相关文档已顺手更新（`docs/agents/` / `FEATURES.md` / `README.md`）
- [ ] 改了安全相关的代码的话，`docs/agents/security.md` 与回归测试一起改了
