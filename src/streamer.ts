/**
 * 本场主播识别。
 *
 * ## 为什么需要单独一层
 *
 * 实测事故：术语表里同时有「乙主播」和「甲主播」两个主播（用户既看乙主播也看甲主播），
 * 而 `renderGlossaryForPrompt` 把它们渲染成一行 ——
 *
 * ```
 * - 主播 / 常驻嘉宾：乙主播、甲主播
 * ```
 *
 * 提示词里写的是「**本场**专有名词」，于是模型理直气壮地把甲主播的直播总结成乙主播的。
 * 素材没错、转写没错，错在**我们把跨主播的全局词表当成了本场信息**。
 *
 * ## 怎么识别（三类证据，按可信度排序）
 *
 * 1. **录制目录名**：biliLive-tools 按主播建目录（`Downloads/Bilibili/甲主播/…`），
 *    目录名里出现哪个词表主播，就是它 —— 这是最硬的证据（用户自己起的目录名）。
 * 2. **弹幕热词**：观众对主播的称呼（「腿宝」「腿姐」）在弹幕里出现频次远高于其他主播名；
 *    权重高于转写，因为转写里提到别的主播名往往是**在聊别人**。
 * 3. **转写正文 / 场次标题**：主播自称、观众称呼都会出现，作为补充证据。
 *
 * 三类证据都不指向任何主播时，**返回 undefined 而不是猜** —— 界面上问一句，
 * 也好过把整场总结写成别人的。
 */

/** 目录名里的通用词：这些不是主播名 */
const GENERIC_DIR = /^(bilibili|downloads?|download|录播|录像|直播|录制|videos?|video|output|out|temp|tmp|data|\d{4}[-_.]?\d{0,2}[-_.]?\d{0,2})$/i;

export interface StreamerGuess {
  /** 识别出的主播名（用词表里的规范写法；没有词表命中时用目录名） */
  name?: string;
  /**
   * 置信度：
   *  - `high`：目录名直接命中 —— 基本不会错；
   *  - `medium`：弹幕/转写多数命中 —— 可信，但提示词里会写成"据弹幕推断"；
   *  - `none`：没有证据，不要瞎写。
   */
  confidence: 'high' | 'medium' | 'none';
  /** 判定依据（写进日志与提示词，出问题时能一眼看出为什么认成了这位） */
  evidence: string[];
}

/** 取路径的父目录名（去掉盘符与通用目录），作为主播名候选 */
export function folderNameOf(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  // 最后一段是文件名，倒数第二段才是目录
  const dir = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  if (!dir || GENERIC_DIR.test(dir)) return undefined;
  return dir;
}

/** 统计 needle 在 haystack 里出现的次数（大小写不敏感，用于英文名） */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let count = 0;
  let from = 0;
  for (;;) {
    const i = h.indexOf(n, from);
    if (i < 0) break;
    count++;
    from = i + n.length;
  }
  return count;
}

export interface DetectStreamerInput {
  /** 本场的源文件路径（多分段的都给上） */
  sourcePaths: string[];
  /** 词表里的主播候选（`glossary.anchors`） */
  anchors: string[];
  /** 转写正文（把所有段落拼起来传进来即可） */
  transcriptText?: string;
  /** 弹幕热词及出现次数 */
  danmakuKeywords?: Array<{ word: string; count: number }>;
  /** 场次标题 */
  title?: string;
}

/**
 * 识别本场主播。找不到证据就返回 `confidence: 'none'`，绝不猜。
 */
export function detectStreamer(input: DetectStreamerInput): StreamerGuess {
  const evidence: string[] = [];
  const anchors = [...new Set(input.anchors.map((a) => a.trim()).filter(Boolean))];

  /* ---- 证据 1：录制目录名 ---- */
  const folders = [...new Set(input.sourcePaths.map((p) => folderNameOf(p)).filter((x): x is string => Boolean(x)))];
  for (const folder of folders) {
    // 目录名里命中词表主播 → 用词表里的规范写法
    const hit = anchors.find((a) => folder.toLowerCase().includes(a.toLowerCase()));
    if (hit) {
      evidence.push(`录制目录名「${folder}」命中词表主播「${hit}」`);
      return { name: hit, confidence: 'high', evidence };
    }
  }
  // 目录名本身不像通用目录，就当主播名用（biliLive-tools 按主播建目录）
  if (folders.length === 1 && folders[0] && folders[0].length <= 24) {
    evidence.push(`录制目录名「${folders[0]}」（词表里没有对应主播，按目录名使用）`);
    return { name: folders[0], confidence: 'high', evidence };
  }
  if (folders.length > 1) {
    evidence.push(`有多个不同的录制目录（${folders.join('、')}），无法据此判定，转用弹幕/转写证据`);
  }

  /* ---- 证据 2/3：弹幕热词（权重 3）与转写正文（权重 1）、标题（权重 2） ---- */
  const scores = new Map<string, { score: number; danmaku: number; transcript: number; title: number }>();
  for (const a of anchors) {
    let danmaku = 0;
    for (const k of input.danmakuKeywords ?? []) {
      if (k.word.toLowerCase().includes(a.toLowerCase())) danmaku += k.count;
    }
    const transcript = countOccurrences(input.transcriptText ?? '', a);
    const title = countOccurrences(input.title ?? '', a);
    const score = danmaku * 3 + transcript + title * 2;
    scores.set(a, { score, danmaku, transcript, title });
  }
  const ranked = [...scores.entries()].sort((x, y) => y[1].score - x[1].score);
  const top = ranked[0];
  const second = ranked[1];
  if (top && top[1].score > 0) {
    const [name, s] = top;
    // 只有唯一候选有票，或明显领先（≥2 倍且差距 ≥5 票）才算识别出来
    const dominated = !second || second[1].score === 0 || (s.score >= second[1].score * 2 && s.score - second[1].score >= 5);
    evidence.push(
      `弹幕提及 ${s.danmaku} 次、转写 ${s.transcript} 次、标题 ${s.title} 次` +
        (second && second[1].score > 0 ? `；次高是「${second[0]}」${second[1].score} 分` : ''),
    );
    if (dominated) {
      evidence.push(`在词表主播里明显占优（${s.score} 分）`);
      return { name, confidence: 'medium', evidence };
    }
    evidence.push(`与「${second?.[0]}」的票数接近，不敢断定本场是谁`);
    return { confidence: 'none', evidence };
  }

  evidence.push('目录名、弹幕热词、转写正文都没有指向任何词表主播');
  return { confidence: 'none', evidence };
}

/**
 * 给提示词用的一句话。识别不出来时返回空串（不注入任何主播信息，让模型只依据转写内容）。
 */
export function streamerPromptLine(guess: StreamerGuess): string {
  if (!guess.name) return '';
  const how = guess.confidence === 'high' ? '' : '（据弹幕与转写推断）';
  return (
    `本场直播的主播是「${guess.name}」${how}。` +
    `提到主播时**只能用这个名字**：不要写成其他主播，也不要把词表里别的主播名安到本场主播头上。`
  );
}
