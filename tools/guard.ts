/**
 * 改动归属守卫（2026-10-14，优化清单 P2 最后一件）。
 *
 * 背景：多会话/多人同时改同一仓库，已经真实撞过一次（ASR 独立进程被两份实现）。
 * WORKLOG 的 claim 是**声明式**的：它只说明"我要改这些文件"，并不能阻止别人也改。
 *
 * 这个工具做一件很小但有用的事：**把"你认领之后这些文件又被改过"的事实摆出来**。
 *
 * ⚠️ 诚实的边界（写在这里免得被误用）：
 *   · mtime **不含作者信息** —— 所以它无法判断"是谁改的"，也不该说"冲突"这种断言；
 *     它只说"认领于 T，而文件在 T' > T 被改动过，请你自己确认这是不是你自己的改动"。
 *   · 它**不阻断**任何操作（不改文件、不退出非零去卡流程），除非显式加 `--strict`。
 *
 * 用法：
 *   node tools/guard.ts                 # 检查所有未完成认领（默认 WORKLOG.md）
 *   node tools/guard.ts --log <path>    # 指定看板文件（测试用）
 *   node tools/guard.ts --strict        # 有可疑改动时以非零退出（给脚本用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

const args = process.argv.slice(2);
const logIdx = args.indexOf('--log');
const LOG = logIdx >= 0 ? path.resolve(args[logIdx + 1] ?? '') : path.join(ROOT_DIR, 'WORKLOG.md');
const strict = args.includes('--strict');

interface Entry {
  done: boolean;
  at: number;
  who: string;
  task: string;
  files: string[];
}

function readEntries(): Entry[] {
  if (!fs.existsSync(LOG)) return [];
  const out: Entry[] = [];
  for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
    const m = /^- \[([ x])\] (\S+) \| ([^|]+) \| ([^|]+) \| 文件：(.*)$/.exec(line);
    if (!m) continue;
    const at = Date.parse(m[2]!);
    if (!Number.isFinite(at)) continue;
    out.push({
      done: m[1] === 'x',
      at,
      who: m[3]!.trim(),
      task: m[4]!.trim(),
      files: m[5]!
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    });
  }
  return out;
}

const open = readEntries().filter((e) => !e.done);
console.log(`\x1b[1m改动归属守卫\x1b[0m（看板：${path.relative(ROOT_DIR, LOG) || LOG}；未完成认领 ${open.length} 条）`);

if (open.length === 0) {
  console.log('  ✓ 没有未完成的认领 —— 无需检查（若你正在改东西，记得先 worklog claim）');
  process.exit(0);
}

let suspicious = 0;
for (const e of open) {
  const hits: Array<{ file: string; mtime: string; deltaMin: number }> = [];
  for (const f of e.files) {
    const abs = path.isAbsolute(f) ? f : path.join(ROOT_DIR, f);
    try {
      const st = fs.statSync(abs);
      if (st.mtimeMs > e.at) {
        hits.push({ file: f, mtime: new Date(st.mtimeMs).toISOString().replace('T', ' ').slice(0, 16), deltaMin: Math.round((st.mtimeMs - e.at) / 60_000) });
      }
    } catch {
      /* 文件不存在：不算可疑（可能是刚建/刚删） */
    }
  }
  const when = new Date(e.at).toISOString().replace('T', ' ').slice(0, 16);
  if (hits.length === 0) {
    console.log(`  \x1b[32m✓\x1b[0m ${e.task}（${e.who}，认领于 ${when}）：这些文件认领后没被动过`);
  } else {
    suspicious += hits.length;
    console.log(`  \x1b[33m⚠\x1b[0m ${e.task}（${e.who}，认领于 ${when}）：${hits.length} 个文件在认领**之后**被改过`);
    for (const h of hits.slice(0, 6)) console.log(`      · ${h.file}（最后改动 ${h.mtime}，约认领后 ${h.deltaMin} 分钟）`);
    console.log('      请自行确认：这是你自己的后续改动，还是别人也动了同一批文件（多会话常见）。');
  }
}

console.log(
  suspicious === 0
    ? '\n  结论：没有可疑的并行改动。'
    : `\n  结论：${suspicious} 处**可能**的并行改动 —— 本工具只摆事实（mtime 不含作者信息），不做判断。`,
);
if (strict && suspicious > 0) process.exitCode = 1;
