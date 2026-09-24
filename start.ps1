<#
.SYNOPSIS
  live_auto 启动脚本（PowerShell）。

.DESCRIPTION
  ⚠️ 本机 Node 可能不在 PATH —— 启动脚本必须显式指定 Node 路径。
  自动探测顺序：-Node 参数 > $env:LIVE_AUTO_NODE > 项目 node\node.exe
                > PATH 中的 node > WinGet 安装的 LTS。

.PARAMETER DryRun
  只到 clips.json + 摘要，不切片、不投稿，且默认不调用付费 AI。

.PARAMETER AllowPaid
  显式允许产生 ASR / LLM 费用（--dry-run 下也必须显式给出才允许付费）。

.PARAMETER NoUi
  不启动 Web UI，只跑常驻轮询（适合注册为服务）。

.PARAMETER Once
  跑一次「检查 + 补漏对账」后退出（适合计划任务）。

.PARAMETER Room
  覆盖目标直播间房间号。

.PARAMETER Port
  覆盖 Web UI 端口（默认 3000）。

.PARAMETER SelfCheck
  只跑启动自检后退出。

.PARAMETER Probe
  跑接口联调探测（只读接口，不产生费用）。

.EXAMPLE
  .\start.ps1
  .\start.ps1 -DryRun
  .\start.ps1 -Once -Room 12345678
  .\start.ps1 -NoUi -Port 3100
#>
[CmdletBinding()]
param(
  [string]$Node,
  [switch]$DryRun,
  [switch]$AllowPaid,
  [switch]$NoUi,
  [switch]$Once,
  [switch]$SelfCheck,
  [switch]$Probe,
  [string]$Room,
  [int]$Port,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ExtraArgs
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Write-Head($t) { Write-Host "`n$t" -ForegroundColor Cyan; Write-Host ('─' * [Math]::Max(20, [Math]::Min(70, $t.Length * 2 + 8))) -ForegroundColor DarkGray }
function Write-Ok($t) { Write-Host "✓ $t" -ForegroundColor Green }
function Write-Warn2($t) { Write-Host "⚠ $t" -ForegroundColor Yellow }
function Write-Err2($t) { Write-Host "✗ $t" -ForegroundColor Red }

# ---------------------------------------------------------------- 定位 Node
function Resolve-NodeExe {
  param([string]$Explicit)
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($Explicit) { $candidates.Add($Explicit) }
  if ($env:LIVE_AUTO_NODE) { $candidates.Add($env:LIVE_AUTO_NODE) }
  $candidates.Add((Join-Path $PSScriptRoot 'node\node.exe'))
  $candidates.Add((Join-Path (Split-Path $PSScriptRoot -Parent) 'node\node.exe'))
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $candidates.Add($cmd.Source) }
  Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Filter 'OpenJS.NodeJS.LTS_*' -Directory -ErrorAction SilentlyContinue |
    ForEach-Object {
      Get-ChildItem -Path $_.FullName -Filter 'node-*' -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { $candidates.Add((Join-Path $_.FullName 'node.exe')) }
    }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { return (Resolve-Path -LiteralPath $c).Path }
  }
  return $null
}

$nodeExe = Resolve-NodeExe -Explicit $Node
if (-not $nodeExe) {
  Write-Err2 '找不到 Node.js。'
  Write-Host @'
请任选一种方式解决：
  1. 用参数指定：   .\start.ps1 -Node "F:\deepseek\node\node.exe"
  2. 设置环境变量： $env:LIVE_AUTO_NODE = "F:\deepseek\node\node.exe"
  3. 把 node.exe 放到项目下的 node\ 子目录
  4. 把 Node 加入系统 PATH
'@
  exit 1
}

$nodeVer = (& $nodeExe -v).Trim()
$major = [int]($nodeVer.TrimStart('v').Split('.')[0])
Write-Host "Node: $nodeExe  ($nodeVer)"

if ($major -lt 24) {
  Write-Err2 "Node 版本过低：需要 v24 或更高（当前 $nodeVer）。"
  Write-Host '  本服务直接用 node 运行 .ts 文件，依赖 Node 24 的原生 TypeScript 类型擦除能力（无构建步骤）。'
  exit 1
}

# ---------------------------------------------------------------- 前置检查
if (-not (Test-Path 'config.json')) {
  Write-Warn2 '未找到 config.json，正在从 biliLive-tools 的配置生成本地配置…'
  & $nodeExe 'tools\init-config.mjs'
  if ($LASTEXITCODE -ne 0) {
    Write-Err2 '自动生成失败。请手动复制 config.example.json 为 config.json 并填写 PassKey。'
    exit 1
  }
}

if (-not (Test-Path 'node_modules')) {
  Write-Warn2 '未安装依赖，正在安装…'
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Write-Err2 '依赖安装失败。'; exit 1 }
}

# ---------------------------------------------------------------- 组装命令
if ($Probe) {
  Write-Head '接口联调探测（只读，不产生费用）'
  $probeArgs = @('src\probe.ts')
  if ($DryRun) { $probeArgs += '--dry-run' }
  if ($AllowPaid) { $probeArgs += '--allow-paid' }
  & $nodeExe @probeArgs
  exit $LASTEXITCODE
}

$cliArgs = @('src\cli.ts')
if ($SelfCheck) { $cliArgs += 'selfcheck' }
elseif ($Once) { $cliArgs += 'once' }
else { $cliArgs += 'run' }

if ($DryRun) { $cliArgs += '--dry-run' }
if ($AllowPaid) { $cliArgs += '--allow-paid' }
if ($NoUi) { $cliArgs += '--no-ui' }
if ($Room) { $cliArgs += @('--room', $Room) }
if ($Port) { $cliArgs += @('--port', "$Port") }
if ($ExtraArgs) { $cliArgs += $ExtraArgs }

Write-Head '直播切片助手 · live_auto'
Write-Host "启动时间 : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "工作目录 : $PSScriptRoot"
Write-Host "运行参数 : $($cliArgs -join ' ')"
if ($DryRun -and -not $AllowPaid) {
  Write-Ok 'dry-run 且未允许付费：不会调用付费 ASR / LLM（硬约束 #14）'
}
Write-Host ''

try {
  & $nodeExe @cliArgs
  $code = $LASTEXITCODE
} catch {
  Write-Err2 "启动失败：$($_.Exception.Message)"
  $code = 1
}

if ($code -ne 0) {
  Write-Head '服务异常退出，排查建议'
  $logs = Get-ChildItem -Path 'data\logs' -Filter '*.jsonl' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($logs) { Write-Host "最近日志：$($logs.FullName)" }
  Write-Host @"
排查命令：
  & '$nodeExe' src\cli.ts selfcheck     # 逐项自检
  & '$nodeExe' src\cli.ts health        # 健康快照
  & '$nodeExe' src\cli.ts inspect       # 最近的错误报告
"@
}
exit $code
