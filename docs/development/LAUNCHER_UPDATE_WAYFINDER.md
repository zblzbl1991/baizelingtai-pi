# 启动器整包升级 Wayfinder

本页用于接手 Windows x64 便携版的启动器整包自动升级开发，连接设计、状态所有者、实现与验证入口。13 项产品选择见[设计记录](design/launcher-auto-update.md)，本页不另存一份产品规范。

当前签名信任、独立退出后激活、桌面交接、独立修复和便携构建接线已有源码；旧版自动迁移对无法证明的清理明确拒绝，首次实际迁移与准确包整链验收仍须单独完成。旧外层的一键更新仍只切换服务；新协议的整套能力由维护状态明确声明，包内带新版 EXE 本身不表示原入口已更新。源码、实际运行版本和发行归档须分别核对。

## 先按任务定位

| 接手任务 | 先读哪里 | 定位完成的条件 |
|---|---|---|
| 理解已确认范围 | [设计记录](design/launcher-auto-update.md)、[术语](../../GLOSSARY.md) | 知道整包范围、启用前验证与开放业务后的恢复边界 |
| 核对当前用户行为 | [启动器指南](../DESKTOP_LAUNCHER.md)、[更新指南](../UPDATES.md) | 区分旧外层服务更新能力、新协议源码能力和准确包待验范围 |
| 追维护协议与准入 | [API](../API.md#版本检查与-pi-受管维护)、[架构](ARCHITECTURE.md)、下表的维护入口 | 找到一次性票据、全局空闲、IPC 与业务准入的所有者 |
| 实现或排查退出交接 | 下表的桌面链路、安装锁与正常停机 | 追到实际进程、可信清理证明、锁交接和未知结果处理 |
| 实现激活与恢复 | 下表的候选、备份、原生文件与版本选择 | 明确原安装身份、候选文件证明、提交点和恢复条件 |
| 补测试或交付候选 | 本页验证入口、[E2E 导航](E2E.md)、[开发流程](WORKFLOW.md#验证矩阵)、[发布流程](RELEASING.md) | 列明真实层、替身、准确包 SHA256、通过与待验项 |

## 当前调用链与状态所有者

新协议桌面链路为原根固定 EXE → state.active 版本根的托盘 PowerShell → 同版本 Node runner → 桌面编排 → ManagedLauncher → 同版本服务。原根仍拥有身份、信任、配置、锁和唯一状态；[桌面更新编排](../../server/pivane-desktop-update.js)负责真实托盘证明、助手握手和启用前验证，持久提交之后才开放业务。旧外层继续保留原服务更新兼容路径。

| 职责 | 现有实现入口 | 接手时核对什么 |
|---|---|---|
| 原入口、快捷方式与托盘 | [EXE](../../native/pivane-desktop-launcher.cs)、[托盘](../../scripts/desktop-tray.ps1)、[EXE 构建](../../scripts/build-desktop-launcher.cjs) | EXE 自身退出后托盘仍可持有其程序集；固定入口自身升级必须等实际释放 |
| 桌面身份、runner 与控制协议 | [runner](../../scripts/start-desktop.cjs)、[桌面编排](../../server/pivane-desktop-launcher.js) | 原安装根、data 默认路径、generation、LF 分帧、进程退出与 clean 状态 |
| 版本选择与受管维护执行 | [ManagedLauncher](../../server/pi-managed-launcher.js) | `.pivane-runtime/state.json` 的 active/previous、候选 boot、关闭与恢复；旧外层指针只证明服务切换；新协议还须核对同一 activation 的外层提交记录 |
| 安装级互斥 | [安装锁](../../server/pi-installation-lock.js) | 锁绑定原安装 realpath；迁移、更新助手和正常启动必须服从同一所有权边界，托盘 mutex 不能代替它 |
| 版本页、清单与票据 | [更新 UI](../../public/pi-updates.js)、[更新服务及路由](../../server/pi-update-service.js)、[清单解析](../../server/pi-update-feed.js)、[签名验证](../../server/pi-update-signatures.js)、[维护客户端](../../server/pi-maintenance-client.js) | review/execute/maintenance 查询、目标重查、票据绑定、能力声明与准入；核对原始已签载荷在这些边界内是否保持绑定 |
| 全局空闲与正常停机 | [停机事务](../../server/pivane-desktop-stop.js)、[网关装配与 dispose](../../server/pi-agent-routes.js)、[服务清理与证明](../../server.js) | 所有后台工作参与准入，实际清理完成才能交接；超时、退出码 0 或 PID 消失均不能单独替代证明 |
| ZIP 校验、解压与候选验证 | [便携包安装器](../../server/pi-portable-installer.js)、[合成身份探针](../../server/pi-update-probe.js) | 固定目标、同源下载、字节数/哈希、逐文件清单、源码未发布修改保护；激活前还须重新核验 |
| 备份证明、数据恢复与保留 | [维护文件](../../server/pi-maintenance-files.js)、[备份证明](../../server/pi-maintenance-backup.js)、[恢复](../../server/pi-maintenance-restore.js)、[保留策略](../../server/pi-managed-retention.js)、[离线恢复入口](../../scripts/restore-managed-backup.cjs) | 停机备份、失败数据快照、needsRecovery 与恢复范围；现有离线脚本不能修复固定 EXE |
| Windows 文件身份与替换 | [JS 原生边界](../../server/pi-win32-native.js)、[原生源码](../../native/pi-win32-fd.c)、[原生组件说明](../../native/README.md) | 单文件替换与独立修复闭包共用 native 身份边界；源码、二进制与 manifest 必须匹配 |
| 独立修复与旧版维护 | [修复器](../../server/pi-launcher-repair.js)、[CLI](../../scripts/repair-launcher.cjs)、[旧版计划](../../server/pi-launcher-legacy.js)、[修复指南](../LAUNCHER_REPAIR.md) | 独立闭包、同版本入口修复与未提交数据回退分开；旧版只读计划不表示已自动迁移 |
| 打包、运行时与发现规则 | [Windows 打包](../../scripts/package-windows-portable.cjs)、[源码发现](../../scripts/source-files.cjs)、[公开文档清单](../public-files.json) | 新助手与修复依赖纳入统一发现和准确包清单；私钥、身份、运行目录及备份不得进入发行包 |

## 实施与交付顺序

以下按依赖列出已实现的源码边界及其完成条件。源码专项、准确包验收、部署和公开发布分别留证；不能把源码完成等同于整包能力已可发布。

| 顺序 | 工作与依赖 | 完成条件 |
|---|---|---|
| 1 | 已有维护能力协商、原安装根与版本根、单次事务和业务提交点源码 | 旧外层能力不足能被识别；全链路绑定同一安装、操作、目标与恢复点，不建立竞争的状态所有者 |
| 2 | 已在清单、票据、暂存和激活链贯通签名，提供发布侧显式签名 | schemaVersion:1 保留旧字段；新客户端拒绝无签名/无效签名，首次公钥由可信交付内置，未知密钥不自动信任 |
| 3 | 已有固定入口、独立版本目录、退出后助手与锁交接源码 | 原安装身份和数据路径不变；服务有可信清理证明，旧托盘和 runner 确实退出后才激活，交接期间不会双启动 |
| 4 | 已有整套激活、启用前验证、持久提交与一次回退源码，依赖前述事务、验签与交接 | 默认 120 秒、就绪后稳定 15 秒；提交前不开放业务，失败先确认退出再恢复；提交后不自动恢复旧数据 |
| 5 | 已有中断恢复与独立“修复启动器”依赖闭包源码，便携构建交付独立 Node 和许可证 | 主 EXE 不可用时仍能检查同一事务；只在证明可靠时恢复，未知结果与回退失败保留现场，不自动重放 |
| 6 | 已有旧版只读计划与自动迁移拒绝、签名源上线顺序；首次成功迁移待独立维护与准确包验证 | 旧版无法证明安全退出时转独立维护；先准备签名源再推广新客户端，不通过降级校验迁就旧源 |
| 7 | 完成准确包 Windows 原生隔离验收，再按交付范围更新指南/API/发布说明 | 证明整套启动器实际更新、原快捷方式有效和数据不变；每项证据区分源码、准确包、部署和发布 |

## 不可绕开的边界

- 安装锁与桌面身份绑定原安装根，候选目录只承载程序版本；不能直接双击候选 EXE 形成另一套安装与数据默认值。
- 签名、哈希与文件身份检查涵盖退出后的最终激活；准备时的校验通过不能代替激活时的复核。
- 完整停机、备份与交接记录是激活前提。退出或变更结果未知时停止自动处理，不强制杀进程来制造“已退出”。
- 新版启用前验证必须同时阻止 HTTP、WS、预约和其他后台业务入口；先持久提交成功记录，再开放业务。开放后回退另走维护流程，保留最新数据。
- 自动回退最多一次，恢复前保留失败数据现场。恢复中断、证明缺失或固定入口损坏时，修复入口也遵守相同互斥和核验规则。
- 真实维护不得由承载当前执行的实例内 Agent 重启自身服务。私钥独立加密保管，不进入仓库、日志、包或更新源。

## 验证入口与尚缺的覆盖

下表列出已有可复跑入口及其用途，具体断言与替身以代码为准。已有源码专项与合成夹具不能代替 Windows 准确包和真实托盘验收，具体结果须按当前源码、环境和日志核对。

| 验证层 | 已有入口 | 本功能需要补齐的证明 |
|---|---|---|
| 清单、票据与候选 | [更新服务](../../test/pi-update-service.test.js)、[签名清单与票据](../../test/pi-update-signatures.test.js)、[维护](../../test/pi-maintenance.test.js)、[便携包更新](../../test/pi-portable-update.test.js) | 签名绑定与篡改拒绝、新旧清单兼容、准备后修改、能力不足拒绝外层激活 |
| 安装所有权与进程交接 | [安装锁](../../test/pi-installation-lock.test.js)、[桌面协议](../../test/pivane-desktop-protocol.test.js)、[受控停机集成](../../test/pivane-desktop-control.integration.test.js) | 服务/runner/托盘/助手交接、不同入口竞争、清理未知与交接中断，不能只模拟 PID 消失 |
| 独立修复与旧包边界 | [修复专项](../../test/pi-launcher-repair.test.js)、[准确旧包只读检查](../../test/release/launcher-legacy-migration.cjs) | 已有拒绝未知 owner、同版入口修复、独立依赖和旧包缺协议检查；实际首次迁移仍须准确包维护验收 |
| Windows 原生与恢复 | [原生桌面](../../test/pivane-desktop-native.test.js)、[桌面恢复](../../test/pivane-desktop-recovery.test.js)、[应用更新](../../test/pi-application-update.test.js) | 文件占用、固定 EXE 替换、原件变化、助手依赖独立性、真实入口损坏后的修复 |
| 原生 QA 隔离环境续传 | [环境校验器](../../server/pi-launcher-qa-context.js)、[托盘启动前校验 CLI](../../scripts/launcher-qa.cjs)、[轻量契约测试](../../test/pi-launcher-qa-context.test.js) | 双标记绑定原安装根、run 和私有路径；runner→助手→固定 EXE 只传校验白名单；真实进程链仍需准确包验收 |
| 打包与发现 | [Windows 打包](../../test/windows-portable-package.test.js)、[签名交付](../../test/portable-signed-delivery.test.js)、[小型布局夹具](../../test/portable-infrastructure.test.js)、[签名 CLI](../../test/update-signing-cli.test.js)、[源码发现](../../test/source-files.test.js)、[文档清单](../../test/public-documentation.test.js) | 助手/修复器/公钥完整入包，私钥及运行数据排除，源码与原生二进制清单一致 |
| 桌面 UI | [版本页](../../test/browser/pi-updates.cjs)、[原生托盘](../../test/browser/pivane-desktop-tray.cjs)、[真实桌面启动](../../test/browser/pivane-desktop-launcher.cjs) | 退出前后进度、整套版本展示、重开原入口、失败与需人工恢复状态；网页替身不能代替原生替换验证 |
| 准确包整链 | [便携包验收](../../test/release/windows-portable.cjs)、[网页一键更新](../../test/release/portable-auto-update.cjs)、[内网更新演练](../../test/release/gitlab-portable-update.cjs) | 签名新旧准确包、各持久状态中断、启用前失败回退、提交后保留新数据、旧包首次迁移与固定入口修复 |

Node 专项使用 `npm test -- <文件...>`，浏览器专项使用 `npm run test:browser -- <脚本...>`；先按[开发流程](WORKFLOW.md)确认选择器、独立身份、平台与执行范围。准确包脚本的参数和环境按 [E2E 导航](E2E.md#手动服务实机与准确包入口)及脚本本身读取，不把普通源码测试当成最终包验收。本页导航变更只需文档检查，无需启动真实服务。

原生 QA 必须显式提供 `PIVANE_NATIVE_QA=1`、canonical scope 和小写 UUID run ID，并预建相同 JSON 的 `scope/.pivane-native-qa.json` 与原安装根 `.pivane-launcher-test`。标记中的 14 条授权路径均须存在且位于私有 scope 内；不得包含凭据、任意 Node 选项或浏览器执行开关。Windows 还须预建私有 `HOME/AppData` 和固定 `scope/permission-tmp`；后者仅供只读 DACL 查询的临时文件使用，不属于应用路径白名单。校验器检查真实 DACL、内核路径和完整文件身份；初次托盘在 identity/start/browser 前验证，失败只向 stderr 报错，不授予 smoke 权限或写 smoke 回执。没有 QA opt-in 时，两个交接点继续使用原最小产品环境。

旧版迁移材料的已核验身份见[设计记录的代码事实](design/launcher-auto-update.md#代码事实与现有边界)。本地 1.7.3 ZIP 的哈希匹配不代表它等同于用户当前部署，也不代表迁移已经通过；准确包路径与运行证据须在实施时重新核对。

## 交接与文档维护

1. 接手先检查 Git 状态，区分源码、旧运行实例与候选准确包，保留已有改动；不要用旧归档覆盖本地未发布修复。
2. 从上表读取对应所有者与测试，记录当前工作阶段和真实经过的层；不因已有相邻测试就宣称新机制完成。
3. 新代码与测试通过统一发现入口纳入；协议变化更新 API，实现后再更新用户指南和 CHANGELOG。设计决定仍以[设计记录](design/launcher-auto-update.md)为主，本页只维护路径、依赖与完成条件。
4. 验证按[矩阵](WORKFLOW.md#验证矩阵)和[复用规则](WORKFLOW.md#验证结果复用与失效)执行，报告通过、失败和缺口。准确包绑定 SHA256，部署和公开发布分别执行相应门槛。

返回[仓库 Wayfinder](../../WAYFINDER.md)、[模块导航](MODULES.md)、[开发文档入口](README.md)。
