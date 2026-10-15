# Windows tray shell. Inspired by dsh-tray-launcher; service ownership stays in Node.
param(
    [string]$AppRoot = (Split-Path $PSScriptRoot -Parent),
    [string]$NodePath,
    [switch]$NoOpen,
    [switch]$ConsoleMode,
    [switch]$SmokeTest
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$script:result = 0
$script:service = $null
$script:stopping = $false
$script:exitRequested = $false
$script:restartPending = $false
$script:restartApproved = $false
$script:ready = $false
$script:url = $null
$script:logFile = $null
$script:readTask = $null
$script:errorTask = $null
$script:openPending = -not $NoOpen
$script:readyAt = $null
$script:tickBusy = $false
$script:events = [System.Collections.Generic.List[object]]::new()
$script:smokeValidated = $false
$mutex = $null
$ownsMutex = $false
$openEvent = $null
$tray = $null
$timer = $null
$context = $null

function Show-Failure([string]$Message) {
    $script:result = 1
    if ($ConsoleMode) { Write-Host $Message -ForegroundColor Red }
    if (-not $SmokeTest) { [System.Windows.Forms.MessageBox]::Show($Message, '白泽灵台', 'OK', 'Error') | Out-Null }
    $script:events.Add(@{ type = 'error'; message = $Message })
}
function Open-Workspace {
    if (-not $script:url -or $script:stopping) { $script:openPending = $true; return }
    try {
        $parsed = [Uri]$script:url
        if ($parsed.Scheme -ne 'http' -or $parsed.UserInfo -or $parsed.AbsolutePath -ne '/' -or $parsed.Query -or $parsed.Fragment) { throw '启动器收到无效的工作台地址。' }
        $start = [System.Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $script:url
        $start.UseShellExecute = $true
        [System.Diagnostics.Process]::Start($start) | Out-Null
        $script:events.Add(@{ type = 'browser-opened'; url = $script:url })
        if ($SmokeTest) {
            $snapshot = ConvertTo-Json -Compress @{ type = 'browser-opened'; url = $script:url }
            [Console]::Out.WriteLine($snapshot); [Console]::Out.Flush()
            $count = @($script:events | Where-Object { $_.type -eq 'browser-opened' }).Count
            [IO.File]::WriteAllText((Join-Path $AppRoot ('.pivane-runtime\desktop\smoke-open-' + $count + '.json')), $snapshot, [Text.UTF8Encoding]::new($false))
        }
        $script:openPending = $false
    } catch { Show-Failure ('打开浏览器失败：' + $_.Exception.Message) }
}
function Request-Stop {
    if ($script:exitRequested -or -not $script:service) { return }
    if (-not $SmokeTest) {
        $answer = [System.Windows.Forms.MessageBox]::Show('退出将停止本实例。请先保存草稿、结束任务，并暂停预约。是否继续？', '白泽灵台', 'YesNo', 'Question')
        if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    }
    $script:exitRequested = $true
    $script:restartApproved = $false
    $script:stopping = $true
    $tray.Text = '白泽灵台：正在正常退出'
    $miOpen.Enabled = $false
    $miExit.Enabled = $false
    $miRestart.Enabled = $false
    $miStatus.Text = '正在等待服务和 Agent 退出…'
    if ($script:service.HasExited) { return }
    try {
        $script:service.StandardInput.WriteLine('{"type":"stop"}')
        $script:service.StandardInput.Flush()
    } catch { Show-Failure ('无法发送退出请求：' + $_.Exception.Message) }
}
function Request-Restart {
    if ($script:stopping -or $script:restartPending -or -not $script:ready -or -not $script:service -or $script:service.HasExited) { return }
    # Reserve before MessageBox pumps another Windows event loop.
    $script:restartPending = $true
    $miRestart.Enabled = $false
    if (-not $SmokeTest) {
        $answer = [System.Windows.Forms.MessageBox]::Show('重启将重新加载当前运行版本的代码，网页连接会暂时中断。请先保存草稿、完成任务并暂停预约。是否继续？', '白泽灵台', 'YesNo', 'Question')
        if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { $script:restartPending = $false; $miRestart.Enabled = $script:ready; return }
    }
    $miStatus.Text = '正在检查是否可以重启…'
    try {
        $script:service.StandardInput.WriteLine('{"type":"restart"}')
        $script:service.StandardInput.Flush()
        $script:events.Add(@{ type = 'restart-requested'; pid = $script:service.Id })
    } catch {
        # A broken control pipe leaves the outcome uncertain; never replay it.
        $miStatus.Text = '重启结果尚未确认，请查看日志或正常退出。'
        if ($ConsoleMode) { Write-Host $miStatus.Text -ForegroundColor Yellow }
    }
}
function Start-ServiceProcess {
    if ($script:service) { $script:service.Dispose() }
    $script:ready = $false
    $script:readyAt = $null
    $script:url = $null
    $script:stopping = $false
    $script:restartPending = $false
    $script:restartApproved = $false
    $tray.Text = '白泽灵台：正在启动'
    $miStatus.Text = '正在启动…'
    $miRestart.Enabled = $false
    $miOpen.Enabled = $false
    $miLog.Enabled = $false
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $NodePath
    $start.Arguments = '"' + $runner + '"'
    $start.WorkingDirectory = $AppRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $script:service = [System.Diagnostics.Process]::Start($start)
    $script:service.StandardInput.NewLine = "`n"
    $script:readTask = $script:service.StandardOutput.ReadLineAsync()
    $script:errorTask = $script:service.StandardError.ReadLineAsync()
}
function Handle-Message([string]$Line) {
    if ($Line.Length -gt 8192) { throw '启动器响应超过预算。' }
    $message = $Line | ConvertFrom-Json
    switch ($message.type) {
        'waiting' {
            $script:url = $message.url
            $miOpen.Enabled = $true
            $script:events.Add(@{ type = 'waiting'; url = $script:url })
            if ($SmokeTest) {
                $snapshot = ConvertTo-Json -Compress @{ type = 'waiting'; url = $script:url }
                [IO.Directory]::CreateDirectory((Join-Path $AppRoot '.pivane-runtime\desktop')) | Out-Null
                [IO.File]::WriteAllText((Join-Path $AppRoot '.pivane-runtime\desktop\smoke-waiting.json'), $snapshot, [Text.UTF8Encoding]::new($false))
            }
            if ($script:openPending) { Open-Workspace }
        }
        'starting' { $script:logFile = $message.logFile }
        'ready' {
            $script:url = $message.url
            $script:logFile = $message.logFile
            $script:ready = $true
            $script:readyAt = [DateTime]::UtcNow
            $tray.Text = '白泽灵台：运行中'
            $miStatus.Text = '运行中 · ' + $script:url
            $miOpen.Enabled = $true
            $miLog.Enabled = $true
            $miRestart.Enabled = -not $script:restartPending -and -not $script:exitRequested
            $script:events.Add(@{ type = 'ready'; url = $script:url; pid = $script:service.Id })
            if ($SmokeTest) {
                $snapshot = ConvertTo-Json -Compress @{ type = 'ready'; url = $script:url; pid = $script:service.Id }
                [Console]::Out.WriteLine($snapshot); [Console]::Out.Flush()
                [IO.File]::WriteAllText((Join-Path $AppRoot '.pivane-runtime\desktop\smoke-ready.json'), $snapshot, [Text.UTF8Encoding]::new($false))
            }
            if ($ConsoleMode) { Write-Host ('白泽灵台已启动：' + $script:url); Write-Host '按 R 重启服务，按 Q 正常退出；也可使用托盘右键菜单。' }
            if ($script:openPending) { Open-Workspace }
        }
        'stopping' { $miStatus.Text = '正在等待服务和 Agent 退出…' }
        'restarting' {
            if (-not $script:exitRequested) { $script:restartApproved = $true }
            $script:stopping = $true
            $script:ready = $false
            $tray.Text = '白泽灵台：正在重启'
            $miOpen.Enabled = $false
            $miRestart.Enabled = $false
            $miStatus.Text = '正在等待旧服务正常退出，再重新加载…'
            $script:events.Add(@{ type = 'restarting'; pid = $script:service.Id })
        }
        'restart-pending' { $miStatus.Text = $message.message }
        'restart-blocked' {
            $script:restartPending = $false
            $miRestart.Enabled = $script:ready -and -not $script:exitRequested
            $miStatus.Text = $message.message
            $script:events.Add(@{ type = 'restart-blocked'; message = $message.message })
            if ($ConsoleMode) { Write-Host $message.message -ForegroundColor Yellow }
            if (-not $SmokeTest) { [System.Windows.Forms.MessageBox]::Show($message.message, '暂不能重启', 'OK', 'Information') | Out-Null }
        }
        'error' { Show-Failure ('启动失败：' + $message.message) }
        default { throw '启动器收到未知的私有响应。' }
    }
}
try {
    $AppRoot = [IO.Path]::GetFullPath($AppRoot)
    if ($env:PIVANE_DESKTOP_SMOKE_ROOT -eq $AppRoot) { $SmokeTest = $true }
    if ($SmokeTest -and (-not (Test-Path -LiteralPath (Join-Path $AppRoot '.pivane-launcher-test')) -or -not $env:PI_CODING_AGENT_DIR -or -not $env:PI_MEDIA_DATA_DIR -or -not $env:PI_WEB_DEFERRED_FILE)) { throw 'SmokeTest 仅允许独立合成实例。' }
    $script:smokeValidated = [bool]$SmokeTest
    $runner = Join-Path $AppRoot 'scripts\start-desktop.cjs'
    if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw '找不到白泽灵台程序。请保留完整目录结构。' }
    if (-not $NodePath) {
        foreach ($candidate in @((Join-Path $AppRoot 'runtime\node.exe'), (Join-Path (Split-Path $AppRoot -Parent) 'runtime\node.exe'))) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $NodePath = $candidate; break }
        }
        if (-not $NodePath) { $command = Get-Command node.exe -ErrorAction SilentlyContinue; if ($command) { $NodePath = $command.Source } }
    }
    if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw '没有找到 Node.js。请安装 Node.js 22，或在 runtime 目录放置 node.exe。' }
    # Prepend bundled tools and real Git Bash, avoiding the Windows WSL bash shim.
    $toolPaths = @()
    foreach ($base in @($AppRoot, (Split-Path $AppRoot -Parent))) {
        foreach ($relative in @('tools\rg', 'tools\fd', 'tools\git\bin', 'tools\git\usr\bin')) {
            $candidate = Join-Path $base $relative
            if (Test-Path -LiteralPath $candidate -PathType Container) { $toolPaths += $candidate }
        }
    }
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if ($base) {
            foreach ($relative in @('Git\bin', 'Programs\Git\bin')) {
                $candidate = Join-Path $base $relative
                if (Test-Path -LiteralPath (Join-Path $candidate 'bash.exe')) { $toolPaths += $candidate }
            }
        }
    }
    # Git may be installed on another drive; its cmd shim alone does not expose Bash.
    $gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($gitCommand) {
        $gitBase = Split-Path (Split-Path $gitCommand.Source -Parent) -Parent
        foreach ($relative in @('bin', 'usr\bin')) {
            $candidate = Join-Path $gitBase $relative
            if (Test-Path -LiteralPath (Join-Path $candidate 'bash.exe')) { $toolPaths += $candidate }
        }
    }
    $env:PATH = (@((Split-Path $NodePath -Parent)) + $toolPaths + @($env:PATH)) -join ';'
    $identityStart = [System.Diagnostics.ProcessStartInfo]::new()
    $identityStart.FileName = $NodePath
    $identityStart.Arguments = '"' + $runner + '" --identity'
    $identityStart.UseShellExecute = $false
    $identityStart.CreateNoWindow = $true
    $identityStart.RedirectStandardOutput = $true
    $identityStart.RedirectStandardError = $true
    $identityStart.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $identity = [System.Diagnostics.Process]::Start($identityStart)
    $identityText = $identity.StandardOutput.ReadToEnd()
    $identityError = $identity.StandardError.ReadToEnd()
    $identity.WaitForExit()
    if ($identity.ExitCode -ne 0) { throw ('无法核对安装目录，请先执行 node scripts/install.cjs。' + $identityError) }
    $metadata = $identityText | ConvertFrom-Json
    $identity.Dispose()
    $AppRoot = $metadata.root
    $created = $false
    $mutex = [Threading.Mutex]::new($true, ('Local\pivane-desktop-' + $metadata.id), [ref]$created)
    $ownsMutex = $created
    if (-not $ownsMutex) {
        try { $ownsMutex = $mutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    }
    $openEvent = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::AutoReset, ('Local\pivane-open-' + $metadata.id))
    if (-not $ownsMutex) {
        if (-not $NoOpen) { $openEvent.Set() | Out-Null }
        $script:events.Add(@{ type = 'existing-instance' })
    } else {
        $tray = [System.Windows.Forms.NotifyIcon]::new()
        $iconPath = Join-Path $AppRoot 'public\brand\favicon.ico'
        $tray.Icon = [Drawing.Icon]::new($iconPath)
        $tray.Text = '白泽灵台：正在启动'
        $tray.Visible = $true
        $menu = [System.Windows.Forms.ContextMenuStrip]::new()
        $miStatus = $menu.Items.Add('正在启动…'); $miStatus.Enabled = $false
        $miOpen = $menu.Items.Add('打开白泽灵台'); $miOpen.Enabled = $false
        $miLog = $menu.Items.Add('查看本次日志'); $miLog.Enabled = $false
        $miRestart = $menu.Items.Add('重启服务'); $miRestart.Enabled = $false
        $menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new()) | Out-Null
        $miExit = $menu.Items.Add('正常退出')
        $miOpen.add_Click({ Open-Workspace })
        $miLog.add_Click({ if ($script:logFile) { $start = [Diagnostics.ProcessStartInfo]::new(); $start.FileName = $script:logFile; $start.UseShellExecute = $true; [Diagnostics.Process]::Start($start) | Out-Null } })
        $miExit.add_Click({ Request-Stop })
        $miRestart.add_Click({ Request-Restart })
        $tray.add_DoubleClick({ Open-Workspace })
        $tray.ContextMenuStrip = $menu
        $context = [System.Windows.Forms.ApplicationContext]::new()
        Start-ServiceProcess
        $timer = [System.Windows.Forms.Timer]::new()
        $timer.Interval = 100
        $timer.add_Tick({
            # ShellExecute/MessageBox can pump a nested Windows message loop.
            # Reserve before processing any event or invoking the browser.
            if ($script:tickBusy) { return }
            $script:tickBusy = $true
            try {
                while ($script:readTask -and $script:readTask.IsCompleted) {
                    $line = $script:readTask.GetAwaiter().GetResult()
                    if ($null -eq $line) { $script:readTask = $null; break }
                    $script:readTask = $script:service.StandardOutput.ReadLineAsync()
                    Handle-Message $line
                }
                # Always drain stderr so a busy child never blocks on a full pipe.
                while ($script:errorTask -and $script:errorTask.IsCompleted) {
                    $line = $script:errorTask.GetAwaiter().GetResult()
                    if ($null -eq $line) { $script:errorTask = $null; break }
                    if ($ConsoleMode) { Write-Host $line }
                    $script:errorTask = $script:service.StandardError.ReadLineAsync()
                }
                if ($openEvent.WaitOne(0)) { Open-Workspace }
                if ($ConsoleMode -and -not [Console]::IsInputRedirected) {
                    while ([Console]::KeyAvailable) {
                        $key = [Console]::ReadKey($true).Key
                        if ($key -eq [ConsoleKey]::R) { Request-Restart }
                        elseif ($key -eq [ConsoleKey]::Q) { Request-Stop }
                    }
                }
                if ($SmokeTest -and $script:ready -and (Test-Path -LiteralPath (Join-Path $AppRoot '.pivane-launcher-restart'))) {
                    Remove-Item -LiteralPath (Join-Path $AppRoot '.pivane-launcher-restart')
                    $miRestart.PerformClick()
                }
                if ($SmokeTest -and $script:readyAt -and ((Test-Path -LiteralPath (Join-Path $AppRoot '.pivane-launcher-stop')) -or ([DateTime]::UtcNow - $script:readyAt).TotalSeconds -ge 120)) { $miExit.PerformClick() }
                if ($script:service.HasExited -and -not $script:readTask -and -not $script:errorTask) {
                    $script:events.Add(@{ type = 'exited'; exitCode = $script:service.ExitCode })
                    if ($script:restartApproved -and -not $script:exitRequested -and $script:service.ExitCode -eq 0 -and $script:result -eq 0) {
                        Start-ServiceProcess
                    } else {
                        if ($script:service.ExitCode -ne 0 -and $script:result -eq 0) { Show-Failure '白泽灵台异常退出，请检查日志；未自动重启。' }
                        $context.ExitThread()
                    }
                }
            } catch { Show-Failure $_.Exception.Message; $script:service.StandardInput.Close(); $context.ExitThread() }
            finally { $script:tickBusy = $false }
        })
        $timer.Start()
        [System.Windows.Forms.Application]::Run($context)
    }
} catch { Show-Failure $_.Exception.Message }
finally {
    if ($timer) { $timer.Stop(); $timer.Dispose() }
    if ($script:service) {
        if (-not $script:service.HasExited) {
            # Closing the inherited control pipe invokes Node's normal shutdown.
            $script:service.StandardInput.Close()
            $script:service.WaitForExit()
        }
        $script:service.Dispose()
    }
    if ($script:smokeValidated -and ($ownsMutex -or -not $mutex)) {
        $report = Join-Path $AppRoot '.pivane-runtime\desktop\smoke-result.json'
        [IO.Directory]::CreateDirectory((Split-Path $report -Parent)) | Out-Null
        [IO.File]::WriteAllText($report, (ConvertTo-Json -InputObject $script:events.ToArray() -Depth 4), [Text.UTF8Encoding]::new($false))
    }
    if ($tray) { $tray.Visible = $false; $tray.Icon.Dispose(); $tray.Dispose() }
    if ($context) { $context.Dispose() }
    if ($openEvent) { $openEvent.Dispose() }
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
exit $script:result
