#!/usr/bin/env node
/**
 * 代码热更新监督进程（2026-10-24，用户需求原话：
 * 「能不能加一个热更新功能 每次更新和修bug后 都要手动关闭重新启动 能不能热更新 不需要关闭」）。
 *
 * 形态：`node src/hot-watch.ts --port 3000` —— 它**持有**真正的服务子进程
 * （`node src/cli.ts run --port 3000`），并在源码变化时替用户重启它。
 *
 * 为什么是「监督进程」而不是「在服务进程里监听自己」：
 *   ① .ts 代码改了**必须换一个进程**才会生效（Node 的类型擦除在启动时完成，已加载的模块
 *      不会重新解析）。在同一个进程里 import 缓存清不干净，且 orchestrator/UI/定时器/子进程
 *      句柄全在内存里 —— "重载自己"必然出现状态打架（两个队列、两个定时器、端口占用）。
 *   ② 监督进程自己不 import 业务模块，所以它**永远不会被业务代码的语法错误带崩**：
 *      就算 src 里改出一个类型错误，监督进程仍在，能把「类型检查失败」如实写进日志与状态。
 *
 * 三道闸（顺序不能换，原因写在对应位置）：
 *   ① **类型检查门**：`npm run typecheck` 不过就不重启 —— 否则一次语法笔误会把服务
 *      重启成崩溃循环，用户从「代码没生效」变成「服务起不来」，比原问题更糟；
 *   ② **忙时排队**：台账里有进行中的任务（转写/分析/切片/投稿）时只记「等待空闲」，
 *      空闲后自动重启 —— 重启会打断切片，甚至断在投稿那一步（历史上已因此手工续跑过两次）；
 *   ③ **优雅停止**：先 IPC 发 `{type:'shutdown'}` 让子进程走 `orch.stop()+ui.stop()`，
 *      5 秒不退再 SIGTERM，20 秒还没退才强杀。重启后由服务自己的 `recoverUnfinishedTasks`
 *      续跑未完成的场次。
 *
 * 另外两件事：
 *   · `web/src/**`（.js/.css/.html）保存后只跑 `npm run build:ui` 生成 `public/ui.html`，
 *     **不重启服务** —— 前端是单文件静态产物，刷新浏览器即可；构建失败只记日志，服务不受影响。
 *   · 子进程**崩溃自愈**：非本次重载引起的异常退出，按 2s→5s→10s→30s 退避自动拉起。
 *
 * 状态落盘 `data/hot-watch-state.json`（原子写：临时文件 + rename，读方永远不会读到半截 JSON），
 * 健康面板通过 `/api/health` 的 `hot` 字段展示它。日志同时写控制台与 `data/logs/hot-watch.log`。
 *
 * ⚠️ 本文件自己的改动**不会热生效**：监督进程不重启自己（那会丢掉它持有的子进程句柄，
 * 正是它要避免的事）。改了 hot-watch.ts 请手动重启一次启动器。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
/* 只依赖 util 这种"纯基础设施"，不 import 任何业务模块 —— 见文件头 ②：
   业务代码可能正处于被编辑坏掉的状态，监督进程必须永远起得来。 */
import { ROOT_DIR, appendTextSync, ensureDir, nowIso, readJson, writeJsonAtomic } from './util.ts';

/* ============================================================================
 * 一、纯函数（便于单测；不含任何 IO 与全局状态）
 * ========================================================================== */

/**
 * 「进行中」的场级状态。
 *
 * 为什么这些算忙：它们都意味着**有活正在被这个进程干**（转写 / LLM 分析 / 切片 / 投稿）。
 * 此时重启会把这些活打断在中间：转写有缓存不重复花钱，但切片要重切、投稿可能断在
 * 「已提交但没拿到 taskId」的模糊地带（`SUBMITTING` 就是为这种情况留的判定点）。
 * 反过来 `RECORDED` / `ANALYZED` / `CLIPPED` 都是「等下一步」的静止状态，重启不丢东西，
 * 且服务启动时的 `recoverUnfinishedTasks` 会把它们接着处理 —— 所以不算忙。
 */
export const BUSY_TASK_STATUSES: readonly string[] = ['PENDING', 'TRANSCRIBING', 'ANALYZING', 'CLIPPING', 'PUBLISHING'];

/** 「进行中」的切片级状态（CUTTING / SUBMITTING 时场级可能已经是 CLIPPED，必须单独看） */
export const BUSY_CLIP_STATUSES: readonly string[] = ['CUTTING', 'SUBMITTING'];

/** 台账快照里的忙碌判定结果 */
export interface BusySnapshot {
  /** 有任何进行中的任务/切片 */
  busy: boolean;
  /** 命中的状态（去重保序），用于日志/面板说明「忙在哪」 */
  reasons: string[];
  /** 参与判定的任务数（便于排障：台账读到了几条） */
  taskCount: number;
}

/** 任一状态属于「进行中」即为忙。用于单条切片与场级状态共用一套判定。 */
export function isBusyStatuses(statuses: readonly string[]): boolean {
  return statuses.some((s) => BUSY_TASK_STATUSES.includes(s) || BUSY_CLIP_STATUSES.includes(s));
}

/**
 * 从 ledger.json 的原始 JSON 计算忙碌快照。
 *
 * 为什么直接读文件而不复用 `Ledger`：监督进程要尽可能**与业务代码解耦** ——
 * 业务模块正在被编辑（可能正处于写坏的状态），监督进程绝不能因为 `import` 了一个
 * 语法/类型有问题的模块而自己也起不来。
 *
 * 兼容两种形状：`{tasks: {id: task}}`（当前格式）与 `{tasks: task[]}`（历史格式），
 * 以及任务里可能没有 `clips` 字段。任何异常形状都退化成「不忙」（宁可重启一次，
 * 也不要把重载永久卡死在等待空闲上）。
 */
export function computeBusy(ledger: unknown): BusySnapshot {
  const empty: BusySnapshot = { busy: false, reasons: [], taskCount: 0 };
  if (!ledger || typeof ledger !== 'object') return empty;
  const raw = (ledger as { tasks?: unknown }).tasks;
  let tasks: unknown[] = [];
  if (Array.isArray(raw)) tasks = raw;
  else if (raw && typeof raw === 'object') tasks = Object.values(raw as Record<string, unknown>);
  else return empty;

  const reasons: string[] = [];
  let taskCount = 0;
  for (const t of tasks) {
    if (!t || typeof t !== 'object') continue;
    taskCount++;
    const rec = t as { status?: unknown; clips?: unknown };
    if (typeof rec.status === 'string' && isBusyStatuses([rec.status])) {
      if (!reasons.includes(rec.status)) reasons.push(rec.status);
    }
    const clips = rec.clips;
    if (Array.isArray(clips)) {
      for (const c of clips) {
        const st = (c as { status?: unknown } | null)?.status;
        if (typeof st === 'string' && isBusyStatuses([st]) && !reasons.includes(st)) reasons.push(st);
      }
    }
  }
  return { busy: reasons.length > 0, reasons, taskCount };
}

/** 重载决策：`blocked` = 类型检查没过（保持旧进程）；`wait` = 忙，等空闲；`reload` = 立刻重启 */
export type ReloadDecision = 'reload' | 'wait' | 'blocked';

/**
 * 决定一次「后端重载」该怎么做。
 *
 * 顺序刻意固定：**先类型检查、再判忙**。反过来的话，忙时才做的排队会掩盖掉
 * 「代码根本编不过」这个更重要的信息，用户会以为"等空闲就会生效"。
 */
export function decideReload(input: { typecheckOk: boolean; busy: boolean }): ReloadDecision {
  if (!input.typecheckOk) return 'blocked';
  if (input.busy) return 'wait';
  return 'reload';
}

/**
 * 格式化重载原因（给状态文件/健康面板看）。
 * 只列前 `max` 个文件并带上总数：一次保存几十个文件时，把整串路径塞进状态文件没有信息量。
 */
export function formatReloadReason(files: readonly string[], max = 6): string {
  const list = files.map((f) => f.trim()).filter(Boolean);
  if (list.length === 0) return '（未记录到具体文件）';
  const head = list.slice(0, max).join('、');
  return list.length > max ? `${head} 等 ${list.length} 个文件` : head;
}

/** 崩溃重启的退避阶梯：2s → 5s → 10s → 30s（封顶） */
export const BACKOFF_STEPS: readonly number[] = [2000, 5000, 10000, 30000];

/**
 * 下一次退避间隔。`prev` 传上一次用的间隔（首次传 0）。
 * 为什么要有阶梯而不是固定 2s：代码写坏时子进程会"起来就崩"，固定 2s 会把 CPU 和日志刷爆；
 * 封顶 30s 是为了让用户在改好代码后不必等太久。
 */
export function nextBackoff(prevMs: number): number {
  const last = BACKOFF_STEPS[BACKOFF_STEPS.length - 1]!;
  if (!Number.isFinite(prevMs) || prevMs <= 0) return BACKOFF_STEPS[0]!;
  const idx = BACKOFF_STEPS.findIndex((ms) => ms > prevMs);
  return idx >= 0 ? BACKOFF_STEPS[idx]! : last;
}

/** 不该触发重载的路径（依赖、版本库、构建产物、临时文件） */
const IGNORED_SEGMENTS = new Set(['node_modules', '.git', '.cache', 'dist']);

/**
 * 路径是否忽略。
 *
 * 为什么必须过滤 `node_modules`：`fs.watch(recursive)` 能看到它下面的一切，
 * npm 装依赖时几万个文件事件会把 debounce 一直重置，重载永远等不到。
 * 临时文件（`.tmp` / `~` / `.swp`）是编辑器保存时产生的中间态，跟着重启只会白重启一次。
 */
export function isIgnoredPath(rel: string): boolean {
  const p = rel.replace(/\\/g, '/');
  const segs = p.split('/').filter(Boolean);
  if (segs.length === 0) return true;
  if (segs.some((s) => IGNORED_SEGMENTS.has(s))) return true;
  const base = segs[segs.length - 1] ?? '';
  if (!base) return true;
  if (base.startsWith('.')) return true;
  if (base.endsWith('~') || base.endsWith('.tmp') || base.endsWith('.swp') || base.endsWith('.swx')) return true;
  return false;
}

/**
 * 从 `/api/bootstrap`（或 `/api/health`）的返回体里取应答者 pid（取不到返回 null）。
 * 抽成纯函数是为了可单测：这段逻辑一旦取错字段，`waitReady` 会永远判"无法核对"，
 * 端口被别人占着也照样报"重载完成" —— 正是要防的那个谎报。
 */
export function parseHealthPid(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const rec = payload as { health?: { pid?: unknown }; pid?: unknown };
  const raw = rec.health?.pid ?? rec.pid;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** 变化类型：后端代码（需重启）/ 前端模块（只需构建）/ 无关 */
export type ChangeKind = 'backend' | 'ui';

/**
 * 分类一次文件变化。
 * 后端 = `src/**\/*.ts`；前端 = `web/src/**\/*.{js,css,html}`（构建后进 `public/ui.html`）。
 * 其它一律忽略 —— 包括 `config.json`：改配置本来就有 UI 的保存接口，重启不是它的语义。
 */
export function classifyChange(rel: string): ChangeKind | null {
  const p = rel.replace(/\\/g, '/');
  if (p.startsWith('web/src/')) return /\.(js|css|html)$/i.test(p) ? 'ui' : null;
  if (p.startsWith('src/')) return /\.ts$/i.test(p) ? 'backend' : null;
  return null;
}

/** 把命令输出压成一段可读的错误摘要（去 ANSI、取尾部若干行、限长） */
export function summarizeError(output: string, maxLines = 8): string {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return '（命令失败但没有输出）';
  return lines.slice(-maxLines).join('\n').slice(0, 2000);
}

/* ============================================================================
 * 二、状态文件（健康面板读它）
 * ========================================================================== */

export interface HotWatchState {
  /** 热更新是否在工作（监督进程活着 = true） */
  enabled: boolean;
  /** 监督进程 pid（不是服务 pid；服务 pid 在 `pid`） */
  supervisorPid: number | null;
  /** 当前服务子进程 pid；正在重启的瞬间为 null */
  pid: number | null;
  /** 监督进程启动时间 */
  startedAt: string | null;
  /** 最近一次成功重载的时间与原因（哪些文件） */
  lastReloadAt: string | null;
  lastReloadReason: string | null;
  /** 非 null = 「有改动在等空闲」的起始时间 */
  pendingSince: string | null;
  /** 当前台账是否忙碌（面板展示用） */
  busy: boolean;
  /** 最近一次类型检查的时间与错误（通过时 error 为 null） */
  lastTypecheckAt: string | null;
  lastTypecheckError: string | null;
  /** 最近一次前端构建的时间与错误 */
  lastUiBuildAt: string | null;
  lastUiBuildError: string | null;
  /** 本进程累计重载次数（便于确认"到底重启过几次"） */
  reloads: number;
  /**
   * 监督进程自己捕获到的内部异常（uncaughtException / unhandledRejection）。
   * 这类异常**不让进程退出**（见 `noteInternalError` 的说明），但要留痕：否则"监督进程莫名不工作"
   * 只能靠翻控制台，而那窗口用户早就关了。
   */
  lastInternalError: string | null;
  /** 心跳（每 15s 一次）。面板据此识别「状态文件是上次遗留的」——监督进程被强杀时它来不及写 enabled=false */
  heartbeatAt: string | null;
  port: number;
}

/** 状态文件的默认位置（服务端 `/api/health` 与监督进程共用同一个定义，避免两边各写一遍路径） */
export function stateFilePath(rootDir: string = ROOT_DIR): string {
  return path.join(rootDir, 'data', 'hot-watch-state.json');
}

/** 空状态（新建 / 停止后落盘用） */
export function emptyState(port: number): HotWatchState {
  return {
    enabled: false,
    supervisorPid: null,
    pid: null,
    startedAt: null,
    lastReloadAt: null,
    lastReloadReason: null,
    pendingSince: null,
    busy: false,
    lastTypecheckAt: null,
    lastTypecheckError: null,
    lastUiBuildAt: null,
    lastUiBuildError: null,
    reloads: 0,
    lastInternalError: null,
    heartbeatAt: null,
    port,
  };
}

/** 心跳超过这个时长没更新 ⇒ 认为监督进程已经不在（状态文件是遗留的） */
export const HEARTBEAT_STALE_MS = 90_000;

/** 状态是否可信：enabled 且心跳新鲜。被强杀的监督进程来不及写 enabled=false，只能靠心跳兜底。 */
export function isStateAlive(state: HotWatchState | null, nowMs: number = Date.now()): boolean {
  if (!state || !state.enabled) return false;
  if (!state.heartbeatAt) return true; // 老版本状态文件没有心跳字段：按 enabled 处理
  const at = Date.parse(state.heartbeatAt);
  if (!Number.isFinite(at)) return true;
  return nowMs - at <= HEARTBEAT_STALE_MS;
}

/**
 * 读状态文件；不存在/读坏都返回 null（健康面板据此显示「未启用」）。
 * 绝不抛：状态文件只是展示用的附加信息，不能因为它把 `/api/health` 打成 500。
 */
export function readState(p: string): HotWatchState | null {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = readJson<Partial<HotWatchState> & Record<string, unknown>>(p);
    if (!raw || typeof raw !== 'object') return null;
    return { ...emptyState(Number(raw['port']) || 0), ...raw } as HotWatchState;
  } catch {
    return null;
  }
}

/** 原子写状态文件（临时文件 + rename，读方不会读到半截 JSON） */
export function writeState(p: string, state: HotWatchState): void {
  writeJsonAtomic(p, state);
}

/* ============================================================================
 * 三、监督进程本体
 * ========================================================================== */

export interface HotWatchOptions {
  /** 项目根（默认仓库根） */
  rootDir?: string;
  /** 服务端口（原样透传给子进程 `--port`） */
  port?: number;
  /** 子进程入口（相对 root，默认 src/cli.ts） */
  entry?: string;
  /** 透传给子进程的额外参数（如 --dry-run / --allow-paid） */
  childArgs?: string[];
  statePath?: string;
  logPath?: string;
  ledgerPath?: string;
  /** 类型检查命令（shell 字符串，工作目录 = rootDir） */
  typecheckCmd?: string;
  /** 前端构建命令（shell 字符串，工作目录 = rootDir） */
  uiBuildCmd?: string;
  /** 文件变化去抖（默认 1200ms） */
  debounceMs?: number;
  /** 等待空闲的轮询间隔（默认 5000ms） */
  busyPollMs?: number;
  /** 类型检查/构建超时（默认 180s / 300s） */
  typecheckTimeoutMs?: number;
  uiBuildTimeoutMs?: number;
  /** 优雅退出等待（默认 5000ms） */
  gracefulStopMs?: number;
  /** SIGTERM 后等待（默认 20000ms） */
  termTimeoutMs?: number;
  /** 子进程"活够久"就重置退避（默认 60s） */
  stableAfterMs?: number;
  /**
   * 就绪探测：等多久才算"没起来"（默认 60s，与启动器等 `/api/bootstrap` 的口径一致）。
   * `spawn` 成功 ≠ 服务起来了：端口要绑、配置要读、自检要跑，真机需要 1~3 秒。
   */
  readyTimeoutMs?: number;
  /**
   * 无应答宽限（默认 6s）：进程一直活着、却始终不响应 `/api/bootstrap`，
   * 说明这次启动**本来就没有 Web UI**（`--no-ui`，或 config 里 ui.enabled=false）。
   * 这种情况不能当成"重载失败"（否则会进崩溃循环），按"进程存活即算起来"处理并记一条日志。
   */
  readyGraceMs?: number;
}

/** 解析后的默认值（内部用，所有字段必填） */
interface ResolvedOptions {
  rootDir: string;
  port: number;
  entry: string;
  childArgs: string[];
  statePath: string;
  logPath: string;
  logsDir: string;
  ledgerPath: string;
  typecheckCmd: string;
  uiBuildCmd: string;
  debounceMs: number;
  busyPollMs: number;
  typecheckTimeoutMs: number;
  uiBuildTimeoutMs: number;
  gracefulStopMs: number;
  termTimeoutMs: number;
  stableAfterMs: number;
  readyTimeoutMs: number;
  readyGraceMs: number;
}

function resolveOptions(o: HotWatchOptions): ResolvedOptions {
  const rootDir = path.resolve(o.rootDir ?? ROOT_DIR);
  const logsDir = path.join(rootDir, 'data', 'logs');
  return {
    rootDir,
    port: Number.isFinite(o.port) ? Number(o.port) : 3000,
    entry: o.entry ?? path.join('src', 'cli.ts'),
    childArgs: o.childArgs ?? [],
    statePath: o.statePath ?? stateFilePath(rootDir),
    logPath: o.logPath ?? path.join(logsDir, 'hot-watch.log'),
    logsDir,
    ledgerPath: o.ledgerPath ?? path.join(rootDir, 'data', 'ledger.json'),
    typecheckCmd: o.typecheckCmd ?? 'npm run typecheck',
    uiBuildCmd: o.uiBuildCmd ?? 'npm run build:ui',
    debounceMs: o.debounceMs ?? 1200,
    busyPollMs: o.busyPollMs ?? 5000,
    typecheckTimeoutMs: o.typecheckTimeoutMs ?? 180_000,
    uiBuildTimeoutMs: o.uiBuildTimeoutMs ?? 300_000,
    gracefulStopMs: o.gracefulStopMs ?? 5000,
    termTimeoutMs: o.termTimeoutMs ?? 20_000,
    stableAfterMs: o.stableAfterMs ?? 60_000,
    readyTimeoutMs: o.readyTimeoutMs ?? 60_000,
    readyGraceMs: o.readyGraceMs ?? 6000,
  };
}

/** 等待子进程退出，最多 `ms`；返回是否真的退出了 */
function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (v: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(v);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(50, ms));
    child.once('exit', onExit);
  });
}

/** 心跳间隔 */
export const HEARTBEAT_MS = 15_000;

/** 日志单文件上限（超过就切一份 `.1`）；`data/logs` 本来就近百 MB，不能再来个无界单文件 */
const LOG_MAX_BYTES = 20 * 1024 * 1024;

export class HotWatcher {
  private readonly o: ResolvedOptions;
  private state: HotWatchState;
  private child: ChildProcess | null = null;
  private readonly watchers: fs.FSWatcher[] = [];
  private heartbeatTimer: NodeJS.Timeout | null = null;

  /** 待重载的后端文件（Set 去重；连写只留一份） */
  private readonly pendingBackend = new Set<string>();
  /** 待构建的前端文件 */
  private readonly pendingUi = new Set<string>();

  private debounceTimer: NodeJS.Timeout | null = null;
  private busyTimer: NodeJS.Timeout | null = null;
  private crashTimer: NodeJS.Timeout | null = null;
  private aliveTimer: NodeJS.Timeout | null = null;
  private busyPollTimer: NodeJS.Timeout | null = null;

  /** 本次退出是"我们让它退的"（重载/停止），不是崩溃 */
  private expectingExit = false;
  /** 停止流程已开始：不再重启、不再重载 */
  private stopping = false;
  /**
   * 一次重载正在进行（已进入"停旧→起新→等就绪"这一段）。
   * 这期间子进程退出是**我们自己造成的**，绝不能排崩溃重启 —— 由 `reloadNow` 自己负责失败收尾。
   * 与 `expectingExit` 的分工：`expectingExit` 只覆盖"发 shutdown 到 exit"那一小段，
   * `reloadActive` 覆盖整段（含等就绪期间进程崩溃），否则会出现两套重启逻辑抢同一个端口。
   */
  private reloadActive = false;

  private reloadQueued = false;
  private reloadRunning = false;
  private uiRunning = false;
  private uiQueued = false;

  private crashBackoffMs = 0;
  /** 台账 mtime 缓存：没变就不重复解析大 JSON */
  private ledgerMtimeMs = -1;
  private lastBusy: BusySnapshot = { busy: false, reasons: [], taskCount: 0 };

  /**
   * 同一时刻只允许一次 spawn。
   *
   * ★ 这是 2026-10-24 QA 复现出来的真 bug 的修法之一：
   *   崩溃自愈的退避定时器与热重载可能同时走到 spawn —— 一个在 `reloadNow` 里，
   *   一个在 `crashTimer` 到期时。没有这道锁时会出现**两个子进程**：
   *   第二个 EADDRINUSE 秒退，而 `this.child` 被它覆盖 ⇒ 健康的那个变成孤儿
   *   （占着端口，却既停不掉也热更新不到），此后每次"重载成功"都是假的。
   */
  private spawnInFlight: Promise<number | null> | null = null;

  /**
   * 上一次类型检查通过时的"文件集合指纹"。
   * 忙时排队会反复回到 `runReloadCycle`，若每次都跑 `npm run typecheck`，
   * 转写/切片正忙的时候机器反而被 tsc 抢走 CPU（QA 实测 busy-poll=300ms 时 1.2s 内跑了 3 次）。
   * 文件集合没变就复用上次结论；有新文件保存 ⇒ 指纹变化 ⇒ 重新检查。
   */
  private typecheckPassedKey: string | null = null;

  constructor(options: HotWatchOptions = {}) {
    this.o = resolveOptions(options);
    this.state = emptyState(this.o.port);
  }

  /** 供测试/诊断读取当前状态快照（拷贝，外部改不到内部） */
  getState(): HotWatchState {
    return { ...this.state };
  }

  /**
   * 记一次"监督进程自己的"内部异常，然后**继续运行**（不退出）。
   *
   * 为什么必须兜住（2026-10-24 QA 建议）：`drainReload()` / `drainUiBuild()` 是
   * fire-and-forget（`void this.drainX()`），链里任何一处抛出都会变成 unhandledRejection；
   * Node 默认行为是**退出进程**，而本进程的 exit 钩子会顺手把服务子进程也杀掉 ——
   * 这跟文件头"监督进程永远在，业务代码改坏了它也不死"的承诺正好相反。
   * 兜住之后，下一次文件变化仍会重试，服务也不受牵连。
   */
  noteInternalError(kind: 'uncaughtException' | 'unhandledRejection', err: unknown): void {
    const text =
      err instanceof Error
        ? `${err.message}\n${(err.stack ?? '').split('\n').slice(1, 5).join('\n')}`.trim()
        : String(err);
    let msg = `${kind}: ${text}`;
    /* 异常发生在"停旧→起新→等就绪"这一段时，子进程可能正处于中间态（旧的已停、新的没起好）。
       `reloadActive` 必须复位：否则后续真崩溃会被这条标记一直挡住，再没人拉起服务。
       复位后交给两条既有的兜底路径 —— 崩溃自愈（若子进程确实没了）或用户下一次保存。 */
    if (this.reloadActive) {
      this.reloadActive = false;
      msg += '\n（异常发生在重载过程中：重载可能处于中间态，已复位 reloadActive，交由崩溃自愈/下一次保存兜底）';
    }
    msg = msg.slice(0, 1200);
    try {
      this.log(`内部异常已捕获，监督进程继续运行（${msg}）`);
    } catch {
      /* 连日志都写不了也不能退出 */
    }
    this.state.lastInternalError = msg;
    try {
      this.persist();
    } catch {
      /* ignore */
    }
  }

  /* ---------------------------- 日志 ---------------------------- */

  /** 控制台 + 文件双写；文件用于事后排障（"到底为什么重启/为什么没重启"） */
  private log(msg: string): void {
    const line = `${nowIso()}  ${msg}`;
    console.log(`[hot-watch] ${msg}`);
    this.appendLog(`${line}\n`);
  }

  /**
   * 追加日志，超过 `LOG_MAX_BYTES`（20MB）就切一份 `.1`（只保留一份历史）。
   * 为什么必须切：这一份里既有监督进程的决策，也有子进程 stdout 的全文
   * （服务的 `live_auto-*.jsonl` 已经记过一遍，这里是为了"重启前后同一条时间线"），
   * 不设上限就是一个无界单文件 —— `data/logs` 本来就已近百 MB。
   */
  private appendLog(text: string): void {
    try {
      ensureDir(path.dirname(this.o.logPath));
      try {
        if (fs.statSync(this.o.logPath).size > LOG_MAX_BYTES) {
          fs.renameSync(this.o.logPath, `${this.o.logPath}.1`);
        }
      } catch {
        /* 文件还不存在：直接写 */
      }
      appendTextSync(this.o.logPath, text);
    } catch {
      /* 日志写不进去也不能让监督进程挂掉 */
    }
  }

  /**
   * 把子进程的 stdout/stderr 转到控制台。
   *
   * ★ 只转控制台，**不再写进 hot-watch.log**（2026-10-24 QA 提醒）：
   *   服务自己已经有 `data/logs/live_auto-*.jsonl` 记了同一批内容，这里再落一份等于
   *   把日志体积翻倍、且两处内容还不完全一致（这里是原始 stdout，那边是结构化条目），
   *   排障时反而要先判断"该信哪份"。hot-watch.log 只留**监督层的决策**。
   */
  private pipeChildOutput(tag: 'out' | 'err', chunk: string): void {
    /* 服务的进度行用 `\r` 原地重绘（`\r  TRANSCRIBING 3/10`）：先折成换行再逐行打，免得控制台糊成一行 */
    const text = chunk.replace(/\r\n?/g, '\n');
    for (const line of text.split('\n')) {
      if (line === '') continue;
      console.log(`[svc:${tag}] ${line}`);
    }
  }

  /* ---------------------------- 状态 ---------------------------- */

  private persist(): void {
    try {
      ensureDir(path.dirname(this.o.statePath));
      writeState(this.o.statePath, this.state);
    } catch (e) {
      this.log(`状态文件写入失败：${(e as Error).message}`);
    }
  }

  /* ---------------------------- 生命周期 ---------------------------- */

  /** 启动：写状态 → 拉起服务 → 挂监听 → 起忙闲轮询 */
  async start(): Promise<void> {
    ensureDir(path.join(this.o.rootDir, 'data'));
    ensureDir(this.o.logsDir);
    this.state.enabled = true;
    this.state.supervisorPid = process.pid;
    this.state.startedAt = nowIso();
    this.state.heartbeatAt = nowIso();
    this.persist();

    /* 监督进程自己挂掉时顺手带走服务子进程 —— 否则会留下"端口被占但没人管热更新"的孤儿。
       （被 TerminateProcess 强杀时这里跑不到，所以 launcher 侧也补了收子进程的动作。） */
    process.on('exit', () => {
      try {
        this.child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    });

    this.log(`热更新已开启（端口 ${this.o.port}，监听 src/**/*.ts 与 web/src/**）`);
    this.refreshBusy();

    const pid = await this.spawnChild();
    if (pid === null) this.scheduleCrashRestart('首次启动失败');

    this.watchTree(path.join(this.o.rootDir, 'src'));
    this.watchTree(path.join(this.o.rootDir, 'web', 'src'));

    /* 定期刷新忙闲：健康面板要能看出「现在能不能重载」，而不是只在下一次保存时才知道 */
    this.busyPollTimer = setInterval(() => this.refreshBusy(), Math.max(1000, this.o.busyPollMs));
    this.busyPollTimer.unref?.();

    /* 心跳：面板用它识别"状态文件是遗留的"（监督进程被强杀时来不及写 enabled=false） */
    this.heartbeatTimer = setInterval(() => {
      this.state.heartbeatAt = nowIso();
      this.persist();
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  /** 停止：收子进程 → 落盘 enabled=false → 关监听 */
  async stop(reason = 'supervisor-stop'): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log(`收到停止信号（${reason}），正在收工…`);
    this.clearTimer('debounce');
    this.clearTimer('busy');
    this.clearTimer('crash');
    this.clearTimer('alive');
    if (this.busyPollTimer) {
      clearInterval(this.busyPollTimer);
      this.busyPollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await this.stopChild(reason);
    for (const w of this.watchers.splice(0)) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.state.enabled = false;
    this.state.pid = null;
    this.state.pendingSince = null;
    this.persist();
    this.log('已停止热更新监督进程。');
  }

  private clearTimer(which: 'debounce' | 'busy' | 'crash' | 'alive'): void {
    const map = { debounce: 'debounceTimer', busy: 'busyTimer', crash: 'crashTimer', alive: 'aliveTimer' } as const;
    const key = map[which];
    const t = this[key];
    if (t) {
      clearTimeout(t);
      this[key] = null;
    }
  }

  /* ---------------------------- 子进程 ---------------------------- */

  /**
   * 拉起服务子进程；返回 pid（失败返回 null，由调用方决定是否退避重试）。
   *
   * 这里有两道**必须**的守卫，缺一条就会出现"两个服务抢同一个端口"：
   *   ① 已有存活子进程 ⇒ 不重复拉起（返回现有 pid）；
   *   ② 已有一次 spawn 在路上 ⇒ 复用同一个 Promise（崩溃自愈与热重载并发时）。
   */
  private async spawnChild(): Promise<number | null> {
    if (this.stopping) return null;
    if (this.spawnInFlight) return await this.spawnInFlight;
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      const pid = this.child.pid ?? null;
      this.log(`已有存活的服子进程（pid=${String(pid)}），不重复拉起`);
      return pid;
    }
    this.spawnInFlight = this.doSpawnChild();
    try {
      return await this.spawnInFlight;
    } finally {
      this.spawnInFlight = null;
    }
  }

  private async doSpawnChild(): Promise<number | null> {
    if (this.stopping) return null;
    const entryAbs = path.isAbsolute(this.o.entry) ? this.o.entry : path.join(this.o.rootDir, this.o.entry);
    if (!fs.existsSync(entryAbs)) {
      this.log(`找不到服务入口 ${entryAbs}，无法启动`);
      return null;
    }
    const nodeArgs = [
      '--max-old-space-size=8192',
      '--report-on-fatalerror',
      `--report-directory=${this.o.logsDir}`,
      entryAbs,
      'run',
      '--port',
      String(this.o.port),
      ...this.o.childArgs,
    ];
    return await new Promise<number | null>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, nodeArgs, {
          cwd: this.o.rootDir,
          /* ipc 是「优雅停止」的唯一通道：SIGTERM 在 Windows 上是硬杀，没有善后机会 */
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: { ...process.env, NO_COLOR: '1' },
        });
      } catch (e) {
        this.log(`启动服务子进程失败：${(e as Error).message}`);
        resolve(null);
        return;
      }
      this.child = child;
      this.expectingExit = false;

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => this.pipeChildOutput('out', d));
      child.stderr?.on('data', (d: string) => this.pipeChildOutput('err', d));

      const spawnedPid: number | null = child.pid ?? null;

      child.on('error', (e) => {
        this.log(`服务子进程错误：${e.message}`);
      });

      child.on('exit', (code, signal) => {
        if (this.aliveTimer) {
          clearTimeout(this.aliveTimer);
          this.aliveTimer = null;
        }
        if (this.child === child) this.child = null;
        this.state.pid = null;
        this.persist();
        this.log(`服务子进程退出（code=${String(code)} signal=${String(signal)}）`);
        if (this.stopping) return;
        if (this.expectingExit) {
          /* 本次是重载/停止引起的，不当作崩溃 */
          this.expectingExit = false;
          return;
        }
        /* 重载整段（停旧→起新→等就绪）里退出同样不是"需要自愈的崩溃"：
           失败该由 reloadNow 收尾（它会显式排一次崩溃退避），在这里也排会变成两套重启。 */
        if (this.reloadActive) {
          this.log('服务在重载过程中退出（由本次重载负责收尾，不排崩溃重启）');
          return;
        }
        this.scheduleCrashRestart('异常退出');
      });

      if (spawnedPid !== null) {
        this.state.pid = spawnedPid;
        this.state.busy = this.lastBusy.busy;
        this.persist();
        this.log(`服务子进程已启动（pid=${spawnedPid}）`);
        /* 活够久 ⇒ 说明这次启动是健康的，把退避阶梯归零 */
        this.aliveTimer = setTimeout(() => {
          this.crashBackoffMs = 0;
          this.aliveTimer = null;
        }, this.o.stableAfterMs);
        this.aliveTimer.unref?.();
        resolve(spawnedPid);
      } else {
        /* pid 拿不到（极少数 spawn 立即失败的场景）：交给 exit/error 处理 */
        resolve(null);
      }
    });
  }

  /**
   * 等子进程**真正应答**（`GET /api/bootstrap`），而不是"spawn 成功就算起来了"。
   *
   * 为什么必须真的问一句：`spawn` 只代表进程被创建。端口被占、配置硬错误、代码起不来时，
   * 进程会在几百毫秒内退出；此时若立刻记"重载完成"，面板会显示"最近一次重载 刚刚"
   * 而用户刷新页面依然连不上（新代码也没生效）——这是 QA 报的"谎报成功"。
   *
   * 三个出口：
   *   · 子进程退出 ⇒ false（失败，交给崩溃退避）；
   *   · 探测到 200 ⇒ true；
   *   · 进程活着但一直没人应答、超过 grace ⇒ true 但 `answered=false`
   *     （这次启动就没有 Web UI：`--no-ui` / config 里 ui.enabled=false，不能判失败否则崩溃循环）。
   */
  private async waitReady(child: ChildProcess): Promise<{ ready: boolean; answered: boolean; elapsedMs: number }> {
    const t0 = Date.now();
    const url = `http://127.0.0.1:${this.o.port}/api/bootstrap`;
    if (child.exitCode !== null || child.signalCode !== null) return { ready: false, answered: false, elapsedMs: 0 };
    while (Date.now() - t0 < this.o.readyTimeoutMs) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { ready: false, answered: false, elapsedMs: Date.now() - t0 };
      }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          /* `/api/bootstrap` 里带了 `pid`（见 server.ts 的同名注释）：一次请求就能确认
             "应答者是不是我刚拉起的子进程"，不必额外再打一次接口。
             老版本服务没有该字段 ⇒ 退回 `/api/health` 再问一次；都拿不到就按"无法核对"通过，
             保证升级期间不会因此判失败。 */
          const body = await res.json().catch(() => null);
          const owner = parseHealthPid(body) ?? (await this.probeHealthPid());
          if (owner === null || owner === child.pid) {
            return { ready: true, answered: true, elapsedMs: Date.now() - t0 };
          }
          /* 端口被**别的进程**占着（典型：上次遗留的孤儿服务）。此时新子进程 bind 失败但
             仍存活（cli.ts 里 Web UI 启动失败只记日志、继续跑），若判"就绪"，新代码永不生效
             而面板显示成功 —— 这正是 QA 提的那个谎报场景。 */
          this.log(
            `端口 ${this.o.port} 的应答者不是本次拉起的子进程（应答者 pid=${owner}，期望 pid=${String(child.pid)}）` +
              '—— 判定为端口被其它进程占用，本次重载失败；请先结束占用者，否则热更新不会生效。',
          );
          return { ready: false, answered: false, elapsedMs: Date.now() - t0 };
        }
      } catch {
        /* 还没监听 / 正在绑端口：继续等 */
      }
      if (this.stopping) return { ready: false, answered: false, elapsedMs: Date.now() - t0 };
      if (Date.now() - t0 > this.o.readyGraceMs) {
        this.log(
          `${this.o.readyGraceMs}ms 内没有应答 ${url}（进程仍存活）—— 判定这次启动没有 Web UI（--no-ui 或 ui.enabled=false），按进程存活算就绪`,
        );
        return { ready: true, answered: false, elapsedMs: Date.now() - t0 };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    /* 超时：进程还活着就当起来了（服务可能极慢），但要明确记一条，别让人以为探测通过了 */
    const alive = child.exitCode === null && child.signalCode === null;
    return { ready: alive, answered: false, elapsedMs: Date.now() - t0 };
  }

  /**
   * 问一次 `/api/health` 拿应答者的 pid（拿不到返回 null ⇒ 视为"无法核对"，按通过处理）。
   * 用于区分"我的子进程在应答"与"端口被别的进程占着"（详见 waitReady 里的说明）。
   * 老版本服务没有这个字段，`null` 分支保证升级期间不会因此判失败。
   */
  private async probeHealthPid(): Promise<number | null> {
    try {
      const r = await fetch(`http://127.0.0.1:${this.o.port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) return null;
      return parseHealthPid(await r.json());
    } catch {
      return null;
    }
  }

  /**
   * 崩溃自愈：按 2s→5s→10s→30s 退避拉起。
   *
   * 三种"不是崩溃"的情况必须挡住（否则会重复拉起 / 和重载抢端口）：
   *   · `stopping` —— 监督进程正在收工；
   *   · `reloadActive` —— 这是一次热重载（停旧起新），失败收尾由 `reloadNow` 负责；
   *   · 已有 `crashTimer` —— 同一件事只排一次。
   */
  private scheduleCrashRestart(why: string): void {
    if (this.stopping || this.reloadActive || this.crashTimer) return;
    const delay = nextBackoff(this.crashBackoffMs);
    this.crashBackoffMs = delay;
    this.log(`${why}：${Math.round(delay / 1000)}s 后自动拉起服务`);
    this.crashTimer = setTimeout(() => {
      this.crashTimer = null;
      void this.spawnChild().then((pid) => {
        if (pid === null && !this.stopping) this.scheduleCrashRestart('拉起仍失败');
      });
    }, delay);
    /* ★ 这里**不能** unref：子进程刚死时，这个定时器往往是唯一还活着的句柄。
       unref 掉会让监督进程自己退出 —— "崩溃自愈"直接失效（比不实现更糟：看起来有守护，其实没有）。 */
  }

  /**
   * 优雅停止子进程。
   * 顺序：IPC shutdown → 等 5s → SIGTERM → 等 20s → 强杀。
   * 为什么不直接 kill：`orch.stop()` 会把台账刷盘、把正在写的产物收尾；
   * 硬杀会留下半截 ui.html / 半截 ledger.json 之类需要人工收拾的现场。
   */
  private async stopChild(reason: string): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.expectingExit = true;
    if (child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return;
    }
    this.log(`通知服务优雅退出（${reason}）…`);
    try {
      child.send({ type: 'shutdown', reason });
    } catch {
      /* 通道可能已断；下面还有 SIGTERM 兜底 */
    }
    if (await waitExit(child, this.o.gracefulStopMs)) {
      this.log('服务已优雅退出。');
      this.child = null;
      return;
    }
    this.log(`优雅退出超时（${this.o.gracefulStopMs}ms），发 SIGTERM…`);
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    if (await waitExit(child, this.o.termTimeoutMs)) {
      this.log('服务在 SIGTERM 后退出。');
      this.child = null;
      return;
    }
    this.log(`SIGTERM 后仍未退出（${this.o.termTimeoutMs}ms），强制结束。`);
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await waitExit(child, 3000);
    this.child = null;
  }

  /* ---------------------------- 文件监听 ---------------------------- */

  private watchTree(dir: string): void {
    if (!fs.existsSync(dir)) {
      this.log(`跳过不存在的目录：${dir}`);
      return;
    }
    try {
      const w = fs.watch(dir, { recursive: true }, (_event, filename) => {
        this.onFsEvent(dir, filename === null ? null : filename.toString());
      });
      w.on('error', (e) => this.log(`监听出错（${dir}）：${e.message}`));
      this.watchers.push(w);
      this.log(`开始监听 ${path.relative(this.o.rootDir, dir) || '.'}（recursive）`);
    } catch (e) {
      this.log(`无法监听 ${dir}：${(e as Error).message}`);
    }
  }

  private onFsEvent(dir: string, filename: string | null): void {
    if (this.stopping || !filename) return;
    const abs = path.join(dir, filename);
    const rel = path.relative(this.o.rootDir, abs).replace(/\\/g, '/');
    if (isIgnoredPath(rel)) return;
    const kind = classifyChange(rel);
    if (!kind) return;
    if (kind === 'backend') this.pendingBackend.add(rel);
    else this.pendingUi.add(rel);
    this.scheduleFlush();
  }

  /**
   * 去抖：编辑器保存一个文件会产生多个事件（write/rename），一次 `git checkout` 会连写几十个。
   * 每次事件都重置定时器 ⇒ 只有"安静了 debounceMs 之后"才真正动手。
   * 这样连续保存只排**一次**重载，且以最后一次的文件列表为准。
   */
  private scheduleFlush(): void {
    this.clearTimer('debounce');
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flush();
    }, this.o.debounceMs);
  }

  private flush(): void {
    if (this.stopping) return;
    if (this.pendingUi.size > 0) this.queueUiBuild();
    if (this.pendingBackend.size > 0) this.queueReload();
  }

  /* ---------------------------- 前端构建 ---------------------------- */

  private queueUiBuild(): void {
    this.uiQueued = true;
    if (this.uiRunning) return; // 正在构建：标记排队，等这次结束后再跑一次（覆盖最新改动）
    void this.drainUiBuild();
  }

  private async drainUiBuild(): Promise<void> {
    if (this.uiRunning) return;
    this.uiRunning = true;
    try {
      while (this.uiQueued && !this.stopping) {
        this.uiQueued = false;
        await this.runUiBuild();
      }
    } finally {
      this.uiRunning = false;
    }
  }

  private async runUiBuild(): Promise<void> {
    const files = [...this.pendingUi];
    this.pendingUi.clear();
    if (files.length === 0) return;
    this.log(`前端模块有改动（${formatReloadReason(files)}），开始构建…`);
    const r = await this.runCommand(this.o.uiBuildCmd, this.o.uiBuildTimeoutMs);
    this.state.lastUiBuildAt = nowIso();
    if (r.code === 0) {
      this.state.lastUiBuildError = null;
      this.persist();
      this.log('前端构建完成，刷新浏览器即可生效（服务未重启）。');
      return;
    }
    /* 构建失败不动服务：后端与已有的 public/ui.html 都还能正常用 */
    this.state.lastUiBuildError = summarizeError(r.output);
    this.persist();
    this.log(`前端构建失败（服务未受影响）：\n${this.state.lastUiBuildError}`);
  }

  /* ---------------------------- 后端重载 ---------------------------- */

  private queueReload(): void {
    this.reloadQueued = true;
    if (this.reloadRunning) return; // 正在重载：合并成一次后续重载
    void this.drainReload();
  }

  private async drainReload(): Promise<void> {
    if (this.reloadRunning) return;
    this.reloadRunning = true;
    try {
      while (this.reloadQueued && !this.stopping) {
        this.reloadQueued = false;
        await this.runReloadCycle();
      }
    } finally {
      this.reloadRunning = false;
    }
  }

  /** 一次完整的重载决策：类型检查 → 判忙 → 重启（或排队/放弃） */
  private async runReloadCycle(): Promise<void> {
    const files = [...this.pendingBackend];
    this.pendingBackend.clear();
    if (files.length === 0) return;

    const reason = formatReloadReason(files);
    /* 文件集合指纹：忙时排队会反复回到这里，同集合就不重复跑 tsc（见 typecheckPassedKey 注释） */
    const key = [...files].sort().join('|');

    /* ① 类型检查门：不通过就**保持旧进程继续服务**。
       理由：重启一份编不过的代码，等于把「代码没生效」换成「服务起不来」，那更糟。 */
    if (this.typecheckPassedKey === key) {
      this.log(`文件集合与上次类型检查时一致（${reason}），复用上次结论，不重复跑类型检查`);
    } else {
      this.log(`检测到后端代码改动：${reason}`);
      const check = await this.runCommand(this.o.typecheckCmd, this.o.typecheckTimeoutMs);
      this.state.lastTypecheckAt = nowIso();
      if (check.code !== 0) {
        this.state.lastTypecheckError = summarizeError(check.output);
        this.typecheckPassedKey = null;
        this.persist();
        this.log(`类型检查未通过，**不重启**（继续用旧代码服务）：\n${this.state.lastTypecheckError}`);
        return;
      }
      this.typecheckPassedKey = key;
      this.state.lastTypecheckError = null;
      this.persist();
    }

    /* ② 忙时排队：不打断切片/投稿。文件列表留在 pendingBackend 里，等空闲后原样重跑。 */
    const snap = this.refreshBusy();
    const decision = decideReload({ typecheckOk: true, busy: snap.busy });
    if (decision === 'wait') {
      for (const f of files) this.pendingBackend.add(f);
      if (!this.state.pendingSince) this.state.pendingSince = nowIso();
      this.state.busy = true;
      this.persist();
      this.log(`服务正忙（${snap.reasons.join('/')}），重载排队等待空闲（改动：${reason}）`);
      this.scheduleBusyRetry();
      return;
    }

    /* ③ 真正重启 */
    await this.reloadNow(files, reason);
  }

  /**
   * 空闲后重试：**只判忙**，空闲了才回到完整决策。
   *
   * 为什么不直接调 `queueReload()` 每一轮都跑一遍：忙的时候（转写/切片/投稿）正是机器最忙的时候，
   * 而 `runReloadCycle` 会跑 `npm run typecheck`（真机 ≈5s）。每 5 秒一次 tsc 等于跟业务抢 CPU。
   * QA 实测 busy-poll=300ms 时等待 1.2s 就跑了 3 次 tsc。
   */
  private scheduleBusyRetry(): void {
    if (this.busyTimer) return;
    const tick = (): void => {
      this.busyTimer = null;
      if (this.stopping) return;
      if (this.pendingBackend.size === 0) return;
      if (this.reloadRunning) {
        /* 正有另一轮在做：等它结束后由 drainReload 接管 */
        this.busyTimer = setTimeout(tick, this.o.busyPollMs);
        this.busyTimer.unref?.();
        return;
      }
      if (this.refreshBusy().busy) {
        this.busyTimer = setTimeout(tick, this.o.busyPollMs);
        this.busyTimer.unref?.();
        return;
      }
      this.queueReload();
    };
    this.busyTimer = setTimeout(tick, this.o.busyPollMs);
    this.busyTimer.unref?.();
  }

  private async reloadNow(files: string[], reason: string): Promise<void> {
    this.log(`类型检查通过且当前空闲，开始重载（${reason}）…`);

    /* ★ 本次重载接管：作废待执行的崩溃重启。
       否则"崩溃自愈的 2s 定时器"会在新进程起来之后再拉一个 ⇒ 两个进程抢同一个端口，
       第二个 EADDRINUSE 退出并把 this.child 覆盖掉 ⇒ 健康的那个变孤儿（QA 复现的 bug）。 */
    this.clearTimer('crash');
    this.crashBackoffMs = 0;
    this.state.pendingSince = null;
    /* 重载期间由本方法负责"起不来怎么办"：exit 处理器不要再排崩溃重启（否则同一件事做两遍） */
    this.reloadActive = true;
    let ok = false;
    try {
      await this.stopChild('hot-reload');
      if (this.stopping) return;
      const pid = await this.spawnChild();
      if (pid === null) {
        this.log('重载后服务未能启动。');
        return;
      }

      /* spawn 成功 ≠ 服务起来了：等它真的应答 /api/bootstrap，
         起不来就不许记"重载完成"（面板不能谎报"最近一次重载 刚刚"而页面其实连不上）。 */
      const child = this.child;
      this.log(`服务已拉起（pid=${pid}），等待就绪…`);
      const r = child ? await this.waitReady(child) : { ready: false, answered: false, elapsedMs: 0 };
      if (!r.ready) {
        this.log(`重载失败：新进程 ${r.elapsedMs}ms 内未就绪/已退出（不更新「最近一次重载」）。`);
        return;
      }

      this.typecheckPassedKey = null;
      this.state.lastReloadAt = nowIso();
      this.state.lastReloadReason = reason;
      this.state.busy = false;
      this.state.reloads += 1;
      this.persist();
      ok = true;
      const howReady = r.answered ? `已应答 /api/bootstrap，就绪耗时 ${r.elapsedMs}ms` : '进程存活（本次启动没有 Web UI）';
      this.log(`重载完成（新 pid=${pid}，${howReady}，累计第 ${this.state.reloads} 次）。未完成的场次由启动恢复续跑。`);
    } finally {
      /* 失败分支也要收尾：起不来时交给崩溃退避。
         此刻 exit 处理器已被 reloadActive 挡住，必须在这里显式排一次，否则进程死了就再没人拉起。 */
      this.reloadActive = false;
      if (!this.stopping && !ok) this.scheduleCrashRestart('重载后服务未就绪');
    }
  }

  /* ---------------------------- 忙闲 ---------------------------- */

  /**
   * 刷新台账忙碌状态。
   * 用 mtime 短路：ledger.json 可能有几 MB，5 秒解析一次纯属浪费；
   * 台账每次落盘都会换 mtime，所以「mtime 没变 ⇒ 内容没变」是安全假设。
   */
  refreshBusy(): BusySnapshot {
    let mtimeMs = -1;
    try {
      mtimeMs = fs.statSync(this.o.ledgerPath).mtimeMs;
    } catch {
      /* 台账还不存在（首次启动）：按空闲处理 */
      mtimeMs = -1;
    }
    if (mtimeMs === this.ledgerMtimeMs && mtimeMs !== -1) return this.lastBusy;
    this.ledgerMtimeMs = mtimeMs;
    let snap: BusySnapshot = { busy: false, reasons: [], taskCount: 0 };
    if (mtimeMs !== -1) {
      try {
        snap = computeBusy(readJson<unknown>(this.o.ledgerPath));
      } catch (e) {
        /* 台账正在被另一个进程原子替换时可能读失败：当作空闲，别把重载永久卡住 */
        this.log(`读取台账失败（按空闲处理）：${(e as Error).message}`);
      }
    }
    this.lastBusy = snap;
    if (this.state.busy !== snap.busy) {
      this.state.busy = snap.busy;
      this.persist();
    }
    return snap;
  }

  /* ---------------------------- 命令执行 ---------------------------- */

  /** 跑一条 shell 命令（npm 脚本/自定义命令），带超时；绝不抛 */
  private runCommand(command: string, timeoutMs: number): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
      let output = '';
      const cap = (d: Buffer | string): void => {
        output += d.toString();
        if (output.length > 40_000) output = output.slice(-40_000);
      };
      let child: ChildProcess;
      try {
        child = spawn(command, {
          cwd: this.o.rootDir,
          shell: true,
          env: { ...process.env, NO_COLOR: '1' },
        });
      } catch (e) {
        resolve({ code: -1, output: (e as Error).message });
        return;
      }
      child.stdout?.on('data', cap);
      child.stderr?.on('data', cap);
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        output += `\n（命令超时 ${timeoutMs}ms，已强制结束）`;
      }, Math.max(1000, timeoutMs));
      const done = (code: number): void => {
        clearTimeout(timer);
        resolve({ code, output });
      };
      child.on('error', (e) => {
        output += `\n${e.message}`;
        done(-1);
      });
      child.on('close', (code) => done(code ?? -1));
    });
  }
}

/* ============================================================================
 * 四、命令行入口
 * ========================================================================== */

/** 解析 `node src/hot-watch.ts` 的参数（解析逻辑单独抽出，便于排查"参数没生效"） */
export function parseWatchArgs(argv: readonly string[]): { options: HotWatchOptions; help: boolean } {
  const options: HotWatchOptions = {};
  const childArgs: string[] = [];
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string | undefined => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return undefined;
      i++;
      return v;
    };
    switch (a) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--port': {
        const v = next();
        if (v !== undefined) options.port = Number(v);
        break;
      }
      case '--root': {
        const v = next();
        if (v !== undefined) options.rootDir = v;
        break;
      }
      case '--entry': {
        const v = next();
        if (v !== undefined) options.entry = v;
        break;
      }
      case '--state': {
        const v = next();
        if (v !== undefined) options.statePath = v;
        break;
      }
      case '--log': {
        const v = next();
        if (v !== undefined) options.logPath = v;
        break;
      }
      case '--ledger': {
        const v = next();
        if (v !== undefined) options.ledgerPath = v;
        break;
      }
      case '--typecheck': {
        const v = next();
        if (v !== undefined) options.typecheckCmd = v;
        break;
      }
      case '--build-ui': {
        const v = next();
        if (v !== undefined) options.uiBuildCmd = v;
        break;
      }
      case '--debounce': {
        const v = next();
        if (v !== undefined) options.debounceMs = Number(v);
        break;
      }
      case '--busy-poll': {
        const v = next();
        if (v !== undefined) options.busyPollMs = Number(v);
        break;
      }
      case '--graceful-ms': {
        const v = next();
        if (v !== undefined) options.gracefulStopMs = Number(v);
        break;
      }
      case '--term-ms': {
        const v = next();
        if (v !== undefined) options.termTimeoutMs = Number(v);
        break;
      }
      case '--ready-timeout': {
        const v = next();
        if (v !== undefined) options.readyTimeoutMs = Number(v);
        break;
      }
      case '--ready-grace': {
        const v = next();
        if (v !== undefined) options.readyGraceMs = Number(v);
        break;
      }
      case '--child-arg': {
        /* 透传参数**本身**就可能是 `--dry-run` 这种以 -- 开头的开关，
           所以这里不能走 next()（它会因为"-- 开头"判定为没有值直接跳过）。 */
        const v = argv[i + 1];
        if (v !== undefined) {
          i++;
          childArgs.push(v);
        }
        break;
      }
      default:
        break;
    }
  }
  if (childArgs.length > 0) options.childArgs = childArgs;
  return { options, help };
}

const WATCH_HELP = `代码热更新监督进程

用法：
  node src/hot-watch.ts [--port 3000] [--child-arg --dry-run]…

做什么：
  · 监听 src/**/*.ts，保存后先跑 npm run typecheck，通过且*当前空闲*时自动重启服务；
  · 监听 web/src/**，保存后自动跑 npm run build:ui（不重启服务，刷新浏览器即可）；
  · 子进程异常退出会自动拉起（2s→5s→10s→30s 退避）。

参数：
  --port <n>          服务端口（默认 3000）
  --root <dir>        项目根（默认本仓库）
  --entry <file>      服务入口（默认 src/cli.ts）
  --typecheck <cmd>   类型检查命令（默认 "npm run typecheck"）
  --build-ui <cmd>    前端构建命令（默认 "npm run build:ui"）
  --debounce <ms>     文件变化去抖（默认 1200）
  --busy-poll <ms>    等待空闲的轮询间隔（默认 5000）
  --ready-timeout <ms>  等新进程应答 /api/bootstrap 的上限（默认 60000）
  --ready-grace <ms>    一直无应答但进程存活多久后判定"本次没有 Web UI"（默认 6000）
  --state <path>      状态文件（默认 data/hot-watch-state.json）
  --log <path>        日志文件（默认 data/logs/hot-watch.log）
  --ledger <path>     台账路径（默认 data/ledger.json，用于判忙）
  --child-arg <arg>   透传给服务子进程的参数（可重复，如 --child-arg --allow-paid）
  -h, --help          显示本帮助
`;

/**
 * 给监督进程挂"全局异常兜底"：**记录日志（含栈）后继续运行**，绝不让监督层因此退出。
 *
 * 为什么必须有（2026-10-24 QA + team-lead 都点名）：`drainReload()` / `drainUiBuild()` 是
 * fire-and-forget（`void this.drainX()`），链里任何一处抛出都会变成 unhandledRejection；
 * Node 默认行为是**退出进程**，而本进程的 exit 钩子会顺手把服务子进程也杀掉 ——
 * 用户看到的是"改个代码，整个服务没了"，而这恰恰是本功能要避免的事。
 *
 * 返回一个 disposer（测试用：挂完→制造异常→断言仍存活→摘掉，别影响其它用例）。
 */
export function attachCrashGuards(watcher: HotWatcher): () => void {
  const onException = (e: unknown): void => watcher.noteInternalError('uncaughtException', e);
  const onRejection = (r: unknown): void => watcher.noteInternalError('unhandledRejection', r);
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
  };
}

/** 判断本文件是否被直接执行（被 import 时不能自动跑 main） */
function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const selfPath = fileURLToPath(import.meta.url);
  const a = path.resolve(argv1);
  const b = path.resolve(selfPath);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function main(): Promise<void> {
  const { options, help } = parseWatchArgs(process.argv.slice(2));
  if (help) {
    console.log(WATCH_HELP);
    return;
  }
  const watcher = new HotWatcher(options);
  /* 全局兜底：让"监督进程永远在"这句话成立（见 attachCrashGuards 的注释）。
     只记录、不退出 —— 服务子进程照常跑，下一次文件变化仍会重试。 */
  attachCrashGuards(watcher);
  const shutdown = async (sig: string): Promise<void> => {
    await watcher.stop(sig);
    /* ★ 这里**不调用** `process.exit()`：本进程会用 `fetch` 探测 `/api/bootstrap`，
       而 "fetch 还在关闭连接 + process.exit()" 在 Windows 上会触发 libuv fail-fast
       （`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，退出码 0xC0000409 ——
       本仓库 §102.2 记过同一个坑：脚本打印完全绿却"崩"了）。
       改成"设退出码 + 自然退出"：stop() 已经关掉 watcher、清掉定时器、收掉子进程，
       只剩 undici 的空闲连接（默认 4s 释放）；再留一个 unref 的 8s 兜底。 */
    process.exitCode = 0;
    const hardExit = setTimeout(() => process.exit(0), 8000);
    hardExit.unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await watcher.start();
  /* 常驻：不主动退出，靠信号/子进程事件驱动 */
}

if (isMain()) {
  main().catch((e) => {
    console.error(`[hot-watch] 启动失败：${(e as Error).message}`);
    if ((e as Error).stack) console.error((e as Error).stack);
    process.exit(1);
  });
}
