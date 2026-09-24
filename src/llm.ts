/**
 * LLM 调用出口 —— 全项目唯一的文本生成通道（任务书 §5.3 / §5.4 / §5.5）。
 *
 * 为什么自研：
 *  - 任务书明确「没有可用的通用 LLM 文本生成接口」，总结与选片必须自己调模型；
 *  - 只依赖内置 fetch，走 OpenAI 兼容的 POST /chat/completions —— DeepSeek / 通义千问
 *    compatible-mode / 智谱 v4 / 本地 Ollama 都实现同一套协议，换供应商不用改代码；
 *  - 本模块**不做任何文件读写**：原始响应落盘（recordRawResponses）由调用方负责，
 *    「唯一出口」不应该顺带承担磁盘副作用。
 *
 * 两档模型（§5.3）：
 *  - summary：分块要点提炼 + 全局总结（调用多、求稳、可以便宜）；
 *  - select  ：选片 + 起标题（调用少、求质量，通常配更强的模型）。
 *  - select.model 为空时回落到 summary.model，但 baseUrl / apiKey 各自独立（允许跨供应商）。
 *
 * prompt 缓存前提（§5.4，DeepSeek context caching）：
 *  缓存按「请求前缀逐字节一致」命中，system 通常是最长且固定的前缀。
 *  因此约定：**system 必须由调用方保证同一场任务内完全相同**，分块内容 / 时间轴 / 转写
 *  一律拼进 user。本模块对 system 不做任何加工（不拼接、不 trim、不替换），原样塞进
 *  messages[0]；便于事后核对的是，日志与 RequestContext 只记录 system 的 hash 与字节数。
 *
 * 契约失败必须换模型重跑（§5.5）——本模块在 API 层提供的支撑：
 *  - chatJson 的解析/校验失败一律抛 `LlmError { type:'contract', retryable:false }`，
 *    且**不做任何重试**（重试改变不了模型的格式能力，只会浪费 token 和时间）；
 *  - `LlmError.model` 记录「这次是哪个模型失败的」，`LlmClient.modelOf(slot)` 给出各槽位的
 *    模型名，`LlmClient.isEscalationMeaningful()` 判断「换模型是否真的换了」；
 *    于是 analyze.ts 可以这样升级重跑：捕获 contract 错误 → 若 `err.model` 仍是原模型且
 *    `isEscalationMeaningful()` 为 true → 用另一个槽位的模型名调 `modelOverride` 再跑一次 →
 *    把 `clips.json.escalated / escalationNote` 落账。`RetryAttempt.model` 会记录每次尝试
 *    用的模型名，错误报告里能看出「升级前 / 升级后」分别是谁失败的。
 *
 * 脱敏（硬约束 #8 / 陷阱 #33）：Authorization 头与 apiKey 永不进日志；错误对象、日志字段、
 *  RequestContext.params 一律经 redact / redactText。
 */
import type { ZodType } from 'zod';
import type { AppConfig, LlmConfig, LlmEndpoint } from './config.ts';
import type { ErrorType, LlmUsage, ModelSlot, RequestContext, RetryAttempt } from './types.ts';
import { backoffMs, createLimiter, hashKey, nowIso, sleep, truncate } from './util.ts';
import { redact, redactText } from './redact.ts';
import { log as globalLog, type Logger } from './logger.ts';

/* ============================================================================
 * 常量
 * ========================================================================== */

/** 传输层总尝试次数（首发 + 2 次重试）。契约校验失败不在此列（见 §5.5 约定） */
const MAX_ATTEMPTS = 3;
/** 单次重试的最长等待：429 可能带很大的 Retry-After，不能把任务挂死 */
const MAX_RETRY_WAIT_MS = 30_000;
/** 端点未配置 timeoutMs 时的兜底 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 错误报告里保留的响应体长度（超出截断并记录原始长度） */
const RESPONSE_KEEP_CHARS = 4096;
/** 错误信息里保留的服务端细节长度 */
const DETAIL_KEEP_CHARS = 300;
/** probe 用的极小请求：够验证鉴权 + 模型可用 + 计费链路，几乎不花钱 */
const PROBE_SYSTEM = '你是连通性自检助手，只回复用户要求的内容，不要解释，不要多余字符。';
const PROBE_USER = '回复"ok"两个字符';
/** probe 的超时上限：UI 上的「测试」按钮不能让人等满 120s */
const PROBE_TIMEOUT_CAP_MS = 30_000;

type SlotPricing = AppConfig['llm']['pricing']['summary'];

const ZERO_PRICING: SlotPricing = { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 };

/* ============================================================================
 * 小工具（不导出，避免把实现细节变成公共 API）
 * ========================================================================== */

/** 只接受有限数字；字符串数字也认（部分网关把 usage 序列化成字符串） */
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** 正数毫秒，非法值回落 */
function positiveMs(v: unknown, fallback: number): number {
  const n = num(v);
  return n !== undefined && n > 0 ? n : fallback;
}

/** 正整数（max_tokens 之类），非法值回落 */
function positiveInt(v: unknown, fallback: number): number {
  const n = num(v);
  return n !== undefined && n > 0 ? Math.floor(n) : fallback;
}

/** 非空字符串；数字也转成字符串（部分是 code=40001 这类） */
function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** 本地回环端点：Ollama 这类本地推理服务不需要 API Key，不能因为没填 Key 就拒绝调用 */
function isLocalUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return ['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'].includes(host);
  } catch {
    return false;
  }
}

/** 拼 /chat/completions：允许用户把完整地址或漏写 /v1 的地址直接填进 baseUrl */
function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

/** 把 OpenAI 兼容响应里的 content 归一化成字符串（少数供应商会返回 content 分片数组） */
function normalizeContent(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const item of v) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      const rec = asRecord(item);
      const piece = rec ? (str(rec['text']) ?? str(rec['content'])) : undefined;
      if (piece) parts.push(piece);
    }
    const joined = parts.join('');
    return joined === '' ? undefined : joined;
  }
  return undefined;
}

/** 取服务端错误描述（各家字段名不同：error.message / message / error 字符串 / code） */
function extractApiMessage(bodyText: string): string {
  const raw = (bodyText ?? '').trim();
  if (raw === '') return '';
  try {
    const root = asRecord(JSON.parse(raw));
    if (root) {
      const err = root['error'];
      const errObj = asRecord(err);
      const msg =
        (typeof err === 'string' ? str(err) : undefined) ??
        (errObj ? (str(errObj['message']) ?? str(errObj['msg'])) : undefined) ??
        str(root['message']) ??
        str(root['msg']) ??
        str(root['error_msg']) ??
        str(root['error_description']) ??
        str(root['detail']);
      const code = errObj
        ? (str(errObj['code']) ?? str(errObj['type']))
        : (str(root['code']) ?? str(root['error_code']));
      const parts = [msg, code ? `code=${code}` : ''].filter((p): p is string => Boolean(p));
      if (parts.length > 0) return truncate(parts.join(' | '), DETAIL_KEEP_CHARS).text;
    }
  } catch {
    /* 非 JSON（网关 HTML、纯文本）→ 直接截原文 */
  }
  return truncate(raw.replace(/\s+/g, ' '), DETAIL_KEEP_CHARS).text;
}

/** 429 优先按 Retry-After 退避（秒），否则指数退避 + 抖动 */
function retryWaitMs(attempt: number, retryAfter: string | null): number {
  const sec = retryAfter === null ? undefined : num(retryAfter);
  if (sec !== undefined && sec > 0) return Math.min(MAX_RETRY_WAIT_MS, Math.round(sec * 1000));
  return backoffMs(attempt);
}

/* ============================================================================
 * 错误类型
 * ========================================================================== */

/** LLM 调用错误：带错误分类、是否可重试、已尝试的模型与失败历史 */
export class LlmError extends Error {
  override readonly name = 'LlmError';
  readonly type: ErrorType;
  readonly retryable: boolean;
  /** 已尝试的模型名（用于判断是否已经升级过） */
  readonly model: string;
  readonly request?: RequestContext;
  /** 已发生的重试记录（只记「确实重试过」的失败，最后一次失败即错误本身） */
  readonly attempts: RetryAttempt[];

  /**
   * opts 全部可选：调用方包装「非 LlmError 的异常」时常只拿到一句 message
   * （例如 analyze.ts 的 `new LlmError(String(e.message))`），此时退化为
   * internal / 不可重试 / model 为空 —— 字段依然齐全，错误报告不会缺列。
   */
  constructor(
    message: string,
    opts: {
      type?: ErrorType;
      retryable?: boolean;
      model?: string;
      request?: RequestContext;
      attempts?: RetryAttempt[];
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.type = opts.type ?? 'internal';
    this.retryable = opts.retryable ?? false;
    this.model = opts.model ?? '';
    if (opts.request) this.request = opts.request;
    this.attempts = opts.attempts ?? [];
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** 单次调用的结果 */
export interface LlmCallResult {
  text: string;
  usage: LlmUsage;
  /** 计算出的成本（元） */
  cost: number;
}

/** 供 UI「测试」按钮使用的可执行结论 */
export interface LlmProbeResult {
  ok: boolean;
  /** 人读结论，必须具体可执行，例如「401 无效的 API Key —— 请检查 Key 是否完整或该模型是否已开通」 */
  message: string;
  model: string;
  baseUrl: string;
  latencyMs?: number;
  /** 模型实际返回的一小段内容，用于确认连通 */
  sample?: string;
}

/* ============================================================================
 * usage 解析
 * ========================================================================== */

/**
 * 从 API 响应里解析 usage。
 * 兼容三种入参（完整响应 / {usage} / usage 自身）与两套字段名：
 *  - OpenAI 系：prompt_tokens / completion_tokens / total_tokens
 *  - DeepSeek 缓存：prompt_cache_hit_tokens（原生）与 prompt_tokens_details.cached_tokens
 * 计费口径以「请求的模型名」为准（服务端回显别名时不能让成本表错位），故 model 取入参。
 */
export function parseUsage(raw: unknown, model: string, durationMs: number): LlmUsage {
  const root = asRecord(raw);
  const usage = asRecord(root?.['usage']) ?? root ?? {};
  const details = asRecord(usage['prompt_tokens_details']) ?? asRecord(usage['input_tokens_details']);

  const promptTokens = Math.max(0, num(usage['prompt_tokens'] ?? usage['input_tokens'] ?? usage['promptTokens']) ?? 0);
  const completionTokens = Math.max(
    0,
    num(usage['completion_tokens'] ?? usage['output_tokens'] ?? usage['completionTokens']) ?? 0,
  );
  const totalTokens = Math.max(
    0,
    num(usage['total_tokens'] ?? usage['totalTokens']) ?? promptTokens + completionTokens,
  );

  const cachedRaw =
    (details ? num(details['cached_tokens'] ?? details['cachedTokens']) : undefined) ??
    num(
      usage['prompt_cache_hit_tokens'] ??
        usage['promptCacheHitTokens'] ??
        usage['cached_tokens'] ??
        usage['cachedPromptTokens'] ??
        usage['cache_read_input_tokens'],
    );

  const out: LlmUsage = { promptTokens, completionTokens, totalTokens, model, durationMs };
  // cached 不能超过输入总量，否则成本会算成负数
  if (cachedRaw !== undefined) out.cachedPromptTokens = Math.min(promptTokens, Math.max(0, cachedRaw));
  return out;
}

/* ============================================================================
 * JSON 提取
 * ========================================================================== */

/** 找到从 start 开始的第一个完整 JSON 值的结束位置（+1）；找不到返回 -1 */
function jsonValueEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * 从模型输出里剥出 JSON 文本。
 * 模型常见的包装噪声：```json 代码围栏、前后加一句「好的，以下是结果：」、结尾再补一段说明。
 * 这里先脱围栏，再按括号配平（跳过字符串内的括号与转义）截取**首个完整 JSON 值**。
 */
export function extractJsonText(text: string): string {
  let s = (text ?? '').replace(/^\uFEFF/, '').trim();

  if (s.includes('```')) {
    const fence = /```[ \t]*(?:json|jsonc|json5|javascript|js)?[ \t]*\r?\n?([\s\S]*?)(?:```|$)/i.exec(s);
    const inner = fence?.[1]?.trim();
    if (inner) s = inner;
  }

  const start = s.search(/[{[]/);
  if (start < 0) return s;
  const end = jsonValueEnd(s, start);
  return end > start ? s.slice(start, end) : s.slice(start);
}

/* ============================================================================
 * HTTP / 网络失败 → 可执行结论
 * ========================================================================== */

/**
 * 把 HTTP 状态与响应体翻译成**可执行结论**（UI 与错误报告都用它）。
 * status = 0 表示「没拿到 HTTP 响应」—— 网络层失败（ECONNREFUSED / DNS / 超时）也走这里，
 * 这样所有面向人的失败结论只有一个出口，措辞不会各处走样。
 */
export function explainHttpFailure(
  status: number,
  bodyText: string,
  model: string,
): { type: ErrorType; retryable: boolean; message: string } {
  const detail = redactText(extractApiMessage(bodyText));
  const tail = detail ? ` 服务端返回：${detail}` : '';

  /* ---- 无 HTTP 响应：网络层 ---- */
  if (status === 0) {
    const upper = bodyText.toUpperCase();
    if (/TIMEOUT|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ABORT/.test(upper)) {
      const ms = /TIMEOUT\((\d+)\)/.exec(bodyText)?.[1];
      return {
        type: 'timeout',
        retryable: true,
        message:
          `请求超时（${ms ? `${ms}ms` : '端点 timeoutMs'}）：${model} 未在规定时间内返回 —— 已按退避策略重试；` +
          `若持续超时，请调大对应槽位的 timeoutMs（llm.summary.timeoutMs / llm.select.timeoutMs，` +
          `本地 Ollama 首次加载模型建议 ≥ 300000），并确认单块转写内容没有过大`,
      };
    }
    if (/ENOTFOUND|EAI_AGAIN|GETADDRINFO|\bDNS\b/.test(upper)) {
      return {
        type: 'network',
        retryable: true,
        message:
          `域名解析失败：baseUrl 的主机名无法解析 —— 请检查 baseUrl 拼写与本机网络/代理；` +
          `若用本地服务，请把 baseUrl 改为 http://127.0.0.1:11434/v1（Ollama），并确认 Ollama 是否已启动（ollama serve）${tail}`,
      };
    }
    if (/ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR_SOCKET|SOCKET HANG UP/.test(upper)) {
      return {
        type: 'network',
        retryable: true,
        message:
          `连接被拒绝：目标端口没有服务在监听 —— 若 baseUrl 指向本机（Ollama / 本地推理服务），` +
          `请确认 Ollama 是否已启动（ollama serve 或桌面端已运行），并先用 curl <baseUrl>/models 验证；` +
          `远程端点请检查地址与端口是否正确、是否需要代理${tail}`,
      };
    }
    if (/CERT|SELF SIGNED|SELF_SIGNED|UNABLE_TO_VERIFY|TLS|SSL/.test(upper)) {
      return {
        type: 'network',
        retryable: false,
        message:
          `TLS 证书校验失败：${model} 所在端点的证书不被信任 —— 若走公司代理/自签证书，` +
          `请把根证书导入系统信任区或设置 NODE_EXTRA_CA_CERTS；本地服务可改用 http:// 地址${tail}`,
      };
    }
    return {
      type: 'network',
      retryable: true,
      message:
        `网络不可达：无法连接到 ${model} 所在的端点 —— 请检查本机网络与代理（HTTPS_PROXY/NO_PROXY）；` +
        `若 baseUrl 指向本机（Ollama），请确认 Ollama 是否已启动（ollama serve）${tail}`,
    };
  }

  /* ---- 鉴权 ---- */
  if (status === 401 || status === 403) {
    return {
      type: 'auth',
      retryable: false,
      message:
        `鉴权失败（HTTP ${status}）：API Key 无效或该模型未开通 —— 请检查：` +
        `(1) config.json 的 llm.summary.apiKey / llm.select.apiKey 是否完整（DeepSeek 形如 sk-…，` +
        `不要带 Bearer 前缀、不要有多余空格或引号）；` +
        `(2) baseUrl 与 Key 是否属于同一供应商（跨供应商用 Key 必然 401）；` +
        `(3) 控制台确认模型「${model}」已开通且账号未欠费${tail}`,
    };
  }

  /* ---- 余额 ---- */
  if (status === 402) {
    return {
      type: 'llm-unavailable',
      retryable: false,
      message: `账户余额不足或已欠费（HTTP 402）：${model} 无法继续调用 —— 请到供应商控制台充值后重跑本场分析${tail}`,
    };
  }

  /* ---- 路径 / 模型名 ---- */
  if (status === 404) {
    const ollamaMissing = /try pulling|not found,\s*try/i.test(detail);
    return {
      type: 'http-status',
      retryable: false,
      message: ollamaMissing
        ? `模型未拉取（HTTP 404）：本机 Ollama 上没有「${model}」—— 请先执行 ollama pull ${model}，再点「测试」${tail}`
        : `模型名或接口路径错误（HTTP 404）：找不到模型「${model}」或 /chat/completions 路径 —— 请检查：` +
          `(1) 模型名拼写与控制台可用模型列表（如 deepseek-chat / qwen-plus / glm-4-plus）；` +
          `(2) baseUrl 是否少了或多写了 /v1（正确形如 https://api.deepseek.com/v1，程序会自动补 /chat/completions）；` +
          `(3) 本地 Ollama 需先 ollama pull ${model}${tail}`,
    };
  }
  if (status === 405 || status === 501) {
    return {
      type: 'http-status',
      retryable: false,
      message: `端点不支持该请求（HTTP ${status}）：baseUrl 可能指向了非 OpenAI 兼容地址 —— 请改成形如 https://<host>/v1 的地址${tail}`,
    };
  }

  /* ---- 限流 / 配额 ---- */
  if (status === 429) {
    return {
      type: 'http-status',
      retryable: true,
      message:
        `触发限流或配额上限（HTTP 429）：${model} 请求过于密集 —— 已按 Retry-After / 指数退避自动重试；` +
        `若持续 429，请把 llm.chunkConcurrency 降到 1，或换 Key / 提升配额${tail}`,
    };
  }

  /* ---- 参数 / 上下文 ---- */
  if (status === 400 || status === 422) {
    const tooLong = /(context length|maximum context|too long|max_tokens|exceed|token limit)/i.test(detail);
    return {
      type: 'http-status',
      retryable: false,
      message: tooLong
        ? `请求超出模型限制（HTTP ${status}）：输入或输出超过「${model}」的上限 —— ` +
          `请调小 llm.chunkMinutes（缩短单块转写）或调大该槽位 maxTokens 后重跑${tail}`
        : `请求参数被拒绝（HTTP ${status}）：请检查模型名「${model}」、maxTokens 与 response_format 是否为该端点支持；` +
          `本地 Ollama 用旧版本时可能不支持 response_format，可把 llm.preset 换成 custom 并关掉 JSON 模式${tail}`,
    };
  }
  if (status === 408) {
    return { type: 'timeout', retryable: true, message: `服务端报告请求超时（HTTP 408）：已自动重试；持续出现请调大该槽位 timeoutMs${tail}` };
  }
  if (status === 413) {
    return {
      type: 'http-status',
      retryable: false,
      message: `请求体过大（HTTP 413）：单块内容超出了端点允许的大小 —— 请调小 llm.chunkMinutes 后重跑${tail}`,
    };
  }

  /* ---- 服务端 ---- */
  if (status >= 500) {
    return {
      type: 'http-status',
      retryable: true,
      message:
        `供应商服务端错误（HTTP ${status}）：${model} 侧故障或过载（与你本机配置无关）—— 已自动退避重试；` +
        `若连续 5xx 超过阈值，本场会走降级兜底，可稍后 --from-stage 重跑${tail}`,
    };
  }

  return { type: 'http-status', retryable: false, message: `调用失败（HTTP ${status}）：${model}${tail}` };
}

/* ============================================================================
 * 客户端
 * ========================================================================== */

interface ChatParams {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  modelOverride?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  purpose?: string;
}

type AttemptOutcome =
  | { ok: true; value: LlmCallResult }
  | { ok: false; error: LlmError; retry: boolean; waitMs: number };

/** chatJsonBatch 的单条结果：位置与 jobs 一一对应，单块失败不影响其它块 */
type ChatJsonBatchItem<T> =
  | { ok: true; value: T; usage: LlmUsage; cost: number }
  | { ok: false; error: LlmError; purpose?: string };

export class LlmClient {
  private summary: LlmEndpoint;
  private select: LlmEndpoint;
  /** 手工编辑过的 config.json 可能缺 pricing，故按可选处理，成本按 0 记并告警 */
  private pricing: Partial<Record<ModelSlot, SlotPricing>>;
  private logger: Logger;
  /** 打开时把原始响应交给日志（落盘由调用方负责，本模块不做文件 IO） */
  private recordRawResponses = false;
  private pricingWarned = false;

  /** 累计用量（供 TaskCost 与月度汇总），每场任务结束时 drainTotals() 收账 */
  readonly totals: { promptTokens: number; completionTokens: number; cachedPromptTokens: number; calls: number; cost: number } = {
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    calls: 0,
    cost: 0,
  };

  constructor(opts: { summary: LlmEndpoint; select: LlmEndpoint; pricing: AppConfig['llm']['pricing']; logger?: Logger }) {
    this.summary = opts.summary;
    this.select = opts.select;
    const pricing: Partial<Record<ModelSlot, SlotPricing>> | undefined = opts.pricing;
    this.pricing = pricing ?? {};
    this.logger = opts.logger ?? globalLog;
  }

  static fromConfig(cfg: AppConfig, logger?: Logger): LlmClient {
    const client = new LlmClient({
      summary: cfg.llm.summary,
      select: cfg.llm.select,
      pricing: cfg.llm.pricing,
      ...(logger ? { logger } : {}),
    });
    client.recordRawResponses = Boolean(cfg.llm.recordRawResponses);
    return client;
  }

  /** 配置热加载后更新两个槽位（缺字段保持原值，避免手改配置把服务打挂） */
  update(cfg: LlmConfig): void {
    const next = cfg as Partial<LlmConfig> | undefined;
    const summary: LlmEndpoint | undefined = next?.summary;
    const select: LlmEndpoint | undefined = next?.select;
    const pricing: Partial<Record<ModelSlot, SlotPricing>> | undefined = next?.pricing;
    if (summary) this.summary = summary;
    if (select) this.select = select;
    if (pricing) this.pricing = pricing;
    if (next) this.recordRawResponses = Boolean(next.recordRawResponses);
  }

  /** 两个槽位是否配置完整且不同（用于 §5.3 的提示：同模型时「升级重跑」退化为重试一次） */
  isEscalationMeaningful(): boolean {
    const complete = (ep: LlmEndpoint, model: string): boolean =>
      Boolean(ep.baseUrl && ep.baseUrl.trim() && model && (ep.apiKey && ep.apiKey.trim() ? true : isLocalUrl(ep.baseUrl)));
    if (!complete(this.summary, this.modelOf('summary'))) return false;
    if (!complete(this.select, this.modelOf('select'))) return false;
    return this.modelOf('summary') !== this.modelOf('select');
  }

  /** 槽位对应的模型名（select 未配置时回落到 summary 的模型） */
  modelOf(slot: ModelSlot): string {
    if (slot === 'select') return this.select.model?.trim() || this.summary.model?.trim() || '';
    return this.summary.model?.trim() || '';
  }

  /** 成本计算（可单独测试）：缓存命中的输入按 cachedInputPerMillion，其余按 inputPerMillion */
  computeCost(slot: ModelSlot, usage: LlmUsage): number {
    const p = this.pricing[slot] ?? ZERO_PRICING;
    const inputRate = num(p.inputPerMillion) ?? 0;
    const cachedRate = num(p.cachedInputPerMillion) ?? 0;
    const outputRate = num(p.outputPerMillion) ?? 0;
    if (inputRate === 0 && cachedRate === 0 && outputRate === 0 && !this.pricingWarned) {
      // 只是提示，不阻断调用：成本为 0 会让台账失真，必须让人看见
      this.pricingWarned = true;
      this.logger.warn(`[llm] 未配置 ${slot} 档定价（llm.pricing.${slot}），本次成本将记为 0 元`, { mod: 'llm' });
    }
    const prompt = Math.max(0, usage.promptTokens || 0);
    const cached = Math.min(prompt, Math.max(0, usage.cachedPromptTokens ?? 0));
    const completion = Math.max(0, usage.completionTokens || 0);
    const cost =
      ((prompt - cached) / 1_000_000) * inputRate +
      (cached / 1_000_000) * cachedRate +
      (completion / 1_000_000) * outputRate;
    // 保留 6 位小数，避免浮点尾数污染台账与 UI
    return Math.round(cost * 1_000_000) / 1_000_000;
  }

  /** 取走累计值并清零（每场任务结束时收账） */
  drainTotals(): { promptTokens: number; completionTokens: number; cachedPromptTokens: number; calls: number; cost: number } {
    const snapshot = { ...this.totals, cost: Math.round(this.totals.cost * 1_000_000) / 1_000_000 };
    this.totals.promptTokens = 0;
    this.totals.completionTokens = 0;
    this.totals.cachedPromptTokens = 0;
    this.totals.calls = 0;
    this.totals.cost = 0;
    return snapshot;
  }

  /* ------------------------------------------------------------------------
   * 基础调用
   * ---------------------------------------------------------------------- */

  /** 基础调用：OpenAI 兼容 /chat/completions，带重试、超时、usage 解析、成本计算、脱敏日志 */
  async chat(slot: ModelSlot, opts: ChatParams): Promise<LlmCallResult> {
    const problem = this.configProblem(slot);
    if (problem) {
      // 配置问题不发请求：省一次必然失败的往返，也给 UI 一个明确的结论
      throw new LlmError(problem.message, { type: problem.type, retryable: false, model: this.modelOf(slot) });
    }
    return this.execute(slot, opts, MAX_ATTEMPTS);
  }

  /**
   * 要求返回**结构化 JSON** 并做 zod 校验。
   * - 解析失败 / 校验失败 → 抛 LlmError{ type:'contract' }（retryable=false）
   * - 自动剥离 ```json 代码围栏、截取首个完整 {...} / [...]
   * - **不在此处重试**：格式能力不会因为重试而变好，升级重跑由 analyze.ts 决定（§5.5）
   * 注意：DeepSeek 的 json_object 模式要求提示词里出现 "json" 字样，调用方的 system/user 需自带。
   */
  async chatJson<T>(
    slot: ModelSlot,
    opts: {
      system: string;
      user: string;
      schema: ZodType<T>;
      temperature?: number;
      maxTokens?: number;
      modelOverride?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      purpose?: string;
    },
  ): Promise<{ value: T; usage: LlmUsage; cost: number; raw: string }> {
    const label = opts.purpose ? `（${opts.purpose}）` : '';
    const res = await this.chat(slot, {
      system: opts.system,
      user: opts.user,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.modelOverride ? { modelOverride: opts.modelOverride } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.purpose ? { purpose: opts.purpose } : {}),
      json: true,
    });

    const raw = res.text;
    const jsonText = extractJsonText(raw);
    const snippet = redactText(raw.slice(0, 300));

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      throw new LlmError(
        `返回内容不是合法 JSON${label}：${e instanceof Error ? e.message : String(e)}；` +
          `已剥离代码围栏并截取首个 JSON 值后仍无法解析。原文片段：${snippet}`,
        { type: 'contract', retryable: false, model: res.usage.model },
      );
    }

    const checked = opts.schema.safeParse(parsed);
    if (!checked.success) {
      const issues = checked.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
        .join('; ');
      const more = checked.error.issues.length > 8 ? `（另有 ${checked.error.issues.length - 8} 处）` : '';
      throw new LlmError(
        `返回内容不符合 JSON 契约${label}：${issues}${more}。原文片段：${snippet}`,
        { type: 'contract', retryable: false, model: res.usage.model },
      );
    }

    this.logger.debug(
      `[llm] ✓ ${slot}(${res.usage.model}) chatJson 契约校验通过${label} cost=${res.cost.toFixed(6)}`,
      { mod: 'llm' },
    );
    return { value: checked.data, usage: res.usage, cost: res.cost, raw };
  }

  /* ------------------------------------------------------------------------
   * 连通性测试
   * ---------------------------------------------------------------------- */

  /** 连通性 + 可用性测试：给 UI 的「测试」按钮用，返回可执行结论 */
  async probe(slot: ModelSlot): Promise<LlmProbeResult> {
    const ep = this.endpointOf(slot);
    const model = this.modelOf(slot);
    const baseUrl = (ep.baseUrl ?? '').trim();

    const problem = this.configProblem(slot);
    if (problem) return { ok: false, message: problem.message, model, baseUrl };

    try {
      // 只发 1 次请求：测试按钮要的是「现在到底通不通」，不是把退避重试演一遍
      const res = await this.execute(
        slot,
        {
          system: PROBE_SYSTEM,
          user: PROBE_USER,
          temperature: 0,
          maxTokens: 16,
          purpose: `连通性测试（${slot} 槽位）`,
        },
        1,
      );
      const latencyMs = res.usage.durationMs;
      return {
        ok: true,
        message:
          `连通正常：${slot} 槽位使用模型「${model}」在 ${latencyMs}ms 内返回，` +
          `本次 prompt=${res.usage.promptTokens} / completion=${res.usage.completionTokens} tokens，` +
          `约 ${res.cost.toFixed(6)} 元`,
        model,
        baseUrl,
        latencyMs,
        sample: res.text.trim().slice(0, 120),
      };
    } catch (e) {
      const err =
        e instanceof LlmError
          ? e
          : new LlmError(`连通性测试失败：${e instanceof Error ? e.message : String(e)}`, {
              type: 'internal',
              retryable: false,
              model,
              cause: e,
            });
      const note = err.retryable ? `（测试只发 1 次请求，未自动重试；正式调用会最多重试 ${MAX_ATTEMPTS - 1} 次）` : '';
      const result: LlmProbeResult = { ok: false, message: `${err.message}${note}`, model, baseUrl };
      const latencyMs = err.request?.durationMs;
      if (latencyMs !== undefined) result.latencyMs = latencyMs;
      return result;
    }
  }

  /* ------------------------------------------------------------------------
   * 内部：配置体检 / 单次执行
   * ---------------------------------------------------------------------- */

  private endpointOf(slot: ModelSlot): LlmEndpoint {
    return slot === 'select' ? this.select : this.summary;
  }

  /** 配置是否足以发起调用；不足以发起时给出可执行结论（不发无用请求） */
  private configProblem(slot: ModelSlot): { type: ErrorType; message: string } | undefined {
    const ep = this.endpointOf(slot);
    const baseUrl = (ep?.baseUrl ?? '').trim();
    const model = this.modelOf(slot);
    if (!baseUrl) {
      return {
        type: 'config',
        message: `未配置接口地址（llm.${slot}.baseUrl）—— 请在设置页填写 OpenAI 兼容地址，例如 https://api.deepseek.com/v1`,
      };
    }
    if (!model) {
      return {
        type: 'config',
        message:
          slot === 'select'
            ? '选片档未配置模型名（llm.select.model），且总结档 llm.summary.model 也为空 —— 请至少填写总结档模型名'
            : `未配置模型名（llm.summary.model）—— 请填写模型名，例如 deepseek-chat`,
      };
    }
    const apiKey = (ep?.apiKey ?? '').trim();
    if (!apiKey) {
      if (isLocalUrl(baseUrl)) return undefined; // 本地 Ollama 允许不带 Key
      return {
        type: 'auth',
        message:
          `未配置 API Key（llm.${slot}.apiKey）—— 请在设置页填写；` +
          `若使用本地 Ollama（baseUrl 为 127.0.0.1）可留空`,
      };
    }
    if (/在此填写|请填写|your[-_ ]?(api[-_ ]?)?key|your[-_ ]?token|^x{3,}$/i.test(apiKey)) {
      return {
        type: 'auth',
        message: `llm.${slot}.apiKey 仍是模板占位符（${redactText(apiKey).slice(0, 24)}）—— 请替换为控制台里的真实 Key`,
      };
    }
    return undefined;
  }

  /** 单次 HTTP 调用（含失败分类），重试决策由 execute 负责 */
  private async attemptOnce(
    slot: ModelSlot,
    ep: LlmEndpoint,
    model: string,
    params: ChatParams,
    attempts: RetryAttempt[],
    attempt: number,
    state: { timedOut: boolean },
    signal: AbortSignal,
  ): Promise<AttemptOutcome> {
    const timeoutMs = positiveMs(params.timeoutMs ?? ep.timeoutMs, DEFAULT_TIMEOUT_MS);
    const temperature = num(params.temperature) ?? num(ep.temperature) ?? 0.3;
    const maxTokens = positiveInt(params.maxTokens ?? ep.maxTokens, 4096);
    const url = chatCompletionsUrl(ep.baseUrl);
    const started = Date.now();

    // system 原样透传（prompt 缓存要求逐字节一致）；这里只记录 hash 与字节数，便于核对缓存命中
    const requestCtx: RequestContext = {
      method: 'POST',
      url,
      params: redact({
        slot,
        model,
        temperature,
        maxOutput: maxTokens,
        json: Boolean(params.json),
        purpose: params.purpose ?? '',
        systemHash: hashKey([params.system]),
        systemBytes: Buffer.byteLength(params.system, 'utf8'),
        userBytes: Buffer.byteLength(params.user, 'utf8'),
        timeoutMs,
      }),
    };

    const payload: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    // DeepSeek 要求 json_object 模式时提示词里含 "json" 字样（调用方保证）
    if (params.json) payload['response_format'] = { type: 'json_object' };

    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const apiKey = (ep.apiKey ?? '').trim();
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`; // 只进请求头，绝不进日志/错误对象

    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal });
      const text = await res.text();
      const elapsed = Date.now() - started;

      requestCtx.status = res.status;
      requestCtx.durationMs = elapsed;
      const kept = truncate(text, RESPONSE_KEEP_CHARS);
      requestCtx.responseBody = redactText(kept.text);
      requestCtx.responseTruncated = kept.truncated;
      requestCtx.responseOriginalLength = kept.originalLength;

      if (this.recordRawResponses) {
        // 落盘由调用方负责；这里只在开启时把原文交给日志，便于事后核对 prompt 迭代
        this.logger.debug(`[llm] 原始响应（recordRawResponses=true，${elapsed}ms）`, { mod: 'llm', data: { raw: text } });
      }

      if (!res.ok) {
        const cls = explainHttpFailure(res.status, text, model);
        const error = new LlmError(cls.message, {
          type: cls.type,
          retryable: cls.retryable,
          model,
          request: requestCtx,
          attempts: [...attempts],
        });
        return { ok: false, error, retry: cls.retryable, waitMs: retryWaitMs(attempt, res.headers.get('retry-after')) };
      }

      const completion = this.readCompletion(text, model, elapsed, requestCtx);
      const cost = this.computeCost(slot, completion.usage);
      this.totals.promptTokens += completion.usage.promptTokens;
      this.totals.completionTokens += completion.usage.completionTokens;
      this.totals.cachedPromptTokens += completion.usage.cachedPromptTokens ?? 0;
      this.totals.calls += 1;
      this.totals.cost += cost;

      this.logger.debug(
        `[llm] ✓ ${slot}(${model}) ${elapsed}ms prompt=${completion.usage.promptTokens} ` +
          `completion=${completion.usage.completionTokens} cached=${completion.usage.cachedPromptTokens ?? 0} ` +
          `cost=${cost.toFixed(6)} 元${params.purpose ? ` purpose=${params.purpose}` : ''}`,
        { mod: 'llm', data: { finishReason: completion.finishReason ?? '', json: Boolean(params.json) } },
      );
      return { ok: true, value: { text: completion.text, usage: completion.usage, cost } };
    } catch (e) {
      requestCtx.durationMs = Date.now() - started;

      if (e instanceof LlmError) {
        // readCompletion 抛出的协议/契约问题：不重试（重试解决不了格式问题）
        return { ok: false, error: e, retry: false, waitMs: 0 };
      }
      if (state.timedOut) {
        const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        const cls = explainHttpFailure(0, `TIMEOUT(${timeoutMs})：${raw}`, model);
        const error = new LlmError(cls.message, {
          type: cls.type,
          retryable: cls.retryable,
          model,
          request: requestCtx,
          attempts: [...attempts],
          cause: e,
        });
        return { ok: false, error, retry: cls.retryable, waitMs: backoffMs(attempt) };
      }
      if (signal.aborted) {
        // 外部取消（UI 停止 / 任务取消）：不重试，也不计入失败尝试
        const error = new LlmError(`调用被取消：${slot}(${model})${params.purpose ? ` —— ${params.purpose}` : ''}`, {
          type: 'internal',
          retryable: false,
          model,
          request: requestCtx,
          attempts: [...attempts],
          cause: e,
        });
        return { ok: false, error, retry: false, waitMs: 0 };
      }
      const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const cls = explainHttpFailure(0, raw, model);
      const error = new LlmError(cls.message, {
        type: cls.type,
        retryable: cls.retryable,
        model,
        request: requestCtx,
        attempts: [...attempts],
        cause: e,
      });
      return { ok: false, error, retry: cls.retryable, waitMs: backoffMs(attempt) };
    }
  }

  /** 把响应体解析成文本 + usage；协议层面的问题一律抛 contract 错误（不重试） */
  private readCompletion(
    bodyText: string,
    model: string,
    durationMs: number,
    request: RequestContext,
  ): { text: string; usage: LlmUsage; finishReason?: string } {
    const fail = (message: string): never => {
      throw new LlmError(message, { type: 'contract', retryable: false, model, request });
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      fail(
        `响应不是合法 JSON（HTTP 200）—— baseUrl 可能指向了非 OpenAI 兼容端点（正确形如 https://api.deepseek.com/v1），` +
          `或中间网关返回了 HTML 页面。响应开头：${redactText(bodyText.slice(0, 200))}`,
      );
    }

    const root = asRecord(parsed);
    const choices = root?.['choices'];
    const first = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
    const message = asRecord(first?.['message']);
    const text =
      normalizeContent(message?.['content']) ??
      normalizeContent(first?.['text']) ??
      normalizeContent(root?.['response']);
    const finishReason = str(first?.['finish_reason']);

    if (text === undefined) {
      fail(
        `响应缺少 choices[0].message.content —— 端点不支持 OpenAI 兼容 /chat/completions（baseUrl 是否少了 /v1？）；` +
          `响应片段：${redactText(bodyText.slice(0, 200))}`,
      );
    }
    if ((text ?? '').trim() === '') {
      const reasoning = normalizeContent(message?.['reasoning_content']);
      fail(
        reasoning
          ? `模型只返回了推理内容（reasoning_content）而没有最终答案 —— 多为 max_tokens 太小被推理吃光，` +
            `请调大该槽位 maxTokens 或换用非推理模型；finish_reason=${finishReason ?? '未知'}`
          : `模型返回了空内容 —— 可能被内容安全策略拦截或 max_tokens 过小；finish_reason=${finishReason ?? '未知'}`,
      );
    }

    if (finishReason === 'length') {
      // 输出被截断是 JSON 契约失败的最常见原因，提前把线索打出来
      this.logger.warn(`[llm] 输出被 max_tokens 截断（${model}），JSON 契约可能因此不完整，建议调大该槽位 maxTokens`, {
        mod: 'llm',
      });
    }

    const out: { text: string; usage: LlmUsage; finishReason?: string } = {
      text: text as string,
      usage: parseUsage(root, model, durationMs),
    };
    if (finishReason) out.finishReason = finishReason;
    return out;
  }

  /** 重试主循环：网络/超时/429/5xx 会重试；契约与 4xx 鉴权类失败直接抛出 */
  private async execute(slot: ModelSlot, params: ChatParams, maxAttempts: number): Promise<LlmCallResult> {
    const ep = this.endpointOf(slot);
    const model = params.modelOverride && params.modelOverride.trim() !== '' ? params.modelOverride.trim() : this.modelOf(slot);
    const attempts: RetryAttempt[] = [];
    const total = Math.max(1, maxAttempts);
    let lastError: LlmError | undefined;

    this.logger.debug(
      `[llm] → ${slot}(${model}) attempt=${total} json=${Boolean(params.json)} system=${hashKey([params.system])}` +
        `${params.purpose ? ` purpose=${params.purpose}` : ''}`,
      { mod: 'llm' },
    );

    for (let attempt = 1; attempt <= total; attempt++) {
      const controller = new AbortController();
      const state = { timedOut: false };
      // 每次尝试各自计时：端点配置可能在热加载后变化，且重试应从零开始计超时
      const attemptTimeoutMs = positiveMs(params.timeoutMs ?? ep.timeoutMs, DEFAULT_TIMEOUT_MS);
      const timer = setTimeout(() => {
        state.timedOut = true;
        controller.abort(new Error(`timeout ${attemptTimeoutMs}ms`));
      }, attemptTimeoutMs);
      const onOuterAbort = (): void => controller.abort(new Error('canceled'));
      params.signal?.addEventListener('abort', onOuterAbort, { once: true });

      let outcome: AttemptOutcome;
      try {
        outcome = await this.attemptOnce(slot, ep, model, params, attempts, attempt, state, controller.signal);
      } catch (e) {
        outcome = {
          ok: false,
          error: new LlmError(`LLM 调用出现未预期错误：${e instanceof Error ? e.message : String(e)}`, {
            type: 'internal',
            retryable: false,
            model,
            attempts: [...attempts],
            cause: e,
          }),
          retry: false,
          waitMs: 0,
        };
      } finally {
        clearTimeout(timer);
        params.signal?.removeEventListener('abort', onOuterAbort);
      }

      if (outcome.ok) return outcome.value;

      if (!outcome.retry || attempt === total) {
        this.logger.error(`[llm] ✗ ${slot}(${model}) attempt=${attempt}/${total} type=${outcome.error.type}`, outcome.error, {
          mod: 'llm',
          data: { purpose: params.purpose ?? '', status: outcome.error.request?.status ?? 0 },
        });
        throw outcome.error;
      }

      attempts.push({
        attempt,
        at: nowIso(),
        type: outcome.error.type,
        message: outcome.error.message,
        model,
      });
      const wait = outcome.waitMs;
      this.logger.warn(
        `[llm] ↻ ${slot}(${model}) 第 ${attempt}/${total} 次失败（${outcome.error.type}），${wait}ms 后重试：${outcome.error.message}`,
        { mod: 'llm' },
      );
      lastError = outcome.error;
      await sleep(wait);
      if (params.signal?.aborted) {
        throw new LlmError(`调用已被取消，停止重试：${slot}(${model})`, {
          type: 'internal',
          retryable: false,
          model,
          attempts: [...attempts],
          ...(lastError.request ? { request: lastError.request } : {}),
        });
      }
    }

    throw (
      lastError ??
      new LlmError(`调用失败且无可用错误详情：${slot}(${model})`, { type: 'internal', retryable: false, model, attempts: [...attempts] })
    );
  }
}

/* ============================================================================
 * 批量调用
 * ========================================================================== */

/**
 * 带并发限制的批量调用（分块 map 用），并汇总失败项。
 * 返回数组与 jobs 位置一一对应：单块失败只产出结构化失败项，
 * 由 analyze.ts 决定「记 gap 继续」还是「连续失败超过阈值就整体降级」。
 */
export async function chatJsonBatch<T>(
  client: LlmClient,
  slot: ModelSlot,
  jobs: Array<{ system: string; user: string; schema: ZodType<T>; purpose?: string; maxTokens?: number }>,
  opts: { concurrency: number; signal?: AbortSignal },
): Promise<Array<ChatJsonBatchItem<T>>> {
  const concurrency = Math.max(1, Math.floor(num(opts.concurrency) ?? 1));
  const limit = createLimiter(concurrency);

  return Promise.all(
    jobs.map((job) =>
      limit(async (): Promise<ChatJsonBatchItem<T>> => {
        if (opts.signal?.aborted) {
          const error = new LlmError(`调用已取消，未执行该分块：${job.purpose ?? ''}`, {
            type: 'internal',
            retryable: false,
            model: client.modelOf(slot),
          });
          return job.purpose ? { ok: false, error, purpose: job.purpose } : { ok: false, error };
        }
        try {
          const res = await client.chatJson<T>(slot, {
            system: job.system,
            user: job.user,
            schema: job.schema,
            ...(job.maxTokens !== undefined ? { maxTokens: job.maxTokens } : {}),
            ...(job.purpose ? { purpose: job.purpose } : {}),
            ...(opts.signal ? { signal: opts.signal } : {}),
          });
          return { ok: true, value: res.value, usage: res.usage, cost: res.cost };
        } catch (e) {
          const error =
            e instanceof LlmError
              ? e
              : new LlmError(`分块调用失败：${e instanceof Error ? e.message : String(e)}`, {
                  type: 'internal',
                  retryable: false,
                  model: client.modelOf(slot),
                  cause: e,
                });
          return job.purpose ? { ok: false, error, purpose: job.purpose } : { ok: false, error };
        }
      }),
    ),
  );
}
