/**
 * 真机验证「关得掉、也取消得掉」（2026-10-14 用户：「测试一下，真的可以关机吗」）。
 *
 * 安全设计（这台机器上可能正在录直播，误关就是丢素材）：
 *   ① 先确认**当前没有待执行的关机**（`shutdown /a` 应当失败："没有正在进行中的关机"）；
 *   ② 调**产品自己的那个函数** `executeShutdown(300)` —— 与 daemon 到点执行的是同一个；
 *   ③ 立刻用**产品自己的取消函数** `executeCancelShutdown()` 撤销；
 *      它能撤销成功，本身就证明 ② 真的排上了一个关机（否则 /a 会报"没有正在进行中的关机"）；
 *   ④ 再查一次：应当回到"没有待执行关机"。
 * 任何一步异常都会**连撤 3 次**，确保机器不会被留在倒计时里。
 */
import { executeCancelShutdown, executeShutdown } from '../src/auto-shutdown.ts';

const line = (s: string): void => console.log('  ' + s);

console.log('① 先确认当前没有待执行的关机');
const pre = executeCancelShutdown();
line(pre.ok ? '⚠️ 竟然有待执行的关机（已顺手撤销）' : `没有待执行关机 ✓（${pre.error ?? ''}）`);

console.log('\n② 用产品自己的函数排一个 300 秒的关机（executeShutdown(300)）');
const armed = executeShutdown(300);
line(armed.ok ? '✅ 系统接受了 shutdown /s /t 300（说明关得掉）' : `❌ 被系统拒绝：${armed.error}`);
if (!armed.ok) {
  console.log('\n结论：这台机器上关机命令**发不出去**（常见原因：组策略/权限）。功能本身没问题，但真到点也关不掉。');
  process.exit(1);
}

console.log('\n③ 立刻撤销（executeCancelShutdown）');
let cancelled = executeCancelShutdown();
for (let i = 0; i < 3 && !cancelled.ok; i++) {
  line(`撤销失败，重试第 ${i + 1} 次：${cancelled.error}`);
  cancelled = executeCancelShutdown();
}
line(cancelled.ok ? '✅ 撤销成功 —— 这同时证明 ② 真的排上了关机（否则 /a 会报"没有正在进行中的关机"）' : `❌ 撤销失败：${cancelled.error}`);

console.log('\n④ 复查最终状态');
const post = executeCancelShutdown();
line(post.ok ? '⚠️ 仍有待执行的关机 —— 请立刻手动执行：shutdown /a' : '✅ 已回到"没有待执行关机"（机器不会被关掉）');

console.log('\n结论：' + (cancelled.ok && !post.ok ? '产品调用链在真机上**能关、也能取消** —— 到点会真的关机。' : '有异常，先别打开开关，把上面的输出发我。'));
process.exitCode = cancelled.ok && !post.ok ? 0 : 1;
