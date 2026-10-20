# Existing Windows Forms tray owns the UI and read-only waiting entry. Each run has its own Node owner.
param([Alias('Root')][string]$AppRoot = (Split-Path $PSScriptRoot -Parent), [string]$NodePath, [switch]$NoOpen, [switch]$ConsoleMode, [switch]$SmokeTest)
$ErrorActionPreference = 'Stop'
# Raw presence suppresses a blocking QA error dialog; it grants no smoke authority.
$script:strictQaRequested = $false
foreach ($name in [Environment]::GetEnvironmentVariables().Keys) { if ($name -match '^PIVANE_NATIVE_QA') { $script:strictQaRequested = $true } }
if ($script:strictQaRequested) { $SmokeTest = $false }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$script:result = 0; $script:service = $null; $script:generation = ''; $script:instance = [Guid]::NewGuid().ToString()
$script:state = 'stopped'; $script:url = $null; $script:logFile = $null; $script:lastError = ''; $script:readTask = $null; $script:errorTask = $null
$script:tickBusy = $false; $script:clean = $true; $script:exitIntent = $false; $script:pending = $null; $script:review = $null
$script:events = [Collections.Generic.List[object]]::new(); $script:smokeValidated = $false; $script:smokeCommand = ''; $script:lastSnapshot = [DateTime]::MinValue
$script:confirmationShown=$false; $script:uiScale=1; $script:recoverStop=$false; $script:readyAt = $null; $script:smokeStopSent = $false; $script:lastReport = ''; $script:startupStopReview=$false
$script:versions=$null; $script:maintenanceHint=$false; $script:lastReviewId=''
$ProgramRoot = if ($env:PIVANE_PROGRAM_ROOT) { [IO.Path]::GetFullPath($env:PIVANE_PROGRAM_ROOT) } else { [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)) }
$script:updatePhase=''; $script:nativeAssembly=$null; $script:qaComponents=$null; $script:ownerRefused=$false
$mutex = $null; $ownsMutex = $false; $openEvent = $null; $tray = $null; $timer = $null; $context = $null; $window = $null; $hoster = $null
function Write-QAReceipt([string]$Point, $Payload) {
    if (-not $script:smokeValidated -or $env:PIVANE_NATIVE_QA -cne '1') { return }
    $id=[Guid]::NewGuid().ToString(); $currentProcess=[Diagnostics.Process]::GetCurrentProcess()
    try {
        $value=@{schemaVersion=1;runId=$env:PIVANE_NATIVE_QA_RUN_ID;root=$AppRoot;scenario=$env:PIVANE_NATIVE_QA_SCENARIO;point=$Point;receiptId=$id;
            pid=$PID;creationTime=$currentProcess.StartTime.ToFileTimeUtc().ToString();execPath=$currentProcess.MainModule.FileName;at=[DateTime]::UtcNow.ToString('o');event=$Payload}
        $temporary=Join-Path $env:PIVANE_NATIVE_QA_RECEIPTS ($id+'.tmp');$target=Join-Path $env:PIVANE_NATIVE_QA_RECEIPTS ('tray-'+$id+'.json')
        [IO.File]::WriteAllText($temporary,(ConvertTo-Json -Depth 10 -Compress $value),[Text.UTF8Encoding]::new($false));[IO.File]::Move($temporary,$target)
    } finally { $currentProcess.Dispose() }
}
function Record-Event($Value) {
    if($SmokeTest){$Value.instance=$script:instance;$Value.runId=$env:PIVANE_NATIVE_QA_RUN_ID}
    if($script:events.Count -ge 256){$script:events.RemoveAt(0)}
    $script:events.Add($Value)
    if ($SmokeTest) {
        Write-QAReceipt 'tray-event' $Value
        $dir = Join-Path $AppRoot '.pivane-runtime\desktop'; [IO.Directory]::CreateDirectory($dir) | Out-Null
        if ($Value.type -in @('waiting','ready')) { [IO.File]::WriteAllText((Join-Path $dir ('smoke-' + $Value.type + '.json')), (ConvertTo-Json -Compress $Value), [Text.UTF8Encoding]::new($false)) }
        if ($Value.type -eq 'browser-opened') { $count = @($script:events | Where-Object { $_.type -eq 'browser-opened' }).Count; [IO.File]::WriteAllText((Join-Path $dir ('smoke-open-' + $count + '.json')), (ConvertTo-Json -Compress $Value), [Text.UTF8Encoding]::new($false)) }
    }
}
function Show-Failure([string]$Message, [string]$Code = '') {
    $script:result = 1; $script:lastError = $Message.Substring(0, [Math]::Min(1024,$Message.Length))
    if ($script:strictQaRequested -and -not $script:smokeValidated) { [Console]::Error.WriteLine($script:lastError); return }
    $failureEvent=@{ type = 'error'; message = $script:lastError; generation = $script:generation }
    if ($Code -eq 'DESKTOP_OWNER_UNPROVEN') { $failureEvent.code=$Code }
    Record-Event $failureEvent
    if ($ConsoleMode) { Write-Host $script:lastError -ForegroundColor Red }
    if (-not $tray -and -not $SmokeTest) { [Windows.Forms.MessageBox]::Show($script:lastError,'白泽灵台','OK','Error') | Out-Null }
}
function Set-State([string]$State) {
    $script:state = $State
    if ($hoster) {
        $value = @{state=$State; instance=$script:instance; generation=$script:generation}
        if ($State -eq 'ready') { $value.url = $script:url }
        if ($script:lastError) { $value.message = $script:lastError }
        $hoster.Update((ConvertTo-Json -Compress $value))
    }
    Update-Window
}
function Set-Confirmation([bool]$Visible) {
    if ($script:confirmationShown -ne $Visible) {
        $delta=[int](116*$script:uiScale); $layout.RowStyles[5].Height=if($Visible){$delta}else{0}
        if($Visible){$window.Height+=$delta}else{$window.Height-=$delta}
        $script:confirmationShown=$Visible
    }
    $confirmPanel.Visible=$Visible
}
function Show-Management {
    $window.Show(); if ($window.WindowState -eq 'Minimized') { $window.WindowState = 'Normal' }; $window.Activate() | Out-Null
    Record-Event @{type='management-opened'; generation=$script:generation}
}
function Open-Workspace {
    if ($script:state -eq 'stopped') { Start-Run; return }
    if ($script:state -in @('stopping','unknown','error')) { Show-Management; return }
    $target = if ($script:state -eq 'ready') { $script:url } else { $hoster.Url }
    try {
        $parsed = [Uri]$target
        if ($parsed.Scheme -ne 'http' -or $parsed.UserInfo -or $parsed.AbsolutePath -ne '/' -or $parsed.Query -or $parsed.Fragment) { throw '启动器收到无效的工作台地址。' }
        $start = [Diagnostics.ProcessStartInfo]::new(); $start.FileName = $target; $start.UseShellExecute = $true
        # Synthetic fixture observes browser intent without opening the user's browser.
        if (-not $SmokeTest -or $env:PIVANE_DESKTOP_SMOKE_OPEN_BROWSER -eq '1') { [Diagnostics.Process]::Start($start) | Out-Null }
        Record-Event @{type='browser-opened'; url=$target; generation=$script:generation}
    } catch { Show-Failure ('打开浏览器失败：' + $_.Exception.Message) }
}
function Send-Request([string]$Type, $Extra) {
    if ($script:pending -or -not $script:service -or $script:service.HasExited) { return $false }
    $id = [Guid]::NewGuid().ToString(); $request = @{type=$Type; generation=$script:generation; id=$id}
    foreach ($key in $Extra.Keys) { $request[$key] = $Extra[$key] }
    $script:pending = @{id=$id; type=$Type; generation=$script:generation; started=[DateTime]::UtcNow}
    try { Write-PrivateFrame $request; Update-Window; return $true }
    catch { Show-Failure ('控制连接已断开：' + $_.Exception.Message); Set-State 'unknown'; return $false }
}
function Write-PrivateFrame($Value) {
    # Windows PowerShell's Process.StandardInput uses the legacy code page and
    # has no StandardInputEncoding setter. ASCII JSON escapes preserve every
    # Unicode path while remaining valid UTF-8 LF frames on the private wire.
    $json=ConvertTo-Json -Compress -Depth 5 $Value
    $frame=[regex]::Replace($json,'[^\x00-\x7f]',{param($match) '\u'+([int][char]$match.Value).ToString('x4')})
    $script:service.StandardInput.WriteLine($frame);$script:service.StandardInput.Flush()
}
function Send-TrayEvidence([string]$Type, [string]$Challenge) {
    if (-not $script:service -or $script:service.HasExited -or -not $script:nativeAssembly) { throw '托盘控制连接尚未就绪。' }
    $sha=[Security.Cryptography.SHA256]::Create()
    try {
        $nativePath=$script:nativeAssembly.Location
        $nativeHash=([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($nativePath)))).Replace('-','').ToLowerInvariant()
        $trayHash=([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($PSCommandPath)))).Replace('-','').ToLowerInvariant()
    } finally { $sha.Dispose() }
    $request=@{type=$Type;generation=$script:generation;id=[Guid]::NewGuid().ToString();programRoot=$ProgramRoot;nativePath=$nativePath;nativeVersion=$script:nativeAssembly.GetName().Version.ToString();nativeSha256=$nativeHash;traySha256=$trayHash;nodePath=$NodePath;
        processes=@(@{pid=$script:service.Id;creationTime=$script:service.StartTime.ToFileTimeUtc().ToString()},@{pid=$PID;creationTime=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToFileTimeUtc().ToString()})}
    if($Challenge){$request.challenge=$Challenge}
    $script:qaComponents=@{programRoot=$ProgramRoot;nativePath=$nativePath;nativeVersion=$request.nativeVersion;nativeSha256=$nativeHash;traySha256=$trayHash;nodePath=$NodePath;processes=$request.processes}
    Write-PrivateFrame $request
    if($Type -eq 'tray-attached'){Record-Event @{type='tray-components';generation=$script:generation;components=$script:qaComponents}}
}
function Start-Run {
    if ($script:service -or -not $script:clean -or $script:state -notin @('stopped','error')) { Show-Management; return }
    $script:ownerRefused=$false; $script:recoverStop=$false; $script:generation = [Guid]::NewGuid().ToString(); $script:clean = $false; $script:exitIntent = $false; $script:pending = $null; $script:review = $null
    $script:lastError = ''; $script:logFile = $null; $script:url = $null; $script:readyAt = $null; $script:smokeStopSent = $false; $script:startupStopReview=$false; $script:versions=$null; $script:maintenanceHint=$false
    $script:qaComponents=$null
    Set-State 'starting'
    try {
        $start = [Diagnostics.ProcessStartInfo]::new(); $start.FileName = $NodePath
        $start.Arguments = '"' + $runner + '" --controlled --generation ' + $script:generation
        $start.WorkingDirectory = $AppRoot; $start.UseShellExecute = $false; $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
        $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false); $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
        $script:service = [Diagnostics.Process]::Start($start); $script:service.StandardInput.NewLine = "`n"
        Send-TrayEvidence 'tray-attached' ''
        $script:readTask = $script:service.StandardOutput.ReadLineAsync(); $script:errorTask = $script:service.StandardError.ReadLineAsync()
        Record-Event @{type='waiting';url=$hoster.Url;generation=$script:generation;pid=$script:service.Id}
        if (-not $NoOpen) { Open-Workspace }
    } catch { $script:clean = $null -eq $script:service; Show-Failure $_.Exception.Message; Set-State 'error' }
}
function Request-Stop([string]$Action) {
    if ($script:ownerRefused -and -not $script:service) { if ($Action -eq 'exit') { $context.ExitThread() }; return }
    if ($script:state -in @('stopping','unknown') -or $script:pending) { Show-Management; return }
    if ($script:state -in @('stopped','error') -and $script:clean -and -not $script:service) { if ($Action -eq 'exit') { $context.ExitThread() }; return }
    if ($script:review) { Show-Management; return }
    if ($script:state -eq 'starting') {
        $script:stopAction=$Action; $script:exitIntent = $Action -eq 'exit'; Set-State 'stopping'
        Send-Request 'stop' @{action=$Action} | Out-Null; return
    }
    if ($script:state -eq 'ready') { $script:stopAction = $Action; Show-Management; Send-Request 'review-stop' @{action=$Action} | Out-Null }
}
function Confirm-Stop {
    if (-not $script:review -or -not $savedCheck.Checked -or -not $externalCheck.Checked -or $script:pending) { return }
    $script:exitIntent = $script:stopAction -eq 'exit'
    Send-Request 'execute-stop' @{ticket=$script:review.ticket;draftsSaved=$true;externalWritersStopped=$true} | Out-Null
}
function Show-Blockers($Message) {
    $lines = [Collections.Generic.List[string]]::new()
    if ($Message.complete -ne $true) { $lines.Add('状态检查不完整，暂不能停止服务。请查看日志。') }
    foreach ($item in @($Message.blockers | Select-Object -First 20)) {
        if ($null -eq $item) { continue }
        $label = [string]$item.label; if ($label.Length -gt 160) { $label = $label.Substring(0,160) }
        $line = $label + ' × ' + [string]$item.count + $(if($item.type -eq 'worker'){' 项阻碍原因'}else{''})
        if ($item.cwd) { $line += ' · ' + ([string]$item.cwd).Substring(0,[Math]::Min(160,([string]$item.cwd).Length)) }
        if ($item.sessionId) { $line += ' · 会话 ' + ([string]$item.sessionId).Substring(0,[Math]::Min(64,([string]$item.sessionId).Length)) }
        $lines.Add($line)
    }
    if ($lines.Count -eq 0) { $lines.Add('当前没有阻碍事项。') } else { $lines.Add('请在工作台处理后，再次点击停止服务或退出。') }
    if ($Message.scheduled) { $lines.Add(('预约提示：未来 ' + $Message.scheduled.futureCount + ' 项，latest 策略 ' + $Message.scheduled.latestCount + ' 项。服务停止期间无法执行；配置 latest 的预约在重启后可能按原宽限补最近一次。')) }
    $blockerText.Text = $lines -join "`r`n"
}
function Handle-Message([string]$Line, $Owner, [string]$Generation) {
    if (-not [Object]::ReferenceEquals($Owner,$script:service) -or $Generation -ne $script:generation) { return }
    if ($Line.Length -gt 65536) { throw '启动器响应超过预算。' }
    $message = $Line | ConvertFrom-Json
    if ($message.generation -ne $Generation) { return }
    if ($message.type -eq 'tray-validate') { Send-TrayEvidence 'tray-validated' ([string]$message.challenge); return }
    if ($message.id -and (-not $script:pending -or $message.id -ne $script:pending.id)) { return }
    $pendingType = if ($script:pending) { $script:pending.type } else { '' }
    if ($message.id) { $script:pending = $null }
    if ($message.versions -and $message.type -in @('ready','snapshot','stop-review')) { $script:versions=$message.versions }
    switch ($message.type) {
        'update-progress' { $script:updatePhase=[string]$message.phase; if($script:updatePhase -in @('waiting-exit','rollback-waiting-exit')){Set-State 'stopping'}elseif($script:updatePhase -eq 'needs-recovery'){Set-State 'unknown'}else{Update-Window} }
        'update-handoff' { $script:exitIntent=$true; $script:updatePhase=if($message.mode -eq 'rollback'){'rollback-waiting-exit'}else{'waiting-exit'}; Set-State 'stopping' }
        'starting' { $script:logFile = $message.logFile }
        'ready' {
            if ($script:state -eq 'stopping' -and $pendingType -eq 'stop') { $script:url=$message.url; $script:logFile=$message.logFile; return }
            if ($script:state -in @('stopping','unknown')) { return }
            $script:url = $message.url; $script:logFile = $message.logFile; $script:readyAt = [DateTime]::UtcNow
            Set-State 'ready'; Record-Event @{type='ready';url=$script:url;generation=$Generation;pid=$Owner.Id}
            if ($script:startupStopReview) { $script:startupStopReview=$false; Show-Management; Send-Request 'review-stop' @{action=$script:stopAction} | Out-Null }
        }
        'snapshot' { Show-Blockers $message }
        'stop-review' {
            $script:lastReviewId=$message.id
            Show-Blockers $message
            if ($message.ticket -and $message.complete -eq $true -and @($message.blockers).Count -eq 0) {
                $script:review = @{ticket=$message.ticket;generation=$Generation}; $savedCheck.Checked=$false; $externalCheck.Checked=$false
                Set-Confirmation $true
            } else { $script:review=$null; Set-Confirmation $false; $script:exitIntent=$false }
        }
        'stop-accepted' { $script:recoverStop=$false; $script:lastError=''; $script:result=0; $script:review=$null; Set-Confirmation $false; Set-State 'stopping'; Record-Event @{type='stop-accepted';generation=$Generation;operationId=$message.operationId} }
        'stopping' { Set-State 'stopping' }
        'stopped' { if ($message.clean -eq $true) { $script:clean=$true }; Record-Event @{type='stopped';generation=$Generation;clean=$script:clean} }
        'error' {
            if ($pendingType -eq 'stop' -and $message.code -eq 'DESKTOP_REVIEW_REQUIRED') {
                # The service became ready before the queued startup stop arrived.
                # Keep the same user intent, but require the normal review and confirmation.
                if ($script:url) { Set-State 'ready'; Show-Management; Send-Request 'review-stop' @{action=$script:stopAction} | Out-Null }
                else { $script:startupStopReview=$true; Set-State 'starting' }
                break
            }
            if ($message.code -eq 'DESKTOP_OWNER_UNPROVEN') { $script:ownerRefused=$true }
            Show-Failure ([string]$message.message) ([string]$message.code); $script:review=$null; Set-Confirmation $false
            if ($message.code -eq 'DESKTOP_CLEANUP_UNKNOWN') { Set-State 'unknown' }
            elseif ($pendingType -eq 'execute-stop' -and $message.code -eq 'DESKTOP_TRANSPORT_UNKNOWN') { $script:recoverStop=$true; Set-State 'unknown' }
            elseif ($script:recoverStop -and $pendingType -eq 'snapshot') { $blockerText.Text=$script:lastError }
            elseif ($message.id -and $pendingType -in @('review-stop','execute-stop','snapshot') -and $script:state -eq 'ready') { $script:exitIntent=$false; $blockerText.Text=$script:lastError }
            else { if ($message.clean -eq $true) { $script:clean=$true }; Set-State 'error' }
        }
        default { throw '启动器收到未知的私有响应。' }
    }
    Update-Window
}
function Read-RecentLog {
    if (-not $script:logFile -or -not [IO.File]::Exists($script:logFile)) { $logText.Text='本次运行尚无日志。'; return }
    try {
        $file=[IO.File]::Open($script:logFile,'Open','Read','ReadWrite'); try {
            $buffer=[byte[]]::new(16384); $offset=[Math]::Max(0,$file.Length-$buffer.Length); $file.Seek($offset,'Begin') | Out-Null
            $count=0;while($count -lt $buffer.Length){$read=$file.Read($buffer,$count,$buffer.Length-$count);if($read -eq 0){break};$count+=$read}
            $text=[Text.Encoding]::UTF8.GetString($buffer,0,$count)
        } finally { $file.Dispose() }
        $text=($text -split "`n" | Select-Object -Last 24) -join "`r`n"
        $text=$text -replace '(?i)(Bearer\s+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+','$1[redacted]'
        $logText.Text=$text.Substring([Math]::Max(0,$text.Length-8192))
    } catch { $logText.Text='无法读取本次日志，请使用完整日志入口查看。' }
}
function Update-Window {
    if (-not $window) { return }
    $names=@{starting='正在启动';ready='运行中';stopping='正在停止';stopped='已停止';error='启动或停机失败';unknown='状态未知'}
    $name=$names[$script:state]; $stateLabel.Text=$name; $miStatus.Text=$name; $tray.Text='白泽灵台：'+$name
    $detailLabel.Text = switch ($script:state) {
        'starting' {'浏览器等待页会自动更新；较慢的电脑可能需要更长时间。'}
        'ready' {'服务正常运行。关闭本窗口会保留系统托盘和服务。'}
        'stopping' {'正在等待服务和 Agent 完成清理；完成后需要手动启动。'}
        'stopped' {'服务已结束。管理入口仍在系统托盘中。'}
        'error' { $script:lastError }
        'unknown' {'无法核实清理是否完成。为避免重复所有者，禁止再次启动。请查看日志。'}
    }
    if ($script:pending) { $detailLabel.Text='正在核对服务状态，请稍候。' }
    elseif ($script:maintenanceHint -and $script:state -eq 'ready') { $detailLabel.Text='在工作台打开 设置 → 版本与更新，使用现有独立维护入口。' }
    if ($script:updatePhase) { $detailLabel.Text = switch($script:updatePhase){'validating'{'正在验证新版启动器、服务和原数据，验证通过后开放工作台。'};'waiting-exit'{'更新已准备完成，正在退出本轮托盘，随后自动打开新版。'};'rollback-waiting-exit'{'新版验证失败，正在退出后恢复原程序与停机备份。'};'needs-recovery'{'升级结果需要人工恢复；已保留现场，禁止重复启动。'};default{$detailLabel.Text}} }
    $appVersion=if($script:versions.appVersion){[string]$script:versions.appVersion}else{'未核实'}
    $engineVersion=if($script:versions.engineVersion){[string]$script:versions.engineVersion}else{'未核实'}
    $versionLabel.Text='白泽灵台 '+$appVersion+' · Pi Coding Agent '+$engineVersion
    if($script:versions.launcherVersion){$versionLabel.Text+=' · 启动器 '+[string]$script:versions.launcherVersion}
    $maintenanceButton.Enabled=$script:state -eq 'ready' -and -not $script:pending
    $addressBox.Text=if ($script:url) {$script:url} elseif ($hoster) {$hoster.Url} else {''}
    $canStart=($script:state -in @('stopped','error') -and $script:clean -and -not $script:service)
    $mainButton.Text=if ($canStart) {'启动服务'} else {'打开工作台'}
    $mainButton.Enabled=($canStart -or $script:state -in @('ready','starting')) -and -not $script:pending
    $stopButton.Enabled=$script:state -in @('ready','starting') -and -not $script:pending -and -not $script:review
    $exitButton.Enabled=($script:state -ne 'unknown' -and $script:state -ne 'stopping' -and -not $script:pending)
    $miOpen.Enabled=$mainButton.Enabled; $miStop.Enabled=$stopButton.Enabled; $miExit.Enabled=$exitButton.Enabled
    $miLog.Enabled=[bool]$script:logFile; $logButton.Enabled=[bool]$script:logFile
    $confirmButton.Enabled=$savedCheck.Checked -and $externalCheck.Checked -and -not $script:pending
    $cancelButton.Enabled=-not $script:pending
}
function Report-Smoke {
    if (-not $SmokeTest) { return }
    $value=@{state=$script:state;generation=$script:generation;instance=$script:instance;visible=$window.Visible;canStart=($mainButton.Enabled -and $mainButton.Text -eq '启动服务');pending=[bool]$script:pending;confirm=$confirmPanel.Visible;reviewId=$script:lastReviewId;blockers=$blockerText.Text;versions=$versionLabel.Text;detail=$detailLabel.Text;waitingUrl=$hoster.Url;url=$script:url;pid=if($script:service){$script:service.Id}else{$null};
        runId=$env:PIVANE_NATIVE_QA_RUN_ID;root=$AppRoot;programRoot=$ProgramRoot;nodePath=$NodePath;trayPath=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName;componentVersions=$script:versions;components=$script:qaComponents}
    $json=ConvertTo-Json -Compress -Depth 8 $value
    if ($json -ne $script:lastReport) { [IO.File]::WriteAllText((Join-Path $AppRoot '.pivane-runtime\desktop\smoke-state.json'),$json,[Text.UTF8Encoding]::new($false));Write-QAReceipt 'tray-state' $value; $script:lastReport=$json }
}
function Make-Window {
    $script:window=[Windows.Forms.Form]::new(); $window.Text='白泽灵台 · 服务管理'; $window.Icon=$tray.Icon
    $window.Size=[Drawing.Size]::new(610,554); $window.MinimumSize=[Drawing.Size]::new(540,500); $window.StartPosition='CenterScreen'; $window.MaximizeBox=$false; $window.AutoScaleMode='None'; $window.Font=[Drawing.Font]::new('Microsoft YaHei UI',9)
    $script:layout=[Windows.Forms.TableLayoutPanel]::new(); $layout.Dock='Fill'; $layout.Padding=[Windows.Forms.Padding]::new(22); $layout.ColumnCount=1; $layout.RowCount=10
    foreach($height in @(42,50,122,44,105,0,38,0,38,28)) { $layout.RowStyles.Add([Windows.Forms.RowStyle]::new('Absolute',$height)) | Out-Null }; $window.Controls.Add($layout)
    $script:stateLabel=[Windows.Forms.Label]::new(); $stateLabel.Font=[Drawing.Font]::new($window.Font.FontFamily,17,[Drawing.FontStyle]::Bold); $stateLabel.Dock='Fill'; $layout.Controls.Add($stateLabel,0,0)
    $script:detailLabel=[Windows.Forms.Label]::new(); $detailLabel.Dock='Fill'; $layout.Controls.Add($detailLabel,0,1)
    $details=[Windows.Forms.TableLayoutPanel]::new(); $details.Dock='Fill'; $details.ColumnCount=2; $details.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Absolute',94)) | Out-Null; $details.ColumnStyles.Add([Windows.Forms.ColumnStyle]::new('Percent',100)) | Out-Null
    $label=[Windows.Forms.Label]::new();$label.Text='工作台地址';$label.AutoSize=$true;$details.Controls.Add($label,0,0)
    $script:addressBox=[Windows.Forms.TextBox]::new();$addressBox.ReadOnly=$true;$addressBox.Dock='Fill';$details.Controls.Add($addressBox,1,0)
    $label=[Windows.Forms.Label]::new();$label.Text='程序目录';$label.AutoSize=$true;$details.Controls.Add($label,0,1)
    $rootBox=[Windows.Forms.TextBox]::new();$rootBox.Text=$AppRoot;$rootBox.ReadOnly=$true;$rootBox.Dock='Fill';$details.Controls.Add($rootBox,1,1)
    $script:versionLabel=[Windows.Forms.Label]::new();$versionLabel.Dock='Fill';$versionLabel.AutoEllipsis=$true;$details.Controls.Add($versionLabel,1,2)
    $label=[Windows.Forms.Label]::new();$label.Text='系统默认浏览器 · 服务管理仅控制当前安装目录';$label.AutoSize=$true;$details.Controls.Add($label,1,3);$layout.Controls.Add($details,0,2)
    $actions=[Windows.Forms.FlowLayoutPanel]::new();$actions.Dock='Fill'
    $script:mainButton=[Windows.Forms.Button]::new();$mainButton.Size=[Drawing.Size]::new(132,32);$mainButton.add_Click({if($mainButton.Text -eq '启动服务'){Start-Run}else{Open-Workspace}});$actions.Controls.Add($mainButton)
    $script:stopButton=[Windows.Forms.Button]::new();$stopButton.Text='停止服务';$stopButton.Size=[Drawing.Size]::new(112,32);$stopButton.add_Click({Request-Stop 'stop'});$actions.Controls.Add($stopButton);$layout.Controls.Add($actions,0,3)
    $script:maintenanceButton=[Windows.Forms.Button]::new();$maintenanceButton.Text='版本与更新…';$maintenanceButton.Size=[Drawing.Size]::new(132,32);$maintenanceButton.add_Click({$script:maintenanceHint=$true;Open-Workspace;Update-Window});$actions.Controls.Add($maintenanceButton)
    $script:blockerText=[Windows.Forms.TextBox]::new();$blockerText.Multiline=$true;$blockerText.ReadOnly=$true;$blockerText.ScrollBars='Vertical';$blockerText.Dock='Fill';$blockerText.Text='停止前会检查当前任务、Shell、侧聊和预约。';$layout.Controls.Add($blockerText,0,4)
    $script:confirmPanel=[Windows.Forms.FlowLayoutPanel]::new();$confirmPanel.Dock='Fill';$confirmPanel.FlowDirection='TopDown';$confirmPanel.WrapContents=$false;$confirmPanel.Visible=$false
    $script:savedCheck=[Windows.Forms.CheckBox]::new();$savedCheck.Text='已保存浏览器中的草稿';$savedCheck.AutoSize=$true;$savedCheck.add_CheckedChanged({Update-Window});$confirmPanel.Controls.Add($savedCheck)
    $script:externalCheck=[Windows.Forms.CheckBox]::new();$externalCheck.Text='已停止本实例之外的 CLI / SDK 写入';$externalCheck.AutoSize=$true;$externalCheck.add_CheckedChanged({Update-Window});$confirmPanel.Controls.Add($externalCheck)
    $buttons=[Windows.Forms.FlowLayoutPanel]::new();$buttons.AutoSize=$true
    $script:confirmButton=[Windows.Forms.Button]::new();$confirmButton.Text='确认并重新检查';$confirmButton.AutoSize=$true;$confirmButton.add_Click({Confirm-Stop});$buttons.Controls.Add($confirmButton)
    $script:cancelButton=[Windows.Forms.Button]::new();$cancelButton.Text='取消';$cancelButton.add_Click({$script:review=$null;Set-Confirmation $false;$script:exitIntent=$false;Update-Window});$buttons.Controls.Add($cancelButton);$confirmPanel.Controls.Add($buttons);$layout.Controls.Add($confirmPanel,0,5)
    $logs=[Windows.Forms.FlowLayoutPanel]::new();$logs.Dock='Fill'
    $toggle=[Windows.Forms.Button]::new();$toggle.Text='展开近期日志';$toggle.AutoSize=$true;$toggle.add_Click({$logText.Visible=-not $logText.Visible;if($logText.Visible){$layout.RowStyles[7].Height=120*$script:uiScale;$window.Height+=[int](120*$script:uiScale);Read-RecentLog}else{$layout.RowStyles[7].Height=0;$window.Height-=[int](120*$script:uiScale)}});$logs.Controls.Add($toggle)
    $script:logButton=[Windows.Forms.Button]::new();$logButton.Text='完整日志';$logButton.add_Click({Open-Log});$logs.Controls.Add($logButton);$layout.Controls.Add($logs,0,6)
    $script:logText=[Windows.Forms.TextBox]::new();$logText.Multiline=$true;$logText.ReadOnly=$true;$logText.ScrollBars='Both';$logText.Dock='Fill';$logText.Visible=$false;$layout.Controls.Add($logText,0,7)
    $script:exitButton=[Windows.Forms.Button]::new();$exitButton.Text='退出白泽灵台';$exitButton.Anchor='Left';$exitButton.AutoSize=$true;$exitButton.add_Click({Request-Stop 'exit'});$layout.Controls.Add($exitButton,0,8)
    $hint=[Windows.Forms.Label]::new();$hint.Text='关闭或最小化窗口只会隐藏到系统托盘。';$hint.AutoSize=$true;$layout.Controls.Add($hint,0,9)
    $window.add_FormClosing({param($sender,$eventArgs) $eventArgs.Cancel=$true;$window.Hide()})
    $window.add_Resize({if($window.WindowState -eq 'Minimized'){$window.Hide()}})
    $graphics=$window.CreateGraphics();try{$script:uiScale=$graphics.DpiX/96.0}finally{$graphics.Dispose()}
    if($script:uiScale -ne 1){$window.Scale([Drawing.SizeF]::new($script:uiScale,$script:uiScale))}
    Update-Window
}
function Open-Log {
    if ($script:logFile -and [IO.File]::Exists($script:logFile)) { $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$script:logFile;$start.UseShellExecute=$true;[Diagnostics.Process]::Start($start) | Out-Null }
}
try {
    $AppRoot = [IO.Path]::GetFullPath($AppRoot)
    if([IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)) -ne $ProgramRoot){throw '托盘脚本与选定程序目录不一致。'}
    $env:PIVANE_INSTALLATION_ROOT=$AppRoot; $env:PIVANE_PROGRAM_ROOT=$ProgramRoot
    if (-not $script:strictQaRequested -and $env:PIVANE_DESKTOP_SMOKE_ROOT -eq $AppRoot) { $SmokeTest = $true }
    if ($SmokeTest -and (-not (Test-Path -LiteralPath (Join-Path $AppRoot '.pivane-launcher-test')) -or -not $env:PI_CODING_AGENT_DIR -or -not $env:PI_MEDIA_DATA_DIR -or -not $env:PI_WEB_DEFERRED_FILE)) { throw 'SmokeTest 仅允许独立合成实例。' }
    $script:smokeValidated = [bool]$SmokeTest
    $runner = Join-Path $ProgramRoot 'scripts\start-desktop.cjs'
    if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw '找不到白泽灵台程序。请保留完整目录结构。' }
    if (-not $NodePath) {
        foreach ($candidate in @((Join-Path $ProgramRoot 'runtime\node.exe'), (Join-Path (Split-Path $ProgramRoot -Parent) 'runtime\node.exe'))) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $NodePath = $candidate; break }
        }
        if (-not $NodePath) { $command = Get-Command node.exe -ErrorAction SilentlyContinue; if ($command) { $NodePath = $command.Source } }
    }
    if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw '没有找到 Node.js。请安装 Node.js 22，或在 runtime 目录放置 node.exe。' }
    if ($script:strictQaRequested) {
        # Reject Node preload/options before launching even the validation CLI.
        foreach ($name in [Environment]::GetEnvironmentVariables().Keys) { if ($name -match '^NODE_') { throw 'Native QA rejects Node execution options.' } }
        $qaStart = [Diagnostics.ProcessStartInfo]::new(); $qaStart.FileName = $NodePath
        $qaCli = Join-Path $ProgramRoot 'scripts\launcher-qa.cjs'
        $qaStart.Arguments = '"' + $qaCli + '" validate "' + $AppRoot.TrimEnd('\') + '"'
        $qaStart.UseShellExecute = $false; $qaStart.CreateNoWindow = $true
        $qaStart.RedirectStandardOutput = $true; $qaStart.RedirectStandardError = $true
        $qaStart.StandardOutputEncoding = [Text.UTF8Encoding]::new($false); $qaStart.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
        $qa = [Diagnostics.Process]::Start($qaStart)
        try {
            $qaOutput = $qa.StandardOutput.ReadToEndAsync(); $qaError = $qa.StandardError.ReadToEndAsync()
            if (-not $qa.WaitForExit(30000)) { $qa.Kill(); $qa.WaitForExit(); throw 'Native QA validation timed out.' }
            $qaText = $qaOutput.GetAwaiter().GetResult(); $qaFailure = $qaError.GetAwaiter().GetResult()
            if ($qa.ExitCode -ne 0 -or $qaText.Length -gt 65536) { throw ('Native QA validation failed. ' + $qaFailure.Substring(0, [Math]::Min(1024,$qaFailure.Length))) }
            $qaContext = $qaText | ConvertFrom-Json
            if ($qaContext.PIVANE_NATIVE_QA -ne '1' -or $qaContext.PIVANE_DESKTOP_SMOKE_ROOT -cne $AppRoot) { throw 'Native QA validation did not authorize this root.' }
            foreach ($property in $qaContext.PSObject.Properties) { [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process') }
            $SmokeTest = $true; $script:smokeValidated = $true
        } finally { $qa.Dispose() }
    }
    # Prepend bundled tools and real Git Bash, avoiding the Windows WSL bash shim.
    $toolPaths = @()
    foreach ($base in @($ProgramRoot, (Split-Path $ProgramRoot -Parent))) {
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
    $ProgramRoot = $metadata.programRoot

    $created=$false; $mutex=[Threading.Mutex]::new($true,('Local\pivane-desktop-'+$metadata.id),[ref]$created);$ownsMutex=$created
    if(-not $ownsMutex){try{$ownsMutex=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$ownsMutex=$true}}
    $openEvent=[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::AutoReset,('Local\pivane-open-'+$metadata.id))
    if(-not $ownsMutex){if(-not $NoOpen){$openEvent.Set() | Out-Null};Record-Event @{type='existing-instance'}}else{
        $script:nativeAssembly=[Reflection.Assembly]::LoadFrom((Join-Path $ProgramRoot '白泽灵台.exe'))
        [PivaneDesktopNative]::EnableDpiAwareness()
        $reservedPorts=[int[]]@($metadata.reservedPorts | Where-Object { $_ -ge 1 -and $_ -le 65535 })
        $hoster=[PivaneStartupHost]::new($ProgramRoot,$script:instance,$reservedPorts)
        $tray=[Windows.Forms.NotifyIcon]::new();$tray.Icon=[Drawing.Icon]::new((Join-Path $ProgramRoot 'public\brand\favicon.ico'));$tray.Visible=$true
        $menu=[Windows.Forms.ContextMenuStrip]::new();$miStatus=$menu.Items.Add('正在启动');$miStatus.Enabled=$false
        $miManage=$menu.Items.Add('服务管理');$miManage.add_Click({Show-Management})
        $miOpen=$menu.Items.Add('打开工作台');$miOpen.add_Click({Open-Workspace})
        $miStop=$menu.Items.Add('停止服务');$miStop.add_Click({Request-Stop 'stop'})
        $miLog=$menu.Items.Add('查看本次日志');$miLog.add_Click({Open-Log})
        $menu.Items.Add([Windows.Forms.ToolStripSeparator]::new()) | Out-Null
        $miExit=$menu.Items.Add('退出白泽灵台');$miExit.add_Click({Request-Stop 'exit'})
        $tray.ContextMenuStrip=$menu;$tray.add_DoubleClick({Show-Management});$context=[Windows.Forms.ApplicationContext]::new()
        Make-Window
        Start-Run
        $timer=[Windows.Forms.Timer]::new();$timer.Interval=100
        $timer.add_Tick({
            if($script:tickBusy){return};$script:tickBusy=$true
            try{
                if($script:service){
                    $owner=$script:service;$generation=$script:generation
                    while($script:readTask -and $script:readTask.IsCompleted){$line=$script:readTask.GetAwaiter().GetResult();if($null -eq $line){$script:readTask=$null;break};$script:readTask=$owner.StandardOutput.ReadLineAsync();Handle-Message $line $owner $generation}
                    while($script:errorTask -and $script:errorTask.IsCompleted){$line=$script:errorTask.GetAwaiter().GetResult();if($null -eq $line){$script:errorTask=$null;break};if($ConsoleMode){Write-Host $line};$script:errorTask=$owner.StandardError.ReadLineAsync()}
                    if($owner.HasExited -and -not $script:readTask -and -not $script:errorTask){
                        $code=$owner.ExitCode;Record-Event @{type='exited';exitCode=$code;generation=$generation};$owner.Dispose();$script:service=$null;$script:pending=$null;$script:review=$null;Set-Confirmation $false
                        if($script:ownerRefused){Set-State 'error'}
                        elseif(-not $script:clean){Show-Failure '本轮进程已退出，但服务和 Agent 清理未获确认。';Set-State 'unknown'}
                        elseif($code -ne 0 -or $script:lastError){Set-State 'error'}else{Set-State 'stopped'}
                        if($script:exitIntent -and $script:clean){$context.ExitThread()}
                    }
                }
                if($openEvent.WaitOne(0)){Open-Workspace}
                if(($script:state -eq 'ready' -or ($script:state -eq 'unknown' -and $script:recoverStop)) -and -not $script:pending -and -not $script:review -and ([DateTime]::UtcNow-$script:lastSnapshot).TotalSeconds -ge 3){$script:lastSnapshot=[DateTime]::UtcNow;Send-Request 'snapshot' @{} | Out-Null}
                if($script:pending -and -not $script:pending.timeoutReported -and ([DateTime]::UtcNow-$script:pending.started).TotalSeconds -ge 30){$script:pending.timeoutReported=$true;if($script:pending.type -eq 'execute-stop'){$script:recoverStop=$true};Show-Failure '控制请求结果尚未确定；不会重放请求。';Set-State 'unknown'}
                if($SmokeTest){
                    $commandFile=Join-Path $AppRoot '.pivane-launcher-command.json'
                    if(Test-Path -LiteralPath $commandFile){
                        $command=Get-Content -LiteralPath $commandFile -Raw | ConvertFrom-Json
                        $matchingCommand=(-not $script:strictQaRequested) -or ($command.schemaVersion -eq 1 -and $command.runId -ceq $env:PIVANE_NATIVE_QA_RUN_ID -and $command.instance -ceq $script:instance -and $command.generation -ceq $script:generation -and $command.id -cmatch '^[a-f0-9-]{36}$')
                        if($matchingCommand -and $command.id -ne $script:smokeCommand){$script:smokeCommand=$command.id;switch($command.action){
                            'finish'{$context.ExitThread()};'show'{Show-Management};'hide'{$window.Close()};'minimize'{$window.WindowState='Minimized'};'open'{Open-Workspace};'start'{Start-Run};'stop'{Request-Stop 'stop'};'exit'{Request-Stop 'exit'};'updates'{$maintenanceButton.PerformClick()}
                            'confirm'{$savedCheck.Checked=$true;$externalCheck.Checked=$true;Confirm-Stop}
                            'capture'{Show-Management;$bitmap=[Drawing.Bitmap]::new($window.Width,$window.Height);try{$window.DrawToBitmap($bitmap,[Drawing.Rectangle]::new(0,0,$window.Width,$window.Height));$capture=Join-Path $AppRoot '.pivane-runtime\desktop\management.png';$temporary=$capture+'.tmp';$bitmap.Save($temporary,[Drawing.Imaging.ImageFormat]::Png);if([IO.File]::Exists($capture)){[IO.File]::Replace($temporary,$capture,$null)}else{[IO.File]::Move($temporary,$capture)}}finally{$bitmap.Dispose()}}
                        }}
                    }
                    if(-not $script:strictQaRequested -and -not $script:smokeStopSent -and $script:readyAt -and ((Test-Path -LiteralPath (Join-Path $AppRoot '.pivane-launcher-stop')) -or ([DateTime]::UtcNow-$script:readyAt).TotalSeconds -ge 120)){$script:smokeStopSent=$true;Request-Stop 'exit'}
                    if($script:smokeStopSent -and $script:review){$savedCheck.Checked=$true;$externalCheck.Checked=$true;Confirm-Stop}
                    if($script:state -in @('error','unknown') -and -not $script:service -and -not (Test-Path -LiteralPath (Join-Path $AppRoot '.pivane-launcher-stay'))){$context.ExitThread()}
                    Report-Smoke
                }
            }catch{Show-Failure $_.Exception.Message;Set-State 'unknown';if($SmokeTest){$context.ExitThread()}}
            finally{$script:tickBusy=$false}
        });$timer.Start();[Windows.Forms.Application]::Run($context)
    }
}catch{Show-Failure $_.Exception.Message}
finally{
    if($timer){$timer.Stop();$timer.Dispose()}
    if($script:service){if(-not $script:service.HasExited){$script:service.StandardInput.Close();$script:service.WaitForExit()};$script:service.Dispose()}
    if($script:smokeValidated -and ($ownsMutex -or -not $mutex)){Record-Event @{type='tray-finalized';generation=$script:generation;clean=$script:clean}}
    if($script:smokeValidated -and ($ownsMutex -or -not $mutex)){$report=Join-Path $AppRoot '.pivane-runtime\desktop\smoke-result.json';[IO.Directory]::CreateDirectory((Split-Path $report -Parent)) | Out-Null;[IO.File]::WriteAllText($report,(ConvertTo-Json -InputObject $script:events.ToArray() -Depth 6),[Text.UTF8Encoding]::new($false))}
    if($hoster){$hoster.Dispose()};if($window){$window.Dispose()};if($tray){$tray.Visible=$false;$tray.Icon.Dispose();$tray.Dispose()};if($context){$context.Dispose()};if($openEvent){$openEvent.Dispose()};if($ownsMutex){$mutex.ReleaseMutex()};if($mutex){$mutex.Dispose()}
}
exit $script:result
