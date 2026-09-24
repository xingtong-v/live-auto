/**
 * 投稿标题审计（只读）：把「台账里记录的标题」与「B站上实际存在的稿件标题」逐条对照。
 *
 * 回答四个问题：
 *   1. 投稿时用的标题是什么、会不会被截断、有没有残留错词/无意义标记；
 *   2. 台账里的 bvid 在 B站 上**标题是否一致** —— 不一致意味着幂等校验（按标题反查）会失效，
 *      下次重跑可能重复投稿；
 *   3. 本地有没有重复标题；
 *   4. B站 账号上有没有重复标题（同标题两个稿件）。
 *
 * 只读，不改任何状态、不提交任何东西。
 *
 * 用法：node tools/title-audit.ts [taskId]
 */
import { Ledger } from '../src/ledger.ts';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';
import { GlossaryStore } from '../src/glossary.ts';
import { sanitizeTitle } from '../src/analyze.ts';
import { log } from '../src/logger.ts';

const LIMIT = 80;

async function main(): Promise<void> {
  const ledger = new Ledger();
  const cfg = loadConfig().config;
  const glossary = new GlossaryStore(undefined, log).load();
  const taskId = process.argv[2] ?? ledger.listTasks({ limit: 50 })[0]?.id;
  if (!taskId) {
    console.log('没有任务');
    process.exit(1);
  }
  const task = ledger.getTask(taskId);
  if (!task) {
    console.log(`任务不存在：${taskId}`);
    process.exit(1);
  }
  const clips = ledger.getClips(taskId);
  const suffix = cfg.publish.defaultTitleSuffix || '';

  console.log(`\x1b[1m投稿标题审计\x1b[0m  ${task.id}`);
  console.log(`任务状态：${task.status}　标题：${task.title.slice(0, 50)}`);
  console.log(`标题后缀：${suffix ? `"${suffix}"` : '（未配置）'}`);
  console.log('─'.repeat(96));

  for (const c of clips.sort((a, b) => a.index - b.index)) {
    const raw = c.title ?? '';
    const st = sanitizeTitle(raw, LIMIT);
    const withSuffix = suffix && !st.title.endsWith(suffix) ? sanitizeTitle(`${st.title}${suffix}`, LIMIT) : st;
    const finalLen = [...withSuffix.title].length;
    const flags: string[] = [];
    if (st.truncated) flags.push('\x1b[31m会被截断\x1b[0m');
    if (withSuffix.truncated && !st.truncated) flags.push('\x1b[33m加后缀后截断\x1b[0m');
    if (!raw.trim()) flags.push('\x1b[31m空标题\x1b[0m');
    if (/（待填写）|待填写/.test(raw)) flags.push('\x1b[31m占位标题\x1b[0m');
    if (/[\r\n]/.test(raw)) flags.push('\x1b[33m含换行\x1b[0m');
    if (/\s{2,}/.test(raw)) flags.push('\x1b[33m连续空格\x1b[0m');
    if (/[0-9a-f]{16,}/i.test(raw)) flags.push('\x1b[31m疑似哈希\x1b[0m');
    if (/片段\s*\d+|clip\s*\d+/i.test(raw)) flags.push('\x1b[33m含内部编号\x1b[0m');
    // 术语表里的「错词」还留在标题里 → 说明专有名词被改写了
    for (const r of glossary.replacements) {
      const hit = r.regex ? new RegExp(r.from).test(raw) : raw.includes(r.from);
      if (hit) flags.push(`\x1b[31m残留错词「${r.from}」应作「${r.to}」\x1b[0m`);
    }

    console.log(
      `#${c.index} [${c.status}${c.bvid ? ` ${c.bvid}` : ''}] ${finalLen}/${LIMIT} 字符` +
        (c.dtime ? `　排期 ${new Date(c.dtime * 1000).toLocaleString()}` : ''),
    );
    console.log(`   ${raw}`);
    if (raw !== withSuffix.title) console.log(`   \x1b[90m→ 提交时实际为：${withSuffix.title}\x1b[0m`);
    if (flags.length) console.log(`   ⚠ ${flags.join('　')}`);
    console.log('');
  }

  const dupes = new Map<string, number[]>();
  for (const c of clips) {
    const t = (c.title ?? '').trim();
    if (!t) continue;
    dupes.set(t, [...(dupes.get(t) ?? []), c.index]);
  }
  const dup = [...dupes.entries()].filter(([, idx]) => idx.length > 1);
  console.log(dup.length ? `\x1b[31m本地重复标题：${dup.map(([t, i]) => `#${i.join('/')} ${t.slice(0, 20)}`).join('；')}\x1b[0m` : '本地标题无重复');

  /* ---- 与 B站 侧对照：台账 bvid ↔ 线上标题 ---- */
  await remote(clips.map((c) => ({ index: c.index, bvid: c.bvid, title: c.title ?? '', status: c.status })));
}

async function remote(local: Array<{ index: number; bvid?: string; title: string; status: string }>): Promise<void> {
  const cfg = loadConfig().config;
  const client = BiliLiveClient.fromConfig(cfg, log);
  try {
    // 不带 uid 也能返回当前账号的稿件（biliLive-tools 侧已登录）
    const list = await client.biliArchives({ page: 1, pageSize: 50 });
    const byBvid = new Map(list.map((a) => [String(a.bvid), a]));
    console.log(`\n\x1b[1m台账 ↔ B站 标题对照\x1b[0m（列表接口返回 ${list.length} 条）`);
    let mismatch = 0;
    let missing = 0;
    for (const c of local) {
      if (!c.bvid) {
        console.log(`  #${c.index} \x1b[90m${c.status} 无 bvid（尚未反查到）\x1b[0m`);
        continue;
      }
      let onlineTitle = byBvid.get(c.bvid)?.title ? String(byBvid.get(c.bvid)!.title) : '';
      let source = '列表';
      if (!onlineTitle) {
        // ★ 列表接口不一定包含所有稿件（实测切片稿件就不在里面），
        //   所以必须再用「单稿件详情」按 bvid 直接问一次 —— 这才是线上标题的权威来源。
        try {
          const d = await client.biliArchiveDetail(c.bvid);
          const t = (d as { title?: string }).title;
          if (t) {
            onlineTitle = String(t);
            source = '详情';
          }
        } catch {
          /* 详情也拿不到就按"查不到"处理 */
        }
      }
      if (!onlineTitle) {
        missing++;
        console.log(`  #${c.index} \x1b[31m${c.bvid} 列表与详情都拿不到，无法核对线上标题\x1b[0m`);
        console.log(`      台账标题：${c.title}`);
        continue;
      }
      const same = onlineTitle.trim() === c.title.trim();
      if (same) {
        console.log(`  #${c.index} \x1b[32m✓ ${c.bvid}\x1b[0m（${source}）${[...onlineTitle].length}/80  ${onlineTitle}`);
      } else {
        mismatch++;
        console.log(`  #${c.index} \x1b[31m✗ ${c.bvid} 标题不一致\x1b[0m（${source}）`);
        console.log(`      台账：${c.title}`);
        console.log(`      线上：${onlineTitle}`);
      }
    }
    console.log(
      mismatch === 0 && missing === 0
        ? '\x1b[32m台账与线上标题完全一致 —— 幂等反查（按标题）不会失效。\x1b[0m'
        : `\x1b[31m有 ${mismatch} 条标题不一致、${missing} 条查不到 —— 幂等反查按标题匹配，不一致会导致下次重跑重复投稿。\x1b[0m`,
    );

    const seen = new Map<string, string[]>();
    for (const a of list) seen.set(String(a.title), [...(seen.get(String(a.title)) ?? []), String(a.bvid)]);
    const d = [...seen.entries()].filter(([, v]) => v.length > 1);
    console.log(d.length ? `\x1b[33mB站侧重复标题：${d.map(([t, v]) => `${v.join('/')} ${t.slice(0, 26)}`).join('；')}\x1b[0m` : 'B站侧无重复标题');
  } catch (e) {
    console.log(`\n（B站侧对照失败：${(e as Error).message}）`);
  }
}

await main();
