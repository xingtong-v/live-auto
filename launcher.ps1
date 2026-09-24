<#
  直播切片助手 · 一键启动
  ─────────────────────────────────────────────
  做三件事：
    1. 检查环境（Node 版本、依赖、配置、biliLive-tools 是否在线）
    2. 启动后端常驻服务（默认 127.0.0.1:3000）
    3. 等服务真正就绪后，自动打开前端界面（Edge 应用窗口，像个独立应用）

  用法：
    双击桌面快捷方式，或命令行执行
      powershell -NoProfile -ExecutionPolicy Bypass -File F:\deepseek\live_auto\launcher.ps1

  参数：
    -DryRun        只跑到分析产出，不切片不投稿，且默认不调用付费 AI
    -AllowPaid     显式允许产生 ASR / LLM 费用
    -NoBrowser     只启动后端，不打开界面
    -Port 3000     指定 Web UI 端口
    -Room 22886881 覆盖目标直播间
    -NoPause       退出时不等待按键（供自动化调用）

  实现说明（为什么这么做）：
    · 服务用 Start-Process 起独立进程并持有句柄 —— 关闭本窗口时能确保把它一起收掉，
      不会留下孤儿 node 进程。
    · 服务日志先写文件再读出来显示 —— 比 PowerShell Job 的管道可靠，
      也避免 Windows PowerShell 5.1 用 ANSI 代码页解码 UTF-8 导致的中文乱码。
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$AllowPaid,
  [switch]$NoBrowser,
  [int]$Port = 3000,
  [string]$Room,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 编码
# Windows PowerShell 5.1 默认用系统 ANSI 代码页解码子进程输出，Node 输出 UTF-8 会变乱码。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ★ 光设 [Console]::OutputEncoding **不够**：PowerShell 5.1 并不会因此调用
#   SetConsoleOutputCP，控制台仍按系统 ANSI 代码页（中文 Windows = 936，2 字节/字）
#   解码我们写出去的 UTF-8 字节流。UTF-8 里一个汉字是 3 字节，于是被拆成两个"字符" ——
#   实测界面标题显示成「B站站直直播播全全自自动动切切片片系系统统」（每个汉字变两个）。
#   必须显式把控制台代码页也切成 UTF-8，两边才会一致。
#   注意：**不能**用"降级成 ASCII 输出"来兜底 —— 这个启动器通篇是中文，降级等于什么都不显示。
$script:CpOk = $false
try {
  if (-not ('LiveAuto.ConsoleCp' -as [type])) {
    Add-Type -Namespace LiveAuto -Name ConsoleCp -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetConsoleOutputCP(uint wCodePageID);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern bool SetConsoleCP(uint wCodePageID);
'@ -ErrorAction Stop
  }
  [void][LiveAuto.ConsoleCp]::SetConsoleOutputCP(65001)
  [void][LiveAuto.ConsoleCp]::SetConsoleCP(65001)
  $script:CpOk = $true
} catch {
  $script:CpOk = $false
}
# 启动器自己排版，不需要 Node 侧再插 ANSI 颜色码
$env:NO_COLOR = '1'

$ROOT = $PSScriptRoot
$URL = "http://127.0.0.1:$Port"
$MAIN_TITLE = '直播切片助手 · live_auto'

# ---------------------------------------------------------------- 输出辅助
function Say([string]$t, [string]$color = 'Gray') { Write-Host $t -ForegroundColor $color }
function Ok([string]$t) { Write-Host "  [OK] $t" -ForegroundColor Green }
function Warn([string]$t) { Write-Host "  [!!] $t" -ForegroundColor Yellow }
function Err([string]$t) { Write-Host "  [XX] $t" -ForegroundColor Red }
function Head([string]$t) {
  Write-Host ''
  Write-Host $t -ForegroundColor Cyan
  Write-Host ('-' * [Math]::Max(20, [Math]::Min(64, $t.Length * 2 + 6))) -ForegroundColor DarkGray
}

function Pause-Exit([int]$code) {
  if (-not $NoPause) {
    Write-Host ''
    Write-Host '按任意键关闭此窗口…' -ForegroundColor DarkGray
    try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Start-Sleep -Seconds 6 }
  }
  exit $code
}

# ---------------------------------------------------------------- 界面打开方式（先定义，两处都要用）
function Open-App([string]$u) {
  # 优先用 Edge 的应用模式：没有地址栏和标签页，更像个独立应用
  $edge = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1

  if ($edge) {
    Start-Process -FilePath $edge -ArgumentList @("--app=$u", '--window-size=1440,960') | Out-Null
    return 'Edge 应用窗口'
  }
  Start-Process $u | Out-Null   # 回退：系统默认浏览器
  return '默认浏览器'
}

function Test-Service([string]$u) {
  try {
    $r = Invoke-WebRequest -Uri "$u/api/bootstrap" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Resolve-Node {
  $c = New-Object System.Collections.Generic.List[string]
  if ($env:LIVE_AUTO_NODE) { $c.Add($env:LIVE_AUTO_NODE) }
  $c.Add((Join-Path $ROOT 'node\node.exe'))
  $c.Add((Join-Path (Split-Path $ROOT -Parent) 'node\node.exe'))
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $c.Add($cmd.Source) }
  Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Filter 'OpenJS.NodeJS.LTS_*' -Directory -ErrorAction SilentlyContinue |
    ForEach-Object {
      Get-ChildItem -Path $_.FullName -Filter 'node-*' -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { $c.Add((Join-Path $_.FullName 'node.exe')) }
    }
  foreach ($x in $c) { if ($x -and (Test-Path -LiteralPath $x -PathType Leaf)) { return (Resolve-Path -LiteralPath $x).Path } }
  return $null
}

# ---------------------------------------------------------------- 抬头
try { $Host.UI.RawUI.WindowTitle = $MAIN_TITLE } catch { }
Write-Host ''
Write-Host '  直播切片助手' -ForegroundColor White -BackgroundColor DarkMagenta
Write-Host '  B站直播全自动切片系统' -ForegroundColor DarkGray
Write-Host "  工作目录  $ROOT" -ForegroundColor DarkGray
Write-Host "  运行模式  $(if ($DryRun) { 'dry-run（不切片、不投稿）' } else { '正常运行' })" -ForegroundColor DarkGray
# 代码页没切成 UTF-8 时，上面的中文会被控制台按 2 字节/字解码成"每字变两个"。
# 与其让用户看一屏乱码猜原因，不如直接说清楚怎么办。
if (-not $CpOk) {
  Write-Host '  [!!] 无法把控制台切换到 UTF-8（中文可能显示成"每个字变两个"）' -ForegroundColor Yellow
  Write-Host '       解决办法：在窗口里先执行 chcp 65001，再重新运行本启动器。' -ForegroundColor DarkGray
}

Set-Location -LiteralPath $ROOT

# ---------------------------------------------------------------- 0. 已在运行？
Head '0. 检查服务是否已在运行'
if (Test-Service $URL) {
  Ok "服务已经在运行：$URL"
  if (-not $NoBrowser) {
    Say '  正在打开界面…' DarkGray
    $null = Open-App $URL
  }
  Say '  （无需重复启动；关闭本窗口不会停止已在运行的服务）' DarkGray
  Pause-Exit 0
}

# ---------------------------------------------------------------- 1. 环境检查
Head '1. 环境检查'

$nodeExe = Resolve-Node
if (-not $nodeExe) {
  Err '找不到 Node.js'
  Say '  请设置环境变量 LIVE_AUTO_NODE 指向 node.exe，或把 Node 加入 PATH。' DarkGray
  Pause-Exit 1
}
$nodeVer = (& $nodeExe -v).Trim()
$major = [int]($nodeVer.TrimStart('v').Split('.')[0])
if ($major -lt 24) {
  Err "Node 版本过低：需要 v24+（当前 $nodeVer）"
  Say '  本服务直接用 node 运行 .ts 文件，依赖 Node 24 的原生类型擦除能力（无构建步骤）。' DarkGray
  Pause-Exit 1
}
Ok "Node $nodeVer"
Say "       $nodeExe" DarkGray

if (-not (Test-Path 'node_modules')) {
  Warn '未安装依赖，正在安装（zod / fast-xml-parser / p-limit）…'
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Err '依赖安装失败'; Pause-Exit 1 }
}
Ok '依赖已就绪'

if (-not (Test-Path 'config.json')) {
  Warn '未找到 config.json，正在从 biliLive-tools 读取 PassKey 生成…'
  & $nodeExe 'tools\init-config.mjs'
  if ($LASTEXITCODE -ne 0) {
    Err '自动生成失败：请手动复制 config.example.json 为 config.json 并填写 PassKey'
    Pause-Exit 1
  }
}
Ok 'config.json 已就绪'

# biliLive-tools 是录制/压制/切割/上传/ASR 的执行方，必须在线
$biliUrl = 'http://127.0.0.1:18010'
try {
  $cfg = Get-Content 'config.json' -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($cfg.bililive.baseUrl) { $biliUrl = $cfg.bililive.baseUrl }
} catch { }

$biliUp = $false
try {
  $null = Invoke-WebRequest -Uri "$biliUrl/common/version" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
  $biliUp = $true
} catch {
  # 401 也算「在跑」——只是 PassKey 不匹配，服务本身是活的
  if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -eq 401) { $biliUp = $true }
}
if ($biliUp) {
  Ok "biliLive-tools 在线（$biliUrl）"
} else {
  Warn "biliLive-tools 未响应（$biliUrl）"
  Say '       它是录制 / 压制 / 切割 / 上传 / ASR 的执行方。' DarkGray
  Say '       现在启动也能用（界面与只读功能正常），但开播后不会录制、任务不会执行。' DarkGray
  Say '       建议先启动 biliLive-tools 桌面版。' DarkGray
}

if (-not (Test-Path 'public\ui.html')) { Err '找不到前端界面文件 public\ui.html'; Pause-Exit 1 }
Ok '前端界面文件已就绪'

# ---------------------------------------------------------------- 2. 启动后端
Head '2. 启动后端服务'

$cliArgs = @('src\cli.ts', 'run', '--port', "$Port")
if ($DryRun) { $cliArgs += '--dry-run' }
if ($AllowPaid) { $cliArgs += '--allow-paid' }
if ($Room) { $cliArgs += @('--room', $Room) }

Say "  $nodeExe $($cliArgs -join ' ')" DarkGray
if ($DryRun -and -not $AllowPaid) {
  Say '  dry-run 且未允许付费：不会调用付费 ASR / LLM（硬约束 #14）' Green
}

$logDir = Join-Path $ROOT 'data\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$consoleLog = Join-Path $logDir 'launcher-console.log'
if (Test-Path $consoleLog) { Remove-Item $consoleLog -Force -ErrorAction SilentlyContinue }

Write-Host ''
$proc = Start-Process -FilePath $nodeExe `
  -ArgumentList $cliArgs `
  -WorkingDirectory $ROOT `
  -RedirectStandardOutput $consoleLog `
  -RedirectStandardError (Join-Path $logDir 'launcher-error.log') `
  -NoNewWindow -PassThru

$opened = $false
$script:readOffset = 0
$deadline = (Get-Date).AddSeconds(75)

function Show-NewLog {
  if (-not (Test-Path $consoleLog)) { return }
  try {
    $fs = [System.IO.File]::Open($consoleLog, 'Open', 'Read', 'ReadWrite')
    $text = ''
    try {
      if ($fs.Length -gt $script:readOffset) {
        $null = $fs.Seek($script:readOffset, 'Begin')
        $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
        $text = $sr.ReadToEnd()
        $script:readOffset = $fs.Position
        $sr.Close()
      }
    } finally { $fs.Close() }
    if (-not $text) { return }
    foreach ($line in ($text -split "`r?`n")) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      if ($line -match 'ERROR|\[XX\]') { Write-Host $line -ForegroundColor Red }
      elseif ($line -match 'WARN|\[!!\]') { Write-Host $line -ForegroundColor Yellow }
      elseif ($line -match 'Web UI|已启动|已就绪|READY') { Write-Host $line -ForegroundColor Cyan }
      else { Write-Host $line -ForegroundColor Gray }
    }
  } catch { }
}

try {
  while ($true) {
    Show-NewLog

    if ($proc.HasExited) { Show-NewLog; break }

    if (-not $opened -and (Test-Service $URL)) {
      $opened = $true
      Head '3. 打开前端界面'
      Ok "服务已就绪：$URL"
      if (-not $NoBrowser) {
        $how = Open-App $URL
        Ok "已用 $how 打开界面"
      } else {
        Say '  （-NoBrowser：未自动打开，请手动访问上面的地址）' DarkGray
      }
      Write-Host ''
      Write-Host '  ---------------------------------------------' -ForegroundColor DarkGray
      Write-Host '  服务正在常驻运行，日志继续显示在下方。' -ForegroundColor DarkGray
      Write-Host '  按 Ctrl+C 或直接关闭本窗口即可停止服务。' -ForegroundColor DarkGray
      Write-Host '  ---------------------------------------------' -ForegroundColor DarkGray
      Write-Host ''
    }

    if (-not $opened -and (Get-Date) -gt $deadline) {
      Err '服务在 75 秒内没有就绪'
      Say '  常见原因与处理：' DarkGray
      Say '    · 端口被占用   -> 换端口：launcher.ps1 -Port 3100' DarkGray
      Say '    · PassKey 不对 -> 检查 config.json 的 bililive.passKey' DarkGray
      Say '    · 配置有硬错误 -> 在项目目录执行：node src\cli.ts selfcheck' DarkGray
      break
    }

    Start-Sleep -Milliseconds 500
  }
} finally {
  # 收尾：确保把后端子进程一起收掉，不留孤儿进程
  if ($proc -and -not $proc.HasExited) {
    Write-Host ''
    Say '正在停止服务…' DarkGray
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
    Start-Sleep -Milliseconds 800
  }
  # 双保险：按命令行特征再扫一遍
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$ROOT*" } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }
  Say '服务已停止。' DarkGray
}

if ($proc -and $proc.HasExited -and $proc.ExitCode -ne 0) {
  Err "服务异常退出（退出码 $($proc.ExitCode)）。排查命令："
  Say "  cd $ROOT" DarkGray
  Say "  & '$nodeExe' src\cli.ts selfcheck    # 逐项自检（会明确告诉你是哪一项不通）" DarkGray
  Say "  & '$nodeExe' src\cli.ts health       # 健康快照" DarkGray
  Say "  & '$nodeExe' src\cli.ts inspect      # 最近的错误报告" DarkGray
  Say "  日志：$logDir" DarkGray
  Pause-Exit 1
}

Pause-Exit 0
