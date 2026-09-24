import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync('data/tasks/manual-20260922190206-no27/transcript.json', 'utf8'));
const segs = j.segments ?? [];
console.log('  前 14 条（本地识别结果）：');
for (const s of segs.slice(0, 14)) {
  console.log(`    [${s.start.toFixed(2).padStart(7)} - ${s.end.toFixed(2).padStart(7)}] ${s.text}`);
}
console.log('\n  中间 5 条：');
for (const s of segs.slice(60, 65)) {
  console.log(`    [${s.start.toFixed(2).padStart(7)} - ${s.end.toFixed(2).padStart(7)}] ${s.text}`);
}
console.log('\n  最后 3 条：');
for (const s of segs.slice(-3)) {
  console.log(`    [${s.start.toFixed(2).padStart(7)} - ${s.end.toFixed(2).padStart(7)}] ${s.text}`);
}
const total = segs.reduce((a: number, s: { text: string }) => a + s.text.length, 0);
console.log(`\n  总字数 ${total}，平均每条 ${(total / segs.length).toFixed(1)} 字`);
console.log(`  平均段长 ${(segs.reduce((a: number, s: { start: number; end: number }) => a + (s.end - s.start), 0) / segs.length).toFixed(2)} 秒`);
console.log(`  含「…」续写段: ${segs.filter((s: { text: string }) => s.text.startsWith('…')).length} 条`);
