#!/usr/bin/env node
/**
 * CLI 入口（任务书 §8 WP6 步骤 2、步骤 10）。
 *
 * 用法：
 *   node src/cli.ts run                      常驻运行（轮询 + Web UI）
 *   node src/cli.ts run --dry-run            只到 clips.json + 摘要，不切片不投稿
 *   node src/cli.ts run --allow-paid         显式允许产生 ASR / LLM 费用
 *   node src/cli.ts run --room 12345678      覆盖目标直播间
 *   node src/cli.ts once                     跑一次检查就退出（适合计划任务）
 *   node src/cli.ts video <路径> [--danma <xml>] [--title <标题>]
 *                                            离线模式：直接对指定文件跑一遍
 *   node src/cli.ts replay <taskId> [--from-stage ANALYZED]
 *                                            从指定阶段重跑某一场
 *   node src/cli.ts inspect <taskId|reportId> 打印完整错误报告
 *   node src/cli.ts health                   打印健康快照
 *   node src/cli.ts selfcheck                只跑启动自检
 *   node src/cli.ts clean [--dry-run]        执行一次素材清理
 *   node src/cli.ts perf [--days 30]         拉取稿件表现数据
 *   node src/cli.ts probe                    等价于 node src/probe.ts
 *
 * 硬约束 #14：`--dry-run` 默认**不得调用付费 ASR/LLM**；必须显式 `--allow-paid` 才允许产生费用。
 */
import path from 'node:path';
import { Orchestrator, APP_VERSION } from './daemon.ts';
import { UiServer } from './server.ts';
import { listErrorReports, loadErrorReport, readErrorEvents, renderErrorTimeline, errorCountLastHours } from './errors.ts';
import { loadConfig } from './config.ts';
import { fmtBytes, fmtDuration, fmtLocal } from './util.ts';

/* ============================================================================
 * 参数解析
 * ========================================================================== */

interface ParsedArgs {
  cmd: string;
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(key, next);
          i++;
        } else {
          flags.set(key, true);
        }
      }
    } else {
      positional.push(a);
    }
  }
  const cmd = positional.shift() ?? 'help';
  return { cmd, positional, flags };
}

function flag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === 'true' || args.flags.get(name) === '1';
}

function opt(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

/* ============================================================================
 * 输出辅助
 * ========================================================================== */

/**
 * 控制台颜色。
 * 遵循 NO_COLOR 约定（https://no-color.org）：外部启动器把输出重定向到文件或
 * 自己的面板时，ANSI 转义码会以 `[1m` 这种形式混进日志，必须能关掉。
 */
const USE_COLOR = !process.env['NO_COLOR'] && process.env['TERM'] !== 'dumb';

const C = USE_COLOR
  ? {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[90m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      red: '\x1b[31m',
      cyan: '\x1b[36m',
    }
  : { reset: '', bold: '', dim: '', green: '', yellow: '', red: '', cyan: '' };

function title(t: string): void {
  console.log(`\n${C.bold}${t}${C.reset}`);
  console.log('─'.repeat(Math.max(20, Math.min(78, t.length * 2 + 8))));
}

function help(): void {
  console.log(`
${C.bold}直播切片助手 · CLI${C.reset}  v${APP_VERSION}

用法： node src/cli.ts <命令> [选项]

${C.bold}命令${C.reset}
  run                    常驻运行（轮询触发 + Web UI）
  once                   跑一次「检查 + 补漏对账」后退出
  video <路径>           离线模式：直接对指定视频跑完整链路
  replay <taskId>        从指定阶段重跑某一场
  inspect <id>           打印完整错误报告（taskId 或 reportId）
  health                 打印健康快照
  selfcheck              只跑启动自检
  clean                  执行一次素材清理
  perf                   拉取稿件表现数据（performance.jsonl）
  probe                  接口联调探测（等价于 node src/probe.ts）
  help                   显示本帮助

${C.bold}通用选项${C.reset}
  --dry-run              只到 clips.json + 摘要；不切片、不投稿
  --allow-paid           显式允许调用付费 ASR / LLM（默认不允许）
  --room <房间号>         覆盖目标直播间
  --from-stage <阶段>     RECORDED | TRANSCRIBED | ANALYZED | CLIPPED | PUBLISHED
  --danma <xml路径>       离线模式下的弹幕文件
  --title <标题>          离线模式下的标题
  --days <天数>           perf 命令的回流窗口，默认 30
  --no-ui                不启动 Web UI（只跑常驻轮询）
  --port <端口>           覆盖 Web UI 端口

${C.bold}示例${C.reset}
  node src/cli.ts run --dry-run
  node src/cli.ts video "D:\\rec\\sample.flv" --danma "D:\\rec\\sample.xml" --dry-run
  node src/cli.ts replay 20250922-2130-ab12cd34 --from-stage ANALYZED
  node src/cli.ts inspect 20250922-2130-ab12cd34
`);
}

/* ============================================================================
 * 命令实现
 * ========================================================================== */

function makeOrch(args: ParsedArgs): Orchestrator {
  const roomId = opt(args, 'room');
  const fromStageRaw = opt(args, 'from-stage');
  const validStages = ['IDLE', 'RECORDED', 'TRANSCRIBED', 'ANALYZED', 'CLIPPED', 'PUBLISHED'];
  if (fromStageRaw && !validStages.includes(fromStageRaw.toUpperCase())) {
    console.error(`--from-stage 必须是 ${validStages.join(' / ')} 之一`);
    process.exit(2);
  }
  return new Orchestrator({
    ...(roomId ? { roomId } : {}),
    dryRun: flag(args, 'dry-run'),
    allowPaid: flag(args, 'allow-paid'),
    ...(fromStageRaw ? { fromStage: fromStageRaw.toUpperCase() as never } : {}),
    // --local-asr：本次运行改走本地识别（不写配置、不产生云端费用）
    ...(flag(args, 'local-asr') ? { asrProvider: 'whisper-cpp' as const } : {}),
  });
}

/** 把启动器传进来的 --port 落到配置里（只影响本次运行，不写盘） */
function applyPortOverride(orch: Orchestrator, args: ParsedArgs): number {
  const p = opt(args, 'port');
  if (!p) return orch.config.ui.port;
  const n = Number(p);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`--port 必须是 1–65535 之间的整数，收到 "${p}"`);
    process.exit(2);
  }
  orch.config.ui.port = n;
  return n;
}

/** 打印启动自检结果；有硬错误时返回 false */
async function printSelfCheck(orch: Orchestrator): Promise<boolean> {
  title('启动自检');
  let results;
  try {
    results = await orch.selfCheck();
  } catch (e) {
    console.error(`${C.red}自检本身失败：${(e as Error).message}${C.reset}`);
    return false;
  }
  for (const r of results) {
    const mark = r.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`${mark} ${r.item}`);
    console.log(`    ${r.detail}`);
    if (r.fix) console.log(`    ${C.yellow}→ ${r.fix}${C.reset}`);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`\n${C.yellow}有 ${failed.length} 项未通过。多数情况下可以先修正再重跑；带 ✗ 的非阻塞项（如合集 ID、ffprobe）不阻止链路运行。${C.reset}`);
  } else {
    console.log(`\n${C.green}全部通过。${C.reset}`);
  }
  return failed.length === 0;
}

async function cmdRun(args: ParsedArgs): Promise<void> {
  const orch = makeOrch(args);
  title(`直播切片助手 v${APP_VERSION}`);
  const cfg = orch.config;
  console.log(`直播间    : ${cfg.room.roomId} (platform=${cfg.room.platform})`);
  console.log(`基础设施  : ${cfg.bililive.baseUrl}`);
  console.log(`发布模式  : ${cfg.publish.autoPublish ? '全自动（免确认）' : '半自动（需确认后发布）'}`);
  console.log(`可见性    : ${cfg.publish.isOnlySelf === 1 ? '仅自己可见（试跑期）' : '公开可见'}`);
  console.log(`运行模式  : ${flag(args, 'dry-run') ? 'dry-run（不切片不投稿）' : '正常运行'}${flag(args, 'allow-paid') ? ' + allow-paid（允许付费 AI）' : '（默认不调用付费 AI）'}`);

  const ok = await printSelfCheck(orch);
  if (!ok) {
    console.log(`\n${C.yellow}提示：自检未全部通过仍会继续启动；无法连通 biliLive-tools 时触发链路不会生效。${C.reset}`);
  }

  let ui: UiServer | undefined;
  if (!flag(args, 'no-ui') && cfg.ui.enabled) {
    try {
      const port = applyPortOverride(orch, args);
      ui = new UiServer({ orchestrator: orch, port, openBrowser: cfg.ui.openBrowser });
      await ui.start();
      console.log(`${C.cyan}Web UI   : ${ui.url}${C.reset}  （仅监听 ${cfg.ui.host}，带 CSRF 与 Origin 校验）`);
    } catch (e) {
      console.error(`${C.red}Web UI 启动失败：${(e as Error).message}${C.reset}`);
      const msg = (e as Error).message;
      if (/EADDRINUSE/i.test(msg)) {
        console.error(`端口 ${cfg.ui.port} 已被占用。换端口重试：node src/cli.ts run --port 3100`);
      }
      console.error('轮询链路不受影响，继续运行。');
    }
  }

  await orch.start({ polling: true });
  console.log(`\n${C.green}服务已启动，正在轮询录制历史（每 ${cfg.room.pollIntervalSec} 秒）。按 Ctrl+C 退出。${C.reset}\n`);

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`\n${C.dim}收到 ${sig}，正在停止…${C.reset}`);
    try {
      orch.stop();
      await ui?.stop();
    } catch {
      /* ignore */
    }
    console.log('已停止。');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function cmdOnce(args: ParsedArgs): Promise<void> {
  const orch = makeOrch(args);
  title('单次检查');
  const r = await orch.trigger.checkNow();
  console.log(`轮询触发 : ${r.polled.length} 场`);
  for (const d of r.polled) console.log(`  · ${d.reason}`);
  console.log(`对账触发 : ${r.reconciled.length} 场`);
  for (const d of r.reconciled) console.log(`  · ${d.reason}`);

  // 等队列跑完（once 的语义是「跑完再退出」）
  if (r.polled.length + r.reconciled.length > 0) {
    console.log('\n已入队，等待流水线跑完…');
    const deadline = Date.now() + 6 * 3600_000;
    while ((orch.isBusy || orch.queueLength > 0) && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 3000));
      const tasks = orch.ledger.listTasks({ limit: 5 });
      const t = tasks[0];
      if (t) process.stdout.write(`\r  ${t.id} ${t.status} ${t.progress ? `${t.progress.label} ${t.progress.current}/${t.progress.total}` : ''}          `);
    }
    process.stdout.write('\n');
  }
  orch.stop();
  console.log(`${C.green}完成。${C.reset}`);
}

async function cmdVideo(args: ParsedArgs): Promise<void> {
  const videoPath = args.positional[0];
  if (!videoPath) {
    console.error('用法：node src/cli.ts video <视频绝对路径> [--danma <xml>] [--title <标题>] [--dry-run]');
    process.exit(2);
  }
  const orch = makeOrch(args);
  title('离线模式：手动导入录播');
  const rec = await orch.importLocal({
    videoPath,
    ...(opt(args, 'danma') ? { danmaPath: opt(args, 'danma')! } : {}),
    ...(opt(args, 'title') ? { title: opt(args, 'title')! } : {}),
  });
  console.log(`任务 ID  : ${rec.id}`);
  console.log(`标题     : ${rec.title}`);
  console.log(`总时长   : ${fmtDuration(rec.source.totalDuration)}（${rec.source.segments.length} 个媒体文件）`);
  console.log('\n等待流水线跑完…（Ctrl+C 可中断；已完成的转写段会被复用，不会重复付费）');
  const deadline = Date.now() + 8 * 3600_000;
  let last = '';
  while ((orch.isBusy || orch.queueLength > 0) && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 3000));
    const t = orch.ledger.getTask(rec.id);
    const line = `${t?.status ?? '?'} ${t?.progress ? `${t.progress.label} ${t.progress.current}/${t.progress.total}` : ''}`;
    if (line !== last) {
      process.stdout.write(`\r  ${line}                     `);
      last = line;
    }
  }
  process.stdout.write('\n');
  const t = orch.ledger.getTask(rec.id)!;
  title('结果');
  console.log(`状态     : ${t.status}`);
  console.log(`阶段     : ${t.stage}`);
  console.log(`候选切片 : ${t.clips?.length ?? 0} 个（默认勾选 ${(t.clips ?? []).filter((c) => c.selected).length} 个）`);
  console.log(`成本     : 字幕识别 ¥${t.cost.asrEstimate.toFixed(2)}（估算值） + 内容分析 ¥${t.cost.llmActual.toFixed(4)}（实际）`);
  if (t.error) console.log(`${C.red}错误     : [${t.error.stage}] ${t.error.message}${C.reset}\n           报告：${t.error.reportId}（用 node src/cli.ts inspect ${t.error.reportId} 查看）`);
  console.log(`\n产物目录 : data/tasks/${t.id}/`);
  orch.stop();
}

async function cmdReplay(args: ParsedArgs): Promise<void> {
  const taskId = args.positional[0];
  if (!taskId) {
    console.error('用法：node src/cli.ts replay <taskId> [--from-stage ANALYZED]');
    process.exit(2);
  }
  const orch = makeOrch(args);
  const t = orch.ledger.getTask(taskId);
  if (!t) {
    console.error(`找不到任务 ${taskId}`);
    const list = orch.ledger.listTasks({ limit: 15 });
    console.error('最近的任务：');
    for (const x of list) console.error(`  ${x.id}  ${x.status.padEnd(12)} ${x.title}`);
    process.exit(1);
  }
  const from = (opt(args, 'from-stage')?.toUpperCase() ?? t.stage) as never;
  title(`重跑任务 ${taskId}（从 ${from} 阶段开始）`);
  console.log(`标题     : ${t.title}`);
  console.log(`当前状态 : ${t.status} / ${t.stage}`);
  orch.ledger.clearError(taskId);
  await orch.runPipeline(taskId, from);
  const after = orch.ledger.getTask(taskId)!;
  console.log(`\n重跑结束：${after.status}`);
  if (after.error) console.log(`${C.red}[${after.error.stage}] ${after.error.message}${C.reset}`);
  orch.stop();
}

async function cmdInspect(args: ParsedArgs): Promise<void> {
  const id = args.positional[0];
  const cfg = loadConfig().config;

  if (!id) {
    title('最近的错误事件（errors.jsonl）');
    const events = readErrorEvents({ limit: 30 });
    if (events.length === 0) {
      console.log('没有错误记录。');
    } else {
      for (const e of events) {
        console.log(`${fmtLocal(Date.parse(e.at))}  [${e.stage}] ${e.type}`);
        console.log(`    ${e.message}`);
        console.log(`    ${C.dim}报告：${e.reportId}${e.taskId ? `  任务：${e.taskId}` : ''}${C.reset}`);
      }
      console.log(`\n近 24 小时错误数：${errorCountLastHours(24)}`);
      console.log(`\n用 node src/cli.ts inspect <reportId 或 taskId> 查看完整报告。`);
    }
    console.log(`\n${C.dim}可用报告文件（最近 20 个）：${C.reset}`);
    for (const p of listErrorReports().slice(-20)) console.log(`  ${path.basename(p)}`);
    return;
  }

  // 先按 reportId 找；找不到再按 taskId 找最近一份
  let report = loadErrorReport(id);
  if (!report) {
    const reports = listErrorReports(id);
    if (reports.length) report = loadErrorReport(path.basename(reports[reports.length - 1]!, '.json'));
  }
  if (!report) {
    console.error(`找不到错误报告：${id}`);
    console.error('可用的报告（最近 20 个）：');
    for (const p of listErrorReports().slice(-20)) console.error(`  ${path.basename(p)}`);
    process.exit(1);
  }

  title(`错误报告 ${report.reportId}`);
  console.log(`${C.bold}上下文${C.reset}`);
  console.log(`  任务      : ${report.taskId ?? '(全局)'}${report.taskTitle ? ` · ${report.taskTitle}` : ''}`);
  console.log(`  失败阶段  : ${report.stage}`);
  console.log(`  时间      : ${fmtLocal(Date.parse(report.at))}`);
  console.log(`  服务版本  : ${report.appVersion}   biliLive-tools: ${report.bililiveToolsVersion ?? '未知'}`);

  console.log(`\n${C.bold}错误本体${C.reset}`);
  console.log(`  类型      : ${report.error.type}`);
  console.log(`  消息      : ${C.red}${report.error.message}${C.reset}`);
  if (report.error.stack) {
    console.log(`  堆栈      :`);
    for (const l of report.error.stack.split('\n').slice(0, 8)) console.log(`    ${C.dim}${l}${C.reset}`);
  }

  if (report.request) {
    console.log(`\n${C.bold}请求上下文（已脱敏）${C.reset}`);
    console.log(`  ${report.request.method} ${report.request.url}`);
    if (report.request.status) console.log(`  HTTP ${report.request.status}（${report.request.durationMs ?? '?'}ms）`);
    if (report.request.params !== undefined) console.log(`  参数 : ${JSON.stringify(report.request.params)}`);
    if (report.request.responseBody) {
      console.log(`  响应${report.request.responseTruncated ? `（已截断，原始 ${report.request.responseOriginalLength} 字符）` : ''}：`);
      console.log(`    ${report.request.responseBody.split('\n').slice(0, 10).join('\n    ')}`);
    }
  }

  if (report.retries.length) {
    console.log(`\n${C.bold}重试历史${C.reset}`);
    for (const r of report.retries) {
      console.log(`  第 ${r.attempt} 次  ${fmtLocal(Date.parse(r.at))}  [${r.type}]${r.model ? ` 模型=${r.model}` : ''}`);
      console.log(`    ${r.message}`);
    }
  }

  console.log(`\n${C.bold}时间线${C.reset}`);
  console.log(renderErrorTimeline(report));

  if (report.env.biliLiveToolsLogTail) {
    console.log(`\n${C.bold}biliLive-tools 侧日志片段（切片/压制失败的真因通常在这里）${C.reset}`);
    const lines = String(report.env.biliLiveToolsLogTail).split('\n').slice(-40);
    for (const l of lines) console.log(`  ${C.dim}${l}${C.reset}`);
  }

  console.log(`\n${C.bold}环境快照${C.reset}`);
  const env = report.env;
  console.log(`  磁盘剩余  : ${env.diskFreeGB !== undefined ? `${env.diskFreeGB.toFixed(1)} GB / 总 ${env.diskTotalGB?.toFixed(0)} GB` : '未知'}`);
  console.log(`  状态机    : ${env.taskStatus ?? '?'} / ${env.stage ?? '?'}`);
  console.log(`  Node      : ${env.nodeVersion ?? '?'}   平台: ${env.platform ?? '?'}`);
  console.log(`  工作目录  : ${env.cwd ?? '?'}`);
  if (env.ledgerEntries !== undefined) console.log(`  台账条目  : ${JSON.stringify(env.ledgerEntries)}`);
  console.log(`\n${C.dim}完整报告文件：${path.join(cfg.runtime.dataDir, '..', 'data', 'error-report', report.reportId + '.json')}${C.reset}`);
  console.log(`${C.green}报告已脱敏，可直接复制给开发者。${C.reset}`);
}

async function cmdHealth(args: ParsedArgs): Promise<void> {
  const orch = makeOrch(args);
  const h = await orch.health();
  title(`健康快照 v${h.version}`);
  const mark = (ok: boolean): string => (ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`);

  console.log(`${mark(h.bililive.ok)} biliLive-tools  ${h.bililive.version ?? '(未连接)'} @ ${h.bililive.baseUrl}`);
  console.log(`    ${h.bililive.message}`);
  if (h.account) {
    console.log(`${mark(!h.account.expired)} B站账号        ${h.account.name ?? h.account.uid} · ${h.account.message}`);
  }
  if (h.disk) {
    console.log(`${mark(!h.disk.low)} 磁盘           剩余 ${h.disk.freeGB.toFixed(1)} GB / 总 ${h.disk.totalGB.toFixed(0)} GB（阈值 ${h.disk.thresholdGB} GB）`);
  }
  /* dailyLimit=0 表示用户关闭了限额 —— 显示"不限额"，不要打成 "3 / 0" 那种像超额的样子 */
  const quotaOff = h.dailyLimit <= 0;
  console.log(
    quotaOff
      ? `${mark(true)} 今日投稿       ${h.todayPublished} 个（每日上限已关闭）`
      : `${mark(h.todayPublished < h.dailyLimit)} 今日投稿       ${h.todayPublished} / ${h.dailyLimit}`,
  );
  console.log(`${mark(h.errorsLast24h === 0)} 近 24h 错误    ${h.errorsLast24h}`);
  console.log(`${mark(!h.queue.paused)} 队列           ${h.queue.busy ? '处理中' : '空闲'}，排队 ${h.queue.length}${h.queue.paused ? '（磁盘守卫已暂停）' : ''}`);
  console.log(`  运行时长       ${(h.uptimeSec / 3600).toFixed(1)} 小时`);
  console.log(`\n${C.bold}模式${C.reset}`);
  console.log(`  发布           ${h.mode.autoPublish ? '全自动' : '半自动（需确认后发布）'}`);
  console.log(`  可见性         ${h.mode.isOnlySelf ? '仅自己可见' : `${C.yellow}公开可见${C.reset}`}`);
  console.log(`  付费保护       ${h.mode.dryRun ? `dry-run${h.mode.allowPaid ? ' + allow-paid' : '（不调用付费 AI）'}` : '正常运行'}`);
  console.log(`\n${C.bold}素材占用${C.reset}`);
  console.log(`  任务数         ${h.storage.tasks}`);
  console.log(`  原始分段       ${h.storage.rawGB.toFixed(2)} GB（可清理 ${h.storage.deletableRawGB.toFixed(2)} GB）`);
  console.log(`  压制产物       ${h.storage.fullVideoGB.toFixed(2)} GB（可清理 ${h.storage.deletableFullVideoGB.toFixed(2)} GB）`);
  console.log(`\n${C.bold}触发${C.reset}`);
  console.log(`  已处理录制     ${h.trigger.processedCount} 条，已触发场次 ${h.trigger.firedCount}`);
  if (h.trigger.lastReconcileAt) console.log(`  上次对账       ${fmtLocal(h.trigger.lastReconcileAt)}`);
  if (h.trigger.pending.length) {
    console.log(`  观察中：`);
    for (const p of h.trigger.pending) console.log(`    ${p.liveId} · ${p.reason}（自 ${fmtLocal(Date.parse(p.since))}）`);
  }
  orch.stop();
}

async function cmdSelfCheck(args: ParsedArgs): Promise<void> {
  const orch = makeOrch(args);
  const ok = await printSelfCheck(orch);
  orch.stop();
  if (!ok) process.exitCode = 1;
}

async function cmdClean(args: ParsedArgs): Promise<void> {
  const orch = makeOrch(args);
  const dryRun = flag(args, 'dry-run');
  title(`素材清理${dryRun ? '（dry-run，只报告不删除）' : ''}`);
  const r = await orch.cleaner.runOnce({ dryRun });
  if (r.disk) {
    console.log(`磁盘剩余 : ${r.disk.freeGB.toFixed(1)} GB（阈值 ${orch.config.cleanup.diskFloorGB} GB）${r.disk.low ? `  ${C.red}低于阈值${C.reset}` : ''}`);
  }
  for (const n of r.notes) console.log(`· ${n}`);
  if (r.actions.length) {
    console.log(`\n已删除：`);
    for (const a of r.actions) {
      console.log(`  ${a.taskId}  ${a.kind === 'raw' ? '原始分段' : '压制产物'}  ${a.files.length} 个文件  ${fmtBytes(a.freedBytes)}${a.ok ? '' : `  ${C.red}部分失败：${a.error}${C.reset}`}`);
    }
  }
  console.log(`\n共释放 ${fmtBytes(r.freedBytes)}${r.paused ? `  ${C.yellow}磁盘仍低于阈值，新任务处于暂停状态${C.reset}` : ''}`);
  orch.stop();
}

async function cmdPerf(args: ParsedArgs): Promise<void> {
  const orch = makeOrch(args);
  const days = Number(opt(args, 'days') ?? 30);
  title(`稿件表现数据回流（近 ${days} 天）`);
  const r = await orch.refreshPerformance({ days });
  console.log(`待拉取   : ${r.checked}`);
  console.log(`已更新   : ${r.updated}`);
  if (r.failed.length) {
    console.log(`${C.yellow}失败 ${r.failed.length} 个：${C.reset}`);
    for (const f of r.failed) console.log(`  ${f.bvid}: ${f.error}`);
  }
  for (const n of r.notes) console.log(`\n${n}`);
  orch.stop();
}

async function cmdProbe(args: ParsedArgs): Promise<void> {
  // 直接转发给 probe.ts，保持单一实现
  const { spawn } = await import('node:child_process');
  const passthrough: string[] = [];
  for (const [k, v] of args.flags) passthrough.push(v === true ? `--${k}` : `--${k}=${v}`);
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'probe.ts'), ...passthrough], { stdio: 'inherit' });
  await new Promise<void>((resolve) => child.on('exit', (code) => {
    process.exitCode = code ?? 0;
    resolve();
  }));
}

/* ============================================================================
 * 入口
 * ========================================================================== */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.cmd) {
    case 'run':
      return cmdRun(args);
    case 'once':
      return cmdOnce(args);
    case 'video':
      return cmdVideo(args);
    case 'replay':
      return cmdReplay(args);
    case 'inspect':
      return cmdInspect(args);
    case 'health':
      return cmdHealth(args);
    case 'selfcheck':
      return cmdSelfCheck(args);
    case 'clean':
      return cmdClean(args);
    case 'perf':
      return cmdPerf(args);
    case 'probe':
      return cmdProbe(args);
    case 'help':
    case '--help':
    case '-h':
      return help();
    default:
      console.error(`未知命令：${args.cmd}\n`);
      help();
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(`\n${C.red}命令执行失败：${(e as Error).message}${C.reset}`);
  if ((e as Error).stack) console.error(`${C.dim}${(e as Error).stack?.split('\n').slice(0, 6).join('\n')}${C.reset}`);
  process.exit(1);
});

void fmtBytes;
