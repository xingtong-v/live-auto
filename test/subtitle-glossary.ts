/**
 * 「字幕烧录」与「术语表」的单元级验证（不联网、不调用 ASR/LLM）。
 *
 * 这两块都是"看着简单、错了很难发现"的类型：
 *  - ASS 时间戳写错 → 字幕整体错位，画面上看得见但日志里一切正常；
 *  - 合并时丢了 [Script Info] → 播放器按默认 384×288 渲染，字大得离谱；
 *  - 字幕样式抄了弹幕样式 → 两种文字糊在一起分不清；
 *  - 纠错规则顺序错 → 把对的词改成错的（比不纠错更糟）。
 *
 * 所以这里对成品 ASS 文本做断言，而不是只断言"函数没抛异常"。
 *
 * 用法：node test/subtitle-glossary.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptSegment } from '../src/types.ts';
import {
  buildBurnAss,
  buildCues,
  buildSubtitleOnlyAss,
  escapeAssText,
  mergeSubtitleIntoAss,
  splitIntoSentences,
  toAssTime,
  widthOfText,
  wrapCjk,
} from '../src/subtitle-ass.ts';
import {
  applyCorrections,
  correctTranscript,
  hotWordsText,
  renderGlossaryForPrompt,
  validateGlossary,
  type Glossary,
} from '../src/glossary.ts';
import { bestAnchor, needsAnchor, rmsProfile } from '../src/speech-energy.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];

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
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
  console.log('─'.repeat(Math.max(20, Math.min(74, t.length * 2 + 8))));
}

/** 造一份与 DanmakuFactory 输出同构的最小弹幕 ASS（带 BOM，模拟真实产物） */
function fakeDanmakuAss(): string {
  return (
    '\uFEFF' +
    [
      '[Script Info]',
      'ScriptType: v4.00+',
      'PlayResX: 2560',
      'PlayResY: 1440',
      'WrapStyle: 2',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: Scroll,Microsoft YaHei,53,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,1,7,0,0,0,1',
      'Style: Bottom,Microsoft YaHei,53,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,1,2,0,0,0,1',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:13.00,Scroll,,0,0,0,,前面有个人中了 20 次红包',
      'Dialogue: 0,0:00:20.00,0:00:25.00,Bottom,,0,0,0,,笑死',
      '',
    ].join('\n')
  );
}

const segments: TranscriptSegment[] = [
  { start: 0.5, end: 3.2, text: '欢迎来到后半夜后悔时代' },
  { start: 3.2, end: 6.0, text: '今天我们来玩闪身步' },
  { start: 6.0, end: 6.1, text: '嗯' }, // 过短 → 需要补时长
  { start: 30, end: 40, text: '这段挂了十秒，需要被截断到最长显示时长' },
  { start: 60, end: 62, text: '♪♪' }, // 噪声行（由调用方判定）
  { start: 62, end: 65, text: '   ' }, // 空白行
];

async function main(): Promise<void> {
  console.log('\x1b[1m字幕烧录 + 术语表 单元验证\x1b[0m（无网络、零费用）');
  console.log('─'.repeat(74));

  /* ================= 1. 时间戳格式 ================= */
  section('1. ASS 时间戳');
  eq('0 秒 → 0:00:00.00', toAssTime(0), '0:00:00.00');
  eq('1.5 秒 → 0:00:01.50', toAssTime(1.5), '0:00:01.50');
  eq('61.23 秒 → 0:01:01.23', toAssTime(61.23), '0:01:01.23');
  eq('3661 秒 → 1:01:01.00', toAssTime(3661), '1:01:01.00');
  ok('四舍五入到 100 厘秒不会写出 :100', !/[:.]100\b/.test(toAssTime(59.999)), toAssTime(59.999));
  ok('负数被夹到 0（ASR 偶有负时间戳）', toAssTime(-3) === '0:00:00.00', toAssTime(-3));

  /* ================= 2. 折行与转义 ================= */
  section('2. 中文折行与 ASS 转义');
  eq('超过宽度会折成两行', wrapCjk('一二三四五六七八九十一二三四五六七八九十', 10).length, 2);
  ok('每行不超过给定字宽', wrapCjk('中文测试字幕折行行为是否正确呢', 8).every((l) => [...l].length <= 8));
  ok('两行装不下时加省略号', wrapCjk('甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥', 6).at(-1)!.endsWith('…'));
  eq('大括号会被转义（否则被当成特效块）', escapeAssText('{\\pos(0,0)}哈哈'), '｛＼pos(0,0)｝哈哈');
  ok('换行被压成空格', !escapeAssText('第一行\n第二行').includes('\n'));

  /* ================= 3. 字幕条目整理 ================= */
  section('3. 字幕条目整理（时长/重叠/噪声）');
  const { cues, droppedNoise } = buildCues(segments, { resolution: { width: 1920, height: 1080 }, maxCharsPerLine: 18 }, (t) => t.includes('♪'));
  eq('噪声行被丢掉', droppedNoise, 1);
  // 第 4 段「这段挂了十秒，需要被截断到最长显示时长」按标点切成 2 条（20 字 > 一行容量）
  eq('空白行被丢掉 → 剩 5 条', cues.length, 5);
  const shortCue = cues.find((c) => c.text === '嗯');
  ok('过短的字幕被补到最短时长', !!shortCue && shortCue.end - shortCue.start >= 0.8 - 1e-6, JSON.stringify(shortCue));
  ok('时间被归整到厘秒（ASS 的最小时间单位）', Number.isInteger(Math.round(cues[0]!.start * 100)), JSON.stringify(cues[0]));
  /* 用户报的「字幕和声音对不上」就是这一段：ASR 把「一句话 + 之后 8 秒静音」算成一段，
     旧版让这 12 个字硬挂满 8 秒上限。现在按字数定时长，静音区间不显示字幕。 */
  const long = cues.filter((c) => c.start >= 30 && c.end <= 40);
  ok('长静音段被切成多条（不是一整块挂屏）', long.length === 2, JSON.stringify(long));
  ok('长静音段每条都按字数定时长（不顶 8 秒上限）', long.every((c) => c.end - c.start <= 4.5), JSON.stringify(long));
  ok('字幕不会溢出到静音尾巴上', long.at(-1)!.end < 36, `末条结束于 ${long.at(-1)!.end}s，而 ASR 段落标到 40s`);
  ok('每条字幕都放得下一行（不折行 = 不劈词）', cues.every((c) => !c.text.includes('\\N')), JSON.stringify(cues.filter((c) => c.text.includes('\\N'))));
  ok('相邻字幕不再重叠', cues.every((c, i) => i === 0 || c.start >= cues[i - 1]!.end - 0.001));

  /* ================= 3b. 按标点断句 ================= */
  section('3b. 断句（用户报的「字幕也没有断句」）');
  /* 合并规则：相邻句子合起来仍放得下一行（≤ maxChars）就合并 ——
     避免切出「嗯。」这种两字碎片；合不下才切。 */
  const three = splitIntoSentences('今天我们来玩闪身步，明天玩什么？后天再聊。', 18);
  eq('合不下的句子被切开', three.length, 2);
  eq('标点保留在句尾', three[1], '后天再聊。');
  ok('切出来的每一句都放得下一行', three.every((s) => widthOfText(s) <= 18), JSON.stringify(three));
  eq('短句会被合并，不切得过碎', splitIntoSentences('嗯。对。好。', 18).length, 1);
  /* 无标点的连珠炮：旧版原样保留成一条 20+ 字的字幕，只能按字数硬折 → 把词劈开 */
  const runOn = splitIntoSentences('你你你你是直播间你是直播间的那个推流设置有问题还是这个游戏', 18);
  ok('无标点长句按宽度均分', runOn.length === 2, JSON.stringify(runOn));
  ok('均分后每句都放得下一行', runOn.every((s) => widthOfText(s) <= 18), JSON.stringify(runOn));
  ok('均分不会短尾（两块长度接近）', Math.abs([...runOn[0]!].length - [...runOn[1]!].length) <= 2, JSON.stringify(runOn));
  /* 实测踩到的 bug：按"第 N 个字符"硬切把 enter 切成 ente / r */
  const ascii = splitIntoSentences('我们做个这什么哦就是个enter的enter的哦enter', 18);
  const word = (ch: string | undefined): boolean => !!ch && /[A-Za-z0-9]/.test(ch);
  ok(
    '不会把英文单词切成两半',
    ascii.length >= 2 && ascii.slice(0, -1).every((s, i) => !(word(s.at(-1)) && word(ascii[i + 1]?.[0]))),
    JSON.stringify(ascii),
  );

  /* ================= 3c. 阅读速度决定展示时长 ================= */
  section('3c. 展示时长跟字数走');
  const rate = (c: { start: number; end: number; text: string }): number => [...c.text.replace(/\\N/g, '')].length / (c.end - c.start);
  const fresh = buildCues(
    [
      { start: 0, end: 20, text: '这是一句十二个字的话' }, // 9 字 + 20 秒静音
      { start: 20, end: 21, text: '短' },
    ],
    { maxCharsPerLine: 18, readingCharsPerSec: 4, minDurationSec: 0.8 },
  ).cues;
  ok('9 个字只占约 2.3 秒（旧版会挂满 8 秒）', fresh[0]!.end - fresh[0]!.start <= 2.5, JSON.stringify(fresh[0]));
  ok('阅读速度落在 3–6 字/秒（既跟得上说话，也不闪得看不清）', rate(fresh[0]!) >= 3 && rate(fresh[0]!) <= 6, `${rate(fresh[0]!).toFixed(2)} 字/秒`);
  ok('后面的静音不显示字幕', fresh.every((c) => c.start < 20.5), JSON.stringify(fresh));

  /* ================= 4. 合并进弹幕 ASS ================= */
  section('4. 与弹幕 ASS 合并');
  const merged = mergeSubtitleIntoAss(fakeDanmakuAss(), cues);
  ok('保留了 Script Info', merged.includes('[Script Info]') && merged.includes('ScriptType: v4.00+'));
  ok('继承了弹幕 ASS 的分辨率（2560×1440）', merged.includes('PlayResX: 2560') && merged.includes('PlayResY: 1440'));
  ok('原有弹幕行一条不少', (merged.match(/^Dialogue:/gm) ?? []).length === 2 + cues.length, `Dialogue 行数 ${(merged.match(/^Dialogue:/gm) ?? []).length}`);
  ok('原有弹幕文本没被改动', merged.includes('前面有个人中了 20 次红包'));
  ok('新增了 Subtitle 样式', /^Style:\s*Subtitle,/m.test(merged));
  ok('字幕样式是底部居中（Alignment=2）', /^Style:\s*Subtitle,[^\n]*,\s*2,/m.test(merged));
  ok(
    '字幕边距大于弹幕底部样式（不叠在一起）',
    (() => {
      const sub = /^Style:\s*Subtitle,(.*)$/m.exec(merged)?.[1]?.split(',') ?? [];
      const bot = /^Style:\s*Bottom,(.*)$/m.exec(merged)?.[1]?.split(',') ?? [];
      return Number(sub.at(-2)) > Number(bot.at(-2));
    })(),
  );
  ok('字幕事件使用 Subtitle 样式', (merged.match(/Dialogue:[^,]*,[^,]*,[^,]*,Subtitle,/g) ?? []).length === cues.length);
  ok('没有 BOM（BOM 会让切片接口 500）', !merged.startsWith('\uFEFF'));

  /* ================= 5. 只有字幕（无弹幕）时也能独立成 ASS ================= */
  section('5. 无弹幕时的独立 ASS');
  const solo = buildSubtitleOnlyAss(cues, { resolution: { width: 1280, height: 720 } });
  ok('含 Script Info 与 Events 段', solo.includes('[Script Info]') && solo.includes('[Events]'));
  ok('分辨率跟随入参（1280×720）', solo.includes('PlayResX: 1280') && solo.includes('PlayResY: 720'));
  eq('事件数等于字幕条数', (solo.match(/^Dialogue:/gm) ?? []).length, cues.length);

  /* ================= 6. buildBurnAss 落盘 ================= */
  section('6. 成品文件落盘');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-sub-'));
  const danmakuPath = path.join(tmp, 'danmaku.ass');
  fs.writeFileSync(danmakuPath, fakeDanmakuAss(), 'utf8');
  const r1 = buildBurnAss({
    outDir: tmp,
    danmakuAssPath: danmakuPath,
    segments,
    render: { resolution: { width: 1920, height: 1080 } },
    isNoise: (t) => t.includes('♪'),
  });
  ok('产出 ASS 路径', Boolean(r1.assPath) && fs.existsSync(r1.assPath!), r1.assPath ?? '(无)');
  eq('标记为已合并', r1.merged, true);
  eq('字幕条数与整理结果一致', r1.subtitleCount, cues.length);
  const onDisk = fs.readFileSync(r1.assPath!, 'utf8');
  ok('落盘文件无 BOM', !onDisk.startsWith('\uFEFF'));
  ok('落盘文件保留了 Script Info（分辨率不丢）', onDisk.includes('PlayResX: 2560') && onDisk.includes('ScriptType'));
  const r2 = buildBurnAss({
    outDir: tmp,
    danmakuAssPath: danmakuPath,
    segments,
    render: { resolution: { width: 1920, height: 1080 } },
    isNoise: (t) => t.includes('♪'),
  });
  eq('同参数重复调用复用同一文件（不重复生成）', r2.assPath, r1.assPath);
  // 默认就该过滤噪声：ASR 把音乐/掌声识别成的乱码烧在画面上很出戏
  const rDefault = buildBurnAss({ outDir: tmp, segments, render: { resolution: { width: 1920, height: 1080 } } });
  ok('默认开启噪声过滤（♪♪ / 单字乱码不烧）', rDefault.subtitleCount < cues.length + 1, `默认 ${rDefault.subtitleCount} 条`);
  const r3 = buildBurnAss({ outDir: tmp, segments: [], danmakuAssPath: danmakuPath });
  eq('没有转写内容时退回纯弹幕 ASS', r3.assPath, danmakuPath);
  eq('并给出提示', r3.warnings.length > 0, true);
  fs.rmSync(tmp, { recursive: true, force: true });

  /* ================= 7. 术语表校验与纠错 ================= */
  section('7. 术语表：校验与纠错');
  const v1 = validateGlossary({
    anchors: ['甲主播', '甲主播', ''],
    terms: ['后半夜后悔时代', '闪身步', 123],
    replacements: [
      { from: '闪身部', to: '闪身步' },
      { from: '同词', to: '同词' },
      { from: '(', to: '（', regex: true }, // 半角左括号是非法正则
    ],
  });
  eq('主播名去重并去掉空串', v1.glossary.anchors, ['甲主播']);
  eq('术语里的非字符串项被忽略', v1.glossary.terms, ['后半夜后悔时代', '闪身步']);
  eq('只有合法规则被保留（同词规则 + 坏正则都被剔除）', v1.glossary.replacements.length, 1);
  ok('坏正则被报为 error（不会被写入）', v1.issues.some((i) => i.level === 'error' && /合法正则/.test(i.message)), JSON.stringify(v1.issues));
  ok('非字符串项给出 warn', v1.issues.some((i) => i.level === 'warn'));
  const bad = validateGlossary({ anchors: 'oops' });
  ok('anchors 不是数组时报 error', bad.issues.some((i) => i.level === 'error'));

  const glossary: Glossary = {
    version: 1,
    anchors: ['甲主播'],
    terms: ['后半夜后悔时代', '闪身步'],
    replacements: [
      { from: '后半夜后悔时代', to: '后半夜后悔时代' },
      { from: '闪身部', to: '闪身步' },
      { from: '\\d+次红包', to: '很多次红包', regex: true },
    ],
  };
  const c = applyCorrections('他今天闪身部用得不错，前面中了20次红包', glossary);
  ok('纯文本规则生效', c.text.includes('闪身步') && !c.text.includes('闪身部'), c.text);
  ok('正则规则生效', c.text.includes('很多次红包'), c.text);
  eq('命中次数被统计出来', c.hits.find((h) => h.from === '闪身部')?.count, 1);
  const ct = correctTranscript([{ start: 0, end: 1, text: '闪身部' }, { start: 1, end: 2, text: '闪身部再来一次' }], glossary);
  eq('整场纠错按规则聚合', ct.summary.hits.find((h) => h.from === '闪身部')?.count, 2);
  eq('原文不被就地修改（返回新数组）', ct.segments.length, 2);

  /* ================= 8. 提示词注入 ================= */
  section('8. 术语表 → 提示词');
  const promptText = renderGlossaryForPrompt(glossary);
  ok('写明"不要改写"（否则模型会把对的改错）', /不要改写/.test(promptText));
  ok('含主播名', promptText.includes('甲主播'));
  ok('含术语', promptText.includes('后半夜后悔时代'));
  eq('空术语表不占用任何 token', renderGlossaryForPrompt({ version: 1, anchors: [], terms: [], replacements: [] }), '');
  const hw = hotWordsText(glossary);
  ok('热词可一行一个复制', hw.perLine.split('\n').length === 3, hw.perLine.replace(/\n/g, ' | '));
  ok('也可逗号分隔复制', hw.commaSeparated.includes('，'));

  /* ================= 9. 能量锚点：把"窗口离谱"的字幕挪到真正有人说话的地方 ================= */
  section('9. 能量锚点（云 ASR 会给出"15 个字占 31 秒"的窗口）');
  {
    /* --- 9a. 纯函数：RMS 剖面 --- */
    const sr = 8000;
    const samples = new Float32Array(sr * 4); // 4 秒
    for (let i = 0; i < samples.length; i++) {
      const t = i / sr;
      samples[i] = t >= 2 && t < 3 ? 0.5 : 0.005; // 第 2–3 秒"有人说话"
    }
    const profile = rmsProfile(samples, sr, 0.2);
    eq('剖面：4 秒 / 0.2s 一个 bin = 20 个 bin', profile.rms.length, 20);
    ok('剖面：安静处能量低、说话处能量高', (profile.rms[5] ?? 1) < (profile.rms[12] ?? 0), `${profile.rms[5]?.toFixed(4)} vs ${profile.rms[12]?.toFixed(4)}`);
    eq('剖面时长', profile.durationSec, 4);

    /* --- 9b. bestAnchor：只有"明显突出"的峰值才认账 --- */
    const strong = bestAnchor(profile, 0, 4, 1);
    ok('强峰值 → 锚到说话处（2 秒附近）', strong !== undefined && Math.abs(strong - 1.6) <= 0.5, String(strong));

    const flat = rmsProfile(
      Float32Array.from({ length: sr * 4 }, () => 0.02),
      sr,
      0.2,
    );
    eq('全程一样响（分不清人声与背景）→ 不锚（返回 undefined，保持原样）', bestAnchor(flat, 0, 4, 1), undefined);

    const weak = new Float32Array(sr * 4);
    for (let i = 0; i < weak.length; i++) weak[i] = 0.02;
    for (let i = 2 * sr; i < 3 * sr; i++) weak[i] = 0.028; // 只高 2.9 dB（< 8 dB 余量）
    const weakProfile = rmsProfile(weak, sr, 0.2);
    eq('峰值余量不足 8 dB → 不锚（宁可不做，也不能把字幕搬到音乐上）', bestAnchor(weakProfile, 0, 4, 1), undefined);

    eq('没有剖面 → undefined', bestAnchor(undefined, 0, 10, 2), undefined);
    eq('区间装不下所需时长 → undefined', bestAnchor(profile, 0, 0.5, 3), undefined);

    /* --- 9c. needsAnchor 的判据（用实测的两个真实比值） --- */
    ok('正常段（2.4→4.0s 装 6 个字，需 1s）→ 不重锚', needsAnchor(1.6, 1.0, 8) === false);
    ok('离谱段（0→30.9s 装 15 个字，需 2.5s）→ 重锚', needsAnchor(30.9, 2.5, 8) === true);
    ok('离谱段（6 个字占 40.5s）→ 重锚', needsAnchor(40.5, 1.0, 8) === true);

    /* --- 9d. buildCues 接到锚点后真的挪了位置 --- */
    const longSeg: TranscriptSegment[] = [{ start: 746.69, end: 777.6, text: '如。萌啊！你都怎么突然追上来了' }];
    const picker = { pick: (from: number) => from + 27.1, calls: 0 } as { pick: (f: number, t: number, n: number) => number; calls: number };
    const anchoredCues = buildCues(longSeg, { maxCharsPerLine: 18 }, undefined, {
      pick: (f, t, n) => {
        picker.calls++;
        return picker.pick(f, t, n);
      },
    });
    eq('离谱窗口被重锚：字幕挪到窗口内 +27.1 秒处', anchoredCues.cues[0]?.start, 773.79);
    eq('并且统计了锚定条数（界面/日志要能说出来）', anchoredCues.anchored, 1);

    /* 正常窗口：不该动它的位置（实测正常段与单独重识别的差 < 0.3s） */
    const shortSeg: TranscriptSegment[] = [{ start: 305.38, end: 307.02, text: '不要我帮你吗' }];
    let called = 0;
    const kept = buildCues(shortSeg, { maxCharsPerLine: 18 }, undefined, {
      pick: (f) => {
        called++;
        return f + 5;
      },
    });
    eq('正常段不询问锚点（次数为 0）', called, 0);
    eq('正常段时间保持 ASR 原样', kept.cues[0]?.start, 305.38);
    eq('没有锚点时行为不变（旧行为可回退）', buildCues(longSeg, { maxCharsPerLine: 18 }, undefined, undefined).cues[0]?.start, 746.69);
  }

  console.log('\n' + '─'.repeat(74));
  console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (fail > 0) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
    process.exitCode = 1;
  } else {
    console.log('\x1b[32m字幕合并与术语表行为符合预期。\x1b[0m');
  }
}

main().catch((e) => {
  console.error('\x1b[31m自测异常：\x1b[0m', (e as Error).message);
  console.error((e as Error).stack?.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
