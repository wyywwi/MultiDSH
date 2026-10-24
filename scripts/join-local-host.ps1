# 把本机 Windows 加入 MultiDSH 池：初始化 host 侧车 + 可选启动。
#
#   .\scripts\join-local-host.ps1 -PoolCode 7K3M9Q2X
#   .\scripts\join-local-host.ps1 -PoolCode 7K3M9Q2X -Run
#   .\scripts\join-local-host.ps1 -PoolCode 7K3M9Q2X -PublicUrl https://xxx.trycloudflare.com
#
# 详见 docs\LOCAL-HOST.md

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PoolCode,
  [string]$Directory = 'https://multidsh.example.com',
  [string]$Name = "$env:COMPUTERNAME-local",
  [string]$PublicUrl = '',
  [int]$AdminPort = 4080,
  [int]$DshPort = 3080,
  [string]$DshHome = "$env:USERPROFILE\.multidsh\dsh",
  [string]$Config = "$env:USERPROFILE\.multidsh\host.json",
  [switch]$Run
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$hostBin = Join-Path $root 'packages\host\bin.js'
$nodeCmd = Join-Path $root 'bin\node.cmd'

if (-not (Test-Path $hostBin)) { throw "找不到 host CLI：$hostBin" }
if (-not (Test-Path $nodeCmd)) {
  $nodeCmd = (Get-Command node -ErrorAction Stop).Source
}

if (-not $PublicUrl) {
  $PublicUrl = "http://127.0.0.1:$AdminPort"
  Write-Host "[join-local-host] 未指定 -PublicUrl，使用 $PublicUrl（只有本机/同机桌面端能打开）" -ForegroundColor Yellow
  Write-Host "[join-local-host] 其他设备访问请加 -PublicUrl http://<局域网IP>:$AdminPort 或隧道地址" -ForegroundColor Yellow
}

$code = ($PoolCode -replace '[^0-9A-Za-z]', '').ToUpperInvariant()
if ($code.Length -ne 8) { throw "池码应为 8 位（收到 '$PoolCode'）" }

Write-Host "[join-local-host] 初始化 host：$Name -> $Directory" -ForegroundColor Cyan
& $nodeCmd $hostBin init `
  --directory $Directory `
  --pool-code $code `
  --name $Name `
  --public-url $PublicUrl `
  --admin-port $AdminPort `
  --dsh-port $DshPort `
  --dsh-home $DshHome `
  --config $Config
if ($LASTEXITCODE -ne 0) { throw "host init 失败（exit $LASTEXITCODE）" }

Write-Host ''
Write-Host "[join-local-host] 下一步：在 MultiDSH 桌面端的「待审批」里点『批准』。" -ForegroundColor Green
Write-Host "[join-local-host] 然后运行（关掉窗口主机就下线）：" -ForegroundColor Green
Write-Host "  `"$nodeCmd`" `"$hostBin`" run --config `"$Config`""

if ($Run) {
  Write-Host ''
  Write-Host "[join-local-host] 启动 sidecar（等审批通过后自动上线）…" -ForegroundColor Cyan
  & $nodeCmd $hostBin run --config $Config
  exit $LASTEXITCODE
}
