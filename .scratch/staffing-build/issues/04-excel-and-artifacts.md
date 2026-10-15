# 导入 Excel 差异并按需保存成果

**What to build:** 用户导入标准 Excel 核对人员与占用差异；按需导出带版本的 Excel，并保存到独立成果中心。

**Blocked by:** 在专用聊天推荐人员并通过卡片预占。

**Status:** completed

- [x] 有合成标准模板，原件有预算安全读取，不执行公式或宏。
- [x] ID、重名、日期和旧版本差异明确，未确认不改台账。
- [x] 导出绑定一致台账版本，工作表和值可往返核对。
- [x] 生成、交付和独立保存状态分别报告，沿用来源授权。
- [x] 保存成果失败不误报成功，不撤回已成功人员安排。

## 实施与验证记录

- 已实现固定六表 XLSX、合成模板、独立受限完整解析、原件上传与来源校验、初始化/后续差异计划，以及生成来源与既有成果管理的独立保存。新增代码保持在独立 Excel/import 模块；确认继续由共同 StaffingService 拥有。
- 原生 `origin` 仍为严格 delivery 契约。新生成文件使用 `origin:null` 和类型化 `provenance.kind:staffing-export`；服务端不写活跃 JSONL，不伪造原生交付。页面和专用工具共用导出操作。
- 初始红：公开服务缺少 Excel 模块；随后缺少 export/upload；真实 HTTP 缺少 Excel routes。各片均在实现后通过对应公开行为检查。
- `npm test -- test/staffing-excel.test.js test/staffing-excel-http.test.js test/staffing-runtime.test.js` 曾 6 项通过，42.6 秒：含真实专用 worker 调用导出、实际供应商请求隔离、正常删除来源会话后独立成果仍可读。
- 相关专项（原件解析、上传、成果服务/库、源码发现、调配和 Excel）曾 54 项通过，49.6 秒。后续收口改动待串行复验，不以旧结果宣称当前全部通过。
- 独立 bundled Python/openpyxl 成功打开实际生成的六表文件，并确认 `=1+1` 单元格为字符串；未新增运行依赖。
- Chromium Excel 完整流程在 1440/393/320 三尺寸曾通过，10 秒，检查 pageerror、实际宽度、手机 16px 控件和真实成果字节。随后新增的 JSON 折叠及样式收口需要复验。
- 宿主内存压力期间的后续浏览器批次失败：Excel 在首次页面导航超时；初始化 1440px 完整通过后，393px 在启用按钮稳定等待超时。这些不计作通过，没有增加 timeout 或删除断言。按集成负责人安排等待唯一 QA 窗口。
- 源码尚未部署、发布或导入真实人员。最后状态与提交哈希在收口完成后补充。

## 最终串行复验（锁定依赖独立安装后）

- 实施提交 `d207405`；引导收口 `91d0a6a`；最终修复 `ae62a9b`；已合并集成分支至 `ea33a13`（本分支 merge `9395eca`）。未升级依赖、应用版本或部署实例。
- 两个新增红测依次失败：新鲜导出 R 的导入预览误把准备后的 R+1 当作源基线；修复后，新安排与一同导入的请假重叠未被拒绝。各自保留失败记录，没有放宽断言或提高 timeout。分别改用计划准备前修订作旧版本比较，以及共享日期规则检查新增不可用日期。已有同人同项目安排与如实登记的请假仍能保留。
- `npm test -- test/staffing-excel.test.js test/staffing-excel-http.test.js` 最终 5/5 通过，8.9 秒。覆盖完整六表往返、未确认不修改、重名 ID、公式/宏/资源预算、已释放历史、跨事业部限制、可用性，以及成果独立保存与失败状态。
- `npm test -- test/staffing-runtime.test.js` 最终 1/1 通过，35.3 秒。真实隔离受管 worker 调用 `staffing_ledger_status` 核对 ready/当前修订/计数，并实际导出；普通/其他助手供应商输入没有调配 Skill 与工具，正常删除来源会话后独立成果继续可读。
- `npm run test:browser -- test/browser/pi-staffing-excel.cjs test/browser/pi-staffing-initialize.cjs` 最终 2/2 通过，分别 31 秒和 20 秒，均覆盖 Chromium 1440/393/320。保留 JSON 高级折叠并实际打开检查；Excel 上传、差异、显式确认、初始核对和真实成果字节完成。检查 pageerror、横向宽度、手机 16px。Excel 脚本为隔离组件壳；整站卡片/成果导航由生命周期票继续核查。
- 已目视该批 Excel 1440/393 与完整初始化壳 320 截图；按钮、文字和面板在窄屏内。截图由测试 runner 保存到临时的 `pivane-browser` 目录，精确本机路径在私有交接记录，不写入公开指南。
- `npm test -- test/staffing-adjustments.test.js test/pi-artifacts.test.js test/pi-artifacts-library.test.js test/pi-document-parser.test.js test/pi-document-uploads.test.js test/source-files.test.js` 最终 53/53 通过，140.1 秒。原有 unmanaged file descriptor warnings 仍有输出；无失败或取消。未将这些专项称作全量回归。
- `npm run check` 通过，611 个源码文件；`npm run check:docs` 通过，81 个公开文档；`git diff --check` 通过。最终整体回归及两轴审查仍由集成票执行。
