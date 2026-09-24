/**
 * 重启本项目的常驻服务（`node src/cli.ts run`），并把 UI 需要的地址打出来。
 *
 * 为什么需要脚本：Windows 上"杀端口占用者 → 起新进程 → 等它就绪 → 探活"这一串
 * 在 PowerShell 里很容易因为引号/编码踩坑（本项目已多次遇到），落成文件更稳。
 *
 * 安全性说明：重启**不会**重置"自动处理基线" —— `Trigger` 构造函数里明确
 * "已存在时绝不能重置，否则每次重启都把起点往后推，新录播永远等不到"
 * （见 src/trigger.ts:157）。所以重启不会让已录制的场次被跳过。
 *
 * ★ 但它**会打断正在跑的任务**，这一点必须自己防住（实测栽过两次）：
 *   2026-09-24 凌晨连着两次在 `queue.busy = true` 时重启，把场次打断在
 *   `ANALYZING` / `CLIPPING`，事后都要手工 `POST /api/task/:id/retry` 续跑。
 *   转写有缓存所以没重复花钱，但如果断在**投稿**那一步就不好说。
 *   所以现在默认会先查 `/api/monitor` 的 `queue.busy`：忙就**拒绝重启**并打印在跑什么，
 *   要用 `--force` 才跳过这道闸（确实需要打断时再显式说）。
 *
 * 用法：node --experimental-strip-types tools/restart-service.ts [--port 3000] [--timeout 90] [--force]
 */
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (f: string, d: string): string => {
  const i = argv.indexOf(f);
  return i >= 0 ? (argv[i + 1] ?? d) : d;
};
const port = Number(argOf('--port', '3000'));
const timeoutSec = Number(argOf('--timeout', '90'));
const force = argv.includes('--force');
const ROOT = process.cwd();
const line = (s = ''): void => console.log(s);

line('='.repeat(84));
line(`重启本项目服务（端口 ${port}）`);
line('='.repeat(84));

/* ---- 0) 先问它忙不忙：忙就拒绝，别把正在跑的任务打断 ----
 * 为什么放在最前面：一旦 kill 就已经来不及了。宁可让调用方多跑一次 `--force`，
 * 也不要静默地把一场直播的处理打断（实测已经因此手工续跑过两次）。 */
async function busyCheck(): Promise<void> {
  let data: { queue?: { busy?: boolean; length?: number }; pipeline?: Array<Record<string, unknown>> };
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/monitor`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return; // 老版本可能没有这个接口 —— 探不通就不拦，交给下面正常流程
    data = (await r.json()) as typeof data;
  } catch {
    return; // 服务没起 / 探不通：本来就没东西可打断
  }
  const busy = data.queue?.busy === true || (data.queue?.length ?? 0) > 0;
  if (!busy) return;

  line('');
  line('  \x1b[33m服务正在处理任务，重启会把它打断。\x1b[0m');
  for (const p of data.pipeline ?? []) {
    line(`    · ${String(p['id'] ?? '?')}  ${String(p['statusText'] ?? p['status'] ?? '')}  ${String(p['title'] ?? '').slice(0, 30)}`);
  }
  line('  队列长度：' + String(data.queue?.length ?? 0));
  if (force) {
    line('  \x1b[33m--force 已给出，继续重启。\x1b[0m');
    line('');
    return;
  }
  line('');
  line('  等它跑完再重启；确实要打断就加 --force，打断后记得续跑：');
  line('    POST /api/task/<taskId>/retry  { "fromStage": "<它当前的阶段>" }');
  line('');
  process.exit(3);
}
await busyCheck();

/* ---- 0b) 先清场：launcher.ps1 会**杀掉我们自己** ----
 *
 * 实测（2026-09-24 15:1x）：直接杀旧 node 之后，launcher.ps1 立刻进入它的 finally：
 *     Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
 *       Where-Object { $_.CommandLine -like "*$ROOT*" } | Stop-Process -Force
 * 这条按命令行**子串**匹配，于是连"从项目目录里跑的 `node tools/restart-service.ts`"
 * 一起杀了 —— 表现是脚本中途消失（job runner exit 4294967295），
 * 服务被杀掉、新进程根本没起来。所以顺序必须是：**先请启动器退场，再动服务**。
 *
 * 启动器是被 taskkill 掉的，它自己的 finally 不会执行（这正是我们要的）。
 * 因此它也不会去收它的 node 子进程 —— 那正是下面第 1 步要杀的旧服务。 */
function launcherPids(): string[] {
  try {
    return execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*launcher.ps1*' } | ForEach-Object { $_.ProcessId }",
      ],
      { encoding: 'utf8' },
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return []; // 查不到就当没有（不能因为查询失败把重启卡住）
  }
}
const countLaunchers = (): number => launcherPids().length;
function killLaunchers(): number {
  const pids = launcherPids();
  for (const pid of pids) {
    try {
      execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
    } catch {
      /* 已经退了 */
    }
  }
  return pids.length;
}
const killed = killLaunchers();
if (killed > 0) line(`  先请 ${killed} 个 launcher.ps1 退场（否则它会在收尾时把我们和新服务一起杀掉）`);

/* ---- 1) 找到占用端口的进程并结束 ---- */
function findPidOnPort(p: number): number | undefined {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
      ],
      { encoding: 'utf8' },
    ).trim();
    const pid = Number(out);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

const oldPid = findPidOnPort(port);
if (oldPid) {
  line(`  旧进程 pid=${oldPid}，正在结束…`);
  try {
    execFileSync('taskkill', ['/PID', String(oldPid), '/F', '/T'], { stdio: 'ignore' });
    line('  ✓ 已结束');
  } catch (e) {
    line(`  ⚠ 结束失败（可能已自行退出）：${(e as Error).message.slice(0, 80)}`);
  }
  /* 等端口真正释放，否则新进程 listen 会 EADDRINUSE */
  for (let i = 0; i < 20; i++) {
    if (!findPidOnPort(port)) break;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 400'], { stdio: 'ignore' });
  }
} else {
  line(`  端口 ${port} 当前空闲`);
}

/* ---- 1b) 起新进程前再确认一次没有启动器（第 0b 步杀过，但计划任务每分钟会再拉一个起来） ----
 *
 * 计划任务「直播切片助手（live_auto）」有 RestartCount=3 / 每分钟重试，
 * 我们用 taskkill 干掉启动器会被它当成"失败"，一分钟内可能再拉一个起来。
 * 万一那个新启动器刚好赶上"服务还没 listen"的窗口，它就会再起一个 node 抢 3000 端口。
 * 这里起新进程前扫一眼：还有启动器就先等它退（上限 6 秒），别把重启变成两个服务抢端口。 */
if (oldPid) {
  const n = countLaunchers();
  if (n > 0) {
    line(`  ⚠ 检测到 ${n} 个 launcher.ps1 又起来了 —— 等它退场再起服务（上限 6 秒）…`);
    for (let i = 0; i < 15; i++) {
      if (countLaunchers() === 0) break;
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 400'], { stdio: 'ignore' });
    }
    const after = countLaunchers();
    line(after === 0 ? '  ✓ 启动器已退场' : `  ⚠ 还有 ${after} 个（多半停在"按任意键关闭"上，没有 node 子进程，不影响）`);
  }
}

/* ---- 2) 起新进程（detached，独立于本脚本存活） ---- */
line('');
line('  启动新进程：node src/cli.ts run');
const child = spawn(process.execPath, [path.join(ROOT, 'src', 'cli.ts'), 'run'], {
  cwd: ROOT,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();
line(`  ✓ 已启动（pid=${String(child.pid)}）`);

/* ---- 3) 等就绪 + 探活 ---- */
line('');
line('  等待服务就绪…');
const base = `http://127.0.0.1:${port}`;
let ready = false;
const deadline = Date.now() + timeoutSec * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const res = await fetch(`${base}/api/health`);
    if (res.ok) {
      const j = (await res.json()) as { health?: Record<string, unknown> };
      const h = (j.health ?? j) as Record<string, unknown>;
      const mode = (h['mode'] ?? {}) as Record<string, unknown>;
      line(`  ✓ 服务就绪：${base}`);
      line('');
      line('  当前模式：');
      line(`    dryRun      = ${String(mode['dryRun'])}`);
      line(`    allowPaid   = ${String(mode['allowPaid'])}`);
      line(`    autoPublish = ${String(mode['autoPublish'])}`);
      line(`    isOnlySelf  = ${String(mode['isOnlySelf'])}`);
      const bl = (h['bililive'] ?? {}) as Record<string, unknown>;
      line(`    bililive.ok = ${String(bl['ok'])} (v${String(bl['version'])})`);
      ready = true;
      break;
    }
  } catch {
    /* 还没起来 */
  }
}
if (!ready) {
  line(`  ✗ ${timeoutSec}s 内没起来 —— 看 data/logs/ 下今天的日志确认原因`);
  process.exit(1);
}
line('');
line(`  界面：${base}/`);
line('');
