<#
restore-auto-start.ps1 -- undo the 2026-11-18 "manual only" change.

Restores everything that was disabled on 2026-11-18:
  1. the 7 startup-folder VBS scripts (moved to disabled-startup-20261118\)
  2. the HKCU Run value CoopanionTunnelGuard (phone tunnel guard)
  3. the SnowLuma-Start-Temp scheduled task

WARNING: restoring also brings BACK the two auto-reconnect daemons
(watchdog.ps1 for the QQ/bridge chain and tunnel-guard.py for the phone
tunnel). Only run this if you want automatic startup + auto-reconnect again.

Nothing here is deleted; the disabled originals are kept either way.
#>
$ErrorActionPreference = 'Continue'

$startup = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
$bk = 'D:\dsh workplace\tools\dsh-pet-qq\disabled-startup-20261118'

# 1) startup folder scripts
$names = @(
  'CoopanionTunnel.vbs', 'DeskPets.vbs', 'FocusMode.vbs', 'QQ-Clients.vbs',
  'SnowLuma.vbs', 'StarpostFilterGuard.vbs', 'dsh-pet-qq-watchdog.vbs'
)
foreach ($n in $names) {
  $src = Join-Path $bk $n
  $dst = Join-Path $startup $n
  if ((Test-Path $src) -and -not (Test-Path $dst)) {
    Copy-Item -LiteralPath $src -Destination $dst -Force
    Write-Host "restored startup: $n"
  } else {
    Write-Host "skip startup: $n (missing backup or already present)"
  }
}

# 2) registry Run value (ASCII-safe reconstruction of the Chinese folder)
$folder = 'coo' + [char]0x624B + [char]0x673A + [char]0x5316
$runVal = '"C:\Users\86189\.workbuddy\binaries\python\versions\3.13.12\pythonw.exe" "D:\wb\' + $folder + '\tunnel-guard.py"'
$k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$cur = (Get-ItemProperty -Path $k -Name 'CoopanionTunnelGuard' -ErrorAction SilentlyContinue).CoopanionTunnelGuard
if (-not $cur) {
  New-ItemProperty -Path $k -Name 'CoopanionTunnelGuard' -Value $runVal -PropertyType String -Force | Out-Null
  Write-Host 'restored registry: CoopanionTunnelGuard'
} else {
  Write-Host "skip registry: already present ($cur)"
}

# 3) scheduled task
$x = Join-Path $bk 'SnowLuma-Start-Temp.xml'
if (Test-Path $x) {
  try {
    Register-ScheduledTask -TaskName 'SnowLuma-Start-Temp' -Xml (Get-Content $x -Raw) -Force | Out-Null
    Enable-ScheduledTask -TaskName 'SnowLuma-Start-Temp' | Out-Null
    Write-Host 'restored scheduled task: SnowLuma-Start-Temp'
  } catch { Write-Host "task restore failed: $($_.Exception.Message)" }
} else { Write-Host 'skip task: no XML backup' }

Write-Host ''
Write-Host 'Done. Re-login (or reboot) for the startup items to take effect.'
