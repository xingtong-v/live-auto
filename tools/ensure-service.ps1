<#
  直播切片助手 · 服务守护（计划任务专用，**无窗口**）
  ─────────────────────────────────────────────────────────────
  为什么需要它：原来的计划任务每 10 分钟直接跑 launcher.ps1，
  而 launcher.ps1 是**给人双击的交互式启动器**：
    · 它会创建一个可见的控制台窗口 —— 每 10 分钟在屏幕上闪一次，
      用户看到的就是"切片助手在反复重启"（实测 2026-10-06 23:34:16 那次：
      窗口出现 2 秒后自己退出，服务进程 pid 全程没变）；
    · 它只用 HTTP 探活（3 秒超时）判断"服务在不在"。服务忙的时候探活失败，
      它会**再起第二个实例** → 端口被占（EADDRINUSE）→ 然后它的收尾动作
      会按命令行特征杀掉"项目目录下的 node.exe"，也就是**把健康的那个服务杀掉**；
    · 它启动服务后会**常驻前台持有**这个进程：关掉这个窗口＝服务停掉，
      下一个 10 分钟又起一个 —— 这才是真正意义上的"反复重启"。

  本脚本的规则（就三条）：
    1. 端口在监听 ⇒ 服务在跑 ⇒ **什么都不做**（哪怕探活超时，也不再起第二个）；
    2. 端口空闲 ⇒ 以**隐藏窗口、独立进程**启动服务，等它就绪，然后退出；
    3. **绝不杀任何进程**（全脚本没有 Stop-Process / taskkill）。
  只有真的启动了服务才写一行日志到 data\logs\watchdog.log ——
  平时 10 分钟一次静默通过，日志不会被"检查了一次"刷屏。

  用法（计划任务动作）：
    powershell.exe -NoProfile -NoLogo -NonInteractive -WindowStyle Hidden `
      -ExecutionPolicy Bypass -File "F:\deepseek\live_auto\tools\ensure-service.ps1"
#>
[CmdletBinding()]
param(
  [int]$Port = 3000,
  [int]$WaitSec = 180
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot          # tools\ 的上一级 = 项目根
$logDir = Join-Path $root 'data\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$wdLog = Join-Path $logDir 'watchdog.log'

function Write-WdLog([string]$m) {
  $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  ' + $m
  try { Add-Content -LiteralPath $wdLog -Value $line -Encoding UTF8 } catch { }
}

function Test-PortListening {
  # Get-NetTCPConnection 在极少数情况下会抛（权限/驱动抖动）—— 抛了就当作"没监听"，
  # 但那会让本脚本去启动服务，所以再兜一层：能连上 TCP 也算在监听。
  try {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    if ($c) { return $true }
  } catch { }
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    $okc = $iar.AsyncWaitHandle.WaitOne(800, $false)
    $client.Close()
    return $okc
  } catch { return $false }
}

function Test-HttpReady {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/bootstrap" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

$listening = Test-PortListening

# ---------------------------------------------------------------- ① 端口被占
if ($listening) {
  if (Test-HttpReady) {
    # 正常情况：静默退出（不写日志 —— 每 10 分钟一条会把 watchdog.log 刷成噪音）
    exit 0
  }
  # 端口在监听但探活失败：多半是服务正忙（事件循环被同步操作占住）。
  # **绝不再起第二个实例**：那只会 EADDRINUSE，而"清理"很可能把健康的那个杀掉。
  Write-WdLog "端口 $Port 在监听但 /api/bootstrap 探活失败 —— 判定为「服务在跑但繁忙」，不做任何动作（不重启）"
  exit 0
}

# ---------------------------------------------------------------- ② 端口空闲 ⇒ 启动
$nodeExe = $null
if ($env:LIVE_AUTO_NODE -and (Test-Path $env:LIVE_AUTO_NODE)) { $nodeExe = $env:LIVE_AUTO_NODE }
if (-not $nodeExe) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $nodeExe = $cmd.Source }
}
if (-not $nodeExe) {
  $cand = Join-Path $root 'node\node.exe'
  if (Test-Path $cand) { $nodeExe = $cand }
}
if (-not $nodeExe) {
  Write-WdLog "找不到 node.exe，无法启动服务（设置 LIVE_AUTO_NODE 或把 node 加进 PATH）"
  exit 1
}

$outLog = Join-Path $logDir 'service-console.log'
$errLog = Join-Path $logDir 'service-error.log'

Write-WdLog "服务不在运行（端口 $Port 空闲）—— 以隐藏窗口启动：$nodeExe src\cli.ts run --port $Port"
try {
  $proc = Start-Process -FilePath $nodeExe `
    -ArgumentList @('src\cli.ts', 'run', '--port', "$Port") `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -PassThru
} catch {
  Write-WdLog "启动失败：$($_.Exception.Message)"
  exit 1
}

$deadline = (Get-Date).AddSeconds($WaitSec)
while ((Get-Date) -lt $deadline) {
  if (Test-HttpReady) {
    Write-WdLog "服务已就绪：http://127.0.0.1:$Port（pid=$($proc.Id)）"
    exit 0
  }
  if ($proc.HasExited) {
    Write-WdLog "服务进程启动后立刻退出（exit=$($proc.ExitCode)）—— 见 $outLog / $errLog"
    exit 1
  }
  Start-Sleep -Seconds 2
}
Write-WdLog "等待 $WaitSec 秒仍未就绪（pid=$($proc.Id) 仍在运行）—— 见 $outLog / $errLog"
exit 1
