/**
 * 只切片、不投稿 —— 用于在"先不投稿"的前提下验证切片链路（含字幕/弹幕合并）。
 *
 * 为什么单独写一个工具：`publishStage()` 与 `/api/task/:id/publish` 都会在切完之后
 * **继续投稿**（多分P 模式下会新建或追加稿件）。想验证切片产物本身、又不想往 B站
 * 投任何东西时，就必须走 `publishClips({ skipUpload: true })` 这条内部路径 ——
 * 它在切片完成后直接返回（见 publish.ts 的 `if (opts.skipUpload)` 分支），
 * 切片状态落 `CUT` 并写入 `cutOutput`，与多分P 模式用的完全是同一条代码。
 *
 * ⚠️ 不要与正在运行的服务同时操作同一个任务：两者各自持有内存态台账，
 *    并发写会让后写的覆盖先写的。本工具会先检查该任务是否处于进行中的阶段。
 *
 * 用法：
 *   node --experimental-strip-types tools/cut-only.ts <taskId>
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';
import { Ledger } from '../src/ledger.ts';
import { Publisher } from '../src/publish.ts';
import { log as globalLog } from '../src/logger.ts';
import { fmtBytes, fmtDuration } from '../src/util.ts';

const taskId = process.argv[2];
if (!taskId) {
  console.error('用法：node --experimental-strip-types tools/cut-only.ts <taskId>');
  process.exit(1);
}

const cfg = loadConfig('config.json').config;
const ledger = new Ledger({ path: path.join('data', 'ledger.json'), logger: globalLog });
const task = ledger.getTask(taskId);
if (!task) {
  console.error(`任务不存在：${taskId}`);
  process.exit(1);
}

const BUSY = ['RECORDED', 'TRANSCRIBING', 'TRANSCRIBED', 'ANALYZING', 'CLIPPING', 'PUBLISHING'];
console.log('='.repeat(92));
console.log(`只切片不投稿：${taskId}`);
console.log('='.repeat(92));
console.log(`  标题   : ${task.title}`);
console.log(`  状态   : ${task.status} / ${task.stage}`);
console.log(`  源文件 : ${task.source.rawFiles[0] ?? '(无)'}`);
console.log(`  时长   : ${fmtDuration(task.source.totalDuration)}`);
if (BUSY.includes(task.status)) {
  console.log(`  ⚠ 该任务处于进行中的阶段（${task.status}）—— 若服务正在处理它，请先等它结束，避免并发写台账。`);
}

const clips = ledger.getClips(taskId);
const selected = clips.filter((c) => c.selected);
console.log(`  切片   : 共 ${clips.length} 个，选中 ${selected.length} 个`);
for (const c of selected) {
  console.log(
    `    #${c.index} ${fmtDuration(c.start)}–${fmtDuration(c.end)}（${(c.end - c.start).toFixed(1)}s）` +
      ` score=${c.score} ${c.title.slice(0, 40)}`,
  );
}
if (selected.length === 0) {
  console.log('  没有选中的切片，退出。');
  process.exit(0);
}
console.log('');

const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });
const publisher = new Publisher({ client, config: cfg, ledger, logger: globalLog });

/* uid 从 biliLive-tools 的已登录账号取（切片阶段其实用不到它，但接口要求传） */
let uid: number | string = '';
try {
  const u = await client.primaryUid();
  if (u) uid = u.uid;
} catch {
  /* 取不到也不影响切片（skipUpload 分支不会用到 uid） */
}

const t0 = Date.now();
const res = await publisher.publishClips({
  task,
  uid,
  indices: selected.map((c) => c.index),
  /* ★ 关键：切完就停，绝不投稿 */
  skipUpload: true,
});

console.log('');
console.log('='.repeat(92));
console.log('切片结果');
console.log('='.repeat(92));
console.log(`  成功 ${res.results.filter((r) => r.ok).length} / 失败 ${res.failed} / 跳过 ${res.skipped}   耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('');
for (const r of res.results) {
  if (!r.ok) {
    console.log(`  ✗ #${r.clipIndex} 失败：${r.error?.message?.slice(0, 120)}`);
    continue;
  }
  const out = r.output;
  let size = '';
  let dur = '';
  if (out && fs.existsSync(out)) {
    size = fmtBytes(fs.statSync(out).size);
  }
  const c = ledger.getClip(taskId, r.clipIndex);
  if (c) dur = `${(c.end - c.start).toFixed(1)}s`;
  console.log(`  ✓ #${r.clipIndex} ${dur.padStart(8)} ${size.padStart(10)}  ${out ? path.basename(out) : '(无产出)'}`);
  for (const w of r.warnings ?? []) console.log(`      ⚠ ${String(w).slice(0, 130)}`);
}

/* 字幕是否并入（多分P/烧字幕配置决定） */
const withSub = res.results.filter((r) => r.ok && r.output && fs.existsSync(r.output));
console.log('');
console.log(`  产物目录：${path.dirname(withSub[0]?.output ?? path.join('data', 'clips', taskId, 'x'))}`);
console.log(`  台账状态：${ledger.getClips(taskId).map((c) => `#${c.index}:${c.status}`).join(' ')}`);
console.log('');
