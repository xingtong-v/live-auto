/**
 * 核实：biliLive-tools 在 2026-09-22 那场直播，到底往 B站 投了**几个稿件**？
 *
 * 背景：我此前从源码推断「09-22 一场被 partMergeMinute=10 劈成 7 个稿件」，
 * 但用户指出「原版投稿就在一个稿件里」。推断与事实冲突时，以 B站 侧数据为准。
 *
 * 本工具只读：拉取账号下全部稿件（含自见/审核中），按时序列出，
 * 并把 09-22 前后的稿件单独拎出来核对。
 *
 * 用法：node --experimental-strip-types tools/verify-0922-archives.ts
 */
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

/** 拉多页，避免第一页 100 条装不下 */
async function allArchives(): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 5; page++) {
    const one = (await client.biliArchives({ page, pageSize: 100 })) as unknown as Array<Record<string, unknown>>;
    if (!one.length) break;
    let fresh = 0;
    for (const a of one) {
      const bvid = String(a['bvid'] ?? '');
      if (!bvid || seen.has(bvid)) continue;
      seen.add(bvid);
      out.push(a);
      fresh++;
    }
    if (fresh === 0) break;
  }
  return out;
}

const list = await allArchives();
console.log('='.repeat(100));
console.log(`账号下稿件总数：${list.length}`);
console.log('='.repeat(100));

const rows = list
  .map((a) => ({
    bvid: String(a['bvid'] ?? ''),
    aid: String(a['aid'] ?? ''),
    title: String(a['title'] ?? ''),
    dur: Number(a['duration'] ?? 0),
    ctime: Number(a['ctime'] ?? 0),
    state: String(a['state'] ?? ''),
    onlySelf: String(a['is_only_self'] ?? ''),
  }))
  .sort((x, y) => x.ctime - y.ctime);

console.log('\n全部稿件（按创建时间升序）');
console.log('ctime                时长     state  self  标题');
console.log('-'.repeat(100));
for (const r of rows) {
  const t = r.ctime > 1e9 ? new Date(r.ctime * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-';
  console.log(
    `${t.padEnd(20)} ${String(Math.round(r.dur / 60)).padStart(4)}分 ${r.state.padStart(6)} ${r.onlySelf.padStart(5)}  ${r.title.slice(0, 44)}`,
  );
}

/* 09-22 那场：标题里应含「来两下闪身步就好了」或日期 2026.09.22 */
const target = rows.filter((r) => /来两下闪身步就好了|2026\.09\.22|2026-09-22/.test(r.title));
console.log('\n' + '='.repeat(100));
console.log(`与 09-22 那场相关的稿件：${target.length} 个`);
console.log('='.repeat(100));
for (const r of target) {
  const t = new Date(r.ctime * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`  ${t}  时长 ${Math.round(r.dur / 60)} 分钟  bvid=${r.bvid}  aid=${r.aid}  state=${r.state}`);
  console.log(`      《${r.title}》`);
}

/* 长稿件（>20 分钟）视为完整版录播 */
const longOnes = rows.filter((r) => r.dur > 20 * 60);
console.log('\n' + '='.repeat(100));
console.log(`时长 >20 分钟的稿件（疑似完整版录播）：${longOnes.length} 个`);
console.log('='.repeat(100));
for (const r of longOnes) {
  const t = new Date(r.ctime * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`  ${t}  ${String(Math.round(r.dur / 60)).padStart(4)} 分钟  aid=${r.aid}  ${r.title.slice(0, 50)}`);
}

console.log('\n' + '='.repeat(100));
console.log('判读');
console.log('='.repeat(100));
console.log('  · 若 09-22 只有一个长稿件 ⇒ 我此前「被劈成 7 个稿件」的推断是**错的**');
console.log('  · 若 09-22 有多个长稿件 ⇒ 推断成立（需再确认它们是否都属于那一场）');
console.log('  · 注意本列表可能不含已被删除的稿件 —— 删掉的查不到，不能反证');
