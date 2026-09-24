/**
 * 「录播发现 / 导入预览」单元验证（无网络、零费用）。
 *
 * 这一块的错误都是**静默**的：解析错文件名只是标题难看，配错弹幕只是信号变弱，
 * 但如果**把 `-弹幕版` 当成源文件**，切片就会烧出双层弹幕 —— 而日志里一切正常。
 * 所以用真实文件名（本机 biliLive-tools 的实际产物形态）做断言。
 *
 * 用法：node test/recordings.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describeCandidate,
  findSiblingDanmaku,
  listRecordingsDetailed,
  parseRecordingFileName,
  previewRecording,
  recorderFolderFromConfig,
  recorderFoldersFromConfig,
  recordingGroupKey,
  RECORDING_WINDOW_SEC,
  roomIdsFromConfig,
} from '../src/recordings.ts';
import { loadConfig } from '../src/config.ts';
import { discoverSegments } from '../src/media.ts';

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

console.log('\x1b[1m录播发现与导入预览\x1b[0m（无网络）');
console.log('─'.repeat(74));

/* ================= 1. 文件名解析（真实形态） ================= */
section('1. 文件名解析');
{
  const a = parseRecordingFileName('2026-09-20 00-36-21-040 已进入后半夜后悔时代.flv');
  eq('标准录制：标题', a.title, '已进入后半夜后悔时代');
  ok('标准录制：解析出录制时刻', typeof a.recordedAt === 'number' && new Date(a.recordedAt!).getFullYear() === 2026, String(a.recordedAt));
  eq('标准录制：没标成已烧弹幕', a.hasDanmakuInPicture, false);

  const b = parseRecordingFileName('2026-09-22 22-27-18-350 来两下闪身步就好了-弹幕版.mp4');
  eq('压制产物：标题不带「-弹幕版」', b.title, '来两下闪身步就好了');
  eq('压制产物：识别为画面已烧弹幕', b.hasDanmakuInPicture, true);

  const c = parseRecordingFileName('2026-09-22 22-49-42-277 来两下闪身步就好了_PART000.flv');
  eq('分段：标题不带 _PART', c.title, '来两下闪身步就好了');
  eq('分段：解析出段号', c.partIndex, 0);

  const d = parseRecordingFileName('某人的录播没有时间戳.flv');
  eq('没有时间戳时退回文件名', d.title, '某人的录播没有时间戳');
  eq('没有时间戳时不编造时刻', d.recordedAt, undefined);

  // 别的下载工具的命名：下划线日期 + 空格分秒（实测本机 Downloads 根目录就有这种）
  const f = parseRecordingFileName('2026_9_21 20_50_02 场直播.ts');
  eq('宽松格式：标题解析正确', f.title, '场直播');
  ok('宽松格式：能解析出录制时刻', typeof f.recordedAt === 'number' && new Date(f.recordedAt!).getMonth() === 8, String(f.recordedAt));
  eq('宽松格式：不会把日期当成标题', /^\d/.test(f.title), false);

  const e = parseRecordingFileName('2026-09-22 21-07-58-627 来两下闪身步就好了-弹幕版_PART003.mkv');
  eq('弹幕版 + 分段同时出现：段号', e.partIndex, 3);
  eq('弹幕版 + 分段同时出现：标记已烧弹幕', e.hasDanmakuInPicture, true);
  eq('弹幕版 + 分段同时出现：标题干净', e.title, '来两下闪身步就好了');

  /* biliLive-tools 的**防覆盖 UUID**：同一分段二次压制时产物会变成
     `哈喽-弹幕版-6e88e7c6-1c78-4827-917b-c7e62ad18fc9.mp4`（用户实测截图里就是这个）。
     识别不出这个后缀会同时踩两个坑：① 归成另一场 → 同一段素材被导入两次、ASR 花两遍钱；
     ② 判成"没烧过弹幕" → 拿它当源文件再烧一层（双层弹幕）。 */
  const u = parseRecordingFileName('2026-09-24 00-48-58-767 哈喽-弹幕版-6e88e7c6-1c78-4827-917b-c7e62ad18fc9.mp4');
  eq('防覆盖 UUID：标题里不留 UUID', u.title, '哈喽');
  eq('防覆盖 UUID：仍然认出画面已烧弹幕', u.hasDanmakuInPicture, true);
  ok('防覆盖 UUID：日期仍能解析', typeof u.recordedAt === 'number' && new Date(u.recordedAt!).getDate() === 24, String(u.recordedAt));
  const u2 = parseRecordingFileName('2026-09-24 00-48-58-767 哈喽-弹幕版-6E88E7C6-1C78-4827-917B-C7E62AD18FC9.mp4');
  eq('防覆盖 UUID：大写也认', u2.hasDanmakuInPicture, true);
  eq('防覆盖 UUID：大写也不留 UUID', u2.title, '哈喽');
  // 反例：普通的 `-` 尾巴不能被当成 UUID 后缀而误剥
  const u3 = parseRecordingFileName('2026-09-24 00-48-58-767 哈喽-半夜场.mp4');
  eq('非 UUID 的尾巴不被剥掉', u3.title, '哈喽-半夜场');
  eq('非 UUID 的尾巴不误判成已烧弹幕', u3.hasDanmakuInPicture, false);

  /* `-PART000`（**连字符**分段，实测 2026-09-24 biliLive-tools 就是这么切段的）：
     只认 `_PART` 时标题会残留成 `哈喽-PART000`，而标题要拿去匹配稿件 →
     匹配不上就另投一个新稿件（用户会看到两场直播变成两个稿件）。 */
  const pv = parseRecordingFileName('2026-09-24 01-01-56-910 哈喽-PART000.ts');
  eq('连字符分段：标题不带 -PART000', pv.title, '哈喽');
  eq('连字符分段：解析出段号', pv.partIndex, 0);
  ok('连字符分段：解析出录制时刻', typeof pv.recordedAt === 'number' && new Date(pv.recordedAt!).getHours() === 1, String(pv.recordedAt));
  eq('连字符分段：不误判成已烧弹幕', pv.hasDanmakuInPicture, false);
  const pv2 = parseRecordingFileName('2026-09-24 01-01-56-910 哈喽-part003-弹幕版.mp4');
  eq('连字符分段 + 弹幕版：标题干净', pv2.title, '哈喽');
  eq('连字符分段 + 弹幕版：段号', pv2.partIndex, 3);
  eq('连字符分段 + 弹幕版：认出已烧弹幕', pv2.hasDanmakuInPicture, true);
}

/* ================= 2. 归并键：同一场的文件要归到一组 ================= */
section('2. 同场归并');
{
  const k1 = recordingGroupKey('2026-09-22 22-27-18-350 来两下闪身步就好了.flv');
  const k2 = recordingGroupKey('2026-09-22 22-27-18-350 来两下闪身步就好了-弹幕版.mp4');
  const k3 = recordingGroupKey('2026-09-22 22-27-18-350 来两下闪身步就好了_PART000.flv');
  const k4 = recordingGroupKey('2026-09-22 22-06-29-941 来两下闪身步就好了.flv');
  ok('原始 flv 与 -弹幕版 归为一组', k1 === k2, `${k1} vs ${k2}`);
  ok('原始 flv 与 _PART000 归为一组', k1 === k3, `${k1} vs ${k3}`);
  ok('不同场次不合并（时间戳不同）', k1 !== k4, `${k1} vs ${k4}`);

  /* 实测重复导入事故（用户截图里那条 `哈喽-弹幕版-6e88e7c6-…`）：
     原始 `.ts` 与它的防覆盖 UUID 弹幕版**必须是同一组** ——
     否则目录轮询会把同一段素材当成两场导入，转写/分析各花一遍钱，还有重复投稿风险。 */
  const rawTs = recordingGroupKey('2026-09-24 00-48-58-767 哈喽.ts');
  const burnedUuid = recordingGroupKey('2026-09-24 00-48-58-767 哈喽-弹幕版-6e88e7c6-1c78-4827-917b-c7e62ad18fc9.mp4');
  const burnedPlain = recordingGroupKey('2026-09-24 00-48-58-767 哈喽-弹幕版.mp4');
  ok('原始 ts 与 UUID 弹幕版归为一组', rawTs === burnedUuid, `${rawTs} vs ${burnedUuid}`);
  ok('原始 ts 与普通弹幕版归为一组', rawTs === burnedPlain, `${rawTs} vs ${burnedPlain}`);
  /* 反例：UUID 后的另一场（时间戳不同）不能因为"都带 uuid"就被合并 */
  ok('不同时间戳的两场仍分组', rawTs !== recordingGroupKey('2026-09-24 01-30-00-000 哈喽-弹幕版-6e88e7c6-1c78-4827-917b-c7e62ad18fc9.mp4'));

  /* 连字符分段也要归到同一声道的同一组（`哈喽.ts` ↔ `哈喽-PART000.ts`，同一时间戳） */
  ok(
    '连字符分段与原始文件归为一组（同时间戳）',
    recordingGroupKey('2026-09-24 01-01-56-910 哈喽.ts') === recordingGroupKey('2026-09-24 01-01-56-910 哈喽-PART000.ts'),
    recordingGroupKey('2026-09-24 01-01-56-910 哈喽-PART000.ts'),
  );
}

/* ================= 3. 同名弹幕配对 ================= */
section('3. 弹幕配对');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-rec-'));
  const video = path.join(dir, '2026-09-22 22-27-18-350 来两下闪身步就好了.flv');
  fs.writeFileSync(video, 'x');
  eq('没有弹幕文件时返回 undefined', findSiblingDanmaku(video), undefined);
  fs.writeFileSync(path.join(dir, '2026-09-22 22-27-18-350 来两下闪身步就好了.xml'), '<i/>');
  const hitXml = findSiblingDanmaku(video);
  eq('找到同名 xml', hitXml?.kind, 'xml');
  fs.writeFileSync(path.join(dir, '2026-09-22 22-27-18-350 来两下闪身步就好了.ass'), '[Script Info]');
  eq('xml 与 ass 同时存在时优先 xml（与信令口径一致）', findSiblingDanmaku(video)?.kind, 'xml');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ================= 4. 从 biliLive-tools 配置里挖录制目录与房间 ================= */
section('4. 读 biliLive-tools 的配置');
{
  // 实测字段名是 recorder.savePath（不是 webhook.recoderFolder）——
  // 一开始只找后者，导致永远探测不到，扫描范围退化成硬编码的 Downloads\Bilibili，
  // 用户放在 Downloads\抖音\<主播> 的录播就完全扫不到（这是用户实际反馈过的问题）。
  const real = {
    recorder: { savePath: 'C:\\Users\\someone\\Downloads' },
    video: { subSavePath: 'C:\\Users\\someone\\Downloads' },
    tool: { download: { savePath: 'D:\\抖音录播' } },
    webhook: { open: true, recoderFolder: 'E:\\老字段' },
  };
  const dirs = recorderFoldersFromConfig(real);
  ok('能认出实测字段 recorder.savePath', dirs.includes('C:\\Users\\someone\\Downloads'), JSON.stringify(dirs));
  ok('能认出 tool.download.savePath（抖音录播可能分开存）', dirs.includes('D:\\抖音录播'), JSON.stringify(dirs));
  ok('老字段 webhook.recoderFolder 仍然兼容', dirs.includes('E:\\老字段'), JSON.stringify(dirs));
  ok('重复目录只保留一份', dirs.filter((d) => d === 'C:\\Users\\someone\\Downloads').length === 1, JSON.stringify(dirs));
  eq('单值版本返回第一个', recorderFolderFromConfig(real), 'C:\\Users\\someone\\Downloads');
  eq('没有该字段时返回空数组', recorderFoldersFromConfig({ a: { b: 1 } }), []);
  eq('字段为空串时忽略', recorderFoldersFromConfig({ recorder: { savePath: '   ' } }), []);
  const cyc: Record<string, unknown> = { webhook: {} };
  (cyc['webhook'] as Record<string, unknown>)['self'] = cyc;
  eq('遇到循环引用不卡死', recorderFoldersFromConfig(cyc), []);

  // 房间号：只查配置里那一个房间的话，别的主播的录制历史永远进不来
  const cfgLike = {
    virtualRecord: { config: [{ roomId: 23456789 }, { roomId: '12345678' }] },
    room: { roomId: '111' },
    task: { list: [{ room_id: 999 }] },
  };
  const rooms = roomIdsFromConfig(cfgLike);
  ok('能挖出多个房间号（roomId 与 room_id 两种写法）', rooms.includes('23456789') && rooms.includes('12345678') && rooms.includes('999'), JSON.stringify(rooms));
  eq('去重', roomIdsFromConfig({ a: { roomId: 123456 }, b: { roomId: 123456 } }), ['123456']);
  eq('非数字的房间号被忽略', roomIdsFromConfig({ a: { roomId: 'abc' } }), []);
}

/* ================= 4b. 扫描范围：多个主播目录 + 排除系统目录 ================= */
section('4b. 扫描范围');
{
  const cfg = loadConfig().config;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-roots-'));
  /** 造一个主播目录 + 一个视频文件（体积够小，测试里把 minSizeMB 设为 0） */
  const makeAnchor = (rel: string, file: string): string => {
    const d = path.join(root, rel);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, file), 'x');
    return d;
  };
  const bili = makeAnchor(path.join('Bilibili', '甲主播'), '2026-09-22 20-00-00-000 标题A.flv');
  const douyin = makeAnchor(path.join('抖音', '主播杨树'), '2026-08-15 18-58-49-514 标题B.mp4');
  // 系统/回收站目录：必须被跳过
  makeAnchor(path.join('$RECYCLE.BIN', 'S-1-5-21'), '被删掉的东西.mp4');
  makeAnchor(path.join('node_modules', 'pkg'), '不该出现.mp4');

  const res = await listRecordingsDetailed({ ...cfg, import: { ...cfg.import, scanDirs: [root], minSizeMB: 0, maxDepth: 4 } }, {
    limit: 50,
    includeFallbackDirs: false, // 只扫测试目录，别把真实录播目录也扫进来
  });
  const groups = [...new Set(res.candidates.map((c) => c.group))].sort();
  ok('多个主播目录都能扫到（B站 + 抖音）', groups.includes('甲主播') && groups.includes('主播杨树'), JSON.stringify(groups));
  ok('回收站目录被排除', !groups.some((g) => g.toLowerCase().includes('recycle')), JSON.stringify(groups));
  ok('node_modules 被排除', !groups.includes('pkg'), JSON.stringify(groups));
  ok('报告了实际扫描目录', res.scanRoots.includes(root), JSON.stringify(res.scanRoots));
  eq('两个主播各 1 场', res.candidates.length, 2);

  // 子目录被父目录覆盖时不重复扫（否则同一个文件会出现两次）
  const sub = path.join(root, 'Bilibili');
  const res2 = await listRecordingsDetailed({ ...cfg, import: { ...cfg.import, scanDirs: [root, sub], minSizeMB: 0, maxDepth: 4 } }, { limit: 50, includeFallbackDirs: false });
  ok('父目录已覆盖时不再单列子目录（避免重复扫）', res2.scanRoots.length === 1 && res2.scanRoots[0] === root, JSON.stringify(res2.scanRoots));
  eq('候选数没有因为重复扫描而翻倍', res2.candidates.length, 2);
  void bili;
  void douyin;

  fs.rmSync(root, { recursive: true, force: true });
}

/* ================= 4c. extraDirs 必须真的参与扫盘（轮询导入的唯一入口） ================= */
section('4c. extraDirs 参与扫盘（回归：声明了却不读 → 轮询静默失效）');
{
  const cfg = loadConfig().config;
  /* 实测事故：把新录播丢进 import.watch.dirs，线上轮询连扫 6 分钟都发现不了。
     根因是 `listRecordingsDetailed` 收了 `opts.extraDirs` 却从没读它 ——
     而 `WatchImporter` 正是用它传 `import.watch.dirs` 的；
     它同时传 `includeFallbackDirs: false`，于是 `scanDirs` 为空时扫描根**全空**、
     扫盘一步不做，轮询退化成了「只轮 biliLive-tools 录制历史」。
     这里锁死：只给 extraDirs（不给 scanDirs）、且关掉兜底目录，也必须扫到。 */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-extradirs-'));
  const watchDir = path.join(root, '自动导入测试');
  fs.mkdirSync(watchDir, { recursive: true });
  fs.writeFileSync(path.join(watchDir, '2026-09-23 20-50-00-000 自动导入验证.mp4'), 'x');

  const res = await listRecordingsDetailed(
    { ...cfg, import: { ...cfg.import, scanDirs: [], minSizeMB: 0, maxDepth: 4 } },
    { extraDirs: [watchDir], includeFallbackDirs: false, limit: 50 },
  );
  ok('只给 extraDirs 也必须产生扫描根', res.scanRoots.length > 0, JSON.stringify(res.scanRoots));
  ok('扫描根就是 extraDirs 里的目录', res.scanRoots.includes(watchDir), JSON.stringify(res.scanRoots));
  const hit = res.candidates.find((c) => c.videoPath.toLowerCase().startsWith(watchDir.toLowerCase()));
  ok('extraDirs 里的新录播被发现', Boolean(hit), JSON.stringify(res.candidates.map((c) => c.fileName)));
  eq('它来自扫盘而不是录制历史', hit?.source, 'scan');
  ok('没被发现就说明这条路又断了（这条断言是本次事故的正面证据）', Boolean(hit) && res.candidates.filter((c) => c.source === 'scan').length === 1);

  /* extraDirs 与 scanDirs 是等价叠加：两边都给同一个目录时不能扫两遍 */
  const both = await listRecordingsDetailed(
    { ...cfg, import: { ...cfg.import, scanDirs: [watchDir], minSizeMB: 0, maxDepth: 4 } },
    { extraDirs: [watchDir], includeFallbackDirs: false, limit: 50 },
  );
  eq('两个入口给同一目录时不重复扫', both.scanRoots.length, 1);
  eq('候选数不翻倍', both.candidates.filter((c) => c.source === 'scan').length, 1);

  fs.rmSync(root, { recursive: true, force: true });
}
/* ================= 4d. 同一段素材的「原始 + UUID 弹幕版」只能算一场 ================= */
section('4d. 防覆盖 UUID 产物不另算一场（回归：重复导入 + 重复花 ASR）');
{
  const cfg = loadConfig().config;
  /* 实测事故：`import.watch.dirs` 里同一个 3.5 分钟分段被导入了两次 ——
     `auto-20260923165650-nnxn`（原始 ts）与 `auto-20260923165851-y0eu`（它的弹幕版，
     文件名带 biliLive-tools 的防覆盖 UUID）。两场都跑了转写/分析，等于同一段素材花两遍钱，
     而且两场各自都可能走完投稿 → 重复稿件。这里锁死"清单里只出现一场"。 */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-uuid-dup-'));
  const raw = path.join(root, '2026-09-24 00-48-58-767 哈喽.ts');
  const burned = path.join(root, '2026-09-24 00-48-58-767 哈喽-弹幕版-6e88e7c6-1c78-4827-917b-c7e62ad18fc9.mp4');
  fs.writeFileSync(raw, 'x');
  fs.writeFileSync(burned, 'x');

  const res = await listRecordingsDetailed(
    { ...cfg, import: { ...cfg.import, scanDirs: [root], minSizeMB: 0, maxDepth: 2 } },
    { includeFallbackDirs: false, limit: 50, probe: false },
  );
  eq('同一段素材只产生一场（不是两场）', res.candidates.length, 1);
  const c = res.candidates[0]!;
  eq('两个文件列为同一场的两个变体', c.variants.length, 2);
  eq('首选源文件是原始 ts（不是压制产物）', path.extname(c.fileName).toLowerCase(), '.ts');
  eq('首选源文件没有把压制产物的"已烧弹幕"算到自己头上', c.hasDanmakuInPicture, false);
  ok('弹幕版变体仍被标成已烧弹幕', c.variants.some((v) => v.hasDanmakuInPicture) === true, JSON.stringify(c.variants.map((v) => [v.fileName, v.hasDanmakuInPicture])));
  eq('标题里不留 UUID', c.title, '哈喽');

  /* 台账里已有这一场（按原始 ts 路径登记）→ 整场都算已导入。
     真实事故的后续形态正是这样：原始 ts 投稿完成被清理删掉，盘上只剩弹幕版产物，
     只按"首选文件的路径"判重就又导了一次 → 重复转写、重复投稿。 */
  const cfg2 = { ...cfg, import: { ...cfg.import, scanDirs: [root], minSizeMB: 0, maxDepth: 2 } };
  const fakeLedger = {
    listTasks: () => [
      { id: 'auto-20260924004858-x8zd', status: 'PUBLISHED', source: { rawFiles: [raw] } },
    ],
  } as never;
  const dup = await listRecordingsDetailed(cfg2, { ledger: fakeLedger, includeFallbackDirs: false, limit: 50, probe: false });
  eq('已导入过的这一场仍然只列一场', dup.candidates.length, 1);
  eq('整组命中台账 → 标记已导入（轮询会跳过，不再花 ASR 钱）', dup.candidates[0]?.importedBy?.taskId, 'auto-20260924004858-x8zd');

  /* 实测形态：这一场被 bug 导入了两次（原始 ts 一个任务、弹幕版产物一个任务），
     报出来的应当是**源文件自己的**那个任务，不能随机漂到变体那个任务上。 */
  const fakeLedger2 = {
    listTasks: () => [
      { id: 'auto-20260924005851-y0eu', status: 'CLIPPED', source: { rawFiles: [burned] } },
      { id: 'auto-20260924005650-nnxn', status: 'PUBLISHED', source: { rawFiles: [raw] } },
    ],
  } as never;
  const dup2 = await listRecordingsDetailed(cfg2, { ledger: fakeLedger2, includeFallbackDirs: false, limit: 50, probe: false });
  eq('一场被导入两次时报出源文件那个任务（消息不漂移）', dup2.candidates[0]?.importedBy?.taskId, 'auto-20260924005650-nnxn');

  fs.rmSync(raw, { force: true }); // 模拟投稿后清理删掉了源文件
  const survived = await listRecordingsDetailed(cfg2, { ledger: fakeLedger, includeFallbackDirs: false, limit: 50, probe: false });
  eq('源文件被清理后只剩弹幕版，仍认得出这一场已导入', survived.candidates[0]?.importedBy?.taskId, 'auto-20260924004858-x8zd');

  fs.rmSync(root, { recursive: true, force: true });
}

/* ====== 4g. 「已闭合的分段」不能被「正在录的分段」拖住（回归：整场不导入） ======
 *
 * 实测事故（2026-09-24 晚，用户问「录播为什么没有导入」）：
 * 甲主播那场是「一场录制分多段」的命名 —— 第 1 段闭合后叫 `18-00-41-946 X.ts`（2.7 GB），
 * 而正在录的第 2 段叫 `18-00-41-946 X-PART001.ts` —— **同一个归并键**（`-PART001` 会被剥掉）。
 * 旧实现取「组内最晚 mtime」判断是否仍在录制，于是整组被判为"还在录" →
 * 目录轮询**整场跳过**，已经写完的整整一小时素材一直进不来，要等整场直播结束。
 * 正确行为：已闭合的部分立即可以导入，正在写的分段排除在外并如实报出还有几段。 */
section('4g. 已闭合的分段不被「正在录」的分段拖住（回归：整场不导入）');
{
  const cfg = loadConfig().config;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-pending-part-'));
  const closed = path.join(root, '2026-09-24 18-00-41-946 我来了.ts');
  const writing = path.join(root, '2026-09-24 18-00-41-946 我来了-PART001.ts');
  fs.writeFileSync(closed, 'x');
  fs.writeFileSync(writing, 'x');
  // 已闭合的那个：把 mtime 拨回 1 小时前；正在录的那个保持"现在"（默认就是现在）
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(closed, old, old);

  const res = await listRecordingsDetailed(
    { ...cfg, import: { ...cfg.import, scanDirs: [root], minSizeMB: 0, maxDepth: 2 } },
    { includeFallbackDirs: false, limit: 50, probe: false },
  );
  eq('同一场仍然只列一场', res.candidates.length, 1);
  const c = res.candidates[0]!;
  eq('首选文件是**已闭合**的那一段', path.basename(c.videoPath), path.basename(closed));
  eq('不再被判成"仍在录制"（否则轮询整场跳过）', c.possiblyRecording, false);
  eq('如实报出还有 1 段在录', c.pendingParts, 1);
  eq('还在写的分段不进 variants（否则轮询继续跳过）', c.variants.length, 1);
  eq('variants 里就是已闭合的那段', path.basename(c.variants[0]!.videoPath), path.basename(closed));

  /* 分段发现也必须拒绝"还在写"的文件：否则导入已闭合那段时会把半场素材当成第 2 段，
     总时长/切点/全局时间轴全建立在残缺数据上。 */
  const all = discoverSegments(closed);
  eq('不带时间窗时仍能认出两段（说明第 0 段补位确实会合并它们）', all.length, 2);
  const filtered = discoverSegments(closed, { skipFreshWithinSec: RECORDING_WINDOW_SEC });
  eq('带时间窗后只剩已闭合的那段', filtered.length, 1);
  eq('留下的正是样本自己', path.basename(filtered[0]!), path.basename(closed));

  /* 反向保护：整组都还在写时，必须维持原来的"仍在录制"判定（不能反过来漏掉） */
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-all-fresh-'));
  fs.writeFileSync(path.join(root2, '2026-09-24 19-00-00-000 全在录.ts'), 'x');
  fs.writeFileSync(path.join(root2, '2026-09-24 19-00-00-000 全在录-PART001.ts'), 'x');
  const fresh = await listRecordingsDetailed(
    { ...cfg, import: { ...cfg.import, scanDirs: [root2], minSizeMB: 0, maxDepth: 2 } },
    { includeFallbackDirs: false, limit: 50, probe: false },
  );
  eq('整组都在写时仍判为"仍在录制"', fresh.candidates[0]?.possiblyRecording, true);
  eq('这种时候不报 pendingParts（整场都还不能导）', fresh.candidates[0]?.pendingParts, undefined);

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(root2, { recursive: true, force: true });
}

/* ================= 4e. 多分段必须真的被合并（回归：匹配器漏了分隔符） ================= */
section('4e. 多分段合并（回归：分段匹配器永远匹配不上 → N 段被当成 N 场）');
{
  /* 实测事故：`…来两下闪身步就好了_PART000.flv` 与 `_PART001.flv`（同一时间戳）
     传给 `discoverSegments` 只返回 1 段 —— `segmentPattern` 用 `/i` 认出了分段形态，
     但它生成的匹配器既丢了「前缀后的分隔符」（`_`），又没有 `i`，
     于是**连样本自己都匹配不上**，多分段录播被当成 N 场分别导入：
     N 次转写（都花钱）、N 次选片、N 份投稿。这里把两种真实命名都锁死。 */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-segs-'));
  const underscore = '2026-09-22 22-49-42-277 来两下闪身步就好了_PART000.flv';
  fs.writeFileSync(path.join(root, underscore), 'x');
  fs.writeFileSync(path.join(root, '2026-09-22 22-49-42-277 来两下闪身步就好了_PART001.flv'), 'x');
  const s1 = discoverSegments(path.join(root, underscore));
  eq('_PART000/_PART001 合并为 2 段', s1.length, 2);
  eq('按段号升序（不是字符串序）', path.basename(s1[0] ?? ''), underscore);

  const dash = '2026-09-24 01-01-56-910 哈喽-PART000.ts';
  fs.writeFileSync(path.join(root, dash), 'x');
  fs.writeFileSync(path.join(root, '2026-09-24 01-01-56-910 哈喽-PART001.ts'), 'x');
  eq('连字符 -PART000/-PART001 合并为 2 段', discoverSegments(path.join(root, dash)).length, 2);

  /* 反例：**不同时间戳**的连续录制不能被合并 ——
     它们是两场（biliLive-tools 各录各的），合并会把时间轴拼错；
     实测 2026-09-24 的 `00-52-25-165 哈喽.ts`(561s) 与 `01-01-56-910 哈喽-PART000.ts`(152s+)
     就是首尾相接的两段，各按一场处理。 */
  fs.writeFileSync(path.join(root, '2026-09-24 00-52-25-165 哈喽.ts'), 'x');
  eq('不同时间戳的分段不合并（保守策略）', discoverSegments(path.join(root, '2026-09-24 00-52-25-165 哈喽.ts')).length, 1);

  fs.rmSync(root, { recursive: true, force: true });
}

section('5. 导入预览');
{
  const cfg = loadConfig().config;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-prev-'));
  const video = path.join(dir, '2026-09-22 22-27-18-350 来两下闪身步就好了.flv');
  fs.writeFileSync(video, 'not-a-real-video');

  // 文件存在但不是真视频 → 应报「不可用」而不是静默放行
  const p1 = await previewRecording(video, cfg, {});
  ok('坏文件被标为不可用', p1.usable === false, JSON.stringify(p1.brokenReason));
  ok('坏文件给出可执行的原因', p1.warnings.some((w) => /无法解析/.test(w)), JSON.stringify(p1.warnings));
  ok('坏文件不做 ASR 预检（避免算错费用）', p1.asr === undefined);
  eq('标题仍然能从文件名解析出来', p1.title, '来两下闪身步就好了');

  // 加上「-弹幕版」变体 → 预览要提示「同一场还有已烧弹幕的版本」
  const burned = path.join(dir, '2026-09-22 22-27-18-350 来两下闪身步就好了-弹幕版.mp4');
  fs.writeFileSync(burned, 'x');
  const p2 = await previewRecording(video, cfg, {});
  eq('识别出同一场的两个版本', p2.variants.length, 2);
  ok('提示另一个版本已烧弹幕', p2.warnings.some((w) => /已烧弹幕的版本/.test(w)), JSON.stringify(p2.warnings));
  ok('首选仍是未烧弹幕的原始文件', p2.hasDanmakuInPicture === false);

  // 直接选「-弹幕版」→ 必须明确告知「切片时不再传 ASS」
  const p3 = await previewRecording(burned, cfg, {});
  ok('选压制产物时提示「画面已烧弹幕」', p3.warnings.some((w) => /已烧弹幕/.test(w)), JSON.stringify(p3.warnings));
  eq('该文件的 hasDanmakuInPicture 为 true（导入时会写进台账）', p3.hasDanmakuInPicture, true);

  // 没有弹幕 → 提示「只能依赖转写」
  ok('没有弹幕时明确提示', p2.warnings.some((w) => /没有找到配套弹幕文件/.test(w)), JSON.stringify(p2.warnings));

  /* 变体级判重：台账里这场已经有任务（登记的是原始 flv），现在用户想导它的弹幕版 ——
     同一段素材再导一次会重新转写、并可能投出重复稿件，必须明确提示。 */
  const p4 = await previewRecording(burned, cfg, {
    ledger: { listTasks: () => [{ id: 'auto-20260922123456-abcd', status: 'SUBMITTED', source: { rawFiles: [video] } }] } as never,
  });
  ok('同一场的另一个变体已导入时明确提示', p4.warnings.some((w) => /这一场已经导入过/.test(w)), JSON.stringify(p4.warnings));
  ok('提示里带上已有任务的编号', p4.warnings.some((w) => /auto-20260922123456-abcd/.test(w)), JSON.stringify(p4.warnings));

  // 文件不存在 → 直接抛错，不能返回一个"看起来能导"的预览
  let threw = false;
  try {
    await previewRecording(path.join(dir, '不存在.flv'), cfg, {});
  } catch {
    threw = true;
  }
  ok('文件不存在时抛错（不给假预览）', threw);

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ================= 6. 摘要行 ================= */
section('6. 摘要行');
{
  const base = {
    videoPath: 'v.flv',
    fileName: 'v.flv',
    group: '主播',
    sizeBytes: 100 * 1024 * 1024,
    durationSec: 3600,
    danmaPath: 'v.xml',
    danmaKind: 'xml' as const,
    danmaSource: 'sibling' as const,
    title: 'T',
    titleSource: 'filename' as const,
    hasDanmakuInPicture: false,
    usable: true,
    segmentCount: 1,
    source: 'scan' as const,
    variants: [],
    possiblyRecording: false,
  };
  const s1 = describeCandidate(base);
  ok('摘要含时长/大小/弹幕/段数', /1:00:00/.test(s1) && /100\.0 MB/.test(s1) && /弹幕 xml/.test(s1) && /1 段/.test(s1), s1);
  ok('仍在录制时摘要里能看出来', /可能仍在录制/.test(describeCandidate({ ...base, possiblyRecording: true })));
  ok('已导入时摘要里能看出来', /已导入/.test(describeCandidate({ ...base, importedBy: { taskId: 't', status: 'CLIPPED' } })));
  ok('不可用时摘要里能看出来', /文件不可用/.test(describeCandidate({ ...base, usable: false })));
  ok('多版本时摘要里能看出来', /2 个版本/.test(describeCandidate({ ...base, variants: [{ videoPath: 'a', fileName: 'a', sizeBytes: 1, sizeMB: 0, hasDanmakuInPicture: false, mtimeMs: 0 }, { videoPath: 'b', fileName: 'b', sizeBytes: 1, sizeMB: 0, hasDanmakuInPicture: true, mtimeMs: 0 }] })));
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (fail > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
  process.exitCode = 1;
} else {
  console.log('\x1b[32m录播发现与导入预览行为符合预期。\x1b[0m');
}
