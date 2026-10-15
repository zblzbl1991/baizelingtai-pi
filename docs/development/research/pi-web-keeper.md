# pi-web-keeper 与白泽灵台桌面入口集成评估

核查日期：2026-10-14。上游证据固定在 [NOMOAX/pi-web-keeper 的 cc13f85](https://github.com/NOMOAX/pi-web-keeper/tree/cc13f85fa1fd5cbee1ecbf91fdbdc78001dbcf5a)。白泽灵台比较基线为源码提交 `9111641222ddc4621728420ada4bac447d243b3a`，应用声明版本 1.7.2；这不代表当前运行实例或公开发行版本。

最值得借鉴的是 Windows 已安装 PWA 的启动与窗口身份识别。白泽灵台已经具备受管启动、等待页、托盘、安装级互斥和正常停机；建议在现有入口增加可选应用窗口模式，继续复用原服务所有者。以下均为源码比较与设计建议，未实现应用窗口接入，也未实机验证上游 EXE。

## 上游实际提供的能力

- [ServiceKeeper](https://github.com/NOMOAX/pi-web-keeper/blob/cc13f85fa1fd5cbee1ecbf91fdbdc78001dbcf5a/PiWebKeeper/ServiceKeeper.cs) 启动配置中的命令，等待端口监听，随后通过 `explorer.exe shell:AppsFolder\<AppUserModelId>` 打开已安装应用；允许额外等待固定秒数。
- [AppWindowCloser](https://github.com/NOMOAX/pi-web-keeper/blob/cc13f85fa1fd5cbee1ecbf91fdbdc78001dbcf5a/PiWebKeeper/AppWindowCloser.cs) 枚举可见 Chromium 顶层窗口，通过 `SHGetPropertyStoreForWindow` 读取窗口 AppUserModelId，匹配后投递 `WM_CLOSE`。这是按应用标识筛选窗口的方法，不是按浏览器进程结束所有窗口。
- [SingleInstanceGuard](https://github.com/NOMOAX/pi-web-keeper/blob/cc13f85fa1fd5cbee1ecbf91fdbdc78001dbcf5a/PiWebKeeper/SingleInstanceGuard.cs) 以安装目录哈希建立 Mutex 和激活事件；[App](https://github.com/NOMOAX/pi-web-keeper/blob/cc13f85fa1fd5cbee1ecbf91fdbdc78001dbcf5a/PiWebKeeper/App.xaml.cs) 在重复启动时恢复并激活已有启动器窗口。
- [MainWindow](https://github.com/NOMOAX/pi-web-keeper/blob/cc13f85fa1fd5cbee1ecbf91fdbdc78001dbcf5a/PiWebKeeper/MainWindow.xaml.cs) 提供启动、停止、流式日志与更新操作，成功启动后最小化。关闭的是启动器窗口时请求停止服务；源码没有监听 PWA 窗口关闭来停服务。
- [项目文件](https://github.com/NOMOAX/pi-web-keeper/blob/cc13f85fa1fd5cbee1ecbf91fdbdc78001dbcf5a/PiWebKeeper/PiWebKeeper.csproj) 使用 .NET 10 WPF；[README](https://github.com/NOMOAX/pi-web-keeper/blob/cc13f85fa1fd5cbee1ecbf91fdbdc78001dbcf5a/README.md) 提供自包含单文件发布命令。单文件覆盖的是启动器，运行服务仍需另行安装 Node 与 pi-web。

## 与现有能力比较

| 能力 | 白泽灵台源码现状 | 集成判断 |
|---|---|---|
| 双击启动、服务状态与日志 | [托盘脚本](../../../scripts/desktop-tray.ps1) 已提供打开入口、本次日志、状态及正常退出 | 已覆盖，不需再加一个 WPF 启动器 |
| 服务就绪判断 | [桌面编排](../../../server/pivane-desktop-launcher.js) 先等待 ManagedLauncher，再检查访问状态 HTTP；[启动页服务](../../../server/pivane-desktop-startup.js) 投影 starting/ready/error | 保留现有方式，不退回端口监听加固定延时 |
| 重复启动合并 | 托盘已有 Mutex/EventWaitHandle，[installationId](../../../server/pivane-desktop-launcher.js) 基于 native realpath；[ManagedLauncher](../../../server/pi-managed-launcher.js) 持有最终安装锁 | 已覆盖；可进一步让重复打开聚焦应用窗口 |
| PWA 基础 | [site.webmanifest](../../../public/site.webmanifest) 已有名称、图标、固定 id 和 standalone；[通知 worker](../../../public/pi-notification-sw.js) 提供通知和窗口聚焦 | 有基础；目前托盘通过系统默认浏览器打开 URL，尚未连接已安装 PWA 的应用标识 |
| Windows 用户交付 | [桌面启动指南](../../DESKTOP_LAUNCHER.md) 已包含便携 Node、npm、Bash、rg、fd 和锁定依赖 | 自包含 WPF EXE 不会进一步解决服务安装；引入 .NET 10 增加另一套构建与验证成本 |
| 更新 | [更新契约](../../UPDATES.md) 将应用与适配 Pi 成组更新，并提供独立维护路径 | 可参考清晰状态提示，不移植其全局更新命令 |

## 建议集成的内容

### 优先增加可选 PWA 应用窗口模式

在现有桌面入口中增加由用户明确选择的浏览器模式与已安装应用模式。应用模式记录经核对的 AppUserModelId，在既有 ready 条件通过后打开应用；未安装、标识失效或打开失败时提供恢复浏览器入口的清晰操作。此建议基于上游的 [OpenAppWindow](https://github.com/NOMOAX/pi-web-keeper/blob/cc13f85fa1fd5cbee1ecbf91fdbdc78001dbcf5a/PiWebKeeper/ServiceKeeper.cs)，收益是独立任务栏窗口与更直接的桌面入口。

配置应绑定安装目录、工作台实际 URL 和用户选择的浏览器配置。不能只凭名称相同就选中应用，不能修改系统默认浏览器，也不能在请求中接受任意启动命令。现有临时启动页与 PWA 固定站点属于不同 origin，需明确应用模式的等待反馈，避免同时留下普通浏览器工作台与 PWA 两个窗口。先保持现有默认浏览器流程，再增加显式选择的应用流程。

实现入口以 [desktop-tray.ps1](../../../scripts/desktop-tray.ps1) 的 Open-Workspace 为主；服务状态继续由 [pivane-desktop-launcher](../../../server/pivane-desktop-launcher.js) 给出，不创建第二个 Node 服务或 RPC worker。

### 其次实现重复打开时聚焦已有应用窗口

借鉴上游的 AppUserModelId 查询，匹配已安装应用的 HWND，恢复最小化窗口并尝试聚焦，确实没有匹配窗口时再启动。上游已经提供 [按应用标识发现窗口](https://github.com/NOMOAX/pi-web-keeper/blob/cc13f85fa1fd5cbee1ecbf91fdbdc78001dbcf5a/PiWebKeeper/AppWindowCloser.cs) 与 [恢复启动器窗口](https://github.com/NOMOAX/pi-web-keeper/blob/cc13f85fa1fd5cbee1ecbf91fdbdc78001dbcf5a/PiWebKeeper/App.xaml.cs) 两段参考；聚焦 PWA 的组合逻辑需要本项目实现和验证。

AppUserModelId 表示应用身份，不证明某个窗口由本次启动器创建。同一应用可能有多个用户打开的窗口；自动批量关闭全部匹配窗口不应作为默认退出行为。浏览器配置、工作台 URL、同名实例和重装后的标识都要核对。普通浏览器模式继续尊重用户偏好。

### 按需要补充轻量启动诊断

上游的 [MainWindow](https://github.com/NOMOAX/pi-web-keeper/blob/cc13f85fa1fd5cbee1ecbf91fdbdc78001dbcf5a/PiWebKeeper/MainWindow.xaml.cs) 将操作状态和日志放在同一窗口，故障较容易看到。白泽灵台已有等待页错误和本次日志入口；可补充“查看日志”和应用标识失效说明，优先复用现有页面与日志脱敏，不引入重复日志存储或维护控制接口。

## 不适合直接移植的实现

1. **启动前停止已有服务与端口占用者。** 上游 [StartAsync/StopAsync](https://github.com/NOMOAX/pi-web-keeper/blob/cc13f85fa1fd5cbee1ecbf91fdbdc78001dbcf5a/PiWebKeeper/ServiceKeeper.cs) 启动前调用停止，结束所持进程树，端口仍占用时再按 PID 结束占用进程。白泽灵台需拒绝未知占用者，并由 Supervisor 与受管入口维护唯一 worker，不能用它包裹现有启动命令。
2. **端口监听代表就绪或服务归属。** [PortProbe](https://github.com/NOMOAX/pi-web-keeper/blob/cc13f85fa1fd5cbee1ecbf91fdbdc78001dbcf5a/PiWebKeeper/PortProbe.cs) 按端口号匹配本机 TCP listeners，没有验证工作台身份或 HTTP 状态；Host 配置也不参与该匹配。它不满足现有 IPC 与 HTTP 的就绪契约。
3. **强杀进程树作为正常停机。** 上游直接 Kill；白泽灵台需复用私有 stdin 停机请求、[统一异步停机](../../../server/pi-process-shutdown.js) 和 worker 实际退出检查，保留不确定结果及失败状态。
4. **一键更新全局 Pi。** 上游 [RunUpdateAsync](https://github.com/NOMOAX/pi-web-keeper/blob/cc13f85fa1fd5cbee1ecbf91fdbdc78001dbcf5a/PiWebKeeper/MainWindow.xaml.cs) 顺序执行 `pi update --all` 与 `pi-web update`，不符合白泽灵台锁定依赖和应用/Pi 成组交付的约束。
5. **将其窗口生命周期直接用于工作台。** 上游启动/更新期间关闭窗口没有完整等待处理；停止超时可被捕获后继续显示停止并关闭窗口，见 [MainWindow](https://github.com/NOMOAX/pi-web-keeper/blob/cc13f85fa1fd5cbee1ecbf91fdbdc78001dbcf5a/PiWebKeeper/MainWindow.xaml.cs)。白泽灵台有预约、后台任务及多浏览器访问，推荐继续保持关闭应用窗口后服务在托盘运行，正常退出单独操作。

## 实施与验证边界

建议首批只做“显式配置应用入口 + ready 后打开 + 失败恢复浏览器”，第二批做已开窗口聚焦；自动关闭应用窗口和随关窗停服务暂不纳入。原生声明需适配本项目已有的 .NET Framework 4 构建，不能直接复制上游的 .NET 10 语法与类型；如复用原生代码，同步源码、二进制和构建 manifest。

验证使用独立身份和合成服务，覆盖默认浏览器、指定 PWA、标识缺失、重复打开、最小化、多窗口、多实例、端口冲突、启动失败、正常退出和失败退出。原生窗口行为需 Windows 实机验收，UI 同时跑相关 Chromium 桌面与手机检查；验证范围按 [开发流程](../WORKFLOW.md) 判定，不能用本次静态源码比较代替。

若复制上游实质代码，交付中保留其 [MIT 许可证与版权声明](https://github.com/NOMOAX/pi-web-keeper/blob/cc13f85fa1fd5cbee1ecbf91fdbdc78001dbcf5a/LICENSE)，并登记到本项目第三方来源清单。本次仅保存调研结论，没有引入上游代码或发行二进制。
