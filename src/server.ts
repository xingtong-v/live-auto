/**
 * WP7 —— 本地 Web UI 服务端（任务书 §8 WP7）。
 *
 * 形态：用 `node:http` 再监听一个本地端口（默认 `127.0.0.1:3000`），
 * 页面是**单文件 HTML**（内嵌 CSS/JS，无前端框架、无构建步骤）。
 * 理由：本环境无 Python、不应引入构建链；该界面只服务本机单人使用。
 *
 * 安全要求（硬约束 #2、#15，陷阱 #13、#22）：
 *  - **只监听 127.0.0.1**：上传接口会读本地文件路径，绝不能暴露公网
 *  - UI API 加 **Origin 检查 + CSRF token**，防止恶意网页调用本地服务
 *  - 预览接口**只允许任务目录内文件**，支持 HTTP Range，防路径遍历
 *  - 日志统一脱敏 `Authorization` / passkey / cookie / API Key
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';
import type { Orchestrator } from './daemon.ts';
import { APP_VERSION, retentionNote, summarizeTask } from './daemon.ts';
import type { ClipRecord, Stage, TaskRecord } from './types.ts';
import { loadErrorReport, readErrorEvents, renderErrorTimeline, listErrorReports } from './errors.ts';
import { resolveCover, validateDtime, describeDtimePlan, parseUserDtime } from './publish.ts';
import { sanitizeTitle, sanitizeDesc, sanitizeTags, mapCategoryToTid, transcriptPreview } from './analyze.ts';
import { PromptStore } from './analyze.ts';
import { judgeDeletability } from './cleanup.ts';
import { hotWordsText } from './glossary.ts';
import { checkClipTitles } from './title-check.ts';
import { auditPublish, renderPublishAudit } from './publish-audit.ts';
import { describeCandidate, findVideoProducts, listRecordingsDetailed, previewRecording } from './recordings.ts';
import { cancelPendingDelete, deletePendingNow, listPendingDelete, runDueDeletions } from './pending-delete.ts';
import { moveToTrash } from './trash.ts';
import { buildMcpTools, checkMcpToken, generateMcpToken, handleMcpMessage, type JsonRpcRequest } from './mcp.ts';
import { PREVIEW_DIR, cleanupPreviews, makePreviewClip, previewFileName } from './preview.ts';
import { openInSystemPlayer } from './player.ts';
import { ROOT_DIR, exists, fileSize, fmtBytes, fmtDuration, fmtLocal, nowIso, readJson } from './util.ts';
import { log as globalLog } from './logger.ts';

/* ============================================================================
 * 常量与工具
 * ========================================================================== */

const STAGE_ORDER: Stage[] = ['IDLE', 'RECORDED', 'TRANSCRIBED', 'ANALYZED', 'CLIPPED', 'PUBLISHED'];
const STAGE_LABELS = ['录制', '转写', '分析', '切片', '发布'];

/** 允许的 Host（防 DNS rebinding）；只接受回环地址 */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** 只读方法（不做 CSRF 校验，但仍做 Origin 校验） */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `toTaskSummary()` 里监控面板要用的字段（只声明用到的，避免 any） */
interface TaskSummaryLite {
  statusText?: string;
  stageIndex?: number;
  stages?: string[];
  publishWaiting?: boolean;
  progress?: { label: string; current: number; total: number };
}

export interface UiServerOptions {
  orchestrator: Orchestrator;
  host?: string;
  port?: number;
  /** UI 页面路径（默认 public/ui.html） */
  uiPath?: string;
  openBrowser?: boolean;
}

/* ============================================================================
 * 服务端
 * ========================================================================== */

/**
 * 把 B站 的稿件状态翻译成人读的标签。
 *
 * ⚠️ `state_desc` **不能无条件相信**：实测同一个字段有两种形态 ——
 *   · 正常时是中文文案：`state=0 → "开放浏览"`、`state=-30 → "审核中"`
 *   · 拿不到文案时它只是把数字回显：`state=-50 → "-50"`
 * 所以先判断"是不是纯数字"，是就丢掉，再去查状态码表。
 */
export function archiveStateLabel(state: number, desc: string): string {
  const d = (desc ?? '').trim();
  if (d && !/^-?\d+$/.test(d)) return d; // 真的文案，直接用
  switch (state) {
    case 0:
      return '已通过';
    case -1:
    case -30:
      return '审核中';
    case -2:
    case -20:
      return '未通过';
    default:
      // 剩下的负值在「仅自己可见 / 打回 / 各种审核态」之间靠数字分不开，**不编含义**，
      // 原样给出状态码，让用户自己去创作中心对照。
      return `状态 ${state}`;
  }
}

/**
 * 「已投稿文件」的审核状态判定 —— **纯函数，方便单测直接钉住每个分支**。
 *
 * 用户的要求是「已经投稿还在审核的显示审核中，已经投稿成功的显示 bv 号」。
 * 判据的口径（按可靠性排序）：
 *
 *  1. **有没有 bvid** —— 这是最硬的信号。bvid 是我们按标题从 `/bili/archives` 里反查到的，
 *     有它就说明稿件确实在 B站 上存在；没有就说明还没反查到（仍在审核/转码）。
 *  2. **B站 明确说在审核** —— `state ∈ {-1,-30}` 或状态文案里含「审核」。此时即使已经有 bvid，
 *     也如实显示「审核中」，不急着让用户以为可以点开看了。
 *  3. 其余有 bvid 的情况一律**算已投稿成功**（显示可点的 bv 号），状态标签只作参考。
 *
 * 为什么不要求 `state === 0` 才算成功：这个账号是 `is_only_self=1` 试跑，
 * 实测稿件停在 `state=-50`（B站 连文案都没给）而**分P 全都投上去了、bvid 也查得到**。
 * 如果按"必须 state 0"判定，界面上会永远显示「审核中」，用户既看不到 bv 号也删不了文件 ——
 * 那恰好是这次要解决的问题。
 */
export function reviewStatusOf(
  bvid: string | undefined,
  st: { state: number; stateDesc: string } | undefined,
): { reviewState: 'reviewing' | 'published' | 'unknown'; reviewText: string; stateLabel: string } {
  if (!bvid) return { reviewState: 'reviewing', reviewText: '审核中', stateLabel: '还没反查到稿件' };
  if (!st) {
    // 有 bvid 但当前列表里没有：可能是稿件太多翻出了第一页，也可能是已被删。
    // bvid 是当初反查到的，仍然给出来让人能点开看，同时如实注明。
    return { reviewState: 'published', reviewText: '', stateLabel: '当前列表里没有它（可能已翻页或已删除）' };
  }
  const label = archiveStateLabel(st.state, st.stateDesc);
  if (/审核/.test(label)) return { reviewState: 'reviewing', reviewText: label, stateLabel: label };
  return { reviewState: 'published', reviewText: '', stateLabel: label };
}

export class UiServer {
  private orch: Orchestrator;
  private host: string;
  private port: number;
  private uiPath: string;
  private server?: http.Server;
  private csrfToken: string;
  private openBrowser: boolean;
  /**
   * 录播清单缓存。
   *
   * 列一次清单要对每个文件跑 ffprobe（实测 25 条约 2 秒），
   * 界面每开一次导入对话框都重扫一遍会让「打开」这个动作明显卡顿。
   * 20 秒内的重复请求直接复用；用户点「刷新」时传 refresh=1 绕过。
   */
  private recordingListCache?: {
    at: number;
    value: {
      configuredDirs: string[];
      detectedDirs: string[];
      scanRoots: string[];
      roomIds: string[];
      historyTotal: number;
      historyMissing: number;
      count: number;
      candidates: unknown[];
    };
  };
  /**
   * `/api/monitor` 的短缓存（**每个服务实例一份**，不是模块级全局）。
   *
   * 面板每 5 秒刷一次，而用户还可能开着两个标签页、或边点「立即刷新」——
   * 没有缓存的话每一跳都要重新问 biliLive-tools 并全量扫台账。
   * 1.2 秒足够吸收"同一瞬间的多个请求"，又不会让面板显示过期数据。
   * 放在实例上还有一个好处：测试里起两个服务互不干扰（模块级全局会让断言互相污染）。
   */
  private monitorCache?: { at: number; data: Record<string, unknown> };  private static readonly MONITOR_CACHE_MS = 1200;

  /**
   * 任何**改动状态**的操作之后都要让监控面板的短缓存失效。
   *
   * 为什么必须显式做：面板是 5 秒轮询 + 1.2 秒缓存，用户点完「立即删除」如果立刻刷新，
   * 拿到的还是缓存里那份**旧数据** —— 界面上那一行还在，看起来像没删掉（实测就是这样，
   * 用户会再点一次）。改完状态就让缓存作废，下一页读到的一定是新状态。
   */
  private invalidateMonitor(): void {
    this.monitorCache = undefined;
    this.llcQueueCache = undefined;
    this.archivesCache = undefined;
  }
  /**
   * biliLive-tools 自己的队列（它在压制/上传什么）。
   *
   * 这一跳是"顺路看看"，所以缓存得更久（10 秒）、并且用 1.5 秒超时 ——
   * 它忙的时候绝不能把面板一起拖住。
   */
  private llcQueueCache?: { at: number; data: Array<Record<string, unknown>>; error?: string };
  private static readonly LLC_QUEUE_CACHE_MS = 10_000;

  /**
   * 已投稿件的**审核状态**（`bvid → state_desc`）。
   *
   * 「已投稿文件」那块要显示「审核中 / bv 号」，判据只能来自 B站 自己 ——
   * 实测 `/bili/archives` 直接带 `state_desc` 中文（`审核中`／空），比猜状态码可靠。
   *
   * 缓存 60 秒：面板是 5 秒轮询，不缓存的话每分钟要问 B站 12 次；
   * 而审核状态本来就是分钟级变化的东西，60 秒完全够。
   * 拿不到时**保留上一次的结果**（`error` 只做提示），否则面板会忽明忽暗。
   */
  private archivesCache?: { at: number; data: Map<string, { state: number; stateDesc: string; title: string; pubtime: number }>; error?: string };
  private static readonly ARCHIVES_CACHE_MS = 60_000;

  constructor(opts: UiServerOptions) {
    this.orch = opts.orchestrator;
    const cfg = this.orch.config;
    this.host = opts.host ?? cfg.ui.host;
    this.port = opts.port ?? cfg.ui.port;
    this.uiPath = opts.uiPath ?? path.join(ROOT_DIR, 'public', 'ui.html');
    this.csrfToken = crypto.randomBytes(24).toString('hex');
    this.openBrowser = opts.openBrowser ?? cfg.ui.openBrowser;

    /* MCP token：首次启用时生成一次并写回 config.json。
       为什么写回文件而不是每次启动重新生成：MCP 客户端（Claude Code / Codex）是把 token
       写进**它自己的配置**里的，每次重启都换 token 就等于每次都要重新配对一次。 */
    if (cfg.mcp?.enabled && !cfg.mcp.token) {
      const token = generateMcpToken();
      try {
        const r = this.orch.store.save({ mcp: { enabled: true, token } } as never);
        this.orch.logger.info(
          `已生成 MCP token 并写入 config.json（忽略 ${r.maskedIgnored.length} 个打码字段）` +
            ` —— Agent 可用：claude mcp add --transport http live-auto ${this.url}/mcp --header "Authorization: Bearer ${token}"`,
          { mod: 'mcp' },
        );
      } catch (e) {
        this.orch.logger.warn(`MCP token 写回 config.json 失败（本次仍生效，但重启会变）：${(e as Error).message}`, { mod: 'mcp' });
        cfg.mcp.token = token;
      }
    }

    // 硬约束 #2：只监听回环地址
    if (!ALLOWED_HOSTS.has(this.host)) {
      throw new Error(
        `Web UI 必须只监听回环地址（当前 ${this.host}）。自研服务的上传接口会读本地文件路径，绝不能暴露公网（硬约束 #2、陷阱 #13）`,
      );
    }
  }

  get url(): string {
    return `http://${this.host === '::1' ? '[::1]' : this.host}:${this.port}`;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        globalLog.error('UI 请求处理异常', e, { mod: 'ui' });
        if (!res.headersSent) this.sendJson(res, 500, { error: '服务端异常', detail: (e as Error).message });
      });
    });
    // 只绑定回环地址
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => resolve());
    });
    // 端口传 0 时由系统分配，必须把实际端口读回来，否则 this.url 会指向 0
    const addr = this.server.address();
    if (addr && typeof addr === 'object') this.port = addr.port;
    this.orch.logger.info(`Web UI 已启动：${this.url}（仅监听 ${this.host}，CSRF 与 Origin 校验已启用）`);
    if (this.openBrowser) {
      void import('node:child_process').then(({ spawn }) => {
        const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const args = process.platform === 'win32' ? ['/c', 'start', '', this.url] : [this.url];
        try {
          spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
        } catch {
          /* 打不开浏览器不影响服务 */
        }
      });
    }
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  /* ------------------------------------------------------------------------
   * MCP（Agent 接口）
   * ---------------------------------------------------------------------- */

  /**
   * 处理 `/mcp` 的 JSON-RPC 请求。
   *
   * 传输形态按 MCP 的 Streamable HTTP 约定：
   *  - `POST` 带 JSON-RPC 消息 → 单条响应。客户端若要求 `Accept: text/event-stream`，
   *    就用 SSE 帧回（部分客户端只认这种）；否则回普通 JSON。
   *  - `GET` → 告诉调用方这里支持什么（真正的服务端推送我们用不上，明确拒绝比静默挂着好）。
   *  - 通知（无 id）→ 202 空响应（MCP 规定通知不需要响应）。
   */
  private async handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const cfg = this.orch.config;
    if (!cfg.mcp?.enabled) {
      this.sendJson(res, 404, { error: 'MCP 接口未启用（config.json 的 mcp.enabled=false）' });
      return;
    }
    const auth = checkMcpToken(req.headers, cfg.mcp.token);
    if (!auth.ok) {
      this.sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: auth.reason } });
      return;
    }

    if (req.method === 'GET') {
      this.sendJson(res, 200, {
        protocol: 'mcp',
        transport: 'streamable-http',
        endpoint: `${this.url}/mcp`,
        hint:
          '用 POST 发 JSON-RPC（initialize → notifications/initialized → tools/list → tools/call）。' +
          `Claude Code: claude mcp add --transport http live-auto ${this.url}/mcp --header "Authorization: Bearer <token>"`,
      });
      return;
    }
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: `MCP 只接受 POST，收到 ${req.method}` });
      return;
    }

    let msg: JsonRpcRequest;
    try {
      msg = (await this.readBody(req)) as JsonRpcRequest;
    } catch (e) {
      this.sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `请求体解析失败：${(e as Error).message}` } });
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
      this.sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: '不是合法的 JSON-RPC 请求' } });
      return;
    }

    const response = await handleMcpMessage(this.orch, msg, { name: 'live-auto', version: APP_VERSION });
    if (response === null) {
      res.writeHead(202, { 'Cache-Control': 'no-store' }).end();
      return;
    }

    const accept = String(req.headers.accept ?? '');
    if (accept.includes('text/event-stream')) {
      // SSE 帧：一个 event 一条消息，然后关闭（单响应场景不需要长连接）
      const body = `event: message\ndata: ${JSON.stringify(response)}\n\n`;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.end(body);
      return;
    }
    this.sendJson(res, 200, response);
  }

  /* ------------------------------------------------------------------------
   * 安全校验
   * ---------------------------------------------------------------------- */

  /**
   * Origin / Host 校验（硬约束 #15、陷阱 #22）。
   *
   * 为什么需要：本地服务也会被**恶意网页**调用 —— 你浏览器里的任意页面都能发请求到
   * `127.0.0.1:3000`。因此：
   *   - 非回环 Origin 一律拒绝
   *   - 写操作还要求 CSRF token（Origin 头在部分场景可能缺失，token 是第二道）
   */
  private checkOrigin(req: http.IncomingMessage): { ok: boolean; reason?: string } {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const u = new URL(origin);
        if (!ALLOWED_HOSTS.has(u.hostname)) {
          return { ok: false, reason: `拒绝来自 ${origin} 的请求：本服务只接受回环地址来源（防 CSRF）` };
        }
      } catch {
        return { ok: false, reason: `Origin 头格式非法：${origin}` };
      }
    }
    // Host 头校验（防 DNS rebinding）
    const host = req.headers.host;
    if (host) {
      const hostname = host.replace(/:\d+$/, '');
      if (!ALLOWED_HOSTS.has(hostname)) {
        return { ok: false, reason: `拒绝 Host=${host}：只接受回环地址` };
      }
    }
    return { ok: true };
  }

  private checkCsrf(req: http.IncomingMessage, url: URL): { ok: boolean; reason?: string } {
    if (SAFE_METHODS.has(req.method ?? 'GET')) return { ok: true };
    const token = req.headers['x-csrf-token'];
    const provided = Array.isArray(token) ? token[0] : token;
    const fromQuery = url.searchParams.get('csrf');
    if (provided === this.csrfToken || fromQuery === this.csrfToken) return { ok: true };
    return {
      ok: false,
      reason:
        'CSRF token 缺失或不匹配 —— 请通过页面上的操作发起请求（页面会自动带上 token）。' +
        '如果你在用 curl 调试，请从 GET /api/bootstrap 获取 csrf 并带上 X-CSRF-Token 头',
    };
  }

  /* ------------------------------------------------------------------------
   * 响应工具
   * ---------------------------------------------------------------------- */

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      // 本地服务也不允许被嵌入 iframe
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(text);
  }

  private sendText(res: http.ServerResponse, status: number, text: string, type = 'text/plain; charset=utf-8'): void {
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(text);
  }

  /**
   * 在系统文件管理器里**定位并选中**一个文件（或打开一个目录）。
   *
   * 安全边界（这三条是硬性的，不是风格问题）：
   *  1. **路径绝不来自客户端**。调用方必须传服务端自己从台账/配置里取到的路径 ——
   *     否则这个接口就成了"任意路径的本地文件管理器触发器"。所以本函数只接受
   *     已经由服务端解析好的绝对路径，并且要求它确实存在。
   *  2. **用 spawn 而不是 exec**。`exec` 会经过 shell，路径里的 `&`、`|`、`"` 等
   *     都会被解释成命令分隔符（`p.name & calc.exe` 这类注入在本地服务上照样生效）。
   *     spawn 把参数作为数组传递，没有 shell 参与，路径里的任何字符都只是字符。
   *  3. **只允许打开文件/目录，不允许传额外参数**。不给调用方任何机会拼出别的命令。
   *
   * 平台差异（各自都踩过坑，记在这里免得下次再猜）：
   *  - **Windows**：`explorer /select,<path>` 是最直接的"打开文件夹并选中该文件"，
   *    但 `explorer.exe` **不接受** spawn 数组里那种"整体作为一个参数"的写法
   *    （它自己解析命令行），而且路径含逗号时 `/select,` 会把逗号后面当成第二个文件。
   *    所以走 PowerShell 的 `Start-Process -LiteralPath`：它按字面量处理路径，
   *    空格/逗号/中文/`&` 全都安全，与项目里打开浏览器用的是同一套 spawn 模式。
   *  - **macOS**：`open -R <file>` 就是"在访达中显示"。
   *  - **Linux**：没有统一的"选中文件"约定，退化为打开其所在目录（xdg-open）。
   *
   * @returns 实际执行的命令描述（便于回显给用户/写日志），失败时返回 error。
   */
  private revealInFileManager(target: string): { ok: boolean; how: string; error?: string } {
    if (!target || !path.isAbsolute(target)) {
      return { ok: false, how: '', error: `不是绝对路径，拒绝打开：${target}` };
    }
    if (!exists(target)) {
      return { ok: false, how: '', error: `路径不存在（可能已被「用完即删」清理或移入回收站）：${target}` };
    }
    const isDir = fs.statSync(target).isDirectory();
    const win = process.platform === 'win32';
    const mac = process.platform === 'darwin';

    let cmd: string;
    let args: string[];
    let how: string;

    if (win) {
      /* ★ Windows 实测结论 —— 全部用"唯一命名的临时目录 + 枚举窗口标题"做客观判据
         （见 tools/probe-reveal-methods.ts 与 tools/probe-select-arg.ts）。
         教训：**不能把"命令没报错"当成"用户看到了"**，这两处都踩过：

           ✅ explorer.exe <dir>                     打开目录
           ✅ explorer.exe "/select," <file>         **逗号与路径必须分成两个参数**
           ✅ cmd /c start "" <dir>                  也可用
           ❌ powershell Start-Process -LiteralPath <dir>
              静默无效、不报错、不开任何窗口（`-LiteralPath` 不是 Start-Process 的参数，
              它属于 Get-Item 一类）—— 这就是"点了没跳转"的第一层原因。
           ❌ explorer.exe "/select,<file>"         打开的是「文档」文件夹
           ❌ explorer.exe "/select,\"<file>\""     同上（Node 会自动给含空格参数加引号，
              再手工加一层引号反而让 explorer 解析成空路径）
           ❌ cmd /c start "" explorer.exe "/select,<file>"  同上

         所以文件选中用 `['/select,', target]`；目录直接 `[target]`。
         不经过 shell，路径以数组元素传递，空格/中文/`&` 都安全。 */
      cmd = 'explorer.exe';
      if (isDir) {
        args = [target];
        how = `explorer.exe "${target}"`;
      } else if (target.includes(',')) {
        /* `/select,` 靠逗号分隔路径，路径自身含逗号时无法安全表达。
           退化为"打开所在目录"—— 少一个"选中"效果，好过整个功能失效。 */
        const dir = path.dirname(target);
        args = [dir];
        how = `explorer.exe "${dir}"（路径含逗号，跳过"选中文件"改为打开所在目录）`;
      } else {
        args = ['/select,', target];
        how = `explorer.exe /select, "${target}"`;
      }
    } else if (mac) {
      cmd = 'open';
      args = isDir ? [target] : ['-R', target];
      how = isDir ? `open "${target}"` : `open -R "${target}"`;
    } else {
      cmd = 'xdg-open';
      args = [isDir ? target : path.dirname(target)];
      how = `${cmd} "${args[0]}"`;
    }

    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.unref();
      /* ★ 打开之后，如果窗口没能抢到前台，用户看到的就是"点了没反应"。
         实测现象：资源管理器窗口确实建出来了，但它出现在浏览器**后面**
         （用户原话："文档窗口 显示在界面上面" —— 说的是窗口层级/遮挡问题）。
         新起的 explorer 进程有时能自己抢到前台，但那不是可靠保证（前台锁定策略），
         所以这里在打开之后**再显式激活一次**目标窗口，把它提到最前。

         实现用 Shell.Application 的 `Activate()`（COM，无需额外依赖）：
         按 LocationName 匹配目录名，激活失败不影响主流程（只管能不能看见）。 */
      if (win) {
        void this.activateExplorerWindow(path.basename(isDir ? target : path.dirname(target)));
      }
      return { ok: true, how };
    } catch (e) {
      return { ok: false, how, error: (e as Error).message };
    }
  }

  /**
   * 把资源管理器里 LocationName 匹配 `needle` 的窗口提到前台。
   *
   * 为什么要单独做这一步：`explorer.exe` 打开目录时，窗口有时建在**浏览器后面**，
   * 用户看到的现象就是"点了没反应/跳转了但看不见"。这不是打开失败，是窗口层级问题。
   *
   * ★ 实现上踩过的坑（都实测过，别再猜）：
   *  1. `$window.Activate()` —— **没有这个方法**。实测报
   *     `Method invocation failed because [System.__ComObject] does not contain a method named 'Activate'`。
   *     `Shell.Application.Windows()` 返回的对象只能拿 `HWND`，激活要靠 user32。
   *  2. 只调 `SetForegroundWindow` —— **返回 False**。Windows 的"前台锁定"策略不允许
   *     后台进程抢焦点。必须先模拟一次 ALT 键解锁（用户点按钮时本来就在跟本应用交互，
   *     这个按键没有副作用），再 `AttachThreadInput` 到当前前台线程后调用，才会返回 True。
   *  3. 先用 `SetWindowPos(HWND_TOP)` / `BringWindowToTop` 提 z-order —— 这一步不受
   *     前台锁定限制，即使抢焦点失败，窗口也已经在最上层，不会"看不见"。
   *
   * 其它刻意的设计：
   *  - 用 `-EncodedCommand`（base64/UTF-16LE）传 PowerShell：本项目里 PowerShell 反复
   *    吃过引号与 `$` 的亏，编码传递是唯一稳的方式；
   *  - `needle` 先做单引号转义，避免拼进脚本后破坏字符串；
   *  - 失败**只记 debug 日志**：激活不上最多"窗口在后面"，不该让用户以为跳转失败。
   */
  private async activateExplorerWindow(needle: string): Promise<void> {
    if (!needle) return;
    const safe = needle.replace(/'/g, "''");
    /* ⚠️ 必须**轮询等待窗口出现**，不能只 sleep 一次固定时长：
       本函数是在 `spawn('explorer.exe', …)` 之后**紧接着**调用的，
       此时那个窗口可能还没建出来（实测 700ms 不一定够）。
       早期版本只 `Start-Sleep -Milliseconds 700` 然后 `Where-Object` 一次，
       窗口还没出现就直接 `exit` —— 看起来"脚本跑了"，其实什么都没做。
       这是"命令发出去了 ≠ 事情做成了"的又一个实例。 */
    const script =
      `Add-Type -Namespace W -Name U -MemberDefinition @'\n` +
      `[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);\n` +
      `[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);\n` +
      `[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);\n` +
      `[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\n` +
      `[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);\n` +
      `[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);\n` +
      `[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();\n` +
      `[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);\n` +
      `[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint flags, UIntPtr extra);\n` +
      `[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);\n` +
      `'@; ` +
      `$t = $null; ` +
      `for ($i = 0; $i -lt 20 -and -not $t; $i++) { ` +
      `  Start-Sleep -Milliseconds 300; ` +
      `  $sh = New-Object -ComObject Shell.Application; ` +
      `  foreach ($w in @($sh.Windows())) { ` +
      `    $n=''; try { $n=[string]$w.LocationName } catch { continue }; ` +
      `    if ($n -eq '${safe}' -or $n -like '*${safe}*') { $t = $w; break } ` +
      `  } ` +
      `}; ` +
      `if (-not $t) { exit }; ` +
      `$top = [W.U]::GetAncestor([IntPtr]$t.HWND, 2); if ($top -eq [IntPtr]::Zero) { $top = [IntPtr]$t.HWND }; ` +
      `[void][W.U]::ShowWindow($top, 9); ` +
      `[void][W.U]::SetWindowPos($top, [IntPtr]::Zero, 0,0,0,0, 0x0043); ` +
      `[void][W.U]::BringWindowToTop($top); ` +
      `[W.U]::keybd_event(0x12,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [W.U]::keybd_event(0x12,0,2,[UIntPtr]::Zero); ` +
      `Start-Sleep -Milliseconds 60; ` +
      `$fg = [W.U]::GetForegroundWindow(); $tid = 0; [void][W.U]::GetWindowThreadProcessId($fg, [ref]$tid); ` +
      `$my = [W.U]::GetCurrentThreadId(); $att = $false; ` +
      `if ($tid -ne $my) { $att = [W.U]::AttachThreadInput($my, [uint32]$tid, $true) }; ` +
      `[void][W.U]::SetForegroundWindow($top); ` +
      `if ($att) { [void][W.U]::AttachThreadInput($my, [uint32]$tid, $false) }`;
    try {
      /* ⚠️ 这里**不能**用 `detached: true`（第一版就是栽在这上面）。
         实测对比（tools/diagnose-activate-flow.ts，同一段脚本、同一时刻）：

           detached spawn → 前台始终是浏览器；spawnSync（非 detached）→ SetForegroundWindow=True、前台变 explorer

         原因：detached 会让子进程脱离控制台/会话上下文，而"模拟 ALT 键解锁前台锁定"
         这个手法**依赖调用进程处于正常的交互式会话**。detached 下它静默失效。
         代价是 PowerShell 会作为本服务的子进程短暂存在（几百毫秒后自己退出），
         这完全可以接受 —— 服务是常驻的，不是"跑完就退"的脚本。
         `unref()` 让它不阻塞 Node 的事件循环退出。 */
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } catch (e) {
      globalLog.debug(`激活资源管理器窗口失败（不影响打开本身）：${(e as Error).message.slice(0, 80)}`, { mod: 'ui' });
    }
  }

  private async readBody(req: http.IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          reject(new Error(`请求体超过 ${fmtBytes(maxBytes)} 上限`));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) return resolve({});
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error(`请求体不是合法 JSON：${(e as Error).message}`));
        }
      });
      req.on('error', reject);
    });
  }

  /* ------------------------------------------------------------------------
   * 路由
   * ---------------------------------------------------------------------- */

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    const p = url.pathname;

    // ---- 录制器 webhook（入站接口，不鉴权、不校验 Origin：录制器不是浏览器）----
    if (p.startsWith('/webhook/')) {
      await this.handleRecorderWebhook(req, res, p);
      return;
    }

    // ---- MCP（Agent 接口）----
    /* 为什么放在 Origin/CSRF 校验**之前**：MCP 客户端（Claude Code / Codex / Cursor）不是浏览器，
       既没有 Origin 头、也拿不到页面注入的 CSRF token。它用独立的长期 token 鉴权，
       但**仍然只监听回环地址**（见 start() 的 listen(this.host)）。 */
    if (p === '/mcp' || p === '/mcp/') {
      await this.handleMcp(req, res);
      return;
    }

    // ---- 安全校验 ----
    const origin = this.checkOrigin(req);
    if (!origin.ok) {
      this.sendJson(res, 403, { error: origin.reason });
      return;
    }
    const csrf = this.checkCsrf(req, url);
    if (!csrf.ok) {
      this.sendJson(res, 403, { error: csrf.reason });
      return;
    }

    // ---- 页面 ----
    if (p === '/' || p === '/index.html') {
      this.serveUi(res);
      return;
    }
    if (p === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }

    // ---- API ----
    if (!p.startsWith('/api/')) {
      this.sendJson(res, 404, { error: `未知路径：${p}` });
      return;
    }

    try {
      await this.routeApi(req, res, url, p);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.orch.logger.error(`UI API 失败：${req.method} ${p}`, e, { mod: 'ui' });
      this.sendJson(res, 400, { error: msg });
    }
  }

  private async routeApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, p: string): Promise<void> {
    const method = req.method ?? 'GET';
    const orch = this.orch;
    const cfg = orch.config;

    /* ---------------- GET /api/bootstrap ---------------- */
    if (p === '/api/bootstrap' && method === 'GET') {
      /* 先做一次「有没有被外部改过」的检查再取快照。
         否则界面拿到的是**缓存的** configVersion：外部一改配置，
         界面手里的版本号就永远对不上，之后每次保存都被乐观锁挡下（409 死循环）。
         这里顺便让 bootstrap 的 config 快照也始终是最新的。 */
      orch.store.reloadIfChanged();
      const liveCfg = orch.store.config;
      this.sendJson(res, 200, {
        csrf: this.csrfToken,
        version: APP_VERSION,
        config: orch.store.safeSnapshot(),
        /* 配置内容版本号：界面保存时原样回传，服务端据此判断「表单是否已过期」。
           没有它，界面会拿旧快照静默覆盖外部刚改过的配置（实测丢过 llm.select.model）。 */
        configVersion: orch.store.fileVersion,
        configIssues: orch.store.issues,
        mode: {
          autoPublish: liveCfg.publish.autoPublish,
          isOnlySelf: liveCfg.publish.isOnlySelf === 1,
          burnDanmaku: liveCfg.clip.burnDanmaku,
          burnSubtitles: liveCfg.clip.burnSubtitles,
          recordDecisions: liveCfg.runtime.recordDecisions,
          dryRun: false,
        },
        // 术语表随 bootstrap 一起下发：设置面板打开时不需要再发一次请求
        glossary: (() => {
          const g = orch.glossary.load();
          return {
            anchors: g.anchors,
            terms: g.terms,
            replacements: g.replacements,
            stats: orch.glossary.stats(g),
            path: orch.glossary.path,
          };
        })(),
        stageLabels: STAGE_LABELS,
        roomId: cfg.room.roomId,
        platform: cfg.room.platform,
        seasonConfigured: cfg.publish.seasonId > 0,
        // 排期预览：让界面能直接回答「首片什么时候发、最后一片什么时候发、
        // 我指定的时间有没有被推迟」——这些不该让用户自己算。
        dtimePlan: (() => {
          const plan = describeDtimePlan(Date.now(), cfg.publish, Math.max(1, cfg.clip.maxCandidates));
          return {
            first: plan.first,
            firstText: fmtLocal(plan.first * 1000),
            last: plan.last,
            lastText: fmtLocal(plan.last * 1000),
            note: plan.note,
            userSpecified: plan.userSpecified,
            earliestAllowed: plan.earliestAllowed,
            earliestAllowedText: fmtLocal(plan.earliestAllowed * 1000),
            configured: cfg.publish.firstPublishAt,
          };
        })(),
      });
      return;
    }

    /* ---------------- 任务管理：删除 / 停止 / 修复（UI 操作入口） ---------------- */

    /** 预览删除：先看清会释放什么，再决定删不删 */
    const delPlanMatch = /^\/api\/task\/([^/]+)\/delete-plan$/.exec(p);
    if (delPlanMatch && method === 'GET') {
      const id = decodeURIComponent(delPlanMatch[1]!);
      const plan = orch.inspectDeletion(id);
      const MB = (bytes: number): number => Number((bytes / 1024 ** 2).toFixed(1));
      const clipsMB = MB(plan.clipsBytes);
      const taskMB = MB(plan.taskBytes);
      const taskFullMB = MB(plan.taskFullBytes);
      // 用减法而不是各自 round：两块单独四舍五入后加起来会与合计差 0.1，
      // 用户看到「2932.2 + 0.1 = 2932.3，合计却写 2932.4」会以为算错了。
      const taskMetaMB = Number((taskMB - taskFullMB).toFixed(1));
      this.sendJson(res, 200, {
        plan: {
          title: plan.title,
          clipsDir: plan.clipsDir,
          clipsMB,
          clipsFiles: plan.clipsFiles,
          taskDir: plan.taskDir,
          taskMB,
          // 任务目录拆成「压制产物」和「转写等小文件」，避免用户误以为文本占了几个 G
          taskFullMB,
          taskFullFiles: plan.taskFullFiles,
          taskMetaMB,
          rawFiles: plan.rawFiles.map((f) => ({
            name: path.basename(f.path),
            MB: MB(f.size),
            sharedWith: f.sharedWith,
            exists: exists(f.path),
          })),
          rawMB: MB(plan.rawBytes),
          fullVideo: plan.fullVideo ? { name: path.basename(plan.fullVideo.path), MB: MB(plan.fullVideo.size) } : undefined,
          publishedClips: plan.publishedClips,
          totalMB: MB(plan.clipsBytes + plan.rawBytes + plan.taskBytes),
        },
        warning:
          plan.publishedClips > 0
            ? `该任务有 ${plan.publishedClips} 个切片已投稿到 B站。删除**不会撤回投稿** —— 如需撤下请到 B站创作中心操作。`
            : undefined,
      });
      return;
    }

    /** 执行删除 */
    const delMatch = /^\/api\/task\/([^/]+)\/delete$/.exec(p);
    if (delMatch && method === 'POST') {
      const id = decodeURIComponent(delMatch[1]!);
      const body = (await this.readBody(req)) as { deleteClips?: boolean; deleteRaw?: boolean; deleteTaskDir?: boolean; confirm?: boolean };
      if (!body.confirm) {
        throw new Error('删除不可逆，请求必须带 confirm: true');
      }
      const r = await orch.deleteTask(id, {
        deleteClips: body.deleteClips !== false,
        deleteRaw: body.deleteRaw === true,
        deleteTaskDir: body.deleteTaskDir === true,
      });
      this.invalidateMonitor();
      this.sendJson(res, 200, {
        ok: r.ok,
        freedMB: Number((r.freedBytes / 1024 ** 2).toFixed(1)),
        removed: r.removed.length,
        skipped: r.skipped,
        note: r.note,
        // 有 trashId 说明是「移入回收站」而不是永久删除 —— 界面据此告诉用户还能恢复
        trashId: r.trashId,
      });
      return;
    }

    /** 停止任务（移出队列 + 修复台账状态） */
    const stopMatch = /^\/api\/task\/([^/]+)\/stop$/.exec(p);
    if (stopMatch && method === 'POST') {
      const id = decodeURIComponent(stopMatch[1]!);
      const r = await orch.stopTask(id);
      this.sendJson(res, 200, r);
      return;
    }

    /** 一键修复所有卡住的运行态任务 */
    if (p === '/api/tasks/repair-stuck' && method === 'POST') {
      const fixed: Array<{ taskId: string; from: string; to: string; reason: string }> = [];
      for (const t of orch.ledger.listTasks({ limit: 300 })) {
        const r = orch.ledger.repairStuckTask(t.id);
        if (r.from !== r.to) fixed.push({ taskId: t.id, ...r });
      }
      this.sendJson(res, 200, {
        ok: true,
        fixed,
        note: fixed.length
          ? `修复了 ${fixed.length} 个卡住的任务（进程被强杀后会停在「切片中」这类状态，现已回到可操作状态）`
          : '没有发现卡住的任务',
      });
      return;
    }

    /* ---------------- GET /api/tasks ---------------- */
    if (p === '/api/tasks' && method === 'GET') {
      const status = url.searchParams.get('status') ?? '';
      const search = (url.searchParams.get('q') ?? '').trim();
      const limit = Number(url.searchParams.get('limit') ?? 200);
      let tasks = orch.ledger.listTasks({ limit: Number.isFinite(limit) ? limit : 200 });
      if (search) {
        const kw = search.toLowerCase();
        tasks = tasks.filter(
          (t) =>
            t.title.toLowerCase().includes(kw) ||
            t.id.toLowerCase().includes(kw) ||
            fmtLocal(Date.parse(t.createdAt)).includes(search) ||
            (t.liveId ?? '').includes(search),
        );
      }
      if (status) {
        const groups: Record<string, string[]> = {
          processing: ['PENDING', 'RECORDED', 'TRANSCRIBING', 'TRANSCRIBED', 'ANALYZING', 'CLIPPING', 'CLIPPED', 'PUBLISHING'],
          review: ['ANALYZED'],
          published: ['PUBLISHED', 'ARCHIVED'],
          failed: ['FAILED'],
        };
        const want = groups[status] ?? [status];
        tasks = tasks.filter((t) => want.includes(t.status));
      }
      const items = tasks.map((t) => this.toTaskSummary(t));
      // 成本月度汇总（使用期辅助功能）
      const monthly = this.monthlyCost(tasks);
      this.sendJson(res, 200, { tasks: items, monthly, total: tasks.length });
      return;
    }

    /* ---------------- GET /api/task/:id ---------------- */
    const taskMatch = /^\/api\/task\/([^/]+)$/.exec(p);
    if (taskMatch && method === 'GET') {
      const id = decodeURIComponent(taskMatch[1]!);
      const t = orch.ledger.getTask(id);
      if (!t) {
        this.sendJson(res, 404, { error: `任务不存在：${id}` });
        return;
      }
      this.sendJson(res, 200, this.toTaskDetail(t));
      return;
    }

    /* ---------------- POST /api/task/:id/approve ---------------- */
    const approveMatch = /^\/api\/task\/([^/]+)\/approve$/.exec(p);
    if (approveMatch && method === 'POST') {
      const id = decodeURIComponent(approveMatch[1]!);
      const t = orch.ledger.getTask(id);
      if (!t) throw new Error(`任务不存在：${id}`);
      const body = (await this.readBody(req)) as { indices?: number[] };
      const clips = orch.ledger.getClips(id);

      // 硬约束检查：标题/简介/标签合规 + 时间范围合法
      const problems: string[] = [];
      const indices = body.indices ?? clips.filter((c) => c.selected).map((c) => c.index);
      // ★ 标题体检：长度只是其中一项。占位标题、术语表错词残留、无意义标记、
      //   同场重名等都会在这里被拦下（详见 title-check.ts 的说明）。
      const titleReport = checkClipTitles(
        clips.map((c) => ({ index: c.index, title: c.title, ...(c.degraded !== undefined ? { degraded: c.degraded } : {}) })),
        {
          glossary: orch.glossary.load(),
          ...(cfg.publish.defaultTitleSuffix ? { suffix: cfg.publish.defaultTitleSuffix } : {}),
        },
      );
      for (const i of indices) {
        const c = clips[i];
        if (!c) {
          problems.push(`片段 #${i} 不存在`);
          continue;
        }
        const tr = titleReport.byIndex.get(i);
        for (const p of tr?.problems ?? []) {
          const line = `片段 #${i} 标题：${p.message}${p.fix ? `（${p.fix}）` : ''}`;
          if (p.level === 'error') problems.push(line);
        }
        if (c.desc.length > 250) problems.push(`片段 #${i} 简介 ${c.desc.length} 字符，超出 250 上限`);
        if (c.tags.length < 1 || c.tags.length > 10) problems.push(`片段 #${i} 标签 ${c.tags.length} 个，必须在 1–10 之间`);
        if (!(c.end > c.start)) problems.push(`片段 #${i} 起止时间非法`);
      }
      // 片段重叠检查
      const sorted = indices.map((i) => clips[i]).filter((c): c is ClipRecord => Boolean(c)).sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i]!.start < sorted[i - 1]!.end) {
          problems.push(`片段 #${sorted[i]!.index} 与 #${sorted[i - 1]!.index} 时间范围重叠`);
        }
      }
      if (problems.length) {
        this.sendJson(res, 400, { error: '发布前校验未通过', problems });
        return;
      }      if (indices.length === 0) {
        this.sendJson(res, 400, { error: '没有勾选任何切片' });
        return;
      }

      const result = await orch.publishStage(id, orch.logger);
      this.sendJson(res, 200, { ok: result.ok, stoppedAt: result.stoppedAt, error: result.error, count: indices.length });
      return;
    }

    /* ---------------- PATCH /api/task/:id/clip/:idx ---------------- */
    const clipMatch = /^\/api\/task\/([^/]+)\/clip\/(\d+)$/.exec(p);
    if (clipMatch && (method === 'PATCH' || method === 'POST')) {
      const id = decodeURIComponent(clipMatch[1]!);
      const idx = Number(clipMatch[2]);
      const t = orch.ledger.getTask(id);
      if (!t) throw new Error(`任务不存在：${id}`);
      const clip = orch.ledger.getClip(id, idx);
      if (!clip) throw new Error(`片段 #${idx} 不存在`);

      const body = (await this.readBody(req)) as Partial<ClipRecord> & { select?: boolean };
      const patch: Partial<ClipRecord> = {};
      const warnings: string[] = [];

      if (body.title !== undefined) {
        const st = sanitizeTitle(String(body.title), 80);
        patch.title = st.title;
        if (st.truncated) warnings.push('标题超过 80 字符，已自动截断');
      }
      if (body.desc !== undefined) {
        const sd = sanitizeDesc(String(body.desc), 250);
        patch.desc = sd.desc;
        if (sd.truncated) warnings.push('简介超过 250 字符，已自动截断');
      }
      if (body.tags !== undefined) {
        const res2 = sanitizeTags(
          Array.isArray(body.tags) ? body.tags.map(String) : String(body.tags).split(/[,，]/),
          { sensitive: cfg.publish.tagSensitiveWords },
        );
        patch.tags = res2.tags;
        if (res2.removed.length) warnings.push(`标签被移除：${res2.removed.join('、')}`);
      }
      if (body.start !== undefined || body.end !== undefined) {
        const start = body.start !== undefined ? Number(body.start) : clip.start;
        const end = body.end !== undefined ? Number(body.end) : clip.end;
        if (!(end > start)) throw new Error('结束时间必须大于开始时间');
        if (start < 0) throw new Error('开始时间不能为负');
        if (t.source.totalDuration > 0 && end > t.source.totalDuration + 1) {
          throw new Error(`结束时间 ${end.toFixed(1)}s 超出视频总时长 ${t.source.totalDuration.toFixed(1)}s`);
        }
        // 与其他片段的重叠检查
        const others = orch.ledger.getClips(id).filter((c) => c.index !== idx);
        const conflict = others.find((c) => start < c.end && end > c.start);
        if (conflict) {
          throw new Error(
            `时间范围与片段 #${conflict.index}（${fmtDuration(conflict.start)}–${fmtDuration(conflict.end)}）重叠，请先调整那一个`,
          );
        }
        const dur = end - start;
        if (dur < cfg.clip.minDurationSec || dur > cfg.clip.maxDurationSec) {
          warnings.push(
            `时长 ${dur.toFixed(1)}s 不在建议范围 ${cfg.clip.minDurationSec}–${cfg.clip.maxDurationSec}s 内（可以发布，但不推荐）`,
          );
        }
        patch.start = Number(start.toFixed(2));
        patch.end = Number(end.toFixed(2));
        // 时间范围变了 → 需要重新切片（失败态或已切过的都要重置）
        if (clip.status === 'FAILED' || clip.status === 'CUT' || clip.status === 'CUTTING' || clip.status === 'SUBMITTED') {
          patch.status = 'PENDING_UPLOAD';
        }
      }
      if (body.category !== undefined) {
        const cat = mapCategoryToTid(String(body.category), cfg.publish.tidWhitelist, cfg.publish.defaultCategory);
        patch.category = cat.matched;
        if (cat.note) warnings.push(cat.note);
      }
      if (body.cover_ts !== undefined) patch.cover_ts = Number(body.cover_ts);
      if (body.selected !== undefined || body.select !== undefined) {
        patch.selected = Boolean(body.selected ?? body.select);
      }
      /* 逐片排期时间（用户在看板/排期栏里手动指定发布时间）。
         `dtime` 传字符串（`YYYY-MM-DDTHH:mm`）或秒级时间戳；`clearDtime:true` 清空回到自动排期。
         ⚠️ 硬约束 #4：dtime 必须 > 提交时刻 + 7200 秒 —— 这里就拦住，
         不能等到投稿那一刻才失败（那时切片已经切完、额度也可能已经算上）。 */
      const clearDtime = (body as { clearDtime?: boolean }).clearDtime === true;
      const rawDtime = (body as { dtime?: unknown }).dtime;
      let unsetDtime = false;
      if (clearDtime || rawDtime !== undefined) {
        if (clearDtime || rawDtime === null || rawDtime === '') {
          unsetDtime = true;
          warnings.push('已清空这条切片的定时发布时间，改回自动排期');
        } else {
          const parsed = parseUserDtime(rawDtime);
          if (parsed === undefined) {
            this.sendJson(res, 400, { error: `无法解析定时发布时间：${String(rawDtime)}（可用 2026-09-24T08:00 或秒级时间戳）` });
            return;
          }
          const base = clip.submitTime ?? Date.now();
          const v = validateDtime(parsed, base);
          if (!v.ok) {
            this.sendJson(res, 400, {
              error: `定时发布时间不满足硬约束 #4：${v.note}`,
              dtime: parsed,
              earliestAllowed: Math.floor(base / 1000) + 7201,
            });
            return;
          }
          patch.dtime = parsed;
        }
      }

      // 记录「已编辑」（用于 decisions.jsonl 的 diff 与 prompt 迭代）
      patch.edited = true;
      const updated = orch.ledger.setClipStatus(id, idx, patch.status ?? clip.status, patch, {
        ...(unsetDtime ? { unset: ['dtime'] as Array<keyof ClipRecord> } : {}),
      });

      // 更新 decisions.jsonl 的最终值（用户编辑后的字段，§8 WP4 步骤 8）
      if (cfg.runtime.recordDecisions && updated) {
        orch.ledger.recordDecision({
          taskId: id,
          clipIndex: idx,
          llm: {
            start: clip.llmOriginal?.start ?? clip.start,
            end: clip.llmOriginal?.end ?? clip.end,
            title: clip.llmOriginal?.title ?? clip.title,
            tags: clip.llmOriginal?.tags ?? clip.tags,
            score: clip.score,
            reason: clip.reason,
            category: clip.category,
            degraded: clip.degraded,
          },
          selected: updated.selected,
          final: { start: updated.start, end: updated.end, title: updated.title, tags: updated.tags },
        });
      }
      this.sendJson(res, 200, { ok: true, clip: updated, warnings });
      return;
    }

    /* ---------------- POST /api/task/:id/clip/:idx/delete ----------------
     * 删掉单条切片（看板/排期栏里直接处理不想要的候选）。
     *
     * ⚠️ 已投稿的**不能**删：稿件在 B站 上，删本地记录只会让台账与线上不一致
     * （而且它还会继续出现在「已发布」里等着拉表现数据）。要撤得去创作中心，
     * 所以这里直接拒绝并说清原因，而不是"删了但线上还在"。 */
    const clipDelMatch = /^\/api\/task\/([^/]+)\/clip\/(\d+)\/delete$/.exec(p);
    if (clipDelMatch && method === 'POST') {
      const id = decodeURIComponent(clipDelMatch[1]!);
      const idx = Number(clipDelMatch[2]);
      const clip = orch.ledger.getClip(id, idx);
      if (!clip) throw new Error(`片段 #${idx} 不存在`);
      if (clip.status === 'PUBLISHED' || clip.status === 'SUBMITTED' || clip.status === 'SUBMITTING') {
        this.sendJson(res, 409, {
          error:
            `片段 #${idx} 已经投稿（状态 ${clip.status}${clip.bvid ? `，${clip.bvid}` : ''}）—— ` +
            `删本地记录不会把稿件从 B站 撤下来。请先到 B站创作中心删除该稿件，再回来清记录。`,
          bvid: clip.bvid,
        });
        return;
      }
      const body = (await this.readBody(req)) as { deleteOutput?: boolean };
      const r = orch.ledger.deleteClip(id, idx);
      if (!r) throw new Error(`删除失败：片段 #${idx} 不在台账里`);
      /* 成片文件默认**保留**（删清单不等于删文件：用户可能只想让它别投稿）。
         显式要删才删，而且走回收站，7 天内可恢复。 */
      let outputRemoved: string | undefined;
      if (body.deleteOutput === true && clip.cutOutput && exists(clip.cutOutput)) {
        try {
          /* moveToTrash 是同步的，且需要 title/status（回收站清单里要能读明白这是什么） */
          moveToTrash({
            taskId: id,
            title: `${clip.title}（切片 #${idx} 成片）`,
            status: clip.status,
            paths: [clip.cutOutput],
            reason: `删除切片 #${idx} 的成片`,
            logger: orch.logger,
          });
          outputRemoved = clip.cutOutput;
        } catch (e) {
          this.sendJson(res, 200, {
            ok: true,
            deleted: r.deleted.title,
            fingerprintsRemoved: r.fingerprintsRemoved,
            warning: `切片已从清单移除，但成片移入回收站失败：${(e as Error).message.slice(0, 120)}`,
          });
          return;
        }
      }
      this.sendJson(res, 200, {
        ok: true,
        deleted: r.deleted.title,
        fingerprintsRemoved: r.fingerprintsRemoved,
        ...(outputRemoved ? { outputRemoved } : {}),
      });
      return;
    }

    /* ---------------- POST /api/task/:id/overrides ----------------
     * 保存「本场设置」（逐任务覆盖：最多候选数 / 不参与自动发布 / 追加标签 / **完整版由切片助手投**）。
     *
     * 为什么需要这个端点：界面上那个「保存本场设置」按钮以前只是把值塞进 `state.pendingOverrides`
     * 就没了下文 —— **从没有真正写进台账**（实测：点保存后 `overrides` 一直是空的）。
     * 而「完整版由切片助手投」这条例外必须能逐场记录：它的语义就是"我明确说明这一场"。
     */
    const ovMatch = /^\/api\/task\/([^/]+)\/overrides$/.exec(p);
    if (ovMatch && method === 'POST') {
      const id = decodeURIComponent(ovMatch[1]!);
      const t = orch.ledger.getTask(id);
      if (!t) throw new Error(`任务不存在：${id}`);
      const body = (await this.readBody(req)) as {
        maxClips?: number;
        skipAutoPublish?: boolean;
        extraTags?: string[];
        fullVideoBy?: 'assistant' | null;
        /** 本场显式指定续传目标 aid（稿件标题不可信时的确定性手段），传 null/'' 清除 */
        resumeAid?: string | null;
      };
      const overrides: NonNullable<TaskRecord['overrides']> = {};
      if (body.maxClips !== undefined) {
        const n = Math.trunc(Number(body.maxClips));
        if (Number.isFinite(n) && n > 0 && n <= 100) overrides.maxClips = n;
      }
      if (body.skipAutoPublish !== undefined) overrides.skipAutoPublish = Boolean(body.skipAutoPublish);
      if (Array.isArray(body.extraTags)) {
        const tags = body.extraTags.map((s) => String(s).trim()).filter(Boolean).slice(0, 10);
        if (tags.length) overrides.extraTags = tags;
      }
      /* 例外开关：只允许 'assistant' 或"不设"（不设 = 回到默认：完整版由 biliLive-tools 投） */
      if (body.fullVideoBy === 'assistant') overrides.fullVideoBy = 'assistant';
      /* 本场指定续传 aid：必须是纯数字（B站 aid），非法值直接忽略而不是写进台账 */
      if (body.resumeAid !== undefined && body.resumeAid !== null) {
        const aid = String(body.resumeAid).trim();
        if (!aid) {
          /* 清除：靠下面的 updateTask+unset 把 overrides 整个换掉即可（新对象里没有该键） */
        } else if (/^\d{1,20}$/.test(aid)) {
          overrides.resumeAid = aid;
        } else {
          this.sendJson(res, 400, { error: `aid 必须是纯数字（从创作中心稿件地址里复制），收到：${aid.slice(0, 40)}` });
          return;
        }
      }
      const updated = orch.ledger.updateTask(id, { overrides });
      this.sendJson(res, 200, {
        ok: true,
        overrides: updated.overrides ?? {},
        note:
          overrides.resumeAid
            ? `已把本场续传目标固定为 aid=${overrides.resumeAid}：重跑发布阶段时切片会追加进这个稿件`
            : overrides.fullVideoBy === 'assistant'
              ? '已把本场标为「完整版由切片助手投」：重跑发布阶段时会自己烧弹幕版 + remux 纯享版并新建 2+N 稿件'
              : '已保存本场设置（完整版仍由 biliLive-tools 投，本服务只追加切片分P）',
      });
      return;
    }

    /* ---------------- POST /api/task/:id/retry ---------------- */
    const retryMatch = /^\/api\/task\/([^/]+)\/retry$/.exec(p);
    if (retryMatch && method === 'POST') {
      const id = decodeURIComponent(retryMatch[1]!);
      const t = orch.ledger.getTask(id);
      if (!t) throw new Error(`任务不存在：${id}`);
      const body = (await this.readBody(req)) as { fromStage?: Stage };
      const fromStage = body.fromStage ?? t.stage;
      const valid: Stage[] = ['RECORDED', 'TRANSCRIBED', 'ANALYZED', 'CLIPPED', 'PUBLISHED'];
      if (!valid.includes(fromStage)) {
        throw new Error(`fromStage 必须是 ${valid.join(' / ')} 之一，收到 "${fromStage}"`);
      }
      // 重跑前清错误态；从转写阶段之前重跑会复用缓存，不会重复付费
      orch.ledger.clearError(id);
      orch.ledger.setStatus(id, 'PENDING', { stage: fromStage });
      void orch.enqueue(id, fromStage);
      this.sendJson(res, 200, {
        ok: true,
        fromStage,
        note:
          fromStage === 'RECORDED'
            ? '将从源素材校验开始重跑（转写会复用本地缓存，已花的 ASR 费用不会重复产生）'
            : `将从 ${fromStage} 阶段重跑`,
      });
      return;
    }

    /* ---------------- GET /api/error-report/:id ---------------- */
    const reportMatch = /^\/api\/error-report\/([^/]+)$/.exec(p);
    if (reportMatch && method === 'GET') {
      const reportId = decodeURIComponent(reportMatch[1]!);
      const report = loadErrorReport(reportId);
      if (!report) {
        this.sendJson(res, 404, { error: `找不到错误报告：${reportId}`, available: listErrorReports().slice(-20) });
        return;
      }
      const asText = url.searchParams.get('format') === 'text';
      if (asText) {
        // 「一键复制」用的渲染后时间线
        this.sendText(res, 200, renderErrorTimeline(report));
        return;
      }
      this.sendJson(res, 200, { report, timeline: renderErrorTimeline(report) });
      return;
    }

    /* ---------------- GET /api/health ---------------- */
    if (p === '/api/health' && method === 'GET') {
      const health = await orch.health();
      this.sendJson(res, 200, { health, errors: readErrorEvents({ limit: 20 }) });
      return;
    }

    /* ---------------- GET /api/monitor ----------------
     * 「实时监控」面板的唯一数据源：一次把「现在在干什么 / 在等什么 / 为什么没动」给全。
     *
     * 为什么合成一个接口，而不是让页面并发打 6 个已有接口：
     *   ① 面板默认 5 秒刷一次，6 个请求各自扫台账/问 biliLive-tools 会把本地服务吵起来；
     *   ② 更糟的是**时间点不一致** —— 会出现"队列空闲"和"正在转写"同屏这种自相矛盾的画面。
     *
     * 只读、无副作用：不改台账、不触发外部动作、不花钱。失败一律降级成该块为空，
     * 绝不让面板整体 500（监控面板报错最常见的原因就是它依赖的某一块挂了）。
     */
    if (p === '/api/monitor' && method === 'GET') {
      this.sendJson(res, 200, await this.monitorView());
      return;
    }

    /* ---------------- POST /api/selfcheck ---------------- */
    if (p === '/api/selfcheck' && method === 'POST') {
      const results = await orch.runSelfCheck();
      this.sendJson(res, 200, { results, ok: results.every((r) => r.ok) });
      return;
    }

    /* ---------------- POST /api/check-now ---------------- */
    if (p === '/api/check-now' && method === 'POST') {
      const r = await orch.trigger.checkNow();
      this.sendJson(res, 200, {
        polled: r.polled.map((d) => ({ reason: d.reason, liveId: d.liveId })),
        reconciled: r.reconciled.map((d) => ({ reason: d.reason, liveId: d.liveId })),
        note: r.polled.length + r.reconciled.length === 0 ? '本次检查没有发现已结束且未处理的录制' : '已触发新场次处理',
      });
      return;
    }

    /* ---------------- POST /api/import ---------------- */
    if (p === '/api/import' && method === 'POST') {
      const body = (await this.readBody(req)) as {
        videoPath?: string;
        danmaPath?: string;
        title?: string;
        roomId?: string;
        /** 勾选的是「已烧弹幕」的压制产物 → 源文件自带弹幕，切片时不再传 ASS（陷阱 #8） */
        hasDanmakuInPicture?: boolean;
      };
      if (!body.videoPath) throw new Error('必须提供 videoPath（本地视频绝对路径）');
      const rec = await orch.importLocal({
        videoPath: body.videoPath,
        ...(body.danmaPath ? { danmaPath: body.danmaPath } : {}),
        ...(body.title ? { title: body.title } : {}),
        ...(body.roomId ? { roomId: body.roomId } : {}),
        ...(body.hasDanmakuInPicture !== undefined ? { hasDanmakuInPicture: body.hasDanmakuInPicture } : {}),
      });
      this.sendJson(res, 200, { ok: true, taskId: rec.id, title: rec.title, durationSec: rec.source.totalDuration });
      this.invalidateMonitor();
      return;
    }

    /* ---------------- POST /api/config ---------------- */
    if (p === '/api/config' && method === 'POST') {
      const body = (await this.readBody(req)) as Record<string, unknown>;
      const patch = body['patch'] as Record<string, unknown> | undefined;
      if (!patch) throw new Error('请求体需为 { patch: { … } }');
      const expectVersion = typeof body['configVersion'] === 'string' ? (body['configVersion'] as string) : undefined;
      const force = body['force'] === true;
      const saved = orch.store.save(patch as never, force ? undefined : expectVersion);

      /* 乐观锁冲突：磁盘上的配置在界面打开设置面板之后被别处改过。
         此时**拒绝写入**并如实列出差异，由用户选择重新加载还是强制覆盖。
         直接覆盖会造成「你没改过的项莫名其妙被还原」的静默事故。 */
      if (saved.conflict) {
        const stale = saved.conflict.stalePaths;
        this.sendJson(res, 409, {
          ok: false,
          code: 'CONFIG_CONFLICT',
          error:
            `配置已被其它程序修改（磁盘版本 ${saved.conflict.actual} ≠ 界面版本 ${saved.conflict.expected}），` +
            `本次**未写入任何内容**。若继续保存，界面上的值会覆盖下列已被外部改动的字段：` +
            `${stale.length ? stale.join('、') : '（无）'}`,
          conflict: {
            expected: saved.conflict.expected,
            actual: saved.conflict.actual,
            changedByOthers: saved.conflict.changedPaths,
            wouldOverwrite: stale,
            hint:
              stale.length === 0
                ? '界面上没有会覆盖外部改动的值 —— 点「重新加载」后重试即可。'
                : '建议先点「重新加载」把外部改动读进表单，确认无误后再保存；确实要以界面为准时用「强制覆盖」。',
          },
        });
        return;
      }

      const issues = saved.issues;
      const errors = issues.filter((i) => i.level === 'error');
      const notes: string[] = [];
      if (saved.maskedIgnored.length) {
        // 这里必须**先给成功信号**：界面上回显的凭据是掩码串，保存时会被安全阀拦下，
        // 若只输出「已按不修改处理」，用户会以为保存失败、甚至以为自己的 Key 被清掉了。
        // 实测确实被这样误读过，所以文案要写清「其余已生效 + 跳过了哪几个 + 为什么」。
        notes.push(
          `✓ 配置已保存并热加载（其余修改均已生效）。` +
            `${saved.maskedIgnored.length} 个凭据字段（${saved.maskedIgnored.join('、')}）` +
            `收到的仍是界面回显的掩码串（形如 abc***yz(len=26)），已智能跳过、**保留原值不变** —— ` +
            `这是为了防止把掩码串当成新 Key 存进去、反而覆盖掉真实凭据。` +
            `确实要换这几个 Key 时，把完整新值粘贴进去再保存即可。`,
        );
      }
      this.sendJson(res, 200, {
        ok: errors.length === 0,
        issues,
        maskedIgnored: saved.maskedIgnored,
        /* 回传写入后的新版本号：界面据此更新自己持有的版本，连续保存才不会误判为冲突 */
        configVersion: saved.version,
        hotReloaded: true,
        note: errors.length
          ? '配置已写入但存在硬约束错误，请修正后再次保存'
          : notes.length
            ? notes.join(' ')
            : '配置已保存并热加载：AI 两档模型、发布策略、清理策略等对后续步骤立即生效（已在排期的切片不受影响）',
      });
      return;
    }

    /* ---------------- 术语表：GET / PUT ---------------- */
    if (p === '/api/glossary' && method === 'GET') {
      const g = orch.glossary.load();
      const { perLine, commaSeparated } = hotWordsText(g);
      this.sendJson(res, 200, {
        anchors: g.anchors,
        terms: g.terms,
        replacements: g.replacements,
        stats: orch.glossary.stats(g),
        path: orch.glossary.path,
        // 目前这条路走不通（biliLive-tools 的 /ai/subtitle 不收热词参数），
        // 所以界面提供「复制热词」给用户粘到别处用（本地 whisper、云厂商控制台的定制热词）。
        hotWords: { perLine, commaSeparated },
      });
      return;
    }
    if (p === '/api/glossary' && method === 'PUT') {
      const body = (await this.readBody(req)) as Record<string, unknown>;
      const saved = orch.glossary.save(body);
      const errors = saved.issues.filter((i) => i.level === 'error');
      this.sendJson(res, 200, {
        ok: errors.length === 0,
        issues: saved.issues,
        stats: orch.glossary.stats(saved.glossary),
        note:
          errors.length > 0
            ? '术语表有错误，未写入（见 issues）'
            : `术语表已保存：主播 ${saved.glossary.anchors.length} 个、术语 ${saved.glossary.terms.length} 个、纠错规则 ${saved.glossary.replacements.length} 条 —— 下一次转写/分析即生效，无需重启`,
      });
      return;
    }

    /* ---------------- 投稿体检：GET /api/task/:id/publish-audit ----------------
     * 把「这场到底投了几次、每次用什么标题、有没有重复与 bvid 错配」一次说清。
     * 只读；`remote=1` 时额外去 B站 核对每个 bvid 的可见性与线上标题。 */
    const auditMatch = /^\/api\/task\/([^/]+)\/publish-audit$/.exec(p);
    if (auditMatch && method === 'GET') {
      const id = decodeURIComponent(auditMatch[1]!);
      const t = orch.ledger.getTask(id);
      if (!t) throw new Error(`任务不存在：${id}`);
      const wantRemote = url.searchParams.get('remote') === '1';
      const report = await auditPublish(t, orch.ledger, cfg, {
        ...(wantRemote ? { client: orch.client } : {}),
        glossaryPath: orch.glossary.path,
      });
      this.sendJson(res, 200, { report, text: renderPublishAudit(report) });
      return;
    }

    /* ---------------- 录播清单 / 导入预览 ----------------
     * 参考 biliLive-tools 的做法：不再让用户粘贴绝对路径，而是列出**可导入的录播**让他点选。
     * 清单 = biliLive-tools 录制历史 ∪ 扫盘（含它自己的录制目录），并叠加三件只有我们知道的事：
     * 是否已导入过、ASR 缓存命中与预估费用、文件是否可用。 */

    if (p === '/api/recordings' && method === 'GET') {
      const refresh = url.searchParams.get('refresh') === '1';
      const cached = this.recordingListCache;
      if (!refresh && cached && Date.now() - cached.at < 20_000) {
        this.sendJson(res, 200, { ...cached.value, cached: true });
        return;
      }
      const r = await listRecordingsDetailed(cfg, {
        client: orch.client,
        ledger: orch.ledger,
        asrPreflight: (videoPath, durationSec) => orch.preflightAsr(videoPath, durationSec),
        logger: orch.logger,
      });
      const value = {
        /** 用户配置的额外目录（界面可增删） */
        configuredDirs: cfg.import.scanDirs,
        /** biliLive-tools 自己的保存目录（自动包含，不需要用户配） */
        detectedDirs: r.detectedDirs,
        /** 这次实际扫了哪些目录 */
        scanRoots: r.scanRoots,
        /** 这次查了哪些房间的录制历史 */
        roomIds: r.roomIds,
        historyTotal: r.historyTotal,
        historyMissing: r.historyMissing,
        count: r.candidates.length,
        candidates: r.candidates.map((c) => ({ ...c, summary: describeCandidate(c) })),
      };
      this.recordingListCache = { at: Date.now(), value };
      this.sendJson(res, 200, { ...value, cached: false });
      return;
    }

    /* ---------------- MCP 接口信息 ----------------
     * 界面要能回答"怎么把 Agent 接上来"：端点、token、以及可直接复制的命令。
     * token 走 /api（已有 CSRF + Origin 校验），不会因为 UI 展示而泄露给网页。 */
    if (p === '/api/mcp' && method === 'GET') {
      const enabled = Boolean(cfg.mcp?.enabled);
      const token = cfg.mcp?.token ?? '';
      const endpoint = `${this.url}/mcp`;
      this.sendJson(res, 200, {
        enabled,
        endpoint,
        token,
        paired: Boolean(token),
        toolCount: buildMcpTools(orch).length,
        readOnlyToolCount: buildMcpTools(orch).filter((t) => t.readOnly).length,
        commands: {
          claudeCode: `claude mcp add --transport http live-auto ${endpoint} --header "Authorization: Bearer ${token}"`,
          codex: `codex mcp add live-auto --url ${endpoint} --header "Authorization: Bearer ${token}"`,
          cursorJson: JSON.stringify(
            { mcpServers: { 'live-auto': { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${token}` } } } },
            null,
            2,
          ),
          curl: `curl -s -X POST ${endpoint} -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"tools/list\\"}"`,
        },
        safety: [
          '只监听 127.0.0.1，且必须带 token（不是浏览器，拿不到页面的 CSRF）',
          '删除类工具要求一字不差的确认串（delete_task 要等于 taskId，purge_trash 要等于「永久删除」）',
          '只读工具不产生任何副作用；重跑类工具走的是与界面完全相同的那套逻辑',
        ],
      });
      return;
    }

    /* ---------------- 待删清单（「用完即删」的 24 小时反悔窗口） ----------------
     * 用户要的是"上传完成后删掉切片和源文件"。删源不可逆，所以进清单后要能在界面上看见、
     * 并且一键取消 —— 这几个接口就是那个"取消"按钮的全部后端。 */
    if (p === '/api/pending-delete' && method === 'GET') {
      this.sendJson(res, 200, listPendingDelete());
      return;
    }
    if (p === '/api/pending-delete/cancel' && method === 'POST') {
      const body = (await this.readBody(req)) as { id?: string };
      if (!body.id) throw new Error('缺少 id');
      const r = cancelPendingDelete(body.id, { logger: orch.logger });
      this.invalidateMonitor();
      this.sendJson(res, r.ok ? 200 : 404, r);
      return;
    }
    if (p === '/api/pending-delete/run' && method === 'POST') {
      // 手动执行到点的删除（正常情况下由 daemon 每 10 分钟自动执行）
      const r = runDueDeletions({ logger: orch.logger });
      this.invalidateMonitor();
      this.sendJson(res, 200, r);
      return;
    }

    /* ---------------- POST /api/pending-delete/delete ----------------
     * **立即删除**（不等宽限期）——待删清单里那个「立即删除」按钮走这里。
     *
     * 为什么需要它：宽限期是"防手滑"的缓冲，但用户明确不要的文件还要等 24 小时纯属折磨
     * （实测待删 15 项 / 472 MB）。所以给出显式入口，但把后果说清楚：
     * 同盘进回收站（可恢复），异盘直接删（**不可恢复**）——界面据此给两套确认文案。
     *
     * 边界：只接受**清单里的 id**，不接受调用方传路径 —— 否则这个接口就成了
     * "删任意文件"的通道，本地服务也不能开这个口子。
     */
    if (p === '/api/pending-delete/delete' && method === 'POST') {
      const body = (await this.readBody(req)) as { id?: string; ids?: string[]; all?: boolean };
      const ids = body.all
        ? listPendingDelete().pending.map((e) => e.id)
        : Array.isArray(body.ids)
          ? body.ids.map((x) => String(x))
          : body.id
            ? [String(body.id)]
            : [];
      if (ids.length === 0) {
        this.sendJson(res, 400, { ok: false, error: '需要提供 id / ids / all 之一（只删清单里已有的条目）' });
        return;
      }
      const r = deletePendingNow(ids, { logger: orch.logger });
      this.invalidateMonitor();
      const permanent = r.deleted.filter((d) => d.by === 'rm' && d.bytes > 0).length;
      const freedMB = Number((r.bytes / 1024 ** 2).toFixed(1));
      this.sendJson(res, 200, {
        ok: r.failed.length === 0,
        deleted: r.deleted.length,
        failed: r.failed,
        skipped: r.skipped,
        freedMB,
        trashIds: r.deleted.map((d) => d.trashId).filter(Boolean),
        items: r.deleted,
        note:
          r.deleted.length === 0
            ? `没有删除任何文件${r.skipped.length ? `：${r.skipped.map((s) => s.reason).join('；')}` : ''}`
            : `已立即删除 ${r.deleted.length} 项（释放 ${freedMB} MB）` +
              (permanent ? `，其中 ${permanent} 项是跨盘**永久删除**（不可恢复）` : '，都已移入回收站（可恢复）') +
              (r.failed.length ? `；${r.failed.length} 项失败：${r.failed.map((f) => f.error).join('；')}` : ''),
      });
      return;
    }

    /* ---------------- 目录轮询自动导入 ----------------
     * 为什么要有这两个接口：用户的原话是「打开切片助手后轮询目录，自动导入 → 自动总结切片 → 上传 → 删源」。
     * 轮询在后台跑，界面上必须能回答两个问题：**它在不在跑**、**为什么某个文件没被导入**。
     * 猜不出来的时候可以直接点「立即扫描」看结论。 */
    if (p === '/api/watch' && method === 'GET') {
      this.sendJson(res, 200, orch.watcher.status());
      return;
    }
    if (p === '/api/watch/scan' && method === 'POST') {
      const outcomes = await orch.watcher.scanOnce();
      this.sendJson(res, 200, {
        ok: true,
        scanned: outcomes.length,
        imported: outcomes.filter((o) => o.taskId),
        skipped: outcomes.filter((o) => o.skipped && !o.taskId),
      });
      return;
    }

    /* ---------------- 扫描目录管理 ----------------
     * 用户反馈「导入录播的路径太绝对，我还有别的主播的录播没显示」——
     * 所以扫描范围必须能在界面上改，而不是只能编辑 config.json。 */
    if (p === '/api/recordings/dirs' && method === 'POST') {
      const body = (await this.readBody(req)) as { add?: string; remove?: string; replace?: string[] };
      const next = new Set(cfg.import.scanDirs);
      const notes: string[] = [];

      if (body.replace) {
        next.clear();
        for (const d of body.replace) if (d.trim()) next.add(d.trim());
      }
      if (body.add) {
        const d = body.add.trim();
        // 支持 ~ 开头；同时给出"目录不存在"的即时反馈，别等清单空了才发现写错
        const expanded = d.startsWith('~')
          ? path.join(process.env['USERPROFILE'] ?? os.homedir(), d.slice(1).replace(/^[\\/]/, ''))
          : d;
        if (!exists(expanded)) {
          this.sendJson(res, 400, { ok: false, error: `目录不存在：${expanded}`, configuredDirs: cfg.import.scanDirs });
          return;
        }
        next.add(d);
        notes.push(`已添加扫描目录：${d}`);
      }
      if (body.remove) {
        next.delete(body.remove.trim());
        notes.push(`已移除扫描目录：${body.remove.trim()}`);
      }

      const saved = orch.store.save({ import: { scanDirs: [...next] } } as never);
      this.recordingListCache = undefined; // 目录变了，缓存作废
      this.sendJson(res, 200, {
        ok: true,
        configuredDirs: [...next],
        issues: saved.issues.filter((i) => i.level === 'error'),
        note: notes.join('；') || '扫描目录未变化',
      });
      return;
    }

    /* ---------------- 已投稿文件的删除 ----------------
     * 用户在实时监控里要能"删掉已经投稿成功的文件"。两条硬规矩：
     *   ① **必须有 bvid** —— 没投成功的东西不该从这里删（那是「待删清单」与任务删除的活），
     *      否则用户会在"这个到底投没投出去"都不确定的时候把源材料删了；
     *   ② 删除走**回收站**（不是 rm），与项目里其它删除路径保持一致 —— 删错了能捞回来。
     *
     * 只动文件，**不动台账**：`cutOutput` / `source.fullVideoPath` 这些字段留着当"它原来在哪"的
     * 记录，所有消费点本来就有 `exists()` 守卫（`publishAsMultiPart` 会明说"没有可用的产出文件"）。
     * 台账要是也清掉，从回收站恢复文件之后反而对不上账。 */
    if (p === '/api/published-file/delete' && method === 'POST') {
      const body = (await this.readBody(req)) as { key?: string; confirm?: boolean };
      const key = String(body.key ?? '').trim();
      if (!key) throw new Error('必须提供 key');
      if (!body.confirm) throw new Error('删除文件不可逆（虽会进回收站），请求必须带 confirm: true');

      const target = this.uploadedFiles().items.find((i) => i['key'] === key);
      if (!target) throw new Error(`找不到这条已投稿文件记录（key=${key}）—— 可能已经被删掉了`);
      const filePath = String(target['filePath'] ?? '');
      const bvid = String(target['bvid'] ?? '');
      if (!bvid) throw new Error('这条记录还没有 bvid（仍在审核/未反查到稿件），不能删除');
      if (!filePath || !exists(filePath)) throw new Error(`文件已经不在了：${filePath || '(无路径)'}`);

      const sizeBytes = fileSize(filePath);
      const r = moveToTrash({
        taskId: String(target['taskId'] ?? ''),
        title: String(target['title'] ?? ''),
        status: 'PUBLISHED',
        paths: [filePath],
        reason: `投稿成功（${bvid}）后在实时监控里手动删除`,
        /* ★ 回收站根目录从**台账路径**推出来，而不是用默认的 `data/trash`。
           用默认值会让单测（临时台账）把回收站条目写进**真实**的 data/trash ——
           实测留了一条 `mon-test-published`，用户打开回收站会看到莫名其妙的条目。
           从 ledger.path 的目录推，测试指向临时目录时回收站也跟着走。 */
        root: path.join(path.dirname(this.orch.ledger.path), 'trash'),
        logger: this.orch.logger,
      });
      this.invalidateMonitor();
      const freed = r.moved > 0 ? r.bytes || sizeBytes : 0;
      this.sendJson(res, 200, {
        ok: r.moved > 0,
        moved: r.moved,
        bytes: freed,
        ...(r.id ? { trashId: r.id } : {}),
        warnings: r.warnings,
        note:
          r.moved > 0
            ? `已把「${path.basename(filePath)}」移入回收站（${fmtBytes(freed)}）—— 稿件 ${bvid} 在 B站 上不受影响，可随时从回收站恢复`
            : `没有移动任何文件${r.warnings.length ? `：${r.warnings.join('；')}` : ''}`,
      });
      return;
    }

    if (p === '/api/import/preview' && method === 'POST') {
      const body = (await this.readBody(req)) as { videoPath?: string };
      const videoPath = String(body.videoPath ?? '').trim();
      if (!videoPath) throw new Error('必须提供 videoPath');
      const preview = await previewRecording(videoPath, cfg, {
        client: orch.client,
        ledger: orch.ledger,
        asrPreflight: (p, d) => orch.preflightAsr(p, d),
        logger: orch.logger,
      });
      this.sendJson(res, 200, preview);
      return;
    }

    /* ---------------- 回收站 ----------------
     * 删除不再不可逆：任务目录与切片产物会被移动到 `data/trash/`，
     * 清单里带完整台账快照，所以「恢复」能连任务记录一起写回。 */
    if (p === '/api/trash' && method === 'GET') {
      this.sendJson(res, 200, orch.trash());
      return;
    }
    if (p === '/api/trash/restore' && method === 'POST') {
      const body = (await this.readBody(req)) as { id?: string };
      if (!body.id) throw new Error('必须提供 id');
      const r = orch.restoreFromTrash(body.id);
      this.sendJson(res, 200, r);
      return;
    }
    if (p === '/api/trash/purge' && method === 'POST') {
      const body = (await this.readBody(req)) as { ids?: string[]; olderThanDays?: number; confirm?: boolean };
      if (!body.confirm) throw new Error('清空回收站不可逆，请求必须带 confirm: true');
      const r = orch.purgeTrash({
        ...(body.ids ? { ids: body.ids } : {}),
        ...(body.olderThanDays !== undefined ? { olderThanDays: body.olderThanDays } : {}),
      });
      this.sendJson(res, 200, { ok: true, ...r, note: `已彻底删除 ${r.purged} 项，释放 ${fmtBytes(r.bytes)}` });
      return;
    }

    /* ---------------- 墓碑（已退役但仍生效的幂等指纹） ----------------
     * 背景：删任务/删切片时，**已经投出去过**的指纹不能直接丢弃 ——
     * 否则同一份素材被重新导入、重新分析出同一区间后，会在 B站 上投出第二个
     * 内容完全相同的稿件（B站 没有删除稿件的开放接口，只能人工去创作中心收拾）。
     * 所以那类指纹退役后会变成「墓碑」继续拦着，并把原因暴露在界面上。
     *
     * 这两个接口就是让用户**看得见、并能推翻**它：
     *   GET  /api/tombstones        → 列表（含为什么立碑、原任务、bvid）
     *   POST /api/tombstone/release → 人工解除（确认 B站 上那个稿件确实没了之后）
     * 解除必须带 confirm:true —— 它是「允许同一内容再投一次」的唯一开关。 */
    if (p === '/api/tombstones' && method === 'GET') {
      const rows = orch.ledger.listTombstones();
      this.sendJson(res, 200, {
        ok: true,
        count: rows.length,
        tombstones: rows,
        note:
          rows.length === 0
            ? '暂无墓碑：所有已发布切片的任务都还在台账里'
            : `有 ${rows.length} 条墓碑在生效。它们代表「这段内容以前投过 B站，而当时的任务已被删除」，` +
              `重新投稿时会被自动跳过。确认对应稿件确实不存在后再解除。`,
      });
      return;
    }
    if (p === '/api/tombstone/release' && method === 'POST') {
      const body = (await this.readBody(req)) as { fingerprint?: string; confirm?: boolean; note?: string };
      if (!body.fingerprint) throw new Error('必须提供 fingerprint');
      if (!body.confirm) {
        throw new Error('解除墓碑等于允许同一内容再次投稿，请求必须带 confirm: true');
      }
      const r = orch.ledger.releaseTombstone(body.fingerprint, {
        ...(body.note ? { note: body.note } : {}),
      });
      if (!r.ok) {
        this.sendJson(res, 404, r);
        return;
      }
      this.sendJson(res, 200, {
        ok: true,
        released: r.released,
        note: `已解除墓碑「${r.released?.title ?? '(无标题)'}」——该录制区间现在可以重新投稿。请确认 B站 上确实没有旧稿件。`,
      });
      return;
    }

    /* ---------------- POST /api/test ---------------- */
    if (p === '/api/test' && method === 'POST') {
      const body = (await this.readBody(req)) as { target?: string; slot?: 'summary' | 'select' };
      const target = body.target ?? 'llm';
      if (target === 'conn' || target === 'bililive') {
        try {
          const v = await orch.client.version();
          const users = await orch.client.userList();
          const drift = await orch.client.checkVersionDrift(cfg.bililive.versionExpected);
          this.sendJson(res, 200, {
            ok: true,
            message:
              `✓ 连接正常 · 版本 ${v} · 已登录 ${users.length} 个账号 · PassKey 有效` +
              (drift?.drift ? `\n⚠️ ${drift.note}` : ''),
          });
        } catch (e) {
          const msg = (e as Error).message;
          const is401 = /401|鉴权|PassKey/i.test(msg);
          this.sendJson(res, 200, {
            ok: false,
            message: is401
              ? `✗ 401 鉴权失败 —— 请检查 config.json 的 bililive.passKey 是否与 biliLive-tools「设置 → 服务」中的 PassKey 完全一致`
              : `✗ 连接失败：${msg}\n请确认 biliLive-tools 桌面版已启动且端口为 ${cfg.bililive.baseUrl}`,
          });
        }
        return;
      }
      if (target === 'alert') {
        const ch = (body as { channel?: string }).channel ?? 'serverchan';
        const r = await orch.alerter.testChannel(ch as never);
        this.sendJson(res, 200, r);
        return;
      }
      // LLM 测试
      const slot = body.slot ?? 'summary';
      const r = await orch.llm.probe(slot);
      this.sendJson(res, 200, r);
      return;
    }

    /* ---------------- POST /api/preview-cut（试看：定位切片产物 + 系统播放器前台播放） ----------------
     *
     * 需求最终形态（用户第 4 轮）：
     *   "当我点击试看的时候 定位切片的产物目录 选择这个文件
     *    然后用 win 系统自带的播放器前台播放给我看"
     *   ⇒ 不转码、不生成预览片段、不弹资源管理器去翻文件，直接用系统播放器看。
     *
     * 所以这里做三件事：
     *   ① 找到该候选**已切好的产物**（`cutOutput`）；没有就说清"还没切片"，
     *      并提示先切片 —— **不擅自触发一次完整切片**（那是副作用很大的另一条路径）；
     *   ② 在资源管理器里**定位并选中**它（用户明确要的"定位产物目录、选择这个文件"）；
     *   ③ 用系统自带播放器打开并**提到前台**（实测坑位见 src/player.ts）。
     *
     * 保留浏览器内联播放那条路（`inline:true`），因为它在"不想离开浏览器"或
     * "本机 .mp4 关联坏掉"时仍有价值，但**不再是默认行为**。 */
    if (p === '/api/preview-cut' && method === 'POST') {
      const body = (await this.readBody(req)) as { taskId?: string; index?: number; inline?: boolean };
      if (!body.taskId || body.index === undefined) throw new Error('需要 taskId 与 index');
      const t = orch.ledger.getTask(body.taskId);
      if (!t) throw new Error(`任务不存在：${body.taskId}`);
      const clip = orch.ledger.getClip(body.taskId, body.index);
      if (!clip) throw new Error(`片段 #${body.index} 不存在`);
      const sourcePath = t.source.fullVideoPath ?? t.source.rawFiles[0];

      /* 未切片：如实说明，不假装成功、也不越权替用户开一次切片 */
      if (!clip.cutOutput || !exists(clip.cutOutput)) {
        this.sendJson(res, 200, {
          ok: false,
          notCut: true,
          note: '该候选还没有切片产物 —— 先点「重新切片」（或等自动流程切完）再看。',
          startSec: clip.start,
          endSec: clip.end,
          ...(sourcePath ? { sourcePath } : {}),
        });
        return;
      }

      const cut = clip.cutOutput;
      /* ② 在资源管理器中定位并选中切片产物 */
      const revealed = this.revealInFileManager(cut);
      if (revealed.ok) {
        orch.logger.info(`试看：已在文件管理器中选中切片产物（${revealed.how}）`, { taskId: body.taskId, data: { clipIndex: body.index } });
      } else {
        orch.logger.warn(`试看：定位切片产物失败 —— ${String(revealed.error)}`, { taskId: body.taskId });
      }

      /* ③ 播放：默认用系统播放器；`inline:true` 时才**真的生成**预览片段走浏览器内联播放。
         默认路径完全不转码、不占磁盘 —— 这就是用户要的"不需要这么麻烦"。 */
      let played: { ok: boolean; player?: string; foreground?: boolean; error?: string } = { ok: false };
      let videoUrl: string | undefined;
      let inlineNote = '';
      if (body.inline) {
        const made = await makePreviewClip({
          taskId: body.taskId,
          sourcePath: cut,
          start: 0,
          end: clip.end - clip.start,
          logger: orch.logger,
        });
        if (made.ok && made.name) {
          videoUrl = `/api/preview/_preview/${encodeURIComponent(made.name)}`;
          inlineNote = made.fromCache ? '（缓存命中）' : `（转码 ${((made.elapsedMs ?? 0) / 1000).toFixed(1)}s）`;
        } else {
          inlineNote = `（片段生成失败：${String(made.error ?? '未知原因')}）`;
        }
        try {
          const c = cleanupPreviews({});
          if (c.removed > 0) orch.logger.debug(`试看片段清理：删除 ${c.removed} 个，保留 ${c.kept} 个`, { mod: 'ui' });
        } catch {
          /* 清理失败不影响试看 */
        }
      } else {
        /* ⚠️ 顺序很重要：**先定位（资源管理器），再打开播放器**。
           实测反过来的话，资源管理器窗口会把前台从播放器手里抢走 ——
           用户看到的是文件夹在前、播放器在后面（这正是被反馈过的"挡住了"）。
           中间那个短延迟是给资源管理器建窗口用的；播放器在它之后打开并前置，
           最终前台就是播放器（实测通过）。 */
        await new Promise((r) => setTimeout(r, 800));
        played = await openInSystemPlayer(cut, { logger: orch.logger });
      }

      this.sendJson(res, 200, {
        ok: body.inline ? Boolean(videoUrl) : played.ok,
        note: body.inline
          ? `${fmtDuration(clip.start)}–${fmtDuration(clip.end)}：内联播放${inlineNote}`
          : played.ok
            ? `已用 ${String(played.player ?? '系统播放器')} 打开${played.foreground ? '并置于前台' : '（未确认到前台，可能被其它窗口挡住）'}` +
              `${revealed.ok ? '，并在资源管理器中选中了该文件' : ''}`
            : `已定位到文件，但播放器打开失败：${String(played.error ?? '未知原因')}`,
        startSec: clip.start,
        endSec: clip.end,
        ...(sourcePath ? { sourcePath } : {}),
        cutOutput: cut,
        cutDir: path.dirname(cut),
        revealed: revealed.ok,
        ...(revealed.how ? { revealHow: revealed.how } : {}),
        ...(played.player ? { player: played.player } : {}),
        ...(played.foreground !== undefined ? { playerForeground: played.foreground } : {}),
        ...(videoUrl ? { videoUrl } : {}),
      });
      return;
    }

    /* ---------------- POST /api/reveal（在文件管理器中定位一个**台账内**的路径） ----------------
     *
     * 用途：UI 上凡是显示路径的地方（源文件、切片产物、任务目录、完整版产物）都能一键打开。
     *
     * ★ 安全设计：**不接受客户端传路径**，只接受 (taskId, kind, index)。
     *   服务端按 kind 去台账里取对应路径 —— 这样即使有人伪造请求，也只能打开
     *   "本项目台账里已登记的文件"，拿不到任意路径的打开能力。
     *   kind：
     *     source   —— 该任务的源视频（优先完整版产物，退回第一个原始文件）
     *     cut      —— 第 index 个切片的切片产物
     *     taskDir  —— 任务目录（含 transcript/signals/clips.json/summary.md）
     *     full     —— 完整版/纯享版产物所在目录（任务目录下的 full/） */
    if (p === '/api/reveal' && method === 'POST') {
      const body = (await this.readBody(req)) as { taskId?: string; kind?: string; index?: number };
      if (!body.taskId) throw new Error('需要 taskId');
      const t = orch.ledger.getTask(body.taskId);
      if (!t) throw new Error(`任务不存在：${body.taskId}`);
      const kind = String(body.kind ?? 'source');
      let target: string | undefined;
      if (kind === 'source') {
        target = t.source.fullVideoPath && exists(t.source.fullVideoPath) ? t.source.fullVideoPath : t.source.rawFiles[0];
      } else if (kind === 'cut') {
        if (body.index === undefined) throw new Error('kind=cut 需要 index');
        const c = orch.ledger.getClip(body.taskId, body.index);
        if (!c?.cutOutput) throw new Error(`片段 #${body.index} 还没有切片产物`);
        target = c.cutOutput;
      } else if (kind === 'taskDir') {
        target = orch.ledger.taskDir(body.taskId);
      } else if (kind === 'full') {
        const dir = path.join(orch.ledger.taskDir(body.taskId), 'full');
        /* 目录可能还没建（还没压制）—— 退回任务目录，而不是报错让用户无从下手 */
        target = exists(dir) ? dir : orch.ledger.taskDir(body.taskId);
      } else {
        throw new Error(`未知的 kind：${kind}（支持 source / cut / taskDir / full）`);
      }
      const r = this.revealInFileManager(target ?? '');
      if (!r.ok) {
        this.sendJson(res, 400, { ok: false, error: r.error, target });
        return;
      }
      orch.logger.info(`已在文件管理器中定位（${kind}）：${target}`, { taskId: body.taskId });
      this.sendJson(res, 200, { ok: true, target, how: r.how });
      return;
    }

    /* ---------------- GET /api/schedule ---------------- */
    if (p === '/api/schedule' && method === 'GET') {
      const tasks = orch.ledger.listTasks({ limit: 200 });
      const pending: Array<Record<string, unknown>> = [];
      const published: Array<Record<string, unknown>> = [];
      for (const t of tasks) {
        for (const c of orch.ledger.getClips(t.id)) {
          const row = {
            taskId: t.id,
            index: c.index,
            title: c.title,
            start: c.start,
            end: c.end,
            durationSec: c.end - c.start,
            status: c.status,
            dtime: c.dtime,
            dtimeText: c.dtime ? fmtLocal(c.dtime * 1000) : undefined,
            bvid: c.bvid,
            url: c.bvid ? `https://www.bilibili.com/video/${c.bvid}` : undefined,
            degraded: c.degraded,
            isOnlySelf: cfg.publish.isOnlySelf === 1,
          };
          if (c.status === 'PUBLISHED') published.push(row);
          else if (c.status === 'SUBMITTED' || c.status === 'CUT' || c.status === 'CUTTING' || c.status === 'PENDING_UPLOAD' || c.selected) {
            pending.push(row);
          }
        }
      }
      pending.sort((a, b) => Number(a['dtime'] ?? 0) - Number(b['dtime'] ?? 0));
      published.sort((a, b) => Number(b['dtime'] ?? 0) - Number(a['dtime'] ?? 0));
      const tasksWithRetention = tasks.slice(0, 40).map((t) => {
        const r = retentionNote(t, cfg);
        return { taskId: t.id, title: t.title, keep: r.keep, note: r.note };
      });
      this.sendJson(res, 200, { pending, published, retention: tasksWithRetention });
      return;
    }

    /* ---------------- GET /api/performance ---------------- */
    if (p === '/api/performance' && method === 'GET') {
      this.sendJson(res, 200, this.performanceView());
      return;
    }

    /* ---------------- POST /api/performance/refresh ---------------- */
    if (p === '/api/performance/refresh' && method === 'POST') {
      const r = await orch.refreshPerformance();
      this.sendJson(res, 200, r);
      return;
    }

    /* ---------------- GET /api/prompts ---------------- */
    if (p === '/api/prompts' && method === 'GET') {
      const store = new PromptStore();
      const list = store.list();
      const detailed = list.map((l) => {
        try {
          const text = fs.readFileSync(path.join(ROOT_DIR, 'prompts', `${l.name}.md`), 'utf8');
          return { ...l, text };
        } catch {
          return { ...l, text: '' };
        }
      });
      this.sendJson(res, 200, { prompts: detailed, changedHint: '修改 prompts/*.md 后无需重启：下次分析会重新读取' });
      return;
    }

    /* ---------------- GET /api/preview/:taskId/:file ----------------
     *
     * `taskId` 传 `_preview` 时指向**试看片段目录**（`data/preview/`）—— 见下面 servePreview 的说明。
     * 这样试看生成的 mp4 能直接复用这套 Range + 防遍历逻辑，不必再写一套。 */
    const previewMatch = /^\/api\/preview\/([^/]+)\/(.+)$/.exec(p);
    if (previewMatch && (method === 'GET' || method === 'HEAD')) {
      const taskId = decodeURIComponent(previewMatch[1]!);
      const file = decodeURIComponent(previewMatch[2]!);
      this.servePreview(req, res, taskId, file);
      return;
    }

    this.sendJson(res, 404, { error: `未知 API：${method} ${p}` });
  }

  /* ------------------------------------------------------------------------
   * 页面与预览
   * ---------------------------------------------------------------------- */

  private serveUi(res: http.ServerResponse): void {
    if (!exists(this.uiPath)) {
      this.sendText(
        res,
        500,
        `找不到 UI 页面文件：${this.uiPath}\n请确认 public/ui.html 存在。`,
      );
      return;
    }
    let html = fs.readFileSync(this.uiPath, 'utf8');
    // 注入 CSRF token 与运行时信息（不落盘、不写日志）
    const inject = `<script>window.__BOOT__=${JSON.stringify({
      csrf: this.csrfToken,
      version: APP_VERSION,
      roomId: this.orch.config.room.roomId,
      platform: this.orch.config.room.platform,
    })};</script>`;
    html = html.replace('<!--__BOOT__-->', inject);
    // UI 自身也不允许内联脚本以外的外链，加一层安全头
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(html);
  }

  /**
   * 本地预览：**只允许任务目录内的文件**（硬约束 #15）。
   *
   * 路径遍历防护做三层：
   *   1. 拒绝含 `..` 的原始请求（在解码之前就拒，避免编码绕过）
   *   2. 解析成绝对路径后，要求它的真实路径仍在该任务的目录内
   *   3. 只允许白名单扩展名
   */
  private servePreview(req: http.IncomingMessage, res: http.ServerResponse, taskId: string, file: string): void {
    if (!/^[\w.-]+$/.test(taskId)) {
      this.sendJson(res, 400, { error: 'taskId 含非法字符' });
      return;
    }
    if (file.includes('..') || file.includes('\0') || path.isAbsolute(file)) {
      this.sendJson(res, 400, { error: '文件名非法：禁止路径遍历' });
      return;
    }
    const allowed = new Set(['.json', '.md', '.txt', '.srt', '.jsonl', '.llc', '.mp4', '.flv', '.ts', '.ass', '.xml', '.jpg', '.png']);
    const ext = path.extname(file).toLowerCase();
    if (!allowed.has(ext)) {
      this.sendJson(res, 415, { error: `不允许预览的文件类型：${ext || '(无扩展名)'}` });
      return;
    }

    const taskDir = this.orch.ledger.taskDir(taskId);
    /* ★ `_preview` 是一个**伪 taskId**，指向试看片段目录（`data/preview/`）。
       为什么要这样接：试看需要在界面内联播放，而 `<video>` 只认 mp4；
       源录播是 flv 且在任务目录之外，所以必须先烧一个 mp4 到固定目录。
       把该目录挂到同一个 `/api/preview/` 路由上，就能直接复用它已经过测试的
       Range 支持与防路径遍历逻辑（smoke 里有专项断言），不必另写一套。
       安全性不打折：文件名仍受下面的 `..`/绝对路径/扩展名白名单三重校验。 */
    const baseDir = taskId === '_preview' ? PREVIEW_DIR : taskDir;
    const target = path.resolve(baseDir, file);
    const realTaskDir = path.resolve(baseDir);
    if (!target.startsWith(realTaskDir + path.sep) && target !== realTaskDir) {
      this.sendJson(res, 403, { error: '拒绝访问任务目录之外的文件' });
      return;
    }
    if (!exists(target)) {
      this.sendJson(res, 404, { error: `文件不存在：${file}` });
      return;
    }
    const stat = fs.statSync(target);
    if (!stat.isFile()) {
      this.sendJson(res, 403, { error: '不是普通文件' });
      return;
    }

    // 文本类直接返回内容（供 UI 渲染 log / json）
    if (['.json', '.md', '.txt', '.srt', '.jsonl', '.llc'].includes(ext)) {
      const text = fs.readFileSync(target, 'utf8');
      this.sendText(res, 200, text, ext === '.md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8');
      return;
    }

    // 媒体类支持 HTTP Range（§8 WP7 硬性要求）
    const range = req.headers.range;
    const type =
      ext === '.mp4'
        ? 'video/mp4'
        : ext === '.png'
          ? 'image/png'
          : ext === '.jpg'
            ? 'image/jpeg'
            : 'application/octet-stream';
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const size = stat.size;
        let start = m[1] ? Number(m[1]) : 0;
        let end = m[2] ? Number(m[2]) : size - 1;
        if (!m[1] && m[2]) {
          // bytes=-N 形式：取最后 N 字节
          start = Math.max(0, size - Number(m[2]));
          end = size - 1;
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
          return;
        }
        end = Math.min(end, size - 1);
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        fs.createReadStream(target, { start, end }).pipe(res);
        return;
      }
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(target).pipe(res);
  }

  /* ------------------------------------------------------------------------
   * 录制器 webhook（入站）
   * ---------------------------------------------------------------------- */

  /**
   * 接收录制器事件。
   *
   * ⚠️ 方向：biliLive-tools 的 `/webhook/*` 是**入站接口**（给外部录制器调用的），
   *    自研服务**不能从那里订阅事件**（陷阱 #26）。
   *    首选方案是让录制器**直接配置两个 webhook 目标**（零转发、零单点故障）；
   *    只有在录制器只支持单目标时才由本服务转发（硬约束 #18：原样即时、先落盘再转发、落盘失败不阻塞转发）。
   */
  private async handleRecorderWebhook(req: http.IncomingMessage, res: http.ServerResponse, p: string): Promise<void> {
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: '录制器 webhook 只接受 POST' });
      return;
    }
    let body: unknown = {};
    try {
      body = await this.readBody(req, 1024 * 1024);
    } catch (e) {
      this.sendJson(res, 400, { error: (e as Error).message });
      return;
    }
    const headers: Record<string, string> = {};
    for (const k of ['content-type', 'user-agent', 'x-recorder', 'x-signature']) {
      const v = req.headers[k];
      if (typeof v === 'string') headers[k] = v;
    }
    const result = await this.orch.relay.handle({
      receivedAt: nowIso(),
      path: p,
      body,
      headers,
    });
    // 事件可能是「录制完成」的加速信号 —— 立即触发一次轮询（不等 60 秒）
    void this.orch.trigger.pollOnce().catch(() => undefined);
    this.sendJson(res, 200, { ok: true, ...result });
  }

  /* ------------------------------------------------------------------------
   * 视图拼装
   * ---------------------------------------------------------------------- */

  private stageIndex(t: TaskRecord): number {
    const map: Record<string, number> = {
      PENDING: 0,
      RECORDED: 0,
      TRANSCRIBING: 1,
      TRANSCRIBED: 1,
      ANALYZING: 2,
      ANALYZED: 2,
      CLIPPING: 3,
      CLIPPED: 3,
      PUBLISHING: 3,
      PUBLISHED: 4,
      FAILED: -1,
      ARCHIVED: 4,
      CANCELED: -1,
    };
    return map[t.status] ?? 0;
  }

  private statusText(t: TaskRecord): string {
    const idx = this.stageIndex(t);
    const label = idx >= 0 ? STAGE_LABELS[idx] ?? '' : '';
    const p = this.orch.progress.get(t.id);
    switch (t.status) {
      case 'PENDING':
      case 'RECORDED':
        return '已录制 · 待处理';
      case 'TRANSCRIBING':
        return p ? `转写中 ${p.current}/${p.total}` : '转写中';
      case 'TRANSCRIBED':
        return '转写完成';
      case 'ANALYZING':
        return p?.label ? `分析中（${p.label}）` : '分析中';
      case 'ANALYZED':
        return '待审核';
      case 'CLIPPING':
        return p ? `切片中 ${p.current}/${p.total}` : '切片中';
      case 'CLIPPED':
        return '已切片 · 待发布';
      case 'PUBLISHING':
        return '投稿中';
      case 'PUBLISHED':
        return '已发布';
      case 'ARCHIVED':
        return '已归档';
      case 'FAILED':
        return t.error ? `失败于${t.error.stage}` : '失败';
      case 'CANCELED':
        return '已取消';
      default:
        return String(t.status) + label;
    }
  }

  private toTaskSummary(t: TaskRecord): Record<string, unknown> {
    const clips = this.orch.ledger.getClips(t.id);
    const withClips = { ...t, clips } as TaskRecord;
    const s = summarizeTask(withClips, {
      stageIndex: this.stageIndex(t),
      statusText: this.statusText(t),
      when: fmtLocal(Date.parse(t.createdAt)),
    });
    const p = this.orch.progress.get(t.id);
    return {
      ...s,
      ...(p ? { progress: p } : {}),
      cost: t.cost,
      fullUpload: t.fullUpload,
    };
  }

  /**
   * 「实时监控」面板的数据聚合（只读）。
   *
   * 一次给全四类信息，回答用户真正会问的问题：
   *   ① 现在在干什么 → `pipeline`（活跃任务 + 阶段进度 + 已用时间 + 花费）
   *   ② 在等什么     → `waiting`（等完整版稿件）/ `scheduled`（已排期待投）/ `pendingDelete`（待删）
   *   ③ 为什么没动   → `watch.outcomes`（轮询上一轮对每个文件的结论）/ `recordingNow`（还在写）
   *   ④ 有没有坏事   → `errors` / `recentPublished`
   *
   * 每一块都独立 try/catch 降级：面板最怕的是"因为某一跳超时整页空白"，
   * 那会让人以为助手挂了，而实际只是 biliLive-tools 忙。
   */
  private async monitorView(): Promise<Record<string, unknown>> {
    const cached = this.monitorCache;
    if (cached && Date.now() - cached.at < UiServer.MONITOR_CACHE_MS) return cached.data;
    const orch = this.orch;
    const cfg = orch.config;
    const now = Date.now();

    /* ---- 1. 依赖健康（含 biliLive-tools 版本/账号/磁盘/队列） ---- */
    let health: Awaited<ReturnType<Orchestrator['health']>> | undefined;
    let healthError: string | undefined;
    try {
      health = await orch.health();
    } catch (e) {
      healthError = (e as Error).message;
    }

    /* ---- 2. 台账：活跃任务 / 等待 / 排期 / 今日花费 ---- */
    const tasks = orch.ledger.listTasks({ limit: 300 });
    const dayStart = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
    const FINAL = new Set(['PUBLISHED', 'ARCHIVED', 'FAILED', 'CANCELED']);

    const pipeline = tasks
      .filter((t) => !FINAL.has(t.status))
      .map((t) => {
        const s = this.toTaskSummary(t) as unknown as TaskSummaryLite;
        return {
          id: t.id,
          title: t.title,
          streamer: t.streamer ?? '',
          status: t.status,
          statusText: s.statusText ?? t.status,
          stageIndex: s.stageIndex ?? 0,
          stages: this.stageStates(t),
          progress: s.progress ?? null,
          elapsedSec: Math.max(0, Math.round((now - Date.parse(t.createdAt)) / 1000)),
          publishWaiting: s.publishWaiting === true,
          importSource: t.importSource ?? (t.manual ? 'manual' : 'recording'),
          costYuan: Number(((t.cost?.asrEstimate ?? 0) + (t.cost?.llmActual ?? 0)).toFixed(4)),
          hasError: Boolean(t.error),
          errorStage: t.error?.stage ?? null,
        };
      })
      .sort((a, b) => b.elapsedSec - a.elapsedSec);

    const waiting = tasks
      .filter((t) => t.publishWait)
      .map((t) => {
        const w = t.publishWait!;
        const until = Date.parse(w.until);
        return {
          id: t.id,
          title: t.title,
          status: t.status,
          reason: w.reason,
          since: w.since,
          until: w.until,
          attempts: w.attempts,
          remainSec: Number.isFinite(until) ? Math.max(0, Math.round((until - now) / 1000)) : 0,
          expired: Number.isFinite(until) ? until <= now : false,
        };
      });

    /* 排期：只看最近这些任务里的切片，避免每 5 秒把 300 个任务的 clips.json 全读一遍 */
    const scheduled: Array<Record<string, unknown>> = [];
    let cutAwaitingCount = 0;
    for (const t of tasks.slice(0, 60)) {
      for (const c of orch.ledger.getClips(t.id)) {
        if (c.status === 'PUBLISHED') continue;
        if (c.status === 'CUT' || c.status === 'CUTTING' || c.status === 'PENDING_UPLOAD') cutAwaitingCount++;
        if (c.dtime) {
          scheduled.push({
            taskId: t.id,
            index: c.index,
            title: c.title,
            status: c.status,
            dtime: c.dtime,
            dtimeText: fmtLocal(c.dtime * 1000),
          });
        }
      }
    }
    scheduled.sort((a, b) => Number(a['dtime'] ?? 0) - Number(b['dtime'] ?? 0));

    const todayTasks = tasks.filter((t) => Date.parse(t.createdAt) >= dayStart);
    const sum = (f: (t: TaskRecord) => number): number => Number(todayTasks.reduce((a, t) => a + (Number(f(t)) || 0), 0).toFixed(4));
    const costToday = {
      asr: sum((t) => t.cost?.asrEstimate ?? 0),
      llm: sum((t) => t.cost?.llmActual ?? 0),
    };

    const recentPublished = tasks
      .filter((t) => t.status === 'PUBLISHED' || t.status === 'ARCHIVED')
      .sort((a, b) => Date.parse(b.publishedAt ?? b.updatedAt) - Date.parse(a.publishedAt ?? a.updatedAt))
      .slice(0, 3)
      .map((t) => ({
        id: t.id,
        title: t.title,
        publishedAt: t.publishedAt ?? t.updatedAt,
        clips: orch.ledger
          .getClips(t.id)
          .filter((c) => c.bvid)
          .slice(0, 3)
          .map((c) => ({ index: c.index, title: c.title, bvid: c.bvid, url: `https://www.bilibili.com/video/${c.bvid}` })),
      }));

    /* ---- 2b. 已投稿文件：盘上哪些产物已经交出去了、审核到什么程度、能不能删 ---- */
    const up = this.uploadedFiles();
    const states = await this.archiveStates();
    const uploadedFiles: Array<Record<string, unknown>> = up.items.map((i) => {
      const bvid = typeof i['bvid'] === 'string' ? i['bvid'] : '';
      const st = bvid ? states.map.get(bvid) : undefined;
      const review = reviewStatusOf(bvid || undefined, st);
      return { ...i, ...(st ? { archiveTitle: st.title, pubtime: st.pubtime } : {}), ...review };
    });

    /* ---- 3. 目录轮询：它在盯哪些目录、上一轮对每个文件下了什么结论 ---- */
    let watch: Record<string, unknown> = {};
    let outcomes: Array<Record<string, unknown>> = [];
    try {
      watch = orch.watcher.status() as unknown as Record<string, unknown>;
      if (Array.isArray(watch['lastOutcomes'])) outcomes = watch['lastOutcomes'] as Array<Record<string, unknown>>;
    } catch (e) {
      watch = { error: (e as Error).message };
    }
    const recordingNow = outcomes
      .filter((o) => typeof o['skipped'] === 'string' && /仍在写入|可能仍在录制/.test(String(o['skipped'])))
      .map((o) => ({ fileName: o['fileName'], title: o['title'], sizeMB: o['sizeMB'], note: o['skipped'] }));

    /* ---- 4. 待删清单 ---- */
    let pendingDelete: Record<string, unknown> = { count: 0, items: [] };
    try {
      const pd = listPendingDelete();
      const items = [...pd.pending].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
      const dueTimes = items.map((i) => Date.parse(i.dueAt)).filter((n) => Number.isFinite(n));
      pendingDelete = {
        count: items.length,
        totalMB: Number((items.reduce((a, i) => a + (Number(i.sizeBytes) || 0), 0) / 1024 ** 2).toFixed(1)),
        nextDueSec: dueTimes.length ? Math.max(0, Math.round((Math.min(...dueTimes) - now) / 1000)) : null,
        overdueCount: dueTimes.filter((n) => n <= now).length,
        items: items.slice(0, 5).map((i) => ({
          id: i.id,
          path: i.path,
          kind: i.kind,
          taskId: i.taskId,
          reason: i.reason,
          sizeBytes: i.sizeBytes,
          sizeMB: Number(((Number(i.sizeBytes) || 0) / 1024 ** 2).toFixed(1)),
          dueAt: i.dueAt,
          /** 界面上「立即删除」要在点之前就把后果说清楚：进回收站 vs 永久删除 */
          willTrash: i.willTrash,
          existsNow: i.existsNow,
        })),
      };
    } catch (e) {
      pendingDelete = { count: 0, items: [], error: (e as Error).message };
    }

    /* ---- 5. biliLive-tools 自己的队列（它在压制/上传什么） ----
     * 这一跳是"顺路看看"：1.5 秒拿不到就算了（缓存 10 秒），绝不能让面板等它。 */
    let llcQueue: Array<Record<string, unknown>> = [];
    let llcQueueError: string | undefined;
    const qc = this.llcQueueCache;
    if (qc && now - qc.at < UiServer.LLC_QUEUE_CACHE_MS) {
      llcQueue = qc.data;
      llcQueueError = qc.error;
    } else {
      try {
        const r = await orch.client.taskList({ pageSize: 30, timeoutMs: 1500 });
        llcQueue = (r.list ?? [])
          .filter((t) => t.status === 'running' || t.status === 'pending' || t.status === 'waiting')
          .slice(0, 8)
          .map((t) => ({
            id: t.id,
            type: t.type,
            status: t.status,
            output: typeof t.output === 'string' ? t.output : undefined,
          }));
      } catch (e) {
        llcQueueError = (e as Error).message;
      }
      this.llcQueueCache = { at: now, data: llcQueue, ...(llcQueueError ? { error: llcQueueError } : {}) };    }

    const errors = readErrorEvents({ limit: 5 }).map((e) => ({
      at: e.at,
      stage: e.stage,
      type: e.type,
      message: String(e.message ?? '').slice(0, 160),
      reportId: e.reportId,
    }));

    const data: Record<string, unknown> = {
      now: nowIso(),
      uptimeSec: Math.round(process.uptime()),
      version: APP_VERSION,
      roomId: cfg.room.roomId,
      platform: cfg.room.platform,
      mode: health?.mode ?? {
        autoPublish: cfg.publish.autoPublish,
        isOnlySelf: cfg.publish.isOnlySelf === 1,
        dryRun: cfg.runtime.allowPaid === false,
        allowPaid: cfg.runtime.allowPaid,
      },
      ...(healthError ? { healthError } : {}),
      bililive: health?.bililive ?? { ok: false, version: '', expected: '', drift: false, message: healthError ?? '未知' },
      account: health?.account ?? null,
      disk: health?.disk ?? null,
      queue: health?.queue ?? { busy: false, length: 0, paused: false },
      trigger: health?.trigger ?? null,
      storage: health?.storage ?? null,
      todayPublished: health?.todayPublished ?? 0,
      dailyLimit: health?.dailyLimit ?? 0,
      errorsLast24h: health?.errorsLast24h ?? 0,
      costToday: { ...costToday, total: Number((costToday.asr + costToday.llm).toFixed(4)) },
      pipeline,
      waiting,
      scheduled: { count: scheduled.length, next: scheduled.slice(0, 5) },
      cutAwaitingCount,
      recordingNow,
      watch: {
        enabled: watch['enabled'] ?? false,
        dirs: watch['dirs'] ?? [],
        lastScanAt: watch['lastScanAt'] ?? null,
        lastScanAgoSec: watch['lastScanAgoSec'] ?? null,
        importedTotal: watch['importedTotal'] ?? 0,
        scanning: watch['scanning'] ?? false,
        backoffCount: watch['backoffCount'] ?? 0,
        outcomes,
      },
      pendingDelete,
      llcQueue,
      ...(llcQueueError ? { llcQueueError } : {}),
      recentPublished,
      uploadedFiles: {
        count: uploadedFiles.length,
        deletableCount: uploadedFiles.filter((i) => i['deletable'] === true).length,
        totalMB: up.totalMB,
        deletedCount: up.deletedCount,
        ...(states.error ? { error: states.error } : {}),
        items: uploadedFiles,
      },
      errors,
      stageLabels: STAGE_LABELS,
    };
    this.monitorCache = { at: Date.now(), data };
    return data;
  }

  /**
   * 拉一次「已投稿件的审核状态」，带 60 秒缓存。
   *
   * 判据用 B站 自己给的 `state_desc`（实测直接是中文「审核中」，已通过时为空），
   * 拿不到才退回 `state === 0`。**不去猜状态码** —— `-30` 这种值在审核/仅自己可见/
   * 打回之间并不能靠数字区分，而 `state_desc` 是官方文案。
   */
  private async archiveStates(): Promise<{ map: Map<string, { state: number; stateDesc: string; title: string; pubtime: number }>; error?: string }> {
    const now = Date.now();
    const c = this.archivesCache;
    if (c && now - c.at < UiServer.ARCHIVES_CACHE_MS) return { map: c.data, ...(c.error ? { error: c.error } : {}) };
    try {
      const list = await this.orch.client.biliArchives({ page: 1, pageSize: 100, timeoutMs: 2500 });
      const map = new Map<string, { state: number; stateDesc: string; title: string; pubtime: number }>();
      for (const a of list) {
        if (!a.bvid) continue;
        map.set(String(a.bvid), {
          state: Number(a['state'] ?? 0),
          stateDesc: String(a['state_desc'] ?? '').trim(),
          title: String(a.title ?? ''),
          pubtime: Number(a.pubtime ?? a.ctime ?? 0),
        });
      }
      this.archivesCache = { at: now, data: map };
      return { map };
    } catch (e) {
      const error = (e as Error).message;
      // 拿不到就沿用上一次的：面板宁可显示 60 秒前的状态，也不要整块忽明忽暗
      if (c) {
        this.archivesCache = { at: c.at, data: c.data, error };
        return { map: c.data, error };
      }
      this.archivesCache = { at: now, data: new Map(), error };
      return { map: new Map(), error };
    }
  }

  /**
   * 「已投稿文件」清单：本地哪些产物文件对应着 B站 上已经投出去的东西。
   *
   * 为什么单列一块：用户要回答的是「**我盘上哪些文件已经交出去了、能不能删**」，
   * 而面板原有的「最近投稿」只列任务与 bvid，既看不到文件、也不能删。
   *
   * 三类产物：
   *   - `clip`  切片成片（`clip.cutOutput`）—— bvid 记在切片上
   *   - `full`  完整弹幕版（biliLive-tools 压制产物）—— **按命名约定在录制目录里现场找**，
   *     因为它是录制结束后才生成的，导入那一刻台账里根本没有它
   *   - `pure`  纯享版（任务目录 `full/` 下 p2/pure 命名的 mp4）—— 与完整版同一个稿件
   *
   * 审核状态：**没有 bvid = 还没反查到（审核中）**；有 bvid 就看 B站 给的状态文案。
   * `deletable` 只在「有 bvid 且文件还在」时为真 —— 这正是用户要求的删除门槛：
   * 没投成功的东西不该从这儿删（那是「待删清单」和任务删除的活）。
   */
  private uploadedFiles(): {
    items: Array<Record<string, unknown>>;
    totalMB: number;
    deletedCount: number;
    error?: string;
  } {
    const orch = this.orch;
    const items: Array<Record<string, unknown>> = [];
    let totalBytes = 0;
    let deletedCount = 0;
    /** 同一个产物文件只能出现一次 —— 相邻两段的原始文件名互为前缀时会被算到两场头上 */
    const seenProductPaths = new Set<string>();

    const pushOne = (o: {
      key: string;
      taskId: string;
      kind: 'clip' | 'full' | 'pure';
      clipIndex?: number;
      title: string;
      filePath?: string;
      bvid?: string;
      /** bvid 是怎么来的：任务字段 / 同一稿件的切片 / 没有。界面据此说明可信度 */
      bvidFrom?: 'task' | 'clip' | 'none';
      at?: string;
    }): void => {
      const p = o.filePath;
      const existsNow = Boolean(p && exists(p));
      const sizeBytes = existsNow && p ? fileSize(p) : 0;
      if (existsNow) totalBytes += sizeBytes;
      else if (p) deletedCount++;
      items.push({
        key: o.key,
        taskId: o.taskId,
        kind: o.kind,
        kindText: o.kind === 'clip' ? '切片' : o.kind === 'full' ? '完整弹幕版' : '纯享版',
        ...(o.clipIndex !== undefined ? { clipIndex: o.clipIndex } : {}),
        title: o.title,
        ...(p ? { filePath: p, fileName: path.basename(p) } : {}),
        exists: existsNow,
        sizeBytes,
        sizeMB: Number((sizeBytes / 1024 ** 2).toFixed(2)),
        /* 界面上显示的是 `sizeText` 而不是 `sizeMB`：切片可能只有几百 KB，
           而 `toFixed(1)` 的 MB 会把它们全显示成 "0 MB"（实测踩到）。
           `fmtBytes` 会自己选单位。`sizeMB` 留着给需要数值的地方排序/求和。 */
        sizeText: existsNow ? fmtBytes(sizeBytes) : '—',
        ...(o.bvid ? { bvid: o.bvid, url: `https://www.bilibili.com/video/${o.bvid}` } : {}),
        ...(o.bvidFrom ? { bvidFrom: o.bvidFrom } : {}),
        ...(o.at ? { at: o.at } : {}),
        /** 只有「已反查到 bvid 且文件还在」才允许删 —— 用户明确要求的口径 */
        deletable: Boolean(o.bvid) && existsNow,
      });
    };

    for (const t of orch.ledger.listTasks({ limit: 50 })) {
      const clips = orch.ledger.getClips(t.id);
      // 切片：投过（有 uploadTaskId / bvid）或已到 SUBMITTED 之后的都算
      for (const c of clips) {
        const submitted = Boolean(c.uploadTaskId) || Boolean(c.bvid) || c.status === 'SUBMITTED' || c.status === 'PUBLISHED' || c.status === 'SUBMITTING';
        if (!submitted) continue;
        pushOne({
          key: `${t.id}:clip:${c.index}`,
          taskId: t.id,
          kind: 'clip',
          clipIndex: c.index,
          title: c.title,
          ...(c.cutOutput ? { filePath: c.cutOutput } : {}),
          ...(c.bvid ? { bvid: c.bvid } : {}),
          ...(c.publishedAt ?? c.createdAt ? { at: c.publishedAt ?? c.createdAt } : {}),
        });
      }

      /* 完整版 / 纯享版 —— biliLive-tools 投的那些。
       *
       * ⚠️ `t.fullVideoBvid` 实测**永远是 undefined**：完整版是录制结束**之后**才压出来的，
       * 而任务在「录制文件稳定」时就导入了，那一刻产物还不存在，`source.fullVideoPath` 也是空的。
       * 所以两个都得现场找：
       *   · 文件 → 按命名约定在录制目录里找（`findVideoProducts`，与 PRODUCT_SUFFIX 同一套口径）；
       *   · bvid → 退而取本场**切片的 bvid**。这是对的：我们的切片正是追加进
       *     biliLive-tools 为这场建的那个稿件（`findResumeTarget` 按标题反查到的），
       *     也就是完整版所在的那个稿件。找不到任何切片 bvid 时才真的没有 —— 那时不编，
       *     如实显示「审核中」并说明原因（界面会给 tooltip）。
       */
      const clipBvid = clips.find((c) => c.bvid)?.bvid;
      const fullBvid = t.fullVideoBvid ?? clipBvid;
      const bvidFrom = t.fullVideoBvid ? 'task' : clipBvid ? 'clip' : 'none';
      const rawPaths = [...t.source.rawFiles, ...t.source.segments.map((s) => s.path)];
      for (const raw of rawPaths) {
        for (const prod of findVideoProducts(raw)) {
          const key = prod.toLowerCase();
          if (seenProductPaths.has(key)) continue;
          seenProductPaths.add(key);
          pushOne({
            key: `${t.id}:full:${path.basename(prod)}`,
            taskId: t.id,
            kind: 'full',
            title: `${path.basename(prod)} · 完整版（biliLive-tools 压制）`,
            filePath: prod,
            ...(fullBvid ? { bvid: fullBvid } : {}),
            bvidFrom,
            at: t.publishedAt ?? t.updatedAt,
          });
        }
      }
      // 台账里显式记过完整版路径时也补一条（助手自投完整版的路径会写这个字段）
      if (t.source.fullVideoPath && !seenProductPaths.has(t.source.fullVideoPath.toLowerCase())) {
        seenProductPaths.add(t.source.fullVideoPath.toLowerCase());
        if (exists(t.source.fullVideoPath)) {
          pushOne({
            key: `${t.id}:full`,
            taskId: t.id,
            kind: 'full',
            title: `${t.title} · 完整弹幕版`,
            filePath: t.source.fullVideoPath,
            ...(fullBvid ? { bvid: fullBvid } : {}),
            bvidFrom,
            at: t.publishedAt ?? t.updatedAt,
          });
        }
      }

      /* 纯享版：助手自投多分P 时会 remux 到任务目录 full/ 下（p2/pure 命名）。
         biliLive-tools 那条路不落盘（它是上传时现转的），所以盘上没有就不列 —— 不编。 */
      const fullDir = path.join(orch.ledger.taskDir(t.id), 'full');
      try {
        for (const n of fs.existsSync(fullDir) ? fs.readdirSync(fullDir) : []) {
          const low = n.toLowerCase();
          if (!low.endsWith('.mp4')) continue;
          if (!low.includes('p2') && !low.includes('pure')) continue;
          const p = path.join(fullDir, n);
          if (seenProductPaths.has(p.toLowerCase())) continue;
          seenProductPaths.add(p.toLowerCase());
          pushOne({
            key: `${t.id}:pure`,
            taskId: t.id,
            kind: 'pure',
            title: `${t.title} · 纯享版`,
            filePath: p,
            ...(fullBvid ? { bvid: fullBvid } : {}),
            bvidFrom,
            at: t.publishedAt ?? t.updatedAt,
          });
        }
      } catch {
        /* 目录读不到就当没有 */
      }
    }

    // 只留还存在的（删掉的会从列表消失，另给一个计数说明）
    const alive = items.filter((i) => i['exists'] === true);
    // 有 bvid 的排前面（那些才是能删的），再按时间倒序
    alive.sort((a, b) => {
      const ab = a['bvid'] ? 1 : 0;
      const bb = b['bvid'] ? 1 : 0;
      if (ab !== bb) return bb - ab;
      return String(b['at'] ?? '').localeCompare(String(a['at'] ?? ''));
    });
    return { items: alive, totalMB: Number((totalBytes / 1024 ** 2).toFixed(1)), deletedCount };
  }

  /**
   * 五个阶段的「完成 / 进行中 / 失败 / 未开始」。
   *
   * 抽出来是因为详情页和监控面板都要画同一条阶段条 ——
   * 各写一份必然漂移（实测：监控面板第一版直接取了 `summarizeTask().stages`，
   * 而那个字段其实不存在，于是 5 个阶段全画成灰的，看起来像"什么都没做"）。
   */
  private stageStates(t: TaskRecord): string[] {
    const idx = this.stageIndex(t);
    return STAGE_ORDER.slice(1).map((_, i) => {
      if (t.status === 'FAILED' && t.error) {
        const failedIdx = STAGE_LABELS.indexOf(t.error.stage.replace(/中$/, ''));
        if (failedIdx >= 0) return i === failedIdx ? 'fail' : i < failedIdx ? 'done' : 'todo';
      }
      if (i < idx) return 'done';
      if (i === idx) return ['PUBLISHED', 'ARCHIVED', 'ANALYZED', 'CLIPPED'].includes(t.status) ? 'done' : 'active';
      return 'todo';
    });
  }

  private toTaskDetail(t: TaskRecord): Record<string, unknown> {
    const orch = this.orch;
    const clips = orch.ledger.getClips(t.id);
    const stages = this.stageStates(t);

    let summary: string | undefined;
    if (t.summaryPath && exists(t.summaryPath)) {
      summary = fs.readFileSync(t.summaryPath, 'utf8');
    }
    let signals: unknown;
    if (t.signalsPath && exists(t.signalsPath)) {
      try {
        signals = readJson(t.signalsPath);
      } catch {
        /* ignore */
      }
    }
    let transcriptPreviewOut: Array<{ time: string; text: string }> | undefined;
    if (t.transcriptPath && exists(t.transcriptPath)) {
      try {
        transcriptPreviewOut = transcriptPreview(readJson(t.transcriptPath), 60);
      } catch {
        /* ignore */
      }
    }

    const rawBytes = t.source.rawFiles.reduce((a, f) => a + fileSize(f), 0);
    const verdict = judgeDeletability(t, orch.config, { now: Date.now() });
    const coverInfo = resolveCover(orch.config, {}, undefined);
    const listFiles = (t2: TaskRecord): string[] => {
      const dir = orch.ledger.taskDir(t2.id);
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    };

    return {
      ...this.toTaskSummary(t),
      stage: t.stage,
      stages,
      statusText: this.statusText(t),
      // 本场主播（分析阶段识别出的）：界面要能看出"总结/标题是按谁写的"
      ...(t.streamer ? { streamer: t.streamer } : {}),
      ...(summary ? { summary } : {}),
      ...(signals ? { signals } : {}),
      ...(transcriptPreviewOut ? { transcriptPreview: transcriptPreviewOut } : {}),
      /* 被墓碑拦下的切片要把**墓碑本体**一起带上（而不是只给一个指纹）：
         界面需要显示「以前投到哪个 bvid、原来的任务叫什么、什么时候被删的」，
         否则用户只会看到「这片没投出去」而查不出原因。
         指纹查不到就置 null（正常不会发生；发生说明台账被手工改过）。 */
      clips: clips.map((c) =>
        c.blockedByTombstone ? { ...c, tombstone: orch.ledger.findTombstone(c.blockedByTombstone) ?? null } : c,
      ),

      ...(t.error ? { error: t.error } : {}),
      source: {
        rawCount: t.source.rawFiles.length,
        rawTotalGB: rawBytes / 1024 ** 3,
        ...(t.source.fullVideoPath ? { fullVideoPath: t.source.fullVideoPath } : {}),
        fullVideoExists: Boolean(t.source.fullVideoPath && exists(t.source.fullVideoPath)),
        fullVideoHasDanmaku: t.source.fullVideoHasDanmaku,
        danmaAss: Boolean(t.source.danmaAssPath && exists(t.source.danmaAssPath)),
        danmaXml: Boolean(t.source.danmaXmlPath && exists(t.source.danmaXmlPath)),
        diskNote: verdict.fullVideoReason,
        segments: t.source.segments.map((s) => ({
          name: path.basename(s.path),
          duration: s.duration,
          globalStart: s.globalStart,
          globalEnd: s.globalEnd,
          exists: exists(s.path),
        })),
      },
      files: listFiles(t),
      fullUpload: t.fullUpload,
      ...(t.fullVideoBvid ? { fullVideoBvid: t.fullVideoBvid } : {}),
      ...(t.seasonId ? { seasonId: t.seasonId } : {}),
      // 产物位置提示：用户要能在资源管理器里打开，而不是自己去拼路径
      taskDirHint: orch.ledger.taskDir(t.id),
      ...(exists(path.join(ROOT_DIR, orch.config.clip.outputDir, t.id))
        ? { clipsDirHint: path.join(ROOT_DIR, orch.config.clip.outputDir, t.id) }
        : {}),
      retention: verdict,
      /* 逐任务覆盖必须回传：界面「本场设置」要显示当前值，
         而它以前**从来没被序列化**过 —— 于是"保存了却看不到、也读不回"（实测）。 */
      ...(t.overrides ? { overrides: t.overrides } : {}),
      /* 在等 biliLive-tools 投出完整版稿件（默认规则下的正常中间态）：详情页要显示"在等什么、等到什么时候" */
      ...(t.publishWait ? { publishWait: t.publishWait } : {}),
      ...(t.importSource ? { importSource: t.importSource } : {}),
      cover: { source: coverInfo.source, cover: coverInfo.cover, attempts: coverInfo.attempts },
      llcFile: listFiles(t).find((f) => f.endsWith('.llc')),
      schedule: clips
        .filter((c) => c.selected || c.status !== 'CANDIDATE')
        .map((c) => {
          const check = c.dtime ? validateDtime(c.dtime, c.submitTime ?? Date.now()) : undefined;
          return {
            clipIndex: c.index,
            title: c.title,
            ...(c.dtime ? { dtime: c.dtime } : {}),
            dtimeText: c.dtime ? fmtLocal(c.dtime * 1000) : undefined,
            ...(c.bvid ? { bvid: c.bvid } : {}),
            url: c.bvid ? `https://www.bilibili.com/video/${c.bvid}` : undefined,
            status: c.status,
            dtimeOk: check?.ok,
          };
        }),
      url: this.url,
    };
  }

  /** 成本月度汇总（使用期辅助功能） */
  private monthlyCost(tasks: TaskRecord[]): Record<string, unknown> {
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let asr = 0;
    let llm = 0;
    let audioSec = 0;
    let calls = 0;
    let tasksInMonth = 0;
    const byDay: Record<string, { asr: number; llm: number }> = {};
    for (const t of tasks) {
      const d = new Date(Date.parse(t.createdAt));
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (key !== monthKey) continue;
      tasksInMonth++;
      asr += t.cost.asrEstimate ?? 0;
      llm += t.cost.llmActual ?? 0;
      audioSec += t.cost.asrAudioSeconds ?? 0;
      calls += t.cost.llmCalls ?? 0;
      const day = String(d.getDate()).padStart(2, '0');
      byDay[day] = byDay[day] ?? { asr: 0, llm: 0 };
      byDay[day]!.asr += t.cost.asrEstimate ?? 0;
      byDay[day]!.llm += t.cost.llmActual ?? 0;
    }
    return {
      month: monthKey,
      tasks: tasksInMonth,
      asrEstimate: Number(asr.toFixed(2)),
      llmActual: Number(llm.toFixed(4)),
      total: Number((asr + llm).toFixed(2)),
      asrAudioHours: Number((audioSec / 3600).toFixed(2)),
      llmCalls: calls,
      byDay,
      disclaimer:
        'ASR 为**估算值**：自研服务拿不到 biliLive-tools 的账单，只能按「自己提交的音频时长 × 配置单价」估算；LLM 为实际 usage 计算值',
    };
  }

  /** 稿件表现统计（§8 WP7 稿件表现统计页） */
  private performanceView(): Record<string, unknown> {
    const perf = this.orch.ledger.readPerformance({ sinceMs: Date.now() - 30 * 86400_000 });
    const tasks = this.orch.ledger.listTasks({ limit: 300 });
    // 按 taskId 关联 decisions 与 performance，看「LLM 高分 vs 实际表现」
    const rows: Array<Record<string, unknown>> = [];
    for (const t of tasks) {
      for (const c of this.orch.ledger.getClips(t.id)) {
        if (c.status !== 'PUBLISHED' || !c.bvid) continue;
        const p = perf.filter((x) => (x as { bvid?: string }).bvid === c.bvid).sort(
          (a, b2) => String((b2 as { date?: string }).date).localeCompare(String((a as { date?: string }).date)),
        )[0] as { view?: number; like?: number; coin?: number; favorite?: number; danmaku?: number; date?: string } | undefined;
        rows.push({
          taskId: t.id,
          index: c.index,
          title: c.title,
          bvid: c.bvid,
          url: `https://www.bilibili.com/video/${c.bvid}`,
          llmScore: c.score,
          degraded: c.degraded,
          publishedAt: c.dtime ? fmtLocal(c.dtime * 1000) : undefined,
          view: p?.view,
          like: p?.like,
          coin: p?.coin,
          favorite: p?.favorite,
          danmaku: p?.danmaku,
          statDate: p?.date,
        });
      }
    }
    const withView = rows.filter((r) => typeof r['view'] === 'number');
    withView.sort((a, b) => Number(b['view'] ?? 0) - Number(a['view'] ?? 0));
    // LLM 评分分档 vs 平均播放
    const buckets = [
      { name: '≥9.0', min: 9, max: 11 },
      { name: '8.0–9.0', min: 8, max: 9 },
      { name: '7.0–8.0', min: 7, max: 8 },
      { name: '<7.0', min: -1, max: 7 },
    ];
    const correlation = buckets.map((b) => {
      const items = withView.filter((r) => Number(r['llmScore']) >= b.min && Number(r['llmScore']) < b.max);
      const avg = items.length ? items.reduce((a, r) => a + Number(r['view'] ?? 0), 0) / items.length : 0;
      return { bucket: b.name, count: items.length, avgView: Math.round(avg) };
    });
    return {
      rows: withView.slice(0, 100),
      correlation,
      note:
        'LLM 评分是内容侧的判断，实际表现还受标题、发布时间、封面与推送影响 —— 本页只呈现相关性，不做因果结论。' +
        '数据每日回流一次（performance.jsonl）。',
    };
  }
}

/* ============================================================================
 * 便捷入口
 * ========================================================================== */

export async function startUi(opts: UiServerOptions): Promise<UiServer> {
  const s = new UiServer(opts);
  await s.start();
  return s;
}
