# 白泽灵台 Windows 托盘启动器

启动器适用于 Windows 上手动启动的白泽灵台实例：双击后先打开默认浏览器显示启动页，服务就绪后同一标签页自动进入工作台，关闭浏览器后服务仍在托盘运行。

## 首次使用

1. 按 [Windows 安装指南](WINDOWS.md) 准备 Node.js 22、Git Bash 和 ripgrep，在程序目录执行一次 `node scripts/install.cjs`。已有安装成功的目录不用重复安装。
2. 配置应用目录的 `.env`，沿用实际 Pi 身份、媒体、预约与项目范围。推荐按安装指南将数据放在应用目录之外，所有指定的数据路径必须为绝对路径。启动器不会复制认证或迁移已有数据。
3. 双击根目录 **白泽灵台.exe**。浏览器先显示“正在启动”，服务真正就绪后同一标签页自动进入工作台，不再显示原生启动窗口或托盘气泡。工作台默认地址为 `http://127.0.0.1:11408`，实际地址以启动配置与托盘状态为准。
4. 在系统托盘（可能收在折叠区）找到白泽灵台图标。双击图标或选择“打开白泽灵台”重新打开网页；“查看本次日志”打开本次启动的服务日志；“重启服务”正常停止并重新加载当前运行版本，托盘入口保留。

重复双击同一安装目录的启动入口，启动中打开已有实例的等待页，就绪后打开工作台。不同程序占用工作台端口时启动失败，不结束占用者，也不把对方页面当作白泽灵台打开。

启动页由启动器在临时本地地址提供，先于工作台初始化显示，跟随浏览器的系统明暗主题；只有受管服务的就绪消息和 HTTP 检查都通过才跳转。失败时页面显示错误，启动器仍保留错误提示，不自动重新启动或重放任务。关闭浏览器不取消启动。临时地址仅用于本次启动，请收藏就绪后的工作台地址；就绪后启动页监听最多保留两分钟，正常退出时一并关闭。`-NoOpen` 禁止自动打开浏览器，托盘菜单仍可在启动中打开等待页。

Windows 的安装级互斥使用按实际安装目录命名的系统独占管道，不再占用 TCP 锁端口，因此系统保留端口不会阻止取得安装锁。启动、备份恢复和离线会话迁移共用这把锁；进程退出后系统自动释放，不需要清理旧 PID 或锁文件。临时启动页遇到端口占用或拒绝监听时会换端口，最多尝试 32 次；工作台本身仍使用保存的端口，失败时不自动改配置或重启服务。

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

控制台启动成功后可按 **R** 重启服务，按 **Q** 正常退出，与托盘菜单执行相同流程。控制台输入被重定向时不读取快捷键。

`-NoOpen` 禁止首次自动开浏览器，托盘菜单仍可手动打开。`-NodePath` 可指定 Node 可执行文件。EXE 调用同一 PowerShell 托盘脚本；执行策略选项仅作用于此次进程，不修改系统策略。组织策略禁用 PowerShell 脚本时使用管理员允许的部署方式。

## 重启服务与开发代码重载

先保存网页草稿、完成任务并暂停预约，再选择托盘“重启服务”或在控制台按 R 并确认。服务会检查任务、Shell、侧聊、预约执行、媒体、配置与文件操作；仍有工作时提示暂不能重启，当前服务继续运行。检查等待期间不会重复提交，等待超时不等于取消。

允许重启后先阻止新工作并暂停延迟发送，再等待统一异步停机完成。只有旧服务和它的 Node 启动进程都正常退出，才启动全新的 Node 进程；托盘本身保留，默认不额外打开浏览器。每次启动保留独立日志。停机或新启动失败会明确报错，不自动重试、不重放任务。

开发环境直接运行源码目录且未切换到受管快照时，修改服务端代码后重启即可加载新代码，不必关闭并重新打开控制台。网页代码修改后还需保存草稿并刷新网页；托盘脚本或桌面启动入口本身有修改时，需正常退出托盘后重新打开。重启沿用实际运行版本和原身份、媒体、会话与配置路径；如果当前使用受管发布快照，修改安装根目录的源码不会替换该快照，也不会因重启切回旧版本。旧运行版本尚未声明支持托盘重启时，会提示先正常退出并重新打开启动入口；更新源码后首次启用新菜单，也需要重新打开一次旧托盘。

## 正常退出

先保存草稿、结束 Agent/Shell/侧聊/媒体与配置操作，并暂停预约，然后在托盘选择“正常退出”并确认。托盘显示正在等待，直到服务与 worker 实际退出才消失；重复退出不会重跑清理。

不要把强制结束进程、关闭诊断窗口或结束计划任务当作正常停机。托盘进程意外退出时，私有控制管道断开会请求正常停机，但断电与系统强制结束不保证清理完成。启动器不自动重放失败任务，也不自动重启异常退出的实例。

日志位于原安装目录的 `.pivane-runtime/desktop/service-<运行标识>.log`，使用项目已有的私密文件权限与输出脱敏机制。每次启动新建日志，不覆盖旧日志；分享前仍须检查私人内容，按自己的保留策略管理日志。

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
node scripts/install.cjs
npm run pack:windows
```

脚本使用统一公开源码清单生成快照，从官方地址下载固定版本的运行环境并核对 SHA256，随后用包内 Node/npm 在独立目录锁定安装生产依赖。不会复制当前 `node_modules`、`.env`、身份或运行数据。`dist/portable-cache` 缓存经校验的下载；缓存不进入交付包。构建需要网络和 Windows 自带 `tar.exe` / `curl.exe`，无须预装 7-Zip。结果为 `dist/baizelingtai-<版本>.zip` 及同名 `.sha256`、`.update.json`；解压顶层目录为 `baizelingtai-<版本>`，中文文件名使用明确的 ZIP UTF-8 编码标记。同名 ZIP 或配套文件存在时构建拒绝覆盖，应先保存或移动旧包再构建。

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

构建成功不等于发布：先按准确 ZIP 的验收流程验证，再把 ZIP 上传到公开 Generic Package Registry；随后将生成的 `.update.json` 内容作为项目的 `updates/latest.json` 提交。发布操作由维护者完成，构建脚本不登录 GitLab、不上传。Package Registry 须允许匿名下载。若用仓库原始文件分发 ZIP，把 ZIP 与清单放在同目录即可使用默认相对地址。完整检测规则及失败边界见[内网更新源](UPDATES.md#gitlab-与内网-windows-更新源)。

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

托盘交互参考 [dsh-tray-launcher](https://github.com/fancr-code/dsh-tray-launcher) 的 PowerShell/Windows Forms 方案，本项目独立实现。服务由现有 ManagedLauncher 启动；服务日志与私有 LF 状态消息分开；退出与重启通过托盘拥有的 stdin 管道进入统一异步停机，不通过端口或命令行特征寻找并强杀进程。重启前通过绑定当前子进程、nonce 和请求 ID 的私有 IPC，复用网页维护的空闲检查并同步锁定；只有已确认的重启且旧启动进程退出码为 0、输出管道已排空时，托盘才启动一次新的 Node 进程。不新增公开 HTTP 停机／重启接口。

同目录托盘通过当前用户会话内的 Mutex 与 EventWaitHandle 合并重复启动，安装级别的最终互斥仍由 ManagedLauncher 持有。Node 先通过私有 LF 响应 `waiting` 提供临时启动页 URL，再启动受管服务；`ready` 表示自身子服务 IPC 和 HTTP 访问状态都已核实，并提供实际工作台 URL。托盘只在首次 `waiting` 时自动打开浏览器，`ready` 更新托盘状态和启动页，不再打开第二个标签页。临时页只监听 `127.0.0.1`，只提供固定静态资源及只读 `/status`（`starting`、`ready` 或 `error`），校验 Host/Origin，不提供停机或配置接口。失败页先交付错误，再有界关闭临时监听；启动失败不报告成功。

原生验证目前针对 Windows x64；此入口不宣称 macOS 或 Linux 托盘支持。源码完成、独立实例验收和正式发行分别记录。
