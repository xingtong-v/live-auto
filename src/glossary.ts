/**
 * 术语表（主播名 / 专有名词 / ASR 纠错规则）。
 *
 * ## 为什么需要这个东西
 *
 * 直播里的话有三个特点，通用 ASR 和通用 LLM 都吃不准：
 *   - **人名与昵称**：主播名、常驻嘉宾、粉丝团称呼（"甲主播"、"Asen"）常被识别成同音字；
 *   - **游戏/圈内术语**：技能名、地图名、梗（"闪身步"→"闪身部"）；
 *   - **每场都出现的固定说法**：栏目名、口号、连麦对象。
 *
 * 这三类错误会一路传下去：转写错了 → 选片 prompt 看不懂 → 标题里写错专有名词 → 观众一眼看出是机切的。
 *
 * ## 为什么不做「热词直传 ASR」
 *
 * ⚠️ 这一段说的是**云端**那条路。查过基础设施的实际契约：`POST /ai/subtitle` 的请求体只有
 * `file / modelId / startTime / endTime / offset / song` 六个字段
 * （在 biliLive-tools 的 app.asar 里核对过 `subtitleRecognize` 的实现），
 * 既没有 `hotWord` 也没有 `vocabulary` 参数，整个 ASR 链路里搜不到任何热词相关字段。
 * 修改 biliLive-tools 是硬约束 #1 明确禁止的，所以**云端热词不能直传**。
 *
 * 于是这里走两条等效但可控的路：
 *   1. **转写后确定性纠错**（`replacements`）：把已知的错听词直接替换成正确写法。
 *      这是热词最实在的那部分收益 —— 热词之所以有用，本质就是"让结果里出现正确的词"。
 *   2. **注入 LLM 提示词**（`terms` / `anchors`）：让选片与起标题的模型知道这些词是专有名词，
 *      不要改写、不要翻译、不要当成错别字"修正"。
 *
 * ★ 但**本地**那条路可以直传，而且这条线此前一直没接上（2026-09-24 补上）：
 *   `tools/local-asr/transcribe-funasr.py` 的 spec 里本来就有 `hotwords`，
 *   Fun-ASR-Nano 的 `generate(hotwords=[...])` 是原生参数 —— 也就是说
 *   "能力在、线没接"。现在 `asr.localFunasr.hotwordsEnabled` 默认开启，
 *   由 `hotWordList()` 把本表摊平成数组传给它；`hotWordsText()` 仍保留给
 *   "换成别的支持热词的 ASR 时一键复制"这个用途。
 *
 * ## 为什么单独一个文件而不是塞进 config.json
 *
 * config.json 是"设置"（会被 UI 保存、被校验、被脱敏），术语表是"内容"（会长、会改、
 * 中文为主）。分开存的好处：改术语表不会触发配置校验与热加载，
 * 出错也不会把服务配置弄坏；用户还可以直接用记事本编辑 `data/glossary.json`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, exists, nowIso, readJson, writeJsonAtomic } from './util.ts';
import { log as globalLog, type Logger } from './logger.ts';

export const GLOSSARY_PATH = path.join(ROOT_DIR, 'data', 'glossary.json');

/** 一条确定性纠错规则：`from` 出现即替换为 `to` */
export interface GlossaryReplacement {
  from: string;
  to: string;
  /** true 时 `from` 按正则解释（默认按纯文本） */
  regex?: boolean;
  /** 备注，仅用于人类阅读 */
  note?: string;
}

export interface Glossary {
  version: number;
  /** 主播名 / 常驻嘉宾 —— 会拼进提示词的"人物"段 */
  anchors: string[];
  /** 专有名词（游戏术语、梗、栏目名） */
  terms: string[];
  /** 确定性纠错规则 */
  replacements: GlossaryReplacement[];
  updatedAt?: string;
}

export const EMPTY_GLOSSARY: Glossary = { version: 1, anchors: [], terms: [], replacements: [] };

/** 首次使用时落盘的骨架：带示例，用户照着改就行（JSON 不能写注释，所以示例即文档） */
function skeleton(): Glossary & { $comment: string } {
  return {
    $comment: [
      '直播术语表 —— 直接编辑本文件即可，保存后下一次转写/分析自动生效（无需重启）。',
      'anchors：主播名与常驻嘉宾，例如 ["甲主播"]',
      'terms：专有名词、游戏术语、圈内梗，例如 ["后半夜后悔时代", "闪身步"]',
      'replacements：ASR 听错 → 正确写法，例如 {"from":"闪身部","to":"闪身步"}',
      'regex 为 true 时 from 按正则解释（默认纯文本）。',
    ].join(' '),
    version: 1,
    anchors: [],
    terms: [],
    replacements: [],
    updatedAt: nowIso(),
  };
}

/* ============================================================================
 * 校验
 * ========================================================================== */

export interface GlossaryIssue {
  level: 'error' | 'warn';
  message: string;
}

/** 宽松校验：术语表是"内容"，只拦真正会导致运行异常的问题（坏正则、类型错） */
export function validateGlossary(raw: unknown): { glossary: Glossary; issues: GlossaryIssue[] } {
  const issues: GlossaryIssue[] = [];
  const out: Glossary = { ...EMPTY_GLOSSARY, anchors: [], terms: [], replacements: [] };
  if (!raw || typeof raw !== 'object') {
    issues.push({ level: 'error', message: '术语表不是一个 JSON 对象' });
    return { glossary: out, issues };
  }
  const obj = raw as Record<string, unknown>;

  const strList = (v: unknown, field: string): string[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      issues.push({ level: 'error', message: `${field} 必须是字符串数组` });
      return [];
    }
    const list: string[] = [];
    for (const item of v) {
      if (typeof item !== 'string') {
        issues.push({ level: 'warn', message: `${field} 里有非字符串项，已忽略` });
        continue;
      }
      const t = item.trim();
      if (t) list.push(t);
    }
    // 去重（保持顺序）
    return [...new Set(list)];
  };

  out.anchors = strList(obj['anchors'], 'anchors');
  out.terms = strList(obj['terms'], 'terms');

  const reps = obj['replacements'];
  if (reps !== undefined && reps !== null) {
    if (!Array.isArray(reps)) {
      issues.push({ level: 'error', message: 'replacements 必须是数组' });
    } else {
      for (const item of reps) {
        if (!item || typeof item !== 'object') {
          issues.push({ level: 'warn', message: 'replacements 里有非对象项，已忽略' });
          continue;
        }
        const r = item as Record<string, unknown>;
        const from = typeof r['from'] === 'string' ? r['from'] : '';
        const to = typeof r['to'] === 'string' ? r['to'] : '';
        if (!from) {
          issues.push({ level: 'warn', message: 'replacements 里有空的 from，已忽略' });
          continue;
        }
        if (from === to) {
          issues.push({ level: 'warn', message: `replacements 里 "${from}" 的 from 与 to 相同，已忽略` });
          continue;
        }
        const isRegex = r['regex'] === true;
        if (isRegex) {
          try {
            new RegExp(from, 'g');
          } catch (e) {
            issues.push({ level: 'error', message: `replacements 里 "${from}" 不是合法正则：${(e as Error).message}` });
            continue;
          }
        }
        out.replacements.push({
          from,
          to,
          ...(isRegex ? { regex: true } : {}),
          ...(typeof r['note'] === 'string' && r['note'] ? { note: r['note'] } : {}),
        });
      }
    }
  }

  if (typeof obj['version'] === 'number') out.version = obj['version'];
  if (typeof obj['updatedAt'] === 'string') out.updatedAt = obj['updatedAt'];
  return { glossary: out, issues };
}

/* ============================================================================
 * 纠错应用
 * ========================================================================== */

export interface CorrectionHit {
  from: string;
  to: string;
  count: number;
}

export interface CorrectionResult {
  text: string;
  /** 本次文本里实际发生的替换（按规则聚合） */
  hits: CorrectionHit[];
}

/**
 * 对一段文本应用纠错规则。
 *
 * 顺序敏感：按 `replacements` 的书写顺序依次应用，先写的先生效。
 * 这样用户可以用「先把 A 改成 B，再把 B 改成 C」这类链式规则处理多个错法，
 * 只要把更具体的规则写在前面即可。
 */
export function applyCorrections(text: string, glossary: Glossary): CorrectionResult {
  if (!text || glossary.replacements.length === 0) return { text, hits: [] };
  let out = text;
  const hits: CorrectionHit[] = [];
  for (const rule of glossary.replacements) {
    try {
      if (rule.regex) {
        const re = new RegExp(rule.from, 'g');
        const matched = out.match(re);
        if (matched?.length) {
          out = out.replace(re, rule.to);
          hits.push({ from: rule.from, to: rule.to, count: matched.length });
        }
      } else {
        if (!out.includes(rule.from)) continue;
        const count = out.split(rule.from).length - 1;
        out = out.split(rule.from).join(rule.to);
        hits.push({ from: rule.from, to: rule.to, count });
      }
    } catch {
      // 单条规则出错不能影响整场转写
    }
  }
  return { text: out, hits };
}

export interface TranscriptCorrectionSummary {
  /** 段级替换总次数 */
  replaced: number;
  /** 按规则聚合的命中明细（只保留命中的） */
  hits: CorrectionHit[];
}

/** 对整个转写结果就地应用纠错（返回新的段数组，不改原对象） */
export function correctTranscript<T extends { text: string }>(
  segments: T[],
  glossary: Glossary,
): { segments: T[]; summary: TranscriptCorrectionSummary } {
  const agg = new Map<string, CorrectionHit>();
  let replaced = 0;
  const out = segments.map((s) => {
    const r = applyCorrections(s.text, glossary);
    for (const h of r.hits) {
      replaced += h.count;
      const key = `${h.from}\u0000${h.to}`;
      const prev = agg.get(key);
      if (prev) prev.count += h.count;
      else agg.set(key, { ...h });
    }
    return r.text === s.text ? s : { ...s, text: r.text };
  });
  return {
    segments: out,
    summary: { replaced, hits: [...agg.values()].sort((a, b) => b.count - a.count) },
  };
}

/* ============================================================================
 * 提示词注入
 * ========================================================================== */

/**
 * 生成给 LLM 的「专有名词」段。
 *
 * 措辞要点：明确告诉模型**这些词是对的**、不要改写、不要"纠正"成同音常见词。
 * 不写清楚的话，模型看到"闪身步"会自作聪明改成"闪身部"，反而把对的改错。
 * 没有术语时返回空串（不占用任何 token）。
 */
export function renderGlossaryForPrompt(glossary: Glossary, opts: { maxTerms?: number; streamer?: string } = {}): string {
  const maxTerms = opts.maxTerms ?? 60;
  const terms = glossary.terms.slice(0, maxTerms);
  if (glossary.anchors.length === 0 && terms.length === 0) return '';
  const streamer = opts.streamer?.trim();
  const lines: string[] = [];
  lines.push('## 本场专有名词（**写法就是这样，不要改写、不要替换成同音词**）');
  if (streamer) {
    /* 词表是**跨主播**的全局词表（用户既看乙主播也看甲主播）。
       实测事故：这里以前把 anchors 整行写成「主播 / 常驻嘉宾：乙主播、甲主播」，
       模型就照着把甲主播的直播总结成了乙主播的 —— 所以本场主播必须单独一行说清，
       其余主播要显式标注"不是本场主播"。 */
    lines.push(`- 本场主播：${streamer}`);
    const others = glossary.anchors.filter((a) => a.trim() !== streamer);
    if (others.length) {
      lines.push(`- 词表里的其他主播（**不是本场主播**，只可能是被聊到的对象，不要用来称呼本场主播）：${others.join('、')}`);
    }
  } else if (glossary.anchors.length) {
    // 没能识别出本场是谁时，也不能让模型以为"这些都是本场主播"
    lines.push(`- 词表里的主播 / 常驻嘉宾（**本场具体是谁未确认**，请以转写内容为准）：${glossary.anchors.join('、')}`);
  }
  if (terms.length) lines.push(`- 术语 / 梗 / 栏目名：${terms.join('、')}`);
  if (glossary.terms.length > terms.length) lines.push(`- （其余 ${glossary.terms.length - terms.length} 个术语已省略）`);
  return lines.join('\n');
}

/** 可直接粘到支持热词的 ASR 里的词表（一行一个，逗号分隔的也附一份） */
export function hotWordsText(glossary: Glossary): { perLine: string; commaSeparated: string } {
  const all = [...glossary.anchors, ...glossary.terms];
  return { perLine: all.join('\n'), commaSeparated: all.join('，') };
}

/**
 * 术语表 → **ASR 热词数组**（Fun-ASR 的 `hotwords` 参数收的就是字符串数组）。
 *
 * 与 `hotWordsText()` 同源（anchors + terms），但这里做的是"喂给模型"而不是"给人看"，
 * 所以要多几道清洗 —— 这些规则都是为了让热词**只帮忙、不添乱**：
 *
 *  - 去首尾空白、丢掉空串：空热词会让模型的提示里出现空条目。
 *  - 丢掉过长条目（>20 字）：热词是"词"，一条 40 字的句子塞进去只会稀释其它词；
 *    长句本来就该由术语表纠错（`replacements`）处理。
 *  - 去重（大小写与全半角无关）：`anchors` 和 `terms` 里同一个词出现两次很常见。
 *  - 按 `max` 截断：热词不是越多越好 —— 太多会把解码带偏、也拖慢推理；
 *    截断时**先 anchors 后 terms**（主播名/嘉宾名错得最显眼），并如实返回被截掉的数量。
 *
 * 返回 `{ words, dropped }`：`dropped > 0` 时调用方要记一条日志，
 * 免得用户以为"我词表里明明有它，为什么没生效"。
 */
export function hotWordList(glossary: Glossary, opts: { max?: number } = {}): { words: string[]; dropped: number } {
  const max = Math.max(0, opts.max ?? 80);
  /* 容错：`data/glossary.json` 是用户可以手改的文件，缺字段/写成 null 都可能。
     这条路径通往 ASR，**不能因为词表长得不对就把转写搞崩**（测试当场抓到过：
     传 `{}` 直接 TypeError: glossary.anchors is not iterable）。 */
  const anchors = Array.isArray(glossary?.anchors) ? glossary.anchors : [];
  const terms = Array.isArray(glossary?.terms) ? glossary.terms : [];
  const seen = new Set<string>();
  const words: string[] = [];
  let dropped = 0;
  for (const raw of [...anchors, ...terms]) {
    const w = String(raw ?? '').trim();
    if (!w || w.length > 20) {
      if (w) dropped++;
      continue;
    }
    // 归一化只用于判重，传出去的仍是原样（大小写/全角形态由用户决定）
    const key = w.normalize('NFKC').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (words.length >= max) {
      dropped++;
      continue;
    }
    words.push(w);
  }
  return { words, dropped };
}

/* ============================================================================
 * 存储
 * ========================================================================== */

export class GlossaryStore {
  private p: string;
  private logger: Logger;
  private cache: { glossary: Glossary; mtime: number } | null = null;

  constructor(filePath: string = GLOSSARY_PATH, logger: Logger = globalLog) {
    this.p = filePath;
    this.logger = logger;
  }

  get path(): string {
    return this.p;
  }

  /** 读术语表：文件不存在时**自动创建骨架**（让用户有个能改的文件，而不是对着空目录猜） */
  load(): Glossary {
    try {
      if (!exists(this.p)) {
        writeJsonAtomic(this.p, skeleton());
        this.cache = { glossary: { ...EMPTY_GLOSSARY }, mtime: Date.now() };
        return this.cache.glossary;
      }
      const mtime = fs.statSync(this.p).mtimeMs;
      if (this.cache && this.cache.mtime === mtime) return this.cache.glossary;
      const { glossary, issues } = validateGlossary(readJson<unknown>(this.p));
      for (const i of issues) {
        if (i.level === 'error') this.logger.warn(`术语表问题：${i.message}`, { mod: 'glossary', data: { path: this.p } });
        else this.logger.debug(`术语表提示：${i.message}`, { mod: 'glossary' });
      }
      this.cache = { glossary, mtime };
      return glossary;
    } catch (e) {
      // 术语表坏掉不能拖垮整条链路 —— 退化为「没有术语表」
      this.logger.warn(`术语表读取失败，本次按空表处理：${(e as Error).message}`, { mod: 'glossary', data: { path: this.p } });
      return { ...EMPTY_GLOSSARY };
    }
  }

  /** 保存（UI 编辑入口）：宽松校验后落盘，返回校验问题供界面提示 */
  save(raw: unknown): { glossary: Glossary; issues: GlossaryIssue[] } {
    const { glossary, issues } = validateGlossary(raw);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length > 0) return { glossary: this.load(), issues };
    const next: Glossary = { ...glossary, version: glossary.version || 1, updatedAt: nowIso() };
    writeJsonAtomic(this.p, next);
    this.cache = { glossary: next, mtime: fs.statSync(this.p).mtimeMs };
    this.logger.info(
      `术语表已更新：主播 ${next.anchors.length} 个、术语 ${next.terms.length} 个、纠错规则 ${next.replacements.length} 条`,
      { mod: 'glossary' },
    );
    return { glossary: next, issues };
  }

  /** 供 UI 展示的统计 */
  stats(glossary: Glossary = this.load()): { anchors: number; terms: number; replacements: number; hotWords: number } {
    return {
      anchors: glossary.anchors.length,
      terms: glossary.terms.length,
      replacements: glossary.replacements.length,
      hotWords: glossary.anchors.length + glossary.terms.length,
    };
  }
}
