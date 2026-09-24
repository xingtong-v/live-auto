/**
 * 幂等指纹的**墓碑**自测 —— 锁住「删任务/删切片不会导致 B站 上出现重复稿件」。
 *
 * ## 漏洞是什么（2026-09-24 对照任务书做差距分析时发现）
 *
 * 去重的唯一本地依据是 `ledger.fingerprints`，而 `deleteTask()` / `deleteClip()` 原本会
 * **直接删掉**相关条目，理由写在当时的注释里：「避免以后重跑被误判为已投过而静默少投一稿」。
 * 这个理由对**没投出去过**的切片是对的，对**已经投出去过**的切片是错的：
 *
 *   1. 用户删掉一个已投稿件的任务（`deleteTaskDir=true`）；
 *   2. 同一份录播素材仍在监听目录里（或用户手动重新导入）；
 *   3. 重新转写 + 重新分析，LLM 很可能给出**同样的时间区间**；
 *   4. `findFingerprint` 查不到 → 本地去重整条穿透；
 *   5. B站 侧那道「按标题反查」也拦不住 —— 切片标题是 LLM 每次重新生成的，换个措辞即穿透。
 *
 *   净结果：B站 上出现第二个内容完全相同的稿件，而 B站 没有删除稿件的开放接口。
 *
 * ## 修复后的语义（本测试逐条锁住）
 *
 * | 情形 | 指纹 | 能否重投 |
 * |---|---|---|
 * | 删掉**没投过**的切片 / 任务 | 直接丢弃 | ✅ 可以（这是原来的正确行为，不能被墓碑误伤）|
 * | 删掉**已投过**的切片 / 任务 | 转为墓碑 | ❌ 被拦，UI 显示原因并可人工解除 |
 *
 * `SUBMITTING`（请求已发出、没等到响应就崩了）算「投过」是**故意保守**：
 * 无法确定那一次成没成，宁可少投一票也不能重复投。
 *
 * 运行：node --experimental-strip-types test/fingerprint-tombstone.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger, clipFingerprint } from '../src/ledger.ts';
import { Publisher } from '../src/publish.ts';
import { loadConfig } from '../src/config.ts';
import type { ClipRecord, TaskRecord } from '../src/types.ts';

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
function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-tomb-'));
const now = new Date().toISOString();

function mkClip(index: number, over: Partial<ClipRecord> = {}): ClipRecord {
  return {
    index,
    start: index * 100,
    end: index * 100 + 60,
    title: `切片 ${index}`,
    desc: '',
    tags: ['直播切片'],
    category: '游戏/单机游戏',
    score: 8,
    reason: '测试',
    selected: true,
    status: 'CANDIDATE',
    degraded: false,
    createdAt: now,
    ...over,
  } as ClipRecord;
}

function makeLedger(name: string): Ledger {
  fs.mkdirSync(path.join(tmp, name), { recursive: true });
  return new Ledger({ path: path.join(tmp, name, 'ledger.json') });
}

function mkTask(ledger: Ledger, taskId: string, title: string): void {
  ledger.createTask({
    id: taskId,
    roomId: '12345678',
    platform: 'Bilibili',
    recordingId: 'rec-45678901-0930',
    title,
    status: 'CLIPPED',
    stage: 'CLIPPED',
    source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: now },
    createdAt: now,
    updatedAt: now,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as never);
}

/* ========================================================================== */
section('① 回归保护：删掉**没投过**的切片，指纹照旧直接丢弃、可以重投');
{
  const ledger = makeLedger('a');
  const id = 'tomb-a';
  mkTask(ledger, id, '没投过的场次');
  ledger.setClips(id, [mkClip(0), mkClip(1), mkClip(2)]);
  ledger.registerFingerprint('fp-unpublished-1', { taskId: id, clipIndex: 1 });
  ledger.registerFingerprint('fp-unpublished-2', { taskId: id, clipIndex: 2 });

  const r = ledger.deleteClip(id, 1);
  eq('丢弃 1 条未投过的指纹', r?.fingerprintsRemoved, 1);
  eq('**没有**立碑（否则会误伤"删掉不满意候选后重投"这个正常用法）', r?.fingerprintsTombstoned, 0);
  eq('该指纹已彻底移除（重切后能正常投）', ledger.findFingerprint('fp-unpublished-1'), undefined);
  eq('没有产生任何墓碑', ledger.tombstoneCount(), 0);
  ok('别的切片的指纹没被误删', ledger.findFingerprint('fp-unpublished-2') !== undefined);
}

/* ========================================================================== */
section('② 漏洞复现与封堵：删掉**已发布**的切片 → 立碑，同一区间不能再投');
{
  const ledger = makeLedger('b');
  const id = 'tomb-b';
  mkTask(ledger, id, '已发布的场次');
  ledger.setClips(id, [mkClip(0, { status: 'PUBLISHED', bvid: 'BV1TOMB00001' }), mkClip(1)]);
  ledger.registerFingerprint('fp-published-1', { taskId: id, clipIndex: 0, bvid: 'BV1TOMB00001' });

  const r = ledger.deleteClip(id, 0);
  eq('丢弃 0 条（这条投过，不能丢）', r?.fingerprintsRemoved, 0);
  eq('立碑 1 条', r?.fingerprintsTombstoned, 1);

  /* 这一行就是漏洞本身：本地"生效指纹"确实没了 —— 以前到这里就再无任何本地记录 */
  eq('生效指纹已退役（这就是原来会漏的那一步）', ledger.findFingerprint('fp-published-1'), undefined);

  const t = ledger.findTombstone('fp-published-1');
  ok('★ 但墓碑接管了：仍然拦得住', t !== undefined);
  eq('墓碑记住了 bvid（界面可直接给出核对入口）', t?.bvid, 'BV1TOMB00001');
  eq('墓碑记住了原因', t?.reason, 'clip-deleted');
  eq('墓碑记住了原任务', t?.taskId, id);
  eq('墓碑记住了原标题', t?.title, '切片 0');
  eq('墓碑计数 1', ledger.tombstoneCount(), 1);

  /* 落盘：崩溃/重启后墓碑不能"复活成可以重投" */
  const reopened = new Ledger({ path: path.join(tmp, 'b', 'ledger.json') });
  eq('重开台账后墓碑仍在', reopened.tombstoneCount(), 1);
  ok('重开台账后仍能查到', reopened.findTombstone('fp-published-1') !== undefined);
}

/* ========================================================================== */
section('③ SUBMITTING 也算投过（崩溃判定点，故意保守）');
{
  const ledger = makeLedger('c');
  const id = 'tomb-c';
  mkTask(ledger, id, '崩溃在提交中的场次');
  // SUBMITTING：请求已发出、没拿到 taskId 就崩了 —— 无法确定成没成
  ledger.setClips(id, [mkClip(0, { status: 'SUBMITTING' })]);
  ledger.registerFingerprint('fp-submitting', { taskId: id, clipIndex: 0 });

  const r = ledger.deleteClip(id, 0);
  eq('★ SUBMITTING 的指纹也立碑（宁可不投，不可重复投）', r?.fingerprintsTombstoned, 1);
  eq('墓碑记下了当时的状态', ledger.findTombstone('fp-submitting')?.status, 'SUBMITTING');
  eq('没有 bvid 也不影响拦截', ledger.findTombstone('fp-submitting')?.bvid, undefined);
}

/* ========================================================================== */
section('④ 删任务：已投的立碑 + 标题继续占用；未投的全部释放');
{
  const ledger = makeLedger('d');
  const id = 'tomb-d';
  const title = '墓碑测试场 2026-09-24';
  mkTask(ledger, id, title);
  ledger.setClips(id, [
    mkClip(0, { status: 'PUBLISHED', bvid: 'BV1TOMB00002' }),
    mkClip(1, { status: 'CUT' }),
  ]);
  ledger.registerFingerprint('fp-d-pub', { taskId: id, clipIndex: 0, bvid: 'BV1TOMB00002' });
  ledger.registerFingerprint('fp-d-unpub', { taskId: id, clipIndex: 1 });
  ledger.rememberPublishedTitle(title);

  const r = ledger.deleteTask(id);
  ok('任务已删除', r.deleted);
  eq('丢弃 1 条未投过的', r.freedFingerprints, 1);
  eq('立碑 1 条已投过的', r.tombstonedFingerprints, 1);
  ok('已投的指纹转为墓碑', ledger.findTombstone('fp-d-pub') !== undefined);
  eq('未投的指纹彻底消失（不立碑）', ledger.findTombstone('fp-d-unpub'), undefined);
  ok('任务记录已移除', ledger.getTask(id) === undefined);
  ok(
    '★ 标题**继续占用**（B站 上那个稿件还在，忘掉标题只会削弱按标题反查这道防线）',
    ledger.hasPublishedTitle(title),
  );
}

/* ========================================================================== */
section('⑤ 删任务但一片都没投过：标题也要释放（不能把没投过的标题永久占住）');
{
  const ledger = makeLedger('e');
  const id = 'tomb-e';
  const title = '全是候选的场次 2026-09-24';
  mkTask(ledger, id, title);
  ledger.setClips(id, [mkClip(0, { status: 'CUT' }), mkClip(1, { status: 'CANDIDATE' })]);
  ledger.registerFingerprint('fp-e-1', { taskId: id, clipIndex: 0 });
  ledger.registerFingerprint('fp-e-2', { taskId: id, clipIndex: 1 });
  ledger.rememberPublishedTitle(title);

  const r = ledger.deleteTask(id);
  eq('两条指纹全部丢弃', r.freedFingerprints, 2);
  eq('一条墓碑都没产生', r.tombstonedFingerprints, 0);
  eq('墓碑总数 0', ledger.tombstoneCount(), 0);
  ok('★ 标题已释放（可以重新用这个标题投稿）', !ledger.hasPublishedTitle(title));
}

/* ========================================================================== */
section('⑥ 人工解除墓碑：解除后可以重投，并在 publish-log 留痕');
{
  const ledger = makeLedger('f');
  const id = 'tomb-f';
  mkTask(ledger, id, '解除墓碑的场次');
  ledger.setClips(id, [mkClip(0, { status: 'PUBLISHED', bvid: 'BV1TOMB00003' })]);
  ledger.registerFingerprint('fp-f', { taskId: id, clipIndex: 0, bvid: 'BV1TOMB00003' });
  ledger.deleteTask(id);
  eq('先确认墓碑在', ledger.tombstoneCount(), 1);

  ok('解除不存在的指纹 → 明确失败（不是静默成功）', ledger.releaseTombstone('fp-nope').ok === false);

  const rel = ledger.releaseTombstone('fp-f', { note: '旧稿件已删除' });
  ok('解除成功', rel.ok);
  eq('返回被解除的墓碑（含 bvid，便于界面回显）', rel.released?.bvid, 'BV1TOMB00003');
  eq('墓碑已消失', ledger.tombstoneCount(), 0);
  eq('解除后不再是墓碑 → 可以重投', ledger.findTombstone('fp-f'), undefined);

  /* 解除必须**同时摘掉切片上的历史标记**。不摘的话界面还会挂着「🪦 墓碑拦截」
     的说明和按钮，用户会以为解除没生效（真机实测就是这个现象）。 */
  {
    const dir = path.join(tmp, 'f2');
    fs.mkdirSync(dir, { recursive: true });
    const lg2 = new Ledger({ path: path.join(dir, 'ledger.json') });
    mkTask(lg2, 'tomb-f2', '解除后标记要清掉的场次');
    lg2.setClips('tomb-f2', [mkClip(0, { status: 'PUBLISHED', bvid: 'BV1TOMB00009' })]);
    lg2.registerFingerprint('fp-f2', { taskId: 'tomb-f2', clipIndex: 0, bvid: 'BV1TOMB00009' });
    lg2.deleteTask('tomb-f2');
    mkTask(lg2, 'tomb-f2b', '重新导入后的场次');
    lg2.setClips('tomb-f2b', [mkClip(0, { status: 'PUBLISHED', bvid: 'BV1TOMB00009', fingerprint: 'fp-f2', blockedByTombstone: 'fp-f2' })]);
    eq('拦截标记已写上', lg2.getClip('tomb-f2b', 0)?.blockedByTombstone, 'fp-f2');

    const rel2 = lg2.releaseTombstone('fp-f2', { note: '测试' });
    eq('解除时报告清了几个切片的标记', rel2.clearedClips, 1);
    eq('★ 切片上的拦截标记被摘掉了（界面才会跟着消失）', lg2.getClip('tomb-f2b', 0)?.blockedByTombstone, undefined);
    ok('其它字段没被动（标题/状态/bvid 原样）', lg2.getClip('tomb-f2b', 0)?.title === '切片 0' && lg2.getClip('tomb-f2b', 0)?.bvid === 'BV1TOMB00009');

    const again2 = new Ledger({ path: path.join(dir, 'ledger.json') });
    eq('落盘后标记仍是清掉的（不是只在内存里）', again2.getClip('tomb-f2b', 0)?.blockedByTombstone, undefined);
  }

  const rows = ledger.readPublishLog({ limit: 10 }).filter((x) => x['action'] === 'tombstone-release');
  eq('publish-log 里留了一条解除记录（事后可查"为什么又投了一遍"）', rows.length, 1);
  eq('留痕带上了原因备注', rows[0]?.['note'], '旧稿件已删除');
  ok(
    '解除**不能**被当成一次投稿（否则"本场已投几次"的提醒会数错）',
    ledger.readPublishLog({ limit: 10 }).filter((x) => x['action'] === 'submit' || x['action'] === 'confirm').length === 0,
  );
}

/* ========================================================================== */
section('⑦ 向后兼容：老 ledger.json（没有 tombstones 字段）不能被判成损坏');
{
  const dir = path.join(tmp, 'g');
  fs.mkdirSync(dir, { recursive: true });
  const ledgerPath = path.join(dir, 'ledger.json');
  /* 完全按升级前的格式手写：只有 version/updatedAt/tasks/fingerprints/publishedTitles */
  fs.writeFileSync(
    ledgerPath,
    JSON.stringify({
      version: 1,
      updatedAt: now,
      tasks: {
        'tomb-g': {
          id: 'tomb-g',
          roomId: '12345678',
          platform: 'Bilibili',
          title: '老台账里的任务',
          status: 'CLIPPED',
          stage: 'CLIPPED',
          source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
          fullUpload: 'NOT_APPLICABLE',
          createdAt: now,
          updatedAt: now,
        },
      },
      fingerprints: { 'fp-g': { taskId: 'tomb-g', clipIndex: 0, at: now } },
      publishedTitles: ['老台账里的任务'],
    }),
    'utf8',
  );

  const ledger = new Ledger({ path: ledgerPath });
  eq('老台账被正常读出（没有被隔离）', ledger.tombstoneCount(), 0);
  ok('任务还在', ledger.getTask('tomb-g') !== undefined);
  ok('老指纹还在', ledger.findFingerprint('fp-g') !== undefined);
  ok('标题索引还在', ledger.hasPublishedTitle('老台账里的任务'));
  ok('没有产生损坏备份', ledger.lastCorruptBackup === null);

  /* 老台账上继续立碑 → 落盘后新字段出现，且能再次读回 */
  ledger.deleteTask('tomb-g');
  const again = new Ledger({ path: ledgerPath });
  eq('在老台账上立碑后，重开仍读得到', again.tombstoneCount(), 0);
  const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as { tombstones?: unknown };
  ok('落盘后的台账出现了 tombstones 字段（格式自然升级）', raw.tombstones !== undefined && typeof raw.tombstones === 'object');
}

/* ========================================================================== */
section('⑧ 端到端：真 Publisher 走**新建稿件**路径时，墓碑必须拦住 upload');
{
  /* 这是漏洞真实发生的路径：重跑一场被删过的素材时 resumeAid 为空，
     上面那段 `if (resumeAid)` 的指纹去重根本不执行，只剩主标题反查这道启发式防线。 */
  const dir = path.join(tmp, 'h');
  const dataDir = path.join(dir, 'data');
  const taskDir = path.join(dataDir, 'tasks', 'tomb-h');
  const clipsDir = path.join(dataDir, 'clips', 'tomb-h');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(clipsDir, { recursive: true });

  const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json') });
  const { setErrorsPath, setErrorReportDir } = await import('../src/errors.ts');
  setErrorsPath(path.join(dir, 'errors.jsonl'));
  setErrorReportDir(path.join(dir, 'error-report'));

  const mkEnvTask = (taskId: string): void => {
    ledger.createTask({
      id: taskId,
      roomId: '12345678',
      platform: 'Bilibili',
      recordingId: 'rec-45678901-0930',
      title: `墓碑端到端 ${taskId}`,
      status: 'CLIPPED',
      stage: 'CLIPPED',
      source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
      fullUpload: 'NOT_APPLICABLE',
      cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: now },
      transcriptPath: path.join(taskDir, 'transcript.json'),
      signalsPath: path.join(taskDir, 'signals.json'),
      clipsPath: path.join(taskDir, 'clips.json'),
      createdAt: now,
      updatedAt: now,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as never);
  };

  /* ---- 第一场：正常投出，然后整场删掉（模拟用户删任务） ---- */
  const OLD = 'tomb-h-old';
  mkEnvTask(OLD);
  const oldClips: Array<Partial<ClipRecord>> = [0, 1].map((i) => {
    const out = path.join(clipsDir, `0${i + 1}-${String(100 + i * 400).padStart(6, '0')}-老切片${i + 1}.mp4`);
    fs.writeFileSync(out, 'x');
    return {
      index: i,
      start: 100 + i * 400,
      end: 250 + i * 400,
      title: `老切片${i + 1}`,
      desc: '',
      tags: ['测试'],
      category: '游戏/单机游戏',
      score: 8,
      selected: true,
      status: 'CUT' as const,
      cutOutput: out,
    };
  });
  ledger.setClips(OLD, oldClips as never);

  const realCfg = loadConfig(path.join(process.cwd(), 'config.json')).config;
  const cfg = { ...realCfg, publish: { ...realCfg.publish, multiPart: true, resumeAid: '' } };
  const madeUploads: Array<Record<string, unknown>> = [];
  const fakeClient = {
    biliArchives: async (): Promise<unknown[]> => [],
    biliUpload: async (p: Record<string, unknown>): Promise<{ taskId: string }> => {
      madeUploads.push(p);
      return { taskId: `upload-${madeUploads.length}` };
    },
  };
  const publisher = new Publisher({
    client: fakeClient as never,
    config: cfg,
    ledger,
    logger: silentLog as never,
  });

  const publish = async (taskId: string): Promise<{ titles: string[]; res: Awaited<ReturnType<Publisher['publishAsMultiPart']>> }> => {
    const task = ledger.getTask(taskId) as TaskRecord;
    const clips = ledger.getClips(taskId);
    const res = await publisher.publishAsMultiPart({ task, uid: 12345, clips, logger: silentLog as never });
    return { titles: res.parts.filter((p) => p.kind === 'clip').map((p) => p.title), res };
  };

  const first = await publish(OLD);
  eq('第一场正常投出 2 个切片', first.titles.length, 2);
  eq('确实发起了 1 次上传', madeUploads.length, 1);
  const fps = ledger.getClips(OLD).map((c) => c.fingerprint ?? '');
  ok('第一场两个切片的指纹都落账了', fps.every((x) => x.length > 0), JSON.stringify(fps));

  /* 模拟投稿成功后被反查到 bvid（publishMultiPartStage 走的就是 setClipStatus PUBLISHED） */
  for (const c of ledger.getClips(OLD)) {
    ledger.setClipStatus(OLD, c.index, 'PUBLISHED', { bvid: 'BV1TOMBOLD01', publishedAt: now });
  }
  ledger.rememberPublishedTitle(ledger.getTask(OLD)?.title ?? '');

  const del = ledger.deleteTask(OLD);
  eq('★ 删整场后立碑 2 条（改之前是 0 条 —— 那就是漏洞）', del.tombstonedFingerprints, 2);
  eq('生效指纹归零', ledger.tombstoneCount(), 2);

  /* ---- 第二场：同一份素材被重新导入、重新分析出**同样的区间和标题** ---- */
  const NEW = 'tomb-h-new';
  mkEnvTask(NEW);
  const newClips: Array<Partial<ClipRecord>> = [0, 1].map((i) => {
    const out = path.join(clipsDir, `0${i + 1}-${String(100 + i * 400).padStart(6, '0')}-新切片${i + 1}.mp4`);
    fs.writeFileSync(out, 'x');
    return {
      index: i,
      start: 100 + i * 400, // 同一区间
      end: 250 + i * 400,
      title: `老切片${i + 1}`, // 同一标题（这正是"换措辞就穿透"的反面：连标题都没换）
      desc: '',
      tags: ['测试'],
      category: '游戏/单机游戏',
      score: 8,
      selected: true,
      status: 'CUT' as const,
      cutOutput: out,
    };
  });
  ledger.setClips(NEW, newClips as never);

  /* 先确认指纹真的相同 —— 否则这个测试证明不了任何事 */
  const oldFp = clipFingerprint({ sourceVideoId: 'rec-45678901-0930', start: 100, end: 250, title: '老切片1' });
  ok('新场的指纹与老场**完全相同**（同一素材同一区间同一标题）', fps.includes(oldFp), `${oldFp} vs ${JSON.stringify(fps)}`);

  const second = await publish(NEW);
  eq('★★ 没有发出任何上传请求（墓碑拦住 = 不会产生重复稿件）', madeUploads.length, 1);
  eq('本场实际投出 0 个分P', second.titles.length, 0);
  ok('返回 ok=true（是「无需投稿」而不是「投稿失败」）', second.res.ok === true, `ok=${String(second.res.ok)}`);
  ok('带上了 skipped 说明', typeof second.res.skipped === 'string' && second.res.skipped.length > 0, String(second.res.skipped));
  ok(
    'warnings 里明确写了「墓碑拦截」（不能静默跳过 —— 静默会让人以为丢了稿件）',
    second.res.warnings.some((w) => w.includes('墓碑拦截')),
    JSON.stringify(second.res.warnings),
  );
  const blockedClips = ledger.getClips(NEW).filter((c) => c.blockedByTombstone);
  eq('两个切片都被打上 blockedByTombstone 标记（UI 据此显示原因与解除入口）', blockedClips.length, 2);
  ok(
    '被拦下的切片状态是"已投"而不是"失败"',
    blockedClips.every((c) => c.status === 'PUBLISHED' || c.status === 'SUBMITTED'),
    blockedClips.map((c) => c.status).join(','),
  );

  /* ---- 人工解除后，同一场重跑必须能正常投出 ---- */
  for (const t of ledger.listTombstones()) ledger.releaseTombstone(t.fingerprint, { note: '测试：确认旧稿件已删' });
  eq('墓碑已全部解除', ledger.tombstoneCount(), 0);
  const third = await publish(NEW);
  eq('★ 解除后重投成功（墓碑是"可推翻的保护"，不是死锁）', third.titles.length, 2);
  eq('确实发起了第 2 次上传', madeUploads.length, 2);
  ok('这次不再有墓碑警告', !third.res.warnings.some((w) => w.includes('墓碑拦截')), JSON.stringify(third.res.warnings));

  /* ---- 反证：如果删任务时**不**立碑（= 修复前的行为），这段内容就会被再投一次 ---- */
  const NOGUARD = 'tomb-h-noguard';
  mkEnvTask(NOGUARD);
  ledger.setClips(
    NOGUARD,
    newClips.map((c) => ({ ...c, cutOutput: c.cutOutput })) as never,
  );
  const fourth = await publish(NOGUARD);
  ok(
    '反证：没有墓碑时同样的内容会照投（说明前面那次"没投"确实是墓碑拦下的）',
    fourth.titles.length === 2 && madeUploads.length === 3,
    `投出 ${fourth.titles.length} 个，累计上传 ${madeUploads.length} 次`,
  );
}

console.log(`\n\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\x1b[31m失败项：\x1b[0m');
  for (const f of failures) console.log(`  - ${f}`);
}
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}
process.exitCode = fail === 0 ? 0 : 1;
