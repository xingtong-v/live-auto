<#
  直播切片助手 · 开机后打开界面（计划任务用，**自己不开控制台窗口**）
  ─────────────────────────────────────────────────────────────
  用户的期望（2026-10-07 实测提问）：「开机时打开的是不是这个界面？如果不是，修复他」。
  在此之前，"自动"这一路被我改成了**完全无窗口**（只起后端、不开界面）——
  因为老实现每 10 分钟闪一个 Windows Terminal 窗口。现在把两件事拆开：

    · 后端：`tools\ensure-service.ps1`（登录后 30 秒 + 每 10 分钟一跳，静默、不杀进程、无窗口）；
    · 界面：**本脚本**，只在**登录时**跑一次 —— 等后端就绪，然后用 Edge 应用模式打开界面
      （没有地址栏，跟桌面快捷方式打开的完全是同一个窗口）。

  ★ 职责边界（2026-10-07 实测教训）：本脚本**不负责拉起后端**，只负责"等 + 开"。
    第一版顺手 `& powershell -File ensure-service.ps1`（同步等待），在 conhost --headless 下
    那一句**不返回**：任务卡在 Running、界面永远打不开（服务 6 秒就起来了，脚本却还停在那儿）。
    后端有两条独立保障（登录任务 + 10 分钟看门狗），不需要它操心；
    等不到就**照样开界面**（开机时后端可能只是慢，浏览器里刷新一下即可），
    比"什么都不出现"强得多 —— 用户要的是"开机就能看到这个界面"。

  调用方必须用 `conhost.exe --headless` 包一层：默认终端是 Windows Terminal 时
  `-WindowStyle Hidden` 拦不住控制台窗口（前一轮踩过）。
#>
[CmdletBinding()]
param(
  [int]$Port = 3000,
  [int]$WaitSec = 90,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot          # tools\ 的上一级 = 项目根
$logDir = Join-Path $root 'data\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$stamp = Join-Path $logDir 'ui-opened.stamp'
$logFile = Join-Path $logDir 'open-ui.log'
$url = "http://127.0.0.1:$Port"

function Write-UiLog([string]$m) {
  try { Add-Content -LiteralPath $logFile -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  ' + $m) -Encoding UTF8 } catch { }
}

function Test-HttpReady {
  <# 硬超时探活：`Invoke-WebRequest -TimeoutSec N` 在服务忙时**不生效**（实测挂过 2 分钟），
     所以统一用 HttpClient + CancellationTokenSource。 #>
  $client = $null; $cts = $null
  try {
    Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue | Out-Null
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds(6)
    $cts = New-Object System.Threading.CancellationTokenSource
    [void]$cts.CancelAfter(4000)
    $resp = $client.GetAsync("$url/api/bootstrap", $cts.Token).GetAwaiter().GetResult()
    $okc = ([int]$resp.StatusCode -eq 200)
    $resp.Dispose()
    return $okc
  } catch {
    return $false
  } finally {
    if ($cts) { $cts.Dispose() }
    if ($client) { $client.Dispose() }
  }
}

# ---------------------------------------------------------------- ① 去重：一分钟内不重复开
if (-not $Force -and (Test-Path $stamp)) {
  $age = (Get-Date) - (Get-Item $stamp).LastWriteTime
  if ($age.TotalSeconds -lt 60) {
    Write-UiLog "刚刚（$([math]::Round($age.TotalSeconds)) 秒前）已经开过界面，跳过"
    exit 0
  }
}

# ---------------------------------------------------------------- ② 等后端就绪（后端由别的任务负责拉起）
Write-UiLog "阶段②：等 $url 就绪（上限 $WaitSec 秒）"
$deadline = (Get-Date).AddSeconds($WaitSec)
$ready = Test-HttpReady
while (-not $ready -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $ready = Test-HttpReady
}
if ($ready) {
  Write-UiLog '后端已就绪'
} else {
  Write-UiLog "等了 $WaitSec 秒后端仍未就绪，仍按用户要求打开界面（浏览器里刷新即可；后端排查见 watchdog.log）"
}

# ---------------------------------------------------------------- ③ 用 Edge 应用模式打开界面
$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

try {
  if ($edge) {
    Start-Process -FilePath $edge -ArgumentList @("--app=$url", '--window-size=1440,960') | Out-Null
    Write-UiLog "已用 Edge 应用窗口打开 $url"
  } else {
    Start-Process $url | Out-Null      # 回退：系统默认浏览器
    Write-UiLog "没有 Edge，已用默认浏览器打开 $url"
  }
  Set-Content -LiteralPath $stamp -Value (Get-Date).ToString('o') -Encoding UTF8
} catch {
  Write-UiLog "打开界面失败：$($_.Exception.Message)"
  exit 1
}
Write-UiLog '阶段③结束：完成'
exit 0
