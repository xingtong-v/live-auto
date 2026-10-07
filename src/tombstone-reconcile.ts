/**
 * 墓碑自动核对：**查不到的自动解除**（2026-10-07 用户要求「查不到的 自动解除」）。
 *
 * ## 背景
 *
 * 墓碑（见 `ledger.ts` 的 `FingerprintTombstone`）是「这段内容以前投过 B站、而当时的任务被删了」
 * 的防重复保险：重新投稿时会被自动跳过，避免在线上多出一份完全相同的稿件。
 *
 * 但它**没有自动过期**，只能人工逐条解除 —— 实测健康面板上挂了 118 条，其中很多是
 * 「旧稿件早就删了」或「当年压根没反查到 bvid」的，用户只能一条条去创作中心核对。
 *
 * ## 判定规则（宁可留着，也不误放）
 *
 * | 情况 | 结论 |
 * |---|---|
 * | 有 bvid，且它还在**我的稿件列表**里 | **保留**（旧稿件还在，墓碑正当事） |
 * | 有 bvid，列表拿全了却没有它，且详情接口明确报「稿件不存在」 | **解除** |
 * | 有 bvid，列表没拿全 / 详情报的是别的错（限流、500、审核中） | **保留**（说不清，不用不完整的证据放行） |
 * | 没有 bvid（当年只走到「已提交」），但按**切片标题**在某个稿件的**分P 标题**里找到了 | **保留**，并顺手补记 bvid |
 * | 没有 bvid，列表拿全、分P 也都扫完了，确实找不到 | **解除** |
 * | 没有 bvid，但列表没拿全 / 有稿件的详情拉失败 / 详情调用数超上限 | **保留**（算「没查全」） |
 *
 * 两个刻意的设计：
 * 1. **不用「列表里没有」单独下结论** —— 稿件数超过一页时列表会截断，那会把第 101 个之后的稿件
 *    误判成「已删」（`refreshPerformance` 的注释里记过同类事故）。所以必须 `listComplete`
 *    （列表返回条数 < 页大小）才允许得出「查不到」的结论。
 * 2. **解除一定留痕**：`ledger.releaseTombstone()` 会往 `publish-log.jsonl` 追一条
 *    `tombstone-release`，「为什么当初又投了一遍」事后永远查得到。
 */

import type { Logger } from './logger.ts';
import type { Ledger, TombstoneEntry } from './ledger.ts';
import { isArchiveGoneError } from './publish.ts';

/** 只依赖用到的两个接口，测试里可以直接塞 mock（daemon 传真 client 就行） */
export interface TombstoneReconcileClient {
  biliArchives(params: { page?: number; pageSize?: number }): Promise<Array<Record<string, unknown>>>;
  biliArchiveDetail(bvid: string, opts?: { retry?: number }): Promise<Record<string, unknown>>;
}

export interface TombstoneVerdict {
  fingerprint: string;
  title?: string;
  bvid?: string;
  why: string;
}

export interface TombstoneReconcileResult {
  /** 一共核对了多少条墓碑 */
  checked: number;
  released: number;
  /** 解除的那些里，有多少是因为「唯一可能的旧稿件在 B站 侧已锁定/读不到」 */
  inaccessibleReleases: number;
  kept: number;
  /** 证据不足、保留待下次（列表没取全 / 详情失败 / 详情调用超上限） */
  unverified: number;
  releasedList: TombstoneVerdict[];
  keptList: TombstoneVerdict[];
  notes: string[];
  /** 是否只是预演（不真的解除） */
  dryRun: boolean;
}

/** 我的稿件列表一页取多少 —— 与 refreshPerformance 保持一致 */
export const TOMBSTONE_LIST_PAGE_SIZE = 100;
/** 单轮最多拉多少个稿件详情（分P 标题核对用）。没扫完的墓碑算「证据不足」，保留待下次 */
export const TOMBSTONE_DETAIL_CAP = 100;
/** 相邻两次详情请求之间的间隔：一天一次的后台任务，宁可慢一点也别给 B站 接口上强度 */
export const TOMBSTONE_PACE_MS = 150;

export async function reconcileTombstones(opts: {
  ledger: Ledger;
  client: TombstoneReconcileClient;
  logger?: Logger;
  /** 预演：只报会解除哪些，不真的动台账 */
  dryRun?: boolean;
  detailCap?: number;
  /** 详情请求之间的间隔（毫秒），测试里传 0 */
  paceMs?: number;
}): Promise<TombstoneReconcileResult> {
  const { ledger, client } = opts;
  const dryRun = opts.dryRun === true;
  const detailCap = opts.detailCap ?? TOMBSTONE_DETAIL_CAP;
  const paceMs = opts.paceMs ?? TOMBSTONE_PACE_MS;
  const notes: string[] = [];
  const releasedList: TombstoneVerdict[] = [];
  const keptList: TombstoneVerdict[] = [];

  const tombs = ledger.listTombstones();
  if (tombs.length === 0) {
    return {
      checked: 0,
      released: 0,
      inaccessibleReleases: 0,
      kept: 0,
      unverified: 0,
      releasedList,
      keptList,
      notes: ['没有墓碑，无需核对'],
      dryRun,
    };
  }

  /* ---- 我的稿件列表：一次请求，两处用（bvid 是否存在、分P 标题扫描的候选） ---- */
  let listed: Array<{ bvid: string; title?: string; ctime?: number; state?: number }> = [];
  let listOk = false;
  let listComplete = false;
  try {
    const archives = await client.biliArchives({ page: 1, pageSize: TOMBSTONE_LIST_PAGE_SIZE });
    listed = archives
      .map((a) => ({
        bvid: String(a['bvid'] ?? '').trim(),
        ...(typeof a['title'] === 'string' ? { title: a['title'] } : {}),
        ...(typeof a['ctime'] === 'number' ? { ctime: a['ctime'] } : {}),
        ...(typeof a['state'] === 'number' ? { state: a['state'] } : {}),
      }))
      .filter((a) => a.bvid.length > 0)
      /* 新的排前面：详情调用触顶时，优先扫最近的稿件（旧墓碑多半也对应旧稿件） */
      .sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0));
    listOk = true;
    listComplete = archives.length < TOMBSTONE_LIST_PAGE_SIZE;
  } catch (e) {
    notes.push(`读取我的稿件列表失败：${(e as Error).message.slice(0, 80)} —— 本轮只能核对 bvid 已在列表里的情况`);
  }
  const listedBvids = new Set(listed.map((a) => a.bvid));

  /* ---- 稿件详情（分P 标题）带缓存：同一份稿件只拉一次，且全轮共用 ---- */
  const detailCache = new Map<string, { ok: boolean; parts: string[]; err?: string; gone?: boolean }>();
  /** 拉失败的稿件详情（bvid → 错因）：这些会让「查不到」的结论不成立，必须报出来而不是静默保留 */
  const scanErrors = new Map<string, string>();
  let detailCalls = 0;
  const partsOf = async (bvid: string): Promise<{ ok: boolean; parts: string[]; err?: string; gone?: boolean }> => {
    const hit = detailCache.get(bvid);
    if (hit) return hit;
    if (detailCalls >= detailCap) return { ok: false, parts: [], err: `详情调用已达上限 ${detailCap}` };
    if (detailCalls > 0 && paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
    detailCalls++;
    try {
      const detail = await client.biliArchiveDetail(bvid, { retry: 0 });
      const view = (detail['View'] ?? detail) as Record<string, unknown>;
      const pages = Array.isArray(view['pages']) ? (view['pages'] as Array<Record<string, unknown>>) : [];
      const parts = pages.map((p) => String(p['part'] ?? '').trim()).filter(Boolean);
      const rec = { ok: true, parts };
      detailCache.set(bvid, rec);
      return rec;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 80);
      /* 「稿件不存在」与「读不到（已锁定/500/限流）」要分开：前者说明这份稿件藏不了东西，
         后者只是我们看不见 —— 一个不拦路，一个要按策略处理。 */
      const rec = { ok: false, parts: [] as string[], err: msg, gone: isArchiveGoneError(msg) };
      detailCache.set(bvid, rec);
      scanErrors.set(bvid, msg);
      return rec;
    }
  };

  let kept = 0;
  let unverified = 0;
  let released = 0;
  /** 其中「旧稿件在 B站 侧已锁定/读不到」而解除的条数（口径要写清楚，别混进"扫遍都没有"里） */
  let inaccessibleReleases = 0;

  for (const t of tombs) {
    const shown = { fingerprint: t.fingerprint, ...(t.title ? { title: t.title } : {}), ...(t.bvid ? { bvid: t.bvid } : {}) };
    const label = `「${t.title ?? '(无标题)'}」`;

    /* ---------- ① bvid 已知 ---------- */
    if (t.bvid) {
      if (listedBvids.has(t.bvid)) {
        kept++;
        keptList.push({ ...shown, why: '旧稿件还在我的稿件列表里' });
        continue;
      }
      if (!listOk || !listComplete) {
        unverified++;
        continue;
      }
      let verdict: 'gone' | 'alive' | 'unknown' = 'unknown';
      let errMsg = '';
      try {
        await client.biliArchiveDetail(t.bvid, { retry: 0 });
        verdict = 'alive';
      } catch (e) {
        errMsg = (e as Error).message.slice(0, 80);
        verdict = isArchiveGoneError(errMsg) ? 'gone' : 'unknown';
      }
      if (verdict === 'alive') {
        /* 列表缓存延迟（B站 侧分P/稿件列表有几分钟到几十分钟的滞后），详情能查到就算在 */
        kept++;
        keptList.push({ ...shown, why: '详情接口仍能查到该稿件（列表可能有延迟）' });
        continue;
      }
      if (verdict === 'unknown') {
        unverified++;
        notes.push(`墓碑 ${label} 的旧稿件 ${t.bvid} 查不动（${errMsg}），保留待下次`);
        continue;
      }
      const why = `旧稿件 ${t.bvid} 既不在我的稿件列表里，详情接口也明确报「不存在」（${errMsg}）`;
      if (!dryRun) ledger.releaseTombstone(t.fingerprint, { note: `自动核对解除：${why}` });
      released++;
      releasedList.push({ ...shown, why });
      continue;
    }

    /* ---------- ② bvid 未知（当年只走到「已提交」）----------
       按**切片标题**在稿件的分P 标题里找。注意：稿件列表给的是**稿件标题**，
       而墓碑记的是**切片（分P）标题** —— 这就是它们当初「未反查到 bvid」的原因，
       所以必须拉详情看 pages[].part，不能只比列表标题。 */
    if (!listOk || !listComplete) {
      unverified++;
      notes.push(`墓碑 ${label} 没有 bvid，且稿件列表没取全（可能超过一页），保留待下次`);
      continue;
    }
    const want = (t.title ?? '').trim();
    if (!want) {
      unverified++;
      continue;
    }
    /* 扫描顺序：先扫「同一场」的稿件。**相关性判据用时间窗 ±24 小时**（实测：稿件的 ctime
       比立碑时间早 16~21 分钟，因为完整版稿件是那场直播刚结束时建好、我们的切片过一两小时才追加进去的），
       所以同一场的稿件一定落在窗口内、隔天的场次一定落在窗口外。
       顺序只影响"多快命中"，不影响结论；结论只要求「**可能相关**的稿件都扫过」。
       这道相关性判断是必须的：有一份稿件详情报 500（B站 侧 state=-4 已锁定，读不到分P），
       若把它当成所有墓碑的拦路石，那 58 条会永远停在"证据不足"（第一版就是这样，一条都放不掉）。 */
    const atMs = Date.parse(t.at);
    const relevantArchive = (c?: number): boolean =>
      !Number.isFinite(atMs) || typeof c !== 'number' || Math.abs(c * 1000 - atMs) <= 24 * 3600_000;
    const ordered = Number.isFinite(atMs)
      ? [...listed].sort(
          (a, b) => Number(relevantArchive(b.ctime)) - Number(relevantArchive(a.ctime)) || (b.ctime ?? 0) - (a.ctime ?? 0),
        )
      : listed;
    let found: string | undefined;
    /** 读不到、且时间上**可能**藏有这段内容的稿件。`locked` = B站 侧已锁定（不公开） */
    const blockers: Array<{ bvid: string; reason: string; locked: boolean }> = [];
    for (const a of ordered) {
      const locked = typeof a.state === 'number' && a.state !== 0;
      const cached = detailCache.has(a.bvid);
      if (!cached && detailCalls >= detailCap) {
        if (relevantArchive(a.ctime)) blockers.push({ bvid: a.bvid, reason: `详情调用已达上限 ${detailCap}`, locked });
        continue;
      }
      const d = await partsOf(a.bvid);
      if (!d.ok) {
        /* ★ 「啥都木有」（HTTP 500）同时出现在两种情形：稿件真没了、以及稿件已锁定读不到。
           `isArchiveGoneError` 认不出这个区别，所以这里以**列表里的 state 为准**：
           列表说它已锁定（state≠0）就是"读不到"，不能当成"不存在"混过去
           —— 否则解除依据会写成"扫遍都没有"，而事实是那份稿件压根没读到。 */
        if (d.gone && !locked) continue; // 确实不存在 ⇒ 藏不了东西，不是拦路石
        if (relevantArchive(a.ctime)) blockers.push({ bvid: a.bvid, reason: d.err ?? '详情拉取失败', locked });
        continue;
      }
      if (d.parts.includes(want)) {
        found = a.bvid;
        break;
      }
    }
    if (found) {
      /* 补记 bvid：下次核对直接查它，界面上也能给出「一键打开旧稿件」 */
      if (!dryRun) ledger.setTombstoneBvid(t.fingerprint, found);
      kept++;
      keptList.push({ ...shown, bvid: found, why: `按分P 标题在稿件 ${found} 里找到了同一段内容` });
      continue;
    }
    /* 没命中：能不能下「查不到」的结论，取决于那些读不到的稿件是不是**可能藏着它**。
       - 时间上相关的稿件里，只要有一份是"公开但这次没拉到"（限流/超时/500 未锁定）⇒ 保留，下次再试；
       - 若时间上相关的都**已锁定/已不存在**（我们永远读不到它，B站 上也不公开）⇒ 按用户要求
         「查不到的自动解除」解除，但单独计数、并把那份稿件写进解除依据（留痕可查）。 */
    const hardBlockers = blockers.filter((b) => !b.locked);
    if (hardBlockers.length) {
      unverified++;
      notes.push(
        `墓碑 ${label} 没有 bvid，且时间上相关的稿件里有 ${hardBlockers.length} 份公开稿件这次没拉到（保留待下次）：` +
          hardBlockers.slice(0, 2).map((b) => `${b.bvid}（${b.reason}）`).join(' / '),
      );
      continue;
    }
    const lockedNote = blockers.length
      ? `；时间上相关的 ${blockers.length} 份旧稿件在 B站 侧已锁定/读不到（${blockers[0]!.bvid}，state≠0），` +
        `既然拿不到就当查不到`
      : '；所有可能与它相关的稿件都读到了，都没有这一段';
    const why = `没有 bvid，按切片标题把可能与它相关的稿件扫了一遍（读完 ${detailCache.size} 份详情）没找到${lockedNote}`;
    if (blockers.length) inaccessibleReleases++;
    if (!dryRun) ledger.releaseTombstone(t.fingerprint, { note: `自动核对解除：${why}` });
    released++;
    releasedList.push({ ...shown, why });
  }

  notes.unshift(
    `墓碑自动核对${dryRun ? '（预演）' : ''}：共 ${tombs.length} 条 —— 保留 ${kept}、解除 ${released}` +
      (inaccessibleReleases ? `（其中 ${inaccessibleReleases} 条是因为旧稿件已锁定/读不到）` : '') +
      `、证据不足待下次 ${unverified}` +
      (listOk ? `（我的稿件 ${listed.length} 个${listComplete ? '，列表已取全' : '，⚠ 列表可能被截断'}）` : '（⚠ 稿件列表没取到）') +
      `；本轮拉了 ${detailCalls} 份稿件详情。`,
  );
  opts.logger?.info(notes[0]!, { mod: 'ledger', data: { released, inaccessibleReleases, kept, unverified, dryRun } });
  return { checked: tombs.length, released, inaccessibleReleases, kept, unverified, releasedList, keptList, notes, dryRun };
}
