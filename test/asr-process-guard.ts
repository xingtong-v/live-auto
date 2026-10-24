/**
 * 本地转写的**进程护栏**（2026-10-13 实测事故后加的三道闸）。
 *
 * 事故现场：预转写与正式流水线同时对同一个 59 分钟文件各起了一个转写进程，
 * 两个进程抢同一份 ModelScope 缓存 ⇒ 双双卡死；用户点"修复卡住"后台账回到 RECORDED，
 * 但**那两个 python 没人管**，继续占着 ~2 GB 显存，重跑还会再多一个。
 *
 * 三道闸各守一件事，这里逐条验：
 *   ① **同窗口单飞**：同一个 (引擎, 文件, 区间) 只允许一个进程在跑，第二个复用结果；
 *   ② **收尸**：登记表能报出"谁在跑"，并且能把**整个进程树**杀掉
 *      （Windows 上 venv 的 python.exe 会再拉起真解释器，只杀父进程等于没杀）；
 *   ③ **卡死看门狗判据**：长时间零输出 ⇒ 判定卡死（纯函数，避免真等 20 分钟）。
 * 另有静态接线断言：daemon / server 的"放弃任务"路径必须调用收尸，预转写必须让路。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT_DIR } from '../src/util.ts';
import {
  killAllLocalAsrRuns,
  killLocalAsrRun,
  killLocalAsrRunsForTask,
  findLocalAsrRunsForTask,
  listActiveLocalAsrRuns,
  markLocalAsrRunOutput,
  registerLocalAsrRun,
  shouldKillStalled,
  singleFlightLocal,
  unregisterLocalAsrRun,
  LOCAL_ASR_STALL_MS,
  type LocalAsrResult,
} from '../src/asr.ts';

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/* ========================================================================== */

section('1. 同窗口单飞：同一个文件同一区间只起一个进程');
{
  let started = 0;
  const fake = async (): Promise<LocalAsrResult> => {
    started++;
    await sleep(80);
    return { ok: true, segments: [] } as unknown as LocalAsrResult;
  };
  const a = singleFlightLocal('funasr|model|F:/x.ts|0|100|0', fake);
  const b = singleFlightLocal('funasr|model|F:/x.ts|0|100|0', fake);
  eq('第二次调用被判定为"复用"', b.reused, true);
  eq('第一次不是复用', a.reused, false);
  const [ra, rb] = await Promise.all([a.promise, b.promise]);
  eq('★ 只真正执行了一次（没有第二个进程）', started, 1);
  ok('两次拿到的是同一个结果对象', ra === rb);

  let started2 = 0;
  await singleFlightLocal('funasr|model|F:/x.ts|100|200|100', async () => {
    started2++;
    return { ok: true, segments: [] } as unknown as LocalAsrResult;
  }).promise;
  eq('不同区间不受影响（各跑各的）', started2, 1);

  /* 跑完之后要能再次进入（否则同窗口永远被"复用"成旧结果） */
  const again = singleFlightLocal('funasr|model|F:/x.ts|0|100|0', fake);
  eq('上一次结束后，同 key 可以重新开跑', again.reused, false);
  await again.promise;
  eq('重新开跑确实又执行了一次', started, 2);
}

section('2. 收尸：登记表能报出谁在跑，并能把整棵进程树杀掉');
{
  /* 复刻 Windows 上 venv 的真实形态：父进程（launcher）再拉起一个子进程（真解释器）。
     只杀父进程 = 真正干活的那个还活着 —— 事故里留下的就是这种孤儿。 */
  const childCode = 'setInterval(() => {}, 1000);';
  const parentCode = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const c = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' });
    fs.writeFileSync(process.env.PIDFILE, String(c.pid));
    setInterval(() => {}, 1000);
  `;
  const pidFile = path.join(ROOT_DIR, 'data', 'local-asr-test', `guard-${Date.now()}.txt`);
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  /* pid 文件路径走环境变量：`node -e` 后面跟的位置参数在 argv 里的位置不稳妥（踩过） */
  const parent = spawn(process.execPath, ['-e', parentCode], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PIDFILE: pidFile },
  });
  registerLocalAsrRun('auto-test-task#0', parent, 'F:/fake/recording.ts');
  for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await sleep(100);
  if (!fs.existsSync(pidFile)) {
    ok('子进程按预期写下 pid 文件（模拟 venv launcher + 真解释器）', false, `没等到 ${pidFile}`);
  }

  const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  ok('父/子进程都起来了（模拟 venv launcher + 真解释器）', alive(parent.pid!) && alive(grandchildPid), `parent=${String(parent.pid)} child=${grandchildPid}`);

  const runs = listActiveLocalAsrRuns();
  ok('★ 登记表能报出"谁在跑、跑哪个文件"', runs.some((r) => r.taskId === 'auto-test-task#0' && r.file.endsWith('recording.ts')), JSON.stringify(runs));

  const killed = killLocalAsrRun('auto-test-task#0');
  eq('收尸返回 true（确实杀了一个）', killed, true);
  eq('★ 再杀一次返回 false（幂等，不会误报）', killLocalAsrRun('auto-test-task#0'), false);

  await sleep(600);
  ok('★ 父进程已死', !alive(parent.pid!), `pid ${String(parent.pid)} 仍活着`);
  ok('★ 子进程（真解释器）也已死 —— 只杀父进程等于没杀，这条是本次事故的根因', !alive(grandchildPid), `pid ${grandchildPid} 仍活着`);
  ok('登记表里不再有它', !listActiveLocalAsrRuns().some((r) => r.taskId === 'auto-test-task#0'));

  /* killAll：服务退出时的兜底 */
  const p1 = spawn(process.execPath, ['-e', childCode], { stdio: 'ignore', windowsHide: true });
  const p2 = spawn(process.execPath, ['-e', childCode], { stdio: 'ignore', windowsHide: true });
  registerLocalAsrRun('t1', p1, 'a.ts');
  registerLocalAsrRun('t2', p2, 'b.ts');
  eq('★ 退出前能一次收掉所有在跑的转写', killAllLocalAsrRuns(), 2);
  await sleep(600);
  ok('两个都死了', !alive(p1.pid!) && !alive(p2.pid!));
  unregisterLocalAsrRun('t1');
  fs.rmSync(pidFile, { force: true });
}

section('2b. 按任务收尸：键是 `taskId#窗口`，必须"精确 + 前缀"匹配');
{
  /* 这一节来自 2026-10-13 用户现场：他在任务**正常转写**时反复点「修复卡住」，
     界面被改成「已录制 · 待处理」。查下来发现两件事：
       · 登记键是 `${taskId}#${windowIndex}`，而修复接口只按 taskId 精确匹配 ⇒ 一个都杀不掉；
       · 修复只看台账状态，不看"是不是真的在跑"⇒ 正在跑的任务也被改回 RECORDED。
     下面把"匹配规则"与"在跑就不动"的判据都钉住。 */
  const a = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const b = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  registerLocalAsrRun('auto-x#0', a, 'F:/fake/rec.mp4');
  registerLocalAsrRun('auto-x#1', b, 'F:/fake/rec.mp4');
  registerLocalAsrRun('auto-xy#0', spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }), 'other.mp4');

  eq('按任务能找出它的两个窗口', findLocalAsrRunsForTask('auto-x').length, 2);
  eq('★ 前缀不能误伤别的任务（auto-xy ≠ auto-x）', findLocalAsrRunsForTask('auto-xy').length, 1);

  /* idleSec：刚登记时按"启动时刻"算，标记有输出后被重置 */
  const before = findLocalAsrRunsForTask('auto-x').map((r) => r.idleSec);
  ok('刚登记时 idleSec 很小（按启动时刻算，不会一上来就判死）', Math.min(...before) <= 1, JSON.stringify(before));
  markLocalAsrRunOutput('auto-x#0');
  ok('标记输出后能读到 idleSec（供"在跑 vs 卡住"判定）', findLocalAsrRunsForTask('auto-x').every((r) => r.idleSec >= 0));

  eq('★ 一次收掉某个任务的全部窗口', killLocalAsrRunsForTask('auto-x'), 2);
  await sleep(600);
  ok('两个窗口都死了', !alive(a.pid!) && !alive(b.pid!));
  eq('别的任务不受影响（仍在跑）', findLocalAsrRunsForTask('auto-xy').length, 1);
  killLocalAsrRunsForTask('auto-xy');
}

section('3. 卡死判据（纯函数，避免真等 20 分钟）');
{
  const limit = 20 * 60_000;
  const startedAt = 1_000_000;
  ok('刚起 1 分钟：不杀', !shouldKillStalled(0, startedAt, startedAt + 60_000, limit));
  ok('曾经有输出、静音 5 分钟：不杀', !shouldKillStalled(startedAt + 10_000, startedAt, startedAt + 310_000, limit));
  ok('★ 静音超过 20 分钟：判死', shouldKillStalled(startedAt + 10_000, startedAt, startedAt + 10_000 + limit + 1, limit));
  ok('★ 从未有过输出、但已起 21 分钟：同样判死（不是"永远等下去"）', shouldKillStalled(0, startedAt, startedAt + limit + 1, limit));
}

section('4. 静态接线：这三道闸必须挂在"放弃任务"的每条路上');
{
  const daemon = fs.readFileSync(path.join(ROOT_DIR, 'src', 'daemon.ts'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT_DIR, 'src', 'server.ts'), 'utf8');
  const tick = fs.readFileSync(path.join(ROOT_DIR, 'src', 'pre-transcribe-tick.ts'), 'utf8');
  const asr = fs.readFileSync(path.join(ROOT_DIR, 'src', 'asr.ts'), 'utf8');

  ok('asr.ts 里 runLocalAsr 会登记进程', /registerLocalAsrRun\(taskKey, child/.test(asr));
  ok('asr.ts 里转写结束会注销（否则登记表越积越多）', /unregisterLocalAsrRun\(taskKey\)/.test(asr));
  ok('★ 转写调用点用同窗口单飞', /singleFlightLocal\(flightKey/.test(asr));
  ok('★ 卡死看门狗真的会杀（不是只记日志）', /shouldKillStalled\(lastOutputAt/.test(asr) && /killLocalAsrRun\(taskKey\)/.test(asr));

  ok('★ stopTask 会收尸', /async stopTask\([\s\S]{0,2200}?killLocalAsrRunsForTask\(taskId\)/.test(daemon));
  ok('★ deleteTask 会收尸（删除任务不该留下占显存的孤儿）', /async deleteTask\([\s\S]{0,3000}?killLocalAsrRunsForTask\(taskId\)/.test(daemon));
  ok('★ 服务退出会收掉所有在跑的转写', /stop\(\): void \{[\s\S]{0,600}?killAllLocalAsrRuns\(\)/.test(daemon));
  ok(
    '★ 「修复卡住」不会误伤正在跑的转写（先问 transcriptionStatus 再决定）',
    /transcriptionStatus\(t\.id\)/.test(server) && /st\.live && st\.idleSec \* 1000 < LOCAL_ASR_STALL_MS/.test(server),
  );
  ok(
    '★ 还有第一道判据：流水线正在处理的任务一律跳过（覆盖"预转写代跑"那种查不到进程的情况）',
    /isTaskActive\(t\.id\)/.test(server) &&
      /isTaskActive\(taskId: string\): boolean \{[\s\S]{0,200}?this\.currentTaskId === taskId/.test(daemon) &&
      server.indexOf('orch.isTaskActive(t.id)') < server.indexOf('orch.transcriptionStatus(t.id)'),
  );
  ok('★ 「在跑 vs 卡住」的阈值只有一处定义（看门狗与修复接口共用）', /LOCAL_ASR_STALL_MS/.test(asr) && /import \{ LOCAL_ASR_STALL_MS \} from '\.\/asr\.ts'/.test(server));
  ok('修复接口会如实回报"跳过了几个在跑的"', /skipped/.test(server) && /正在转写中/.test(server));
  ok('修复接口只在真卡住时才收尸（不是无脑杀）', /st\.live \? orch\.cancelTranscription\(t\.id\) : false/.test(server));

  ok('★ 预转写支持"让路"门控', /shouldWork\?:/.test(tick) && /summary\.yielded = gate\.reason/.test(tick));
  /* 让路不能每轮都刷一行（2026-10-13 用户截图：面板里连着四行一模一样的「让路」）：
     原因进 summary.yielded（不进 notes），由 daemon 限频后再记。 */
  ok('★ 让路原因不进 notes（否则每 2 分钟刷一行）', !/notes\.push\(`本轮让路/.test(tick));
  ok('★ 让路日志限频：同一原因 10 分钟内不重复记', /lastPreTranscribeYieldReason/.test(daemon) && /10 \* 60 \* 1000/.test(daemon));
  ok(
    '★ 守护进程在流水线忙时让预转写让路',
    /shouldWork: \(\) =>[\s\S]{0,600}?(this\.busy|this\.currentTaskId)/.test(daemon),
  );
  ok('预转写让路时连 discover 都不做（省一次读盘）', tick.indexOf('本轮让路') < tick.indexOf('deps.discoverSegments(c.videoPath)'));
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
