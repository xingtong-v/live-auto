/**
 * 脱敏层自测（硬约束 #8 / 陷阱 #33）。
 *
 * 这一层是「凭据不进日志」的唯一保障，任何一个模块的疏忽都会导致泄露，
 * 因此必须有可执行、可复现的断言。
 *
 * 运行：node test/redact-selftest.ts
 */
import { redact, redactText, redactJson, isSecretKey, maskValue } from '../src/redact.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
    console.log(`\x1b[31m✗ ${name}\x1b[0m${detail ? ` :: ${detail}` : ''}`);
  }
}

/** 断言某个明文串不再出现 */
function assertGone(name: string, text: string, secret: string): void {
  const hit = text.includes(secret);
  check(name, !hit, hit ? `明文仍存在：${text.slice(0, 200)}` : undefined);
}

console.log('=== 1) 自由文本脱敏（redactText）—— 这是所有日志出口的最后一道 ===');

const cases: Array<{ name: string; input: string; secret: string }> = [
  { name: 'Authorization 头', input: 'Authorization: my-secret-passkey-12345', secret: 'my-secret-passkey-12345' },
  { name: 'Authorization 头（等号形式）', input: 'authorization=abc123def456ghi', secret: 'abc123def456ghi' },
  { name: 'Bearer token', input: 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig', secret: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig' },
  { name: 'sk- API Key', input: 'apiKey: sk-abcdef1234567890', secret: 'sk-abcdef1234567890' },
  { name: 'Server酱 SendKey', input: 'sendKey=SCT123456abcdefGHIJKL', secret: 'SCT123456abcdefGHIJKL' },
  { name: 'URL query auth', input: 'GET http://127.0.0.1:18010/task/cut?auth=0.9EXAMPLEfake11&x=1', secret: '0.9EXAMPLEfake11' },
  { name: 'URL query token', input: 'http://a/b?token=zzzz9999yyyy', secret: 'zzzz9999yyyy' },
  { name: 'B站 SESSDATA', input: 'Cookie: SESSDATA=abc%2Fdef123; bili_jct=deadbeef0011', secret: 'abc%2Fdef123' },
  { name: 'bili_jct 单独出现', input: 'bili_jct=deadbeef0011', secret: 'deadbeef0011' },
  { name: '阿里云 AccessKey', input: 'accessKeyId=LTAI5tAbCdEfGhIjKlMn', secret: 'LTAI5tAbCdEfGhIjKlMn' },
  { name: 'JSON 形态 apiKey', input: '{"apiKey":"sk-jsonkey123456","model":"x"}', secret: 'sk-jsonkey123456' },
  { name: '下划线形态 api_key', input: 'api_key: supersecretvalue99', secret: 'supersecretvalue99' },
  { name: 'password 字段', input: 'password=hunter2secret', secret: 'hunter2secret' },
  { name: 'bot_token 字段', input: 'bot_token=123456789:AAFabcdefghijklmnop', secret: '123456789:AAFabcdefghijklmnop' },
  { name: '多行混合（错误报告真实场景）', input: 'POST /task/cut 失败\nAuthorization: pass-1234567890\napiKey: sk-abcdef123456\nSESSDATA=xyz789abc', secret: 'pass-1234567890' },
];

for (const c of cases) {
  const out = redactText(c.input);
  assertGone(`redactText 遮蔽「${c.name}」`, out, c.secret);
}

// 多行混合场景要把所有凭据都清掉，不能只清第一个
{
  const input = 'POST /task/cut 失败\nAuthorization: pass-1234567890\napiKey: sk-abcdef123456\nSESSDATA=xyz789abc\ntoken=abc12345xyz';
  const out = redactText(input);
  for (const s of ['pass-1234567890', 'sk-abcdef123456', 'xyz789abc', 'abc12345xyz']) {
    assertGone(`多行混合全部清除（${s.slice(0, 8)}…）`, out, s);
  }
  console.log('  混合场景输出：');
  console.log(out.split('\n').map((l) => `    ${l}`).join('\n'));
}

// 不能过度脱敏：普通文本要原样保留
{
  const safe = '本片段来自 2025-01-01 的直播《DLC 开荒》，时间点 00:12:34 - 00:13:58，标题：残血翻盘那一刻';
  const out = redactText(safe);
  check('普通文本不被误改', out === safe, out === safe ? undefined : `被改成：${out}`);
  const safe2 = '标签：名场面、高能、游戏。分区：游戏/单机游戏。评分 9.2';
  check('含冒号的普通文本不被误改', redactText(safe2) === safe2, redactText(safe2));
}

console.log('\n=== 2) 结构化深度脱敏（redact） ===');

{
  const input = {
    passKey: 'super-secret-passkey-value',
    apiKey: 'sk-abcdef123456',
    cookie: 'SESSDATA=abcdef123456; bili_jct=99887766',
    Authorization: 'my-auth-token-123',
    nested: { secret: 'nested-secret-value', arr: [{ token: 'tok_abcdefghijk' }] },
    safe: '这串应该保留',
    num: 42,
    bool: true,
  };
  const out = redact(input) as Record<string, unknown>;
  const flat = JSON.stringify(out);
  for (const s of [
    'super-secret-passkey-value',
    'sk-abcdef123456',
    'SESSDATA=abcdef123456',
    'my-auth-token-123',
    'nested-secret-value',
    'tok_abcdefghijk',
  ]) {
    assertGone(`redact 深度遮蔽 ${s.slice(0, 12)}…`, flat, s);
  }
  check('非敏感字段保留', out['safe'] === '这串应该保留', String(out['safe']));
  check('数字保留', out['num'] === 42);
  check('布尔保留', out['bool'] === true);
  check('嵌套对象仍可序列化', typeof out['nested'] === 'object');
  console.log('  脱敏后：', JSON.stringify(out));
}

// 键名识别
{
  const secretKeys = ['passKey', 'passkey', 'apiKey', 'api_key', 'Authorization', 'cookie', 'SESSDATA', 'bili_jct', 'accessKey', 'secret', 'botToken', 'password', 'sendKey', 'privateKey'];
  const safeKeys = ['title', 'desc', 'start', 'end', 'output', 'videoFilePath', 'keynote', 'monkey'];
  for (const k of secretKeys) check(`isSecretKey("${k}") === true`, isSecretKey(k) === true);
  for (const k of safeKeys) check(`isSecretKey("${k}") === false`, isSecretKey(k) === false, `误判为敏感键`);
}

// maskValue 行为
{
  const masked = maskValue('super-secret-passkey-value');
  assertGone('maskValue 不保留完整值', masked, 'super-secret-passkey-value');
  check('maskValue 短值整体遮蔽', maskValue('abc') === '***', maskValue('abc'));
  check('maskValue 标注长度便于比对', masked.includes('len=26'), masked);
}

console.log('\n=== 3) Error / 循环引用 / 大对象 ===');

{
  const e = new Error('请求失败：Authorization: secret-token-abcdef');
  (e as Error & { code?: string }).code = 'EAUTH';
  const out = JSON.stringify(redact({ err: e }));
  assertGone('Error.message 脱敏', out, 'secret-token-abcdef');
  check('Error 的 name 保留', out.includes('Error'));
}

{
  // 循环引用不能把 redact 打崩
  const a: Record<string, unknown> = { name: 'a' };
  a['self'] = a;
  let ok = false;
  try {
    const out = redact(a) as Record<string, unknown>;
    ok = typeof out === 'object';
  } catch {
    ok = false;
  }
  check('不因循环引用抛异常（但需注意深度截断）', ok);
}

{
  // 大对象被限制规模，避免刷爆日志
  const big = { arr: Array.from({ length: 500 }, (_, i) => i), str: 'x'.repeat(20000) };
  const out = redact(big, { maxArray: 10, maxString: 100 }) as { arr: unknown[]; str: string };
  check('数组被截断', out.arr.length <= 11, `长度 ${out.arr.length}`);
  check('字符串被截断', String(out.str).length <= 100, `长度 ${String(out.str).length}`);
}

console.log('\n=== 4) redactJson ===');
{
  const out = redactJson({ passKey: 'abcdef123456', title: '正常标题' }, 2);
  assertGone('redactJson 遮蔽', out, 'abcdef123456');
  check('redactJson 可格式化', out.includes('\n  '));
}

console.log('\n=== 5) 真实场景回放：错误报告片段 ===');
{
  // 模拟 api.ts 在 401 时构造的真实错误对象：
  // ★ 设计契约：错误消息文本本身**不得包含凭据值**，只提示字段名与排查动作；
  //   凭据只可能出现在 request 上下文里（headers / URL query / 参数），由 redact 兜住。
  const scenario = {
    error: '鉴权失败（HTTP 401）—— 请检查 config.json 的 bililive.passKey 是否与 biliLive-tools「设置 → 服务」中的 PassKey 完全一致',
    request: {
      method: 'GET',
      url: 'http://127.0.0.1:18010/record-history/recent-clips?room_id=12345678&auth=0.9EXAMPLEfake11',
      params: { room_id: '12345678', platform: 'Bilibili' },
      body: { headers: { Authorization: '0.9EXAMPLEfake11' } },
      responseBody: '{"code":401,"message":"unauthorized","sentAuth":"0.9EXAMPLEfake11"}',
    },
  };
  const out = redactJson(scenario);
  assertGone('场景：passkey 不出现在报告的 URL 里', out, 'auth=0.9EXAMPLEfake11');
  check('场景：URL query 的 auth 已被遮蔽', out.includes('auth=***REDACTED***'), out.slice(0, 300));
  assertGone('场景：Authorization 头里的 passkey 不在报告里', out, '"Authorization":"0.9EXAMPLEfake11"');
  assertGone('场景：响应体里回显的 passkey 也被遮蔽', out, '"sentAuth":"0.9EXAMPLEfake11"');
  check('场景：房间号仍可读（便于排障）', out.includes('12345678'));
  check('场景：platform 仍可读', out.includes('Bilibili'));
  check('场景：错误消息本身可读（不含凭据）', out.includes('PassKey 完全一致'));
}

console.log('\n=== 6) 反向验证：闸门的边界 ===');
{
  // 脱敏是「按形态」生效的：等号/冒号后跟 ≥16 位紧凑随机串会被兜底规则遮掉。
  const randomish = 'someUnknownField=zzzzzzzzzzzzzzzzzzzz';
  const out = redactText(randomish);
  check('兜底规则能遮蔽未知键名后的长随机串', !out.includes('zzzzzzzzzzzzzzzzzzzz'), out);

  // 但自然语言文本不会被误伤（否则总结、标题、简介会被破坏）
  const prose = [
    '本片段来自 2025-01-01 的直播《DLC 开荒》，时间点 00:12:34 - 00:13:58',
    '残血翻盘那一刻，弹幕直接炸了。观众表示：这也行？',
    '分区：游戏/单机游戏；标签：名场面、高能、游戏；评分 9.2',
    'http://127.0.0.1:18010/task/abc123 任务已完成',
    'dtime = submitTime + 7800 + (N - 1) × 7500 + random(0, 1800)',
  ];
  for (const p of prose) {
    check(`自然语言不被误伤：${p.slice(0, 20)}…`, redactText(p) === p, redactText(p));
  }

  console.log('  ⚠️ 结论：redact 是「按已知形态」脱敏，不是万能橡皮擦。');
  console.log('     因此硬约束是「不打印整个 request/config 对象」，而不是依赖脱敏兜住一切。');
}

console.log(`\n===== 结果：PASS=${pass} FAIL=${fail} =====`);
if (fail > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log('\x1b[32m全部通过\x1b[0m');
}
