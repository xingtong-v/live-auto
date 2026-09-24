# 把直播录播素材与切片素材从 C 盘迁移到 D 盘，并在原位置留下目录联接（junction）。
#
# 为什么用 junction 而不是"改配置路径"：
#   两个软件（biliLive-tools、切片助手）里有大量写死的路径假设 ——
#   项目的 LOGS_DIR / ERROR_REPORT_DIR 是模块级常量，servePreview 的白名单基于
#   ledger.taskDir()，biliLive-tools 界面上显示保存目录、历史台账里记着历史文件绝对路径……
#   改配置只能覆盖一部分，剩下的会在迁移后指向不存在的位置。
#   junction 让"原路径照常可用"，两个软件一行配置都不用改，也不需要管理员权限。
#
# 迁移对象：
#   C:\Users\demo\Downloads\Bilibili   ->  D:\live_auto_media\Bilibili   （biliLive-tools 录播）
#   F:\deepseek\live_auto\data           ->  D:\live_auto_media\data       （切片/台账/缓存/回收站）
#
# 安全性：
#   1. 默认 -DryRun，只报告规模与目标，不动任何文件；
#   2. robocopy /MIR 复制后用**文件数 + 总字节数**双向核对；
#   3. 核对通过才删源目录；
#   4. mklink /J 建立联接并复核；最后通过原路径做一次真实读写验证；
#   5. 幂等：已经是联接就跳过。
#
# 用法：
#   .\tools\migrate-media-to-d.ps1 -DryRun
#   .\tools\migrate-media-to-d.ps1 -Apply

[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ROOT = 'D:\live_auto_media'
$PROJECT = 'F:\deepseek\live_auto'

$Jobs = @(
  [pscustomobject]@{
    Label = 'biliLive-tools 录播素材'
    Src   = 'C:\Users\demo\Downloads\Bilibili'
    Dst   = Join-Path $ROOT 'Bilibili'
  },
  [pscustomobject]@{
    Label = '切片助手 data（切片/台账/缓存/回收站）'
    Src   = 'F:\deepseek\live_auto\data'
    Dst   = Join-Path $ROOT 'data'
  }
)

function Get-TreeStat {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{ Files = 0; Bytes = 0 } }
  $items = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue)
  $sum = ($items | Measure-Object -Property Length -Sum).Sum
  if ($null -eq $sum) { $sum = 0 }
  return [pscustomobject]@{ Files = $items.Count; Bytes = [long]$sum }
}

function Format-GB {
  param([long]$Bytes)
  return ('{0:N2} GB' -f ($Bytes / 1GB))
}

function Get-LinkInfo {
  param([string]$Path)
  $i = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $i) { return [pscustomobject]@{ IsLink = $false; Type = ''; Target = '' } }
  $t = ''
  if ($i.PSObject.Properties['LinkType'] -and $i.LinkType) { $t = [string]$i.LinkType }
  $tg = ''
  if ($i.PSObject.Properties['Target'] -and $i.Target) { $tg = ($i.Target -join ',') }
  return [pscustomobject]@{ IsLink = [bool]($t -ne ''); Type = $t; Target = $tg }
}

Write-Host ('=' * 92)
if ($Apply -and -not $DryRun) {
  Write-Host '素材迁移到 D 盘（正式执行）'
} else {
  Write-Host '素材迁移到 D 盘（干跑，不改任何东西）'
  $Apply = $false
}
Write-Host ('=' * 92)
Write-Host ("  目标根目录：{0}" -f $ROOT)
Write-Host ''

# ---- 前置检查 ----
Write-Host '前置检查'
$listening = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
$serviceWasRunning = $false
$servicePid = 0
if ($listening.Count -gt 0) {
  $servicePid = $listening[0].OwningProcess
  if (-not $Apply) {
    Write-Host ("  ! 项目服务正在运行（pid={0}）—— 正式执行时会自动停掉，迁移完成后自动重启" -f $servicePid)
  } else {
    Write-Host ("  > 停止项目服务（pid={0}），否则台账正在写、文件被占用" -f $servicePid)
    try {
      Stop-Process -Id $servicePid -Force -ErrorAction Stop
      $serviceWasRunning = $true
      for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Milliseconds 400
        $still = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).Count
        if ($still -eq 0) { break }
      }
      Write-Host '      OK 已停止'
    } catch {
      Write-Host ("      ! 停止失败：{0} —— 已中止（台账在写时迁移不安全）" -f $_.Exception.Message)
      exit 1
    }
  }
} else {
  Write-Host '  OK 项目服务未在运行'
}
$blt = Get-Process -Name 'biliLive-tools' -ErrorAction SilentlyContinue
if ($blt) {
  Write-Host '  ! biliLive-tools 正在运行'
  # 关键：**必须先确认没有正在进行的录制**。实测踩过：迁移时它正在录 丙主播，
  # 源文件实时增长，robocopy 拷完后源又变新（robocopy 标 Newer），核对永远不一致。
  $recState = & node --experimental-strip-types -e "import{loadConfig}from'./src/config.ts';import{BiliLiveClient}from'./src/api.ts';const c=new BiliLiveClient({baseUrl:loadConfig('config.json').config.bililive.baseUrl,passKey:loadConfig('config.json').config.bililive.passKey});const r=await c.request('/recorder/list',{purpose:'检查录制',tag:'rec'});console.log((r?.payload?.data??[]).filter(x=>x.state==='recording').map(x=>x.channelId).join(','))" 2>$null
  $recording = @($recState -split ',' | Where-Object { $_ -and $_.Trim() -ne '' })
  if ($recording.Count -gt 0) {
    if (-not $Apply) {
      Write-Host ("      ! 正在录制：{0} —— 正式执行时会先停止录制再迁移" -f ($recording -join ','))
    } else {
      Write-Host ("      > 停止正在进行的录制：{0}" -f ($recording -join ','))
      & node --experimental-strip-types -e "import{loadConfig}from'./src/config.ts';import{BiliLiveClient}from'./src/api.ts';const cfg=loadConfig('config.json').config;const c=new BiliLiveClient({baseUrl:cfg.bililive.baseUrl,passKey:cfg.bililive.passKey});const raw=await c.request('/recorder/list',{purpose:'停止录制',tag:'rec'});const ids=(raw?.payload?.data??[]).filter(x=>x.state==='recording').map(x=>x.id);if(ids.length){await c.request('/recorder/manager/batch_stop_record',{method:'POST',body:{ids},purpose:'停止录制',tag:'rec'});console.log('stopped '+ids.length)}" 2>$null | Out-Null
      Write-Host '      OK 已停止录制；等待文件落定…'
      # 等最后写入的文件大小不再变化（最多 60 秒）
      $prev = -1
      for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        $cur = (Get-ChildItem 'C:\Users\demo\Downloads\Bilibili' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
        if ($cur -eq $prev) { break }
        $prev = $cur
      }
      Write-Host '      OK 文件已落定'
    }
  } else {
    Write-Host '      OK 当前没有正在进行的录制'
  }
} else {
  Write-Host '  OK biliLive-tools 未在运行'
}
Write-Host ''

# ---- 规模与目标 ----
Write-Host '迁移清单'
$plans = @()
$totalBytes = [long]0
foreach ($j in $Jobs) {
  $link = Get-LinkInfo -Path $j.Src
  $exists = Test-Path -LiteralPath $j.Src
  if ($exists -and -not $link.IsLink) {
    $st = Get-TreeStat -Path $j.Src
  } else {
    $st = [pscustomobject]@{ Files = 0; Bytes = 0 }
  }
  $dstExists = Test-Path -LiteralPath $j.Dst
  $totalBytes += $st.Bytes
  $plans += [pscustomobject]@{ Job = $j; Stat = $st; DstExists = $dstExists; Link = $link }

  Write-Host ("  . {0}" -f $j.Label)
  if ($exists) {
    if ($link.IsLink) {
      Write-Host ("      源：{0}" -f $j.Src)
      Write-Host ("      ! 源已经是{0} -> {1}，将跳过" -f $link.Type, $link.Target)
    } else {
      Write-Host ("      源：{0}（{1} 文件 / {2}）" -f $j.Src, $st.Files, (Format-GB $st.Bytes))
    }
  } else {
    Write-Host ("      源：{0}（不存在）" -f $j.Src)
  }
  Write-Host ("      目标：{0}{1}" -f $j.Dst, $(if ($dstExists) { '（已存在）' } else { '' }))
}
Write-Host ''
Write-Host ("  合计待迁移：{0}" -f (Format-GB $totalBytes))
$free = (Get-Volume -DriveLetter D).SizeRemaining
Write-Host ("  D 盘可用：{0}  {1}" -f (Format-GB $free), $(if ($free -gt $totalBytes + 2GB) { 'OK 足够' } else { '! 空间不足' }))
if ($free -le $totalBytes + 2GB -and $Apply) { Write-Host '  空间不足，已中止。'; exit 1 }
Write-Host ''

if (-not $Apply) {
  Write-Host '干跑结束：以上是将会发生的事，未改动任何文件。确认后加 -Apply 执行。'
  Write-Host ''
  exit 0
}

# ---- 正式执行 ----
if (-not (Test-Path -LiteralPath $ROOT)) { New-Item -ItemType Directory -Path $ROOT -Force | Out-Null }

foreach ($p in $plans) {
  $job = $p.Job
  Write-Host ('-' * 92)
  Write-Host ("迁移：{0}" -f $job.Label)

  if ($p.Link.IsLink) {
    Write-Host ("  跳过：源已经是链接（-> {0}）" -f $p.Link.Target)
    continue
  }

  $srcExists = Test-Path -LiteralPath $job.Src
  if (-not $srcExists) {
    if (-not $p.DstExists) { Write-Host '  源与目标都不存在 -> 跳过'; continue }
    Write-Host '  源不存在但目标存在 -> 直接建立联接'
  } else {
    # 1)+2) 复制并校验 —— **循环重试**：
    #   实测：biliLive-tools 停录后压制仍在写文件（哈喽-弹幕版.mp4 拷完后还长 6MB），
    #   一趟走完必然报差异。所以这里最多试 $MaxSync 轮，每轮重新同步再复核。
    $MaxSync = 3
    $synced = $false
    for ($attempt = 1; $attempt -le $MaxSync -and -not $synced; $attempt++) {
      Write-Host ("  1) robocopy 同步（第 {0}/{1} 轮）-> {2}" -f $attempt, $MaxSync, $job.Dst)
      $roboArgs = @($job.Src, $job.Dst, '/MIR', '/COPY:DAT', '/DCOPY:DAT', '/R:2', '/W:2', '/NFL', '/NDL', '/NP', '/NJH', '/NJS')
      & robocopy @roboArgs | Out-Null
      $rc = $LASTEXITCODE
      Write-Host ("      robocopy 退出码 {0} {1}" -f $rc, $(if ($rc -lt 8) { '（成功）' } else { '（有错误！）' }))
      if ($rc -ge 8) {
        Write-Host '  复制失败，已中止（源未改动）。'
        exit 1
      }

      $a = Get-TreeStat -Path $job.Src
      $b = Get-TreeStat -Path $job.Dst
      Write-Host ("  2) 核对：源 {0} 文件 / {1}  <->  目标 {2} 文件 / {3}" -f $a.Files, (Format-GB $a.Bytes), $b.Files, (Format-GB $b.Bytes))
      if ($a.Files -ne $b.Files) {
        Write-Host '      ! 文件数不一致（源可能在新增文件）—— 重试…'
        Start-Sleep -Seconds 5
        continue
      }

      # 用 robocopy 干跑复核：退出码 0 = 两边完全一致
      $diffArgs = @($job.Src, $job.Dst, '/MIR', '/L', '/NJH', '/NP', '/R:0', '/W:0', '/NDL')
      $diffOut = & robocopy @diffArgs 2>&1
      $drc = $LASTEXITCODE
      if ($drc -eq 0) {
        Write-Host '      OK robocopy 复核：两边完全一致'
        $synced = $true
      } else {
        Write-Host ("      ! 第 {0} 轮复核仍有差异（退出码 {1}）：" -f $attempt, $drc)
        $diffOut | Where-Object { $_ -and $_.Trim() -ne '' -and $_ -notmatch '^(Total|Dirs|Files|Bytes|Times|Ended|Speed|\s*[-]+\s*$)' } | Select-Object -First 8 | ForEach-Object { Write-Host ("        {0}" -f $_.Trim()) }
        if ($attempt -lt $MaxSync) { Write-Host '      等 6 秒后重试（文件可能还在写）…'; Start-Sleep -Seconds 6 }
      }
    }
    if (-not $synced) {
      Write-Host ''
      Write-Host '      ! 连续多轮都无法完全一致 —— 说明上游仍在写这些文件。'
      Write-Host '        最可能的原因：biliLive-tools 的**压制/后处理任务还在跑**（停止录制 ≠ 停止压制）。'
      Write-Host '        处理办法：在 biliLive-tools 里等它的任务队列清空（或退出该软件），然后重跑本脚本；'
      Write-Host '        已复制的部分会自动跳过，不会重复拷。'
      Write-Host '      ! 为安全起见**不删除源**。'
      exit 1
    }

    # 3) 删除源
    Write-Host '  3) 删除原目录（目标已有完整副本）'
    try {
      Remove-Item -LiteralPath $job.Src -Recurse -Force -ErrorAction Stop
    } catch {
      Write-Host ("      ! 删除失败：{0}" -f $_.Exception.Message)
      Write-Host '      目标副本完好；请手动删除源目录后重跑本脚本（它会直接建联接）。'
      exit 1
    }
    Write-Host '      OK 已删除'
  }

  # 4) 建立联接
  Write-Host ("  4) mklink /J {0} -> {1}" -f $job.Src, $job.Dst)
  $mk = & cmd.exe /c mklink /J $job.Src $job.Dst 2>&1
  Write-Host ("      {0}" -f ($mk -join ' '))
  $li = Get-LinkInfo -Path $job.Src
  if ($li.IsLink) {
    Write-Host ("      OK 联接已建立（{0} -> {1}）" -f $li.Type, $li.Target)
  } else {
    Write-Host '      ! 联接未建立 —— 原路径现在不可用！请手动执行上面那条 mklink 命令。'
    exit 1
  }

  # 5) 通过原路径验证读写
  $probe = Join-Path $job.Src ('.dsh-probe-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  try {
    Set-Content -LiteralPath $probe -Value 'ok' -Encoding ascii -ErrorAction Stop
    Remove-Item -LiteralPath $probe -Force -ErrorAction Stop
    Write-Host '      OK 通过原路径读写正常（联接生效）'
  } catch {
    Write-Host ("      ! 通过原路径写入失败：{0}" -f $_.Exception.Message)
    exit 1
  }
  Write-Host ''
}

Write-Host ('=' * 92)
Write-Host '迁移完成'
Write-Host ('=' * 92)
foreach ($p in $plans) {
  $li = Get-LinkInfo -Path $p.Job.Src
  Write-Host ("  {0}" -f $p.Job.Src)
  if ($li.IsLink) {
    Write-Host ("      -> {0} {1}" -f $li.Type, $li.Target)
  } else {
    Write-Host '      -> (不是链接，需检查)'
  }
}
Write-Host ''
Write-Host '  两个软件不需要改任何配置 —— 原路径经联接照常指向 D 盘的数据。'
Write-Host ("  真实数据现在位于：{0}" -f $ROOT)
Write-Host ''

# 自动重启服务（如果迁移前它在跑）
if ($serviceWasRunning) {
  Write-Host '  重启切片助手服务…'
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
  if ($up) {
    Write-Host '      OK 服务已重启：http://127.0.0.1:3000'
  } else {
    Write-Host '      ! 服务没起来 —— 请手动运行：node src\cli.ts run'
  }
}
Write-Host ''
