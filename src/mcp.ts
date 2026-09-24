/**
 * MCP（Model Context Protocol）服务端 —— 让 Agent 用自然语言驱动整条切片流水线。
 *
 * ## 为什么值得做
 *
 * 参考 [Palmier Pro](https://github.com/palmier-io/palmier-pro)：它是个 macOS 原生剪辑器
 * （Swift + Metal，仅 Apple Silicon，我们无法本地部署），但它有一个做法非常值得抄 ——
 * 应用打开时在 `http://127.0.0.1:19789/mcp` 暴露 MCP server，Claude Code / Codex / Cursor
 * 一条命令接上，就能直接操作时间线。
 *
 * 我们这边**天然更适合**：本地服务已经有一整套 API（任务、重跑、录播清单、待删清单、
 * 术语表、投稿体检…）。包一层 MCP 之后，用户就可以直接说
 * 「把这场从 ANALYZED 重跑，只留弹幕峰值最高的 3 条」「取消删源录播」「这场为什么判不合规」，
 * 由 Agent 去调工具，而不是在界面上一步步点。
 *
 * ## 三条设计原则
 *
 * 1. **工具是已有逻辑的薄封装，绝不另起一套**：每个 handler 调的都是 REST 路由用的同一个
 *    orchestrator 方法 —— 否则会出现"界面上一套规则、Agent 走另一套"的分裂。
 * 2. **危险操作要显式确认**：删任务、清空回收站这类不可逆动作，`confirm` 参数必须等于
 *    指定短语（如任务 id），模型没法"顺手"删掉东西。
 * 3. **只读工具不做 CSRF 校验，但仍只监听回环地址，并且要求 MCP token**：
 *    MCP 客户端不是浏览器、拿不到页面里的 CSRF token，所以单独发一个 token；
 *    没有 token 的本地进程不能驱动流水线。
 */

import crypto from 'node:crypto';
import type { AppConfig } from './config.ts';
import type { Ledger } from './ledger.ts';
import type { Logger } from './logger.ts';
import type { Stage, ClipRecord, TaskRecord } from './types.ts';
import { auditPublish } from './publish-audit.ts';
import { listRecordingsDetailed, describeCandidate } from './recordings.ts';
import { cancelPendingDelete, listPendingDelete } from './pending-delete.ts';
import { fmtBytes, exists } from './util.ts';

/** 我们支持的协议版本（按新到旧）。客户端报什么就回什么，不在表里则回最新的。 */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_LATEST_PROTOCOL = MCP_PROTOCOL_VERSIONS[0];

/** 合法阶段（`retry_stage` 用） */
const STAGES: Stage[] = ['RECORDED', 'TRANSCRIBED', 'ANALYZED', 'CLIPPED', 'PUBLISHED'];

/** 清空回收站的确认短语：必须一字不差 */
export const PURGE_CONFIRM_PHRASE = '永久删除';

/**
 * 解除墓碑的确认短语 —— 这是一条**会产生线上后果**的操作：
 * 解除之后同一录制区间可以再次投稿，若旧稿件其实还在 B站，就会多出一个重复稿件。
 */
export const TOMBSTONE_RELEASE_CONFIRM_PHRASE = '确认旧稿件已删除';

/**
 * 本模块需要 orchestrator 提供的**能力子集**。
 *
 * 用结构化类型而不是 `import type { Orchestrator }`：一来避免 server ↔ daemon 的循环依赖，
 * 二来把"MCP 到底依赖哪些能力"写死在类型里，改坏了编译期就报错。
 */
export interface McpOrchestrator {
  readonly ledger: Ledger;
  readonly logger: Logger;
  readonly config: AppConfig;
  readonly watcher: { status(): unknown; scanOnce(): Promise<unknown[]> };
  readonly glossary: {
    load(): unknown;
    save(raw: unknown): { glossary: unknown; issues: unknown[] };
    stats(g?: unknown): unknown;
    path: string;
  };
  importLocal(input: { videoPath: string; danmaPath?: string; title?: string }): Promise<{ id: string }>;
  stopTask(taskId: string): Promise<unknown>;
  enqueue(id: string, fromStage?: Stage): Promise<void>;
  trash(): unknown;
  restoreFromTrash(id: string): { ok: boolean; restored: string[]; warnings: string[] };
  /** 注意：确认串由**调用方**（REST 路由 / MCP 工具）把关，这一层不再校验 */
  purgeTrash(opts: { olderThanDays?: number; ids?: string[] }): unknown;
  inspectDeletion(taskId: string): unknown;
  deleteTask(taskId: string, opts?: { deleteClips?: boolean; deleteRaw?: boolean; deleteTaskDir?: boolean }): Promise<unknown>;
  runSelfCheck(): Promise<unknown>;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 只读工具（不产生副作用）—— 用于文档与审计 */
  readOnly?: boolean;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

/* ============================================================================
 * JSON-RPC 2.0 / MCP 消息
 * ========================================================================== */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP 的工具返回：文本内容 + 出错标记（Agent 据此决定要不要重试/换路） */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function textResult(data: unknown): McpToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/* ============================================================================
 * 工具定义
 * ========================================================================== */

/** 把任务压成 Agent 好读的形状（不要塞整个 TaskRecord，太多噪声） */
function taskBrief(t: TaskRecord): Record<string, unknown> {
  const clips = t.clips ?? [];
  const published = clips.filter((c) => c.status === 'PUBLISHED').length;
  return {
    id: t.id,
    status: t.status,
    stage: t.stage,
    title: t.title,
    streamer: t.streamer || undefined,
    manual: Boolean(t.manual),
    /** 来源：recording（录制触发）/ auto（目录自动导入）/ manual（人工导入） */
    importSource: t.importSource ?? (t.manual ? 'manual' : 'recording'),
    durationMin: t.source?.totalDuration ? Math.round(t.source.totalDuration / 60) : undefined,
    clips: { total: clips.length, published },
    ...(t.progress ? { progress: t.progress } : {}),
    ...(t.error ? { error: { stage: t.error.stage, message: t.error.message?.slice(0, 300) } } : {}),
    createdAt: t.createdAt,
  };
}

function clipBrief(c: ClipRecord, withText = false): Record<string, unknown> {
  return {
    index: c.index,
    status: c.status,
    selected: c.selected,
    title: c.title,
    start: Number(c.start?.toFixed?.(1) ?? c.start),
    end: Number(c.end?.toFixed?.(1) ?? c.end),
    durationSec: Math.round((c.end ?? 0) - (c.start ?? 0)),
    ...(c.bvid ? { bvid: c.bvid, url: `https://www.bilibili.com/video/${c.bvid}` } : {})
    ,
    ...(c.failReason ? { failReason: String(c.failReason).slice(0, 200) } : {}),
    ...(withText ? { desc: c.desc, tags: c.tags } : {}),
  };
}

export function buildMcpTools(orch: McpOrchestrator): McpToolDef[] {
  const cfg = orch.config;
  const tools: McpToolDef[] = [
    /* ---------------- 只读：能看清当前状态 ---------------- */
    {
      name: 'list_tasks',
      description:
        '列出所有切片任务（最近优先）。返回 id / 状态 / 阶段 / 标题 / 主播 / 切片数 / 失败原因。' +
        '想知道"现在有什么在跑、哪场失败了"就用它。',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', description: '最多返回多少条（默认 20）' } },
      },
      handler: (args) => {
        const limit = Math.min(200, Math.max(1, Number(args['limit'] ?? 20)));
        const tasks = orch.ledger.listTasks({ limit });
        return { count: tasks.length, tasks: tasks.map(taskBrief) };
      },
    },
    {
      name: 'get_task',
      description:
        '看一场任务的完整情况：候选切片（含标题、时间区间、状态、bvid）、失败原因、成本、总结节选。' +
        '排查"这场为什么没出片"从这里开始。',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string', description: '任务 id' } },
        required: ['taskId'],
      },
      handler: (args) => {
        const id = String(args['taskId'] ?? '');
        const t = orch.ledger.getTask(id);
        if (!t) throw new Error(`任务不存在：${id}`);
        const clips = orch.ledger.getClips(id);
        return {
          ...taskBrief(t),
          source: {
            rawFiles: t.source.rawFiles?.map((f) => ({ path: f, exists: exists(f) })) ?? [],
            totalDurationMin: t.source.totalDuration ? Math.round(t.source.totalDuration / 60) : undefined,
            hasDanmaku: Boolean(t.source.danmaXmlPath || t.source.danmaAssPath),
            fullVideoHasDanmaku: t.source.fullVideoHasDanmaku,
          },
          cost: t.cost,
          clips: clips.map((c) => clipBrief(c, true)),
        };
      },
    },
    {
      name: 'list_clips',
      description: '只列某场任务的切片清单（状态、标题、时间区间、是否已投稿与 bvid）。',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
      handler: (args) => {
        const id = String(args['taskId'] ?? '');
        const clips = orch.ledger.getClips(id);
        return { taskId: id, count: clips.length, clips: clips.map((c) => clipBrief(c)) };
      },
    },
    {
      name: 'list_recordings',
      description:
        '列出磁盘上发现的录播（已按"场"归并），并标出每个是否已导入、为什么没被自动导入。' +
        '回答"我新录的那场去哪了"就用它。',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '最多返回多少场（默认 30）' },
          probe: { type: 'boolean', description: '是否 ffprobe 探测时长/分辨率（慢一些，默认 false）' },
        },
      },
      handler: async (args) => {
        const limit = Math.min(200, Math.max(1, Number(args['limit'] ?? 30)));
        const r = await listRecordingsDetailed(cfg, {
          ledger: orch.ledger,
          probe: args['probe'] === true,
          limit,
          logger: orch.logger,
        });
        return {
          scanRoots: r.scanRoots,
          count: r.candidates.length,
          recordings: r.candidates.slice(0, limit).map((c) => ({
            videoPath: c.videoPath,
            title: c.title,
            group: c.group,
            sizeMB: Math.round(c.sizeBytes / 1024 ** 2),
            danmaku: c.danmaPath ? c.danmaKind : '无',
            usable: c.usable,
            ...(c.brokenReason ? { brokenReason: c.brokenReason } : {}),
            possiblyRecording: c.possiblyRecording,
            imported: c.importedBy ? { taskId: c.importedBy.taskId, status: c.importedBy.status } : false,
            summary: describeCandidate(c),
          })),
        };
      },
    },
    {
      name: 'get_watch_status',
      description:
        '目录轮询导入的状态：在看哪些目录、上一轮什么时候跑的、以及**每个候选为什么没被导入**' +
        '（文件仍在写入 / 已导入 / 历史基线 / 缺弹幕…）。',
      readOnly: true,
      inputSchema: { type: 'object', properties: {} },
      handler: () => orch.watcher.status(),
    },
    {
      name: 'list_pending_delete',
      description:
        '「用完即删」的待删清单：哪些文件已排队、什么时候到点自动删除、哪些已删。' +
        '删源录播不可逆 —— 发现不想删的，用 cancel_pending_delete 取消。',
      readOnly: true,
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        const v = listPendingDelete();
        return {
          stats: { ...v.stats, pendingHuman: fmtBytes(v.stats.pendingBytes) },
          pending: v.pending.map(pdBrief),
          recentlyDeleted: v.deleted.slice(-10).map(pdBrief),
        };
      },
    },
    {
      name: 'list_trash',
      description: '回收站内容（删除的任务会先进这里，默认保留 7 天，可恢复）。',
      readOnly: true,
      inputSchema: { type: 'object', properties: {} },
      handler: () => orch.trash(),
    },
    {
      name: 'get_glossary',
      description:
        '读术语表：主播（anchors）、术语/梗（terms）、ASR 纠错规则（replacements）。' +
        '这些词会被注入提示词，也会用于把 ASR 的同音错字改正。',
      readOnly: true,
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        const g = orch.glossary.load() as { anchors: string[]; terms: string[]; replacements: unknown[] };
        return { ...g, stats: orch.glossary.stats(g), path: orch.glossary.path };
      },
    },
    {
      name: 'publish_audit',
      description:
        '对某场跑一次投稿体检：投了几次、有没有重复稿件、bvid 是否可信、标题有没有硬伤、定时发布时间是否合规。',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
      handler: async (args) => {
        const id = String(args['taskId'] ?? '');
        const t = orch.ledger.getTask(id);
        if (!t) throw new Error(`任务不存在：${id}`);
        const report = await auditPublish(t, orch.ledger, cfg, { glossaryPath: orch.glossary.path });
        return report;
      },
    },
    {
      name: 'self_check',
      description: '跑一次自检：biliLive-tools 连通性、凭据、目录、磁盘、ASR/LLM 可用性等。',
      readOnly: true,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => orch.runSelfCheck(),
    },

    /* ---------------- 写：可逆或幂等 ---------------- */
    {
      name: 'retry_stage',
      description:
        '把一场任务**从某个阶段重跑**（幂等：已完成的阶段不会重复付费的会走缓存）。' +
        '用法举例：转写失败 → fromStage=RECORDED（会复用 ASR 缓存，不重复计费）；' +
        '想换一批候选 → fromStage=ANALYZED（重跑 LLM 选片，会产生少量 LLM 费用）。',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          fromStage: { type: 'string', enum: STAGES, description: 'RECORDED=从转写开始；TRANSCRIBED=从信号/分析开始；ANALYZED=只重跑选片与切片；CLIPPED=只重跑投稿' },
        },
        required: ['taskId', 'fromStage'],
      },
      handler: async (args) => {
        const id = String(args['taskId'] ?? '');
        const fromStage = String(args['fromStage'] ?? '') as Stage;
        if (!STAGES.includes(fromStage)) throw new Error(`fromStage 必须是 ${STAGES.join(' / ')}`);
        const t = orch.ledger.getTask(id);
        if (!t) throw new Error(`任务不存在：${id}`);
        orch.ledger.clearError(id);
        orch.ledger.setStatus(id, 'PENDING', { stage: fromStage });
        await orch.enqueue(id, fromStage);
        return {
          ok: true,
          taskId: id,
          fromStage,
          note:
            fromStage === 'RECORDED'
              ? '已入队：将从转写开始重跑（ASR 走本地缓存，已花的钱不会重复产生）'
              : `已入队：将从 ${fromStage} 阶段重跑`,
        };
      },
    },
    {
      name: 'stop_task',
      description: '停止一场任务：移出队列并把运行态收回（不会删除任何文件，可随时重跑）。',
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
      handler: async (args) => orch.stopTask(String(args['taskId'] ?? '')),
    },
    {
      name: 'import_recording',
      description:
        '把一个录播文件导入成任务（之后自动走转写 → 选片 → 切片 → 投稿）。' +
        '**注意**：导入会触发 ASR，会产生费用（约 ¥2/小时音频）。' +
        '建议先用 previewPath=true 预览（探测时长、是否已有弹幕、预估 ASR 费用），确认后再导入。',
      inputSchema: {
        type: 'object',
        properties: {
          videoPath: { type: 'string', description: '录播文件的绝对路径' },
          danmaPath: { type: 'string', description: '弹幕文件路径（可省略，会自动找同名 .xml/.ass）' },
          title: { type: 'string', description: '场次标题（可省略，默认用文件名）' },
          previewPath: { type: 'boolean', description: '只预览不导入（默认 false）' },
        },
        required: ['videoPath'],
      },
      handler: async (args) => {
        const videoPath = String(args['videoPath'] ?? '');
        if (!videoPath) throw new Error('缺少 videoPath');
        if (!exists(videoPath)) throw new Error(`文件不存在：${videoPath}`);
        if (args['previewPath'] === true) {
          return {
            preview: true,
            videoPath,
            note: '预览模式：未创建任务。确认后把 previewPath 设为 false 再调一次即可导入。',
          };
        }
        const r = await orch.importLocal({
          videoPath,
          ...(args['danmaPath'] ? { danmaPath: String(args['danmaPath']) } : {}),
          ...(args['title'] ? { title: String(args['title']) } : {}),
        });
        return { ok: true, taskId: r.id, note: `已导入并排队：${r.id}（转写会产生 ASR 费用）` };
      },
    },
    {
      name: 'scan_watch_now',
      description: '立即扫一轮监听目录（平时每 intervalSec 自动扫）；返回本轮每个候选的结论。',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const outcomes = await orch.watcher.scanOnce();
        return { scanned: outcomes.length, outcomes };
      },
    },
    {
      name: 'cancel_pending_delete',
      description: '取消待删清单里的一项（宽限期内反悔）。**这是唯一能阻止自动删源的操作，优先用它。**',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '待删条目 id（从 list_pending_delete 拿）' } },
        required: ['id'],
      },
      handler: (args) => {
        const r = cancelPendingDelete(String(args['id'] ?? ''), { logger: orch.logger });
        if (!r.ok) throw new Error('取消失败：条目不存在，或已取消/已删除');
        return { ok: true, entry: r.entry ? pdBrief(r.entry) : undefined };
      },
    },
    {
      name: 'restore_trash',
      description: '从回收站恢复一个条目（任务记录 + 文件一起回来）。',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '回收站条目 id（从 list_trash 拿）' } },
        required: ['id'],
      },
      handler: (args) => {
        const r = orch.restoreFromTrash(String(args['id'] ?? ''));
        return { ok: true, result: r };
      },
    },
    {
      name: 'update_glossary',
      description:
        '更新术语表（整体替换传入的字段）。主播名/术语会被注入提示词避免被改写，纠错规则用于修正 ASR 同音错字。' +
        '改完对**之后**的分析生效，已产出的任务不受影响。',
      inputSchema: {
        type: 'object',
        properties: {
          anchors: { type: 'array', items: { type: 'string' }, description: '主播/常驻嘉宾名' },
          terms: { type: 'array', items: { type: 'string' }, description: '术语/梗/栏目名' },
          replacements: {
            type: 'array',
            description: 'ASR 纠错规则',
            items: {
              type: 'object',
              properties: { from: { type: 'string' }, to: { type: 'string' } },
              required: ['from', 'to'],
            },
          },
        },
      },
      handler: (args) => {
        const cur = orch.glossary.load() as { anchors: string[]; terms: string[]; replacements: unknown[] };
        const next = {
          anchors: Array.isArray(args['anchors']) ? args['anchors'] : cur.anchors,
          terms: Array.isArray(args['terms']) ? args['terms'] : cur.terms,
          replacements: Array.isArray(args['replacements']) ? args['replacements'] : cur.replacements,
        };
        const saved = orch.glossary.save(next);
        return { ok: true, stats: orch.glossary.stats(saved.glossary), issues: saved.issues };
      },
    },
    {
      name: 'edit_clip',
      description:
        '修改某条切片的标题/时间区间/标签/勾选状态。只能改**尚未投稿**的切片（已投稿的改本地不会影响 B站）。',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          index: { type: 'number', description: '切片序号（从 0 开始）' },
          title: { type: 'string' },
          start: { type: 'number', description: '起始秒' },
          end: { type: 'number', description: '结束秒' },
          tags: { type: 'array', items: { type: 'string' } },
          selected: { type: 'boolean', description: '是否勾选（不勾选就不会切片/投稿）' },
        },
        required: ['taskId', 'index'],
      },
      handler: (args) => {
        const id = String(args['taskId'] ?? '');
        const idx = Number(args['index']);
        const clip = orch.ledger.getClip(id, idx);
        if (!clip) throw new Error(`任务 ${id} 没有第 ${idx} 条切片`);
        const patch: Partial<ClipRecord> = {};
        if (args['title'] !== undefined) patch.title = String(args['title']);
        if (args['start'] !== undefined) patch.start = Number(args['start']);
        if (args['end'] !== undefined) patch.end = Number(args['end']);
        if (args['tags'] !== undefined) patch.tags = (args['tags'] as string[]).map(String);
        if (args['selected'] !== undefined) patch.selected = Boolean(args['selected']);
        if (Object.keys(patch).length === 0) throw new Error('没有提供任何要修改的字段');
        if (patch.start !== undefined && patch.end !== undefined && patch.end <= patch.start) {
          throw new Error('end 必须大于 start');
        }
        const updated = orch.ledger.setClipStatus(id, idx, clip.status, { ...patch, edited: true });
        return { ok: true, clip: updated ? clipBrief(updated, true) : undefined };
      },
    },

    /* ---------------- 危险：必须显式确认 ---------------- */
    {
      name: 'delete_task',
      description:
        '删除一场任务：任务目录与切片产物**移入回收站**（默认保留 7 天，可恢复），台账记录一并移走。' +
        '⚠️ 已投稿到 B站的稿件**不会被撤回**。为了避免误删，confirm 必须一字不差地等于 taskId。' +
        '建议先用 inspect_deletion 看看会释放什么。',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          confirm: { type: 'string', description: '必须与 taskId 完全一致才执行' },
        },
        required: ['taskId', 'confirm'],
      },
      handler: (args) => {
        const id = String(args['taskId'] ?? '');
        if (String(args['confirm'] ?? '') !== id) {
          throw new Error(`确认串不匹配：要删除任务 ${id}，confirm 必须等于 "${id}"（实际收到 "${String(args['confirm'] ?? '')}"）`);
        }
        return orch.deleteTask(id);
      },
    },
    {
      name: 'inspect_deletion',
      description: '预览删除一场任务会释放什么（目录、成片、转写、总结、成本），不会真的删。',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
      handler: (args) => orch.inspectDeletion(String(args['taskId'] ?? '')),
    },
    {
      name: 'list_tombstones',
      description:
        '列出**墓碑**：已删除任务的、曾经真的投出去过的切片指纹。它们仍在拦重复投稿 —— ' +
        '同一份素材被重新导入并分析出同一区间时，会被自动跳过（切片上标 blockedByTombstone）。' +
        '当用户问「为什么这一片没投出去」时先调它。',
      readOnly: true,
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        const rows = orch.ledger.listTombstones();
        return {
          count: rows.length,
          tombstones: rows,
          note:
            rows.length === 0
              ? '暂无墓碑'
              : '墓碑不影响「没投出去过」的切片：删掉不满意的候选后重跑照常可以投。',
        };
      },
    },
    {
      name: 'release_tombstone',
      description:
        '**人工解除**一条墓碑 —— 解除后同一录制区间可以再次投稿到 B站。' +
        '只在用户确认「B站 上那个旧稿件确实已经不存在」之后才能做，否则会产生重复稿件。' +
        `为了避免误操作，confirm 必须一字不差地等于「${TOMBSTONE_RELEASE_CONFIRM_PHRASE}」。`,
      inputSchema: {
        type: 'object',
        properties: {
          fingerprint: { type: 'string', description: 'list_tombstones 返回的 fingerprint' },
          confirm: { type: 'string', description: `必须等于「${TOMBSTONE_RELEASE_CONFIRM_PHRASE}」` },
          note: { type: 'string', description: '可选：记下为什么解除（会写进 publish-log）' },
        },
        required: ['fingerprint', 'confirm'],
      },
      handler: (args) => {
        if (String(args['confirm'] ?? '') !== TOMBSTONE_RELEASE_CONFIRM_PHRASE) {
          throw new Error(`确认串不匹配：confirm 必须等于「${TOMBSTONE_RELEASE_CONFIRM_PHRASE}」`);
        }
        const r = orch.ledger.releaseTombstone(String(args['fingerprint'] ?? ''), {
          ...(args['note'] !== undefined ? { note: String(args['note']) } : {}),
        });
        if (!r.ok) throw new Error(r.error ?? '解除失败');
        return { ok: true, released: r.released };
      },
    },
    {
      name: 'purge_trash',
      description:
        `彻底清空回收站（**不可逆**，文件从磁盘抹掉）。confirm 必须一字不差地等于「${PURGE_CONFIRM_PHRASE}」。` +
        '只想删某几项就传 ids；不传 ids 会清空全部。',
      inputSchema: {
        type: 'object',
        properties: {
          confirm: { type: 'string', description: `必须等于「${PURGE_CONFIRM_PHRASE}」` },
          ids: { type: 'array', items: { type: 'string' }, description: '只删这些条目（省略=全部）' },
        },
        required: ['confirm'],
      },
      handler: (args) => {
        if (String(args['confirm'] ?? '') !== PURGE_CONFIRM_PHRASE) {
          throw new Error(`确认串不匹配：confirm 必须等于「${PURGE_CONFIRM_PHRASE}」`);
        }
        const ids = Array.isArray(args['ids']) ? (args['ids'] as string[]).map(String) : undefined;
        return orch.purgeTrash(ids ? { ids } : {});
      },
    },
  ];
  return tools;
}

/** 待删条目压成简明形状 */
function pdBrief(e: {
  id: string;
  path: string;
  kind: string;
  taskId: string;
  sizeBytes: number;
  dueAt: string;
  reason?: string;
  deletedAt?: string;
  deletedBy?: string;
  error?: string;
  cancelledAt?: string;
}): Record<string, unknown> {
  return {
    id: e.id,
    path: e.path,
    kind: e.kind,
    taskId: e.taskId,
    size: fmtBytes(e.sizeBytes),
    dueAt: e.dueAt,
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.deletedAt ? { deletedAt: e.deletedAt, deletedBy: e.deletedBy } : {}),
    ...(e.cancelledAt ? { cancelledAt: e.cancelledAt } : {}),
    ...(e.error ? { error: e.error } : {}),
  };
}

/* ============================================================================
 * JSON-RPC 分发
 * ========================================================================== */

export interface McpServerInfo {
  name: string;
  version: string;
}

/**
 * 处理一条 JSON-RPC 消息。
 *
 * 返回 `null` 表示这是**通知**（如 `notifications/initialized`）—— MCP 规定通知不需要响应，
 * HTTP 层应回 202 而不是塞一个空 result（后者会让部分客户端报协议错误）。
 */
export async function handleMcpMessage(
  orch: McpOrchestrator,
  msg: JsonRpcRequest,
  info: McpServerInfo,
): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const params = msg.params ?? {};
  const tools = buildMcpTools(orch);

  try {
    switch (msg.method) {
      case 'initialize': {
        const asked = String(params['protocolVersion'] ?? '');
        const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_LATEST_PROTOCOL;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: info.name, version: info.version },
            instructions:
              '这是「B站直播切片助手」的本地控制接口。常用流程：list_tasks 看现状 → get_task 看某场细节 → ' +
              'retry_stage 重跑某阶段。删除类操作不可逆，工具会要求你传确认串；删源录播前请先看 list_pending_delete。',
          },
        };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list': {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              ...(t.readOnly ? { annotations: { readOnlyHint: true } } : {}),
            })),
          },
        };
      }
      case 'tools/call': {
        const name = String(params['name'] ?? '');
        const args = (params['arguments'] ?? {}) as Record<string, unknown>;
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
          return {
            jsonrpc: '2.0',
            id,
            result: errorResult(`未知工具：${name}。可用工具见 tools/list。`),
          };
        }
        try {
          const data = await tool.handler(args);
          return { jsonrpc: '2.0', id, result: textResult(data) };
        } catch (e) {
          // 工具内部错误按 MCP 约定放在 result 里（isError），而不是 JSON-RPC error：
          // Agent 需要看到错误内容才能自我修正，而 JSON-RPC error 常被客户端吞掉细节。
          const m = e instanceof Error ? e.message : String(e);
          orch.logger.warn(`MCP 工具 ${name} 执行失败：${m}`, { mod: 'mcp' });
          return { jsonrpc: '2.0', id, result: errorResult(`${name} 失败：${m}`) };
        }
      }
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `不支持的方法：${msg.method}` },
        };
    }
  } catch (e) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
    };
  }
}

/* ============================================================================
 * 鉴权
 * ========================================================================== */

/** 生成一个 MCP token（只在首次开启时生成一次，写回 config.json） */
export function generateMcpToken(): string {
  return `mcp-${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * 校验 MCP 请求的 token。
 *
 * 为什么不复用页面的 CSRF token：MCP 客户端（Claude Code / Codex / Cursor）**不是浏览器**，
 * 拿不到页面里注入的 token，也没有 Origin 头。所以单独发一个长期 token：
 * 既能挡住本机其它进程随手调用，又不需要用户每次启动重新配对。
 */
export function checkMcpToken(headers: Record<string, string | string[] | undefined>, expected: string): { ok: boolean; reason?: string } {
  if (!expected) return { ok: false, reason: 'MCP 未启用（config.json 的 mcp.token 为空）' };
  const raw = headers['authorization'] ?? headers['x-mcp-token'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    return {
      ok: false,
      reason:
        '缺少 MCP token —— 请在请求头带上 `Authorization: Bearer <token>`（token 见 config.json 的 mcp.token，' +
        '或界面上「MCP 接口」那一栏）',
    };
  }
  const provided = value.startsWith('Bearer ') ? value.slice(7) : value;
  // 定长比较，避免计时侧信道（本地服务也要讲基本法）
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? { ok: true } : { ok: false, reason: 'MCP token 不匹配' };
}
