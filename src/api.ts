/**
 * biliLive-tools HTTP API 统一客户端（任务书 §4 / WP1）。
 *
 * 职责边界（硬约束 #1）：只调用 HTTP API，不修改、不 fork biliLive-tools。
 *
 * 关键实现点：
 *  - 鉴权：header `Authorization: <passKey>`（`http/src/index.ts:47`），也支持 `?auth=`
 *  - 超时可配：ASR 接口是同步阻塞的，必须用长超时（§4.2）
 *  - 重试：网络抖动 / 5xx / 超时可重试；4xx（含 401）不重试，避免打爆对方
 *  - 日志脱敏：Authorization / passKey / cookie / API Key 一律不出现在日志里（硬约束 #8、陷阱 #33）
 *  - 请求上下文留痕：供错误报告使用（§8 WP6 步骤 10），响应体 >4KB 截断并记录原始长度
 */
import type {
  ArchiveDetail,
  ArchiveItem,
  BiliUploadResponse,
  BiliUser,
  DanmaFileRef,
  DanmuPreset,
  FfmpegPreset,
  RecordHistoryFile,
  RecordHistoryListItem,
  RecentClip,
  TaskDetail,
  TaskListResponse,
  VideoPreset,
} from './types.ts';
import type { AppConfig } from './config.ts';
import type { ErrorType, RequestContext, RetryAttempt } from './types.ts';
import { backoffMs, sleep, truncate } from './util.ts';
import { log as globalLog, type Logger } from './logger.ts';

/* ============================================================================
 * 错误类型
 * ========================================================================== */

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly type: ErrorType;
  /** 是否值得重试 */
  readonly retryable: boolean;
  readonly request?: RequestContext;
  readonly attempts: RetryAttempt[];

  constructor(
    message: string,
    opts: {
      type?: ErrorType;
      retryable?: boolean;
      request?: RequestContext;
      attempts?: RetryAttempt[];
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.type = opts.type ?? 'internal';
    this.retryable = opts.retryable ?? false;
    if (opts.request) this.request = opts.request;
    this.attempts = opts.attempts ?? [];
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** 把 HTTP 状态码映射到错误类型与可执行结论 */
function classifyStatus(status: number, path: string, bodyText: string): { type: ErrorType; retryable: boolean; hint: string } {
  if (status === 401 || status === 403) {
    return {
      type: 'auth',
      retryable: false,
      hint:
        `鉴权失败（HTTP ${status}）。按以下顺序排查：\n` +
        `  1. 直接跑 \`node tools/init-config.mjs\` —— 它会从 biliLive-tools 的配置里重新读取 PassKey 并写回 config.json（最省事）\n` +
        `  2. 确认 config.json 的 bililive.passKey 与 biliLive-tools「设置 → 服务」里的 PassKey **完全一致**（注意别漏字符、别多空格）\n` +
        `  3. 若刚从别的机器/备份恢复过配置，PassKey 很可能已被截断 —— 用 \`node src/cli.ts selfcheck\` 能看到长度检查结果`,
    };
  }
  if (status === 404) {
    return {
      type: 'http-status',
      retryable: false,
      hint: `接口不存在（HTTP 404：${path}）—— biliLive-tools 版本可能已变动，请用 probe.ts 复核接口（§4.6）`,
    };
  }
  if (status === 429) {
    return { type: 'http-status', retryable: true, hint: '被限流（HTTP 429），退避后重试' };
  }
  if (status >= 500) {
    // §4.2：/ai/subtitle 失败返回 HTTP 500 { error: "..." }
    const detail = bodyText ? ` —— ${bodyText.slice(0, 300)}` : '';
    return {
      type: 'http-status',
      retryable: true,
      hint: `biliLive-tools 内部错误（HTTP ${status}）${detail}`,
    };
  }
  return { type: 'http-status', retryable: false, hint: `HTTP ${status}${bodyText ? ` —— ${bodyText.slice(0, 300)}` : ''}` };
}

/* ============================================================================
 * 客户端
 * ========================================================================== */

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** query 参数（自动 URL 编码；undefined/null 跳过） */
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** 覆盖超时（毫秒）。ASR 必须传长超时 */
  timeoutMs?: number;
  /** 覆盖重试次数 */
  retry?: number;
  /** 返回原始文本而不解析 JSON */
  rawText?: boolean;
  /** 不写常规日志（用于高频轮询） */
  quiet?: boolean;
  /** 日志用标签，例如 'asr' / 'cut' */
  tag?: string;
  /** 调用方自带的 logger 上下文 */
  logger?: Logger;
  /** 本次请求的语义说明，错误报告里更好读 */
  purpose?: string;
  /** 外部传入的 AbortSignal（用于取消） */
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  baseUrl: string;
  passKey: string;
  timeoutMs?: number;
  asrTimeoutMs?: number;
  retry?: number;
  logger?: Logger;
}

export class BiliLiveClient {
  baseUrl: string;
  private passKey: string;
  private timeoutMs: number;
  private asrTimeoutMs: number;
  private retry: number;
  private logger: Logger;
  /** 最近一次成功的版本号（供健康面板与错误报告使用） */
  private versionCache?: { version: string; at: number };

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.passKey = opts.passKey;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.asrTimeoutMs = opts.asrTimeoutMs ?? 1800000;
    this.retry = opts.retry ?? 3;
    this.logger = opts.logger ?? globalLog;
  }

  static fromConfig(cfg: AppConfig, logger?: Logger): BiliLiveClient {
    return new BiliLiveClient({
      baseUrl: cfg.bililive.baseUrl,
      passKey: cfg.bililive.passKey,
      timeoutMs: cfg.bililive.timeoutMs,
      asrTimeoutMs: cfg.bililive.asrTimeoutMs,
      retry: cfg.bililive.retry,
      ...(logger ? { logger } : {}),
    });
  }

  /** 配置热加载后更新凭据与地址 */
  update(opts: Partial<ApiClientOptions>): void {
    if (opts.baseUrl) this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    if (opts.passKey !== undefined) this.passKey = opts.passKey;
    if (opts.timeoutMs !== undefined) this.timeoutMs = opts.timeoutMs;
    if (opts.asrTimeoutMs !== undefined) this.asrTimeoutMs = opts.asrTimeoutMs;
    if (opts.retry !== undefined) this.retry = opts.retry;
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /**
   * 底层请求：鉴权、超时、重试、脱敏日志、错误报告上下文。
   * 所有对外方法都必须经过这里，禁止在别处直接 fetch。
   */
  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? 'GET';
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const maxAttempts = Math.max(1, (opts.retry ?? this.retry) + 1);
    const url = this.buildUrl(path, opts.query);
    const attempts: RetryAttempt[] = [];
    const logger = opts.logger ?? this.logger;
    const tag = opts.tag ? `[${opts.tag}] ` : '';

    let lastError: ApiError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      const onOuterAbort = (): void => controller.abort(new Error('aborted'));
      opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

      const requestCtx: RequestContext = {
        method,
        url,
        params: opts.body,
      };

      try {
        const headers: Record<string, string> = {
          Authorization: this.passKey,
          Accept: 'application/json',
        };
        let payload: string | undefined;
        if (opts.body !== undefined) {
          headers['Content-Type'] = 'application/json';
          payload = JSON.stringify(opts.body);
        }

        if (!opts.quiet && attempt === 1) {
          logger.debug(`${tag}→ ${method} ${path}${opts.purpose ? ` (${opts.purpose})` : ''}`, { data: opts.body });
        }

        const res = await fetch(url, {
          method,
          headers,
          ...(payload !== undefined ? { body: payload } : {}),
          signal: controller.signal,
        });

        const text = await res.text();
        const elapsed = Date.now() - started;
        requestCtx.status = res.status;
        requestCtx.durationMs = elapsed;

        const t = truncate(text, 4096);
        requestCtx.responseBody = t.text;
        requestCtx.responseTruncated = t.truncated;
        requestCtx.responseOriginalLength = t.originalLength;

        if (!res.ok) {
          const cls = classifyStatus(res.status, path, text);
          const err = new ApiError(cls.hint, {
            type: cls.type,
            retryable: cls.retryable,
            request: requestCtx,
            attempts: [...attempts],
          });
          if (!cls.retryable || attempt === maxAttempts) {
            if (!opts.quiet) logger.error(`${tag}✗ ${method} ${path}`, err, { data: { status: res.status, purpose: opts.purpose } });
            throw err;
          }
          attempts.push({
            attempt,
            at: new Date().toISOString(),
            type: cls.type,
            message: cls.hint,
          });
          const wait = backoffMs(attempt);
          if (!opts.quiet) logger.warn(`${tag}↻ ${method} ${path} 第 ${attempt} 次失败，${wait}ms 后重试：${cls.hint}`);
          await sleep(wait);
          continue;
        }

        if (opts.rawText) return text as unknown as T;
        if (text.trim() === '') return undefined as unknown as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          // 少数端点直接返回字符串（如 /common/version）
          return text as unknown as T;
        }
      } catch (e) {
        const elapsed = Date.now() - started;
        requestCtx.durationMs = elapsed;
        if (e instanceof ApiError) {
          lastError = e;
          if (!e.retryable) throw e;
          if (attempt === maxAttempts) throw e;
          continue;
        }
        const isAbort = controller.signal.aborted;
        const isTimeout = isAbort && !opts.signal?.aborted;
        const type: ErrorType = isTimeout ? 'timeout' : 'network';
        const msg = isTimeout
          ? `请求超时（${timeoutMs}ms）：${method} ${path}`
          : `网络错误：${method} ${path} —— ${(e as Error).message}`;
        const err = new ApiError(msg, {
          type,
          retryable: true,
          request: requestCtx,
          attempts: [...attempts],
          cause: e,
        });
        if (opts.signal?.aborted) throw new ApiError(`请求被取消：${method} ${path}`, { type: 'internal', retryable: false, request: requestCtx });
        if (attempt === maxAttempts) {
          if (!opts.quiet) logger.error(`${tag}✗ ${method} ${path}`, err);
          throw err;
        }
        attempts.push({ attempt, at: new Date().toISOString(), type, message: msg });
        const wait = backoffMs(attempt);
        if (!opts.quiet) logger.warn(`${tag}↻ ${method} ${path} 第 ${attempt} 次失败，${wait}ms 后重试：${msg}`);
        await sleep(wait);
        lastError = err;
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onOuterAbort);
      }
    }
    throw lastError ?? new ApiError(`请求失败：${method} ${path}`, { type: 'internal' });
  }

  /* ------------------------------------------------------------------------
   * 连通性与版本
   * ---------------------------------------------------------------------- */

  /**
   * GET /common/version —— 连通性探测（需鉴权）。
   * 记录版本号；与期望版本差异大时告警「接口可能变动」（§4.6）。
   */
  async version(): Promise<string> {
    const v = await this.request<string>('/common/version', { purpose: '连通性探测' });
    const version = typeof v === 'string' ? v : String((v as { version?: string })?.version ?? v);
    this.versionCache = { version, at: Date.now() };
    return version;
  }

  /**
   * 版本漂移检查。返回 null 表示无漂移。
   * 语义：只比较主次版本；补丁号差异不告警（避免噪声）。
   */
  async checkVersionDrift(expected: string): Promise<{ actual: string; expected: string; drift: boolean; note: string } | null> {
    let actual: string;
    try {
      actual = await this.version();
    } catch {
      return null;
    }
    const norm = (s: string): number[] => s.split(/[.\-+]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
    const a = norm(actual);
    const b = norm(expected);
    const majorMinorDiff = a[0] !== b[0] || a[1] !== b[1];
    return {
      actual,
      expected,
      drift: majorMinorDiff,
      note: majorMinorDiff
        ? `biliLive-tools 版本 ${actual} 与任务书核实的 ${expected} 主次版本不同，接口字段可能已变动，请跑 probe.ts 复核`
        : `版本 ${actual} 与核实的 ${expected} 兼容（补丁号差异不影响接口契约）`,
    };
  }

  get cachedVersion(): string | undefined {
    return this.versionCache?.version;
  }

  /* ------------------------------------------------------------------------
   * 录制历史（§4.1）—— 触发链路的核心
   * ---------------------------------------------------------------------- */

  /**
   * GET /record-history/recent-clips —— 最多返回 5 条。
   *
   * ⚠️ 陷阱 #1：platform 必须传 "Bilibili"（首字母大写）。传错**静默返回空数组**。
   * ⚠️ 前置条件：目标直播间必须在 streamer 表中有记录，否则同样静默空数组（陷阱 #2）。
   */
  async recentClips(roomId: string, platform = 'Bilibili', logger?: Logger): Promise<RecentClip[]> {
    const res = await this.request<{ code?: number; data?: RecentClip[] } | RecentClip[]>('/record-history/recent-clips', {
      query: { room_id: roomId, platform },
      purpose: '感知录制完成',
      tag: 'trigger',
      ...(logger ? { logger } : {}),
    });
    const data = Array.isArray(res) ? res : (res?.data ?? []);
    return Array.isArray(data) ? data : [];
  }

  /**
   * GET /record-history/list —— 分页补漏（启动时 + 每小时对账）。
   *
   * ⚠️ 陷阱 #32：startTime / endTime 单位是**毫秒**（与 record_start_time 一致），传秒会得到错误结果。
   * ⚠️ 陷阱 #10：data 字段是**下划线风格**，与 recent-clips 的驼峰字段名不一致。
   */
  async recordHistoryList(params: {
    roomId: string;
    platform?: string;
    page?: number;
    pageSize?: number;
    /** 毫秒时间戳 */
    startTime?: number;
    endTime?: number;
  }): Promise<{ list: RecordHistoryListItem[]; total: number; page: number; pageSize: number }> {
    const res = await this.request<{
      code?: number;
      data?: RecordHistoryListItem[];
      pagination?: { total?: number; page?: number; pageSize?: number };
    }>('/record-history/list', {
      query: {
        room_id: params.roomId,
        platform: params.platform ?? 'Bilibili',
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 50,
        // 单位毫秒 —— 见陷阱 #32
        ...(params.startTime !== undefined ? { startTime: params.startTime } : {}),
        ...(params.endTime !== undefined ? { endTime: params.endTime } : {}),
      },
      purpose: '分页补漏 / 对账',
      tag: 'trigger',
    });
    const data = Array.isArray(res) ? res : (res?.data ?? []);
    const pag = res && !Array.isArray(res) ? res.pagination : undefined;
    return {
      list: Array.isArray(data) ? data : [],
      total: pag?.total ?? (Array.isArray(data) ? data.length : 0),
      page: pag?.page ?? params.page ?? 1,
      pageSize: pag?.pageSize ?? params.pageSize ?? 50,
    };
  }

  /** GET /record-history/file/:id */
  async recordHistoryFile(id: string): Promise<RecordHistoryFile> {
    const res = await this.request<{ code?: number; data?: RecordHistoryFile } | RecordHistoryFile>(
      `/record-history/file/${encodeURIComponent(id)}`,
      { purpose: '读取录制文件信息', tag: 'trigger' },
    );
    return (Array.isArray(res) ? res[0] : ((res as { data?: RecordHistoryFile })?.data ?? (res as RecordHistoryFile))) ?? {};
  }

  /**
   * POST /record-history/danma-file
   * 用视频绝对路径直接查弹幕文件，无需 id。
   * danmaFilePath 优先返回 .ass，其次 .xml（用 danmaFileExt 判断，§4.1）。
   */
  async danmaFileByVideoPath(videoFilePath: string): Promise<DanmaFileRef> {
    const res = await this.request<{ code?: number; data?: DanmaFileRef } | DanmaFileRef>('/record-history/danma-file', {
      method: 'POST',
      body: { videoFilePath },
      purpose: '查询弹幕文件',
      tag: 'trigger',
      retry: 1,
    });
    return (Array.isArray(res) ? res[0] : ((res as { data?: DanmaFileRef })?.data ?? (res as DanmaFileRef))) ?? {};
  }

  /* ------------------------------------------------------------------------
   * 转写（§4.2）
   * ---------------------------------------------------------------------- */

  /**
   * POST /ai/subtitle —— 同步阻塞接口。
   *
   * ⚠️ 硬约束 #7 / 陷阱 #4：startTime 与 endTime **必须成对提供**，
   *    只传其一时会被忽略，接口按**整个文件**处理，成本与耗时失控。
   * ⚠️ 陷阱 #3：源码中 disableCache: true，每次都是真实 ASR 请求，**重复调试重复计费**，
   *    因此调用方必须自己落盘缓存（见 asr.ts）。
   * ⚠️ 本方法不做自动重试由调用方控制更细（要记录重试历史），故 retry=0 默认。
   */
  async subtitle(params: {
    file: string;
    modelId?: string;
    /** 秒，相对该文件起点 */
    startTime?: number;
    /** 秒，相对该文件起点 */
    endTime?: number;
    /** 输出时间戳 = 音频内时间 + offset */
    offset?: number;
    song?: boolean;
    timeoutMs?: number;
    retry?: number;
  }): Promise<string> {
    const hasStart = params.startTime !== undefined && params.startTime !== null;
    const hasEnd = params.endTime !== undefined && params.endTime !== null;
    if (hasStart !== hasEnd) {
      throw new ApiError(
        'startTime 与 endTime 必须成对提供 —— 只传其一时接口会按整个文件处理，成本与耗时失控（§4.2）',
        { type: 'contract', retryable: false },
      );
    }
    const body: Record<string, unknown> = { file: params.file };
    if (params.modelId) body.modelId = params.modelId;
    if (hasStart) body.startTime = params.startTime;
    if (hasEnd) body.endTime = params.endTime;
    if (params.offset !== undefined) body.offset = params.offset;
    // song 留空或 false：字幕识别会主动过滤音乐片段（§4.2）
    body.song = params.song ?? false;

    const res = await this.request<{ srt?: string; error?: string } | string>('/ai/subtitle', {
      method: 'POST',
      body,
      timeoutMs: params.timeoutMs ?? this.asrTimeoutMs,
      retry: params.retry ?? 0,
      tag: 'asr',
      purpose: `转写 ${params.startTime ?? 0}s–${params.endTime ?? '末尾'}s`,
    });
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object' && typeof res.srt === 'string') return res.srt;
    const errMsg = (res as { error?: string })?.error;
    throw new ApiError(`ASR 返回结构异常${errMsg ? `：${errMsg}` : ''}`, { type: 'asr-failed', retryable: false });
  }

  /* ------------------------------------------------------------------------
   * 切片与任务（§4.3 / §4.6）
   * ---------------------------------------------------------------------- */

  /**
   * POST /task/cut
   *
   * ⚠️ 陷阱 #6：output **必须传绝对路径** —— 源码中只有当 output 不是绝对路径时
   *    才会用 saveType/savePath 拼路径（shared/src/task/video.ts:1122-1129）。
   * ⚠️ 硬约束 #5：切片必须重编码，禁止 stream copy（两个原因见 §4.3）。
   *    本方法会主动拒绝 copy 编码器。
   */
  async cut(params: {
    videoFilePath: string;
    assFilePath?: string;
    output: string;
    /** ffmpegOptions：来自 /preset/ffmpeg 叠加 ss/to */
    ffmpegOptions: Record<string, unknown>;
    saveType?: number;
    savePath?: string;
    /** 不传 srtContent（§4.3 首版不使用） */
  }): Promise<{ taskId: string }> {
    if (!isAbsolutePath(params.output)) {
      throw new ApiError(
        `output 必须是绝对路径（收到 "${params.output}"）—— 传相对名时调用方无法预知最终路径，后续上传无从指定文件（陷阱 #6）`,
        { type: 'contract', retryable: false },
      );
    }
    const ss = Number(params.ffmpegOptions['ss']);
    const to = Number(params.ffmpegOptions['to']);
    if (!Number.isFinite(ss) || !Number.isFinite(to) || to <= ss) {
      throw new ApiError(`ffmpegOptions 的 ss/to 不合法：ss=${params.ffmpegOptions['ss']} to=${params.ffmpegOptions['to']}`, {
        type: 'contract',
        retryable: false,
      });
    }
    // 硬约束 #5：禁止 stream copy
    const encoder = params.ffmpegOptions['c:v'] ?? params.ffmpegOptions['vcodec'] ?? params.ffmpegOptions['codec'];
    if (typeof encoder === 'string' && encoder.trim().toLowerCase() === 'copy') {
      throw new ApiError(
        '切片编码器为 copy —— 禁止 stream copy：① 只能切关键帧，开头会花屏/黑帧；② -copyts 只在重编码时添加，弹幕会整体错位（§4.3、硬约束 #5）',
        { type: 'contract', retryable: false },
      );
    }

    const files: Record<string, string> = { videoFilePath: params.videoFilePath };
    // 烧弹幕：可以传整场 ASS，不需要预先裁剪（§4.3）
    if (params.assFilePath) files['assFilePath'] = params.assFilePath;

    const res = await this.request<{ taskId?: string } | string>('/task/cut', {
      method: 'POST',
      body: {
        files,
        output: params.output,
        ffmpegOptions: params.ffmpegOptions,
        options: { saveType: params.saveType ?? 2, ...(params.savePath ? { savePath: params.savePath } : {}) },
      },
      tag: 'cut',
      purpose: `切割 ${ss}s–${to}s`,
    });
    const taskId = typeof res === 'string' ? res : res?.taskId;
    if (!taskId) throw new ApiError('POST /task/cut 未返回 taskId', { type: 'contract', retryable: false });
    return { taskId };
  }

  /**
   * POST /task/convertXml2Ass —— 弹幕 XML → ASS（烧弹幕前置步骤）。
   *
   * ⚠️ 实测：`preset` **必填**（弹幕样式预设）。不传会得到
   * `HTTP 400 preset is required`，而不是「用默认值」。
   * 因此这里在调用方没给 preset 时**自动读取 `/preset/danmu` 的第一条**兜底。
   */
  async convertXml2Ass(params: {
    input: string;
    output: string;
    preset?: unknown;
    options?: { sync?: boolean };
  }): Promise<{ taskId?: string }> {
    let preset = params.preset;
    if (preset === undefined) {
      try {
        const list = await this.presetDanmu();
        preset = list[0]?.config ?? list[0] ?? {};
        if (list.length === 0) {
          throw new ApiError(
            'convertXml2Ass 需要 preset，但 biliLive-tools 里没有任何弹幕样式预设 —— 请先在它的「设置 → 弹幕」中创建一个',
            { type: 'contract', retryable: false },
          );
        }
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError(`convertXml2Ass 需要 preset，但读取 /preset/danmu 失败：${(e as Error).message}`, {
          type: 'http-status',
          retryable: false,
        });
      }
    }
    const res = await this.request<{ taskId?: string }>('/task/convertXml2Ass', {
      method: 'POST',
      body: {
        input: params.input,
        output: params.output,
        preset,
        options: params.options ?? { sync: true },
      },
      tag: 'cut',
      purpose: '弹幕 XML 转 ASS',
    });
    return res ?? {};
  }

  /**
   * GET /task/?type=&status=&page=&pageSize= —— 含 runningTaskNum（并发控制）
   *
   * `timeoutMs`：监控面板会周期性看一眼"它在压制/上传什么"，
   * 这种**顺路查询**绝不能让面板卡住，所以调用方可以传一个很短的超时。
   */
  async taskList(params: { type?: string; status?: string; page?: number; pageSize?: number; timeoutMs?: number } = {}): Promise<TaskListResponse> {
    const res = await this.request<TaskListResponse | TaskListResponse['list']>('/task/', {
      query: {
        ...(params.type ? { type: params.type } : {}),
        ...(params.status ? { status: params.status } : {}),
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 50,
      },
      quiet: true,
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      purpose: '任务列表 / 并发控制',
    });
    if (Array.isArray(res)) return { list: res, runningTaskNum: res.filter((t) => t.status === 'running').length };
    return res ?? {};
  }

  /** GET /task/:id —— 单任务状态轮询 */
  async taskDetail(taskId: string, opts: { quiet?: boolean } = {}): Promise<TaskDetail> {
    const res = await this.request<TaskDetail | { data?: TaskDetail }>(`/task/${encodeURIComponent(taskId)}`, {
      quiet: opts.quiet ?? true,
      retry: 1,
      purpose: '任务状态轮询',
    });
    const detail = (res as { data?: TaskDetail })?.data ?? (res as TaskDetail);
    if (!detail || typeof detail !== 'object') {
      throw new ApiError(`GET /task/${taskId} 返回结构异常`, { type: 'contract', retryable: false });
    }
    return detail;
  }

  /** POST /task/:id/kill */
  async taskKill(taskId: string): Promise<void> {
    await this.request(`/task/${encodeURIComponent(taskId)}/kill`, { method: 'POST', tag: 'task', purpose: '终止任务' });
  }

  /** POST /task/:id/restart */
  async taskRestart(taskId: string): Promise<void> {
    await this.request(`/task/${encodeURIComponent(taskId)}/restart`, { method: 'POST', tag: 'task', purpose: '重启任务' });
  }

  /** POST /task/cutSubtitle —— 为每个片段单独导出 .srt（首版不用于投稿，仅供人工） */
  async cutSubtitle(params: {
    srtContent: string;
    segments: Array<{ start: number; end: number; name: string }>;
    saveType?: number;
    savePath?: string;
    videoPath: string;
  }): Promise<unknown> {
    return this.request('/task/cutSubtitle', { method: 'POST', body: params, tag: 'task', purpose: '导出片段字幕' });
  }

  /* ------------------------------------------------------------------------
   * 投稿（§4.4 / §4.6）
   * ---------------------------------------------------------------------- */

  /**
   * POST /bili/upload
   *
   * ⚠️ 陷阱 #11：返回 `{ taskId }` 而非稿件 id。任务队列在内存中、进程重启即丢，
   *    **不能只靠 taskId 去重**；最终 bvid 必须用 GET /bili/archives 按标题反查。
   */
  async biliUpload(params: {
    uid: number | string;
    /** string[] 或 { path, title? }[] */
    videos: Array<string | { path: string; title?: string }>;
    config: Record<string, unknown>;
    vid?: string;
    options?: Record<string, unknown>;
  }): Promise<BiliUploadResponse> {
    const res = await this.request<BiliUploadResponse | { taskId?: string } | string>('/bili/upload', {
      method: 'POST',
      body: {
        uid: params.uid,
        videos: params.videos,
        config: params.config,
        ...(params.vid ? { vid: params.vid } : {}),
        ...(params.options ? { options: params.options } : {}),
      },
      tag: 'publish',
      purpose: `投稿 ${params.videos.length} 个视频`,
      retry: 1, // 投稿不轻易重试，避免重复稿件
    });
    const taskId = typeof res === 'string' ? res : res?.taskId;
    if (!taskId) throw new ApiError('POST /bili/upload 未返回 taskId', { type: 'contract', retryable: false });
    return { taskId };
  }

  /**
   * GET /bili/archives —— 已投稿件列表。
   * 这是**幂等校验与 bvid 反查的唯一可靠来源**（一查三用，§8 WP5 步骤 1）。
   *
   * ⚠️ 实测（v3.21.0）：稿件列表在 **`arc_audits[].Archive`**，而不是 `list` / `data` / `archives`
   * （`archives` 字段实际是 `null`）。每个元素形如：
   *   `{ Archive: { aid, bvid, title, cover, state, ... }, stat: {...}, ... }`
   * 只按 `list`/`data` 找会**静默拿到空数组**，导致幂等失效、bvid 永远反查不到。
   */
  async biliArchives(
    params: { page?: number; pageSize?: number; uid?: number | string; keyword?: string; timeoutMs?: number } = {},
  ): Promise<ArchiveItem[]> {
    const res = await this.request<
      | ArchiveItem[]
      | {
          list?: ArchiveItem[];
          data?: ArchiveItem[] | { list?: ArchiveItem[] };
          archives?: ArchiveItem[] | null;
          arc_audits?: Array<{ Archive?: ArchiveItem }>;
        }
    >('/bili/archives', {
      query: {
        ...(params.page ? { page: params.page } : {}),
        ...(params.pageSize ? { pageSize: params.pageSize } : {}),
        // 实测分页参数用 pn/ps（与 page/pageSize 并不冲突，两个都带上更保险）
        ...(params.page ? { pn: params.page } : {}),
        ...(params.pageSize ? { ps: params.pageSize } : {}),
        ...(params.uid ? { uid: params.uid } : {}),
        ...(params.keyword ? { keyword: params.keyword } : {}),
      },
      purpose: '稿件反查（幂等 / bvid）',
      tag: 'publish',
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    });

    if (Array.isArray(res)) return res;
    const r = res as {
      list?: ArchiveItem[];
      data?: ArchiveItem[] | { list?: ArchiveItem[] };
      archives?: ArchiveItem[] | null;
      arc_audits?: Array<{ Archive?: ArchiveItem }>;
    };

    // ★ 首要路径：arc_audits[].Archive（实测结构）
    if (Array.isArray(r?.arc_audits)) {
      return r.arc_audits
        .map((x) => x?.Archive)
        .filter((a): a is ArchiveItem => Boolean(a && (a.bvid || a.title)));
    }
    if (Array.isArray(r?.list)) return r.list;
    if (Array.isArray(r?.archives)) return r.archives;
    if (Array.isArray(r?.data)) return r.data;
    if (r?.data && Array.isArray((r.data as { list?: ArchiveItem[] }).list)) return (r.data as { list: ArchiveItem[] }).list;
    return [];
  }

  /**
   * GET /bili/user/archive/:bvid —— 单稿件详情，稿件表现数据回流的来源（§8 WP6 步骤 11）。
   *
   * `retry` 可显式设为 0：体检这类"查不到就算了"的场景不需要退避重试，
   * 否则「定时发布未到点」的稿件会让接口连试 3 次、整体耗时 30 秒以上。
   */
  async biliArchiveDetail(bvid: string, opts: { retry?: number } = {}): Promise<ArchiveDetail> {
    const res = await this.request<ArchiveDetail | { data?: ArchiveDetail }>(`/bili/user/archive/${encodeURIComponent(bvid)}`, {
      purpose: '稿件表现数据回流',
      tag: 'perf',
      ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
    });
    return ((res as { data?: ArchiveDetail })?.data ?? (res as ArchiveDetail)) ?? {};
  }

  /* ------------------------------------------------------------------------
   * 账号（§4.6）
   * ---------------------------------------------------------------------- */

  /**
   * GET /user/list —— 已登录账号，`uid` 是投稿必填项，`expires` 用于有效期检查。
   * ⚠️ `/user/export` 会输出含 cookie 的原始数据，**禁止调用、禁止落盘**。
   *
   * 文档写返回数组，实测可能返回单个对象，两种都兼容。
   */
  async userList(): Promise<BiliUser[]> {
    const res = await this.request<BiliUser[] | BiliUser | { data?: BiliUser[] | BiliUser }>('/user/list', {
      purpose: '账号有效性检查',
      tag: 'account',
    });
    let arr: unknown = res;
    if (res && !Array.isArray(res) && typeof res === 'object' && 'data' in res) {
      arr = (res as { data?: unknown }).data;
    }
    if (Array.isArray(arr)) return arr as BiliUser[];
    if (arr && typeof arr === 'object' && 'uid' in (arr as object)) return [arr as BiliUser];
    return [];
  }

  /** 取投稿用 uid（取第一个账号） */
  async primaryUid(): Promise<BiliUser | undefined> {
    const users = await this.userList();
    return users[0];
  }

  /* ------------------------------------------------------------------------
   * 预设（§4.5）
   * ---------------------------------------------------------------------- */

  private unwrapList<T>(res: unknown): T[] {
    if (Array.isArray(res)) return res as T[];
    const r = res as { data?: unknown; list?: unknown };
    if (Array.isArray(r?.data)) return r.data as T[];
    if (Array.isArray(r?.list)) return r.list as T[];
    if (r?.data && Array.isArray((r.data as { list?: unknown }).list)) return (r.data as { list: T[] }).list;
    return [];
  }

  /** GET /preset/ffmpeg —— 取其中一条的 config 作为 ffmpegOptions 基础，叠加 ss/to */
  async presetFfmpeg(): Promise<FfmpegPreset[]> {
    const res = await this.request<unknown>('/preset/ffmpeg', { purpose: '读取 ffmpeg 预设', tag: 'preset' });
    return this.unwrapList<FfmpegPreset>(res);
  }

  /** GET /preset/video —— 投稿预设 */
  async presetVideo(): Promise<VideoPreset[]> {
    const res = await this.request<unknown>('/preset/video', { purpose: '读取投稿预设', tag: 'preset' });
    return this.unwrapList<VideoPreset>(res);
  }

  /** GET /preset/danmu —— 弹幕样式预设 */
  async presetDanmu(): Promise<DanmuPreset[]> {
    const res = await this.request<unknown>('/preset/danmu', { purpose: '读取弹幕预设', tag: 'preset' });
    return this.unwrapList<DanmuPreset>(res);
  }

  /* ------------------------------------------------------------------------
   * 其它（§4.6 / §4.7）
   * ---------------------------------------------------------------------- */

  /**
   * GET /common/getLogContent —— 读取 biliLive-tools **自身的日志文件内容**。
   * 错误报告用它附带对方侧日志片段：切片/压制失败的 ffmpeg 报错在那边（§8 WP6 步骤 10）。
   */
  async getLogContent(maxBytes = 200 * 1024, opts: { quiet?: boolean } = {}): Promise<string> {
    try {
      const text = await this.request<string>('/common/getLogContent', {
        rawText: true,
        quiet: opts.quiet ?? true,
        retry: 0,
        timeoutMs: 10000,
        purpose: '读取对方侧日志（错误报告）',
        tag: 'diag',
      });
      const s = typeof text === 'string' ? text : JSON.stringify(text);
      return s.length > maxBytes ? s.slice(-maxBytes) : s;
    } catch {
      // 取不到对方日志不是致命错误，报告里留空即可
      return '';
    }
  }

  /** POST /common/readDanma —— 读 ass/xml/srt 内容 */
  async readDanma(filepath: string): Promise<string> {
    const res = await this.request<string | { content?: string }>('/common/readDanma', {
      method: 'POST',
      body: { filepath },
      tag: 'danmaku',
      purpose: '读取弹幕文件内容',
      timeoutMs: 60000,
    });
    if (typeof res === 'string') return res;
    return res?.content ?? '';
  }

  /**
   * POST /common/writeLLC —— 写 lossless-cut 项目文件（content 必须含 cutSegments）。
   *
   * ⚠️ 两个**实测**出来的硬性要求（猜错会得到 HTTP 500）：
   *   1. `content` 必须是 **JSON 字符串**，不能是对象 ——
   *      对方实现里对 content 调用了 `.includes()`，传对象会报
   *      `content.includes is not a function`。
   *   2. `filepath` 必须是**绝对路径** —— 相对路径会被解析到 biliLive-tools
   *      自己的工作目录（实测落到了 `C:\WINDOWS\system32\...`），而不是本项目目录。
   */
  async writeLLC(filepath: string, content: unknown): Promise<void> {
    if (!content || typeof content !== 'object' || !('cutSegments' in (content as object))) {
      throw new ApiError('writeLLC 的 content 必须包含 cutSegments 字段（§4.6）', { type: 'contract', retryable: false });
    }
    if (!isAbsolutePath(filepath)) {
      throw new ApiError(
        `writeLLC 的 filepath 必须是绝对路径（收到 "${filepath}"）—— 相对路径会被写到 biliLive-tools 自己的工作目录，而不是本项目目录`,
        { type: 'contract', retryable: false },
      );
    }
    await this.request('/common/writeLLC', {
      method: 'POST',
      body: { filepath, content: JSON.stringify(content) },
      tag: 'llc',
      purpose: '写出 .llc 项目文件',
    });
  }

  /** POST /common/readLLC */
  async readLLC(filepath: string): Promise<unknown> {
    return this.request('/common/readLLC', { method: 'POST', body: { filepath }, tag: 'llc', purpose: '读取 .llc' });
  }

  /**
   * GET /config —— WP1 确认项：ffmpeg 二进制路径（二期封面抽帧要用）。
   * 返回原始对象，由 probe 记录。
   */
  async getConfig(): Promise<unknown> {
    return this.request('/config', { purpose: '读取 biliLive-tools 配置', tag: 'preset', retry: 0 });
  }

  /**
   * 直播间开播状态 —— 用于「下播确认」（§8 WP2 步骤 3、硬约束 #19）。
   *
   * ⚠️ biliLive-tools 未提供稳定的公开 HTTP 端点用于查询 live_status，
   *    因此优先尝试若干候选端点；全部不可用时返回 undefined，
   *    由 trigger.ts 退化为「同 live_id 全部录制段落关闭 + record_end_time 超窗」判定。
   * 这里不猜测端点语义，只做存在性探测并把结果留给调用方判断。
   */
  async liveStatus(roomId: string): Promise<{ live: boolean; raw: unknown } | undefined> {
    const candidates = [
      { path: '/record/status', query: { room_id: roomId } },
      { path: `/record/${encodeURIComponent(roomId)}/status`, query: {} },
      { path: '/streamer/status', query: { room_id: roomId } },
    ];
    for (const c of candidates) {
      try {
        const raw = await this.request<unknown>(c.path, { query: c.query, quiet: true, retry: 0, timeoutMs: 5000, purpose: '开播状态探测' });
        const live = extractLiveFlag(raw);
        if (live !== undefined) return { live, raw };
      } catch {
        /* 试下一个候选 */
      }
    }
    return undefined;
  }
}

/** 从各种可能的结构里抽出「是否在直播」 */
export function extractLiveFlag(raw: unknown): boolean | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1;
  if (typeof raw === 'string') {
    if (raw === '1' || raw.toLowerCase() === 'true' || raw === 'live' || raw === '直播中') return true;
    if (raw === '0' || raw.toLowerCase() === 'false' || raw === 'offline' || raw === '未开播') return false;
    return undefined;
  }
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    // 常见字段名
    for (const k of ['live_status', 'liveStatus', 'status', 'isLive', 'is_live', 'live', 'living', 'recording']) {
      if (k in o) {
        const v = extractLiveFlag(o[k]);
        if (v !== undefined) return v;
      }
    }
    // 展开 data / streamer 一层
    for (const k of ['data', 'streamer', 'room', 'result']) {
      if (k in o) {
        const v = extractLiveFlag(o[k]);
        if (v !== undefined) return v;
      }
    }
  }
  return undefined;
}

/** 判断是否 Windows 绝对路径（也容忍 POSIX 形式，便于测试） */
export function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
}
