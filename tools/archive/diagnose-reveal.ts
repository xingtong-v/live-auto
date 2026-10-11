/**
 * 诊断"打开文件管理器"到底有没有真的把窗口带到用户面前。
 *
 * 背景（用户反馈）：试看弹窗显示「✓ 已在文件管理器中定位源文件」，但用户说"没有正确跳转"。
 * 关键区别：我的实现里 `revealed: true` 只代表 **spawn 命令发出成功**，
 * 不代表资源管理器窗口真的出现、更不代表它被**置于前台**。
 *
 * 已知的 Windows 行为（这才是真正的原因）：
 *   `explorer.exe` 是**单实例复用的外壳进程**：如果目标文件夹已经在某个资源管理器
 *   窗口里打开着，你再次"打开"它时，Windows **不会新建窗口**，而是激活那个已有窗口 ——
 *   而"激活"这一步在 Windows 10/11 上经常**只闪烁任务栏**、不把窗口提到前台
 *   （前台锁定策略）。用户看到的现象就是"点了没反应/没跳转"。
 *
 * 本脚本逐项验证，用**窗口列表的前后差异**作为客观判据（不靠感觉）：
 *   ① 记录当前所有 explorer 窗口标题
 *   ② 执行一次"打开目录"，再记录窗口标题
 *   ③ 报告：新增了哪些窗口 / 有没有被前置（用 GetForegroundWindow 的进程名判断）
 *
 * 用法：
 *   node --experimental-strip-types tools/diagnose-reveal.ts <要打开的目录或文件> [--method ps|psliteral|cmdstart|explorer|shell]
 */
import { execFileSync, spawnSync } from 'node:child_process';

const target = process.argv[2];
if (!target) {
  console.error('用法：node --experimental-strip-types tools/diagnose-reveal.ts <目录或文件> [--method ps|psliteral|cmdstart|explorer|shell]');
  process.exit(1);
}
const mi = process.argv.indexOf('--method');
const method = mi > 0 ? String(process.argv[mi + 1]) : 'ps';
const line = (s = ''): void => console.log(s);

/** 列出当前所有资源管理器窗口的标题（用 Shell.Application，无需额外依赖） */
function explorerWindows(): string[] {
  const ps = [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    // Shell.Application 的 Windows() 会列出所有已打开的文件夹窗口（含标题）
    '$sh = New-Object -ComObject Shell.Application; @($sh.Windows()) | ForEach-Object { try { $_.LocationName } catch { "" } }',
  ];
  try {
    const out = execFileSync('powershell.exe', ps, { encoding: 'utf8' });
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    line(`  ⚠ 枚举窗口失败：${(e as Error).message.slice(0, 80)}`);
    return [];
  }
}

/** 当前前台窗口属于哪个进程（用于判断窗口有没有被真的提到前面） */
function foregroundProcess(): string {
  const ps = [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Add-Type -Namespace W -Name U -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);\' -PassThru | Out-Null; $h=[W.U]::GetForegroundWindow(); $pid2=0; [W.U]::GetWindowThreadProcessId($h,[ref]$pid2) | Out-Null; (Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName',
  ];
  try {
    return execFileSync('powershell.exe', ps, { encoding: 'utf8', cwd: process.env['TEMP'] }).trim();
  } catch {
    return '(未知)';
  }
}

line('='.repeat(92));
line(`诊断「打开文件管理器」：${target}`);
line('='.repeat(92));
line(`  方法：${method}`);

const before = explorerWindows();
line(`  ① 执行前已有 ${before.length} 个资源管理器窗口：`);
for (const w of before.slice(0, 12)) line(`      · ${w}`);

line('');
line('  ② 执行打开…');
const t0 = Date.now();
let how = '';
try {
  if (method === 'ps') {
    /* 当前实现走的就是这条 */
    how = `Start-Process explorer.exe -ArgumentList '/select,"${target}"'`;
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process', 'explorer.exe', '-ArgumentList', `/select,"${target}"`], { stdio: 'ignore' });
  } else if (method === 'psliteral') {
    /* 打开目录（不选中文件）时用的那条 */
    how = `Start-Process -LiteralPath "${target}"`;
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process', '-LiteralPath', target], { stdio: 'ignore' });
  } else if (method === 'cmdstart') {
    how = `cmd /c start "" "${target}"`;
    spawnSync('cmd.exe', ['/c', 'start', '', target], { stdio: 'ignore' });
  } else if (method === 'explorer') {
    how = `explorer.exe "/select,${target}"`;
    spawnSync('explorer.exe', [`/select,${target}`], { stdio: 'ignore' });
  } else if (method === 'shell') {
    how = `Shell.Application.Explore("${target}")` + (target.includes('.') ? '（GoTo）' : '');
    const psCmd = target.includes('.')
      ? `$sh=New-Object -ComObject Shell.Application; $sh.Explore("${target}")`
      : `$sh=New-Object -ComObject Shell.Application; $sh.Explore("${target}")`;
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { stdio: 'ignore' });
  } else {
    line(`  未知方法：${method}`);
    process.exit(1);
  }
  line(`     ${how}`);
} catch (e) {
  line(`     ✗ 执行抛错：${(e as Error).message.slice(0, 100)}`);
}
line(`     执行耗时 ${Date.now() - t0} ms`);

/* 给资源管理器一点时间把窗口建出来 */
await new Promise((r) => setTimeout(r, 2500));

const after = explorerWindows();
line('');
line(`  ③ 执行后共 ${after.length} 个资源管理器窗口：`);
for (const w of after.slice(0, 16)) line(`      · ${w}`);
const added = after.filter((w) => !before.includes(w));
line('');
line(`  ④ 判定：${added.length > 0 ? `\x1b[32m新增 ${added.length} 个窗口\x1b[0m → ${added.join(' / ')}` : '\x1b[33m窗口数没有变化\x1b[0m'}`);
line(`     前台进程：${foregroundProcess()}`);
line('');
line('  ⑤ 结论提示：');
if (added.length === 0) {
  line('     · 没有新窗口 ⇒ 目标目录**已经在某个窗口里打开着**（explorer 复用旧窗口），');
  line('       或该命令没有生效。前者是 Windows 的既定行为，不是 bug；');
  line('       但这正是用户"点了没跳转"的来源 —— 旧窗口没有被提到前台。');
} else {
  line('     · 有新窗口 ⇒ 命令生效。若用户仍觉得"没跳转"，那是**新窗口没被前置**，');
  line('       同样需要主动激活窗口才能让人看到。');
}
line('');
