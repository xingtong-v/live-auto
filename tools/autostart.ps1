<#
.SYNOPSIS
  把「直播切片助手」注册成**开机自启**（登录时启动，无窗口、不开浏览器）。

.DESCRIPTION
  为什么用计划任务而不是注册表 Run / 启动文件夹：
    · 能设「延迟 30 秒」—— 让 biliLive-tools（它自己已经在 HKCU Run 里）和网络先起来；
    · 能设「只允许一个实例」—— 避免重复启动导致的端口占用（EADDRINUSE 时旧服务会静默失去 UI 端口）；
    · 能设「失败自动重试」—— 服务崩了 1 分钟后自动拉起来；
    · 能设「不因电池/超时而停」。
  而 `launcher.ps1` 本身已经有「已在运行就不重复启动」的第 0 步检查，两者叠加是双保险。

  全程**不需要管理员权限**：任务以当前用户身份、受限级别（Limited）运行。

.PARAMETER Install
  安装/更新自启任务（默认动作）。

.PARAMETER Remove
  移除自启任务（不影响正在运行的服务）。

.PARAMETER Status
  查看当前自启状态与服务是否在跑。

.PARAMETER TaskName
  任务名，默认「直播切片助手（live_auto）」。

.PARAMETER DelaySec
  登录后延迟多少秒启动，默认 30。

.PARAMETER WatchdogMinutes
  **看门狗**：每 N 分钟自动检查一次服务在不在，不在就拉起来（默认 10；0 = 关闭）。
  为什么要它：自启只在登录时跑一次，服务中途被别的东西杀掉（实测 2026-09-24 12:07 被
  以 Ctrl+C 方式终止，任务计划程序的"失败重试"对"被外部终止"不生效）就再也不会自己回来。
  每个 tick 只是 launcher.ps1 的第 0 步检查（3 秒 HTTP 探测），服务健在时立刻退出，几乎零开销。
  ⚠️ 反过来说：**想彻底停掉服务，不能只是杀掉进程** —— 要么 `-Remove` 移除任务，
  要么 `Stop-ScheduledTask` 停任务，否则最多 N 分钟后会被重新拉起。

.PARAMETER Hidden
  **隐藏窗口**启动（默认是**有窗口**的，和双击桌面快捷方式一样能看见启动日志与报错）。
  加这个开关就回到"后台静默"模式。

.PARAMETER Browser
  启动时**顺便打开界面**（默认不打开；窗口里会打印地址，自己点开即可）。
  注意：看门狗每次拉起服务时也会跟着打开浏览器 —— 不想每次弹浏览器就别加。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\autostart.ps1 -Install
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\autostart.ps1 -Install -Hidden
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\autostart.ps1 -Install -Browser
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\autostart.ps1 -Status
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\autostart.ps1 -Remove
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Remove,
  [switch]$Status,
  [string]$TaskName = '直播切片助手（live_auto）',
  [int]$DelaySec = 30,
  [int]$WatchdogMinutes = 10,
  [switch]$Hidden,
  [switch]$Browser
)

$ErrorActionPreference = 'Stop'
$ROOT = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $ROOT 'launcher.ps1'
$port = 3000
try {
  $cfg = Get-Content -LiteralPath (Join-Path $ROOT 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($cfg.ui.port) { $port = [int]$cfg.ui.port }
} catch {
  # 读不到就用默认端口，不影响安装
}
$URL = "http://127.0.0.1:$port"

function Ok($t) { Write-Host "  [OK] $t" -ForegroundColor Green }
function Warn2($t) { Write-Host "  [!!] $t" -ForegroundColor Yellow }
function Err2($t) { Write-Host "  [XX] $t" -ForegroundColor Red }
function Head($t) { Write-Host ''; Write-Host $t -ForegroundColor Cyan }

function Test-Service {
  try {
    $r = Invoke-WebRequest -Uri "$URL/api/bootstrap" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    return $r.StatusCode -eq 200
  } catch { return $false }
}

if (-not (Test-Path -LiteralPath $launcher)) {
  Err2 "找不到启动器：$launcher"
  exit 1
}

# ---------------------------------------------------------------- 移除
if ($Remove) {
  Head '移除自启任务'
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $existing) {
    Warn2 '没有找到该任务（可能本来就没装）'
    exit 0
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Ok "已移除：$TaskName"
  Write-Host '  （正在运行的服务不受影响；桌面快捷方式照旧可用）' -ForegroundColor DarkGray
  exit 0
}

# ---------------------------------------------------------------- 状态
if ($Status) {
  Head '自启状态'
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($t) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Ok "已注册：$TaskName"
    Write-Host "       状态        $($t.State)"
    Write-Host "       触发器      $((($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ', '))"
    Write-Host "       上次运行    $($info.LastRunTime)（结果码 $($info.LastTaskResult)）"
    Write-Host "       下次运行    $($info.NextRunTime)"
    if ($info.LastTaskResult -eq 267009) { Write-Host '       （267009 = 正在运行，正常）' -ForegroundColor DarkGray }
    # 看门狗间隔从 XML 里读（Repetition 没有稳定的 CIM 读取路径）
    $x = Export-ScheduledTask -TaskName $TaskName
    if ($x -match '<Repetition>\s*<Interval>PT(\d+)M</Interval>') {
      Write-Host "       看门狗      每 $($matches[1]) 分钟检查一次（服务不在就拉起）"
    } else {
      Write-Host '       看门狗      未开启（服务被杀掉后不会自动回来）' -ForegroundColor DarkGray
    }
  } else {
    Warn2 "未注册自启任务：$TaskName"
  }
  if (Test-Service) { Ok "服务正在运行：$URL" } else { Warn2 "服务未响应：$URL" }
  # biliLive-tools 是上游依赖，它自己也应该自启 —— 顺手检查一下，省得"服务起来了但上游不在"
  $llt = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).'com.electron.biliLiveTools'
  if ($llt) { Ok 'biliLive-tools 也已设置开机自启（HKCU Run）' } else { Warn2 'biliLive-tools 未设置开机自启 —— 本服务会在上游就绪后自动接上' }
  exit 0
}

# ---------------------------------------------------------------- 安装（默认）
Head '安装自启任务'
Write-Host "  项目目录    $ROOT"
Write-Host "  启动方式    launcher.ps1$(if ($Hidden) { ' -NoBrowser（后台静默，无窗口）' } else { '（**有窗口**，看得见启动日志与报错）' })"
if ($Browser) { Write-Host '  界面       启动后自动打开浏览器' }
Write-Host "  触发时机    登录后 $DelaySec 秒"
if ($WatchdogMinutes -gt 0) { Write-Host "  看门狗      每 $WatchdogMinutes 分钟检查一次（服务不在就拉起）" }
Write-Host "  界面地址    $URL"
Write-Host ''

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $ps)) { $ps = 'powershell.exe' }

# 窗口可见性：默认**有窗口**（用户明确要的）——去掉 -WindowStyle Hidden 即可。
# 仍然保留 -NoPause：报错时窗口会随手关掉，但错误全在 data\logs\launcher-console.log 里，
# 而且任务会正常结束 → 看门狗下一跳还能把它重新拉起来。
# （若不传 -NoPause，出错时窗口会停在"按任意键"，任务一直处于 Running，看门狗反而不重试。）
$argLine = '-NoProfile -NoLogo{0} -ExecutionPolicy Bypass -File "{1}"{2} -NoPause' -f `
  $(if ($Hidden) { ' -WindowStyle Hidden' } else { '' }), `
  $launcher, `
  $(if ($Browser) { '' } else { ' -NoBrowser' })

try {
  $action = New-ScheduledTaskAction -Execute $ps -Argument $argLine -WorkingDirectory $ROOT
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  # Delay 在 PS 5.1 里只能改 CIM 对象的属性
  $trigger.Delay = 'PT{0}S' -f [Math]::Max(0, $DelaySec)
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

  # 看门狗要**独立的时间触发器**，不能只挂在登录触发器上：
  # 实测踩过 —— 登录触发器上的 <Repetition> 要等"该触发器触发过"之后才开始计时，
  # 而任务刚注册/刚改过时它还没触发过，于是重复根本不发生（服务被杀掉后一直不回来）。
  # 「从现在起每 N 分钟」的 TimeTrigger 才是"立刻生效、长期有效"的写法。
  $triggers = @($trigger)
  if ($WatchdogMinutes -gt 0) {
    $triggers += New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
      -RepetitionInterval (New-TimeSpan -Minutes $WatchdogMinutes) `
      -RepetitionDuration ([TimeSpan]::FromDays(3650))
  }

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal `
    -Description '开机（登录）后自动启动 B站直播切片助手；无窗口、不开浏览器。带看门狗：每 N 分钟检查一次，服务不在就拉起。移除：tools\autostart.ps1 -Remove' -Force | Out-Null

  # ⚠️ PS 5.1 的 `New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew` 的**读取**有坑：
  #    `(Get-ScheduledTask).Settings.MultipleInstancesPolicy` 读回来是空值，所以判断必须看**导出的 XML**。
  #    "只允许一个实例"确实要：重复启动会撞端口，旧实例会静默失去 UI 端口（EADDRINUSE 后继续轮询）。
  try {
    $xml = Export-ScheduledTask -TaskName $TaskName
    $patched = [regex]::Replace($xml, '<MultipleInstancesPolicy>.*?</MultipleInstancesPolicy>', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
    if ($patched -notmatch 'MultipleInstancesPolicy>IgnoreNew<') {
      # 插入位置要在 DisallowStartIfOnBatteries 之前（task schema 对子元素顺序敏感，放错会被丢弃）
      $patched = $patched -replace '<DisallowStartIfOnBatteries>', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>'
    }
    if ($patched -ne $xml) { Register-ScheduledTask -TaskName $TaskName -Xml $patched -Force | Out-Null }
    $verify = Export-ScheduledTask -TaskName $TaskName
    if ($verify -match 'MultipleInstancesPolicy>IgnoreNew<') { Ok '已设「只允许一个实例」：IgnoreNew（不会重复启动撞端口）' }
    else { Warn2 '「只允许一个实例」没能写进任务 XML —— launcher.ps1 的第 0 步检查仍可兜底' }

    # 看门狗：确认时间触发器里的重复间隔真的写进去了（读 XML，不信 CIM 属性）
    if ($WatchdogMinutes -gt 0) {
      if ($verify -match '<Repetition>\s*<Interval>PT(\d+)M</Interval>') {
        Ok "看门狗已开启：每 $($matches[1]) 分钟检查一次（服务被杀掉后最多 $($matches[1]) 分钟自动回来）"
      } else {
        Warn2 '看门狗没能写进任务 XML —— 服务被杀掉后需要手动重启（或下次登录）'
      }
    } else {
      Ok '看门狗未开启（-WatchdogMinutes 0）：服务被杀掉后不会自动回来'
    }
  } catch {
    Warn2 "设置 MultipleInstancesPolicy 失败：$($_.Exception.Message)（launcher.ps1 的第 0 步检查仍可兜底）"
  }

  Ok "已注册计划任务：$TaskName"

  if (Test-Service) {
    Ok "服务当前已在运行：$URL（自启只会在下次登录时接上）"
  } else {
    Warn2 '服务当前未运行 —— 可以现在手动跑一次任务验证：Start-ScheduledTask -TaskName 上面的任务名'
  }
} catch {
  Err2 "注册计划任务失败：$($_.Exception.Message)"
  Write-Host ''
  Write-Host '  退路：改用「启动文件夹」（不需要管理员权限，但没有延迟/重试能力）' -ForegroundColor Yellow
  $startup = [Environment]::GetFolderPath('Startup')
  $cmdPath = Join-Path $startup 'live_auto.cmd'
  $content = "@echo off`r`n`"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`" -NoBrowser -NoPause`r`n"
  [System.IO.File]::WriteAllText($cmdPath, $content, (New-Object System.Text.ASCIIEncoding))
  Ok "已改为写入启动文件夹：$cmdPath"
  Write-Host '  （删除该文件即可取消自启）' -ForegroundColor DarkGray
}
exit 0
