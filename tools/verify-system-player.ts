/**
 * 验证"用系统自带播放器前台播放切片产物"的完整流程。
 *
 * 本机实测到的两个障碍（都不是猜的）：
 *   ① `.mp4` **没有有效的默认关联** —— `UserChoice` 是空的，注册表里挂着一个
 *      坏的 `QyClient_mp4`（奇游加速器）。所以 `Start-Process <file>` 会弹出
 *      **「打开方式」对话框**（前台进程名就叫 `OpenWith`），而不是播放视频。
 *   ② `wmplayer.exe` 进程确实起来了，但窗口抢不到前台（`SetForegroundWindow` 返回 False），
 *      因为前台被那个对话框占着。
 *
 * 对策：
 *   · **绕过文件关联**，直接指定播放器可执行文件（wmplayer.exe 是系统自带的）；
 *   · 打开前先关掉可能存在的「打开方式」对话框（否则它会一直挡在前面）；
 *   · 打开后用 HWND + ALT 解锁把播放器窗口提到前台（这套在 §12.7.1 已验证有效）。
 *
 * 用法：node --experimental-strip-types tools/verify-system-player.ts <视频文件>
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('用法：node --experimental-strip-types tools/verify-system-player.ts <存在的视频文件>');
  process.exit(1);
}
const line = (s = ''): void => console.log(s);

function ps(script: string, quiet = true): string {
  const r = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    cwd: process.env['TEMP'],
    ...(quiet ? {} : { stdio: 'ignore' as const }),
  });
  return typeof r === 'string' ? r : '';
}
function foreground(): string {
  try {
    return ps(`Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
'@
$h=[W.U]::GetForegroundWindow(); $p=0; [void][W.U]::GetWindowThreadProcessId($h,[ref]$p)
(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName`).trim();
  } catch {
    return '(取不到)';
  }
}

/** 关掉「打开方式」对话框（它由 explorer 宿主，进程名 OpenWith / 标题含"打开方式"） */
function closeOpenWithDialog(): number {
  try {
    const out = ps(`
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
'@
$n = 0
foreach ($p in @(Get-Process -Name 'OpenWith' -ErrorAction SilentlyContinue)) { try { $p.CloseMainWindow() | Out-Null; $n++ } catch {} }
Start-Sleep -Milliseconds 400
foreach ($p in @(Get-Process -Name 'OpenWith' -ErrorAction SilentlyContinue)) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; $n++ } catch {} }
Write-Output $n`);
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

/** 打开播放器并把它的窗口提到前台 */
function openAndRaise(exe: string, target: string): { opened: boolean; raised: string } {
  const safeExe = exe.replace(/'/g, "''");
  const safeTarget = target.replace(/'/g, "''");
  const script = `
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint flags, UIntPtr e);
'@
try { Start-Process -FilePath '${safeExe}' -ArgumentList '"${safeTarget}"' -ErrorAction Stop } catch { Write-Output ('OPENFAIL=' + $_.Exception.Message); exit }
# 轮询等窗口出现（播放器启动要时间）
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 25 -and $h -eq [IntPtr]::Zero; $i++) {
  Start-Sleep -Milliseconds 400
  $p = Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension('${safeExe}')) -ErrorAction SilentlyContinue |
       Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { $h = [IntPtr]$p.MainWindowHandle }
}
if ($h -eq [IntPtr]::Zero) { Write-Output 'NOWINDOW'; exit }
[void][W.U]::ShowWindow($h, 9)
[W.U]::keybd_event(0x12,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [W.U]::keybd_event(0x12,0,2,[UIntPtr]::Zero)
$fg=[W.U]::GetForegroundWindow(); $tid=0; [void][W.U]::GetWindowThreadProcessId($fg,[ref]$tid)
$my=[W.U]::GetCurrentThreadId(); $att=$false
if ($tid -ne $my) { $att=[W.U]::AttachThreadInput($my,[uint32]$tid,$true) }
$r=[W.U]::SetForegroundWindow($h)
if ($att) { [void][W.U]::AttachThreadInput($my,[uint32]$tid,$false) }
Write-Output ('OPENED ret=' + $r)`;
  const out = ps(script);
  return { opened: out.includes('OPENED'), raised: out.trim() };
}

line('='.repeat(92));
line('验证：用系统自带播放器前台播放切片产物');
line('='.repeat(92));
line(`  文件：${file}`);
line(`  初始前台：${foreground()}`);

line('');
line('① 先关掉可能存在的「打开方式」对话框（它会把播放器挡在后面）');
const closed = closeOpenWithDialog();
line(`     关闭了 ${closed} 个`);

/* 找可用的系统播放器：优先 wmplayer.exe（系统自带、实测进程能起来） */
line('');
line('② 定位可用的系统播放器可执行文件');
const found = ps(`
$out = @()
foreach ($c in @(
  @{n='wmplayer'; p="$env:SystemRoot\\System32\\wmplayer.exe"},
  @{n='wmplayer(x86)'; p="$env:ProgramFiles(x86)\\Windows Media Player\\wmplayer.exe"},
  @{n='mpc-hc'; p="$env:ProgramFiles\\MPC-HC\\mpc-hc64.exe"},
  @{n='vlc'; p="$env:ProgramFiles\\VideoLAN\\VLC\\vlc.exe"},
  @{n='PotPlayer'; p="$env:ProgramFiles\\DAUM\\PotPlayer\\PotPlayerMini64.exe"}
)) { if (Test-Path $c.p) { $out += ($c.n + '=' + $c.p) } }
$out -join "\`n"`);
for (const l of found.split(/\r?\n/).filter(Boolean)) line(`     ${l}`);
const exeLine = found.split(/\r?\n/).find((l) => l.startsWith('wmplayer='));
if (!exeLine) {
  line('     ✗ 没找到 wmplayer.exe，无法继续');
  process.exit(1);
}
const exe = exeLine.slice('wmplayer='.length).trim();

line('');
line(`③ 用 ${exe} 打开并提到前台（轮询等窗口出现 + ALT 解锁）`);
const r = openAndRaise(exe, file);
line(`     脚本输出：${r.raised}`);
await new Promise((res) => setTimeout(res, 1500));
const fg = foreground();
line(`     现在前台：${fg}`);
line('');
line(fg.toLowerCase().includes('wmplayer') ? '\x1b[32m✓ 成功：播放器已在前台播放\x1b[0m' : '\x1b[31m✗ 播放器不在前台\x1b[0m');
line('');
