# Windows 原生整包升级验收

[验收脚本](../../test/release/native-launcher-update.cjs)只在 Windows x64 使用显式准确包运行。每次选择一个场景，输出目录必须不存在。它不会构建、覆盖归档或连接已有实例。源码检查、准确包结果、部署和发布分别记录；脚本存在不代表任何包已经通过。已有服务更新脚本不能代替本入口的真实托盘与退出后助手链。

## 输入

需要新旧完整 ZIP 及各自 SHA256、候选准确 ZIP 对应的 Ed25519 已签清单、临时 `qa-*` 公钥信任文件、独立 Chromium 和 Playwright。已签清单的 package/release 链接使用相对路径，脚本通过 loopback 提供相同字节。私钥不作为脚本输入，也不写入输出。`target-changed` 另外要求 `--changed-manifest`，它必须也是同一 QA 信任根下有效签名的不同目标。

```powershell
node test/release/native-launcher-update.cjs --previous-archive D:/qa/previous.zip --previous-sha256 <64位小写SHA256> --previous-version 1.7.99 --baseline-kind synthetic-qa --archive D:/qa/candidate.zip --sha256 <候选SHA256> --signed-manifest D:/qa/release.signed.json --qa-trust D:/qa/public-trust.json --output D:/qa/run-001 --browser D:/qa/chrome.exe --playwright D:/qa/node_modules/playwright --scenario normal
```

`--baseline-kind` 必填：`synthetic-qa` 表示另行准备的合成低版本，`published-new-protocol` 表示有对应发行证据的新协议准确旧包，`historical-legacy` 只允许 `legacy-refusal`。现有原生编译和托盘握手要求三段数字版本；例如另行构建的 `1.7.99 → 1.8.0` 可以作为 QA 基线，不能称为历史正式 1.7.3。源码提交与构建记录由验收者另外关联到准确包哈希；脚本不隐式 overlay 当前源码。

成功自动链要求两个包都含本版严格 QA 续传与检查点代码、完整依赖、协议 1 和独立 repair 闭包。缺少能力记为 unsupported，不能用外部托盘 peer、直接构造 ManagedLauncher 或开发依赖 junction 补成准确包成功。外部验收器自身使用源码环境与显式 QA 浏览器依赖，应用、runner、SDK 和修复 Node 均来自已核验的准确包。

## 真实链与隔离

脚本串行核验两个 ZIP 及完整解压库存；每个场景使用全新中文、空格和 `&` 路径安装根，以及私有身份、原生会话、项目、媒体、预约、HOME/profile/temp 路径。QA 公钥只经显式本地输入安装到该合成原根，并记录变更；候选包所带公钥仍受其原始完整库存约束，不改变准确 ZIP。两处最小环境续传由[严格 QA 上下文](../../server/pi-launcher-qa-context.js)验证，QA 开关不进入正常 runtimePaths。

正常链使用真实固定 EXE、.NET/PowerShell 托盘、同包 Node runner/service、维护 review 与一次 execute、真实进程 HANDLE 助手、自动重开的新托盘和磁盘 commit。提交前检查 HTTP 写入/读取及 WS 拒绝，核对五项证明、真实稳定 15 秒与默认 120 秒期限，提交后才检查业务可用。随后正常停机，再从原 `.lnk` 打开目标版本，并检查重复快捷方式仍进入原 owner。不会打开用户默认浏览器；截图来自脚本显式启动的隔离 headless Chromium。

原生 SessionManager 负责构造、打开和核对合成 JSONL；检查 ID、完整分支和书签、原绝对路径及原文件字节。故障回退在验证检查点写入一份明确的候选增量，证明失败快照保存其准确字节，成功恢复后的原数据路径不包含该增量。没有模型或供应商请求；后台验证只覆盖原生初始化健康证明，不宣称真实任务调度或供应商已验收。

## 场景

| `--scenario` | 实际故障层与断言 |
|---|---|
| `normal` | 完整自动链、组件/runtime 路径、原快捷方式、数据及实际清理 |
| `missing-signature` / `invalid-signature` / `foreign-key` | 只改变 loopback 清单签名，真实 review 的私有诊断须是签名拒绝，旧服务与 active 不变 |
| `target-changed` | 确认后换另一个有效已签目标，实际 stage 目标重查拒绝 |
| `corrupt-download` | 传输完整已声明字节数，但确定改变一个字节，实际 SHA256 校验拒绝；不能把网络超时记为预期成功 |
| `staged-mutation` / `unpublished-source` | 确定检查点改本轮候选副本，或改合成原根受登记源码，真实库存/源码保护拒绝 |
| `occupied-entry` / `old-tray-held` | 真实文件占用使替换失败；或暂停旧真实 owner 退出，验证助手等待、无竞争启动，释放后继续 |
| `unknown-cleanup` | 真实清理后省略 IPC 证明，产品仍保持未知；先持 service HANDLE 证实退出，才单列精确身份的 forced fixture teardown，不补产品 clean:true |
| `interrupt-prepared` / `interrupt-activating` / `interrupt-rollback` | 在真实助手持有进程证明与对应持久阶段后暂停，仅通过相同已核对 FILETIME/EXE 的可终止 HANDLE 中断本轮合成助手；原包 repair 诊断且不重放 |
| `validation-failure` / `validation-timeout` / `recovery-failure` | 有效签名完整库存候选和真实新托盘，检查点拒绝/等待原期限；真实退出后一次回退；或确定移走已知备份对象使恢复失败 |
| `repair-entry` / `repair-changed-entry` | 真正提交与停机后删/改固定 EXE，隐藏原根主依赖；使用包内 repair 自身 Node 修复，核对保留原件字节、active 和最新数据 |
| `postcommit-preservation` | 真正 commit 后新增数据，再请求独立回退，必须拒绝且保留最新字节 |
| `legacy-refusal` | 准确历史 ZIP 的只读计划与自动迁移拒绝；不启动旧进程，不宣称迁移或原生语义已验收 |

检查点只读取严格授权私有 scope 的固定文件，命令一次消费，resume 绑定新回执 nonce；托盘命令同时绑定 runId、instance 和 generation。它们不提供公共 HTTP 控制、不跳验签/库存/锁/HANDLE，也不改变正常产品流程或产品时间预算。严格 QA 使用明确清理命令，不沿用旧 smoke 的 120 秒自动结束或无代次 stop 文件。

## 结果与清理

`result.json` 记录准确包/清单/公钥哈希、外部验收器闭包哈希、host Node/OS/架构、实际浏览器版本、各阶段与每代原生回执。未选场景为 not-run；只有本场景实际断言完成才 passed/退出 0，failed 退出 1，unsupported 退出 2。取消、无关网络/SDK 失败、未知故障原因不能记为预期场景成功。

默认在真实清理及 held HANDLE 退出后删除两个大程序树，保留小数据、回执、状态证明与截图；`--retain-success yes` 保留程序树。所有递归删除前重新核对绝对目标仍位于本轮私有 scope。首次失败保留现场，未知结果不自动重试；若仍有未证实退出的子进程，保留并明确清理需求。期望缺失清理证明的用例单列 forced-fixture-teardown，不能将其当成产品清理证明。

目前场景不覆盖 committed 父 runner 与 tray 同时硬崩溃、旧 service 异步清理尚未结束时的新 owner 竞争风险；`service-cleanup-pending` 仅预留观察点。该风险仍须独立修复与真实验收，不能由正常停机或 postcommit-preservation 替代。中断后只运行实际独立 repair 诊断，未重新打开可能弹出 MessageBox 的错误 EXE，因此错误界面也不在本入口覆盖内。

执行前按[开发流程](WORKFLOW.md#验证矩阵)核对资源、空闲、准确输入和验收范围；一次只运行一个重型场景。源码通过不代替最终准确包整链和公开发布门槛。
