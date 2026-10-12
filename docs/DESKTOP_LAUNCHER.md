# 白泽灵台 Windows 托盘启动器

启动器适用于 Windows 上手动启动的白泽灵台实例：双击启动、等待服务就绪、自动打开默认浏览器，关闭浏览器后服务仍在托盘运行。

## 首次使用

1. 按 [Windows 安装指南](WINDOWS.md) 准备 Node.js 22、Git Bash 和 ripgrep，在程序目录执行一次 `node scripts/install.cjs`。已有安装成功的目录不用重复安装。
2. 配置应用目录的 `.env`，沿用实际 Pi 身份、媒体、预约与项目范围。推荐按安装指南将数据放在应用目录之外，所有指定的数据路径必须为绝对路径。启动器不会复制认证或迁移已有数据。
3. 双击根目录 **白泽灵台.exe**。服务就绪后自动打开默认浏览器；默认地址为 `http://127.0.0.1:11408`，实际地址以启动配置与托盘状态为准。
4. 在系统托盘（可能收在折叠区）找到白泽灵台图标。双击图标或选择“打开白泽灵台”重新打开网页；“查看本次日志”打开本次启动的服务日志。

重复双击同一安装目录的启动入口，只唤起已有托盘的网页；启动尚未完成时等待实际就绪。不同程序占用端口时启动失败，不结束占用者，也不把对方页面当作白泽灵台打开。

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

脚本使用统一公开源码清单生成快照，从官方地址下载固定版本的运行环境并核对 SHA256，随后用包内 Node/npm 在独立目录锁定安装生产依赖。不会复制当前 `node_modules`、`.env`、身份或运行数据。`dist/portable-cache` 缓存经校验的下载；缓存不进入交付包。构建需要网络和 Windows 自带 `tar.exe` / `curl.exe`，无须预装 7-Zip。结果为 `dist/pivane-<版本>-windows-x64-portable-<时间戳>.zip` 及同名 `.sha256`，不会覆盖已有包。

`scripts/windows-portable-assets.json` 是运行环境版本、下载地址和哈希的唯一清单。更换运行环境版本须重新验证。包内 `PORTABLE_MANIFEST.json` 记录源码归档哈希和全部应用、依赖、工具文件哈希；原始第三方许可证保留，来源见 `PORTABLE_NOTICES.txt`。

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

托盘交互参考 [dsh-tray-launcher](https://github.com/fancr-code/dsh-tray-launcher) 的 PowerShell/Windows Forms 方案，本项目独立实现。服务由现有 ManagedLauncher 启动；服务日志与私有 LF 状态消息分开；退出通过托盘拥有的 stdin 管道进入统一异步停机，不通过端口或命令行特征寻找并强杀进程。

同目录托盘通过当前用户会话内的 Mutex 与 EventWaitHandle 合并重复启动，安装级别的最终互斥仍由 ManagedLauncher 持有。Node 确认自身子服务的 IPC 就绪消息，并检查 HTTP 访问状态，才通知托盘打开页面。启动失败不报告成功。

原生验证目前针对 Windows x64；此入口不宣称 macOS 或 Linux 托盘支持。源码完成、独立实例验收和正式发行分别记录。
