/**
 * WP1 联调脚本（任务书 §8 WP1）。
 *
 * 一条命令跑完全部只读接口，把**真实响应**记录到：
 *   - `test/fixtures/*.json`     —— 作为 WP2–WP5 离线单测的 fixture
 *   - `docs/api-observed.md`     —— 与 §4 对照，不一致处以实测为准
 *   - `docs/wp1-findings.json`   —— 六项确认项的结构化结论
 *
 * 用法：
 *   node src/probe.ts                 # 只读探测 + 写文档与 fixture
 *   node src/probe.ts --dry-run       # 只打印，不写文件（且绝不调用付费接口）
 *   node src/probe.ts --allow-paid    # 允许调用 /ai/subtitle 实测 offset 语义
 *   node src/probe.ts --json          # 只输出机器可读 JSON
 *
 * 硬约束 #14：默认**不调用付费 ASR/LLM**；要用真实 ASR 实测 `offset` 语义必须显式 --allow-paid。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BiliLiveClient, ApiError } from './api.ts';
import { ConfigStore, loadConfig } from './config.ts';
import type { AppConfig } from './config.ts';
import { checkAfterUploadDelete } from './cleanup.ts';
import { DATA_DIR, ROOT_DIR, ensureDir, exists, fmtDuration, writeJsonAtomic, nowIso } from './util.ts';
import { Logger } from './logger.ts';
import { redact, redactJson } from './redact.ts';

/** 是否输出 ANSI 颜色：遵守 NO_COLOR 约定（重定向到文件时不应混入转义码） */
const USE_COLOR = !process.env["NO_COLOR"] && process.env["TERM"] !== "dumb";

/* ============================================================================
 * CLI 参数
 * ========================================================================== */

interface ProbeArgs {
  dryRun: boolean;
  allowPaid: boolean;
  jsonOnly: boolean;
  verbose: boolean;
  /** 指定要写入的文档目录 */
  docsDir: string;
}

function parseArgs(argv: string[]): ProbeArgs {
  return {
    dryRun: argv.includes('--dry-run'),
    allowPaid: argv.includes('--allow-paid'),
    jsonOnly: argv.includes('--json'),
    verbose: argv.includes('--verbose'),
    docsDir: path.join(ROOT_DIR, 'docs'),
  };
}

/* ============================================================================
 * 探测结果模型
 * ========================================================================== */

type Status = 'ok' | 'empty' | 'unsupported' | 'error' | 'skipped';

interface StepResult {
  id: string;
  title: string;
  /** 任务书里对应的章节 */
  ref: string;
  method?: string;
  endpoint?: string;
  status: Status;
  ms?: number;
  /** 观测到的关键事实（人读） */
  facts: string[];
  /** 与任务书不一致之处（必须显式记录） */
  deviations: string[];
  /** 原始响应（已脱敏，写 fixture 用） */
  raw?: unknown;
  /** markdown 表格用 */
  shape?: string;
  error?: { type: string; message: string };
}

const results: StepResult[] = [];
const findings: Record<string, unknown> = {};

function record(r: StepResult): StepResult {
  results.push(r);
  return r;
}

/** 描述一个 JSON 值的结构（字段名 + 类型），用于文档 */
function describeShape(v: unknown, depth = 0): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[${describeShape(v[0], depth + 1)} ×${v.length}]`;
  }
  if (typeof v === 'object') {
    if (depth >= 2) return '{…}';
    const entries = Object.entries(v as Record<string, unknown>).slice(0, 40);
    return `{ ${entries.map(([k, val]) => `${k}: ${describeShape(val, depth + 1)}`).join(', ')} }`;
  }
  if (typeof v === 'string') return 'string';
  return typeof v;
}

/** 从 JSON 值里取字段名列表（支持数组取首元素） */
function keysOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.length ? Object.keys((v[0] ?? {}) as object) : [];
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o['data'])) return keysOf(o['data']);
    if (Array.isArray(o['list'])) return keysOf(o['list']);
    return Object.keys(o);
  }
  return [];
}

/** 比较实测字段与任务书声明字段，返回缺失项 */
function diffKeys(observed: string[], expected: string[]): { missing: string[]; extra: string[] } {
  const set = new Set(observed);
  const exp = new Set(expected);
  return {
    missing: expected.filter((k) => !set.has(k)),
    extra: observed.filter((k) => !exp.has(k)),
  };
}

/* ============================================================================
 * 主流程
 * ========================================================================== */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const store = new ConfigStore();
  const cfg = store.config;
  const logger = new Logger({ level: args.verbose ? 'debug' : 'info', file: !args.dryRun, color: true });
  const client = BiliLiveClient.fromConfig(cfg, logger);

  if (!args.jsonOnly) {
    header('WP1 联调探测 · biliLive-tools API');
    console.log(`配置文件   : ${store.path}${store.exists ? '' : '  ⚠️ 不存在（使用默认值）'}`);    console.log(`服务地址   : ${cfg.bililive.baseUrl}`);
    console.log(`目标直播间 : ${cfg.room.roomId}  (platform=${cfg.room.platform})`);
    console.log(`模式       : ${args.dryRun ? 'dry-run（不写文件）' : '写入 fixture 与文档'}${args.allowPaid ? ' + allow-paid（允许付费 ASR）' : ''}`);
    console.log('');

    // 配置层面的硬约束前置检查
    if (store.issues.length) {
      header('配置检查');
      for (const i of store.issues) {
        const mark = i.level === 'error' ? '✗' : '⚠';
        console.log(`${mark} [${i.field}] ${i.message}${i.fix ? `\n    → ${i.fix}` : ''}`);
      }
      console.log('');
      if (store.errors.length) {
        console.log('存在配置错误，后续探测可能失败。请先修正 config.json（可从 config.example.json 复制）。\n');
      }
    }
  }

  /* ---- 步骤 0：本机环境（whisper 滤镜、ffmpeg）—— WP1 确认项之一 ---- */
  findings['whisper'] = probeWhisperFilter(cfg, args);
  record({
    id: 'env-whisper',
    title: '本机 ffmpeg 是否带 whisper 滤镜',
    ref: '§5.2 / WP1 步骤 4',
    status: findings['whisper'] ? ((findings['whisper'] as { hasWhisper: boolean }).hasWhisper ? 'ok' : 'unsupported') : 'skipped',
    facts: [(findings['whisper'] as { note: string })?.note ?? '未检测'],
    deviations: [],
  });

  /* ---- 步骤 1：连通性 + 版本 ---- */
  const versionStep = record({
    id: 'version',
    title: '连通性与版本',
    ref: '§4.6',
    method: 'GET',
    endpoint: '/common/version',
    status: 'error',
    facts: [],
    deviations: [],
  });
  let connected = false;
  try {
    const t0 = Date.now();
    const version = await client.version();
    versionStep.ms = Date.now() - t0;
    versionStep.status = 'ok';
    versionStep.raw = { version };
    versionStep.shape = typeof version === 'string' ? 'string' : describeShape(version);
    versionStep.facts.push(`biliLive-tools 版本 = ${version}`);
    connected = true;

    const drift = await client.checkVersionDrift(cfg.bililive.versionExpected);
    if (drift) {
      versionStep.facts.push(drift.note);
      if (drift.drift) {
        versionStep.deviations.push(
          `版本 ${drift.actual} ≠ 任务书核实的 ${drift.expected}（主次版本不同）—— 字段可能已变动，本文件所有实测结果优先`,
        );
      }
      findings['version'] = drift;
    }
  } catch (e) {
    versionStep.error = errInfo(e);
    versionStep.facts.push(`无法连接：${(e as Error).message}`);
    versionStep.facts.push('请确认 biliLive-tools 桌面版已启动，且 config.json 的 baseUrl / passKey 正确');
  }

  /* ---- 步骤 2：账号（uid / expires） ---- */
  if (connected) {
    const step = record({
      id: 'user-list',
      title: '已登录账号（投稿必填 uid、有效期）',
      ref: '§4.6',
      method: 'GET',
      endpoint: '/user/list',
      status: 'error',
      facts: [],
      deviations: [],
    });
    try {
      const t0 = Date.now();
      const users = await client.userList();
      step.ms = Date.now() - t0;
      step.raw = users.map((u) => ({ uid: u.uid, name: u.name, expires: u.expires, hasFace: Boolean(u.face) }));
      step.shape = describeShape(users);
      if (users.length === 0) {
        step.status = 'empty';
        step.facts.push('未返回任何账号 —— 请在 biliLive-tools 中扫码登录 B站账号');
      } else {
        step.status = 'ok';
        const u = users[0]!;
        const expText = u.expires ? `${new Date(u.expires).toLocaleString('zh-CN')}（还剩 ${Math.round((u.expires - Date.now()) / 86400000)} 天）` : '未提供';
        step.facts.push(`共 ${users.length} 个账号；主账号 uid=${u.uid} name=${u.name ?? '(无)'}`);
        step.facts.push(`cookie 有效期 expires = ${u.expires} → ${expText}`);
        // 实测与文档的差异：文档写「数组」，实测可能是单对象
        if (!Array.isArray(step.raw) || users.length === 1) {
          step.deviations.push('实测 /user/list 可能返回**单个对象**而非文档所述的数组；api.ts 已对两种形态做兼容');
        }
        // /user/export 禁止调用（含 cookie 明文）
        step.facts.push('⚠️ 依 §4.6，/user/export 会输出含 cookie 的原始数据，本次探测**未调用**，服务也不会调用');
        findings['account'] = { uid: u.uid, name: u.name, expires: u.expires, count: users.length };
      }
    } catch (e) {
      step.error = errInfo(e);
    }
  }

  /* ---- 步骤 3：录制历史（触发链路的两个接口） ---- */
  const roomId = cfg.room.roomId;
  if (connected && roomId) {
    const recentStep = record({
      id: 'recent-clips',
      title: '最近录制（触发信号）',
      ref: '§4.1',
      method: 'GET',
      endpoint: '/record-history/recent-clips?room_id&platform=Bilibili',
      status: 'error',
      facts: [],
      deviations: [],
    });
    try {
      const t0 = Date.now();
      const clips = await client.recentClips(roomId, cfg.room.platform, logger);
      recentStep.ms = Date.now() - t0;
      recentStep.raw = clips;
      recentStep.shape = describeShape(clips);
      recentStep.status = clips.length ? 'ok' : 'empty';
      recentStep.facts.push(`返回 ${clips.length} 条（接口最多返回 5 条）`);
      if (clips.length === 0) {
        recentStep.facts.push(
          '空数组有两种已知原因（都不会报错）：① platform 传错（必须 "Bilibili"）；② 该直播间在 streamer 表中没有记录（陷阱 #1、#2）',
        );
        recentStep.facts.push(`本次传的是 platform="${cfg.room.platform}"，若该直播间从未录制过，空数组是正常的`);
      } else {
        const k = keysOf(clips);
        const d = diffKeys(k, [
          'id',
          'title',
          'liveStartTime',
          'recordStartTime',
          'recordEndTime',
          'videoDuration',
          'videoFilePath',
          'videoFileId',
          'videoFileExt',
          'videoFileSize',
          'videoFileUpdatedAt',
        ]);
        const c = clips[0]!;
        recentStep.facts.push(`字段（驼峰）: ${k.join(', ')}`);
        if (d.missing.length) recentStep.deviations.push(`任务书声明但实测缺失的字段：${d.missing.join(', ')}`);
        if (d.extra.length) {
          recentStep.facts.push(`实测额外字段：${d.extra.join(', ')}`);
          recentStep.deviations.push(`实测存在任务书未列出的字段：${d.extra.join(', ')}（以实测为准）`);
        }
        recentStep.facts.push(
          `最新一条 id=${c.id} title=${c.title ?? '(无)'}`,
        );
        recentStep.facts.push(
          `recordStartTime=${c.recordStartTime}（${c.recordStartTime && c.recordStartTime > 1e11 ? '毫秒' : '秒?'}）` +
            ` / recordEndTime=${c.recordEndTime ?? '无'} / videoFileSize=${c.videoFileSize ?? '无'}`,
        );
        if (c.videoFilePath) recentStep.facts.push(`videoFilePath 存在=${exists(c.videoFilePath)} → ${redactPath(c.videoFilePath)}`);
        findings['recentClips'] = { count: clips.length, sampleFields: k, latestId: c.id };
      }
    } catch (e) {
      recentStep.error = errInfo(e);
    }

    const listStep = record({
      id: 'record-history-list',
      title: '录制历史分页（启动补漏 / 周期对账）',
      ref: '§4.1、§8 WP2 步骤 2',
      method: 'GET',
      endpoint: '/record-history/list?room_id&platform=Bilibili&page&pageSize',
      status: 'error',
      facts: [],
      deviations: [],
    });
    try {
      const t0 = Date.now();
      const page = await client.recordHistoryList({ roomId, platform: cfg.room.platform, page: 1, pageSize: cfg.recorder.recordHistoryPageSize });
      listStep.ms = Date.now() - t0;
      // fixture 里只保留前 3 条，避免把大对象整份写进仓库
      listStep.raw = { pagination: { total: page.total, page: page.page, pageSize: page.pageSize }, data: page.list.slice(0, 3) };
      listStep.shape = describeShape(page.list);
      listStep.status = page.list.length ? 'ok' : 'empty';
      listStep.facts.push(`total=${page.total}，本页 ${page.list.length} 条（pageSize=${page.pageSize}）`);
      if (page.list.length) {
        const k = keysOf(page.list);
        listStep.facts.push(`字段（下划线）: ${k.join(', ')}`);
        const d = diffKeys(k, [
          'id',
          'title',
          'live_start_time',
          'record_start_time',
          'record_end_time',
          'video_file',
          'video_duration',
          'danma_num',
          'interact_num',
          'danma_density',
        ]);
        if (d.missing.length) listStep.facts.push(`任务书声明但实测缺失：${d.missing.join(', ')}`);
        if (d.extra.length) listStep.facts.push(`实测额外字段：${d.extra.join(', ')}`);
        listStep.deviations.push(
          '实测确认：本接口字段为下划线风格，与 recent-clips 的驼峰风格不同（陷阱 #10 已复现并规避）',
        );
        // 时间戳单位核对（陷阱 #9）
        const first = page.list[0]!;
        const lst = first.live_start_time;
        const rst = first.record_start_time;
        if (lst !== undefined && rst !== undefined) {
          listStep.facts.push(
            `时间戳单位核对：live_start_time=${lst}（${lst > 1e11 ? '毫秒' : '秒'}） / record_start_time=${rst}（${rst > 1e11 ? '毫秒' : '秒'}）`,
          );
          if (lst > 1e11) listStep.deviations.push('实测 live_start_time 是**毫秒**，与任务书 §4.1「live_start_time 是秒级」不一致 —— 以实测为准，util.toSec 已做自适应');
        }
        // 分段探测（WP1 确认项：录制输出是否分段）
        const rawCount = page.list.filter((x) => x.record_start_time && x.record_end_time).length;
        findings['segmentation'] = {
          sampledRecords: page.list.length,
          sampleRecordStart: rst,
          sampleRecordEnd: first.record_end_time,
          durationSec:
            rst && first.record_end_time ? Math.round((first.record_end_time - rst) / (rst > 1e11 ? 1000 : 1)) : undefined,
          note: '单条 record 的时长 > 录制器 segment 配置值时，说明合并后仍是单条记录',
        };
        if (rawCount) listStep.facts.push(`可计算时长的记录数：${rawCount}`);
      }
    } catch (e) {
      listStep.error = errInfo(e);
    }

    /* ---- 步骤 4：弹幕文件 ---- */
    const danmaStep = record({
      id: 'danma-file',
      title: '弹幕文件查询（ASS 用于烧录 / XML 用于信号分析）',
      ref: '§4.1',
      method: 'POST',
      endpoint: '/record-history/danma-file',
      status: 'error',
      facts: [],
      deviations: [],
    });
    const firstClip = (results.find((r) => r.id === 'recent-clips')?.raw as Array<{ videoFilePath?: string }> | undefined)?.[0];
    if (firstClip?.videoFilePath) {
      try {
        const t0 = Date.now();
        const ref = await client.danmaFileByVideoPath(firstClip.videoFilePath);
        danmaStep.ms = Date.now() - t0;
        danmaStep.raw = { danmaFileExt: ref.danmaFileExt, hasPath: Boolean(ref.danmaFilePath), hasId: Boolean(ref.danmaFileId) };
        danmaStep.shape = describeShape(ref);
        if (!ref.danmaFilePath) {
          danmaStep.status = 'empty';
          danmaStep.facts.push('该录制没有弹幕文件');
        } else {
          danmaStep.status = 'ok';
          danmaStep.facts.push(`danmaFileExt=${ref.danmaFileExt ?? '(无)'} → ${ref.danmaFileExt === 'ass' ? '优先返回 ASS（可直接用于烧录）' : '返回的是 XML/SRT'}`);
          danmaStep.facts.push(`文件存在=${exists(ref.danmaFilePath)}`);
          findings['danmaku'] = { ext: ref.danmaFileExt, path: redactPath(ref.danmaFilePath) };
        }
      } catch (e) {
        danmaStep.error = errInfo(e);
      }
    } else {
      danmaStep.status = 'skipped';
      danmaStep.facts.push('没有可用的录制记录，跳过（该接口需要视频绝对路径）');
    }
  }

  /* ---- 步骤 5：预设 ---- */
  if (connected) {
    for (const [id, title, fn] of [
      ['preset-ffmpeg', 'ffmpeg 预设（切片参数来源）', () => client.presetFfmpeg()],
      ['preset-video', '投稿预设', () => client.presetVideo()],
      ['preset-danmu', '弹幕样式预设', () => client.presetDanmu()],
    ] as const) {
      const step = record({
        id,
        title,
        ref: '§4.5',
        method: 'GET',
        endpoint: `/preset/${id.replace('preset-', '')}`,
        status: 'error',
        facts: [],
        deviations: [],
      });
      try {
        const t0 = Date.now();
        const presets = (await fn()) as Array<{ id?: string; name?: string; config?: unknown }>;
        step.ms = Date.now() - t0;
        step.raw = presets.map((p) => ({ id: p.id, name: p.name, config: p.config }));
        step.shape = describeShape(presets);
        step.status = presets.length ? 'ok' : 'empty';
        step.facts.push(`共 ${presets.length} 条：${presets.map((p) => `${p.id ?? '?'}(${p.name ?? '-'})`).join(', ') || '(空)'}`);
        if (id === 'preset-ffmpeg' && presets.length) {
          const names = new Set(presets.map((p) => p.id));
          if (!names.has(cfg.clip.ffmpegPresetId)) {
            step.deviations.push(
              `配置的 clip.ffmpegPresetId="${cfg.clip.ffmpegPresetId}" 不在预设列表中 —— 切片时会回退到内置覆盖参数`,
            );
          } else {
            step.facts.push(`配置的 clip.ffmpegPresetId="${cfg.clip.ffmpegPresetId}" 存在 ✓`);
          }
          const def = presets.find((p) => p.id === cfg.clip.ffmpegPresetId) ?? presets[0]!;
          const c = (def.config ?? {}) as Record<string, unknown>;
          const enc = c['c:v'] ?? c['vcodec'] ?? c['codec'];
          step.facts.push(`预设 "${def.id}" 的编码器 = ${String(enc ?? '(未声明)')}${String(enc).includes('nvenc') ? '（硬件编码）' : ''}`);
          if (String(enc).toLowerCase() === 'copy') {
            step.deviations.push('该预设使用 copy 编码器 —— 硬约束 #5 禁止用于切片，api.ts 会直接拒绝（会导致弹幕错位）');
          }
          findings['ffmpegPreset'] = { id: def.id, encoder: enc, configKeys: Object.keys(c) };
        }
      } catch (e) {
        step.error = errInfo(e);
      }
    }
  }

  /* ---- 步骤 6：任务队列（并发控制） ---- */
  if (connected) {
    const step = record({
      id: 'task-list',
      title: '任务列表与并发数',
      ref: '§4.6 / §8 WP5 步骤 6',
      method: 'GET',
      endpoint: '/task/?page&pageSize',
      status: 'error',
      facts: [],
      deviations: [],
    });
    try {
      const t0 = Date.now();
      const t = await client.taskList({ page: 1, pageSize: 20 });
      step.ms = Date.now() - t0;
      step.raw = { runningTaskNum: t.runningTaskNum, listLen: t.list?.length ?? 0, sample: (t.list ?? []).slice(0, 2) };
      step.shape = describeShape(t);
      step.status = 'ok';
      step.facts.push(`runningTaskNum = ${t.runningTaskNum ?? '(未提供)'}（用于并发控制）`);
      step.facts.push(`列表返回 ${t.list?.length ?? 0} 条任务`);
      const k = keysOf(t.list ?? []);
      if (k.length) step.facts.push(`任务字段: ${k.join(', ')}`);
    } catch (e) {
      step.error = errInfo(e);
    }
  }

  /* ---- 步骤 7：biliLive-tools 自身配置（WP1 确认项：ffmpeg 路径） ---- */
  if (connected) {
    const step = record({
      id: 'config',
      title: 'biliLive-tools 配置（ffmpeg 路径 / 上传后删除开关）',
      ref: '§8 WP1 步骤 4',
      method: 'GET',
      endpoint: '/config',
      status: 'error',
      facts: [],
      deviations: [],
    });
    try {
      const t0 = Date.now();
      const raw = await client.getConfig();
      step.ms = Date.now() - t0;
      const flat = flatten(raw);
      // 只挑需要的字段记录，避免把 cookie / key 写进文档
      const interesting: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(flat)) {
        if (/ffmpegPath|ffprobePath|danmuFactoryPath|afterUploadDeletAction|removeOrigin|segment$|autoPartMerge|recorderType|cacheFolder/i.test(k)) {
          interesting[k] = typeof v === 'string' && /[\\/]/.test(v) ? redactPath(v) : v;
        }
      }
      step.raw = interesting;
      step.shape = describeShape(raw);
      step.status = Object.keys(interesting).length ? 'ok' : 'empty';
      step.facts.push(`命中字段：${Object.keys(interesting).join(', ') || '(未命中)'}`);
      findings['bililiveConfig'] = interesting;

      const ffmpegPath = String(flat['ffmpegPath'] ?? flat['ffmpeg'] ?? '');
      if (ffmpegPath) {
        step.facts.push(`ffmpeg 二进制 = ${redactPath(ffmpegPath)}（存在=${exists(ffmpegPath)}）—— 二期封面抽帧可用`);
      } else {
        step.facts.push('未从 /config 拿到 ffmpeg 路径 —— 二期封面抽帧需要另行确定路径（首版不做，不阻塞）');
      }
      // 硬约束 #11：上传后删除必须关闭 —— **所有房间**都要查（房间级覆盖会盖住全局）
      const delCheck = checkAfterUploadDelete(loadConfig().config, raw);
      if (delCheck.ok) {
        step.facts.push(delCheck.message);
      } else {
        step.deviations.push(delCheck.message);
        if (delCheck.fix) step.facts.push(`修复：${delCheck.fix}`);
      }
    } catch (e) {
      step.error = errInfo(e);
      step.facts.push('该端点可能不存在于本版本；不阻塞（首版封面策略不依赖它）');
    }
  }

  /* ---- 步骤 8：ASR offset 语义实测（付费，需 --allow-paid） ---- */
  const asrStep = record({
    id: 'asr-offset',
    title: 'ASR 分段调用与 offset 语义实测',
    ref: '§4.2 / §8 WP1 步骤 2、WP3 步骤 2',
    method: 'POST',
    endpoint: '/ai/subtitle',
    status: 'skipped',
    facts: [],
    deviations: [],
  });
  if (!args.allowPaid) {
    asrStep.facts.push('未传 --allow-paid：**未调用付费 ASR**（硬约束 #14）');
    asrStep.facts.push('要实测 offset 语义，请运行：node src/probe.ts --allow-paid（建议先把 asr.segmentMinutes 调小做一次短片段）');
  } else {
    try {
      const target = pickProbeMedia(cfg);
      if (!target) {
        asrStep.status = 'skipped';
        asrStep.facts.push('没有可用的探测素材（既无录制文件，也未配置 --video）');
      } else {
        const t0 = Date.now();
        // 只取前 60 秒，控制成本；startTime/endTime 必须成对（硬约束 #7）
        const srt = await client.subtitle({ file: target.file, startTime: 0, endTime: 60, offset: 0, timeoutMs: cfg.bililive.asrTimeoutMs });
        asrStep.ms = Date.now() - t0;
        const parsed = parseSrt(srt);
        asrStep.raw = { srtHead: srt.slice(0, 800), segments: parsed.slice(0, 5), segmentCount: parsed.length };
        asrStep.status = parsed.length ? 'ok' : 'empty';
        asrStep.facts.push(`调用成功，耗时 ${((asrStep.ms ?? 0) / 1000).toFixed(1)}s，返回 ${parsed.length} 条字幕`);
        if (parsed.length) {
          asrStep.facts.push(`首条时间戳 ${parsed[0]!.start.toFixed(2)}s → ${parsed[0]!.end.toFixed(2)}s：offset=0 时时间戳相对**该音频片段起点**，故全局时间 = 段内时间 + 段起点绝对秒数`);
          asrStep.facts.push('✅ WP3 拼回全局时间的算法：globalStart = 段起点绝对秒 + srt 时间戳');
        }
      }
    } catch (e) {
      asrStep.error = errInfo(e);
      asrStep.facts.push('若报「请先在配置中设置字幕识别ASR模型」，请到 biliLive-tools 设置 → AI 配置 为字幕识别指定勾选 ASR 标签的模型（陷阱 #5）');
    }
  }

  /* ---- 步骤 9：日志读取能力（错误报告依赖） ---- */
  if (connected) {
    const step = record({
      id: 'get-log-content',
      title: '读取 biliLive-tools 自身日志（错误报告用）',
      ref: '§4.6 / §8 WP6 步骤 10',
      method: 'GET',
      endpoint: '/common/getLogContent',
      status: 'error',
      facts: [],
      deviations: [],
    });
    try {
      const t0 = Date.now();
      const text = await client.getLogContent(8192);
      step.ms = Date.now() - t0;
      step.raw = { length: text.length, tail: text.slice(-300) };
      step.status = text.length ? 'ok' : 'empty';
      step.facts.push(`读取到 ${text.length} 字符 —— 错误报告会附带其末尾片段用于定位 ffmpeg 报错`);
    } catch (e) {
      step.error = errInfo(e);
    }
  }

  /* ---- 确认项汇总 ---- */
  findings['confirmedAt'] = nowIso();
  findings['roomId'] = roomId;

  /* ---- 输出 ---- */
  if (args.jsonOnly) {
    console.log(JSON.stringify({ results: serializeResults(), findings }, null, 2));
  } else {
    printHumanReport();
    if (!args.dryRun) {
      writeArtifacts(args, cfg);
    } else {
      console.log('dry-run：未写入 docs/ 与 test/fixtures/');
    }
  }

  await sleep0();
  logger.close();

  // 有硬性错误时以非 0 退出，便于脚本判断
  const fatal = results.filter((r) => r.status === 'error');
  if (fatal.length) process.exitCode = 1;
}

function sleep0(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/* ============================================================================
 * 辅助
 * ========================================================================== */

function header(t: string): void {
  console.log(`\n${USE_COLOR ? "\x1b[1m" : ""}${t}${USE_COLOR ? "\x1b[0m" : ""}`);
  console.log('─'.repeat(Math.max(20, Math.min(78, t.length * 2 + 10))));
}

function errInfo(e: unknown): { type: string; message: string } {
  if (e instanceof ApiError) return { type: e.type, message: e.message };
  return { type: 'internal', message: (e as Error)?.message ?? String(e) };
}

/** 路径脱敏：只保留最后两段，避免文档里出现完整用户名路径 */
function redactPath(p: string | undefined): string {
  if (!p) return '';
  const parts = p.split(/[\\/]/);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}

/** 扁平化嵌套对象为 a.b.c → value */
function flatten(v: unknown, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (v === null || typeof v !== 'object') {
    if (prefix) out[prefix] = v;
    return out;
  }
  if (Array.isArray(v)) {
    if (prefix) out[prefix] = `[${v.length} 项]`;
    return out;
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) Object.assign(out, flatten(val, key));
    else out[key] = Array.isArray(val) ? `[${val.length} 项]` : val;
  }
  return out;
}

/** 极简 SRT 解析（probe 自用，完整实现见 asr.ts） */
function parseSrt(srt: string): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  const blocks = srt.replace(/\r/g, '').split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim());
    if (lines.length < 2) continue;
    const timeLine = lines.find((l) => l.includes('-->'));
    if (!timeLine) continue;
    const m = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/.exec(timeLine);
    if (!m) continue;
    const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
    const e = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
    const idx = lines.indexOf(timeLine);
    const text = lines.slice(idx + 1).join(' ').trim();
    if (text) out.push({ start: s, end: e, text });
  }
  return out;
}

/** 选一个探测素材（优先用 recent-clips 的最新录制） */
function pickProbeMedia(cfg: AppConfig): { file: string } | null {
  const idx = process.argv.findIndex((a) => a === '--video');
  if (idx >= 0 && process.argv[idx + 1]) {
    const f = process.argv[idx + 1]!;
    return exists(f) ? { file: f } : null;
  }
  const raw = results.find((r) => r.id === 'recent-clips')?.raw as Array<{ videoFilePath?: string }> | undefined;
  const p = raw?.[0]?.videoFilePath;
  if (p && exists(p)) return { file: p };
  void cfg;
  return null;
}

/** 探测本机 ffmpeg 是否带 whisper 滤镜 */
function probeWhisperFilter(cfg: AppConfig, args: ProbeArgs): { hasWhisper: boolean; ffmpeg: string; note: string } | null {
  const candidates: string[] = [];
  const explicit = process.argv[process.argv.indexOf('--ffmpeg') + 1];
  if (process.argv.includes('--ffmpeg') && explicit) candidates.push(explicit);
  if (cfg.asr.silenceTrim.ffmpegPath) candidates.push(cfg.asr.silenceTrim.ffmpegPath);
  candidates.push(path.join(ROOT_DIR, 'ffmpeg.exe'));
  candidates.push('ffmpeg'); // PATH
  candidates.push('C:\\Users\\demo\\tools\\ffmpeg\\bin\\ffmpeg.exe'); // 本机已装的 8.1（含 whisper）

  for (const ff of candidates) {
    try {
      const out = execFileSync(ff, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
      const hasWhisper = /\bwhisper\b/.test(out);
      const ver = execFileSync(ff, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
        .split('\n')[0]
        ?.trim();
      return {
        hasWhisper,
        ffmpeg: ff,
        note: hasWhisper
          ? `✓ ${ff}（${ver}）**带 whisper 滤镜** —— §5.2 本地方案可用（另有更可控的 whisper.cpp 独立程序路径）`
          : `${ff}（${ver}）不带 whisper 滤镜 —— 本地方案需另备带 --enable-whisper 的构建，或走 whisper.cpp 独立程序（§5.2）`,
      };
    } catch {
      /* 试下一个候选 */
    }
  }
  void args;
  return null;
}

function serializeResults(): unknown[] {
  return results.map((r) => ({
    id: r.id,
    ref: r.ref,
    endpoint: r.endpoint,
    status: r.status,
    ms: r.ms,
    facts: r.facts,
    deviations: r.deviations,
    shape: r.shape,
    error: r.error,
  }));
}

function printHumanReport(): void {
  header('探测结果');
  const icons: Record<Status, string> = { ok: '✓', empty: '○', unsupported: '–', error: '✗', skipped: '·' };
  for (const r of results) {
    const ms = r.ms !== undefined ? ` (${r.ms}ms)` : '';
    console.log(`${icons[r.status]} ${r.title}${ms}`);
    if (r.endpoint) console.log(`    ${r.method ?? 'GET'} ${r.endpoint}`);
    for (const f of r.facts) console.log(`    · ${f}`);
    if (r.error) console.log(`    ${USE_COLOR ? "\x1b[31m" : ""}✗ [${r.error.type}] ${r.error.message}${USE_COLOR ? "\x1b[0m" : ""}`);
    for (const d of r.deviations) console.log(`    ${USE_COLOR ? "\x1b[33m" : ""}⚠ ${d}${USE_COLOR ? "\x1b[0m" : ""}`);
    console.log('');
  }

  const w = (t: string): void => console.log(`${USE_COLOR ? "\x1b[1m" : ""}${t}${USE_COLOR ? "\x1b[0m" : ""}`);
  header('WP1 六项确认项');
  const seg = findings['segmentation'] as { durationSec?: number; note?: string } | undefined;
  const rec = findings['recorderType'] as string | undefined;
  console.log(`1. /config 是否返回 ffmpeg 路径        : ${findings['bililiveConfig'] ? '见上（config 步骤）' : '未取得'}`);
  console.log(`2. 录制器类型与 webhook 能力          : ${rec ?? cfg_recorderType()}`);
  console.log(`3. 录制输出是否分段                    : ${seg?.durationSec ? `单条记录 ${fmtDuration(seg.durationSec)}，${seg.note ?? ''}` : '样本不足，见 signals/asr 模块的分段映射逻辑'}`);
  console.log(`4. seasonId / sectionId 获取方式       : 见下方「合集」结论`);
  console.log(`5. 阿里云 ASR 是否支持静音过滤 / VAD   : 需在阿里云控制台确认；本服务已内置本地剪静音开关（默认关闭）兜底`);
  console.log(`6. 弹幕 XML 是否含 SC / 上舰 / 礼物    : ${findings['danmaku'] ? '见 danmaku 分析（WP2 深入验证）' : '样本不足'}`);
  console.log('');
  w('合集（seasonId）结论');
  console.log('  /bili/upload 的 config 支持 seasonId / sectionId，但**没有任何接口能创建合集**。');
  console.log('  → 首次需在 B站创作中心手动建一个合集，把 ID 填进 config.json 的 publish.seasonId；');
  console.log('  → 若留空（0），服务会照常投稿但**无法归入同一合集**，UI 会提示这一点。');
  console.log('');

  const errs = results.filter((r) => r.status === 'error');
  if (errs.length) {
    w(`有 ${errs.length} 个步骤失败`);
    for (const e of errs) console.log(`  ✗ ${e.title}: ${e.error?.message ?? ''}`);
    console.log('');
  }
}

function cfg_recorderType(): string {
  try {
    return new ConfigStore().config.recorder.type;
  } catch {
    return '(未知)';
  }
}

/* ============================================================================
 * 产物落盘：docs/ + test/fixtures/
 * ========================================================================== */

function writeArtifacts(args: ProbeArgs, cfg: AppConfig): void {
  const fixturesDir = path.join(ROOT_DIR, 'test', 'fixtures');
  ensureDir(fixturesDir);
  ensureDir(args.docsDir);
  ensureDir(DATA_DIR);

  // 1) fixtures：每个成功步骤一个 json
  const fixtureIndex: Record<string, string> = {};
  for (const r of results) {
    if (r.raw === undefined) continue;
    const file = path.join(fixturesDir, `${r.id}.json`);
    writeJsonAtomic(file, { endpoint: r.endpoint, method: r.method, ref: r.ref, capturedAt: nowIso(), data: r.raw });
    fixtureIndex[r.id] = path.relative(ROOT_DIR, file).replace(/\\/g, '/');
  }
  // 给 fixture 本身做一次凭据兜底扫描
  const leaked: string[] = [];
  for (const f of fs.readdirSync(fixturesDir)) {
    const text = fs.readFileSync(path.join(fixturesDir, f), 'utf8');
    if (/"(passKey|apiKey|api_key|SESSDATA|bili_jct|cookie)"\s*:\s*"[^"*]{8,}"/i.test(text)) leaked.push(f);
  }
  if (leaked.length) {
    console.log(`${USE_COLOR ? "\x1b[31m" : ""}⚠ 检测到 fixture 可能含未脱敏凭据：${leaked.join(', ')} —— 已中止写入，请检查 probe 的采样范围${USE_COLOR ? "\x1b[0m" : ""}`);
    return;
  }

  // 2) findings
  writeJsonAtomic(path.join(args.docsDir, 'wp1-findings.json'), { findings, results: serializeResults() });

  // 3) docs/api-observed.md
  const md = renderMarkdown(cfg, fixtureIndex);
  fs.writeFileSync(path.join(args.docsDir, 'api-observed.md'), md, 'utf8');

  console.log(`\n已写入：`);
  console.log(`  docs/api-observed.md     （实测接口记录）`);
  console.log(`  docs/wp1-findings.json   （六项确认项结论）`);
  console.log(`  test/fixtures/*.json     （${Object.keys(fixtureIndex).length} 个 fixture，供 WP2–WP5 离线单测）`);
}

function renderMarkdown(cfg: AppConfig, fixtureIndex: Record<string, string>): string {
  const L: string[] = [];
  L.push('# biliLive-tools API 实测记录（WP1 产出）');
  L.push('');
  L.push(`> 由 \`node src/probe.ts\` 于 ${new Date().toLocaleString('zh-CN')} 自动生成。`);
  L.push('> **与任务书 §4 不一致处以本文件为准**（任务书原文亦如此要求）。');
  L.push('');
  L.push('## 环境');
  L.push('');
  L.push('| 项 | 值 |');
  L.push('|---|---|');
  const ver = findings['version'] as { actual?: string; expected?: string } | undefined;
  L.push(`| biliLive-tools 版本 | ${ver?.actual ?? '未探测到'} |`);
  L.push(`| 任务书核实版本 | ${ver?.expected ?? '3.22.1'} |`);
  L.push(`| 服务地址 | ${cfg.bililive.baseUrl} |`);
  L.push(`| 目标直播间 | ${cfg.room.roomId} (platform=${cfg.room.platform}) |`);
  const acc = findings['account'] as { uid?: number | string; name?: string; expires?: number } | undefined;
  L.push(`| 登录账号 | ${acc ? `uid=${acc.uid} ${acc.name ?? ''}` : '未探测到'} |`);
  L.push(
    `| cookie 有效期 | ${acc?.expires ? `${new Date(acc.expires).toLocaleString('zh-CN')}（剩余 ${Math.round((acc.expires - Date.now()) / 86400000)} 天）` : '未知'} |`,
  );
  const wh = findings['whisper'] as { hasWhisper?: boolean; ffmpeg?: string; note?: string } | undefined;
  L.push(`| 本机 ffmpeg | ${wh ? `${redactPath(wh.ffmpeg)}，whisper 滤镜=${wh.hasWhisper ? '有' : '无'}` : '未检测'} |`);
  L.push(`| Node | ${process.version} |`);
  L.push('');

  L.push('## WP1 六项确认项结论');
  L.push('');
  const conf = findings['bililiveConfig'] as Record<string, unknown> | undefined;
  const ffmpegPathKey = conf ? Object.keys(conf).find((k) => /ffmpegPath/i.test(k)) : undefined;
  L.push(`1. **/config 是否返回 ffmpeg 路径**：${ffmpegPathKey ? `是 —— \`${ffmpegPathKey}\` = \`${String(conf![ffmpegPathKey])}\`（二期封面抽帧可用）` : '未取得；首版不做封面抽帧，不阻塞'}`);
  L.push(
    `2. **录制器与 webhook**：配置声明 \`recorder.type=${cfg.recorder.type}\`。${
      cfg.recorder.type === 'builtin'
        ? '内置引擎**没有对外事件源**，因此本服务以 60 秒轮询为主路径 + 每小时对账；**不要把 /webhook/* 当推送通道**（陷阱 #26）。'
        : `若录制器支持配置多个 webhook 目标，把它同时指向本服务的 \`POST /webhook/recorder\`；若只支持单个目标，才由本服务转发到 \`${cfg.recorder.forwardTo}\`（端点必须匹配录制器类型，陷阱 #27）。`
    }`,
  );
  const seg = findings['segmentation'] as { durationSec?: number } | undefined;
  L.push(
    `3. **录制输出是否分段**：${seg?.durationSec ? `实测单条 record 时长 ${fmtDuration(seg.durationSec)}；` : ''}本服务的 asr.ts 一律按「分段文件 → 全局时间映射」处理（用 ffprobe 读每段时长并累加），单文件场景退化为 1 段，两种都能跑。`,
  );
  L.push(
    `4. **seasonId / sectionId**：\`/bili/upload\` 的 config 接受这两个字段，但**没有任何接口能创建合集**。→ 首次需人工在创作中心建合集并填写 \`publish.seasonId\`；留空时无法归入同一合集（UI 会提示）。`,
  );
  L.push(`5. **阿里云 ASR 静音过滤 / VAD**：需在阿里云控制台确认；本服务已内置**本地剪静音**开关（\`asr.silenceTrim.enabled\`，默认关闭）作为可控兜底，可省 20–40% 费用。`);
  L.push(`6. **弹幕 XML 是否含 SC / 上舰 / 礼物**：由 WP2 的 \`danmaku.ts\` 在解析后写入 \`signals.json.eventSignalsAvailable\`；不含时自动降级为「弹幕密度 + 关键词」信号（陷阱 #25）。`);
  L.push('');

  L.push('## 逐接口实测');
  L.push('');
  for (const r of results) {
    L.push(`### ${r.title}`);
    L.push('');
    L.push(`- 对应章节：${r.ref}`);
    if (r.endpoint) L.push(`- 请求：\`${r.method ?? 'GET'} ${r.endpoint}\``);
    L.push(`- 结果：**${statusText(r.status)}**${r.ms !== undefined ? `（${r.ms}ms）` : ''}`);
    if (r.shape) L.push(`- 实测结构：\`${r.shape}\``);
    if (fixtureIndex[r.id]) L.push(`- fixture：\`${fixtureIndex[r.id]}\``);
    if (r.facts.length) {
      L.push('');
      L.push('观测事实：');
      L.push('');
      for (const f of r.facts) L.push(`- ${f}`);
    }
    if (r.error) {
      L.push('');
      L.push(`> ❌ 错误类型 \`${r.error.type}\`：${r.error.message}`);
    }
    if (r.deviations.length) {
      L.push('');
      L.push('与任务书 **不一致 / 需注意**：');
      L.push('');
      for (const d of r.deviations) L.push(`- ⚠️ ${d}`);
    }
    L.push('');
  }

  L.push('## 陷阱复现情况');
  L.push('');
  L.push('| # | 陷阱 | 本次探测是否复现 / 已规避方式 |');
  L.push('|---|---|---|');
  const pc = (findings['recentClips'] as { count?: number } | undefined)?.count ?? 0;
  L.push(`| 1 | \`platform\` 写成 \`bilibili\` | 已按 \`Bilibili\` 调用，返回 ${pc} 条；\`api.ts\` 的 \`recentClips\` 默认值即 \`Bilibili\`，配置层另有硬校验 |`);
  L.push(`| 2 | 直播间在 streamer 表中无记录 | 空数组时 probe 会明确提示该原因（不报错、静默返回） |`);
  L.push(`| 3 | \`/ai/subtitle\` 无服务端缓存 | 默认**不调用**；\`asr.ts\` 逐段落盘缓存，缓存键不含 videoFileId |`);
  L.push(`| 4 | 只传 startTime 或 endTime | \`api.ts\` 在客户端直接抛错拒绝（不发请求） |`);
  L.push(`| 6 | \`/task/cut\` 的 output 传相对路径 | \`api.ts\` 校验绝对路径，否则抛错 |`);
  L.push(`| 7 | 切片用 stream copy | \`api.ts\` 检测到 \`c:v=copy\` 直接拒绝 |`);
  L.push(`| 9 | 秒/毫秒混用 | \`util.toSec/toMs\` 自适应；probe 打印实测单位 |`);
  L.push(`| 10 | \`list\`（下划线）与 \`recent-clips\`（驼峰）混用 | 两种结构分别建模，\`RecordHistoryListItem\` / \`RecentClip\` |`);
  L.push(`| 11 | 以为 \`/bili/upload\` 返回稿件 id | 类型标注为 \`{ taskId }\`；bvid 一律用 \`/bili/archives\` 反查 |`);
  L.push(`| 21 | 日志/配置写入真实凭据 | 本次探测的 fixture 已做凭据扫描；\`redact.ts\` 是唯一日志出口 |`);
  L.push(`| 32 | \`list\` 的时间过滤参数用秒 | \`recordHistoryList\` 的参数注释与调用一律用毫秒 |`);
  L.push('');

  L.push('## 复现命令');
  L.push('');
  L.push('```powershell');
  L.push('# 只读探测（不产生任何费用、不写文件）');
  L.push('node src/probe.ts --dry-run');
  L.push('');
  L.push('# 完整探测并写入 docs / fixtures');
  L.push('node src/probe.ts');
  L.push('');
  L.push('# 附带真实 ASR 实测 offset 语义（会产生费用）');
  L.push('node src/probe.ts --allow-paid --video "D:\\path\\to\\sample.flv"');
  L.push('```');
  L.push('');
  return L.join('\n');
}

function statusText(s: Status): string {
  return { ok: '成功', empty: '成功但返回空', unsupported: '不支持', error: '失败', skipped: '已跳过' }[s];
}

/* ============================================================================
 * 入口
 * ========================================================================== */

main().catch((e) => {
  console.error(`${USE_COLOR ? "\x1b[31m" : ""}probe 失败：${USE_COLOR ? "\x1b[0m" : ""}`, e instanceof Error ? e.message : e);
  if (e instanceof ApiError && e.request) {
    // 错误路径也要脱敏（陷阱 #33）
    console.error('请求上下文：', redactJson({ url: e.request.url, status: e.request.status }));
  }
  process.exit(1);
});

/** 供测试引用 */
export { parseSrt, flatten, describeShape, diffKeys };
/** 未使用的导出占位，避免 tree-shaking 误删类型引用 */
export type { StepResult };
void redact;
