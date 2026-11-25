$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'logs\hide-console.log'
if (-not (Test-Path (Split-Path $log))) { New-Item -ItemType Directory -Path (Split-Path $log) -Force | Out-Null }
function WL([string]$m){ try { [System.IO.File]::AppendAllText($log, "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m`r`n") } catch {} }

WL "===== hide-console start ====="
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ConsoleHider2 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
'@
} catch {
  WL "Add-Type failed: $($_.Exception.Message)"
  exit 0
}

# Only hide WindowsTerminal windows whose title points to a node.exe console.
# Never kills any process; fully reversible (use ShowWindow SW_SHOW to restore).
$targets = @(Get-Process | Where-Object {
  $_.ProcessName -eq 'WindowsTerminal' -and $_.MainWindowTitle -like '*node.exe*'
})
if ($targets.Count -eq 0) { WL 'no matching terminal window'; exit 0 }
foreach ($t in $targets) {
  $h = $t.MainWindowHandle
  if ($h -eq [IntPtr]::Zero) { continue }
  $before = [ConsoleHider2]::IsWindowVisible($h)
  [ConsoleHider2]::ShowWindow($h, 0) | Out-Null
  Start-Sleep -Milliseconds 300
  $after = [ConsoleHider2]::IsWindowVisible($h)
  WL "PID $($t.ProcessId) title='$($t.MainWindowTitle)' visible $before -> $after"
}
WL 'done: terminal window hidden, bridge process untouched'
