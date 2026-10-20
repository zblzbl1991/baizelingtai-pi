# 白泽灵台 Wayfinder

按任务找到实现、契约和验证入口。这里描述当前检出源码；是否已提交、部署、发布或通过验收，分别核对 Git、运行实例和验证记录。

## 从任务进入

| 本次要做什么 | 先读哪里 | 定位完成的条件 |
|---|---|---|
| 首次接手源码 | [贡献指南](CONTRIBUTING.md)、[Agent 边界](AGENTS.md) | 已区分源码、运行版和候选，保留工作区已有改动 |
| 新功能、修复或重构 | [模块导航](docs/development/MODULES.md) → 对应功能契约 | 已找到状态所有者、调用方和受影响测试 |
| 会话、并发、文件身份或生命周期问题 | [架构](docs/development/ARCHITECTURE.md) → [API](docs/API.md) | 已追到实际数据来源、互斥和退出边界 |
| 选择测试或补 E2E | [E2E 导航](docs/development/E2E.md) → [验证矩阵](docs/development/WORKFLOW.md#验证矩阵) | 已列出本次真实经过的层、替身及未覆盖链路 |
| 安装、升级、回退或发布 | [发布流程](docs/development/RELEASING.md) | 已明确准确归档、平台与隔离验收入口 |
| 启动器整包自动升级的开发与验收 | [专项 Wayfinder](docs/development/LAUNCHER_UPDATE_WAYFINDER.md) → [已确认设计](docs/development/design/launcher-auto-update.md) | 已区分旧外层服务更新、新协议源码和准确包待验范围，找到签名、退出交接、修复与交付入口 |
| 帮用户配置或排障 | [用户 Agent 指南](docs/AGENT_GUIDE.md) → [功能文档目录](docs/README.md) | 已核对实际安装版本和可用能力 |

## 沿调用链找所有者

| 入口或边界 | 从这里追踪 | 关键事实归属 |
|---|---|---|
| 浏览器操作、状态和布局 | `public/`；按[模块导航](docs/development/MODULES.md)查组件 | 页面协调器和功能组件；UI 回归与真实后端 E2E 分开选择 |
| HTTP / WebSocket | [服务装配](server.js)、[网关](server/pi-agent-routes.js) | 鉴权、路由和服务连接；业务状态回到职责服务 |
| 原生会话与执行 | [Supervisor](server/pi-agent-supervisor.js)、[RPC](server/pi-rpc-client.js)、[生命周期](server/pi-worker-lifecycle.js) | Pi SessionManager / 原生 JSONL，以及每个规范会话文件唯一的受管 worker |
| 文件、附件与交付 | [文件服务](server/pi-file-service.js)、[附件](server/pi-document-uploads.js)、[交付](server/pi-deliverables.js) | 项目范围、已打开文件身份、原生分支授权与成果快照 |
| 能力包与上游 | [能力登记](server/pi-bundled-capabilities.js)、[资源适配](server/pi-bundled-resources.js)、[依赖约定](docs/development/DEPENDENCIES.md) | `pi-packages/` 的宿主适配、`vendor/manifest.json` 的上游原始文件 |
| 启动、更新和恢复 | [受管启动器](server/pi-managed-launcher.js)、[发布流程](docs/development/RELEASING.md) | 统一停机、独立代码目录、停机备份和失败恢复 |

具体功能仍以[模块导航](docs/development/MODULES.md)为文件映射来源；本页不复制完整模块表。

## 验证和收尾

1. 在 [E2E 导航](docs/development/E2E.md)选择相关链路，再按[开发流程](docs/development/WORKFLOW.md)确定专项、全量及证据复用范围。列明准备执行、复用和缺失的检查。
2. 从统一入口列出测试再运行；Node、自动浏览器、手动实机和准确包验收各有范围。退出码、日志与实际断言共同决定结果。
3. 对跨层改动说明入口、真实服务、原生执行、持久化和结果读取经过了哪些层。缺少某一层时记录缺口，并补相应测试或标为待验。
4. 按[文档责任](docs/development/WORKFLOW.md#文档责任)更新对应契约。新文档进入 [公开清单](docs/public-files.json)，新增代码与测试进入[统一发现](scripts/source-files.cjs)。完成后给出变更、验证结果和未覆盖项。

本机资料通过可选 `AGENTS.local.md` 读取；实例地址、身份、授权和完整日志保留在私有维护资料中。
