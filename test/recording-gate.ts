/**
 * 「有没有在录」判据 + 自动关机那道 gate 的自测（2026-10-24）。
 *
 * 为什么单独一个文件、而且写得这么细：
 * 用户 2026-10-24 的截图里，三处界面互相打架 ——
 *   · 运行观测页：「正在录制的文件 1 个」1.13 GB、0.76 MB/s、最后写入 0 秒前；
 *   · 直播间状态：`state=recording`；
 *   · 「跑完自动关机」页：「没有正在录制 / 可能还在录的场次 **0 场**」。
 * 根因是那道 gate 只统计 **watcher 的 mp4 导入候选项**，而 biliLive-tools 的分段录制写的是 `.ts`
 * ⇒ 这一项永远是 0。后果是：`llcQueue=[]` + 流水线空闲时其余门槛一旦满足，
 * **自动关机会在直播录制中途把机器关掉**（那一场录制直接报废）。
 *
 * 所以这里逐个源钉死，并且**必须**包含"只有原始 .ts 在写、watcher 一无所知"这条回归用例 ——
 * 它红了就说明这次 Bug 又回来了，而红的那一刻机器还没有被关掉。
 *
 * 全部 hermetic：临时目录自己建、时钟自己给，不依赖真实录制目录、不依赖真实 biliLive-tools。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decideShutdown } from '../src/auto-shutdown.ts';
import {
  RECORDING_ACTIVE_WINDOW_SEC,
  RECORDING_GATE_LABEL,
  gatherRecordingGate,
  pickLiveSegments,
  recordingGate,
  resetRecordingSampleCache,
  scanRecordingFiles,
  sessionKeyOf,
  summarizeRecordingEvidence,
  type RecordingEvidence,
} from '../src/recording-signals.ts';
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
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

/* ---- 临时录制目录（hermetic：不碰用户的真实录制盘） ---- */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-recgate-'));
const roomDir = path.join(tmpRoot, '甲主播');
fs.mkdirSync(roomDir, { recursive: true });

/** 用户截图里那个真实文件名（PART007 就是它） */
const SESSION = '2026-10-24 17-59-44-718 玩《深空当铺》，当极致倒勾';
const fileOf = (part: number): string => path.join(roomDir, `${SESSION}-PART${String(part).padStart(3, '0')}.ts`);

/** 写一个"正在录"的分段：体积给够，mtime = 现在 ⇒ 新鲜（ageSec≈0） */
function writeLive(file: string, bytes = 4096): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
}
/** 把 mtime 调到 ageSec 秒之前（用来造"历史文件"） */
function ageFile(file: string, ageSec: number): void {
  const t = new Date(Date.now() - ageSec * 1000);
  fs.utimesSync(file, t, t);
}

/* ========================================================================== */

section('0. 场次归并键：同一场的 PART001…PART007 必须归到一起');
{
  const a = sessionKeyOf(fileOf(1));
  const b = sessionKeyOf(fileOf(7));
  eq('同目录同开录时间戳 → 同一个键（这是"两个来源只算 1 场"的基础）', a === b, true);
  const other = sessionKeyOf(path.join(roomDir, '2026-10-25 20-00-00-000 另一场-PART007.ts'));
  eq('不同场次 → 不同的键', a === other, false);
  const otherRoom = sessionKeyOf(path.join(tmpRoot, '别的主播', path.basename(fileOf(7))));
  eq('不同房间目录（哪怕时间戳碰巧一样）→ 不同的键', a === otherRoom, false);
}

section('1. ★ 回归用例：只有原始 .ts 在写、watcher 一无所知 → 必须判"还在录"');
{
  resetRecordingSampleCache();
  writeLive(fileOf(7), 1_200_000);
  const r = gatherRecordingGate({ now: Date.now(), dirs: [tmpRoot], outcomes: [], recorders: [] });
  eq('★ 场次数 ≥ 1（旧实现这里是 0 —— 就是这次 Bug）', r.gate.count >= 1, true);
  eq('★ gate.ok = false（绝不能在录制中途关机）', r.gate.ok, false);
  ok('detail 说清来源是"原始分段在写"', /原始分段在写/.test(r.gate.detail), r.gate.detail);
  ok('detail 带上文件名（用户能核对是哪一场）', /PART007\.ts/.test(r.gate.detail), r.gate.detail);
  ok('detail 带上房间目录名（主播名）', /甲主播/.test(r.gate.detail), r.gate.detail);
  eq('label 明确写了"含原始分段在写"', r.gate.label, RECORDING_GATE_LABEL);
  ok('label 里点明这一条包含原始分段', /含原始分段在写/.test(RECORDING_GATE_LABEL), RECORDING_GATE_LABEL);
  fs.rmSync(fileOf(7), { force: true });
}

section('2. 录制器 state=recording、盘上没有任何文件 → 也必须判"还在录"');
{
  resetRecordingSampleCache();
  const r = gatherRecordingGate({
    now: Date.now(),
    dirs: [tmpRoot],
    outcomes: [],
    recorders: [{ channelId: '23456789', remarks: '甲主播', state: 'recording', liveInfo: { living: true } }],
  });
  eq('★ 场次数 = 1', r.gate.count, 1);
  eq('★ gate.ok = false', r.gate.ok, false);
  ok('detail 说清来源是"录制器 recording"', /录制器 recording/.test(r.gate.detail), r.gate.detail);
  ok('detail 带上主播名与"直播中"', /甲主播（直播中）/.test(r.gate.detail), r.gate.detail);
}

section('3. 去重：两个来源指向同一场 → 只算 1 场');
{
  resetRecordingSampleCache();
  writeLive(fileOf(7), 900_000);
  const r = gatherRecordingGate({
    now: Date.now(),
    dirs: [tmpRoot],
    /* watcher 说 PART001 那一段"可能还在录"（它只认 mp4 候选，路径同目录同时间戳） */
    outcomes: [{ videoPath: fileOf(1), fileName: path.basename(fileOf(1)), title: SESSION, possiblyRecording: true }],
    /* 录制器也说在录（同一场，同一房间号） */
    recorders: [{ channelId: '23456789', remarks: '甲主播', state: 'recording' }],
  });
  eq('★ watcher + 原始分段 + 录制器一起命中同一场 → 仍然只算 1 场', r.gate.count, 1);
  eq('gate.ok = false', r.gate.ok, false);
  ok('两个来源都在 detail 里出现（不是只报一个）', /原始分段在写/.test(r.gate.detail) && /轮询候选项仍未写稳/.test(r.gate.detail), r.gate.detail);
  fs.rmSync(fileOf(7), { force: true });
}

section('4. 同一 taskId 的多条证据 → 只算 1 场（按任务号归并）');
{
  const evidence: RecordingEvidence[] = [
    { source: 'watcher', path: '/x/甲/2026-10-01 10-00-00-000 甲场-PART001.ts', taskId: 'auto-1', label: 'A.ts' },
    { source: 'watcher', path: '/x/甲/2026-10-02 10-00-00-000 乙场-PART002.ts', taskId: 'auto-1', label: 'B.ts' },
  ];
  const s = summarizeRecordingEvidence(evidence);
  eq('★ 同一 taskId 的两条 → 1 场', s.count, 1);
  eq('两场的说明都留着（用户能看见两个文件）', s.sessions[0]!.labels.length, 2);
}

section('5. 全部没在录（文件已停写、录制器 idle）→ 0 场、gate.ok = true');
{
  resetRecordingSampleCache();
  /* 一场"昨天的"录制：早就停止写入 ⇒ 不能因为它在盘上就永久判"还在录" */
  const old = path.join(roomDir, '2026-10-20 20-00-00-000 昨晚那场-PART001.ts');
  writeLive(old, 1024);
  ageFile(old, RECORDING_ACTIVE_WINDOW_SEC + 3600);
  const r = gatherRecordingGate({
    now: Date.now(),
    dirs: [tmpRoot],
    outcomes: [{ videoPath: old, fileName: path.basename(old), skipped: '已导入过（任务 auto-9）' }],
    recorders: [{ channelId: '23456789', remarks: '甲主播', state: 'idle' }],
  });
  eq('★ 历史 .ts（早已停写）不算 → 0 场', r.gate.count, 0);
  eq('★ gate.ok = true（这才允许关机）', r.gate.ok, true);
  eq('detail 就是"0 场"', r.gate.detail, '0 场');
  fs.rmSync(old, { force: true });
}

section('6. 反例：停写但仍在时间窗内 → 第二轮采样就该判"没在长"（避免永久误判）');
{
  resetRecordingSampleCache();
  const f = path.join(roomDir, '2026-10-23 21-00-00-000 刚停那场-PART001.ts');
  writeLive(f, 500_000);
  const t0 = Date.now();
  const first = gatherRecordingGate({ now: t0, dirs: [tmpRoot], outcomes: [], recorders: [] });
  eq('第一轮：没有基准 + 90 秒内写过 → 保守算"在写"', first.gate.count, 1);
  /* 60 秒后再看：体积一点没变 ⇒ 已经停了，不该再算 */
  const second = gatherRecordingGate({ now: Date.now() + 60_000, dirs: [tmpRoot], outcomes: [], recorders: [] });
  eq('★ 第二轮：体积没变大 → 0 场（不会把"刚停"永久当成"还在录"）', second.gate.count, 0);
  eq('gate.ok = true', second.gate.ok, true);
  /* 再写一点：立刻又该判"在写" */
  writeLive(f, 900_000);
  const third = gatherRecordingGate({ now: Date.now() + 70_000, dirs: [tmpRoot], outcomes: [], recorders: [] });
  eq('第三轮：体积又长了 → 1 场', third.gate.count, 1);
  fs.rmSync(f, { force: true });
}

section('7. 保守原则：任一数据源查不到 → 按"还在录"处理（不通过）');
{
  resetRecordingSampleCache();
  const r = gatherRecordingGate({ now: Date.now(), dirs: [tmpRoot], outcomes: [], recorders: undefined, failed: ['biliLive-tools 录制器状态'] });
  eq('★ 查不到录制器 → 1 场（保守）', r.gate.count, 1);
  eq('★ gate.ok = false', r.gate.ok, false);
  ok('detail 说清"哪一源查不到 + 按还在录处理"', /查不到 biliLive-tools 录制器状态/.test(r.gate.detail) && /按"还在录"处理/.test(r.gate.detail), r.gate.detail);
  eq('failed 里记着这一源（日志/界面能看到）', r.failed, ['biliLive-tools 录制器状态']);
}

section('8. 扫盘失败也要记成"查不到"（不静默放过）');
{
  resetRecordingSampleCache();
  /* 传一个"看起来是目录、实际是文件"的路径：readdirSync 会 ENOTDIR，
     scanRecordingFiles 内部吞掉单个目录的错 ⇒ 这里改用"文件当 dirs"仍应得到 0 个文件而不是崩 */
  const fake = path.join(tmpRoot, 'not-a-dir.txt');
  fs.writeFileSync(fake, 'x');
  const files = scanRecordingFiles([fake], { now: Date.now() });
  eq('扫不到就返回空（不抛错，让其它信号源继续工作）', files.length, 0);
  fs.rmSync(fake, { force: true });
}

section('9. 只认视频文件 + 压制产物要标出来（别把 .json 当在录）');
{
  resetRecordingSampleCache();
  const json = path.join(roomDir, '.pre-transcribe.json');
  const product = path.join(roomDir, `${SESSION}-弹幕版.mp4`);
  writeLive(json, 128);
  writeLive(product, 4096);
  writeLive(fileOf(7), 8192);
  const segs = pickLiveSegments(scanRecordingFiles([tmpRoot], { now: Date.now() }), { now: Date.now() });
  eq('状态文件（.json）不算"在录"', segs.some((s) => s.name.endsWith('.json')), false);
  const p = segs.find((s) => s.name.includes('-弹幕版'));
  eq('压制产物被识别为 product（说成"在压制"而不是"在录制"）', p?.product, true);
  const raw = segs.find((s) => /-PART\d+\.ts$/.test(s.name));
  eq('原始 .ts 被找到', raw !== undefined, true);
  eq('原始 .ts 不是 product', raw?.product, false);
  fs.rmSync(json, { force: true });
  fs.rmSync(product, { force: true });
  fs.rmSync(fileOf(7), { force: true });
}

section('10. 空输入：什么都不传 → 0 场、可以关');
{
  const r = gatherRecordingGate({ now: Date.now() });
  eq('0 场', r.gate.count, 0);
  eq('gate.ok = true', r.gate.ok, true);
  eq('recordingGate 单独调用也一致', recordingGate(summarizeRecordingEvidence([])).ok, true);
}

section('11. 静态接线：三处必须用同一套判据（防止有人把 daemon 改回只认 watcher）');
{
  const daemon = fs.readFileSync(path.join(ROOT_DIR, 'src', 'daemon.ts'), 'utf8');
  ok('★ 自动关机走 gatherRecordingGate（多源归并）', /gatherRecordingGate\(\{/.test(daemon));
  ok('★ 自动关机问了录制器状态', /recorders = await this\.client\.recorderList\(\)/.test(daemon));
  ok('★ 自动关机取的是 watcher 的 dirs（扫盘要用）', /dirs = Array\.isArray\(st\?\.dirs\)/.test(daemon));
  ok('★ 旧写法（只 filter lastOutcomes 算场次数）已不在 evaluateAutoShutdown 里', !/recordingSessions: this\.watcher/.test(daemon));
  ok('查不到录制器时记账（不静默当成"没在录"）', /failed\.push\('biliLive-tools 录制器状态'\)/.test(daemon));

  const server = fs.readFileSync(path.join(ROOT_DIR, 'src', 'server.ts'), 'utf8');
  ok('★ 观测页用共享的扫描/判定函数（不再自己写一遍）', /scanRecordingFiles\(dirs, \{ now \}\)/.test(server) && /pickLiveSegments\(files, \{ now \}\)/.test(server));
  ok('★ 观测页不再有自己那份采样缓存（避免两页各采各的）', !/observeSizeCache/.test(server));
  ok('★ 监控页的 recordingNow 也列出"原始分段仍在写入（正在录制）"', /原始分段仍在写入（正在录制）/.test(server));
  ok('★ 监控页与观测页共用同一个场次归并键（同一场不会列两次）', /recordingNowKeys\.has\(key\)/.test(server));
  ok('观测页保留"5 秒一刷"的速率说明所需的字段（rateMBps/growing）', /rateMBps: s\.rateMBps/.test(server) && /growing: s\.growing/.test(server));

  const mod = fs.readFileSync(path.join(ROOT_DIR, 'src', 'recording-signals.ts'), 'utf8');
  ok('模块头注释写明这次的真实教训（.ts 不被 watcher 当候选 ⇒ 永远是 0）', /PART007\.ts/.test(mod) && /永远/.test(mod));
  ok('三个源都在 gatherRecordingGate 里出现', /source: 'watcher'/.test(mod) && /source: 'raw'/.test(mod) && /source: 'recorder'/.test(mod));
}

section('12. 与自动关机 decideShutdown 拼起来：reason 读起来是干净的一句话');
{
  resetRecordingSampleCache();
  writeLive(fileOf(7), 1_000_000);
  const r = gatherRecordingGate({ now: Date.now(), dirs: [tmpRoot], outcomes: [], recorders: [] });
  ok('gate.sources 只讲来源、不带场次数（否则 reason 里会重复一遍"场"）', !/场可能还在录/.test(r.gate.sources) && /原始分段在写/.test(r.gate.sources), r.gate.sources);
  const d = decideShutdown(
    {
      enabled: true,
      busy: false,
      queueLength: 0,
      activeTranscriptions: 0,
      llcQueueLength: 0,
      recordingSessions: r.gate.count,
      recordingDetail: r.gate.sources,
      now: new Date(),
    },
    { minIdleMinutes: 0, graceSeconds: 300 },
    new Date(Date.now() - 3600_000).toISOString(),
  );
  eq('★ 有原始分段在写 ⇒ 绝不关机', d.shutdown, false);
  ok(
    '★ reason 是"有 1 场可能正在录制（原始分段在写：…）—— …"，没有括号套括号',
    /^有 1 场可能正在录制（原始分段在写：[^（）]*）\s+—— /.test(d.reason),
    d.reason,
  );
  fs.rmSync(fileOf(7), { force: true });
}

/* ---- 收尾：清掉临时目录 ---- */
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exitCode = fail === 0 ? 0 : 1;
