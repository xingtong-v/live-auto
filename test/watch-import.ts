/**
 * 目录轮询自动导入的单元验证。
 *
 * 这个功能的每一条判定都对应一类**真实事故**，所以逐条钉住：
 *
 *  1. 录制还在写就导入 → 拿到半场素材（时长错、尾帧残缺），事后极难排查；
 *  2. 同一个文件重复导入 → 白花一次转写钱（实测 ¥8.5/场）；
 *  3. 坏文件每轮重试 → 每 60 秒刷一条错误、反复建任务；
 *  4. 误把「-弹幕版」压制产物当源 → 双层弹幕；
 *  5. 把 `scanDirs` 之类的目录也顺手扫进来 → 每轮读一堆无关文件；
 *  6. **首次启用时把历史积压全导入** → 实测目录里 28 个文件 / 32 GB，一次排 28 场转写（≈¥238）。
 *
 * 全部用注入的假扫描器与假导入函数，零网络、零文件、零费用。
 *
 * 用法：node test/watch-import.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config.ts';
import { WatchImporter, type WatchImportOutcome } from '../src/watch-import.ts';
import type { RecordingCandidate } from '../src/recordings.ts';
import type { ListRecordingsResult } from '../src/recordings.ts';
import type { Logger } from '../src/logger.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string, extra?: string): void {
  if (cond) pass++;
  else {
    fail++;
    failures.push(msg);
  }
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${msg}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`);
}
function eq<T>(msg: string, actual: T, expected: T): void {
  ok(actual === expected, msg, actual === expected ? undefined : `期望 ${String(expected)}，实际 ${String(actual)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

/* ---------------- 测试替身 ---------------- */

const logLines: string[] = [];
const fakeLogger = {
  info: (m: string) => logLines.push(`info ${m}`),
  warn: (m: string) => logLines.push(`warn ${m}`),
  error: (m: string) => logLines.push(`error ${m}`),
  debug: (m: string) => logLines.push(`debug ${m}`),
  child: () => fakeLogger,
} as unknown as Logger;

/** 状态文件放临时目录：绝不能写生产状态，也不能让用例之间互相影响 */
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-watch-'));
let stateSeq = 0;

function makeConfig(over: Partial<AppConfig['import']['watch']> = {}): AppConfig {
  return {
    import: {
      scanDirs: [],
      maxDepth: 3,
      minSizeMB: 5,
      watch: {
        enabled: true,
        dirs: ['C:/fake/bilibili'],
        intervalSec: 60,
        stableSec: 30,
        requireDanmaku: false,
        importExisting: true,
        maxDepth: 3,
        minSizeMB: 5,
        ...over,
      },
    },
  } as unknown as AppConfig;
}

interface CandOverrides {
  sizeBytes?: number;
  importedBy?: { taskId: string; status: string };
  usable?: boolean;
  brokenReason?: string;
  possiblyRecording?: boolean;
  danmaPath?: string;
  hasDanmakuInPicture?: boolean;
  title?: string;
  /** 文件修改时间（毫秒）。默认「一小时前」；用来验「启用前就已存在」的判定 */
  mtimeMs?: number;
  /** 本场还有分段在写入（已闭合的那段照常导入） */
  pendingParts?: number;
  pendingFiles?: Array<{ fileName: string; sizeMB: number }>;
}

function cand(fileName: string, over: CandOverrides = {}): RecordingCandidate {
  return {
    videoPath: `C:/fake/bilibili/${fileName}`,
    fileName,
    group: '甲主播',
    sizeBytes: over.sizeBytes ?? 900 * 1024 ** 2,
    durationSec: 3600,
    title: over.title ?? fileName.replace(/\.[^.]+$/, ''),
    danmaSource: over.danmaPath ? 'sibling' : 'none',
    ...(over.danmaPath ? { danmaPath: over.danmaPath, danmaKind: 'xml' as const } : {}),
    titleSource: 'filename',
    hasDanmakuInPicture: over.hasDanmakuInPicture ?? false,
    usable: over.usable ?? true,
    ...(over.brokenReason ? { brokenReason: over.brokenReason } : {}),
    ...(over.importedBy ? { importedBy: over.importedBy } : {}),
    segmentCount: 1,
    source: 'scan',
    variants: [
      {
        videoPath: `C:/fake/bilibili/${fileName}`,
        fileName,
        sizeBytes: over.sizeBytes ?? 900 * 1024 ** 2,
        sizeMB: 900,
        hasDanmakuInPicture: over.hasDanmakuInPicture ?? false,
        mtimeMs: over.mtimeMs ?? Date.now() - 3600_000,
      },
    ],
    possiblyRecording: over.possiblyRecording ?? false,
    ...(over.pendingParts ? { pendingParts: over.pendingParts } : {}),
    ...(over.pendingFiles ? { pendingFiles: over.pendingFiles } : {}),
  };
}

interface Harness {
  importer: WatchImporter;
  imported: Array<{ videoPath: string; danmaPath?: string; title?: string }>;
  setCandidates: (list: RecordingCandidate[]) => void;
  scanOpts: () => Record<string, unknown>;
  setFail: (fn: ((input: { videoPath: string }) => void) | undefined) => void;
  advance: (ms: number) => void;
  /** 改变「本轮实际扫到的目录」——用来验扫描范围变化的处理 */
  setScanRoots: (roots: string[]) => void;
  /** 状态文件路径：用例可以直接读它、也可以在构造前先写一份老状态 */
  statePath: string;
  /** 测试起始时钟（毫秒），用来构造「早于/晚于启用时刻」的 mtime */
  startNow: number;
}

function makeHarness(
  initial: RecordingCandidate[],
  over: Partial<AppConfig['import']['watch']> = {},
  seedState?: unknown,
): Harness {
  let list = initial;
  let now = 1_700_000_000_000;
  let failFn: ((input: { videoPath: string }) => void) | undefined;
  const imported: Harness['imported'] = [];
  let lastOpts: Record<string, unknown> = {};
  let seq = 0;
  let scanRoots = ['C:/fake/bilibili'];
  const statePath = path.join(stateDir, `state-${++stateSeq}.json`);
  if (seedState !== undefined) fs.writeFileSync(statePath, JSON.stringify(seedState, null, 2));

  const importer = new WatchImporter({
    config: makeConfig(over),
    ledger: { listTasks: () => [] } as never,
    logger: fakeLogger,
    importFn: async (input) => {
      failFn?.(input);
      imported.push(input);
      seq++;
      return { id: `task-${seq}` };
    },
    listFn: (async (_cfg: AppConfig, opts: Record<string, unknown>) => {
      lastOpts = opts;
      return {
        candidates: list,
        scanRoots,
        detectedDirs: [],
        roomIds: [],
        historyTotal: 0,
        historyMissing: 0,
      } satisfies ListRecordingsResult;
    }) as unknown as typeof import('../src/recordings.ts').listRecordingsDetailed,
    now: () => now,
    statePath,
  });

  return {
    importer,
    imported,
    setCandidates: (l) => {
      list = l;
    },
    scanOpts: () => lastOpts,
    setFail: (fn) => {
      failFn = fn;
    },
    advance: (ms) => {
      now += ms;
    },
    setScanRoots: (roots) => {
      scanRoots = roots;
    },
    statePath,
    startNow: now,
  };
}

const pick = (outs: WatchImportOutcome[], fileName: string): WatchImportOutcome | undefined =>
  outs.find((o) => o.fileName === fileName);

async function main(): Promise<void> {
  console.log('\x1b[1m目录轮询自动导入验证\x1b[0m（注入替身，零网络、零费用）');
  console.log('─'.repeat(74));

  /* ================= 0. 首次启用：历史积压只登记不导入 ================= */
  section('0. 首次启用时目录里已有的积压 → 只登记基线，不导入（最贵的一个坑）');
  {
    logLines.length = 0;
    const backlog = Array.from({ length: 28 }, (_, i) => cand(`历史录播-${i}.flv`));
    const h = makeHarness(backlog, { importExisting: false });
    const first = await h.importer.scanOnce();
    eq('28 个历史文件一个都没导入（否则一次排 28 场转写）', h.imported.length, 0);
    eq('每个都给出了原因', first.filter((o) => o.skipped?.includes('首次启用时已存在')).length, 28);
    ok(
      logLines.some((l) => l.includes('不会自动导入')),
      '日志里明确说了"历史文件不会自动导入"',
      logLines.find((l) => l.includes('不会自动导入'))?.slice(0, 70),
    );

    // 第二轮：新录的一场出现了 → 首次见到，只登记体积，还不导
    h.setCandidates([...backlog, cand('新录的一场.flv')]);
    h.advance(31_000);
    await h.importer.scanOnce();
    eq('新文件第一次出现时不导（还没确认写完）', h.imported.length, 0);

    // 第三轮：体积连续两轮没变 → 导入，而且只导这一个
    h.advance(31_000);
    await h.importer.scanOnce();
    eq('体积稳定后导入新那场', h.imported.length, 1);
    eq('导入的正是新文件（历史积压仍不导）', h.imported[0]?.videoPath, 'C:/fake/bilibili/新录的一场.flv');

    // 历史文件体积变了（被重新录制/覆盖）→ 视为新文件
    h.setCandidates([...backlog.slice(1), cand('历史录播-0.flv', { sizeBytes: 950 * 1024 ** 2 })]);
    h.advance(31_000);
    await h.importer.scanOnce();
    h.advance(31_000);
    await h.importer.scanOnce();
    eq('历史文件体积变了（被重录）→ 视为新文件导入', h.imported.length, 2);

    // 明确要求导入历史积压时，基线不生效
    const eager = makeHarness([cand('历史.flv')], { importExisting: true });
    await eager.importer.scanOnce();
    eager.advance(31_000);
    await eager.importer.scanOnce();
    eq('importExisting=true 时历史文件照常导入', eager.imported.length, 1);
  }

  /* ================= 1. 稳定性：录制还在写不能导 ================= */
  section('1. 录制还在写 → 不导入（否则拿到半场素材）');
  {
    const h = makeHarness([cand('上半场.flv'), cand('写完的.flv')]);
    const first = await h.importer.scanOnce();
    eq('第一轮一个都不导（首次见到，体积还没稳定）', h.imported.length, 0);
    ok(
      pick(first, '写完的.flv')?.skipped?.includes('等下一轮') === true,
      '给出了"等下一轮确认写完"的原因',
      pick(first, '写完的.flv')?.skipped,
    );

    h.advance(31_000);
    const second = await h.importer.scanOnce();
    eq('稳定 31 秒后两个都导入', h.imported.length, 2);
    ok(second.every((o) => o.taskId), '每个候选都带上了任务 id');

    h.advance(60_000);
    h.setCandidates([cand('还在写.flv', { sizeBytes: 500 * 1024 ** 2 })]);
    await h.importer.scanOnce();
    h.setCandidates([cand('还在写.flv', { sizeBytes: 800 * 1024 ** 2 })]);
    h.advance(31_000);
    const third = await h.importer.scanOnce();
    eq('体积变大过（录制仍在进行）→ 不导入', h.imported.length, 2);
    ok(pick(third, '还在写.flv')?.skipped?.includes('等下一轮') === true, '原因是"等下一轮"', pick(third, '还在写.flv')?.skipped);
  }

  /* ================= 2. 台账已导入过 → 不重复花钱 ================= */
  section('2. 已导入过的文件不再导入（每次重复导入都要重花一次转写钱）');
  {
    const h = makeHarness([cand('导入过.flv', { importedBy: { taskId: 'manual-20260922-x', status: 'PUBLISHED' } })]);
    await h.importer.scanOnce();
    h.advance(31_000);
    const outs = await h.importer.scanOnce();
    eq('一次都没导入', h.imported.length, 0);
    ok(
      pick(outs, '导入过.flv')?.skipped?.includes('已导入过') === true,
      '原因是"已导入过"（含任务号，便于追溯）',
      pick(outs, '导入过.flv')?.skipped,
    );
  }

  /* ================= 3. 判重靠台账（跨重启有效） ================= */
  section('3. 判重靠台账（换新进程也不会重复导入）');
  {
    const h1 = makeHarness([cand('A.flv')]);
    await h1.importer.scanOnce();
    h1.advance(31_000);
    await h1.importer.scanOnce();
    eq('第一个进程导入了 1 个', h1.imported.length, 1);

    const h2 = makeHarness([cand('A.flv', { importedBy: { taskId: 'task-1', status: 'CLIPPING' } })]);
    h2.advance(31_000);
    await h2.importer.scanOnce();
    eq('新进程看到台账里有记录 → 不重复导入', h2.imported.length, 0);
  }

  /* ================= 4. 失败退避 ================= */
  section('4. 导入失败 → 退避，不再每轮重试');
  {
    const h = makeHarness([cand('坏的.flv')]);
    h.setFail(() => {
      throw new Error('源文件损坏：moov atom not found');
    });
    await h.importer.scanOnce();
    h.advance(31_000);
    const outs = await h.importer.scanOnce();
    eq('失败后没有留任务', h.imported.length, 0);
    ok(pick(outs, '坏的.flv')?.skipped?.includes('导入失败') === true, '原因里带上了失败信息', pick(outs, '坏的.flv')?.skipped);

    h.advance(60_000);
    const outs2 = await h.importer.scanOnce();
    ok(pick(outs2, '坏的.flv')?.skipped?.includes('退避中') === true, '退避窗口内不再重试', pick(outs2, '坏的.flv')?.skipped);

    h.setFail(undefined);
    h.advance(11 * 60_000);
    await h.importer.scanOnce();
    eq('退避结束后会重试（文件修好了就能导入）', h.imported.length, 1);
  }

  /* ================= 5. 仍在录制 / 文件不可用 ================= */
  section('5. 其他必须拦住的情况');
  {
    const h = makeHarness([
      cand('正在录.flv', { possiblyRecording: true }),
      cand('损坏.flv', { usable: false, brokenReason: 'moov atom not found' }),
    ]);
    await h.importer.scanOnce();
    h.advance(31_000);
    const outs = await h.importer.scanOnce();
    eq('两种都不导入', h.imported.length, 0);
    ok(pick(outs, '正在录.flv')?.skipped?.includes('仍在写入') === true, '录着的原因明确', pick(outs, '正在录.flv')?.skipped);
    ok(pick(outs, '损坏.flv')?.skipped?.includes('不可用') === true, '坏文件带上原因', pick(outs, '损坏.flv')?.skipped);
  }

  /* ================= 6. 弹幕要求 ================= */
  section('6. 弹幕：默认不强制，可配成必须');
  {
    const h = makeHarness([cand('没弹幕.flv')]);
    await h.importer.scanOnce();
    h.advance(31_000);
    const outs = await h.importer.scanOnce();
    eq('默认（requireDanmaku=false）没弹幕也导入', h.imported.length, 1);
    ok(Boolean(pick(outs, '没弹幕.flv')?.taskId), '任务已建');

    const strict = makeHarness([cand('没弹幕2.flv')], { requireDanmaku: true });
    await strict.importer.scanOnce();
    strict.advance(31_000);
    const outs2 = await strict.importer.scanOnce();
    eq('requireDanmaku=true 时跳过', strict.imported.length, 0);
    ok(pick(outs2, '没弹幕2.flv')?.skipped?.includes('弹幕') === true, '原因说清是缺弹幕', pick(outs2, '没弹幕2.flv')?.skipped);

    const withDanma = makeHarness([cand('有弹幕.flv', { danmaPath: 'C:/fake/bilibili/有弹幕.xml' })], { requireDanmaku: true });
    await withDanma.importer.scanOnce();
    withDanma.advance(31_000);
    await withDanma.importer.scanOnce();
    eq('有同名弹幕时正常导入', withDanma.imported.length, 1);
    eq('弹幕路径传给了导入', withDanma.imported[0]?.danmaPath, 'C:/fake/bilibili/有弹幕.xml');
  }

  /* ================= 7. 压制产物（已烧弹幕）要提醒 ================= */
  section('7. 「-弹幕版」压制产物：导入但明确提醒（避免双层弹幕）');
  {
    logLines.length = 0;
    const h = makeHarness([cand('录播-弹幕版.mp4', { hasDanmakuInPicture: true })]);
    await h.importer.scanOnce();
    h.advance(31_000);
    await h.importer.scanOnce();
    eq('仍然导入（它可以是唯一可用的源）', h.imported.length, 1);
    ok(
      logLines.some((l) => l.includes('已烧弹幕')),
      '日志里明确提醒了"画布已烧弹幕、本场不再叠 ASS"',
      logLines.find((l) => l.includes('已烧弹幕'))?.slice(0, 60),
    );
  }

  /* ================= 8. 扫描范围必须收敛 ================= */
  section('8. 扫描范围：只扫配置的目录，不叠加兜底目录');
  {
    const h = makeHarness([cand('A.flv')]);
    await h.importer.scanOnce();
    const opts = h.scanOpts();
    eq('关掉了兜底目录（否则每 60 秒扫一堆无关文件）', opts['includeFallbackDirs'], false);
    eq('关掉了 ffprobe 预检（探测留给真正导入那一步）', opts['probe'], false);
    eq('只扫 import.watch.dirs', JSON.stringify(opts['extraDirs']), JSON.stringify(['C:/fake/bilibili']));
    eq('递归深度取自 watch 配置', opts['maxDepth'], 3);
  }

  /* ================= 9. 状态与开关 ================= */
  section('9. 状态与开关');
  {
    const h = makeHarness([cand('A.flv')]);
    await h.importer.scanOnce();
    h.advance(31_000);
    await h.importer.scanOnce();
    const st = h.importer.status();
    eq('统计到已导入 1 个', st.importedTotal, 1);
    ok(st.lastScanAt !== undefined, '记录了最后扫描时间', st.lastScanAt);
    ok(st.lastOutcomes.length > 0, '状态里带上了最近一轮的结论（界面能展示"为什么不导"）');
    ok(st.enabled, '启用状态如实反映配置');

    const off = makeHarness([cand('A.flv')], { enabled: false });
    off.importer.start();
    const stOff = off.importer.status();
    eq('关闭时 start() 不扫（enabled=false 如实上报）', stOff.enabled, false);
    eq('关闭时不产生导入', off.imported.length, 0);
  }

  /* ================= 10. 启用时刻：与扫描范围无关的第二道闸 =================
   *
   * 实测事故（2026-09-23）：`extraDirs` 没被读 → 轮询那一路扫描根全空、只拿到录制历史，
   * 于是基线只登记了 13 个历史条目。修好扫描范围后，盘上**所有**历史文件（09-13、09-20 的）
   * 都成了"没见过的候选"而被导入 —— 正是 importExisting=false 想避免的事。
   * 本条用例锁死：**mtime 早于启用时刻的文件，不管基线里有没有，都不算新文件**。 */
  section('10. 启用时刻判定：mtime 早于启用时刻 → 算历史积压（不依赖基线是否完整）');
  {
    const T0 = 1_700_000_000_000; // 与 harness 的起始时钟一致
    const T0Iso = new Date(T0).toISOString();
    /* 模拟「坏基线」老状态：只有一条录制历史条目、且没有 startedAt 字段（升级前的形态） */
    const legacyState = {
      version: 1,
      lastScanAt: T0Iso,
      imported: {},
      baseline: { 'C:/fake/bilibili/历史条目.flv': { at: T0Iso, sizeBytes: 900 * 1024 ** 2 } },
    };
    const oldFile = cand('09-13 的老录播.flv', { mtimeMs: T0 - 10 * 86_400_000 });
    const newFile = cand('刚录完的一场.flv', { mtimeMs: T0 + 60_000 });
    const h = makeHarness([oldFile, newFile], { importExisting: false }, legacyState);

    const first = await h.importer.scanOnce();
    eq('老文件没有被导入（坏基线不再导致全量导入）', h.imported.length, 0);
    ok(
      pick(first, '09-13 的老录播.flv')?.skipped?.includes('轮询启用之前就已存在') === true,
      '老文件给的原因是「轮询启用之前就已存在」（含修改时间，便于核对）',
      pick(first, '09-13 的老录播.flv')?.skipped,
    );
    ok(
      pick(first, '刚录完的一场.flv')?.skipped?.includes('等下一轮') === true,
      '新文件不受影响（照常进入稳定性判定，没有过度拦截）',
      pick(first, '刚录完的一场.flv')?.skipped,
    );

    h.advance(31_000);
    await h.importer.scanOnce();
    eq('第二轮只导入了新录的那一场', h.imported.length, 1);
    eq('导入的正是新文件', h.imported[0]?.videoPath, 'C:/fake/bilibili/刚录完的一场.flv');

    /* 老文件被补登记进基线 + 启用时刻落盘（否则下次重启又会算一遍） */
    const st = JSON.parse(fs.readFileSync(h.statePath, 'utf8')) as {
      startedAt?: string;
      baseline?: Record<string, { at: string }>;
    };
    ok(st.startedAt === T0Iso, '状态里落盘了 startedAt（重启后判据不变）', st.startedAt);
    ok(
      st.baseline?.['C:/fake/bilibili/09-13 的老录播.flv'] !== undefined,
      '老文件被补登记进基线（下一轮不再重复计算）',
    );
    ok(st.baseline?.['C:/fake/bilibili/历史条目.flv'] !== undefined, '原有基线条目没被清掉');

    /* importExisting=true 时这道闸也要让路（用户明确要求导入积压） */
    const eager = makeHarness([cand('老文件.flv', { mtimeMs: T0 - 86_400_000 })], { importExisting: true });
    await eager.importer.scanOnce();
    eager.advance(31_000);
    await eager.importer.scanOnce();
    eq('importExisting=true 时老文件照常导入', eager.imported.length, 1);
  }

  /* ================= 11. 扫描范围变化 → 重新登记基线 ================= */
  section('11. 扫描范围变化 → 重新登记基线，而不是把新范围内的积压导一遍');
  {
    const T0 = 1_700_000_000_000;
    const h = makeHarness([cand('A.flv', { mtimeMs: T0 - 86_400_000 })], { importExisting: false });
    /* 第一轮把范围记下来（此时 lastScanRoots 从无到有，不算"变化"） */
    await h.importer.scanOnce();
    const afterFirst = JSON.parse(fs.readFileSync(h.statePath, 'utf8')) as { lastScanRoots?: string };
    eq('记下了本轮实际扫描根', afterFirst.lastScanRoots, 'c:/fake/bilibili');

    /* 用户加了新目录（或我们把 extraDirs 修好）→ 范围变了 */
    logLines.length = 0;
    h.setScanRoots(['C:/fake/bilibili', 'C:/fake/new-dir']);
    h.setCandidates([cand('A.flv', { mtimeMs: T0 - 86_400_000 }), cand('新目录里的老录播.flv', { mtimeMs: T0 - 86_400_000 })]);
    h.advance(60_000);
    const outs = await h.importer.scanOnce();
    eq('范围变化后一个都不导入（新目录里的老文件也不算新录播）', h.imported.length, 0);
    eq('每个候选都说明是"重新登记基线"', outs.filter((o) => o.skipped?.includes('扫描范围变化')).length, 2);
    ok(
      logLines.some((l) => l.includes('扫描范围发生变化')),
      '日志里明确提示范围变了、本轮不导入（用户知道要去手动导入）',
      logLines.find((l) => l.includes('扫描范围发生变化'))?.slice(0, 80),
    );
    const afterChange = JSON.parse(fs.readFileSync(h.statePath, 'utf8')) as {
      lastScanRoots?: string;
      baseline?: Record<string, unknown>;
    };
    eq('新的扫描根被记下', afterChange.lastScanRoots, 'c:/fake/bilibili|c:/fake/new-dir');
    ok(afterChange.baseline?.['C:/fake/bilibili/新目录里的老录播.flv'] !== undefined, '新范围内的文件进了基线');

    /* 范围稳定后，真正新录的照常导入 */
    h.setCandidates([cand('范围稳定后新录的.flv', { mtimeMs: T0 + 120_000 })]);
    h.advance(31_000);
    await h.importer.scanOnce();
    h.advance(31_000);
    await h.importer.scanOnce();
    eq('范围稳定后新录的照常自动导入', h.imported.length, 1);
    eq('导入的正是它', h.imported[0]?.videoPath, 'C:/fake/bilibili/范围稳定后新录的.flv');
  }

  /* ====== 12. 「本场还有分段在写入」必须报出去（哪怕这一段已经导入） ======
   *
   * 实测（2026-09-24 晚）：把新鲜度判定改成按文件之后，已闭合的分段能导入了，
   * 但监控面板的「正在录制」整块消失 —— 因为那块是从"因仍在写入而被跳过"的行拼出来的，
   * 而新逻辑下这个候选已经能导入、不再产生那种跳过行。用户当场问「为什么现在不显示还在录制了」。
   * 这里锁死：成功导入的行也要带上 pendingFiles，界面才有东西可显示。 */
  section('12. 成功导入的候选也要带上"本场还有 N 段在写入"');
  {
    /* ⚠️ 两个坑（都踩过）：
       ① `makeHarness` **不要**显式传 `importExisting:false` —— 那样首轮扫描会把文件登记成
          "启用前已存在"的基线，第二轮就被 `base0` 闸拦下（那是 §10 专门验的另一条规则）；
       ② 本文件的 `ok` 是 `(cond, msg, extra)` 顺序（与 recordings.ts 的 `(name, cond)` 相反）。 */
    const h = makeHarness([
      cand('我来了.ts', {
        pendingParts: 1,
        pendingFiles: [{ fileName: '我来了-PART002.ts', sizeMB: 1076 }],
      }),
    ]);
    await h.importer.scanOnce();
    h.advance(31_000);
    const outs = await h.importer.scanOnce();
    eq('已闭合的那段照常导入', h.imported.length, 1);
    const row = outs.find((o) => o.taskId) ?? outs[0];
    eq('导入了这一行', Boolean(row?.taskId), true);
    eq('这一行带上了 pendingParts', row?.pendingParts, 1);
    eq('这一行带上了还在写的文件名（界面据此显示"正在录制"）', row?.pendingFiles?.[0]?.fileName, '我来了-PART002.ts');
    ok(!row?.skipped, '这一行没有被标成"仍在写入"（它确实导入成功了）', String(row?.skipped));

    /* 整场都还没写稳时，仍然是原来的"仍在写入"跳过语义（不能因为这次改动而丢掉） */
    const h2 = makeHarness([cand('全在录.ts', { possiblyRecording: true })]);
    await h2.importer.scanOnce();
    const outs2 = await h2.importer.scanOnce();
    ok(outs2[0]?.skipped?.includes('仍在写入') === true, '整场都在录时照旧跳过并说明原因', String(outs2[0]?.skipped));
    eq('并且把它标成 possiblyRecording（界面据此显示"正在录制"）', outs2[0]?.possiblyRecording, true);
  }

  console.log('\n' + '─'.repeat(74));
  console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  try {
    fs.rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响结论 */
  }
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('\x1b[31m验证异常：\x1b[0m', e instanceof Error ? e.message : e);
  try {
    fs.rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
