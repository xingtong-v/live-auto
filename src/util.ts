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

/** 读 jsonl（容错：跳过坏行） */
export function readJsonl<T = unknown>(p: string, limit?: number): T[] {
  if (!exists(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
  const slice = limit && lines.length > limit ? lines.slice(-limit) : lines;
  const out: T[] = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* 跳过坏行，不让一条脏数据毁掉整个读取 */
    }
  }
  return out;
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
