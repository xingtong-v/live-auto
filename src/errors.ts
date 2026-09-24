/**
 * 错误报告与复查（任务书 §8 WP6 步骤 10）。
 *
 * 目标：事后**无需复现**即可定位问题。为此一条报告要一次性带齐：
 *   - 上下文：任务 / 场次 / 失败阶段 / 时间 / 自研服务版本 / biliLive-tools 版本
 *   - 错误本体：类型 / 消息 / 堆栈 / cause
 *   - 请求上下文：接口 / 脱敏参数 / HTTP 状态 / 截断后的响应体（含原始长度）
 *   - 重试历史：第几次 / 历次失败原因 / 是否已升级模型
 *   - biliLive-tools 侧日志片段：切片、压制失败的真正原因在对方进程里（§4.6 getLogContent）
 *   - 环境快照：磁盘剩余 / 状态机位置 / ledger 条目 / Node 与平台
 *   - timeline：面向人工的时间线（步骤 → 错误 → 重试）
 *
 * 两条硬性约束（任务书 §8 WP6 步骤 10）：
 *  1) **同步写盘**：appendErrorEvent / writeErrorReport 全程走 appendFileSync 与
 *     writeFileSync。进程 OOM、被 kill、掉电时异步写流里缓冲的最后一条会丢，
 *     而「最后一条」恰恰是最需要的那条。
 *  2) **零凭据泄漏**：所有文本先过 redact()/redactText()，再经本模块的强化清洗
 *     scrubText（redact.ts 的 Authorization 规则是 `$1$2<REDACTED>`，原值仍留在
 *     文本里，必须再抹一次），写盘前还要过一次凭据形态扫描，命中就把该字段整体
 *     替换为 `[扫描后已移除]` 并记一条 warning（硬约束 #8 / 陷阱 #33）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BiliLiveClient } from './api.ts';
import type { EnvSnapshot, ErrorReport, ErrorType, RequestContext, RetryAttempt, TaskErrorBrief } from './types.ts';
import { redact, redactText } from './redact.ts';
import { log as globalLog, type Logger } from './logger.ts';
import {
  ERROR_REPORT_DIR,
  ERRORS_PATH,
  ROOT_DIR,
  appendJsonl,
  fmtBytes,
  fmtLocal,
  nowIso,
  readJson,
  readJsonl,
  safeFileName,
  truncate,
  writeJsonAtomic,
} from './util.ts';

/* ============================================================================
 * 对外类型
 * ========================================================================== */

/** 全局错误事件（写入 errors.jsonl 的一行，轻量、可 grep） */
export interface ErrorEvent {
  reportId: string;
  at: string;
  taskId?: string;
  stage: string;
  type: ErrorType;
  message: string;
  /** 调用的接口（若有） */
  endpoint?: string;
  httpStatus?: number;
  retries: number;
  /** 完整报告的相对路径 */
  reportPath: string;
}

/** 错误报告构建器的入参 */
export interface ErrorReportInput {
  taskId?: string;
  taskTitle?: string;
  stage: string;
  error: unknown;
  /** 覆盖错误类型（不传则自动判定） */
  type?: ErrorType;
  request?: RequestContext;
  retries?: RetryAttempt[];
  /** 当前状态机位置的描述 */
  taskStatus?: string;
  ledgerEntries?: unknown;
  /** 传入 client 时自动抓取：biliLive-tools 版本 + 其日志末尾片段 + 磁盘剩余 */
  client?: BiliLiveClient;
  /** 覆盖环境快照里的字段 */
  extraEnv?: Partial<EnvSnapshot>;
  appVersion?: string;
}

/** 完整的报告三元组（报告 / 落盘路径 / 台账摘要） */
export interface ErrorReportResult {
  report: ErrorReport;
  reportPath: string;
  brief: TaskErrorBrief;
}

/* ============================================================================
 * 常量
 * ========================================================================== */

/** 响应体截断阈值：与 api.ts 的 RequestContext 约定一致（4KB） */
const RESPONSE_BODY_MAX = 4096;

/** biliLive-tools 侧日志默认取末尾 200 行：真因通常在最后几行 */
const TOOLS_LOG_TAIL_LINES = 200;
const TOOLS_LOG_TAIL_MAX_CHARS = 64 * 1024;

/** 运行时错误类型清单：既做 duck-typing 判定，也保证与 types.ts 的联合类型同步 */
const ERROR_TYPES: readonly ErrorType[] = [
  'network',
  'http-status',
  'timeout',
  'contract',
  'file-missing',
  'llm-unavailable',
  'asr-failed',
  'upload-failed',
  'disk',
  'auth',
  'config',
  'internal',
];

/** 自研服务版本：显式入参 > 环境变量 > package.json */
const PACKAGE_VERSION: string = (() => {
  try {
    const raw = fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8');
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === 'string' && v ? v : '0.0.0';
  } catch {
    // 读不到版本号不影响报告生成，退化为占位值
    return '0.0.0';
  }
})();

function isErrorType(v: unknown): v is ErrorType {
  return typeof v === 'string' && (ERROR_TYPES as readonly string[]).includes(v);
}

function resolveAppVersion(explicit?: string): string {
  if (explicit) return explicit;
  const fromEnv = process.env['LIVE_AUTO_VERSION'];
  return fromEnv && fromEnv ? fromEnv : PACKAGE_VERSION;
}

/* ============================================================================
 * 脱敏（redact.ts 之上的强化清洗）
 * ========================================================================== */

/**
 * 在 redactText 之后再抹一遍。
 *
 * 为什么必须再做一次：redact.ts 的 Authorization 规则替换结果是 `$1$2<REDACTED>`，
 * 即「保留了原值再追加标记」，`Authorization: my-secret-passkey` 会变成
 * `Authorization: my-secret-passkey<REDACTED>` —— 凭据仍在文本里。本模块不允许
 * 依赖外部模块的实现细节去赌安全，凡出站文本一律过这里。
 */
function scrubText(input: string): string {
  let out = redactText(String(input));
  // Authorization 头：无论后面跟什么都没收
  out = out.replace(/(authorization\s*[:=]\s*)([^\s"',;}\]]+)/gi, '$1***REDACTED***');
  // 常见「键: 值」形态
  out = out.replace(
    /(\b(?:passkey|pass_key|apikey|api_key|sendkey|send_key|bottoken|bot_token|access_token|refresh_token|secret|password|passwd|signature|credential)\b\s*[:=]\s*"?)([^"',;\s}\]]+)/gi,
    '$1***REDACTED***',
  );
  // Cookie 头整体（分号分隔的一长串）
  out = out.replace(/(cookie\s*[:=]\s*)([^\r\n]+)/gi, '$1***REDACTED***');
  // 已知密钥形态
  out = out.replace(/\bsk-[A-Za-z0-9_.\-]{6,}/g, 'sk-***REDACTED***');
  out = out.replace(/\bSCT[A-Za-z0-9]{6,}/g, 'SCT***REDACTED***');
  out = out.replace(/\bLTAI[A-Za-z0-9]{8,}/g, 'LTAI***REDACTED***');
  out = out.replace(/\b(SESSDATA|bili_jct|DedeUserID|sessionid)=([^;\s]+)/gi, '$1=***REDACTED***');
  // URL query 里的凭据（钉钉 sign / 通用 token）
  out = out.replace(/([?&](?:auth|passkey|pass_key|key|token|access_token|sign)=)([^&\s]+)/gi, '$1***REDACTED***');
  return out;
}

/** 深度脱敏：先走项目统一的 redact()，再对每个字符串做强化清洗 */
function scrub(value: unknown): unknown {
  const once = redact(value, { maxDepth: 6, maxArray: 30, maxString: 8192 });
  return mapStrings(once, scrubText);
}

function mapStrings(value: unknown, fn: (s: string) => string, depth = 0): unknown {
  if (typeof value === 'string') return fn(value);
  if (value === null || value === undefined) return value;
  if (depth > 8) return '[深度截断]';
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mapStrings(v, fn, depth + 1);
    return out;
  }
  return value;
}

/* ============================================================================
 * 凭据形态扫描自检（写盘前的最后一道闸）
 * ========================================================================== */

export interface CredentialShapeHit {
  /** 命中的字段路径，如 request.params.headers.Authorization */
  path: string;
  /** 命中的模式标签 */
  pattern: string;
}

/** 需要整体遮蔽的「键名即凭据」名单（精确匹配，避免误伤 author 之类） */
const STRONG_SECRET_KEYS =
  /^(?:pass_?key|api_?key|send_?key|bot_?token|access_?token|refresh_?token|secret|sign|password|passwd|authorization|cookie|sessdata|bili_jct|sessionid|credential|private_?key)$/i;

/** 值内联的密钥形态 */
const CREDENTIAL_SHAPES: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'openai-sk', re: /\bsk-[A-Za-z0-9_.\-]{6,}/ },
  { label: 'serverchan-sct', re: /\bSCT[A-Za-z0-9]{6,}/ },
  { label: 'aliyun-ltai', re: /\bLTAI[A-Za-z0-9]{8,}/ },
  { label: 'bili-cookie', re: /\b(?:SESSDATA|bili_jct|DedeUserID|sessionid)\s*=/i },
  { label: 'authorization-header', re: /\bauthorization\b\s*[:=]\s*(?!\*{3}|<REDACTED>|\[扫描后已移除\])\S+/i },
  {
    label: 'json-secret-field',
    re: /"(?:passkey|pass_key|apikey|api_key|sendkey|send_key|bottoken|bot_token|access_token|secret|password|passwd|signature|sign)"\s*:\s*"(?!\*{3}|<REDACTED>|\[扫描后已移除\])[^"]+"/i,
  },
  { label: 'url-token', re: /[?&](?:access_token|token|auth|passkey|pass_key|key|sign)=[^&\s]{6,}/i },
  { label: 'bearer-or-basic', re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/ },
];

/** 已掩码的痕迹：命中这些说明已经处理过，不再重复报 */
const MASK_MARK = /\*\*\*|<REDACTED>|\[扫描后已移除\]|\[深度截断\]/;

function looksMasked(s: string): boolean {
  return MASK_MARK.test(s);
}

/**
 * 凭据形态扫描：返回命中的字段路径与模式标签（**不回传命中内容**，避免二次泄漏）。
 * 导出是为了让单测与 CI 能审计历史报告文件。
 */
export function scanCredentialShapes(value: unknown): CredentialShapeHit[] {
  const hits: CredentialShapeHit[] = [];
  walkScan(value, '', hits, 0);
  return hits;
}

function walkScan(value: unknown, at: string, hits: CredentialShapeHit[], depth: number): void {
  if (depth > 10 || hits.length > 50) return;
  if (typeof value === 'string') {
    if (looksMasked(value)) return;
    for (const { label, re } of CREDENTIAL_SHAPES) {
      if (re.test(value)) hits.push({ path: at || '$', pattern: label });
    }
    return;
  }
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkScan(v, `${at}[${i}]`, hits, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const here = at ? `${at}.${k}` : k;
      if (STRONG_SECRET_KEYS.test(k) && typeof v === 'string' && v.length >= 6 && !looksMasked(v)) {
        hits.push({ path: here, pattern: 'secret-key-name' });
        continue;
      }
      walkScan(v, here, hits, depth + 1);
    }
  }
}

/**
 * 凭据形态自检 + 字段级清除：命中就把该字段整体替换为 `[扫描后已移除]`。
 * 返回新对象（不改入参），并给出命中清单供调用方记 warning。
 */
export function neutralizeCredentialShapes<T>(value: T): { value: T; hits: CredentialShapeHit[] } {
  const hits: CredentialShapeHit[] = [];
  const clean = walkNeutralize(value, '', hits, 0);
  return { value: clean as T, hits };
}

function walkNeutralize(value: unknown, at: string, hits: CredentialShapeHit[], depth: number): unknown {
  if (typeof value === 'string') {
    if (looksMasked(value)) return value;
    for (const { label, re } of CREDENTIAL_SHAPES) {
      if (re.test(value)) {
        hits.push({ path: at || '$', pattern: label });
        return '[扫描后已移除]';
      }
    }
    return value;
  }
  if (value === null || value === undefined || depth > 10) return value;
  if (Array.isArray(value)) return value.map((v, i) => walkNeutralize(v, `${at}[${i}]`, hits, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const here = at ? `${at}.${k}` : k;
      if (STRONG_SECRET_KEYS.test(k) && typeof v === 'string' && v.length >= 6 && !looksMasked(v)) {
        hits.push({ path: here, pattern: 'secret-key-name' });
        out[k] = '[扫描后已移除]';
        continue;
      }
      out[k] = walkNeutralize(v, here, hits, depth + 1);
    }
    return out;
  }
  return value;
}

/* ============================================================================
 * 请求上下文与错误判定
 * ========================================================================== */

/** 构造请求上下文（自动 >4KB 截断并记录原始长度，硬性要求） */
export function makeRequestContext(input: {
  method: string;
  url: string;
  params?: unknown;
  status?: number;
  body?: string;
  durationMs?: number;
}): RequestContext {
  const ctx: RequestContext = {
    method: String(input.method || 'GET').toUpperCase(),
    url: scrubText(String(input.url ?? '')),
  };
  if (input.params !== undefined) ctx.params = scrub(input.params);
  if (typeof input.status === 'number') ctx.status = input.status;
  if (typeof input.durationMs === 'number') ctx.durationMs = input.durationMs;
  if (input.body !== undefined && input.body !== null) {
    const raw = String(input.body);
    // 先按**原始长度**截断再脱敏：util.truncate 会把原始长度写进正文标注，
    // 若先脱敏，标注里的数字会变成清洗后的长度（脱敏会改变字符数），误导复查者
    const t = truncate(raw, RESPONSE_BODY_MAX);
    ctx.responseBody = scrubText(t.text);
    ctx.responseTruncated = t.truncated;
    ctx.responseOriginalLength = t.originalLength;
  }
  return ctx;
}

/** 复用已有 RequestContext 时重新过一遍脱敏与截断（ApiError.request 走这条路） */
function sanitizeRequestContext(raw: RequestContext): RequestContext {
  const out: RequestContext = {
    method: String(raw.method ?? 'GET').toUpperCase(),
    url: scrubText(String(raw.url ?? '')),
  };
  if (raw.params !== undefined) out.params = scrub(raw.params);
  if (typeof raw.status === 'number') out.status = raw.status;
  if (typeof raw.durationMs === 'number') out.durationMs = raw.durationMs;
  if (typeof raw.responseBody === 'string') {
    const bodyLen = raw.responseBody.length;
    const declared = typeof raw.responseOriginalLength === 'number' ? raw.responseOriginalLength : 0;
    const originalLength = declared > bodyLen ? declared : bodyLen;
    if (raw.responseTruncated === true || declared > bodyLen) {
      // 已经是「截断 + 标注」形态（api.ts / makeRequestContext 的产物）：只脱敏不再截，
      // 否则二次截断会把标注里的原始长度改写成当前长度，复查时看不到真正的响应体大小
      out.responseBody = scrubText(raw.responseBody);
      out.responseTruncated = true;
      out.responseOriginalLength = originalLength;
    } else {
      const t = truncate(raw.responseBody, RESPONSE_BODY_MAX);
      out.responseBody = scrubText(t.text);
      out.responseTruncated = t.truncated;
      out.responseOriginalLength = t.originalLength;
    }
  }
  return out;
}

/**
 * 判定规则表：越具体的判据越靠前，避免「网络」这种大口袋吃掉真正的原因。
 * 刻意**不扫堆栈**：堆栈里全是文件路径，本项目路径含 "deepseek"，会把任意异常
 * 误判成 llm-unavailable（自测实测踩到过）；同理拒绝裸词（not found / 模型 / deepseek）。
 */
const CLASSIFY_RULES: ReadonlyArray<{ type: ErrorType; re: RegExp }> = [
  { type: 'disk', re: /enospc|no space left|disk full|quota exceeded|磁盘(?:空间)?(?:不足|满)|空间不足/ },
  { type: 'file-missing', re: /enoent|no such file|file not found|cannot find the (?:file|path)|文件不存在|找不到(?:该)?文件|路径不存在/ },
  { type: 'auth', re: /eacces|eperm|unauthorized|forbidden|invalid token|鉴权|认证失败|登录(?:已)?失效|passkey|\b40[13]\b/ },
  { type: 'timeout', re: /etimedout|timed?\s?out|timeout|超时|abort(?:ed|error)?/ },
  { type: 'contract', re: /契约|contract|schema|zod|未返回 taskid|返回结构异常|字段缺失|校验失败|不合法/ },
  {
    type: 'llm-unavailable',
    re: /\bllm\b|chat\/completions|api\.deepseek\.com|deepseek-(?:chat|reasoner|coder)|api\.openai\.com|\bopenai\b|dashscope|api[_ ]key|模型(?:不可用|调用失败|返回异常|连续失败|输出)/,
  },
  { type: 'asr-failed', re: /\basr\b|subtitle|转写|whisper|语音识别/ },
  { type: 'upload-failed', re: /upload|投稿|稿件/ },
  { type: 'http-status', re: /http\s*[1-5]\d\d|status(?:\s*code)?\s*[:=]?\s*[1-5]\d\d|bad gateway|internal server error/ },
  { type: 'network', re: /econnrefused|econnreset|enotfound|eai_again|epipe|network|fetch failed|socket hang up|连接被拒绝|网络/ },
  { type: 'config', re: /config|配置/ },
];

/**
 * 从任意异常判定错误类型（含文件不存在、磁盘、鉴权、超时、契约）。
 */
export function classifyError(e: unknown, fallback: ErrorType = 'internal'): ErrorType {
  // 1) 自带类型（api.ts 的 ApiError 等）优先：它掌握着 HTTP 状态与上下文
  if (e && typeof e === 'object') {
    const t = (e as { type?: unknown }).type;
    if (isErrorType(t)) return t;
  }

  // 2) 从 code / errno / name / message 里找线索（不含 stack，见规则表注释）
  const chunks: string[] = [];
  if (typeof e === 'string') chunks.push(e);
  else if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    for (const k of ['code', 'errno', 'name', 'message']) {
      const v = o[k];
      if (typeof v === 'string' || typeof v === 'number') chunks.push(String(v));
    }
  } else if (typeof e === 'number' || typeof e === 'boolean') {
    chunks.push(String(e));
  }
  const text = chunks.join(' | ');
  if (!text.trim()) return fallback;
  const t = text.toLowerCase();

  // 主动取消不算故障，也不该被 timeout 规则吃掉（否则「取消」会伪装成超时告警）
  if (/请求被取消|cancell?ed|aborted by user/.test(t)) return 'internal';

  for (const rule of CLASSIFY_RULES) {
    if (rule.re.test(t)) return rule.type;
  }
  return fallback;
}

/** 错误本体 → 报告字段（消息、堆栈、cause 全部脱敏） */
function describeError(e: unknown): { message: string; stack?: string; cause?: string } {
  if (e === null || e === undefined) return { message: '未知错误（error 为空）' };
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    const head = `${e.name}: ${e.message}`.trim();
    const message = code !== undefined && !head.includes(String(code)) ? `${head} (code=${String(code)})` : head;
    const out: { message: string; stack?: string; cause?: string } = { message: truncate(scrubText(message), 2000).text };
    if (e.stack) out.stack = truncate(scrubText(e.stack), 8000).text;
    const cause = (e as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== null) out.cause = describeCause(cause);
    return out;
  }
  if (typeof e === 'string') return { message: truncate(scrubText(e), 4000).text };
  if (typeof e === 'object') {
    let json: string;
    try {
      json = JSON.stringify(scrub(e));
    } catch {
      json = '[无法序列化]';
    }
    return { message: truncate(json, 4000).text };
  }
  return { message: String(e) };
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return truncate(scrubText(`${cause.name}: ${cause.message}`), 2000).text;
  if (typeof cause === 'string') return truncate(scrubText(cause), 2000).text;
  try {
    return truncate(JSON.stringify(scrub(cause)), 2000).text;
  } catch {
    return '[cause 无法序列化]';
  }
}

/** 从 ApiError 之类的异常里接管重试历史，调用方不必重复传 */
function extractAttempts(e: unknown): RetryAttempt[] {
  if (!e || typeof e !== 'object') return [];
  const raw = (e as { attempts?: unknown }).attempts;
  if (!Array.isArray(raw)) return [];
  return raw.map((item, i) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const attemptNum = Number(o['attempt']);
    const out: RetryAttempt = {
      attempt: Number.isFinite(attemptNum) && attemptNum > 0 ? attemptNum : i + 1,
      at: typeof o['at'] === 'string' && o['at'] ? o['at'] : nowIso(),
      type: isErrorType(o['type']) ? o['type'] : 'internal',
      message: truncate(scrubText(String(o['message'] ?? '')), 1000).text,
    };
    if (typeof o['model'] === 'string' && o['model']) out.model = o['model'];
    return out;
  });
}

/** 从 ApiError 之类的异常里接管请求上下文 */
function extractRequest(e: unknown): RequestContext | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const raw = (e as { request?: unknown }).request;
  if (!raw || typeof raw !== 'object') return undefined;
  return sanitizeRequestContext(raw as RequestContext);
}

/* ============================================================================
 * 环境快照
 * ========================================================================== */

/**
 * 错误报告目录。默认 `data/error-report`，可被 `setErrorReportDir()` 覆盖 ——
 * 端到端测试必须能把报告写到临时目录，否则会污染真实运行的数据。
 */
let reportDirOverride: string | undefined;

/** 覆盖错误报告目录（端到端测试 / 多实例隔离用） */
export function setErrorReportDir(dir: string | undefined): void {
  reportDirOverride = dir;
}

/** 当前生效的错误报告目录 */
export function getErrorReportDir(): string {
  return reportDirOverride ?? ERROR_REPORT_DIR;
}

/**
 * 全局错误事件流文件（`data/errors.jsonl`）。理由同 `setErrorReportDir`：
 *
 * ⚠️ 实测教训（2026-09-23）：这个路径原本是**模块级常量、不可覆盖**，
 * 而端到端测试的 `dataDirOverride` 管不到它 ⇒ 测试产生的错误被写进**真实**的
 * `data/errors.jsonl`。后果是健康面板的「近 24h 错误」严重失真：
 * 实测 83 条里有 **67 条来自内建测试**、7 条来自 UI e2e，真实生产错误只有 9 条。
 * 指标一旦失真，基于它的告警与判断全都不可信 —— 所以隔离不是洁癖，是正确性。
 */
let errorsPathOverride: string | undefined;

/** 覆盖错误事件流路径（端到端测试 / 多实例隔离用） */
export function setErrorsPath(p: string | undefined): void {
  errorsPathOverride = p;
}

/** 当前生效的错误事件流路径 */
export function getErrorsPath(): string {
  return errorsPathOverride ?? ERRORS_PATH;
}

/** 磁盘剩余：报告要回答「是不是磁盘满了」，所以必须带绝对数值而不是只写一句提示 */
function diskInfo(): { freeBytes: number; totalBytes: number } | undefined {
  for (const dir of [getErrorReportDir(), path.join(ROOT_DIR, 'data'), ROOT_DIR, process.cwd()]) {
    try {
      const st = fs.statfsSync(dir);
      const bsize = Number(st.bsize);
      const freeBytes = Number(st.bavail) * bsize;
      const totalBytes = Number(st.blocks) * bsize;
      if (Number.isFinite(freeBytes) && freeBytes >= 0 && totalBytes > 0) return { freeBytes, totalBytes };
    } catch {
      /* 目录还不存在或不支持 statfs，换下一个候选 */
    }
  }
  return undefined;
}

function buildEnvSnapshot(
  input: ErrorReportInput,
  report: { stage: string; request?: RequestContext },
): EnvSnapshot {
  const env: EnvSnapshot = {
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    cwd: process.cwd(),
    appVersion: resolveAppVersion(input.appVersion),
    stage: report.stage,
  };
  if (input.taskStatus) env.taskStatus = input.taskStatus;
  const disk = diskInfo();
  if (disk) {
    env.diskFreeBytes = disk.freeBytes;
    env.diskFreeGB = Number((disk.freeBytes / 1024 ** 3).toFixed(2));
    env.diskTotalGB = Number((disk.totalBytes / 1024 ** 3).toFixed(2));
  }
  const cachedVersion = input.client?.cachedVersion;
  if (cachedVersion) env.bililiveToolsVersion = cachedVersion;
  if (input.ledgerEntries !== undefined) env.ledgerEntries = scrub(input.ledgerEntries) as unknown;
  if (input.extraEnv) {
    // extraEnv 显式覆盖：例如调用方已自行 await 过 getLogContent，可直接内联日志片段
    for (const [k, v] of Object.entries(input.extraEnv)) {
      if (v === undefined) continue;
      (env as Record<string, unknown>)[k] = k === 'ledgerEntries' ? (scrub(v) as unknown) : mapStrings(v, scrubText);
    }
  }
  return env;
}

/* ============================================================================
 * timeline
 * ========================================================================== */

type TimelineStep = ErrorReport['timeline'][number];

/**
 * 生成人读时间线：把 retries 展开成「第 N 次尝试失败（原因）+ 模型」，
 * 最后一条是最终失败；若末次请求其实返回了 2xx，则补一条「接口成功但流程失败」，
 * 明确告诉复查者「问题不在 HTTP 层」。
 */
function buildTimeline(report: {
  stage: string;
  at: string;
  error: { message: string; stack?: string; cause?: string };
  request?: RequestContext;
  retries: RetryAttempt[];
}): TimelineStep[] {
  const out: TimelineStep[] = [];
  const endMs = Date.parse(report.at);
  const stamps = report.retries.map((r) => Date.parse(r.at));

  report.retries.forEach((r, i) => {
    const start = stamps[i];
    const next = i + 1 < report.retries.length ? stamps[i + 1] : endMs;
    const step: TimelineStep = { at: r.at, step: `第 ${r.attempt} 次尝试失败`, ok: false, detail: r.message };
    if (r.model) step.model = r.model;
    if (start !== undefined && next !== undefined && Number.isFinite(start) && Number.isFinite(next) && next >= start) {
      step.elapsedMs = next - start;
    }
    out.push(step);
  });

  const status = report.request?.status;
  if (report.request && typeof status === 'number' && status >= 200 && status < 300) {
    out.push({
      at: report.at,
      step: `接口已成功（HTTP ${status}），失败发生在后续处理`,
      ok: true,
      detail: describeErrorRequest(report.request),
    });
  }

  const attemptNo = report.retries.length + 1;
  const finalStep: TimelineStep = {
    at: report.at,
    step: report.retries.length > 0 ? `第 ${attemptNo} 次尝试最终失败（阶段 ${report.stage}）` : `阶段 ${report.stage} 首次尝试即失败`,
    ok: false,
    detail: `${report.error.message}${describeErrorRequest(report.request)}`,
  };
  const lastModel = report.retries.length > 0 ? report.retries[report.retries.length - 1]?.model : undefined;
  if (lastModel) finalStep.model = lastModel;
  const lastStamp = stamps.length > 0 ? stamps[stamps.length - 1] : undefined;
  if (lastStamp !== undefined && Number.isFinite(lastStamp) && Number.isFinite(endMs) && endMs >= lastStamp) {
    finalStep.elapsedMs = endMs - lastStamp;
  }
  out.push(finalStep);
  return out;
}

function describeErrorRequest(request: RequestContext | undefined): string {
  if (!request) return '';
  const status = typeof request.status === 'number' ? ` → HTTP ${request.status}` : '';
  const ms = typeof request.durationMs === 'number' ? `（${request.durationMs}ms）` : '';
  return ` @ ${request.method} ${request.url}${status}${ms}`;
}

/* ============================================================================
 * 报告落盘
 * ========================================================================== */

/**
 * 写报告：errors.jsonl（同步写盘，保证崩溃前最后一条不丢）+ error-report/<时间戳>-<taskId>.json（完整报告）。
 *
 * 顺序上「先写事件行、再写完整报告」：事件行只有几百字节、写成功概率最高，
 * 磁盘写满时它是唯一还能落盘的东西；完整报告失败只降级记一条 error，绝不抛异常。
 * 传入 client 时会在写盘后**异步**补一次 biliLive-tools 侧日志片段（getLogContent 是
 * async，而本函数必须同步返回，崩溃安全优先）。
 */
export function writeErrorReport(input: ErrorReportInput): ErrorReportResult {
  const at = nowIso();
  const stage = input.stage && input.stage.trim() ? input.stage.trim() : 'unknown';
  const taskId = input.taskId && input.taskId.trim() ? input.taskId.trim() : undefined;
  const errorBody = describeError(input.error);
  const type = input.type ?? classifyError(input.error, 'internal');
  const retries = (input.retries ?? extractAttempts(input.error)).map((r) => ({ ...r }));
  const request = input.request ? sanitizeRequestContext(input.request) : extractRequest(input.error);

  const reportId = `${at.replace(/[:.]/g, '-')}-${taskId ? safeFileName(taskId, 60) : 'global'}`;
  const reportPath = reportPathOf(reportId);
  const env = buildEnvSnapshot(input, { stage, ...(request ? { request } : {}) });

  const draft: ErrorReport = {
    reportId,
    stage,
    at,
    appVersion: resolveAppVersion(input.appVersion),
    error: { type, ...errorBody },
    retries,
    env,
    timeline: [],
  };
  if (taskId) draft.taskId = taskId;
  if (input.taskTitle) draft.taskTitle = input.taskTitle;
  if (request) draft.request = request;
  if (env.bililiveToolsVersion) draft.bililiveToolsVersion = env.bililiveToolsVersion;
  draft.timeline = buildTimeline({ stage, at, error: draft.error, retries, ...(request ? { request } : {}) });

  /*
   * 写盘前的凭据形态自检：即使上游某次改了 redact 的实现、或某条消息绕过了 scrub，
   * 这里也会把整字段替换成 `[扫描后已移除]` 并告警，绝不让凭据落盘（硬约束 #8）。
   */
  const gated = neutralizeCredentialShapes(draft);
  const report = gated.value;
  if (gated.hits.length > 0) {
    globalLog.warn('错误报告命中凭据形态扫描，相关字段已整体移除', {
      data: { reportId, hits: gated.hits.slice(0, 10) },
    });
  }

  const brief: TaskErrorBrief = {
    reportId,
    stage,
    type,
    message: truncate(report.error.message, 500).text,
    at,
    retries: retries.length,
  };

  const event: ErrorEvent = {
    reportId,
    at,
    stage,
    type,
    message: truncate(report.error.message.replace(/\s+/g, ' '), 300).text,
    retries: retries.length,
    reportPath,
  };
  if (taskId) event.taskId = taskId;
  if (request) {
    event.endpoint = request.url;
    if (typeof request.status === 'number') event.httpStatus = request.status;
  }

  // ① 全局事件行：同步追加，进程立刻崩溃也不丢
  appendErrorEvent(event);

  // ② 完整报告：写失败只降级，不抛
  try {
    writeJsonAtomic(reportPath, report, 2);
  } catch (e) {
    globalLog.error(`错误报告写盘失败，已降级为仅写 errors.jsonl：${reportPath}`, e, {
      data: { reportId, taskId, stage, type },
    });
  }

  // ③ 异步补充：对方侧日志片段 / 版本号（写盘后再补写一次报告文件）
  if (input.client) {
    void enrichWithToolsLog(input.client, reportPath, report, globalLog);
  }

  return { report, reportPath, brief };
}

/** 仅追加一行全局错误事件（同步写盘） */
export function appendErrorEvent(ev: ErrorEvent): void {
  try {
    // appendJsonl 内部用 fs.appendFileSync：诊断写入绝不能拖垮业务，失败只记一条 error
    appendJsonl(getErrorsPath(), ev);
  } catch (e) {
    globalLog.error(`写入全局错误事件流失败：${getErrorsPath()}`, e, { data: { reportId: ev.reportId } });
  }
}

/**
 * 补写 biliLive-tools 侧日志末尾片段与版本号。
 *
 * 为什么放在写盘之后：getLogContent 是 async，而 writeErrorReport 必须同步返回
 * （崩溃安全）。报告先落地保证「一定有一份」，再补写把「对方侧真因」加上。
 * 注意：报告的 env 会被就地更新，调用方若仍持有 report 引用可读到补充后的值。
 */
async function enrichWithToolsLog(
  client: BiliLiveClient,
  reportPath: string,
  report: ErrorReport,
  logger: Logger,
): Promise<void> {
  try {
    let changed = false;
    const raw = await client.getLogContent(512 * 1024);
    if (raw && raw.trim()) {
      report.env.biliLiveToolsLogTail = truncate(
        scrubText(tailLines(raw, TOOLS_LOG_TAIL_LINES)),
        TOOLS_LOG_TAIL_MAX_CHARS,
      ).text;
      changed = true;
    }
    if (!report.env.bililiveToolsVersion) {
      try {
        // client 没缓存版本号时补一次（失败无所谓，报告里留空即可）
        const v = await client.version();
        if (v) {
          report.env.bililiveToolsVersion = v;
          report.bililiveToolsVersion = v;
          changed = true;
        }
      } catch {
        /* 版本号拿不到不影响报告可用性 */
      }
    } else if (!report.bililiveToolsVersion) {
      report.bililiveToolsVersion = report.env.bililiveToolsVersion;
      changed = true;
    }
    if (!changed) return;
    // 二次落盘走原子写：补写过程中被 kill 也不会留下半截 JSON
    writeJsonAtomic(reportPath, report, 2);
    logger.debug('错误报告已补充 biliLive-tools 侧日志片段', {
      data: { reportId: report.reportId, tailChars: report.env.biliLiveToolsLogTail?.length ?? 0 },
    });
  } catch (e) {
    logger.warn('补充 biliLive-tools 侧日志片段失败（报告主体已在盘上）', {
      data: { reportId: report.reportId, error: e instanceof Error ? e.message : String(e) },
    });
  }
}

/** 取末尾 N 行（日志真因在最后，取头没有意义） */
function tailLines(text: string, lines: number): string {
  const all = text.split(/\r?\n/);
  return (all.length > lines ? all.slice(all.length - lines) : all).join('\n');
}

/* ============================================================================
 * 读取与查询
 * ========================================================================== */

/** 读全局错误事件流（支持按任务与时间过滤） */
export function readErrorEvents(opts: { taskId?: string; sinceMs?: number; limit?: number; type?: ErrorType } = {}): ErrorEvent[] {
  const sinceMs = opts.sinceMs;
  const taskId = opts.taskId;
  const type = opts.type;
  let out = readJsonl<ErrorEvent>(getErrorsPath()).filter((e) => e && typeof e.at === 'string');
  if (taskId) out = out.filter((e) => e.taskId === taskId);
  if (type) out = out.filter((e) => e.type === type);
  if (sinceMs !== undefined) {
    out = out.filter((e) => {
      const t = Date.parse(e.at);
      return Number.isFinite(t) && t >= sinceMs;
    });
  }
  // limit 取「最近 N 条」，返回时保持时间升序（便于直接打印）
  if (opts.limit && opts.limit > 0) out = out.slice(-opts.limit);
  return out;
}

/** 近 N 小时错误数（健康面板用） */
export function errorCountLastHours(hours: number, now: number = Date.now()): number {
  const since = now - Math.max(0, hours) * 3600_000;
  return readErrorEvents({ sinceMs: since }).length;
}

/** reportId → 报告文件绝对路径（只允许安全字符，防目录穿越） */
export function reportPathOf(reportId: string): string {
  const safe = String(reportId)
    .replace(/\.json$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '_');
  return path.join(getErrorReportDir(), `${safe}.json`);
}

/** 载入某任务的完整报告（CLI --inspect 与 UI「查看日志」用） */
export function loadErrorReport(reportId: string): ErrorReport | undefined {
  try {
    const raw = readJson<ErrorReport>(reportPathOf(reportId));
    if (!raw || typeof raw !== 'object') return undefined;
    return raw;
  } catch {
    // 报告不存在 / 半截文件：返回 undefined，由调用方给出「报告不存在」的结论
    return undefined;
  }
}

/**
 * 列出报告 id（新的在前，可直接传给 loadErrorReport / reportPathOf）。
 * 传入 taskId 时按 `<时间戳>-<taskId>.json` 的命名约定过滤。
 */
export function listErrorReports(taskId?: string): string[] {
  try {
    const suffix = taskId ? `-${safeFileName(taskId, 60)}.json` : '.json';
    return fs
      .readdirSync(getErrorReportDir())
      .filter((f) => f.endsWith(suffix) && !f.endsWith('.tmp'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/* ============================================================================
 * 人读渲染
 * ========================================================================== */

/**
 * 把报告渲染成**人读的时间线**（步骤 → 错误 → 重试），用于 UI「查看日志」与一键复制。
 * 输出是轻量 Markdown / 纯文本，且最后再整体过一遍 scrubText，保证复制出去也不含凭据。
 */
export function renderErrorTimeline(report: ErrorReport): string {
  const lines: string[] = [];
  const atMs = Date.parse(report.at);
  const toolsVersion = report.bililiveToolsVersion ?? report.env.bililiveToolsVersion;
  const where = report.env.taskStatus ?? report.env.stage;

  lines.push(`# 错误报告 ${report.reportId}`);
  lines.push('');
  lines.push(`- 时间：${fmtLocal(Number.isFinite(atMs) ? atMs : new Date())}（本地） / ${report.at}`);
  if (report.taskId) lines.push(`- 任务：${report.taskId}${report.taskTitle ? ` 《${report.taskTitle}》` : ''}`);
  lines.push(`- 失败阶段：${report.stage}${where ? `（状态机位置：${where}）` : ''}`);
  lines.push(`- 错误类型：${report.error.type}`);
  lines.push(`- 错误消息：${report.error.message}`);
  lines.push(`- 版本：live_auto ${report.appVersion}${toolsVersion ? ` / biliLive-tools ${toolsVersion}` : ' / biliLive-tools 版本未知'}`);
  lines.push(`- 报告文件：${reportPathOf(report.reportId)}`);

  lines.push('');
  lines.push(`## 时间线（步骤 → 错误 → 重试，共 ${report.timeline.length} 步）`);
  lines.push('');
  if (report.timeline.length === 0) {
    lines.push('（无记录：未捕获到步骤明细）');
  }
  report.timeline.forEach((s, i) => {
    const t = Date.parse(s.at);
    const clock = Number.isFinite(t) ? fmtLocal(t).slice(11) : s.at;
    const model = s.model ? `  模型=${s.model}` : '';
    const elapsed = typeof s.elapsedMs === 'number' ? `  间隔=${(s.elapsedMs / 1000).toFixed(1)}s` : '';
    lines.push(`${i + 1}. [${clock}] ${s.ok ? '✓' : '✗'} ${s.step}${model}${elapsed}`);
    if (s.detail) lines.push(`   原因：${s.detail}`);
  });

  lines.push('');
  lines.push('## 请求上下文');
  lines.push('');
  if (report.request) {
    const r = report.request;
    lines.push(`- ${r.method} ${r.url}${typeof r.status === 'number' ? ` → HTTP ${r.status}` : ''}${typeof r.durationMs === 'number' ? `（${r.durationMs}ms）` : ''}`);
    if (r.params !== undefined) lines.push(`- 参数（已脱敏）：${safeJson(r.params, 2000)}`);
    if (r.responseBody) {
      const note = r.responseTruncated ? `已截断，原始 ${r.responseOriginalLength ?? r.responseBody.length} 字符` : `完整 ${r.responseBody.length} 字符`;
      lines.push(`- 响应体（${note}）：`);
      lines.push('```');
      lines.push(r.responseBody);
      lines.push('```');
    }
  } else {
    lines.push('- （无请求上下文：失败不发生在 HTTP 调用上）');
  }

  lines.push('');
  lines.push('## 环境快照');
  lines.push('');
  if (typeof report.env.diskFreeGB === 'number') {
    const total = typeof report.env.diskTotalGB === 'number' ? ` / 总 ${report.env.diskTotalGB} GB` : '';
    const rawBytes = typeof report.env.diskFreeBytes === 'number' ? `（${fmtBytes(report.env.diskFreeBytes)}）` : '';
    lines.push(`- 磁盘剩余：${report.env.diskFreeGB} GB${total} ${rawBytes}`);
  }
  lines.push(`- Node：${report.env.nodeVersion ?? process.version}　平台：${report.env.platform ?? process.platform}`);
  lines.push(`- 工作目录：${report.env.cwd ?? process.cwd()}`);
  if (report.env.ledgerEntries !== undefined) {
    lines.push('- ledger 条目：');
    lines.push('```json');
    lines.push(safeJson(report.env.ledgerEntries, 2000));
    lines.push('```');
  }

  if (report.env.biliLiveToolsLogTail) {
    lines.push('');
    lines.push(`## biliLive-tools 侧日志末尾片段（切片 / 压制失败的真因在这里）`);
    lines.push('');
    lines.push('```');
    lines.push(tailLines(report.env.biliLiveToolsLogTail, 60));
    lines.push('```');
    lines.push('');
    lines.push('（完整片段见报告 JSON 的 env.biliLiveToolsLogTail）');
  }

  if (report.error.stack) {
    lines.push('');
    lines.push('## 堆栈');
    lines.push('');
    lines.push('```');
    lines.push(report.error.stack);
    lines.push('```');
  }
  if (report.error.cause) {
    lines.push('');
    lines.push(`## 底层原因（cause）`);
    lines.push('');
    lines.push(report.error.cause);
  }

  // 出站文本的最后一道闸：即使报告里混进了什么，复制出去也不含凭据
  return scrubText(lines.join('\n'));
}

function safeJson(value: unknown, max: number): string {
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return truncate(s ?? String(value), max).text;
  } catch {
    return '[无法序列化]';
  }
}
