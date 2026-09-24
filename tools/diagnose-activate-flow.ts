/**
 * 复刻服务的「打开 + 激活」流程并捕获 PowerShell 输出，定位激活为何没生效。
 *
 * 为什么要单独做：`tools/diagnose-activate.ts`（spawnSync + 已存在的窗口）能成功，
 * 但服务（关窗口 → spawn explorer 打开 → 立刻 detached spawn powershell 激活）失败。
 * 差异只可能在"窗口刚创建、可能还没就绪"和"detached spawn"这两点上，
 * 所以这里**完全复刻服务的调用序列**，并把 PowerShell 的 stdout/stderr 打出来。
 *
 * 用法：node --experimental-strip-types tools/diagnose-activate-flow.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';

const line = (s = ''): void => console.log(s);
const WANT = '丙主播';
const FILE = 'C:\\Users\\demo\\Downloads\\Bilibili\\丙主播\\2026-09-23 21-53-17-917 哈喽.flv';

function foreground(): string {
  const ps = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);' -PassThru | Out-Null; $h=[W.U]::GetForegroundWindow(); $p=0; [void][W.U]::GetWindowThreadProcessId($h,[ref]$p); (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName`;
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8' }).trim();
  } catch {
    return '(取不到)';
  }
}

/** 与服务里 activateExplorerWindow 完全一致的脚本（带诊断输出） */
function buildScript(needle: string): string {
  const safe = needle.replace(/'/g, "''");
  return (
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
    `$t = $null; $tries = 0; ` +
    `for ($i = 0; $i -lt 20 -and -not $t; $i++) { ` +
    `  Start-Sleep -Milliseconds 300; $tries++; ` +
    `  $sh = New-Object -ComObject Shell.Application; ` +
    `  foreach ($w in @($sh.Windows())) { ` +
    `    $n=''; try { $n=[string]$w.LocationName } catch { continue }; ` +
    `    if ($n -eq '${safe}' -or $n -like '*${safe}*') { $t = $w; break } ` +
    `  } ` +
    `}; ` +
    `Write-Output ('tries=' + $tries + ' found=' + [bool]$t); ` +
    `if (-not $t) { Write-Output 'GIVEUP'; exit }; ` +
    `$top = [W.U]::GetAncestor([IntPtr]$t.HWND, 2); if ($top -eq [IntPtr]::Zero) { $top = [IntPtr]$t.HWND }; ` +
    `Write-Output ('top=' + $top); ` +
    `[void][W.U]::ShowWindow($top, 9); ` +
    `Write-Output ('SetWindowPos=' + [W.U]::SetWindowPos($top, [IntPtr]::Zero, 0,0,0,0, 0x0043)); ` +
    `[void][W.U]::BringWindowToTop($top); ` +
    `[W.U]::keybd_event(0x12,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [W.U]::keybd_event(0x12,0,2,[UIntPtr]::Zero); ` +
    `Start-Sleep -Milliseconds 60; ` +
    `$fg = [W.U]::GetForegroundWindow(); $tid = 0; [void][W.U]::GetWindowThreadProcessId($fg, [ref]$tid); ` +
    `$my = [W.U]::GetCurrentThreadId(); $att = $false; ` +
    `if ($tid -ne $my) { $att = [W.U]::AttachThreadInput($my, [uint32]$tid, $true) }; ` +
    `Write-Output ('attach=' + $att); ` +
    `Write-Output ('SetForegroundWindow=' + [W.U]::SetForegroundWindow($top)); ` +
    `if ($att) { [void][W.U]::AttachThreadInput($my, [uint32]$tid, $false) }`
  );
}

line('='.repeat(90));
line('复刻服务流程：关窗口 → spawn explorer → 立刻 detached spawn powershell 激活');
line('='.repeat(90));
line(`  初始前台：${foreground()}`);

/* 1) 关掉已有窗口，保证是"新建"场景 */
try {
  execFileSync('node', ['--experimental-strip-types', 'tools/close-explorer-windows.ts', WANT], { stdio: 'ignore' });
} catch {
  /* ignore */
}
await new Promise((r) => setTimeout(r, 2000));
line(`  关窗口后前台：${foreground()}`);

/* 2) 复刻服务的：spawn explorer（detached） */
line('');
line('  ① spawn explorer.exe /select,…（detached + unref）');
const e = spawn('explorer.exe', ['/select,', FILE], { detached: true, stdio: 'ignore' });
e.unref();

/* 3) 复刻服务的：立刻 detached spawn powershell 激活（不等待、无输出捕获） */
line('  ② 立刻 detached spawn powershell 激活（服务的方式，stdout 丢弃）');
const detachedScript = buildScript(WANT);
const p1 = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(detachedScript, 'utf16le').toString('base64')], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
p1.unref();
await new Promise((r) => setTimeout(r, 9000));
line(`     9 秒后前台：${foreground()}`);

/* 4) 同样脚本用 spawnSync 跑一次，捕获输出 —— 看究竟哪一步失败 */
line('');
line('  ③ 同样脚本改用 spawnSync（捕获 stdout）再跑一次');
const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(detachedScript, 'utf16le').toString('base64')], {
  encoding: 'utf8',
  cwd: process.env['TEMP'],
});
for (const l of (r.stdout ?? '').split(/\r?\n/).filter(Boolean)) line(`     ${l}`);
line(`     退出码 ${String(r.status)}`);
await new Promise((r2) => setTimeout(r2, 1500));
line(`     之后前台：${foreground()}`);
line('');
line('  解读：');
line('   · 若③成功而②失败 ⇒ 问题在 detached spawn（无控制台/会话差异），');
line('     应改为普通 spawn 或把激活放进 explorer 同一条命令链里。');
line('   · 若两者都成功而前台仍不是 explorer ⇒ 是**前台锁定**：');
line('     ALT 解锁只在"调用进程自己就在前台"时稳定有效，');
line('     后台服务（node）抢焦点的能力受系统策略限制。');
line('');
