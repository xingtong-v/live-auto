/**
 * 对候选试跑素材做只读预检：真实时长、转写窗口数、预估费用、弹幕条数。
 *
 * 全部走 `POST /api/import/preview`（与真实导入同一套逻辑），不建任务、不付费。
 * 目的：在真正开跑之前，把「这场要花多少钱、要跑多久」摆到台面上。
 *
 * 用法：node --experimental-strip-types tools/trial-preflight.ts [port]
 */
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2] ?? 3000);
const base = `http://127.0.0.1:${port}`;
const DIR = 'C:\\Users\\demo\\Downloads\\Bilibili\\甲主播';

/** 候选：同一场直播的分段 + 另一个较完整的片段 */
const wanted = [
  '2026-09-22 20-08-55-173 来两下闪身步就好了.flv',
  '2026-09-22 21-07-58-627 来两下闪身步就好了.flv',
  '2026-09-22 22-49-42-277 来两下闪身步就好了.flv',
  '2026-09-18 00-09-09-432 电台汤圆人，太劲爆了.flv',
];

const boot = (await (await fetch(`${base}/api/bootstrap`)).json()) as { csrf: string };
console.log('体积(MB)   时长        窗口  弹幕数   预估ASR费   文件');
console.log('-'.repeat(96));

interface Row { file: string; mb: number; dur: number; win: number; cost: number; danmaku: number }
const rows: Row[] = [];

for (const name of wanted) {
  const vp = path.join(DIR, name);
  if (!fs.existsSync(vp)) {
    console.log(`  (不存在) ${name}`);
    continue;
  }
  const mb = fs.statSync(vp).size / 1048576;
  const res = await fetch(`${base}/api/import/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrf },
    body: JSON.stringify({ videoPath: vp }),
  });
  if (res.status !== 200) {
    console.log(`  (预览失败 ${res.status}) ${name}`);
    continue;
  }
  const d = (await res.json()) as {
    durationSec?: number;
    sizeMB?: number;
    asr?: { windows?: number; estCost?: number; cacheHits?: number };
    danmaPath?: string;
    possiblyRecording?: boolean;
    usable?: boolean;
  };
  // 弹幕条数：数 XML 里的 <d> 标签
  let danmaku = 0;
  if (d.danmaPath && fs.existsSync(d.danmaPath)) {
    const xml = fs.readFileSync(d.danmaPath, 'utf8');
    danmaku = (xml.match(/<d\b/g) ?? []).length;
  }
  const dur = d.durationSec ?? 0;
  const mm = `${Math.floor(dur / 60)}分${Math.round(dur % 60)}秒`;
  const row: Row = { file: name, mb, dur, win: d.asr?.windows ?? 0, cost: d.asr?.estCost ?? 0, danmaku };
  rows.push(row);
  console.log(
    `${mb.toFixed(0).padStart(8)}  ${mm.padStart(11)}  ${String(row.win).padStart(4)}  ${String(danmaku).padStart(6)}  ` +
      `${('¥' + row.cost.toFixed(2)).padStart(10)}   ${name}` +
      (d.usable === false ? '  [不可用]' : '') +
      (d.possiblyRecording ? '  [疑似仍在录制]' : ''),
  );
}

console.log('\n' + '='.repeat(96));
console.log('说明：预估 ASR 费按 config.json 的 asr.unitPricePerHour 计算；');
console.log('      阿里云 fun-asr 实际单价约 ¥0.79/小时，所以真实花费约为上表的一半以下。');
console.log('='.repeat(96));

const cheapest = [...rows].sort((a, b) => a.cost - b.cost)[0];
if (cheapest) {
  console.log(`\n最省的完整试跑素材：${cheapest.file}`);
  console.log(`  ${cheapest.mb.toFixed(0)}MB   ${(cheapest.dur / 60).toFixed(1)} 分钟   ${cheapest.danmaku} 条弹幕   预估 ¥${cheapest.cost.toFixed(2)}`);
}
