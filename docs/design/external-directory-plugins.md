# 外部目录插件体系与服务接入

状态：V1 已实现，内置飞书适配清单；实际账号权限与网页登录仍需服务账号联调。金山等服务尚未实现具体适配。本文定义当前契约和其他插件的接入步骤。

## 挂载模型与操作流程

插件描述一个服务入口的 API 和数据映射；挂载是用户将某个具体对象加入某个项目的快捷访问。远程对象的标识与本地文件路径始终分开。用户在快速访问中选择“添加云文档或 Wiki 目录”，选入口类型、填写对象链接并选择浏览器设备授权（实验）或手动访问令牌。

挂载分成两种：

- **document**：某个具体文档。点击快捷项后重新解析访问链接，直接在网页预览中打开。
- **directory**：某个文件夹或 Wiki 节点。点击后打开目录浏览界面，支持逐层进入、分页、刷新和详情。Wiki 节点可以同时有子节点和关联文档，通过“打开当前文档”或子项的“打开文档”按钮访问。

项目持久化 providerId、挂载 id、根对象 id、根对象类型和展示名。访问令牌只在宿主进程内存中保存，切换项目、重启、令牌失效或移除来源后需要重新连接。解析出来的在线 URL 不写进项目导航或固定列布局，避免短期签名链接落盘；云文档固定预览仅在本次会话保留。网页登录账号和 API 访问令牌分别管理。

本地参考目录继续由原生选择框授权；当前的本地实现保持文件路径和真实路径边界。云目录插件没有文件系统访问接口，不把 node id 交给 fs IPC。

## 共享插件清单与宿主

插件清单位于 `src/shared/directory-providers.json`，两个 shell 使用同一份配置。Electron 的宿主在 `src/main/directory-plugins.js`，MyGo 的宿主在 `mygo/directory_plugins.go`，前端 `src/renderer/cloud-directories.js` 只处理标准化对象。

V1 为随应用构建的声明式插件：静态审查清单后注册，不支持页面注入清单、任意脚本执行或直接下载执行第三方包。新增一个符合 V1 能力的服务只需添加清单和契约夹具，无须改导航界面。使用请求签名、OAuth 或其他认证方式的服务需要扩展两端宿主并升级契约，不能在清单中塞可执行表达式。

| 概念 | 字段 | 约束 |
| --- | --- | --- |
| Catalog | apiVersion、providers | 当前 apiVersion 为 1；变更主版本需显式支持 |
| Provider | id、name、version、inputHint、apiOrigin、documentHosts、root、list、details、initialize?、success、authCodes | id 稳定；API origin 与文档域名分开声明 |
| Root | kind、defaultType、urlTypes | kind 为 document / directory；URL 前缀映射到根对象类型，也可直接输入对象标识 |
| Mount | id、providerId、rootId、rootType?、name | 按项目隔离；连接状态是运行时信息 |
| Node | id、name、type、kind、url?、modifiedAt?、scopeId?、documentId?、documentType? | id 为不含路径分隔符、空白和查询字符的稳定远程标识；与本地路径无关 |
| Page | directory、entries、nextCursor | 宿主标准化后返回，界面不认识服务原始字段 |

`scopeId` 是服务的目录命名空间，例如飞书 Wiki 的 space_id；它由接口响应产生，页面不能自行替换。`hasChildren` 是可选的布尔字段，Wiki 叶子节点会作为可直接点击打开的文档展示。`documentId/documentType` 表示目录节点背后的实体文档，使“目录”和“可打开文档”可以同时成立。

## 操作模板

每个 list / details 操作包含：

- `method`：GET 或 POST；`path`：固定相对路径，可使用已编码的标识变量；`query` 和 `body`：查询 / JSON 模板。
- `entries`：响应数组的点分字段路径；`fields`：标准字段到服务字段路径的映射。以 `=` 开头的字段是固定字面值，如 `"type": "=wiki"`。
- list 额外声明 `cursor`、`hasMore` 字段路径。
- 可选 initialize 用于解析根对象，使用 `node` 指定响应中的单个节点对象路径；Wiki 通过它获得知识空间和实体文档身份。
- `success.field/value` 描述业务成功标志，允许不同服务使用不同响应外层结构；`authCodes` 列出凭据失效的数值业务码，HTTP 401 / 403 / 404 / 429 也会被归一化。

可用变量仅为 `$nodeId`、`$nodeType`、`$scopeId`、`$documentId`、`$documentType` 和 `$cursor`。query/body 中整段以 `$` 开头的字符串会被替换；path 中的标识单独编码。文档标识缺省取当前节点 id/type。分页标记只能使用该目录已返回的标记，不能通过传入别的 cursor 扩大范围。

当前 details 支持对文档查询最新元数据和 URL；普通文件夹详情来自列表元数据，Wiki 目录详情通过 initialize 节点接口刷新。某服务若需独立文件夹详情接口，应增加明确的目录详情操作并同时扩展两个宿主，不伪造服务接口。

桥接只暴露 `directoryCall(method, args)`，method 限于 providers / mounts / connect / list / details / open / remove / cancel；没有“发送任意 HTTP 请求”。同一个 Node 宿主分派函数用于 Electron IPC 与测试，MyGo 实现相同的数据约定。

## 飞书内置推演

四个入口共享认证、请求调度和元数据映射，由清单组合出不同挂载语义，避免在界面或宿主中按飞书 id 分支。

| providerId | 快捷项含义 | 输入示例 |
| --- | --- | --- |
| feishu-drive | 指定文件夹目录 | `https://tenant.feishu.cn/drive/folder/<folder_token>` |
| feishu-document | 指定普通云文档 | `https://tenant.feishu.cn/docx/<token>`，也支持 docs / sheets / base / mindnotes / slides / file 前缀 |
| feishu-wiki | 指定 Wiki 节点及其子树 | `https://tenant.feishu.cn/wiki/<node_token>` |
| feishu-wiki-document | 指定 Wiki 节点自己的文档 | 同上，点击快捷项直接打开实体文档 |

实现核对了飞书官方 Go SDK 的字段和路径：

1. `GET /open-apis/drive/v1/files`：folder_token、page_token、page_size；返回 data.files、data.has_more、data.next_page_token。
2. `POST /open-apis/drive/v1/metas/batch_query`：request_docs 中传 doc_token/doc_type，with_url 为 true；返回 data.metas 中的实际文档 URL。
3. `GET /open-apis/wiki/v2/spaces/get_node`：输入 Wiki token，得到 node_token、space_id、obj_token、obj_type 和标题。
4. `GET /open-apis/wiki/v2/spaces/<space_id>/nodes`：以 parent_node_token 浏览指定节点的子项，返回 data.items、data.has_more、data.page_token。

Wiki 的 node_token 与 obj_token 不同：导航用前者，打开文档时用后者查询真实元数据链接。当前打开的是元数据接口返回的实体文档 URL，不猜测租户域名或自行拼接页面地址。Wiki 内的浏览路径保留在来源目录视图中。

参考：

- [云空间目录列表官方文档](https://open.feishu.cn/document/server-docs/docs/drive-v1/file/list)
- [获取文档元数据官方文档](https://open.feishu.cn/document/server-docs/docs/drive-v1/meta/batch_query)
- [Wiki 获取节点官方文档](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space/get_node)
- [Wiki 子节点列表官方文档](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/list)
- [官方 Drive SDK 请求实现](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/drive/v1/resource.go)
- [官方 Wiki SDK 请求实现](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/wiki/v2/resource.go)

### 账号与权限

手动入口接受飞书的 user_access_token 或 tenant_access_token。另有实验性设备授权，支持浏览器确认个人应用注册 / 自有应用认证，由本机宿主交换和刷新令牌；平台资格和真实租户适配待验证，见[飞书客户端授权](feishu-client-authorization.md)。通过飞书应用 / API 调试台获取访问令牌，并按所用接口官方文档启用云空间、文档元数据或知识库的相应读取权限。应用还必须能访问所选目录或文档；tenant token 不会自动继承用户个人空间权限，文档可能需要共享给应用。

连接时先验证根对象，再保存挂载。单文档验证元数据；文件夹验证首屏；Wiki 先验证节点再读取子项或实体文档。401 或已知 token 失效码会断开该连接并提示重连；403 提示权限范围。没有真实账号凭据的测试只验证官方响应契约和界面流程，不代表某个租户的应用权限配置已经可用。

## 其他插件接入方案（含金山）

1. 收集目标服务的官方文档和脱敏样例：认证、具体文档链接结构、目录列表与分页、目录 / 文件详情、实际文档访问链接、错误码和限流策略。
2. 判断是否符合 V1：HTTPS JSON API、Bearer 会话令牌、GET/POST、稳定对象 id、固定 API origin、明确的文档域名。符合时在共享清单添加 provider；目录和具体文档可分别提供 root.kind 配置。
3. 填写 root.urlTypes、可选 initialize、list/details 操作、成功码和字段映射。需要空间 / 团队等额外命名空间时从初始化响应映射 scopeId；目录节点关联实体文档时映射 documentId/documentType。
4. 若金山接口要求请求签名、交互 OAuth、应用密钥交换或不同的层级详情操作，先扩展版本化契约和两个宿主，再加入服务清单。不得为省事把令牌发给自定义任意 URL，或让插件在渲染进程执行请求签名和保存密钥。
5. 加入脱敏 JSON 夹具。复用以下契约用例：根对象验证、目录 / 单文档语义、分页、重名、目录与实体 id 不同、详情和在线链接、权限失败、限流、响应体上限、错误域名、删除 / 项目切换与连接中取消。
6. 两种 shell 都跑同一份夹具；界面用公共桥接测试。最后用实际账号验证应用授权、链接有效期、网页登录、服务拒绝嵌入时的“在浏览器中打开”。

示例结构（占位域名与字段仅示意，不能当作金山真实接口）：

```json
{
  "id": "example-documents",
  "name": "示例文档服务",
  "version": "1.0.0",
  "apiOrigin": "https://api.example.com",
  "documentHosts": ["docs.example.com"],
  "root": {"kind": "directory", "defaultType": "folder", "urlTypes": {"folder": "folder"}},
  "success": {"field": "status", "value": "ok"},
  "directoryType": "folder",
  "list": {
    "method": "GET", "path": "/v1/folders/$nodeId/items", "query": {"cursor": "$cursor"},
    "entries": "payload.nodes", "cursor": "payload.cursor", "hasMore": "payload.more",
    "fields": {"id": "id", "name": "label", "type": "kind", "url": "link"}
  },
  "details": {
    "method": "GET", "path": "/v1/documents/$nodeId", "entries": "payload.nodes",
    "fields": {"id": "id", "name": "label", "type": "kind", "url": "link"}
  }
}
```

Node 契约测试已用不同的 origin、路径、成功标志和字段映射运行第二个示例插件，验证通用宿主没有依赖飞书 providerId 或飞书目录字段。金山真实清单应在拿到官方接口信息并完成实际账号验证后提交。

## 权限、缓存与失败边界

- 清单随应用构建并审查，页面不能改 API origin、注册插件或写入 directoryMounts。API 请求固定 origin、携带 Bearer，仅在宿主执行；不跟随重定向，不把原始认证错误、凭据或请求体写入日志。
- 会话按项目和挂载隔离，只接受根节点与服务列表中已发现的节点。单文档挂载不能拿来列举其他文档。移除来源和切项目会取消请求并丢弃凭据；关闭连接表单会取消尚在验证的连接。
- 文档 URL 只允许 HTTPS 和插件声明的域名 / 子域名，拒绝用户名密码、异常端口、控制字符和 file/data/javascript 等协议。在线页面仍使用现有隔离网页视图，不能取得本地 pv 桥接。
- 请求超时 15 秒，每连接最多 4 个并发，响应 JSON 上限 2 MiB，每页最多 200 个节点，会话最多发现 10000 个节点。目录缓存 60 秒、最多 128 页；刷新可以绕过缓存。没有自动限流重试，收到 429 由用户稍后手动重试。
- 页面与接口响应使用请求版本检查，旧响应不会覆盖当前项目 / 目录。关闭和移除会清理对应界面；移除某个来源仅关闭其预览，保留其他本地或云来源的阅读内容。
- 参考目录只读与 SVG 可写根的权限不因云插件变化。插件不提供上传、删除云端文档或同步本地的 API。

## 验证与后续工作

单元段 S9/S10 和 MyGo `TestDirectoryPluginFeishuContract` / `TestDirectoryPluginDocumentAndWiki` 使用 `test/fixtures/feishu-directory.json`。界面段 D1 覆盖四种快捷项、分页 / 详情、Wiki 节点和实体文档的区别、令牌清空、临时链接不落布局、移除来源保留本地固定预览。

后续可独立推进：设备授权实测与系统凭据库存储、金山等真实服务适配、来源改名、断开连接入口、云目录浏览位置的跨重启恢复、更完整的目录详情操作，以及经隔离和签名验证的第三方可执行插件。当前版本不实现上述后续能力，不把声明式清单扩展等同于任意第三方代码的安装运行。
