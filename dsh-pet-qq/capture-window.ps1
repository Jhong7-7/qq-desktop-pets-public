param(
  [ValidateSet('probe', 'capture')][string]$Mode = 'probe',
  [long]$ExpectHwnd = 0,
  [int]$MaxEdge = 1280,
  [int]$Quality = 72,
  [int]$MaxBytes = 600000,
  [int]$MinWidth = 320,
  [int]$MinHeight = 240
)

# Captures the foreground window rectangle only. Never captures the whole
# virtual desktop, never writes an image file: the JPEG goes out as base64 on
# stdout and is consumed straight into the dsh-pet /chat attachment.
# All comments and literals are ASCII on purpose (Windows PowerShell 5.1 reads
# BOM-less .ps1 as ANSI, non-ASCII source would be corrupted).
$ErrorActionPreference = 'Stop'

# CodeDom compilation of the tiny Win32 helper needs an ASCII temp path.
$tempCandidates = @()
if ($env:LOCALAPPDATA) { $tempCandidates += (Join-Path $env:LOCALAPPDATA 'Temp') }
$tempCandidates += 'C:\Windows\Temp'
if ($env:TEMP) { $tempCandidates += $env:TEMP }
$asciiTemp = $null
foreach ($c in $tempCandidates) {
  if ($c -and ($c -match '^[\x20-\x7e]+$') -and (Test-Path $c)) { $asciiTemp = $c; break }
}
if ($asciiTemp) { $env:TEMP = $asciiTemp; $env:TMP = $asciiTemp }

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5))
}

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $helper = @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public struct PetRect { public int Left; public int Top; public int Right; public int Bottom; }

public static class PetWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out PetRect r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);

  public static IntPtr EnterDpi() {
    try { return SetThreadDpiAwarenessContext(new IntPtr(-4)); }
    catch { return IntPtr.Zero; }
  }
  public static void LeaveDpi(IntPtr p) {
    try { SetThreadDpiAwarenessContext(p); } catch { }
  }
}
'@
  Add-Type -TypeDefinition $helper -ReferencedAssemblies 'System.Windows.Forms.dll', 'System.Drawing.dll' -ErrorAction Stop

  function Get-WindowInfo([IntPtr]$h) {
    if ($h -eq [IntPtr]::Zero) { return $null }
    $r = [PetRect]::new()
    if (-not [PetWin]::GetWindowRect($h, [ref]$r)) { return $null }
    $sb = [System.Text.StringBuilder]::new(512)
    [void][PetWin]::GetWindowText($h, $sb, 512)
    $procId = [uint32]0
    [void][PetWin]::GetWindowThreadProcessId($h, [ref]$procId)
    $procName = ''
    try {
      $p = Get-Process -Id $procId -ErrorAction Stop
      $procName = [string]$p.ProcessName
    } catch { }
    return @{
      hwnd  = [long]$h
      title = $sb.ToString()
      process = $procName
      x = $r.Left
      y = $r.Top
      w = ($r.Right - $r.Left)
      h = ($r.Bottom - $r.Top)
    }
  }

  $dpi = [PetWin]::EnterDpi()
  try {
    $fg = [PetWin]::GetForegroundWindow()

    if ($Mode -eq 'probe') {
      $info = Get-WindowInfo $fg
      if (-not $info) { Emit @{ ok = $false; reason = 'no-foreground-window' } }
      else { Emit @{ ok = $true; mode = 'probe'; window = $info; dpi = ($dpi -ne [IntPtr]::Zero) } }
      return
    }

    if ($ExpectHwnd -gt 0) {
      $h = [IntPtr]$ExpectHwnd
      if (-not [PetWin]::IsWindow($h)) {
        Emit @{ ok = $false; reason = 'window-gone' }
        return
      }
      if ($fg -ne $h) {
        Emit @{ ok = $false; reason = 'foreground-mismatch'; foreground = (Get-WindowInfo $fg) }
        return
      }
    } else {
      $h = $fg
    }

    $info = Get-WindowInfo $h
    if (-not $info) {
      Emit @{ ok = $false; reason = 'window-info-failed' }
      return
    }

    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $left = [Math]::Max($info.x, $vs.Left)
    $top = [Math]::Max($info.y, $vs.Top)
    $right = [Math]::Min(($info.x + $info.w), $vs.Right)
    $bottom = [Math]::Min(($info.y + $info.h), $vs.Bottom)
    $w = $right - $left
    $hh = $bottom - $top
    if ($w -lt $MinWidth -or $hh -lt $MinHeight) {
      Emit @{ ok = $false; reason = 'window-too-small'; w = $w; h = $hh }
      return
    }

    $full = [System.Drawing.Bitmap]::new($w, $hh)
    $g = [System.Drawing.Graphics]::FromImage($full)
    $g.CopyFromScreen($left, $top, 0, 0, [System.Drawing.Size]::new($w, $hh))
    $g.Dispose()

    $scale = [Math]::Min(1.0, ($MaxEdge / [Math]::Max($w, $hh)))
    $dw = [Math]::Max(1, [int]($w * $scale))
    $dh = [Math]::Max(1, [int]($hh * $scale))
    $bmp = [System.Drawing.Bitmap]::new($dw, $dh)
    $g2 = [System.Drawing.Graphics]::FromImage($bmp)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($full, 0, 0, $dw, $dh)
    $g2.Dispose()

    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
      Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    if (-not $codec) {
      Emit @{ ok = $false; reason = 'no-jpeg-encoder' }
      return
    }

    $bytes = $null
    $usedQuality = $Quality
    foreach ($q in @($Quality, 60, 48, 36, 28)) {
      $eps = [System.Drawing.Imaging.EncoderParameters]::new(1)
      $par = New-Object System.Drawing.Imaging.EncoderParameter -ArgumentList @([System.Drawing.Imaging.Encoder]::Quality, [long]$q)
      $eps.Param[0] = $par
      $ms = [System.IO.MemoryStream]::new()
      $bmp.Save($ms, $codec, $eps)
      $candidate = $ms.ToArray()
      $ms.Dispose()
      $eps.Dispose()
      $bytes = $candidate
      $usedQuality = $q
      if ($candidate.Length -le $MaxBytes) { break }
    }
    if ($bytes.Length -gt $MaxBytes) {
      Emit @{ ok = $false; reason = 'image-too-large'; bytes = $bytes.Length }
      return
    }

    $fpBmp = [System.Drawing.Bitmap]::new(24, 14)
    $g3 = [System.Drawing.Graphics]::FromImage($fpBmp)
    $g3.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g3.DrawImage($full, 0, 0, 24, 14)
    $g3.Dispose()
    $fpSb = [System.Text.StringBuilder]::new()
    $sum = 0
    for ($yy = 0; $yy -lt 14; $yy++) {
      for ($xx = 0; $xx -lt 24; $xx++) {
        $c = $fpBmp.GetPixel($xx, $yy)
        $lum = [int]((([int]$c.R * 299) + ([int]$c.G * 587) + ([int]$c.B * 114)) / 1000)
        $sum += $lum
        [void]$fpSb.Append($lum.ToString('X2'))
      }
    }
    $mean = $sum / 336.0

    Emit @{
      ok = $true
      mode = 'capture'
      hwnd = $info.hwnd
      title = $info.title
      process = $info.process
      w = $dw
      h = $dh
      bytes = $bytes.Length
      quality = $usedQuality
      mean = [Math]::Round($mean, 1)
      fp = $fpSb.ToString()
      mediaType = 'image/jpeg'
      jpeg = [Convert]::ToBase64String($bytes)
      dpi = ($dpi -ne [IntPtr]::Zero)
    }

    $fpBmp.Dispose()
    $bmp.Dispose()
    $full.Dispose()
  } finally {
    [PetWin]::LeaveDpi($dpi)
  }
} catch {
  Emit @{ ok = $false; reason = 'capture-exception'; detail = $_.Exception.Message }
  exit 1
}
