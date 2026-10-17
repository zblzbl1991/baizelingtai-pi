# 白泽灵台开发文档

这些文档随源码版本管理，保存可复用的设计、契约和流程。机器地址、当前部署、有效授权和验证日志属于私有维护资料，源码入口通过可选的 `AGENTS.local.md` 指向本机资料。

## 按需阅读

先读 [贡献指南](../../CONTRIBUTING.md) 和 [源码 Agent 入口](../../AGENTS.md)，再只打开与本次任务相关的文档：

| 需要了解什么 | 入口 |
|---|---|
| 按任务定位实现、契约和测试链路 | [Wayfinder](../../WAYFINDER.md) |
| 一类功能应该修改哪里、相关契约在哪 | [模块导航](MODULES.md) |
| 系统边界、数据流、设计取舍与已知技术债 | [架构](ARCHITECTURE.md) |
| 开发步骤、验证范围、文档责任 | [开发流程](WORKFLOW.md) |
| 助手身份、分类与档案记忆的实现边界 | [助手档案实现](AGENT_PROFILES.md) |
| 白泽灵台名称、旧版本兼容、项目迁移 | [命名与迁移](NAMING.md) |
| Pi/第三方依赖、公开 API 和升级验证 | [依赖与上游适配](DEPENDENCIES.md) |
| 候选包、发布与恢复演练 | [发布流程](RELEASING.md) |
| 字段和协议 | [API](../API.md)、对应功能文档（索引见 [文档目录](../README.md)） |
| 平台原生组件 | [native](../../native/README.md) |
| OfficeCLI 程序、原生 MCP、Office 工作副本与验收 | [Office 文档](../OFFICE_DOCUMENTS.md)、[模块导航](MODULES.md) |
| 六种 Office 预览、四来源授权、只读表格和引擎闭包 | [Office 预览](../OFFICE_PREVIEW.md)、[API](../API.md#office-文件预览)、[依赖](DEPENDENCIES.md#office-预览依赖)、[验证入口](E2E.md#office-预览验证入口) |
| guizang-ppt 与内网 SkillHub 来源、CLI 和接口依据 | [SkillHub 接入核查](research/skillhub-guizang-ppt.md) |
| pi-web-keeper 的 Windows PWA 入口与集成取舍 | [桌面入口集成评估](research/pi-web-keeper.md) |
| gongwen-kit 公文生成、机检与修订的接入建议 | [gongwen-kit 接入评估](research/gongwen-kit.md) |
| 公文格式核验、草稿交付与目标软件的已确认设计边界 | [公文格式核验决策](../adr/0001-gongwen-format-validation.md) |
| 六种 Office 格式、四类文件入口与首批预览验收平台 | [Office 预览范围决策](../adr/0002-office-preview-scope.md) |
| Office 原件与预览副本、故障降级及表格适配边界 | [Office 预览接入决策](../adr/0003-office-preview-derived-bytes.md) |

用户可见行为以功能文档为准；实现细节以本目录为准；两者都不记录某台机器的部署状态。

## 验证入口

按功能寻找真实网关／原生 RPC、浏览器、实机与准确包测试时，先查 [E2E 导航](E2E.md)，确认真实范围、接口替身及缺口。

统一的 [验证矩阵](WORKFLOW.md#验证矩阵) 区分局部功能本机部署、共享基础能力部署和公开发布，覆盖源码交付与累计集成检查；[结果复用](WORKFLOW.md#验证结果复用与失效) 定义证据和失效条件；[Node 测试入口](WORKFLOW.md#node-测试入口与计时) 提供定向运行、清单与耗时报告。

Node 用例递归发现 `test/` 下的 `.test.js`；浏览器回归位于 `test/browser/`（`npm run test:browser`），归档演练位于 `test/release/`，两者不由 `npm test` 执行。依赖、手动脚本和隔离要求见 [浏览器与重型专项](WORKFLOW.md#浏览器与重型专项)。
