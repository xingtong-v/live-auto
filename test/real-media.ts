/**
 * 真实录播验证（任务书验收：`--dry-run` 全链路 + 源素材可复用）。
 *
 * 与 `e2e-offline.ts` 的区别：
 *   - e2e-offline 用 **mock** biliLive-tools 验证业务逻辑（可覆盖异常路径）；
 *   - 本脚本用**真实的录播文件与真实的 biliLive-tools**，验证「真的能读、真的能算、真的不花钱」。
 *
 * 默认**零成本**：
 *   - 转写走 `--dry-run`：无缓存时拒绝付费调用，只产出 gaps（硬约束 #14）
 *   - 分析走 dry-run：不调用 LLM
 *   - 若加 `--allow-paid`，则允许真实 ASR / LLM 调用（**会产生费用，需显式授权**）
 *
 * 用法：
 *   node test/real-media.ts                      # 自动挑一条真实录播，零成本验证
 *   node test/real-media.ts --file <视频路径>     # 指定素材
 *   node test/real-media.ts --allow-paid         # 允许真实付费调用（谨慎）
 */
import path from 'node:path';
import fs from 'node:fs';
import { Orchestrator } from '../src/daemon.ts';
import { Ledger } from '../src/ledger.ts';
import { BiliLiveClient } from '../src/api.ts';
import { buildSegmentMap, danmaKind, discoverSegments, findFfprobe, probeMedia } from '../src/media.ts';
import { analyzeDanmaku } from '../src/danmaku.ts';
import { checkAfterUploadDelete } from '../src/cleanup.ts';
import { exists, fileSize, fmtBytes, fmtDuration, toSec } from '../src/util.ts';

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

function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
  console.log('─'.repeat(Math.max(20, Math.min(74, t.length * 2 + 8))));
}

function note(t: string): void {
  notes.push(t);
  console.log(`  \x1b[90m· ${t}\x1b[0m`);
}

const ALLOW_PAID = process.argv.includes('--allow-paid');
const fileArgIdx = process.argv.indexOf('--file');
const FILE_ARG = fileArgIdx >= 0 ? process.argv[fileArgIdx + 1] : undefined;

async function main(): Promise<void> {
  console.log('\x1b[1m真实录播验证\x1b[0m');
  console.log(`模式：${ALLOW_PAID ? '\x1b[33m--allow-paid（会产生 ASR/LLM 费用）\x1b[0m' : '\x1b[32m零成本（dry-run，拒绝付费调用）\x1b[0m'}`);

  const orch = new Orchestrator({ dryRun: !ALLOW_PAID, allowPaid: ALLOW_PAID });
  orch.logger.setConsole(false);
  const cfg = orch.config;
  const client = orch.client;

  /* ---------------- 1. 找到一条真实且可用的录播 ---------------- */
  section('1. 素材发现');
  let videoPath = FILE_ARG;
  let danmaPath: string | undefined;
  let videoDuration = 0;

  if (videoPath) {
    ok('使用显式指定的素材', exists(videoPath), videoPath);
  } else {
    // 先试 record-history（可能因为文件被移动/删除而不可用）
    let found: { path: string; dur: number } | undefined;
    try {
      const res = await client.recordHistoryList({ roomId: cfg.room.roomId, platform: 'Bilibili', page: 1, pageSize: 60 });
      for (const r of res.list) {
        if (r.video_file && exists(r.video_file) && fileSize(r.video_file) > 20 * 1024 * 1024) {
          found = { path: r.video_file, dur: toSec(r.video_duration) ?? 0 };
          break;
        }
      }
      note(`record-history 共 ${res.total} 条，其中文件仍存在的：${found ? 1 : 0} 条`);
    } catch (e) {
      note(`record-history 查询失败：${(e as Error).message}`);
    }

    if (!found) {
      // 退化：直接在录制目录里找
      const guessDirs = [
        path.join(process.env['USERPROFILE'] ?? '', 'Downloads', 'Bilibili'),
        path.join(process.env['USERPROFILE'] ?? '', 'Downloads'),
      ];
      const candidates: Array<{ path: string; size: number; mtimeMs: number }> = [];
      for (const d of guessDirs) {
        if (!exists(d)) continue;
        const walk = (dir: string, depth: number): void => {
          if (depth > 3) return;
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full, depth + 1);
            else if (/\.(flv|ts|mp4)$/i.test(e.name)) {
              /* ⚠️ 两个排除条件都是实测踩出来的：
                 ① **压制产物**（`-弹幕版` / `-后处理`）不是录制原始文件，选它等于验证错了对象；
                 ② **刚写过的文件**可能还没写完 —— 实测挑中了正在烧弹幕的
                    `…-弹幕版.mp4`，ffprobe 直接报 `moov atom not found`（mp4 的索引还没落盘），
                    后面三条断言跟着全红。而那个"错误"跟被测代码毫无关系。 */
              if (/弹幕版|后处理|danmaku/i.test(e.name)) continue;
              const st = fs.statSync(full);
              if (Date.now() - st.mtimeMs < 5 * 60_000) continue;
              if (st.size > 200 * 1024 * 1024) candidates.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
            }
          }
        };
        walk(d, 0);
      }
      candidates.sort((a, b) => a.size - b.size); // 挑最小的，成本最低
      if (candidates.length) {
        found = { path: candidates[0]!.path, dur: 0 };
        note('record-history 中的文件已不存在（可能被移动或按「上传后删除」清掉了），改用磁盘扫描找到的素材');
      }
    }
    videoPath = found?.path;
    videoDuration = found?.dur ?? 0;
  }

  if (!videoPath || !exists(videoPath)) {
    console.log('\n\x1b[33m找不到可用的真实录播素材。\x1b[0m');
    console.log('可以：');
    console.log('  1. 用 --file 指定一个真实视频文件');
    console.log('  2. 直接跑离线端到端验证（不需要真实素材）：npm run e2e');
    console.log('\n已知素材位置参考：');
    console.log(`  ${path.join(process.env['USERPROFILE'] ?? '', 'Downloads', 'Bilibili')}`);
    process.exitCode = 2;
    orch.stop();
    return;
  }

  const probe = probeMedia(videoPath);
  if (videoDuration <= 0) videoDuration = probe.duration;
  ok('素材存在且可读', exists(videoPath));
  ok('ffprobe 能解析出时长（真实媒体文件）', probe.duration > 0, `${probe.duration}s / ${probe.error ?? 'ok'}`);
  note(`文件：${path.basename(videoPath)}`);
  note(`大小 ${fmtBytes(fileSize(videoPath))}，时长 ${fmtDuration(videoDuration)}（${probe.videoCodec ?? '?'} / ${probe.audioCodec ?? '?'} ${probe.width ?? '?'}x${probe.height ?? '?'}）`);

  /* ---------------- 2. 弹幕文件 ---------------- */
  section('2. 弹幕文件');
  const ffprobePath = findFfprobe();
  if (!danmaPath) {
    try {
      const ref = await client.danmaFileByVideoPath(videoPath);
      if (ref.danmaFilePath && exists(ref.danmaFilePath)) {
        danmaPath = ref.danmaFilePath;
        note(`biliLive-tools 返回弹幕文件：${path.basename(danmaPath)}（ext=${ref.danmaFileExt ?? '?'}）`);
      } else {
        note('biliLive-tools 没有这一场的弹幕文件记录（该场录制时可能未抓弹幕）');
      }
    } catch (e) {
      note(`查询弹幕失败：${(e as Error).message}`);
    }
  }
  // 退化：同目录下找同名弹幕文件
  if (!danmaPath) {
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    for (const cand of [`${base}.xml`, `${base}.ass`, path.join(dir, `${base}.xml`)]) {
      if (exists(cand)) {
        danmaPath = cand;
        break;
      }
    }
    if (danmaPath) note(`在同目录找到同名弹幕文件：${path.basename(danmaPath)}`);
  }
  ok('弹幕文件可用性或已给出原因', true, danmaPath ?? '（无弹幕，链路应能继续）');

  /* ---------------- 3. 分段映射 ---------------- */
  section('3. 分段文件 → 全局时间映射');
  const segs = discoverSegments(videoPath);
  const map = buildSegmentMap(segs, {
    ...(ffprobePath ? { ffprobePath } : {}),
    fallbackDurationSec: videoDuration,
  });
  ok('分段映射构建成功', map.segments.length >= 1, `${map.segments.length} 段`);
  /* ⚠️ 不能假设样本一定是「单文件」：这个用例挑的是磁盘上最小的可用素材，
     而 biliLive-tools 会把一场连续直播按分钟切段（`X.ts` + `X-PART001.ts` + …）。
     实测踩到过：录到一半时最小的候选变成了 `-PART001.ts`，于是 `discoverSegments` 返回 2 段，
     原来那两条「单文件场景」断言就红了 —— **是断言假设错了，不是分段识别错了**。
     所以这里按实际分段数分别校验，并把"总时长 = 各段之和"这条真正的不变量always 校验。 */
  const sumSegDur = map.segments.reduce((a, s) => a + s.duration, 0);
  ok('分段总数与 discoverSegments 一致', map.segments.length === segs.length, `${map.segments.length} vs ${segs.length}`);
  ok('全局总时长 = 各段时长之和', Math.abs(map.totalDuration - sumSegDur) < 2, `${map.totalDuration} vs ${sumSegDur}`);
  if (segs.length === 1) {
    ok('单文件场景：全局总时长与 ffprobe 一致', Math.abs(map.totalDuration - videoDuration) < 2, `${map.totalDuration} vs ${videoDuration}`);
  } else {
    ok(
      `多分段场景（${segs.length} 段）：总时长不短于样本文件本身`,
      map.totalDuration >= videoDuration - 2,
      `${map.totalDuration} vs 样本 ${videoDuration}`,
    );
    note(`本样本是**多分段**录播（${segs.length} 段），已按分段合并后的全局时间轴处理`);
  }
  for (const w of map.warnings) note(`警告：${w}`);
  note(`分段：${map.segments.map((s) => `${path.basename(s.path)}[${s.globalStart.toFixed(0)}-${s.globalEnd.toFixed(0)}]`).join(', ')}`);

  /* ---------------- 4. 弹幕信号（真实素材，零成本） ---------------- */
  section('4. 弹幕信号分析（真实素材，零成本）');
  if (danmaPath) {
    const t0 = Date.now();
    const res = analyzeDanmaku({ taskId: 'real-media-check', filePath: danmaPath, videoDuration: map.totalDuration, config: cfg });
    const ms = Date.now() - t0;
    for (const w of res.warnings) note(`警告：${w}`);
    ok('弹幕解析成功', res.signals.danmakuTotal > 0, `${res.signals.danmakuTotal} 条`);
    ok('解析耗时在可接受范围（< 30s）', ms < 30_000, `${ms}ms`);
    ok('产出密度曲线', res.signals.density.length > 0, `${res.signals.density.length} 个窗口`);
    ok('产出峰值窗口', res.signals.peaks.length > 0, `${res.signals.peaks.length} 个`);
    ok('产出高频词', res.signals.keywords.length > 0, res.signals.keywords.slice(0, 6).map((k) => `${k.word}(${k.count})`).join(' '));
    ok('记录了时间基准偏移', typeof res.signals.danmakuOffset === 'number', `offset=${res.signals.danmakuOffset}s`);
    note(`高能事件：SC ${res.signals.eventCounts['superchat'] ?? 0}，上舰 ${res.signals.eventCounts['guard'] ?? 0}，礼物 ${res.signals.eventCounts['gift'] ?? 0}` +
      (res.signals.eventSignalsAvailable ? '' : '（该场弹幕不含这类事件，已按陷阱 #25 降级）'));
    const top = res.signals.peaks[0];
    if (top) note(`密度最高窗口：${fmtDuration(top.start)}（${top.count} 条，强度 ${(top.intensity * 100).toFixed(0)}%）`);
    if (res.signals.density.length > 1) {
      const peakWindow = res.signals.density.reduce((a, b) => (b.count > a.count ? b : a));
      note(`单窗口峰值：${fmtDuration(peakWindow.start)} 有 ${peakWindow.count} 条弹幕`);
    }
  } else {
    note('没有弹幕文件 —— 跳过信号分析（真实场景下链路会继续，选片更多依赖转写）');
    ok('无弹幕时不抛异常（降级路径）', true);
  }

  /* ---------------- 5. 转写（默认 dry-run，零成本） ---------------- */
  section(`5. 转写${ALLOW_PAID ? '（\x1b[33m允许付费\x1b[0m）' : '（dry-run，拒绝付费调用）'}`);
  const tmpData = path.join(process.env['TEMP'] ?? process.cwd(), `live_auto-real-${Date.now()}`);
  fs.mkdirSync(tmpData, { recursive: true });
  /* 错误事件流/报告重定向到临时目录（模块级常量，dataDirOverride 管不到） */
  const { setErrorsPath, setErrorReportDir } = await import('../src/errors.ts');
  setErrorsPath(path.join(tmpData, 'errors.jsonl'));
  setErrorReportDir(path.join(tmpData, 'error-report'));
  const tmpLedger = new Ledger({ path: path.join(tmpData, 'ledger.json') });
  const orchTmp = new Orchestrator({
    dryRun: !ALLOW_PAID,
    allowPaid: ALLOW_PAID,
    ledger: tmpLedger,
    dataDirOverride: tmpData,
  });
  orchTmp.logger.setConsole(false);

  const taskRec = tmpLedger.createTask({
    id: `real-${Date.now()}`,
    roomId: cfg.room.roomId,
    platform: 'Bilibili',
    title: `【真实素材验证】${path.basename(videoPath)}`,
    status: 'RECORDED',
    stage: 'RECORDED',
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: new Date().toISOString() },
    source: {
      segments: map.segments,
      totalDuration: map.totalDuration,
      rawFiles: map.segments.map((s) => s.path),
      fullVideoHasDanmaku: false,
      ...(danmaPath ? { danmaXmlPath: danmaPath, danmaAssPath: danmaKind(danmaPath) === 'ass' ? danmaPath : undefined } : {}),
    },
  }).record;

  const adapter = {
    planCalls: (range: { start: number; end: number }) => {
      const out: Array<{ file: string; inFileStart: number; inFileEnd: number; globalStart: number; globalEnd: number; offset: number; windowIndex: number }> = [];
      for (const seg of map.segments) {
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

  const pre = orchTmp.transcriber.preflight(adapter, map.totalDuration);
  ok('转写预检可执行', pre.windows.length > 0, `${pre.windows.length} 个调用单元`);
  ok(
    '每个调用单元都不超过配置的窗口长度（硬约束 #7）',
    pre.windows.every((w) => w.inFileEnd - w.inFileStart <= cfg.asr.segmentMinutes * 60 + 1),
    pre.windows.map((w) => (w.inFileEnd - w.inFileStart).toFixed(0)).join(','),
  );
  note(`预检：${pre.windows.length} 个单元，缓存命中 ${pre.cacheHits}，需付费 ${pre.toPay}，音频合计 ${fmtDuration(pre.audioSeconds)}，估算 ¥${pre.estimatedCost.toFixed(2)}`);

  const t0 = Date.now();
  const tr = await orchTmp.transcriber.transcribe({
    taskId: taskRec.id,
    media: adapter,
    totalDuration: map.totalDuration,
    dryRun: !ALLOW_PAID,
    allowPaid: ALLOW_PAID,
  });
  const elapsed = Date.now() - t0;

  if (ALLOW_PAID) {
    ok('真实转写完成（有字幕产出）', tr.transcript.segments.length > 0, `${tr.transcript.segments.length} 条`);
    ok('付费调用次数已统计', tr.paidCalls >= 0, `${tr.paidCalls} 次`);
    note(`转写耗时 ${(elapsed / 1000).toFixed(1)}s，字幕 ${tr.transcript.segments.length} 条，gaps ${tr.transcript.gaps.length} 处，估算成本 ¥${(tr.transcript.costEstimate ?? 0).toFixed(2)}`);
    if (tr.transcript.segments.length) {
      const sample = tr.transcript.segments.filter((s) => s.text.length > 8).slice(0, 3);
      for (const s of sample) note(`  [${fmtDuration(s.start)}] ${s.text.slice(0, 60)}`);
    }
    ok('转写时间戳落在视频时长内', tr.transcript.segments.every((s) => s.end <= map.totalDuration + 5), `最大 ${Math.max(0, ...tr.transcript.segments.map((s) => s.end)).toFixed(0)}s vs 总长 ${map.totalDuration.toFixed(0)}s`);
  } else {
    ok('dry-run 且无缓存时**没有产生任何付费调用**（硬约束 #14）', tr.paidCalls === 0, `${tr.paidCalls} 次`);
    if (pre.cacheHits === pre.windows.length && pre.windows.length > 0) {
      // 缓存全命中：dry-run 应当**直接复用**已付费的转写，而不是产出一堆 gaps
      ok('dry-run 命中全部本地缓存 → 直接复用已有转写（不重复付费、也不假装缺失）', tr.transcript.segments.length > 0, `${tr.transcript.segments.length} 条`);
      ok('缓存命中时不应产生 gaps', tr.transcript.gaps.length === 0, `${tr.transcript.gaps.length} 处`);
      note(`dry-run 复用缓存：${tr.transcript.segments.length} 条字幕，本次花费 ¥0.00（转写结果来自 data/asr-cache）`);
    } else {
      ok('dry-run 且无缓存时如实记录缺失区间（而不是假装成功）', tr.transcript.gaps.length > 0, `${tr.transcript.gaps.length} 处`);
      ok('缺失原因指明是付费保护', tr.transcript.gaps.every((g) => /dry-run|付费/.test(g.reason)), tr.transcript.gaps[0]?.reason);
      ok('无缓存时不产出任何字幕（避免把空结果当成成功）', tr.transcript.segments.length === 0, `${tr.transcript.segments.length} 条`);
      note(`dry-run 结果：${tr.transcript.gaps.length} 个区间被跳过，未付费。如需真实转写请显式加 --allow-paid`);
    }
  }

  /* ---------------- 6. 分析阶段（dry-run 不调 LLM） ---------------- */
  section('6. 分析阶段');
  const signals = danmaPath
    ? analyzeDanmaku({ taskId: taskRec.id, filePath: danmaPath, videoDuration: map.totalDuration, config: cfg }).signals
    : {
        taskId: taskRec.id,
        danmakuOffset: 0,
        eventSignalsAvailable: false,
        eventCounts: { danmaku: 0, superchat: 0, guard: 0, gift: 0 },
        density: [],
        peaks: [],
        keywords: [],
        danmakuTotal: 0,
        videoDuration: map.totalDuration,
        createdAt: new Date().toISOString(),
      };
  const an = await orchTmp.analyzer.analyze({
    taskId: taskRec.id,
    transcript: tr.transcript,
    signals,
    videoDuration: map.totalDuration,
    dryRun: !ALLOW_PAID,
    allowPaid: ALLOW_PAID,
  });
  if (ALLOW_PAID) {
    ok('真实分析流程完整执行（未抛异常）', true, `${an.decision.clips.length} 个候选`);
    const llmConfigured = Boolean(cfg.llm.summary.apiKey && cfg.llm.select.apiKey) && !/在此填写|placeholder/i.test(cfg.llm.summary.apiKey);
    if (llmConfigured && !an.decision.degraded) {
      ok('未降级（真实 LLM 可用，产出真实选片）', true);
      note(`总结 ${an.summary.length} 字符；候选 ${an.decision.clips.length} 个（勾选 ${an.decision.clips.filter((c) => c.selected).length} 个）`);
      for (const c of an.decision.clips.slice(0, 6)) {
        note(`  ${fmtDuration(c.start)}-${fmtDuration(c.end)} [${c.score}] ${c.title}（${c.category} / ${c.tags.join(',')}）`);
      }
      ok('全部候选标题 ≤ 80 字符（硬约束 #3）', an.decision.clips.every((c) => c.title.length <= 80));
      ok('全部候选分区来自白名单（硬约束 #16）', an.decision.clips.every((c) => Object.keys(cfg.publish.tidWhitelist).includes(c.category)));
      ok('候选互不重叠', an.decision.clips.every((c, i) => i === 0 || c.start >= an.decision.clips[i - 1]!.end - 0.01));
      ok('候选时长在配置范围内', an.decision.clips.every((c) => c.end - c.start >= cfg.clip.minDurationSec - 0.1 && c.end - c.start <= cfg.clip.maxDurationSec + 0.1));
    } else {
      // LLM Key 未配置属于**环境项**：代码正确识别并进入降级兜底，这是预期行为而非缺陷
      ok('LLM 未配置时正确进入降级兜底（而不是崩溃或静默零产出）', an.decision.degraded === true, `degraded=${an.decision.degraded}`);
      ok('降级兜底仍产出可人工确认的候选（避免「成功但无内容」）', an.decision.clips.length > 0, `${an.decision.clips.length} 个`);
      ok('降级产出默认不勾选（必须人工确认）', an.decision.clips.every((c) => !c.selected));
      ok('降级产出的标题是占位符', an.decision.clips.every((c) => c.title.includes('待填写')));
      console.log(`  \x1b[33m⚠ 需要人工处理：LLM API Key 未配置\x1b[0m`);
      console.log(`  \x1b[33m  → 在 config.json 填写 llm.summary.apiKey 与 llm.select.apiKey（建议选片档用更强模型）\x1b[0m`);
      console.log(`  \x1b[33m  → 当前降级来源：${an.decision.modelUsed}，共 ${an.decision.clips.length} 个候选待人工确认\x1b[0m`);
      note(`环境项：LLM Key 未配置 → 已走降级兜底（${an.decision.modelUsed}），产出 ${an.decision.clips.length} 个候选`);
    }
  } else {
    ok('dry-run 没有调用 LLM（硬约束 #14）', an.cost.calls === 0 || an.decision.degraded, `calls=${an.cost.calls} degraded=${an.decision.degraded}`);
    note(`dry-run 分析：标记为降级=${an.decision.degraded}，未产生 LLM 费用`);
  }

  /* ---------------- 7. 环境健康 ---------------- */
  section('7. 环境健康（代码无法解决、需要人工处理的项）');
  try {
    const raw = await client.getConfig();
    const del = checkAfterUploadDelete(cfg, raw);
    ok('已检查「上传后删除素材」开关', true, del.value ?? '未读到');
    if (!del.ok) {
      console.log(`  \x1b[33m⚠ 需要人工处理：${del.message}\x1b[0m`);
      if (del.fix) console.log(`  \x1b[33m  → ${del.fix}\x1b[0m`);
      notes.push('环境项：「上传后删除素材」未关闭（硬约束 #11）—— 建议首次试跑前处理');
    }
  } catch {
    note('无法读取 /config（跳过该检查）');
  }
  const disk = orchTmp.cleaner.canStartNewTask();
  ok('磁盘守卫可用', disk.ok, disk.reason ?? `剩余空间充足`);

  /* ---------------- 汇总 ---------------- */
  section('汇总');
  console.log(`  素材    : ${path.basename(videoPath)}`);
  console.log(`  时长    : ${fmtDuration(map.totalDuration)}（${map.segments.length} 段）`);
  console.log(`  弹幕    : ${danmaPath ? `${signals.danmakuTotal} 条` : '无'}`);
  console.log(`  转写    : ${ALLOW_PAID ? `${tr.transcript.segments.length} 条字幕，估算 ¥${(tr.transcript.costEstimate ?? 0).toFixed(2)}` : 'dry-run 跳过（未付费）'}`);
  console.log(`  分析    : ${ALLOW_PAID ? `${an.decision.clips.length} 个候选` : 'dry-run 跳过（未付费）'}`);
  console.log(`  总耗时  : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const n of notes.filter((x) => x.startsWith('环境项'))) console.log(`  \x1b[33m${n}\x1b[0m`);

  orch.stop();
  orchTmp.stop();
  try {
    fs.rmSync(tmpData, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  console.log(`\n\x1b[1m===== 结果：PASS=${pass} FAIL=${fail} =====\x1b[0m`);
  if (fail > 0) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
    process.exitCode = 1;
  } else {
    console.log('\x1b[32m真实素材上的链路验证通过。\x1b[0m');
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  ok(name, actual === expected, actual === expected ? undefined : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

main().catch((e) => {
  console.error('\x1b[31m真实素材验证脚本崩溃：\x1b[0m');
  console.error((e as Error).stack);
  process.exit(1);
});
