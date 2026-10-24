import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** src/ 目录绝对路径 */
export const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录 */
export const ROOT_DIR = path.resolve(SRC_DIR, '..');

/** 运行期数据目录（台账、缓存、任务目录都在这里，已在 .gitignore 中忽略） */
export const DATA_DIR = path.join(ROOT_DIR, 'data');

/** 任务工作目录根 */
export const TASKS_DIR = path.join(DATA_DIR, 'tasks');

/** ASR 分段缓存目录 */
export const ASR_CACHE_DIR = path.join(DATA_DIR, 'asr-cache');

/** 日志目录 */
export const LOGS_DIR = path.join(DATA_DIR, 'logs');

/** 错误报告目录 */
export const ERROR_REPORT_DIR = path.join(DATA_DIR, 'error-report');

/** 切片输出目录 */
export const CLIPS_DIR = path.join(DATA_DIR, 'clips');

/** 默认配置文件路径 */
export const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
export const CONFIG_EXAMPLE_PATH = path.join(ROOT_DIR, 'config.example.json');

/** 台账 / 决策 / 表现 / 错误事件流的默认路径 */
export const LEDGER_PATH = path.join(DATA_DIR, 'ledger.json');
export const DECISIONS_PATH = path.join(DATA_DIR, 'decisions.jsonl');
export const PERFORMANCE_PATH = path.join(DATA_DIR, 'performance.jsonl');
export const ERRORS_PATH = path.join(DATA_DIR, 'errors.jsonl');

/* ---------------------------------------------------------------------------
 * 时间工具（陷阱 #9：秒 / 毫秒混用是本项目最容易出错的地方）
 * ------------------------------------------------------------------------- */

/** 判断时间戳量级：毫秒级约 1.7e12，秒级约 1.7e9 */
export function isMilliseconds(ts: number): boolean {
  return ts > 1e11;
}

/** 统一转成毫秒；已是毫秒的原样返回 */
export function toMs(ts: number | null | undefined): number | undefined {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return undefined;
  return isMilliseconds(ts) ? ts : ts * 1000;
}

/** 统一转成秒；已是秒的原样返回 */
export function toSec(ts: number | null | undefined): number | undefined {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return undefined;
  return isMilliseconds(ts) ? ts / 1000 : ts;
}

/** ISO 字符串 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 本地时间 YYYY-MM-DD HH:mm:ss */
export function fmtLocal(d: Date | number = new Date()): string {
  const date = typeof d === 'number' ? new Date(d) : d;
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
  );
}

/** 本地时间 YYYY-MM-DD */
export function fmtDate(d: Date | number = new Date()): string {
  return fmtLocal(d).slice(0, 10);
}

/** 秒 → HH:MM:SS */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** 秒 → 人类可读（1小时23分 / 45分12秒） */
export function fmtHuman(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} 小时 ${String(m).padStart(2, '0')} 分`;
  return `${m} 分 ${String(s % 60).padStart(2, '0')} 秒`;
}

/* ---------------------------------------------------------------------------
 * 文件系统工具
 * ------------------------------------------------------------------------- */

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function exists(p: string | undefined | null): boolean {
  if (!p) return false;
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function readJson<T = unknown>(p: string, fallback?: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

/**
 * 原子写 JSON：先写 .tmp 再 rename。
 * 台账 / clips.json 这类「崩溃后必须可读」的文件一律走这里，
 * 避免进程在写盘中途被杀导致文件半截。
 */
export function writeJsonAtomic(p: string, value: unknown, space = 2): void {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, space), 'utf8');
  fs.renameSync(tmp, p);
}

/** 追加一行 JSON（jsonl）。用同步写盘，确保崩溃前最后一条不丢 */
export function appendJsonl(p: string, value: unknown): void {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, `${JSON.stringify(value)}\n`, 'utf8');
}

/** 同步追加文本（错误路径专用，§8 WP6 步骤 10 要求同步写盘） */
export function appendTextSync(p: string, text: string): void {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, text, 'utf8');
}

export interface ReadJsonlOptions {
  /** 只取末尾 N 行 */
  limit?: number;
  /** 只取时间戳 ≥ sinceMs 的行（依赖「追加即有序」；从尾部回读，读到更早的行就停） */
  sinceMs?: number;
  /** 时间戳字段名（默认 'at'，ISO 字符串） */
  atField?: string;
  /** 回读字节上限（默认 8MB），配合 limit / sinceMs 使用 */
  maxScanBytes?: number;
}

/** jsonl 尾部回读的块大小 */
const JSONL_TAIL_CHUNK = 256 * 1024;
/** jsonl 尾部回读的默认字节上限 */
const JSONL_TAIL_MAX_BYTES = 8 * 1024 * 1024;
/**
 * 低于这个大小就直接整读。
 *
 * 实测（本机、真实数据文件）：小文件上"回读"反而更慢 —— 0.15MB 时 0.45ms → 1.00ms
 * （多出 open/fstat/分块分配的固定开销），而 readFileSync 一次读完非常快。
 * 回读的意义是**让成本不再随历史增长**，所以只对"已经长大的文件"启用。
 */
const JSONL_TAIL_MIN_BYTES = 512 * 1024;

/** 解析一行的时间戳（毫秒）；坏行 / 缺字段返回 undefined（不该打断回读） */
function lineTimeMs(line: string, atField: string): number | undefined {
  try {
    const v = (JSON.parse(line) as Record<string, unknown>)[atField];
    if (typeof v !== 'string') return undefined;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

/** 尾部回读的结束原因 */
type TailStop =
  /** 已读到文件头（窗口包含整个文件） */
  | 'start'
  /** 已凑够 minLines 行 */
  | 'lines'
  /** 已回读到第一条早于 sinceMs 的行 */
  | 'since'
  /** 触到 maxScanBytes 上限，窗口是截断的 —— 调用方必须退回整读，绝不能少给数据 */
  | 'cap';

/**
 * 从文件尾部回读行（**不整读文件**）。
 *
 * 存在的理由：`readJsonl(p, limit)` 的旧实现是「整文件读进内存 → split → 再切片」，
 * 于是"只要最后 5 条"的调用反而成了最贵的一类 —— errors.jsonl / publish-log.jsonl
 * 只增不减，健康与监控面板每次刷新都要全量读一遍（P2）。
 *
 * 停止条件（满足其一即停；单次回读不超过 maxScanBytes）：
 *   - `minLines`：已凑够这么多非空行；
 *   - `sinceMs`：回读到第一条时间戳**早于** sinceMs 的行（依赖追加有序 —— 事件发生时由
 *     `appendJsonl` 顺序写入；手工乱序过的文件会少读，但那不是本项目的写入方式）。
 *
 * 返回的行保持文件内原始顺序。`stop==='cap'` 时窗口是截断的，调用方**必须整读兜底**。
 */
function readTailLines(p: string, opts: ReadJsonlOptions, minLines?: number): { lines: string[]; stop: TailStop } {
  const maxScan = Math.max(JSONL_TAIL_CHUNK, opts.maxScanBytes ?? JSONL_TAIL_MAX_BYTES);
  const atField = opts.atField ?? 'at';
  // 凑够 minLines 行 ⇒ 回读到 minLines+1 个换行（多出来的那个用于丢弃半行 / 空行）
  const needNewlines = minLines !== undefined ? minLines + 1 : undefined;
  const fd = fs.openSync(p, 'r');
  try {
    let pos = fs.fstatSync(fd).size;
    /* ★ 按**字节**累积、最后一次解码：分块各自 toString() 会把跨块的多字节字符
       解成两个 U+FFFD —— 而那个位置往往落在窗口中间的行里，等于静默损坏数据
       （对照测试抓到过）。换行符 0x0A 不会出现在多字节序列内，所以按字节数换行是安全的。 */
    const bufs: Buffer[] = [];
    let scanned = 0;
    let newlines = 0;
    let stop: TailStop = 'start';
    while (pos > 0) {
      const readSize = Math.min(JSONL_TAIL_CHUNK, pos, maxScan - scanned);
      if (readSize <= 0) {
        stop = 'cap';
        break;
      }
      pos -= readSize;
      scanned += readSize;
      const buf = Buffer.allocUnsafe(readSize);
      fs.readSync(fd, buf, 0, readSize, pos);
      bufs.unshift(buf);
      for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) newlines += 1;

      if (needNewlines !== undefined && newlines > needNewlines) {
        stop = 'lines';
        break;
      }
      if (opts.sinceMs !== undefined) {
        // 只有这一路需要看时间戳，才付出解码成本
        const usable = textWindow(bufs, pos > 0);
        const reachedOlder = usable.some((line) => {
          const t = lineTimeMs(line, atField);
          return t !== undefined && t < opts.sinceMs!;
        });
        if (reachedOlder) {
          stop = 'since';
          break;
        }
      }
    }
    return { lines: textWindow(bufs, pos > 0), stop };
  } finally {
    fs.closeSync(fd);
  }
}

/** 把回读到的字节块解成行；`partialFirst=true` 时丢掉可能是半行的首行 */
function textWindow(bufs: Buffer[], partialFirst: boolean): string[] {
  const split = Buffer.concat(bufs).toString('utf8').split('\n');
  return partialFirst ? split.slice(1) : split;
}

/**
 * 读 jsonl（容错：跳过坏行）。
 *
 * 第二个参数可以是数字（= `limit`，兼容旧调用）或选项对象。传了 `limit` / `sinceMs` 时
 * **只回读文件尾部**，不再把整个文件读进内存再切片；回读触到字节上限时自动退回整读，
 * 所以返回值与旧实现**逐字节等价**（有对照测试）。
 */
export function readJsonl<T = unknown>(p: string, limitOrOptions?: number | ReadJsonlOptions): T[] {
  if (!exists(p)) return [];
  const opts: ReadJsonlOptions = typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : (limitOrOptions ?? {});
  const minLines = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : undefined;
  let lines: string[] | undefined;
  if (minLines !== undefined || typeof opts.sinceMs === 'number') {
    // 小文件整读更快（见 JSONL_TAIL_MIN_BYTES）；只有长大了才值得回读
    let big = true;
    try {
      big = fs.statSync(p).size > JSONL_TAIL_MIN_BYTES;
    } catch {
      /* stat 失败就当小文件，走整读 */
      big = false;
    }
    if (big) {
      const tail = readTailLines(p, opts, minLines);
      if (tail.stop !== 'cap') lines = tail.lines;
    }
  }
  if (lines === undefined) lines = fs.readFileSync(p, 'utf8').split('\n');

  const limit = opts.limit;
  const sinceMs = opts.sinceMs;
  const useSince = typeof sinceMs === 'number' && Number.isFinite(sinceMs);
  const atField = opts.atField ?? 'at';

  // 行级过滤（空行）—— 与旧实现一致，先过滤再切末尾 N 行
  let want = lines.filter((l) => l.trim());
  /* ★ parse 是大头：没有 sinceMs 时先把末尾 N 行切出来再 parse（旧实现就是这么做的，
     否则"只要最后 5 条"却要把整个文件都 JSON.parse 一遍）。 */
  if (!useSince && typeof limit === 'number' && limit > 0 && want.length > limit) want = want.slice(-limit);

  const parsed: T[] = [];
  for (const line of want) {
    try {
      parsed.push(JSON.parse(line) as T);
    } catch {
      /* 跳过坏行，不让一条脏数据毁掉整个读取 */
    }
  }

  if (!useSince) return parsed;
  // 带时间窗时必须在 parse 之后过滤（顺序与旧实现一致：先按时间过滤，再切末尾 N 行）
  let kept = parsed.filter((rec) => {
    const v = (rec as Record<string, unknown>)?.[atField];
    const t = typeof v === 'string' ? Date.parse(v) : Number.NaN;
    return Number.isFinite(t) && t >= (sinceMs as number);
  });
  if (typeof limit === 'number' && limit > 0 && kept.length > limit) kept = kept.slice(-limit);
  return kept;
}

/** 把 Windows 路径统一成 ffmpeg 能吃的形式（正斜杠） */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 文件名安全化 */
export function safeFileName(name: string, maxLen = 80): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
  return (cleaned || 'untitled').slice(0, maxLen);
}

/** 人类可读字节数 */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 数组求最大值（可给兜底值）。
 *
 * ⚠️ 别用 `Math.max(...arr)`：元素上万时会因"参数个数超限"抛 `RangeError:
 * Maximum call stack size exceeded` —— 转写分段这类数组完全可能上万（P6）。
 */
export function maxOf(nums: number[], fallback = 0): number {
  let m = fallback;
  for (const n of nums) if (n > m) m = n;
  return m;
}

/* ---------------------------------------------------------------------------
 * 通用工具
 * ------------------------------------------------------------------------- */

/** 休眠 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 带抖动的指数退避（毫秒） */
export function backoffMs(attempt: number, base = 1000, cap = 60000): number {
  const raw = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(raw * (0.7 + Math.random() * 0.6));
}

export function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** 稳定哈希（FNV-1a 32 位），用于幂等指纹 */
export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 组合哈希，用于缓存键 */
export function hashKey(parts: Array<string | number | undefined | null>): string {
  return fnv1a(parts.map((p) => String(p ?? '')).join('|'));
}

/** 深拷贝（结构化数据） */
export function clone<T>(v: T): T {
  return structuredClone(v);
}

/** 截断字符串并标注原始长度 */
export function truncate(text: string, max = 4096): { text: string; truncated: boolean; originalLength: number } {
  const originalLength = text.length;
  if (originalLength <= max) return { text, truncated: false, originalLength };
  return { text: `${text.slice(0, max)}\n...[已截断，原始长度 ${originalLength} 字符]`, truncated: true, originalLength };
}

/** 简易并发限制器（不引入 p-limit 的强依赖时也能用） */
export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = (): void => {
    active--;
    const fn = queue.shift();
    if (fn) fn();
  };
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active++;
        fn().then(
          (v) => {
            next();
            resolve(v);
          },
          (e) => {
            next();
            reject(e);
          },
        );
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}

/** 把「秒」格式化成 SRT 时间戳 00:00:01,234 */
export function toSrtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
}

/** 解析 SRT 时间戳 → 秒 */
export function parseSrtTime(s: string): number {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s.trim());
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}
