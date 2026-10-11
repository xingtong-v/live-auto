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
