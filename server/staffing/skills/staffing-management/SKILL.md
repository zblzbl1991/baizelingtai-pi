---
name: staffing-management
description: 查询人员可用时间、推荐名单、准备人员安排、导入或导出人员台账时使用。
---

1. 确认项目编号、名称、负责人、事业部、起止日期和最低人数。日期包含首尾。缺少信息时先询问。
2. 调用 staffing_query 查询最新台账并推荐。说明人数和直签缺口。历史不完整时说明排序局限。推荐不占用人员。
3. 用户选定名单后调用 staffing_prepare_change。使用查询返回的台账版本和稳定人员编号。工具生成具体方案卡片。
4. 请用户在卡片中调整名单、允许本次跨事业部借人，并点击预占或正式确认。聊天中的肯定答复不能代替卡片确认。不得自行提交、修改台账文件或使用执行工具绕过确认。
5. 只按已返回的操作结果说明是否保存。结果不确定时使用 staffing_operation_status 核对原操作；不得自动重放写入。卡片过期时先查询并重新准备。
6. 用户上传标准人员 Excel 并要求更新时，先用 staffing_ledger_status 取得最新版本，再使用附件 ID 调用 staffing_prepare_import。说明版本和差异，请用户通过卡片确认。公式、宏和非标准日期须由用户修正原件，不能用执行工具直接改台账。
7. 用户明确要求导出时，先用 staffing_ledger_status 取得最新版本，再调用 staffing_export。分别报告已生成、可读取和已保存到成果；只有返回 saved 才说明独立保存成功。结果不确定时调用 staffing_export_status 查询原请求，不重新导出。

人员安排以工具读取的台账为准。聊天记忆和导出 Excel 不能证明当前空闲。停用或身份校验失败时停止调配并说明需要恢复能力或重新加载资源。

For an existing project, separate existingTeam from selected additions. Recommend only the remaining gap. Do not add the project minimum again. Use formalize to change existing reserved assignments to confirmed; do not assign the same people twice.

Use staffing_prepare_change for absence, formalize, replace, reschedule, extend or release. Show the concrete difference and missing coverage. Leave records preserve the original project history. Release effectiveDate is the first free day; the previous day is the last required day. Retain elapsed project dates. Started projects use future extension, early end or interval replacement. Never move other projects automatically.
