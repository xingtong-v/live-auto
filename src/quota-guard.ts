/**
 * 账号受限检测（quota guard）
 *
 * ============================================================================
 * 为什么需要它（2026-10-21/22 线上事实）
 * ============================================================================
 * B站 的「投稿过于频繁，请稍后再试」并不总是"等 30 分钟就好"：
 *   · 10-21 一天投了 70 个切片后，账号进入**账号级限制**；
 *   · 到 10-22 已经「今日已提交 0 个」，B站 仍然拒绝（19:57 实测）；
 *   · 期间用户反复点「重新投稿」，每一次都在给账号继续扣分，且我们照旧发告警、照旧写错误报告。
 *
 * 单靠"本轮停手"（{@link Publisher} 里的 quota 分支）只能止血一轮，**跨批次**仍然会反复撞。
 * 所以这里做一个**跨进程、跨批次**的持久化闸门：
 *   · 24 小时内累计 **2 次**配额拒绝 ⇒ 判定账号受限，暂停投稿直到「今天 24:00」；
 *   · 暂停期间 `publishClips` 直接早退（0 次提交、不写错误报告、不发"投稿失败"），
 *     并把原因/解除时间带进结果与 UI；
 *   · 用户确认 B站 恢复后，可手动解除（不清空历史计数，只清 blockedUntil）。
 *
 * 为什么落在**台账同目录**：生产用它自己的 data 目录，测试传临时台账目录就自动隔离
 * （与 `Publisher.batchLog()` 同一套思路，避免"跑测试写坏生产状态"的老坑）。
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from './logger.ts';

/** 24 小时内多少次配额拒绝判定为「账号受限」 */
export const QUOTA_BLOCK_THRESHOLD = 2;
/** 判定的滑动窗口 */
export const QUOTA_BLOCK_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 距离午夜不足这么多时，改用"现在 + 6 小时"，避免刚封就在几分钟后自动解封 */
export const QUOTA_BLOCK_MIN_MS = 2 * 60 * 60 * 1000;
/** 近距离封禁的兜底时长 */
export const QUOTA_BLOCK_FALLBACK_MS = 6 * 60 * 60 * 1000;

export interface QuotaGuardFile {
  /** 最近 24h 内每次配额拒绝的时间（ISO） */
  rejections: string[];
  /** 暂停投稿到什么时候（ISO）；缺省/过期 = 未受限 */
  blockedUntil?: string;
  /** 最近一次拒绝的原始错误（便于 UI 显示 B站 原话） */
  lastMessage?: string;
  /** 手动解除的时刻与来源（留痕，便于排查"谁放的"） */
  clearedAt?: string;
}

export interface QuotaGuardStatus {
  /** 现在是否处于"账号受限、暂停投稿"状态 */
  blocked: boolean;
  /** 解除时间（ISO），未受限时 undefined */
  until?: string;
  /** 24h 内配额拒绝次数 */
  rejections: number;
  /** 最近一次 B站 原话 */
  message?: string;
  /** 给人看的一句话（UI 直接显示） */
  note: string;
}

/** 只用到这两条，取 Logger 的真实签名（避免自造 unknown 型，导致真 Logger 反而不兼容） */
type GuardLogger = Pick<Logger, 'warn' | 'info'>;

export class QuotaGuard {
  private readonly file: string;
  private readonly now: () => number;
  private readonly log?: GuardLogger;

  constructor(opts: { path: string; now?: () => number; logger?: GuardLogger }) {
    this.file = opts.path;
    this.now = opts.now ?? (() => Date.now());
    if (opts.logger) this.log = opts.logger;
  }

  /** 台账同目录下的 quota-block.json */
  static pathFor(ledgerPath: string): string {
    return path.join(path.dirname(ledgerPath), 'quota-block.json');
  }

  read(): QuotaGuardFile {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const j = JSON.parse(raw) as QuotaGuardFile;
      return {
        rejections: Array.isArray(j.rejections) ? j.rejections.filter((x) => typeof x === 'string') : [],
        ...(typeof j.blockedUntil === 'string' ? { blockedUntil: j.blockedUntil } : {}),
        ...(typeof j.lastMessage === 'string' ? { lastMessage: j.lastMessage } : {}),
        ...(typeof j.clearedAt === 'string' ? { clearedAt: j.clearedAt } : {}),
      };
    } catch {
      return { rejections: [] };
    }
  }

  private write(state: QuotaGuardFile): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** 只保留窗口内的拒绝记录 */
  private prune(rejections: string[], nowMs: number): string[] {
    return rejections.filter((iso) => {
      const t = Date.parse(iso);
      return Number.isFinite(t) && nowMs - t <= QUOTA_BLOCK_WINDOW_MS;
    });
  }

  status(): QuotaGuardStatus {
    const nowMs = this.now();
    const st = this.read();
    const rejections = this.prune(st.rejections, nowMs);
    const untilMs = st.blockedUntil ? Date.parse(st.blockedUntil) : NaN;
    const blocked = Number.isFinite(untilMs) && untilMs > nowMs;
    const until = blocked ? new Date(untilMs).toISOString() : undefined;
    return {
      blocked,
      ...(until ? { until } : {}),
      rejections: rejections.length,
      ...(st.lastMessage ? { message: st.lastMessage } : {}),
      note: blocked
        ? `账号受限：B站 连续拒绝投稿（24 小时内 ${rejections.length} 次），已暂停投稿至 ${fmtLocalTime(untilMs)}。确认恢复后可手动解除。`
        : rejections.length > 0
          ? `近 24 小时有 ${rejections.length} 次 B站 配额拒绝（未达受限阈值 ${QUOTA_BLOCK_THRESHOLD} 次）`
          : '未检测到账号受限',
    };
  }

  /**
   * 记录一次配额拒绝；达到阈值则进入"暂停投稿"。
   * 返回本次调用之后的状态（调用方据此决定日志与结果字段）。
   */
  recordRejection(message: string): QuotaGuardStatus {
    const nowMs = this.now();
    const st = this.read();
    const rejections = [...this.prune(st.rejections, nowMs), new Date(nowMs).toISOString()];
    const next: QuotaGuardFile = { rejections, lastMessage: message.slice(0, 300) };
    if (rejections.length >= QUOTA_BLOCK_THRESHOLD) {
      const untilMs = nextBlockUntil(nowMs);
      next.blockedUntil = new Date(untilMs).toISOString();
      if (st.blockedUntil !== next.blockedUntil) {
        this.log?.warn(
          `账号受限：24 小时内已 ${rejections.length} 次被 B站 拒绝投稿 ⇒ 暂停投稿至 ${fmtLocalTime(untilMs)}（期间不再尝试，避免继续扣分）`,
          { mod: 'quota-guard', data: { until: next.blockedUntil } },
        );
      }
    }
    this.write(next);
    return this.status();
  }

  /** 手动解除（用户确认 B站 已恢复）。保留拒绝计数，避免解除后又立刻被判受限。 */
  clear(reason = 'manual'): QuotaGuardStatus {
    const st = this.read();
    this.write({ ...st, blockedUntil: undefined, clearedAt: new Date(this.now()).toISOString() });
    this.log?.info(`账号受限已手动解除（${reason}）—— 保留 24h 内 ${st.rejections.length} 次拒绝记录作为参考`, {
      mod: 'quota-guard',
    });
    return this.status();
  }
}

/** 默认解除时刻：下一个本地 0 点；不足 2 小时则用 现在+6h */
export function nextBlockUntil(nowMs: number): number {
  const d = new Date(nowMs);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
  if (midnight - nowMs < QUOTA_BLOCK_MIN_MS) return nowMs + QUOTA_BLOCK_FALLBACK_MS;
  return midnight;
}

function fmtLocalTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
