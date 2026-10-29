# 外部目录插件体系

## 用户行为

本地参考目录与云目录按项目加入快捷访问。插件入口只挂载目录：飞书文件夹、指定 Wiki 节点子树，以及金山个人云文档文件夹。单篇文档通过现有网页快捷链接添加。

远程标识与本地文件路径分开。目录支持逐层浏览、分页、详情、刷新和将子目录单独加入快捷访问；目录里的文档点击后解析实际在线链接，交给现有网页预览。Wiki 节点可以同时有子项和实体文档，提供“打开当前文档”。

稳定的 providerId、挂载 id、根对象 id/type 和名称按项目保存。凭据留在本机宿主内存；切项目、重启或无法续期后需重连。解析出的在线链接不写导航 / 固定列布局，云预览只在当前会话保留。移除来源只关闭该来源预览，保留其他来源内容。

## 共享清单与契约

`src/shared/directory-providers.json` 是随应用构建并审查的 V1 声明式清单。Node `src/main/directory-plugins.js` 与 Go `mygo/directory_plugins.go` 实现同形宿主；`src/renderer/cloud-directories.js` 只处理标准化对象。页面不能注册域名、清单、请求模板或任意代码。

| 概念 | 字段与约束 |
| --- | --- |
| Catalog | apiVersion=1、providers |
| Provider | id、name、version、inputHint、apiOrigin、documentHosts、root、list、details?、documentLink?、initialize?、success、authCodes?、errorCodes?、authentication? |
| Root | kind 固定为 directory、defaultType、urlTypes；可选 defaultId / omitDefaultId 定义服务默认根 |
| Mount | id、providerId、rootId、rootType?、name；connected 为运行时信息 |
| Node | id、name、type、kind、url?、modifiedAt?、scopeId?、documentId?、documentType?、hasChildren? |
| Page | directory、entries、nextCursor |

节点 kind 仍区分目录和文档。id 为不含分隔符、空白和查询字符的稳定远程标识；不交给 fs IPC。scopeId 是服务命名空间，例如 Wiki space_id。documentId/type 用于目录节点自身关联的实体文档；hasChildren=false 的 Wiki 叶子直接作为文档打开。

移除单文档 provider 后，旧单文档挂载不再加载；没有原始租户网页链接时不自动猜测转换地址。

## 请求模板与归一化

list / details / initialize 声明 method（GET/POST）、固定相对 path、query/body 模板、entries 和 fields 映射；initialize 额外用 node 指定单个对象路径。以 `=` 开头的 fields 值是固定字面值。modifiedAt 接受文本或数值时间戳，其余对象身份不做隐式类型转换。

变量为 nodeId、nodeType、scopeId、documentId、documentType、cursor，以及默认根的 parentId、复合分页的 offset/filter。query/body 的 `$变量` 会替换值，路径标识编码；认证令牌不作为模板变量暴露。

- 默认认证为 Bearer；authentication.type=query / parameter=access_token 允许按服务官方要求由宿主注入令牌。
- success.field/value 定义业务成功标志；authCodes 断开无效凭据，errorCodes 映射稳定业务错误。原始响应错误信息不返回页面。
- 普通 list 使用 cursor / hasMore；offset-filter 分页将服务返回的两个字段封装成一个 cursor。宿主只接受该目录已发出的分页标记。
- details 查询最新文档元数据；没有 details 时使用列表元数据。documentLink 可单独声明实际链接查询（url/name 响应路径），用于金山的已有分享接口。
- 文档域名与 API origin 分开，打开前验证 HTTPS、主机、端口、控制字符与账号密码。

桥接 `directoryCall` 仅分派 providers / mounts / connect / list / details / open / pin / remove / cancel / authStart / authPoll，不暴露任意 HTTP 或原始令牌。pin 只能将已发现的目录加入快捷访问，重复来源复用已有项；连接验证及项目序号检查继续生效。

## 飞书内置插件

| providerId | 含义 | 输入 |
| --- | --- | --- |
| feishu-drive | 文件夹及其子树 | `https://tenant.feishu.cn/drive/folder/<folder_token>` 或 token |
| feishu-wiki | 指定 Wiki 节点及其子树 | `https://tenant.feishu.cn/wiki/<node_token>` 或 token |

接口映射：

1. GET `/open-apis/drive/v1/files`：folder_token / page_token / page_size，返回 data.files / has_more / next_page_token。
2. POST `/open-apis/drive/v1/metas/batch_query`：request_docs 和 with_url，读取 data.metas 的实际 URL。
3. GET `/open-apis/wiki/v2/spaces/get_node`：解析 node_token、space_id、obj_token、obj_type。
4. GET `/open-apis/wiki/v2/spaces/<space_id>/nodes`：parent_node_token 与分页，返回 data.items。

Wiki 导航使用 node_token，打开时用 obj_token/type 查询实际文档链接，不猜测租户域名。普通文件夹详情来自列表，Wiki 详情可刷新节点。

官方依据：[云空间列表](https://open.feishu.cn/document/server-docs/docs/drive-v1/file/list)、[元数据](https://open.feishu.cn/document/server-docs/docs/drive-v1/meta/batch_query)、[Wiki 节点](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space/get_node)、[Wiki 子项](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/list)、[Drive SDK](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/drive/v1/resource.go)、[Wiki SDK](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/wiki/v2/resource.go)。

支持手动 user_access_token / tenant_access_token，另有浏览器设备授权实验版，由本机宿主交换与刷新。应用还需相应读取权限和对象可访问范围，tenant token 不自动继承用户权限；实验授权的适用资格及真实租户配置待验证，见 [飞书客户端授权](feishu-client-authorization.md)。

## 金山内置插件

`kdocs-personal` 使用个人文档官方列表与已有分享接口，支持默认“我的文档”、双字段分页和子文件夹独立快捷项。鉴权为手动 access_token，所需权限 access_personal_files；不复用飞书登录，不把 WPS 365 企业接口或应用空间混入个人文档。

普通网页目录链接不能替代应用相关 ID，可先从“我的文档”浏览目标目录。没有分享链接时提示用户，不自动扩大分享权限。接口证据、差异、鉴权边界与真实测试准备见 [金山插件设计](kdocs-directory-plugin.md)。

## 其他插件接入

1. 核对官方认证、文件夹标识、层级列表、分页、详情 / 实际链接与错误码，保存脱敏响应夹具。
2. 若符合静态 HTTPS JSON、GET/POST、Bearer / 查询参数 token 和现有分页能力，在共享清单加入目录 provider；无需添加单文档入口。
3. 映射 URL 前缀、默认根、可选初始化、scopeId、对象字段和文档链接；缺乏官方链接时不拼接猜测页面地址。
4. 请求签名、不同的交互授权或其他分页形式需先扩展两端宿主；清单中不放可执行表达式，不分发共享应用密钥。
5. 两端运行同一组夹具，覆盖分页、重名、权限、限流、令牌隔离、错误域名、未知节点、删除及项目切换；界面走公共桥接测试。
6. 真实账户联调后确认权限与服务可用性，检查网页登录和无法内嵌时的系统浏览器退路。自动测试通过不代表第三方平台已接受该应用配置。

## 权限、缓存与验证

API 请求固定 origin，不跟随重定向；响应 JSON 2 MiB、超时 15 秒、连接最多 4 并发、每页 200 节点、会话最多发现 10000 节点。目录缓存 60 秒 / 128 页，刷新绕过缓存。没有自动限流重试。

移除、切项目中断对应请求；关闭连接表单取消验证。旧响应不能覆盖新项目或目录。云插件不增加本地路径权限，不提供云端上传、删除或分享修改能力。在线网页不能取得本地 pv 桥接，API 身份与网页登录身份分别管理。

Node S9/S10、Go 飞书契约测试及界面 D1 覆盖飞书目录 / Wiki；S11/D2 与 Go 授权用例覆盖实验设备授权；S12/D3 和 `TestDirectoryPluginKdocsFolders` 使用共享金山夹具覆盖默认根、分页、文件夹快捷项和已有分享链接。

后续工作：真实服务联调、系统凭据库和跨重启账号复用、其他服务适配、来源改名、目录浏览位置恢复，以及更完整的目录详情。当前没有任意第三方可执行插件安装运行能力。
