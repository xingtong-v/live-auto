/**
 * 续传落地的**反查确认**自测。
 *
 * 背景（真实事故，2026-09-23）：
 *   同一个稿件追加了 4 次，biliLive-tools 的任务**全部** `completed`、`error` 为空、
 *   `output` 是正确的 aid —— 但 B站 侧分P 数只在第 1 次从 14 涨到 23，之后三次纹丝不动。
 *   项目每次都判 PUBLISHED 并把切片记成 SUBMITTED，等于**谎报成功**，
 *   台账、终态、告警全被污染。
 *
 * 所以续传之后必须反查 B站 侧（`View.pages` 的 part 标题）确认真的落地了。
 * 本测试用 mock client 覆盖四条路径：
 *   ① 落地了            → true（正常情况）
 *   ② 一直查不到        → false（谎报被挡住）
 *   ③ 读不到分P 列表    → true 且降级为"依据较弱"（不能把成功的判失败）
 *   ④ 去重：目标已有该标题 → 不重复投（返回 skipped）
 *
 * 运行：node test/confirm-append.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Publisher } from '../src/publish.ts';
import { Ledger } from '../src/ledger.ts';
import { loadConfig } from '../src/config.ts';

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
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const silentLog = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  debug: (): void => {},
  child: (): unknown => silentLog,
};

const cfg = loadConfig('config.json').config;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-append-'));

/** 造一个 Publisher + mock client（分P 列表可逐次变化，模拟 B站 侧延迟落地） */
function makePublisher(archiveResponses: Array<Array<{ part: string; duration: number }> | 'no-list'>): {
  pub: Publisher;
  calls: { n: number };
} {
  const calls = { n: 0 };
  const client = {
    biliArchives: async () => [{ bvid: 'BV1FAKE00001', aid: 999, title: '测试稿件', duration: 100 }],
    biliArchiveDetail: async () => {
      const r = archiveResponses[Math.min(calls.n, archiveResponses.length - 1)]!;
      calls.n++;
      if (r === 'no-list') return { View: { bvid: 'BV1FAKE00001', videos: 1 } }; // 没有 pages 字段
      return { View: { bvid: 'BV1FAKE00001', videos: r.length, pages: r.map((p) => ({ part: p.part, duration: p.duration })) } };
    },
  };
  const ledger = new Ledger({ path: path.join(tmpRoot, `ledger-${Math.random().toString(36).slice(2)}.json`) });
  const pub = new Publisher({
    client: client as never,
    config: cfg,
    ledger,
    logger: silentLog as never,
  });
  return { pub, calls };
}

/** 调用私有的 confirmPartTitlesLanded */
async function confirm(
  pub: Publisher,
  want: string[],
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const m = (pub as unknown as {
    confirmPartTitlesLanded: (aid: string, t: string[], l: unknown, o?: unknown) => Promise<boolean>;
  }).confirmPartTitlesLanded;
  return m.call(pub, '999', want, silentLog, { timeoutMs: 400, intervalMs: 60, ...opts });
}

/** 调用私有的 fetchExistingPartTitles */
async function existing(pub: Publisher): Promise<string[] | undefined> {
  const m = (pub as unknown as { fetchExistingPartTitles: (aid: string, l: unknown) => Promise<string[] | undefined> })
    .fetchExistingPartTitles;
  return m.call(pub, '999', silentLog);
}

async function main(): Promise<void> {
  section('1. 已有分P 标题的读取');
  {
    const { pub } = makePublisher([[{ part: '完整版', duration: 100 }, { part: '纯享版', duration: 100 }]]);
    const got = await existing(pub);
    ok('读到 2 个标题', got?.length === 2, JSON.stringify(got));
    ok('标题内容正确', got?.[0] === '完整版' && got?.[1] === '纯享版', JSON.stringify(got));
  }
  {
    /* 详情里没有 pages（例如仅自己可见稿件接口不返回）⇒ 必须返回 undefined，不能返回 [] */
    const { pub } = makePublisher(['no-list']);
    const got = await existing(pub);
    ok('没有分P 列表时返回 undefined（而非空数组）', got === undefined, `实际 ${JSON.stringify(got)}`);
  }

  section('2. 续传落地确认：新标题出现 → true');
  {
    /* 第 1 次查（记 before）：只有旧分P；第 2 次查：新标题出现了 */
    const { pub } = makePublisher([
      [{ part: '旧分P1', duration: 10 }, { part: '旧分P2', duration: 10 }],
      [{ part: '旧分P1', duration: 10 }, { part: '旧分P2', duration: 10 }, { part: '新切片A', duration: 10 }],
    ]);
    const r = await confirm(pub, ['新切片A']);
    ok('确认落地 → true', r === true, `实际 ${r}`);
  }

  section('3. 续传落地确认：新标题**始终不出现** → false（调用方据此记「待确认」，不谎报也不误判失败）');
  {
    /* 每次查都是同一份旧列表：模拟"任务 completed 但 B站 侧一时看不到"。
       ⚠️ 注意 false 的语义**不是失败** —— B站 分P 列表实测有延迟（可达 20 分钟），
       所以调用方（publishAsMultiPart）拿到 false 时记 SUBMITTED（待确认），
       而不是 FAILED。这一条同时是"不许谎报成功"的守卫。 */
    const { pub, calls } = makePublisher([[{ part: '旧分P1', duration: 10 }]]);
    const r = await confirm(pub, ['新切片A'], { timeoutMs: 300, intervalMs: 60 });
    ok('超时未出现 → false（待确认）', r === false, `实际 ${r}`);
    ok('确实轮询了多次（不是只查一次就判死）', calls.n >= 2, `查询 ${calls.n} 次`);
  }

  section('4. 落地确认：读不到分P 列表 → 降级为 true（依据较弱）');
  {
    const { pub } = makePublisher(['no-list']);
    const r = await confirm(pub, ['新切片A']);
    ok('读不到列表时不把成功判成失败', r === true, `实际 ${r}`);
  }

  section('5. 边界：空待投清单直接为 true');
  {
    const { pub } = makePublisher([[{ part: '旧', duration: 10 }]]);
    const r = await confirm(pub, []);
    ok('没有待投标题 → true', r === true, `实际 ${r}`);
  }

  section('6. 去重：目标已有同标题 → 不重复投');
  {
    /* 这一条验证的是"重复投递会被 B站 静默丢弃"的防呆：
       标题已存在时必须识别出来，避免整批被丢。 */
    const { pub } = makePublisher([[{ part: '新切片A', duration: 10 }, { part: '旧分P', duration: 10 }]]);
    const got = await existing(pub);
    const norm = (s: string): string => s.replace(/\s+/g, '').trim();
    const have = new Set((got ?? []).map(norm));
    ok('能识别出「新切片A」已存在（会被去重跳过）', have.has(norm('新切片A')), JSON.stringify([...have]));
    ok('未存在的标题不会被误判为已存在', !have.has(norm('新切片B')), JSON.stringify([...have]));
  }

  console.log(`\n\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (failures.length) {
    console.log('\x1b[31m失败项：\x1b[0m');
    for (const f of failures) console.log(`  - ${f}`);
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

await main();
