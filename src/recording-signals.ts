/**
 * 「现在到底还有没有在录」的**唯一判据来源**（2026-10-24 加）。
 *
 * 为什么要把这件事抽出来：同一台机器上有三处地方需要回答这个问题，而它们当初各写了一份，
 * 于是**互相矛盾** —— 用户 2026-10-24 的截图就是最坏的那种：
 *   · 运行观测页：「正在录制的文件 1 个」1.13 GB、0.76 MB/s、最后写入 0 秒前；
 *   · 直播间状态：`state=recording`、7.3 小时前那次之后一直在录；
 *   · 而「跑完自动关机」页：「没有正在录制 / 可能还在录的场次 **0 场**」。
 *
 * 根因（真实教训，写在这里以免以后又被"统一"回去）：
 *   自动关机那一栏只统计 **watcher 的 mp4 导入候选项**（`possiblyRecording` / `pendingParts`）。
 *   而 biliLive-tools 的分段录制写的是 `.ts`（`…-PART007.ts`），watcher 从不把它当导入候选，
 *   所以这一项**永远是 0**；同一时刻 `/api/monitor` 的 `recordingNow` 同源，于是监控页也跟着瞎。
 *   后果不是"数字难看"，而是：`llcQueue=[]` + 流水线空闲时其余门槛一旦满足，
 *   **自动关机会在直播录制中途把机器关掉** —— 那一场录制直接废掉（数据丢失）。
 *
 * 所以这里定义三个**互不覆盖**的信号源，任何一源说"在录"就算在录：
 *   ① `watcher`  —— 目录轮询的 mp4 候选项（possiblyRecording / pendingParts）；
 *   ② `raw`      —— 录制目录里**体积还在长的原始分段**（.ts/.flv/.mp4/.mkv）；
 *   ③ `recorder` —— biliLive-tools 录制器自报的 `state === 'recording'`（最权威，但要问得到）。
 *
 * 归并口径：**同一场次被多源同时命中只算 1 场**。每条证据带 1~3 个键：
 *   · 文件场次键 =「房间目录 + 文件名里的开录时间戳」（同一场直播的 PART001…PART007
 *     共享同一个 `2026-10-24 17-59-44-718` 前缀，所以它能把跨源的两条认成同一场）；
 *   · 台账 `taskId`（同一任务下的多个文件）；
 *   · 录制器 `channelId`（同一房间的录制器）。
 * 用并查集把**任意键相同**的证据并成一组，于是"watcher 说 PART001 可能还在录"与
 * "raw 说 PART007 在长"不会被算成两场。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseRecordingFileName } from './recordings.ts';

/* ============================================================================
 * 1. 扫描录制目录
 * ========================================================================== */

/** 一次扫描看到的录制文件（只带判据需要的字段） */
export interface RecordingFileInfo {
  /** 绝对路径（采样缓存的键） */
  path: string;
  /** 文件名（界面显示用） */
  name: string;
  sizeBytes: number;
  /** 最后写入距今多少秒（负数按 0 处理） */
  ageSec: number;
}

/** 录制目录的层级深度：录制文件通常在 `<根>/<主播名>/` 下，两层足够 */
const SCAN_MAX_DEPTH = 2;
/** 扫描时收哪些扩展名：媒体文件 + `.pre-transcribe.json` 这类状态文件（观测页要用） */
const SCAN_EXT = /\.(ts|flv|mp4|mkv|json)$/i;

/**
 * 扫描若干录制根目录（最多两层），返回所有文件的体积与写入新鲜度。
 *
 * 与 `observeView` 原来的实现**逐字等价**（同样的深度、同样的扩展名、单个文件读不到就跳过），
 * 只是抽成函数，好让监控页与自动关机 gate 用同一份 —— 两处各写一份正是这次 Bug 的来源。
 *
 * 读不到目录不抛错：录制盘掉线/权限变化时，调用方要能继续用其它信号判。
 */
export function scanRecordingFiles(
  dirs: readonly string[],
  opts: { now?: number; maxDepth?: number } = {},
): RecordingFileInfo[] {
  const now = opts.now ?? Date.now();
  const maxDepth = Math.max(0, opts.maxDepth ?? SCAN_MAX_DEPTH);
  const files: RecordingFileInfo[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在/没权限：跳过（不是判据失败）
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!SCAN_EXT.test(e.name)) continue;
      try {
        const st = fs.statSync(full);
        files.push({ path: full, name: e.name, sizeBytes: st.size, ageSec: Math.max(0, Math.round((now - st.mtimeMs) / 1000)) });
      } catch {
        /* 单个文件读不到就跳过 */
      }
    }
  };
  for (const d of dirs) {
    if (typeof d === 'string' && d.length > 0) walk(d, 0);
  }
  return files;
}

/* ============================================================================
 * 2. 判定「这段还在写吗」
 * ========================================================================== */

/** 「正在录制」的时间窗（秒）：超过这么久没被写过就不算在录（与观测页原来的值一致） */
export const RECORDING_ACTIVE_WINDOW_SEC = 300;
/**
 * 第一次见到某文件时的"新鲜度"判据（秒）：没有上一轮采样做基准时，
 * 用"90 秒内被写过"当作"在写"。宁可多等一轮，也不要在录制中途判成"写完了"。
 */
export const RECORDING_FRESH_SEC = 90;

/** 采样缓存：文件路径 → 上次看到的体积与时刻（算速率 + 判断"有没有变大"） */
const sizeCache = new Map<string, { bytes: number; at: number }>();
/** 缓存条目上限：录制目录长期变化时不让它无限攒 */
const SIZE_CACHE_MAX = 1000;

/** 清空采样缓存（只给测试用：避免用例之间互相污染） */
export function resetRecordingSampleCache(): void {
  sizeCache.clear();
}

/** 「正在写」的原始分段 */
export interface LiveSegment {
  path: string;
  name: string;
  /** 房间目录（绝对路径） */
  dirPath: string;
  /** 房间目录名（= 主播名，用户一眼能认出是哪一场） */
  dirName: string;
  /** 文件名里的开录时间戳（`2026-10-24 17-59-44-718`），同一场各分段共享；取不到为 '' */
  stamp: string;
  /** 从文件名解析出的标题（取不到就退回文件名） */
  title: string;
  sizeBytes: number;
  ageSec: number;
  /** 两次采样算出的写入速率（MB/s）；没有基准时为 null */
  rateMBps: number | null;
  /** ★ 是否**还在长**：有基准时看体积有没有变大，没基准时看是不是 90 秒内写过 */
  growing: boolean;
  /** 是否压制产物（`-弹幕版` / `-纯享版`）：它也在写，但语义是"在压制"而不是"在录制" */
  product: boolean;
}

/** 从文件名里取开录时间戳（`2026-10-24 17-59-44-718`）；取不到返回 '' */
export function stampTextOf(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '');
  const m = /^(\d{4}[-_/]\d{1,2}[-_/]\d{1,2}[ _]\d{1,2}[-_:]\d{1,2}[-_:]\d{1,2}(?:[-_.]\d{1,3})?)\s+/.exec(base);
  return m ? m[1]! : '';
}

/**
 * 场次归并键：**房间目录 + 开录时间戳**（拿不到时间戳就退回去掉分段/产物后缀的基名）。
 *
 * 为什么用时间戳而不是文件名：同一场直播会写成 `PART001…PART007` 多个文件（时间戳相同、分段号不同），
 * 而且 watcher 报的是 PART001、磁盘上在长的是 PART007 —— 只有时间戳能把它们归成同一场。
 */
export function sessionKeyOf(filePath: string): string {
  const dir = path.dirname(filePath).toLowerCase();
  const name = path.basename(filePath);
  const parsed = parseRecordingFileName(name);
  if (typeof parsed.recordedAt === 'number' && Number.isFinite(parsed.recordedAt)) {
    return `${dir}|at:${parsed.recordedAt}`;
  }
  const stamp = stampTextOf(name);
  if (stamp) return `${dir}|stamp:${stamp}`;
  /* 连时间戳都没有（别的下载工具的命名）：整份文件名就是它自己的身份 */
  return `${dir}|name:${parsed.title || name}`;
}

/**
 * 从扫描结果里挑出「正在写」的分段，并更新采样缓存（速率/变大判据）。
 *
 * ⚠️ **不裁剪条数**：调用方要显示时自己 slice；自动关机的 gate 必须看**全部** ——
 * 只取前 N 条可能在"第 N+1 场在录"时漏判，那正好是丢数据的那一次。
 */
export function pickLiveSegments(
  files: readonly RecordingFileInfo[],
  opts: { now?: number; windowSec?: number } = {},
): LiveSegment[] {
  const now = opts.now ?? Date.now();
  const windowSec = Math.max(1, opts.windowSec ?? RECORDING_ACTIVE_WINDOW_SEC);

  /* 先修剪缓存：条目以文件路径为键、只增不删，录制目录长期变化时会一直攒。
     超过阈值就把"半小时没再被采样到"的清掉；还超就整体清空（它只是速率基准）。 */
  if (sizeCache.size > SIZE_CACHE_MAX) {
    const cutoff = now - 30 * 60_000;
    for (const [k, v] of sizeCache) if (v.at < cutoff) sizeCache.delete(k);
    if (sizeCache.size > SIZE_CACHE_MAX) sizeCache.clear();
  }

  const out: LiveSegment[] = [];
  for (const f of files) {
    if (!/\.(ts|flv|mp4|mkv)$/i.test(f.name)) continue;
    if (f.ageSec >= windowSec) continue; // 早就停写的历史文件不算（避免永久误判）
    const prev = sizeCache.get(f.path);
    sizeCache.set(f.path, { bytes: f.sizeBytes, at: now });
    /* 速率用两次采样的差值算（面板 5 秒一刷，足够看出"在长多快"）。
       第一次采样没有基准 ⇒ 如实给 null，让界面显示"—"而不是编一个数。 */
    const rateMBps =
      prev && prev.at && f.sizeBytes > prev.bytes
        ? (f.sizeBytes - prev.bytes) / 1048576 / Math.max(0.001, (now - prev.at) / 1000)
        : null;
    const parsed = parseRecordingFileName(f.name);
    out.push({
      path: f.path,
      name: f.name,
      dirPath: path.dirname(f.path),
      dirName: path.basename(path.dirname(f.path)),
      stamp: stampTextOf(f.name),
      title: parsed.title || f.name,
      sizeBytes: f.sizeBytes,
      ageSec: f.ageSec,
      rateMBps: rateMBps === null ? null : Math.round(rateMBps * 100) / 100,
      growing: prev !== undefined ? f.sizeBytes > prev.bytes : f.ageSec < RECORDING_FRESH_SEC,
      /* 压制产物（画面已烧弹幕/-纯享版）：也在写，但要说成"在压制"而不是"在录制" */
      product: parsed.hasDanmakuInPicture || /-纯享版/i.test(f.name),
    });
  }
  return out;
}

/* ============================================================================
 * 3. biliLive-tools 录制器状态（两个页面共用一份解析）
 * ========================================================================== */

export interface RecorderRow {
  channelId: string;
  owner: string;
  living: boolean;
  state: string;
  /** 上次录制距今多少秒（拿不到为 null） */
  lastRecordSec: number | null;
}

export interface RecorderStatusSummary {
  /** 这次问到了没有（false = 接口异常，调用方**不能**据此判定"没在录"） */
  ok: boolean;
  /** `state` 里带 recording 的录制器个数 */
  recording: number;
  /** 直播间正在直播的个数 */
  living: number;
  recorders: RecorderRow[];
  error?: string;
}

/** `/recorder/list` 的原始行（只列出这里用到的字段） */
export interface RecorderRawRow {
  channelId?: string;
  remarks?: string;
  state?: string;
  liveInfo?: { living?: boolean; owner?: string };
  extra?: { lastRecordTime?: number };
}

/**
 * 把 `/recorder/list` 的原始数组整理成「有几个在录」。
 *
 * 判据是录制器**自己**报的 `state`（`/recording/i`），不是文件时间推断 ——
 * 后者是"事后近似"：一个刚写完的文件与一个正在写的文件看起来一样。
 * 问不到时 `ok=false`，由调用方决定保守到什么程度（自动关机那边按"还在录"处理）。
 */
export function summarizeRecorders(list: readonly RecorderRawRow[], now: number = Date.now()): RecorderStatusSummary {
  const recorders: RecorderRow[] = list.map((r) => ({
    channelId: String(r?.channelId ?? ''),
    owner: String(r?.remarks ?? r?.liveInfo?.owner ?? ''),
    living: r?.liveInfo?.living === true,
    state: String(r?.state ?? ''),
    lastRecordSec:
      typeof r?.extra?.lastRecordTime === 'number' ? Math.max(0, Math.round((now - r.extra.lastRecordTime) / 1000)) : null,
  }));
  return {
    ok: true,
    recording: recorders.filter((x) => /recording/i.test(x.state)).length,
    living: recorders.filter((x) => x.living).length,
    recorders,
  };
}

/* ============================================================================
 * 4. 多源归并：几场？分别是哪几场？
 * ========================================================================== */

/** 一条「还在录」的证据 */
export interface RecordingEvidence {
  /** 来自哪个信号源 */
  source: 'watcher' | 'raw' | 'recorder';
  /** 台账任务 id（watcher 命中时可能有）—— 归并键之一 */
  taskId?: string;
  /** 场次里的某个文件路径（watcher 的 videoPath / 原始分段的绝对路径）—— 归并键之一 */
  path?: string;
  /** 录制器所在房间号（source='recorder' 时用）—— 归并键之一 */
  channelId?: string;
  /** 一句话说明"是哪个"（进 detail 与面板） */
  label: string;
}

export interface RecordingSession {
  /** 归并后这一场的代表键（调试用） */
  key: string;
  /** 这一场被哪些来源命中（按展示顺序排好） */
  sources: Array<'watcher' | 'raw' | 'recorder'>;
  /** 这一场各来源自己的说明（detail 要按来源分段说，不能混着报） */
  bySource: Record<'watcher' | 'raw' | 'recorder', string[]>;
  /** 这一场的全部说明（去重后，面板/调试用） */
  labels: string[];
}

export interface RecordingSessionsSummary {
  count: number;
  /** 人话 detail：「1 场可能还在录（原始分段在写：…-PART007.ts）」 */
  detail: string;
  sessions: RecordingSession[];
  evidence: RecordingEvidence[];
}

/** 一条证据参与归并的键（任意键相同 ⇒ 同一场） */
function mergeKeysOf(e: RecordingEvidence): string[] {
  const keys: string[] = [];
  const fileKey = typeof e.path === 'string' && e.path.length > 0 ? sessionKeyOf(e.path) : '';
  if (fileKey) keys.push(`file:${fileKey}`);
  if (typeof e.taskId === 'string' && e.taskId.length > 0) keys.push(`task:${e.taskId}`);
  if (typeof e.channelId === 'string' && e.channelId.length > 0) keys.push(`rec:${e.channelId}`);
  return keys;
}

/** 来源的展示顺序（raw 最能说明"文件在长"，排最前） */
const SOURCE_ORDER: Array<RecordingEvidence['source']> = ['raw', 'recorder', 'watcher'];
/** 每种来源在 detail 里的说法 */
const SOURCE_TEXT: Record<RecordingEvidence['source'], string> = {
  raw: '原始分段在写',
  recorder: '录制器 recording',
  watcher: '轮询候选项仍未写稳',
};

/**
 * 把多源证据归并成「几场」。**去重是关键**：同一场被 watcher 与 raw 同时命中只算 1 场，
 * 否则界面上会写"2 场"，用户看到"我只开了一个直播间"就再也不会相信这个数字了。
 *
 * 做法：并查集。每条证据带 1~3 个键（文件场次键 / taskId / 房间号），任意键相同即并组。
 * 这样既能按 taskId 归并（同一任务的多个文件），也能按"房间目录 + 开录时间戳"跨源归并
 * （watcher 报 PART001、磁盘上在长的是 PART007 —— 只有时间戳能把它们认成同一场）。
 */
export function summarizeRecordingEvidence(evidence: readonly RecordingEvidence[]): RecordingSessionsSummary {
  const n = evidence.length;
  const parent: number[] = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r]!;
    /* 路径压缩：证据条数很少（个位数），但别留成链 */
    let c = i;
    while (parent[c] !== r) {
      const next = parent[c]!;
      parent[c] = r;
      c = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const firstWithKey = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    for (const k of mergeKeysOf(evidence[i]!)) {
      const prev = firstWithKey.get(k);
      if (prev === undefined) firstWithKey.set(k, i);
      else union(prev, i);
    }
  }

  const groups = new Map<number, RecordingSession>();
  /** 空的分来源说明表（每次新建，避免多个场次共享同一个数组） */
  const emptyBySource = (): Record<'watcher' | 'raw' | 'recorder', string[]> => ({ watcher: [], raw: [], recorder: [] });
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const e = evidence[i]!;
    const keys = mergeKeysOf(e);
    let cur = groups.get(root);
    if (!cur) {
      cur = { key: keys[0] ?? `i:${i}`, sources: [], bySource: emptyBySource(), labels: [] };
      groups.set(root, cur);
    }
    if (!cur.sources.includes(e.source)) cur.sources.push(e.source);
    if (!cur.labels.includes(e.label)) cur.labels.push(e.label);
    /* 同一场同一来源可能有多条（PART001 与 PART007 都在写）：都留着，detail 里"…等 N 条"能交代 */
    if (!cur.bySource[e.source].includes(e.label)) cur.bySource[e.source].push(e.label);
  }

  const sessions = [...groups.values()].map((s) => ({
    ...s,
    sources: [...s.sources].sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b)),
  }));

  return { count: sessions.length, detail: describeRecordingSessions(sessions), sessions, evidence: [...evidence] };
}

/** 最多列几个文件名（再多就"…等 N 条"）——detail 是要给人看的一句话，不是清单 */
const MAX_LABELS_PER_SOURCE = 2;

/**
 * 把归并结果写成**来源清单**：「原始分段在写：A、B；录制器 recording：C」（没有就是空串）。
 *
 * 单独抽出来是因为自动关机的"原因"要用它：那边自己已经写了「有 N 场可能正在录制（…）」，
 * 若这里再返回带场次数的整句，日志里就会变成「有 1 场可能正在录制（1 场可能还在录（…））」
 * —— 括号套括号，读起来像机器生成的。
 */
export function describeRecordingSources(sessions: readonly RecordingSession[]): string {
  /* 按来源汇总：同一来源的说明合并成一段，用户才知道"数字是被谁撑起来的" */
  const bySource: Record<'watcher' | 'raw' | 'recorder', string[]> = { watcher: [], raw: [], recorder: [] };
  for (const s of sessions) {
    for (const src of SOURCE_ORDER) {
      for (const label of s.bySource[src] ?? []) {
        if (!bySource[src].includes(label)) bySource[src].push(label);
      }
    }
  }
  const parts: string[] = [];
  for (const src of SOURCE_ORDER) {
    const list = bySource[src];
    if (list.length === 0) continue;
    const head = list.slice(0, MAX_LABELS_PER_SOURCE).join('、');
    const tail = list.length > MAX_LABELS_PER_SOURCE ? `…等 ${list.length} 条` : '';
    parts.push(`${SOURCE_TEXT[src]}：${head}${tail}`);
  }
  return parts.join('；');
}

/** 把归并结果写成一句人话：「2 场可能还在录（原始分段在写：A、B；录制器 recording：C）」 */
export function describeRecordingSessions(sessions: readonly RecordingSession[]): string {
  if (sessions.length === 0) return '0 场';
  const sources = describeRecordingSources(sessions);
  return sources ? `${sessions.length} 场可能还在录（${sources}）` : `${sessions.length} 场可能还在录`;
}

/* ============================================================================
 * 5. 给「跑完自动关机」用的门（gate）
 * ========================================================================== */

/** gate 的标题：明确写出"含原始分段在写"，用户才会知道这个数字是怎么来的 */
export const RECORDING_GATE_LABEL = '没有正在录制 / 可能还在录的场次（含原始分段在写）';

export interface RecordingGate {
  count: number;
  label: string;
  /** false = 不能关机 */
  ok: boolean;
  /** 一句话 detail（界面上那一行） */
  detail: string;
  /** 只讲"来源"的那半句（自动关机的 reason 会自己写场次数，避免括号套括号） */
  sources: string;
}

/**
 * 组装「还在录」这道门。
 *
 * 保守原则（与 `auto-shutdown.ts` 的既有注释一致，这两条都是踩一次就丢数据的地方）：
 *   · 任一信号源查询失败 ⇒ **按"还在录"处理**（不通过），并在 detail 里说清是哪一源查不到，
 *     否则用户只会看到"永远不关机"却不知道为什么；
 *   · 历史文件（早已停止写入的 .ts）不算 —— 判据沿用 growing / 新鲜度，
 *     避免"昨天那个 .ts 还在磁盘上 ⇒ 永远不关机"这种反向误判。
 */
export function recordingGate(summary: RecordingSessionsSummary, failedSources: readonly string[] = []): RecordingGate {
  const baseOk = summary.count === 0 && failedSources.length === 0;
  const count = summary.count > 0 ? summary.count : failedSources.length > 0 ? 1 : 0;
  const sources = describeRecordingSources(summary.sessions);
  if (failedSources.length === 0) {
    return { count, label: RECORDING_GATE_LABEL, ok: baseOk, detail: summary.detail, sources };
  }
  /* 不用括号包"按还在录处理"：这句会被塞进自动关机的 reason（那里外面已经有一层括号） */
  const failedText = `查不到 ${failedSources.join('、')}，按"还在录"处理，绝不关机`;
  return {
    count,
    label: RECORDING_GATE_LABEL,
    ok: false,
    detail: summary.count > 0 ? `${summary.detail}；另${failedText}` : failedText,
    sources: summary.count > 0 ? `${sources}；另${failedText}` : failedText,
  };
}

/* ============================================================================
 * 6. 一次"取全部证据 + 出结论"（daemon 只负责把 IO 数据递进来）
 * ========================================================================== */

/** watcher 上一轮的结论（只列这里用到的字段，daemon 的 `WatchImportOutcome` 结构兼容） */
export interface WatcherOutcomeLike {
  videoPath?: string;
  fileName?: string;
  title?: string;
  taskId?: string;
  possiblyRecording?: boolean;
  pendingParts?: number;
  /** 未导入的原因（这里只需要能接收真实结构，判据不看它） */
  skipped?: string;
}

export interface RecordingSignalsInput {
  /** 现在（毫秒）。测试注入固定时钟 */
  now?: number;
  /** watcher 的轮询结论；不传 = 没有 */
  outcomes?: readonly WatcherOutcomeLike[];
  /** 要扫的录制目录（watcher 报的 dirs）；不传 = 不扫盘 */
  dirs?: readonly string[];
  /**
   * 已经扫好的文件。**测试注入用**（真实目录会变、也不能依赖它存在）；
   * 不传就自己去扫 `dirs`。
   */
  files?: readonly RecordingFileInfo[];
  /** 录制器原始行（`/recorder/list` 的结果）；不传 = 当作"没有录制器/没问过" */
  recorders?: readonly RecorderRawRow[];
  /** 已知查询失败的数据源名 —— 保守按"还在录"处理 */
  failed?: readonly string[];
}

/** 一次汇总的结果（gate + 明细，便于日志/测试） */
export interface RecordingSignalsResult {
  gate: RecordingGate;
  summary: RecordingSessionsSummary;
  /** 汇总时累计的失败源（含扫盘失败） */
  failed: string[];
}

/**
 * 把三个信号源的数据合起来，给出「几场在录 + 能不能关机」。
 *
 * 这是 daemon 与单测**共用**的那一步：daemon 只负责把 IO（`watcher.status()` /
 * `/recorder/list` / 目录扫描）取回来，判据全在这里（纯函数，可用 fixture 钉死）。
 * 也正因为如此，"漏掉某个源"的回归在单测里能直接看见，而不是等它把机器关掉才发现。
 */
export function gatherRecordingGate(input: RecordingSignalsInput = {}): RecordingSignalsResult {
  const now = input.now ?? Date.now();
  const failed: string[] = [...(input.failed ?? [])];
  const evidence: RecordingEvidence[] = [];

  /* ① watcher 的 mp4 轮询候选项 */
  for (const o of input.outcomes ?? []) {
    if (o.possiblyRecording !== true && (o.pendingParts ?? 0) <= 0) continue;
    const label = o.fileName || o.title || o.videoPath || '(未命名)';
    evidence.push({
      source: 'watcher',
      ...(typeof o.videoPath === 'string' && o.videoPath ? { path: o.videoPath } : {}),
      ...(typeof o.taskId === 'string' && o.taskId ? { taskId: o.taskId } : {}),
      label,
    });
  }

  /* ② 原始分段（含压制产物）在写 —— ★ 本次 Bug 的核心：只认 mp4 候选项的话这里永远是 0 */
  try {
    const files = input.files ?? scanRecordingFiles(input.dirs ?? [], { now });
    for (const s of pickLiveSegments(files, { now })) {
      if (!s.growing) continue; // 早已停止写入的历史 .ts 不算（避免永久误判）
      evidence.push({ source: 'raw', path: s.path, label: `${s.dirName}/${s.name}` });
    }
  } catch {
    failed.push('录制目录');
  }

  /* ③ biliLive-tools 录制器自报 state */
  if (input.recorders !== undefined) {
    const sum = summarizeRecorders(input.recorders, now);
    /* 「录制器说在录」与「某个目录里的文件在长」是不是同一场？
       能对上的证据是**房间目录名**：biliLive-tools 按主播建子目录（见 server.countCoveredStreamers：
       "录制根目录下的主播子目录"），而录制器行里的 `remarks` 就是主播名、`channelId` 就是房间号。
       对上就把这条证据**挂到那一场的文件路径上**（共用 file 键 ⇒ 归并成 1 场），
       免得界面上写"2 场"而用户明明只开了一个直播间。
       对不上（目录名是自己起的、remaks 是备注）就让它独立成一场 —— 多算一场只会更保守，
       绝不会因此放过"在录"这个事实。 */
    const fileEvidence = evidence.filter((e) => e.source === 'raw' || e.source === 'watcher');
    const roomOfPath = (p?: string): string => (typeof p === 'string' && p ? path.basename(path.dirname(p)).toLowerCase() : '');
    for (const r of sum.recorders) {
      if (!/recording/i.test(r.state)) continue;
      const hints = [r.owner, r.channelId].filter((x): x is string => typeof x === 'string' && x.length > 0).map((x) => x.toLowerCase());
      const twin = fileEvidence.find((e) => {
        const room = roomOfPath(e.path);
        return room.length > 0 && hints.includes(room);
      });
      evidence.push({
        source: 'recorder',
        ...(r.channelId ? { channelId: r.channelId } : {}),
        ...(twin?.path ? { path: twin.path } : {}),
        label: `${r.owner || r.channelId || '未知房间'}${r.living ? '（直播中）' : ''}`,
      });
    }
  }

  const summary = summarizeRecordingEvidence(evidence);
  return { gate: recordingGate(summary, failed), summary, failed };
}
