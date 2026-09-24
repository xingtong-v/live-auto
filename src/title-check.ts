/**
 * 投稿标题体检。
 *
 * ## 为什么单独一个模块
 *
 * 标题是唯一**观众可见、平台会拒、事后再改要人工去创作中心**的字段，
 * 而它由 LLM 生成 —— 这是整条链路里"内容质量最不可控"的一环。
 * 现有的把关只有「长度 ≤80」，实测漏得掉这些：
 *
 *   - 降级产出留下的占位标题「（待填写）xxx」；
 *   - **术语表里的错词**：我们刚教会模型"这些词是对的、不要改写"，
 *     但模型仍可能把「闪身步」写成「闪身部」—— 投稿前必须能查出来；
 *   - 无意义技术标记：哈希、`片段3`、`clip_12`、文件名残渣；
 *   - 分P 前缀混进单片标题（`P3 xxx`）—— 那是多分P 模式的产物，单片投稿不该带；
 *   - 同场两个切片撞标题（B站 上就是两条几乎一样的稿件，观众观感很差）；
 *   - 全是标点/空白、首尾有多余空格、内部有连续空格。
 *
 * ## 分级
 *
 * `error` = 会被平台拒、或明显不该发（占位标题、空标题、错词残留、纯符号）；
 * `warn`  = 能发但该看一眼（截断、疑似编号、与同场重名、多余空白）。
 *
 * 体检**不修改**标题（除了返回"截断后会长成什么样"），改不改由调用方决定 ——
 * 静默改标题比不改更糟：用户以为发的是自己看到的那个。
 */
import type { Glossary } from './glossary.ts';
import { sanitizeTitle } from './analyze.ts';

export const TITLE_MAX = 80;

export interface TitleProblem {
  level: 'error' | 'warn';
  code: string;
  message: string;
  /** 可执行的修复建议 */
  fix?: string;
}

export interface TitleCheckContext {
  /** 术语表：用来查「错词残留」 */
  glossary?: Glossary;
  /** 标题后缀（publish.defaultTitleSuffix） */
  suffix?: string;
  /** 同场其它切片的标题，用于查重 */
  siblings?: string[];
  /** 上限，默认 80 */
  max?: number;
}

export interface TitleCheckResult {
  /** 原标题 */
  raw: string;
  /** 加后缀 + 截断之后、真正会被提交的样子 */
  finalTitle: string;
  /** 是否发生了截断 */
  truncated: boolean;
  problems: TitleProblem[];
  /** 未通过（含 error） */
  ok: boolean;
}

/** 疑似哈希 / base64 残渣：连续 16 位以上十六进制，或 24 位以上无空格字母数字混合 */
const HASH_LIKE = /[0-9a-f]{16,}|\b[A-Za-z0-9_-]{24,}\b/i;
/** 内部编号：片段3 / clip_12 / part2 / shot-4 */
const INTERNAL_INDEX = /(片段|clip|part|shot|slice)\s*[-_#]?\s*\d+/i;
/** 分P 前缀：P3 标题 */
const PART_PREFIX = /^P\d+\s/;
/** 占位标题 */
const PLACEHOLDER = /待填写|待补|TODO|PLACEHOLDER|示例标题/i;

/**
 * 单个标题体检。
 *
 * 顺序有意为之：先算「最终会长成什么样」（加后缀→截断），再基于**最终值**判断 ——
 * 否则会漏掉"加后缀之后才超长"这类问题（实测踩过）。
 */
export function checkTitle(title: unknown, ctx: TitleCheckContext = {}): TitleCheckResult {
  const max = ctx.max ?? TITLE_MAX;
  const raw = typeof title === 'string' ? title : '';
  const problems: TitleProblem[] = [];

  const trimmed = raw.trim();
  if (!trimmed) {
    problems.push({ level: 'error', code: 'empty', message: '标题为空', fix: '补一个具体标题；降级产出的占位标题不能直接发' });
  }
  if (raw !== trimmed) {
    problems.push({ level: 'warn', code: 'outer-space', message: '标题首尾有多余空白', fix: '保存时会自动去掉' });
  }
  if (/[\r\n]/.test(raw)) {
    problems.push({ level: 'error', code: 'newline', message: '标题含换行', fix: '换行会被平台当成非法字符' });
  }
  if (/ {2,}|　{2,}/.test(raw)) {
    problems.push({ level: 'warn', code: 'double-space', message: '标题里有连续空格' });
  }
  if (trimmed && !/[\u4e00-\u9fa5a-zA-Z0-9]/.test(trimmed)) {
    problems.push({ level: 'error', code: 'no-word', message: '标题里没有任何文字或数字（只有符号）' });
  }
  if (PLACEHOLDER.test(raw)) {
    problems.push({
      level: 'error',
      code: 'placeholder',
      message: '标题里含占位词（待填写/待补/示例标题）',
      fix: '这是 LLM 降级产出的占位标题，发布前必须人工改写',
    });
  }

  // 最终形态：加后缀 → 截断（与 buildBiliupConfig 的顺序保持一致）
  const st = sanitizeTitle(trimmed, max);
  let finalTitle = st.title;
  let truncated = st.truncated;
  const suffix = ctx.suffix ?? '';
  if (suffix && !finalTitle.endsWith(suffix)) {
    const withSuffix = sanitizeTitle(`${finalTitle}${suffix}`, max);
    finalTitle = withSuffix.title;
    truncated = truncated || withSuffix.truncated;
  }
  if (truncated) {
    const lost = [...trimmed].length - [...finalTitle].length;
    problems.push({
      level: 'warn',
      code: 'truncated',
      message: `标题超过 ${max} 字符，提交时会被截掉 ${lost} 个字符：${finalTitle}`,
      fix: '把标题压到 80 字以内，别让平台从中间截断',
    });
  }
  // 短标题分两档：≤2 个字基本等于没标题（error），≤6 个字信息量偏弱（warn）。
  // ⚠️ 不要把「短」一律当 error：实测有 5 个字的标题完全成立，
  //    当成硬伤会让用户没法发布正常内容。
  const finLen = [...finalTitle].length;
  if (trimmed && finLen <= 2) {
    problems.push({ level: 'error', code: 'too-short', message: `标题只有 ${finLen} 个字符，等于没有标题` });
  } else if (trimmed && finLen <= 6) {
    problems.push({ level: 'warn', code: 'very-short', message: `标题只有 ${finLen} 个字符，信息量偏少`, fix: '补一个钩子或具体信息' });
  }

  // 术语表错词残留（模型改写了专有名词，或 ASR 错词一路传到了标题）
  for (const rule of ctx.glossary?.replacements ?? []) {
    let hit = false;
    try {
      hit = rule.regex ? new RegExp(rule.from).test(raw) : raw.includes(rule.from);
    } catch {
      hit = false;
    }
    if (hit) {
      problems.push({
        level: 'error',
        code: 'glossary-wrong-word',
        message: `标题里出现术语表的错词「${rule.from}」，应写作「${rule.to}」`,
        fix: `改成「${rule.to}」；若这是模型改写专有名词，说明提示词没压住，建议重跑选片`,
      });
    }
  }

  if (HASH_LIKE.test(raw)) {
    problems.push({
      level: 'warn',
      code: 'hash-like',
      message: '标题里疑似有哈希/文件名残渣（一长串无意义字符）',
      fix: '检查 prompt 是否把内部编号写进了标题',
    });
  }
  if (INTERNAL_INDEX.test(raw)) {
    problems.push({ level: 'warn', code: 'internal-index', message: '标题里含内部编号（片段/clip/part+数字）' });
  }
  if (PART_PREFIX.test(raw)) {
    problems.push({
      level: 'warn',
      code: 'part-prefix',
      message: '标题以分P 前缀开头（如「P3 …」）—— 那是多分P 稿件里的分P 命名，单片投稿不该带',
      fix: '单片投稿请去掉前缀；多分P 请用 publish.partTitleTemplate 统一控制',
    });
  }

  const sibs = ctx.siblings ?? [];
  const norm = normalizeForCompare(finalTitle);
  if (norm && sibs.some((s) => normalizeForCompare(s) === norm)) {
    problems.push({
      level: 'warn',
      code: 'duplicate-sibling',
      message: '与同场另一个切片标题重复',
      fix: '两条几乎一样的稿件会互相分流；改掉其中一条',
    });
  }

  return {
    raw,
    finalTitle,
    truncated,
    problems,
    ok: !problems.some((p) => p.level === 'error'),
  };
}

/** 用于查重的宽松归一化（去空白与标点、全角转半角、转小写） */
export function normalizeForCompare(title: string): string {
  return String(title)
    .replace(/[\s\u3000]+/g, '')
    .replace(/[【】\[\]（）()《》<>「」『』,，.。!！?？:：;；'"“”‘’~～\-—_/\\|+*#@&$%^]/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

export interface ClipTitleInput {
  index: number;
  title: string;
  degraded?: boolean;
}

export interface ClipTitlesReport {
  byIndex: Map<number, TitleCheckResult>;
  errors: Array<{ index: number; problem: TitleProblem }>;
  warnings: Array<{ index: number; problem: TitleProblem }>;
  ok: boolean;
}

/** 整场体检：逐条检查 + 互相查重 */
export function checkClipTitles(clips: ClipTitleInput[], ctx: TitleCheckContext = {}): ClipTitlesReport {
  const titles = clips.map((c) => c.title);
  const byIndex = new Map<number, TitleCheckResult>();
  const errors: Array<{ index: number; problem: TitleProblem }> = [];
  const warnings: Array<{ index: number; problem: TitleProblem }> = [];
  for (const c of clips) {
    // 兄弟标题集合排除自己
    const siblings = titles.filter((t) => t !== c.title);
    const r = checkTitle(c.title, { ...ctx, siblings });
    byIndex.set(c.index, r);
    for (const p of r.problems) {
      if (p.level === 'error') errors.push({ index: c.index, problem: p });
      else warnings.push({ index: c.index, problem: p });
    }
  }
  return { byIndex, errors, warnings, ok: errors.length === 0 };
}

/** 单行摘要，用于日志与 toast */
export function summarizeTitleIssues(report: ClipTitlesReport): string {
  const parts: string[] = [];
  if (report.errors.length) parts.push(`${report.errors.length} 处必须修`);
  if (report.warnings.length) parts.push(`${report.warnings.length} 处建议看`);
  return parts.length ? parts.join('，') : '全部合规';
}
