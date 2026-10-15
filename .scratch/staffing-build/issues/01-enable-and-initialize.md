# 启用人员调配并建立初始台账

**What to build:** 用户从默认关闭状态启用能力，通过引导建立专用智能体与初始人员台账，核对后可以查询；重新启用继续使用原数据。

**Blocked by:** None (can start immediately).

**Status:** implemented

- [x] 能力默认关闭，启用、待核对、就绪、停用状态准确可查。
- [x] 私密台账原子保存、版本和幂等操作结果可恢复。
- [x] 专用档案按稳定业务绑定恢复，不按名称重复创建。
- [x] 初始人员与占用核对后才允许正式安排。
- [x] 具备可操作的最小引导界面和隔离 HTTP 行为验证。

## 实现边界

- `server/staffing/service.js` 统一启停、初始化核对、请求回执、生命周期和就绪门槛。
- `server/staffing/store.js` 使用原生描述符身份、私密目录与文件权限、目录锁、CAS 和原子替换。8 MiB 上限；人员 5000、业务项目 5000、占用 20000、持久操作 10000、历史 20000 条。超限失败，保留旧台账，不静默清理。
- `server/staffing/validation.js` 校验稳定 ID、严格日期、记录预算和初始项目重叠。
- `PiProfileRegistry.ensureManagedProfile('pivane-staffing:v1', template)` 在档案注册表内原子保存稳定业务绑定。保留已有档案及用户编辑，不设置普通聊天默认档案。
- `server/staffing/routes.js` 挂载到已有 workspace auth/Origin 边界；gateway 增加能力声明、活动、维护空闲和统一停机投影。
- `public/pi-staffing.js/.css` 提供 `#/staffing` 初始化页面，扩展发现页提供始终可发现的入口，启用后显示更多菜单入口。支持 JSON 文件/文本导入、完整数据核对、回到初始数据修改、显式确认及停用恢复。
- 本票不提供推荐、安排卡片、专用工具/Skill 装配、三视图和 Excel；由依赖本票的实施票扩展。`requireReady()` 已提供后续写操作的就绪门槛。

## HTTP 契约

- GET `/api/pi/staffing/status`、`/ledger`、`/operations/:requestId`。
- POST `/api/pi/staffing/enable`、`/initialize`、`/confirm-initial`、`/disable`。
- 写操作均要求 `requestId` 和整数 `expectedRevision`。同编号同参数返回原结果；异参拒绝；未完成操作仅查询状态，不自动重放。
- 初始数据为 `people[{id,name,department,direct}]`、`projects[{id,name,department,owner,start,end,minimum}]`、`occupancies[{id,personId,projectId?,kind,state,start,end,reason?}]`、`historyComplete`。
- 初始核对要求 `reviewed:true`。状态为 `disabled`、`initializing`、`awaiting-import`、`awaiting-review`、`ready`。初始化中返回原始初始化请求参数以支持显式恢复。

## 验证记录

环境：Windows x64，Node v24.19.0，锁定依赖；独立临时身份、合成数据；未部署、未接触真实会话。

- 红：`npm test -- test/staffing-initialization.test.js` 因缺少 service 模块失败；增加最小实现后绿。HTTP 切片先因缺少 routes 模块失败，再转绿。浏览器切片先因缺少启用按钮失败，再转绿。
- `npm test -- test/staffing-initialization.test.js test/source-files.test.js test/pi-native-integration.test.js`：退出 0，19 项通过，26.7 秒。覆盖真实 auth/Origin、持久回执、CAS、并发、Windows DACL、私密路径及共享原生接入。
- `npm test -- test/staffing-initialization.test.js test/pi-i18n.test.js`：退出 0，10 项通过，83.7 秒。包含初始全流程、中断恢复、维护/停机、损坏/超预算/链接拒绝和语言目录校验。
- `npm test -- test/staffing-initialization.test.js test/pi-profile-edit.test.js test/source-files.test.js`：退出 0，9 项通过，124.1 秒（前序切片，档案行为未再改变）。
- `npm run check`：退出 0，587 个文件。
- `npm run check:docs`：退出 0，79 个公开文档。
- `npm run test:browser -- test/browser/pi-staffing-initialize.cjs test/browser/pi-assistant-shell.cjs`：退出 0，2/2 通过（初始化 51 秒，外壳 96 秒）。初始化覆盖 1440、393、320px，中英文、安全 DOM、真实 HTTP、响应丢失后只查询原操作、修改初始数据、显式核对和停用恢复。截图保存在测试运行器选择的临时目录。
- 相邻 `pi-extension-assistant.cjs`：通过，85 秒；新增内置能力后固定卡片数从 6 更新为 7，原附件断言保留。
- 相邻 `pi-assistant-shell.cjs`：通过，96 秒。回归发现隐藏导航仍被键盘遍历，已修复可见项过滤和 hidden CSS。截图环境的外部字体等待已通过阻断测试中的字体联网消除，业务断言保留。
- 新增语言目录时出现的数组闭合符及重复条目错误已修复，保留原目录顺序，仅追加去重条目，语言专项重新通过。

所有 Node 命令仍走统一过滤入口；本机命令设置 `PSModulePath` 为系统 Windows PowerShell Modules，避免 PS7 路径污染 DACL 验证。浏览器命令设置 `PLAYWRIGHT_MODULE` 为本机 Codex runtime 的 playwright，`CHROMIUM_PATH` 为已存在的 chromium-1248 的 `chrome.exe`。未放宽文件身份、权限或业务断言。
