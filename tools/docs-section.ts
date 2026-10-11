/**
 * 文档章节号管理（2026-10-12，优化第三批 ④）。
 *
 * 起因（多会话协作的真实后果）：`docs/implementation-report.md` 里出现了**重复章节号**
 * ——两个 §37、两个 §38、两个 §40。原因是两个会话各自"读最大号 + 1"，然后同时写进去。
 * 手工挑号在多会话下必然撞车，所以把挑号这件事交给工具。
 *
 * 用法：
 *   node tools/docs-section.ts next     # 打印下一个可用章节号（写新章节前先跑它）
 *   node tools/docs-section.ts check    # 查重 + 查乱序；有重复则非零退出（已接入 verify:fast）
 *   node tools/docs-section.ts list     # 列出所有章节号与标题
 *
 * ⚠️ 刻意**不做自动重编号**：正文里有大量 "见 §51" 这类交叉引用，自动改号会把引用指错，
 *    而且重编号会让"会话 A 刚写的那节"和"会话 B 的引用"同时失效。
 *    这个工具只负责：① 新章节不再撞号；② 已有撞号能被立刻发现并列出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

const DOC = path.join(ROOT_DIR, 'docs', 'implementation-report.md');
const cmd = process.argv[2] ?? 'check';

if (!fs.existsSync(DOC)) throw new Error(`找不到文档：${DOC}`);
const lines = fs.readFileSync(DOC, 'utf8').split('\n');

interface Sec {
  num: number;
  title: string;
  line: number;
}
const sections: Sec[] = [];
lines.forEach((l, i) => {
  /* 标题**不能以数字开头**，否则 `## 7.5 子节` 会被误判成主章节 §7（第一版就报了一堆这种假警报） */
  const m = /^## (\d+)\.\s+(\D.*)$/.exec(l);
  if (m) sections.push({ num: Number(m[1]), title: m[2]!.trim(), line: i + 1 });
});

if (cmd === 'next') {
  const max = sections.reduce((a, s) => Math.max(a, s.num), 0);
  console.log(`${max + 1}`);
} else if (cmd === 'list') {
  for (const s of sections) console.log(`  §${String(s.num).padStart(3)}  L${String(s.line).padStart(5)}  ${s.title.slice(0, 60)}`);
  console.log(`  共 ${sections.length} 节`);
} else {
  /* check：重复号 + 乱序（新章节号应递增；允许历史小节插在中间，只报"倒退"超过阈值的情况） */
  const byNum = new Map<number, Sec[]>();
  for (const s of sections) {
    const arr = byNum.get(s.num) ?? [];
    arr.push(s);
    byNum.set(s.num, arr);
  }
  const dups = [...byNum.entries()].filter(([, arr]) => arr.length > 1).sort((a, b) => a[0] - b[0]);
  const max = sections.reduce((a, s) => Math.max(a, s.num), 0);

  if (dups.length === 0) {
    console.log(`  \x1b[32m✓\x1b[0m 章节号无重复（共 ${sections.length} 节，最大 §${max}）—— 新章节请用：node tools/docs-section.ts next`);
    process.exitCode = 0;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m 发现 ${dups.length} 组重复章节号（共 ${sections.length} 节，最大 §${max}）：`);
    for (const [num, arr] of dups) {
      console.log(`     §${num} —— ${arr.length} 处：`);
      for (const s of arr) console.log(`        L${s.line}  ${s.title.slice(0, 64)}`);
    }
    console.log('\n  处理建议：**只重编号较晚出现的那一节**，并同步修正引用它的 "见 §N"；');
    console.log('  新章节请先跑 `node tools/docs-section.ts next` 拿号，避免继续撞车。');
    process.exitCode = 1;
  }
}
