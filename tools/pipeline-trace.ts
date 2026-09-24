/**
 * 链路核对：把「当前这台机器上、当前这份代码里」的实际链路打印出来。
 *
 * 为什么要这个工具：链路图很容易变成"设计意图"而不是"实际行为"——
 * 默认值、配置覆盖、分支（半自动/全自动）、以及某一步压根没实现在全自动路径上，
 * 这些都只有从**实际配置 + 实际代码**里读出来才算数。
 *
 * 只读。
 *
 * 用法：node tools/pipeline-trace.ts
 */
import { loadConfig } from '../src/config.ts';
import { Ledger } from '../src/ledger.ts';
import { exists } from '../src/util.ts';

const cfg = loadConfig().config;
const led = new Ledger();
const tasks = led.listTasks({ limit: 5 });

const y = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const w = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const line = (): void => console.log('─'.repeat(78));

console.log('\x1b[1m链路核对：当前配置 × 当前代码\x1b[0m');
line();

console.log(`\n\x1b[1m① 触发（录制结束 → 建任务）\x1b[0m`);
console.log(`  轮询 recent-clips 间隔 : ${cfg.room.pollIntervalSec}s        ${y('trigger.ts')}`);
console.log(`  历史对账间隔           : ${cfg.room.reconcileIntervalMin}min      ${y('trigger.ts')}`);
console.log(`  下播确认窗口           : ${cfg.room.offlineConfirmSec}s      ${y('硬约束 #19')}`);
console.log(`  录制器类型             : ${cfg.recorder.type}${cfg.recorder.type === 'builtin' ? '  ' + w('（内置：无对外事件源，只能靠轮询）') : ''}`);
console.log(`  webhook 目标           : ${cfg.recorder.webhookTargets.length ? cfg.recorder.webhookTargets.join(', ') : '(未配置，靠轮询)'}`);

console.log(`\n\x1b[1m② 转写支线\x1b[0m`);
console.log(`  provider               : ${cfg.asr.provider}`);
console.log(`  输入源                 : ${cfg.asr.inputSource}${cfg.asr.inputSource === 'raw' ? y('  （原始 flv，与压制并行）') : w('  （压制产物，会与压制串行）')}`);
console.log(`  分段 / 重叠 / 并发     : ${cfg.asr.segmentMinutes}min / ${cfg.asr.overlapSeconds}s / ${cfg.asr.concurrency}`);
console.log(`  单价（估算用）         : ¥${cfg.asr.unitPricePerHour}/h`);
console.log(`  本地缓存               : ${cfg.asr.cacheDir}  键不含 videoFileId`);
console.log(`  剪静音                 : ${cfg.asr.silenceTrim.enabled ? '开启' : '关闭'}`);
console.log(`  → transcript.json      : 分段写盘，供选片与字幕复用`);

console.log(`\n\x1b[1m③ 上传支线（完整版）\x1b[0m`);
console.log(`  是否并行               : kickFullVideoUpload 不 await（不阻塞切片）`);
console.log(`  完成判定               : /bili/archives 反查（任务队列重启即丢）`);
console.log(`  用途                   : 判断源 mp4 何时可删（cleanup）`);

console.log(`\n\x1b[1m④ 弹幕信号\x1b[0m`);
console.log(`  密度窗口 / 峰值 TopN   : ${cfg.danmaku.densityWindowSec}s / ${cfg.danmaku.peakTopN}`);
console.log(`  时间基准偏移           : ${String(cfg.danmaku.danmakuOffsetSec)}${cfg.danmaku.danmakuOffsetSec === 'auto' ? y('  （自动标定，写入 transcript.danmakuOffset）') : ''}`);
console.log(`  → signals.json         : 密度曲线 / 峰值 / 热词 / SC / 上舰 / 礼物`);

console.log(`\n\x1b[1m⑤ LLM 分析\x1b[0m`);
console.log(`  预设                   : ${cfg.llm.preset}`);
console.log(`  便宜档（分块+总结）    : ${cfg.llm.summary.model}`);
console.log(`  选片档                 : ${cfg.llm.select.model || `(留空 → 回落到 ${cfg.llm.summary.model})`}`);
console.log(`  分块                   : ${cfg.llm.chunkMinutes}min × 并发 ${cfg.llm.chunkConcurrency}`);
// ⚠️ 判断"升级是否真实"必须按**运行时的解析结果**比，不能比原始配置值：
//    llm.ts 的 modelOf('select') = select.model || summary.model（留空会回落），
//    所以配置里"一个空一个有值"看起来不同，运行时其实是同一个模型 → 升级退化为原地重试。
const effectiveSelect = cfg.llm.select.model?.trim() || cfg.llm.summary.model?.trim() || '';
const effectiveSummary = cfg.llm.summary.model?.trim() || '';
console.log(
  `  契约失败升级           : ${
    effectiveSelect !== effectiveSummary
      ? y(`两档实际不同（${effectiveSummary} → ${effectiveSelect}）→ 真升级`)
      : w(`两档实际相同（都是 ${effectiveSummary || '未配置'}）→ 只能原地重试，建议把选片档换成更强的模型`)
  }`,
);
console.log(`  记录原始响应           : ${cfg.llm.recordRawResponses ? '开启' : '关闭'}`);

console.log(`\n\x1b[1m⑥ 标题体检\x1b[0m`);
console.log(`  半自动（approve）      : ${y('硬校验：error 级直接拦下')}`);
console.log(`  多分P 投稿             : ${w('只告警不阻断')}`);
console.log(`  单片投稿（cutAndUpload）: ${w('未做体检（标题已在选片时 sanitize）')}`);
console.log(`  标题后缀 / 分P 模板    : "${cfg.publish.defaultTitleSuffix}" / "${cfg.publish.partTitleTemplate || '(默认 P{n} {title})'}"`);

console.log(`\n\x1b[1m⑦ 切片\x1b[0m`);
console.log(`  烧弹幕                 : ${cfg.clip.burnDanmaku ? '开' : '关'}`);
console.log(`  烧字幕                 : ${cfg.clip.burnSubtitles ? y('开（与弹幕合并成一个 ASS）') : w('关')}`);
console.log(`  字幕样式               : ${cfg.clip.subtitle.fontSize || 'auto'}号 / 每行 ${cfg.clip.subtitle.maxCharsPerLine} 字 / 最短 ${cfg.clip.subtitle.minDurationSec}s`);
console.log(`  片段时长范围           : ${cfg.clip.minDurationSec}–${cfg.clip.maxDurationSec}s，前后缓冲 ${cfg.clip.bufferSec}s`);
console.log(`  编码                   : ${JSON.stringify(cfg.clip.ffmpegOptionsOverride)}`);
console.log(`  输出目录               : ${cfg.clip.outputDir}`);

console.log(`\n\x1b[1m⑧ 投稿\x1b[0m`);
console.log(`  模式                   : ${cfg.publish.autoPublish ? w('全自动（分析完直接排期发布）') : y('半自动（需人工确认）')}`);
console.log(`  可见性                 : ${cfg.publish.isOnlySelf === 1 ? '仅自己可见' : w('公开')}`);
console.log(`  首片余量 / 片间隔      : ${cfg.publish.submitGapSec}s / ${cfg.publish.clipGapSec}s（硬约束 #4：>7200）`);
console.log(`  首片指定时间           : ${cfg.publish.firstPublishAt || '(自动算)'}`);
console.log(`  每日上限               : ${cfg.publish.dailyLimit}`);
console.log(`  多分P                  : ${cfg.publish.multiPart ? '开启' : '关闭'}`);
console.log(`  分区白名单             : ${Object.keys(cfg.publish.tidWhitelist).join('、')}`);

console.log(`\n\x1b[1m⑨ bvid 反查\x1b[0m`);
console.log(`  反查                   : /bili/archives 按标题（不用 taskId）`);
console.log(`  可信度三道闸           : 精确匹配 → ctime 晚于提交 → 排除完整版录播标题`);
console.log(`  反查循环               : 每 ${5}min 一次（daemon.confirmTick）`);

console.log(`\n\x1b[1m⑩ 清理\x1b[0m`);
console.log(`  素材缓冲期             : ${cfg.cleanup.retentionDays} 天`);
console.log(`  转写后删原始分段       : ${cfg.cleanup.deleteRawAfterTranscribe ? w('开启（符合 §7.3，但重跑需靠压制产物）') : '关闭'}`);
console.log(`  磁盘下限               : ${cfg.cleanup.diskFloorGB} GB`);
console.log(`  回收站保留             : ${cfg.cleanup.trashDays} 天`);

console.log(`\n\x1b[1m⑪ 目录与素材\x1b[0m`);
console.log(`  导入扫描目录（额外）   : ${cfg.import.scanDirs.length ? cfg.import.scanDirs.join(', ') : '(无)'}`);
console.log(`  递归深度 / 最小体积    : ${cfg.import.maxDepth} / ${cfg.import.minSizeMB}MB`);

console.log(`\n\x1b[1m⑫ 现存任务的素材状态（最容易出问题的一环）\x1b[0m`);
if (tasks.length === 0) console.log('  （台账里没有任务）');
for (const t of tasks) {
  const missing = (t.source.rawFiles ?? []).filter((f) => !exists(f));
  const full = t.source.fullVideoPath;
  console.log(`  ${t.id}  ${t.status}`);
  console.log(`      原始分段 ${(t.source.rawFiles ?? []).length} 个${missing.length ? `，\x1b[31m缺失 ${missing.length} 个\x1b[0m` : y('（都在）')}`);
  console.log(`      压制产物 ${full ? (exists(full) ? y('在') : '\x1b[31m缺失\x1b[0m') : '(未记录)'}   弹幕 ${t.source.danmaXmlPath ? 'xml' : ''}${t.source.danmaAssPath ? ' ass' : ''}`);
  if (missing.length && !full) console.log(`      \x1b[31m⚠ 原始分段缺失且无压制产物 → 「从源素材重来」会失败\x1b[0m`);
}
line();
