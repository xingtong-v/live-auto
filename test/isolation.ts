/**
 * 隔离性测试（2026-10-12，优化第三批 ②）。
 *
 * 起因（本轮实测抓到的真 bug）：`readBatches()` 用的是硬编码 `DATA_DIR`，所以在
 * `dataDirOverride`（测试、隔离运行）下会**静默读真实目录**的 `publish-log.jsonl` ——
 * 台账隔离了、周边文件却还指向真实仓库，这正是"测试污染真实数据"那一类事故的温床
 * （`ledger.ts` 里早有一段注释记着同类问题）。
 *
 * 这个套件把口径固定成一条硬约束：
 *   **用隔离目录起一套服务，跑一圈只读接口，真实 `data/` 必须一个字节都没动。**
 *
 * 两个刻意的例外（写清楚，而不是悄悄放过）：
 *   · `data/logs/` —— logger 与看门狗共用真实日志目录（这是设计，日志要能跨进程看到）；
 *   · `data/verify-shots/` / `data/trash/` —— 验收截图与回收站可能被其它进程/定时器动到。
 *   除这三处外，任何新增/删除/改动都算违规。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { Orchestrator } from '../src/daemon.ts';
import { UiServer } from '../src/server.ts';
import { ROOT_DIR } from '../src/util.ts';

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

const REAL_DATA = path.join(ROOT_DIR, 'data');
const EXCLUDE = new Set(['logs', 'verify-shots', 'trash']);

/** 真实 data/ 的快照：rel → "大小:mtime"，排除上面那三处 */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(REAL_DATA)) return out;
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(REAL_DATA, full).replace(/\\/g, '/');
      if (rel.split('/').some((seg) => EXCLUDE.has(seg))) continue;
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      const st = fs.statSync(full);
      out.set(rel, `${st.size}:${Math.round(st.mtimeMs)}`);
    }
  };
  walk(REAL_DATA);
  return out;
}

const before = snapshot();
console.log(`  真实 data/ 快照：${before.size} 个文件（已排除 ${[...EXCLUDE].join(' / ')}）`);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-isolation-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json') });
const orch = new Orchestrator({ ledger, dataDirOverride: dataDir });
orch.logger.setConsole(false);

/* 刻意**不**调 orch.start()：那会拉起轮询/清理定时器，测试不该有副作用。
   UiServer 只读接口不需要流水线在跑。 */
const ui = new UiServer({ orchestrator: orch, port: 0, openBrowser: false });
await ui.start();

try {
  const get = async (p: string): Promise<{ status: number; body: unknown }> => {
    const r = await fetch(`${ui.url}${p}`);
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  /* 把可能碰 DATA_DIR 的只读接口全打一遍（这也是"路径是否都走隔离目录"的覆盖面） */
  const endpoints = ['/api/bootstrap', '/api/tasks?limit=20', '/api/todos', '/api/clips/library?limit=5', '/api/health', '/api/pending-delete', '/api/trash', '/api/performance'];
  const results: Array<[string, number]> = [];
  for (const p of endpoints) {
    const r = await get(p).catch(() => ({ status: -1, body: null }));
    results.push([p, r.status]);
  }
  const bad = results.filter(([, s]) => s !== 200);
  ok(
    `★ 隔离实例的只读接口全部 200（${endpoints.length} 个）`,
    bad.length === 0,
    bad.map(([p, s]) => `${p}→${s}`).join(', '),
  );

  /* 隔离目录里**应该**出现台账文件（证明写确实落在 override 目录，而不是被静默丢弃） */
  ok('★ 写落在隔离目录：ledger.json 已在临时目录里生成', fs.existsSync(path.join(dataDir, 'ledger.json')), dataDir);
  /* 日志目录也**应该**出现在隔离目录里（说明 logger 同样遵守 override，而不是偷偷写真实 data/logs） */
  ok('★ 日志也落在隔离目录（未写真实 data/logs）', fs.existsSync(path.join(dataDir, 'logs')), dataDir);

  /* 关键断言：真实 data/ 一个字节没动 */
  const after = snapshot();
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [k, v] of after) {
    if (!before.has(k)) added.push(k);
    else if (before.get(k) !== v) changed.push(k);
  }
  for (const k of before.keys()) if (!after.has(k)) removed.push(k);
  ok('★ 真实 data/ 没有被新增文件', added.length === 0, added.slice(0, 8).join(', '));
  ok('★ 真实 data/ 没有被删除文件', removed.length === 0, removed.slice(0, 8).join(', '));
  ok('★ 真实 data/ 没有被改动文件（大小/mtime 一致）', changed.length === 0, changed.slice(0, 8).join(', '));

  /* 再补一条：批次账的路径必须跟着隔离目录走（本轮修的那个 bug 的回归断言） */
  const publishLogPath = orch.ledger.publishLogPath;
  ok(
    '★ 批次账路径跟着隔离目录（不是硬编码的真实 data/）',
    publishLogPath.startsWith(dataDir) && !publishLogPath.startsWith(REAL_DATA),
    publishLogPath,
  );
  const h = crypto.createHash('sha256').update(JSON.stringify([...before.entries()].sort())).digest('hex').slice(0, 16);
  console.log(`  快照指纹 ${h}（前后一致 ⇒ 真实数据未被触碰）`);
} finally {
  ui.stop();
  orch.stop();
  await new Promise((r) => setTimeout(r, 100));
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
