/**
 * 失败分级（`src/failure-class.ts`）——2026-10-13，优化清单 P1-5 后半。
 *
 * 这个套件锁的是**判据本身**：哪些失败可以自动重试一次、哪些必须留给人。
 * 为什么值得单独测：自动重试的代价是"可能重复投稿"，比漏重试严重得多 ——
 * 所以每条判据都要有断言守着，尤其是**保守默认**与**确定性优先**这两条容易被"优化"掉的设计。
 */
import { classifyFailure, describeVerdict, shouldAutoRetry } from '../src/failure-class.ts';

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
function kind(label: string, input: Parameters<typeof classifyFailure>[0], want: 'retryable' | 'manual'): void {
  const got = classifyFailure(input);
  ok(label, got.kind === want, `期望 ${want}，实际 ${got.kind}（${got.why}）`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

section('1. HTTP 状态码优先（最可靠的判据）');
kind('429 限流 ⇒ 可重试', { httpStatus: 429 }, 'retryable');
kind('503 服务不可用 ⇒ 可重试', { httpStatus: 503 }, 'retryable');
kind('502 网关错误 ⇒ 可重试', { httpStatus: 502 }, 'retryable');
kind('403 权限 ⇒ 人工', { httpStatus: 403 }, 'manual');
kind('400 请求非法 ⇒ 人工', { httpStatus: 400 }, 'manual');

section('2. 临时性信号 ⇒ 可重试');
kind('超时', { message: '连接超时（60000ms）' }, 'retryable');
kind('fetch failed（网络层）', { message: 'fetch failed' }, 'retryable');
kind('ECONNRESET', { message: 'read ECONNRESET' }, 'retryable');
kind('本地依赖不可达', { message: 'biliLive-tools 未连接' }, 'retryable');
kind('限流提示', { message: 'too many requests' }, 'retryable');

section('3. 确定性信号 ⇒ 人工（重试不会变）');
kind('稿件锁定', { message: '稿件已被锁定' }, 'manual');
kind('审核/违规', { message: '稿件审核不通过：标题违规' }, 'manual');
kind('额度用完', { message: '每日投稿额度已用完' }, 'manual');
kind('登录态失效', { message: '登录态失效，请重新登录' }, 'manual');
kind('目标不存在', { message: '目标稿件不存在' }, 'manual');
kind('疑似重复投稿', { message: '疑似重复投稿，已跳过' }, 'manual');

section('4. ★ 两条刻意保留的设计（最容易被"优化"掉）');
kind(
  '★ 确定性优先于临时性：同时含「锁定」与「超时」⇒ 人工',
  { message: '稿件已被锁定，重试超时' },
  'manual',
);
kind('★ 未识别的失败 ⇒ 默认人工（自动重试的代价是可能重复投稿）', { type: 'upload-failed', message: '未知错误 xyz' }, 'manual');
kind('★ 空信息 ⇒ 默认人工', {}, 'manual');

section('5. 要不要自动重试（含最要紧的那条边界）');
const ar = (i: Parameters<typeof shouldAutoRetry>[0]): boolean => shouldAutoRetry(i).retry;
ok('成功/跳过 ⇒ 不重试', !ar({ ok: true }) && !ar({ skipped: true }));
ok('★ 上传阶段失败 ⇒ 绝不重试（否则可能重复分P）', !ar({ errorType: 'upload-failed', message: '连接超时' }), '超时也不重试');
ok('开关关闭 ⇒ 不重试', !ar({ errorType: 'internal', message: '连接超时', enabled: false }));
ok('切片阶段的超时 ⇒ 重试', ar({ errorType: 'internal', message: '连接超时' }));
ok('切片阶段的未识别错误 ⇒ 不重试（保守）', !ar({ errorType: 'internal', message: '未知错误 xyz' }));
ok('说明里带理由（写日志用）', /上传阶段/.test(shouldAutoRetry({ errorType: 'upload-failed' }).why));

section('5. 结论可读（写进日志/台账）');
ok('可重试的说明里带理由', /可自动重试一次（.+）/.test(describeVerdict(classifyFailure({ message: '连接超时' }))), describeVerdict(classifyFailure({ message: '连接超时' })));
ok('留人工的说明里带理由', /留给人工（.+）/.test(describeVerdict(classifyFailure({ message: '稿件已被锁定' }))), describeVerdict(classifyFailure({ message: '稿件已被锁定' })));

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
