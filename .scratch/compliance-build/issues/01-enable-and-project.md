# 01：启用能力并建立首个工程项目档案

**Spec:** [合规审查实现规格草案](../spec.md)

**What to build:** 用户在内置能力设置中启用合规审查，完成专用智能体和模型的首次配置，通过专用聊天建立工程项目档案，并能重开后继续使用。业务状态、受管工具、设置 UI 和公开接口形成首条可验证流程。

**Blocked by:** None (can start immediately).

**Status:** done

- [x] 默认关闭；实例开关覆盖入口与服务端执行资格，启用不发起检查。
- [x] 首次配置持久绑定专用档案，再次配置不重复创建，用户名称与行为说明保留。
- [x] 普通聊天不新增合规提示、Skill 索引和工具定义，专用会话资格经过真实绑定验证。
- [x] 用户可以建立与读取稳定 ID 的工程项目档案，包含已确认身份、类型、阶段及适用清单，未知字段保留未知。
- [x] 受保护私密状态使用修订与稳定操作 ID，重开服务可读取，失败不报告成功。
- [x] 专用工具、四个 Skill、设置和档案操作通过 HTTP、真实 RPC 与桌面/手机的相关验证。

## 实施与验证

- 业务状态归 `ComplianceService` 与受保护账本所有。设置、工程项目与专用聊天创建都有稳定操作编号、修订和持久回执。原生聊天保持 Pi 唯一事实来源。
- 受管加载器在发现和注册前核对真实专用档案绑定。四个 Skill 和 `compliance_project` 只进入合格会话；工具执行再次验证存活 worker 与原生绑定。
- `npm test -- test/pi-compliance.test.js`：3/3。`test/pi-compliance-runtime.test.js`：真实 Pi RPC 与合成供应商请求捕获 1/1，含工具执行、目录摘要、禁用和会话创建幂等。
- `test/source-files.test.js` 与 `test/pi-worker-lifecycle.test.js`：专项及上述 HTTP 合计 12/12。
- `npm run test:browser -- test/browser/pi-compliance.cjs`：1440 与 393 两种宽度通过，含实际受认证服务、跨聊天修订冲突后恢复、字面文字、安全 DOM、表单宽度和 pageerror 检查；浅色桌面与深色手机截图人工核对。
- `npm run check:docs`：90 份公开文件；`git diff --check` 通过。部分首次加载受本机系统延迟影响，原失败和诊断保留在仓库外实施记录。
- 仅源码交付。未部署、未发布；后续资料、规则、扫描、复核和报告由其余实施票负责，未关闭旧规划票。

