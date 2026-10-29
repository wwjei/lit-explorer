# 飞书客户端授权：设备流程实验版

## 结论与证据

Lit 可以实现“不部署 Lit 授权服务，凭据留在用户客户端”的设备授权原型。实现已接入 Electron / MyGo 和云文档快捷项，但尚未使用真实飞书租户验证，不应视为正式上线的登录能力。

核对依据是飞书官方 [larksuite/cli](https://github.com/larksuite/cli)，本次核对版本为 `782a5a4db906ed4914223838cc98b129c60b0dab`：

- [个人应用注册](https://github.com/larksuite/cli/blob/782a5a4db906ed4914223838cc98b129c60b0dab/internal/auth/app_registration.go)：`PersonalAgent` 注册、浏览器确认、轮询返回每个应用独立的 client_id / client_secret。
- [设备授权](https://github.com/larksuite/cli/blob/782a5a4db906ed4914223838cc98b129c60b0dab/internal/auth/device_flow.go)：Basic 认证发起设备授权，客户端轮询领取令牌。
- [认证域名](https://github.com/larksuite/cli/blob/782a5a4db906ed4914223838cc98b129c60b0dab/internal/core/types.go)：中国区 Accounts 为 `https://accounts.feishu.cn`，统一令牌端点为 `/oauth/v3/token`。
- [刷新令牌的条件](https://github.com/larksuite/cli/blob/782a5a4db906ed4914223838cc98b129c60b0dab/internal/auth/no_refresh_token.go)：请求 offline_access 并不保证收到 refresh_token，应用需开启刷新能力并发布生效。

这里采用协议重新实现，无 CLI 进程依赖。没有把官方 CLI 的产品专属资格推断为所有桌面产品均受支持；PersonalAgent 的产品适用范围、租户策略和普通测试应用的 Device Flow 可用性是实测门槛。若平台不支持，不回退到 Cookie 或私有目录接口。

## 为什么选这个方案

| 方案 | 凭据可留客户端 | Lit 适用性 |
| --- | --- | --- |
| H5 requestAccess / requestAuthCode | 返回临时 code，仍需交换 token | 依赖飞书容器环境，不能直接当独立 WebView 登录 |
| 普通网页授权码 + 产品共享 App Secret | 客户端可以持有最终 token | 共享密钥不应内置分发；通常需要可信交换端 |
| 无密钥公共客户端 + PKCE | 理论上适合 | 本次未确认飞书向普通桌面产品提供这种能力，不据此编码 |
| Device Flow + 用户独立应用 | 是，含交换与刷新 | 官方 CLI 有实际实现；Lit 已做实验版本，待真实平台验证 |
| 浏览器 Cookie + 非公开列表接口 | 是 | 会话权限大、接口及风控变化风险高，不作为本版方案 |

“前端持有授权”在此指用户的客户端持有凭据：本机 Electron 主进程 / Go 宿主负责交换、保存和使用；共享 HTML 界面只收到状态和确认链接。无需 Lit 云服务，也不要求用户配置 HTTP 回调地址。此流程仍然依赖飞书官方在线认证服务。

## 两条入口

### 浏览器创建个人应用（实验）

1. 在快捷访问添加飞书来源，填写文件夹或 Wiki 节点链接。
2. 选择“浏览器创建个人应用并授权”。宿主向 `/oauth/v1/app/registration` 发起 `action=begin`，声明 `archetype=PersonalAgent`、`auth_method=client_secret`。
3. 系统浏览器打开 `https://open.feishu.cn/page/cli?user_code=...`。界面同时显示确认码，用户核对并确认创建应用。
4. 宿主按 interval 轮询 `action=poll`，取得本机应用凭据，不返回渲染进程。
5. 以 Basic(client_id:client_secret) 请求 `/oauth/v1/device_authorization`，固定只读云文档 / 元数据 / Wiki 权限及 offline_access。
6. 再次打开官方确认页；用户确认权限后，宿主向 `/oauth/v3/token` 轮询 `grant_type=urn:ietf:params:oauth:grant-type:device_code`。
7. 授权结果以一次性 authId 交给挂载，验证指定对象可读后保存来源配置。授权成功但对象无权限时不保存无效来源。

首次可能需要两次浏览器确认。注册产生的应用由用户在飞书管理；取消本地流程或移除快捷项不会自动删除已经创建的飞书应用。实验版不保存应用密钥，下次连接重新注册可能产生额外应用，正式发布前应先补系统凭据库与账号复用。

### 使用自己的飞书应用（实验）

填写用户自己的 App ID / App Secret，从上面的第 5 步开始。密钥提交后立即清空输入框，只留在宿主会话内存。不打包或分发 Lit 公共 App Secret，也不承诺普通测试应用一定支持 Device Flow；平台拒绝时显示授权失败。

手动访问令牌入口仍保留，用于隔离目录 API 的权限问题和设备授权能力问题。

## 权限与生命周期

固定权限见 `src/shared/feishu-auth.json`：`drive:drive:readonly`、`drive:drive.metadata:readonly`、`wiki:wiki:readonly`、`offline_access`。需实测确认这些权限在目标应用 / 租户是否可用，平台可能裁剪授权范围；最终目录请求仍会检验对象可读性。只读授权范围可能覆盖用户更多文档，选择一个挂载根不会把飞书 token 限制到该根；宿主继续限制只能访问该挂载的已发现节点。

- access token 接近过期时刷新；并发请求合并刷新，使用服务返回的轮换令牌。没有 refresh token 时在当前 access token 有效期内工作，到期重新授权。
- 本版只接受 Bearer，收到 DPoP 令牌明确报不支持，避免缺少私钥时错误使用令牌。正式版可另行评估 DPoP 和系统私钥存储。
- App Secret、access token、refresh token、device_code 不写设置、布局或日志，不通过 IPC 返回；待确认流程只返回授权链接、用户确认码、状态和有效期。
- 关闭表单取消 begin / poll / 目录验证；切项目中断请求并丢弃待授权和挂载凭据。移除来源关闭该来源的预览。退出或切项目后不保留账号。
- 本地断开只删除本机连接，不等于撤销飞书授权。用户可通过飞书侧管理应用及权限。
- 授权地址仅允许中国区 `accounts.feishu.cn` / `open.feishu.cn` 的 HTTPS 链接，认证请求固定 origin，不跟随重定向。响应体 64 KiB、单请求 15 秒，轮询遵守 interval / slow_down 和设备码到期时间。
- 当前只支持飞书中国区；注册响应提示 Lark 地区时终止，不动态跟随服务返回的地区或域名。

## 代码入口

- Electron：`src/main/feishu-auth.js`，设备流程与内存凭据；`directory-plugins.js` 连接挂载并在请求前取有效 token。
- MyGo：`mygo/feishu_auth.go`，同一共享配置和状态机；`directory_plugins.go` 接业务桥接。
- 界面：`src/renderer/cloud-directories.js`，授权方式、确认码、系统浏览器、取消和连接状态。
- 桥接方法：`authStart`、`authPoll`、现有 `cancel`、带一次性 authId 的 `connect`。不提供获取原始 token、任意请求或任意认证端点的方法。

## 自动验证与真实测试准备

自动测试使用 `test/fixtures/feishu-auth.json`，没有调用真实注册接口或创建远程应用。

- S11：注册 → 设备授权、轮询节流 / slow_down、拒绝 / 过期、取消、单次消费、刷新合并、URL 域名和 DPoP 拒绝。
- D2：真实界面经过两次浏览器跳转桩，授权后连接文件夹并打开其中的文档、秘密不入界面 / 设置、关闭表单取消。
- MyGo：`TestFeishuDeviceRegistrationAndRefresh` / `TestFeishuDeviceDenialExpiryAndCancel`；对应 JSON 夹具和并发刷新。

后续实测准备：

1. 一个允许测试的飞书中国区账号 / 租户，可在系统浏览器登录。无需提供浏览器 Cookie 或把 token 发到聊天。
2. 一个测试文件夹、一个普通文档、一个有子节点的 Wiki 节点；另备不可访问对象，检查权限拒绝。
3. 优先测试个人应用入口，核实注册页面、创建权限、两次确认、目录权限是否实际生效。若应用创建受限，记录平台错误，使用自有测试应用入口隔离验证。
4. 测试自有应用时在 Lit 本机界面填写 App ID / Secret，确认是否开放设备授权，启用读取权限与刷新能力并发布生效。该步骤不要求配置 Lit 回调 URL。
5. 真实测试过期刷新、拒绝、关闭、切项目、重启、应用撤权；同时核对账户身份、网页身份和目录内容是否符合预期。分别用独立 Electron / MyGo 测试实例，检查 Windows 浏览器唤起及返回应用的体验。

正式发布门槛：真实租户确认此授权用途受到支持、整理失败提示和应用管理指引、接入系统凭据库及账号复用，再决定是否把实验入口作为默认产品登录。服务可用性与资格未确认前，不能用模拟测试通过来宣称真实飞书登录已完成。
