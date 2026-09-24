/**
 * 实测 Server 酱告警通道：走项目自己的 POST /api/test {target:'alert'}。
 *
 * 不打印 SendKey（硬约束 #8）——只看项目返回的结果。
 * 用法：node --experimental-strip-types tools/test-alert.ts [port] [channel]
 */
const port = Number(process.argv[2] ?? 3000);
const channel = process.argv[3] ?? 'serverchan';
const base = `http://127.0.0.1:${port}`;

const boot = (await (await fetch(`${base}/api/bootstrap`)).json()) as { csrf: string };
const res = await fetch(`${base}/api/test`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrf },
  body: JSON.stringify({ target: 'alert', channel }),
});
const r = (await res.json()) as Record<string, unknown>;

console.log(`POST /api/test {target:'alert', channel:'${channel}'}`);
console.log(`HTTP ${res.status}\n`);
console.log(JSON.stringify(r, null, 2));

/* 结果里可能带 latencyMs / message / ok / channel 等字段，按常见形态判定 */
const okFlag = r['ok'] ?? r['success'];
const msg = String(r['message'] ?? r['detail'] ?? r['reason'] ?? '');
console.log('\n' + '='.repeat(70));
if (okFlag === true) {
  console.log('\x1b[32m结论：推送成功 —— 去微信看「Server酱」服务号的消息，应该收到一条测试告警。\x1b[0m');
} else {
  console.log('\x1b[31m结论：推送失败\x1b[0m');
  if (/code\s*=\s*(3|40001|40002)/i.test(msg)) {
    console.log('  提示：Server 酱返回鉴权类错误 —— 常见原因是 SendKey 抄错，或微信端没有关注/绑定「Server酱」服务号。');
  }
}
console.log('='.repeat(70));
