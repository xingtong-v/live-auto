/**
 * 本地 mock server（WP1 交付物之一，任务书 §8 WP1 步骤 5 / §9 交付物清单 6）。
 *
 * 目的：让 WP2–WP5 **脱离 biliLive-tools 单测**，不依赖真实直播、不产生任何 ASR/LLM 费用。
 *
 * 它模拟的行为尽量贴近实测（docs/api-observed.md）：
 *  - 鉴权：`Authorization: <passKey>`，未通过返回 401（与真实服务一致）
 *  - `/record-history/recent-clips`：**驼峰**字段、**最多 5 条**（陷阱 #10）
 *  - `/record-history/list`：**下划线**字段 + 分页 + `startTime` 单位为**毫秒**（陷阱 #32）
 *  - `/ai/subtitle`：同步返回 SRT；可通过 fixture 配置「第 N 次调用失败」以验证重试与 gaps；
 *    并统计调用次数（**验证缓存命中、断点续跑不重复付费**）
 *  - `/task/cut`：创建任务并让它在若干次轮询后 completed，产出文件真实写到磁盘
 *    （这样 publish.ts 的 `exists(taskOutput)` 校验能通过）
 *  - `/bili/upload`：**只返回 taskId**（陷阱 #11），并把它加入 archives（模拟 B站侧最终可见）
 *  - `/common/version`：返回可配置版本（默认故意与任务书核实的 3.22.1 有差异，用于验证版本漂移告警）
 *
 * 用法：
 *   node test/mock-server.ts                    # 默认 127.0.0.1:18011
 *   node test/mock-server.ts --port 18011 --passkey local-test-key
 *   node test/mock-server.ts --flaky-asr 2      # 第 2 次 /ai/subtitle 调用返回 500
 *   node test/mock-server.ts --clips-seen 3     # 前 3 次轮询返回「录制中」，第 4 次起返回已完成
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { ROOT_DIR, ensureDir, exists, nowIso, writeJsonAtomic } from '../src/util.ts';

/* ============================================================================
 * 参数与状态
 * ========================================================================== */

interface MockOptions {
  host: string;
  port: number;
  passKey: string;
  version: string;
  /** 第 N 次 /ai/subtitle 调用返回 500（1 起算），用于验证重试与 gaps */
  flakyAsr: number;
  /** 前 N 次 recent-clips 返回「录制中」（无 recordEndTime），之后返回已完成 */
  clipsSeen: number;
  /** 启用「断流多段」场景：同一 live_id 有两个录制段 */
  segmented: boolean;
  /** 弹幕 XML 是否包含 SC / 上舰 / 礼物事件 */
  withEvents: boolean;
  /** 立即完成切片任务（不模拟延迟） */
  instant: boolean;
  /** 状态落盘目录（便于 e2e 断言） */
  dataDir: string;
}

function parseArgs(argv: string[]): MockOptions {
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const num = (name: string, fallback: number): number => {
    const v = Number(get(name, String(fallback)));
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    host: get('host', '127.0.0.1'),
    port: num('port', 18011),
    passKey: get('passkey', 'mock-passkey-local'),
    version: get('version', '3.21.0'),
    flakyAsr: num('flaky-asr', 0),
    clipsSeen: num('clips-seen', 0),
    segmented: has('segmented'),
    withEvents: has('with-events'),
    instant: has('instant'),
    dataDir: get('data-dir', path.join(ROOT_DIR, 'data', 'mock')),
  };
}

const cfg = parseArgs(process.argv.slice(2));
ensureDir(cfg.dataDir);
const mediaDir = path.join(cfg.dataDir, 'media');
ensureDir(mediaDir);

/** 内存状态（每次启动重置） */
const state = {
  /** recent-clips 被调用次数（用于模拟「录制中 → 已完成」的演进） */
  recentClipsCalls: 0,
  /** /ai/subtitle 的调用记录（验证缓存命中与断点续跑的关键证据） */
  asrCalls: [] as Array<{ file: string; startTime?: number; endTime?: number; offset?: number; at: string; result: 'ok' | 'fail' }>,
  /** 切片任务 */
  tasks: new Map<string, { taskId: string; type: string; status: string; output?: string; error?: string; polls: number; createdAt: number; body?: unknown }>(),
  /** 已投稿件（模拟 /bili/archives 的来源） */
  archives: [] as Array<Record<string, unknown>>,
  /** 上传任务 → 稿件标题的映射 */
  uploads: new Map<string, { title: string; videos: string[]; config: Record<string, unknown> }>(),
  taskSeq: 1,
  archiveSeq: 1,
  /** 请求日志（便于 e2e 断言调用顺序） */
  requestLog: [] as Array<{ at: string; method: string; path: string; status: number; auth: boolean }>,
};

/* ============================================================================
 * 媒体与弹幕 fixture 生成
 * ========================================================================== */

/** 写一个占位「视频」文件（不需要真能播；publish.ts 只校验存在与非空） */
function makeDummyMedia(name: string, sizeBytes = 2 * 1024 * 1024): string {
  const p = path.join(mediaDir, name);
  if (!exists(p) || fs.statSync(p).size !== sizeBytes) {
    // 用可复现的内容填充，避免每次启动都改变文件大小（缓存键依赖 size + mtime）
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    const fd = fs.openSync(p, 'w');
    let written = 0;
    while (written < sizeBytes) {
      const n = Math.min(chunk.length, sizeBytes - written);
      fs.writeSync(fd, chunk, 0, n);
      written += n;
    }
    fs.closeSync(fd);
  }
  return p;
}

/** 生成一份小规模弹幕 XML */
function makeDanmakuXml(name: string, opts: { withEvents: boolean; durationSec: number }): string {
  const p = path.join(mediaDir, name);
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<i>', '<chatserver>chat.bilibili.com</chatserver>'];
  const phrases = ['好活当赏', '名场面', '这也行', '绝了', '哈哈哈哈哈', '上号', '翻盘了', '稳住别浪', '666', '打卡'];
  const rng = mulberry32(42);
  for (let t = 0; t < opts.durationSec; t += 2) {
    // 在 600-660 与 1200-1260 制造密度峰
    const inPeak = (t >= 600 && t <= 660) || (t >= 1200 && t <= 1260);
    const base = inPeak ? 8 : 2;
    const count = base + Math.floor(rng() * (inPeak ? 6 : 2));
    for (let i = 0; i < count; i++) {
      const sec = (t + rng() * 2).toFixed(2);
      const text = phrases[Math.floor(rng() * phrases.length)]!;
      lines.push(`<d p="${sec},1,25,16777215,1700000000,0,${(rng() * 1e15).toFixed(0)},0">${text}</d>`);
    }
  }
  if (opts.withEvents) {
    lines.push('<sc ts="601.0" user="观众A" price="30" time="10" text="好活当赏" />');
    lines.push('<sc ts="601.5" user="观众B" price="50" time="20" text="这段必须切" />');
    lines.push('<guard ts="602.0" user="舰长C" level="3" num="1" text="上舰了" />');
    lines.push('<gift ts="602.5" user="观众D" giftname="辣条" num="10" price="100" text="辣条x10" />');
    lines.push('<sc ts="1201.0" user="观众E" price="100" time="30" text="翻盘了！" />');
    lines.push('<guard ts="1202.0" user="舰长F" level="1" num="1" text="上舰" />');
  }
  lines.push('</i>');
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  return p;
}

/** 确定性伪随机（让 fixture 可复现） */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DURATION_SEC = 1800; // 30 分钟测试场次
const video1 = makeDummyMedia('mock-seg-01.flv', 3 * 1024 * 1024);
const video2 = cfg.segmented ? makeDummyMedia('mock-seg-02.flv', 3 * 1024 * 1024) : undefined;
const danmaXml = makeDanmakuXml('mock-danmaku.xml', { withEvents: cfg.withEvents, durationSec: DURATION_SEC });

const RECORD_ID = 'rec-mock-0001';
const LIVE_ID = '1789900000000';
const baseTs = Date.now() - 2 * 3600_000; // 2 小时前

/* ============================================================================
 * 响应工具
 * ========================================================================== */

function send(res: http.ServerResponse, status: number, body: unknown, raw = false): void {
  const text = raw && typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': raw && typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const t = Buffer.concat(chunks).toString('utf8');
      if (!t.trim()) return resolve({});
      try {
        resolve(JSON.parse(t) as Record<string, unknown>);
      } catch {
        resolve({ __raw: t });
      }
    });
    req.on('error', () => resolve({}));
  });
}

/* ============================================================================
 * 各接口的实现
 * ========================================================================== */

/** /record-history/recent-clips —— 驼峰字段，最多 5 条 */
function recentClips(roomId: string, platform: string): unknown {
  state.recentClipsCalls++;
  // 平台大小写陷阱：真实服务传错会静默返回空数组（这里如实模拟）
  if (platform !== 'Bilibili') return { code: 200, data: [] };
  // 未知房间同样静默空数组（陷阱 #2）
  if (!['12345678', '23456789', '123456'].includes(roomId)) return { code: 200, data: [] };

  // 前 N 次轮询模拟「录制中」（文件大小仍在变化、无 recordEndTime）
  const stillRecording = state.recentClipsCalls <= cfg.clipsSeen;
  const endTs = stillRecording ? undefined : baseTs + DURATION_SEC * 1000;

  const items: Array<Record<string, unknown>> = [];
  if (cfg.segmented && video2) {
    // 断流多段：同一 live_id 两段
    items.push({
      id: `${RECORD_ID}-a`,
      title: '【Mock】断流多段测试场',
      liveStartTime: Math.floor(baseTs / 1000),
      recordStartTime: baseTs,
      ...(endTs ? { recordEndTime: baseTs + 900_000 } : {}),
      videoDuration: 900,
      videoFilePath: video1,
      videoFileId: 'file-mock-1',
      videoFileExt: 'flv',
      videoFileSize: fs.statSync(video1).size,
      videoFileUpdatedAt: fs.statSync(video1).mtimeMs,
    });
    items.push({
      id: `${RECORD_ID}-b`,
      title: '【Mock】断流多段测试场',
      liveStartTime: Math.floor(baseTs / 1000),
      recordStartTime: baseTs + 900_000,
      ...(endTs ? { recordEndTime: baseTs + DURATION_SEC * 1000 } : {}),
      videoDuration: 900,
      videoFilePath: video2,
      videoFileId: 'file-mock-2',
      videoFileExt: 'flv',
      videoFileSize: fs.statSync(video2).size,
      videoFileUpdatedAt: fs.statSync(video2).mtimeMs,
    });
  } else {
    items.push({
      id: RECORD_ID,
      title: '【Mock】测试场次 · DLC 开荒 + 观众问答',
      liveStartTime: Math.floor(baseTs / 1000),
      recordStartTime: baseTs,
      ...(endTs ? { recordEndTime: endTs } : {}),
      videoDuration: DURATION_SEC,
      videoFilePath: video1,
      videoFileId: 'file-mock-1',
      videoFileExt: 'flv',
      videoFileSize: fs.statSync(video1).size,
      videoFileUpdatedAt: fs.statSync(video1).mtimeMs,
    });
  }
  return { code: 200, data: items };
}

/** /record-history/list —— **下划线**字段 + 分页；startTime 单位为毫秒 */
function recordHistoryList(q: URLSearchParams): unknown {
  const roomId = q.get('room_id') ?? '';
  const platform = q.get('platform') ?? 'Bilibili';
  if (platform !== 'Bilibili') return { code: 200, data: [], pagination: { total: 0, page: 1, pageSize: 50 } };
  if (!['12345678', '23456789', '123456'].includes(roomId)) {
    return { code: 200, data: [], pagination: { total: 0, page: 1, pageSize: 50 } };
  }
  const page = Number(q.get('page') ?? 1);
  const pageSize = Number(q.get('pageSize') ?? 50);
  const startTime = q.get('startTime') ? Number(q.get('startTime')) : undefined;

  // 造 6 条历史：最近一条是「已完成且未处理」（用于验证启动补漏）
  const all: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 6; i++) {
    const start = baseTs - i * 86400_000;
    all.push({
      id: i === 0 ? RECORD_ID : `rec-mock-old-${i}`,
      title: i === 0 ? '【Mock】测试场次 · DLC 开荒 + 观众问答' : `【Mock】历史场次 ${i}`,
      live_id: i === 0 ? LIVE_ID : `17899${i}00000000`,
      live_start_time: Math.floor(start / 1000),
      record_start_time: start,
      record_end_time: start + DURATION_SEC * 1000,
      video_file: i === 0 ? video1 : path.join(mediaDir, 'missing-old.flv'),
      video_filename: path.basename(video1),
      video_duration: DURATION_SEC,
      danma_num: 431,
      interact_num: 12,
      danma_density: 0.24,
      quick_hash: `hash${i}`,
      created_at: start,
    });
  }
  // ★ 毫秒过滤（陷阱 #32：传秒会得到错误结果）
  const filtered = startTime !== undefined ? all.filter((r) => Number(r['record_start_time']) >= startTime) : all;
  const offset = (page - 1) * pageSize;
  return {
    code: 200,
    data: filtered.slice(offset, offset + pageSize),
    pagination: { total: filtered.length, page, pageSize },
  };
}

/** /ai/subtitle —— 同步返回 SRT；支持「第 N 次失败」以验证重试 */
function subtitle(body: Record<string, unknown>): { status: number; payload: unknown } {
  const file = String(body['file'] ?? '');
  const startTime = body['startTime'] !== undefined ? Number(body['startTime']) : undefined;
  const endTime = body['endTime'] !== undefined ? Number(body['endTime']) : undefined;
  const offset = body['offset'] !== undefined ? Number(body['offset']) : undefined;

  // ★ 硬约束 #7：startTime/endTime 必须成对。这里如实模拟「只传一个就按整文件处理」
  const paired = startTime !== undefined && endTime !== undefined;
  if ((startTime !== undefined) !== (endTime !== undefined)) {
    state.asrCalls.push({ file, startTime, endTime, offset, at: nowIso(), result: 'ok' });
    // 整文件：返回全片字幕（成本失控的模拟）
    return { status: 200, payload: { srt: buildSrt(0, DURATION_SEC, 0) } };
  }

  const callIndex = state.asrCalls.length + 1;
  if (cfg.flakyAsr > 0 && callIndex === cfg.flakyAsr) {
    state.asrCalls.push({ file, startTime, endTime, offset, at: nowIso(), result: 'fail' });
    return {
      status: 500,
      payload: { error: '模拟 ASR 故障（--flaky-asr）：上游识别服务返回 500，请稍后重试' },
    };
  }

  state.asrCalls.push({ file, startTime, endTime, offset, at: nowIso(), result: 'ok' });
  const s = paired ? startTime! : 0;
  const e = paired ? endTime! : DURATION_SEC;
  // ★ offset 语义：返回的时间戳相对**本次提交的音频片段起点**（实测结论）
  //   即全局时间 = 段内时间戳 + 调用方传入的段起点绝对秒数
  return { status: 200, payload: { srt: buildSrt(s, e, offset ?? 0) } };
}

/**
 * 生成 SRT。
 * @param from 本段在文件内的起点（秒）
 * @param to   本段在文件内的终点（秒）
 * @param offset 接口的 offset 参数；实测语义为「输出时间戳 = 音频内时间 + offset」
 */
function buildSrt(from: number, to: number, offset: number): string {
  const lines: string[] = [];
  const sentences = [
    '好，我们现在开始今天的内容',
    '这个 Boss 的机制其实挺有意思的',
    '等一下，这个操作有点东西',
    '大家看这个血量，就差一点点',
    '翻盘了翻盘了，弹幕都刷起来了',
    '接下来回答几个观众的问题',
    '关于配装，我个人建议这样搭',
    '那今天就先到这里，感谢大家陪伴',
  ];
  let idx = 1;
  // 每 12 秒一条字幕，模拟真实 ASR 的稀疏输出
  for (let t = from; t < to; t += 12) {
    const rel = t - from; // 段内相对时间
    const a = rel + offset;
    const b = Math.min(rel + offset + 10, to - from + offset);
    const text = sentences[idx % sentences.length]!;
    lines.push(String(idx));
    lines.push(`${srtTime(a)} --> ${srtTime(b)}`);
    lines.push(text);
    lines.push('');
    idx++;
  }
  return lines.join('\n');
}

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
}

/** /task/cut —— 创建切片任务，产出真实写到磁盘 */
function cutTask(body: Record<string, unknown>): unknown {
  const taskId = `cut-${state.taskSeq++}`;
  const files = (body['files'] ?? {}) as Record<string, string>;
  const output = String(body['output'] ?? '');
  const ff = (body['ffmpegOptions'] ?? {}) as Record<string, unknown>;

  // 校验：output 必须绝对路径（陷阱 #6）
  if (!/^[a-zA-Z]:[\\/]/.test(output) && !output.startsWith('/')) {
    return { code: 400, error: 'output 必须是绝对路径' };
  }
  // 校验：禁止 stream copy（硬约束 #5）
  const enc = String(ff['c:v'] ?? ff['vcodec'] ?? ff['codec'] ?? '');
  if (enc.toLowerCase() === 'copy') {
    return { code: 400, error: '切片禁止 stream copy（会导致开头花屏与弹幕错位）' };
  }
  // 校验：源文件存在
  const src = files['videoFilePath'];
  if (!src || !exists(src)) {
    return { code: 400, error: `输入文件不存在：${src}` };
  }
  // 校验：要烧弹幕时 ASS 必须存在
  if (files['assFilePath'] && !exists(files['assFilePath'])) {
    return { code: 400, error: `弹幕文件不存在：${files['assFilePath']}` };
  }
  /* 校验：`assFilePath` 必须是**绝对路径**（陷阱 #6）。
     为什么这条校验必须单独写（真实事故，2026-09-23 在真实录播上抓到）：
       biliLive-tools 是**另一个进程**，它把 assFilePath 原样拼进 ffmpeg 的
       `[0:v]subtitles=<path>[0:video]`，由 ffmpeg 以**它自己的 cwd** 解析。
       于是相对路径 `data/tasks/<id>/burn-xxx.ass` 在它那边不存在 →
       `ffmpeg exited with code 4294967294`（-2）→ 切片直接不产出。
       而这里只校验 exists() 是抓不到的：mock server 与 e2e **共用同一个 cwd**，
       相对路径恰好能解析到，于是测试一路绿灯、真机才炸。
       所以必须按"路径形态"校验，模拟对方的解析方式。 */
  if (files['assFilePath'] && !/^[a-zA-Z]:[\\/]/.test(files['assFilePath']) && !files['assFilePath'].startsWith('/')) {
    return { code: 400, error: `assFilePath 必须是绝对路径（biliLive-tools 以自己的 cwd 解析）：${files['assFilePath']}` };
  }
  // 同理：videoFilePath 也走 ffmpeg 输入，同样要求绝对路径
  if (src && !/^[a-zA-Z]:[\\/]/.test(src) && !src.startsWith('/')) {
    return { code: 400, error: `videoFilePath 必须是绝对路径：${src}` };
  }

  ensureDir(path.dirname(output));
  // 产出一个真实的小文件（内容不重要，publish.ts 只校验存在与非空）
  fs.writeFileSync(output, Buffer.alloc(512 * 1024, 0x42));

  state.tasks.set(taskId, {
    taskId,
    type: 'cut',
    status: 'pending',
    output,
    polls: 0,
    createdAt: Date.now(),
    body,
  });
  return { taskId };
}

/** /bili/upload —— **只返回 taskId**（陷阱 #11）；若干次轮询后把稿件放进 archives */
function biliUpload(body: Record<string, unknown>): unknown {
  const taskId = `upload-${state.taskSeq++}`;
  const videos = (body['videos'] ?? []) as Array<string | { path: string }>;
  const config = (body['config'] ?? {}) as Record<string, unknown>;
  const title = String(config['title'] ?? '(无标题)');
  const paths = videos.map((v) => (typeof v === 'string' ? v : v?.path ?? ''));

  state.tasks.set(taskId, {
    taskId,
    type: 'biliUpload',
    status: 'pending',
    polls: 0,
    createdAt: Date.now(),
    body,
  });
  state.uploads.set(taskId, { title, videos: paths, config });
  return { taskId };
}

/** /task/:id —— 每次轮询推进状态 */
function taskDetail(taskId: string): unknown {
  const t = state.tasks.get(taskId);
  if (!t) return { code: 404, error: `任务不存在：${taskId}` };
  t.polls++;
  const needed = cfg.instant ? 0 : t.type === 'cut' ? 2 : 3;
  if (t.polls > needed) {
    t.status = 'completed';
    // 上传任务完成 → 模拟 B站侧稿件可见（供 /bili/archives 反查）
    if (t.type === 'biliUpload') {
      const up = state.uploads.get(taskId);
      if (up) {
        const bvid = `BV1MOCK${String(state.archiveSeq++).padStart(6, '0')}`;
        state.archives.unshift({
          bvid,
          title: up.title,
          desc: String(up.config['desc'] ?? ''),
          ctime: Math.floor(Date.now() / 1000),
          pubtime: Math.floor(Date.now() / 1000),
          state: Number(up.config['is_only_self']) === 1 ? -50 : 0,
          stat: { view: 0, like: 0, coin: 0, favorite: 0, danmaku: 0, reply: 0, share: 0 },
          _uploadTaskId: taskId,
        });
      }
    }
  } else {
    t.status = 'running';
  }
  return {
    taskId: t.taskId,
    type: t.type,
    status: t.status,
    ...(t.output ? { output: t.output } : {}),
    ...(t.error ? { error: t.error } : {}),
  };
}

/* ============================================================================
 * 服务器
 * ========================================================================== */

const server = http.createServer((req, res) => {
  void handle(req, res).catch((e) => {
    send(res, 500, { error: `mock server 内部错误：${(e as Error).message}` });
  });
});

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${cfg.host}:${cfg.port}`);
  const p = url.pathname;
  const method = req.method ?? 'GET';

  // 鉴权（与真实服务一致：header Authorization）
  const auth = req.headers.authorization;
  const authed = auth === cfg.passKey || url.searchParams.get('auth') === cfg.passKey;

  // /webhook/* 与 /common/video/* 在真实服务中注册在鉴权中间件之前
  // /__mock/* 是本测试服务器的辅助端点（不属于真实 API），同样免鉴权，便于 e2e 断言
  const noAuth = p.startsWith('/webhook/') || p.startsWith('/common/video/') || p.startsWith('/__mock/');
  state.requestLog.push({ at: nowIso(), method, path: p, status: 0, auth: authed });

  if (!authed && !noAuth) {
    state.requestLog[state.requestLog.length - 1]!.status = 401;
    send(res, 401, { code: 401, message: 'unauthorized：PassKey 不匹配（mock server 期望 Authorization: ' + '<passkey>' + '）' });
    return;
  }

  const body = method === 'POST' || method === 'PATCH' ? await readBody(req) : {};

  switch (true) {
    /* ---------------- 连通性 / 账号 ---------------- */
    case p === '/common/version' && method === 'GET':
      // 真实服务返回裸字符串
      send(res, 200, cfg.version, true);
      return;

    case p === '/user/list' && method === 'GET':
      send(res, 200, {
        uid: 1000000000000000,
        name: 'Mock用户',
        face: 'https://example.invalid/face.jpg',
        expires: Date.now() + 142 * 86400_000,
      });
      return;

    case p === '/user/export':
      // 永不调用；这里返回一个明确的错误便于发现误用
      send(res, 403, { error: '/user/export 会输出含 cookie 的原始数据，本项目禁止调用（硬约束 #8）' });
      return;

    /* ---------------- 录制历史 ---------------- */
    case p === '/record-history/recent-clips' && method === 'GET': {
      const r = recentClips(url.searchParams.get('room_id') ?? '', url.searchParams.get('platform') ?? '');
      send(res, 200, r);
      return;
    }

    case p === '/record-history/list' && method === 'GET':
      send(res, 200, recordHistoryList(url.searchParams));
      return;

    case p.startsWith('/record-history/file/') && method === 'GET': {
      const id = decodeURIComponent(p.replace('/record-history/file/', ''));
      send(res, 200, {
        code: 200,
        data: {
          videoFilePath: video1,
          videoFileExt: 'flv',
          videoFileSize: fs.statSync(video1).size,
          videoFileUpdatedAt: fs.statSync(video1).mtimeMs,
          danmaFilePath: danmaXml,
          danmaFileId: 'danma-mock-1',
          danmaFileExt: 'xml',
        },
      });
      void id;
      return;
    }

    case p === '/record-history/danma-file' && method === 'POST': {
      const vf = String(body['videoFilePath'] ?? '');
      const ok = exists(vf);
      send(res, 200, {
        code: 200,
        data: ok
          ? { danmaFilePath: danmaXml, danmaFileId: 'danma-mock-1', danmaFileExt: 'xml' }
          : {},
      });
      return;
    }

    /* ---------------- ASR ---------------- */
    case p === '/ai/subtitle' && method === 'POST': {
      const r = subtitle(body);
      send(res, r.status, r.payload);
      return;
    }

    /* ---------------- 任务 ---------------- */
    case p === '/task/' && method === 'GET': {
      const list = Array.from(state.tasks.values()).map((t) => ({
        taskId: t.taskId,
        type: t.type,
        status: t.status,
        name: t.type === 'cut' ? '视频切片' : 'B站上传',
        output: t.output,
      }));
      send(res, 200, {
        list,
        runningTaskNum: list.filter((t) => t.status === 'running').length,
        total: list.length,
      });
      return;
    }

    case p === '/task/cut' && method === 'POST': {
      const r = cutTask(body);
      if ((r as { error?: string }).error) {
        send(res, 400, r);
        return;
      }
      send(res, 200, r);
      return;
    }

    case p === '/task/convertXml2Ass' && method === 'POST': {
      const output = String(body['output'] ?? '');
      if (!output) {
        send(res, 400, { error: 'output 必填' });
        return;
      }
      ensureDir(path.dirname(output));
      // 写一份最小的合法 ASS
      fs.writeFileSync(
        output,
        [
          '[Script Info]',
          'Title: mock',
          'ScriptType: v4.00+',
          '',
          '[V4+ Styles]',
          'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
          'Style: Default,Microsoft YaHei,36,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1',
          '',
          '[Events]',
          'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
          'Dialogue: 0,0:10:00.00,0:10:05.00,Default,,0,0,0,,名场面',
          'Dialogue: 0,0:20:00.00,0:20:05.00,Default,,0,0,0,,翻盘了',
          '',
        ].join('\n'),
        'utf8',
      );
      send(res, 200, { taskId: `conv-${state.taskSeq++}` });
      return;
    }

    case p.startsWith('/task/') && p.endsWith('/kill') && method === 'POST': {
      const id = p.replace('/task/', '').replace('/kill', '');
      const t = state.tasks.get(id);
      if (t) t.status = 'error';
      send(res, 200, { ok: true });
      return;
    }

    case p.startsWith('/task/') && p.endsWith('/restart') && method === 'POST': {
      const id = p.replace('/task/', '').replace('/restart', '');
      const t = state.tasks.get(id);
      if (t) {
        t.status = 'pending';
        t.polls = 0;
      }
      send(res, 200, { ok: true });
      return;
    }

    case p.startsWith('/task/') && method === 'GET': {
      const id = decodeURIComponent(p.replace('/task/', ''));
      send(res, 200, taskDetail(id));
      return;
    }

    /* ---------------- 投稿 ---------------- */
    case p === '/bili/upload' && method === 'POST': {
      send(res, 200, biliUpload(body));
      return;
    }

    case p === '/bili/archives' && method === 'GET':
      send(res, 200, { list: state.archives, total: state.archives.length });
      return;

    case p.startsWith('/bili/user/archive/') && method === 'GET': {
      const bvid = decodeURIComponent(p.replace('/bili/user/archive/', ''));
      const found = state.archives.find((a) => a['bvid'] === bvid);
      if (!found) {
        send(res, 404, { code: -404, message: '稿件不存在' });
        return;
      }
      // 模拟播放量随时间增长（便于验证表现数据回流）
      const age = Date.now() / 1000 - Number(found['ctime'] ?? 0);
      const growth = Math.floor(age / 60) * 7;
      send(res, 200, {
        ...found,
        stat: {
          view: 120 + growth,
          like: 12 + Math.floor(growth / 6),
          coin: 3 + Math.floor(growth / 20),
          favorite: 5 + Math.floor(growth / 12),
          danmaku: 8 + Math.floor(growth / 9),
          reply: 2 + Math.floor(growth / 30),
          share: 1 + Math.floor(growth / 40),
        },
      });
      return;
    }

    /* ---------------- 预设 ---------------- */
    case p === '/preset/ffmpeg' && method === 'GET':
      send(res, 200, {
        data: [
          {
            id: 'default',
            name: '默认配置',
            // 关键：不声明编码器，用于验证 buildFfmpegOptions 的覆盖兜底
            config: { preset: 'veryfast', crf: '21' },
          },
          {
            id: 'nvenc',
            name: 'N卡硬件编码',
            config: { 'c:v': 'h264_nvenc', preset: 'p5', cq: '23', 'c:a': 'aac', 'b:a': '192k' },
          },
          {
            id: 'copy-bad',
            name: '错误示例（copy）',
            config: { 'c:v': 'copy' },
          },
        ],
      });
      return;

    case p === '/preset/video' && method === 'GET':
      send(res, 200, {
        data: [
          { id: 'default', name: '默认配置', config: { tid: 17, copyright: 1, tag: ['直播切片'] } },
          { id: 'withCover', name: '带封面', config: { cover: path.join(mediaDir, 'cover.jpg') } },
        ],
      });
      return;

    case p === '/preset/danmu' && method === 'GET':
      send(res, 200, { data: [{ id: 'default', name: '默认配置', config: { fontSize: 36, opacity: 0.8 } }] });
      return;

    /* ---------------- 其它 ---------------- */
    case p === '/config' && method === 'GET':
      send(res, 200, {
        ffmpegPath: 'C:\\mock\\bin\\ffmpeg.exe',
        ffprobePath: 'C:\\mock\\bin\\ffprobe.exe',
        // ★ 默认故意设为 delete（非 none），用于验证硬约束 #11 的检查逻辑能报警
        afterUploadDeletAction: url.searchParams.get('ok-delete') === '1' ? 'none' : 'deleteAfterCheck',
        recorder: { recorderType: 'bililive', segment: '59', autoPartMerge: true },
        cacheFolder: path.join(cfg.dataDir, 'cache'),
        ai: { subtitleRecognize: { modelId: 'mock-asr-model' } },
      });
      return;

    case p === '/common/getLogContent' && method === 'GET':
      send(
        res,
        200,
        [
          '[2025-01-01 20:00:01] [info] 开始录制',
          '[2025-01-01 20:30:00] [info] 录制结束，共 1800 秒',
          '[2025-01-01 20:30:05] [info] ffmpeg 压制开始',
          '[2025-01-01 20:35:12] [error] ffmpeg 报错示例：Invalid data found when processing input',
          '[2025-01-01 20:35:13] [info] 压制结束',
        ].join('\n'),
        true,
      );
      return;

    case p === '/common/readDanma' && method === 'POST': {
      const fp = String(body['filepath'] ?? '');
      if (!exists(fp)) {
        send(res, 404, { error: `文件不存在：${fp}` });
        return;
      }
      send(res, 200, fs.readFileSync(fp, 'utf8'), true);
      return;
    }

    case p === '/common/writeLLC' && method === 'POST': {
      const content = body['content'] as Record<string, unknown> | undefined;
      if (!content || !('cutSegments' in content)) {
        send(res, 400, { error: 'content 必须包含 cutSegments' });
        return;
      }
      const fp = String(body['filepath'] ?? '');
      ensureDir(path.dirname(fp));
      // 真实实现用 JSON5.stringify；JSON 是 JSON5 的超集，兼容
      fs.writeFileSync(fp, JSON.stringify(content, null, 2), 'utf8');
      send(res, 200, { ok: true });
      return;
    }

    case p === '/common/readLLC' && method === 'POST': {
      const fp = String(body['filepath'] ?? '');
      if (!exists(fp)) {
        send(res, 404, { error: `文件不存在：${fp}` });
        return;
      }
      send(res, 200, JSON.parse(fs.readFileSync(fp, 'utf8')));
      return;
    }

    /* ---------------- webhook 入站（不需鉴权） ---------------- */
    case p.startsWith('/webhook/') && method === 'POST': {
      // 记录到磁盘，便于 e2e 断言「原样转发」
      const logPath = path.join(cfg.dataDir, 'webhook-received.jsonl');
      fs.appendFileSync(logPath, `${JSON.stringify({ at: nowIso(), path: p, body })}\n`, 'utf8');
      send(res, 200, { code: 200, message: 'ok' });
      return;
    }

    /* ---------------- 测试辅助端点（不属于真实 API，便于 e2e 断言） ---------------- */
    case p === '/__mock/state' && method === 'GET':
      send(res, 200, {
        asrCalls: state.asrCalls,
        asrCallCount: state.asrCalls.length,
        asrBillableCalls: state.asrCalls.filter((c) => c.result === 'ok').length,
        recentClipsCalls: state.recentClipsCalls,
        archives: state.archives.map((a) => ({ bvid: a['bvid'], title: a['title'], state: a['state'] })),
        tasks: Array.from(state.tasks.values()).map((t) => ({ taskId: t.taskId, type: t.type, status: t.status, output: t.output })),
        uploads: Array.from(state.uploads.entries()).map(([k, v]) => ({ taskId: k, title: v.title, videos: v.videos, config: v.config })),
        requests: state.requestLog.map((r) => `${r.method} ${r.path}${r.status ? ` (${r.status})` : ''}`),
      });
      return;

    case p === '/__mock/reset' && method === 'POST':
      state.asrCalls.length = 0;
      state.recentClipsCalls = 0;
      state.tasks.clear();
      state.archives.length = 0;
      state.uploads.clear();
      state.requestLog.length = 0;
      state.taskSeq = 1;
      state.archiveSeq = 1;
      send(res, 200, { ok: true });
      return;

    case p === '/__mock/ping' && method === 'GET':
      send(res, 200, { ok: true, version: cfg.version, uptimeSec: Math.round(process.uptime()) });
      return;

    default:
      state.requestLog[state.requestLog.length - 1]!.status = 404;
      send(res, 404, { code: 404, message: `mock server 未实现该端点：${method} ${p}` });
  }
}

/* ============================================================================
 * 启动
 * ========================================================================== */

server.listen(cfg.port, cfg.host, () => {
  const info = {
    baseUrl: `http://${cfg.host}:${cfg.port}`,
    passKey: cfg.passKey,
    version: cfg.version,
    flakyAsr: cfg.flakyAsr,
    clipsSeen: cfg.clipsSeen,
    segmented: cfg.segmented,
    withEvents: cfg.withEvents,
    dataDir: cfg.dataDir,
    media: { video1, video2, danmaXml },
    startedAt: nowIso(),
  };
  writeJsonAtomic(path.join(cfg.dataDir, 'mock-info.json'), info);

  console.log(`\x1b[1mmock biliLive-tools 已启动\x1b[0m`);
  console.log(`  地址      : http://${cfg.host}:${cfg.port}`);
  console.log(`  PassKey   : ${cfg.passKey}`);
  console.log(`  版本      : ${cfg.version}（任务书核实 3.22.1，用于验证版本漂移告警）`);
  console.log(`  媒体文件  : ${video1}${video2 ? `\n              ${video2}` : ''}`);
  console.log(`  弹幕 XML  : ${danmaXml}${cfg.withEvents ? '（含 SC/上舰/礼物）' : '（不含高能事件，用于验证降级）'}`);
  console.log(`  场景      : ${cfg.clipsSeen > 0 ? `前 ${cfg.clipsSeen} 次轮询返回「录制中」` : '首次轮询即返回已完成'}${cfg.segmented ? ' · 断流多段' : ''}${cfg.flakyAsr ? ` · 第 ${cfg.flakyAsr} 次 ASR 调用失败` : ''}`);
  console.log(`  状态查询  : GET /__mock/state（asr 调用次数、archives、tasks）`);
  console.log(`  重置      : POST /__mock/reset`);
  console.log('');
  console.log('把它接到本项目：把 config.json 的 bililive 段改成');
  console.log(`  "baseUrl": "http://${cfg.host}:${cfg.port}", "passKey": "${cfg.passKey}"`);
  console.log('');
});

const shutdown = (): void => {
  console.log('\nmock server 停止中…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
