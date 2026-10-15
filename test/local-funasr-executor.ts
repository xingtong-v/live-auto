/**
 * 本地 Fun-ASR **执行器本体**的行为测试（2026-10-15，配合「精确进度」）。
 *
 * 为什么需要它：这个仓库此前只测过 TS 侧（spec 组装 / stdout 解析，见
 * `test/local-funasr-provider.ts`），**从来没有人真正跑过 `transcribe-funasr.py`**。
 * 于是"改一行执行器"的唯一验证方式是等一场真录播（半小时以上）—— 这就是 2026-10-15
 * 我改进度上报与子批推理时最担心的事：万一改坏了，代价是用户下一场转写直接失败。
 *
 * 做法：给执行器喂一个**假的 funasr 模块**（PYTHONPATH 前置），于是：
 *   · 不加载模型、不碰显卡（十几秒跑完，能与正在跑的转写共存，也不吃那几 GB 显存）；
 *   · 但 VAD/推理/分批/结果回填/进度上报**全都是真代码路径**；
 *   · 假模块按 `seg-NNNN.wav` 的文件名回文本 ⇒ 结果与区间的**对齐关系可断言**
 *     （原实现用 `zip(fine, results_items)`，一旦有区间因为太短被跳过就会整体串位，
 *      这种错在真机上表现为"字幕时间全错"，极难查）。
 *
 * 没有 `.venv-funasr` 或 ffmpeg 的机器上**跳过**（与"本地执行器是可选项"的原则一致，
 * 不能让 `npm run verify` 依赖它装没装）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT_DIR } from '../src/util.ts';

let pass = 0;
let fail = 0;
let skipped = 0;
const failures: string[] = [];
function ok(title: string, cond: unknown, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${title}`);
  } else {
    fail++;
    failures.push(`${title}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${title}${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq(title: string, got: unknown, want: unknown): void {
  ok(title, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function skip(title: string, why: string): void {
  skipped++;
  console.log(`  \x1b[33m~\x1b[0m ${title} —— 跳过：${why}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const PY = path.join(ROOT_DIR, '.venv-funasr', 'Scripts', 'python.exe');
const SCRIPT = path.join(ROOT_DIR, 'tools', 'local-asr', 'transcribe-funasr.py');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'funasr-exec-test-'));

/* ---------- 假 funasr 模块 ---------- */
const FAKE_DIR = path.join(TMP, 'fakelib');
fs.mkdirSync(path.join(FAKE_DIR, 'funasr'), { recursive: true });
fs.writeFileSync(
  path.join(FAKE_DIR, 'funasr', '__init__.py'),
  `
import json, os, re, sys

LOG = os.environ.get("FAKE_FUNASR_LOG", "")

def _log(row):
    if LOG:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\\n")

class _Model:
    def __init__(self, model=None, **kw):
        self.model = model or ""
        self.is_vad = "vad" in self.model.lower()

    def generate(self, input=None, **kw):
        if self.is_vad:
            import soundfile as sf
            info = sf.info(input)
            # 每 1.5 秒一段，留 0.2 秒缝 —— 段数足够多，才能把"子批"真的切出来
            spans = []
            t = 0.0
            while t < info.duration:
                e = min(info.duration, t + 1.5)
                if e - t > 0.05:
                    spans.append([int(t * 1000), int(e * 1000)])
                t = e + 0.2
            _log({"kind": "vad", "spans": len(spans), "duration": info.duration})
            return [{"value": spans}]
        paths = input if isinstance(input, list) else [input]
        if os.environ.get("FAKE_FAIL_FIRST_BATCH") and not os.path.exists(LOG + ".failed"):
            open(LOG + ".failed", "w").close()
            _log({"kind": "asr", "batch": len(paths), "failed": True})
            raise RuntimeError("假模块：这一批故意失败（验退化路径）")
        _log({"kind": "asr", "batch": len(paths), "paths": [os.path.basename(p) for p in paths]})
        out = []
        for p in paths:
            m = re.search(r"seg-(\\d+)\\.wav$", os.path.basename(p))
            out.append({"text": "seg%s" % (m.group(1) if m else "?")})
        return out

def AutoModel(model=None, **kw):
    return _Model(model=model, **kw)
`,
);

function havePy(): boolean {
  return fs.existsSync(PY);
}

/** 造一段 12 秒的音频（用 ffmpeg 的 sine，纯本地、无需素材） */
function makeWav(seconds: number): string | undefined {
  const wav = path.join(TMP, `in-${seconds}.wav`);
  if (fs.existsSync(wav)) return wav;
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-ar', '16000', '-ac', '1', wav], { encoding: 'utf8' });
  return r.status === 0 && fs.existsSync(wav) ? wav : undefined;
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

/** 跑一次真执行器（假 funasr） */
function runExecutor(spec: Record<string, unknown>, env: Record<string, string> = {}): RunResult {
  const log = path.join(TMP, `calls-${Math.random().toString(36).slice(2)}.jsonl`);
  const r = spawnSync(PY, [SCRIPT], {
    input: JSON.stringify(spec),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONPATH: FAKE_DIR,
      FAKE_FUNASR_LOG: log,
      ...env,
    },
  });
  return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), status: r.status, ...{ calls: log } } as RunResult;
}

function callsOf(res: RunResult): Array<Record<string, unknown>> {
  const file = (res as unknown as { calls: string }).calls;
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function jsonOf(res: RunResult): Record<string, unknown> {
  const line = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.endsWith('}'))
    .pop();
  return line ? (JSON.parse(line) as Record<string, unknown>) : {};
}

function progressOf(res: RunResult): Array<Record<string, unknown>> {
  return res.stderr
    .split(/\r?\n/)
    .filter((l) => l.includes('##ASR-PROGRESS##'))
    .map((l) => JSON.parse(l.slice(l.indexOf('##ASR-PROGRESS##') + '##ASR-PROGRESS##'.length).trim()) as Record<string, unknown>);
}

section('0. 前置条件（缺了就不测，绝不让 verify 依赖可选执行器）');
if (!havePy()) {
  skip('执行器行为测试', `没有 ${path.relative(ROOT_DIR, PY)}（本机未装本地 Fun-ASR 时可跳过）`);
} else {
  const wav = makeWav(12);
  if (!wav) {
    skip('执行器行为测试', '本机 PATH 里没有 ffmpeg');
  } else {
    ok('前置就绪：解释器 + ffmpeg + 执行器脚本', fs.existsSync(SCRIPT));

    /* ---------- 1. 子批 + 进度上报 ---------- */
    section('1. 子批推理与"实测进度"上报（progress_batch_sec=4，12 秒音频 ⇒ 应切出多批）');
    const spec = {
      file: wav,
      start_time: 0,
      end_time: 12,
      offset: 0,
      model: 'FunAudioLLM/Fun-ASR-Nano-2512',
      hub: 'ms',
      device: 'cpu',
      engine: 'pytorch',
      timestamps: true,
      progress_batch_sec: 4,
    };
    const res = runExecutor(spec);
    const out = jsonOf(res);
    const ticks = progressOf(res);
    const calls = callsOf(res);

    eq('执行器成功返回（假模块下也走完整条真实代码路径）', out['ok'], true);
    eq('失败时也带上错误（没有静默）', res.status, 0);

    const phases = ticks.map((t) => String(t['phase']));
    ok('进度里出现了四个阶段（抽取音频 / 切句 / 加载模型 / 识别）', ['extract', 'vad', 'load', 'asr'].every((p) => phases.includes(p)), phases.join(','));
    const asrTicks = ticks.filter((t) => t['phase'] === 'asr');
    ok('识别阶段报了多次（子批切开了）', asrTicks.length >= 3, `asr ticks=${asrTicks.length}`);
    ok(
      '已推进位置单调不减（界面上进度条不会来回跳）',
      asrTicks.every((t, i) => i === 0 || Number(t['done_sec']) >= Number(asrTicks[i - 1]!['done_sec'])),
      asrTicks.map((t) => t['done_sec']).join(','),
    );
    eq('最后一个识别 tick 报"到末尾"（否则界面永远停在 99%）', Number(asrTicks[asrTicks.length - 1]!['done_sec']), 12);
    eq('句子进度最终 = 总句数', asrTicks[asrTicks.length - 1]!['seg_done'], asrTicks[asrTicks.length - 1]!['seg_total']);
    ok('每个识别 tick 都带**实测速度**（音频秒/墙上秒）', asrTicks.every((t) => Number(t['speed']) > 0), JSON.stringify(asrTicks[0]));
    ok('识别 tick 带 elapsed_ms（用来算单块固定成本 ≈90–100 秒）', asrTicks.every((t) => Number(t['elapsed_ms']) >= 0));
    ok('结果 JSON 里有 progress 汇总（批数/句数/速度）', Number((out['progress'] as Record<string, unknown>)?.['batches']) >= 2, JSON.stringify(out['progress']));

    const asrCalls = calls.filter((c) => c['kind'] === 'asr');
    ok('假模块证实"确实分了多批"（不是把全部句子一次喂进去）', asrCalls.length >= 3, `批次=${asrCalls.length}`);
    const fed = asrCalls.reduce((a, c) => a + Number(c['batch'] ?? 0), 0);
    eq('★ 每一句都只喂了一次（数量守恒：不漏不重）', fed, Number(out['segments_input']));
    eq('批次数量与结果里报的一致', asrCalls.length, Number((out['progress'] as Record<string, unknown>)?.['batches']));

    /* ---------- 2. 对齐：结果不能被"太短的区间被跳过"带偏 ---------- */
    section('2. 结果与区间的对齐（原实现用 zip(fine, results) —— 一旦跳过就会整体串位）');
    const segs = (out['segments'] ?? []) as Array<{ start: number; end: number; text: string }>;
    ok('有字幕产出', segs.length > 0, String(segs.length));
    ok(
      '★ 字幕按时间递增，且文本里的段号也递增（串位会立刻暴露）',
      segs.every((s, i) => i === 0 || (s.start >= segs[i - 1]!.start && Number(s.text.replace('seg', '')) > Number(segs[i - 1]!.text.replace('seg', '')))),
      segs.slice(0, 6).map((s) => `${s.start}:${s.text}`).join(' | '),
    );
    eq('第一条字幕的文本 = 第一段的编号（区间与文本一一对应）', segs[0]?.text, 'seg0000');
    ok('全段都回来了（没有任何一段丢结果）', segs.length === Number(out['segments_input']), `${segs.length} vs ${out['segments_input']}`);

    /* ---------- 3. 关掉分批 = 历史行为 ---------- */
    section('3. progress_batch_sec=0：关掉分批（对照组，行为应与历史一致）');
    const res0 = runExecutor({ ...spec, progress_batch_sec: 0 });
    const out0 = jsonOf(res0);
    const asr0 = callsOf(res0).filter((c) => c['kind'] === 'asr');
    eq('只调用一次 generate（"一次喂完"）', asr0.length, 1);
    eq('一次喂进的段数 = 全部句子', asr0[0]?.['batch'], out0['segments_input']);
    eq('结果照样正确', (out0['segments'] as unknown[])?.length, out0['segments_input']);
    eq('关掉分批时进度里只有 1 批', Number((out0['progress'] as Record<string, unknown>)?.['batches']), 1);

    /* ---------- 4. 批次失败 ⇒ 退化到逐段（不能整块失败） ---------- */
    section('4. 一批失败时的退化路径（原逻辑是"整批失败 ⇒ 逐段重试"，分批后必须按批退化）');
    const resF = runExecutor({ ...spec, progress_batch_sec: 4 }, { FAKE_FAIL_FIRST_BATCH: '1' });
    const outF = jsonOf(resF);
    const callsF = callsOf(resF);
    eq('仍然成功返回（一批失败不至于整块失败）', outF['ok'], true);
    ok('结果里标注了有批次退化', /退化/.test(String(outF['batch_note'])), String(outF['batch_note']));
    eq('退化后字幕照样齐全', (outF['segments'] as unknown[])?.length, outF['segments_input']);
    const asrCallsF = callsF.filter((c) => c['kind'] === 'asr');
    ok(
      '★ 退化的那一批是**逐段**调用的（出现 batch=1 的调用，而不是整批重来）',
      asrCallsF.some((c) => Number(c['batch']) === 1),
      asrCallsF.map((c) => c['batch']).join(','),
    );
    /* ⚠️ 守恒要数**成功的**投喂：失败那一次也进了日志（带 failed:true），
       把它算进去会得出"喂了 11 段 / 只有 8 段"这种假警报（这一条正是被自己的断言抓出来的）。 */
    const fedF = asrCallsF.filter((c) => c['failed'] !== true).reduce((a, c) => a + Number(c['batch'] ?? 0), 0);
    eq('★ 退化路径下句子照样数量守恒（不漏不重 —— 这是"结果与区间对齐"的前提）', fedF, Number(outF['segments_input']));
  }
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}${skipped ? ` SKIP=${skipped}` : ''}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败不影响结论 */
}
process.exitCode = fail === 0 ? 0 : 1;
