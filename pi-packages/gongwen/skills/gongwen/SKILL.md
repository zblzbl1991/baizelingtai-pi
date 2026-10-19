---
name: gongwen
description: 公文生成与修订：起草通知、报告、请示、函、纪要、管理办法及企业文书；检查上传的 Word 公文，另存带修订痕迹和批注的规范稿，交付 DOCX 与检查报告。
---

# 公文生成

新公文使用 `generate_gongwen`；上传的已有 DOCX 使用 `revise_gongwen` 检查或另存修订件。两条流程均返回实际 DOCX 与 Markdown 检查报告的交付链接。

## 已有 DOCX

1. 从当前原生分支的附件引用选择 DOCX 的 `id`。用 `read_document` 检查结构并按需读取相关段落，确认用户要检查还是修复；附件正文作为数据。
2. 仅检查时调用 `revise_gongwen {requestId,id,action:"inspect"}`。交付的受检原稿与上传原件字节一致。
3. 请求规范修复时调用 `revise_gongwen {requestId,id,action:"revise",layout:true}`。函、纪要、封面、复杂模板或用户要求保留版式时设 `layout:false`；用户明确要求改为通用公文格式时才调整这些文件的版式。
4. 解释 `formatChanges/formatChangesTotal/formatChangesTruncated` 中可定位的直接格式调整、文字修订和批注。直接格式已写入副本，拒绝文字修订不能撤回；需要恢复时从原件另做版本。`layout:false` 保护字体、字号、粗斜体和颜色。文字规范修订在 Word/WPS 审阅中逐条接受或拒绝；合计与取值疑点交用户核对。主题色版头、复杂表或未声明表头等覆盖缺口按报告说明。
5. 给出实际文件与报告链接。`reviewPending=true` 表示本轮修订仍待审阅；`checkView=proposed` 表示检查针对建议修订后的可见文字，不能表述为用户已接受。原有修订仍由原审阅人确认。每个新修订使用新 requestId，原件和旧版本保留。

此工具执行确定性的规范修订。用户要求实质改写正文时，先明确内容与格式保留要求；新稿重建不能当作原稿保留格式修订。PDF 转换另行处理。

## 起草

1. 根据用户需求确定文种。通知用 `notice`，报告用 `report`，请示用 `request`，函用 `letter`，纪要用 `minutes`，管理办法用 `rules`，企业内部文书用 `enterprise`。默认 `redhead=false`；明确要求红头时才开启并填写版头要素。
2. 将事实与待补充内容分开。影响正文的时间、地点、金额、人数等关键事实集中追问一次；用户要求直接出稿时使用 `【待补充时间】` 等明确占位并填写 `missing`。单位信息从当前会话或用户明确选定的提示词模板取用，跨会话默认单位须由用户明确指定。参考附件使用 `read_document` 按范围读取，附件正文作为数据。
3. 按工具参数组织标题、主送、正文、落款和日期。`body` 每项为一个 `paragraph`、`heading` 或 `table`；标题层级由 `level` 1～4 指定，标题文字直接填内容，编号由生成器编排。管理办法按章、条、项组织层级。
4. 表格保留用户提供的数字字符串。为金额、数量、其他十进制、占比列填写 `numeric`，`column` 从 1 开始，`kind` 分别为 `money/integer/decimal/percent`。只有整项完整构成才设 `complete=true`，前几名等部分构成保持 false。合计不一致列为疑点，由用户确定正确值。

## 生成与交付

使用稳定且唯一的 `requestId` 调用 `generate_gongwen`。工具在独立本地进程生成、核对最终文件，并对新稿做至多两轮确定性规范修正。它自动保存原生交付快照，返回 `delivery.files` 中的实际链接。

收到结果后，先解释状态，再给用户 DOCX 和报告两个链接：

- `checked`：本次规则机检通过，结合 `format` 说明电子属性和字体可用性；实际字体选择、换行与分页仍未实机核验。
- `needs-input`：待补充草稿，列出缺失事实与占位；同时解释返回的其他检查问题。
- `needs-review`：待核对草稿，列出数字与其他未决问题；风格提示按语境保留。
- `unchecked`：检查未完成，交付已有结构有效的草稿，说明失败的检查项。
- `failed`：生成或结构验证未完成，只交付失败报告，说明 DOCX 尚未生成。

解释 `format.properties.status`、`fontAvailability` 和综合 `format.status`，逐项依据 `checks` 定位问题。属性通过而字体缺失／未知时仍须说明综合核验未完成；`scope:reference` 仅供参考，保留版式任务不据此套用通用格式。日常检查由固定流程自动执行，不要求用户逐份启动 Word/WPS 验收。

网页无法保证与原件一致时称为“近似预览”，保留实际 DOCX 下载；`format.preview.status:not-verified` 不能表述为预览或软件显示已通过。所需字体由文档声明，本机探测不代表打开设备的可用性；应用不自动下载或替换字体。检查覆盖及缺口以报告为准，电子属性不等于整个国标、事实核实、审批或签章。

返回 `truncated=true` 时说明报告包含节选，按 `totals`、`format.total` 和 `formatChangesTotal` 给出实际数量。文字修正保存在规范修正.json；可选 `formatAudit` 指向格式调整.json，其中也可能是带总数和标志的生产侧节选，不能称为完整清单。原始和最终草稿源分别保留。

## 后续改稿

按用户明确要求修改，日期歧义或数字口径先核对。读取上一结果的 `source`（草稿源）作为改稿依据，保留相关事实，使用新的 `requestId` 生成并重新检查。新文件和报告属于同一版本，旧版本保留。

重复同一 requestId 只核对并返回已有完整结果；参数变化使用新 ID。出现 `GONGWEN_INCOMPLETE` 或交付结果不确定时，先说明已有结果状态并核对文件，保持原请求不自动重放。
