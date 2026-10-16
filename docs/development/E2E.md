# E2E 导航

从 [Wayfinder](../../WAYFINDER.md) 或[模块导航](MODULES.md)找到受影响功能，再在本页选择验证链路。验证级别由[开发流程](WORKFLOW.md#验证矩阵)决定；本页提供现有脚本和覆盖边界，不记录某次检查是否通过。

## 先确认测试经过哪些层

| 类型 | 实际经过什么 | 能证明什么 |
|---|---|---|
| Node 专项与跨层集成 | 以用例为准；部分会装配真实网关、受管 Pi RPC、合成 Provider 和临时文件 | 对应服务、协议、原生工具与持久化行为；浏览器操作另验 |
| 浏览器 UI 回归 | 真实 Chromium 与页面；许多脚本替换 API / WebSocket | 页面行为、布局、状态与错误处理；被替换的后端链路另验 |
| 浏览器 E2E | 真实 Chromium → 隔离网关 → 实际职责服务；需要模型时接本地合成 Provider | 该场景中实际贯通的用户操作与结果；检查脚本是否还替换了相邻接口 |
| 准确包与原生实机专项 | 指定 SHA256 的归档、独立身份、真实启动器或 Office 程序 | 该包、该平台和该程序的安装、运行、恢复或渲染结果 |

目录名、文件名中的 `e2e`、以及启动了 HTTP 服务，都不能单独确定覆盖范围；以脚本里的装配、路由替身和断言为准。合成 Provider 验证调用契约，真实供应商行为另行验收。

## 自动浏览器中的真实链路

以下脚本由 `npm run test:browser` 统一运行，自己准备隔离后端。其他可运行脚本通过 `--list` 查询，按源代码判断接口是否被替换。

| 场景 | 入口 | 真实范围与限制 |
|---|---|---|
| 助手项目、对话和档案联动 | [pi-assistant-workspace-integration.cjs](../../test/browser/pi-assistant-workspace-integration.cjs) | 浏览器、真实网关、Pi worker、合成 Provider 与隔离档案 |
| 记住 → 纠正 → 使用的记忆闭环 | [pi-memory-learning-e2e.cjs](../../test/browser/pi-memory-learning-e2e.cjs) | 浏览器、网关、审查过的记忆 bundle、原生 RPC 与合成学习模型 |
| 原生历史与正文兼容 | [pi-087-compat.cjs](../../test/browser/pi-087-compat.cjs) | 实际 SessionManager、网关、worker 和页面；预置历史，不发送模型请求；文件名保留历史来源 |
| 创建项目文件夹 | [pi-project-directories.cjs](../../test/browser/pi-project-directories.cjs) | 桌面／手机、真实目录 API 和文件系统；相邻会话行为有替身，不经过模型执行 |
| 上传 Office 原件 → 工作副本 → 原生 MCP 编辑 → 交付下载 | [pi-office-editing-e2e.cjs](../../test/browser/pi-office-editing-e2e.cjs) | 浏览器、真实网关、受管 worker、stdio OfficeCLI 进程与交付快照；合成 Provider 编排 `prepare_office_document` → Codemode MCP → `deliver_files`；断言原件字节不变、修订标记与下载字节 |
| 上传公文原稿 → 规范修订 → 报告预览与授权下载 | [pi-gongwen-revision-e2e.cjs](../../test/browser/pi-gongwen-revision-e2e.cjs) | 浏览器、真实网关、受管 worker 与 gongwen 子进程；合成 Provider 调用 `revise_gongwen`；断言修订 DOCX 字节、报告预览、原件不变与交付面板条目 |

运行前完成[开发环境准备](../../CONTRIBUTING.md#开发环境)。Playwright 与浏览器由验证环境提供；将下列示例路径替换为已核对的绝对路径。Bash、rg、原生组件及平台权限按所选用例准备，见[浏览器与重型专项](WORKFLOW.md#浏览器与重型专项)。

```powershell
$env:PLAYWRIGHT_MODULE = 'C:\qa\node_modules\playwright'
$env:CHROMIUM_PATH = 'C:\qa\chromium\chrome.exe'
npm run test:browser -- --list
npm run test:browser -- test/browser/pi-assistant-workspace-integration.cjs test/browser/pi-memory-learning-e2e.cjs
```

统一运行器会过滤供应商凭据、提供静态资源并设置审查过的记忆 bundle 路径。浏览器选择器接受精确脚本名。`pivane-browser: manual` 标记的脚本另走下节入口。

## 按功能选择跨层检查

下表为代表性入口；完整实现和相邻测试按[模块导航](MODULES.md)继续查。Node 用例通过 `npm test -- <文件...>` 运行，浏览器脚本通过 `npm run test:browser -- <文件...>` 运行。

| 改动链路 | Node / 原生集成 | 配套浏览器与需补的边界 |
|---|---|---|
| 附件上传 → 原生读取 | [pi-document-runtime](../../test/pi-document-runtime.test.js)、[pi-document-uploads](../../test/pi-document-uploads.test.js) | [附件 UI](../../test/browser/pi-document-uploads.cjs)验证模拟接口下的页面行为；上传授权与原生分支由 runtime 用例覆盖 |
| 公文生成／修订 → 版本 → 授权下载 | [pi-gongwen-runtime](../../test/pi-gongwen-runtime.test.js)、[生成规则](../../test/pi-gongwen.test.js)、[修订保护](../../test/pi-gongwen-revise.test.js) | [交付 UI](../../test/browser/pi-deliverables.cjs)另验；上传→修订→授权下载已由 [pi-gongwen-revision-e2e](../../test/browser/pi-gongwen-revision-e2e.cjs) 用合成 Provider 贯通，生成→版本→下载仍是 Node 集成，真实 Office 渲染走下节 |
| Office 工作副本 → 原生 MCP → 编辑与交付 | [pi-officecli-runtime](../../test/pi-officecli-runtime.test.js)、[副本与程序检查](../../test/pi-officecli.test.js) | 原生程序须按[Office 文档](../OFFICE_DOCUMENTS.md)准备；浏览器编辑全链见 [pi-office-editing-e2e](../../test/browser/pi-office-editing-e2e.cjs)，Word/WPS 实机渲染仍按下节单独验收 |
| 原生 MCP / Codemode / 子任务 | [原生 MCP](../../test/pi-native-mcp.test.js)、[控制边界](../../test/pi-native-mcp-control.test.js)、[子任务](../../test/pi-native-mcp-child.test.js) | [MCP 工作台](../../test/browser/pi-native-mcp-workbench.cjs)的 API / WS 有替身；原生连接与子任务结果依靠 Node 集成 |
| 文件交付 → 成果发现与管理 | [pi-deliverables-runtime](../../test/pi-deliverables-runtime.test.js)、[成果服务](../../test/pi-artifacts.test.js)、[成果库](../../test/pi-artifacts-library.test.js) | [交付](../../test/browser/pi-deliverables.cjs)、[成果管理](../../test/browser/pi-artifacts-management.cjs)覆盖 UI；按用例核对跨会话授权与失败结果 |
| 启动 → 维护互斥 → 停机／重新启动 | [维护](../../test/pi-maintenance.test.js)、[安装锁](../../test/pi-installation-lock.test.js)、[受控停机](../../test/pivane-desktop-control.integration.test.js)、[停机事务](../../test/pi-desktop-stop.test.js) | [启动等待页](../../test/browser/pivane-desktop-startup.cjs)与 Windows 原生托盘分别验证；平台条件和跳过项单独记账 |
| 下载更新 → 安装／回退 | [应用更新](../../test/pi-application-update.test.js)、[受管 HTTP](../../test/pi-managed-http.test.js) | [更新 UI](../../test/browser/pi-updates.cjs)不替代准确 ZIP 更新 E2E，见下节 |

例如，只核对公文原生交付链与相关规则：

```powershell
npm test -- --list test/pi-gongwen.test.js test/pi-gongwen-revise.test.js test/pi-gongwen-runtime.test.js
npm test -- test/pi-gongwen.test.js test/pi-gongwen-revise.test.js test/pi-gongwen-runtime.test.js
```

这个选择不代表已经运行附件、浏览器、Office 实机或完整发行验收。应补哪些检查仍按本次影响范围确定。

## 手动服务、实机与准确包入口

| 场景 | 入口 | 运行前核对 |
|---|---|---|
| 归档安装、真实 RPC/Shell、升级与恢复 | [acceptance.cjs](../../test/release/acceptance.cjs) | 独立 Node 22、准确归档及 SHA256、浏览器、Playwright、新输出目录；参数和平台门槛见[隔离验收](RELEASING.md#可复跑的隔离验收) |
| Windows 便携 ZIP | [windows-portable.cjs](../../test/release/windows-portable.cjs) | Windows x64；传入 `ZIP SHA256`，QA 浏览器依赖在归档外 |
| 网页一键更新 E2E | [portable-auto-update.cjs](../../test/release/portable-auto-update.cjs) | Windows、准确新旧 ZIP 及哈希、目标包 `.update.json`、浏览器与新输出目录；本地合成更新源，参数复用 [options](../../test/release/gitlab-portable-update.cjs) |
| 内网更新与回退演练 | [gitlab-portable-update.cjs](../../test/release/gitlab-portable-update.cjs) | 新旧包、SHA256 与独立目录；`--source-candidate` 会生成模拟包，结果与正式准确包分开 |
| Pi 引擎受管联网更新 | [pi-managed-update.cjs](../../test/release/pi-managed-update.cjs) | 显式 `PI_RUN_MANAGED_UPDATE_TRIAL=1`，Node 22 / 24、独立测试数据；先读脚本的联网与更新目标 |
| 公文生成／修订的 Office 验收 | [gongwen-office.cjs](../../test/release/gongwen-office.cjs)、[gongwen-revise-office.cjs](../../test/release/gongwen-revise-office.cjs) | Windows、实际 Word / WPS 与字体；`--out` 指向尚不存在的绝对目录；核对报告、渲染和修订接受／拒绝结果，记录缺失程序／字体 |
| 浏览器连接外部隔离服务 | [Shell](../../test/browser/pi-shell-live.cjs)、[项目初始配置](../../test/browser/pi-project-onboarding.cjs)、[访问控制](../../test/browser/workspace-access.cjs) | 按脚本核对 URL、固定项目根、浏览器路径及所需服务配置；旧脚本有固定路径，准备不满足时记录待验 |
| Windows 托盘与真实服务 | [pivane-desktop-launcher.cjs](../../test/browser/pivane-desktop-launcher.cjs) | Windows 原生托盘与脚本自建的隔离 fixture；准确包模式的 `--portable-root` 由便携包验收器传入，不指向当前工作实例 |

`test/release/` 也包含供入口调用的 helper；先看文件头与调用方再执行。[release-install.cjs](../../test/browser/release-install.cjs)由 acceptance 驱动，不单独对普通服务运行。acceptance 不包含全量自动浏览器，公开发布按[发布流程](RELEASING.md)另补准确包内的检查。

## 补充 E2E 和留下证据

新增场景放入现有测试目录，沿用[统一发现](../../scripts/source-files.cjs)与运行器；自动浏览器脚本按现有 `chromium.launch` 发现约定接入，需要外部隔离服务的脚本标记 `pivane-browser: manual`。增加行为测试时，选择能穿过本次变更边界的最短链路：真实输入、职责服务或受管 worker、结果持久化与再次读取。对取消、超时、重启、分支切换或重复请求等受影响失败边界加入断言。

测试身份、项目、媒体、预约与配置使用独立路径，模型接本地合成服务。对 UI 记录桌面／手机、`pageerror`、实际宽度、抽屉、附件与工具状态；对文件和会话结果核对授权、身份及原生语义。隔离要求和清理次序遵循[开发流程](WORKFLOW.md#浏览器与重型专项)。

完成一条链路后，按[结果复用规则](WORKFLOW.md#验证结果复用与失效)保存：源码提交与未提交差异证明、命令与选择器、环境及依赖、退出码、日志位置／哈希、经过的真实层与替身、未覆盖项。准确包另绑定归档 SHA256，Office 实机另记实际程序和字体。完整证据放私有维护资料；本导航只更新可复跑入口与覆盖边界。
