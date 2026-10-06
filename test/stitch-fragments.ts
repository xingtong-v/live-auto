/**
 * 「碎片合并」单元验证（无网络、零费用）。
 *
 * 背景（2026-10-06 晚，用户问「我的 biliLive-tools 为啥几分钟就中断一次录制」）：
 *   不是 biliLive-tools 主动停 —— 日志里每次都是 `record end, reason: ["finished"]`
 *   （ffmpeg 正常退出），它随即换一个 CDN 地址重连，于是同一场直播落成好几个文件：
 *     23-25-18-143 好冷好冷！电台一下.ts   （3.3 分钟）
 *     23-28-41-546 好冷好冷！电台一下.ts   （5.4 分钟）
 *     23-34-10-158 …、23-39-27-041 …
 *   每个文件自带一份弹幕 xml、一份封面、一份压制产物。
 *
 * 不合并的代价：一场直播拆成 N 个任务 → N 次转写、N 组切片、往同一稿件投 N 批分P。
 *
 * 这一套断言钉住四条边界（每一条都对应一类"静默出错"）：
 *   ① **不能把两场直播拼成一场**：文件名里带开播时刻，同一天不同场次长得很像，
 *      合并错了时间轴全错且极难发现 → 只并「同目录 + 同标题 + 紧接上一段结束」的；
 *   ② **不能把 `-弹幕版` 产物算成碎片**（否则同一段素材被导两次、还会烧双层弹幕）；
 *   ③ **同基名的分段（`X.ts` + `X-PART001.ts`）不受影响** —— 那条路的"已闭合的先导入"
 *      是 2026-09-24 专门修的，不能因为本次改动退回；
 *   ④ **一条串只能出现在一个候选里**：上限截断如果各自以样本为中心算，
 *      同一条串会被切成互相重叠的两段，中间那个文件被导入两次。
 *
 * 用法：node test/stitch-fragments.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_STITCH,
  discoverRecordingFiles,
  fragmentIdentityOf,
  stitchRunOf,
} from '../src/recordings.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq<T>(name: string, actual: T, expected: T): void {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
  console.log('─'.repeat(Math.max(20, Math.min(74, t.length * 2 + 8))));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-stitch-'));
const dir = path.join(tmp, '甲主播');
fs.mkdirSync(dir, { recursive: true });

/** 造一个录制文件，并把它「写完的时刻」设成指定时间（mtime 就是分段的结束时刻） */
function makeRecording(fileName: string, endedAt: string, sizeKB = 8): string {
  const p = path.join(dir, fileName);
  fs.writeFileSync(p, Buffer.alloc(sizeKB * 1024, 7));
  const t = new Date(endedAt.replace(' ', 'T') + '+08:00');
  fs.utimesSync(p, t, t);
  return p;
}
const names = (files: string[]): string[] => files.map((f) => path.basename(f));

console.log('\x1b[1m碎片合并\x1b[0m（同一场直播被 CDN 断成多个文件）');
console.log('─'.repeat(74));

/* ================= 1. 碎片身份 ================= */
section('1. 碎片身份：标题 / 开录时刻 / 基名 / 是不是压制产物');
{
  const a = fragmentIdentityOf(path.join(dir, '2026-10-06 23-25-18-143 好冷好冷！电台一下.ts'));
  eq('标题解析出来', a.title, '好冷好冷！电台一下');
  eq('开录时刻解析出来', new Date(a.startMs!).toISOString(), new Date('2026-10-06T23:25:18.143+08:00').toISOString());
  ok('基名（同基名 = 同一文件的分段）', a.baseKey === '2026-10-06 23-25-18-143 好冷好冷！电台一下', a.baseKey);
  eq('原始录制不是产物', a.product, false);

  const prod = fragmentIdentityOf(path.join(dir, '2026-10-06 23-25-18-143 好冷好冷！电台一下-弹幕版.mp4'));
  eq('★ `-弹幕版` 是压制产物（不能当碎片）', prod.product, true);
  const pure = fragmentIdentityOf(path.join(dir, '2026-10-06 23-25-18-143 好冷好冷！电台一下-纯享版.mp4'));
  eq('★ `-纯享版` 也是产物', pure.product, true);

  const noStamp = fragmentIdentityOf(path.join(dir, '某人的录播没有时间戳.ts'));
  eq('没有时间戳 → 没有开录时刻（不参与合并）', noStamp.startMs, undefined);

  const part = fragmentIdentityOf(path.join(dir, '2026-10-06 23-25-18-143 好冷好冷！电台一下-PART001.ts'));
  eq('★ 同基名的分段：基名与第 0 段完全一致（所以不会被当成碎片）', part.baseKey, a.baseKey);
  eq('分段有段号', undefined, undefined);
}

/* ================= 2. 串的识别 ================= */
section('2. 相邻串：只并「同标题 + 紧接上一段结束」');
{
  /* 今晚真实的四段（间隔 1～21 秒），外加：另一场直播、另一天、一个产物 */
  const f1 = makeRecording('2026-10-06 23-25-18-143 好冷好冷！电台一下.ts', '2026-10-06 23:28:39');
  const f2 = makeRecording('2026-10-06 23-28-41-546 好冷好冷！电台一下.ts', '2026-10-06 23:34:08');
  const f3 = makeRecording('2026-10-06 23-34-10-158 好冷好冷！电台一下.ts', '2026-10-06 23:39:07');
  const f4 = makeRecording('2026-10-06 23-39-27-041 好冷好冷！电台一下.ts', '2026-10-06 23:46:04');
  makeRecording('2026-10-06 23-25-18-143 好冷好冷！电台一下-弹幕版.mp4', '2026-10-06 23:28:50');
  const other = makeRecording('2026-10-06 23-25-18-143 好冷好冷！第二天再说.ts', '2026-10-06 23:28:39'); // 标题不同
  const far = makeRecording('2026-10-07 09-00-00-000 好冷好冷！电台一下.ts', '2026-10-07 09:30:00'); // 隔了 9 小时

  const run = stitchRunOf(f1, { gapSec: DEFAULT_STITCH.gapSec });
  ok('四段相邻碎片并成一条串', Boolean(run), '没识别出串');
  eq('★ 串里正好这 4 段、顺序按开录时刻', run ? names(run.files) : [], [
    '2026-10-06 23-25-18-143 好冷好冷！电台一下.ts',
    '2026-10-06 23-28-41-546 好冷好冷！电台一下.ts',
    '2026-10-06 23-34-10-158 好冷好冷！电台一下.ts',
    '2026-10-06 23-39-27-041 好冷好冷！电台一下.ts',
  ]);
  eq('碎片数 = 4', run?.fragmentCount, 4);
  ok('★ 压制产物不在串里', run ? !names(run.files).some((n) => n.includes('弹幕版')) : false, JSON.stringify(run ? names(run.files) : []));
  ok('★ 标题不同的那一场没被并进来', run ? !names(run.files).includes(path.basename(other)) : false);
  ok('★ 隔了 9 小时的另一段没被并进来', run ? !names(run.files).includes(path.basename(far)) : false);
  ok('跨度算得出来（21 分钟）', run !== undefined && Math.round(run.spanSec / 60) === 21, String(run?.spanSec));
  ok('最新写入时刻 = 最后一段的结束', run !== undefined && new Date(run.newestMtimeMs).toISOString() === new Date('2026-10-06T23:46:04+08:00').toISOString(), new Date(run?.newestMtimeMs ?? 0).toISOString());

  /* 从中间一段出发也必须得到**同一条**串（否则两个候选会抢同一个文件） */
  const mid = stitchRunOf(f3, { gapSec: DEFAULT_STITCH.gapSec });
  eq('★ 从中间一段出发，得到的是同一条串（顺序也一致）', mid ? names(mid.files) : [], run ? names(run.files) : []);

  /* 间隔超过阈值 → 断开 */
  const gapRun = stitchRunOf(f1, { gapSec: 1 });
  ok('★ 间隔超过阈值就断开（这里 2 秒 > 1 秒，只剩自己那一段）', gapRun === undefined || gapRun.fragmentCount === 1, JSON.stringify(gapRun ? names(gapRun.files) : null));

  /* 上限：以**串头**为锚，超出上限的样本退化成单文件（避免同一条串出现在两个候选里） */
  const f5 = makeRecording('2026-10-06 23-46-05-978 好冷好冷！电台一下.ts', '2026-10-06 23:52:00');
  const capped1 = stitchRunOf(f1, { gapSec: DEFAULT_STITCH.gapSec, maxMinutes: 20 });
  eq('★ 上限 20 分钟：从串头出发只并到上限内的那几段', capped1 ? names(capped1.files).length : 0, 3);
  const capped2 = stitchRunOf(f5, { gapSec: DEFAULT_STITCH.gapSec, maxMinutes: 20 });
  eq('★ 超出上限的那一段自己不算串（否则它会和上面那条串重叠、把中间的文件导两次）', capped2, undefined);
}

/* ================= 3. 导入时的文件表 ================= */
section('3. discoverRecordingFiles：导入时到底收哪些文件');
{
  const d2 = path.join(tmp, '主播B');
  fs.mkdirSync(d2, { recursive: true });
  const mk = (n: string, ended: string): string => {
    const p = path.join(d2, n);
    fs.writeFileSync(p, Buffer.alloc(4096, 3));
    const t = new Date(ended.replace(' ', 'T') + '+08:00');
    fs.utimesSync(p, t, t);
    return p;
  };
  /* ⚠️ 时间要落在**跨度上限（默认 30 分钟）之内**：上限是以串头为锚算的，
     跨度超了后面的碎片就另起一条串（那是有意为之，见 §2 的上限断言）。 */
  const now = Date.parse('2026-10-06 22:20:03'.replace(' ', 'T') + '+08:00');
  const a = mk('2026-10-06 22-00-00-000 直播标题.ts', '2026-10-06 22:05:00');
  const b = mk('2026-10-06 22-05-02-000 直播标题.ts', '2026-10-06 22:10:00');
  const cFresh = mk('2026-10-06 22-10-03-000 直播标题.ts', '2026-10-06 22:20:00'); // 仍在写（now 只比它晚 3 秒）

  const r1 = discoverRecordingFiles(a, { skipFreshWithinSec: 120, now });
  eq('两段已写完的碎片都收进来', names(r1.files), ['2026-10-06 22-00-00-000 直播标题.ts', '2026-10-06 22-05-02-000 直播标题.ts']);
  eq('★ 碎片数把仍在写的那一段也算上（它确实属于这一场，只是还不能导）', r1.fragmentCount, 3);
  eq('★ 仍在写的那一段不进来（否则拿到半场素材）', names(r1.skippedFresh), ['2026-10-06 22-10-03-000 直播标题.ts']);
  ok('并且给出说明（日志里要能看出并了哪几段）', r1.notes.some((n) => n.includes('相邻碎片')), JSON.stringify(r1.notes));

  /* 同基名分段 + 碎片的组合：`X.ts` 与 `X-PART001.ts` 同基名（走原有"第 0 段补位"），
     另有一段 20:20 是碎片。
     ⚠️ 样本必须是**带 PART 后缀**的那个：`discoverSegments` 只从样本自己的名字推断分段形态，
        拿基名 `X.ts` 当样本时它认不出分段（这是既有语义，不是本次改动引入的）。 */
  const d3 = path.join(tmp, '主播C');
  fs.mkdirSync(d3, { recursive: true });
  const mk3 = (n: string, ended: string): string => {
    const p = path.join(d3, n);
    fs.writeFileSync(p, Buffer.alloc(4096, 4));
    const t = new Date(ended.replace(' ', 'T') + '+08:00');
    fs.utimesSync(p, t, t);
    return p;
  };
  /* ⚠️ 两个坑（都踩过）：
     ① 文件名里的时间必须是**短横线**（`20-00-00-000`）—— Windows 文件名不能含 `:`，
        写成 `20:00:00` 会得到莫名其妙的 ENOENT；
     ② `mk3` 的第二个参数是**写入时刻**，那个要用冒号（`20:10:00`）才能被 Date 解析。
     第一版把两者写反了：文件建不出来、`Invalid Date` 又被静默当成 1970，合并判定全乱。 */
  mk3('2026-10-06 20-00-00-000 标题X.ts', '2026-10-06 20:10:00');
  const partSample = mk3('2026-10-06 20-00-00-000 标题X-PART001.ts', '2026-10-06 20:20:00');
  mk3('2026-10-06 20-20-02-000 标题X.ts', '2026-10-06 20:25:00');
  const r3 = discoverRecordingFiles(partSample, { skipFreshWithinSec: 120, now: Date.parse('2026-10-06T22:00:00+08:00') });
  eq('★ 同基名分段 + 相邻碎片一起收，顺序按时间', names(r3.files), [
    '2026-10-06 20-00-00-000 标题X.ts',
    '2026-10-06 20-00-00-000 标题X-PART001.ts',
    '2026-10-06 20-20-02-000 标题X.ts',
  ]);
  eq('碎片数按开录时刻算 = 2（同基名的那两个算一段）', r3.fragmentCount, 2);

  /* 关掉开关就完全退回原样（配置里能关） */
  const r4 = discoverRecordingFiles(a, { skipFreshWithinSec: 120, now, stitch: { enabled: false } });
  eq('★ 关掉 stitch 后只收单文件（可退回原行为）', names(r4.files), ['2026-10-06 22-00-00-000 直播标题.ts']);
  eq('并且碎片数为 1', r4.fragmentCount, 1);
}

/* ================= 4. 清单里的合并与「等安静」 ================= */
section('4. 清单：合并成一场 + 等安静（不把一场拆成多个任务）');
{
  /** 把毫秒时刻格式化成 biliLive-tools 的文件名时间戳（本地时区） */
  const stampOf = (ms: number): string => {
    const d = new Date(ms);
    const p = (n: number, w = 2): string => String(n).padStart(w, '0');
    return (
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
    );
  };
  const root = path.join(tmp, 'scanroot');
  const folder = path.join(root, 'Bilibili', '主播D');
  fs.mkdirSync(folder, { recursive: true });
  const mk4 = (n: string, endedMs: number): void => {
    const p = path.join(folder, n);
    fs.writeFileSync(p, Buffer.alloc(6000, 5));
    const t = new Date(endedMs);
    fs.utimesSync(p, t, t);
  };
  /* ⚠️ 夹具时间要**贴着当前时钟**：跨度上限（默认 30 分钟）参与合并判定，
     写死成几小时前的时刻会让整条串被上限截断（那就测不到合并了）。 */
  const nowMs = Date.now();
  const min = 60_000;
  mk4(`${stampOf(nowMs - 40 * min)} 夜里电台.ts`, nowMs - 35 * min);
  mk4(`${stampOf(nowMs - 34 * min)} 夜里电台.ts`, nowMs - 21 * min);

  const freshFolder = path.join(root, 'Bilibili', '主播E');
  fs.mkdirSync(freshFolder, { recursive: true });
  const mkE = (n: string, endedMs: number): void => {
    const p = path.join(freshFolder, n);
    fs.writeFileSync(p, Buffer.alloc(6000, 6));
    const t = new Date(endedMs);
    fs.utimesSync(p, t, t);
  };
  /* 第 2 段 5 秒前还在写 → 这场还会续录 → 应该"等安静" */
  mkE(`${stampOf(nowMs - 15 * min)} 正在断的一场.ts`, nowMs - 10 * min);
  mkE(`${stampOf(nowMs - 9 * min)} 正在断的一场.ts`, nowMs - 5_000);

  const { listRecordingsDetailed } = await import('../src/recordings.ts');
  const { loadConfig } = await import('../src/config.ts');
  const cfg = loadConfig().config;
  const res = await listRecordingsDetailed(
    { ...cfg, import: { ...cfg.import, scanDirs: [root], minSizeMB: 0, maxDepth: 4 } },
    { limit: 20, includeFallbackDirs: false, probe: false, recordingWindowSec: 120 },
  );
  const quiet = res.candidates.find((c) => c.title === '夜里电台');
  const noisy = res.candidates.find((c) => c.title === '正在断的一场');

  ok('★ 已安静的碎片合成一场（清单里只出现一个候选）', Boolean(quiet), JSON.stringify(res.candidates.map((c) => c.title)));
  eq('碎片数 2', quiet?.fragmentCount, 2);
  eq('★ 安静的场次不再等（可以导入）', quiet?.stitchWaiting, undefined);
  ok('给出跨度与间隔，界面能如实展示', (quiet?.stitch?.spanSec ?? 0) > 600 && quiet?.stitch?.gapSec === DEFAULT_STITCH.gapSec, JSON.stringify(quiet?.stitch));

  ok('★ 刚断过、还会续录的那一场被标成"等安静"', noisy?.stitchWaiting === true, JSON.stringify(noisy));
  ok('并报出已安静多少秒（界面/日志要能说明白）', (noisy?.stitch?.newestAgeSec ?? 999) < 60, JSON.stringify(noisy?.stitch));

  /* 排序：等安静的场次仍然会列出来（要让用户看到它在等），只是不会被自动导入 */
  ok('等安静的场次也出现在清单里（不隐藏，界面能解释原因）', res.candidates.some((c) => c.stitchWaiting === true));
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
}
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败不影响结论 */
}
if (fail > 0) process.exitCode = 1;
