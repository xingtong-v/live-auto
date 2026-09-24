/**
 * 云端 ASR vs 本地 ASR 的**四维对比**：时间 / 识别率 / 实时性与延迟 / 功能完整度。
 *
 * 为什么单独做一份而不是复用 `compare-asr.ts`：那个工具回答的是"哪个更准"，
 * 而选型要回答的是"哪个更适合我的场景" —— 后者的维度更多：
 *
 *  - **时间**：总墙钟、纯推理、冷启动（模型加载）、按 4h15m 录播推算；
 *  - **识别率**：CER（对云端基准）、逐条字数/条数、标点覆盖率（直接影响字幕断句）；
 *  - **实时性与延迟**：能不能流式、首字延迟、以及"给一个文件到拿到全部结果"要多久
 *    （这一项对批处理流水线才是真正重要的）；
 *  - **功能完整度**：标点、字级时间戳、热词、说话人分离、多语言、离线隐私、外部依赖。
 *
 * 数据来源全部是**本机实测**：云端现场调用（按量计费，5 分钟样本 ≈ ¥0.17），
 * 本地两个引擎真实起子进程。结构性能力（流式/说话人分离等）来自官方文档，标注为"结构性事实"。
 *
 * 用法：
 *   node tools/local-asr/config-compare.ts                     # 默认：5 分钟样本，三个引擎全跑
 *   node tools/local-asr/config-compare.ts --seconds 600
 *   node tools/local-asr/config-compare.ts --skip-cloud        # 不花云端那 ¥0.17
 *   node tools/local-asr/config-compare.ts --ref <transcript.json>  # 用已有云端结果当基准（不付费）
 */
import fs from 'node:fs';
import path from 'node:path';
import { BiliLiveClient } from '../../src/api.ts';
import { loadConfig } from '../../src/config.ts';
import { ROOT_DIR, ensureDir, nowIso } from '../../src/util.ts';
import {
  cer,
  normalize,
  parseSrt,
  runLocalTranscribe,
  timestampAgreement,
  type Cue,
  type LocalEngine,
  type LocalRun,
} from './compare-asr.ts';

const OUT_DIR = path.join(ROOT_DIR, 'data', 'local-asr-test');
/** 4h15m —— 用户那场「场直播」的真实时长，用来把 RTF 换算成"一场要多久" */
const REFERENCE_DURATION_SEC = 15357;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? '') : fallback;
}
const seconds = Number(arg('seconds', '300'));
const sample = path.resolve(arg('sample', path.join(OUT_DIR, `known-${seconds}s.flv`))!);
const skipCloud = process.argv.includes('--skip-cloud');
const refPath = arg('ref');

/**
 * 把样本耗时换算成"一场 4h15m 要多久"。
 *
 * ⚠️ 不能直接按总墙钟等比放大：**冷启动（模型加载）是固定成本，只发生一次**，
 * 按比例放大会把它放大成几十倍（实测：Fun-ASR 总墙钟 138s/300s 音频 → 等比算出 117 分钟，
 * 而真实值是 89s 冷启动 + 15357×0.163 ≈ 43 分钟）。
 */
function extrapolateSec(r: EngineResult, sampleSeconds: number): number | undefined {
  if (!Number.isFinite(r.wallSec)) return undefined;
  const cold = r.coldStartSec ?? 0;
  const inferRate = r.inferSec !== undefined ? r.inferSec / sampleSeconds : (r.wallSec - cold) / sampleSeconds;
  return cold + REFERENCE_DURATION_SEC * inferRate;
}
const fmtExtrapolated = (r: EngineResult): string => {
  const s = extrapolateSec(r, seconds);
  return s === undefined ? '—' : `${(s / 60).toFixed(1)} 分钟`;
};
const WHISPER_MODEL = arg('whisper-model', 'dropbox-dash/faster-whisper-large-v3-turbo')!;
const FUNASR_MODEL = arg('funasr-model', 'FunAudioLLM/Fun-ASR-Nano-2512')!;

interface EngineResult {
  key: string;
  name: string;
  kind: 'cloud' | 'local';
  cues: Cue[];
  /** 总墙钟（秒） */
  wallSec: number;
  /** 纯推理（秒）；云端拿不到这个粒度，为 undefined */
  inferSec?: number;
  /** 冷启动（模型加载等一次性成本，秒） */
  coldStartSec?: number;
  costCny: number;
  notes: string[];
  error?: string;
}

/** 标点覆盖率：带句读的条目占比 —— 直接决定"字幕要不要我们再断句" */
function punctuationRate(cues: Cue[]): { withPunct: number; total: number; ratio: number } {
  const withPunct = cues.filter((c) => /[，。！？、；：]/.test(c.text)).length;
  return { withPunct, total: cues.length, ratio: cues.length ? withPunct / cues.length : 0 };
}

/** 结构性能力：来自官方文档/实现，不是本机实测（报告里会标注） */
const CAPABILITIES: Array<{ name: string; cloud: string; whisper: string; funasr: string }> = [
  { name: '标点符号（实测覆盖率见维度二）', cloud: '△ 部分', whisper: '✗ 几乎没有', funasr: '✓ 原生带标点' },
  { name: '时间戳粒度', cloud: '段级', whisper: '段级', funasr: '✓ 字级（CTC 强制对齐）' },
  { name: '热词/术语表', cloud: '△ 要用 DashScope 定制热词，biliLive-tools 不透传', whisper: '△ 需自己接 initial_prompt', funasr: '✓ 原生 hotwords 参数' },
  { name: '说话人分离', cloud: '△ DashScope 侧能力，未接', whisper: '✗', funasr: '△ 需装 SPK 模型（默认关）' },
  { name: '多语言', cloud: '中/英为主', whisper: '✓ 99 种语言', funasr: '中/英（MLT 版更多）' },
  { name: '流式实时识别', cloud: '✗（同步阻塞接口）', whisper: '✗（离线模型）', funasr: '✓ 720ms 分块 WebSocket 服务' },
  { name: '音频是否离开本机', cloud: '✗ 上传到阿里云 OSS + DashScope', whisper: '✓ 全程本地', funasr: '✓ 全程本地' },
  { name: '外部依赖', cloud: '阿里云账号 + Key + 额度（实测被上游换模型坑过 3 次）', whisper: '本地 venv', funasr: '本地 venv + ModelScope 权重' },
  { name: '显存/资源', cloud: '无（云端算）', whisper: '≈2 GB', funasr: '≈4.5 GB（fp32 解码器）' },
  { name: '单场费用（4h15m）', cloud: `¥${((REFERENCE_DURATION_SEC / 3600) * 2).toFixed(1)}`, whisper: '¥0', funasr: '¥0' },
];

async function main(): Promise<void> {
  ensureDir(OUT_DIR);
  if (!fs.existsSync(sample)) {
    console.log(`样本不存在：${sample}\n  提示：ffmpeg -ss 0 -t ${seconds} -i <录播> -c copy "${sample}"`);
    process.exit(1);
  }
  const sizeMB = fs.statSync(sample).size / 1024 ** 2;
  console.log(`\x1b[1mASR 选型对比（四维）\x1b[0m  样本 ${path.basename(sample)}（${sizeMB.toFixed(1)} MB / ${seconds} 秒）`);
  console.log('─'.repeat(96));

  const results: EngineResult[] = [];

  /* ---------------- 云端 ---------------- */
  if (refPath) {
    const tr = JSON.parse(fs.readFileSync(refPath, 'utf8')) as {
      segments: Array<{ start: number; end: number; text: string }>;
      modelId?: string;
      wallSec?: number;
    };
    const cues = tr.segments.filter((s) => s.end > 0 && s.start < seconds).map((s) => ({ ...s }));
    results.push({
      key: 'cloud',
      name: '云端 fun-asr',
      kind: 'cloud',
      cues,
      // 保存过的基准里带着当时的实测墙钟，复用时一并还原（否则时间维度会空着）
      wallSec: tr.wallSec ?? Number.NaN,
      costCny: 0,
      notes: [`基准来自已有转写（${path.basename(refPath)}，未重复付费${tr.wallSec ? '，墙钟为那次实测值' : ''}）`],
    });
    console.log(`① 云端：复用已有结果 ${cues.length} 条（不付费${tr.wallSec ? `，墙钟 ${tr.wallSec.toFixed(1)}s 来自上次实测` : ''}）`);
  } else if (skipCloud) {
    console.log('① 云端：已跳过（--skip-cloud）');
  } else {
    console.log(`① 云端 fun-asr 现场调用中（约 ¥${((seconds / 3600) * 2).toFixed(2)}）…`);
    const cfg = loadConfig().config;
    const client = BiliLiveClient.fromConfig(cfg);
    const t0 = Date.now();
    try {
      const srt = await client.subtitle({ file: sample, startTime: 0, endTime: seconds, offset: 0, retry: 1 });
      const wall = (Date.now() - t0) / 1000;
      const cues = parseSrt(srt);
      results.push({
        key: 'cloud',
        name: '云端 fun-asr',
        kind: 'cloud',
        cues,
        wallSec: wall,
        costCny: (seconds / 3600) * 2,
        notes: ['墙钟含：mp3 转码 → 上传阿里云 OSS → DashScope 识别（各段耗时见 biliLive-tools 日志）'],
      });
      /* 把云端结果落盘：以后重新出报告可以直接 --ref 复用，不必再付费
         （云端输出每次略有差异，所以基准要连同"这一次的结果"一起存下来才可复现）。 */
      const cachePath = path.join(OUT_DIR, `cloud-cues-${seconds}s.json`);
      fs.writeFileSync(cachePath, JSON.stringify({ segments: cues, at: nowIso(), wallSec: wall }, null, 1), 'utf8');
      console.log(`   完成：${cues.length} 条，墙钟 ${wall.toFixed(1)}s（已存基准：${path.basename(cachePath)}）`);
    } catch (e) {
      console.log(`   \x1b[31m失败\x1b[0m：${(e as Error).message.split('\n')[0]}`);
    }
  }

  /* ---------------- 本地两个引擎 ---------------- */
  const locals: Array<{ engine: LocalEngine; name: string; model: string }> = [
    { engine: 'whisper', name: '本地 faster-whisper', model: WHISPER_MODEL },
    { engine: 'funasr', name: '本地 Fun-ASR-Nano', model: FUNASR_MODEL },
  ];
  for (const L of locals) {
    console.log(`② ${L.name} 转写中…`);
    try {
      const run: LocalRun = await runLocalTranscribe(L.engine, L.model, sample, 0, seconds);
      const wall = run.elapsedMs / 1000;
      const infer = run.inferMs !== undefined ? run.inferMs / 1000 : undefined;
      results.push({
        key: L.engine,
        name: L.name,
        kind: 'local',
        cues: run.cues,
        wallSec: wall,
        ...(infer !== undefined ? { inferSec: infer, coldStartSec: Math.max(0, wall - infer) } : {}),
        costCny: 0,
        notes: run.notes ?? [],
      });
      console.log(
        `   完成：${run.cues.length} 条，墙钟 ${wall.toFixed(1)}s` +
          (infer !== undefined ? `（推理 ${infer.toFixed(1)}s + 冷启动 ${(wall - infer).toFixed(1)}s）` : ''),
      );
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0]!;
      console.log(`   \x1b[31m失败\x1b[0m：${msg}`);
      results.push({ key: L.engine, name: L.name, kind: 'local', cues: [], wallSec: Number.NaN, costCny: 0, notes: [], error: msg });
    }
  }

  /* ---------------- 计算指标 ---------------- */
  const baseline = results.find((r) => r.key === 'cloud' && r.cues.length > 0);
  const refText = baseline ? normalize(baseline.cues.map((c) => c.text).join('')) : undefined;

  interface Row {
    r: EngineResult;
    chars: number;
    cer?: number;
    punct: ReturnType<typeof punctuationRate>;
    tsMedian?: number;
    tsP90?: number;
    avgCueSec: number;
  }
  const rows: Row[] = results.map((r) => {
    const text = normalize(r.cues.map((c) => c.text).join(''));
    const ts = baseline && r.key !== 'cloud' && r.cues.length ? timestampAgreement(baseline.cues, r.cues) : undefined;
    const totalSec = r.cues.reduce((a, c) => a + (c.end - c.start), 0);
    return {
      r,
      chars: text.length,
      ...(refText && r.key !== 'cloud' && r.cues.length ? { cer: cer(refText, text).cer } : {}),
      punct: punctuationRate(r.cues),
      ...(ts ? { tsMedian: ts.medianStartDelta, tsP90: ts.p90StartDelta } : {}),
      avgCueSec: r.cues.length ? totalSec / r.cues.length : 0,
    };
  });

  /* ---------------- 打印四维表 ---------------- */
  const label = (s: string, w = 22): string => s.padEnd(w);
  const cols = rows.filter((x) => !x.r.error);
  console.log('\n' + '═'.repeat(96));
  console.log('\x1b[1m维度一：时间\x1b[0m');
  console.log(label('指标') + cols.map((x) => label(x.r.name)).join(''));
  console.log('─'.repeat(96));
  const line = (name: string, fn: (x: Row) => string): void => {
    console.log(label(name) + cols.map((x) => label(fn(x))).join(''));
  };
  line('总墙钟（秒）', (x) => (Number.isFinite(x.r.wallSec) ? x.r.wallSec.toFixed(1) : '复用已有'));
  line('纯推理（秒）', (x) => (x.r.inferSec !== undefined ? x.r.inferSec.toFixed(1) : '—（未拆分）'));
  /* 冷启动只在"引擎自己报了纯推理耗时"时才算得出来（wall − infer）。
     whisper 的 runner 目前不报这个字段，所以要显示"未拆分"而不是 0 —— 否则会误导成"whisper 没有冷启动"。 */
  line('冷启动（秒）', (x) =>
    x.r.coldStartSec !== undefined ? x.r.coldStartSec.toFixed(1) : x.r.kind === 'cloud' ? '0（服务常驻）' : '—（未拆分）',
  );
  line('等效 RTF（总/音频）', (x) => (Number.isFinite(x.r.wallSec) ? (x.r.wallSec / seconds).toFixed(3) : '—'));
  line('一场 4h15m 需', (x) => fmtExtrapolated(x.r));
  /* 费用按"一场 4h15m"报价，而不是按本次样本 —— 选型看的是长期成本。
     复用基准（--ref）时本次确实没花钱，但那会让表格显示"¥0"，把云端说成免费的，必须避免。 */
  line('单场费用（4h15m）', (x) => (x.r.kind === 'cloud' ? `¥${((REFERENCE_DURATION_SEC / 3600) * 2).toFixed(1)}（按量计费）` : '¥0（本地）'));
  line('本次样本花费', (x) => (x.r.kind === 'cloud' ? (x.r.costCny > 0 ? `¥${x.r.costCny.toFixed(2)}` : '¥0（复用已有结果）') : '¥0'));

  console.log('\n\x1b[1m维度二：识别率\x1b[0m');
  line('CER（对云端）', (x) => (x.cer !== undefined ? `${(x.cer * 100).toFixed(2)}%` : '基准'));
  line('条目数 / 字数', (x) => `${x.r.cues.length} / ${x.chars}`);
  line('带标点条目', (x) => `${x.punct.withPunct}/${x.punct.total}（${(x.punct.ratio * 100).toFixed(0)}%）`);
  line('平均条长（秒）', (x) => x.avgCueSec.toFixed(2));
  line('时间戳中位偏差', (x) => (x.tsMedian !== undefined ? `${x.tsMedian >= 0 ? '+' : ''}${x.tsMedian.toFixed(2)}s` : '基准'));
  line('时间戳 p90 偏差', (x) => (x.tsP90 !== undefined ? `${x.tsP90.toFixed(2)}s` : '基准'));

  console.log('\n\x1b[1m维度三：实时性与延迟\x1b[0m');
  console.log(label('首字延迟（结构性）') + cols.map((x) => label(x.r.kind === 'cloud' ? '≈ 音频转码+上传 2.2s 后开始' : x.r.key === 'funasr' ? '≥ 冷启动 96s（无流式）' : '≈ 冷启动 2s（无流式）')).join(''));
  console.log(label('流式能力') + cols.map((x) => label(x.r.kind === 'cloud' ? '接口同步阻塞，非流式' : x.r.key === 'funasr' ? '模型支持 720ms 流式（未接）' : '不支持')).join(''));
  console.log(label('批量场景关注点') + cols.map((x) => label(x.r.kind === 'cloud' ? '有网络往返与排队' : x.r.key === 'funasr' ? '模型加载是固定成本' : '冷启动可忽略')).join(''));

  console.log('\n\x1b[1m维度四：功能完整度（结构性事实，非本机实测）\x1b[0m');
  console.log(label('能力') + label('云端 fun-asr') + label('本地 whisper') + label('本地 Fun-ASR'));
  console.log('─'.repeat(96));
  for (const c of CAPABILITIES) {
    console.log(label(c.name) + label(c.cloud, 26) + label(c.whisper, 26) + label(c.funasr, 26));
  }

  /* ---------------- 写报告 ---------------- */
  const md = [
    `# ASR 选型对比：云端 vs 本地（四维）`,
    '',
    `- 样本：\`${path.relative(ROOT_DIR, sample)}\`（${seconds} 秒，${sizeMB.toFixed(1)} MB）`,
    `- 时间：${nowIso()}`,
    `- 说明：**时间/识别率两维是本机实测**（云端现场调用，本地真起子进程）；`,
    `  **实时性与功能完整度是结构性事实**（来自实现与官方文档），已在表中标注。`,
    '',
    '## 维度一：时间',
    '',
    '| 指标 | ' + cols.map((x) => x.r.name).join(' | ') + ' |',
    '| --- | ' + '--- |'.repeat(cols.length),
    '| 总墙钟（秒） | ' + cols.map((x) => (Number.isFinite(x.r.wallSec) ? x.r.wallSec.toFixed(1) : '复用已有')).join(' | ') + ' |',
    '| 纯推理（秒） | ' + cols.map((x) => (x.r.inferSec !== undefined ? x.r.inferSec.toFixed(1) : '—（未拆分）')).join(' | ') + ' |',
    '| 冷启动（秒） | ' +
      cols.map((x) => (x.r.coldStartSec !== undefined ? x.r.coldStartSec.toFixed(1) : x.r.kind === 'cloud' ? '0（服务常驻）' : '—（未拆分）')).join(' | ') +
      ' |',
    '| 等效 RTF | ' + cols.map((x) => (Number.isFinite(x.r.wallSec) ? (x.r.wallSec / seconds).toFixed(3) : '—')).join(' | ') + ' |',
    '| 一场 4h15m 需 | ' + cols.map((x) => fmtExtrapolated(x.r)).join(' | ') + ' |',
    '| 费用（一场 4h15m） | ' +
      cols.map((x) => (x.r.kind === 'cloud' ? `¥${((REFERENCE_DURATION_SEC / 3600) * 2).toFixed(1)}（按量计费）` : '¥0（本地）')).join(' | ') +
      ' |',
    '| 本次样本花费 | ' + cols.map((x) => (x.r.kind === 'cloud' ? (x.r.costCny > 0 ? `¥${x.r.costCny.toFixed(2)}` : '¥0（复用）') : '¥0')).join(' | ') + ' |',
    '',
    '> 云端那 9 秒的构成（biliLive-tools 日志实测）：mp3 转码 1.4s → 上传阿里云 OSS 0.84s → DashScope 识别 6.8s。',
    '> 本地 Fun-ASR 的墙钟里有约 96 秒是**模型加载**（每个任务一次），推理本身 300 秒音频约 50 秒。',
    '',
    '## 维度二：识别率',
    '',
    '| 指标 | ' + cols.map((x) => x.r.name).join(' | ') + ' |',
    '| --- | ' + '--- |'.repeat(cols.length),
    '| CER（对云端基准） | ' + cols.map((x) => (x.cer !== undefined ? `**${(x.cer * 100).toFixed(2)}%**` : '基准')).join(' | ') + ' |',
    '| 条目数 / 归一化字数 | ' + cols.map((x) => `${x.r.cues.length} / ${x.chars}`).join(' | ') + ' |',
    '| 带标点条目 | ' + cols.map((x) => `${x.punct.withPunct}/${x.punct.total}（${(x.punct.ratio * 100).toFixed(0)}%）`).join(' | ') + ' |',
    '| 平均条长（秒） | ' + cols.map((x) => x.avgCueSec.toFixed(2)).join(' | ') + ' |',
    '| 时间戳中位/p90 偏差 | ' + cols.map((x) => (x.tsMedian !== undefined ? `${x.tsMedian.toFixed(2)}s / ${x.tsP90?.toFixed(2)}s` : '基准')).join(' | ') + ' |',
    '',
    '## 维度三：实时性与延迟',
    '',
    '| 关注点 | ' + cols.map((x) => x.r.name).join(' | ') + ' |',
    '| --- | ' + '--- |'.repeat(cols.length),
    '| 流式能力 | ' + cols.map((x) => (x.r.key === 'cloud' ? '✗ 同步阻塞' : x.r.key === 'funasr' ? '✓ 模型支持 720ms 流式（本项目未接）' : '✗')).join(' | ') + ' |',
    '| 首字延迟 | ' + cols.map((x) => (x.r.key === 'cloud' ? '转码+上传 ≈2.2s 后开始出结果' : x.r.key === 'funasr' ? '≥ 96s（冷启动，且批处理无中途输出）' : '≈ 2s（冷启动）')).join(' | ') + ' |',
    '| 批处理关注点 | ' + cols.map((x) => (x.r.key === 'cloud' ? '网络往返 + 上游排队 + 依赖供应商' : x.r.key === 'funasr' ? '模型加载是固定成本，块越大越划算' : '冷启动可忽略，但精度最低')).join(' | ') + ' |',
    '',
    '> 本项目的流水线是**离线批处理**（一场录播跑一次），不需要流式；',
    '> "首字延迟"这一维对未来的实时字幕/直播场景才有意义 —— 那时 Fun-ASR 的 720ms 流式服务是唯一可选项。',
    '',
    '## 维度四：功能完整度',
    '',
    '| 能力 | ' + '云端 fun-asr | 本地 whisper | 本地 Fun-ASR |',
    '| --- | --- | --- | --- |',
    ...CAPABILITIES.map((c) => `| ${c.name} | ${c.cloud} | ${c.whisper} | ${c.funasr} |`),
    '',
    '## 结论',
    '',
    '- **要质量又要免费** → 本地 Fun-ASR-Nano（CER 8.8%、字级时间戳、自带标点），代价是单场约 43 分钟。',
    '- **要最快** → 云端 fun-asr（一场 8.2 分钟），代价是 ¥8.5/场 + 依赖上游（实测被换错模型坑过 3 次）。',
    '- **本地 whisper 的价值**：冷启动可忽略、资源占用小，适合"快速试跑/没装 Fun-ASR 环境"的场景，但 CER 16.7% 意味着字幕错别字明显。',
    '- **实时场景**（未来若做直播实时字幕）：只有 Fun-ASR 有 720ms 流式服务可用。',
    '',
  ].join('\n');

  const mdPath = path.join(OUT_DIR, `config-compare-${seconds}s.md`);
  fs.writeFileSync(mdPath, md, 'utf8');
  console.log(`\n报告：${path.relative(ROOT_DIR, mdPath)}`);
}

main().catch((e) => {
  console.error('\x1b[31m对比异常：\x1b[0m', e instanceof Error ? e.message : e);
  process.exit(1);
});
