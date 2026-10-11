/**
 * 探测：用**系统默认播放器**打开一个视频文件时，窗口会不会真的出现在前台。
 *
 * 背景（用户第 4 轮需求）："当我点击试看的时候 定位切片的产物目录 选择这个文件
 * 然后用 win 系统自带的播放器前台播放给我看"。
 * 这条路比"自己转码生成预览片段"简单得多 —— 不转码、不占磁盘、不等待。
 *
 * 但"能不能**前台**播放"必须实测，因为：
 *   · 同一播放器进程已在运行时会**复用窗口**，新文件在里面打开，
 *     窗口可能停在后台（这正是前几轮"点了没反应"的同一个坑）；
 *   · `Start-Process` 无法保证前台。
 *
 * 本工具测两件事：
 *   ① `.mp4` 的默认关联程序是谁（读注册表 UserChoice，不猜）
 *   ② `Start-Process` 打开后，前台窗口是不是那个播放器；不是的话尝试激活
 *
 * 用法：node --experimental-strip-types tools/probe-system-player.ts <视频文件路径>
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const file = process.argv[2];
if (!file) {
  console.error('用法：node --experimental-strip-types tools/probe-system-player.ts <视频文件路径>');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`文件不存在：${file}`);
  process.exit(1);
}
const line = (s = ''): void => console.log(s);

function ps(script: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    cwd: process.env['TEMP'],
  });
}

line('='.repeat(92));
line(`探测系统默认播放器：${file}`);
line('='.repeat(92));

/* ---- ① 默认关联：查 UserChoice（用户显式选择过才有），再退回 HKCR 的 .mp4 ---- */
line('');
line('① 关联信息（只读注册表，不修改任何关联）');
const assoc = ps(`
$progId = ''
try {
  $u = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExtCom\\.mp4\\UserChoice' -ErrorAction Stop
  $progId = $u.ProgId
} catch { }
if (-not $progId) {
  try { $progId = (Get-ItemProperty 'HKCU:\\Software\\Classes\\.mp4' -ErrorAction Stop).'(default)' } catch { }
}
if (-not $progId) { try { $progId = (Get-ItemProperty 'HKLM:\\Software\\Classes\\.mp4' -ErrorAction Stop).'(default)' } catch { } }
Write-Output ('ProgId=' + $progId)
$cmd = ''
if ($progId) {
  try { $cmd = (Get-ItemProperty ('HKCR:\\' + $progId + '\\shell\\open\\command') -ErrorAction Stop).'(default)' } catch { }
  if (-not $cmd) { try { $cmd = (Get-ItemProperty ('HKCU:\\Software\\Classes\\' + $progId + '\\shell\\open\\command') -ErrorAction Stop).'(default)' } catch { } }
}
Write-Output ('OpenCommand=' + $cmd)
`)
for (const l of assoc.split(/\r?\n/).filter(Boolean)) line(`     ${l}`);

/* ---- ② 前台窗口检测用的辅助脚本 ---- */
function foreground(): string {
  return ps(`
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
'@
$h = [W.U]::GetForegroundWindow()
$p = 0
[void][W.U]::GetWindowThreadProcessId($h, [ref]$p)
(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
`).trim();
}

line('');
line(`② 打开前的前台进程：${foreground()}`);

/* ---- ③ 用默认程序打开（Start-Process 不绕 shell，路径安全） ---- */
line('');
line('③ 执行 Start-Process -FilePath <file>（走系统默认程序）');
const t0 = Date.now();
try {
  ps(`Start-Process -FilePath '${file.replace(/'/g, "''")}'`);
  line('     已发出');
} catch (e) {
  line(`     ✗ 失败：${(e as Error).message.slice(0, 120)}`);
}
await new Promise((r) => setTimeout(r, 4000));
const fg1 = foreground();
line(`     ${Date.now() - t0}ms 后前台进程：${fg1}`);

/* ---- ④ 若不在前台，尝试把它提上来 ---- */
line('');
line('④ 前台校正');
if (fg1.toLowerCase().includes('player') || fg1 === 'Microsoft.Media.Player' || fg1 === 'wmplayer' || fg1 === 'Music.UI') {
  line('     ✓ 播放器已在前台，无需额外处理');
} else {
  line(`     前台是 ${fg1}，尝试用无标题匹配的方式把播放器窗口提上来…`);
  const probe = ps(`
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint p);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint flags, UIntPtr extra);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
'@
# 找出占用当前前台之外、最近启动的媒体相关进程的主窗口
$names = @('Microsoft.Media.Player','wmplayer','vlc','mpc-hc64','mpc-hc','PotPlayerMini64','PotPlayer','mpv','QQPlayer','bilibili')
$cand = @()
foreach ($n in $names) {
  foreach ($p in @(Get-Process -Name $n -ErrorAction SilentlyContinue)) {
    if ($p.MainWindowHandle -ne 0) { $cand += [pscustomobject]@{ Name=$p.ProcessName; H=$p.MainWindowHandle; T=$p.StartTime } }
  }
}
$cand = $cand | Sort-Object T -Descending
if ($cand.Count -eq 0) { Write-Output 'NOPLAYER'; exit }
$top = [IntPtr]$cand[0].H
[void][W.U]::ShowWindow($top, 9)
[W.U]::keybd_event(0x12,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [W.U]::keybd_event(0x12,0,2,[UIntPtr]::Zero)
$fg = [W.U]::GetForegroundWindow(); $tid = 0; [void][W.U]::GetWindowThreadProcessId($fg, [ref]$tid)
$my = [W.U]::GetCurrentThreadId(); $att = $false
if ($tid -ne $my) { $att = [W.U]::AttachThreadInput($my, [uint32]$tid, $true) }
$r = [W.U]::SetForegroundWindow($top)
if ($att) { [void][W.U]::AttachThreadInput($my, [uint32]$tid, $false) }
Write-Output ('CAND=' + $cand[0].Name + ' ret=' + $r)
`);
  for (const l of probe.split(/\r?\n/).filter(Boolean)) line(`     ${l}`);
  await new Promise((r) => setTimeout(r, 2000));
  line(`     之后前台进程：${foreground()}`);
}
line('');
