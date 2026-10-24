/**
 * 代码热更新监督进程（`src/hot-watch.ts`）回归套件 —— 全离线、零费用、不碰真实服务。
 *
 * 为什么要这一套：用户的原话是「每次更新和修bug后 都要手动关闭重新启动 能不能热更新 不需要关闭」。
 * 这件事最容易出错的不是"重启"本身，而是**什么时候不该重启**：
 *   · 代码编不过时重启 ⇒ 把「代码没生效」变成「服务起不来」（用户更懵）；
 *   · 有任务在跑时重启 ⇒ 把切片/投稿打断在中间（历史上已因此手工续跑过两次）；
 *   · 连续保存多次 ⇒ 重启风暴。
 * 所以本套件把这三条边界都钉住，而不是只测"改文件会重启"。
 *
 * 结构：
 *   一、纯函数单测（忙判定 / 重载决策 / 退避 / 原因格式化 / 忽略规则 / 错误摘要 / 状态原子读写）；
 *   二、hermetic 集成用例：**临时目录**里起一个假的"服务"（.mjs，收到 IPC shutdown 就退出），
 *       真实的监督进程去监听临时目录里的 `src/` 与 `web/src/`，走完
 *       「改文件 → typecheck 通过 → 空闲 → 重载 → 新 pid」以及
 *       「typecheck 失败不重启」「忙时排队、空闲后自动重载」「改前端只构建不重启」四个分支。
 *       全程不连 3000 端口、不读写真实 `data/`（状态/日志/台账都指向临时目录）。
 *
 * 用法：node test/hot-watch.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  HotWatcher,
  attachCrashGuards,
  classifyChange,
  computeBusy,
  decideReload,
  emptyState,
  formatReloadReason,
  isBusyStatuses,
  isIgnoredPath,
  isStateAlive,
  nextBackoff,
  parseHealthPid,
  readState,
  stateFilePath,
  summarizeError,
  writeState,
} from '../src/hot-watch.ts';
import { ROOT_DIR } from '../src/util.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(detail ? `${name} :: ${detail}` : name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq<T>(name: string, actual: T, expected: T): void {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 取一个空闲端口（listen 0 → 拿端口 → 关掉）：假服务要真监听，写死端口容易撞 */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
}

/* ============================================================================
 * 一、纯函数
 * ========================================================================== */

section('忙判定：哪些状态算「正在干活」');
ok('TRANSCRIBING 算忙', isBusyStatuses(['TRANSCRIBING']));
ok('ANALYZING 算忙', isBusyStatuses(['ANALYZING']));
ok('CLIPPING 算忙', isBusyStatuses(['CLIPPING']));
ok('PUBLISHING 算忙', isBusyStatuses(['PUBLISHING']));
ok('PENDING 算忙（已入队还没开始）', isBusyStatuses(['PENDING']));
ok('切片级 CUTTING 算忙', isBusyStatuses(['CUTTING']));
ok('切片级 SUBMITTING 算忙', isBusyStatuses(['SUBMITTING']));
ok('ANALYZED 不忙（等确认，重启不丢东西）', !isBusyStatuses(['ANALYZED']));
ok('PUBLISHED 不忙', !isBusyStatuses(['PUBLISHED']));
ok('CLIPPED 不忙（等投稿，启动恢复会接手）', !isBusyStatuses(['CLIPPED']));
ok('空列表不忙', !isBusyStatuses([]));
eq('混合列表只要有忙的就忙', isBusyStatuses(['ANALYZED', 'CUTTING']), true);

section('从 ledger.json 原始 JSON 算忙碌（兼容两种 tasks 形状）');
eq(
  '空闲台账',
  computeBusy({ tasks: { a: { status: 'ANALYZED', clips: [] }, b: { status: 'PUBLISHED' } } }).busy,
  false,
);
{
  const snap = computeBusy({ tasks: { a: { status: 'TRANSCRIBING' }, b: { status: 'ANALYZED' } } });
  eq('场级忙', snap.busy, true);
  eq('原因记录到场级状态', snap.reasons, ['TRANSCRIBING']);
  eq('任务计数', snap.taskCount, 2);
}
{
  /* 场级已经是 CLIPPED（静止），但某个切片还在切 —— 必须算忙 */
  const snap = computeBusy({ tasks: { a: { status: 'CLIPPED', clips: [{ status: 'CUT' }, { status: 'CUTTING' }] } } });
  eq('切片级忙（场级静止也算）', snap.busy, true);
  eq('原因记录到切片级状态', snap.reasons, ['CUTTING']);
}
eq('数组形状兼容', computeBusy({ tasks: [{ status: 'PUBLISHING' }] }).busy, true);
eq('空对象', computeBusy({}).busy, false);
eq('null 台账', computeBusy(null).busy, false);
eq('坏形状不抛', computeBusy({ tasks: 'oops' }).busy, false);

section('重载决策（先类型检查、再判忙）');
eq('类型检查失败 ⇒ 不重启', decideReload({ typecheckOk: false, busy: false }), 'blocked');
eq('类型检查失败且忙 ⇒ 仍然是不重启（不排队）', decideReload({ typecheckOk: false, busy: true }), 'blocked');
eq('检查通过但忙 ⇒ 等空闲', decideReload({ typecheckOk: true, busy: true }), 'wait');
eq('检查通过且空闲 ⇒ 重启', decideReload({ typecheckOk: true, busy: false }), 'reload');

section('重载原因格式化');
eq('单个文件', formatReloadReason(['src/api.ts']), 'src/api.ts');
eq('多个文件用顿号', formatReloadReason(['src/a.ts', 'src/b.ts']), 'src/a.ts、src/b.ts');
eq('太多文件只列前几个', formatReloadReason(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']), 'a、b、c、d、e、f 等 8 个文件');
eq('空列表有兜底文案', formatReloadReason([]), '（未记录到具体文件）');
eq('忽略空白项', formatReloadReason(['', '  ', 'src/a.ts']), 'src/a.ts');

section('崩溃退避阶梯 2s→5s→10s→30s（封顶）');
eq('首次 2s', nextBackoff(0), 2000);
eq('2s→5s', nextBackoff(2000), 5000);
eq('5s→10s', nextBackoff(5000), 10000);
eq('10s→30s', nextBackoff(10000), 30000);
eq('30s 封顶', nextBackoff(30000), 30000);
eq('异常输入退回 2s', nextBackoff(Number.NaN), 2000);
eq('负数退回 2s', nextBackoff(-5), 2000);

section('忽略规则与变化分类');
ok('node_modules 里的产物不触发', isIgnoredPath('node_modules/zod/index.ts'));
ok('.git 不触发', isIgnoredPath('.git/index'));
ok('编辑器临时文件不触发', isIgnoredPath('src/api.ts.tmp'));
ok('备份文件不触发', isIgnoredPath('src/api.ts~'));
ok('隐藏文件不触发', isIgnoredPath('.DS_Store'));
ok('源码要触发', !isIgnoredPath('src/api.ts'));
eq('后端 .ts', classifyChange('src/api.ts'), 'backend');
eq('后端里的 .js 不算（产物/脚本）', classifyChange('src/api.js'), null);
eq('前端 .js', classifyChange('web/src/33-数据加载.js'), 'ui');
eq('前端 .css', classifyChange('web/src/10-style.css'), 'ui');
eq('前端 .html', classifyChange('web/src/20-shell-body.html'), 'ui');
eq('前端里的 .ts 不算', classifyChange('web/src/x.ts'), null);
eq('config.json 不触发（改配置走接口，重启不是它的语义）', classifyChange('config.json'), null);
eq('根目录文档不触发', classifyChange('README.md'), null);

section('错误摘要（面板/日志要的是"最后几行"而不是整个 tsc 输出）');
eq('去 ANSI 取尾部', summarizeError('\x1b[31merror TS2322\x1b[0m\n  line 1\n  line 2'), 'error TS2322\n  line 1\n  line 2');
eq('空输出有兜底', summarizeError('   \n\n'), '（命令失败但没有输出）');
ok('超长输出被截断到最后 2 行', summarizeError('a\nb\nc\nd', 2) === 'c\nd');

section('就绪探测：能不能认出"端口上应答的是谁"');
eq('取 health.pid', parseHealthPid({ health: { pid: 1234 } }), 1234);
eq('兼容顶层 pid', parseHealthPid({ pid: 7 }), 7);
eq('老版本服务没有 pid ⇒ null（按"无法核对"通过，不判失败）', parseHealthPid({ health: {} }), null);
eq('0 视为无效', parseHealthPid({ health: { pid: 0 } }), null);
eq('非对象不抛', parseHealthPid('oops'), null);
eq('null 不抛', parseHealthPid(null), null);

section('状态文件：原子读写 + 心跳判活');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hot-state-'));
  const p = path.join(tmp, 'hot-watch-state.json');
  eq('不存在时返回 null', readState(p), null);
  const st = { ...emptyState(3000), enabled: true, pid: 4321, reloads: 2, heartbeatAt: new Date().toISOString() };
  writeState(p, st);
  const back = readState(p);
  eq('写进去读出来一致', back?.pid, 4321);
  eq('enabled 保留', back?.enabled, true);
  eq('reloads 保留', back?.reloads, 2);
  fs.writeFileSync(p, '{ 半截 JSON', 'utf8');
  eq('读坏不抛、退化成 null', readState(p), null);
  eq('心跳新鲜 ⇒ 活着', isStateAlive(st), true);
  eq(
    '心跳过期 ⇒ 视为已关闭（被强杀时来不及写 enabled=false）',
    isStateAlive({ ...st, heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() }),
    false,
  );
  eq('enabled=false ⇒ 关闭', isStateAlive({ ...st, enabled: false }), false);
  eq('null ⇒ 关闭', isStateAlive(null), false);
  /* 状态文件默认位置必须落在 data/ 下（健康面板按同一个函数读，不能两边各算一遍） */
  eq('默认状态文件路径', stateFilePath(ROOT_DIR), path.join(ROOT_DIR, 'data', 'hot-watch-state.json'));
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ============================================================================
 * 二、hermetic 集成用例（临时目录 + 假服务）
 * ========================================================================== */

/** 轮询等待条件成立；超时返回 null（不抛，让断言给出可读的失败信息） */
async function waitFor<T>(label: string, fn: () => T | null | undefined | false, timeoutMs = 25_000, intervalMs = 100): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v as T;
    await sleep(intervalMs);
  }
  console.log(`    \x1b[33m（等待超时：${label}）\x1b[0m`);
  return null;
}

const readLines = (p: string): string[] => {
  try {
    return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
};

const FAKE_SERVICE = `import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const cwd = process.cwd();
const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const port = portIdx >= 0 ? Number(argv[portIdx + 1]) : 0;

/* 每次启动记一行 pid：测试据此数"到底重启了几次" */
fs.appendFileSync(path.join(cwd, 'starts.log'), String(process.pid) + '\\n');

/* 故障注入：存在 die-on-start ⇒ 这次启动必定失败（用来验证"起不来不算重载成功"） */
if (fs.existsSync(path.join(cwd, 'die-on-start'))) {
  process.exit(4);
}

/* 真监听端口并应答 /api/bootstrap —— 监督进程的"就绪"判定是**真发 HTTP 请求**，
   假服务必须能应答，否则测的就只是"进程活着"而不是"服务起来了"。 */
const server = http.createServer((req, res) => {
  if (req.url === '/api/bootstrap') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  /* 就绪探测会再问一次 /api/health 核对"应答者是不是刚拉起的那个子进程" */
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ health: { pid: process.pid, version: 'fake' } }));
    return;
  }
  res.writeHead(404);
  res.end();
});

function listen(attempt) {
  server.once('error', (e) => {
    /* 上一个进程刚释放端口，Windows 上偶尔还会短暂 EADDRINUSE：重试几次（这是真实场景，不是假失败） */
    if (e && e.code === 'EADDRINUSE' && attempt < 15) {
      setTimeout(() => listen(attempt + 1), 150);
      return;
    }
    fs.appendFileSync(path.join(cwd, 'bind-fail.log'), String(process.pid) + ' ' + String(e && e.code) + '\\n');
    process.exit(3);
  });
  server.listen(port, '127.0.0.1', () => {
    fs.appendFileSync(path.join(cwd, 'listening.log'), String(process.pid) + '\\n');
  });
}
listen(0);

/* 收到监督进程的 IPC shutdown 就优雅退出，并留一行证据（证明走的是 IPC 而不是硬杀） */
process.on('message', (m) => {
  if (m && m.type === 'shutdown') {
    fs.appendFileSync(path.join(cwd, 'stops.log'), String(process.pid) + '\\n');
    try { server.close(); } catch (e) { /* ignore */ }
    process.exit(0);
  }
});
`;

const TYPECHECK = `import fs from 'node:fs';
/* 每次被调用记一行：用来断言"忙时轮询没有反复重跑类型检查"（Bug 2 回归） */
fs.appendFileSync('tc.log', '1\\n');
/* 由测试通过"存在 fail-typecheck 文件"来切换类型检查结果 */
if (fs.existsSync('fail-typecheck')) {
  console.error('src/fake.ts(1,1): error TS2322: 类型不匹配（测试故意失败）');
  process.exit(1);
}
/* "检查窗口内崩溃"的竞态用例需要让类型检查慢下来：tc-delay 里写毫秒数 */
if (fs.existsSync('tc-delay')) {
  const ms = Number(fs.readFileSync('tc-delay', 'utf8').trim()) || 0;
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
process.exit(0);
`;

const BUILD = `import fs from 'node:fs';
fs.appendFileSync('builds.log', '1\\n');
if (fs.existsSync('fail-build')) {
  console.error('build failed（测试故意失败）');
  process.exit(1);
}
process.exit(0);
`;

async function integration(): Promise<void> {
  section('集成用例：真实监督进程 + 假服务（临时目录，不碰 3000 / 真实 data）');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hot-watch-'));
  const srcDir = path.join(tmp, 'src');
  const webSrcDir = path.join(tmp, 'web', 'src');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(webSrcDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'fake.ts'), 'export const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(webSrcDir, '30-x.js'), 'const x = 1;\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'fake-service.mjs'), FAKE_SERVICE, 'utf8');
  fs.writeFileSync(path.join(tmp, 'typecheck.mjs'), TYPECHECK, 'utf8');
  fs.writeFileSync(path.join(tmp, 'build.mjs'), BUILD, 'utf8');
  const ledgerPath = path.join(dataDir, 'ledger.json');
  const statePath = path.join(dataDir, 'hot-watch-state.json');
  const logPath = path.join(dataDir, 'logs', 'hot-watch.log');
  const writeLedger = (tasks: Record<string, unknown>): void => {
    fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), tasks }), 'utf8');
  };
  writeLedger({});

  /* 端口必须动态取一个空闲的：假服务要真监听并应答 /api/bootstrap（监督进程的就绪判定是真的发请求），
     写死端口在 CI/并行时容易撞。 */
  const servicePort = await freePort();

  const watcher: ChildProcess = spawn(
    process.execPath,
    [
      path.join(ROOT_DIR, 'src', 'hot-watch.ts'),
      '--port',
      String(servicePort),
      '--root',
      tmp,
      '--entry',
      'fake-service.mjs',
      '--state',
      statePath,
      '--log',
      logPath,
      '--ledger',
      ledgerPath,
      '--typecheck',
      'node typecheck.mjs',
      '--build-ui',
      'node build.mjs',
      '--debounce',
      '120',
      '--busy-poll',
      '150',
      '--graceful-ms',
      '4000',
      '--term-ms',
      '6000',
      '--ready-timeout',
      '20000',
      '--ready-grace',
      '2500',
    ],
    { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let watchOut = '';
  watcher.stdout?.on('data', (d: Buffer) => {
    watchOut += d.toString();
  });
  watcher.stderr?.on('data', (d: Buffer) => {
    watchOut += d.toString();
  });

  const starts = (): string[] => readLines(path.join(tmp, 'starts.log'));
  const stops = (): string[] => readLines(path.join(tmp, 'stops.log'));
  const state = (): ReturnType<typeof readState> => readState(statePath);

  try {
    /* ---- ① 首次启动 ---- */
    const st0 = await waitFor('监督进程拉起服务', () => {
      const s = state();
      return s && s.enabled && s.pid ? s : null;
    });
    ok('监督进程启动后状态文件出现且带 pid', st0 !== null, watchOut.slice(-800));
    const pid0 = st0?.pid ?? null;
    /* 状态文件里的 pid 是监督进程 spawn 之后立刻写的；子进程自己写 starts.log 可能晚几毫秒，
       所以这里等它落盘再断言（否则会偶发假失败）。 */
    const firstStart = await waitFor('假服务写下第一行 starts.log', () => starts().length >= 1);
    ok('假服务已启动一次', firstStart !== null, `starts=${starts().length}`);
    eq('首次启动不算重载', st0?.reloads, 0);
    eq('首次启动没有 pendingSince', st0?.pendingSince, null);
    /* 状态文件里的 supervisorPid 必须是监督进程自己 */
    eq('supervisorPid = 监督进程', st0?.supervisorPid, watcher.pid);

    /* ---- ② 改后端代码 → 类型检查通过 → 空闲 → 重载 → 新 pid ---- */
    fs.writeFileSync(path.join(srcDir, 'fake.ts'), 'export const a = 2;\n', 'utf8');
    const st1 = await waitFor('重载完成（pid 变化）', () => {
      const s = state();
      return s && s.pid !== pid0 && s.lastReloadAt ? s : null;
    });
    ok('保存后端代码后自动重载（新 pid）', st1 !== null, watchOut.slice(-800));
    ok('新 pid 与旧 pid 不同', !!st1 && st1.pid !== pid0);
    const secondStart = await waitFor('新进程写下 starts.log', () => starts().length >= 2);
    ok('假服务被启动了两次', secondStart !== null, `starts=${starts().length}`);
    eq('累计重载计数 +1', st1?.reloads, 1);
    ok('重载原因是刚改的源文件', String(st1?.lastReloadReason ?? '').includes('src/fake.ts'), String(st1?.lastReloadReason));
    /* 优雅停止的证据：假服务收到了 IPC shutdown 才退出（而不是被硬杀） */
    ok('旧进程走的是优雅退出（收到 IPC shutdown）', stops().length === 1, `stops=${stops().length}`);
    /* 就绪证据：被记成"重载完成"的那个 pid 必须真的 bind 过端口并应答过 /api/bootstrap */
    ok(
      '被记"重载完成"的新进程确实在监听端口（就绪探测真的通过了）',
      readLines(path.join(tmp, 'listening.log')).includes(String(st1?.pid)),
      `listening=${readLines(path.join(tmp, 'listening.log')).join(',')} pid=${String(st1?.pid)}`,
    );
    /* 就绪核对：端口上应答 /api/health 的必须就是状态文件里记的那个 pid（防"端口被别的进程占着"误判） */
    const liveHealth = await fetch(`http://127.0.0.1:${servicePort}/api/health`)
      .then((r) => r.json())
      .catch(() => null);
    eq('端口上的应答者 == 状态里记的子进程（pid 核对通过）', parseHealthPid(liveHealth), st1?.pid);

    /* ---- ③ 类型检查失败 → 不重启，旧进程继续服务 ---- */
    fs.writeFileSync(path.join(tmp, 'fail-typecheck'), '1', 'utf8');
    fs.writeFileSync(path.join(srcDir, 'fake.ts'), 'export const a = 3;\n', 'utf8');
    const st2 = await waitFor('记录类型检查错误', () => {
      const s = state();
      return s && s.lastTypecheckError ? s : null;
    });
    ok('类型检查失败被记录下来', st2 !== null, watchOut.slice(-800));
    ok('类型检查错误里带 tsc 的信息', String(st2?.lastTypecheckError ?? '').includes('TS2322'), String(st2?.lastTypecheckError));
    eq('类型检查失败时**没有**重启（pid 不变）', st2?.pid, st1?.pid);
    eq('类型检查失败时服务只启动过两次', starts().length, 2);

    /* ---- ④ 忙时排队：空闲后自动重载（不打断切片/投稿） ---- */
    fs.rmSync(path.join(tmp, 'fail-typecheck'), { force: true });
    writeLedger({ busy1: { status: 'TRANSCRIBING', clips: [] } });
    fs.writeFileSync(path.join(srcDir, 'fake.ts'), 'export const a = 4;\n', 'utf8');
    const st3 = await waitFor('进入等待空闲', () => {
      const s = state();
      return s && s.pendingSince ? s : null;
    });
    ok('忙时进入「等待空闲」队列', st3 !== null, watchOut.slice(-800));
    eq('忙时不重启（pid 不变）', st3?.pid, st1?.pid);
    eq('忙时服务启动次数不变', starts().length, 2);
    ok('等待空闲时 busy=true', st3?.busy === true);

    /* 忙时轮询只判忙、不重跑 tsc（真机 tsc≈5s，跟转写/切片抢 CPU 会把业务拖慢） */
    const tcRunsWhileBusy = readLines(path.join(tmp, 'tc.log')).length;
    await sleep(900); // busy-poll=150ms ⇒ 这段时间里旧实现会跑 6 次左右
    eq('忙时轮询不重复跑类型检查', readLines(path.join(tmp, 'tc.log')).length, tcRunsWhileBusy);

    /* 台账转为空闲 → 监督进程自动把排队的重载做掉 */
    writeLedger({ busy1: { status: 'ANALYZED', clips: [] } });
    const st4 = await waitFor('空闲后自动重载', () => {
      const s = state();
      /* 注意等 reloads 涨上去：settle 之后才写"重载完成"（spawn 成功 ≠ 起来了） */
      return s && s.pid !== st1?.pid && s.pendingSince === null && s.reloads >= 2 ? s : null;
    });
    ok('空闲后自动执行了排队的重载', st4 !== null, watchOut.slice(-800));
    ok('重载后 pid 又变了', !!st4 && st4.pid !== st1?.pid);
    eq('累计重载计数 = 2', st4?.reloads, 2);
    eq('空闲后 busy 复位为 false', st4?.busy, false);
    eq('文件集合未变 ⇒ 复用上次类型检查结论（未重跑 tsc）', readLines(path.join(tmp, 'tc.log')).length, tcRunsWhileBusy);

    /* ---- ⑤ 改前端模块 → 只构建，不重启服务 ---- */
    const pidBeforeUi = state()?.pid;
    fs.writeFileSync(path.join(webSrcDir, '30-x.js'), 'const x = 2;\n', 'utf8');
    const built = await waitFor('前端构建被触发', () => readLines(path.join(tmp, 'builds.log')).length > 0);
    ok('保存前端模块触发了 npm run build:ui 等价命令', built !== null);
    await sleep(400);
    eq('前端构建**不重启**服务（pid 不变）', state()?.pid, pidBeforeUi);
    eq('前端构建成功后没有残留错误', state()?.lastUiBuildError, null);
    ok('前端构建时间已记录', !!state()?.lastUiBuildAt);

    /* ---- ⑥ 前端构建失败：只记日志/状态，不影响服务 ---- */
    fs.writeFileSync(path.join(tmp, 'fail-build'), '1', 'utf8');
    fs.writeFileSync(path.join(webSrcDir, '30-x.js'), 'const x = 3;\n', 'utf8');
    const uiErr = await waitFor('记录前端构建错误', () => {
      const s = state();
      return s && s.lastUiBuildError ? s : null;
    });
    ok('前端构建失败被记录下来', uiErr !== null, watchOut.slice(-800));
    eq('前端构建失败不影响服务（pid 不变）', uiErr?.pid, pidBeforeUi);

    /* ---- ⑦ 崩溃自愈：子进程异常退出（不是我们让它退的）要自动拉起 ---- */
    const pidBeforeCrash = state()?.pid ?? null;
    const reloadsBeforeCrash = state()?.reloads ?? -1;
    ok('崩溃前拿到当前服务 pid', typeof pidBeforeCrash === 'number');
    if (typeof pidBeforeCrash === 'number') {
      try {
        process.kill(pidBeforeCrash, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    const st5 = await waitFor('异常退出后自动拉起', () => {
      const s = state();
      return s && s.pid !== null && s.pid !== pidBeforeCrash ? s : null;
    }, 25_000);
    ok('服务异常退出后自动拉起（崩溃自愈，退避 2s）', st5 !== null, watchOut.slice(-800));
    eq('崩溃自愈不改变「热更新重载次数」', st5?.reloads, reloadsBeforeCrash);

    /* ---- ⑧ 回归：崩溃 × 重载并发（QA 2026-10-24 复现的"重复拉起 ⇒ EADDRINUSE ⇒ 热更新哑火"） ----
       场景：类型检查窗口内子进程崩掉 ⇒ 崩溃退避已排队；随后重载又拉起一个新进程。
       旧实现里崩溃定时器不检查"已有存活子进程"，到点会再拉一个 ⇒ 两个进程抢端口，
       第二个秒退并把 this.child 覆盖 ⇒ 健康的那个成孤儿、state.pid 指向死进程，
       之后每次保存都"重载成功"但新代码永远不生效。 */
    const pidBeforeRace = state()?.pid ?? null;
    const reloadsBeforeRace = state()?.reloads ?? -1;
    /* starts.log 是子进程自己写的，可能比 state.pid 晚几毫秒；先等它落盘再取基线，
       否则基线偏小会把"上一步的进程"算成这一步多拉起来的（假失败）。 */
    await waitFor('starts.log 已记录当前子进程', () => {
      const list = starts();
      return list.length > 0 && Number(list[list.length - 1]) === state()?.pid;
    });
    const startsBeforeRace = starts().length;
    fs.writeFileSync(path.join(tmp, 'tc-delay'), '700', 'utf8');
    fs.writeFileSync(path.join(srcDir, 'fake.ts'), 'export const a = 5;\n', 'utf8');
    await sleep(350); // debounce 120ms + 余量：此刻类型检查正在跑
    ok('竞态用例：已拿到崩溃前的 pid', typeof pidBeforeRace === 'number');
    if (typeof pidBeforeRace === 'number') {
      try {
        process.kill(pidBeforeRace, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    fs.rmSync(path.join(tmp, 'tc-delay'), { force: true }); // 后续步骤用快速类型检查
    /* 两层等待缺一不可：
       ① 等"重载完成"（settle 之后才写 lastReloadAt/reloads）；
       ② 再等过崩溃退避窗口 —— 上一档退避是 2s ⇒ 这次排的是 5s，
          旧的 bug（不清理崩溃定时器）会在这个时刻冒出第二个子进程，只等①是抓不到的。 */
    const st6a = await waitFor('重载完成（settle 之后）', () => {
      const s = state();
      return s && s.reloads === reloadsBeforeRace + 1 ? s : null;
    });
    ok('并发场景下重载确实完成了', st6a !== null);
    await sleep(5400);
    const st6 = state();
    if (starts().length - startsBeforeRace !== 1) {
      console.log('    --- hot-watch 日志尾部（调试用） ---');
      for (const l of readLines(logPath).slice(-40)) console.log(`      ${l}`);
      console.log(`      starts=${starts().join(',')} stops=${stops().join(',')} reloads=${String(st6?.reloads)} pid=${String(st6?.pid)}`);
    }
    eq('并发场景下只拉起了一个新进程（没有重复 spawn）', starts().length - startsBeforeRace, 1);
    eq('并发场景下重载只计一次', st6?.reloads, reloadsBeforeRace + 1);
    const lastStarted = starts().length > 0 ? Number(starts()[starts().length - 1]) : NaN;
    eq('state.pid 就是最后拉起的那个进程（没有孤儿旧进程）', st6?.pid, lastStarted);
    const trackedAlive = ((): boolean => {
      const pid = st6?.pid;
      if (typeof pid !== 'number') return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    ok('state.pid 指向的进程确实活着（不是已死的重复进程）', trackedAlive);

    /* ---- ⑨ 回归：新进程起不来时**不许**记成"重载完成"（面板谎报成功） ----
       场景：重载拉起的新进程秒退（端口被占 / 配置硬错误 / 代码起不来）。
       期望：不写 lastReloadAt、不增加 reloads；日志写"重载失败"；故障解除后由崩溃自愈接手恢复，
       且恢复也不计入 reloads（它不是用户触发的热重载）。 */
    const reloadsBeforeFail = state()?.reloads ?? -1;
    const lastReloadAtBeforeFail = state()?.lastReloadAt ?? null;
    fs.writeFileSync(path.join(tmp, 'die-on-start'), '1', 'utf8');
    fs.writeFileSync(path.join(srcDir, 'fake.ts'), 'export const a = 6;\n', 'utf8');
    const failLogged = await waitFor(
      '日志出现「重载失败」',
      () => readLines(logPath).some((l) => l.includes('重载失败')),
      20_000,
    );
    ok('新进程起不来时日志明确写「重载失败」', failLogged !== null, watchOut.slice(-800));
    eq('起不来的重载不增加 reloads', state()?.reloads, reloadsBeforeFail);
    eq('起不来的重载不更新 lastReloadAt（面板不谎报）', state()?.lastReloadAt, lastReloadAtBeforeFail);

    fs.rmSync(path.join(tmp, 'die-on-start'), { force: true });
    const recovered = await waitFor(
      '故障解除后自动恢复',
      () => {
        const s = state();
        return s && typeof s.pid === 'number' ? s : null;
      },
      30_000,
    );
    ok('故障解除后由崩溃自愈自动恢复', recovered !== null, watchOut.slice(-800));
    eq('崩溃自愈恢复不计入"热重载次数"', recovered?.reloads, reloadsBeforeFail);
  } finally {
    /* 收尾：先让监督进程退出，再清掉它可能留下的假服务进程（避免测试留下孤儿） */
    const lastPid = readState(statePath)?.pid ?? null;
    try {
      watcher.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await sleep(300);
    if (lastPid) {
      try {
        process.kill(lastPid, 'SIGKILL');
      } catch {
        /* 已经退出 */
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ============================================================================
 * 三、全局异常兜底（QA/team-lead 都点名的那条：fire-and-forget 链里一次异常会带走监督进程）
 * ========================================================================== */

/**
 * 直接制造一个"没人处理的 rejection"，断言监督进程**没有跟着退出**、子进程也没被带走。
 * 真实场景就是 `void this.drainReload()` 链里抛了 —— Node 默认会因此退出整个进程，
 * 而本进程的 exit 钩子会顺手把服务子进程杀掉。
 */
async function crashGuards(): Promise<void> {
  section('全局异常兜底：unhandledRejection 之后监督进程仍存活、服务不被带走');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hot-guards-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'web', 'src'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'fake.ts'), 'export const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'fake-service.mjs'), FAKE_SERVICE, 'utf8');
  const ledgerPath = path.join(tmp, 'data', 'ledger.json');
  fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), tasks: {} }), 'utf8');
  const port = await freePort();

  const w = new HotWatcher({
    rootDir: tmp,
    port,
    entry: 'fake-service.mjs',
    statePath: path.join(tmp, 'data', 'hot-watch-state.json'),
    logPath: path.join(tmp, 'data', 'logs', 'hot-watch.log'),
    ledgerPath,
    debounceMs: 120,
    busyPollMs: 300,
  });
  await w.start();
  const pid0 = w.getState().pid;
  ok('兜底用例：监督进程已拉起子进程', typeof pid0 === 'number', `pid=${String(pid0)}`);

  const off = attachCrashGuards(w);
  try {
    /* 制造未处理的 rejection（不 await、不 catch）—— 这就是真实的 unhandledRejection 形态 */
    void Promise.reject(new Error('boom-guard-test'));
    await sleep(400);
    /* 能跑到这一行本身就是证据：没有兜底时 Node 会因为 unhandledRejection 直接退出 */
    ok('异常后监督进程仍存活（本用例还能继续执行）', true);
    eq('异常不改变子进程 pid（服务没被 exit 钩子带走）', w.getState().pid, pid0);
    ok(
      '异常被记录进状态文件（含 kind 与消息）',
      String(w.getState().lastInternalError ?? '').includes('boom-guard-test') &&
        String(w.getState().lastInternalError ?? '').includes('unhandledRejection'),
      String(w.getState().lastInternalError ?? ''),
    );
    const alive = ((): boolean => {
      try {
        process.kill(pid0 as number, 0);
        return true;
      } catch {
        return false;
      }
    })();
    ok('子进程确实还活着（没被一并杀掉）', alive);
  } finally {
    off(); // 摘掉兜底，避免影响本进程后续用例
    await w.stop('test-cleanup');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ============================================================================
 * 四、命令行解析（保证启动参数真的进到了 options 里）
 * ========================================================================== */

async function cliParse(): Promise<void> {
  section('命令行解析');
  const { parseWatchArgs } = await import('../src/hot-watch.ts');
  const { options } = parseWatchArgs(['--port', '3100', '--root', 'X:/tmp', '--busy-poll', '900', '--child-arg', '--dry-run', '--child-arg', '--allow-paid']);
  eq('端口', options.port, 3100);
  eq('root', options.rootDir, 'X:/tmp');
  eq('忙闲轮询间隔', options.busyPollMs, 900);
  eq('透传参数', options.childArgs, ['--dry-run', '--allow-paid']);
  const parsed = parseWatchArgs(['--help']);
  eq('--help 被识别', parsed.help, true);
  /* HotWatcher 构造不改全局状态（可在同一进程里多实例，测试用得上） */
  const w = new HotWatcher({ rootDir: os.tmpdir(), port: 1234 });
  eq('构造即带端口', w.getState().port, 1234);
  eq('构造后 enabled=false（还没 start）', w.getState().enabled, false);
}

/* ============================================================================
 * 入口
 * ========================================================================== */

await cliParse();
await crashGuards();
await integration();

console.log('');
if (fail === 0) {
  console.log(`\x1b[32m全部通过：${pass} 项\x1b[0m`);
} else {
  console.log(`\x1b[31m失败 ${fail} 项 / 共 ${pass + fail} 项\x1b[0m`);
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
