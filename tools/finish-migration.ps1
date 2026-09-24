# 等 biliLive-tools 的压制结束后，完成迁移的最后一步（删源 + 建联接 + 重启服务）。
#
# 背景：素材已 100% 同步到 D 盘（robocopy 复核"两边完全一致"），但删源时失败 ——
#   biliLive-tools 正在用 ffmpeg 压制 `哈喽-弹幕版-2deaf488-….mp4`，文件被占用。
#   强行结束 ffmpeg 会得到一个**半成品文件**（比杀掉它更糟），所以要等它自然结束。
#
# 本脚本做的事：
#   1. 轮询等待：那个文件不再被独占锁定，且没有 ffmpeg 在读写 Downloads\Bilibili 下的文件；
#   2. 等待期间如果源又有变化，会重新 robocopy 同步（保持目标最新）；
#   3. 稳定后再做最后一次 robocopy 复核，通过才删源；
#   4. 建目录联接 + 复核 + 通过原路径读写验证；
#   5. 重启切片助手服务。
#
# 用法：powershell -File tools\finish-migration.ps1
#       （默认最多等 40 分钟；加 -MaxWaitMin 60 可延长）

[CmdletBinding()]
param(
  [int]$MaxWaitMin = 40
)

$ErrorActionPreference = 'Continue'
$ROOT = 'D:\live_auto_media'
$PROJECT = 'F:\deepseek\live_auto'
$SRC = 'C:\Users\demo\Downloads\Bilibili'
$DST = Join-Path $ROOT 'Bilibili'
$DATA_SRC = 'F:\deepseek\live_auto\data'
$DATA_DST = Join-Path $ROOT 'data'

function Get-TreeStat {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{ Files = 0; Bytes = 0 } }
  $items = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue)
  $sum = ($items | Measure-Object -Property Length -Sum).Sum
  if ($null -eq $sum) { $sum = 0 }
  return [pscustomobject]@{ Files = $items.Count; Bytes = [long]$sum }
}
function Format-GB { param([long]$B) return ('{0:N2} GB' -f ($B / 1GB)) }

function Test-NotLocked {
  param([string]$File)
  try {
    $fs = [System.IO.File]::Open($File, 'Open', 'Read', 'None')
    $fs.Close()
    return $true
  } catch {
    return $false
  }
}

function Test-FfmpegBusy {
  # 只要有 ffmpeg 命令行里出现 Downloads\Bilibili，就认为它还在处理这些素材
  $procs = Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    if ($p.CommandLine -and $p.CommandLine -like '*Downloads\Bilibili*') { return $true }
  }
  return $false
}

function Sync-Tree {
  param([string]$From, [string]$To)
  & robocopy $From $To /MIR /COPY:DAT /DCOPY:DAT /R:2 /W:2 /NFL /NDL /NP /NJH /NJS | Out-Null
  $rc = $LASTEXITCODE
  if ($rc -ge 8) {
    Write-Host ("      ! robocopy 出错（退出码 {0}）" -f $rc)
    return $false
  }
  # 复核：/L 干跑，退出码 0 = 完全一致
  & robocopy $From $To /MIR /L /NJH /NP /R:0 /W:0 /NDL | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Make-Junction {
  param([string]$Link, [string]$Target)
  $existing = Get-Item -LiteralPath $Link -Force -ErrorAction SilentlyContinue
  if ($existing -and $existing.LinkType) {
    Write-Host ("  跳过：{0} 已是 {1}" -f $Link, $existing.LinkType)
    return $true
  }
  $out = & cmd.exe /c mklink /J $Link $Target 2>&1
  Write-Host ("  {0}" -f ($out -join ' '))
  $after = Get-Item -LiteralPath $Link -Force -ErrorAction SilentlyContinue
  return [bool]($after -and $after.LinkType)
}

Write-Host ('=' * 92)
Write-Host '完成迁移（等压制结束后删源 + 建联接）'
Write-Host ('=' * 92)

# ---------- 第 1 部分：biliLive-tools 录播目录 ----------
Write-Host ''
Write-Host '【1/2】biliLive-tools 录播素材'
$deadline = (Get-Date).AddMinutes($MaxWaitMin)
$waited = 0
$stable = $false
while ((Get-Date) -lt $deadline) {
  # 找出仍然被锁的文件
  $locked = @()
  Get-ChildItem -LiteralPath $SRC -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
    if (-not (Test-NotLocked -File $_.FullName)) { $locked += $_.Name }
  }
  $busy = Test-FfmpegBusy
  if ($locked.Count -eq 0 -and -not $busy) {
    # 再等 15 秒确认没有新的写入，然后复核
    Start-Sleep -Seconds 15
    $ok = Sync-Tree -From $SRC -To $DST
    if ($ok) {
      $a = Get-TreeStat -Path $SRC
      $b = Get-TreeStat -Path $DST
      if ($a.Files -eq $b.Files -and $a.Bytes -eq $b.Bytes) {
        $stable = $true
        Write-Host ("  OK 已稳定且完全一致（{0} 文件 / {1}）" -f $a.Files, (Format-GB $a.Bytes))
        break
      }
    }
    Write-Host '  · 源仍在变化，继续等…'
  } else {
    if ($waited % 60 -lt 15) {
      $msg = @()
      if ($locked.Count -gt 0) { $msg += ("{0} 个文件被占用" -f $locked.Count) }
      if ($busy) { $msg += 'ffmpeg 仍在处理' }
      Write-Host ("  · 等待压制结束（{0}）… 已等 {1} 分钟" -f ($msg -join '，'), [int]($waited / 60))
    }
  }
  Start-Sleep -Seconds 15
  $waited += 15
}

if (-not $stable) {
  Write-Host ''
  Write-Host ("  ! 等了 {0} 分钟仍未稳定 —— 没有删除任何东西，源数据完好。" -f $MaxWaitMin)
  Write-Host '    请等 biliLive-tools 的任务跑完后重跑本脚本。'
  exit 1
}

# 删源 + 建联接
Write-Host '  删除 C 盘原目录（目标已有完整副本）'
try {
  Remove-Item -LiteralPath $SRC -Recurse -Force -ErrorAction Stop
  Write-Host '      OK 已删除'
} catch {
  Write-Host ("      ! 删除失败：{0}" -f $_.Exception.Message)
  Write-Host '        目标副本完好。请关闭 biliLive-tools 后重跑本脚本。'
  exit 1
}
Write-Host ("  建立联接：{0} -> {1}" -f $SRC, $DST)
if (-not (Make-Junction -Link $SRC -Target $DST)) { Write-Host '      ! 联接建立失败'; exit 1 }
$probe = Join-Path $SRC ('.dsh-probe-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
try {
  Set-Content -LiteralPath $probe -Value 'ok' -Encoding ascii -ErrorAction Stop
  Remove-Item -LiteralPath $probe -Force -ErrorAction Stop
  Write-Host '      OK 通过原路径读写正常（联接生效）'
} catch {
  Write-Host ("      ! 原路径写入失败：{0}" -f $_.Exception.Message)
  exit 1
}

# ---------- 第 2 部分：切片助手 data ----------
Write-Host ''
Write-Host '【2/2】切片助手 data（切片/台账/缓存/回收站）'
$dataStable = $false
for ($i = 0; $i -lt 3 -and -not $dataStable; $i++) {
  $ok = Sync-Tree -From $DATA_SRC -To $DATA_DST
  $a = Get-TreeStat -Path $DATA_SRC
  $b = Get-TreeStat -Path $DATA_DST
  Write-Host ("  同步第 {0} 轮：源 {1} 文件 / {2}  <->  目标 {3} 文件 / {4}" -f ($i + 1), $a.Files, (Format-GB $a.Bytes), $b.Files, (Format-GB $b.Bytes))
  if ($ok -and $a.Files -eq $b.Files -and $a.Bytes -eq $b.Bytes) { $dataStable = $true; break }
  Start-Sleep -Seconds 5
}
if (-not $dataStable) {
  Write-Host '  ! data 目录无法稳定同步 —— 未删除源。请确认项目服务已停止后重跑。'
  exit 1
}
Write-Host '  OK 完全一致，删除 F 盘原目录'
try {
  Remove-Item -LiteralPath $DATA_SRC -Recurse -Force -ErrorAction Stop
  Write-Host '      OK 已删除'
} catch {
  Write-Host ("      ! 删除失败：{0}" -f $_.Exception.Message)
  exit 1
}
Write-Host ("  建立联接：{0} -> {1}" -f $DATA_SRC, $DATA_DST)
if (-not (Make-Junction -Link $DATA_SRC -Target $DATA_DST)) { Write-Host '      ! 联接建立失败'; exit 1 }
$probe2 = Join-Path $DATA_SRC ('.dsh-probe-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
try {
  Set-Content -LiteralPath $probe2 -Value 'ok' -Encoding ascii -ErrorAction Stop
  Remove-Item -LiteralPath $probe2 -Force -ErrorAction Stop
  Write-Host '      OK 通过原路径读写正常（联接生效）'
} catch {
  Write-Host ("      ! 原路径写入失败：{0}" -f $_.Exception.Message)
  exit 1
}

# ---------- 重启服务 ----------
Write-Host ''
Write-Host '重启切片助手服务…'
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { $nodeExe = 'node' }
Start-Process -FilePath $nodeExe -ArgumentList 'src\cli.ts', 'run' -WorkingDirectory $PROJECT -WindowStyle Hidden
$up = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 1500
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/health' -UseBasicParsing -TimeoutSec 4
    if ($r.StatusCode -eq 200) { $up = $true; break }
  } catch { }
}
Write-Host ('      ' + $(if ($up) { 'OK 服务已重启：http://127.0.0.1:3000' } else { '! 服务没起来 —— 请手动运行：node src\cli.ts run' }))

Write-Host ''
Write-Host ('=' * 92)
Write-Host '迁移完成'
Write-Host ('=' * 92)
foreach ($p in @(@{ L = $SRC; }, @{ L = $DATA_SRC })) {
  $i = Get-Item -LiteralPath $p.L -Force -ErrorAction SilentlyContinue
  if ($i) {
    Write-Host ("  {0}" -f $p.L)
    Write-Host ("      -> {0} {1}" -f $i.LinkType, ($i.Target -join ','))
  }
}
Write-Host ''
Write-Host ("  真实数据现在位于：{0}" -f $ROOT)
Write-Host '  两个软件不需要改任何配置 —— 原路径经联接照常指向 D 盘的数据。'
Write-Host ''
