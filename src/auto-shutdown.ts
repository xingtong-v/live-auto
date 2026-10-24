/**
 * 「跑完自动关机」的**判定核心**（2026-10-14 用户需求：「做个定时开关，当开关打开时，
 * 所有的条件都满足时，关机」）。
 *
 * 为什么把判定单独抽成纯函数：**判错的代价是把机器关掉**，而关机可能正踩在
 * ① 直播还在录（分段写一半 → 那场录制废掉）、② biliLive-tools 正在烧弹幕版/上传分P
 * （掐掉就白跑几十分钟）、③ 我们的转写正在跑 这三种时刻上。
 * 纯函数的输入是"当前事实"，输出是"关 / 不关 + 为什么"，于是每条门槛都能被单测钉死，
 * 而不必拿真机器去试。
 *
 * 使用方式（daemon 侧）：
 *   1. 每分钟收集一次 `ShutdownConditions`（全是既有接口能拿到的事实）；
 *   2. 调 `decideShutdown(...)`；
 *   3. 说关 → 先发告警（复用 alerter）→ `shutdown /s /t <graceSeconds>`；
 *      `shutdown /a` 可取消（界面上给一个"取消关机"）。
 *
 * ⚠️ 开关默认**关**，且**只生效一次**：真关机前把开关复位，否则哪天白天跑完一场就给你关机。
 */
import { spawnSync } from 'node:child_process';

/** 判定所需的全部事实（缺一项就必须保守：宁可不关） */
export interface ShutdownConditions {
  /** 用户开关（配置或界面上的那个） */
  enabled: boolean;
  /** 流水线是否在跑（daemon.busy） */
  busy: boolean;
  /** 待处理队列长度 */
  queueLength: number;
  /** 本进程正在跑的本地转写数（ASR 子进程） */
  activeTranscriptions: number;
  /**
   * 「可能正在录制」的场次数（**多源归并后**的场次数，同一场只算 1 次）。
   *
   * 三个源互不覆盖（见 `src/recording-signals.ts` 的头注释）：
   *   · watcher 的 mp4 轮询候选项（`possiblyRecording` / `pendingParts`）；
   *   · 录制目录里**体积还在长的原始分段**（`.ts`，本次修复补上的那条）；
   *   · biliLive-tools 录制器自报 `state === 'recording'`。
   */
  recordingSessions: number;
  /**
   * 上面那个数字**是怎么来的**（只讲来源，例如「原始分段在写：…-PART007.ts」）。
   * 只用于把原因写清楚：用户看到"不关"必须能立刻知道是哪一场在录，否则只会以为功能坏了。
   * 刻意**不带场次数** —— reason 里已经写了「有 N 场可能正在录制（…）」，再带一遍就成了重复。
   */
  recordingDetail?: string;
  /** biliLive-tools 队列里在跑的任务数（压制/上传/下载） */
  llcQueueLength: number;
  /** 当前时刻 */
  now: Date;
}

export interface ShutdownPolicy {
  /** 条件连续满足多久才真的关机（分钟）—— 防"直播刚断线重连"的假空闲 */
  minIdleMinutes: number;
  /** 允许关机的时段（本地时间，HH:MM）；都不填 = 不限时段 */
  windowFrom?: string;
  windowTo?: string;
  /** 关机倒计时秒数（期间可 `shutdown /a` 取消） */
  graceSeconds: number;
}

export type ShutdownDecision =
  | { shutdown: false; reason: string }
  | { shutdown: true; reason: string; /** 冷静期起点（ISO），便于日志/界面显示还要等多久 */ idleSinceIso: string };

/** `HH:MM` → 当天的分钟数；非法输入返回 undefined */
export function parseHHMM(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return h * 60 + min;
}

/**
 * 当前时刻是否落在允许关机的时段内。
 * 支持**跨午夜**（如 22:00–08:00）：from > to 时视为跨天。
 * 两个端点都不配置 = 不限时段（返回 true）；只配一个 = 从该点起 / 到该点止。
 */
export function inShutdownWindow(now: Date, from?: string, to?: string): boolean {
  const f = parseHHMM(from);
  const t = parseHHMM(to);
  if (f === undefined && t === undefined) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (f !== undefined && t === undefined) return cur >= f;
  if (f === undefined && t !== undefined) return cur < t;
  return f! <= t! ? cur >= f! && cur < t! : cur >= f! || cur < t!;
}

/**
 * 判定：**六条门槛全部满足 + 冷静期已过 + 在时段内**才关机。
 * 任何一条不满足都返回 false 并给出人话原因（日志/界面直接用这句话）。
 */
export function decideShutdown(
  c: ShutdownConditions,
  p: ShutdownPolicy,
  /** 条件**连续**满足的起点（上次评估时若也满足，就沿用；否则由调用方重置为本次时刻） */
  idleSinceIso?: string,
): ShutdownDecision {
  if (!c.enabled) return { shutdown: false, reason: '自动关机开关未打开' };
  if (c.recordingSessions > 0) {
    /* 原因里带上来由（`recordingDetail`）：只写"有 1 场在录"用户没法核对是哪一场，
       而这一条正是"号码对不上就丢数据"的那条，必须让人一眼能查。 */
    return {
      shutdown: false,
      reason: `有 ${c.recordingSessions} 场可能正在录制${c.recordingDetail ? `（${c.recordingDetail}）` : ''} —— 关机可能写坏分段，绝不关`,
    };
  }
  if (c.busy || c.queueLength > 0) {
    return { shutdown: false, reason: `流水线还在忙（${c.busy ? '有任务在跑' : ''}${c.busy && c.queueLength ? '，' : ''}${c.queueLength ? `队列 ${c.queueLength} 个` : ''}）` };
  }
  if (c.activeTranscriptions > 0) {
    return { shutdown: false, reason: `还有 ${c.activeTranscriptions} 个本地转写在跑` };
  }
  if (c.llcQueueLength > 0) {
    return { shutdown: false, reason: `biliLive-tools 队列里还有 ${c.llcQueueLength} 个压制/上传任务` };
  }
  if (!inShutdownWindow(c.now, p.windowFrom, p.windowTo)) {
    return { shutdown: false, reason: `当前不在允许关机的时段（${p.windowFrom ?? '—'}–${p.windowTo ?? '—'}）` };
  }
  const since = idleSinceIso ? Date.parse(idleSinceIso) : c.now.getTime();
  const waitedMin = (c.now.getTime() - since) / 60000;
  if (waitedMin < p.minIdleMinutes) {
    return {
      shutdown: false,
      reason: `空闲 ${waitedMin.toFixed(1)} 分钟，未达冷静期 ${p.minIdleMinutes} 分钟（还剩 ${(p.minIdleMinutes - waitedMin).toFixed(1)} 分钟）`,
    };
  }
  return {
    shutdown: true,
    idleSinceIso: new Date(since).toISOString(),
    reason: `六条条件全部满足且已空闲 ${waitedMin.toFixed(1)} 分钟 → ${p.graceSeconds} 秒后关机（可取消）`,
  };
}

/** 真正的关机命令（Windows）。⚠️ 只用 `/s /t`，不用 `/f`：宁可失败也不要强杀进程丢数据。 */
export function shutdownCommand(graceSeconds: number): { cmd: string; args: string[] } {
  return { cmd: 'shutdown', args: ['/s', '/t', String(Math.max(0, Math.round(graceSeconds))), '/c', '切片助手：所有任务已完成，自动关机'] };
}

/** 取消关机（倒计时内有效） */
export function cancelShutdownCommand(): { cmd: string; args: string[] } {
  return { cmd: 'shutdown', args: ['/a'] };
}

/**
 * 执行关机 / 取消（同步、失败不抛）。
 * ⚠️ 用 `spawnSync` 而不是 exec：不需要读输出，也不该因为管道/编码问题节外生枝；
 *    失败时把 stderr 带回来，日志里能看见"为什么没关成"（例如被组策略禁用）。
 */
function run(cmd: string, args: string[]): { ok: boolean; error?: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
    if (r.error) return { ok: false, error: r.error.message };
    if (r.status !== 0) return { ok: false, error: `退出码 ${String(r.status)}：${String(r.stderr ?? '').trim().slice(0, 200)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function executeShutdown(graceSeconds: number): { ok: boolean; error?: string } {
  const { cmd, args } = shutdownCommand(graceSeconds);
  return run(cmd, args);
}

export function executeCancelShutdown(): { ok: boolean; error?: string } {
  const { cmd, args } = cancelShutdownCommand();
  return run(cmd, args);
}
