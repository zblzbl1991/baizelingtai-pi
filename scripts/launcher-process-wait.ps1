$ErrorActionPreference = 'Stop'
# The helper opens every exact process object before acknowledging handoff. A PID
# is used only to open the object; identity and termination use that held HANDLE.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public sealed class PivaneProcessWait : IDisposable {
    [DllImport("kernel32.dll", SetLastError=true)] static extern SafeWaitHandle OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(SafeWaitHandle handle, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(SafeWaitHandle handle, uint milliseconds);
    SafeWaitHandle handle;
    public PivaneProcessWait(uint id, string creationTime) {
        handle = OpenProcess(0x100000 | 0x1000, false, id);
        long created, exited, kernel, user;
        if (handle.IsInvalid || !GetProcessTimes(handle, out created, out exited, out kernel, out user) || created.ToString(System.Globalization.CultureInfo.InvariantCulture) != creationTime || WaitForSingleObject(handle, 0) != 258) {
            handle.Dispose(); throw new InvalidOperationException("Exact live process identity unavailable");
        }
    }
    public void Wait(uint milliseconds) { if(WaitForSingleObject(handle, milliseconds) != 0) throw new InvalidOperationException("Process exit proof unavailable; timeout is not termination"); }
    public void Dispose() { handle.Dispose(); }
}
'@
$held = [Collections.Generic.List[IDisposable]]::new()
try {
    $items = @(ConvertFrom-Json ([Console]::ReadLine()))
    if ($items.Count -lt 1 -or $items.Count -gt 3) { throw 'Invalid process identity count' }
    foreach($item in $items) { $held.Add([PivaneProcessWait]::new([uint32]$item.pid, [string]$item.creationTime)) }
    [Console]::WriteLine('ready'); [Console]::Out.Flush()
    $deadline = [DateTime]::UtcNow.AddMinutes(2)
    foreach($item in $held) {
        $remaining = [Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        $item.Wait([uint32]$remaining)
    }
    [Console]::WriteLine('exited'); [Console]::Out.Flush()
} finally { foreach($item in $held) { $item.Dispose() } }
