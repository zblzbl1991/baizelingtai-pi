# WeKnora 知识库

当前源码提供独立知识库页面与聊天检索入口，复用[Pi 原生 MCP](MCP.md)中已经配置的服务。源码实现不表示运行实例已经升级；本功能尚未公开发布。

## 配置与打开

1. 在“扩展 → MCP”添加内置 WeKnora，刷新后编辑 `WEKNORA_BASE_URL`（含 `/api/v1`）和 `WEKNORA_API_KEY` 并启用，即可连接 WeKnora 0.7 REST 服务，无需另开 MCP 进程；详见[内置配置](MCP.md#内置-ocr-与-weknora-stdio)。也可沿用自行配置的 stdio MCP，或在新版 WeKnora“设置 → 发布与集成 → MCP Server”创建 HTTP 端点。不在知识库页另存地址或凭据。
2. 在聊天中打开一个持久线程。进入“扩展 → 知识库”，也可以从聊天输入框的添加菜单选择“知识库检索”。页面不会为关闭的线程启动 worker。
3. 选择已配置服务；如尚未发现工具，点击“连接所选服务”。如需登录，在原生 MCP 页按原生流程处理。保存配置不会自动更新已打开的线程，必要时重载线程资源。
4. 点击“读取知识库”，有后续页时点击“更多知识库”；选择范围，再“浏览文档”或输入问题“搜索知识库”。文档列表每页 20 项，搜索最多请求 10 个片段。支持全库搜索的端点可以不选知识库；内置 0.7 桥接和旧版 `hybrid_search` 需要先选择一个知识库，以实际参数 schema 为准。

打开页面只读取脱敏配置与已有 worker 的工具目录。连接与数据读取需要明确点击；项目配置遵守项目信任，隐藏、禁用、白名单排除的工具不会通过页面获得调用权限。配置中存在服务不表示当前线程已加载相应工具。

## 浏览和聊天

- 独立页面支持知识库列表、文档分页、搜索结果、文档读取及继续读取。服务实际返回的 HTTP/HTTPS 来源链接可直接打开。资料以安全文本显示，包括原文中的 HTML 和 Markdown。
- 内置 0.7 返回的是未经重排的关键词／向量混合召回；检索可能触发上游 embedding。结果保留来源文档 ID、分块类型与截断提示，摘要和图片描述不能直接当作原文。阅读支持“下一页原文”与“继续读取此分块”；续读保持页范围和 Unicode 字符偏移，并保留同页其他分块。单分块累计展示达到约一百万 JS 字符后，可在聊天中按偏移继续。列表只包含 API Key 可访问的当前空间自有库；共享库 ID 可在聊天中明确提供，不会把名称猜作 ID。
- “在聊天中提问”把问题、服务、知识库范围和实际工具名填入当前线程草稿；“引用到聊天”还加入所选片段，供助手核对原文。用户点击发送后，模型使用原生 MCP 工具检索并回答。实际回答能力与引用质量取决于当前模型及服务返回内容。
- 已有聊天草稿或附件不会被覆盖，也不会自动发送消息。先保存或发送原草稿后再试。
- 页面读取不调用聊天模型，不建立另一份聊天、知识索引或文档数据库。页面结果不持久缓存；关闭或锁定后清除结果。明确引用到聊天并发送的内容会进入原生会话历史。

## 工具兼容与限制

| 操作 | WeKnora HTTP MCP | 内置 0.7 REST 桥接 | 旧版 MCP |
|---|---|---|---|
| 列出知识库 | `list_knowledge_bases` | 同名，`page/page_size` 分页 | `list_knowledge_bases` |
| 文档列表 | `list_documents {knowledge_base_id}` | `list_documents {kb_id}` | `list_knowledge {kb_id}` |
| 检索 | `search_knowledge {knowledge_base_ids}` | `search_knowledge {kb_id}`，须选单库 | `hybrid_search {kb_id}` |
| 文档读取 | `read_document {knowledge_id,offset,limit}` | `read_document {knowledge_id,page,page_size,content_offset}` | `get_knowledge` |
| 后续内容 | `next_offset` | 页级 `next_page`，分块级 `next_content_offset` | 服务提供 `list_chunks` 时可使用 |

工具以当前 worker 实际注册的目录与参数 schema 为准，只提供其中可用的操作。每次读取重新检查目录修订与原生可调用权限。页面没有上传、修改或删除知识的入口，不调用 WeKnora 的聊天／智能体工具；聊天中仍按用户实际授权和原生工具权限执行。

线程正在运行或设置正在保存时，等待结束后再读取。线程切换、断线、目录变化或读取失败时不会自动重放；刷新后核对再操作。网络断开不代表服务器上的读取已经取消，执行槽持续保留到原生操作完成。读取返回预算为 320 KiB；超出时缩小范围或在聊天中分段读取。

验证使用独立身份、本地合成 MCP 与合成模型，覆盖真实 HTTP、唯一受管 worker、Pi 原生连接、工具权限钩子与原生会话持久化；不等同于用户实际 WeKnora 部署、凭据与数据的联调验收。

接口见 [API](API.md#知识库读取)，实现位置见[模块导航](development/MODULES.md)。WeKnora 工具参考：[内置端点](https://github.com/Tencent/WeKnora/blob/main/internal/mcpserver/tools_retrieve.go)与[旧版 MCP](https://github.com/Tencent/WeKnora/tree/main/mcp-server)。
