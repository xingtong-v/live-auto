/**
 * 本地 Fun-ASR provider 的单元验证（纯逻辑，零网络、零费用、不加载模型）。
 *
 * 为什么这些必须测：它们错了的表现是**跑了几十分钟才失败**，或者更糟 ——
 * 时间戳整体错位而"看起来都在范围内"。所以把可纯函数化的部分全部拉出来测：
 *
 *  1. `buildLocalAsrSpec`：whisper 与 funasr **两套字段不能串**（串了对面直接报错或静默走默认值）；
 *  2. `parseLocalAsrOutput`：第三方库会往 stdout 打横幅与进度，不能 `JSON.parse(stdout)`；
 *  3. `mergeWindowsPerFile`：多分段任务里"每个文件一次调用"的合并**必须按文件分组** ——
 *     直接取第一个窗口拉成整场会让后续分段的全局时间戳整体错位；
 *  4. offset 语义：本地执行器输出的时间戳要加上 offset 才能拼回全局时间。
 *
 * 用法：node test/local-funasr-provider.ts
 */
import { buildLocalAsrSpec, mergeWindowsPerFile, parseLocalAsrOutput } from '../src/asr.ts';
import type { WindowCall } from '../src/asr.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string, extra?: string): void {
  if (cond) pass++;
  else {
    fail++;
    failures.push(msg);
  }
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${msg}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`);
}
function eq<T>(msg: string, actual: T, expected: T): void {
  ok(actual === expected, msg, actual === expected ? undefined : `期望 ${String(expected)}，实际 ${String(actual)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const funasrOpts = {
  engine: 'funasr' as const,
  pythonPath: 'F:/x/.venv-funasr/Scripts/python.exe',
  scriptPath: 'F:/x/tools/local-asr/transcribe-funasr.py',
  model: 'FunAudioLLM/Fun-ASR-Nano-2512',
  modelDir: '',
  language: '中文',
  device: 'auto',
  computeType: 'n/a',
  beamSize: 0,
  vadFilter: true,
  timeoutMs: 3600_000,
  hub: 'ms',
  enginePreference: 'auto',
  maxCharsPerCue: 18,
  minCueDur: 0.6,
  timestamps: true,
};

const whisperOpts = {
  engine: 'whisper' as const,
  pythonPath: 'F:/x/.venv-asr/Scripts/python.exe',
  scriptPath: 'F:/x/tools/local-asr/transcribe.py',
  model: 'dropbox-dash/faster-whisper-large-v3-turbo',
  modelDir: 'F:/x/.venv-asr/models',
  language: 'zh',
  device: 'cuda',
  computeType: 'float16',
  beamSize: 5,
  vadFilter: true,
  timeoutMs: 3600_000,
};

const w = (o: Partial<WindowCall> = {}): WindowCall => ({
  file: 'C:/rec/a.flv',
  inFileStart: 0,
  inFileEnd: 1800,
  globalStart: 0,
  globalEnd: 1800,
  offset: 0,
  windowIndex: 0,
  ...o,
});

console.log('\x1b[1m本地 Fun-ASR provider 验证\x1b[0m（纯逻辑）');
console.log('─'.repeat(74));

/* ================= 1. spec 组装 ================= */
section('1. spec 组装（两套字段不能串）');
{
  const s = buildLocalAsrSpec(funasrOpts, { file: 'C:/a.flv', startTime: 0, endTime: 300, offset: 0 });
  eq('带上了模型', s['model'], 'FunAudioLLM/Fun-ASR-Nano-2512');
  eq('hub = ms（国内快）', s['hub'], 'ms');
  eq('engine = auto（优先 vLLM，失败退 PyTorch）', s['engine'], 'auto');
  eq('语言是「中文」（Fun-ASR 的取值，不是 zh）', s['language'], '中文');
  eq('字级时间戳开启', s['timestamps'], true);
  eq('每句字数上限', s['max_chars_per_cue'], 18);
  eq('最短显示时长', s['min_cue_dur'], 0.6);
  ok(!('beam_size' in s), '**不带** whisper 的 beam_size（串了对面会报未知参数）');
  ok(!('compute_type' in s), '**不带** whisper 的 compute_type');
  ok(!('model_dir' in s), '**不带** whisper 的 model_dir');

  const sw = buildLocalAsrSpec(whisperOpts, { file: 'C:/a.flv', startTime: 60, endTime: 120, offset: 30 });
  eq('whisper 仍带 model_dir', sw['model_dir'], 'F:/x/.venv-asr/models');
  eq('whisper 仍带 compute_type', sw['compute_type'], 'float16');
  eq('whisper 仍带 beam_size', sw['beam_size'], 5);
  ok(!('hub' in sw) && !('timestamps' in sw), 'whisper 的 spec 里没有 funasr 专有字段（回归保护）');
  eq('时间窗正确传递', `${sw['start_time']}-${sw['end_time']}`, '60-120');
  eq('offset 传递（用于把文件内时间拼回全局）', sw['offset'], 30);

  // timestamps=false 时要显式关掉（否则时间戳退化而用户不知道为什么）
  const off = buildLocalAsrSpec({ ...funasrOpts, timestamps: false }, { file: 'C:/a.flv', startTime: 0, endTime: 60, offset: 0 });
  eq('可以显式关掉字级时间戳', off['timestamps'], false);
}

/* ================= 2. 输出解析 ================= */
section('2. 输出解析（第三方库会往 stdout 打杂音）');
{
  const clean = parseLocalAsrOutput('{"ok":true,"segments":[{"start":1,"end":2,"text":"你好"}]}');
  ok(clean.ok && clean.segments?.length === 1, '正常输出能解析');

  // 实测：funasr 在 import 时打版本横幅，模型加载也会打进度
  const noisy = [
    'funasr version: 1.4.16',
    'Downloading: 100%|####| 21/21',
    '2026-09-23 04:26:57 [INFO] rank: 0, model is builded.',
    '{"ok":true,"segments":[{"start":0.95,"end":2.45,"text":"我开了一下小风扇，"}]}',
  ].join('\n');
  const parsed = parseLocalAsrOutput(noisy);
  ok(parsed.ok, '带横幅/进度的输出也能解析（取最后一个带 ok 的 JSON 行）');
  eq('拿到的是最后那条结果', parsed.segments?.[0]?.text, '我开了一下小风扇，');

  // 报错时也要能解析出来（否则用户只看到"输出不是合法 JSON"，看不到真因）
  const errOut = '{"ok":false,"error":"RuntimeError: CUDA out of memory","trace":"..."}';
  const e = parseLocalAsrOutput(errOut);
  eq('错误输出被解析出来', e.ok, false);
  ok((e.error ?? '').includes('CUDA out of memory'), '错误信息完整保留');

  let threw = false;
  try {
    parseLocalAsrOutput('完全是垃圾输出，没有任何 JSON');
  } catch (ex) {
    threw = true;
    ok((ex as Error).message.includes('找不到结果 JSON'), '垃圾输出 → 抛带上下文可查的错误');
  }
  ok(threw, '垃圾输出不会静默返回空结果');
}

/* ================= 3. 按文件合并窗口 ================= */
section('3. 多分段任务的窗口合并（这里错了时间戳会整体错位）');
{
  // 单个文件 3 个窗口（90 分钟）→ 合成 1 个
  const single = [w({ inFileStart: 0, inFileEnd: 1800, globalStart: 0, globalEnd: 1800 }), w({ inFileStart: 1740, inFileEnd: 3540, globalStart: 1740, globalEnd: 3540 }), w({ inFileStart: 3480, inFileEnd: 5400, globalStart: 3480, globalEnd: 5400 })];
  const merged = mergeWindowsPerFile(single);
  eq('同一文件的 3 个窗口合成 1 个', merged.length, 1);
  eq('覆盖整个文件（从头）', merged[0]?.inFileStart, 0);
  eq('覆盖到最后一个窗口的末尾', merged[0]?.inFileEnd, 5400);
  eq('全局区间也对', `${merged[0]?.globalStart}-${merged[0]?.globalEnd}`, '0-5400');

  // 多分段：文件 A 0–1800，文件 B 1800–3600（每文件 2 个窗口）
  const multi = [
    w({ file: 'C:/rec/a.flv', inFileStart: 0, inFileEnd: 900, globalStart: 0, globalEnd: 900, windowIndex: 0 }),
    w({ file: 'C:/rec/a.flv', inFileStart: 840, inFileEnd: 1800, globalStart: 840, globalEnd: 1800, windowIndex: 1 }),
    w({ file: 'C:/rec/b.flv', inFileStart: 0, inFileEnd: 900, globalStart: 1800, globalEnd: 2700, windowIndex: 2 }),
    w({ file: 'C:/rec/b.flv', inFileStart: 840, inFileEnd: 1800, globalStart: 2640, globalEnd: 3600, windowIndex: 3 }),
  ];
  const m2 = mergeWindowsPerFile(multi);
  eq('两个文件 → 两次调用（不能合成一次）', m2.length, 2);
  eq('第一个文件的全局起点', m2[0]?.globalStart, 0);
  eq('第一个文件的全局终点', m2[0]?.globalEnd, 1800);
  eq('**第二个文件的全局起点保持 1800**（不能被拉成 0）', m2[1]?.globalStart, 1800);
  eq('第二个文件的文件内终点', m2[1]?.inFileEnd, 1800);
  ok(
    m2.every((x) => x.inFileStart === 0),
    '每个文件都从它自己的 0 开始（文件内时间）',
  );
  ok(m2[0]!.file !== m2[1]!.file, '两次调用用的是不同文件');

  eq('空输入返回空', mergeWindowsPerFile([]).length, 0);
}

/* ================= 4. offset 语义 ================= */
section('4. offset 语义（本地输出 + offset = 全局时间）');
{
  // 与 transcribe.py 完全一致：runner 负责加 offset，调用方不再叠加
  const spec = buildLocalAsrSpec(funasrOpts, { file: 'C:/rec/b.flv', startTime: 0, endTime: 900, offset: 1800 });
  eq('offset 进入 spec', spec['offset'], 1800);
  eq('文件内起点仍是 0（不是全局 1800）', spec['start_time'], 0);
  /* runner 侧：_cues_from_stamps 出来的时间是"文件内"的，最后统一 +offset。
     这里用一段等价计算做交叉验证，防止哪天有人在调用方又加一次 offset（双重叠加）。 */
  const fileLocalSegments = [{ start: 1.5, end: 3.0 }];
  const offset = Number(spec['offset']);
  const global = fileLocalSegments.map((s) => ({ ...s, start: s.start + offset, end: s.end + offset }));
  eq('拼接后的全局起点', global[0]?.start, 1801.5);
  eq('拼接后的全局终点', global[0]?.end, 1803);
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
}
if (fail > 0) process.exitCode = 1;
