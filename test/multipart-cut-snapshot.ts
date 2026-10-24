/**
 * 回归测试：`publishMultiPartStage` 在切片**之后**必须能拿到切片的 `cutOutput`。
 *
 * 真实事故（2026-09-23，30 分钟真实录播全流程验证）：
 *   6 个切片全部切片成功（日志"切片产出完成"6 条、台账里 status=CUT 且 cutOutput 都在、
 *   mp4 也确实在磁盘上），但紧接着多分P 投稿报「没有任何可投稿的文件（完整版与切片都不可用）」
 *   —— **一个分P 都没投出去**，而且没报错、任务停回 ANALYZED。
 *
 * 根因是**台账对象在切片过程中脱钩**：
 *   `publishMultiPartStage` 在切片前取 `selected = ledger.getClips(...).filter(selected)`；
 *   而 ledger 的 `clipsArray()` 有一条「clips.json 的 mtime 比我们上次写它的时间新 ⇒ 重新读文件
 *   并**重建整个切片数组**」的规则（本意是跟上 analyze.ts 绕过 ledger 直接改文件的情况）。
 *   切片阶段会写 clips.json，于是这条规则被触发、`rec.clips` 被换成一批**新对象**——
 *   切片前拿到的那些旧对象再也不会被写入 `cutOutput`，`parts` 因此为空。
 *
 * 本测试用**真实 Ledger + 真实 Publisher**（假 client），并且**故意触发**上述重建规则，
 * 确保修复（逐个 `getClip(index)` 重读）在任何时候都能拿到产物。
 *
 * 运行：node --experimental-strip-types test/multipart-cut-snapshot.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';
import { Publisher } from '../src/publish.ts';
import { loadConfig } from '../src/config.ts';
import type { TaskRecord } from '../src/types.ts';

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

const TASK_ID = 'snap-0001';

async function main(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-snapreg-'));
  const dataDir = path.join(tmpRoot, 'data');
  const taskDir = path.join(dataDir, 'tasks', TASK_ID);
  const clipsDir = path.join(dataDir, 'clips', TASK_ID);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(clipsDir, { recursive: true });

  const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json') });
  ledger.createTask({
    id: TASK_ID,
    roomId: '12345678',
    title: '多分P 切片快照回归',
    stage: 'ANALYZED',
    source: { segments: [], totalDuration: 1800, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: new Date().toISOString() },
    transcriptPath: path.join(taskDir, 'transcript.json'),
    signalsPath: path.join(taskDir, 'signals.json'),
    clipsPath: path.join(taskDir, 'clips.json'),
  });
  ledger.setClips(TASK_ID, [0, 1, 2].map((i) => ({
    index: i,
    start: 100 + i * 300,
    end: 200 + i * 300,
    title: `片段${i + 1}`,
    desc: '',
    tags: ['测试'],
    category: '生活',
    score: 8,
    selected: true,
    status: 'CANDIDATE' as const,
  })) as never);

  /* ---- 复刻 publishMultiPartStage 的取法：切片**之前**取快照 ---- */
  section('1. 切片前取 selected 快照（复刻 publishMultiPartStage 的取法）');
  const selectedBeforeCut = ledger.getClips(TASK_ID).filter((c) => c.selected);
  ok('快照有 3 个切片', selectedBeforeCut.length === 3, `实际 ${selectedBeforeCut.length}`);
  ok('快照里还没有 cutOutput（切片尚未发生）', selectedBeforeCut.every((c) => !c.cutOutput));

  /* ---- 模拟切片过程：写产物 + 写台账 ---- */
  section('2. 模拟切片：为每个切片写入 cutOutput');
  for (let i = 0; i < 3; i++) {
    /* ★ 必须写**绝对路径**：真实链路里 `cutAndUploadClip` 产出的是绝对路径
       （`outDir = absPath(cfg.clip.outputDir + taskId)`），而 `exists()` 是按进程 cwd
       解析相对路径的 —— 测试进程的 cwd 不是临时目录，用相对路径会得到假阴性。
       第一版就踩了这个：台账里明明有值，`exists()` 却全 false，看起来像"修不好"。 */
    const out = path.resolve(clipsDir, `0${i + 1}-片段${i + 1}.mp4`);
    fs.writeFileSync(out, 'x');
    ledger.setClipStatus(TASK_ID, i, 'CUT', { cutOutput: out });
  }
  const afterCut = ledger.getClips(TASK_ID);
  ok('台账里 3 个切片都有 cutOutput 且文件存在', afterCut.filter((c) => c.cutOutput && fs.existsSync(c.cutOutput)).length === 3);

  /* ★ 关键：把 clips.json 的 mtime 推到未来，强制 `clipsArray()` 认为"clips.json 被外部改过"
     并**重新读文件、重建整个切片数组**（ledger.ts 里那条规则的本意是跟上 analyze.ts
     绕过 ledger 直接重写 clips.json 的情况）。切片阶段会写这个文件，真实场景里这条规则
     完全可能被触发 —— 一旦触发，切片前拿到的对象引用就与台账脱钩。 */
  const clipsFile = path.join(taskDir, 'clips.json');
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(clipsFile, future, future);
  const afterRebuild = ledger.getClips(TASK_ID);
  ok('重建后台账里 3 个切片仍有 cutOutput（数据没丢）', afterRebuild.filter((c) => c.cutOutput).length === 3);
  ok(
    '重建后台账里的对象**不再是**切片前那批（引用脱钩已发生）',
    afterRebuild[0] !== selectedBeforeCut[0],
    `same=${String(afterRebuild[0] === selectedBeforeCut[0])}`,
  );

  /* ---- 用修复后的做法（逐个 getClip 重读）取列表 ---- */
  section('3. 修复做法：逐个 getClip(index) 重读');
  const selectedAfterCut = selectedBeforeCut
    .map((c) => ledger.getClip(TASK_ID, c.index))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));
  ok('重读后拿到 3 个切片', selectedAfterCut.length === 3, `实际 ${selectedAfterCut.length}`);
  const withOut = selectedAfterCut.filter((c) => c.cutOutput && fs.existsSync(c.cutOutput));
  ok('★ 重读后 3 个切片都能投（有 cutOutput 且文件存在）', withOut.length === 3, `实际 ${withOut.length}`);

  /* ---- 用重读后的列表走真实 publishAsMultiPart（假 client）---- */
  section('4. 用重读后的列表跑 publishAsMultiPart（验证 parts 不再为空）');
  const realCfg = loadConfig(path.join(process.cwd(), 'config.json')).config;
  const cfg = { ...realCfg, publish: { ...realCfg.publish, multiPart: true, resumeAid: '' } };
  const uploads: Array<Record<string, unknown>> = [];
  const publisher = new Publisher({
    client: {
      biliArchives: async (): Promise<unknown[]> => [],
      /* ⚠️ `publishAsMultiPart` 开头要 `ensureAnchorUid`（按房间号查主播 UID），
         桩缺这个方法会直接抛 TypeError（既有桩的缺口，与本套件要验的事无关） */
      anchorInfoByRoom: async (): Promise<{ uid: string; name: string }> => ({ uid: '12345', name: '测试主播' }),
      biliUpload: async (p: Record<string, unknown>): Promise<{ taskId: string }> => {
        uploads.push(p);
        return { taskId: `upload-${uploads.length}` };
      },
    } as never,
    config: cfg,
    ledger,
    logger: silentLog as never,
  });

  const res = await publisher.publishAsMultiPart({
    task: ledger.getTask(TASK_ID) as TaskRecord,
    uid: 1,
    clips: selectedAfterCut,
    logger: silentLog as never,
  });
  ok('★ 不再报「没有任何可投稿的文件」', res.ok === true, `ok=${String(res.ok)} error=${String(res.error)}`);
  ok('投出了 3 个切片分P', res.parts.filter((p) => p.kind === 'clip').length === 3, `实际 ${res.parts.length}`);

  /* ---- 反证：如果用那份过期快照，就会复现事故 ---- */
  section('5. 反证：用过期快照就会复现事故（证明这个测试真的能抓住 bug）');
  const uploads2: Array<Record<string, unknown>> = [];
  const publisher2 = new Publisher({
    client: {
      biliArchives: async (): Promise<unknown[]> => [],
      biliUpload: async (p: Record<string, unknown>): Promise<{ taskId: string }> => {
        uploads2.push(p);
        return { taskId: `up-${uploads2.length}` };
      },
    } as never,
    config: cfg,
    ledger,
    logger: silentLog as never,
  });
  /* 造一份"切片前"的对象：把 cutOutput 抹掉，模拟旧快照 */
  const stale = selectedAfterCut.map((c) => ({ ...c, cutOutput: undefined }));
  const res2 = await publisher2.publishAsMultiPart({
    task: ledger.getTask(TASK_ID) as TaskRecord,
    uid: 1,
    clips: stale as never,
    logger: silentLog as never,
  });
  ok('过期快照确实导致 ok=false', res2.ok === false, `ok=${String(res2.ok)}`);
  ok(
    '过期快照的报错正是「没有任何可投稿的文件」',
    String(res2.error ?? '').includes('没有任何可投稿的文件'),
    String(res2.error ?? '(无 error)'),
  );
  ok('过期快照下一个分P 都没投', res2.parts.length === 0, `实际 ${res2.parts.length}`);

  /* ==========================================================================
   * 6. 追加失败要**如实说**：biliLive-tools 报错时不能含糊成"待确认"
   *    （2026-10-10 用户问「这是投稿了吗」—— 那条静默躺在「已提交待确认」半小时，
   *      原因就是旧代码无论任务成功/失败/还在跑，都只报同一句"任务已完成、B站 侧还没查到"）
   * ======================================================================== */
  section('6. 追加被 biliLive-tools 判错 → 标 FAILED 并写清原因');
  {
    const cfgResume = { ...realCfg, publish: { ...realCfg.publish, multiPart: true, resumeAid: '117000000000001' } };
    const dataDir2 = path.join(tmpRoot, 'fail');
    const taskId2 = 'mp-fail-0001';
    const clipsDir2 = path.join(dataDir2, 'clips', taskId2);
    fs.mkdirSync(clipsDir2, { recursive: true });
    const ledger2 = new Ledger({ path: path.join(dataDir2, 'ledger.json') });
    ledger2.createTask({
      id: taskId2,
      roomId: '12345678',
      title: '追加失败回归',
      stage: 'ANALYZED',
      source: { segments: [], totalDuration: 600, rawFiles: [], fullVideoHasDanmaku: false },
      fullUpload: 'NOT_APPLICABLE',
      cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: new Date().toISOString() },
    });
    const outFile = path.resolve(clipsDir2, '01-待追加.mp4');
    fs.writeFileSync(outFile, 'x');
    ledger2.setClips(taskId2, [
      {
        index: 0,
        start: 10,
        end: 70,
        title: '待追加的切片',
        desc: '',
        tags: ['测试'],
        category: '生活',
        score: 8,
        selected: true,
        status: 'CUT' as const,
        cutOutput: outFile,
      },
    ] as never);

    const publisher3 = new Publisher({
      client: {
        biliArchives: async (): Promise<unknown[]> => [],
        /* `publishAsMultiPart` 开头要 `ensureAnchorUid`（既有桩的缺口，补齐才能跑到投稿逻辑） */
        anchorInfoByRoom: async (): Promise<{ uid: string; name: string }> => ({ uid: '12345', name: '测试主播' }),
        /* 续传目标稿件的分P 列表里**始终没有**这条标题 ⇒ 落地确认必然失败 */
        biliArchiveDetail: async (): Promise<unknown> => ({
          View: { bvid: 'BV1FAIL00001', videos: 1, pages: [{ part: '完整版', duration: 10 }] },
        }),
        biliUpload: async (): Promise<{ taskId: string }> => ({ taskId: 'up-fail-1' }),
        /* ★ 关键：对方明确报错 —— 旧代码不看这个字段，照样写"任务已完成" */
        taskDetail: async (): Promise<unknown> => ({ status: 'error', error: '稿件已被锁定，无法追加分P' }),
      } as never,
      config: cfgResume,
      ledger: ledger2,
      logger: silentLog as never,
    });

    const r3 = await publisher3.publishAsMultiPart({
      task: ledger2.getTask(taskId2) as TaskRecord,
      uid: 1,
      clips: ledger2.getClips(taskId2),
      resumeAid: '117000000000001',
      resumeBvid: 'BV1FAIL00001',
      logger: silentLog as never,
    });
    ok('★ 任务报错 ⇒ ok=false（不再含糊成「已提交待确认」）', r3.ok === false, JSON.stringify({ ok: r3.ok, error: r3.error }).slice(0, 200));
    ok('错误里带上对方原文（人/自动重跑才有依据）', String(r3.error ?? '').includes('稿件已被锁定'), String(r3.error ?? '(无)'));
    const c3 = ledger2.getClip(taskId2, 0);
    ok('★ 切片状态是 FAILED（不是 SUBMITTED）', c3?.status === 'FAILED', `实际 ${String(c3?.status)}`);
    ok('failReason 写清了原因', String(c3?.failReason ?? '').includes('稿件已被锁定'), String(c3?.failReason ?? '(空)'));
  }

  console.log(`\n\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (failures.length) {
    console.log('\x1b[31m失败项：\x1b[0m');
    for (const f of failures) console.log(`  - ${f}`);
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

await main();
