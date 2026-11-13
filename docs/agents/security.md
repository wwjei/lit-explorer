# 安全边界

产品只有 Go 原生宿主（`mygo/`），渲染页面通过 `bridge.js` 的白名单 `pv` 调用系统能力。
`test/host/` 是测试适配器，不是另一个产品实现或权限依据。

- `fsapi.go` 对真实路径做工作区/参考根授权；Windows 忽略大小写，macOS / Unix 保留大小写；参考根只读，工作区才可保存 SVG。
- 页面不能自行扩展 offered 根、修改挂载或提供任意 API 域名、命令、请求模板。
- `statefile.go` 只接受白名单设置；恢复项目先收敛结构，页面新增项目还须已获宿主提供。
- SVG 保存仅覆盖已有 UTF-8 `.svg`，检查大小和 size/mtime 基线、同目录临时文件原子替换。
- Markdown、SVG、Office 输出清洗危险协议、脚本、事件、外来可执行 DOM；SVG 清洗后有风险则只读。
- 本地 HTML 资源走随机令牌的 127.0.0.1 服务，每个请求仍检查路径；不监听公网、不持久化令牌。
- 系统文件与 URL 打开走 Shell API，不拼 shell 命令。
- 远程子 WebView 不注入本地 pv 桥接，地址仅允许安全 http(s)，站点权限采用 WebView2 策略。
- 弹层和拖动各自持有网页遮挡租约，不能解除别人的遮挡。
- 云目录只访问内置固定 API 域名，拒绝重定向，限制体积、并发、超时、节点与分页；旧项目请求取消。
- 金山凭据在 Windows 用 DPAPI 保护；macOS 用登录钥匙串保存独立 profile 的随机 AES-GCM 密钥、授权文件只存密文，保护不可用时只保留内存；不降级明文，不返回渲染器。
- 飞书凭据只在当前会话，设备授权资格仍需真实租户验证。
- 数据迁移只取已知普通设置文件与兼容密文，拒绝链接，原子提交，不覆盖新目录；不导入旧 Electron 密文。
- 安装/卸载仅影响当前用户与目标安装目录，请求关闭目标产品进程，不强杀其他程序；卸载保留用户数据。

云目录细节见 [插件契约](../design/external-directory-plugins.md)、
[飞书授权](../design/feishu-client-authorization.md)、[金山模块](../design/kdocs-directory-plugin.md)。
