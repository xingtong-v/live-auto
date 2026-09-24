/**
 * 告警通道（任务书 §8 WP6 步骤 4）。
 *
 * 覆盖事件：录制完成、分析完成、投稿成功 / 失败、账号失效、磁盘不足、版本差异大。
 * 三条硬性要求：
 *  1) **去重 + 恢复配对**：同一 key 在 dedupeWindowSec 内只推一次，重复发生只累加计数；
 *     `recover(key)` 仅在该 key 处于告警态时发一条「已恢复」，发完清除状态。
 *     状态在内存 + data/alerts-state.json 双写，进程重启后仍能配对恢复通知。
 *  2) **接口可注入**：所有渠道函数都收 `fetchImpl`，单测不需要真发网络请求。
 *  3) **绝不影响主流程**：全链路 try/catch，失败只 logger.warn；
 *     凭据（sendKey / secret / botToken / webhook）绝不出现在返回值与日志里（硬约束 #8）。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import type { AppConfig } from './config.ts';
import type { AlertLevel, AlertPayload } from './types.ts';
import { DATA_DIR, fmtHuman, fmtLocal, nowIso, readJson, toMs, truncate, writeJsonAtomic } from './util.ts';
import { redactText } from './redact.ts';
import { log as globalLog, type Logger } from './logger.ts';

/* ============================================================================
 * 对外类型与常量
 * ========================================================================== */

export interface AlertChannelResult {
  channel: string;
  ok: boolean;
  message: string;
  latencyMs?: number;
}

/** 支持的告警渠道（与 AppConfig.alert.channels 的元素类型一致） */
const CHANNELS = ['serverchan', 'dingtalk', 'telegram', 'webhook'] as const;
export type AlertChannelName = (typeof CHANNELS)[number];

/** 渠道默认的发送超时：告警宁可晚到也不能把主流程挂住 */
const ALERT_TIMEOUT_MS = 15000;

const LEVEL_TAG: Record<AlertLevel, string> = { info: '📢', warn: '⚠️', error: '❌', recover: '✅' };
const LEVEL_TEXT: Record<AlertLevel, string> = { info: '通知', warn: '警告', error: '错误', recover: '恢复' };

/** 告警 key 前缀 → config.alert.events 里的开关名 */
const KEY_EVENT_MAP: Record<string, string> = {
  'recording-done': 'recordingDone',
  'analysis-done': 'analysisDone',
  'publish-success': 'publishSuccess',
  'publish-failed': 'failure',
  'task-failed': 'failure',
  'account-expiring': 'accountExpiring',
  'account-expired': 'accountExpiring',
  'disk-low': 'diskLow',
  'disk-full': 'diskLow',
  'version-drift': 'versionDrift',
};

/** 钉钉常见错误码 → 可执行结论（不猜未核实的码，只列确定的两个） */
const DINGTALK_ERRCODE_HINT: Record<number, string> = {
  300001: 'access_token 无效：机器人 Webhook 被重置过，请重新复制完整地址',
  310000: '安全设置校验失败：加签 secret 不匹配，或消息未命中「自定义关键词」',
};

/* ============================================================================
 * 通用小工具（脱敏 / 渲染 / 结果封装）
 * ========================================================================== */

/**
 * 出站文本统一出口：先过 redactText，再把该渠道自己的凭据串整体抹掉。
 * 后者是必要的补充：bot token 形如 `123456:AA...`、webhook 里带 access_token，
 * redact.ts 的形态规则覆盖不到，而异常消息里经常整条 URL 带出来。
 */
function safeText(text: unknown, secrets: Array<string | undefined> = []): string {
  let out = redactText(String(text ?? ''));
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 6) out = out.split(s).join('***REDACTED***');
  }
  return out;
}

function errText(e: unknown, secrets: Array<string | undefined> = []): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return safeText(truncate(raw, 300).text, secrets);
}

function result(channel: string, ok: boolean, message: string, latencyMs?: number): AlertChannelResult {
  const out: AlertChannelResult = { channel, ok, message: safeText(message) };
  if (typeof latencyMs === 'number') out.latencyMs = latencyMs;
  return out;
}

/** 告警文本（各渠道共用；纯文本，避免 Markdown 解析失败导致整条发不出去） */
function renderText(payload: AlertPayload): string {
  const atMs = Date.parse(payload.at);
  const parts: string[] = [`${LEVEL_TAG[payload.level]} 【${LEVEL_TEXT[payload.level]}】${payload.title}`];
  if (payload.body) parts.push('', payload.body);
  if (payload.fields) {
    const rows = Object.entries(payload.fields).filter(([, v]) => v !== undefined && v !== null);
    if (rows.length > 0) parts.push('', ...rows.map(([k, v]) => `- ${k}：${String(v)}`));
  }
  if (payload.taskId) parts.push('', `任务：${payload.taskId}`);
  parts.push(`时间：${fmtLocal(Number.isFinite(atMs) ? atMs : Date.now())}`);
  return parts.join('\n');
}

/** 带超时的 fetch：告警发送不能无限等待 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs = ALERT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`告警发送超时（${timeoutMs}ms）`)), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/* ============================================================================
 * 钉钉加签（必须正确，否则钉钉直接拒收）
 * ========================================================================== */

/**
 * 钉钉加签：`stringToSign = timestamp + "\n" + secret`，
 * HMAC-SHA256（key = secret）→ Base64 → encodeURIComponent。
 */
export function dingtalkSign(secret: string, timestampMs: number): string {
  const stringToSign = `${timestampMs}\n${secret}`;
  const digest = crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
  return encodeURIComponent(digest);
}

/* ============================================================================
 * 各渠道独立发送函数（便于单测，不依赖 Alerter 实例）
 * ========================================================================== */

/** Server 酱：POST https://sctapi.ftqq.com/<sendKey>.send，成功判据是响应体里的 code === 0 */
export async function sendServerChan(
  cfg: { sendKey: string },
  payload: AlertPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<AlertChannelResult> {
  const channel = 'serverchan';
  const started = Date.now();
  const sendKey = cfg?.sendKey ?? '';
  if (!sendKey) {
    return result(channel, false, '未配置 serverchan.sendKey —— 在 config.json 的 alert.serverchan.sendKey 填入 SendKey（形如 SCTxxxxx），或改用其它渠道', 0);
  }
  const secrets = [sendKey];
  try {
    const url = `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`;
    const res = await fetchWithTimeout(fetchImpl, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: safeText(payload.title, secrets).slice(0, 100),
        desp: safeText(renderText(payload), secrets),
      }),
    });
    const latencyMs = Date.now() - started;
    const text = await readText(res);
    if (!res.ok) {
      return result(channel, false, `HTTP ${res.status} —— ${safeText(truncate(text, 200).text, secrets)}`, latencyMs);
    }
    const body = parseJson(text);
    const codeRaw = body ? body['code'] : undefined;
    const code = Number(codeRaw);
    const message = String(body?.['message'] ?? body?.['msg'] ?? '');
    if (code === 0) {
      return result(channel, true, `已推送（code=0${message ? `，${message}` : ''}）`, latencyMs);
    }
    // HTTP 200 但 code != 0 是 Server 酱的常规失败姿势，必须把服务端 message 带出来
    const detail = message || truncate(text, 200).text;
    return result(
      channel,
      false,
      `Server 酱返回 code=${codeRaw === undefined ? '未知' : String(codeRaw)}${detail ? `：${detail}` : ''} —— 请核对 SendKey 是否正确、是否已在微信端关注并绑定`,
      latencyMs,
    );
  } catch (e) {
    return result(channel, false, `发送异常（网络 / 超时）：${errText(e, secrets)}`, Date.now() - started);
  }
}

/** 钉钉机器人：加签后 POST markdown 消息，成功判据是 errcode === 0 */
export async function sendDingTalk(
  cfg: { webhook: string; secret: string },
  payload: AlertPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<AlertChannelResult> {
  const channel = 'dingtalk';
  const started = Date.now();
  const webhook = cfg?.webhook ?? '';
  const secret = cfg?.secret ?? '';
  if (!webhook) {
    return result(channel, false, '未配置 dingtalk.webhook —— 钉钉群「智能群助手」添加自定义机器人后，把 Webhook 地址填入 config.json', 0);
  }
  const secrets = [webhook, secret];
  try {
    const timestamp = Date.now();
    let url = webhook;
    if (secret) {
      // 加签参数必须拼在 query 上；已有 query 时用 & 续接
      url += `${url.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${dingtalkSign(secret, timestamp)}`;
    }
    const res = await fetchWithTimeout(fetchImpl, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: {
          title: safeText(payload.title, secrets).slice(0, 60),
          text: safeText(renderText(payload), secrets),
        },
      }),
    });
    const latencyMs = Date.now() - started;
    const text = await readText(res);
    if (!res.ok) {
      return result(channel, false, `HTTP ${res.status} —— ${safeText(truncate(text, 200).text, secrets)}`, latencyMs);
    }
    const body = parseJson(text);
    const errcode = Number(body?.['errcode']);
    const errmsg = String(body?.['errmsg'] ?? '');
    if (errcode === 0) {
      return result(channel, true, `已推送（errcode=0${secret ? '，已加签' : '，未加签'}）`, latencyMs);
    }
    const hint = DINGTALK_ERRCODE_HINT[errcode] ?? (secret ? '' : '当前未配置 alert.dingtalk.secret：若机器人安全设置选了「加签」则必然失败，请补 secret 或改用「自定义关键词」');
    return result(
      channel,
      false,
      `钉钉返回 errcode=${body?.['errcode'] === undefined ? '未知' : String(body['errcode'])}${errmsg ? `：${errmsg}` : ''}${hint ? ` —— ${hint}` : ''}`,
      latencyMs,
    );
  } catch (e) {
    return result(channel, false, `发送异常（网络 / 超时）：${errText(e, secrets)}`, Date.now() - started);
  }
}

/** Telegram：纯文本发送（不用 MarkdownV2，标题正文里的 * _ [ ] 会让解析直接 400） */
export async function sendTelegram(
  cfg: { botToken: string; chatId: string },
  payload: AlertPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<AlertChannelResult> {
  const channel = 'telegram';
  const started = Date.now();
  const botToken = cfg?.botToken ?? '';
  const chatId = cfg?.chatId ?? '';
  if (!botToken || !chatId) {
    return result(
      channel,
      false,
      `未配置 telegram.${!botToken ? 'botToken' : 'chatId'} —— 找 @BotFather 建机器人拿 token，再把数字 chatId 填入 config.json 的 alert.telegram`,
      0,
    );
  }
  const secrets = [botToken];
  try {
    const res = await fetchWithTimeout(fetchImpl, `https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: safeText(renderText(payload), secrets).slice(0, 3900),
        disable_web_page_preview: true,
      }),
    });
    const latencyMs = Date.now() - started;
    const text = await readText(res);
    const body = parseJson(text);
    if (!res.ok || body?.['ok'] !== true) {
      const desc = String(body?.['description'] ?? truncate(text, 200).text);
      return result(channel, false, `Telegram 返回${res.ok ? '' : ` HTTP ${res.status}`}：${safeText(desc, secrets)}`, latencyMs);
    }
    return result(channel, true, '已推送（ok=true）', latencyMs);
  } catch (e) {
    return result(channel, false, `发送异常（网络 / 超时）：${errText(e, secrets)}`, Date.now() - started);
  }
}

/** 通用 Webhook：POST JSON（自建通知服务 / Bark / n8n 等） */
export async function sendWebhook(
  cfg: { url: string },
  payload: AlertPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<AlertChannelResult> {
  const channel = 'webhook';
  const started = Date.now();
  const url = cfg?.url ?? '';
  if (!url) {
    return result(channel, false, '未配置 webhook.url —— 填入能接收 POST JSON 的地址（自建通知服务 / n8n / Bark 等）', 0);
  }
  const secrets = [url];
  try {
    const res = await fetchWithTimeout(fetchImpl, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 显式逐字段构造而不是展开 payload：避免把调用方没清干净的字段原样送出去
      body: JSON.stringify({
        source: 'live_auto',
        event: payload.key,
        level: payload.level,
        title: safeText(payload.title, secrets),
        body: safeText(payload.body, secrets),
        text: safeText(renderText(payload), secrets),
        ...(payload.taskId ? { taskId: payload.taskId } : {}),
        at: payload.at,
        ...(payload.fields ? { fields: payload.fields } : {}),
      }),
    });
    const latencyMs = Date.now() - started;
    const text = await readText(res);
    if (!res.ok) {
      return result(channel, false, `HTTP ${res.status} —— ${safeText(truncate(text, 200).text, secrets)}`, latencyMs);
    }
    return result(channel, true, `已推送（HTTP ${res.status}${text.trim() ? `，响应 ${safeText(truncate(text.trim(), 120).text, secrets)}` : ''}）`, latencyMs);
  } catch (e) {
    return result(channel, false, `发送异常（网络 / 超时）：${errText(e, secrets)}`, Date.now() - started);
  }
}

/* ============================================================================
 * 去重状态
 * ========================================================================== */

interface AlertStateEntry {
  key: string;
  level: AlertLevel;
  /** 用于恢复通知的标题（首次告警时记录） */
  title: string;
  /** 首次告警时间 */
  since: string;
  /** 最近一次发生时间 */
  lastAt: string;
  /**
   * 最近一次「真正推送成功」的时间 —— 去重窗口以它为起点。
   * 为什么不以 lastAt 为起点：持续存在的故障若一直滑动窗口，就永远不会再提醒；
   * 以推送时间为起点可以做到「窗口内静默、窗口外重提醒」。
   */
  lastSentAt?: string;
  /** 累计发生次数（含被去重抑制的） */
  count: number;
}

interface AlertStateFile {
  version: number;
  updatedAt: string;
  entries: AlertStateEntry[];
}

interface AlerterOptions {
  config: AppConfig['alert'];
  logger?: Logger;
  appVersion?: string;
  /** 去重状态文件路径。默认 data/alerts-state.json；单测可注入临时目录，避免污染真实数据 */
  statePath?: string;
  /** 注入 fetch（单测用）。默认全局 fetch */
  fetchImpl?: typeof fetch;
}

function isAlertLevel(v: unknown): v is AlertLevel {
  return v === 'info' || v === 'warn' || v === 'error' || v === 'recover';
}

/** 从 key 里取事件名：`task-failed:t1:ANALYZING` → task-failed → failure */
function eventNameOf(key: string): string | undefined {
  if (!key) return undefined;
  const prefix = key.split(':')[0] ?? '';
  return KEY_EVENT_MAP[prefix];
}

/* ============================================================================
 * Alerter
 * ========================================================================== */

export class Alerter {
  private config: AppConfig['alert'];
  private logger: Logger;
  private appVersion?: string;
  private statePath: string;
  private fetchImpl: typeof fetch;
  private state = new Map<string, AlertStateEntry>();

  /** 注意：不使用 TS 参数属性（erasableSyntaxOnly / Node 原生类型擦除不支持） */
  constructor(opts: AlerterOptions) {
    this.config = opts.config;
    this.logger = opts.logger ?? globalLog;
    if (opts.appVersion) this.appVersion = opts.appVersion;
    this.statePath = opts.statePath ?? path.join(DATA_DIR, 'alerts-state.json');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.loadState();
  }

  /** 配置热加载（§8 WP6 步骤 9）：保存配置后无需重启即可生效 */
  update(config: AppConfig['alert']): void {
    this.config = config;
  }

  /* ------------------------------------------------------------------------
   * 主入口
   * ---------------------------------------------------------------------- */

  /**
   * 主入口：按事件开关过滤 → 去重 → 发送 → 记录。
   * 返回值是各渠道结果汇总；被跳过时返回一条 channel='skip' 的说明（便于 UI 给出可执行结论）。
   * 本方法永不抛异常。
   */
  async send(payload: AlertPayload): Promise<AlertChannelResult[]> {
    try {
      const cfg = this.config;
      if (!cfg || cfg.enabled === false) {
        return [result('skip', true, '告警已全局关闭（alert.enabled=false），本条未发送', 0)];
      }
      if (!this.eventEnabled(payload.key)) {
        return [result('skip', true, `事件开关已关闭（alert.events.${eventNameOf(payload.key) ?? payload.key}=false），本条未发送`, 0)];
      }

      const gate = this.register(payload);
      if (gate.suppressed) {
        return [result('dedupe', true, `去重窗口（${this.windowSec()}s）内第 ${gate.count} 次相同告警，已累加计数、未重复推送`, 0)];
      }

      const results = await this.dispatch(payload);
      const anyOk = results.some((r) => r.ok);
      const channelCount = (cfg.channels ?? []).length;
      // 全部渠道都失败时不刷新 lastSentAt，让下一次重复发生还能再试一次
      if (anyOk || channelCount === 0) {
        const entry = this.state.get(payload.key);
        if (entry) entry.lastSentAt = nowIso();
        this.saveState();
      }
      this.logger.info('告警已发送', {
        data: { key: payload.key, level: payload.level, taskId: payload.taskId, results },
      });
      return results;
    } catch (e) {
      this.logger.warn('告警发送流程异常（已忽略，不影响主流程）', {
        data: { key: payload?.key, error: errText(e) },
      });
      return [result('alerter', false, `告警流程异常：${errText(e)}`, 0)];
    }
  }

  /* ------------------------------------------------------------------------
   * 语义化快捷方法（流水线各处只调这些，key 命名统一在这里收口）
   * ---------------------------------------------------------------------- */

  async recordingDone(info: { taskId: string; title: string; durationSec: number; roomId: string }): Promise<void> {
    await this.fire({
      level: 'info',
      key: `recording-done:${info.taskId}`,
      title: `录制完成：${info.title}`,
      body: `房间 ${info.roomId} 本场录制已确认完成，时长 ${fmtHuman(info.durationSec)}，已进入转写与选片流水线。`,
      taskId: info.taskId,
      at: nowIso(),
      fields: { 时长: fmtHuman(info.durationSec), 房间: info.roomId },
    });
  }

  async analysisDone(info: { taskId: string; title: string; clipCount: number; degraded: boolean; summaryHead?: string }): Promise<void> {
    const head = info.summaryHead ? truncate(info.summaryHead.replace(/\s+/g, ' '), 200).text : '';
    await this.fire({
      level: info.degraded ? 'warn' : 'info',
      key: `analysis-done:${info.taskId}`,
      title: `${info.degraded ? '分析完成（已降级）' : '分析完成'}：${info.title}`,
      body: info.degraded
        ? `LLM 不可用或输出未通过契约校验，已降级为弹幕密度兜底，产出 ${info.clipCount} 个候选切片，建议人工重点复核标题与时间点。`
        : `产出 ${info.clipCount} 个候选切片，等待确认发布。`,
      taskId: info.taskId,
      at: nowIso(),
      fields: { 候选切片: info.clipCount, 降级: info.degraded ? '是' : '否', ...(head ? { 摘要: head } : {}) },
    });
  }

  async publishSuccess(info: { taskId: string; title: string; bvid?: string; dtime?: number; isOnlySelf: boolean }): Promise<void> {
    const dtimeMs = toMs(info.dtime);
    const dtimeNote = dtimeMs !== undefined ? `定时发布时间：${fmtLocal(dtimeMs)}。` : '';
    const bvidNote = info.bvid
      ? `BV 号 ${info.bvid}（https://www.bilibili.com/video/${info.bvid}）`
      : '暂未反查到 BV 号，请留意 /bili/archives 反查结果';
    await this.fire({
      level: info.bvid ? 'info' : 'warn',
      key: `publish-success:${info.taskId}`,
      title: `投稿成功：${info.title}`,
      body:
        `切片《${info.title}》投稿成功，${bvidNote}。` +
        `${info.isOnlySelf ? '当前为「仅自己可见」（试跑期），确认无误后需手动改为公开。' : '已公开。'}` +
        dtimeNote,
      taskId: info.taskId,
      at: nowIso(),
      fields: {
        可见性: info.isOnlySelf ? '仅自己可见' : '公开',
        ...(info.bvid ? { BV号: info.bvid } : {}),
        ...(dtimeMs !== undefined ? { 定时发布: fmtLocal(dtimeMs) } : {}),
      },
    });
  }

  async publishFailed(info: { taskId: string; title: string; reason: string }): Promise<void> {
    await this.fire({
      level: 'error',
      key: `publish-failed:${info.taskId}`,
      title: `投稿失败：${info.title}`,
      body: `切片《${info.title}》投稿失败：${info.reason}\n可从投稿阶段重跑；重跑前请先确认该稿件确实未提交成功（以 /bili/archives 反查为准，避免重复稿件）。`,
      taskId: info.taskId,
      at: nowIso(),
      fields: { 原因: truncate(info.reason, 400).text },
    });
  }

  async failure(info: { taskId?: string; stage: string; message: string; reportPath?: string }): Promise<void> {
    const key = `task-failed:${info.taskId ?? 'global'}:${info.stage}`;
    await this.fire({
      level: 'error',
      key,
      title: `任务失败：${info.stage} 阶段`,
      body: `${info.message}${info.reportPath ? `\n完整错误报告：${info.reportPath}` : ''}\n可用 --from-stage ${info.stage} 从该阶段重跑。`,
      ...(info.taskId ? { taskId: info.taskId } : {}),
      at: nowIso(),
      fields: { 阶段: info.stage, ...(info.reportPath ? { 报告: info.reportPath } : {}) },
    });
  }

  async accountExpiring(info: { uid: number | string; name?: string; expires?: number; daysLeft?: number; expired: boolean }): Promise<void> {
    const expiresMs = toMs(info.expires);
    const days =
      typeof info.daysLeft === 'number'
        ? info.daysLeft
        : expiresMs !== undefined
          ? Math.floor((expiresMs - Date.now()) / 86400_000)
          : undefined;
    const who = info.name ? `${info.name}（uid=${info.uid}）` : `uid=${info.uid}`;
    const expiresNote = expiresMs !== undefined ? `（${fmtLocal(expiresMs)} 到期）` : '';
    await this.fire({
      level: info.expired ? 'error' : 'warn',
      key: info.expired ? `account-expired:${info.uid}` : `account-expiring:${info.uid}`,
      title: info.expired ? `账号登录态已失效：${who}` : `账号即将过期：${who}`,
      body: info.expired
        ? `B 站账号 ${who} 的登录态已失效${expiresNote}，投稿会整批失败。请打开 biliLive-tools → 设置 → 账号重新扫码登录，然后从投稿阶段重跑；恢复后本告警会自动发一条「已恢复」。`
        : `B 站账号 ${who} 的登录态${days !== undefined ? `还有约 ${days} 天` : ''}过期${expiresNote}。请提前到 biliLive-tools 重新登录，避免投稿阶段整批失败。`,
      at: nowIso(),
      fields: {
        账号: who,
        ...(days !== undefined ? { 剩余天数: days } : {}),
        ...(expiresMs !== undefined ? { 到期时间: fmtLocal(expiresMs) } : {}),
      },
    });
  }

  async diskLow(info: { freeGB: number; thresholdGB: number; taskId?: string }): Promise<void> {
    await this.fire({
      level: 'warn',
      key: 'disk-low',
      title: `磁盘剩余空间不足：${info.freeGB} GB`,
      body:
        `数据盘剩余 ${info.freeGB} GB，已低于阈值 ${info.thresholdGB} GB。切片 / 压制可能中途失败或产出不完整。\n` +
        `处理：清理 data/ 下的历史素材与 data/clips 产物，或调小 cleanup.retentionDays；清理到阈值以上后本告警会自动发一条「已恢复」。`,
      ...(info.taskId ? { taskId: info.taskId } : {}),
      at: nowIso(),
      fields: { 剩余GB: info.freeGB, 阈值GB: info.thresholdGB },
    });
  }

  async versionDrift(info: { actual: string; expected: string; note: string }): Promise<void> {
    await this.fire({
      level: 'warn',
      key: 'version-drift',
      title: `biliLive-tools 版本差异：${info.actual} ≠ ${info.expected}`,
      body: `${info.note}\n版本差异大意味着接口字段可能已变动（陷阱 #10/#11 都由此而来），建议先跑 node src/probe.ts 复核全部端点字段名。`,
      at: nowIso(),
      fields: { 实际版本: info.actual, 期望版本: info.expected },
    });
  }

  /* ------------------------------------------------------------------------
   * 恢复通知
   * ---------------------------------------------------------------------- */

  /**
   * 恢复通知：同一 key 之前告警过、现在恢复正常时发一条「已恢复」。
   * 返回 true 表示确实发了恢复通知（之前处于告警态）。
   */
  async recover(key: string, message: string): Promise<boolean> {
    try {
      const entry = this.state.get(key);
      if (!entry) return false;
      // 全局关闭或事件开关被关掉时不再打扰用户，但状态要清掉，否则健康面板会永远挂着一条已恢复的告警
      if (!this.config || this.config.enabled === false || !this.eventEnabled(key)) {
        this.state.delete(key);
        this.saveState();
        return false;
      }
      const payload: AlertPayload = {
        level: 'recover',
        key,
        title: `已恢复：${entry.title || key}`,
        body: message,
        at: nowIso(),
        fields: { 首次告警: entry.since, 累计次数: entry.count },
      };
      const results = await this.dispatch(payload);
      this.state.delete(key);
      this.saveState();
      this.logger.info('告警已恢复', {
        data: { key, since: entry.since, count: entry.count, results },
      });
      return true;
    } catch (e) {
      this.logger.warn('恢复通知发送异常（已忽略，不影响主流程）', { data: { key, error: errText(e) } });
      return false;
    }
  }

  /* ------------------------------------------------------------------------
   * 测试与状态展示
   * ---------------------------------------------------------------------- */

  /** 测试渠道：给 UI「测试」按钮用，返回**可执行的结论** */
  async testChannel(channel: AlertChannelName): Promise<AlertChannelResult> {
    const name = String(channel);
    if (!(CHANNELS as readonly string[]).includes(name)) {
      return result(name, false, `未知告警渠道「${name}」—— 可选：${CHANNELS.join(' / ')}`, 0);
    }
    const payload: AlertPayload = {
      level: 'info',
      key: `test:${name}`,
      title: '【测试】live_auto 告警通道',
      body: `这是一条测试告警（渠道：${name}）。收到即表示该渠道配置可用。`,
      at: nowIso(),
      fields: { 渠道: name, 服务版本: this.appVersion ?? 'unknown' },
    };
    try {
      // 测试必须绕过去重与事件开关：UI「测试」按钮每点一次都要真实发一次
      return await this.sendTo(channel, payload);
    } catch (e) {
      return result(name, false, `测试发送异常：${errText(e)}`, 0);
    }
  }

  /** 去重状态（供健康面板展示） */
  activeAlerts(): Array<{ key: string; level: AlertLevel; since: string; count: number }> {
    return [...this.state.values()]
      .sort((a, b) => a.since.localeCompare(b.since))
      .map((e) => ({ key: e.key, level: e.level, since: e.since, count: e.count }));
  }

  /* ------------------------------------------------------------------------
   * 内部实现
   * ---------------------------------------------------------------------- */

  /** 语义化方法的统一包装：告警失败绝不影响主流程 */
  private async fire(payload: AlertPayload): Promise<void> {
    try {
      await this.send(payload);
    } catch (e) {
      this.logger.warn('告警发送失败（已忽略，不影响主流程）', { data: { key: payload.key, error: errText(e) } });
    }
  }

  private windowSec(): number {
    const v = Number(this.config?.dedupeWindowSec);
    return Number.isFinite(v) && v >= 0 ? v : 900;
  }

  /** 事件开关：key 全名优先，其次按前缀映射到 events 里的开关名；未配置视为开启 */
  private eventEnabled(key: string): boolean {
    const events = this.config?.events ?? {};
    if (Object.prototype.hasOwnProperty.call(events, key)) return events[key] !== false;
    const name = eventNameOf(key);
    if (name && Object.prototype.hasOwnProperty.call(events, name)) return events[name] !== false;
    return true;
  }

  /** 记录本次发生，并判断是否落在去重窗口内 */
  private register(payload: AlertPayload): { suppressed: boolean; count: number } {
    const now = nowIso();
    const cur = this.state.get(payload.key);
    if (!cur) {
      this.state.set(payload.key, {
        key: payload.key,
        level: payload.level,
        title: payload.title,
        since: now,
        lastAt: now,
        count: 1,
      });
      this.saveState();
      return { suppressed: false, count: 1 };
    }
    cur.count += 1;
    cur.lastAt = now;
    cur.level = payload.level;
    cur.title = payload.title;
    const lastSent = cur.lastSentAt ? Date.parse(cur.lastSentAt) : NaN;
    const suppressed = Number.isFinite(lastSent) && Date.now() - lastSent < this.windowSec() * 1000;
    this.saveState();
    return { suppressed, count: cur.count };
  }

  /** 并发发送到所有已配置渠道；每个渠道各自 try/catch，互不拖累 */
  private async dispatch(payload: AlertPayload): Promise<AlertChannelResult[]> {
    const configured = (this.config?.channels ?? []).filter((c): c is AlertChannelName =>
      (CHANNELS as readonly string[]).includes(c),
    );
    if (configured.length === 0) {
      return [result('none', true, '未配置任何告警渠道（alert.channels 为空）：本条只写日志与状态文件，请在 config.json 补充渠道', 0)];
    }
    const settled = await Promise.all(configured.map((c) => this.sendTo(c, payload)));
    for (const r of settled) {
      if (!r.ok) this.logger.warn('告警渠道发送失败', { data: { channel: r.channel, message: r.message, key: payload.key } });
    }
    return settled;
  }

  private async sendTo(channel: AlertChannelName, payload: AlertPayload): Promise<AlertChannelResult> {
    try {
      switch (channel) {
        case 'serverchan':
          return await sendServerChan(this.config.serverchan ?? { sendKey: '' }, payload, this.fetchImpl);
        case 'dingtalk':
          return await sendDingTalk(this.config.dingtalk ?? { webhook: '', secret: '' }, payload, this.fetchImpl);
        case 'telegram':
          return await sendTelegram(this.config.telegram ?? { botToken: '', chatId: '' }, payload, this.fetchImpl);
        case 'webhook':
          return await sendWebhook(this.config.webhook ?? { url: '' }, payload, this.fetchImpl);
        default:
          return result(String(channel), false, `未知告警渠道「${String(channel)}」`, 0);
      }
    } catch (e) {
      // 双保险：渠道函数内部已 try/catch，这里再兜一层，保证 send() 永不 reject
      return result(String(channel), false, `发送异常：${errText(e)}`, 0);
    }
  }

  /** 载入去重状态：进程重启后仍能配对恢复通知（§8 WP6 步骤 4） */
  private loadState(): void {
    const empty: AlertStateFile = { version: 1, updatedAt: '', entries: [] };
    try {
      const raw = readJson<AlertStateFile>(this.statePath, empty);
      for (const e of raw?.entries ?? []) {
        if (!e || typeof e.key !== 'string' || !e.key) continue;
        const entry: AlertStateEntry = {
          key: e.key,
          level: isAlertLevel(e.level) ? e.level : 'warn',
          title: typeof e.title === 'string' && e.title ? e.title : e.key,
          since: typeof e.since === 'string' && e.since ? e.since : nowIso(),
          lastAt: typeof e.lastAt === 'string' && e.lastAt ? e.lastAt : nowIso(),
          count: Number.isFinite(Number(e.count)) && Number(e.count) > 0 ? Number(e.count) : 1,
        };
        if (typeof e.lastSentAt === 'string' && e.lastSentAt) entry.lastSentAt = e.lastSentAt;
        this.state.set(entry.key, entry);
      }
    } catch (e) {
      this.logger.warn('告警状态文件读取失败，按空状态继续（可能多发一次告警）', {
        data: { path: this.statePath, error: errText(e) },
      });
    }
  }

  private saveState(): void {
    try {
      const file: AlertStateFile = { version: 1, updatedAt: nowIso(), entries: [...this.state.values()] };
      // 原子写：UI 面板可能正在读这个文件，半截 JSON 会让健康面板整块报错
      writeJsonAtomic(this.statePath, file, 2);
    } catch (e) {
      // 状态写不进去只影响「重启后能否配对恢复通知」，绝不阻断告警发送
      this.logger.warn('告警状态文件写入失败（不影响告警发送）', {
        data: { path: this.statePath, error: errText(e) },
      });
    }
  }
}
