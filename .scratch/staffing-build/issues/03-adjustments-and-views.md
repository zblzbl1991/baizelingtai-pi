# 处理请假与安排变更并核查三个视图

**What to build:** 用户登记请假、调整日期和人员、释放安排，通过可用人员、项目安排和人员日历视图核查真实覆盖。

**Blocked by:** 在专用聊天推荐人员并通过卡片预占。

**Status:** completed

- [x] 请假如实记录并立即显示对应项目的逐日人数和直签缺口。
- [x] 改期、换人、撤回和提前结束均展示差异并经确认提交。
- [x] 预占不自动过期，取消释放对应未来占用并保留历史。
- [x] 三个视图与聊天读取同一台账，达标与全部确认分别显示。
- [x] 桌面和手机均可完成核查及手动调整。


## Implementation and validation

- Implemented in source only. No deployment, publication, real personnel import or live service restart.
- Public behavior covers truthful absence and daily gaps, existing reservation formalization without duplicate occupancy, 3-of-5 staffing completed by 2 additions, future replacement/reschedule/extension/release, retained elapsed workload/history, page authority, stale plans and a server-calendar boundary.
- TDD red evidence: missing views; unsupported formalize/replacement/reschedule; missing browser view; a replacement borrowing scope leak; and a release plan becoming retrospective overnight. Each received a public behavior correction.
- Final narrow Node run passed 12/12: staffing-adjustments 7 and i18n 5. Earlier adjacent plans/initialization/recovery/source-discovery/documentation behavior and actual managed supplier-request isolation passed and were reused within their unchanged scope.
- Chromium views passed at 1440/393/320. The first final cards run timed out on the duplicate-card P2 interaction. It had full candidate DOM and no pageerror, but disabled/geometry values were not captured then. A diagnostic-only rerun kept all original assertions and timeouts and passed the complete duplicate/in-flight plus 1440/393/320 script in 24 seconds. The first failure remains unexplained; it is not proven to be environmental. Both logs are retained for final integration review.
- Browser screenshots cover arrangement plans/results, absence changes, project gaps and personnel views at all three widths. Safe DOM, actual widths and mobile 16px inputs passed. The 320px change and arrangement screenshots were visually inspected.
- Syntax passed for 603 files; documentation check passed for 81 public files at this ticket's verification tip. Final integration merges peer Excel work and will receive the planned shared regression.
