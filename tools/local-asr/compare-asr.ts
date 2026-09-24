/**
 * 云端 ASR vs 本地 ASR 的**质量对比**（同一段音频、同一时间窗）。
 *
 * ## 为什么只比"耗时/条数"不够
 *
 * 已有的本地基准（`bench.mjs` / `cloud-30m.ts`）只统计了墙钟、RTF、字幕条数 ——
 * 这些回答不了"能不能换"：换 ASR 之后**字幕会变成什么样**才是关键。
 * 所以这个工具比三件事：
 *
 *  1. **CER（字错率）**：以云端（现役 `fun-asr`）结果为基准，算本地结果的字错率 ——
 *     这是"本地差多少"最直接的量化；
 *  2. **分段一致性**：把两份结果按 10 秒分桶逐桶比，能区分"整体质量差"与"只是时间轴偏了"；
 *  3. **时间戳一致性**：为每条云端字幕找重叠最多的本地条目，统计起点偏差的中位数与 p90 ——
 *     我们的字幕、切片边界都依赖时间戳，这一项比 CER 更容易被忽略但同样致命。
 *
 * ## 成本
 *
 * 云端按 ¥2/小时计费：跑 5 分钟样本 = ¥0.17。本地零成本。
 * 默认用 `data/local-asr-test/sample-300s.flv`（已备好的样本），可用 `--seconds` 改。
 *
 * 用法：
 *   node tools/local-asr/compare-asr.ts                       # 默认 5 分钟样本 + large-v3-turbo
 *   node tools/local-asr/compare-asr.ts --seconds 120 --model dropbox-dash/faster-whisper-large-v3-turbo
 *   node tools/local-asr/compare-asr.ts --local-only          # 不调云端（省钱、只看本地）
 *   node tools/local-asr/compare-asr.ts --ref <transcript.json>  # 用已有转写当基准（不再付费调云端）
 *
 * `--ref` 的用处：云端 ASR 是**按小时计费**的，同一段素材没必要重复付钱。
 * 只要那份转写本来就是 `fun-asr` 产出的（本项目的流水线默认就是），
 * 它就是合格的基准 —— 省一次钱，也避免上游抽风时基准跑不出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { BiliLiveClient } from '../../src/api.ts';
import { loadConfig } from '../../src/config.ts';
import { ROOT_DIR, ensureDir, nowIso, writeJsonAtomic } from '../../src/util.ts';

const OUT_DIR = path.join(ROOT_DIR, 'data', 'local-asr-test');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? '') : fallback;
}
const localOnly = process.argv.includes('--local-only');
const seconds = Number(arg('seconds', '300'));
const sample = arg('sample', path.join(OUT_DIR, `sample-${seconds}s.flv`))!;
const model = arg('model', 'dropbox-dash/faster-whisper-large-v3-turbo')!;
const device = arg('device', 'cuda')!;
const computeType = arg('compute_type', 'float16')!;

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/* ---------------------------------------------------------------------------
 * 归一化与 CER
 * ------------------------------------------------------------------------- */

/**
 * 归一化后再比：ASR 之间的差异大量来自标点、空白、全角半角 ——
 * 这些对我们的字幕排版有影响，但对"听对了没有"没影响，混在一起算会让 CER 失真。
 */
export function normalize(s: string): string {
  return s
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角→半角
    .replace(/[\s]+/g, '')
    .replace(/[，。！？、；：""''（）《》【】…—·,.!?;:"'()<>[\]~`\-_/\\|@#$%^&*+=]/g, '')
    .toLowerCase();
}

/** 字级编辑距离 → CER */
export function cer(ref: string, hyp: string): { cer: number; dist: number; refLen: number } {
  const a = [...ref];
  const b = [...hyp];
  if (a.length === 0) return { cer: b.length > 0 ? 1 : 0, dist: b.length, refLen: 0 };
  // 滚动数组，内存 O(min)
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  const dist = prev[b.length]!;
  return { cer: dist / a.length, dist, refLen: a.length };
}

/** 解析 SRT（biliLive-tools 的返回格式） */
export function parseSrt(srt: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = srt.replace(/\r/g, '').split(/\n{2,}/);
  for (const b of blocks) {
    const m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(b);
    if (!m) continue;
    const toSec = (h: string, mi: string, s: string, ms: string): number =>
      Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms) / (ms.length === 3 ? 1000 : 100);
    const text = b
      .split('\n')
      .filter((l) => !/-->/.test(l) && !/^\d+$/.test(l.trim()))
      .join(' ')
      .trim();
    if (text) cues.push({ start: toSec(m[1]!, m[2]!, m[3]!, m[4]!), end: toSec(m[5]!, m[6]!, m[7]!, m[8]!), text });
  }
  return cues;
}

/* ---------------------------------------------------------------------------
 * 本地转写
 *
 * 两个 runner 共用同一套 spec/stdout 契约（`transcribe.py` = faster-whisper，
 * `transcribe-funasr.py` = 阿里云开源 Fun-ASR-Nano），所以这里只需要换解释器与脚本。
 * ------------------------------------------------------------------------- */
export type LocalEngine = 'whisper' | 'funasr';

const RUNNERS: Record<LocalEngine, { python: string; script: string }> = {
  whisper: { python: path.join(ROOT_DIR, '.venv-asr', 'Scripts', 'python.exe'), script: path.join(ROOT_DIR, 'tools', 'local-asr', 'transcribe.py') },
  funasr: { python: path.join(ROOT_DIR, '.venv-funasr', 'Scripts', 'python.exe'), script: path.join(ROOT_DIR, 'tools', 'local-asr', 'transcribe-funasr.py') },
};

export interface LocalRun {
  cues: Cue[];
  elapsedMs: number;
  /** 纯推理耗时（不含模型加载）—— 冷启动是一次性成本，混进来会把 RTF 算高好几倍 */
  inferMs?: number;
  device: string;
  computeType: string;
  engine: string;
  notes?: string[];
}

export function runLocalTranscribe(engine: LocalEngine, modelId: string, file: string, from: number, to: number): Promise<LocalRun> {
  const runner = RUNNERS[engine];
  if (!fs.existsSync(runner.python)) {
    throw new Error(`${engine} 环境不存在：${runner.python}${engine === 'funasr' ? '（先跑 node tools/local-asr/setup-funasr.mjs）' : ''}`);
  }
  const spec =
    engine === 'whisper'
      ? JSON.stringify({
          file,
          start_time: from,
          end_time: to,
          model: modelId,
          model_dir: path.join(ROOT_DIR, '.venv-asr', 'models'),
          language: 'zh',
          device,
          compute_type: computeType,
          beam_size: 5,
          vad_filter: true,
          offset: 0,
        })
      : JSON.stringify({
          file,
          start_time: from,
          end_time: to,
          model: modelId,
          hub: 'ms',
          device: device === 'cpu' ? 'cpu' : 'auto',
          language: '中文',
          hotwords: (arg('hotwords', '') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
          engine: arg('funasr-engine', 'auto'),
          max_segment_sec: 60,
        });
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    /* 环境变量兜第二层：即使某个 runner 忘了 reconfigure，
       PYTHONUTF8/PYTHONIOENCODING 也能保证管道里是 UTF-8
       （踩过：GBK 字节被按 UTF-8 解码，中文全乱且不报错，CER 直接算出 169%）。 */
    const child = spawn(runner.python, [runner.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', reject);
    child.on('close', () => {
      const elapsedMs = Date.now() - t0;
      try {
        /* 容错解析：第三方库（funasr）会往 stdout 打横幅与进度。
           已经在 runner 里把库的输出改道到 stderr，这里再兜一层 ——
           取**最后一个**能解析出 `ok` 字段的 JSON，避免被杂音带崩。 */
        const candidates = out
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.startsWith('{') && l.endsWith('}'));
        let j: {
          ok: boolean;
          error?: string;
          trace?: string;
          engine?: string;
          notes?: string[];
          segments?: Array<{ start: number; end: number; text: string }>;
          device?: string;
          compute_type?: string;
          asr_ms?: number;
        } | undefined;
        for (const line of candidates.reverse()) {
          try {
            const parsed = JSON.parse(line) as typeof j;
            if (parsed && typeof parsed.ok === 'boolean') {
              j = parsed;
              break;
            }
          } catch {
            /* 试下一个 */
          }
        }
        if (!j) {
          throw new Error(`stdout 里找不到结果 JSON（前 200 字：${out.slice(0, 200)}）`);
        }
        if (!j.ok) {
          return reject(new Error(`${j.error ?? '本地转写失败'}${j.trace ? `\n${j.trace.slice(0, 800)}` : ''}`));
        }
        resolve({
          cues: (j.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text })),
          elapsedMs,
          ...(typeof j.asr_ms === 'number' ? { inferMs: j.asr_ms } : {}),
          device: j.device ?? device,
          computeType: j.compute_type ?? (engine === 'funasr' ? arg('funasr-engine', 'auto')! : computeType),
          engine: j.engine ?? engine,
          ...(j.notes?.length ? { notes: j.notes } : {}),
        });
      } catch (e) {
        reject(new Error(`本地转写输出无法解析：${(e as Error).message}；stderr=${err.slice(-500)}`));
      }
    });
    child.stdin.write(spec, 'utf8');
    child.stdin.end();
  });
}

/* ---------------------------------------------------------------------------
 * 对比
 * ------------------------------------------------------------------------- */
export function perBucketCer(ref: Cue[], hyp: Cue[], bucketSec: number, total: number): Array<{ from: number; to: number; refChars: number; hypChars: number; cer: number }> {
  const bucketText = (cues: Cue[]): Map<number, string> => {
    const m = new Map<number, string>();
    for (const c of cues) {
      const k = Math.floor(c.start / bucketSec);
      m.set(k, (m.get(k) ?? '') + normalize(c.text));
    }
    return m;
  };
  const r = bucketText(ref);
  const h = bucketText(hyp);
  const out: Array<{ from: number; to: number; refChars: number; hypChars: number; cer: number }> = [];
  for (let k = 0; k * bucketSec < total; k++) {
    const rt = r.get(k) ?? '';
    const ht = h.get(k) ?? '';
    if (rt.length === 0 && ht.length === 0) continue;
    out.push({ from: k * bucketSec, to: (k + 1) * bucketSec, refChars: rt.length, hypChars: ht.length, cer: cer(rt, ht).cer });
  }
  return out;
}

/** 每条云端字幕找重叠最多的本地条目，比起点 */
export function timestampAgreement(ref: Cue[], hyp: Cue[]): { matched: number; medianStartDelta: number; p90StartDelta: number; medianDurDelta: number } {
  const overlaps = (a: Cue, b: Cue): number => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const deltas: number[] = [];
  const durDeltas: number[] = [];
  for (const a of ref) {
    let best: Cue | undefined;
    let bestOv = 0;
    for (const b of hyp) {
      const ov = overlaps(a, b);
      if (ov > bestOv) {
        bestOv = ov;
        best = b;
      }
    }
    if (!best || bestOv <= 0) continue;
    deltas.push(best.start - a.start);
    durDeltas.push(best.end - best.start - (a.end - a.start));
  }
  const q = (arr: number[], p: number): number => {
    if (arr.length === 0) return Number.NaN;
    const s = [...arr].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
  };
  return {
    matched: deltas.length,
    medianStartDelta: q(deltas, 0.5),
    p90StartDelta: q(deltas.map(Math.abs), 0.9),
    medianDurDelta: q(durDeltas, 0.5),
  };
}

async function main(): Promise<void> {
  ensureDir(OUT_DIR);
  if (!fs.existsSync(sample)) {
    console.log(`样本不存在：${sample}`);
    console.log(`可先用 ffmpeg 从任意录播截一段：ffmpeg -ss 0 -t ${seconds} -i <录播> -c copy "${sample}"`);
    process.exit(1);
  }
  const sizeMB = fs.statSync(sample).size / 1024 ** 2;
  const which = (arg('local', 'whisper') ?? 'whisper') as 'whisper' | 'funasr' | 'both';
  const engines: LocalEngine[] = which === 'both' ? ['whisper', 'funasr'] : [which];
  console.log(`\x1b[1mASR 质量对比\x1b[0m  云端 fun-asr  vs  本地 ${engines.join(' + ')}`);
  console.log('─'.repeat(84));
  console.log(`样本：${path.relative(ROOT_DIR, sample)}（${sizeMB.toFixed(1)} MB，${seconds} 秒）`);
  console.log(`本地：device=${device} compute_type=${computeType}\n`);

  const result: Record<string, unknown> = { at: nowIso(), sample, seconds, model, device, computeType, engines };

  /* ---- 本地（可同时跑多个引擎做三方对比）---- */
  const locals: Array<{ engine: LocalEngine; name: string; run: LocalRun }> = [];
  for (const eng of engines) {
    const modelId = eng === 'funasr' ? (arg('funasr-model', 'FunAudioLLM/Fun-ASR-Nano-2512') ?? 'FunAudioLLM/Fun-ASR-Nano-2512') : model;
    console.log(`① 本地转写中（${eng}${eng === 'funasr' ? ` / ${modelId}` : ''}）…`);
    try {
      const run = await runLocalTranscribe(eng, modelId, sample, 0, seconds);
      const chars = normalize(run.cues.map((c) => c.text).join('')).length;
      const wall = run.elapsedMs / 1000;
      console.log(
        `   完成：${run.cues.length} 条 / ${chars} 字，墙钟 ${wall.toFixed(1)}s，RTF ${(wall / seconds).toFixed(3)}（引擎 ${run.engine}，${run.device}）`,
      );
      for (const n of run.notes ?? []) console.log(`   \x1b[33m注：${n}\x1b[0m`);
      locals.push({ engine: eng, name: eng === 'funasr' ? `本地 Fun-ASR (${modelId.split('/').pop()})` : `本地 whisper (${model.split('/').pop()})`, run });
      result[`local_${eng}`] = { cues: run.cues.length, chars, wallSec: wall, rtf: wall / seconds, device: run.device, engine: run.engine };
    } catch (e) {
      console.log(`   \x1b[31m失败\x1b[0m：${(e as Error).message.split('\n')[0]}`);
      result[`local_${eng}`] = { error: (e as Error).message.slice(0, 500) };
    }
  }
  if (locals.length === 0) {
    console.log('\n所有本地引擎都失败，无法对比。');
    writeJsonAtomic(path.join(OUT_DIR, 'compare-last.json'), result);
    process.exit(1);
  }

  /* ---- 云端 ---- */
  let cloud: Cue[] | undefined;
  const refPath = arg('ref');
  if (refPath) {
    /* 用已有转写当基准：不花钱、也不受上游抽风影响。
       只取样本时间窗内的段落（转写是源时间轴上的绝对秒）。 */
    const tr = JSON.parse(fs.readFileSync(refPath, 'utf8')) as { segments: Array<{ start: number; end: number; text: string }>; modelId?: string };
    const off = Number(arg('ref-offset', '0'));
    cloud = tr.segments
      .filter((s) => s.end > off && s.start < off + seconds)
      .map((s) => ({ start: Math.max(0, s.start - off), end: Math.max(0, s.end - off), text: s.text }));
    console.log(`② 基准来自已有转写：${path.relative(ROOT_DIR, refPath)}（${cloud.length} 条落在样本窗内，模型 ${tr.modelId ?? '?'}）`);
    result['cloud'] = { cues: cloud.length, chars: normalize(cloud.map((c) => c.text).join('')).length, source: refPath };
  } else if (localOnly) {
    console.log('② 云端：已跳过（--local-only）');
  } else {
    console.log(`② 云端转写中（预计花费 ¥${((seconds / 3600) * 2).toFixed(2)}）…`);
    const cfg = loadConfig().config;
    const client = BiliLiveClient.fromConfig(cfg);
    const t0 = Date.now();
    try {
      /* ⚠️ 必须传**绝对路径**：biliLive-tools 是独立进程，工作目录与我们不同，
         传相对路径会得到 "Error opening input file ... No such file or directory"
         并被它包装成含糊的「字幕识别失败」（踩过：以为云端又坏了，其实是路径问题）。 */
      const srt = await client.subtitle({ file: path.resolve(sample), startTime: 0, endTime: seconds, offset: 0, retry: 1 });
      const wall = (Date.now() - t0) / 1000;
      cloud = parseSrt(srt);
      const cloudChars = normalize(cloud.map((c) => c.text).join('')).length;
      console.log(`   完成：${cloud.length} 条 / ${cloudChars} 字，墙钟 ${wall.toFixed(1)}s，RTF ${(wall / seconds).toFixed(3)}`);
      result['cloud'] = { cues: cloud.length, chars: cloudChars, wallSec: wall, rtf: wall / seconds, costCny: (seconds / 3600) * 2 };
      fs.writeFileSync(path.join(OUT_DIR, 'last-cloud.srt'), srt, 'utf8');
    } catch (e) {
      console.log(`   \x1b[31m失败\x1b[0m：${(e as Error).message}`);
      console.log('   （云端失败不影响本地结论；也可用 --local-only 跳过云端）');
    }
  }

  /* ---- 对比 ---- */
  if (!cloud || cloud.length === 0) {
    writeJsonAtomic(path.join(OUT_DIR, 'compare-last.json'), result);
    console.log('\n没有云端结果可比，仅保存本地结果。');
    return;
  }

  console.log('\n③ 对比');
  const refText = normalize(cloud.map((c) => c.text).join(''));
  const cloudInfo = result['cloud'] as { wallSec?: number; rtf?: number; source?: string };
  const cloudWall = cloudInfo.wallSec;
  const cloudRtf = cloudInfo.rtf;

  interface Metrics {
    name: string;
    cues: number;
    chars: number;
    wall: number;
    /** 纯推理秒数（有就用它算 RTF） */
    inferSec?: number;
    rtf: number;
    cer: number;
    dist: number;
    ts: ReturnType<typeof timestampAgreement>;
    buckets: ReturnType<typeof perBucketCer>;
    bad: ReturnType<typeof perBucketCer>;
  }
  const metrics: Metrics[] = [];
  for (const l of locals) {
    const hypText = normalize(l.run.cues.map((c) => c.text).join(''));
    // 30 分钟以上全量矩阵会很大，做一次规模保护（4000 万格以内才全量算）
    const overall =
      refText.length * hypText.length <= 40_000_000
        ? cer(refText, hypText)
        : (() => {
            const b = perBucketCer(cloud, l.run.cues, 10, seconds);
            const w = Math.max(1, b.reduce((a, x) => a + x.refChars, 0));
            return { cer: b.reduce((a, x) => a + x.cer * x.refChars, 0) / w, dist: -1, refLen: refText.length };
          })();
    const buckets = perBucketCer(cloud, l.run.cues, 60, seconds);
    /* RTF 用**纯推理**耗时算：模型加载是冷启动的一次性成本，
       混进来会把本地引擎的 RTF 算高 3～5 倍（实测 Fun-ASR：推理 0.17 vs 含加载 0.49）。 */
    const inferSec = l.run.inferMs !== undefined ? l.run.inferMs / 1000 : undefined;
    const rtf = (inferSec ?? l.run.elapsedMs / 1000) / seconds;
    metrics.push({
      name: l.name,
      cues: l.run.cues.length,
      chars: hypText.length,
      wall: l.run.elapsedMs / 1000,
      ...(inferSec !== undefined ? { inferSec } : {}),
      rtf,
      cer: overall.cer,
      dist: overall.dist,
      ts: timestampAgreement(cloud, l.run.cues),
      buckets,
      bad: buckets.filter((b) => b.cer > 0.3).sort((a, b) => b.cer - a.cer),
    });
    result[`metrics_${l.engine}`] = {
      cer: overall.cer,
      wallSec: l.run.elapsedMs / 1000,
      ...(inferSec !== undefined ? { inferSec } : {}),
      rtf,
      timestamps: metrics.at(-1)!.ts,
    };
  }

  const cloudCost = cloudInfo.source ? 0 : (seconds / 3600) * 2;
  const colW = 22;
  const head = '指标'.padEnd(16) + '云端 fun-asr'.padEnd(colW) + metrics.map((m) => m.name.slice(0, colW - 2).padEnd(colW)).join('');
  console.log('');
  console.log(head);
  console.log('─'.repeat(Math.max(84, head.length)));
  const row = (label: string, cloudCell: string, fn: (m: Metrics) => string): void => {
    console.log(label.padEnd(14) + cloudCell.padEnd(colW) + metrics.map((m) => fn(m).padEnd(colW)).join(''));
  };
  row('字幕条数', String(cloud.length), (m) => String(m.cues));
  row('归一化字数', String(refText.length), (m) => String(m.chars));
  row('墙钟(秒)', cloudWall !== undefined ? cloudWall.toFixed(1) : '（复用已有）', (m) => m.wall.toFixed(1));
  row('推理(秒)', '—', (m) => (m.inferSec !== undefined ? m.inferSec.toFixed(1) : '（未拆分）'));
  row('\x1b[1m推理 RTF\x1b[0m', cloudRtf !== undefined ? cloudRtf.toFixed(3) : '—', (m) => m.rtf.toFixed(3));
  row('费用(元)', cloudCost.toFixed(2), () => '0.00');
  row('\x1b[1mCER\x1b[0m', '\x1b[90m（基准）\x1b[0m', (m) => `\x1b[1m${(m.cer * 100).toFixed(2)}%\x1b[0m`);
  row('时间戳中位偏差', '—', (m) => `${m.ts.medianStartDelta >= 0 ? '+' : ''}${m.ts.medianStartDelta.toFixed(2)}s`);
  row('合成 4h15m 需时', cloudRtf !== undefined ? `${((15357 * cloudRtf) / 60).toFixed(1)} 分钟` : '—', (m) => `${((15357 * m.rtf) / 60).toFixed(1)} 分钟`);
  console.log('');
  for (const m of metrics) {
    console.log(
      `${m.name}：CER ${(m.cer * 100).toFixed(2)}%` +
        (m.dist >= 0 ? `（编辑距离 ${m.dist} / 基准 ${refText.length} 字）` : '（按分桶估算）') +
        `；时间戳 起点偏差中位数 ${m.ts.medianStartDelta >= 0 ? '+' : ''}${m.ts.medianStartDelta.toFixed(2)}s，p90 ${m.ts.p90StartDelta.toFixed(2)}s；` +
        `CER>30% 的分钟桶 ${m.bad.length}/${m.buckets.length}` +
        (m.bad.length ? `（最差 ${m.bad.slice(0, 3).map((b) => `${b.from}-${b.to}s:${(b.cer * 100).toFixed(0)}%`).join(' ')}）` : ''),
    );
  }

  const md = [
    `# ASR 对比：云端 fun-asr vs 本地（${metrics.map((m) => m.name).join('、')}）`,
    '',
    `- 样本：\`${path.relative(ROOT_DIR, sample)}\`（${seconds} 秒，${sizeMB.toFixed(1)} MB）`,
    `- 本机：device=${device}；GPU 见下`,
    `- 时间：${nowIso()}`,
    '',
    '| 指标 | 云端 fun-asr | ' + metrics.map((m) => m.name).join(' | ') + ' |',
    '| --- | ' + '--- |'.repeat(metrics.length + 1),
    `| 字幕条数 | ${cloud.length} | ` + metrics.map((m) => String(m.cues)).join(' | ') + ' |',
    `| 归一化字数 | ${refText.length} | ` + metrics.map((m) => String(m.chars)).join(' | ') + ' |',
    `| 墙钟（秒） | ${cloudWall !== undefined ? cloudWall.toFixed(1) : '（复用已有）'} | ` + metrics.map((m) => m.wall.toFixed(1)).join(' | ') + ' |',
    `| RTF | ${cloudRtf !== undefined ? cloudRtf.toFixed(3) : '—'} | ` + metrics.map((m) => m.rtf.toFixed(3)).join(' | ') + ' |',
    `| 费用（元） | ${cloudCost.toFixed(2)} | ` + metrics.map(() => '0.00').join(' | ') + ' |',
    `| **CER（对云端）** | 基准 | ` + metrics.map((m) => `**${(m.cer * 100).toFixed(2)}%**`).join(' | ') + ' |',
    `| 起点偏差中位数 | — | ` + metrics.map((m) => `${m.ts.medianStartDelta.toFixed(2)}s`).join(' | ') + ' |',
    `| 起点偏差 p90 | — | ` + metrics.map((m) => `${m.ts.p90StartDelta.toFixed(2)}s`).join(' | ') + ' |',
    `| 推算 4h15m 录播耗时 | ${cloudRtf !== undefined ? `${((15357 * cloudRtf) / 60).toFixed(1)} 分钟` : '—'} | ` + metrics.map((m) => `${((15357 * m.rtf) / 60).toFixed(1)} 分钟`).join(' | ') + ' |',
    '',
    '## 分桶（60 秒）CER',
    '',
    '| 区间 | ' + metrics.map((m) => m.name).join(' | ') + ' |',
    '| --- | ' + '--- |'.repeat(metrics.length),
    ...metrics[0]!.buckets.map((b, i) => `| ${b.from}-${b.to}s | ` + metrics.map((m) => `${((m.buckets[i]?.cer ?? 0) * 100).toFixed(0)}%`).join(' | ') + ' |'),
    '',
    '## 逐条对照（按时间重叠配对，不是按序号）',
    '',
    '> 两边分段数不同（一个爱拆句、一个爱合并），按序号排会看成"整体漂移几秒" —— 那是假象。',
    '> 这里按时间重叠配对，并标出「本地缺这条」。',
    '',
    ...metrics.map((m) => {
      const l = locals.find((x) => x.name === m.name)!;
      const rows = cloud.slice(0, 30).map((c) => {
        let best: Cue | undefined;
        let bestOv = 0;
        for (const lc of l.run.cues) {
          const ov = Math.max(0, Math.min(c.end, lc.end) - Math.max(c.start, lc.start));
          if (ov > bestOv) {
            bestOv = ov;
            best = lc;
          }
        }
        const cell = best ? best.text.replace(/\|/g, '/') : '**（缺这条）**';
        const delta = best ? `${best.start - c.start >= 0 ? '+' : ''}${(best.start - c.start).toFixed(1)}s` : '—';
        return `| ${c.start.toFixed(1)}s | ${c.text.replace(/\|/g, '/')} | ${cell} | ${delta} |`;
      });
      return [`### ${m.name}`, '', '| 云端时间 | 云端 | 本地 | 偏差 |', '| --- | --- | --- | --- |', ...rows, ''].join('\n');
    }),
    '',
  ].join('\n');
  const mdPath = path.join(OUT_DIR, `compare-${seconds}s.md`);
  fs.writeFileSync(mdPath, md, 'utf8');
  writeJsonAtomic(path.join(OUT_DIR, 'compare-last.json'), result);
  console.log(`\n报告：${path.relative(ROOT_DIR, mdPath)}`);
  console.log(`数据：${path.relative(ROOT_DIR, path.join(OUT_DIR, 'compare-last.json'))}`);
}

/**
 * 只在**本文件被当作脚本直接执行**时才跑 main()。
 *
 * 为什么必须守卫：`config-compare.ts` 要复用本文件的度量函数（CER / 时间戳对比 / runner），
 * 而 ESM 的 import 会**执行被导入模块的顶层代码** —— 没有这道守卫，
 * 导入一次就会把整个三方对比再跑一遍（实测输出交叠、还白花一次云端调用）。
 */
const isEntry = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isEntry) {
  main().catch((e) => {
    console.error('\x1b[31m对比异常：\x1b[0m', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
