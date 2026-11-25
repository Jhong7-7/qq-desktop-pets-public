<#
focus-mode.ps1 -- power profile switch for the two desktop pets.

  quiet = you are actively using the PC -> suspend background chatter,
          lower CPU priority, but QQ passive replies stay FULLY alive.
  full  = you are away (idle / session locked) -> restore everything.

Detection: Win32 GetLastInputInfo idle seconds + LogonUI (locked session).
One-shot manual switch (used by focus-quiet.vbs / focus-full.vbs):
  powershell -File focus-mode.ps1 -Apply quiet|full
  Applies immediately and exits. Does NOT need the daemon.

Legacy manual override (only meaningful while the daemon still runs):
  focus-mode.override containing "quiet" or "full";
  delete the file (or -Set auto) to return to automatic detection.
  powershell -File focus-mode.ps1 -Set quiet|full|auto

Automatic guardian (idle/lock detection loop) is DISABLED by user request
(2026-11-18). The Startup entry is a no-op; only the two manual switches
above switch modes now. Nothing here restarts Coopanion or the bridge. World enable/disable goes
through /api/worlds/activation (hot, no process restart); proactive chatter
is gated by focus-mode.flag which bridge.mjs checks live. The qq world, the
bridge, /chat, @ routing, anti-loop and appointment alarms are never touched.

Priority is owned solely by this script (watchdog.ps1 deliberately does not
set it), so the two daemons never fight over process priority.
#>
param(
  [int]$IntervalSec = 15,
  [int]$IdleThresholdSec = 600,
  [string]$Set = '',
  [string]$Apply = ''
)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$logFile = Join-Path $root 'logs\focus-mode.log'
$stateFile = Join-Path $root 'focus-mode-state.json'
$overrideFile = Join-Path $root 'focus-mode.override'
$flagFile = Join-Path $root 'focus-mode.flag'
$cooConfig = 'D:\coopanion\data\home\companion\config.json'
$apiBase = 'http://127.0.0.1:17788'
$utf8 = New-Object System.Text.UTF8Encoding($false)

$logDir = Split-Path -Parent $logFile
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Log([string]$msg) {
  try {
    if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 1048576) {
      Move-Item -Path $logFile -Destination "$logFile.1" -Force
    }
    [System.IO.File]::AppendAllText($logFile, "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg`n", $utf8)
  } catch { }
}

# ---- manual override: write the marker and exit, no daemon side effects ----
if ($Set -ne '') {
  $v = $Set.ToLower().Trim()
  if ($v -eq 'quiet' -or $v -eq 'full') {
    [System.IO.File]::WriteAllText($overrideFile, $v, $utf8)
    Write-Log "manual override -> $v (daemon applies within ${IntervalSec}s)"
  } elseif ($v -eq 'auto') {
    Remove-Item $overrideFile -Force -ErrorAction SilentlyContinue
    Write-Log 'manual override cleared -> auto'
  } else {
    Write-Log "unknown -Set value: $Set"
  }
  exit 0
}

# ---- Win32 idle probe (last keyboard/mouse input) ----
$idleProbeOk = $false
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FocusIdleProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  [DllImport("kernel32.dll")] public static extern uint GetTickCount();
  public static double IdleSeconds() {
    LASTINPUTINFO li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref li)) return -1;
    long d = (long)GetTickCount() - (long)li.dwTime;
    if (d < 0) d += 4294967296L;   // GetTickCount wraps every ~49.7 days
    return d / 1000.0;
  }
}
'@ -ErrorAction Stop
  $idleProbeOk = $true
} catch {
  Write-Log "idle probe unavailable ($($_.Exception.Message)); lock detection only"
}

try {
  $mutex = [System.Threading.Mutex]::new($false, 'Local\dsh-pet-qq-focus-mode')
  if (-not $mutex.WaitOne(0, $false)) { Write-Log 'another focus-mode daemon is running, exit'; exit 0 }
} catch {
  Write-Log "mutex failed: $($_.Exception.Message)"; exit 1
}

# Worlds suspended while the PC is in use. All are self-triggered / background /
# network-facing; NONE is needed to answer an incoming QQ message.
$quietDisable = @(
  'selftalk',    'qzone',      'daily-life', 'terrarium',
  'image',      'gpt-sovits', 'rvc',        'songs'
)
# Hard protection: the QQ reply chain and persona core are never switched.
$protect = @('qq', 'console', 'coopanion', 'desktop-pet', 'memory', 'clock', 'wechat')
$quietDisable = @($quietDisable | Where-Object { $protect -notcontains $_ })
$petProcNames = @('Coopanion', 'DeepSeek Harness')

function Read-State {
  try {
    if (Test-Path $stateFile) { return (Get-Content $stateFile -Raw | ConvertFrom-Json) }
  } catch { Write-Log "state read failed: $($_.Exception.Message)" }
  return $null
}
function Read-Saved($state) {
  $d = @{}
  try {
    if ($null -ne $state -and $null -ne $state.savedEnabled) {
      foreach ($p in $state.savedEnabled.PSObject.Properties) { $d[$p.Name] = [bool]$p.Value }
    }
  } catch { }
  return $d
}
function Write-State($obj) {
  try {
    $tmp = "$stateFile.tmp"
    [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 6), $utf8)
    Move-Item -Path $tmp -Destination $stateFile -Force
  } catch { Write-Log "state write failed: $($_.Exception.Message)" }
}
function Get-CooStatus {
  try { return Invoke-RestMethod -Uri "$apiBase/api/status" -TimeoutSec 5 } catch { return $null }
}
function Set-World([string]$id, [bool]$on) {
  try {
    $body = @{ id = $id; enabled = $on } | ConvertTo-Json -Compress
    $r = Invoke-RestMethod -Uri "$apiBase/api/worlds/activation" -Method Post `
      -Body $body -ContentType 'application/json' -TimeoutSec 10
    return ($r.ok -eq $true)
  } catch {
    Write-Log "world $id -> $on failed: $($_.Exception.Message)"
    return $false
  }
}
function Get-WorldEnabled([string]$id) {
  # Read the RUNTIME truth from /api/worlds, not config.json: the activation
  # endpoint writes config asynchronously, and PowerShell 5.1 reads UTF-8
  # files with a legacy codepage. status 'active' == enabled.
  try {
    $ws = Invoke-RestMethod -Uri "$apiBase/api/worlds" -TimeoutSec 6
    foreach ($w in $ws.worlds) {
      if ($w.id -eq $id) {
        if ($w.status -eq 'active') { return $true }
        if ($w.status -eq 'inactive') { return $false }
        return $null
      }
    }
    return $null
  } catch { return $null }
}
function Set-PetPriority([string]$prio) {
  try {
    foreach ($p in (Get-Process | Where-Object { $petProcNames -contains $_.ProcessName })) {
      try { if ($p.PriorityClass -ne $prio) { $p.PriorityClass = $prio } } catch { }
    }
  } catch { }
}
function Set-BridgeFlag([bool]$on) {
  try {
    if ($on) { [System.IO.File]::WriteAllText($flagFile, "quiet`n", $utf8) }
    else { Remove-Item $flagFile -Force -ErrorAction SilentlyContinue }
  } catch { Write-Log "bridge flag failed: $($_.Exception.Message)" }
}

function Switch-To([string]$want) {
  $state = Read-State
  $st = Get-CooStatus
  if ($null -eq $st) { Write-Log 'Coo API unavailable, postpone switch'; return $false }
  $phase = $st.loop.phase.state
  if ($phase -ne 'idle') { Write-Log "Coo busy (phase=$phase), postpone switch to $want"; return $false }

  $saved = Read-Saved $state
  if ($want -eq 'quiet') {
    # Remember each world's ORIGINAL enabled value so a crash mid-mode still
    # restores exactly. Worlds the user had already disabled stay disabled.
    foreach ($id in $quietDisable) {
      if (-not $saved.ContainsKey($id)) {
        $cur = Get-WorldEnabled $id
        if ($null -ne $cur) { $saved[$id] = [bool]$cur }
      }
      if ((Get-WorldEnabled $id) -ne $false) { [void](Set-World $id $false) }
    }
    Set-BridgeFlag $true
    Set-PetPriority 'BelowNormal'
    Write-State ([pscustomobject]@{ mode = 'quiet'; savedEnabled = $saved; at = (Get-Date).ToString('o') })
    Write-Log "-> QUIET (pc in use): suspended $($quietDisable.Count) background worlds, proactive chatter paused, priority BelowNormal"
  } else {
    foreach ($id in @($saved.Keys)) { [void](Set-World $id ([bool]$saved[$id])) }
    Set-BridgeFlag $false
    Set-PetPriority 'Normal'
    Write-State ([pscustomobject]@{ mode = 'full'; savedEnabled = @{}; at = (Get-Date).ToString('o') })
    Write-Log "-> FULL (away): restored $($saved.Count) worlds, proactive chatter on, priority Normal"
  }
  return $true
}

function Get-WantMode {
  $ov = ''
  if (Test-Path $overrideFile) {
    try { $ov = ([System.IO.File]::ReadAllText($overrideFile)).Trim().ToLower() } catch { }
  }
  if ($ov -eq 'quiet' -or $ov -eq 'full') { return $ov }
  if (@(Get-Process -Name LogonUI -ErrorAction SilentlyContinue).Count -gt 0) { return 'full' }
  if ($idleProbeOk) {
    try {
      $idle = [FocusIdleProbe]::IdleSeconds()
      if ($idle -ge 0 -and $idle -ge $IdleThresholdSec) { return 'full' }
    } catch { }
  }
  return 'quiet'
}

# ---- one-shot manual apply: immediate switch, no daemon required ----
# Used by the two manual VBS switches. Retries briefly if Coo is mid-reply,
# so a click is not silently lost. Exits right after the switch.
if ($Apply -ne '') {
  $v = $Apply.ToLower().Trim()
  if ($v -eq 'quiet' -or $v -eq 'full') {
    $ok = $false
    for ($i = 0; $i -lt 10 -and -not $ok; $i++) {
      $ok = Switch-To $v
      if (-not $ok) { Start-Sleep -Seconds 2 }
    }
    if ($ok) { Write-Log "one-shot apply -> $v (no daemon)" }
    else { Write-Log "one-shot apply -> $v FAILED (Coo busy/unavailable after 10 tries)" }
  } else {
    Write-Log "unknown -Apply value: $Apply"
  }
  exit 0
}

Write-Log "focus-mode daemon start PID=$PID interval=${IntervalSec}s idleThreshold=${IdleThresholdSec}s idleProbe=$idleProbeOk"
# Force one switch on startup so a crash mid-mode is always reconciled.
$current = ''
while ($true) {
  try {
    $want = Get-WantMode
    if ($want -ne $current) {
      if (Switch-To $want) { $current = $want }
    } else {
      # Idempotent: covers Electron children spawned after a pet restart.
      Set-PetPriority $(if ($want -eq 'quiet') { 'BelowNormal' } else { 'Normal' })
    }
  } catch {
    Write-Log "loop error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $IntervalSec
}
