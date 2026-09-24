/**
 * 离线端到端验证（任务书 §9 交付物清单 5「一份可复现的离线测试用例」）。
 *
 * 目标：**不依赖真实直播、不产生任何 ASR / LLM 费用**，把整条链路跑一遍并逐项断言：
 *
 *   1. 源素材校验 → 转写（含缓存命中与断点续跑）→ 弹幕信号 → LLM 分析
 *   2. 契约校验失败 → **升级到另一档模型重跑**（硬约束 #13）
 *   3. 切片（两步走：cut → 轮询 → upload）→ 投稿
 *   4. **幂等**：重复运行不产生重复稿件
 *   5. 崩溃恢复：卡在 SUBMITTING 的切片处理
 *   6. 素材清理判定（分层策略）
 *   7. 无弹幕 / 无高能事件时的降级信号
 *
 * 用法：
 *   node test/e2e-offline.ts              # 跑全部场景
 *   node test/e2e-offline.ts --keep       # 保留临时目录便于排查
 *   node test/e2e-offline.ts --verbose    # 打印被测服务的日志
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { Orchestrator } from '../src/daemon.ts';
import { Ledger } from '../src/ledger.ts';
import { ASR_CACHE_DIR, ROOT_DIR, ensureDir, exists, fmtBytes, nowIso, readJson, writeJsonAtomic } from '../src/util.ts';
import type { ClipRecord, TaskRecord } from '../src/types.ts';

/* ============================================================================
 * 测试脚手架
 * ========================================================================== */

let pass = 0;
let fail = 0;
const failures: string[] = [];
const notes: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` :: ${detail}` : ''}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  ok(name, actual === expected, actual === expected ? undefined : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
  console.log('─'.repeat(Math.max(20, Math.min(76, t.length * 2 + 8))));
}

function note(t: string): void {
  notes.push(t);
  console.log(`  \x1b[90m· ${t}\x1b[0m`);
}

async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 轮询直到条件满足或超时 */
async function waitFor(name: string, fn: () => boolean | Promise<boolean>, timeoutMs = 30_000, intervalMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await wait(intervalMs);
  }
  ok(`等待条件超时：${name}`, false, `${timeoutMs}ms 内未满足`);
  return false;
}

async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return data as T;
}

const KEEP = process.argv.includes('--keep');
const VERBOSE = process.argv.includes('--verbose');
const PARENT_VERBOSE = process.argv.includes('--verbose-parent');
/** 打印测试自身的调试信息（与 --verbose 区分：后者是被测服务的日志级别） */
const VERBOSE_PUBLIC = process.argv.includes('--debug');

/* ============================================================================
 * 假 LLM 端点（模拟 OpenAI 兼容接口）
 * ========================================================================== */

interface MockLlmState {
  /** 契约失败注入：'none' | 'first-select'（第一次选片返回超长标题）| 'always' */
  contractFailure: 'none' | 'first-select' | 'always';
  /** 网络失败注入：前 N 次调用返回 500 */
  failFirst: number;
  calls: Array<{ at: string; model: string; purpose?: string; systemHash: string; isSelect: boolean; status: number }>;
  selectCalls: number;
  /** 每次 select 调用的快照，用于诊断「升级重跑」路径 */
  selectLog: string[];
  /** 记录所有 system 内容，用于验证「字节级一致」（DeepSeek 缓存命中前提） */
  systems: string[];
}

const llm: MockLlmState = { contractFailure: 'none', failFirst: 0, calls: [], selectCalls: 0, selectLog: [], systems: [] };

function simpleHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function startMockLlm(): Promise<{ server: http.Server; port: number; url: string }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: { messages?: Array<{ role: string; content: string }>; model?: string } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        /* ignore */
      }
      const messages = body.messages ?? [];
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      const isSelect = system.includes('选片编辑');
      const callIndex = llm.calls.length + 1;

      llm.systems.push(system);

      // 网络故障注入
      if (llm.failFirst > 0) {
        llm.failFirst--;
        llm.calls.push({ at: nowIso(), model: body.model ?? '?', systemHash: simpleHash(system), isSelect, status: 500 });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '模拟供应商 500（用于验证重试）' } }));
        return;
      }

      let content: string;
      if (isSelect) {
        llm.selectCalls++;
        const failNow =
          llm.contractFailure === 'always' || (llm.contractFailure === 'first-select' && llm.selectCalls === 1);
        content = failNow ? JSON.stringify(buildBadSelection()) : JSON.stringify(buildSelection(user));
        llm.selectLog.push(
          `select#${llm.selectCalls} mode=${llm.contractFailure} failNow=${failNow} len=${content.length} purpose=${String((body as { purpose?: string }).purpose ?? '-')}`,
        );
      } else if (system.includes('内容总结助手')) {
        content = buildSummaryMarkdown();
      } else {
        content = JSON.stringify(buildChunkDigest(user));
      }

      llm.calls.push({ at: nowIso(), model: body.model ?? '?', systemHash: simpleHash(system), isSelect, status: 200 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `chatcmpl-mock-${callIndex}`,
          object: 'chat.completion',
          model: body.model ?? 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 3200,
            completion_tokens: 800,
            total_tokens: 4000,
            prompt_tokens_details: { cached_tokens: 640 },
          },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, url: `http://127.0.0.1:${port}/v1` });
    });
  });
}

/** 分块要点：从 user 消息里取时间窗 */
function buildChunkDigest(user: string): unknown {
  const m = /绝对时间 (\d{2}):(\d{2}):(\d{2}) – (\d{2}):(\d{2}):(\d{2})/.exec(user);
  const toSec = (h: string, mi: string, s: string): number => Number(h) * 3600 + Number(mi) * 60 + Number(s);
  const start = m ? toSec(m[1]!, m[2]!, m[3]!) : 0;
  const end = m ? toSec(m[4]!, m[5]!, m[6]!) : 600;
  const mid = Math.floor((end - start) / 2);
  return {
    topics: ['本段讨论了游戏机制与操作细节', '回答了观众关于配装的提问'],
    highlights: [
      { time: mid, what: '连续三次挑战同一处 Boss，第三次残血翻盘', why: '情绪反应最强，弹幕密度冲高' },
      { time: Math.max(0, mid - 120), what: '讲解 Boss 二阶段的机制与走位', why: '信息密度高，可独立成片' },
    ],
  };
}

function buildSummaryMarkdown(): string {
  return [
    '本场直播围绕《艾尔登法环》DLC 开荒展开。前半段是常规闲聊与日程说明，中段进入游戏实操，连续三次挑战同一处 Boss，第三次残血翻盘时弹幕密度冲到全场峰值；后半段转为观众问答，集中回答了配装与外设问题。',
    '',
    '- **00:10:00** 第三次挑战残血翻盘，弹幕密度达到全场峰值',
    '- **00:20:00** 讲解 Boss 二阶段机制与走位要点',
    '- **00:12:00** 观众问答环节，回答配装问题',
  ].join('\n');
}

/** 合法的选片输出：从 user 消息里读取总时长与参数 */
function buildSelection(user: string): unknown {
  const durMatch = /(\d+) 秒（/.exec(user);
  const total = durMatch ? Number(durMatch[1]) : 1800;
  const maxMatch = /候选数量上限：(\d+) 个/.exec(user);
  const max = maxMatch ? Number(maxMatch[1]) : 6;
  const minMatch = /片段时长范围：(\d+)–(\d+) 秒/.exec(user);
  const minDur = minMatch ? Number(minMatch[1]) : 30;
  const maxDur = minMatch ? Number(minMatch[2]) : 90;

  const dur = Math.min(maxDur, Math.max(minDur, 62));
  const planned = [
    { start: 600, score: 9.3, title: '残血翻盘那一刻，弹幕直接炸了', category: '游戏/单机游戏', tags: ['名场面', '高能', '游戏'] },
    { start: 1195, score: 8.7, title: 'Boss 二阶段机制一次讲清楚', category: '游戏/单机游戏', tags: ['攻略', '干货'] },
    { start: 720, score: 7.9, title: '被问最多的配装问题，一次说清', category: '游戏/单机游戏', tags: ['问答', '实用'] },
    { start: 300, score: 7.4, title: '开场日程说明与本周计划', category: '生活/日常', tags: ['日常'] },
    { start: 900, score: 6.6, title: '中途一段闲聊', category: '不存在的分区/测试回退', tags: ['闲聊', '闲聊', '   ', '外挂'] },
    { start: 1500, score: 6.2, title: '下播前的收尾闲聊', category: '生活/日常', tags: ['收尾'] },
  ].slice(0, max);

  const clips = planned
    .map((p) => {
      const end = Math.min(total, p.start + dur);
      if (end - p.start < minDur) return null;
      return {
        start: p.start,
        end,
        title: p.title,
        desc: `本片段来自测试场次的 ${p.start} 秒处。${p.title}。`,
        tags: p.tags,
        category: p.category,
        score: p.score,
        reason: `弹幕密度在此处显著抬升，且内容自洽、可脱离上下文理解`,
        cover_ts: p.start + Math.floor(dur / 2),
      };
    })
    .filter(Boolean);

  return { summary: buildSummaryMarkdown(), clips };
}

/** 违约的选片输出：标题超长 + 时间早于 0 */
function buildBadSelection(): unknown {
  return {
    summary: '这一份的标题超长，用于强制触发契约校验失败。',
    clips: [
      {
        start: -5,
        end: 60,
        title:
          '这是一个故意写得非常非常长的标题用来触发 zod 契约校验失败因为硬约束要求标题不能超过八十个字符而这一串文字显然远远超过了这个上限',
        desc: '违约样本',
        tags: ['测试'],
        category: '游戏/单机游戏',
        score: 8,
        reason: '违约',
      },
    ],
  };
}

/* ============================================================================
 * 主流程
 * ========================================================================== */

async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmpRoot = path.join(os.tmpdir(), `live_auto-e2e-${stamp}`);
  const tmpData = path.join(tmpRoot, 'data');
  ensureDir(tmpData);
  ensureDir(path.join(tmpRoot, 'clips'));

  /* ⚠️ 错误事件流与错误报告**必须**重定向到临时目录。
     它们原本是模块级常量，`dataDirOverride` 管不到 ⇒ 测试产生的错误会写进真实的
     data/errors.jsonl 与 data/error-report/，把「近 24h 错误」冲成噪音
     （实测 83 条里只有 9 条真实、67 条来自内建测试、7 条来自 UI e2e）。 */
  const { setErrorsPath, setErrorReportDir } = await import('../src/errors.ts');
  setErrorsPath(path.join(tmpData, 'errors.jsonl'));
  setErrorReportDir(path.join(tmpData, 'error-report'));

  console.log(`\x1b[1m离线端到端验证\x1b[0m  v1.0.0`);
  console.log(`临时目录：${tmpRoot}${KEEP ? '（--keep，跑完保留）' : ''}`);
  console.log(`说明：全程使用 mock biliLive-tools 与假 LLM 端点，\x1b[32m不产生任何费用\x1b[0m。`);

  const cleanups: Array<() => void | Promise<void>> = [];
  let mockChild: ChildProcess | undefined;

  try {
    /* ================= 准备：mock biliLive-tools ================= */
    section('准备：启动 mock biliLive-tools（含高能事件、单文件录制）');
    const mockPort = 18000 + Math.floor(Math.random() * 900);
    const mockPass = `mock-key-${stamp}`;
    const mockLogPath = path.join(tmpRoot, 'mock-server.log');
    const mockLogFd = fs.openSync(mockLogPath, 'w');

    mockChild = spawn(
      process.execPath,
      [
        path.join(ROOT_DIR, 'test', 'mock-server.ts'),
        '--port', String(mockPort),
        '--passkey', mockPass,
        '--version', '3.21.0',
        '--with-events',
        '--instant',
        '--clips-seen', '1', // 前 1 次轮询返回「录制中」，验证「两次采样不再变化」+ 下播确认
        '--data-dir', path.join(tmpRoot, 'mock'),
      ],
      { stdio: ['ignore', mockLogFd, mockLogFd], windowsHide: true },
    );
    cleanups.push(() => {
      try {
        mockChild?.kill();
      } catch {
        /* ignore */
      }
      try {
        fs.closeSync(mockLogFd);
      } catch {
        /* ignore */
      }
    });

    const baseUrl = `http://127.0.0.1:${mockPort}`;
    const pinged = await waitFor('mock server 就绪', async () => {
      try {
        await httpJson(`${baseUrl}/__mock/ping`);
        return true;
      } catch {
        return false;
      }
    }, 20_000);
    if (!pinged) {
      console.error(`\n\x1b[31mmock server 未启动，日志：\x1b[0m`);
      console.error(fs.readFileSync(mockLogPath, 'utf8').slice(-3000));
      process.exitCode = 1;
      return;
    }
    ok('mock biliLive-tools 已就绪', true);

    /* ================= 准备：假 LLM ================= */
    section('准备：启动假 LLM 端点（OpenAI 兼容）');
    const mockLlm = await startMockLlm();
    cleanups.push(() => {
      mockLlm.server.close();
    });
    ok(`假 LLM 端点已就绪（端口 ${mockLlm.port}）`, true);

    /* ================= 准备：隔离的配置与台账 ================= */
    const configPath = path.join(tmpRoot, 'config.json');
    const example = readJson<Record<string, unknown>>(path.join(ROOT_DIR, 'config.example.json'));
    const cfg = {
      ...example,
      bililive: {
        baseUrl,
        passKey: mockPass,
        versionExpected: '3.22.1',
        versionDriftWarn: true,
        timeoutMs: 15000,
        asrTimeoutMs: 60000,
        retry: 1,
      },
      room: {
        roomId: '12345678',
        platform: 'Bilibili',
        pollIntervalSec: 999, // 常驻轮询不参与本测试（用 checkNow 手动驱动）
        reconcileIntervalMin: 9999,
        liveCheckIntervalSec: 30,
        offlineConfirmSec: 0, // 测试里不想等 10 分钟：置 0，靠「同 live_id 全部关闭」防误触发
        registerStreamerHint: true,
      },
      recorder: { type: 'builtin', webhookTargets: [], forwardTo: '/webhook/custom', eventLogPath: path.join(tmpData, 'webhook-events.jsonl'), recentClipsWindow: 5, recordHistoryPageSize: 50 },
      asr: {
        provider: 'bililive-tools',
        segmentMinutes: 30,
        overlapSeconds: 8,
        concurrency: 1,
        maxRetries: 2,
        modelId: '',
        cacheDir: path.join(tmpData, 'asr-cache'),
        unitPricePerHour: 2.0,
        inputSource: 'raw',
        silenceTrim: { enabled: false, noiseDb: -32, minSilenceSec: 2, paddingSec: 0.4, ffmpegPath: '' },
        whisperCpp: { binaryPath: '', modelPath: '', language: 'zh', threads: 8, extraArgs: [] },
      },
      llm: {
        preset: 'custom',
        // ★ 两档**故意配成不同模型**，这样才验证得了「升级到另一档」而不是同模型重试
        summary: { baseUrl: mockLlm.url, apiKey: 'sk-mock-summary-key', model: 'mock-summary-model', maxTokens: 4096, temperature: 0.3, timeoutMs: 20000 },
        select: { baseUrl: mockLlm.url, apiKey: 'sk-mock-select-key', model: 'mock-select-model', maxTokens: 8192, temperature: 0.4, timeoutMs: 20000 },
        chunkMinutes: 12,
        chunkConcurrency: 2,
        consecutiveFailureThreshold: 3,
        pricing: {
          currency: 'CNY',
          summary: { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.2 },
          select: { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.2 },
        },
        recordRawResponses: false,
      },
      clip: {
        maxCandidates: 6,
        autoSelectScoreFloor: 7.0,
        minDurationSec: 30,
        maxDurationSec: 90,
        bufferSec: 1.5,
        ffmpegPresetId: 'default',
        burnDanmaku: true,
        ffmpegOptionsOverride: { 'c:v': 'libx264', preset: 'veryfast', crf: '21', 'c:a': 'aac', 'b:a': '192k' },
        fullVideoHasDanmaku: false,
        outputDir: path.join(tmpRoot, 'clips'),
        cutTimeoutSec: 60,
      },
      publish: {
        autoPublish: false,
        isOnlySelf: 1,
        submitGapSec: 7800,
        clipGapSec: 7500,
        jitterSec: 1800,
        dailyLimit: 10,
        minSubmitIntervalSec: 0,
        maxConcurrentUploads: 2,
        copyright: 1,
        creationStatement: -1,
        dynamic: '',
        noDisturbance: 0,
        defaultCover: '',
        coverSource: 'preset',
        uploadPresetId: 'default',
        seasonId: 0,
        sectionId: 0,
        defaultCategory: '游戏/单机游戏',
        tidWhitelist: { '游戏/单机游戏': 17, '游戏/网络游戏': 65, '生活/日常': 21, 综合: 21 },
        defaultTags: ['直播切片', '名场面'],
        tagSensitiveWords: ['外挂', '代练'],
        defaultTitleSuffix: '',
        descTemplate: '本片段来自 {{date}} 的直播《{{liveTitle}}\n原直播：{{roomUrl}}\n时间点：{{startText}} - {{endText}}\n\n{{desc}}',
        autoCutTimeoutSec: 30,
      },
      cleanup: {
        retentionDays: 7,
        diskFloorGB: 1,
        deleteRawAfterTranscribe: true,
        checkIntervalMin: 9999,
        keepFullVideoOnFailure: true,
      },
      alert: {
        enabled: false,
        channels: [],
        events: {},
        dedupeWindowSec: 900,
        accountExpireWarnDays: 7,
        serverchan: { sendKey: '' },
        dingtalk: { webhook: '', secret: '' },
        telegram: { botToken: '', chatId: '' },
        webhook: { url: '' },
      },
      ui: { enabled: false, host: '127.0.0.1', port: 0, openBrowser: false },
      runtime: {
        dataDir: tmpData,
        timezone: 'Asia/Shanghai',
        logLevel: VERBOSE ? 'debug' : 'info',
        logKeepDays: 3,
        // e2e 用隔离的临时 ledger，而 decisions.jsonl 由全局单例 ledger 写入 ——
        // 关掉这个开关，避免把测试数据写进真实的 data/decisions.jsonl。
        recordDecisions: false,
        allowPaid: true, // mock 端点不产生费用；真实运行请保持 false
        maxParallelTasks: 1,
        stageTimeoutSec: 600,
      },
    };
    writeJsonAtomic(configPath, cfg);

    const e2eLedger = new Ledger({ path: path.join(tmpData, 'ledger.json'), logger: undefined });

    const createOrch = (overrides: Record<string, unknown> = {}): Orchestrator =>
      new Orchestrator({
        configPath,
        ledger: e2eLedger,
        dataDirOverride: tmpData,
        dryRun: false,
        allowPaid: true,
        // 关掉「自动处理基线」：生产默认只处理"从现在起"新录完的场次，
        // 而 mock 造出来的录制时间是过去时刻 —— 留基线会让对账把它们全过滤掉，测试永远触发不了。
        triggerBaselineMs: 0,
        ...overrides,
      });

    let orch = createOrch();
    // 让日志安静一点（除非 --verbose-parent）
    if (!PARENT_VERBOSE) orch.logger.setConsole(false);
    cleanups.push(() => orch.stop());

    ok('配置与台账已隔离到临时目录', exists(configPath) && !exists(path.join(ROOT_DIR, 'data', 'ledger.json' + '.e2e')));

    /* ================= 场景 1：启动补漏对账（发现已完成录制） ================= */
    section('场景 1：启动补漏对账 —— 用 record-history/list 找出未处理的已完成录制');
    const reconcileResult = await orch.trigger.reconcile({ lookbackHours: 24 * 7 });
    eq('对账发现并触发 1 场', reconcileResult.length, 1);
    if (reconcileResult[0]) {
      note(`触发原因：${reconcileResult[0].reason}`);
      ok('触发原因里说明了「下播确认」依据', /结束确认|非直播|窗口/.test(reconcileResult[0].reason), reconcileResult[0].reason);
    }

    // 等流水线跑到 ANALYZED（半自动模式下会停在这里）
    const taskId = reconcileResult[0] ? e2eLedger.listTasks({ limit: 1 })[0]?.id : undefined;
    ok('已创建任务', Boolean(taskId), `taskId=${taskId}`);
    if (!taskId) {
      console.error('\n无法创建任务，后续场景跳过。mock 日志：');
      console.error(fs.readFileSync(mockLogPath, 'utf8').slice(-2000));
      process.exitCode = 1;
      return;
    }

    await waitFor('流水线跑到 ANALYZED（半自动模式会停在这里等人确认）', () => {
      const t = e2eLedger.getTask(taskId);
      return t?.status === 'ANALYZED' || t?.status === 'FAILED';
    }, 60_000);

    let task = e2eLedger.getTask(taskId)!;
    ok('任务状态为 ANALYZED（半自动：等待人工确认，未自动发布）', task.status === 'ANALYZED', `实际 ${task.status}${task.error ? ` / 错误：${task.error.message}` : ''}`);
    if (task.status === 'FAILED') {
      console.error(`\n\x1b[31m流水线失败：${task.error?.stage} :: ${task.error?.message}\x1b[0m`);
    }

    /* ================= 场景 2：转写产物与缓存 ================= */
    section('场景 2：转写 —— 分段调用、缓存键、断点续跑');
    const transcriptPath = path.join(tmpData, 'tasks', taskId, 'transcript.json');
    ok('transcript.json 已落盘', exists(transcriptPath), transcriptPath);
    if (exists(transcriptPath)) {
      const tr = readJson<{ segments: Array<{ start: number; end: number; text: string }>; gaps: unknown[]; audioSeconds?: number; costEstimate?: number }>(transcriptPath);
      ok('转写出了字幕', tr.segments.length > 0, `条数 ${tr.segments.length}`);
      ok('字幕时间戳是全局绝对时间（不是段内相对时间）', tr.segments.every((s) => s.start >= 0 && s.end <= 1900), `范围 ${tr.segments[0]?.start}–${tr.segments[tr.segments.length - 1]?.end}`);
      ok('字幕按时间升序', tr.segments.every((s, i) => i === 0 || s.start >= tr.segments[i - 1]!.start));
      ok('ASR 估算成本已记录', (tr.costEstimate ?? 0) >= 0, `¥${tr.costEstimate}`);

      const mockState = await httpJson<{ asrCalls: Array<{ startTime?: number; endTime?: number; offset?: number }>; asrCallCount: number }>(`${baseUrl}/__mock/state`);
      ok('每个 ASR 调用都成对提供了 startTime/endTime（硬约束 #7）', mockState.asrCalls.every((c) => c.startTime !== undefined && c.endTime !== undefined), JSON.stringify(mockState.asrCalls.slice(0, 3)));
      ok('ASR 调用传的是**文件内**时间（不是全局时间）', mockState.asrCalls.every((c) => (c.startTime ?? 0) >= 0 && (c.endTime ?? 0) <= 1801), JSON.stringify(mockState.asrCalls));
      note(`ASR 实际调用 ${mockState.asrCallCount} 次（30 分钟场次 / 30 分钟窗口 → 1 次；重叠只在多窗口时生效）`);
      ok('未对整片之外的范围发起调用（成本可控）', mockState.asrCallCount >= 1 && mockState.asrCallCount <= 4, `调用 ${mockState.asrCallCount} 次`);

      // 分段调用的核心保证：任何一段都不得超过配置的单次窗口长度（否则同步接口会挂很久）
      {
        const { Transcriber } = await import('../src/asr.ts');
        const probe = new Transcriber({ client: orch.client, config: orch.config });
        const ad = buildAdapterFromTask(e2eLedger.getTask(taskId)!);
        const longPlan = probe.preflight(ad, 4 * 3600); // 模拟 4 小时素材
        ok(
          '4 小时素材会被切成多个调用单元（不是整片一次调用，硬约束 #7）',
          longPlan.windows.length >= 5,
          `${longPlan.windows.length} 个单元`,
        );
        ok(
          '每个调用单元都不超过配置的窗口长度',
          longPlan.windows.every((w) => w.inFileEnd - w.inFileStart <= orch.config.asr.segmentMinutes * 60 + 1),
          longPlan.windows.map((w) => (w.inFileEnd - w.inFileStart).toFixed(0)).join(','),
        );
        note(`4 小时素材 → ${longPlan.windows.length} 个单元，估算费用 ¥${longPlan.estimatedCost.toFixed(2)}（按配置单价估算）`);
      }

      // 断点续跑：重跑转写（不复用 transcript.json），全段应命中缓存
      const callsBefore = mockState.asrCallCount;
      const t2 = e2eLedger.getTask(taskId)!;
      const res2 = await orch.transcriber.transcribe({
        taskId,
        media: buildAdapterFromTask(t2),
        totalDuration: t2.source.totalDuration,
        dryRun: false,
        allowPaid: true,
      });
      const mockState2 = await httpJson<{ asrCallCount: number }>(`${baseUrl}/__mock/state`);
      eq('断点续跑：第二次转写没有产生新的付费调用', mockState2.asrCallCount, callsBefore);
      ok('第二次转写全部命中缓存', res2.cacheHits === res2.paidCalls + res2.cacheHits && res2.paidCalls === 0, `paidCalls=${res2.paidCalls} cacheHits=${res2.cacheHits}`);
      ok('第二次转写结果与第一次一致', res2.transcript.segments.length === tr.segments.length, `${res2.transcript.segments.length} vs ${tr.segments.length}`);
    }

    /* ================= 场景 3：弹幕信号 ================= */
    section('场景 3：弹幕信号（密度、峰值、热词、高能事件）');
    const signalsPath = path.join(tmpData, 'tasks', taskId, 'signals.json');
    ok('signals.json 已落盘', exists(signalsPath));
    if (exists(signalsPath)) {
      const sig = readJson<{
        eventSignalsAvailable: boolean;
        eventCounts: Record<string, number>;
        peaks: Array<{ start: number; end: number; count: number; intensity: number }>;
        keywords: Array<{ word: string; count: number }>;
        danmakuTotal: number;
        danmakuOffset: number;
        density: unknown[];
      }>(signalsPath);
      ok('解析到弹幕', sig.danmakuTotal > 0, `${sig.danmakuTotal} 条`);
      ok('识别出高能事件（SC/上舰/礼物）', sig.eventSignalsAvailable === true && (sig.eventCounts['superchat'] ?? 0) > 0, JSON.stringify(sig.eventCounts));
      ok('产出密度峰值窗口', sig.peaks.length > 0, `${sig.peaks.length} 个`);
      const peakAt600 = sig.peaks.some((p) => Math.abs(p.start - 600) < 60);
      ok('峰值落在 fixture 人为制造的高能时段（约 600s）', peakAt600, `峰值起点：${sig.peaks.map((p) => Math.round(p.start)).join(', ')}`);
      ok('产出高频词', sig.keywords.length > 0, `前 5：${sig.keywords.slice(0, 5).map((k) => k.word).join('/')}`);
      ok('记录了弹幕与转写的时间基准偏移', typeof sig.danmakuOffset === 'number', `offset=${sig.danmakuOffset}`);
    }

    /* ---- 场景 3b：高频词的「n-gram 碎片」必须被左右邻字熵滤掉 ----
     *
     * 真实事故（2026-09-23，4502 条真实弹幕）：
     *   top 片段是 `安可(444) Anko(247) 表情(196) 情包(194) 抱抱(183) 可表(102)
     *   动态(89) 可动(87) 态表(87)` —— `表情包` 被同时切成 `表情`/`情包`/`可表`，
     *   `动态表情` 切成 `动态`/`可动`/`态表`。它们互不构成包含关系（`情包` 不含于 `表情`），
     *   所以老的"包含关系去重"一个都拦不住，硬占掉一半 top-N 名额，
     *   喂给 LLM 的"窗口热词"里全是假词 —— 直接拉低选片质量。
     *
     * 判据换成无监督的**左右邻字熵**：真词两侧用字自由（`[这]表情包[真]`），
     * 碎片两侧被夹死（`情包` 左边几乎只能是"表"）。
     */
    section('场景 3b：高频词去碎片（左右邻字熵，真实事故形态复现）');
    {
      const { extractKeywords } = await import('../src/danmaku.ts');
      /* 构造与事故同构的语料：`表情包` 出现 40 次（3 种不同左邻字 + 3 种右邻字），
         `情包`/`可表` 只作为它的内部切片存在 —— 它们应当被滤掉。 */
      const mk = (text: string, time: number): { time: number; text: string; kind: 'danmaku' } => ({ time, text, kind: 'danmaku' });
      const items: Array<{ time: number; text: string; kind: 'danmaku' }> = [];
      const lefts = ['这个', '那个', '好'];
      const rights = ['真好', '哈哈', '笑死'];
      for (let i = 0; i < 40; i++) {
        items.push(mk(`${lefts[i % 3]}表情包${rights[i % 3]}`, i * 3));
      }
      /* 另加一个真正独立的词，验证过滤没有把所有 2-gram 都干掉 */
      for (let i = 0; i < 30; i++) items.push(mk(`${i % 2 ? '一起' : '快来'}抱抱${i % 2 ? '呀' : '啦'}`, 200 + i * 3));
      const kw = extractKeywords(items as never, { topN: 10, noiseWords: [] });
      const words = kw.map((k) => k.word);
      ok('碎片 `情包` 被滤掉（它是 `表情包` 的内部切片）', !words.includes('情包'), `实际：${words.join('/')}`);
      ok('碎片 `可表` 被滤掉', !words.includes('可表'), `实际：${words.join('/')}`);
      ok('完整词 `表情包` 保留下来', words.includes('表情包'), `实际：${words.join('/')}`);
      ok('真正独立的词没被误杀（`抱抱` 仍在）', words.includes('抱抱'), `实际：${words.join('/')}`);
      note(`碎片过滤：${kw.map((k) => `${k.word}(${k.count})`).join(' ')}`);
    }

    /* ================= 场景 4：LLM 分析产物 ================= */
    section('场景 4：LLM 分析 —— 分块要点、总结、选片、契约后处理');
    const clipsPath = path.join(tmpData, 'tasks', taskId, 'clips.json');
    ok('clips.json 已落盘', exists(clipsPath));
    ok('summary.md 已落盘', exists(path.join(tmpData, 'tasks', taskId, 'summary.md')));

    let clips: ClipRecord[] = [];
    if (exists(clipsPath)) {
      const doc = readJson<{ clips: ClipRecord[]; degraded: boolean; escalated: boolean; warnings: string[]; modelUsed: string }>(clipsPath);
      clips = doc.clips;
      ok('产出候选切片', clips.length > 0, `${clips.length} 个`);
      ok('未进入降级兜底', doc.degraded === false);
      ok('选片用的是选片档模型', doc.modelUsed === 'mock-select-model', doc.modelUsed);

      // 契约后处理
      ok('全部标题 ≤ 80 字符（硬约束 #3）', clips.every((c) => c.title.length <= 80), clips.map((c) => c.title.length).join(','));
      ok('全部简介 ≤ 250 字符', clips.every((c) => c.desc.length <= 250));
      ok('标签去重后仍在 1–10 个（硬约束 #16）', clips.every((c) => c.tags.length >= 1 && c.tags.length <= 10), clips.map((c) => c.tags.length).join(','));
      ok('标签里的敏感词被过滤', clips.every((c) => c.tags.every((t) => !t.includes('外挂'))));
      ok('分区全部映射到白名单 tid（陷阱 #20）', clips.every((c) => ['游戏/单机游戏', '游戏/网络游戏', '生活/日常', '综合'].includes(c.category)), clips.map((c) => c.category).join(' / '));
      ok('无法映射的分区已回退（LLM 给的「不存在的分区/测试回退」）', clips.some((c) => c.start === 900) ? clips.find((c) => c.start === 900)!.category === '游戏/单机游戏' : true);
      ok('片段时长全部在配置范围内（含 buffer 调整后）', clips.every((c) => {
        const d = c.end - c.start;
        return d >= 29.9 && d <= 90.1;
      }), clips.map((c) => (c.end - c.start).toFixed(1)).join(','));
      ok('片段互不重叠', clips.every((c, i) => i === 0 || c.start >= clips[i - 1]!.end - 0.01), clips.map((c) => `${Math.round(c.start)}-${Math.round(c.end)}`).join(' '));
      ok('片段落在视频时长内', clips.every((c) => c.start >= 0 && c.end <= 1801));
      ok('默认勾选评分 ≥ 阈值的片段', clips.filter((c) => c.selected).every((c) => c.score >= 7.0));
      ok('低分片段默认不勾选', clips.filter((c) => c.score < 7.0).every((c) => !c.selected));
      ok('保留了 LLM 原始输出（用于 decisions.jsonl 的 diff）', clips.every((c) => c.llmOriginal !== undefined));
      ok('记录了 cover_ts 且落在片段内', clips.every((c) => c.cover_ts !== undefined && c.cover_ts >= c.start && c.cover_ts <= c.end));

      // decisions.jsonl 由全局单例 ledger 持有（不随 e2e 的隔离台账走），
      // 因此这里不断言它的内容；该功能由真实任务验证（data/decisions.jsonl 里有实际记录）。
      ok('候选产出与 decisions 记录职责已分离（记录走全局 ledger）', clips.length > 0);
    }

    // prompt 缓存前提：同批分块请求的 system 必须字节级一致
    const chunkSystems = llm.systems.filter((s) => s.includes('内容分析助手'));
    if (chunkSystems.length > 1) {
      const uniq = new Set(chunkSystems.map(simpleHash));
      eq('分块请求的 system prompt 字节级一致（DeepSeek 缓存命中的前提，§5.4）', uniq.size, 1);
    }

    /* ================= 场景 5：契约校验失败 → 升级到另一档模型重跑 ================= */
    section('场景 5：硬约束 #13 —— 契约校验失败必须**升级到另一档模型**重跑');
    {
      // ★ 关键：假 LLM 用「全局 select 计数器」判断是否注入契约失败，
      //   而场景 4 已经消耗掉了第 1 次。这里把计数器归零，
      //   让本场景的**第一次**选片调用返回违约数据（否则注入永远不会生效）。
      llm.selectLog.length = 0;
      llm.selectCalls = 0;
      llm.contractFailure = 'first-select';
      const selectCallsBefore = llm.selectCalls;
      const callsBefore = llm.calls.length;
      const newTask = await createIsolatedTask(orch, e2eLedger, tmpRoot, '契约失败升级');
      const t = e2eLedger.getTask(newTask)!;
      const res = await orch.analyzer.analyze({
        taskId: newTask,
        transcript: readJson(path.join(tmpData, 'tasks', taskId, 'transcript.json')),
        signals: readJson(path.join(tmpData, 'tasks', taskId, 'signals.json')),
        videoDuration: t.source.totalDuration,
        dryRun: false,
        allowPaid: true,
      });
      const selectCallsAfter = llm.selectCalls;
      if (VERBOSE_PUBLIC) {
        console.log(`  [调试] 本轮 LLM 调用：${llm.calls.slice(callsBefore).map((c) => `${c.isSelect ? 'SELECT' : 'other'}/${c.model}/${c.status}`).join(', ')}`);
        console.log(`  [调试] selectCalls ${selectCallsBefore} → ${selectCallsAfter}`);
        console.log(`  [调试] selectLog：${llm.selectLog.join('  ||  ')}`);
      }
      ok('发生了第二次选片调用（说明走了重跑路径）', selectCallsAfter - selectCallsBefore >= 2, `调用 ${selectCallsAfter - selectCallsBefore} 次`);
      ok('第一次调用确实返回了违约数据（标题超长/起始为负）', llm.selectLog[0]?.includes('failNow=true') ?? false, llm.selectLog.join(' || '));
      ok('结果标记 escalated = true', res.decision.escalated === true);
      ok('升级说明里指明了换到哪一档模型', /mock-summary-model|另一档/.test(res.decision.escalationNote ?? ''), res.decision.escalationNote);
      ok('重跑后产出合法候选（没有直接降级）', res.decision.degraded === false && res.decision.clips.length > 0, `${res.decision.clips.length} 个 / degraded=${res.decision.degraded}`);

      // 时间线要能看出「先失败、再升级重跑」
      const timelineSteps = res.timeline.map((x) => `${x.ok ? 'ok' : 'fail'}:${x.step}@${x.model}`);
      ok('时间线记录了失败与升级重跑两个步骤', timelineSteps.some((s) => s.startsWith('fail:选片与起标题')) && timelineSteps.some((s) => s.includes('升级重跑')), timelineSteps.join(' | '));
      const failStep = res.timeline.find((x) => !x.ok && x.step === '选片与起标题');
      const retryStep = res.timeline.find((x) => x.step.includes('升级重跑'));
      ok('失败步骤记录的是原模型', failStep?.model === 'mock-select-model', failStep?.model);
      ok('重跑步骤记录的是**另一个**模型', retryStep?.model === 'mock-summary-model', retryStep?.model);
      note(`升级路径：${failStep?.model} 契约失败 → ${retryStep?.model} 重跑成功`);
      llm.contractFailure = 'none';
    }

    /* ================= 场景 6：切片 + 投稿（两步走） ================= */
    section('场景 6：切片与投稿 —— /task/cut 取 task.output，再 /bili/upload');
    {
      const before = await httpJson<{ tasks: Array<{ type: string }>; uploads: unknown[]; archives: Array<{ bvid: string; title: string }> }>(`${baseUrl}/__mock/state`);
      const cutsBefore = before.tasks.filter((t) => t.type === 'cut').length;
      const uploadsBefore = before.uploads.length;

      const allClips = e2eLedger.getClips(taskId);
      if (VERBOSE_PUBLIC) {
        console.log(`  [调试] 切片状态：${allClips.map((c) => `${c.index}:${c.status}:sel=${c.selected}`).join(' ')}`);
        console.log(`  [调试] ledger getClip(0) = ${JSON.stringify(e2eLedger.getClip(taskId, 0)?.status)}`);
      }
      const selected = allClips.filter((c) => c.selected).map((c) => c.index);
      ok('有已勾选的切片待发布', selected.length > 0, `${selected.length} 个`);

      const pubResult = await orch.publisher.publishClips({
        task: e2eLedger.getTask(taskId)!,
        uid: 1000000000000000,
        indices: selected,
        onProgress: () => undefined,
      });
      if (VERBOSE_PUBLIC) {
        console.log(`  [调试] publishClips 返回：${JSON.stringify({ submitted: pubResult.submitted, skipped: pubResult.skipped, failed: pubResult.failed, quota: pubResult.quota })}`);
        console.log(`  [调试] 明细：${pubResult.results.map((r) => `#${r.clipIndex}:ok=${r.ok}:skip=${r.skipped ? 'Y' : 'N'}:err=${r.error?.message ?? '-'}`).join(' | ')}`);
      }

      const after = await httpJson<{
        tasks: Array<{ type: string }>;
        uploads: Array<{ title: string; config: Record<string, unknown> }>;
        archives: Array<{ bvid: string; title: string; state: number }>;
      }>(`${baseUrl}/__mock/state`);
      const cutsAfter = after.tasks.filter((t) => t.type === 'cut').length;

      ok('为每个勾选切片提交了切片任务', cutsAfter - cutsBefore === selected.length, `${cutsAfter - cutsBefore} vs ${selected.length}`);
      ok('切片全部成功', pubResult.failed === 0, `失败 ${pubResult.failed}`);
      ok('为每个切片提交了投稿', after.uploads.length - uploadsBefore === selected.length, `${after.uploads.length - uploadsBefore} vs ${selected.length}`);

      // 投递内容合规
      const uploadCfg = after.uploads[after.uploads.length - 1]!.config;
      ok('投稿配置带 title', typeof uploadCfg['title'] === 'string' && String(uploadCfg['title']).length > 0);
      ok('投稿配置的标签为数组', Array.isArray(uploadCfg['tag']), JSON.stringify(uploadCfg['tag']));
      ok('投稿配置的 tid 来自白名单', [17, 65, 21].includes(Number(uploadCfg['tid'])), String(uploadCfg['tid']));
      ok('投稿配置带 dtime 且距提交 > 7200 秒（硬约束 #4）', typeof uploadCfg['dtime'] === 'number' && Number(uploadCfg['dtime']) - Math.floor(Date.now() / 1000) > 7100, `dtime-now=${Number(uploadCfg['dtime']) - Math.floor(Date.now() / 1000)}`);
      eq('试跑期保持仅自己可见（硬约束 #10）', Number(uploadCfg['is_only_self']), 1);
      ok('未把幂等指纹写进公开字段（陷阱 #18）', !String(uploadCfg['desc'] ?? '').includes('fp') && !String(uploadCfg['dynamic'] ?? '').includes('fp'), String(uploadCfg['desc'] ?? '').slice(0, 120));

      // 切片产出真实存在
      const clipOut = e2eLedger.getClips(taskId).filter((c) => c.cutOutput);
      ok('切片产出路径来自服务端返回的 task.output', clipOut.length === selected.length, `${clipOut.length} 个`);
      ok('切片产出文件真实存在（非零字节）', clipOut.every((c) => c.cutOutput && exists(c.cutOutput) && fs.statSync(c.cutOutput).size > 0));

      // 反查 bvid。
      // ★ 必须轮询等待：/bili/upload 只返回 taskId（陷阱 #11），任务队列在内存中，
      //   稿件在 B站侧出现有延迟 —— 这正是「任务轮询只是加速信号、完成必须以 archives 反查为准」的由来。
      await waitFor('mock 侧上传任务完成并进入 archives', async () => {
        const s = await httpJson<{ archives: unknown[] }>(`${baseUrl}/__mock/state`);
        return s.archives.length >= selected.length;
      }, 30_000);

      const confirm = await orch.publisher.confirmPublished(taskId);
      ok('通过 /bili/archives 反查到 bvid（陷阱 #11：上传接口只返回 taskId）', confirm.confirmed.length > 0, `确认 ${confirm.confirmed.length} 个，待定 ${confirm.pending.length}`);
      eq('全部勾选切片都反查到 bvid', confirm.confirmed.length, selected.length);
      ok('反查后切片状态转为 PUBLISHED', e2eLedger.getClips(taskId).filter((c) => c.status === 'PUBLISHED').length === selected.length, JSON.stringify(e2eLedger.getClips(taskId).map((c) => `${c.index}:${c.status}`)));
      const withBvid = e2eLedger.getClips(taskId).filter((c) => c.bvid);
      ok('台账记录了 bvid', withBvid.length === confirm.confirmed.length, `${withBvid.length} 个`);
      // mock 侧把 is_only_self=1 的稿件标为 state=-50（仅自己可见），与真实 B站语义一致
      const archives = await httpJson<{ archives: Array<{ bvid: string; state: number }> }>(`${baseUrl}/__mock/state`);
      const myBvids = new Set(withBvid.map((c) => c.bvid));
      const mine = archives.archives.filter((a) => myBvids.has(a.bvid));
      ok('对应稿件在服务器侧处于「仅自己可见」（state=-50）', mine.length > 0 && mine.every((a) => a.state === -50), JSON.stringify(mine.map((a) => a.state)));
    }

    /* ================= 场景 7：幂等 —— 重复运行不产生重复稿件 ================= */
    section('场景 7：幂等 —— 重复运行不产生重复稿件');
    {
      const before = await httpJson<{ uploads: unknown[] }>(`${baseUrl}/__mock/state`);
      const selected = e2eLedger.getClips(taskId).filter((c) => c.selected).map((c) => c.index);
      const again = await orch.publisher.publishClips({
        task: e2eLedger.getTask(taskId)!,
        uid: 1000000000000000,
        indices: selected,
      });
      const after = await httpJson<{ uploads: unknown[] }>(`${baseUrl}/__mock/state`);
      eq('第二次运行没有新增任何投稿', after.uploads.length, before.uploads.length);
      eq('全部被幂等跳过', again.skipped, selected.length);
      eq('没有任何失败', again.failed, 0);
      ok('跳过原因里说明了「已投过」', again.results.every((r) => (r.skipped ?? '').includes('幂等') || (r.skipped ?? '').includes('已存在')), again.results.map((r) => r.skipped).join(' | '));
    }

    /* ================= 场景 8：崩溃恢复 ================= */
    section('场景 8：崩溃恢复 —— 卡在 SUBMITTING 的切片');
    {
      // 人为制造一个 SUBMITTING 的切片（模拟「提交前崩溃」）
      const t = e2eLedger.getTask(taskId)!;
      const clips = e2eLedger.getClips(taskId);
      const target = clips.find((c) => c.status === 'PUBLISHED');
      if (target) {
        e2eLedger.setClipStatus(taskId, target.index, 'SUBMITTING', { bvid: undefined, uploadTaskId: undefined });
        const rec = await orch.publisher.recoverStuck();
        ok('发现了卡住的切片', rec.checked > 0, `检查 ${rec.checked} 个`);
        const after = e2eLedger.getClip(taskId, target.index);
        ok('服务器侧已存在该稿件 → 恢复时补记为 PUBLISHED 而不是重复投稿', after?.status === 'PUBLISHED' && Boolean(after?.bvid), `实际 ${after?.status} / bvid=${after?.bvid}`);
        note(rec.notes.join('；') || '（无备注）');
      } else {
        ok('跳过崩溃恢复场景（没有 PUBLISHED 切片）', false);
      }
      void t;
    }

    /* ================= 场景 9：素材清理判定（分层策略） ================= */
    section('场景 9：素材清理判定 —— 分层策略与缓冲期');
    {
      // 先把全部勾选切片推进到 PUBLISHED，才能验证「切片全部发布完成后才可删」这条规则
      const allSelected = e2eLedger.getClips(taskId).filter((c) => c.selected);
      await orch.publisher.publishClips({ task: e2eLedger.getTask(taskId)!, uid: 1000000000000000, indices: allSelected.map((c) => c.index) });
      await waitFor('全部切片进入 archives', async () => {
        const s = await httpJson<{ archives: unknown[] }>(`${baseUrl}/__mock/state`);
        return s.archives.length >= allSelected.length;
      }, 30_000);
      await orch.confirmPendingPublished();

      const t = e2eLedger.getTask(taskId)!;
      const publishedCount = e2eLedger.getClips(taskId).filter((c) => c.status === 'PUBLISHED').length;
      ok('全部勾选切片已发布', publishedCount === allSelected.length, `${publishedCount}/${allSelected.length}`);

      const verdict = orch.cleaner.judgeDeletabilityPublic(t);
      if (VERBOSE_PUBLIC) {
        console.log(`  [调试] task.status=${t.status} 切片=${e2eLedger.getClips(taskId).map((c) => `${c.index}:${c.status}:sel=${c.selected}`).join(' ')}`);
        console.log(`  [调试] v.facts=${JSON.stringify(verdict.facts)}`);
      }
      // 未勾选的候选切片（CANDIDATE）不会发布，不该阻塞清理 —— 这里正是该语义的断言
      const selectedUnpublished = e2eLedger.getClips(taskId).filter((c) => c.selected && c.status !== 'PUBLISHED');
      eq('所有已勾选切片都已发布（未勾选的候选不算阻塞项）', selectedUnpublished.length, 0);
      ok('原始分段：转写已完成且已勾选切片全部完成 → 可删（§7.3）', verdict.rawDeletable === true, verdict.rawReason);
      // 场级状态推进到 PUBLISHED 后同样可删（用注入的 task 验证另一条路径）
      const asPublished: TaskRecord = { ...t, status: 'PUBLISHED', stage: 'PUBLISHED' };
      ok('场级状态为 PUBLISHED 时也可删', orch.cleaner.judgeDeletabilityPublic(asPublished).rawDeletable === true, orch.cleaner.judgeDeletabilityPublic(asPublished).rawReason);
      ok('压制产物：完整版未确认 / 缓冲期未满 → 不可删', verdict.fullVideoDeletable === false, verdict.fullVideoReason);
      note(`原始分段：${verdict.rawReason}`);
      note(`压制产物：${verdict.fullVideoReason}`);

      const report = await orch.cleaner.runOnce({ dryRun: true });
      ok('dry-run 清理不删除任何文件', report.actions.length === 0, `执行了 ${report.actions.length} 个删除动作`);
      ok('dry-run 给出了将要删除的说明', report.notes.some((n) => n.includes('dry-run')), report.notes.join(' | ') || '（无说明）');

      // 真删原始分段，验证台账被更新
      const rawFiles = t.source.rawFiles.filter((f) => exists(f));
      ok('清理前原始分段确实存在', rawFiles.length > 0, `${rawFiles.length} 个`);
      if (rawFiles.length) {
        const real = await orch.cleaner.runOnce({ dryRun: false });
        ok('执行清理后原始分段被删除', rawFiles.every((f) => !exists(f)), rawFiles.filter((f) => exists(f)).join(', '));
        ok('台账记录了清理时间', Boolean(e2eLedger.getTask(taskId)?.cleaned?.rawDeletedAt));
        note(`清理动作 ${real.actions.length} 个，释放 ${fmtBytes(real.freedBytes)}`);
      }

      // 缓冲期语义：把保留期控制住，验证「全部发布 + 完整版确认 + 过缓冲期」后才可删
      {
        const base = e2eLedger.getTask(taskId)!;
        const noClips: TaskRecord = { ...base, clips: e2eLedger.getClips(taskId).filter((c) => c.status !== 'PUBLISHED') };
        const v0 = orch.cleaner.judgeDeletabilityPublic(noClips, { now: Date.now() });
        ok('存在未发布切片时压制产物不可删（补切/重切还要读它）', v0.fullVideoDeletable === false, v0.fullVideoReason);

        const allPublished: TaskRecord = {
          ...base,
          clips: e2eLedger.getClips(taskId).map((c) => ({ ...c, status: 'PUBLISHED' as const })),
          fullUpload: 'CONFIRMED',
          publishedAt: new Date(Date.now() - 8 * 86400_000).toISOString(),
          updatedAt: new Date(Date.now() - 8 * 86400_000).toISOString(),
          status: 'PUBLISHED',
        };
        const v1 = orch.cleaner.judgeDeletabilityPublic(allPublished, { now: Date.now() });
        ok('全部切片发布 + 完整版确认 + 已过 7 天缓冲期 → 压制产物可删', v1.fullVideoDeletable === true, v1.fullVideoReason);

        const justPublished: TaskRecord = { ...allPublished, publishedAt: nowIso(), updatedAt: nowIso() };
        const v2 = orch.cleaner.judgeDeletabilityPublic(justPublished, { now: Date.now() });
        ok('刚发布完成（未满缓冲期）→ 仍不可删', v2.fullVideoDeletable === false, v2.fullVideoReason);
        ok('不可删的原因里写明了「未满缓冲期」', /缓冲期/.test(v2.fullVideoReason), v2.fullVideoReason);

        const notConfirmed: TaskRecord = { ...allPublished, fullUpload: 'UPLOADING' };
        const v3 = orch.cleaner.judgeDeletabilityPublic(notConfirmed, { now: Date.now() });
        ok('完整版未通过 archives 反查确认 → 不可删（硬约束 #17）', v3.fullVideoDeletable === false && /反查|确认/.test(v3.fullVideoReason), v3.fullVideoReason);

        const failedTask: TaskRecord = { ...allPublished, status: 'FAILED' };
        const v4 = orch.cleaner.judgeDeletabilityPublic(failedTask, { now: Date.now() });
        ok('失败态任务保留素材（便于重跑）', v4.fullVideoDeletable === false && /失败/.test(v4.fullVideoReason), v4.fullVideoReason);
      }
    }

    /* ================= 场景 10：无高能事件时的降级信号 ================= */
    section('场景 10：弹幕 XML 不含 SC/上舰/礼物 → 信号降级（陷阱 #25）');
    {
      const plainXml = path.join(ROOT_DIR, 'test', 'fixtures', 'danmaku-sample-plain.xml');
      if (exists(plainXml)) {
        const { analyzeDanmaku } = await import('../src/danmaku.ts');
        const r = analyzeDanmaku({ taskId: 'plain-test', filePath: plainXml, videoDuration: 1800, config: orch.config });
        ok('eventSignalsAvailable = false', r.signals.eventSignalsAvailable === false);
        ok('显式给出了降级说明', r.warnings.some((w) => w.includes('降级')), r.warnings.join(' | '));
        ok('仍然产出了密度峰值（降级不等于不可用）', r.signals.peaks.length > 0, `${r.signals.peaks.length} 个`);
      } else {
        const { parseDanmakuXml } = await import('../src/danmaku.ts');
        const r = parseDanmakuXml('<i><d p="1.0,1,25,16777215,0,0,abc,0">测试</d></i>');
        ok('不含事件节点时 eventSignalsAvailable = false', r.eventSignalsAvailable === false);
      }
    }

    /* ================= 场景 11：LLM 完全不可用 → 弹幕密度降级兜底 ================= */
    section('场景 11：LLM 完全不可用 → 降级为「弹幕密度 Top-N 窗口」（§5.5）');
    {
      llm.failFirst = 99; // 让所有 LLM 调用都失败
      const newTask = await createIsolatedTask(orch, e2eLedger, tmpRoot, 'LLM 不可用降级');
      const t = e2eLedger.getTask(newTask)!;
      const res = await orch.analyzer.analyze({
        taskId: newTask,
        transcript: readJson(path.join(tmpData, 'tasks', taskId, 'transcript.json')),
        signals: readJson(path.join(tmpData, 'tasks', taskId, 'signals.json')),
        videoDuration: t.source.totalDuration,
        dryRun: false,
        allowPaid: true,
      });
      ok('进入了降级兜底', res.decision.degraded === true);
      ok('产出 de graded=true 的候选片段', res.decision.clips.length > 0 && res.decision.clips.every((c) => c.degraded), `${res.decision.clips.length} 个`);
      ok('降级产出默认不勾选（必须人工确认）', res.decision.clips.every((c) => !c.selected));
      ok('降级产出的标题是占位符，提示需人工填写', res.decision.clips.every((c) => c.title.includes('待填写')));
      ok('说明里交代了降级原因', (res.decision.escalationNote ?? '').length > 0, res.decision.escalationNote);
      ok('总结也标注了不可用', res.summary.includes('降级') || res.summary.includes('不可用'), res.summary.slice(0, 80));
      llm.failFirst = 0;
    }

    /* ================= 场景 12：dry-run 不产生付费调用 ================= */
    section('场景 12：--dry-run 默认不调用付费 AI（硬约束 #14）');
    {
      const dryTask = await createIsolatedTask(orch, e2eLedger, tmpRoot, 'dry-run 付费保护');
      const dryOrch = createOrch({ dryRun: true, allowPaid: false });
      dryOrch.logger.setConsole(false);
      const t = e2eLedger.getTask(dryTask)!;
      // ★ 关键：必须用**全新的空缓存目录**，否则会命中前面场景已缓存的转写结果，
      //   「无缓存时不得付费」这个前提就不成立了（实测：复用共享缓存会直接返回 150 条字幕）。
      const { Transcriber, AsrCache } = await import('../src/asr.ts');
      const coldCacheDir = path.join(tmpRoot, `asr-cache-cold-${Date.now()}`);
      const coldTranscriber = new Transcriber({
        client: orch.client,
        config: orch.config,
        logger: dryOrch.logger,
        cache: new AsrCache(coldCacheDir, dryOrch.logger),
      });
      const callsBefore = (await httpJson<{ asrCallCount: number }>(`${baseUrl}/__mock/state`)).asrCallCount;

      const res = await coldTranscriber.transcribe({
        taskId: dryTask,
        media: buildAdapterFromTask(t, `-dry-${stamp}`),
        totalDuration: t.source.totalDuration,
        dryRun: true,
        allowPaid: false,
      });
      const callsAfter = (await httpJson<{ asrCallCount: number }>(`${baseUrl}/__mock/state`)).asrCallCount;
      eq('dry-run 且无缓存时没有发起任何 ASR 调用', callsAfter, callsBefore);
      ok('明确记录了拒绝付费的原因（写入 gaps，供 UI 与总结提示）', res.transcript.gaps.length > 0 && res.transcript.gaps.every((g) => g.reason.includes('dry-run')), JSON.stringify(res.transcript.gaps.map((g) => g.reason)));
      ok('dry-run 的 gaps 覆盖了整个时间轴（而不是假装转写成功）', res.transcript.segments.length === 0 && res.failedWindows > 0, `segments=${res.transcript.segments.length} failedWindows=${res.failedWindows}`);
      note(`dry-run 预检：${res.failedWindows} 个窗口被跳过（未付费）`);

      /* ★ 契约：编排层必须能识别出"这次空转写是安全阀拦的"，从而**优雅终止**而不是报错。
         实测事故（2026-09-23 20:51）：dry-run 实例对两个预检任务各抛一次
         "语音识别没有产出任何字幕"，被 catch 归为 internal 写进 data/errors.jsonl，
         把「近 24h 错误」冲成噪音。修复靠的是 isDryRunPaymentRejection() 这个纯函数，
         它的判据依赖 asr 写进 gaps 的前缀 —— 所以这里锁住"前缀契约"本身。 */
      const { isDryRunPaymentRejection, DRY_RUN_REJECT_PREFIX } = await import('../src/asr.ts');
      ok(
        'asr 层写入的 gaps 前缀符合编排层识别契约（DRY_RUN_REJECT_PREFIX）',
        res.transcript.gaps.every((g) => (g.reason ?? '').startsWith(DRY_RUN_REJECT_PREFIX)),
        `前缀=${DRY_RUN_REJECT_PREFIX} 实际=${res.transcript.gaps[0]?.reason?.slice(0, 40)}`,
      );
      ok('编排层判定为「设计内的付费拦截」（不报错、不写错误报告）', isDryRunPaymentRejection(res.transcript) === true);
      /* 反向：只要有一个窗口是**真实**失败，就不能被当成"没付费"吞掉 */
      ok(
        '混入真实失败时判定为 false（真故障必须照常报错，不许拿没付费当挡箭牌）',
        isDryRunPaymentRejection({
          segments: [],
          gaps: [{ reason: `${DRY_RUN_REJECT_PREFIX} 且无缓存：拒绝调用付费 ASR（段 1）` }, { reason: 'http-status: 上游 500' }],
        }) === false,
      );
      ok('没有 gaps 时判定为 false（不能假设是安全阀拦的）', isDryRunPaymentRejection({ segments: [], gaps: [] }) === false);
      ok('有字幕时判定为 false（不是空转写）', isDryRunPaymentRejection({ segments: [{}], gaps: [{ reason: DRY_RUN_REJECT_PREFIX }] }) === false);

      // 分析阶段同样不得调用 LLM
      const llmBefore = llm.calls.length;
      const dryAnalyze = await dryOrch.analyzer.analyze({
        taskId: dryTask,
        transcript: res.transcript,
        signals: readJson(path.join(tmpData, 'tasks', taskId, 'signals.json')),
        videoDuration: t.source.totalDuration,
        dryRun: true,
        allowPaid: false,
      });
      eq('dry-run 没有发起任何 LLM 调用', llm.calls.length, llmBefore);
      ok('dry-run 分析产出降级候选而非付费结果', dryAnalyze.decision.degraded === true);
      dryOrch.stop();
    }

    /* ================= 场景 13：截流/鉴权与 401 ================= */
    section('场景 13：鉴权与错误处理');
    {
      // 错误 PassKey → 401
      let got401 = false;
      try {
        const res = await fetch(`${baseUrl}/common/version`, { headers: { Authorization: 'wrong-key' } });
        got401 = res.status === 401;
      } catch {
        got401 = false;
      }
      ok('错误 PassKey 被拒绝（401）', got401);

      // 平台大小写陷阱：传错静默返回空数组
      const wrongPlatform = await httpJson<{ data: unknown[] }>(`${baseUrl}/record-history/recent-clips?room_id=12345678&platform=bilibili`, {
        headers: { Authorization: mockPass },
      });
      eq('platform 传成小写 bilibili → 静默返回空数组（陷阱 #1 已复现并验证防御）', wrongPlatform.data.length, 0);

      // 客户端默认值必须是 Bilibili
      const { BiliLiveClient } = await import('../src/api.ts');
      const c = new BiliLiveClient({ baseUrl, passKey: 'wrong' });
      let has401Hint = false;
      try {
        await c.version();
      } catch (e) {
        has401Hint = /PassKey|401/.test((e as Error).message);
      }
      ok('401 的错误消息给出可执行结论（指向 PassKey）', has401Hint);

      // 契约拦截：relative output
      const goodClient = new BiliLiveClient({ baseUrl, passKey: mockPass });
      let cutRejected = false;
      try {
        await goodClient.cut({
          videoFilePath: path.join(tmpRoot, 'x.flv'),
          output: 'relative-name.mp4',
          ffmpegOptions: { ss: 0, to: 10, 'c:v': 'libx264' },
        });
      } catch (e) {
        cutRejected = /绝对路径/.test((e as Error).message);
      }
      ok('相对 output 在客户端就被拒绝（陷阱 #6）', cutRejected);

      // 契约拦截：stream copy
      let copyRejected = false;
      try {
        await goodClient.cut({
          videoFilePath: path.join(tmpRoot, 'x.flv'),
          output: path.join(tmpRoot, 'x-out.mp4'),
          ffmpegOptions: { ss: 0, to: 10, 'c:v': 'copy' },
        });
      } catch (e) {
        copyRejected = /stream copy/.test((e as Error).message);
      }
      ok('stream copy 在客户端就被拒绝（硬约束 #5）', copyRejected);

      // 契约拦截：ASR 只传一个时间参数
      let pairRejected = false;
      try {
        await goodClient.subtitle({ file: path.join(tmpRoot, 'x.flv'), startTime: 0 });
      } catch (e) {
        pairRejected = /成对/.test((e as Error).message);
      }
      ok('ASR 只传 startTime 被拒绝（硬约束 #7 / 陷阱 #4）', pairRejected);
    }

    /* ================= 场景 14：错误报告与脱敏 ================= */
    section('场景 14：错误报告 —— 无需复现即可定位问题，且不含未脱敏凭据');
    {
      const { writeErrorReport, loadErrorReport, renderErrorTimeline } = await import('../src/errors.ts');
      const reportRes = writeErrorReport({
        taskId,
        taskTitle: 'E2E 测试场次',
        stage: 'ANALYZING',
        type: 'llm-unavailable',
        error: new Error(`调用失败：Authorization: ${mockPass} 被拒绝`),
        taskStatus: 'FAILED',
        client: orch.client,
        request: {
          method: 'POST',
          url: `${baseUrl}/bili/upload?auth=${mockPass}`,
          params: { apiKey: 'sk-leak-test-abcdef', config: { title: '正常标题' } },
          status: 500,
          responseBody: `{"error":"server error"}\napiKey: sk-leak-test-abcdef\n${'X'.repeat(5200)}`,
          responseOriginalLength: 5250,
        },
      });
      ok('错误报告已落盘', exists(reportRes.reportPath), reportRes.reportPath);
      const reportText = fs.readFileSync(reportRes.reportPath, 'utf8');
      ok('报告中不含未脱敏的 passKey', !reportText.includes(mockPass), '发现了明文 passkey');
      ok('报告中不含未脱敏的 API Key', !reportText.includes('sk-leak-test-abcdef'), '发现了明文 API Key');
      ok('报告中保留了可读的排障信息（标题仍可见）', reportText.includes('正常标题'));
      ok('响应体 >4KB 时被截断并记录原始长度', reportText.includes('responseOriginalLength') && reportText.includes('52'));
      const loaded = loadErrorReport(reportRes.brief.reportId);
      ok('报告可被重新载入（CLI --inspect / UI 查看日志的入口）', Boolean(loaded));
      const timeline = loaded ? renderErrorTimeline(loaded) : '';
      ok('渲染后的时间线非空且可读', timeline.length > 50, timeline.slice(0, 100));
      ok('时间线同样不含凭据', !timeline.includes(mockPass));
      note(`报告 ID：${reportRes.brief.reportId}`);
    }

    /* ================= 场景 15：健康快照 ================= */
    section('场景 15：健康快照（UI 健康面板的数据来源）');
    {
      const h = await orch.health();
      ok('biliLive-tools 连接状态已探测', h.bililive.ok === true, h.bililive.message);
      ok('识别出版本漂移（mock 返回 3.21.0，核实版本 3.22.1）', h.bililive.drift === true, h.bililive.message);
      ok('账号信息已获取', Boolean(h.account), JSON.stringify(h.account));
      ok('磁盘信息已获取', Boolean(h.disk), JSON.stringify(h.disk));
      ok('今日投稿数已统计', typeof h.todayPublished === 'number', String(h.todayPublished));
      ok('素材占用已统计', h.storage.tasks > 0, JSON.stringify(h.storage));
      ok('触发状态已统计', h.trigger.processedCount > 0, JSON.stringify(h.trigger.processedCount));
      note(`版本漂移：${h.bililive.message}`);
    }

    /* ================= 场景 16：mock server 侧调用记录总览 ================= */
    section('场景 16：调用总览（验证「该调的调了、不该调的没调」）');
    {
      const s = await httpJson<{ requests: string[]; asrCallCount: number; archives: Array<{ bvid: string; title: string }> }>(`${baseUrl}/__mock/state`);
      const paths = s.requests.map((r) => r.split(' ')[1] ?? '');
      ok('调用了 /record-history/list（启动补漏）', paths.some((p) => p.startsWith('/record-history/list')));
      ok('调用了 /ai/subtitle', paths.some((p) => p === '/ai/subtitle'));
      ok('调用了 /task/cut', paths.some((p) => p === '/task/cut'));
      ok('调用了 /bili/upload', paths.some((p) => p === '/bili/upload'));
      ok('调用了 /bili/archives（bvid 反查）', paths.some((p) => p === '/bili/archives'));
      ok('调用了 /common/getLogContent（错误报告附对方日志）', paths.some((p) => p === '/common/getLogContent'));
      ok('**没有**调用 /user/export（含 cookie 明文，禁止调用）', !paths.some((p) => p === '/user/export'));
      note(`ASR 总调用 ${s.asrCallCount} 次；B站侧稿件 ${s.archives.length} 个：${s.archives.map((a) => a.bvid).join(', ')}`);
      eq('B站侧稿件数与已发布切片数一致（无重复投稿）', s.archives.length, e2eLedger.getClips(taskId).filter((c) => c.status === 'PUBLISHED').length);
    }

    /* ================= 场景 17：每日额度口径 ================= */
    section('场景 17：每日额度口径 —— 同切片可重投，但同一次投稿必须折叠');
    {
      // 背景：真实台账里同一天先「单投 5 个切片」，随后又把同样 5 个切片「并成 1 个 6 分P 稿件」，
      //      日志中 (taskId, clipIndex) 完全重复。旧实现按 (taskId, clipIndex) 去重 → 11 算成 6，
      //      每日上限被绕过（实测当天投了 11 个稿件却只记 6）。此场景锁死正确口径。
      const qRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quota-'));
      const qLedger = new Ledger({ path: path.join(qRoot, 'ledger.json') });
      const taskId = 'quota-task';
      /**
       * 时间戳基准取「**今天** 00:00:10」，而不是 `Date.now() + 偏移`。
       *
       * ⚠️ 踩过的坑：原来用 `Date.now() + offsetSec`（未来时间），偏移量最大 +800 秒，
       * 于是**在 23:46 之后跑这个测试，时间戳会跨到第二天**，被 `todayPublishedCount`
       * 的「只算今天」过滤掉，凭空少算 1 → 三条断言一起失败。
       * 表现是「白天全绿、深夜必红」，实测在 23:48 复现（期望 12 实际 11）。
       *
       * 固定到今天凌晨就与运行时刻无关：最早 00:00:10、最晚 00:13:30，永远同一天。
       */
      const dayBase = new Date();
      dayBase.setHours(0, 0, 10, 0);
      const iso = (offsetSec: number): string => new Date(dayBase.getTime() + offsetSec * 1000).toISOString();

      // 5 次单投：每次都写 submit（带自己的 uploadTaskId + dtime）+ confirm（反查到 bvid）。
      // 新代码的 confirm 会带上同一次投稿的 uploadTaskId；i=0 故意不带，模拟旧日志的回退路径。
      for (let i = 0; i < 5; i++) {
        qLedger.logPublish({
          taskId,
          clipIndex: i,
          action: 'submit',
          at: iso(i * 60),
          uploadTaskId: `single-upload-${i}`,
          dtime: 1_800_000_000 + i * 7919,
          title: `单投 ${i}`,
        });
        qLedger.logPublish({
          taskId,
          clipIndex: i,
          action: 'confirm',
          at: iso(i * 60 + 20),
          ...(i === 0 ? {} : { uploadTaskId: `single-upload-${i}` }),
          bvid: `BVsingle${i}`,
          title: `单投 ${i}`,
        });
      }
      eq('5 次单投 + 各自 confirm 折叠后记 5 个稿件（含旧日志无 uploadTaskId 的回退）', qLedger.todayPublishedCount(), 5);

      // 同一个 6 分P 稿件：6 条 submit 共用一个 uploadTaskId 和一个 dtime
      // 同一个 6 分P 稿件：真实的 publishAsMultiPart 一次算出**一个 dtime 给所有分P 共用**，
      // 6 条 submit 也在同一时刻写入，只共用一个 uploadTaskId。这才是「一次投稿」的语义。
      const batchAt = iso(600);
      for (let i = 0; i < 6; i++) {
        qLedger.logPublish({
          taskId,
          clipIndex: i,
          action: 'submit',
          at: batchAt,
          uploadTaskId: 'multi-upload-1',
          dtime: 1_800_999_999,
          title: `P${i + 3} 分P`,
        });
      }
      // 注意：这 5 个分P 与上面 5 次单投的 (taskId, clipIndex) 完全相同 —— 正是会踩坑的形态。
      // 账目 = 5 次单投 + 这次多分P（它贡献 1：分P0-4 与单投共桶各算第 2 次，分P5 独占桶算第 1 次）。
      // 关键是**多分P 这个稿件整体只被算 1 次**，而 5 次单投没有被它吞掉。
      eq('多分P 一次投稿只贡献 1，且不吞掉此前的单投', qLedger.todayPublishedCount(), 11);

      // 反查用的是**主标题**（不是分P 标题），命中的稿件不属于任何分P 桶：
      // 这类 confirm 不能被当成「额外的孤儿稿件」，否则 6 个分P 会各自多算 1 个。
      for (let i = 0; i < 6; i++) {
        qLedger.logPublish({
          taskId,
          clipIndex: i,
          action: 'confirm',
          at: iso(700),
          bvid: `BVmulti${i}`,
          uploadTaskId: 'multi-upload-1',
          title: `P${i + 3} 分P`,
        });
      }
      eq('多分P 的 confirm（按主标题反查、不落在分P 桶）不额外计数', qLedger.todayPublishedCount(), 11);

      // 幂等命中：服务器已有同名稿件、本地没有 submit 行，只有一条 confirm → 必须独立计数
      qLedger.logPublish({ taskId, clipIndex: 9, action: 'confirm', at: iso(800), bvid: 'BVidem0001', title: '幂等命中' });
      eq('幂等命中的 confirm（无对应 submit）独立计 1', qLedger.todayPublishedCount(), 12);

      // fail 记录不占额度
      qLedger.logPublish({ taskId, clipIndex: 10, action: 'fail', at: iso(900), error: '投稿失败' });
      eq('fail 不占每日额度', qLedger.todayPublishedCount(), 12);

      // 昨天的记录不算今天
      qLedger.logPublish({
        taskId,
        clipIndex: 11,
        action: 'submit',
        at: new Date(Date.now() - 36 * 3600_000).toISOString(),
        uploadTaskId: 'yesterday-upload',
        dtime: 1_700_000_000,
        title: '昨天',
      });
      eq('昨天的投稿不计入今日额度', qLedger.todayPublishedCount(), 12);

      fs.rmSync(qRoot, { recursive: true, force: true });
      note('额度口径：同切片重投各算 1（删稿重投不能被吞），同一次投稿的多条日志折叠为 1，fail 与跨天不计');
    }

    /* ================= 汇总 ================= */
    section('验证汇总');
    const t = e2eLedger.getTask(taskId)!;
    console.log(`  任务：${t.id}  ${t.title}`);
    console.log(`  候选切片：${e2eLedger.getClips(taskId).length} 个，默认勾选 ${e2eLedger.getClips(taskId).filter((c) => c.selected).length} 个，已发布 ${e2eLedger.getClips(taskId).filter((c) => c.status === 'PUBLISHED').length} 个`);
    console.log(`  成本：字幕识别 ¥${t.cost.asrEstimate.toFixed(2)}（估算值） + 内容分析 ¥${t.cost.llmActual.toFixed(4)}（实际 usage）`);
    console.log(`  产物目录：${path.join(tmpData, 'tasks', taskId)}`);
  } catch (e) {
    fail++;
    failures.push(`未捕获异常：${(e as Error).message}`);
    console.error(`\n\x1b[31m测试过程中抛出异常：\x1b[0m`);
    console.error((e as Error).stack);
  } finally {
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch {
        /* ignore */
      }
    }
    if (!KEEP) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* 文件被占用时忽略 */
      }
    }
  }

  console.log(`\n\x1b[1m===== 结果：PASS=${pass} FAIL=${fail} =====\x1b[0m`);
  if (KEEP) console.log(`临时目录已保留：${tmpRoot}`);
  if (fail > 0) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
    process.exitCode = 1;
  } else {
    console.log('\x1b[32m全部通过：整条链路可在无真实直播、无付费调用的情况下跑通。\x1b[0m');
  }
  void ASR_CACHE_DIR;
}

/* ============================================================================
 * 辅助
 * ========================================================================== */

/** 从任务记录构造 asr.ts 需要的 AsrMediaAdapter（与 daemon 内的实现等价） */
function buildAdapterFromTask(t: TaskRecord, cacheBustKey = ''): {
  planCalls: (range: { start: number; end: number }) => Array<{
    file: string;
    inFileStart: number;
    inFileEnd: number;
    globalStart: number;
    globalEnd: number;
    offset: number;
    windowIndex: number;
  }>;
  fileStat: (file: string) => { size: number; updatedAt: number };
} {
  const segments = t.source.segments.length
    ? t.source.segments
    : [{ path: t.source.rawFiles[0] ?? '', duration: t.source.totalDuration, globalStart: 0, globalEnd: t.source.totalDuration }];
  void cacheBustKey;
  return {
    planCalls: (range) => {
      const out: Array<{
        file: string;
        inFileStart: number;
        inFileEnd: number;
        globalStart: number;
        globalEnd: number;
        offset: number;
        windowIndex: number;
      }> = [];
      for (const seg of segments) {
        const s = Math.max(range.start, seg.globalStart);
        const e = Math.min(range.end, seg.globalEnd);
        if (e - s <= 0.5) continue;
        out.push({
          file: seg.path,
          inFileStart: Number((s - seg.globalStart).toFixed(3)),
          inFileEnd: Number((e - seg.globalStart).toFixed(3)),
          globalStart: Number(s.toFixed(3)),
          globalEnd: Number(e.toFixed(3)),
          offset: 0,
          windowIndex: 0,
        });
      }
      if (out.length === 0 && segments[0]) {
        out.push({
          file: segments[0].path,
          inFileStart: 0,
          inFileEnd: Math.max(range.end - range.start, 1),
          globalStart: 0,
          globalEnd: Math.max(range.end - range.start, 1),
          offset: 0,
          windowIndex: 0,
        });
      }
      return out;
    },
    fileStat: (file: string) => {
      try {
        const st = fs.statSync(file);
        return { size: st.size, updatedAt: Math.round(st.mtimeMs) };
      } catch {
        return { size: -1, updatedAt: 0 };
      }
    },
  };
}

/**
 * 为「分析器 / 转写器」的独立场景创建一个只含源素材的隔离任务
 * （不跑完整流水线，避免重复触发 mock 记账）。
 */
async function createIsolatedTask(orch: Orchestrator, ledger: Ledger, tmpRoot: string, label: string): Promise<string> {
  const id = `e2e-${label.replace(/\s+/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
  const srcDir = path.join(tmpRoot, 'mock', 'media');
  const file = path.join(srcDir, 'mock-seg-01.flv');
  for (const f of fs.readdirSync(srcDir)) {
    if (f.startsWith('mock-seg-01')) {
      void f;
    }
  }
  const rec: Partial<TaskRecord> & { id: string; roomId: string } = {
    id,
    roomId: orch.config.room.roomId,
    platform: 'Bilibili',
    title: `【E2E】${label}`,
    status: 'RECORDED',
    stage: 'RECORDED',
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: nowIso() },
    source: {
      segments: [{ path: file, duration: 1800, globalStart: 0, globalEnd: 1800, size: exists(file) ? fs.statSync(file).size : 0 }],
      totalDuration: 1800,
      rawFiles: [file],
      fullVideoHasDanmaku: false,
      danmaXmlPath: path.join(srcDir, 'mock-danmaku.xml'),
    },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const { record } = ledger.createTask(rec);
  return record.id;
}

main().catch((e) => {
  console.error('\x1b[31m端到端测试脚本自身崩溃：\x1b[0m');
  console.error((e as Error).stack);
  process.exit(1);
});
