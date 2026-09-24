/**
 * 诊断：服务里那段"激活资源管理器窗口"的 PowerShell 脚本为什么没生效。
 *
 * 背景：`tools/focus-window.ts` 里同样的思路实测成功（SetForegroundWindow 返回 True、
 * 前台变成 explorer），但搬到服务里通过 spawn 调用后前台仍是浏览器。
 * 差异可能在：Add-Type 的命名空间冲突、脚本拼接、spawn 的参数、或执行时机。
 *
 * 本脚本用**与服务完全相同的写法**发一次，并把 PowerShell 的输出/错误原样打出来 ——
 * 不再靠"没报错就是成功"来判断。
 *
 * 用法：node --experimental-strip-types tools/diagnose-activate.ts <目录名匹配串>
 */
import { spawnSync } from 'node:child_process';

const needle = process.argv[2];
if (!needle) {
  console.error('用法：node --experimental-strip-types tools/diagnose-activate.ts <目录名匹配串>');
  process.exit(1);
}
const safe = needle.replace(/'/g, "''");
const line = (s = ''): void => console.log(s);

/* ↓↓↓ 这一段与 src/server.ts 的 activateExplorerWindow 保持一致 ↓↓↓ */
const script =
  `Start-Sleep -Milliseconds 700; ` +
  `Add-Type -Namespace W -Name U -MemberDefinition @'\n` +
  `[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);\n` +
  `[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);\n` +
  `[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);\n` +
  `[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\n` +
  `[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);\n` +
  `[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);\n` +
  `[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();\n` +
  `[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);\n` +
  `[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint flags, UIntPtr extra);\n` +
  `[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);\n` +
  `'@; ` +
  `$sh = New-Object -ComObject Shell.Application; ` +
  `$t = $null; ` +
  `foreach ($w in @($sh.Windows())) { $n=''; try { $n=[string]$w.LocationName } catch { continue }; ` +
  `if ($n -eq '${safe}' -or $n -like '*${safe}*') { $t = $w; break } }; ` +
  `if (-not $t) { Write-Output 'NOTFOUND'; exit }; ` +
  `Write-Output ('FOUND LocationName=' + $t.LocationName); ` +
  `$top = [W.U]::GetAncestor([IntPtr]$t.HWND, 2); if ($top -eq [IntPtr]::Zero) { $top = [IntPtr]$t.HWND }; ` +
  `Write-Output ('TOP=' + $top); ` +
  `[void][W.U]::ShowWindow($top, 9); ` +
  `Write-Output ('SetWindowPos=' + [W.U]::SetWindowPos($top, [IntPtr]::Zero, 0,0,0,0, 0x0043)); ` +
  `[void][W.U]::BringWindowToTop($top); ` +
  `[W.U]::keybd_event(0x12,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [W.U]::keybd_event(0x12,0,2,[UIntPtr]::Zero); ` +
  `Start-Sleep -Milliseconds 60; ` +
  `$fg = [W.U]::GetForegroundWindow(); $tid = 0; [void][W.U]::GetWindowThreadProcessId($fg, [ref]$tid); ` +
  `$my = [W.U]::GetCurrentThreadId(); ` +
  `Write-Output ('fgTid=' + $tid + ' myTid=' + $my); ` +
  `$att = $false; ` +
  `if ($tid -ne $my) { $att = [W.U]::AttachThreadInput($my, [uint32]$tid, $true) }; ` +
  `Write-Output ('AttachThreadInput=' + $att); ` +
  `$r = [W.U]::SetForegroundWindow($top); ` +
  `Write-Output ('SetForegroundWindow=' + $r); ` +
  `if ($att) { [void][W.U]::AttachThreadInput($my, [uint32]$tid, $false) }`;
/* ↑↑↑ 与服务一致 ↑↑↑ */

line('='.repeat(88));
line(`诊断激活脚本：匹配串「${needle}」`);
line('='.repeat(88));

const b64 = Buffer.from(script, 'utf16le').toString('base64');
line(`  脚本长度 ${script.length} 字符，base64 ${b64.length} 字符`);
line('');
line('  执行（捕获 stdout + stderr）…');
const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { encoding: 'utf8' });
line(`  exit code = ${String(r.status)}`);
line('');
line('  ── stdout ──');
for (const l of (r.stdout ?? '').split(/\r?\n/).filter(Boolean)) line(`    ${l}`);
if (r.stderr && r.stderr.trim()) {
  line('  ── stderr ──');
  for (const l of r.stderr.split(/\r?\n/).filter(Boolean).slice(0, 12)) line(`    ${l}`);
}
line('');
