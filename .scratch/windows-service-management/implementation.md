# Windows 服务管理实施

Tracker: local-markdown
Status: in-progress
Integration: codex/windows-service-management
Baseline: 6fcedc9dd5e5e52e029c6ed29c9eec9d7a3833a4

依据 [已解决的规划地图](map.md) 和 [实施接口](implementation-contract.md)。基线包含用户现有公开源码，原工作区保持不变。每项通过其验收后改为 resolved；地图的 resolved 只表示决策完成。

| Ticket | Status | Depends on | Scope / acceptance |
|---|---|---|---|
| backend-stop | ready | — | 统一完整性/阻碍投影、私有 IPC、一次性最终检查和可逆停机门；保留预约策略；专项回归 |
| desktop-runtime | ready | — | 短命受控 runner、代次与 IPC、180 秒预算、等待页只读重连；专项回归 |
| native-management | ready | — | A 原生控制窗、常驻托盘与每次启停、稳定只读等待入口；原生源码/二进制/manifest 同步；合成夹具 |
| integration | blocked | backend-stop, desktop-runtime, native-management | 真装配契约与竞态、桌面/手机浏览器验收、用户/API/开发文档、全量 Node 与语法检查 |
| review | blocked | integration | Standards 与 Spec 双轴独立 review；修复后关闭全部票据 |

部署、真实服务重启和公开发布不在本次实施授权内。原生实机验收使用独立合成身份。
