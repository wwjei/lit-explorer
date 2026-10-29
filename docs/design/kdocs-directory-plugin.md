# 金山云目录：内置 Skill 插件

## 当前方案

`kdocs-skill` 在 Lit 宿主内原生实现浏览器认证、目录列表、对象详情和在线链接四项读取能力。它参考官方公开授权脚本和当前 Skill / CLI 协议，不分发或运行 CLI，不下载组件、不调用子进程、不扫描 PATH，不读取浏览器 Cookie 或其他应用的凭据文件。

Electron 与 MyGo 各有一个独立插件模块，共用固定协议配置和目录清单。单篇文档仍可用普通网页快捷链接；插件只挂载文件夹 / 目录。

旧 `kdocs-personal` 适配的是开放平台 access_token 与应用 open_id；Skill 使用不同凭据与对象标识，因此旧挂载不自动转换或继续加载。

## 已核对的官方依据

- [官方 kdocs-skill](https://github.com/kdocs-app/kdocs-skill)，本次参考版本 `1c5bf75`，Skill / CLI 版本 2.7.1。
- [当前授权说明](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf75/references/auth.md)：官方登录生成 auth_code、打开引导页、轮询领取结果；用户取消后返回 409。当前仅支持 WPS 个人账号，企业受控账号应停止重试。
- [历史公开授权脚本](https://github.com/kdocs-app/kdocs-skill/blob/eb7aea0/get-token.sh)：生成 UUID，POST `https://api.wps.cn/office/v5/ai/skill_hub/wps_auth/exchange`，请求 `{code}`；202 等待、200 返回 token / expires_in，轮询间隔 1 秒、期限 5 分钟。
- [目录与详情参考](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf75/references/drive/read_and_download.md)：list_my_files、list_files、get_file_info 的参数与响应；[在线链接参考](https://github.com/kdocs-app/kdocs-skill/blob/1c5bf75/references/drive/share.md)：get_file_link。

当前公开仓库不包含完整 CLI Go 源码。额外下载并核验了官方 2.7.1 二进制，仅用于开发调研：将四个读取命令指向本机模拟服务，用虚构令牌核对其请求格式，不连接真实用户数据。请求为 POST `/skill_hub/api/v1/tool`，JSON `{tool,args}`，Bearer 身份与 X-Cli-Version。调研二进制不进入源码、安装包或运行时。

按这些协议独立实现，没有复制 / 分发 CLI 的内部实现。使用当前官方引导页而非直接拼接历史登录回调页；引导页由 WPS 生成实际登录地址。

## 用户体验

1. “添加云目录”选择金山，目录标识留空浏览“我的文档”，或输入目标文件夹 ID。
2. 点击连接：已有有效的 Lit 授权则直接复用；否则打开系统浏览器中的官方引导页，使用 WPS 个人账号确认。
3. 确认后 Lit 自动连接目录，无需用户创建应用、填写 App ID 或复制 token。
4. 浏览子目录并“将此目录加入快捷访问”；新快捷项独立保存，移除原入口不影响它。
5. 点击文档，用 get_file_link 解析实际在线地址。插件没有分享创建 / 修改、上传或删除能力。
6. 可选择重新登录 / 切换账号，或退出 Lit 的金山登录。退出只删除 Lit 自己保存的授权，不影响官方 CLI、浏览器或其他应用。

API 授权与在线网页自身登录仍各自管理。普通网页文件夹链接解析尚未开放；可通过“我的文档”浏览选择，不猜测网页路径中的对象身份。当前不支持 WPS 365 企业账号。

## 模块与桥接

| 入口 | 职责 |
| --- | --- |
| `src/shared/kdocs-skill.json` | 固定引导页、交换端点、工具端点和参考协议版本 |
| `src/main/kdocs-plugin.js` | Node 原生授权、到期 / 取消、四个读取操作、账号身份绑定 |
| `src/main/protected-credentials.js` | 宿主注入系统加密能力，写受保护的凭据文件 |
| `mygo/kdocs_plugin.go` | Go 同形协议、授权与读取操作 |
| `mygo/kdocs_protection_windows.go` | Windows 当前用户 DPAPI，无外部命令或新增库 |
| `src/main/directory-plugins.js` / `mygo/directory_plugins.go` | 节点 / 分页授权、目录验证、快捷项、缓存和项目切换 |

`kdocsAuthStart` 返回临时授权链接和状态，`kdocsAuthPoll` 轮询，`kdocsLogout` 删除本机授权；原始 token / 服务错误信息不经 IPC 返回。目录入口沿用 connect / list / details / open / pin。

工具端点只允许模块固定选择 list_my_files、list_files、get_file_info、get_file_link，页面不能提交任意工具名、URL 或请求体。发送 X-Cli-Version 仅用于参考协议版本兼容，客户端来源明确标记为 lit-explorer。

## 认证与保护

- 随机 UUID 仅用于本次授权，1 秒节流，5 分钟到期。重开、关闭表单、切项目会中断对应请求；原始授权结果不写日志。
- token 留在宿主；安全保存仅包含 token 与有效期，位于应用自己的 `credentials/kdocs.bin`。它不进入普通 state.json、项目布局或源码。
- Electron 使用 safeStorage；Linux 的 basic_text 不视为安全存储。MyGo Windows 使用 DPAPI，绑定当前 Windows 用户。没有另存可复制的本地解密密钥。
- 系统保护不可用时仅保留当前运行会话，界面提示不能保持登录，不降级到明文。无法更新已有安全凭据时返回存储错误。
- 切项目清空目录授权与在途请求，但保留本机账号凭据；下次连接仍验证目标目录。退出显式清除凭据。收到 Skill token 失效码 400006 / HTTP 401 后移除失效凭据并要求重新授权。
- 当前未发现并验证可用的 refresh_token 协议，不伪造自动续期。token 未过期可复用；到期通过官方页面重新确认。
- 每个连接绑定凭据指纹，旧连接不能悄悄换用新账号；旧请求失败也不能删除新账号刚保存的授权。

Skill 授权本身可能覆盖比某个文件夹更多的能力；Lit 限制读取操作和挂载已发现节点，不宣称 WPS token 被远端限定到单个文件夹。

## 请求与目录约束

- 所有请求仅访问配置中的 HTTPS 固定端点，不跟随重定向；单请求 15 秒，工具响应最多 2 MiB，交换响应最多 64 KiB。
- list_my_files 读取默认根；list_files 携带 parent_id、已发现的 drive_id，分页使用 page_token。只接受该目录此前返回的分页标记。
- 手工指定文件夹或添加子目录时先 get_file_info，验证 id 与目录类型，再读取列表，成功才保存。
- 详情归一化为名称 / 标识 / 类型 / drive_id / 修改时间；不将完整原始响应透传界面。在线地址只接受 HTTPS 和金山文档域名。
- 移除、切项目与旧响应检查继续由目录宿主管理；云链接不写固定列布局，网页隔离策略不变。

## 验证与实际资源

共享 `test/fixtures/kdocs-skill.json`，Node S12/S13 覆盖原生授权、节流、取消、过期、企业拒绝、账号切换、受保护持久化、读取白名单与失效清理。D3 覆盖浏览器跳转桩、目录分页 / 详情、子目录快捷项、切项目复用与界面退出。Go `TestKdocsNative*` 覆盖同一契约及取消边界；Windows 构建检查 DPAPI 绑定是否可编译。

尚未用真实 WPS 个人账号联调。官方当前 Go 实现未公开，直接工具协议可能变化，模拟结果不能替代平台实际验证；自动化测试也不证明真实 Windows 的安全存储和浏览器交互已经验收。

后续需要：一个可用于测试的 WPS 个人账号、包含多层文件夹的个人云文档、可访问 / 无权限文档。检查官方引导页确认、交换返回字段、目录与 drive_id、在线链接、token 到期 / 撤销、重启恢复与退出，并在 Windows Electron / MyGo 独立实例验收。无需提供 Cookie，也无需把 token 发到聊天。
