/**
 * ASR 独立进程的**父进程侧客户端**（2026-10-11，第 6 步的护栏）。
 *
 * 整项的价值只有一句话：**转写出事时，死的是 worker，不是守护进程**。这句话要靠两件事成立：
 *   ① 起不来 / 握手失败 / 崩溃 / 心跳丢失 / 超时 —— 五种失败都必须被**归类**成 `AsrWorkerError`
 *      （调用方据此降级，不需要猜"这是业务失败还是 worker 失败"）；
 *   ② 每一种失败之后，子进程都必须**已被收尸**（否则"隔离"变成"泄漏"：ASR 崩一次留一个僵尸进程，
 *      泄漏几次就把机器拖垮，比不隔离更糟）。
 *
 * 这两条都没法靠"等到某天线上真崩一次"来验，所以这里用**假 worker**（`forkPath` 指过去的小脚本）
 * 把五种失败各造一遍，并且每个假 worker 启动时先把自己的 pid 写进文件 —— 事后断言那个 pid 真的没了。
 *
 * 另有两条**静态不变量**（便宜的护栏，防止后面有人"顺手"改坏接线）：
 *   · worker 里用的是**同一份**规划纯函数（`planSegmentCalls`）与缓存目录，且**不通过 IPC 传配置**；
 *   · 守护进程侧是"最多试 2 次 ⇒ 原地降级到进程内转写"，降级不是第二套实现。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';
import { AsrWorkerError, transcribeInWorker } from '../src/asr-worker-client.ts';

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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-worker-test-'));
const CACHE = path.join(TMP, 'cache');
fs.mkdirSync(CACHE, { recursive: true });

/**
 * 造一个假 worker：启动先落 pid（供收尸断言），再执行脚本体。
 * 用 `forkPath` 指过去，客户端本身一行都不用改 —— 这正是那个选项存在的理由。
 */
function fakeWorker(name: string, body: string): { script: string; pidFile: string } {
  const pidFile = path.join(TMP, `${name}.pid`);
  const script = path.join(TMP, `${name}.mjs`);
  fs.writeFileSync(
    script,
    [
      `import fs from 'node:fs';`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `const send = (m) => { try { process.send?.(m); } catch {} };`,
      body,
      '',
    ].join('\n'),
  );
  return { script, pidFile };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 等子进程真的消失（最多 3 秒）。返回证据串，便于失败时看清现场。 */
async function waitReaped(pidFile: string): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + 3000;
  let pid = 0;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidFile)) {
      pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (Number.isFinite(pid) && pid > 0 && !alive(pid)) return { ok: true, detail: `pid ${pid} 已退出` };
    }
    await sleep(50);
  }
  if (!pid) return { ok: false, detail: '假 worker 从未写下 pid（它根本没起来？）' };
  return { ok: false, detail: `pid ${pid} 仍然活着（没收尸）` };
}

const job = (over: Record<string, unknown> = {}): Parameters<typeof transcribeInWorker>[0] => ({
  taskId: 'asr-worker-test',
  totalDuration: 0,
  allowPaid: false,
  segments: [],
  cacheDir: CACHE,
  ...over,
});

/* ========================================================================== */

section('1. 真 worker：握手 + 空任务往返（不喂音频 ⇒ 不花钱、不加载模型）');
{
  /* 这一段是"协议真的通"的正面证据：fork 的是**生产用的那个脚本**（src/asr-worker.ts），
     它自己 loadConfig、自己建 Transcriber。任务给空 segments + 时长 0 ⇒ 规划出 0 个窗口，
     asr.ts 会直接给一条"没有可转写的窗口"的警告并返回 —— 全程不碰模型。 */
  const t0 = Date.now();
  let res: Record<string, unknown> | undefined;
  let err: unknown;
  try {
    res = await transcribeInWorker(job({ taskId: `smoke-${Date.now()}` }));
  } catch (e) {
    err = e;
  }
  const ms = Date.now() - t0;
  ok('★ 真 worker 能起来、能握手、能跑完（不是"只冒烟看了握手"）', res !== undefined, String(err));
  ok(
    `往返很快（${ms} ms）—— 说明确实没加载模型`,
    ms < 30_000,
    `${ms} ms：如果这里要几十秒，说明空任务也在跑真转写（测试变贵；这本身是个信号）`,
  );
  const transcript = (res?.transcript ?? {}) as { segments?: unknown[] };
  eq('结果形状与进程内路径一致（transcript.segments）', Array.isArray(transcript.segments), true);
  eq('空任务 ⇒ 0 条字幕', (transcript.segments ?? []).length, 0);
  const warnings = (res?.warnings ?? []) as string[];
  ok(
    '如实回报"没有可转写的窗口"（不是静默给空结果）',
    warnings.some((w) => w.includes('没有可转写的窗口')),
    JSON.stringify(warnings),
  );
}

section('2. 协议：任务原样抵达、进度原样回传、结果原样返回');
{
  /* 任务字段是 worker 侧重建调用单元的唯一依据 —— 少一个字段，worker 就会对同一段音频
     切出不同的窗口（静默产出不一样的转写）。所以这里逐字段核对"过去的是什么、回来的就是什么"。 */
  const echo = fakeWorker(
    'echo',
    `process.on('message', (m) => {
       if (m?.type === 'ping') return send({ type: 'pong' });
       if (m?.type === 'job') send({ type: 'done', result: { received: m.job } });
     });
     send({ type: 'ready' });`,
  );
  const sent = job({
    taskId: 'echo-task',
    totalDuration: 3540,
    allowPaid: true,
    /* dryRun 必须跟着任务走：云端 ASR 下它决定"空转写"的原因文案，
       而守护进程靠那个前缀区分"设计内的安全拦截"与"真跑挂了"（这是两条路径的一次真实漂移） */
    dryRun: true,
    segments: [
      { path: 'F:/tmp/a.ts', globalStart: 0, globalEnd: 1800, size: 11 },
      { path: 'F:/tmp/b.ts', globalStart: 1800, globalEnd: 3540, size: 22 },
    ],
  });
  let got: Record<string, unknown> | undefined;
  try {
    got = await transcribeInWorker(sent, { forkPath: echo.script, handshakeMs: 5000, timeoutMs: 10_000 });
  } catch (e) {
    ok('echo worker 应当成功返回', false, String(e));
  }
  eq('★ 任务字段逐字抵达 worker（含可序列化的 segments）', got?.received, sent);
  ok('allowPaid 也在其中（worker 据此设 cfg.runtime.allowPaid）', (got?.received as { allowPaid?: boolean })?.allowPaid === true);
  ok('★ 子进程已被收尸（成功路径同样不留孤儿）', (await waitReaped(echo.pidFile)).ok);

  const prog = fakeWorker(
    'progress',
    `send({ type: 'ready' });
     process.on('message', (m) => {
       if (m?.type === 'ping') return send({ type: 'pong' });
       if (m?.type !== 'job') return;
       send({ type: 'progress', label: '转写中', current: 1, total: 3 });
       send({ type: 'progress', label: '转写中', current: 2, total: 3 });
       send({ type: 'progress', label: '收尾', current: 3, total: 3 });
       send({ type: 'done', result: { transcript: { segments: [{ start: 1, end: 2, text: '空耳' }] }, paidCalls: 0, cacheHits: 1, failedWindows: 0, warnings: [], durationMs: 12 } });
     });`,
  );
  const seen: Array<{ label: string; current: number; total: number }> = [];
  let progRes: Record<string, unknown> | undefined;
  try {
    progRes = await transcribeInWorker(job({ taskId: 'progress-task' }), {
      forkPath: prog.script,
      handshakeMs: 5000,
      timeoutMs: 10_000,
      onProgress: (p) => seen.push(p),
    });
  } catch (e) {
    ok('progress worker 应当成功返回', false, String(e));
  }
  eq(
    '★ 进度原样转发给界面（3 条，顺序与 label 都不丢）',
    seen,
    [
      { label: '转写中', current: 1, total: 3 },
      { label: '转写中', current: 2, total: 3 },
      { label: '收尾', current: 3, total: 3 },
    ],
  );
  eq(
    '★ 结果对象**原样**透传（调用方不必区分两条路径 —— 少一处字段漂移点）',
    (progRes?.transcript as { segments?: unknown[] })?.segments,
    [{ start: 1, end: 2, text: '空耳' }],
  );
}

section('3. 五种失败：都必须被归类，且都必须收尸');
{
  /** 跑一个注定失败的假 worker，核对归类 + 收尸 */
  const expectFail = async (
    name: string,
    w: { script: string; pidFile: string },
    opts: Parameters<typeof transcribeInWorker>[1],
    wantKind: AsrWorkerError['kind'],
    wantInMessage: string,
  ): Promise<void> => {
    let err: unknown;
    try {
      await transcribeInWorker(job({ taskId: `fail-${name}` }), { forkPath: w.script, ...opts });
    } catch (e) {
      err = e;
    }
    const e = err as AsrWorkerError;
    ok(
      `${name}：抛出的是 AsrWorkerError（调用方只 catch 这一种 —— 不用猜是业务失败还是 worker 失败）`,
      e instanceof AsrWorkerError && e.name === 'AsrWorkerError',
      String(err),
    );
    eq(`${name}：归类为 ${wantKind}`, e?.kind, wantKind);
    ok(`${name}：错误信息带上真因（含「${wantInMessage}」）`, String(e?.message ?? '').includes(wantInMessage), String(e?.message));
    const r = await waitReaped(w.pidFile);
    ok(`${name}：★ 子进程已被收尸（不留孤儿）— ${r.detail}`, r.ok);
  };

  await expectFail(
    '3a 未握手就退出',
    fakeWorker('die-early', `process.exit(3);`),
    { handshakeMs: 5000 },
    'crash',
    '从未握手',
  );

  await expectFail(
    '3b 迟迟不握手（脚本加载卡住？）',
    fakeWorker('never-ready', `setInterval(() => {}, 1000);`),
    { handshakeMs: 1200 },
    'handshake',
    '没有握手',
  );

  await expectFail(
    '3c worker 自己报错（如显存不足）',
    fakeWorker(
      'reports-error',
      `send({ type: 'ready' });
       process.on('message', (m) => {
         if (m?.type === 'ping') return send({ type: 'pong' });
         if (m?.type === 'job') { send({ type: 'error', message: '模型加载失败：显存不足' }); setTimeout(() => process.exit(1), 10); }
       });`,
    ),
    { handshakeMs: 5000 },
    'error',
    '模型加载失败：显存不足',
  );

  await expectFail(
    '3d 卡在 native 调用里（心跳丢失）',
    /* ⚠️ 这里必须**保持活着但不应答**（`setInterval` 撑着事件循环，且不处理 message）。
       第一版只写了 `send({type:'ready'})` —— 脚本跑完就自然退出，于是先撞上 exit 分支被归类成
       `crash`（code=0）。分类没错，是假 worker 造得不对：真要验的是"进程还在、只是不理人"。 */
    fakeWorker('no-pong', `send({ type: 'ready' });\nsetInterval(() => {}, 1000);`),
    { handshakeMs: 5000, heartbeatMs: 150, timeoutMs: 20_000 },
    'heartbeat',
    '心跳丢失',
  );

  await expectFail(
    '3e 一直不结束（整体超时）',
    fakeWorker(
      'never-done',
      `send({ type: 'ready' });
       process.on('message', (m) => { if (m?.type === 'ping') send({ type: 'pong' }); });`,
    ),
    { handshakeMs: 5000, heartbeatMs: 100, timeoutMs: 700 },
    'timeout',
    '未完成',
  );

  await expectFail(
    '3f 转写中途崩掉（真有 exit code）',
    fakeWorker(
      'die-mid',
      `send({ type: 'ready' });
       process.on('message', (m) => {
         if (m?.type === 'ping') return send({ type: 'pong' });
         if (m?.type === 'job') { send({ type: 'progress', label: '转写中', current: 1, total: 9 }); setTimeout(() => process.exit(7), 30); }
       });`,
    ),
    { handshakeMs: 5000 },
    'crash',
    'code=7',
  );
}

section('4. 静态不变量：接线不会被后续改动悄悄拆掉');
{
  const client = fs.readFileSync(path.join(ROOT_DIR, 'src', 'asr-worker-client.ts'), 'utf8');
  const worker = fs.readFileSync(path.join(ROOT_DIR, 'src', 'asr-worker.ts'), 'utf8');
  const daemon = fs.readFileSync(path.join(ROOT_DIR, 'src', 'daemon.ts'), 'utf8');
  const cfg = fs.readFileSync(path.join(ROOT_DIR, 'src', 'config.ts'), 'utf8');

  const kinds = ['spawn', 'handshake', 'heartbeat', 'timeout', 'crash', 'error'];
  ok('失败归类是一组**封闭**的 kind（上面六种都被用到）', kinds.every((k) => client.includes(`'${k}'`)), kinds.join(','));

  ok('★ worker 侧用**同一份**规划纯函数（不是抄一份 —— 抄一份就会行为漂移）', worker.includes('planSegmentCalls'));
  ok('★ worker 不通过 IPC 收配置（免得密钥在进程间搬）：自己 loadConfig', worker.includes('loadConfig()'));
  ok('worker 与主进程共用同一份 ASR 缓存目录', worker.includes('new AsrCache(job.cacheDir'));
  ok('worker 侧把未捕获异常/未处理拒绝也报回父进程（不是静默死掉）', worker.includes("'uncaughtException'") && worker.includes("'unhandledRejection'"));
  ok('worker 的付费闸门由父进程决定（默认不付费）', worker.includes('cfg.runtime.allowPaid = job.allowPaid === true'));
  ok(
    '★ worker 也带上了 dryRun（否则云端 ASR 下两条路径对"空转写"给出不同结论）',
    worker.includes('job.dryRun ? { dryRun: true }') && daemon.includes('...(this.opts.dryRun !== undefined ? { dryRun: this.opts.dryRun } : {})'),
  );

  ok('★ 守护进程接线：最多试 2 次', /attempt\s*<=\s*2/.test(daemon));
  ok('★ 失败后**原地降级**到进程内转写（降级不是第二套实现）', daemon.includes('this.transcriber.transcribe({') && daemon.includes('已原地降级'));
  ok('开关默认**关**（关着 = 与接线前逐字一致）', /worker:\s*\{\s*enabled:\s*false/.test(cfg), 'config.ts 的 builtinDefaults');
  const example = fs.readFileSync(path.join(ROOT_DIR, 'config.example.json'), 'utf8');
  ok('示例配置里也给了这个开关（默认关 + 有说明）', /"worker"/.test(example) && /"enabled":\s*false/.test(example));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8').replace(/^\uFEFF/, '')) as { scripts: Record<string, string> };
  /* verify 现在是**清单驱动**（verify.steps.json + tools/verify.ts），
     链里不会再出现单个测试名 ⇒ 旧写法（查 npm 脚本文本）永远为假。
     改成读**真正的链定义**，同时保住原本的意图：worker 必须有一条链跑它（不跑就等于没有护栏）。 */
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'verify.steps.json'), 'utf8')) as {
    steps: Array<{ name: string; fast?: boolean }>;
  };
  const inChain = manifest.steps.some((s) => s.name === 'asr-worker-test');
  ok(
    'npm 脚本暴露 asr-worker-test，且接进了 verify 链（快速或全量清单）',
    Boolean(pkg.scripts['asr-worker-test']) && inChain,
  );
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
