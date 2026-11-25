<#
hide-snowluma.ps1 —— 隐藏当前 SnowLuma 的控制台窗口，不结束任何进程、不中断服务。

背景：启动项 SnowLuma.vbs 已改为 SW_HIDE(0)，但那要下次登录才生效；
       当前这次会话里那个已经打开的 cmd 窗口需要单独隐藏一次。
双击 hide-snowluma.bat 运行，或由 keep-alive.bat 顺带调用；可重复运行。
#>
$ErrorActionPreference = 'Continue'

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SnowLumaWinHide {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
'@
} catch {
  Write-Host "  无法加载 Win32 窗口 API：$($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host '  不影响使用：下次登录起 SnowLuma 就是隐藏启动的。' -ForegroundColor Yellow
  exit 0
}

# 只认「跑着 SnowLuma\start.bat 的 cmd」，绝不碰别的命令行窗口。
$targets = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
  Where-Object { $_.CommandLine -like '*SnowLuma*start.bat*' })

if ($targets.Count -eq 0) {
  Write-Host '  没有发现 SnowLuma 控制台窗口（可能已隐藏，或 SnowLuma 未启动）'
  exit 0
}

foreach ($t in $targets) {
  $p = Get-Process -Id $t.ProcessId -ErrorAction SilentlyContinue
  if (-not $p -or $p.MainWindowHandle -eq [IntPtr]::Zero) { continue }
  $h = $p.MainWindowHandle
  if (-not [SnowLumaWinHide]::IsWindowVisible($h)) {
    Write-Host "  PID $($t.ProcessId) 已经是隐藏状态"
    continue
  }
  [SnowLumaWinHide]::ShowWindow($h, 0) | Out-Null
  Write-Host "  已隐藏 SnowLuma 控制台窗口（PID $($t.ProcessId)，进程保持运行）" -ForegroundColor Green
}
