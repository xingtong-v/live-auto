/**
 * 探查：切片能不能追加进 **biliLive-tools 已投出的那个稿件**（同一个稿件）。
 *
 * 背景（用户的问题）：一场 4 小时的直播在 biliLive-tools 里按 59 分钟分段录成 4 个文件，
 * biliLive-tools 自己把这 4 段投成「1 个稿件的 N 个分P」（已从它的 asar 源码确认：
 * `Live.parts[]` + `uploadToSameMedia` → `editMedia` append）。
 * 那切片助手能不能把切片也追加进**同一个**稿件？本脚本用**真实稿件列表 + 真实台账**
 * 跑一遍已经上线的解析函数（`resolveResumeTarget` / `archivePartCount`），给出实际命中结果。
 *
 * 本脚本**只读**：不投稿、不改台账、不碰 biliLive-tools。
 *
 * 用法：node tools/resume-target-probe.ts
 */
import { BiliLiveClient } from '../src/api.ts';
import type { ArchiveItem } from '../src/types.ts';
import { loadConfig } from '../src/config.ts';
import { Ledger } from '../src/ledger.ts';
import { archivePartCount, cleanLiveTitle, guessAnchorName, resolveResumeTarget, taskDateText } from '../src/publish.ts';

const cfg = loadConfig().config;
const client = BiliLiveClient.fromConfig(cfg);
const ledger = new Ledger();

/* 单页只回 10 条（实测 ps=100 也被截到 10），必须翻页，否则会误判「没有完整版稿件」 */
const archives: ArchiveItem[] = [];
const seenBvid = new Set<string>();
for (let page = 1; page <= 12; page++) {
  const one = await client.biliArchives({ page, pageSize: 50 });
  const fresh = one.filter((a) => a.bvid && !seenBvid.has(a.bvid));
  if (fresh.length === 0) break;
  for (const a of fresh) seenBvid.add(a.bvid!);
  archives.push(...fresh);
}
console.log(`稿件列表：翻页共取到 ${archives.length} 条\n`);

/* 只打印「像 biliLive-tools 投的完整版」的（标题以账号名开头、结尾是日期），切片稿件不列 */
const fullLike = archives.filter((a) => /\d{4}\.\d{2}\.\d{2}$/.test(String(a.title ?? '')));
console.log(`其中「完整版录播」形态（标题以日期结尾）${fullLike.length} 条：`);
for (const a of fullLike.slice(0, 12)) {
  const n = a.bvid ? archivePartCount(await client.biliArchiveDetail(a.bvid, { retry: 0 }).catch(() => undefined)) : undefined;
  const ct = a.ctime ? new Date(a.ctime * 1000).toLocaleString() : '(无 ctime)';
  console.log(`  ${a.bvid ?? '(无bvid)'}  aid=${String(a['aid'] ?? '(无)')}  ${ct}  分P=${n ?? '?'}  「${a.title ?? ''}」`);
}
if (fullLike.length > 12) console.log(`  …另有 ${fullLike.length - 12} 条`);

const tasks = ledger.listTasks({ limit: 50 });
console.log(`\n台账任务：${tasks.length} 条`);
console.log(`publish.resumeAid           = ${cfg.publish.resumeAid.trim() || '(空)'}`);
console.log(`publish.resumeTitleTemplate = ${cfg.publish.resumeTitleTemplate.trim() || '(空 → 关闭自动查找)'}`);
console.log(`publish.resumeClipIndexBase = ${cfg.publish.resumeClipIndexBase}（现在只是**兜底**，优先用目标稿件的实际分P 数）\n`);

let hit = 0;
for (const t of tasks) {
  const liveTitle = cleanLiveTitle(t.title);
  const fromArchives = guessAnchorName(archives, liveTitle) ?? '';
  const r = resolveResumeTarget({
    template: cfg.publish.resumeTitleTemplate,
    liveTitle,
    dateText: taskDateText(t),
    anchors: [fromArchives, t.streamer ?? ''],
    archives,
  });
  if (r.target) hit++;
  console.log(`任务 ${t.id}  状态=${t.status}`);
  console.log(`  直播标题：${t.title}`);
  console.log(`  主播名候选：稿件列表反推「${fromArchives || '(空)'}」/ 台账识别「${t.streamer || '(空)'}」`);
  console.log(`  试过的标题：${r.tried.join('  |  ') || '(无)'}`);
  if (r.target) {
    const n = r.target.bvid ? archivePartCount(await client.biliArchiveDetail(r.target.bvid, { retry: 0 }).catch(() => undefined)) : undefined;
    console.log(
      `  ✅ 命中 ${r.target.bvid}（aid=${r.target.aid}）「${r.target.title ?? ''}」` +
        `方式=${r.target.how}  该稿件已有 ${n ?? '?'} 个分P → 切片从 P${(n ?? cfg.publish.resumeClipIndexBase) + 1} 起编号`,
    );
  } else {
    console.log(`  ❌ 未命中：${r.reason ?? '未知'}（精确候选 ${r.candidates} 个）`);
  }
  console.log('');
}
console.log(`小结：${hit}/${tasks.length} 个任务能在真实稿件列表里定位到 biliLive-tools 的稿件（即切片会追加进同一个稿件）。`);
