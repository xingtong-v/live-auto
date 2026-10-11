/**
 * 列出当前所有**可见的顶层窗口**（含标题与所属进程），用于排查"某个窗口挡在界面上"。
 *
 * 为什么不用 Shell.Application：那只列**资源管理器文件夹窗口**，
 * 查不到其它程序（浏览器、记事本、QQ 等）的窗口。这里用 user32 的 EnumWindows。
 *
 * 用法：
 *   node --experimental-strip-types tools/list-windows.ts            # 只看可见且有标题的
 *   node --experimental-strip-types tools/list-windows.ts --all      # 连隐藏/无标题也列出
 */
import { execFileSync } from 'node:child_process';

const all = process.argv.includes('--all');

/* PowerShell 源码里用单引号字符串拼装，避免 $ 与引号被外层 shell 吃掉 */
const script = `
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
'@
$rows = New-Object System.Collections.ArrayList
$cb = [W.U+EnumWindowsProc]{
  param($h, $l)
  $len = [W.U]::GetWindowTextLengthW($h)
  $vis = [W.U]::IsWindowVisible($h)
  if ($len -gt 0 -or $all) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][W.U]::GetWindowTextW($h, $sb, 512)
    $pid2 = 0
    [void][W.U]::GetWindowThreadProcessId($h, [ref]$pid2)
    $proc = (Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName
    [void]$rows.Add([pscustomobject]@{ Title = $sb.ToString(); Proc = $proc; Visible = $vis })
  }
  return $true
}
[void][W.U]::EnumWindows($cb, [IntPtr]::Zero)
$fg = [W.U]::GetForegroundWindow()
$fgPid = 0
[void][W.U]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$fgProc = (Get-Process -Id $fgPid -ErrorAction SilentlyContinue).ProcessName
Write-Output "FOREGROUND=$fgProc"
foreach ($r in $rows) {
  if (-not $all -and (-not $r.Visible -or [string]::IsNullOrWhiteSpace($r.Title))) { continue }
  Write-Output ("W|" + $r.Proc + "|" + $r.Visible + "|" + $r.Title)
}
`;
const b64 = Buffer.from(script, 'utf16le').toString('base64');
const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { encoding: 'utf8' });

const lines = out.split(/\r?\n/).map((s) => s.trimEnd()).filter(Boolean);
console.log('='.repeat(96));
console.log('当前可见顶层窗口');
console.log('='.repeat(96));
let n = 0;
for (const l of lines) {
  if (l.startsWith('FOREGROUND=')) {
    console.log(`  前台窗口属于：${l.slice('FOREGROUND='.length)}`);
    console.log('');
    continue;
  }
  if (!l.startsWith('W|')) continue;
  const [, proc, vis, ...rest] = l.split('|');
  const title = rest.join('|');
  n++;
  console.log(`  ${vis === 'True' ? '[可见]' : '[隐藏]'} ${String(proc).padEnd(16)} ${title.slice(0, 70)}`);
}
console.log('');
console.log(`  共 ${n} 个窗口`);
console.log('');
