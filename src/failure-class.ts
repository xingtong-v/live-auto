/**
 * 失败分级：哪些失败可以自动重试一次，哪些必须留给人（2026-10-13，优化清单 P1-5 后半）。
 *
 * 背景：现在任何失败都要人去点重跑，待办里一半条目是这类。但"无脑自动重试"更糟 ——
 * 内容类失败（标题违规、稿件锁定、额度用尽）重试一百次也不会成功，只会刷日志、还可能触发风控。
 * 所以先把**判据**固定成一个纯函数（可测、可 review），自动重试的接线再单独做。
 *
 * 设计原则（刻意保守）：
 *   1. **默认 manual**：认不出来的一律留给人 —— 自动重试的代价是"可能重复投稿"，比漏重试严重得多；
 *   2. 只有明确的"临时性"信号才判 retryable：网络/超时/连接被重置/5xx/429；
 *   3. 明确的"确定性"信号一律 manual：稿件锁定、审核、违规、额度、权限、登录态失效、内容非法；
 *   4. 判据表写在代码里（而不是散在 if 里），每条都带理由，便于以后按真实失败样本修订。
 *
 * ⚠️ 这个模块**不执行**任何重试，也不改台账 —— 只回答"该不该重试一次"。
 */

export type FailureKind = 'retryable' | 'manual';

export interface FailureInfo {
  /** 调用方已有的错误分类（本项目里形如 'internal' / 'upload-failed' / 'cut-failed' …） */
  type?: string;
  message?: string;
  /** 若失败来自 HTTP，带上状态码（有就按它判，最可靠） */
  httpStatus?: number;
}

export interface FailureVerdict {
  kind: FailureKind;
  /** 判定的依据（写进日志/台账，便于复盘"为什么没自动重试"） */
  why: string;
}

/** 明确的临时性信号（出现即判 retryable） */
const RETRYABLE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /超时|timeout|timed?\s?out/i, why: '超时（临时性）' },
  { re: /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|network|ENOTFOUND|EAI_AGAIN/i, why: '网络层错误（临时性）' },
  { re: /429|too many requests|频率|限流|rate.?limit/i, why: '被限流（等一会儿再试有意义）' },
  { re: /50[234]\b|bad gateway|service unavailable|gateway time-?out/i, why: '服务端 5xx（对端临时故障）' },
  { re: /biliLive-tools.*(未连接|连不上)|fetch failed/i, why: '本地依赖服务不可达（临时性）' },
];

/** 明确的确定性信号（出现即判 manual，优先于上面） */
const MANUAL_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /锁定|已被锁定|lock(ed)?/i, why: '稿件被锁定 —— 重试不会变，需要人处理' },
  { re: /审核|违规|敏感|退回|打回/i, why: '内容/审核问题 —— 重试无意义' },
  { re: /额度|上限|超出.*限制|quota|forbidden/i, why: '额度或权限问题 —— 重试无意义' },
  { re: /登录|cookie|未登录|token.*(失效|过期)|凭证/i, why: '登录态问题 —— 需要人重新登录' },
  { re: /标题|封面|分区|标签.*(非法|不合法)|tag.*invalid/i, why: '内容字段非法 —— 重试无意义' },
  { re: /不存在|已被删除|已删除|稿件不存在/i, why: '目标对象不存在 —— 重试无意义' },
  { re: /重复|已投稿|已存在/i, why: '疑似重复投稿 —— 绝不能自动重试' },
];

/** 判定一次失败该不该自动重试 */
export function classifyFailure(f: FailureInfo): FailureVerdict {
  /* ① HTTP 状态码最可靠，优先 */
  const http = f.httpStatus;
  if (typeof http === 'number') {
    if (http === 429 || (http >= 500 && http <= 599)) {
      return { kind: 'retryable', why: `HTTP ${http}（限流或对端临时故障）` };
    }
    if (http >= 400) {
      return { kind: 'manual', why: `HTTP ${http}（客户端错误，重试不会变）` };
    }
  }

  const text = `${f.type ?? ''} ${f.message ?? ''}`;

  /* ② 确定性信号优先于临时性信号（宁可漏重试，不可误重试） */
  for (const p of MANUAL_PATTERNS) {
    if (p.re.test(text)) return { kind: 'manual', why: p.why };
  }
  for (const p of RETRYABLE_PATTERNS) {
    if (p.re.test(text)) return { kind: 'retryable', why: p.why };
  }

  /* ③ 认不出来 ⇒ 留给人（保守默认；修订时请在下面这条 reason 的基础上加新规则，不要放开默认值） */
  return { kind: 'manual', why: '未识别的失败类型 —— 保守留给人工（自动重试的代价是可能重复投稿）' };
}

/**
 * 把「要不要自动重试」也变成纯函数 —— 循环里的内联条件无法单测，而这条判断的边界最要紧：
 * **已经发起过上传的失败绝不能重试**（会重复投稿）。抽出来之后，边界就有断言守着。
 */
export function shouldAutoRetry(input: {
  ok?: boolean;
  /** 注意：cutAndUploadClip 里 skipped 是"跳过原因"字符串（真值判断即可），不是布尔 */
  skipped?: boolean | string;
  errorType?: string;
  message?: string;
  /** 配置开关（publish.autoRetryOnce）；false = 整体关闭 */
  enabled?: boolean;
}): FailureVerdict & { retry: boolean } {
  if (input.ok || input.skipped) return { kind: 'manual', why: '本次没有失败', retry: false };
  if (input.enabled === false) return { kind: 'manual', why: '自动重试已关闭（publish.autoRetryOnce=false）', retry: false };
  if (input.errorType === 'upload-failed') {
    return { kind: 'manual', why: '失败发生在上传阶段 —— 重试可能产生重复分P，绝不自动重试', retry: false };
  }
  const v = classifyFailure({ type: input.errorType, message: input.message });
  return { ...v, retry: v.kind === 'retryable' };
}

/** 给日志/台账用的一句话 */
export function describeVerdict(v: FailureVerdict): string {
  return v.kind === 'retryable' ? `可自动重试一次（${v.why}）` : `留给人工（${v.why}）`;
}

/* ============================================================================
 * 投稿限流识别（B站「您投稿的频率过快，请稍等2秒」）—— 2026-10-17 线上事故
 * ==========================================================================*/

/**
 * ## 为什么需要这两个纯函数
 *
 * 2026-10-17 线上（任务 `auto-20261017112152-ap05`）：
 *   同一进程里两个任务并行投稿，两次提交只差几百毫秒，B站 直接回了
 *   `您投稿的频率过快，请稍等2秒` —— biliLive-tools 侧是 `BiliAddVideoTask.submit` 抛
 *   `BiliResponseError`，我们的 `cutAndUploadClip` 把它统一按 `upload-failed` 判死：
 *   台账 FAILED + 写错误报告，需要人工重投。
 *
 * 但这条错误的语义与「稿件被锁定/标题违规」**完全不同**：它是**提交被拒**
 * （B站 根本没创建稿件/分P），等两秒再交是**安全**的。
 * 所以判断依据必须落成纯函数（可单测、可 review），而不是散在 catch 里的 if。
 *
 * ⚠️ 这两个函数只回答「是不是限流」「它要求等几秒」，**不做任何重试** ——
 *   重试的编排（最多几次、每次等多久、续传场景要不要先反查是否已落地）在 publish.ts 的
 *   Publisher 里，因为只有那里知道"上一次提交有没有可能已经落地"。
 */

/** 解析不到「请稍等N秒」时的保守等待（秒）。宁可多等一下，也别立刻再撞一次限流。 */
export const RATE_LIMIT_DEFAULT_WAIT_SEC = 5;

/**
 * 「投稿提交被限流拒绝」的消息特征。
 *
 * 只收**平台明确说"太快了"**的措辞（现实样本就是中文那一句），
 * 刻意不做成 /频率|限流/ 这种宽口径：`classifyFailure` 里那种宽口径是用来"猜"的，
 * 而这里一旦误判，后果是**同一次投稿被提交两次**（可能多出一个分P）。
 * 所以只有明确措辞 + 明确的"稍等 N 秒"才允许进入重试。
 */
const UPLOAD_RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /投稿.{0,8}频率.{0,6}过快/, // 「您投稿的频率过快，请稍等2秒」（线上原话）
  /投稿.{0,8}(太|过)快/, // 「投稿速度太快」「投稿过快」
  /(操作|请求|提交).{0,6}(太|过)快/, // 「操作太快了，请稍后再试」
  /请稍等\s*\d+(?:\.\d+)?\s*秒/, // 明确带等待秒数
  /too\s?many\s?requests|rate.?limit/i, // 英文变体（biliLive-tools 透传时可能出现）
  /* ★ 2026-10-21 补充：配额级限流的措辞。它们**也是**限流（提交被拒、什么都没创建），
     所以「是不是限流」这一问的答案是 true；但「能不能原地等几秒重试」的答案**不是**，
     判据见 {@link isUploadQuotaLimited}。调用方必须先问 quota、再问 short ——
     顺序反了就会把配额限流当成秒级限流去连撞三次（这正是 10-21 事故的形态）。 */
  /过于频繁/, // 「投稿过于频繁，请稍后再试」（2026-10-21 线上原话）
  /(投稿|提交|发布).{0,10}频繁/, // 「投稿太频繁了」「提交频繁」
  /频率过快/, // 「操作频率过快」
];

/** 这条错误消息是不是「投稿被限流拒绝」（可等待后安全重试的临时拒绝） */
export function isUploadRateLimited(message: string | undefined | null): boolean {
  if (typeof message !== 'string' || message.length === 0) return false;
  return UPLOAD_RATE_LIMIT_PATTERNS.some((re) => re.test(message));
}

/** 「请稍等 N 秒」里的 N（秒）；解析不到返回 undefined，由调用方用保守默认值 */
const WAIT_SEC_PATTERN = /(?:请稍等|稍等|等待|wait)\s*(\d+(?:\.\d+)?)\s*(?:秒|s\b)/i;

export function parseRateLimitWaitSec(message: string | undefined | null): number | undefined {
  if (typeof message !== 'string' || message.length === 0) return undefined;
  const m = WAIT_SEC_PATTERN.exec(message);
  if (!m) return undefined;
  const sec = Number(m[1]);
  if (!Number.isFinite(sec) || sec <= 0) return undefined;
  return sec;
}

/* ============================================================================
 * 配额级限流（账号级投稿配额被打满）—— 2026-10-21 线上事故
 *
 * 事故：任务 `auto-20261021030839-l3ti` 的切片 #3 报
 *   `BiliResponseError: 投稿过于频繁，请稍后再试`
 * 注意它**没有秒数**。当时 `isUploadRateLimited` 只认「频率过快 / 请稍等N秒」这些措辞，
 * 于是这句话既不是"限流"也不是"可等待"，被当成**永久失败**：一分钟都不等就 FAILED，
 * 而同一批剩下的 3 片继续按 143 秒的间隔往上撞，一片不落全撞死（要人工逐片重投）。
 *
 * 两类限流的**恢复时间尺度**完全不同，必须分开判：
 *   · 秒级限流（`您投稿的频率过快，请稍等2秒`）—— 风控抖动，等对方给的秒数即可；
 *   · 配额级限流（`投稿过于频繁，请稍后再试`）—— 账号当日/当小时的投稿配额打满，
 *     **不可能在 10 秒内恢复**。原地重试 3 次只是把 3 次拒绝写在日志里，
 *     还会把"其实可以稍后重投"的切片写成 FAILED。
 *
 * 所以配额级一律 **fail-fast**：本轮立刻收手，切片留在 CANDIDATE（待投），
 * 由调用方告警并给出建议重试时间。
 * ==========================================================================*/

/** 配额级限流措辞（只有在**没有**明确秒数时才成立，见 {@link isUploadQuotaLimited}） */
const UPLOAD_QUOTA_LIMIT_PATTERNS: readonly RegExp[] = [
  /过于频繁/, // 「投稿过于频繁，请稍后再试」（2026-10-21 线上原话）
  /(投稿|提交|发布).{0,10}频繁/, // 「投稿太频繁了」「提交频繁」
  /频率过快/, // 「操作频率过快」
  /(投稿|提交).{0,10}稍后再试/, // 「投稿排队中，请稍后再试」这类没有秒数的软拒绝
];

/** 配额级限流命中后建议的等待时长（分钟）：给用户一个可执行的重试时间点 */
export const UPLOAD_QUOTA_RETRY_AFTER_MIN = 30;

/**
 * 这条错误消息是不是「账号级投稿配额被打满」。
 *
 * ★ 与 {@link isUploadRateLimited} 的关系：**先问它**。
 *   判据有两条且必须同时成立：
 *     ① 措辞命中配额级特征（过于频繁 / 频率过快 / 稍后再试 …）；
 *     ② 消息里**没有**明确的等待秒数 —— 有秒数就是对方告诉我们等多久，
 *        属于秒级限流，交给现有的短退避（`请稍等2秒` 这类**行为不变**）。
 *   第 ② 条是刻意写死的：`投稿过于频繁，请稍等2秒` 这种混合措辞必须走短退避，
 *   否则会因为一次误判把整批投稿停下来。
 */
export function isUploadQuotaLimited(message: string | undefined | null): boolean {
  if (typeof message !== 'string' || message.length === 0) return false;
  /* 有明确秒数 ⇒ 不是配额级（对方已经告诉我们等多久了） */
  if (parseRateLimitWaitSec(message) !== undefined) return false;
  return UPLOAD_QUOTA_LIMIT_PATTERNS.some((re) => re.test(message));
}

/** 提交被拒的限流类型：`none` 不是限流 / `short` 秒级（可原地短退避）/ `quota` 配额级（必须 fail-fast） */
export type SubmitLimitKind = 'none' | 'short' | 'quota';

/**
 * 把"提交被拒"的一句话归成三类，**顺序即语义**（quota 必须排在最前）。
 *
 * 单独抽成纯函数是为了让 publish.ts 的三个提交点（完整版 / 单切片 / 多分P 追加）
 * 用同一套判据，而不是各自写一个 if —— 10-21 事故就是因为只有一个地方"认得"限流，
 * 另一个地方把它当永久失败。
 */
export function classifySubmitLimit(message: string | undefined | null): SubmitLimitKind {
  if (typeof message !== 'string' || message.length === 0) return 'none';
  if (isUploadQuotaLimited(message)) return 'quota';
  if (isUploadRateLimited(message)) return 'short';
  return 'none';
}
