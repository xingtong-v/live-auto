<#
.SYNOPSIS
  一条命令验证「开机自启」到底有没有生效（重启后跑这个就行）。

.DESCRIPTION
  判据不是"任务存在"，而是**服务进程的启动时刻**：
    · 从系统的 LastBootUpTime 与服务的 uptime 反推出服务启动时刻；
    · 如果它落在开机后 10 分钟以内 → 说明确实是开机/登录时被拉起来的（✅）；
    · 如果服务在跑但启动时刻远在开机之后 → 说明是被手动/看门狗拉起来的（⚠️，不算开机自启生效）；
    · 服务没在跑 → ❌，并打印排查入口。

  同时打印：任务状态、上次运行时刻与结果码、看门狗间隔、启动器日志尾部、
  以及"有没有卡在运行态的任务"（自启生效时顺手看一眼，免得以为它在干活其实卡住了）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\autostart-verify.ps1
#>
[CmdletBinding()]
param(
  [string]$TaskName = '直播切片助手（live_auto）'
)

$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot
$port = 3000
try {
  $cfg = Get-Content -LiteralPath (Join-Path $ROOT 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($cfg.ui.port) { $port = [int]$cfg.ui.port }
} catch { }
$URL = "http://127.0.0.1:$port"

function Line($t) { Write-Host $t }
function Ok($t) { Write-Host "  [OK] $t" -ForegroundColor Green }
function Warn2($t) { Write-Host "  [!!] $t" -ForegroundColor Yellow }
function Bad($t) { Write-Host "  [XX] $t" -ForegroundColor Red }

Line ''
Line '  开机自启验证' -ForegroundColor White -BackgroundColor DarkMagenta
Line ('  ' + ('─' * 62)) -ForegroundColor DarkGray

$os = Get-CimInstance Win32_OperatingSystem
$boot = $os.LastBootUpTime
$now = Get-Date
Line "  现在          $($now.ToString('yyyy-MM-dd HH:mm:ss'))"
Line "  本次开机      $($boot.ToString('yyyy-MM-dd HH:mm:ss'))（已 $([math]::Round(($now - $boot).TotalMinutes,1)) 分钟）"

# ---- 服务 ----
$health = $null
try { $health = Invoke-RestMethod -Uri "$URL/api/health" -TimeoutSec 6 } catch { }
$serviceOk = $health -ne $null
$startedAt = $null
if ($serviceOk) {
  $startedAt = $now.AddSeconds(-1 * [int]$health.health.uptimeSec)
  Line "  服务启动于    $($startedAt.ToString('yyyy-MM-dd HH:mm:ss'))（uptime $([math]::Round($health.health.uptimeSec/60,1)) 分钟）"
  $afterBootSec = ($startedAt - $boot).TotalSeconds
  Line "  开机后多久启动 $([math]::Round($afterBootSec,0)) 秒"
}

# ---- 任务 ----
Line ''
$t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($t) {
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  $x = Export-ScheduledTask -TaskName $TaskName
  $wd = if ($x -match '<Repetition>\s*<Interval>PT(\d+)M</Interval>') { "每 $($matches[1]) 分钟" } else { '未开启' }
  $mi = if ($x -match '<MultipleInstancesPolicy>(\w+)<') { $matches[1] } else { '?' }
  Ok "自启任务已注册：$TaskName"
  Line "       状态        $($t.State)"
  Line "       上次运行    $($info.LastRunTime)（结果码 $($info.LastTaskResult)）"
  Line "       下次运行    $($info.NextRunTime)"
  Line "       看门狗      $wd（服务不在就拉起）"
  Line "       单实例      $mi"
} else {
  Bad "自启任务不存在：$TaskName —— 用 tools\autostart.ps1 -Install 安装"
}

# ---- 启动器日志 ----
Line ''
$log = Join-Path $ROOT 'data\logs\launcher-console.log'
if (Test-Path -LiteralPath $log) {
  $f = Get-Item -LiteralPath $log
  Line "  启动器日志    $log"
  Line "       最后写入    $($f.LastWriteTime)"
  $tail = Get-Content -LiteralPath $log -Tail 3 -Encoding UTF8 -ErrorAction SilentlyContinue
  foreach ($l in $tail) { if ($l.Trim()) { Line ('       ' + $l.Substring(0, [Math]::Min(110, $l.Length))) } }
} else {
  Warn2 '还没有启动器日志（说明这条路还没跑过）'
}

# ---- 结论 ----
Line ''
Line ('  ' + ('─' * 62)) -ForegroundColor DarkGray
$verdict = 1
if (-not $serviceOk) {
  Bad "服务没在运行：$URL"
  Line '       排查：  .\start.ps1            （手动起一次看报错）'
  Line '               tools\autostart.ps1 -Status'
  Line '               data\logs\launcher-console.log'
} elseif ($afterBootSec -lt 600) {
  Ok "开机自启生效：本次开机后 $([math]::Round($afterBootSec,0)) 秒服务自动上线"
  $verdict = 0
} else {
  Warn2 "服务在跑，但不是本次开机拉起来的（开机已 $([math]::Round(($now - $boot).TotalMinutes,0)) 分钟，服务才启动 $([math]::Round(($now - $startedAt).TotalMinutes,1)) 分钟）"
  Line '       可能是：本次登录时任务没触发（看"上次运行"时刻）、或之前是被手动/看门狗拉起来的'
}

# ---- 顺带：卡在运行态的任务（别把"卡住"当成"在干活"）----
if ($serviceOk) {
  $running = @()
  try {
    $tasks = Invoke-RestMethod -Uri "$URL/api/tasks?limit=50" -TimeoutSec 10
    $running = @($tasks.tasks | Where-Object { $_.status -in @('TRANSCRIBING','ANALYZING','CLIPPING','PUBLISHING') })
  } catch { }
  if ($running.Count -gt 0) {
    Line ''
    Warn2 "$($running.Count) 个任务停在运行态（重启会打断正在跑的阶段，需要修复才能继续）"
    foreach ($r in $running) { Line "       $($r.id)  $($r.status)  $($r.title)" }
    Line "       修复：界面上点「修复卡住」，或 POST $URL/api/tasks/repair-stuck"
  }
}

Line ''
exit $verdict
