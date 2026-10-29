# 金山云文档文件夹插件

## 范围

内置 `kdocs-personal` 接入金山个人云文档的官方开放接口，支持“我的文档”或指定文件夹、逐层浏览、分页、列表详情、将已发现的子文件夹单独加入快捷访问，以及打开目录中文档的已有分享链接。

此处的“金山云文档”是 kdocs.cn 个人文档体系；不把 WPS 365 企业盘、应用空间或金山云对象存储视为同一套接口。没有使用 Cookie 或网页私有列表接口。

插件只挂载目录。飞书与金山的单文档都可以直接通过原有网页快捷链接添加，不需要单文档 provider。原有飞书单文档 provider 配置不再加载；由于配置没有保存原始租户网页链接，不自动猜测或转换为网页条目。

## 已核对的官方契约

- [目录列表](https://developer.kdocs.cn/server/personal/files.html)：`GET https://developer.kdocs.cn/api/v1/openapi/personal/files`，权限 `access_personal_files`，查询参数包含 access_token、parent_id、count、offset、filter。
- [对象标识说明](https://developer.kdocs.cn/server/guide/question.html)：列表返回的 id.open_id / id.union_id 可作为文件标识；open_id 随应用变化，不能把普通网页数字 ID 或分享 ID 当作它。
- [获取已有分享](https://developer.kdocs.cn/server/personal/get-links.html)：`GET /api/v1/openapi/personal/files/:file_token/links`，使用同一访问权限，返回 data.link_url 和 data.filename。
- [权限](https://developer.kdocs.cn/server/guide/permission.html)、[错误码](https://developer.kdocs.cn/server/guide/error.html)：成功 code=0；20007/20008 表示访问令牌无效或过期；20009 为权限不匹配，30002 限流，30012 对象不存在，30014 分享不存在。
- [签名说明](https://developer.kdocs.cn/server/guide/signature.html)：WPS-2 签名针对应用文档接口，本插件接入的个人文档接口按官方要求携带 access_token。

没有真实金山账号或应用资源参与本次验证，当前核对的是公开接口文档与本地契约测试；真实应用的审核、权限范围、目录可访问性、分享与页面嵌入仍需联调。

## 用户流程

1. 在“添加云目录”选择“金山云文档文件夹”，输入本人的访问令牌。
2. 目录标识留空进入“我的文档”，也可以输入同一应用的文件夹 open_id / union_id。
3. 浏览到目标子文件夹，点击“将此目录加入快捷访问”。新快捷项的根就是这个文件夹；重复添加会复用原项，移除“我的文档”不影响已添加的文件夹。
4. 点击目录中的文档，查询已有分享链接后交给现有网页预览。若分享不存在，提示用户检查金山分享设置，不自动创建或修改分享，也不拼接未经验证的页面 URL。
5. 单篇文档的固定入口使用原有网页快捷链接。

普通网页文件夹链接目前不能直接导入：官方对象 ID 与网页路径不等价。通过“我的文档”浏览选取，可以在不额外读取浏览器会话的前提下取得正确的应用标识。

## 两端宿主与共享清单

共享 `src/shared/directory-providers.json` 注册该插件，Electron 和 MyGo 使用同一份清单。宿主扩展均为声明式能力，页面不能改变域名或请求模板：

| 能力 | 清单定义 | 行为 |
| --- | --- | --- |
| 查询参数认证 | authentication.type=query / parameter=access_token | 宿主注入令牌；不返回带令牌的请求 URL，不重复发送 Bearer |
| 默认文档根 | root.defaultId / omitDefaultId | 内部用 @my-documents 标识根，请求时省略 parent_id |
| 复合分页 | list.pagination.type=offset-filter | 将 next_offset 与 next_filter 编码成一个受控 cursor，后续完整回传 |
| 文档链接 | documentLink | 独立 GET 已有分享，URL 再做 HTTPS / 文档域名校验 |
| 错误映射 | errorCodes | 平台业务码转换为权限、限流、对象不存在、无分享等稳定错误 |

offset=0 仍可能是有效的下一页，特别是从文件夹阶段转入文件阶段；只有 -1 表示结束。宿主校验 offset 为安全整数，并只接受该目录已经返回的复合 cursor，页面不能伪造分页范围。

目录和文件的“详情”使用当前已发现的列表元数据，包含名称、标识、类型与修改时间；刷新目录可更新它们。本版没有依赖官方简易信息页中 `/simple` 与示例 `/simple/info` 不一致的路径。

`pin(mountId,nodeId)` 只能接受来源会话已发现的目录，新挂载先验证列表再保存，数量上限和项目切换序号检查继续生效。共享的是宿主内存凭据，页面拿不到原始 token。

## 鉴权边界

本版接受用户已经取得的金山 access_token，所需权限为 access_personal_files。凭据只在本机宿主内存保留，切项目、重启或过期需重连；源配置仅保存稳定对象标识和名称。

[官方 Web 授权](https://developer.kdocs.cn/common/authorization/web.html)要求预先注册应用、配置回调、用 app_key 交换 code；文档要求敏感交换在服务端完成。本次未确认金山对独立桌面应用开放无共享密钥的 PKCE / Device Flow，因此不复用飞书认证流程，不分发公共 app_key，也不把手动 token 入口标成自动登录。可在拿到应用资源后进一步验证用户自有应用、本机授权的官方适用范围。

金山要求令牌放在 API 查询串中；只有宿主向固定 HTTPS origin 构造该请求，不向渲染层返回、不写日志、不持久化，且不跟随重定向。用户打开的文档 URL 来自分享接口，不使用 API 请求 URL。网页里的登录身份与 API 令牌身份仍各自管理。

## 验证与后续实测

共享夹具 `test/fixtures/kdocs-directory.json` 用于 Node S12、Go `TestDirectoryPluginKdocsFolders`；界面用例 D3 覆盖默认根、仅显示适用鉴权、分页、子目录独立快捷项、移除原入口后继续访问、详情与网页预览。现有飞书用例覆盖移除单文档 provider 后的目录功能与设备授权。

真实测试需要用户自己的金山开放平台应用及 access_personal_files 授权令牌，一个有多级子文件夹的个人目录、已有分享的文档、未分享文档和无权限对象。验证从文件夹切换到文件阶段的分页、token 过期、链接失效、分享权限及浏览器退路。资源准备好后在本机界面输入凭据即可，无需把令牌或 Cookie 发到聊天。
