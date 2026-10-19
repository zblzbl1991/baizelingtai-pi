# 白泽灵台内置能力包

当前源码锁定 Pi 1.2.0，随应用交付子 Agent、档案记忆、网页搜索与阅读、桌面操作、guizang-ppt 演示文稿技能、文档一致性审查、公文生成和 OfficeCLI 编辑，由白泽灵台验证后统一更新。精确组件版本以 `server/pi-bundled-capabilities.js`、`vendor/manifest.json` 和 `config/officecli.json` 为准，Pi 版本以根 package.json 为准。已发布归档的依赖与验收仍以其版本说明为准，源码完成不表示运行实例已经更新。

## 网页、桌面与演示文稿

这三项无需在扩展助手中另行安装。“扩展 → 发现”显示“白泽灵台内置”，可从“已安装”分别启停，保存后在空闲会话重载资源或新开运行实例。旧 npm/Git 包声明保留并映射到内置版本，避免重复加载。

- **搜索与阅读网页**：内置 pi-web-access 0.39.0，提供 `web_search`、`fetch_content` 和结果读取等工具。仍需要网络，部分搜索供应商需要用户配置；沿用实际 Agent 目录的 `web-search.json`。受管网页运行不加载上游终端搜索命令／快捷键，也不启用独立 curator 或后台抓取；先搜索，再显式读取完整网页，两步均在原生工具操作内完成。不自动获取浏览器 Cookie 或配置收费服务。
- **操作桌面应用**：内置 `@injaneity/pi-computer-use` 0.5.1 及其官方原生源码、预编译程序，提供窗口发现、观察、点击和输入等工具。操作的是运行白泽灵台的机器。打开普通聊天不安装／启动 helper 或询问权限，首次桌面工具调用时由上游准备 helper 并检查系统权限；默认 helper 位于实际身份的 `helpers/pi-computer-use/0.5.1/`，显式 helper 路径优先。Windows x64、macOS 和 Linux 的权限与图形会话要求仍由平台决定，Linux/Wayland 功能有限。macOS/Linux 跨平台实机操作尚未在本次源码验证中验收。
- **制作演示文稿**：内置归藏的原版 `guizang-ppt-skill`，固定作者提交 `c91369c449d34755d320a8b81d0734000d99d1ab`，由独立资源登记包 `pivane-presentations` 加载。主要输出杂志风／瑞士风单文件 HTML，不承诺可编辑 PPTX。技能本身安装不需要 SkillHub；模板外链字体、图标和脚本仍需网络或另行离线准备。额外 SkillHub 技能继续从用户选择的仓库安装，不自动切换来源、更新内置目录或删除既有 PPT Master。

guizang-ppt 的独立源码、模板、脚本和许可证完整保留在 `vendor/guizang-ppt-skill/`，按 GNU AGPLv3 提供；网页和桌面包按各自 MIT 许可提供。资源登记与宿主适配不改写上游文件，应用自身许可不替代这些独立组件的许可；再分发须保留对应许可证和源码。

## 公文生成

公文能力由独立 `pivane-gongwen` 包注册 `gongwen` 技能与 `generate_gongwen`、`revise_gongwen` 原生工具，默认可用，支持分别启停与重载。固定 MIT 上游 gongwen-kit 的原始目录及逐文件清单，运行依赖由根 lockfile 锁定；在无凭据独立进程生成、检查和另存带修订／批注的已有公文，原件与旧版本保留，文件与报告通过原生交付快照访问。电子属性、字体可用性与实际版面分别报告，日常检查不依赖 Word/WPS，字体不捆绑或自动替换。用法、草稿状态与边界见[公文生成](GONGWEN.md)。

## OfficeCLI 编辑

内置 `pivane-officecli` 资源包，使用固定版本原生程序与 Pi 官方 MCP，注册 `office-documents` 技能、附件工作副本工具和 OfficeCLI 文档操作。程序随应用安装／归档准备，固定来源及 SHA256 由 `config/officecli.json` 管理；运行时无自动更新，不修改用户 MCP 配置。纯文本模型可以检查内容和结构，截图检查按能力启用；用法、部署位置、平台验收和失败边界见[Office 文档](OFFICE_DOCUMENTS.md)。

## 文档一致性审查

内置原创 `document-consistency-review` Skill，由 `pivane-document-review` 资源包注册，按应用 ISC 许可提供。先输出有位置、原文依据和修改建议的问题清单，用户在聊天确认报告和问题编号后再修改；修改前复核文件版本，默认保留原件并交付修订副本。它复用当前模型、办公附件读取、原生文件工具、进度和交付物，不增加专用扩展工具、后台队列或确认票据。Office 原件编辑依赖当前实际可用能力，详见[文档一致性审查](DOCUMENT_REVIEW.md)。

此项无需另行安装；在“扩展 → 已安装”的技能资源中启停，保存后在空闲会话重载或重开运行实例。不同于发现页的第三方精选，此资源不要求访问外部仓库。

## 安装与配置

在当前源码或包含内置组件的新归档目录运行 `node scripts/install.cjs`（仅生产依赖可加 `--omit=dev`），即可安装锁定依赖、准备 esbuild、校验上游文件、构建档案记忆 bundle，并检查当前 Node 的 SQLite FTS5/trigram 支持。上游包和技能已经在归档的 `vendor/` 中，不再单独安装到 Pi 身份目录。vendor 不作为 npm workspace 安装：执行所需依赖由应用根 lockfile 锁定，不安装上游开发依赖及旧 Pi 副本。安装失败会明确返回非零退出码，不能当作组件已就绪。此前已发布且没有该脚本的归档仍按其原安装说明使用 `npm ci`。

记忆依赖 `better-sqlite3@13.0.3` 随 npm 包提供的原生二进制。在 Windows、macOS 和 Linux 的受支持目标上优先使用这些文件。普通 `npm ci` 的生命周期推断可能忽略该包的 `gypfile:false`，无谓调用 node-gyp；统一安装入口使用 `npm ci --ignore-scripts` 后显式准备所需组件，因此不会为已有可用二进制的 Windows 安装要求 Visual Studio C++。不修改第三方文件。切换 Node 或平台后重新安装依赖，不复制其他平台的 `node_modules`。

手动使用 `npm ci --ignore-scripts` 后，需依次运行：

```sh
npm rebuild esbuild --foreground-scripts
node scripts/install-bundled-capabilities.cjs
```

没有可用 SQLite 二进制的目标会在就绪检查时明确失败；若要自行支持该目标，需准备 Python 与该平台的 C/C++ 工具链，并执行上游的 `npm --prefix node_modules/better-sqlite3 run build-release`，再重新运行内置组件准备。应用更新和 Pi 受管更新也执行上述组件准备，再进行隔离探测。旧 `PI_SKIP_DEFAULT_CAPABILITIES` 和身份中的安装尝试记录不控制内置组件；`PI_OFFLINE` 不代替 npm 的依赖准备。

- 子 Agent 默认可用，模型与角色覆盖继续保存在原生 `settings.json` 的 `subagents` 字段。安装和保存设置不启动子任务。扩展页可以逐项启用、停用内置扩展、技能和提示词；开关保存为对应 `pivaneBuiltins` 组件的资源过滤，不写入版本目录绝对路径。
- 档案记忆默认使用当前应用目录的 `server/profile-memory/upstream-bundle.mjs`。仍需在相应助手身份启用记忆或学习技能；后台学习模型和开关沿用原规则。无身份和临时会话不会因此获得记忆工具。
- Packages 中的内置资源登记包显示白泽灵台与版本，不提供独立更新或移除。内置包的安装、更新、移除 API 请求返回管理说明。升级整个白泽灵台才会切换组件版本。

## 旧安装兼容

原有 npm、Git 和可识别的本地同名包声明及文件保留，CLI 继续使用自己的安装。白泽灵台在加载前将子 Agent、网页和桌面包来源映射到内置版本，并保留资源过滤和全局／受信项目优先级；旧上游记忆默认扩展不加载。子 Agent 的后台与前台子会话也使用这套资源选择规则。父会话和子任务都不会因为两个来源同时存在而重复执行旧包工厂。

原来的 `pivane-profiles/runtime.json` 不重写。可用的内置记忆 bundle 优先；没有可用内置 bundle 时，仍按旧校验规则尝试已配置的独立 bundle。数据继续位于原 Pi 身份的 `pivane-profiles/data/`，原生 JSONL 仍是会话事实来源。旧的独立安装目录可以保留作回退，本次安装不删除它。

已打开的 worker 继续运行原先代码；在任务完成后重开运行实例，才能核对新版本。恢复旧应用版本前，核对记忆数据库兼容性；不能用代码回退替代数据备份与迁移验证。

## 上游与适配边界

`vendor/manifest.json` 记录官方 npm 发布包或作者源码归档的 URL、版本／提交、SHA256、许可证以及逐文件 SHA256。子 Agent 官方发布包为编译后的 JavaScript、声明、source map、文档和资源；记忆包含 TypeScript 源码。目录内容保持发布包原样。`scripts/vendor-files.cjs` 校验字节和普通文件身份，发行和受管源码快照均使用同一清单；不会递归收集 vendor 下的依赖、缓存或用户文件。

`server/pi-bundled-capabilities.js` 是白泽灵台的接入清单；`pi-bundled-resources.js` 在内存中生成受管资源视图；`pi-managed-runtime.mjs` 使用 Pi 的公开 SDK 与原生 RPC，保留 Supervisor 的唯一 worker 和原生身份。资源重载复用同一个原生 ResourceLoader 及其缓存清理生命周期。RPC 的会话和工具接口使用公开 SDK；代理与 HTTP 空闲超时初始化复用当前 Pi 的 `dist/core/http-dispatcher.js`，这一 CLI 初始化接口也需随 Pi 升级复核。

子会话适配通过上游 child-session factory 和精确 import 映射接入已连接的 Pi 原生 MCP 目录，保留信任、资源过滤和嵌套权限 gate；上游拥有任务生命周期与存储。内部接口绑定 Pi 1.2.0 和 pi-subagents 0.78.0，升级须重新复核，不修改上游文件。实现入口见[模块导航](development/MODULES.md)，授权与兼容见[原生 MCP](MCP.md)。

记忆适配继续只导出选定的存储、检索和工具组件，禁止调用上游默认 factory；生成 bundle 必须匹配已审查 SHA256，所有上游许可证随包保留。

## 维护更新

1. 下载精确的官方发布包，核对来源与完整性；在独立目录导入原始文件，更新逐文件清单，保留许可证。
2. 审查上游差异、Pi 协议、child-session factory 接口和数据库结构；只在白泽灵台适配层调整。
3. 更新接入清单、锁定依赖与 bundle 校验值，验证干净安装、旧声明过滤、资源重载、前后台子任务、记忆读写／检索／隔离及数据恢复。
4. 完成 Node、语法、文档、生产依赖审计、打包和相关桌面／手机回归，从准确归档执行独立安装；目标平台范围单独记录。
5. 随白泽灵台发布，保留上一版本及数据备份。未来包可加入接入清单，但需明确采用原生包加载还是组件适配，不自动加载所有 vendor 内容。
