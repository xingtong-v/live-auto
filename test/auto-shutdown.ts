/**
 * 「跑完自动关机」判定核心的自测（2026-10-14）。
 * 重点：**六条门槛缺一不可**（尤其"还在录"与"它还在压制/上传"），以及冷静期/时段/跨午夜。
 * 全是纯函数断言 —— 判错的代价是把用户机器关掉，所以每条都要单独钉住。
 */
import fs from 'node:fs';
import path from 'node:path';
import { decideShutdown, inShutdownWindow, parseHHMM, shutdownCommand, cancelShutdownCommand, type ShutdownConditions, type ShutdownPolicy } from '../src/auto-shutdown.ts';
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
function eq(title: string, got: unknown, want: unknown): void {
  ok(title, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const policy: ShutdownPolicy = { minIdleMinutes: 15, windowFrom: '22:00', windowTo: '08:00', graceSeconds: 300 };
/** 深夜 02:00（在允许时段内）；`idleSince` 默认给它 20 分钟前的空闲起点 */
const at = (h: number, m = 0): Date => new Date(2026, 9, 14, h, m, 0);
const idle20 = (now: Date): string => new Date(now.getTime() - 20 * 60000).toISOString();
const base = (over: Partial<ShutdownConditions> = {}, now = at(2)): ShutdownConditions => ({
  enabled: true,
  busy: false,
  queueLength: 0,
  activeTranscriptions: 0,
  recordingSessions: 0,
  llcQueueLength: 0,
  now,
  ...over,
});

section('1. 干净空闲 → 关机');
{
  const now = at(2);
  const d = decideShutdown(base({}, now), policy, idle20(now));
  ok('★ 六条都满足 + 冷静期已过 → 关机', d.shutdown === true, JSON.stringify(d));
  ok('说明里带上"可取消"（用户看得懂）', d.shutdown === true && /可取消/.test(d.reason), d.reason);
}

section('2. 六条门槛缺一不可（每条都要能挡住关机）');
{
  const now = at(2);
  const since = idle20(now);
  const cases: Array<[string, Partial<ShutdownConditions>, RegExp]> = [
    ['开关没开', { enabled: false }, /开关未打开/],
    ['★ 还在录', { recordingSessions: 1 }, /正在录制/],
    ['流水线在跑', { busy: true }, /流水线还在忙/],
    ['队列里有任务', { queueLength: 2 }, /队列 2 个/],
    ['转写在跑', { activeTranscriptions: 1 }, /本地转写在跑/],
    ['★ 它还在压制/上传', { llcQueueLength: 3 }, /压制\/上传任务/],
  ];
  for (const [name, over, re] of cases) {
    const d = decideShutdown(base(over, now), policy, since);
    eq(`★ ${name} → 不关`, d.shutdown, false);
    ok(`  （原因说得清：${name}）`, re.test(d.reason), d.reason);
  }
  /* 原因里要带回"是哪一场在录"（`recordingDetail`）：只写"有 1 场在录"用户没法核对，
     而这一条正是"号码对不上就丢数据"的那条（2026-10-24 漏判 .ts 的现场就出在这里）。 */
  const withDetail = decideShutdown(
    base({ recordingSessions: 1, recordingDetail: '1 场可能还在录（原始分段在写：…-PART007.ts）' }, now),
    policy,
    since,
  );
  ok('★ 原因里带上来由（哪一场、什么来源）', /原始分段在写/.test(withDetail.reason) && /PART007\.ts/.test(withDetail.reason), withDetail.reason);
}

section('3. 冷静期：刚空闲不关，够了才关');
{
  const now = at(2);
  const d1 = decideShutdown(base({}, now), policy, new Date(now.getTime() - 3 * 60000).toISOString());
  eq('空闲 3 分钟 < 15 分钟 → 不关', d1.shutdown, false);
  ok('并如实报"还剩多少分钟"', /还剩 12\.0 分钟/.test(d1.reason), d1.reason);
  const d2 = decideShutdown(base({}, now), policy, new Date(now.getTime() - 15 * 60000).toISOString());
  eq('恰好 15 分钟 → 关', d2.shutdown, true);
  const d3 = decideShutdown(base({}, now), policy, undefined);
  eq('没有空闲起点（首次评估）→ 不关（先记一个起点）', d3.shutdown, false);
}

section('4. 时段：只在该关的时候关（含跨午夜）');
{
  eq('22:00 边界内 → 关', decideShutdown(base({}, at(22)), policy, idle20(at(22))).shutdown, true);
  eq('07:59 仍在窗口内 → 关', decideShutdown(base({}, at(7, 59)), policy, idle20(at(7, 59))).shutdown, true);
  const noon = at(12);
  const d = decideShutdown(base({}, noon), policy, idle20(noon));
  eq('★ 中午 12:00 不在 22:00–08:00 → 不关', d.shutdown, false);
  ok('原因写明"不在允许关机的时段"', /不在允许关机的时段/.test(d.reason), d.reason);
  eq('08:00 正好出窗口 → 不关', inShutdownWindow(at(8), '22:00', '08:00'), false);
  eq('22:00 正好进窗口 → 关', inShutdownWindow(at(22), '22:00', '08:00'), true);
  eq('两个端点都不填 = 不限时段', inShutdownWindow(at(12), undefined, undefined), true);
  eq('只填 from（如 23:00 之后）', [inShutdownWindow(at(23, 30), '23:00', undefined), inShutdownWindow(at(12), '23:00', undefined)], [true, false]);
  eq('只填 to（如 06:00 之前）', [inShutdownWindow(at(5), undefined, '06:00'), inShutdownWindow(at(12), undefined, '06:00')], [true, false]);
  eq('HH:MM 解析：非法输入返回 undefined', [parseHHMM('24:00'), parseHHMM('7:5'), parseHHMM('07:05'), parseHHMM(undefined)], [undefined, undefined, 425, undefined]);
}

section('5. 关机命令本身：不带 /f（宁可失败也不强杀进程）');
{
  const c = shutdownCommand(300);
  eq('命令是 shutdown', c.cmd, 'shutdown');
  ok('★ 带 /s 与倒计时秒数', c.args.includes('/s') && c.args.includes('300'), JSON.stringify(c.args));
  ok('★ 不带 /f（不强杀进程，避免丢数据）', !c.args.includes('/f'), JSON.stringify(c.args));
  ok('带一句说明（关机对话框里能看到）', c.args.includes('/c'), JSON.stringify(c.args));
  eq('取消命令是 shutdown /a', cancelShutdownCommand(), { cmd: 'shutdown', args: ['/a'] });
  eq('倒计时负数会被夹到 0', shutdownCommand(-5).args.includes('0'), true);
}

section('6. 静态接线：默认关 + 只生效一次（避免"哪天白天跑完就关机"）');
{
  const src = fs.readFileSync(path.join(ROOT_DIR, 'src', 'auto-shutdown.ts'), 'utf8');
  ok('开关默认关：没打开就返回"开关未打开"', /自动关机开关未打开/.test(src));
  ok('★ 判定顺序里"还在录"排在最前（比"流水线忙"更优先）', src.indexOf('recordingSessions > 0') < src.indexOf('c.busy || c.queueLength > 0'));
  ok('注释里写明"真关机前把开关复位"（一次性）', /只生效一次|开关复位/.test(src));

  /* 接线（2026-10-14）：daemon 每分钟评估一次；服务端只暴露状态与开关，不重复实现判据 */
  const daemon = fs.readFileSync(path.join(ROOT_DIR, 'src', 'daemon.ts'), 'utf8');
  ok('★ daemon 里有每分钟的评估定时器', /setInterval\(\(\) => \{\s*void this\.evaluateAutoShutdown\(\);\s*\}, 60_000\)/.test(daemon));
  ok('★ 六条事实都取自既有接口（busy/队列/转写/它那边队列）', /activeTranscriptions: listActiveLocalAsrRuns\(\)\.length/.test(daemon));
  /* ★ 2026-10-24：「还在录」改成多源归并（watcher 候选项 + 原始分段在写 + 录制器 recording）。
     旧写法只 filter watcher 的 mp4 候选项 ⇒ 直播正在写 .ts 时恒为 0，自动关机会在录制中途执行。
     逐条断言见 test/recording-gate.ts；这里只钉住"接入点是多源的"这一件事。 */
  ok('★ 「还在录」由 gatherRecordingGate 多源归并（不再是单源 filter）', /gatherRecordingGate\(\{/.test(daemon) && !/recordingSessions: this\.watcher/.test(daemon));
  ok('★ biliLive-tools 队列查不到时按"忙"算（绝不当空闲）', /catch \{\s*llcQueueLength = 1;\s*\}/.test(daemon));
  ok('★ 同一个运行周期内不重复下发关机', /shutdownFiredAt && Date\.now\(\) - this\.shutdownFiredAt < 6 \* 3600_000/.test(daemon));
  ok('dry-run 时只记日志、不下发', /dry-run）：本应关机/.test(daemon));

  const server = fs.readFileSync(path.join(ROOT_DIR, 'src', 'server.ts'), 'utf8');
  ok('★ 服务端暴露 /api/shutdown（GET 状态 / POST 开关+取消）', /p === '\/api\/shutdown' && \(method === 'GET' \|\| method === 'POST'\)/.test(server));
  ok('取消走 daemon.cancelAutoShutdown（= shutdown /a）', /orch\.cancelAutoShutdown\(\)/.test(server));
  ok('服务端不自己算判据（没有第二套六条门槛）', !/recordingSessions > 0/.test(server));
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exitCode = fail === 0 ? 0 : 1;
