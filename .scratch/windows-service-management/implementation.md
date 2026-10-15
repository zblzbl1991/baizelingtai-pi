# Windows 服务管理实施

Tracker: local-markdown
Status: resolved
Completed: 2026-10-16
Integration: codex/windows-service-management
Baseline: 6fcedc9dd5e5e52e029c6ed29c9eec9d7a3833a4

依据 [已解决的规划地图](map.md) 和 [实施接口](implementation-contract.md)。基线包含用户现有公开源码，原工作区保持不变。每项通过其验收后改为 resolved；地图的 resolved 只表示决策完成。

| Ticket | Status | Depends on | Scope / acceptance |
|---|---|---|---|
| backend-stop | resolved | — | 21ee206；统一完整性/阻碍投影、私有 IPC、一次性最终检查和可逆停机门；保留预约策略；38 项后端/装配专项通过 |
| desktop-runtime | resolved | — | 5e14e56；短命受控 runner、代次与 IPC、180 秒预算、等待页只读重连；30 项专项及 Chromium 桌面/手机恢复通过 |
| native-management | resolved | — | A 原生控制窗、常驻托盘、稳定只读等待入口；源码/EXE/manifest 同步；真实 Chromium 与 Medium 令牌 8/8 原生夹具通过 |
| integration | resolved | backend-stop, desktop-runtime, native-management | 真装配启停/清理证明、桌面/手机、Medium 原生及文档完成；最终全量 827 项，696 通过，129 失败和 2 取消逐项匹配旧基线，无新增回归 |
| review | resolved | integration | Standards 与 Spec 双轴独立复核无剩余发现；见 [review](review.md)，含工作台 WS 保持打开的停机回归 |

部署、真实服务重启和公开发布不在本次实施授权内。原生实机验收使用独立合成身份。

## 源码交付与验证

全部规格已实现并合入同一集成分支，最终可执行源码固定在 `21b568c`（运行修复合入点 `fad24f8`，后续仅关闭 tracker/review 元数据）。双轴独立复核无剩余发现，完整说明见 [review](review.md)。

最终验证使用独立的本地依赖目录：全量 Node 827 项，696 通过、129 失败、2 取消；131 个失败／取消均与前功能基线的逐项错误一致。旧 Codemode import seam 一项在依赖改为物理目录后通过，不将其冒认为本功能修复。先前发现的工作台 WS 导致维护停机挂起已修复，真实备份／重启在最终全量中通过。**全量仍有历史失败，不能表述为全量通过。**

Chromium 桌面／手机 2/2、真实 EXE 启动／重复入口／退出、Medium 权限原生 8/8、625 文件语法、88 份公开文档检查均通过；生产依赖审计 0 漏洞。已完成源码／EXE／manifest 绑定检查与 trial 打包。证据、精确输入和日志哈希保留在本地忽略的 `validation-*`、`normal-local-evidence` 和 `exe-local-evidence`，不进入发行包。普通权限测试为同账户受限令牌及合成 runner，未宣称真实供应商、其他系统或正式准确包安装／升级／恢复已验收。

原工作区的源码与后续并发改动未被覆盖，尚未合并回原工作区、部署或发布。收尾归档误沿依赖 junction 删除的共享依赖已按原 lock 恢复，27,893 文件逐字节零差异；集成工作区改为独立物理依赖，恢复后完整重验。辅助 worktree 已清理，保留本集成 worktree 供审阅。
