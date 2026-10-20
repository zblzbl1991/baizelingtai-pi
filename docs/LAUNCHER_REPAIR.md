# 独立修复入口与旧版维护迁移

独立修复程序用于主启动 EXE 不可用时检查同一次升级。它保持原安装身份，使用原安装锁、签名信任和完整文件证据；不根据窗口关闭、PID 消失或退出码 0 推断可以恢复数据。整包升级的产品边界见[设计记录](development/design/launcher-auto-update.md)。

本文描述源码中的 CLI。便携包仍须完成独立闭包、公钥交付和准确包验收，不能仅凭源码工具存在就认定旧版迁移成功。打包验收边界见[发布流程](development/RELEASING.md)。

## 从独立程序开始诊断

完整便携交付将修复 Node 和全部代码放在原安装根的 `repair/`，不加载主 EXE、原程序的 Node 或 `node_modules`：

```powershell
& '.\repair\runtime\node.exe' '.\repair\scripts\repair-launcher.cjs' diagnose 'D:\Apps\pivane'
```

开发源码可用 `node scripts/repair-launcher.cjs diagnose <原安装绝对根>`。输出一行 JSON。默认诊断不改安装状态、不启动服务、不恢复数据。安装锁被当前桌面 owner 持有时，先通过该桌面入口正常停止；修复器不强制杀进程。

`healthy` 表示当前入口与已验签 active 程序一致；`entry-missing` 可按返回的 activationId 修复。`entry-changed` 要先核对原件，再显式确认替换。`manual-recovery` 表示证据不完整、文件变化、未完成的替换/回退、未知验证 owner 或之前修复结果不明；保留现场，不修改状态来制造“空闲”。

## 修复已提交版本的入口

已 committed 的版本只恢复为**同一个 active 已签名版本**的固定 EXE，不切回旧版本，不恢复升级前数据，不改变 runtimePaths：

```powershell
& '.\repair\runtime\node.exe' '.\repair\scripts\repair-launcher.cjs' restore-entry 'D:\Apps\pivane' '<activation-id>'
```

现有 EXE 内容已变化时，默认拒绝覆盖。核对诊断中的目标版本与范围后，可显式使用 `--replace-changed`；程序先将变化原件保存到该事务的私有 `entry-repair/<repair-id>/previous-entry.exe`，再仅替换固定入口。目标正在被占用、文件身份在操作中变化或原子替换失败时，留下未完成记录，后续只诊断，不自动重放。

每个 activation 最多自动执行一次入口修复；成功后重复请求仅报告已健康。再次损坏进入人工维护。修复完成不自动启动程序，核对结果后再打开原快捷方式。已开放业务后的所有最新数据保留原处。

未 committed 的 validating 状态只有在从未出现验证 owner，且旧代清理、准确进程退出、原件和完整备份证明齐全时，才允许恢复同一个候选入口。出现过未知 validationOwner 或 needsRecovery 时拒绝此操作，不能清除 owner 后重试。

## 启用前失败的数据回退

独立 CLI 的 `rollback-handoff <root> <activation-id>` 消费原 runner 已持久保存的 failureShutdownProof 和 failureHandoffProcesses，并从 stdin 读取同一组准确 Windows PID/创建时间。它在旧对象仍可打开时持有 HANDLE，发出 ready 后才允许 runner/托盘退出；实际退出并接管原安装锁后，复用更新助手的至多一次回退。

该入口由可信桌面维护链交接使用，不接受 `--assume-stopped` 或操作者手写的“已停机”标志替代证明。已经丢失 HANDLE、清理结果未知、备份不完整、回退中断或已经 committed 时，不能借此恢复旧数据。恢复实现和证据边界见[助手源码](../server/pi-launcher-activation.js)。

## 1.7.3 的独立维护路线

1.7.3 的外层启动器不能提供新协议需要的可信清理证明。即使 active 服务显示新版本、旧窗口已经关闭、进程不见或状态写了 succeeded，也不直接执行自动迁移。

先准备一个私有 scope JSON，**逐项填入原实例实际使用的绝对路径**，不要把示例路径当成默认数据位置：

```json
{
  "schemaVersion": 1,
  "runtimePaths": {
    "PI_CODING_AGENT_DIR": "D:\\Data\\original-agent",
    "PI_MEDIA_DATA_DIR": "D:\\Apps\\pivane",
    "PI_MEDIA_CONFIG_DIR": "D:\\Data\\original-media-config",
    "PI_WEB_DEFERRED_FILE": "D:\\Data\\original-deferred.json"
  },
  "backupRoots": ["D:\\Apps\\pivane", "D:\\Data"],
  "backupDirectory": "E:\\OfflineBackup\\pivane-before-migration"
}
```

backupRoots 必须覆盖全部 runtimePaths、实际配置、会话、媒体、历史和 prompts；备份目录须在原安装和全部数据范围之外。路径有别名或范围不全时先核实，工具不会猜测用户目录。不要输出配置文件正文或凭据。

```powershell
& '.\repair\runtime\node.exe' '.\repair\scripts\repair-launcher.cjs' legacy-plan 'D:\Apps\pivane' --scope 'E:\Private\migration-scope.json'
```

计划列出外层/active 服务版本、固定路径、必需备份、逐项程序变更，以及 `LEGACY_CLEANUP_UNPROVEN`。它不创建备份、不提取新程序、不改 EXE、state、会话或快捷方式。`migrate-legacy` 明确拒绝自动执行；不能把计划输出当成迁移完成记录。

独立人工维护须完成以下步骤后才能切换：

1. 在承载当前工作之外安排停机维护，核对全部任务、Shell、侧聊、预约、媒体、配置及导入导出，正常停止。旧版无法提供新清理证明时，不继续在线助手；进入能独立确认全部写入方已停止的离线维护环境，保留未确定的工作结果，不强制终止来冒充清理完成。
2. 备份原安装、state 的未知字段及 scope 内全部现存数据和配置；保留 Windows 实际私有 DACL、原件和完整备份清单。验证备份字节数/哈希、范围、会话 ID/时间/完整分支/书签/正文及媒体历史语义。备份不完整不修改程序。
3. 从独立可信渠道取得完整新版与初始公钥，核验目标签名、准确包 SHA256、完整库存和运行时。目标程序放入原根下独立 release 目录，保持原安装根和四个实际 runtimePaths。该目录还须具备经过受管安装验证生成的完成标记；单纯复制解压目录不足以激活，不能手写完成标记来冒充验证。缺少可用的独立维护安装路径时停在原版本，不能直接把候选目录当新安装启动。
4. 按计划逐项变更：添加完整 release；安装独立 repair 闭包和稳定根公钥；仅在原件备份后替换固定 EXE；在同一原 state 保留未知字段，设置经过核验的 active/previous 和原始绝对路径。记录每个原件、目标哈希和实际变更结果。此人工维护过程不伪造 activation、validationOwner、cleanup 或 HANDLE 证明。
5. 使用独立维护身份验证程序，先核对 native 会话和备份语义，确认新组件版本、原快捷方式和数据路径，再结束维护。若任一步结果不明，停止并按原件/备份清单人工恢复；不要先打开真实业务后再自动倒回旧备份。

这些是独立人工维护要求，不是已自动执行的脚本。准确 1.7.3 的专项只证明选定旧包的协议缺失、版本差异识别和自动迁移拒绝；成功迁移、真实首次启动和完整新协议升级仍须单独准确包验收。

## 开发与验收入口

- [修复模块](../server/pi-launcher-repair.js)的 `repairFiles(programRoot)` 枚举独立代码/native 闭包；Node 由便携构建另外核验并复制为 `repair/runtime/node.exe`，不能依赖待替换的 runtime。
- [本机专项](../test/pi-launcher-repair.test.js)覆盖未知 owner、同版本入口修复、数据保留、独立闭包和明确替换原件。
- [准确旧包检查](../test/release/launcher-legacy-migration.cjs)只提取指定代码文件并核对原清单，不运行旧版服务；输出包含包哈希、合成部分和未执行的迁移验收。
