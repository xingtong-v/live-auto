/**
 * 结构化日志（jsonl）+ 控制台输出。
 *
 * 硬约束 #8 / 陷阱 #33：日志统一脱敏，禁止裸打印 request 对象。
 * 本模块是唯一的日志出口 —— 其它模块不得直接 console.log 敏感结构。
 */
import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR, ensureDir, fmtLocal, nowIso } from './util.ts';
import { redact } from './redact.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  /** 任务 / 场次 id，便于全链路追溯 */
  taskId?: string;
  /** 阶段标记，如 RECORDED / TRANSCRIBING */
  stage?: string;
  /** 子模块名 */
  mod?: string;
  /** 附加字段（已脱敏） */
  data?: unknown;
  err?: { name: string; message: string; stack?: string };
}

export interface LoggerOptions {
  level?: LogLevel;
  /** 同时写文件（默认 true） */
  file?: boolean;
  /** 控制台彩色（默认非 TTY 时关闭） */
  color?: boolean;
  /** 日志目录 */
  dir?: string;
  /** 单文件大小上限（字节），超过则轮转。默认 16MB */
  maxBytes?: number;
  /** 保留天数，默认 14 天 */
  keepDays?: number;
  /** 是否输出到 stdout */
  console?: boolean;
}

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

export class Logger {
  private level: LogLevel;
  private useFile: boolean;
  private useColor: boolean;
  private useConsole: boolean;
  private dir: string;
  private maxBytes: number;
  private keepDays: number;
  /** 当前写入的文件日期，跨天自动换文件 */
  private currentDate = '';
  private stream: fs.WriteStream | null = null;
  /** 上次"日志写盘失败"告警时刻（用于抑制刷屏） */
  private lastStreamErrorAt = 0;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? 'info';
    this.useFile = opts.file ?? true;
    this.useConsole = opts.console ?? true;
    // 颜色：默认只在真实终端上开；显式 color 优先。
    // 同时遵守 NO_COLOR 约定（https://no-color.org）—— 把输出重定向到文件、
    // 或由外部启动器/日志采集器接管时，ANSI 转义码会变成 `[36m` 这样的噪音。
    this.useColor = opts.color ?? (!process.env['NO_COLOR'] && process.env['TERM'] !== 'dumb' && Boolean(process.stdout.isTTY));
    this.dir = opts.dir ?? LOGS_DIR;
    this.maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
    this.keepDays = opts.keepDays ?? 14;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * 换日志目录（**必须在还没写过文件之前调**，或接受"换目录前那几行留在旧文件里"）。
   *
   * 为什么需要它：`log` 是模块级单例，很多模块（ledger / publish / trash…）直接用它，
   * 不经过 Orchestrator 自己的 logger。端到端测试虽然把 dataDir 换到临时目录，
   * 单例的目录仍指向真实的 `data/logs` —— 于是测试的几万行把真实日志冲掉，
   * 出错时翻日志翻不出东西（实测：当天 2 MB 日志绝大部分是 mock 测试场次）。
   */
  setDir(dir: string): void {
    if (dir === this.dir) return;
    this.dir = dir;
    this.stream = null; // 让下一次写入按新目录重新建流
    this.currentDate = '';
  }

  setConsole(enabled: boolean): void {
    this.useConsole = enabled;
  }

  private filePath(date = new Date()): string {
    const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return path.join(this.dir, `live_auto-${d}.jsonl`);
  }

  /** 懒打开写入流；跨天或超限时轮转 */
  private getStream(): fs.WriteStream | null {
    if (!this.useFile) return null;
    try {
      const today = this.filePath();
      if (this.stream && this.currentDate === today) {
        // 大小轮转：超限时改名并重开
        try {
          const st = fs.statSync(today);
          if (st.size > this.maxBytes) {
            this.stream.end();
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            fs.renameSync(today, path.join(this.dir, `live_auto-${stamp}.jsonl`));
            this.stream = null;
          } else {
            return this.stream;
          }
        } catch {
          return this.stream;
        }
      }
      if (this.stream && this.currentDate !== today) {
        this.stream.end();
        this.stream = null;
      }
      ensureDir(this.dir);
      const stream = fs.createWriteStream(today, { flags: 'a' });
      /* ★ 必须挂 error 处理器。没有它时，异步写失败（目录被删掉、磁盘满、权限变化）
         会以**未捕获的 'error' 事件**形式抛出来，直接带走整个进程 ——
         而抛出者居然是"日志"。实测踩过两次：端到端测试删掉临时目录后（ENOENT），
         以及日志目录被当成临时目录清理时。日志写不进去是小事，因为写日志把
         正在投稿的服务干掉是大事。 */
      stream.on('error', (e: Error) => this.onStreamError(e));
      this.stream = stream;
      this.currentDate = today;
      this.pruneOld();
      return this.stream;
    } catch {
      // 磁盘满 / IO 拥塞时不得让日志把业务拖死
      this.useFile = false;
      return null;
    }
  }

  /**
   * 文件写入流报错：关掉它、退化成"只输出到控制台"，并**每个窗口只提示一次**。
   *
   * 不直接把 `useFile` 永久关掉：目录可能只是临时不可用（比如被挪走又挪回来），
   * 下一轮写入会重新尝试打开。但也不能每写一行就重试一次 —— 那会在坏盘上打转。
   */
  private onStreamError(e: Error): void {
    try {
      this.stream?.end();
    } catch {
      /* ignore */
    }
    this.stream = null;
    this.currentDate = '';
    const now = Date.now();
    if (now - this.lastStreamErrorAt > 60_000) {
      this.lastStreamErrorAt = now;
      // 用 stderr 直写：自己就是坏掉的那条路，不能再走自己
      try {
        process.stderr.write(`[logger] 日志文件写入失败，已临时降级为仅控制台输出：${e.message}\n`);
      } catch {
        /* ignore */
      }
    }
  }

  /** 清理过期日志（§7.3 日志轮转） */
  private pruneOld(): void {
    try {
      const cutoff = Date.now() - this.keepDays * 86400_000;
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.startsWith('live_auto-') || !f.endsWith('.jsonl')) continue;
        const full = path.join(this.dir, f);
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      }
    } catch {
      /* 清理失败不影响主流程 */
    }
  }

  private write(entry: LogEntry): void {
    const stream = this.getStream();
    if (stream) {
      try {
        stream.write(`${JSON.stringify(entry)}\n`);
      } catch {
        /* 忽略写盘异常 */
      }
    }
    if (this.useConsole) {
      const t = fmtLocal(new Date(entry.ts)).slice(11);
      const tag = entry.level.toUpperCase().padEnd(5);
      const where = entry.mod ? `[${entry.mod}]` : '';
      const task = entry.taskId ? ` task=${entry.taskId}` : '';
      const stage = entry.stage ? ` ${entry.stage}` : '';
      const extra = entry.data !== undefined ? ` ${this.compact(entry.data)}` : '';
      const errPart = entry.err ? ` :: ${entry.err.name}: ${entry.err.message}` : '';
      const line = `${t} ${tag} ${where}${task}${stage} ${entry.msg}${errPart}${extra}`;
      const colored = this.useColor ? `${COLORS[entry.level]}${line}${RESET}` : line;
      if (entry.level === 'error' || entry.level === 'warn') process.stderr.write(`${colored}\n`);
      else process.stdout.write(`${colored}\n`);
    }
  }

  private compact(data: unknown): string {
    try {
      const r = redact(data, { maxDepth: 4, maxArray: 8, maxString: 600 });
      const s = typeof r === 'string' ? r : JSON.stringify(r);
      return s.length > 800 ? `${s.slice(0, 800)}…` : s;
    } catch {
      return '[无法序列化]';
    }
  }

  log(level: LogLevel, msg: string, fields: Omit<LogEntry, 'ts' | 'level' | 'msg'> = {}): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const entry: LogEntry = { ts: nowIso(), level, msg };
    if (fields.taskId) entry.taskId = fields.taskId;
    if (fields.stage) entry.stage = fields.stage;
    if (fields.mod) entry.mod = fields.mod;
    if (fields.data !== undefined) entry.data = redact(fields.data, { maxDepth: 5, maxArray: 20, maxString: 2048 });
    if (fields.err) entry.err = fields.err;
    this.write(entry);
  }

  debug(msg: string, fields?: Omit<LogEntry, 'ts' | 'level' | 'msg'>): void {
    this.log('debug', msg, fields ?? {});
  }
  info(msg: string, fields?: Omit<LogEntry, 'ts' | 'level' | 'msg'>): void {
    this.log('info', msg, fields ?? {});
  }
  warn(msg: string, fields?: Omit<LogEntry, 'ts' | 'level' | 'msg'>): void {
    this.log('warn', msg, fields ?? {});
  }

  /** 错误日志：Error 对象自动提取堆栈并经脱敏 */
  error(msg: string, err?: unknown, fields?: Omit<LogEntry, 'ts' | 'level' | 'msg' | 'err'>): void {
    const base = fields ?? {};
    if (err !== undefined) {
      const e = err instanceof Error ? err : new Error(String(err));
      const safeMessage = String((redact({ m: e.message }) as { m?: unknown }).m ?? e.message);
      this.log('error', msg, {
        ...base,
        err: {
          name: e.name,
          message: safeMessage,
          ...(e.stack ? { stack: String((redact({ s: e.stack }) as { s?: unknown }).s ?? e.stack) } : {}),
        },
      });
      return;
    }
    this.log('error', msg, base);
  }

  /** 创建带固定上下文的子 logger */
  child(ctx: { taskId?: string; mod?: string; stage?: string }): Logger {
    const parent = this;
    const sub = Object.create(this) as Logger;
    // 用一个轻量包装避免每次调用都合并对象
    type Fields = Omit<LogEntry, 'ts' | 'level' | 'msg'>;
    const merge = (f?: Fields): Fields => ({ ...ctx, ...(f ?? {}) });
    Object.defineProperties(sub, {
      debug: { value: (m: string, f?: Fields) => parent.debug(m, merge(f)) },
      info: { value: (m: string, f?: Fields) => parent.info(m, merge(f)) },
      warn: { value: (m: string, f?: Fields) => parent.warn(m, merge(f)) },
      error: { value: (m: string, e?: unknown, f?: Fields) => parent.error(m, e, merge(f)) },
      log: { value: (l: LogLevel, m: string, f?: Fields) => parent.log(l, m, merge(f)) },
      setLevel: { value: (l: LogLevel) => parent.setLevel(l) },
      setDir: { value: (d: string) => parent.setDir(d) },
      close: { value: () => parent.close() },
    });
    return sub;
  }

  close(): void {
    try {
      this.stream?.end();
    } catch {
      /* ignore */
    }
    this.stream = null;
  }
}

/** 全局 logger 单例（在 daemon / CLI 启动时初始化） */
export const log = new Logger();
