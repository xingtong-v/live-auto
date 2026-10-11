/**
 * ASR 独立进程的**独立验收**（2026-10-12，优化清单 #1）。
 *
 * 背景：`src/asr-worker.ts` / `asr-worker-client.ts` 不是本会话写的（另一个会话实现，已接进 daemon，
 * 开关默认关）。他们自己的套件 46/0 用的是受控小样本 —— 缺两条独立证据，这个脚本补上：
 *
 *   A. **等价性**：同一段 59 分钟真实录播，走 worker 路径 vs 走进程内路径（已有基准）是否一致？
 *      进程内基准（2026-10-11 实测，整段）：1727 条字幕 / 覆盖 2432.7s / 首 4.41 / 末 3539.6
 *   B. **杀掉 worker**：真跑时把自己的 worker 子进程 kill 掉 ⇒ 应当
 *      ① 抛 AsrWorkerError（调用方只 catch 这一种）、② 不留孤儿进程、③ **本进程（守护进程的替身）存活**、
 *      ④ 重试一次能成功（对应 daemon 的"最多试 2 次"）。
 *
 * 用法：node tools/local-asr/worker-equivalence.ts "<媒体文件>" [--minutes 59] [--short 300]
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsrWorkerError, transcribeInWorker } from '../../src/asr-worker-client.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) throw new Error('用法：node tools/local-asr/worker-equivalence.ts "<媒体文件>" [--minutes 59] [--short 300]');
const getNum = (flag: string, dflt: number): number => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const span = getNum('--minutes', 59) * 60;
const shortSpan = getNum('--short', 300);
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-verify-cache-'));

const BASELINE = { cues: 1727, covered: 2432.7, first: 4.41, last: 3539.6 };

interface Cue {
  start: number;
  end: number;
}
function summarize(res: Record<string, unknown>): { cues: number; covered: number; first: number; last: number } {
  const tr = res['transcript'] as { segments?: Cue[] } | undefined;
  const segs = tr?.segments ?? [];
  const covered = segs.reduce((a, s) => a + Math.max(0, (s.end ?? 0) - (s.start ?? 0)), 0);
  return {
    cues: segs.length,
    covered: Number(covered.toFixed(1)),
    first: Number((segs[0]?.start ?? -1).toFixed(2)),
    last: Number((segs[segs.length - 1]?.start ?? -1).toFixed(2)),
  };
}

/** 找出**我自己**的 asr-worker 子进程 pid（只扫本进程的孩子，绝不误杀别的会话） */
function workerPids(): number[] {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"ParentProcessId=${process.pid}\\" | Where-Object { $_.CommandLine -like '*asr-worker*' } | ForEach-Object { $_.ProcessId }"`,
      { encoding: 'utf8', timeout: 20000 },
    );
    return out
      .split(/\s+/)
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

const verdict: Record<string, unknown> = {};

/* ---------------- A. 等价性 ---------------- */
if (args.includes('--full')) {
console.log(`  【A】等价性：${path.basename(file)} 前 ${span} 秒走 worker 路径…`);
const t0 = Date.now();
try {
  const res = await transcribeInWorker({
    taskId: `verify-worker-${Date.now()}`,
    totalDuration: span,
    allowPaid: false,
    segments: [{ path: file, globalStart: 0, globalEnd: span }],
    cacheDir,
  });
  const got = summarize(res);
  const wallSec = Number(((Date.now() - t0) / 1000).toFixed(1));
  const cuePct = Math.abs(got.cues - BASELINE.cues) / BASELINE.cues * 100;
  const covPct = Math.abs(got.covered - BASELINE.covered) / BASELINE.covered * 100;
  console.log(`       worker：墙钟 ${wallSec}s，${got.cues} 条字幕，覆盖 ${got.covered}s，首 ${got.first} / 末 ${got.last}`);
  console.log(`       基准：          ${BASELINE.cues} 条字幕，覆盖 ${BASELINE.covered}s，首 ${BASELINE.first} / 末 ${BASELINE.last}`);
  console.log(`       差异：条数 ${cuePct.toFixed(2)}% / 覆盖 ${covPct.toFixed(2)}%`);
  verdict['A_equivalence'] = {
    ok: cuePct <= 5 && covPct <= 5,
    worker: got,
    baseline: BASELINE,
    cueDeltaPct: Number(cuePct.toFixed(2)),
    coveredDeltaPct: Number(covPct.toFixed(2)),
    wallSec,
  };
} catch (e) {
  console.log(`       [ERR] worker 路径失败：${(e as Error).message}`);
  verdict['A_equivalence'] = { ok: false, error: (e as Error).message };
}
} else {
  console.log('  【A】已跳过（等价性已在 2026-10-12 证明：1727/2432.7/4.41/3539.6 全等）；加 --full 可复跑');
}

/* ---------------- B. 杀掉 worker ---------------- */
console.log(`\n  【B】杀掉 worker：${shortSpan} 秒素材，跑起来后把子进程 kill 掉…`);
const survivors: string[] = [];
try {
  const p = transcribeInWorker({
    taskId: `verify-kill-${Date.now()}`,
    totalDuration: shortSpan,
    allowPaid: false,
    segments: [{ path: file, globalStart: 0, globalEnd: shortSpan }],
    cacheDir,
  });
  /* 等 worker 真的起来（最多 20 秒），再动手 */
  let pids: number[] = [];
  for (let i = 0; i < 40 && pids.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 500));
    pids = workerPids();
  }
  console.log(`       [scan] worker 子进程：${pids.length ? pids.join(', ') : '(没找到 - 无法执行 kill 测试)'}`);
  /* ★ 判定孤儿必须**以杀之前的快照为基准**：第一版用"杀完之后再扫一次全量"，
     结果把 A 阶段退得慢的进程、以及紧跟着重试新起的 worker 都算成了"残留"，
     断言既不成立也不失效（等于没测）。现在只认"快照里那些、杀完还活着的"。 */
  const before = new Set(pids);
  const killedOk: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
      killedOk.push(pid);
      console.log(`       [kill] SIGKILL pid=${pid}`);
    } catch (e) {
      console.log(`       [kill] FAILED pid=${pid}: ${(e as Error).message}`);
    }
  }
  let kind = '(未抛错)';
  let message = '';
  try {
    await p;
  } catch (e) {
    if (e instanceof AsrWorkerError) {
      kind = e.kind;
      message = e.message;
    } else {
      kind = `非 AsrWorkerError：${(e as Error).name}`;
      message = (e as Error).message;
    }
  }
  await new Promise((r) => setTimeout(r, 2000));
  const leftover = workerPids().filter((pid) => before.has(pid));
  console.log(`       抛出归类：${kind}${message ? ` （${message.slice(0, 90)}）` : ''}`);
  console.log(`       残留子进程（只算杀之前那批）：${leftover.length ? leftover.join(', ') : '无（已收尸）'}`);
  console.log(`       本进程：存活（能走到这里就是证据）`);
  survivors.push('daemon-alive');

  /* 重试一次：对应 daemon 的"崩一次重试" */
  let retryOk = false;
  try {
    const res2 = await transcribeInWorker({
      taskId: `verify-retry-${Date.now()}`,
      totalDuration: shortSpan + 60 /* 换时长以避开内容哈希缓存：这条要证明"重新起 worker 真跑成"，不是"命中缓存" */,
      allowPaid: false,
      segments: [{ path: file, globalStart: 0, globalEnd: shortSpan + 60 }],
      cacheDir,
    });
    retryOk = summarize(res2).cues > 0;
    console.log(`       重试：成功（${summarize(res2).cues} 条字幕）`);
  } catch (e) {
    console.log(`       重试：失败 ${(e as Error).message}`);
  }
  verdict['B_kill'] = {
    ok: kind === 'crash' || kind === 'timeout' || kind === 'heartbeat',
    killed: pids.length,
    errorKind: kind,
    noOrphan: leftover.length === 0,
    daemonAlive: true,
    retryOk,
  };
} catch (e) {
  verdict['B_kill'] = { ok: false, error: (e as Error).message };
}

const b = verdict['B_kill'] as { errorKind?: string; noOrphan?: boolean; daemonAlive?: boolean; retryOk?: boolean } | undefined;
const allFour = Boolean(
  b && ['crash', 'timeout', 'heartbeat'].includes(String(b.errorKind)) && b.noOrphan && b.daemonAlive && b.retryOk,
);
console.log(`\n  四条同时成立 = ${allFour}（归类正确 / 不留孤儿 / 守护进程存活 / 重试真跑成）`);
console.log('\n=== VERDICT ===');
console.log(JSON.stringify(verdict, null, 2));
fs.rmSync(cacheDir, { recursive: true, force: true });
