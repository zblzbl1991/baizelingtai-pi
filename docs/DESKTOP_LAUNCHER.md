# 白泽灵台 Windows 托盘启动器

启动器适用于 Windows 上手动启动的白泽灵台实例：双击后先打开默认浏览器显示启动页，服务就绪后同一标签页自动进入工作台，关闭浏览器后服务仍在托盘运行。

## 首次使用

1. 按 [Windows 安装指南](WINDOWS.md) 准备 Node.js 22、Git Bash 和 ripgrep，在程序目录执行一次 `node scripts/install.cjs`。已有安装成功的目录不用重复安装。
2. 配置应用目录的 `.env`，沿用实际 Pi 身份、媒体、预约与项目范围。推荐按安装指南将数据放在应用目录之外，所有指定的数据路径必须为绝对路径。启动器不会复制认证或迁移已有数据。
3. 双击根目录 **白泽灵台.exe**。浏览器先显示“正在启动”，服务真正就绪后同一标签页自动进入工作台，不再显示原生启动窗口或托盘气泡。工作台默认地址为 `http://127.0.0.1:11408`，实际地址以启动配置与托盘状态为准。
4. 在系统托盘（可能收在折叠区）找到白泽灵台图标。双击图标打开“服务管理”紧凑窗口；右键菜单也可打开管理窗口、工作台和本次日志。管理窗口默认隐藏，关闭或最小化只会隐藏窗口，服务继续运行。

管理窗口显示已核实的实际应用与引擎版本，尚未取得运行信息时明确显示未核实。“版本与更新”打开现有工作台，并提示进入“设置 → 版本与更新”；管理窗口本身不执行升级。

重复双击同一安装目录的 EXE，启动中打开当前等待页，运行时打开工作台，已正常停止时启动新一轮服务。停机中只显示管理窗口里的进度，不排队重启。清理结果未知时禁止新启动，请从管理窗口查看状态和日志。不同程序占用工作台端口时启动失败，不结束占用者，也不把对方页面当作白泽灵台打开。

启动页先于工作台初始化显示，跟随浏览器的系统明暗主题；只有当前受管服务的就绪消息和 HTTP 检查都通过才跳转。单次状态请求超时或断线时显示重新连接并退避查询，不重新启动服务。明确启动失败时保留错误；用户在同一托盘中显式重新启动后，原等待页可跟随新一轮服务进入工作台。关闭浏览器不取消启动。

托盘在其存续期间持有稳定的本地只读等待地址，停止服务后也保留。退出整个托盘后该地址关闭；再次启动托盘不保证旧地址仍有效，请双击 EXE 或从当前托盘打开入口。等待页不扫描端口、不接管其他实例。收藏地址请使用就绪后的工作台地址。`-NoOpen` 禁止首次自动打开浏览器，托盘菜单仍可手动打开。

桌面服务整体启动默认最多等待 180 秒。较慢时先显示耗时提示，继续等待同一次启动；达到上限后报告失败并有序收尾，等待服务实际退出，不自动重试。在 `.env` 中可设置 `PIVANE_DESKTOP_START_TIMEOUT_MS=180000`，必须为 10000—900000 毫秒的十进制整数。此设置只影响桌面服务启动，和单次状态查询、线程 worker 的 `PIVANE_WEB_STARTUP_TIMEOUT_MS` 分开。

Windows 的安装级互斥使用按实际安装目录命名的系统独占管道，不再占用 TCP 锁端口，因此系统保留端口不会阻止取得安装锁。启动、备份恢复和离线会话迁移共用这把锁；进程退出后系统自动释放，不需要清理旧 PID 或锁文件。等待入口遇到端口占用、权限拒绝或落入服务保留范围时，会在预算内尝试随机备用端口；原生入口最多 64 次，旧单轮 Node 入口最多 32 次。工作台本身仍使用保存的端口，失败时不自动改配置或重启服务。

从旧版 TCP 安装锁升级时，先正常停止旧版，再使用整套新版启动和维护脚本；不要在同一安装目录混用旧版运行进程与新版恢复／迁移工具。

需要桌面快捷方式时，在程序目录执行一次：

```powershell
.\白泽灵台.exe --create-shortcut
```

之后双击桌面 **白泽灵台** 即可。快捷方式使用程序图标并指向 EXE，已有同名快捷方式不会被覆盖；移动程序目录后需自行更新快捷方式。EXE 使用 .NET Framework 4；源代码、已构建二进制与构建校验清单随包提供。旧 VBS 入口继续保留兼容。

有错误时双击 **启动白泽灵台.cmd**，控制台显示启动和服务输出。也可运行：

```powershell
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File scripts/desktop-tray.ps1 -ConsoleMode
```

`-NoOpen` 禁止首次自动开浏览器，托盘菜单仍可手动打开。`-NodePath` 可指定 Node 可执行文件。EXE 调用同一 PowerShell 托盘脚本；执行策略选项仅作用于此次进程，不修改系统策略。组织策略禁用 PowerShell 脚本时使用管理员允许的部署方式。

## 停止服务与退出程序

管理窗口和托盘提供两个操作：**停止服务**完成后保留托盘与管理窗口，可再次点击启动；**退出白泽灵台**在同样的有序停机完成后关闭托盘。

操作先检查服务端的任务、Shell、侧聊、子任务后台保留、媒体、预约派发和配置等状态。有阻碍时列出类型、数量及可用的定位信息，本次请求结束；在工作台手动处理后重新检查。仍然打开的空闲侧聊也会阻碍停机。状态读取不完整时不能确认停机。窗口不会替你取消任务，也不会等空闲后自动执行。

检查通过后，保存浏览器草稿和未提交编辑，停止使用同一身份数据的外部进程，再勾选确认。确认期间工作台仍可使用；提交时服务端重新检查，期间发生过工作变化就需要重新确认。接受前可取消；接受后关闭窗口只隐藏，不取消收尾。重复点击只显示同一次操作的状态。只有服务、worker 和本轮启动进程实际退出且清理已核实，才显示停止完成；超时、断线和端口空闲都不等于停止成功。

停止不会永久暂停或改写预约配置。离线期间沿用各任务既有的 `skip` / `latest` 规则；明确配置的 `latest` 可能在宽限期内补最近一次。过期延迟消息按原规则重新确认，结果不确定的任务不自动重放。管理窗口会在确认前提示预约影响；需要改变预约行为时先在工作台设置。

不要把强制结束进程、关闭诊断窗口或结束计划任务当作正常停机。托盘进程意外退出时，私有控制管道断开会请求正常停机，但断电与系统强制结束不保证清理完成。启动器不自动重放失败任务，也不自动重启异常退出的实例。

日志位于原安装目录的 `.pivane-runtime/desktop/service-<运行标识>.log`，使用项目已有的私密文件权限与输出脱敏机制。每次启动新建日志，不覆盖旧日志；分享前仍须检查私人内容，按自己的保留策略管理日志。

## 启动器整包更新

支持新协议的 Windows 便携托盘在“版本与更新”页分别显示实际启动器和后台服务版本。整包更新先校验发布签名、ZIP 与文件清单，正常停机并备份后，由独立助手持有本轮 runner、托盘的准确 Windows 进程 HANDLE。助手确认两者实际退出后才取得原安装锁、替换固定 EXE 并切换版本；原快捷方式继续指向原入口。新版托盘、Node、脚本及服务来自同一版本目录，数据、配置、信任根、运行锁和日志仍归原安装目录。

首次打开候选时工作台业务保持关闭，默认在 120 秒内核对私有控制通道、实际组件版本、HTTP 就绪、原生会话／预约／延迟消息读取和托盘实际装载证明，就绪后稳定观察至少 15 秒，再持久提交并开放业务。可在 `.env` 设置 `PIVANE_ACTIVATION_TIMEOUT_MS`，范围 15000—900000 毫秒；该预算包括启动与验证。验证不会给真实会话发送测试消息。页面和托盘显示等待退出、验证、回退或需要人工恢复的状态。

提交前失败，仅在候选清理获证、runner 与托盘均退出后尝试一次恢复，先保留失败数据现场。结果不明、退出无法证明或恢复失败时保留所有权并停止自动操作；提交成功并开放工作后，不自动恢复旧备份。中断的旧式候选启动若已可能写入数据，也不直接启动旧版覆盖现场。

没有新协议的旧外层仍只具备原服务更新能力，页面会明确提示；带新版 EXE 的更新包本身不会给旧外层补上交接能力。旧版迁移和独立修复入口另按[设计与实施导航](development/LAUNCHER_UPDATE_WAYFINDER.md)推进。本节描述源码行为，不表示准确 Windows 包已验收、实例已部署或版本已发布。

## 与后台服务的关系

托盘和 [后台服务](BACKGROUND_SERVICE.md) 是两种启动方式。同一目录已有后台服务安装记录时，托盘拒绝启动，避免建立第二个服务所有者。继续使用原后台服务的桌面入口；需要切换时，先按后台服务指南正常停止并卸载，保留全部用户数据。

托盘不注册开机启动、不提权、不修改防火墙或浏览器默认设置。用户注销后不保证继续运行。

## 随包运行环境

### Windows x64 便携版

便携 ZIP 内已包含 Node、npm、Git Bash、ripgrep、fd 和按 lockfile 安装的应用依赖。用户将完整 ZIP 解压到可写目录，双击 **白泽灵台.exe** 即可打开工作台，不用运行安装命令。首次使用仍需在“供应商与模型”中配置自己的账号；包中没有维护者认证或用户数据。

便携版要求 Windows 10/11 x64、自带 Windows PowerShell 5.1、.NET Framework 4 和默认浏览器。它不注册系统服务或修改系统 PATH，也不包含模型权重、GPU 服务、Python 或其他项目自己的开发环境。

默认身份位于 `data/agent`，媒体位于 `data/media`，媒体配置位于 `data/media-lab`，预约文件位于 `data/pivane-deferred-messages.json`。启动时根据当前解压目录计算绝对路径，`.env` 和显式环境配置仍优先。正常退出后备份整个目录；移动已有目录不会改写原生会话中的项目路径。使用过的目录含个人账号与数据，不要重新发给别人。

维护者在 Windows x64 源码目录执行：

```powershell
npm run pack:windows
```

这一条命令会先按 lockfile 准备构建依赖和内置能力，再核对 Windows 启动器；版本、源码或构建清单不匹配时自动重建并复核，无需另外执行安装或 EXE 构建命令。应用版本仍取自 `package.json`，不会自动升版本。

脚本使用统一公开源码清单生成快照，从官方地址下载固定版本的运行环境并核对 SHA256，随后用包内 Node/npm 在独立目录锁定安装生产依赖。不会复制当前 `node_modules`、`.env`、身份或运行数据。`dist/portable-cache` 缓存经校验的下载；缓存不进入交付包。构建需要网络和 Windows 自带 `tar.exe` / `curl.exe`，无须预装 7-Zip。最终生成 `dist/baizelingtai-<版本>-offline.zip`，拷贝这一个文件到内网即可。外层 ZIP 包含应用包 `baizelingtai-<版本>.zip`、校验文件 `baizelingtai-<版本>.zip.sha256` 和更新清单 `updates/latest.json`；清单路径与默认 GitLab 自动检测地址一致。`dist` 另外保留应用 ZIP 及同名 `.sha256`、`.update.json`，外层包中的 `updates/latest.json` 与该 `.update.json` 内容相同。先解压外层 ZIP，再解压应用 ZIP 即可使用；应用包顶层目录为 `baizelingtai-<版本>`，中文文件名使用明确的 ZIP UTF-8 编码标记。任一同名产物存在时构建拒绝覆盖，应先保存或移动旧包再构建。

`scripts/windows-portable-assets.json` 是运行环境版本、下载地址和哈希的唯一清单。更换运行环境版本须重新验证。包内 `PORTABLE_MANIFEST.json` 记录源码归档哈希和全部应用、依赖、工具文件哈希；原始第三方许可证保留，来源见 `PORTABLE_NOTICES.txt`。

### 内网更新源与 GitLab 分发

`npm run pack:windows` 自动读取源码根目录的 `.baizelingtai-update-build.json`，存在时把该项目的公开 GitLab 清单地址写入包内 `baizelingtai-portable.json`，无需额外运行构建脚本或每个用户配置 `.env`。本机发布配置只包含项目地址，同时被 Git 和发行规则排除：

```json
{
  "version": 1,
  "gitlabProjectUrl": "http://gitlab.example/team/baizelingtai"
}
```

清单通过 GitLab API 的 `updates/latest.json` 和 `ref=HEAD` 跟随默认分支；ZIP 下载地址使用该项目的 Generic Package Registry，包名固定为 `baizelingtai`，包版本自动跟随应用版本。构建生成 `baizelingtai-<版本>.zip`、同名 `.sha256` 和 `.update.json`，清单绑定准确 ZIP 的版本、配套 Pi、字节数和 SHA256。`npm run pack:windows -- --dry-run` 只展示构建路径和更新源，不下载、打包或覆盖已有文件。没有本机发布配置时保持官方检查方式；配置损坏时明确失败。

显式 URL 参数仍可整体覆盖本机发布配置。以下域名、项目路径、项目数字 ID、版本均须替换为实际值；`{filename}` 由构建脚本替换为最终 ZIP 文件名：

```powershell
npm run pack:windows -- --update-feed-url 'http://gitlab.example/team/baizelingtai/-/raw/main/updates/latest.json' --package-url 'http://gitlab.example/api/v4/projects/20/packages/generic/baizelingtai/1.8.0/{filename}' --release-url 'http://gitlab.example/team/baizelingtai/-/releases/v1.8.0'
```

所有链接须与清单同源。`--package-url` 和 `--release-url` 可省略：包地址默认是相对清单的 ZIP 文件名，“查看更新来源”默认打开清单。只给源域名不够，必须给出能返回 JSON 的完整清单地址。也支持 GitLab repository files API 的 `.../repository/files/updates%2Flatest.json/raw?ref=main`，或 `ref=HEAD` 跟随默认分支；API 清单地址应同时显式指定 `--package-url`，避免把 ZIP 相对地址解析到 API 目录。

将 `-offline.zip` 拷贝到内网并解压后，使用其中的应用 ZIP 分发更新；SHA256 和更新清单始终绑定这个应用 ZIP。构建成功不等于发布：先按准确 ZIP 的验收流程验证，再把应用 ZIP 上传到公开 Generic Package Registry；随后将解压所得的 `updates/latest.json` 按原路径提交到 GitLab 项目，无需手动改名。发布操作由维护者完成，构建脚本不登录 GitLab、不上传。Package Registry 须允许匿名下载。若用仓库原始文件或静态站点分发 ZIP，须在构建时指定相对 `updates/latest.json` 的包地址（例如 `../baizelingtai-<版本>.zip`）或同源完整地址，避免默认相对文件名解析到 `updates` 子目录。完整检测规则及失败边界见[内网更新源](UPDATES.md#gitlab-与内网-windows-更新源)。

原来的包不会自动知道新增源；首次需要发放包含源地址的新包，或在已有实例 `.env` 中设置 `BAIZELINGTAI_UPDATE_FEED_URL`。地址由本机发布配置、构建参数或部署配置决定，不使用运行机器上维护者的凭据。旧 `pivane-portable.json` 和 `PIVANE_UPDATE_FEED_URL` 保留读取兼容，不复制或迁移既有数据。

### 隔离模拟 GitLab 更新

网页一键更新的准确包 E2E 使用 `test/release/portable-auto-update.cjs`，参数与下方演练相同（不使用 `--routine` 或源码叠加）。它在旧包真实页面点击确认，通过受管票据完成下载、备份与启动新版，并检查桌面/手机、单次提交、原生分支/书签和媒体配置字节；覆盖下载哈希、503、重定向与启动失败恢复，最后验证原入口重启新版和离线回退。旧包必须包含新更新器；仅改版本号的模拟基线不代表已发行旧版获得此能力。

维护者可用 `test/release/gitlab-portable-update.cjs` 在 Windows x64 本机模拟 GitLab repository files 清单及 Generic Package Registry 下载。脚本要求两个已核对 SHA256、版本递增的 Windows ZIP、新的报告目录，以及独立 Playwright/Chromium 路径：

```powershell
node test/release/gitlab-portable-update.cjs --previous-archive C:/qa/baizelingtai-OLD.zip --previous-sha256 OLD_SHA256 --archive C:/qa/baizelingtai-NEW.zip --sha256 NEW_SHA256 --routine --output C:/qa/new-report --browser C:/qa/chrome.exe --playwright C:/qa/node_modules/playwright
```

所有身份、会话、媒体、配置与项目都是新建的合成数据，HTTP 只监听随机 loopback 端口；下载并按所选范围校验后实际启动旧包与新包的受管服务，检查桌面/手机更新页，正常停机备份并演练回退。预构建包只在已确认下载后解压安装，不提前重复解压候选；测试等待已认证的只读 HTTP 就绪后再检查。覆盖清单不可达、登录 HTML、跨域包、字节数与哈希错误、下载重定向、下载失败和目标版本变化；不调用模型、不安装依赖、不更新真实实例、不上传发布。

`--routine` 按用户日常流程核对完整 ZIP 的字节数、SHA256、解压路径和版本，不遍历依赖逐文件哈希；省略时做完整逐文件开发验收，报告分别记录范围。旧包没有内网检测能力时，脚本用独立清单检查完成首次整包引导，升级后验证新版真实 API；旧版不具备的检测能力不记为通过。测试服务通过独立 preload 阻断非 loopback HTTP(S)，避免旧版或后台任务访问外网。

开发时可额外传入 `--source-candidate`：要求新包 lockfile 与源码一致，把统一发行清单中的当前文件叠加到新建的**模拟候选 ZIP**，重新生成逐文件清单，保留原始正式 ZIP。报告记录基础包哈希、模拟候选哈希和源码文件清单；这只能验证当前源码的局部更新链路，不能代替正式发布的准确包验收。结果与截图保存在指定报告目录，合成临时目录保留以便审查。

准确 ZIP 的独立验收入口（Playwright/Chromium 是维护者 QA 工具，不随包分发）：

```powershell
$env:PLAYWRIGHT_MODULE='C:/qa/node_modules/playwright'
$env:CHROMIUM_PATH='C:/Program Files/Google/Chrome/Application/chrome.exe'
node test/release/windows-portable.cjs 'C:/packages/portable.zip' '<实际SHA256>'
```

验收逐文件核对 ZIP，使用中文、空格与 `&` 路径，不安装依赖，移除系统开发工具 PATH；验证包内 SQLite/esbuild、真实 Pi worker 与 Bash、EXE/快捷方式、Chromium 桌面/手机、重复启动及正常停机。此专项通过表示该包的便携启动已验收；正式公开 Release 仍按[发布流程](development/RELEASING.md)完成完整验收。

启动器优先使用应用目录或其父目录下的 `runtime/node.exe`，其次查找系统 PATH 中的 Node。工具路径优先加入相应位置的 `tools/rg`、`tools/fd`、`tools/git/bin` 和 `tools/git/usr/bin`，随后使用常规安装的 Git Bash 与现有 PATH；还会从 PATH 上的 `git.exe` 定位装在其他盘符的 Git Bash。只修改当前进程的环境。

受管 Pi 的 Shell 默认通过 SDK 配置视图直接使用包内 Bash 的真实绝对路径，支持中文安装目录，避免 Windows `where` 的输出编码影响发现。用户已经配置的 `shellPath` 优先；不会改写用户设置文件或上游源码。

`pack:trial` / `pack:release` 继续生成源码包，不包含 Node、Git、rg 或 node_modules；`pack:windows` 才生成上述 Windows x64 便携 ZIP。

## 实现与参考

托盘交互参考 [dsh-tray-launcher](https://github.com/fancr-code/dsh-tray-launcher) 的 PowerShell/Windows Forms 方案，本项目独立实现。服务由现有 ManagedLauncher 启动；服务日志与私有 LF 状态消息分开。停止与退出经过托盘拥有的私有控制管道、一次性停机票据和统一异步清理，不通过端口或命令行特征寻找并强杀进程。服务停止并核实清理完成后，用户可明确启动新一轮服务以加载代码；管理窗口不提供旧版的一键重启或 R/Q 控制台快捷键。

同目录托盘通过当前用户会话内的 Mutex 与 EventWaitHandle 合并重复启动。托盘常驻，每轮服务使用新代次、新 Node runner 与新 ManagedLauncher；安装级运行锁在所属服务及 worker 清理得到私有通道证明且服务真正退出后释放，托盘的桌面互斥继续保留。退出码 0 本身不是清理证明；无法确认时保留 runner 和运行锁，防止建立新所有者。旧代次回调不能覆盖当前状态。现有受管维护在 runner 内切换服务时仍使用原来的内部代次与就绪核对。

稳定等待入口在既有原生／托盘边界中运行，不增加常驻 Node 控制服务。它只监听 `127.0.0.1`，提供固定静态资源和只读 `/status`，校验 Host/Origin 并限制请求预算。页面核对托盘实例标记后才接受状态；`ready` 仍要求受管子服务 IPC 和 HTTP 检查。停止检查和执行沿继承的 LF 管道及私有 IPC 进行，不增加公开 HTTP 停机接口，也不向托盘交付工作台凭据。直接调用旧 Node 桌面入口的兼容流程仍可使用单轮临时等待页。

原生验证目前针对 Windows x64；此入口不宣称 macOS 或 Linux 托盘支持。源码完成、独立实例验收和正式发行分别记录。
