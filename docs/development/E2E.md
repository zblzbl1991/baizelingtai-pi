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
| 人员调配完整生命周期 | [pi-staffing-lifecycle.cjs](../../test/browser/pi-staffing-lifecycle.cjs) | Chromium → 隔离网关 → 受管 Pi worker 与合成 Provider → 台账 → Excel → 独立成果；核对普通对话与专用智能体的资源隔离，不代表真实供应商验收 |
| 人员调配启用与初始核对 | [pi-staffing-initialize.cjs](../../test/browser/pi-staffing-initialize.cjs) | 真实页面、调配 HTTP、职责服务与私有持久化；相邻工作台接口与聊天连接有替身 |
| 调配卡片、三视图及 Excel 操作 | [pi-staffing-cards.cjs](../../test/browser/pi-staffing-cards.cjs)、[pi-staffing-views.cjs](../../test/browser/pi-staffing-views.cjs)、[pi-staffing-excel.cjs](../../test/browser/pi-staffing-excel.cjs) | 真实页面、调配服务与私有持久化，Excel 脚本还经过解析与成果服务；相邻工作台和聊天有替身，原生聊天链路见生命周期脚本 |
| 助手项目、对话和档案联动 | [pi-assistant-workspace-integration.cjs](../../test/browser/pi-assistant-workspace-integration.cjs) | 浏览器、真实网关、Pi worker、合成 Provider 与隔离档案 |
| 记住 → 纠正 → 使用的记忆闭环 | [pi-memory-learning-e2e.cjs](../../test/browser/pi-memory-learning-e2e.cjs) | 浏览器、网关、审查过的记忆 bundle、原生 RPC 与合成学习模型 |
| 原生历史与正文兼容 | [pi-087-compat.cjs](../../test/browser/pi-087-compat.cjs) | 实际 SessionManager、网关、worker 和页面；预置历史，不发送模型请求；文件名保留历史来源 |
| 创建项目文件夹 | [pi-project-directories.cjs](../../test/browser/pi-project-directories.cjs) | 桌面／手机、真实目录 API 和文件系统；相邻会话行为有替身，不经过模型执行 |
| 上传 Office 原件 → 工作副本 → 原生 MCP 编辑 → 交付下载 | [pi-office-editing-e2e.cjs](../../test/browser/pi-office-editing-e2e.cjs) | 浏览器、真实网关、受管 worker、stdio OfficeCLI 进程与交付快照；合成 Provider 编排 `prepare_office_document` → Codemode MCP → `deliver_files`；断言原件字节不变、修订标记与下载字节 |
| 上传公文原稿 → 规范修订 → 报告预览与授权下载 | [pi-gongwen-revision-e2e.cjs](../../test/browser/pi-gongwen-revision-e2e.cjs) | 浏览器、真实网关、受管 worker 与 gongwen 子进程；合成 Provider 调用 `revise_gongwen`；断言修订 DOCX 字节、报告预览、原件不变与交付面板条目 |
| 六格式 × 四来源 Office 阅读、原件保存／下载和关闭 | [pi-office-preview-e2e.cjs](../../test/browser/pi-office-preview-e2e.cjs) | 两种桌面宽度的实际页面、网关、SessionManager／来源服务、原生 kit、PDF.js 和工作簿 Worker；公开 UI 保存交付原件、核对哈希及重复关闭资源。依赖 Windows x64 原生引擎 |
| 工作簿 Strict／Transitional 与 UTF-8／UTF-16 原件 → 网格 | [pi-office-preview-opc-e2e.cjs](../../test/browser/pi-office-preview-opc-e2e.cjs) | 项目文件及公开草稿上传、非传统主部件、实际 Worker／安全 DOM、中英文缓存提示和原文；纯 Excel，不标记为需要原生 Word／PPT 引擎 |
| Office 草稿隔离、切线程、重连与字体刷新 | [pi-office-preview-state-e2e.cjs](../../test/browser/pi-office-preview-state-e2e.cjs) | 实际上传／阅读、WebSocket 断开再连接和同一受管 worker、工具行、缺字体及显式刷新；依赖 Windows x64 原生引擎，未安装新字体或操作 Word／WPS |

运行前完成[开发环境准备](../../CONTRIBUTING.md#开发环境)。Playwright 与浏览器由验证环境提供；将下列示例路径替换为已核对的绝对路径。Bash、rg、原生组件及平台权限按所选用例准备，见[浏览器与重型专项](WORKFLOW.md#浏览器与重型专项)。

```powershell
$env:PLAYWRIGHT_MODULE = 'C:\qa\node_modules\playwright'
$env:CHROMIUM_PATH = 'C:\qa\chromium\chrome.exe'
npm run test:browser -- --list
npm run test:browser -- test/browser/pi-assistant-workspace-integration.cjs test/browser/pi-memory-learning-e2e.cjs
```

统一运行器会过滤供应商凭据、提供静态资源并设置审查过的记忆 bundle 路径。浏览器选择器接受精确脚本名。`pivane-browser: manual` 标记的脚本另走下节入口。

人员调配的五个脚本支持 `PI_STAFFING_VIEWPORT=1440`：只使用桌面视口，保留卡片和初始化脚本原有的业务分支。默认仍覆盖各脚本定义的全部视口。Office 编辑、记忆闭环、MCP 工作台、附件存储、队列恢复和字体不可达脚本支持 `PI_TEST_DESKTOP_ONLY=1`；重新打开会话等业务检查仍会执行。

```powershell
$env:PI_STAFFING_VIEWPORT = '1440'
npm run test:browser -- test/browser/pi-staffing-initialize.cjs test/browser/pi-staffing-cards.cjs test/browser/pi-staffing-views.cjs test/browser/pi-staffing-excel.cjs test/browser/pi-staffing-lifecycle.cjs
```

统一 `--target=desktop|all` 默认 all。仅验桌面时，例如 `npm run test:browser -- --target=desktop test/browser/pi-office-file-preview.cjs`；选择器、真实视口 guard 和结果范围见[开发流程](WORKFLOW.md#浏览器与重型专项)。不将桌面选择的成功计作手机验收。

Office 真实链路使用 [隔离服务 helper](../../test/office-preview-real-server.cjs)与[浏览器 helper](../../test/browser/pi-office-real-helper.cjs)，预置原生会话和收据后再打开唯一受管 worker，不替换 HTTP／WebSocket／引擎响应。该一次性 fixture 关闭登录要求，鉴权／外来 Origin 拒绝由相应 HTTP 专项另验；不声称模型生成文档链路，预览断言不应调用 Provider。`pivane-browser: office-native` 元数据仅用于上述主矩阵和状态脚本，运行器复用唯一平台声明：未支持平台默认或显式选择均输出 `SKIP / not applicable / requires Windows x64`，跳过项不计入通过数；纯 Excel OPC 场景保持适用。平台选择策略测试不代表其他操作系统的实际浏览器或原生转换验收。

## Office 预览验证入口

六种格式和四种来源的行为契约见 [Office 预览](../OFFICE_PREVIEW.md)和 [API](../API.md#office-文件预览)。下表只定位可复跑边界，不代表某次执行已通过：

| 入口 | 真实范围与限制 |
|---|---|
| [来源矩阵](../../test/pi-office-preview-sources.test.js)、[服务生命周期](../../test/pi-office-previews.test.js)、[HTTP](../../test/pi-office-preview-routes.test.js)、[格式](../../test/pi-office-format.test.js) | 原生 SessionManager／分支、文件／交付／成果库／附件职责服务及授权、身份变化、原件哈希、HTTP 安全与取消；可控引擎替身验证失败／共享边界，不代替原生转换 |
| [OPC／编码集成](../../test/pi-office-opc.test.js) | 真实项目文件与上传来源把 Strict／Transitional、UTF-8／UTF-16LE／UTF-16BE XLSX 原字节传至有界解析器，核对重定位主部件、中文值、SHA256 和非法关系／编码拒绝；不是实际浏览器 Worker 或 Word／PPT 原生转换验收 |
| [引擎专项](../../test/office-preview-engine.test.js)、[原生引擎探针](../../test/release/office-preview-engine.cjs) | 单元用例的注入故障与独立原生运行须分别看；后者执行完整性／实际转换、私有权限、取消清理、代际刷新及输出预算，要求目标平台组件，不证明 Word／WPS 最终版面 |
| [平台预检](../../test/office-preview-platform.test.js)、[应用候选](../../test/pi-application-update.test.js) | 验证共享支持声明、未声明平台降级和已声明平台严格拒绝不健康候选；注入目标／进程适配的测试不冒充 Linux／macOS／ARM 原生安装，实际 Windows 健康探针以用例为准 |
| [预算专项](../../test/pi-office-preview-limits.test.js)、[原生安全／资源专项](../../test/release/office-preview-security.cjs) | 前者以服务公开 seam 和可控来源／引擎验证准入边界；后者通过真实项目来源、服务与 Windows 原生 kit，观察字段／外链 canary、缓存／字体刷新、私有 DACL、真实取消和进程／临时目录清理，以及采样资源下界。可选独立 authoring 还提供真实 DOC AutoOpen 正／负控制，继而证明同一输入在产品来源准入处被拒绝、未进入转换；不外推其他 VBA／PPT 自动执行机制 |
| [宏材料生成](../../test/office-macro-fixtures.cjs)、[公共来源宏拒绝](../../test/pi-office-macro.test.js) | 有界纯内存生成 DOC 材料，生成器本身不写文件；其中无害宏运行时只向调用方私有 canary 目录写固定标记，支持 ASCII／中文父路径。轻量服务用例以引擎计数替身验证准入，实际自动打开控制仍走显式原生专项 |
| [工作簿解析](../../test/office-workbook.test.js)、[材料说明](../../test/fixtures/office/README.md) | 实际 XLSX 容器、XML／OPC、XLS／BIFF、保存缓存、日期／样式／异常与预算；材料来源和兼容性结论按具体断言核对，不用解析成功证明所有布局还原 |
| [Office 阅读桥](../../test/browser/pi-office-file-preview.cjs)、[只读表格](../../test/browser/pi-office-table-preview.cjs)、[桥接回归](../../test/pi-office-file-preview.test.js) | 实际 PDF／Worker／DOM 组件与模拟 HTTP；覆盖四入口、原件动作、代次／迟到清理和阅读状态，不能称真实网关＋转换引擎端到端 |

Node 专项经 `npm test -- <文件>`，自动浏览器经统一 `npm run test:browser -- --target=desktop <脚本>`；原生引擎探针按脚本参数单独运行。准确包需要再证明其依赖、生成资源、完整许可证闭包及候选拒绝激活／恢复；实际安装字体后的效果、Word／WPS 排版、其他操作系统和手机分别列出通过或待验，不从上述源码专项推断。

`office-preview-security.cjs` 是显式重型原生专项，不随普通全量 Node 自动执行。按脚本要求准备 Windows x64 和已核验原生依赖后，可运行 `node test/release/office-preview-security.cjs --report /path/to/new-report.json`；它过滤供应商／身份环境并创建自己的合成身份、项目和 canary。需要实际 DOC 字段样本时追加 `--authoring-soffice /path/to/independent/soffice.com`，指向已核对的独立完整 LibreOffice authoring 程序，以私有 profile 导出 Word97；该选项不安装系统程序，也不把 authoring 进程当作待测 kit。未提供时不声称覆盖该独立导出链路。报告中的 RSS／句柄／临时目录峰值是采样下界；PDF 没有本地标记不等于文件打开审计，canary 结果不等于操作系统网络／文件沙箱。

只复跑 DOC AutoOpen 准入闭环时，使用 `node test/release/office-preview-security.cjs --macro-only --authoring-soffice /path/to/independent/soffice.com --report /path/to/new-macro-report.json`；追加 `--unicode-canary` 使用中文父目录。独立 authoring 安装还须具有脚本检查的 Python／UNO runtime。该场景真实打开同一无害 DOC，先以禁用宏模式确认无标记，再以允许模式确认自动生成准确标记，未手动调用宏；关闭独立进程、清除标记后，通过真实产品来源断言 `OFFICE_INVALID`、转换调用数为零、无新标记。它验证特定 DOC 样例的公共准入阻断，不证明所有 Office 宏、PowerPoint 自动事件或转换器本身在接收任意宏时的运行安全。

## 按功能选择跨层检查

下表为代表性入口；完整实现和相邻测试按[模块导航](MODULES.md)继续查。Node 用例通过 `npm test -- <文件...>` 运行，浏览器脚本通过 `npm run test:browser -- <文件...>` 运行。

| 改动链路 | Node / 原生集成 | 配套浏览器与需补的边界 |
|---|---|---|
| 人员调配 → 确认 → 台账 → Excel 成果 | [初始化](../../test/staffing-initialization.test.js)、[专用上下文](../../test/staffing-runtime.test.js)、[显式路径隔离](../../test/staffing-paths.test.js)、[导出关停](../../test/staffing-shutdown.test.js)；其余 `staffing-*.test.js` 由统一入口发现 | 上表五个调配脚本；生命周期经过原生聊天和真实服务，其余脚本隔离相邻工作台接口 |
| 附件上传 → 原生读取 | [pi-document-runtime](../../test/pi-document-runtime.test.js)、[pi-document-uploads](../../test/pi-document-uploads.test.js) | [附件 UI](../../test/browser/pi-document-uploads.cjs)验证模拟接口下的页面行为；上传授权与原生分支由 runtime 用例覆盖 |
| 公文生成／修订 → 版本 → 授权下载 | [pi-gongwen-runtime](../../test/pi-gongwen-runtime.test.js)、[生成规则](../../test/pi-gongwen.test.js)、[修订保护](../../test/pi-gongwen-revise.test.js)、[生成结构与 HTML](../../test/pi-gongwen-format-generation.test.js)、[最终属性](../../test/pi-gongwen-format-validation.test.js)、[格式保护与差异](../../test/pi-gongwen-format-revisions.test.js) | runtime 断言格式报告、变更记录持久化与复用；独立 OfficeCLI 校验和真实 HTML 转换不等于 Word/WPS 渲染。[交付 UI](../../test/browser/pi-deliverables.cjs)另验；上传→修订→授权下载已由 [pi-gongwen-revision-e2e](../../test/browser/pi-gongwen-revision-e2e.cjs) 用合成 Provider 贯通，生成→版本→下载仍是 Node 集成 |
| Office 工作副本 → 原生 MCP → 编辑与交付 | [pi-officecli-runtime](../../test/pi-officecli-runtime.test.js)、[副本与程序检查](../../test/pi-officecli.test.js) | 原生程序须按[Office 文档](../OFFICE_DOCUMENTS.md)准备；浏览器编辑全链见 [pi-office-editing-e2e](../../test/browser/pi-office-editing-e2e.cjs)，Word/WPS 实机渲染仍按下节单独验收 |
| 原生 MCP / Codemode / 子任务 | [原生 MCP](../../test/pi-native-mcp.test.js)、[控制边界](../../test/pi-native-mcp-control.test.js)、[子任务](../../test/pi-native-mcp-child.test.js) | [MCP 工作台](../../test/browser/pi-native-mcp-workbench.cjs)的 API / WS 有替身；原生连接与子任务结果依靠 Node 集成 |
| 文件交付 → 成果发现与管理 | [pi-deliverables-runtime](../../test/pi-deliverables-runtime.test.js)、[成果服务](../../test/pi-artifacts.test.js)、[成果库](../../test/pi-artifacts-library.test.js) | [交付](../../test/browser/pi-deliverables.cjs)、[成果管理](../../test/browser/pi-artifacts-management.cjs)覆盖 UI；按用例核对跨会话授权与失败结果 |
| 启动 → 维护互斥 → 停机／重新启动 | [维护](../../test/pi-maintenance.test.js)、[安装锁](../../test/pi-installation-lock.test.js)、[受控停机](../../test/pivane-desktop-control.integration.test.js)、[停机事务](../../test/pi-desktop-stop.test.js)、[停机装配](../../test/pi-desktop-stop-gateway.test.js) | [启动等待页](../../test/browser/pivane-desktop-startup.cjs)与 Windows 原生托盘分别验证；平台条件和跳过项单独记账 |
| 下载更新 → 安装／回退 | [应用更新](../../test/pi-application-update.test.js)、[受管 HTTP](../../test/pi-managed-http.test.js) | [更新 UI](../../test/browser/pi-updates.cjs)不替代准确 ZIP 更新 E2E，见下节 |

## 合规全链路与故障注入

[完整链路](../../test/browser/pi-compliance-full-chain.cjs)使用真实 Chromium、HTTP/聊天 WebSocket、唯一受管 worker、本地 SSE 合成供应商、合规账本与原生会话，覆盖规则、人工复核、报告、交付与成果保存。[故障链路](../../test/browser/pi-compliance-full-chain-faults.cjs)覆盖明确拒绝、响应丢失、在途请求、修订冲突、迟到结果、停用、重启后的未知步骤、原生确认丢失与同名报告来源核对。故障用例在声明的边界注入失败，其余业务服务保持真实。

两者经统一浏览器入口运行，使用独立临时身份和项目，不需要维护者的样本目录；[样本生成器](../../test/compliance-full-chain-fixtures.cjs)按固定哈希生成合成 PDF/CSV。全链默认运行中文 1440 桌面场景；`COMPLIANCE_FULLCHAIN_COMBOS` 可指定 `1440:full:zh,1440:min:en` 等组合，`--target=desktop` 会过滤手机组合。历史六组合结果不代表当前源码已重新验收。

```powershell
npm run test:browser -- --target=desktop test/browser/pi-compliance-full-chain.cjs test/browser/pi-compliance-full-chain-faults.cjs
```

`COMPLIANCE_FULLCHAIN_SAMPLES` 可指定带 `MANIFEST.sha256` 的外部样本目录；`COMPLIANCE_FULLCHAIN_EVIDENCE` 与 `COMPLIANCE_FAULTS_EVIDENCE` 可指定树外结果 JSON。`COMPLIANCE_FAULTS_ONLY=f8` 仅用于定向诊断，不能作为九项故障全验收。浏览器与 Playwright 的准备沿用本页统一入口。

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
| 公文生成／修订的开发样本 Office 回归 | [gongwen-office.cjs](../../test/release/gongwen-office.cjs)、[gongwen-revise-office.cjs](../../test/release/gongwen-revise-office.cjs) | Windows、实际 Word / WPS 与字体；`--out` 指向尚不存在的绝对目录；核对报告、渲染和修订接受／拒绝结果，记录缺失程序／字体。日常生成／修订自动核验电子属性，不依赖此脚本或逐份软件验收；样本通过不扩大为任意文件实机通过 |
| 浏览器连接外部隔离服务 | [Shell](../../test/browser/pi-shell-live.cjs)、[项目初始配置](../../test/browser/pi-project-onboarding.cjs)、[访问控制](../../test/browser/workspace-access.cjs) | 按脚本核对 URL、固定项目根、浏览器路径及所需服务配置；旧脚本有固定路径，准备不满足时记录待验 |
| Windows 托盘与真实服务 | [pivane-desktop-launcher.cjs](../../test/browser/pivane-desktop-launcher.cjs) | Windows 原生托盘与脚本自建的隔离 fixture；准确包模式的 `--portable-root` 由便携包验收器传入，不指向当前工作实例 |

`test/release/` 也包含供入口调用的 helper；先看文件头与调用方再执行。[release-install.cjs](../../test/browser/release-install.cjs)由 acceptance 驱动，不单独对普通服务运行。acceptance 不包含全量自动浏览器，公开发布按[发布流程](RELEASING.md)另补准确包内的检查。

## 补充 E2E 和留下证据

新增场景放入现有测试目录，沿用[统一发现](../../scripts/source-files.cjs)与运行器；自动浏览器脚本按现有 `chromium.launch` 发现约定接入，需要外部隔离服务的脚本标记 `pivane-browser: manual`。增加行为测试时，选择能穿过本次变更边界的最短链路：真实输入、职责服务或受管 worker、结果持久化与再次读取。对取消、超时、重启、分支切换或重复请求等受影响失败边界加入断言。

测试身份、项目、媒体、预约与配置使用独立路径，模型接本地合成服务。对 UI 记录桌面／手机、`pageerror`、实际宽度、抽屉、附件与工具状态；对文件和会话结果核对授权、身份及原生语义。隔离要求和清理次序遵循[开发流程](WORKFLOW.md#浏览器与重型专项)。

完成一条链路后，按[结果复用规则](WORKFLOW.md#验证结果复用与失效)保存：源码提交与未提交差异证明、命令与选择器、环境及依赖、退出码、日志位置／哈希、经过的真实层与替身、未覆盖项。准确包另绑定归档 SHA256，Office 实机另记实际程序和字体。完整证据放私有维护资料；本导航只更新可复跑入口与覆盖边界。
