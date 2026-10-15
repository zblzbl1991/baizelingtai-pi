param(
    [Parameter(Mandatory = $true)][string]$InputDirectory,
    [Parameter(Mandatory = $true)][ValidateSet('word', 'wps')][string]$Office,
    [switch]$VerifyRevisions
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GongwenOfficeWindow {
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$inputRoot = (Resolve-Path -LiteralPath $InputDirectory).Path
$initialIds = @(Get-Process -Name WINWORD,wps,kwps -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$application = $null
$owned = $false
$document = $null
$results = @()
$expectations = $null
if ($VerifyRevisions) { $expectations = Get-Content -LiteralPath (Join-Path $inputRoot 'revision-expectations.json') -Encoding UTF8 -Raw | ConvertFrom-Json }
try {
    if ($Office -eq 'word') {
        $nativeWord = $false
        foreach ($key in @('Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WINWORD.EXE', 'Registry::HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WINWORD.EXE')) {
            if (Test-Path -LiteralPath $key) {
                $binary = (Get-Item -LiteralPath $key).GetValue('')
                if ($binary -and (Test-Path -LiteralPath $binary)) {
                    $nativeWord = $nativeWord -or ((Split-Path -Leaf $binary) -ieq 'WINWORD.EXE' -and (Get-Item -LiteralPath $binary).VersionInfo.CompanyName -match 'Microsoft')
                }
            }
        }
        if (!$nativeWord) { throw 'Native Microsoft Word was not found; a registered Word.Application compatibility alias is not Word verification' }
    }
    $application = New-Object -ComObject $(if ($Office -eq 'word') { 'Word.Application' } else { 'KWPS.Application' })
    if ($null -eq $application.Documents.Count -or $application.Documents.Count -ne 0 -or $application.Visible) {
        throw 'Office automation returned an existing application; user documents were preserved'
    }
    $version = [string]$application.Version
    foreach ($file in Get-ChildItem -LiteralPath $inputRoot -Filter '*.docx' -File) {
        $pdf = Join-Path $inputRoot ($Office + '-' + $file.BaseName + '.pdf')
        if (Test-Path -LiteralPath $pdf) { throw 'Render output already exists; nothing was overwritten' }
        $document = $application.Documents.Open($file.FullName, $false, $true, $false)
        try {
            if (!$owned) {
                # Hwnd belongs to Word.Window, not Word.Application.
                [uint32]$officeProcessId = 0
                [void][GongwenOfficeWindow]::GetWindowThreadProcessId([IntPtr]$document.ActiveWindow.Hwnd, [ref]$officeProcessId)
                if ($officeProcessId -eq 0 -or $initialIds -contains $officeProcessId) { throw 'Office instance ownership could not be verified; existing applications were preserved' }
                $owned = $true
                $application.Visible = $false
                $application.DisplayAlerts = 0
                try { $application.AutomationSecurity = 3 } catch { }
            }
            $document.Repaginate()
            $pages = [int]$document.ComputeStatistics(2)
            $document.ExportAsFixedFormat($pdf, 17)
            if (!(Test-Path -LiteralPath $pdf) -or (Get-Item -LiteralPath $pdf).Length -lt 1000) { throw 'Office did not produce a complete PDF' }
            $review = $null
            if ($VerifyRevisions) {
                $expected = $expectations.PSObject.Properties[$file.Name].Value
                if ($null -ne $expected) {
                    if ($expected.source -match '[/\\]' -or $expected.source -notmatch '\.docx$') { throw 'Invalid synthetic source name' }
                    $sourcePath = Join-Path $inputRoot $expected.source
                    $baselineDocument = $application.Documents.Open($sourcePath, $false, $true, $false)
                    try { $baselineText = [string]$baselineDocument.Content.Text }
                    finally { $baselineDocument.Close(0); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($baselineDocument) }
                    $ownCount = 0
                    $commentCount = [int]$document.Comments.Count
                    for ($index = [int]$document.Revisions.Count; $index -ge 1; $index--) {
                        $revision = $document.Revisions.Item($index)
                        try { if ([string]$revision.Author -eq $expected.author) { $ownCount++; $revision.Reject() } }
                        finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($revision) }
                    }
                    if ($ownCount -eq 0) { throw 'Office did not recognize this round of tracked revisions' }
                    if ([string]$document.Content.Text -cne $baselineText) { throw 'Rejecting this round did not restore the original native document text' }
                    $document.Close(0); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
                    $document = $application.Documents.Open($file.FullName, $false, $true, $false)
                    $accepted = 0
                    for ($index = [int]$document.Revisions.Count; $index -ge 1; $index--) {
                        $revision = $document.Revisions.Item($index)
                        try { if ([string]$revision.Author -eq $expected.author) { $accepted++; $revision.Accept() } }
                        finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($revision) }
                    }
                    if ($accepted -eq 0 -or $commentCount -lt 1) { throw 'Office did not accept tracked revisions or recognize comments' }
                    $review = @{ author = $expected.author; revisionsRejected = $ownCount; revisionsAccepted = $accepted; comments = $commentCount; rejectRestoresOriginal = $true }
                }
            }
            $results += [pscustomobject]@{ name = $file.Name; pdf = $pdf; pages = $pages; office = $Office; version = $version; review = $review }
        } finally {
            $document.Close(0)
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document)
            $document = $null
        }
    }
    $results | ConvertTo-Json -Depth 4
} finally {
    if ($null -ne $document) { $document.Close(0); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
    if ($null -ne $application) {
        if ($owned) { $application.Quit(0) }
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($application)
    }
}
