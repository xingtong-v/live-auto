/**
 * 浏览器验收脚本的"共享件"使用闸门（2026-10-14，方案 A 的配套）。
 *
 * ## 背景
 * 10 个脚本原先各自复制同一套驱动（8 份 `class Cdp`、各一份 ok/eq/spawn/汇总），
 * 于是"修一处要改十处"（实例：「等元素再点、别拿固定 sleep 赌渲染」那次修复、
 * 以及 2026-10-14 加的「切页签前复位页面筛选状态」——都只落在一个脚本里）。
 *
 * 2026-10-14 抽出 `tools/ui-shared.ts`，并把 2 个脚本迁过去（`verify-health-ui` / `verify-multiselect-ui`）。
 * 其余 6 个**没有**强行迁移 —— 逐一核对后发现它们是"各自演化过的脚本"（紧凑单行类 / main() 包一切 /
 * 顶层直接起浏览器 / 自定义 errors 字段 / finally 里嵌 try…），通用转换会把它们改坏（实测过一次并回滚）。
 * 因此采用**机会式采用**：新脚本一律用共享件，老脚本等下次因真实原因改动时再迁。
 *
 * ## 这道闸门守什么
 *   1. **不再长出新副本**：除名单内的 6 个历史脚本外，`tools/` 下任何文件都不许再定义 `class Cdp`；
 *   2. 新脚本必须 import 共享件（既不在名单、又不 import 的浏览器验收脚本 ⇒ 判红）；
 *   3. 共享件本身必须导出约定的 API（防止有人"顺手"把它掏空）；
 *   4. 已归档的 `ui-diag.ts` 不许回到 `tools/` 顶层。
 *
 * 名单是**只减不增**的：迁走一个就从名单里删一个（断言会提醒你）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

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
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const toolsDir = path.join(ROOT_DIR, 'tools');
/** ★ 历史遗留名单：只减不增（迁走一个就删一个） */
const LEGACY = [
  'ui-e2e.ts',
  'verify-error-report-ui.ts',
  'verify-monitor-ui.ts',
  'verify-perf-ui.ts',
  'verify-subtitle-switch.ts',
  'verify-tabs.ts',
  'verify-tombstone-ui.ts',
].filter((f) => fs.existsSync(path.join(toolsDir, f)));

section('1. 浏览器验收脚本：要么用共享件，要么在历史名单里');
{
  const all = fs.readdirSync(toolsDir).filter((f) => f.endsWith('.ts') && fs.statSync(path.join(toolsDir, f)).isFile());
  const looksBrowser = (f: string): boolean => {
    if (f === 'ui-shared.ts') return false;
    const t = fs.readFileSync(path.join(toolsDir, f), 'utf8');
    return /Cdp\.attach|class Cdp|remote-debugging-port/.test(t);
  };
  const browserish = all.filter(looksBrowser);
  const unconverted = browserish.filter((f) => !LEGACY.includes(f) && !/from '\.\/ui-shared\.ts'/.test(fs.readFileSync(path.join(toolsDir, f), 'utf8')));
  ok('★ 没有"既不在历史名单、又不用共享件"的浏览器脚本', unconverted.length === 0, unconverted.join(', '));
  ok('历史名单里的文件仍然存在（迁走后请从名单删除）', LEGACY.every((f) => fs.existsSync(path.join(toolsDir, f))), LEGACY.join(', '));
  /* 注意：已迁移的脚本**不再含 class Cdp/attach**，所以不在 browserish 里 —— 单独统计它们，
     否则这行会显示成「已用共享件 0」（2026-10-14 实测踩过这个显示错误）。 */
  const usingShared = all.filter((f) => /from '\.\/ui-shared\.ts'/.test(fs.readFileSync(path.join(toolsDir, f), 'utf8')));
  console.log(`  （已用共享件 ${usingShared.length} 个：${usingShared.join(', ')}；自带驱动待迁移 ${LEGACY.length} 个）`);
}

section('2. ★ 不再长出新副本：`class Cdp` 只允许出现在共享件与历史名单里');
{
  const owners = fs
    .readdirSync(toolsDir)
    .filter((f) => f.endsWith('.ts') && fs.statSync(path.join(toolsDir, f)).isFile())
    .filter((f) => /^class Cdp\b/m.test(fs.readFileSync(path.join(toolsDir, f), 'utf8')));
  const illegal = owners.filter((f) => f !== 'ui-shared.ts' && !LEGACY.includes(f));
  ok('★ 没有新增的 `class Cdp` 副本', illegal.length === 0, illegal.join(', '));
  console.log(`  （当前定义 Cdp 的文件：${owners.join(', ')}）`);
}

section('3. 共享件本身：约定的 API 必须都在');
{
  const shared = fs.readFileSync(path.join(toolsDir, 'ui-shared.ts'), 'utf8');
  for (const api of ['export class Cdp', 'export function ok', 'export function eq', 'export async function report', 'export async function launchBrowser', 'export function findEdge', 'readonly errors']) {
    ok(`共享件导出 ${api}`, shared.includes(api));
  }
  const bugs = fs.readFileSync(path.join(toolsDir, 'ui-shared.ts'), 'utf8');
  ok('★ 共享件没踩本项目禁用的语法（构造函数参数属性）', !/constructor\([^)]*(private|public|readonly)\s/.test(bugs));
}

section('4. 已归档的脚本不许回到顶层');
{
  const top = fs.readdirSync(toolsDir);
  ok('`ui-diag.ts` 不在 tools/ 顶层（已归档）', !top.includes('ui-diag.ts'));
  ok('它在 tools/archive/ 里', fs.existsSync(path.join(toolsDir, 'archive', 'ui-diag.ts')));
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
