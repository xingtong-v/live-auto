/**
 * 把标题匹配的窗口提到前台（用于验证/修正"打开文件管理器后窗口被浏览器挡住"）。
 *
 * 背景：`explorer.exe` 打开目录后，窗口确实建出来了，但它出现在浏览器**后面** ——
 * 用户看到的现象就是"跳转了但看不见"。这不是打开失败，是窗口层级问题。
 *
 * 关键教训（第一版为什么没用）：我凭印象写了 `$w.Activate()`，
 * 实测直接报 `Method invocation failed ... does not contain a method named 'Activate'`。
 * `Shell.Application.Windows()` 返回的不是可 Activate 的对象。正确做法是拿它的 `HWND`，
 * 再用 user32 的 `ShowWindow(SW_RESTORE)` + `SetForegroundWindow`（必要时配合
 * `AttachThreadInput` 绕过前台锁定）。
 *
 * 用法：
 *   node --experimental-strip-types tools/focus-window.ts <标题匹配串> [--exact]
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const needle = args.find((a) => !a.startsWith('--'));
if (!needle) {
  console.error('用法：node --experimental-strip-types tools/focus-window.ts <标题匹配串> [--exact]');
  process.exit(1);
}
const exact = args.includes('--exact');
const safe = needle.replace(/'/g, "''");

/* 用 -EncodedCommand（base64 / UTF-16LE）传脚本：本项目里 PowerShell 反复吃过
   引号与 `$` 的亏，编码传递是唯一稳的方式。 */
const script = `
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
'@
$sh = New-Object -ComObject Shell.Application
$all = @($sh.Windows())
$target = $null
foreach ($w in $all) {
  $n = ''
  try { $n = [string]$w.LocationName } catch { continue }
  if (${exact ? "$n -eq '" + safe + "'" : "$n -like '*" + safe + "*'"}) { $target = $w; break }
}
if (-not $target) { Write-Output 'NOTFOUND'; exit }
$raw = [IntPtr]$target.HWND
$top = [W.U]::GetAncestor($raw, 2)
if ($top -eq [IntPtr]::Zero) { $top = $raw }
[void][W.U]::ShowWindow($top, 9)

# ① 先把 z-order 提到最上（不受前台锁定限制，但不会给键盘焦点）
$HWND_TOP = [IntPtr]::Zero
$SWP_NOMOVE = 0x0002; $SWP_NOSIZE = 0x0001; $SWP_SHOWWINDOW = 0x0040
[void][W.U]::SetWindowPos($top, $HWND_TOP, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW))
[void][W.U]::BringWindowToTop($top)

# ② 再抢前台。SetForegroundWindow 会被"前台锁定"拒绝（实测返回 False），
#    标准解锁法是先模拟一次 ALT 键（用户点按钮时本来就在跟本应用交互，无副作用），
#    再 AttachThreadInput 到当前前台线程后调用。
[W.U]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[W.U]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 30

$fg = [W.U]::GetForegroundWindow()
$fgTid = 0
[void][W.U]::GetWindowThreadProcessId($fg, [ref]$fgTid)
$myTid = [W.U]::GetCurrentThreadId()
$attached = $false
if ($fgTid -ne $myTid) { $attached = [W.U]::AttachThreadInput($myTid, [uint32]$fgTid, $true) }
$r = [W.U]::SetForegroundWindow($top)
if ($attached) { [void][W.U]::AttachThreadInput($myTid, [uint32]$fgTid, $false) }
Start-Sleep -Milliseconds 300
$now = [W.U]::GetForegroundWindow()
$nowPid = 0
[void][W.U]::GetWindowThreadProcessId($now, [ref]$nowPid)
$nowProc = (Get-Process -Id $nowPid -ErrorAction SilentlyContinue).ProcessName
Write-Output ("FOUND|" + $top + "|" + $r + "|" + $nowProc)
`;
try {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', cwd: process.env['TEMP'] },
  ).trim();
  if (out === 'NOTFOUND') {
    console.log(`没有找到标题匹配「${needle}」的资源管理器窗口`);
    process.exit(2);
  }
  const [tag, hwnd, ok, nowProc] = out.split('|');
  console.log(`找到窗口：HWND=${hwnd}`);
  console.log(`SetForegroundWindow 返回：${ok}`);
  console.log(`现在前台进程：${nowProc}`);
  console.log(nowProc === 'explorer' ? '✓ 已提到前台' : '⚠ 前台不是 explorer（可能被系统前台锁定拒绝）');
} catch (e) {
  console.error(`执行失败：${(e as Error).message.slice(0, 200)}`);
  process.exit(1);
}
