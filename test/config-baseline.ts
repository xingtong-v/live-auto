/**
 * 配置基线与差异（`src/config-baseline.ts`）——2026-10-14，优化清单 P1-7 收口。
 *
 * 界面要显示"你改过哪些项"，判据就是这里的差分。锁住的性质：
 *   ① changed / added / removed 三类都能认出来（嵌套路径要精确到叶子）；
 *   ② 数组与对象**整体当叶子**比较（顺序变了就算变了 —— 不假装"内容相同"）；
 *   ③ **基线只建立一次**：第二次读不会覆写（否则"你改过哪些项"会永远归零，功能形同虚设）；
 *   ④ 基线缺失/读写失败 ⇒ 返回 undefined 而不是抛错（界面退化为"不显示改过项"，绝不因此报错）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASELINE_FILE, diffConfig, readOrCreateBaseline } from '../src/config-baseline.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(title: string, cond: unknown, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${title}`);
  } else {
    fail++;
    failures.push(`${title}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${title}${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq(title: string, got: unknown, want: unknown): void {
  ok(title, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

section('1. 三类差异：changed / added / removed（嵌套路径到叶子）');
{
  const base = { clip: { concurrency: 1, burnDanmaku: true }, publish: { dailyLimit: 0 }, gone: { a: 1 }, arr: [1, 2] };
  const cur = { clip: { concurrency: 2, burnDanmaku: true }, publish: { dailyLimit: 0, autoRetryOnce: true }, arr: [2, 1] };
  const d = diffConfig(base, cur);
  const byPath = new Map(d.map((x) => [x.path, x]));

  eq('恰好 4 处差异', d.length, 4);
  eq('changed 的路径精确到叶子', byPath.get('clip.concurrency')?.kind, 'changed');
  eq('changed 带旧值与新值', [byPath.get('clip.concurrency')?.from, byPath.get('clip.concurrency')?.to], ['1', '2']);
  eq('新增字段 ⇒ added', byPath.get('publish.autoRetryOnce')?.kind, 'added');
  /* 整棵子树被删时，报的是**子树的根**（值显示成 {…}）而不是逐个叶子 —— 这是刻意的：
     逐个叶子刷屏没有意义（配置项几十个一起删的场合很多）。叶子级删除另有下面的用例。 */
  eq('★ 整棵子树被删 ⇒ 报子树根（removed）', byPath.get('gone')?.kind, 'removed');
  eq('子树根的值显示成 {…}', byPath.get('gone')?.from, '{…}');
  {
    const leaf = diffConfig({ clip: { a: 1, b: 2 } }, { clip: { a: 1 } });
    eq('★ 单个叶子被删 ⇒ 精确到叶子路径', leaf.map((x) => `${x.kind}:${x.path}`), ['removed:clip.b']);
  }
  eq('★ 数组当叶子整体比较（顺序变了就算变了）', byPath.get('arr')?.kind, 'changed');
  ok('未改动的叶子不出现在差异里', !byPath.has('clip.burnDanmaku') && !byPath.has('publish.dailyLimit'));
}

section('2. 相同配置 ⇒ 空差异（界面显示"没改过"的依据）');
{
  const cfg = { a: { b: [1, 2, 3], c: 'x' }, d: true };
  eq('★ 引用不同但内容相同 ⇒ 0 处差异', diffConfig(JSON.parse(JSON.stringify(cfg)), cfg).length, 0);
}

section('3. ★ 基线只建立一次（第二次读绝不覆写）');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-baseline-'));
  const first = { publish: { dailyLimit: 0 } };
  const r1 = readOrCreateBaseline({ dataDir: dir, current: first });
  eq('第一次：建立了基线', r1.created, true);
  ok('基线文件已落盘', fs.existsSync(path.join(dir, BASELINE_FILE)));

  /* 之后配置变了，再读一次：必须仍返回**最初那份**，且 created=false */
  const r2 = readOrCreateBaseline({ dataDir: dir, current: { publish: { dailyLimit: 9 } } });
  eq('★ 第二次：不覆写（created=false）', r2.created, false);
  eq('★ 第二次返回的仍是最初那份基线', (r2.baseline as { publish: { dailyLimit: number } }).publish.dailyLimit, 0);
  eq('★ 于是"改过几项"能如实算出来', diffConfig(r2.baseline, { publish: { dailyLimit: 9 } }).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
}

section('4. 基线缺失 / 读不出来 ⇒ 不抛错（界面据此退化为不显示）');
{
  eq('两边都是 undefined ⇒ 无差异、不抛错', diffConfig(undefined, undefined).length, 0);
  eq('基线 undefined ⇒ 无差异（界面显示 0 项）', diffConfig(undefined, { a: 1 }).length, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-baseline-bad-'));
  fs.writeFileSync(path.join(dir, BASELINE_FILE), '{ 这不是 JSON', 'utf8');
  const r = readOrCreateBaseline({ dataDir: dir, current: { a: 1 } });
  eq('★ 基线文件损坏 ⇒ 返回 undefined 而不是抛错', r.baseline, undefined);
  eq('损坏时也不会把坏文件覆盖掉（created=false）', r.created, false);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
