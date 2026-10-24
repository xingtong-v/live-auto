/**
 * 代码热更新（`src/hot-watch.ts`）的**独立验收套件** —— QA 侧补的极端用例（2026-10-24）。
 *
 * 与 `test/hot-watch.ts`（工程师自测）刻意分开，理由：自测套件天然倾向于"按我实现的方式验证"。
 * 这一套换三个角度钉：
 *   ① **假服务真的监听端口**（自测里的假服务不监听）—— 只有这样"端口不残留"才有意义：
 *      重载时旧进程若没真的退出，新进程会 EADDRINUSE，这一套会抓到；
 *   ② **测的是用户能感知的结果**：类型错误保存后仍能 `fetch` 到 200、忙时排队后"不再保存也能生效"、
 *      崩溃自愈的**退避是否真的在涨**（不是只看"拉起了一次"）；
 *   ③ 面板/接口的**字段口径一致性**（服务端写什么、前端读什么，不能各写一份）。
 *
 * 全程 hermetic：临时目录 + 临时端口（net 动态分配，不碰 3000）+ 假子进程；
 * 状态文件/日志/台账都指向临时目录。唯一碰真实路径的是"只读"地确认
 * `data/hot-watch-state.json` 不在（用来验证 `/api/health` 的 `hot: null` 分支）。
 *
 * 用法：node test/hot-watch-qa.ts
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { Ledger } from '../src/ledger.ts';
import { Orchestrator } from '../src/daemon.ts';
import { UiServer } from '../src/server.ts';
import { ROOT_DIR } from '../src/util.ts';
import {
  classifyChange,
  computeBusy,
  emptyState,
  isStateAlive,
  nextBackoff,
  parseWatchArgs,
  readState,
  stateFilePath,
} from '../src/hot-watch.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(title: string, cond: unknown, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${title}`);
  } else {
    fail++;
    failures.push(`${title}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${title}${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq(title: string, got: unknown, want: unknown): void {
  ok(title, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询等待；返回条件成立时的值（超时返回 null，交给断言给可读失败信息） */
async function waitFor<T>(label: string, fn: () => T | null | undefined | false, timeoutMs = 30_000, intervalMs = 60): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v as T;
    await sleep(intervalMs);
  }
  console.log(`    \x1b[33m（等待超时：${label}）\x1b[0m`);
  return null;
}

/** 动态取一个空闲端口（不碰 3000；用完即释放，留给假服务） */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
}

const readLines = (p: string): string[] => {
  try {
    return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
};

/** pid 是否还活着（kill(pid,0) 不抛即活着；Windows 上也能用） */
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/* ============================================================================
 * 一、纯函数增量用例（自测套件没覆盖到的角度）
 * ========================================================================== */

section('忙碌判定：模糊地带与坏形状');
{
  /* 场级已 CLIPPED（静止），切片停在 SUBMITTING —— 「已提交但没拿到 taskId」，最该算忙的状态 */
  const snap = computeBusy({ tasks: { a: { status: 'CLIPPED', clips: [{ status: 'CUT' }, { status: 'SUBMITTING' }] } } });
  eq('★ 场级 CLIPPED + 切片 SUBMITTING ⇒ 忙（已提交未拿 taskId 不能打断）', snap.busy, true);
  eq('原因写明 SUBMITTING', snap.reasons, ['SUBMITTING']);
}
eq('场级 CLIPPING + 切片 CUTTING ⇒ 忙且原因去重保序', computeBusy({ tasks: { a: { status: 'CLIPPING', clips: [{ status: 'CUTTING' }] } } }).reasons, [
  'CLIPPING',
  'CUTTING',
]);
eq('RECORDED 不算忙（重启后 recoverUnfinishedTasks 接手）', computeBusy({ tasks: { a: { status: 'RECORDED' } } }).busy, false);
eq('clips 为 null 不抛', computeBusy({ tasks: { a: { status: 'CLIPPED', clips: null } } }).busy, false);
eq('clips 里有 null 元素不抛', computeBusy({ tasks: { a: { status: 'CLIPPED', clips: [null, { status: 'CUTTING' }] } } }).busy, true);
eq('status 不是字符串不抛', computeBusy({ tasks: { a: { status: 42, clips: [] } } }).busy, false);
eq('tasks 是空对象 ⇒ 空闲', computeBusy({ tasks: {} }).busy, false);

section('变化分类：前缀陷阱');
eq('src 下的嵌套文件算后端', classifyChange('src/pipeline/cut.ts'), 'backend');
eq('srcx/a.ts 不是 src 下的（前缀陷阱）', classifyChange('srcx/a.ts'), null);
eq('src/a.tsx 不算', classifyChange('src/a.tsx'), null);
eq('web/src 嵌套目录算前端', classifyChange('web/src/deep/x.js'), 'ui');
eq('web/src 里的 .ts 不算前端（前端是 .js/.css/.html）', classifyChange('web/src/x.ts'), null);

section('退避阶梯：封顶与异常输入');
eq('恰好等于档位时进下一档（2000→5000）', nextBackoff(2000), 5000);
eq('非档位值取下一档（3000→5000）', nextBackoff(3000), 5000);
eq('超过封顶仍返回 30s', nextBackoff(999_999), 30000);
eq('Infinity 退回 2s', nextBackoff(Number.POSITIVE_INFINITY), 2000);

section('命令行：透传参数不能被子进程开关吃掉');
{
  const { options } = parseWatchArgs(['--port', '3000', '--child-arg', '--room', '--child-arg', '22886881', '--child-arg', '--dry-run']);
  eq('★ --child-arg 能透传以 -- 开头的开关（launcher 的 -Room 走这条路）', options.childArgs, ['--room', '22886881', '--dry-run']);
}
{
  const { options } = parseWatchArgs(['--port']);
  eq('--port 没值时不下发 undefined（保持默认端口语义）', options.port, undefined);
}
{
  const { options } = parseWatchArgs(['--child-arg']);
  eq('--child-arg 在末尾无值时不炸', options.childArgs, undefined);
}
{
  const { options, help } = parseWatchArgs(['--unknown-flag', 'x', '-h']);
  eq('未知参数被忽略且不吃后面的值', options.port, undefined);
  eq('-h 生效', help, true);
}

/* ============================================================================
 * 二、面板与接口的字段口径一致性（静态：服务端写什么，前端读什么）
 * ========================================================================== */

section('健康面板字段口径（防止两边各写一份、改名后静默失效）');
{
  const stateKeys = new Set([...Object.keys(emptyState(3000)), 'alive']);
  const panelPath = path.join(ROOT_DIR, 'web', 'src', '39-其它页签-健康-成本-表现-Prompt.js');
  const panel = fs.readFileSync(panelPath, 'utf8');
  const used = new Set<string>();
  for (const m of panel.matchAll(/\bhot\.([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1]!);
  ok('面板确实渲染了「热更新」这一格', /kpi\('热更新'/.test(panel));
  const unknown = [...used].filter((k) => !stateKeys.has(k));
  eq('★ 面板读的每个 hot 字段都真实存在于状态接口', unknown, []);
  ok('面板覆盖了四种用户可感知状态', ['未启用', '已关闭', '等待空闲', '类型检查未通过'].every((s) => panel.includes(s)), [...used].join(','));
}

/* ============================================================================
 * 三、集成：假服务**真的监听端口**（这样才能验"端口不残留"）
 * ========================================================================== */

const FAKE_SERVICE = `import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const cwd = process.cwd();
const at = process.argv.indexOf('--port');
const port = at >= 0 ? Number(process.argv[at + 1]) : 0;
const rec = (f, s) => { try { fs.appendFileSync(path.join(cwd, f), s + '\\n'); } catch {} };
rec('starts.log', String(process.pid) + ' ' + Date.now());
/* 起稳期用例：这个标记在 ⇒ 子进程"起来就死"，用来验证「重载完成」不许谎报 */
if (fs.existsSync('die-fast')) process.exit(1);
/* 就绪门边界 B：活着但不监听，过一会儿再死（模拟"等就绪期间进程死亡"） */
const dieAfter = fs.existsSync('die-after-ms') ? (Number(fs.readFileSync('die-after-ms', 'utf8')) || 800) : 0;
const srv = http.createServer((q, s) => {
  /* 每次请求都记一行 pid：重载后连打若干次，若回的都是新 pid，就证明没有"幽灵旧进程"还在接连接
     （Windows 允许 SO_REUSEADDR 双绑，靠 EADDRINUSE 是抓不到重叠的，所以改用"谁在应答"来证） */
  rec('reqs.log', String(process.pid));
  s.writeHead(200, { 'content-type': 'application/json' });
  s.end(JSON.stringify({ pid: process.pid }));
});
/* 端口没被旧进程释放 ⇒ EADDRINUSE；这一行就是"端口不残留"的证据 */
srv.on('error', (e) => { rec('bind-errors.log', String(process.pid) + ' ' + e.code); process.exit(3); });
if (dieAfter) setTimeout(() => process.exit(7), dieAfter);
else srv.listen(port, '127.0.0.1', () => rec('listen-ok.log', String(process.pid) + ' ' + port));
process.on('message', (m) => {
  if (m && m.type === 'shutdown') { rec('stops.log', String(process.pid)); srv.close(); process.exit(0); }
});
setInterval(() => {}, 1000);
`;

/** 可切换失败的 typecheck：标记文件 + 可选延迟（用于复现"类型检查期间子进程崩了"） */
const TYPECHECK = `import fs from 'node:fs';
fs.appendFileSync('typecheck-runs.log', String(Date.now()) + '\\n');
if (fs.existsSync('typecheck-delay')) {
  const ms = Number(fs.readFileSync('typecheck-delay', 'utf8')) || 0;
  const end = Date.now() + ms;
  while (Date.now() < end) { /* 忙等，模拟 tsc 占时间 */ }
}
if (fs.existsSync('fail-typecheck')) {
  console.error('src/fake.ts(1,1): error TS2322: 类型不匹配（测试故意失败）');
  process.exit(1);
}
process.exit(0);
`;
const BUILD = `import fs from 'node:fs';
fs.appendFileSync('builds.log', String(Date.now()) + '\\n');
if (fs.existsSync('fail-build')) {
  console.error('build failed（测试故意失败）');
  process.exit(1);
}
process.exit(0);
`;

/** 边界 A：进程活着但**永不监听**（等价 `--no-ui` / ui.enabled=false：没有 Web UI 可探） */
const FAKE_NO_HTTP = `import fs from 'node:fs';
import path from 'node:path';
try { fs.appendFileSync(path.join(process.cwd(), 'starts.log'), String(process.pid) + ' ' + Date.now() + '\\n'); } catch {}
try { fs.appendFileSync(path.join(process.cwd(), 'nohttp.log'), String(process.pid) + '\\n'); } catch {}
setInterval(() => {}, 1000);
`;

/** 边界 B：起来后**很快自己退出**（等就绪期间进程死亡 ⇒ 必须立刻判失败，不能干等 ready-timeout） */
const FAKE_DIE_SOON = `import fs from 'node:fs';
import path from 'node:path';
try { fs.appendFileSync(path.join(process.cwd(), 'starts.log'), String(process.pid) + ' ' + Date.now() + '\\n'); } catch {}
setTimeout(() => process.exit(7), 500);
setInterval(() => {}, 1000);
`;

/** 崩溃兜底探针：在**独立进程**里挂上 attachCrashGuards，制造两类异常，再证明监督进程仍然完整可用 */
const CRASH_GUARD_HARNESS = (root: string, port: number, statePath: string, logPath: string, ledgerPath: string): string => `
import fs from 'node:fs';
import path from 'node:path';
import { HotWatcher, attachCrashGuards } from 'file:///${path.join(ROOT_DIR, 'src', 'hot-watch.ts').replace(/\\/g, '/')}';
const w = new HotWatcher({
  rootDir: ${JSON.stringify(root)},
  port: ${port},
  entry: 'fake-service.mjs',
  statePath: ${JSON.stringify(statePath)},
  logPath: ${JSON.stringify(logPath)},
  ledgerPath: ${JSON.stringify(ledgerPath)},
  typecheckCmd: 'node typecheck.mjs',
  uiBuildCmd: 'node build.mjs',
  readyGraceMs: 900,
});
attachCrashGuards(w);
const say = (s) => console.log('HARNESS ' + s);
const st = () => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8')); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (label, fn, ms = 25000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(100); } say('TIMEOUT ' + label); return null; };
const serve = async () => { try { const r = await fetch('http://127.0.0.1:' + ${port} + '/', { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } };

await w.start();
const pid0 = await waitFor('首启', () => st()?.pid);
await waitFor('首启可服务', serve);
say('pid0=' + String(pid0));

/* ① unhandledRejection：fire-and-forget 链里最常见的形态 */
Promise.reject(new Error('qa-boom-1'));
await sleep(900);
const s1 = st();
say('alive_after_rejection=' + String(s1?.pid === pid0));
say('err_has_rejection=' + String(String(s1?.lastInternalError || '').includes('unhandledRejection')));
say('err_has_boom1=' + String(String(s1?.lastInternalError || '').includes('qa-boom-1')));

/* ② uncaughtException（同步 throw）：同样只记录不退出 */
setTimeout(() => { throw new Error('qa-boom-sync'); }, 120);
await sleep(900);
const s2 = st();
say('alive_after_exception=' + String(s2?.pid === pid0));
say('err_has_exception=' + String(String(s2?.lastInternalError || '').includes('uncaughtException')));

/* ③ 兜底之后必须"功能完好"：热重载仍然要能正常工作 */
fs.writeFileSync(path.join(${JSON.stringify(root)}, 'src', 'g1.ts'), 'export const g1 = 1;\\n');
const s3 = await waitFor('兜底后重载', () => { const s = st(); return s && s.reloads === 1 && s.pid !== pid0 ? s : null; });
say('reload_after_guards=' + String(s3 !== null) + ' pid1=' + String(s3?.pid));
say('serving_after_guards=' + String(await serve()));

/* ④ 兜底之后"真崩溃"仍必须被拉起（证明 reloadActive 没被永久卡住） */
const pidKill = st()?.pid;
setTimeout(() => { throw new Error('qa-boom-during-reload'); }, 50);
fs.writeFileSync(path.join(${JSON.stringify(root)}, 'src', 'g2.ts'), 'export const g2 = 2;\\n');
await sleep(1600);
const pidBeforeKill = st()?.pid;
try { process.kill(pidBeforeKill, 'SIGKILL'); } catch {}
const s4 = await waitFor('崩溃后仍能拉起', () => { const s = st(); return s && s.pid && s.pid !== pidBeforeKill ? s : null; }, 35000);
say('restart_after_guards=' + String(s4 !== null));
await w.stop('crash-guard-harness');
console.log('HARNESS done exitCode=' + String(process.exitCode ?? 0));
`;


const EXIT_HARNESS = (root: string, port: number, statePath: string, logPath: string, ledgerPath: string): string => `
import { HotWatcher } from 'file:///${path.join(ROOT_DIR, 'src', 'hot-watch.ts').replace(/\\/g, '/')}';
const w = new HotWatcher({
  rootDir: ${JSON.stringify(root)},
  port: ${port},
  entry: 'fake-service.mjs',
  statePath: ${JSON.stringify(statePath)},
  logPath: ${JSON.stringify(logPath)},
  ledgerPath: ${JSON.stringify(ledgerPath)},
  typecheckCmd: 'node typecheck.mjs',
  uiBuildCmd: 'node build.mjs',
  readyGraceMs: 900,
});
await w.start();
await new Promise((r) => setTimeout(r, 3000));  // 让 /api/bootstrap 的就绪探测真的跑过（fetch 有活动连接）
const t = Date.now();
await w.stop('exit-harness');
console.log('STOPPED in ' + (Date.now() - t) + 'ms exitCode=' + String(process.exitCode ?? 0));
/* 关键：这里**不调用** process.exit()，靠事件循环自然退出 —— 验的就是"fetch + process.exit 会 libuv fail-fast"这个坑 */
`;

interface Sandbox {
  tmp: string;
  srcDir: string;
  webSrcDir: string;
  ledgerPath: string;
  statePath: string;
  logPath: string;
  starts: () => string[];
  listenOk: () => string[];
  bindErrors: () => string[];
  stops: () => string[];
  reqs: () => string[];
  typecheckRuns: () => string[];
  builds: () => string[];
  state: () => ReturnType<typeof readState>;
  writeLedger: (tasks: Record<string, unknown>) => void;
  touch: (rel: string) => void;
  writeSrc: (name: string, body: string) => void;
  writeWeb: (name: string, body: string) => void;
}

function makeSandbox(tag: string): Sandbox {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-hotqa-${tag}-`));
  const srcDir = path.join(tmp, 'src');
  const webSrcDir = path.join(tmp, 'web', 'src');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(webSrcDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'fake.ts'), 'export const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(webSrcDir, '30-x.js'), 'const x = 1;\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'fake-service.mjs'), FAKE_SERVICE, 'utf8');
  fs.writeFileSync(path.join(tmp, 'fake-nohttp.mjs'), FAKE_NO_HTTP, 'utf8');
  fs.writeFileSync(path.join(tmp, 'fake-die-soon.mjs'), FAKE_DIE_SOON, 'utf8');
  fs.writeFileSync(path.join(tmp, 'typecheck.mjs'), TYPECHECK, 'utf8');
  fs.writeFileSync(path.join(tmp, 'build.mjs'), BUILD, 'utf8');
  const ledgerPath = path.join(dataDir, 'ledger.json');
  const statePath = path.join(dataDir, 'hot-watch-state.json');
  const logPath = path.join(dataDir, 'logs', 'hot-watch.log');
  const writeLedger = (tasks: Record<string, unknown>): void => {
    fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), tasks }), 'utf8');
  };
  writeLedger({});
  return {
    tmp,
    srcDir,
    webSrcDir,
    ledgerPath,
    statePath,
    logPath,
    starts: () => readLines(path.join(tmp, 'starts.log')),
    listenOk: () => readLines(path.join(tmp, 'listen-ok.log')),
    bindErrors: () => readLines(path.join(tmp, 'bind-errors.log')),
    stops: () => readLines(path.join(tmp, 'stops.log')),
    reqs: () => readLines(path.join(tmp, 'reqs.log')),
    typecheckRuns: () => readLines(path.join(tmp, 'typecheck-runs.log')),
    builds: () => readLines(path.join(tmp, 'builds.log')),
    state: () => readState(statePath),
    writeLedger,
    touch: (rel: string) => fs.writeFileSync(path.join(tmp, rel), '1', 'utf8'),
    writeSrc: (name: string, body: string) => fs.writeFileSync(path.join(srcDir, name), body, 'utf8'),
    writeWeb: (name: string, body: string) => fs.writeFileSync(path.join(webSrcDir, name), body, 'utf8'),
  };
}

/** 起一个真监督进程去管某个沙箱 */
function startSupervisor(box: Sandbox, port: number, extra: string[] = []): { proc: ChildProcess; out: () => string } {
  let out = '';
  const proc = spawn(
    process.execPath,
    [
      path.join(ROOT_DIR, 'src', 'hot-watch.ts'),
      '--port',
      String(port),
      '--root',
      box.tmp,
      '--entry',
      'fake-service.mjs',
      '--state',
      box.statePath,
      '--log',
      box.logPath,
      '--ledger',
      box.ledgerPath,
      '--typecheck',
      'node typecheck.mjs',
      '--build-ui',
      'node build.mjs',
      '--debounce',
      '600',
      '--busy-poll',
      '300',
      '--graceful-ms',
      '5000',
      '--term-ms',
      '6000',
      /* 起稳/就绪探测的宽限调小一点，让"没 Web UI / 起来就死"这两条分支跑得快些 */
      '--ready-grace',
      '900',
      ...extra,
    ],
    { cwd: box.tmp, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stdout?.on('data', (d: Buffer) => {
    out += d.toString();
  });
  proc.stderr?.on('data', (d: Buffer) => {
    out += d.toString();
  });
  return { proc, out: () => out };
}

/** 收尾：杀掉沙箱里所有出现过的 pid（防止测试自己留孤儿） */
function killAll(box: Sandbox, supervisor?: ChildProcess | null): void {
  try {
    supervisor?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  const pids = new Set<number>([...(readState(box.statePath)?.pid ? [readState(box.statePath)!.pid!] : [])]);
  for (const line of box.starts()) {
    const n = Number(line.split(' ')[0]);
    if (Number.isFinite(n)) pids.add(n);
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经退出 */
    }
  }
}

const httpGet = async (url: string): Promise<{ status: number; body: unknown }> => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const text = await r.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* 保持原文 */
    }
    return { status: r.status, body };
  } catch (e) {
    return { status: -1, body: (e as Error).message };
  }
};

/* ---------------------------- 主场景 ---------------------------- */

async function mainFlow(): Promise<void> {
  section('集成 A：假服务真监听端口的完整流程');
  const port = await freePort();
  const box = makeSandbox('a');
  const sup = startSupervisor(box, port);
  const url = `http://127.0.0.1:${port}/`;
  try {
    /* ---- ① 启动 ---- */
    const st0 = await waitFor('监督进程拉起服务', () => {
      const s = box.state();
      return s && s.enabled && s.pid ? s : null;
    });
    ok('监督进程启动，状态文件带 pid', st0 !== null, sup.out().slice(-600));
    const pid0 = st0?.pid ?? null;
    await waitFor('假服务监听成功', () => box.listenOk().length >= 1);
    eq('★ 服务真的绑上了端口（listen-ok 一条）', box.listenOk().length, 1);
    eq('启动后能拿到 200', (await httpGet(url)).status, 200);
    eq('首次启动不算重载', st0?.reloads, 0);

    /* ---- ② 类型错误保存：不重启，旧进程继续服务 ---- */
    box.touch('fail-typecheck');
    box.writeSrc('fake.ts', 'export const a: number = "这不是数字";\n');
    const stErr = await waitFor('记录类型检查错误', () => {
      const s = box.state();
      return s && s.lastTypecheckError ? s : null;
    });
    ok('类型错误被记录进状态', stErr !== null, sup.out().slice(-800));
    ok('错误摘要里带 tsc 原文', String(stErr?.lastTypecheckError ?? '').includes('TS2322'), String(stErr?.lastTypecheckError));
    eq('★ 类型错误时 pid 不变（没有重启）', stErr?.pid, pid0);
    eq('★ 类型错误时进程数不变（starts.log 仍 1 条）', box.starts().length, 1);
    eq('★ 类型错误时服务**仍在对外服务**（HTTP 200）', (await httpGet(url)).status, 200);
    eq('类型错误不计入 reloads', stErr?.reloads, 0);

    /* ---- ③ 改回正确代码：自动重载 ---- */
    fs.rmSync(path.join(box.tmp, 'fail-typecheck'), { force: true });
    box.writeSrc('fake.ts', 'export const a = 2;\n');
    const st1 = await waitFor('改回正确代码后自动重载', () => {
      const s = box.state();
      return s && s.pid !== pid0 && s.lastReloadAt ? s : null;
    });
    ok('★ 类型错误修好后自动重载（新 pid）', st1 !== null, sup.out().slice(-800));
    eq('累计重载 +1', st1?.reloads, 1);
    eq('类型检查错误已清空（面板不会一直挂着红字）', st1?.lastTypecheckError, null);
    await waitFor('新进程监听成功', () => box.listenOk().length >= 2);
    eq('★ 重载后服务仍可访问且是新 pid', (await httpGet(url)).body, { pid: st1?.pid });
    eq('★ 旧进程收到 IPC shutdown 优雅退出（stops.log 一条）', box.stops().length, 1);
    ok('★ 旧 pid 已真的消失（端口被释放）', pid0 !== null && !pidAlive(pid0), `pid0=${pid0} 仍活着`);

    /* ---- ④ 连续保存 5 个文件：只重载 1 次、reason 记全 ---- */
    const reloadsBefore = box.state()?.reloads ?? -1;
    const startsBefore = box.starts().length;
    const names = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    for (const n of names) {
      box.writeSrc(n, `export const v_${n.replace('.', '_')} = 1;\n`);
      await sleep(80); // 5 个文件在 ~0.5s 内写完，全部落在同一个去抖窗口内
    }
    const st2 = await waitFor('连续保存后重载', () => {
      const s = box.state();
      return s && s.reloads === reloadsBefore + 1 ? s : null;
    });
    ok('连续保存触发了重载', st2 !== null, sup.out().slice(-800));
    await sleep(1500); // 再等一会：确认没有第二次重载
    eq('★ 5 个文件 1 秒内写完 ⇒ 只重载 1 次（reloads 恰好 +1）', box.state()?.reloads, reloadsBefore + 1);
    eq('★ 物理上只重启了 1 次（starts.log 只多 1 条）', box.starts().length, startsBefore + 1);
    const reason = String(box.state()?.lastReloadReason ?? '');
    ok('reason 包含最后一批文件（首个与末个都在）', reason.includes('src/a.ts') && reason.includes('src/e.ts'), reason);

    /* ---- ⑤ 忙时排队（CLIPPING + 切片 SUBMITTING）→ 空闲后自动生效 ---- */
    const pidBusy = box.state()?.pid ?? null;
    const reloadsBeforeBusy = box.state()?.reloads ?? -1;
    const startsBeforeBusy = box.starts().length;
    const tcBeforeBusy = box.typecheckRuns().length;
    box.writeLedger({ t1: { status: 'CLIPPING', clips: [{ status: 'CUT' }, { status: 'SUBMITTING' }] } });
    box.writeSrc('busy.ts', 'export const b = 1;\n');
    const stBusy = await waitFor('进入等待空闲', () => {
      const s = box.state();
      return s && s.pendingSince ? s : null;
    });
    ok('★ 忙时进入「等待空闲」', stBusy !== null, sup.out().slice(-800));
    eq('★ 忙时不重启（pid 不变）', stBusy?.pid, pidBusy);
    eq('★ 忙时不重启（starts.log 不变）', box.starts().length, startsBeforeBusy);
    eq('状态里标记 busy=true', stBusy?.busy, true);
    eq('★ 首轮决策跑了 1 次类型检查（先检查、再判忙）', box.typecheckRuns().length - tcBeforeBusy, 1);

    /* 忙时 N 轮轮询：只判忙，不许重跑 tsc（Round 1 报的 Bug 2） */
    const tcAtBusy = box.typecheckRuns().length;
    await sleep(1500); // busy-poll=300ms ⇒ 至少 4~5 轮
    eq('★ 等待空闲期间轮询 5 轮：tsc 调用次数**不增加**', box.typecheckRuns().length - tcAtBusy, 0);
    eq('等待期间反复轮询仍不重启', box.starts().length, startsBeforeBusy);

    /* 文件集合指纹：同一批文件再次触发 fs 事件 ⇒ 复用上次结论，不重跑 tsc */
    box.writeSrc('busy.ts', 'export const b = 1; /* 同文件再存一次 */\n');
    await sleep(1200); // debounce 600 ⇒ 一定重跑过一轮决策
    eq('★ 同一批文件再次触发：不再跑 tsc（复用结论）', box.typecheckRuns().length - tcAtBusy, 0);
    eq('同批文件也不会误重启', box.starts().length, startsBeforeBusy);

    /* 台账转为空闲 —— 不再保存任何文件，监督进程应自己把排队的重载做掉 */
    const tcBeforeIdleReload = box.typecheckRuns().length;
    box.writeLedger({ t1: { status: 'CLIPPED', clips: [{ status: 'SUBMITTED', bvid: 'BV1QA000001' }] } });
    const stIdle = await waitFor('空闲后自动重载', () => {
      const s = box.state();
      return s && s.reloads === reloadsBeforeBusy + 1 && s.pendingSince === null ? s : null;
    }, 40_000);
    ok('★ 改台账为空闲后**不需要再保存一次**就自动重载了', stIdle !== null, sup.out().slice(-900));
    eq('重载后 busy 复位', stIdle?.busy, false);
    ok('排队的文件出现在 reason 里', String(stIdle?.lastReloadReason ?? '').includes('busy.ts'), String(stIdle?.lastReloadReason));
    eq('★ 空闲后的这次重载没有再跑 tsc（文件集合没变 ⇒ 复用）', box.typecheckRuns().length - tcBeforeIdleReload, 0);

    /* 再来一轮：**新增文件**必须重新检查（指纹变了不能复用），空闲后依旧只跑 1 次 */
    const startsAfterIdle = box.starts().length;
    box.writeLedger({ t2: { status: 'TRANSCRIBING', clips: [] } });
    const tcBeforeNew = box.typecheckRuns().length;
    box.writeSrc('busy2.ts', 'export const b2 = 1;\n');
    const tcRecheck = await waitFor('指纹变化后重新检查', () => box.typecheckRuns().length - tcBeforeNew >= 1, 10_000);
    ok('★ 新增文件后重新跑了一次 tsc（指纹变化不被复用）', tcRecheck !== null, `tc=${box.typecheckRuns().length - tcBeforeNew}`);
    await sleep(900);
    eq('重新检查后依然因为忙而排队（不重启）', box.starts().length, startsAfterIdle);
    const tcBeforeIdle2 = box.typecheckRuns().length;
    box.writeLedger({ t2: { status: 'ANALYZED', clips: [] } });
    const stIdle2 = await waitFor('第二轮空闲后重载', () => {
      const s = box.state();
      return s && s.reloads === reloadsBeforeBusy + 2 ? s : null;
    }, 40_000);
    ok('★ 第二轮排队的改动也在空闲后自动生效', stIdle2 !== null, sup.out().slice(-900));
    eq('★ 第二轮空闲重载同样没有重复跑 tsc', box.typecheckRuns().length - tcBeforeIdle2, 0);
    ok('reason 记的是新文件', String(stIdle2?.lastReloadReason ?? '').includes('busy2.ts'), String(stIdle2?.lastReloadReason));

    /* ---- ⑥ 端口不残留：旧进程必须真的退出，不能再有"幽灵"接连接 ---- */
    eq('★ 全程没有一次绑定失败（bind-errors 为空）', box.bindErrors(), []);
    ok('每个启动过的进程都成功监听过', box.listenOk().length >= box.starts().length, `starts=${box.starts().length} listenOk=${box.listenOk().length}`);
    {
      /* 为什么不用"再绑一次看是否 EADDRINUSE"：
         Windows 默认允许 SO_REUSEADDR 双绑（实测同一端口能被两个进程同时 listen），
         那个探测在本机**恒为成功**，验不出残留。改用「谁在应答」：连打 15 次，
         应答的 pid 必须全是当前子进程 —— 只要还有旧进程在接连接，就会出现旧 pid。 */
      await waitFor('重载后的新进程开始监听', () => box.listenOk().length >= box.starts().length);
      /* 重载刚完成的那一刻，新子进程可能还在 bind 之前（spawn 返回 ≠ 已监听），
         所以先等它真的应答，再打 15 次；否则会误判成"端口没人接"。 */
      const cur = box.state()?.pid ?? null;
      let firstPid: number | null = null;
      const readyDeadline = Date.now() + 15_000;
      while (Date.now() < readyDeadline) {
        const p = ((await httpGet(url)).body as { pid?: number } | null)?.pid;
        if (typeof p === 'number') {
          firstPid = p;
          break;
        }
        await sleep(100);
      }
      ok('★ 排队的重载完成后服务恢复应答（且应答者是新的子进程）', firstPid !== null && firstPid === cur, `pid=${String(firstPid)} state=${String(cur)}`);
      const reqsBefore = box.reqs().length;
      const seen = new Set<number>();
      for (let i = 0; i < 15; i++) {
        const r = await httpGet(url);
        const pid = (r.body as { pid?: number } | null)?.pid;
        if (typeof pid === 'number') seen.add(pid);
      }
      eq('★ 连续 15 次请求全部由**当前**子进程应答（没有幽灵旧进程抢连接）', [...seen], cur === null ? [] : [cur]);
      ok('旧进程 pid 已消失（端口确实被它释放）', pid0 !== null && !pidAlive(pid0), `pid0=${pid0}`);
      /* 只看本轮 15 次请求落下的记录（reqs.log 里更早的行属于更早的子进程，属正常） */
      const tail = box.reqs().slice(reqsBefore).map(Number);
      eq('服务端收到的这 15 次请求也全落在当前 pid 上', [...new Set(tail)], cur === null ? [] : [cur]);
    }

    /* ---- ⑦ 崩溃自愈：退避 2s → 5s，reloads 不涨 ---- */
    const pidCrash1 = box.state()?.pid ?? null;
    const reloadsBeforeCrash = box.state()?.reloads ?? -1;
    ok('拿到崩溃前 pid', typeof pidCrash1 === 'number');
    const t1 = Date.now();
    if (typeof pidCrash1 === 'number') {
      try {
        process.kill(pidCrash1, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    const stC1 = await waitFor('崩溃后自动拉起', () => {
      const s = box.state();
      return s && s.pid !== null && s.pid !== pidCrash1 ? s : null;
    }, 20_000);
    const gap1 = Date.now() - t1;
    ok('★ 子进程被 -9 后自动拉起', stC1 !== null, sup.out().slice(-800));
    ok(`★ 首次退避约 2s（实测 ${gap1}ms）`, gap1 >= 1700 && gap1 <= 6000, `gap=${gap1}ms`);
    eq('★ 崩溃自愈不增加 reloads（面板数字只反映热更新）', stC1?.reloads, reloadsBeforeCrash);

    /* 立刻再崩一次：子进程"活够久"没达到 ⇒ 退避应升到 5s（不是又 2s） */
    const pidCrash2 = box.state()?.pid ?? null;
    const t2 = Date.now();
    if (typeof pidCrash2 === 'number') {
      try {
        process.kill(pidCrash2, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    await waitFor('第二次崩溃后拉起', () => {
      const s = box.state();
      return s && s.pid !== null && s.pid !== pidCrash2 ? s : null;
    }, 25_000);
    const gap2 = Date.now() - t2;
    ok(`★ 连续崩溃退避升到 5s（实测 ${gap2}ms）`, gap2 >= 4300, `gap=${gap2}ms`);
    eq('两次崩溃都不影响 reloads', box.state()?.reloads, reloadsBeforeCrash);

    /* ---- ⑧ 前端构建失败：只记错误，服务不动 ---- */
    const pidUi = box.state()?.pid ?? null;
    const buildsBefore = box.builds().length;
    box.touch('fail-build');
    box.writeWeb('30-x.js', 'const x = 3;\n');
    const stUiErr = await waitFor('记录前端构建错误', () => {
      const s = box.state();
      return s && s.lastUiBuildError ? s : null;
    });
    ok('★ 前端构建失败被记录', stUiErr !== null, sup.out().slice(-800));
    eq('★ 构建失败不影响服务（pid 不变）', stUiErr?.pid, pidUi);
    eq('★ 构建失败不影响服务（HTTP 仍 200）', (await httpGet(url)).status, 200);
    fs.rmSync(path.join(box.tmp, 'fail-build'), { force: true });
    box.writeWeb('30-x.js', 'const x = 4;\n');
    const stUiOk = await waitFor('恢复后重新构建成功', () => {
      const s = box.state();
      return s && s.lastUiBuildError === null && box.builds().length > buildsBefore ? s : null;
    });
    ok('★ 恢复后能重新构建并清空错误', stUiOk !== null, sup.out().slice(-800));
    eq('前端改动从不重启后端（pid 一直不变）', box.state()?.pid, pidUi);
  } finally {
    killAll(box, sup.proc);
    await sleep(200);
    fs.rmSync(box.tmp, { recursive: true, force: true });
  }
}

/* ---------------------------- 起稳期（不允许谎报"重载完成"） ---------------------------- */

/**
 * 「新进程起来了」≠「重载成功」。
 * `spawn` 只代表进程被创建；端口被占/配置硬错误时它会在几百毫秒内退出。
 * 那时若照常写 `reloads+1` 与 `lastReloadAt`，面板就会显示"已开启 · 最近一次重载 刚刚"，
 * 而用户刷新页面依然连不上、新代码也没生效 —— 这正是最难自查的形态。
 */
async function settleFlow(): Promise<void> {
  section('集成 E：新进程"起来就死"时，不许记「重载完成」');
  const port = await freePort();
  const box = makeSandbox('e');
  const sup = startSupervisor(box, port);
  const url = `http://127.0.0.1:${port}/`;
  try {
    const st0 = await waitFor('监督进程拉起服务', () => {
      const s = box.state();
      return s && s.enabled && s.pid ? s : null;
    });
    await waitFor('初始服务监听成功', () => box.listenOk().length >= 1);
    ok('初始服务已启动并能应答', st0 !== null && (await httpGet(url)).status === 200, sup.out().slice(-600));

    /* 让"下一个子进程"起来就死，然后保存代码触发重载 */
    box.touch('die-fast');
    box.writeSrc('boom.ts', 'export const boom = 1;\n');
    const failed = await waitFor('重载被判定为失败', () => /重载失败/.test(sup.out()), 25_000);
    ok('★ 监督进程如实记录「重载失败」（不是「重载完成」）', failed !== null, sup.out().slice(-800));
    eq('★ reloads 不涨（面板不会显示"最近一次重载 刚刚"）', box.state()?.reloads, 0);
    eq('★ lastReloadAt 保持为空', box.state()?.lastReloadAt, null);
    eq('★ lastReloadReason 保持为空', box.state()?.lastReloadReason, null);
    ok('进程确实死过（starts 至少 2 条）', box.starts().length >= 2, `starts=${box.starts().length}`);

    /* 去掉标记：崩溃自愈应该把服务拉回来，且用的就是当前（新）代码 */
    fs.rmSync(path.join(box.tmp, 'die-fast'), { force: true });
    const back = await waitFor(
      '崩溃退避后服务恢复',
      () => {
        const s = box.state();
        return s && s.pid ? s : null;
      },
      45_000,
    );
    ok('★ 去掉标记后服务被拉回（崩溃自愈接管）', back !== null, sup.out().slice(-800));
    let answered = false;
    const deadline2 = Date.now() + 15_000;
    while (Date.now() < deadline2 && !answered) {
      answered = (await httpGet(url)).status === 200;
      if (!answered) await sleep(200);
    }
    ok('★ 恢复后能正常应答', answered);
    eq('崩溃自愈不算重载（reloads 仍为 0，属"没成功过一次"）', box.state()?.reloads, 0);
  } finally {
    killAll(box, sup.proc);
    await sleep(200);
    fs.rmSync(box.tmp, { recursive: true, force: true });
  }
}

/* ---------------------------- 就绪门边界 A：没有 Web UI ---------------------------- */

/**
 * `--no-ui` / `config.ui.enabled=false` 时，进程活着但**永远不会**应答 `/api/bootstrap`。
 * 若把"没应答"一律判失败，就会陷入崩溃循环（服务其实是好的）。
 * 正确行为：超过 `--ready-grace` 判定"本次启动本来就没有 UI"，按存活算就绪并留一条日志。
 */
async function noUiReadinessFlow(): Promise<void> {
  section('集成 F：就绪门边界 A —— 进程活着但永不应答（等价 --no-ui）');
  const port = await freePort();
  const box = makeSandbox('f');
  /* 换成一个只 idle、不提供 HTTP 的假服务；grace 调小、timeout 放大，用来证明"不是靠等超时" */
  const sup = startSupervisor(box, port, ['--entry', 'fake-nohttp.mjs', '--ready-grace', '1200', '--ready-timeout', '30000']);
  try {
    await waitFor('监督进程拉起服务', () => {
      const s = box.state();
      return s && s.pid ? s : null;
    });
    const noHttp = await waitFor('nohttp 假服务跑起来', () => readLines(path.join(box.tmp, 'nohttp.log')).length >= 1, 10_000);
    ok('假服务确实没有监听任何端口（nohttp.log 有记录）', noHttp !== null, sup.out().slice(-400));

    const t0 = Date.now();
    box.writeSrc('x.ts', 'export const x = 1;\n');
    const done = await waitFor('按「没有 Web UI」判定就绪并完成重载', () => (/判定这次启动没有 Web UI/.test(sup.out()) ? true : null), 30_000);
    ok('★ 超过 ready-grace 后判定"本次启动没有 Web UI"', done !== null, sup.out().slice(-900));
    const elapsed = Date.now() - t0;
    ok(`★ 没有干等 ready-timeout（30s）：实测 ${elapsed}ms`, elapsed < 12_000, `elapsed=${elapsed}ms`);
    eq('★ 按存活算就绪 ⇒ reloads +1（面板能正确显示已重载）', box.state()?.reloads, 1);
    ok('日志写明是"进程存活（本次启动没有 Web UI）"', /进程存活（本次启动没有 Web UI）/.test(sup.out()), sup.out().slice(-600));
    ok('新进程仍然活着（没有被误判失败后杀掉/退化）', pidAlive(Number(box.state()?.pid ?? 0)));
  } finally {
    killAll(box, sup.proc);
    await sleep(200);
    fs.rmSync(box.tmp, { recursive: true, force: true });
  }
}

/* ---------------------------- 就绪门边界 B：等就绪期间进程死亡 ---------------------------- */

/**
 * 新进程起来了但**没有应答就死了**：必须立刻判失败（而不是干等 ready-timeout 60s），
 * 且不得把它记成"重载完成"；随后由崩溃退避接管，故障解除后能自愈。
 */
async function dieDuringReadinessFlow(): Promise<void> {
  section('集成 G：就绪门边界 B —— 等就绪期间进程死亡 ⇒ 立即判失败');
  const port = await freePort();
  const box = makeSandbox('g');
  /* ready-timeout 故意给 30s：如果实现是"干等超时"，这里会卡 30s 才失败 */
  const sup = startSupervisor(box, port, ['--ready-timeout', '30000', '--ready-grace', '20000']);
  try {
    const st0 = await waitFor('初始服务就绪', () => {
      const s = box.state();
      return s && s.pid ? s : null;
    }, 30_000);
    let firstOk = false;
    const dl0 = Date.now() + 15_000;
    while (Date.now() < dl0 && !firstOk) {
      firstOk = (await httpGet(`http://127.0.0.1:${port}/`)).status === 200;
      if (!firstOk) await sleep(150);
    }
    ok('初始启动正常（服务已在应答）', st0 !== null && firstOk, sup.out().slice(-600));
    const reloads0 = box.state()?.reloads ?? 0;

    /* 下一个子进程：活着 1200ms 但**不监听**（因此永不应答），然后退出 */
    fs.writeFileSync(path.join(box.tmp, 'die-after-ms'), '1200', 'utf8');
    const t0 = Date.now();
    box.writeSrc('y.ts', 'export const y = 1;\n');
    const failed = await waitFor('等待就绪期间进程死亡 ⇒ 判失败', () => (/重载失败：新进程 \d+ms 内未就绪/.test(sup.out()) ? true : null), 30_000);
    const elapsed = Date.now() - t0;
    ok('★ 如实记「重载失败：新进程 Xms 内未就绪/已退出」', failed !== null, sup.out().slice(-900));
    ok(`★ 是"发现进程死了就立刻判失败"，没干等 ready-timeout（实测 ${elapsed}ms）`, elapsed < 12_000, `elapsed=${elapsed}ms`);
    eq('★ reloads 不涨（没谎报成功）', box.state()?.reloads, reloads0);
    eq('★ lastReloadAt 仍为空', box.state()?.lastReloadAt, null);
    ok('★ 失败后交给崩溃退避（日志出现「重载后服务未就绪 … 后自动拉起」）', /重载后服务未就绪.*后自动拉起|异常退出.*后自动拉起/.test(sup.out()), sup.out().slice(-600));

    /* 故障解除：崩溃退避应把服务拉回来 */
    fs.rmSync(path.join(box.tmp, 'die-after-ms'), { force: true });
    const back = await waitFor('故障解除后服务恢复', () => {
      const s = box.state();
      return s && s.pid ? s : null;
    }, 45_000);
    ok('★ 故障解除后被拉回（崩溃自愈生效）', back !== null, sup.out().slice(-800));
    let answered = false;
    const dl = Date.now() + 15_000;
    while (Date.now() < dl && !answered) {
      answered = (await httpGet(`http://127.0.0.1:${port}/`)).status === 200;
      if (!answered) await sleep(200);
    }
    ok('★ 恢复后能正常应答', answered);
    eq('崩溃自愈不虚增 reloads', box.state()?.reloads, reloads0);
  } finally {
    killAll(box, sup.proc);
    await sleep(200);
    fs.rmSync(box.tmp, { recursive: true, force: true });
  }
}

/* ---------------------------- 日志轮转 ---------------------------- */

async function logRotationFlow(): Promise<void> {
  section('集成 H：hot-watch.log 超过上限自动切 .1');
  const port = await freePort();
  const box = makeSandbox('h');
  /* 先把日志做成"已经超限"，监督进程下一次写日志时就该切 */
  fs.mkdirSync(path.dirname(box.logPath), { recursive: true });
  fs.writeFileSync(box.logPath, 'x'.repeat(21 * 1024 * 1024), 'utf8');
  const before = fs.statSync(box.logPath).size;
  const sup = startSupervisor(box, port);
  try {
    await waitFor('监督进程拉起服务', () => {
      const s = box.state();
      return s && s.pid ? s : null;
    });
    const rotated = await waitFor('切出 .1', () => (fs.existsSync(`${box.logPath}.1`) ? true : null), 15_000);
    ok(`★ 超限后切成 .1（原文件 ${(before / 1024 / 1024).toFixed(1)}MB）`, rotated !== null);
    const old = fs.existsSync(`${box.logPath}.1`) ? fs.statSync(`${box.logPath}.1`).size : 0;
    const cur = fs.existsSync(box.logPath) ? fs.statSync(box.logPath).size : -1;
    ok('历史文件保留了原内容（大小一致）', old >= before, `old=${old} before=${before}`);
    ok('新日志从小开始（不是继续往同一个大文件里追加）', cur >= 0 && cur < 2 * 1024 * 1024, `cur=${cur}`);
    await waitFor('轮转后服务仍在跑', () => {
      const s = box.state();
      return s && s.pid && box.starts().length >= 1 ? s : null;
    }, 15_000);
    const pidNow = Number(box.state()?.pid ?? 0);
    ok('轮转后仍在继续写日志（进程没挂）', box.starts().length >= 1 && pidNow > 0 && pidAlive(pidNow), `starts=${box.starts().length} pid=${pidNow}`);
  } finally {
    killAll(box, sup.proc);
    await sleep(200);
    fs.rmSync(box.tmp, { recursive: true, force: true });
  }
}

/* ---------------------------- 退出路径（不 fail-fast） ---------------------------- */

/**
 * `process.exit()` 与未关闭的 fetch 连接在 Windows 上会触发 libuv fail-fast（退出码 0xC0000409）。
 * 这里在独立进程里 start →（真的跑过就绪探测 fetch）→ stop → 让事件循环自然退出，
 * 断言退出码是 0 而不是崩溃码。
 */
async function exitPathFlow(): Promise<void> {
  section('集成 I：正常收尾的退出路径（不许 0xC0000409 / libuv fail-fast）');
  const port = await freePort();
  const box = makeSandbox('i');
  const harnessPath = path.join(box.tmp, 'exit-harness.mjs');
  const statePath = box.statePath;
  const logPath = box.logPath;
  fs.writeFileSync(harnessPath, EXIT_HARNESS(box.tmp, port, statePath, logPath, box.ledgerPath), 'utf8');
  const res = await new Promise<{ code: number | null; signal: string | null; out: string; err: string }>((resolve) => {
    const p = spawn(process.execPath, [harnessPath], { cwd: box.tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    p.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    const killer = setTimeout(() => {
      try {
        p.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 25_000);
    p.on('exit', (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, out, err });
    });
  });
  try {
    eq('★ 收尾后进程以退出码 0 结束（不是 0xC0000409/3221226505）', res.code, 0);
    ok('stdout 里有 stop 完成的证据', /STOPPED in \d+ms/.test(res.out), res.out.slice(-300));
    ok('stderr 里没有 libuv fail-fast / Assertion failed', !/Assertion failed|0xC0000409|3221226505|UV_HANDLE_CLOSING/.test(res.err), res.err.slice(-400).replace(/\n/g, ' | '));
    ok('没有因为 fetch 未关连接而卡住（25s 内自然退出）', res.code !== null);
  } finally {
    const lastPid = readState(statePath)?.pid ?? null;
    if (lastPid) {
      try {
        process.kill(lastPid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    await sleep(200);
    fs.rmSync(box.tmp, { recursive: true, force: true });
  }
}

/* ---------------------------- 全局异常兜底 ---------------------------- */

/**
 * 监督进程自己的内部异常（fire-and-forget 链里的 unhandledRejection、或同步 throw）
 * **不许带走进程** —— 否则它的 exit 钩子会顺手杀掉服务，"改个代码整个服务没了"。
 * 兜住之后还必须"功能完好"：能热重载、真崩溃仍能被拉起。
 */
async function crashGuardFlow(): Promise<void> {
  section('集成 K：内部异常兜底（只记录不退出，且功能仍完好）');
  const port = await freePort();
  const box = makeSandbox('k');
  const harnessPath = path.join(box.tmp, 'crash-guard-harness.mjs');
  fs.writeFileSync(harnessPath, CRASH_GUARD_HARNESS(box.tmp, port, box.statePath, box.logPath, box.ledgerPath), 'utf8');
  const res = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const p = spawn(process.execPath, [harnessPath], { cwd: box.tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    p.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    const killer = setTimeout(() => {
      try {
        p.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 120_000);
    p.on('exit', (code) => {
      clearTimeout(killer);
      resolve({ code, out, err });
    });
  });
  const mark = (k: string): string => (new RegExp(`HARNESS ${k}=(\\S+)`).exec(res.out)?.[1] ?? 'missing');
  try {
    ok('探针跑完并正常收尾（exitCode=0）', res.code === 0 && /HARNESS done exitCode=0/.test(res.out), `code=${String(res.code)} err=${res.err.slice(-200).replace(/\n/g, ' | ')}`);
    eq('★ unhandledRejection 后监督进程仍存活、子进程没被牵连', mark('alive_after_rejection'), 'true');
    eq('★ uncaughtException 后同样存活、子进程没被牵连', mark('alive_after_exception'), 'true');
    eq('状态文件记下 unhandledRejection（面板/日志能查到）', mark('err_has_rejection'), 'true');
    eq('状态文件记下 uncaughtException', mark('err_has_exception'), 'true');
    eq('记录里带着异常原文（qa-boom-1）', mark('err_has_boom1'), 'true');
    eq('★ 兜底之后热重载仍然正常（reloads=1、新 pid）', mark('reload_after_guards'), 'true');
    eq('★ 兜底之后服务确实在应答', mark('serving_after_guards'), 'true');
    eq('★ 兜底之后"真崩溃"仍被拉起（reloadActive 没被永久卡住）', mark('restart_after_guards'), 'true');
  } finally {
    const st = readState(box.statePath);
    const pids = new Set<number>();
    if (st?.pid) pids.add(st.pid);
    for (const l of box.starts()) {
      const n = Number(l.split(' ')[0]);
      if (Number.isFinite(n)) pids.add(n);
    }
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    await sleep(200);
    fs.rmSync(box.tmp, { recursive: true, force: true });
  }
}

/* ---------------------------- 老版本服务（应答里没有 pid） ---------------------------- */

/**
 * 升级期间：老的 `/api/bootstrap`/`/api/health` 都没有 `pid` 字段。
 * 拿不到应答者 ⇒ "无法核对" ⇒ 按通过处理，否则会把老版本误判成"端口被占"。
 */
async function noPidToleranceFlow(): Promise<void> {
  section('集成 L：老版本服务（应答里没有 pid）⇒ 无法核对时按通过，不误杀');
  const port = await freePort();
  const box = makeSandbox('l');
  /* "外人"占着端口，但返回体里**没有** pid（模拟老版本） */
  const foreign = http.createServer((_q, s) => {
    s.writeHead(200, { 'content-type': 'application/json' });
    s.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => foreign.listen(port, '127.0.0.1', () => resolve()));
  const sup = startSupervisor(box, port, ['--entry', 'fake-nohttp.mjs', '--ready-timeout', '20000', '--ready-grace', '8000']);
  try {
    await waitFor('监督进程拉起服务', () => {
      const s = box.state();
      return s && s.pid ? s : null;
    });
    box.writeSrc('legacy.ts', 'export const legacy = 1;\n');
    const done = await waitFor('按无法核对放行', () => (/已应答 \/api\/bootstrap/.test(sup.out()) ? true : null), 25_000);
    ok('★ 拿不到 pid 时按"无法核对"放行（不误判成端口被占）', done !== null, sup.out().slice(-900));
    eq('★ 并按就绪处理 ⇒ reloads +1', box.state()?.reloads, 1);
    ok('没有误报"应答者不是本次拉起的子进程"', !/应答者不是本次拉起的子进程/.test(sup.out()), sup.out().slice(-400));
  } finally {
    killAll(box, sup.proc);
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
    await sleep(200);
    fs.rmSync(box.tmp, { recursive: true, force: true });
  }
}

/* ---------------------------- 端口被别的进程占着 ---------------------------- */

/**
 * 就绪探测打的是 `127.0.0.1:<port>/api/bootstrap`：如果这个端口被**别的进程**占着，
 * 探测会拿到别人的 200 —— 若只看状态码，就会把"别人的服务在应答"当成"我的新进程起来了"。
 * 正确行为：核对应答者 pid，不一致就判失败并明确告诉用户"端口被占用"。
 */
async function wrongResponderFlow(): Promise<void> {
  section('集成 J：端口被别的进程占着（应答者不是子进程）⇒ 判失败，不谎报');
  const port = await freePort();
  const box = makeSandbox('j');
  /* 假扮"占着端口的别人"：返回一个绝不可能是子进程的 pid */
  const foreign = http.createServer((_q, s) => {
    s.writeHead(200, { 'content-type': 'application/json' });
    s.end(JSON.stringify({ pid: 999_999 }));
  });
  await new Promise<void>((resolve) => foreign.listen(port, '127.0.0.1', () => resolve()));
  /* 子进程换成"活着但不监听"的那个，让端口确实由外人应答 */
  const sup = startSupervisor(box, port, ['--entry', 'fake-nohttp.mjs', '--ready-timeout', '30000', '--ready-grace', '20000']);
  try {
    await waitFor('监督进程拉起服务', () => {
      const s = box.state();
      return s && s.pid ? s : null;
    });
    box.writeSrc('z.ts', 'export const z = 1;\n');
    const caught = await waitFor('识别出应答者不是子进程', () => (/应答者不是本次拉起的子进程/.test(sup.out()) ? true : null), 30_000);
    ok('★ 核对应答者 pid：不是自己拉起的子进程 ⇒ 判失败（而不是"重载完成"）', caught !== null, sup.out().slice(-900));
    ok('提示里说清原因与处理方向（端口被其它进程占用）', /端口被其它进程占用/.test(sup.out()), sup.out().slice(-400));
    eq('★ reloads 不涨', box.state()?.reloads, 0);
    eq('★ lastReloadAt 仍为空（面板不谎报）', box.state()?.lastReloadAt, null);
  } finally {
    killAll(box, sup.proc);
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
    await sleep(200);
    fs.rmSync(box.tmp, { recursive: true, force: true });
  }
}

/* ---------------------------- 崩溃 × 重载 并发 ---------------------------- */

/**
 * 崩溃自愈与热重载撞车：子进程在"某次重载的类型检查窗口内"崩掉时，
 * 待执行的崩溃重启定时器**不能**在重载已经拉起新进程之后再拉起一个。
 *
 * 修复前的实际表现（QA 2026-10-24 复现两遍）：新进程 EADDRINUSE 秒死 → 健康进程变孤儿
 * → `state.pid` 长期 null → 之后每次保存都"重载完成"但新代码永不生效。
 * 这条用例就是那个 bug 的回归护栏。
 */
async function crashDuringTypecheckFlow(): Promise<void> {
  section('集成 D：崩溃落在重载的类型检查窗口内（回归：不许重复拉起子进程）');
  const port = await freePort();
  const box = makeSandbox('d');
  const sup = startSupervisor(box, port);
  const url = `http://127.0.0.1:${port}/`;
  try {
    const st0 = await waitFor('监督进程拉起服务', () => {
      const s = box.state();
      return s && s.enabled && s.pid ? s : null;
    });
    ok('初始服务已启动', st0 !== null, sup.out().slice(-600));
    await waitFor('初始服务监听成功', () => box.listenOk().length >= 1);

    /* 让类型检查变慢，然后"保存代码 + 在类型检查期间把子进程打崩" */
    fs.writeFileSync(path.join(box.tmp, 'typecheck-delay'), '1200', 'utf8');
    box.writeSrc('a.ts', 'export const a = 2;\n');
    await sleep(800); // debounce 600 已过 ⇒ 类型检查正在跑
    const pidKilled = box.state()?.pid ?? null;
    ok('拿到了"重载中"的旧子进程 pid', typeof pidKilled === 'number', String(pidKilled));
    if (typeof pidKilled === 'number') {
      try {
        process.kill(pidKilled, 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }

    /* 等崩溃退避(2s)+重载+可能的多余拉起全部落定 */
    await waitFor('重载落定', () => {
      const s = box.state();
      return s && s.reloads >= 1 && s.pid !== null ? s : null;
    }, 25_000);
    await sleep(4000);

    eq('★ 全程没有绑定失败（不能出现第二个子进程抢端口）', box.bindErrors(), []);
    eq('★ 物理上只启动了 2 个进程（初始 1 + 重载 1）', box.starts().length, 2);
    eq('★ 重载计数只 +1（没把崩溃自愈算成重载）', box.state()?.reloads, 1);
    ok('状态里 pid 不为 null（没有掉进"孤儿占端口 + 监督进程不知道谁在跑"）', box.state()?.pid !== null, JSON.stringify(box.state()));
    {
      const alive = box.starts()
        .map((l) => Number(l.split(' ')[0]))
        .filter((p) => Number.isFinite(p) && pidAlive(p));
      eq('★ 只剩 1 个存活子进程（不是孤儿满天飞）', alive.length, 1);
      const answered = ((await httpGet(url)).body as { pid?: number } | null)?.pid;
      eq('★ 应答的就是状态里记的那个子进程', answered, box.state()?.pid);
    }

    /* ★ 撞车之后必须还能继续用：再保存一次代码，仍要正常重载（新 pid + 服务应答） */
    const pidAfterRace = box.state()?.pid ?? null;
    const reloadsAfterRace = box.state()?.reloads ?? -1;
    box.writeSrc('after-race.ts', 'export const afterRace = 1;\n');
    const stNext = await waitFor('撞车后再保存仍能重载', () => {
      const s = box.state();
      return s && s.reloads === reloadsAfterRace + 1 && s.pid !== pidAfterRace ? s : null;
    }, 40_000);
    ok('★ 撞车之后再保存：热更新仍然工作（新 pid + reloads+1）', stNext !== null, sup.out().slice(-900));
    let ok2 = false;
    const dl2 = Date.now() + 15_000;
    while (Date.now() < dl2 && !ok2) {
      const body = ((await httpGet(url)).body as { pid?: number } | null)?.pid;
      ok2 = typeof body === 'number' && body === box.state()?.pid;
      if (!ok2) await sleep(200);
    }
    ok('★ 撞车后再重载的服务确实在应答（不是"假成功后哑火"）', ok2);
    eq('★ 全程依然零绑定失败', box.bindErrors(), []);
  } finally {
    killAll(box, sup.proc);
    await sleep(200);
    fs.rmSync(box.tmp, { recursive: true, force: true });
  }
}

/* ---------------------------- 监督进程被强杀 ---------------------------- */

async function supervisorKilledFlow(): Promise<void> {
  section('集成 B：监督进程被强杀后，状态文件不许长期谎报「已开启」');
  const port = await freePort();
  const box = makeSandbox('b');
  const sup = startSupervisor(box, port);
  try {
    const st0 = await waitFor('监督进程起来', () => {
      const s = box.state();
      return s && s.enabled && s.pid ? s : null;
    });
    ok('状态文件：enabled=true 且带 pid', st0 !== null, sup.out().slice(-600));
    eq('心跳新鲜 ⇒ alive（正常态）', isStateAlive(st0), true);
    const childPid = st0?.pid ?? null;

    /* TerminateProcess 式强杀：监督进程来不及写 enabled=false */
    try {
      sup.proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await sleep(800);
    const left = box.state();
    eq('被强杀后状态文件仍残留 enabled=true（这就是要心跳的原因）', left?.enabled, true);
    eq('立刻判活仍在 90s 宽限内（如此才对，不能一夜之间变红）', isStateAlive(left), true);
    /* 心跳老化到 91s 后：必须判死 */
    eq(
      '★ 心跳过期（>90s）⇒ alive=false（面板显示「已关闭」，不谎报）',
      isStateAlive({ ...left!, heartbeatAt: new Date(Date.now() - 91_000).toISOString() }),
      false,
    );
    eq('心跳边界 89s 仍算活着（不抖动）', isStateAlive({ ...left!, heartbeatAt: new Date(Date.now() - 89_000).toISOString() }), true);
    /* 现状如实记录（不作为断言）：监督进程死了以后，服务子进程在本机实测也会一起消失
       （TerminateProcess 下 Node 的 exit 钩子跑不到；本机观察到子进程随后也退出，
       端口不再应答）。但**不能**把这条当成产品保证：生产里 launcher 仍要按 pid 补刀，
       因为"父进程被强杀"在不同启动方式下（计划任务/控制台关闭）行为并不一致。 */
    const childStill = typeof childPid === 'number' && pidAlive(childPid);
    const served = (await httpGet(`http://127.0.0.1:${port}/`)).status;
    console.log(`    \x1b[90m· 记录：监督进程被 -9 后，子进程 ${childStill ? '仍活着（会成为孤儿，需 launcher 补刀）' : '也退出了'}；端口探测=${served}\x1b[0m`);
  } finally {
    killAll(box, sup.proc);
    await sleep(200);
    fs.rmSync(box.tmp, { recursive: true, force: true });
  }
}

/* ============================================================================
 * 四、启动脚本：参数构造与三条铁律（静态读，不执行 —— 执行会抢端口）
 * ========================================================================== */

/** 去掉 PowerShell 注释（块注释 <# #> 与行注释 #），避免"注释里提到 Stop-Process"造成假红 */
function stripPsComments(src: string): string {
  return src
    .replace(/<#[\s\S]*?#>/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
}

section('启动脚本：默认走热更新、-NoWatch 回退、参数透传、铁律不破');
{
  const launcher = fs.readFileSync(path.join(ROOT_DIR, 'launcher.ps1'), 'utf8');
  const ensureSrc = fs.readFileSync(path.join(ROOT_DIR, 'tools', 'ensure-service.ps1'), 'utf8');
  const ensure = stripPsComments(ensureSrc);

  ok('launcher.ps1 声明了 -NoWatch 开关', /\[switch\]\$NoWatch/.test(launcher));
  ok('★ 默认入口是热更新监督进程（src\\hot-watch.ts）', /src\\hot-watch\.ts', '--port', "\$Port"/.test(launcher));
  ok('★ 业务开关经 --child-arg 透传（否则会被监督进程自己吃掉）', /'--child-arg', '--dry-run'/.test(launcher) && /'--child-arg', '--allow-paid'/.test(launcher));
  ok('★ -Room 走两个 --child-arg（--room 本身以 -- 开头，不能丢）', /'--child-arg', '--room', '--child-arg', \$Room/.test(launcher));
  ok('★ -NoWatch 回退分支仍是 `src\\cli.ts run --port`（直启语义不变）', /src\\cli\.ts', 'run', '--port', "\$Port"/.test(launcher));
  ok('已在运行分支会读 /api/health 的 hot 字段（告诉用户热更新开没开）', /\.hot/.test(launcher) && /api\/health/.test(launcher));
  {
    /* 收尾补刀：必须先记孙进程 pid，再杀监督进程（顺序反了孙进程就找不到了） */
    const iCapture = launcher.indexOf('$grandKids = @(Get-CimInstance');
    const iKill = launcher.indexOf('Stop-Process -Id $proc.Id -Force');
    ok('★ 收尾时先记孙进程 pid 再杀监督进程（避免留下占端口的孤儿）', iCapture > 0 && iKill > iCapture, `capture=${iCapture} kill=${iKill}`);
  }

  ok('ensure-service.ps1 现在拉起的是监督进程', /src\\hot-watch\.ts/.test(ensure));
  ok('★ ensure-service.ps1 仍然绝不杀进程（三条铁律之一）', !/Stop-Process|taskkill/i.test(ensure));
  ok('★ ensure-service.ps1 仍然"端口在监听就什么都不做"', /if \(\$listening\)/.test(ensure) && /exit 0/.test(ensure));

  /* 另外两个入口（2026-10-24 补齐）：只改 launcher 会让"用 start.ps1 / restart-service 启动的人"没有热更新，
     而两者都是仓库里被文档推荐过的入口。 */
  const startPs = stripPsComments(fs.readFileSync(path.join(ROOT_DIR, 'start.ps1'), 'utf8'));
  ok('start.ps1 声明了 -NoWatch', /\[switch\]\$NoWatch/.test(startPs));
  ok('★ start.ps1 常驻运行时默认走监督进程', /src\\hot-watch\.ts/.test(startPs));
  ok('★ start.ps1 的 SelfCheck/Once 仍直连 cli.ts（一次性命令不该套监督层）', /\$SelfCheck -or \$Once -or \$NoWatch/.test(startPs));
  const restart = stripPsComments(fs.readFileSync(path.join(ROOT_DIR, 'tools', 'restart-service.ts'), 'utf8'));
  ok('★ restart-service.ts 默认重启监督进程（否则只杀服务会被它立刻拉回旧代码）', /hot-watch\.ts/.test(restart));
  ok('restart-service.ts 提供 --no-watch 回退（排障用）', /'--no-watch'/.test(restart));
  ok('★ restart-service.ts 认出监督进程后连它一起重启（/T 杀整棵树）', /\/T/.test(restart) && /supervisorPid|hot-watch-state/.test(restart));

  /* README 不能再有"start.bat / start.ps1 等价入口"这种错话（两者现在一个转调 launcher、一个自己组装参数） */
  const readme = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8');
  ok('★ README 不再出现「等价入口（start.bat / start.ps1）」的错误说法', !/等价入口（`start\.bat` \/ `start\.ps1`）/.test(readme));
  ok('README 有热更新说明段 + 用户切换步骤', /代码热更新/.test(readme) && /切换步骤/.test(readme));
  ok('README 写明 -NoWatch 的三种关法', /launcher\.ps1 -NoWatch/.test(readme) && /start\.ps1 -NoWatch/.test(readme) && /restart-service\.ts --no-watch/.test(readme));
}

/* ============================================================================
 * 五、真实 /api/health 的 hot 字段（只读验证，不碰真实 data）
 * ========================================================================== */

async function healthRouteFlow(): Promise<void> {
  section('集成 C：/api/health 的 hot 字段（只读验证，不碰真实 data）');
  const realStatePath = stateFilePath(ROOT_DIR);
  const existedBefore = fs.existsSync(realStatePath);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hotqa-health-'));
  const dataDir = path.join(tmpRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json') });
  const orch = new Orchestrator({ ledger, dataDirOverride: dataDir });
  orch.logger.setConsole(false);
  const ui = new UiServer({ orchestrator: orch, port: 0, openBrowser: false });
  await ui.start();
  try {
    const health = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
      const r = await httpGet(`${ui.url}/api/health`);
      return { status: r.status, body: (r.body ?? {}) as Record<string, unknown> };
    };
    const h = await health();
    eq('/api/health 返回 200', h.status, 200);
    ok('健康快照本身还在（没被 hot 字段破坏）', Boolean(h.body['health']));
    if (!existedBefore) {
      eq('★ 没有状态文件 ⇒ hot 为 null（面板显示「未启用」，不是一堆空字段）', h.body['hot'], null);
    } else {
      console.log('    \x1b[90m（真实 data/hot-watch-state.json 已存在 ⇒ 跳过 hot=null 断言，保护现场）\x1b[0m');
    }
  } finally {
    await ui.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  /* 接口里的 alive 是用「读状态 + 心跳判活」两步算出来的（server.ts 里就这两行）。
     这里用同样的两步在临时目录上复验，证明面板拿到的 alive 会随时间变假。 */
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hotqa-health2-'));
  const sp = path.join(tmp2, 'hot-watch-state.json');
  try {
    const fresh = { ...emptyState(3000), enabled: true, pid: 4321, reloads: 7, heartbeatAt: new Date().toISOString() };
    fs.writeFileSync(sp, JSON.stringify(fresh), 'utf8');
    eq('新鲜状态 ⇒ alive=true（面板「已开启」）', isStateAlive(readState(sp)), true);
    fs.writeFileSync(sp, JSON.stringify({ ...fresh, heartbeatAt: new Date(Date.now() - 120_000).toISOString() }), 'utf8');
    const stale = readState(sp);
    eq('心跳过期 ⇒ alive=false 且 enabled 仍 true（面板文案才能说「监督进程已退出」）', [isStateAlive(stale), stale?.enabled], [false, true]);
    fs.writeFileSync(sp, '{ 半截 JSON', 'utf8');
    eq('状态文件读坏 ⇒ readState 退回 null（接口给 hot=null，不打 500）', readState(sp), null);
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
  eq('真实 data/hot-watch-state.json 的在场状态与测试前一致（没被测试写过）', fs.existsSync(realStatePath), existedBefore);
}

/* ---------------------------- 入口 ---------------------------- */

await mainFlow();
await settleFlow();
await noUiReadinessFlow();
await dieDuringReadinessFlow();
await wrongResponderFlow();
await noPidToleranceFlow();
await crashGuardFlow();
await crashDuringTypecheckFlow();
await logRotationFlow();
await exitPathFlow();
await supervisorKilledFlow();
await healthRouteFlow();

console.log('');
if (fail === 0) {
  console.log(`\x1b[32m全部通过：${pass} 项\x1b[0m`);
} else {
  console.log(`\x1b[31m失败 ${fail} 项 / 共 ${pass + fail} 项\x1b[0m`);
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
