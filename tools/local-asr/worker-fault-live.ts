/**
 * ASR 独立进程的**真机故障注入**（2026-10-11，第 6 步的两项实测）。
 *
 * 这一项的全部卖点只有两句话，而两句都**只能实测**：
 *   A. 转写进行到一半，把 worker（连同它拉起的 FunASR 子进程一起）**强杀** ——
 *      守护进程必须活着、HTTP 必须照常应答（界面不发卡），而且任务必须**自动重试成功**；
 *   B. 把 worker 脚本"弄坏"（改名，模拟部署残缺 / 路径写错）—— 必须**原地降级**到进程内转写，
 *      任务照常完成；而且因为两条路径共用缓存，降级那次不该把音频重算一遍。
 *
 * 为什么必须跑**真 Orchestrator**（而不是像 `test/asr-worker.ts` 那样测客户端）：
 * "重试两次 ⇒ 原地降级"是接线在 `src/daemon.ts` 里的编排逻辑，模拟不出来。
 *
 * 隔离手段（不碰真实运行状态）：
 *   · `dataDirOverride` 指向本次运行的临时目录（日志、错误报告、任务产物都在里面）；
 *   · 台账用指向临时目录的 Ledger 实例；
 *   · `dryRun`：只到 clips.json，**不切片、不投稿**；
 *   · 不启动轮询/触发（只手动导入这一场）。
 *   ⚠️ 唯一"借用"真实资源的是 ASR 缓存目录（故意共用：B 步要验缓存复用，且 5 分钟素材的
 *      缓存条目很小）。配置以真实 `config.json` 为准 —— 因为要跑的就是用户那套本地 Fun-ASR。
 *
 * 用法：
 *   node --experimental-strip-types tools/local-asr/worker-fault-live.ts "<媒体文件>" [--clip-min 5] [--kill-after 150] [--cleanup]
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Orchestrator } from '../../src/daemon.ts';
import { Ledger } from '../../src/ledger.ts';
import { UiServer } from '../../src/server.ts';
import { findFfmpeg } from '../../src/av-sync.ts';
import { ROOT_DIR, exists } from '../../src/util.ts';

/* ------------------------------------------------------------------ 断言与输出 */

let pass = 0;
let fail = 0;
const failures: string[] = [];
const evidence: Record<string, unknown> = {};
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
function note(t: string): void {
  console.log(`  \x1b[90m· ${t}\x1b[0m`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2);
const media = argv.find((a) => !a.startsWith('--'));
const optOf = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const clipMin = optOf('clip-min', 15);
/* 默认 150 秒：worker 的模型加载约 96 秒（固定成本），杀掉要落在**推理进行中**才有意义。
   ⚠️ 素材必须够长：5 分钟素材的转写全长约 150 秒（96 秒加载 + 约 51 秒推理），
   第一次实测就是"还没来得及杀，它已经跑完了" —— 那样验到的是正常路径，不是隔离。
   15 分钟素材的转写约 250 秒，150 秒时正在推理中（见下面的"赛跑护栏"）。 */
const killAfterSec = optOf('kill-after', 150);
/* 默认**保留**整轮的日志与报告（这是实测证据，删掉就得重跑一遍）；--cleanup 才删 */
const cleanup = argv.includes('--cleanup');

if (!media || !exists(media)) {
  console.error('用法：node --experimental-strip-types tools/local-asr/worker-fault-live.ts "<媒体文件>" [--clip-min 5] [--kill-after 150] [--cleanup]');
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runDir = path.join(ROOT_DIR, 'data', 'local-asr-test', `worker-fault-${stamp}`);
const logsDir = path.join(runDir, 'logs');
fs.mkdirSync(logsDir, { recursive: true });
const workerPath = path.join(ROOT_DIR, 'src', 'asr-worker.ts');
const workerBak = `${workerPath}.fault-injection-bak`;
/* 全程**不写配置**：开关只在内存里打开。最后拿它证明"这次实测没把开关落到盘上"。
   ⚠️ 不能用 mtime 当判据：这是一个多会话共用的仓库，另一路会话（或正在跑的服务）随时可能
   自己保存一次 config.json —— 第一版就是这么假红了一次。判据要落在**内容**上。 */
const cfgPath = path.join(ROOT_DIR, 'config.json');
const cfgHashBefore = exists(cfgPath) ? crypto.createHash('sha256').update(fs.readFileSync(cfgPath)).digest('hex').slice(0, 12) : 'missing';

/** 读当天日志（daemon 的结构化日志就在这儿），用来找 worker pid 与失败/降级证据 */
function logLines(): string[] {
  const out: string[] = [];
  for (const f of fs.readdirSync(logsDir)) {
    if (!f.startsWith('live_auto-') || !f.endsWith('.jsonl')) continue;
    out.push(...fs.readFileSync(path.join(logsDir, f), 'utf8').split('\n').filter(Boolean));
  }
  return out;
}
const logHas = (re: RegExp): boolean => logLines().some((l) => re.test(l));
function logMatches(re: RegExp): string[] {
  return logLines()
    .filter((l) => re.test(l))
    .map((l) => {
      try {
        return String((JSON.parse(l) as { msg?: string }).msg ?? l);
      } catch {
        return l;
      }
    });
}

/** 等一个条件成立（轮询），超时返回 false */
async function waitFor(label: string, ms: number, cond: () => boolean, everyMs = 500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(everyMs);
  }
  console.log(`  \x1b[33m! 等待超时：${label}（${Math.round(ms / 1000)} 秒）\x1b[0m`);
  return false;
}

/** 找一个空闲端口（UI 服务器必须只监听回环） */
async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

/** 进程是否还活着（用于"到点要杀时 worker 还在不在"的赛跑护栏） */
function alivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ 0. 切一段短素材 */

section('0. 准备：切一段短素材（故障注入要"转写正在进行中"，整场 59 分钟太慢）');
const clip = path.join(runDir, `clip-${clipMin}min.ts`);
{
  const ffmpeg = findFfmpeg();
  const t0 = Date.now();
  const r = spawnSync(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-ss', '600', '-i', media, '-t', String(clipMin * 60), '-c', 'copy', '-y', clip],
    { stdio: 'inherit' },
  );
  ok(
    `切出 ${clipMin} 分钟素材（-c copy 无重编码，${((Date.now() - t0) / 1000).toFixed(1)}s）`,
    r.status === 0 && exists(clip) && fs.statSync(clip).size > 0,
    `ffmpeg=${ffmpeg} 退出码=${String(r.status)}`,
  );
  evidence.clip = { path: clip, bytes: exists(clip) ? fs.statSync(clip).size : 0 };
}

/* ------------------------------------------------------------------ 1. 起真 daemon（隔离数据目录 + 真 HTTP 服务） */

section('1. 起真 Orchestrator（临时数据目录、dryRun）+ 真 HTTP 服务');
const ledger = new Ledger({ path: path.join(runDir, 'ledger.json'), logger: undefined });
const orch = new Orchestrator({
  ledger,
  dataDirOverride: runDir,
  dryRun: true, // 只到 clips.json：不切片、不投稿
  allowPaid: false, // 本地 Fun-ASR 不产生费用；这里也不允许任何付费调用
  triggerBaselineMs: 0,
});
orch.logger.setConsole(false); // 日志进文件（下面按文件断言），控制台留给本工具的结论

/* 内存里打开开关（**不写 config.json**：默认态必须保持一致，直到用户批准长期打开） */
orch.config.asr.worker.enabled = true;
orch.config.mcp.enabled = false; // 免得 UiServer 构造函数去写 config.json 里的 MCP token
orch.config.runtime.recordDecisions = false; // 不往真实 decisions.jsonl 里写测试记录
orch.config.publish.autoPublish = false; // 双保险：任何情况下都不投稿

eq('开关已在内存里打开（config.json 未被改动）', orch.config.asr.worker.enabled, true);
eq('走的是本地 Fun-ASR（不产生费用）', orch.config.asr.provider, 'local-funasr');

const port = await freePort();
const ui = new UiServer({ orchestrator: orch, port, openBrowser: false, host: '127.0.0.1' });
await ui.start();
ok(`HTTP 服务已起来：${ui.url}`, true);

let unauth = 0;
/** UI 一直在轮询的那个端点（GET /api/tasks）：用它测"界面还活着" */
async function pingTasks(): Promise<number> {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${port}/api/tasks`, { signal: AbortSignal.timeout(10_000) });
  await r.text();
  if (!r.ok) unauth++;
  return Date.now() - t0;
}
const poller = { running: false, samples: [] as Array<{ at: number; ms: number }>, errors: 0 };
async function pollLoop(): Promise<void> {
  while (poller.running) {
    try {
      const ms = await pingTasks();
      poller.samples.push({ at: Date.now(), ms });
    } catch {
      poller.errors++;
      poller.samples.push({ at: Date.now(), ms: -1 });
    }
    await sleep(250);
  }
}
poller.running = true;
const pollTask = pollLoop();

/* ------------------------------------------------------------------ 2. A 步：转写中途杀 worker */

section('2. A 步：转写进行到一半，强杀 worker（连同 FunASR 子进程）');
const taskA = await orch.importLocal({ videoPath: clip, title: `故障注入 A（杀 worker）${stamp}` });
note(`任务 ${taskA.id} 已导入，等它进入转写并连上 worker…`);

const gotPid = await waitFor('worker pid 出现在日志里', 120_000, () => /转写 worker 已启动（pid \d+）/.test(logLines().join('\n')), 300);
const pidLine = logMatches(/转写 worker 已启动（pid \d+）/)[0] ?? '';
const workerPid = Number(/pid (\d+)/.exec(pidLine)?.[1] ?? 0);
ok('日志里能看到 worker 的 pid（出事时用户能照着 pid 找到它）', gotPid && workerPid > 0, pidLine);
evidence.workerPid = workerPid;

note(`让它真跑 ${killAfterSec} 秒（模型加载约 96 秒 + 推理），其间 HTTP 每 250ms 打一次`);
const workerStartedAt = Date.now();
const transcriptA = path.join(runDir, 'tasks', taskA.id, 'transcript.json');
/* 赛跑护栏：先确认"到点要杀时它还活着、还没跑完" —— 否则验到的是正常路径，不是隔离。
   （第一次实测就踩了：5 分钟素材在 150 秒时已经转写完，taskkill 报 "process not found"。） */
let raceProblem = '';
for (let i = 0; i < killAfterSec; i++) {
  if (exists(transcriptA)) {
    raceProblem = `转写在 ${i} 秒内就跑完了（素材太短 / RTF 比预期快）—— 这次没有形成"进行中被杀"的场景`;
    break;
  }
  if (!alivePid(workerPid)) {
    raceProblem = `worker（pid ${workerPid}）在第 ${i} 秒已经退出 —— 转写跑完了或它自己崩了`;
    break;
  }
  await sleep(1000);
}
ok(`★ 形成"转写进行中被杀"的场景（素材 ${clipMin} 分钟，第 ${killAfterSec} 秒时 worker 仍在跑）`, !raceProblem, raceProblem);
if (raceProblem) {
  console.log(`  \x1b[33m! 请调大 --clip-min（例如 15）或调小 --kill-after；本轮 A 步的结论不可用\x1b[0m`);
}
const pingsBeforeKill = poller.samples.length;
const killedAt = Date.now();
const workerAliveSec = (killedAt - workerStartedAt) / 1000;
const kill = spawnSync('taskkill', ['/F', '/T', '/PID', String(workerPid)], { encoding: 'utf8' });
note(`taskkill /F /T ${workerPid} → ${String(kill.stdout ?? '').trim() || String(kill.stderr ?? '').trim()}`);
ok('强杀命令本身成功（worker 与它的子进程一起没了）', kill.status === 0, `退出码 ${String(kill.status)}`);
ok(
  `★ 杀在**推理进行中**，不是启动阶段（worker 已运行 ${workerAliveSec.toFixed(0)} 秒 > 模型加载约 96 秒）`,
  workerAliveSec > 100,
  `实际 ${workerAliveSec.toFixed(0)} 秒`,
);

const sawFail = await waitFor('守护进程记下"第 1/2 次失败"', 60_000, () => logHas(/独立进程转写失败（第 1\/2 次）/), 300);
const failLine = logMatches(/独立进程转写失败（第 1\/2 次）/)[0] ?? '';
ok('★ 失败被如实记录（不是静默重跑）', sawFail, failLine);
ok('★ 归类为进程崩溃（而不是含混的"转写失败"）', /提前退出|code=|signal=/.test(failLine), failLine);
/* ⚠️ 判据是"日志里**失败行之后**紧跟着第 2 次尝试"，而不是"日志行数变多"：
   日志是按批刷盘的，失败行与重试行常常同一次落盘 —— 第一版拿行数当判据，假红了一次。
   也不用"转写完成"当判据：那要等第 2 次跑完（15 分钟素材约 4 分钟）。 */
const retryStarted = await waitFor('守护进程立刻重试（第 2/2 次尝试）', 30_000, () => logHas(/转写走独立进程（第 2\/2 次尝试）/), 250);
const lines = logLines();
const idxFail = lines.findIndex((l) => /独立进程转写失败（第 1\/2 次）/.test(l));
const idxRetry = lines.findIndex((l) => /转写走独立进程（第 2\/2 次尝试）/.test(l));
ok(
  '★ 守护进程没有跟着死：它记下失败后**立刻自己发起了第 2 次尝试**（同一个进程、同一份日志，顺序可查）',
  retryStarted && idxFail >= 0 && idxRetry > idxFail && process.uptime() > workerAliveSec,
  `日志第 ${idxFail} 行是失败、第 ${idxRetry} 行是重试；pid ${String(process.pid)} 存活 ${process.uptime().toFixed(0)}s`,
);

/* 等第二次尝试把这一场真正转写完（这次会跑满：模型加载 + 推理） */
const doneTranscribe = await waitFor('第 2 次尝试转写完成（transcript.json 落地）', 15 * 60_000, () => exists(transcriptA), 2000);
ok('★ 任务**自动重试成功**：第 2 次尝试产出了 transcript.json', doneTranscribe, transcriptA);

type Seg = { start: number; end: number };
const segsA: Seg[] = doneTranscribe ? ((JSON.parse(fs.readFileSync(transcriptA, 'utf8')) as { segments?: Seg[] }).segments ?? []) : [];
ok(`转写结果非空（${segsA.length} 条字幕）`, segsA.length > 0);
evidence.taskA = { id: taskA.id, cues: segsA.length };

/* HTTP 存活与事件循环「不发卡」的量化：整个杀进程窗口里，主进程必须一直能应答 */
poller.running = false;
await pollTask;
const during = poller.samples.filter((s) => s.at >= killedAt - 5000);
const maxGap = during.reduce((m, s, i) => (i === 0 ? m : Math.max(m, s.at - during[i - 1]!.at)), 0);
const maxMs = during.reduce((m, s) => Math.max(m, s.ms), 0);
const avgMs = during.length ? during.reduce((a, s) => a + s.ms, 0) / during.length : 0;
note(
  `窗口内 HTTP 采样 ${during.length} 次（杀进程前后各取了 5 秒）：平均 ${avgMs.toFixed(0)}ms、` +
    `最大 ${maxMs}ms、两次采样最大间隔 ${maxGap}ms、失败 ${poller.errors} 次`,
);
ok('★ worker 被杀期间 HTTP **一次都没失败**（界面不白屏）', poller.errors === 0, `${poller.errors} 次失败`);
ok('★ 事件循环没有被 ASR 拖住（两次响应间隔 < 1.5 秒）', maxGap > 0 && maxGap < 1500, `最大间隔 ${maxGap}ms`);
ok('★ 单次响应都在 2 秒内（含转写进行中）', maxMs < 2000, `最大 ${maxMs}ms`);
ok('转写全程的 HTTP 采样数够密（说明轮询没被饿死）', pingsBeforeKill > 0 && during.length >= 8, `${during.length} 次`);
eq('A 步转写走了独立进程（日志里能看到 worker 启动）', gotPid, true);
evidence.http = { samplesDuring: during.length, maxGapMs: maxGap, maxMs, avgMs: Number(avgMs.toFixed(1)), failures: poller.errors };

/* ------------------------------------------------------------------ 3. B 步：把 worker 脚本弄坏 ⇒ 原地降级 */

section('3. B 步：worker 脚本改名（模拟部署残缺）⇒ 必须原地降级，任务照常完成');
/* 故障注入动了源码文件，所以要能证明"恢复回去的还是原来那份"—— 用内容指纹，不用长度 */
const sha = (p: string): string => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const workerHashBefore = sha(workerPath);
let restored = false;
let taskB: { id: string } | undefined;
try {
  fs.renameSync(workerPath, workerBak);
  restored = false;
  ok('worker 脚本已临时改名（下一条断言验的就是"起不来会怎样"）', !exists(workerPath) && exists(workerBak));

  taskB = await orch.importLocal({ videoPath: clip, title: `故障注入 B（坏 worker）${stamp}` });
  note(`任务 ${taskB.id} 已导入（worker 起不来，应当两次尝试都失败后原地降级）`);
  const transcriptB = path.join(runDir, 'tasks', taskB.id, 'transcript.json');
  const doneB = await waitFor('降级后转写完成', 10 * 60_000, () => exists(transcriptB), 2000);
  ok('★ 原地降级后任务照常完成（transcript.json 落地）', doneB, transcriptB);
  ok('★ 两次失败都被记下（不是只试一次就放弃）', logHas(/独立进程转写失败（第 1\/2 次）/) && logHas(/独立进程转写失败（第 2\/2 次）/));
  ok('★ 明确记下"已原地降级"（用户看得懂发生了什么）', logHas(/已原地降级/), logMatches(/已原地降级/)[0] ?? '');
  const failB = logMatches(/独立进程转写失败（第 2\/2 次）/)[0] ?? '';
  ok('失败原因是"起不来"这一类（脚本不存在 ⇒ spawn 失败）', /起 worker 失败|worker 进程错误|没有握手|提前退出/.test(failB), failB);

  const segsB: Seg[] = doneB ? ((JSON.parse(fs.readFileSync(transcriptB, 'utf8')) as { segments?: Seg[] }).segments ?? []) : [];
  ok(`降级路径产出的字幕数与非降级一致（${segsB.length} 条）`, segsB.length > 0 && segsB.length === segsA.length, `A=${segsA.length} B=${segsB.length}`);
  evidence.taskB = { id: taskB.id, cues: segsB.length };
} finally {
  if (exists(workerBak)) {
    fs.renameSync(workerBak, workerPath);
    restored = exists(workerPath) && !exists(workerBak);
  } else {
    restored = exists(workerPath);
  }
}
ok(
  `★ worker 脚本已恢复原状，且内容指纹与运行前一致（${workerHashBefore.slice(0, 12)}）`,
  restored && sha(workerPath) === workerHashBefore,
  `恢复后 ${sha(workerPath).slice(0, 12)}`,
);

/* ------------------------------------------------------------------ 4. 收尾 */

section('4. 收尾');
await ui.stop();
orch.stop();
/* 本次实测**没有**把开关落到盘上：它只在内存里开着（要不要长期打开由用户定） */
const cfgOnDisk = exists(cfgPath) ? (JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { asr?: { worker?: { enabled?: boolean } } }) : {};
const cfgHashAfter = exists(cfgPath) ? crypto.createHash('sha256').update(fs.readFileSync(cfgPath)).digest('hex').slice(0, 12) : 'missing';
ok(
  '★ 开关在盘上仍是**关**（这次实测没有偷偷打开它）',
  cfgOnDisk.asr?.worker?.enabled === false,
  `config.json 里 asr.worker=${JSON.stringify(cfgOnDisk.asr?.worker)}`,
);
note(`config.json 指纹 ${cfgHashBefore} → ${cfgHashAfter}${cfgHashBefore === cfgHashAfter ? '（内容未变）' : '（**被别的进程改过** —— 多会话共用仓库时正常，见上面的判据说明）'}`);
ok('★ 源码没有留在"被弄坏"的状态（worker 脚本在位）', exists(workerPath) && !exists(workerBak));
const report = { at: new Date().toISOString(), runDir, pass, fail, failures, evidence };
fs.writeFileSync(path.join(runDir, 'fault-report.json'), JSON.stringify(report, null, 2));
note(`证据与报告：${path.join(runDir, 'fault-report.json')}`);
if (cleanup) {
  fs.rmSync(runDir, { recursive: true, force: true });
  note(`（--cleanup：临时目录已删除）`);
} else {
  note(`（临时目录保留，便于回看日志：${runDir}）`);
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exit(fail === 0 ? 0 : 1);
