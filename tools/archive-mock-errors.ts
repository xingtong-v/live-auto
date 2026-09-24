/**
 * 维护工具：把**内建测试**写进真实 `data/errors.jsonl` 的历史噪音挪出去。
 *
 * 背景（用户报的「错误报告 目前没有任何效果」）：`errors.jsonl` 与 `error-report/`
 * 以前是模块级常量、`dataDirOverride` 管不到，端到端测试的 mock 场次
 * （taskId 形如 `20260923-2215-rec-mock`）把错误写进了**真实**事件流。后果：
 *   · 86 条事件里 74 条是这些 mock 的；
 *   · 它们的报告文件在临时目录里、**根本不存在**，界面上点「报告」全是 404；
 *   · 健康面板「近 24h 错误」显示 21，真实生产错误其实只有个位数。
 * 结构性原因已在 `daemon.ts` 修掉（`dataDirOverride` 现在同时改事件流与报告目录），
 * 本工具只处理**已经写进去的历史**，也可在将来某次污染后复用。
 *
 * 做法（可逆、可审计）：
 *   1. 原文件整份备份到 `data/errors.jsonl.bak-<时间戳>`；
 *   2. mock 事件**追加**到 `data/errors.archived-mock.jsonl`（不删，只是挪出主事件流）；
 *   3. 主事件流重写为剩下的真实事件。
 *
 * 用法：
 *   node tools/archive-mock-errors.ts --dry-run    # 先看会动哪些
 *   node tools/archive-mock-errors.ts              # 真改（自动备份）
 */
import fs from 'node:fs';
import path from 'node:path';
import { getErrorReportDir, getErrorsPath } from '../src/errors.ts';

const MAIN = getErrorsPath();
const ARCHIVE = path.join(path.dirname(MAIN), 'errors.archived-mock.jsonl');
const REPORT_DIR = getErrorReportDir();
const DRY = process.argv.includes('--dry-run');

/** mock 场次的 reportId 特征（`<时间戳>-<taskId>`，taskId 以 -rec-mock 结尾） */
const MOCK = /-rec-mock$/;

interface Ev {
  reportId: string;
  at: string;
  taskId?: string;
  type?: string;
}

const raw = fs.readFileSync(MAIN, 'utf8').split(/\r?\n/).filter((l) => l.trim());
const events: Array<{ raw: string; ev: Ev; mock: boolean; hasFile: boolean }> = [];
let broken = 0;
for (const line of raw) {
  let ev: Ev;
  try {
    ev = JSON.parse(line) as Ev;
  } catch {
    broken++;
    continue; // 坏行不参与搬迁（也别把它删掉）
  }
  const hasFile = fs.existsSync(path.join(REPORT_DIR, `${ev.reportId}.json`));
  const mock = MOCK.test(ev.reportId) || MOCK.test(String(ev.taskId ?? ''));
  events.push({ raw: line, ev, mock, hasFile });
}

const mockEvs = events.filter((e) => e.mock);
const keep = events.filter((e) => !e.mock);

console.log(`主事件流：${MAIN}`);
console.log(`  合计 ${events.length} 条${broken > 0 ? `（另有 ${broken} 行无法解析，原样保留）` : ''}`);
console.log(`  其中 mock 测试场次：${mockEvs.length} 条（无报告文件的 ${mockEvs.filter((e) => !e.hasFile).length} 条）`);
console.log(`  保留（真实）：${keep.length} 条（其中无报告文件的 ${keep.filter((e) => !e.hasFile).length} 条，点「报告」走事件行合成）`);
if (keep.length > 0) console.log(`  保留的时间范围：${keep[0]!.ev.at}  →  ${keep[keep.length - 1]!.ev.at}`);
if (mockEvs.length === 0) {
  console.log('\n没有需要搬迁的 mock 事件。');
  process.exit(0);
}

if (DRY) {
  console.log('\n[dry-run] 未写盘。去掉 --dry-run 才会真改。');
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${MAIN}.bak-${stamp}`;
  fs.copyFileSync(MAIN, backup);
  fs.appendFileSync(ARCHIVE, mockEvs.map((e) => e.raw).join('\n') + '\n', 'utf8');
  fs.writeFileSync(MAIN, keep.length > 0 ? keep.map((e) => e.raw).join('\n') + '\n' : '', 'utf8');
  console.log(`\n✅ 已备份原文件：${backup}`);
  console.log(`✅ 已把 ${mockEvs.length} 条 mock 事件挪到：${ARCHIVE}`);
  console.log(`✅ 主事件流现在 ${keep.length} 条`);
}
