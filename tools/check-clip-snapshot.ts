/**
 * 验证一个会让「多分P 投稿」静默投不出切片的假设：
 *   `publishMultiPartStage` 里 `selected` 是切片**之前**取的快照，
 *   切片完成后（`setClipStatus(..., 'CUT', { cutOutput })`）它是否还能看到 `cutOutput`？
 *
 * 如果看不到 ⇒ `publishAsMultiPart` 收到的每个 clip 都没有 `cutOutput` ⇒
 * `parts` 为空 ⇒ 报"没有任何可投稿的文件"，而切片其实全部成功。
 *
 * 只读（在临时目录里造数据，不碰真实台账）。
 *
 * 用法：node --experimental-strip-types tools/check-clip-snapshot.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-snap-'));
const ledger = new Ledger({ path: path.join(tmp, 'ledger.json') });
const taskId = 'snap-test';
fs.mkdirSync(path.join(tmp, 'tasks', taskId), { recursive: true });

ledger.createTask({
  id: taskId,
  roomId: '1',
  title: '快照语义验证',
  stage: 'ANALYZED',
  source: { segments: [], totalDuration: 100, rawFiles: [], fullVideoHasDanmaku: false },
  fullUpload: 'NOT_APPLICABLE',
  cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: new Date().toISOString() },
  transcriptPath: path.join(tmp, 't.json'),
  signalsPath: path.join(tmp, 's.json'),
  clipsPath: path.join(tmp, 'tasks', taskId, 'clips.json'),
});

ledger.setClips(taskId, [
  { index: 0, start: 0, end: 60, title: '片段A', desc: '', tags: ['x'], category: '生活', score: 8, selected: true, status: 'CANDIDATE' },
  { index: 1, start: 100, end: 160, title: '片段B', desc: '', tags: ['x'], category: '生活', score: 8, selected: true, status: 'CANDIDATE' },
] as never);

/* 模拟 publishMultiPartStage：切片**之前**取快照 */
const selected = ledger.getClips(taskId).filter((c) => c.selected);
console.log('='.repeat(80));
console.log('1) 切片前取快照 selected');
console.log('='.repeat(80));
console.log(`   数量 ${selected.length}；cutOutput = ${selected.map((c) => JSON.stringify(c.cutOutput)).join(', ')}`);

/* 模拟切片完成：写入 cutOutput */
const out0 = path.join(tmp, 'clips', '01.mp4');
const out1 = path.join(tmp, 'clips', '02.mp4');
fs.mkdirSync(path.dirname(out0), { recursive: true });
fs.writeFileSync(out0, 'x');
fs.writeFileSync(out1, 'x');
ledger.setClipStatus(taskId, 0, 'CUT', { cutOutput: out0 });
ledger.setClipStatus(taskId, 1, 'CUT', { cutOutput: out1 });

console.log('');
console.log('='.repeat(80));
console.log('2) 切片后：快照 vs 重新读取');
console.log('='.repeat(80));
console.log(`   旧快照 selected 里的 cutOutput：`);
for (const c of selected) console.log(`     #${c.index} status=${c.status} cutOutput=${JSON.stringify(c.cutOutput)}`);
const reread = ledger.getClips(taskId).filter((c) => c.selected);
console.log(`   重新 getClips() 里的 cutOutput：`);
for (const c of reread) console.log(`     #${c.index} status=${c.status} cutOutput=${c.cutOutput ? path.basename(c.cutOutput) : '(无)'}`);

/* 判定：模拟 publishAsMultiPart 的 parts 构造 */
const partsFromSnapshot = selected.filter((c) => c.cutOutput && fs.existsSync(c.cutOutput)).length;
const partsFromReread = reread.filter((c) => c.cutOutput && fs.existsSync(c.cutOutput)).length;
console.log('');
console.log('='.repeat(80));
console.log('3) 结论');
console.log('='.repeat(80));
console.log(`   用旧快照构造 parts：${partsFromSnapshot} 个可投分P`);
console.log(`   用重新读取构造 parts：${partsFromReread} 个可投分P`);
if (partsFromSnapshot === 0 && partsFromReread > 0) {
  console.log('');
  console.log('   \x1b[31m✗ 假设成立：旧快照看不到切片产物 → 多分P 会投出 0 个分P 并报"没有任何可投稿的文件"\x1b[0m');
  console.log('     ⇒ 修复：publishMultiPartStage 在切片后必须**重新读取**切片列表，不能用切片前的快照。');
} else if (partsFromSnapshot > 0) {
  console.log('');
  console.log('   \x1b[32m✓ 假设不成立：快照能看到 cutOutput（说明是别的原因）\x1b[0m');
}
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}
