/**
 * 昵称候选查重（只读、无凭据、一次性工具，**不属于流水线**）。
 *
 * ## 先记住三条实测出来的规则
 *
 * 1. **长度上限 16 字符，一个汉字算 1 个字符**。
 *    标定方法：用搜索接口捞 317 个真实昵称，最长的是「我是一颗小星星点歌台」= 10 个汉字 /
 *    10 个字符 —— 若汉字按 2 个算，10 汉字 = 20 早就超 16 了。文档口径也是 2–16 字符。
 * 2. **只允许 `-` 和 `_` 两个特殊字符**（其它符号会被拒：code 40004）。
 * 3. passport 的昵称校验接口**已失效**，不能用来判断重名（见下）。
 *
 * ## 为什么不直接用 passport 的 check/nickname
 *
 * 那个接口（`https://passport.bilibili.com/web/generic/check/nickname`）**已经失效**：
 * 实测连文档里明确该报错的样本都返回 `{"code":0}` ——
 *   `test`（文档：40014 昵称已存在）→ `{"code":0}`
 *   `test0000000000000␠`（文档：40005 过长）→ `{"code":0}`
 *   `//`（文档：40004 特殊字符）→ `{"code":0}`
 * 连**用户当前昵称**也返回可用。所以它不能作为任何依据（谁拿它写查重，结论必然是「全都可用」）。
 *
 * ## 用什么代替
 *
 * B站 用户搜索接口是真的（返回 `numResults` 与用户列表）：
 *   GET https://api.bilibili.com/x/web-interface/search/type?search_type=bili_user&keyword=...
 * 判据：结果里**存在 uname 与候选完全相同**的用户 → 已被占用；一个都没有 → 大概率可用。
 * 注意它可能返回模糊命中，所以**必须按 uname 精确比对**，不能只看 numResults。
 * 另：不带设备 cookie 时它会返回 HTML 风控页，所以要先取匿名 `buvid3/buvid4`。
 *
 * 控制组（必须验）：本人当前昵称应命中 1 个（就是用户自己）、`乙主播` 应命中。
 * 控制组不通过就说明这套判据本身不可信，不能拿结论去改名。
 *
 * 本脚本只发 GET、不带账号 cookie / 不登录、不写文件；候选之间 sleep 1.2s、失败退避重试。
 *
 * 用法：
 *   node tools/nickname-probe.ts                       # 内置候选清单 + 控制组
 *   node tools/nickname-probe.ts 示例账号捏切片屋 全自动示例账号捏
 */
const ENDPOINT = 'https://api.bilibili.com/x/web-interface/search/type';

/** 内置候选：全部**连续包含**「示例账号捏」 */
const CANDIDATES = [
  /* 官方感（对齐 乙主播 的形态） */
  '示例账号捏Official',
  '示例账号捏_Official',
  /* 项目梗（这个项目就是「全自动切片」） */
  '示例账号捏的切片屋',
  '示例账号捏切片机',
  '示例账号捏切片屋',
  '全自动示例账号捏',
  '示例账号捏_切片版',
  '示例账号捏的录播屋',
  '示例账号捏的切片机',
  /* 萌系 / 语气（「捏」本来就是语气词，接着叠最自然） */
  '示例账号捏捏',
  '示例账号捏捏捏',
  '示例账号捏不捏',
  '示例账号捏喵',
  '小星星示例账号捏',
  /* 长名（16 字符上限附近，用于确认到底能多长） */
  '全自动切片机示例账号捏',
  '示例账号捏的自动切片屋',
];

/** 控制组：已知必然被占用的名字。它们不通过，整份结论就不能用 */
const CONTROLS = ['示例账号捏', '乙主播'];

interface UserHit {
  uname: string;
  mid?: number;
  fans?: number;
}

interface SearchOutcome {
  /** 与候选**完全相同**的用户名个数（真正的判据） */
  exact: number;
  /** 接口报的模糊命中总数 */
  fuzzy: number;
  hits: UserHit[];
  error?: string;
}

/** B站 搜索结果里的 uname 带高亮标签，必须剥掉再比对 */
function stripTags(s: string): string {
  return String(s).replace(/<[^>]*>/g, '').trim();
}

/**
 * 取匿名设备 cookie。
 *
 * 实测：不带 cookie 直接搜，B站 会返回 HTML 风控页（`<!DOCTYPE ...`），JSON.parse 直接炸。
 * 浏览器首次访问时会先调这个接口拿 `buvid3/buvid4`，这里照做 —— 它是**匿名**的，
 * 与账号无关、不含任何凭据（本工具自始至终不登录、不带 cookie 文件）。
 */
let cookieHeader = '';
async function bootstrapCookies(): Promise<string> {
  try {
    const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json()) as { data?: { b_3?: string; b_4?: string } };
    const b3 = j.data?.b_3;
    const b4 = j.data?.b_4;
    if (b3) {
      cookieHeader = `buvid3=${b3};${b4 ? ` buvid4=${b4};` : ''} b_nut=${Math.floor(Date.now() / 1000)}`;
      return cookieHeader;
    }
    return '（拿不到 b_3，将不带 cookie 请求）';
  } catch (e) {
    return `（取设备 cookie 失败：${(e as Error).message.slice(0, 60)}）`;
  }
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function searchOnce(nick: string): Promise<SearchOutcome> {
  const url = `${ENDPOINT}?search_type=bili_user&keyword=${encodeURIComponent(nick)}&page=1`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://search.bilibili.com/',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!text.trimStart().startsWith('{')) {
      /* HTML = 风控页，交给上层退避重试 */
      return { exact: 0, fuzzy: 0, hits: [], error: `HTML 风控页（HTTP ${res.status}）` };
    }
    const j = JSON.parse(text) as {
      code?: number;
      message?: string;
      data?: { numResults?: number; result?: Array<Record<string, unknown>> };
    };
    if (Number(j.code) !== 0) return { exact: 0, fuzzy: 0, hits: [], error: `code=${String(j.code)} ${j.message ?? ''}` };
    const raw = Array.isArray(j.data?.result) ? j.data!.result! : [];
    const hits: UserHit[] = raw.map((u) => ({
      uname: stripTags(String(u['uname'] ?? '')),
      ...(u['mid'] !== undefined ? { mid: Number(u['mid']) } : {}),
      ...(u['fans'] !== undefined ? { fans: Number(u['fans']) } : {}),
    }));
    return {
      exact: hits.filter((h) => h.uname === nick).length,
      fuzzy: Number(j.data?.numResults ?? hits.length),
      hits,
    };
  } catch (e) {
    return { exact: 0, fuzzy: 0, hits: [], error: `请求失败：${(e as Error).message.slice(0, 80)}` };
  }
}

/** 带退避重试：风控是概率性的，退避后通常能过 */
async function searchNickname(nick: string): Promise<SearchOutcome> {
  let last: SearchOutcome = { exact: 0, fuzzy: 0, hits: [], error: '未执行' };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((s) => setTimeout(s, 1500 * attempt));
    last = await searchOnce(nick);
    if (!last.error) return last;
    /* 风控/网络问题才重试；code 非 0（接口层拒绝）原样返回 */
    if (!/风控|请求失败/.test(last.error)) return last;
  }
  return last;
}

const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const raw = argv.length > 0 ? argv : CANDIDATES;

/* 硬性要求：必须**连续**包含「示例账号捏」。写错顺序或拆开就直接剔除，不能靠肉眼看 */
const ANCHOR = '示例账号捏';
const bad = raw.filter((c) => !c.includes(ANCHOR));
if (bad.length > 0) console.log(`\x1b[31m剔除 ${bad.length} 个没有连续包含「${ANCHOR}」的候选：${bad.join('、')}\x1b[0m\n`);
const candidates = raw.filter((c) => c.includes(ANCHOR));

console.log(`设备 cookie：${(await bootstrapCookies()).slice(0, 48)}…\n`);

/* ---- 第一步：控制组自证 ---- */
console.log('\x1b[1m控制组自证\x1b[0m（这两个必然被占用；不通过说明判据不可信）');
console.log('-'.repeat(74));
let controlsOk = true;
for (const c of CONTROLS) {
  const r = await searchNickname(c);
  const pass = r.exact >= 1;
  if (!pass) controlsOk = false;
  const who = r.hits
    .filter((h) => h.uname === c)
    .map((h) => `mid=${h.mid ?? '?'} 粉丝=${h.fans ?? '?'}`)
    .join('; ');
  console.log(
    `  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${c.padEnd(20)} 同名 ${r.exact} 个  ${who}${r.error ? `  (${r.error})` : ''}`,
  );
  await new Promise((s) => setTimeout(s, 1200));
}
console.log(
  controlsOk
    ? '\x1b[32m控制组通过 —— 判据有效，可以看候选结果。\x1b[0m\n'
    : '\x1b[31m控制组未通过 —— 搜索接口没有给出预期结果，下面的候选结论一律不可用！\x1b[0m\n',
);

/* ---- 第二步：候选查重 ---- */
console.log(`\x1b[1m候选查重\x1b[0m（${candidates.length} 个，全部连续包含「示例账号捏」）`);
console.log('-'.repeat(74));
console.log('字符数  判定        候选');
let free = 0;
let failed = 0;
const verdicts: Array<{ nick: string; len: number; taken: boolean; failed: boolean; who: string }> = [];
for (const nick of candidates) {
  const r = await searchNickname(nick);
  const len = [...nick].length;
  const isFailed = Boolean(r.error);
  const taken = !isFailed && r.exact >= 1;
  if (isFailed) failed++;
  else if (!taken) free++;
  const who = r.hits
    .filter((h) => h.uname === nick)
    .map((h) => `mid=${h.mid ?? '?'} 粉丝=${h.fans ?? '?'}`)
    .join('; ');
  const tag = isFailed ? '\x1b[31m查询失败\x1b[0m' : taken ? '\x1b[33m已占用\x1b[0m' : '\x1b[32m未见同名\x1b[0m';
  console.log(
    `${String(len).padStart(5)}   ${tag}    ${nick}${who ? `  （${who}）` : ''}${isFailed ? `  （${r.error}）` : ''}`,
  );
  verdicts.push({ nick, len, taken, failed: isFailed, who });
  await new Promise((s) => setTimeout(s, 1200));
}

console.log('-'.repeat(74));
/* 长度：B站 文档口径是 2–16 字符；这里按码点数（一个汉字算一个）给出，改名框还会再校验一次 */
const ok = verdicts.filter((v) => !v.failed && !v.taken && v.len <= 16);
console.log(
  `\n汇总：查询成功 ${verdicts.length - failed} 个 → 未见同名 ${free} 个、已占用 ${verdicts.length - failed - free} 个` +
    `${failed ? `、查询失败 ${failed} 个（风控，可隔几分钟重跑）` : ''}。`,
);
console.log(`其中「未见同名且 ≤16 字符」的 ${ok.length} 个：`);
for (const v of ok.sort((a, b) => a.len - b.len)) console.log(`  ${String(v.len).padStart(2)} 字符  ${v.nick}`);
console.log('\n注意：「未见同名」= B站 用户搜索里没有 uname 完全相同的用户，不等于官方保证可注册；');
console.log('      最终以改名提交时的结果为准。');
