# 安装 cortico-world-wechat：复制 → 登记依赖 → 建 junction → 提示重启
# 用法：.\install.ps1 [-Restart]
param(
    [switch]$Restart
)

$ErrorActionPreference = "Stop"
$src  = $PSScriptRoot
$dest = "D:\coopanion\data\extensions\local\cortico-world-wechat"
$extRoot = "D:\coopanion\data\extensions"
$pkg = Join-Path $extRoot "package.json"
$nm = Join-Path $extRoot "node_modules\cortico-world-wechat"

if (-not (Test-Path $pkg)) { throw "找不到 $pkg，确认 Coopanion 安装路径" }

Write-Host "1/3 复制到 $dest"
robocopy $src $dest /MIR /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败：$LASTEXITCODE" }

Write-Host "2/3 登记依赖"
Copy-Item $pkg "$pkg.bak-wechat" -Force
$json = Get-Content $pkg -Raw | ConvertFrom-Json
if (-not $json.PSObject.Properties["dependencies"]) {
    $json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
$cur = $json.dependencies.PSObject.Properties["cortico-world-wechat"]
if ($cur) {
    $cur.Value = "link:$dest"
} else {
    $json.dependencies | Add-Member -NotePropertyName "cortico-world-wechat" -NotePropertyValue "link:$dest"
}
$out = $json | ConvertTo-Json -Depth 30
[System.IO.File]::WriteAllText($pkg, $out, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "3/3 建 junction"
if (Test-Path $nm) {
    Write-Host "  已存在：$nm"
} else {
    cmd /c mklink /J "$nm" "$dest" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "mklink 失败：$LASTEXITCODE" }
}

Write-Host ""
Write-Host "完成。还需要："
Write-Host "  1) 在 companion\config.json 里加 worlds.wechat（见 README）"
Write-Host "  2) 完全退出 Coopanion 再打开（新装扩展必须重启进程）"
if ($Restart) {
    Write-Host "  正在调用 /api/run/restart ..."
    Invoke-WebRequest -Uri "http://127.0.0.1:17788/api/run/restart" -Method Post `
        -ContentType "application/json" -Body "{}" | Out-Null
}
