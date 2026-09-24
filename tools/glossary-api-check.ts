/**
 * 术语表接口体检：中文能原样存取、坏正则会被拒绝且不清空已有规则。
 *
 * ⚠️ 这条链路必须用 Node（或浏览器）测，**不要用 PowerShell 的 Invoke-RestMethod**：
 * PowerShell 5.1 在没有 charset 时会按本地代码页编码请求体，
 * 中文到服务端就变成了 `?` —— 数据真的会被写坏，而且看起来像服务端 bug。
 * （同一个坑在本项目已经踩过两次：一次是 passKey 被截断，一次就是这个。）
 *
 * 用法：node tools/glossary-api-check.ts
 */
const BASE = 'http://127.0.0.1:3000';

const boot = (await (await fetch(`${BASE}/api/bootstrap`)).json()) as { csrf: string };
const H = { 'Content-Type': 'application/json; charset=utf-8', 'X-CSRF-Token': boot.csrf };

const payload = {
  anchors: ['甲主播'],
  terms: ['后半夜后悔时代', '闪身步'],
  replacements: [{ from: '闪身部', to: '闪身步' }],
};

const put = (await (
  await fetch(`${BASE}/api/glossary`, { method: 'PUT', headers: H, body: JSON.stringify(payload) })
).json()) as { ok: boolean; note: string; stats: unknown };
console.log('PUT ok =', put.ok);
console.log('note   =', put.note);

const g = (await (await fetch(`${BASE}/api/glossary`)).json()) as {
  anchors: string[];
  terms: string[];
  replacements: Array<{ from: string; to: string }>;
  hotWords: { perLine: string };
};
console.log('anchors      =', JSON.stringify(g.anchors));
console.log('terms        =', JSON.stringify(g.terms));
console.log('replacements =', JSON.stringify(g.replacements));
console.log('hotWords     =', JSON.stringify(g.hotWords.perLine));

// 坏正则必须被拒（不写入）
const bad = (await (
  await fetch(`${BASE}/api/glossary`, {
    method: 'PUT',
    headers: H,
    body: JSON.stringify({ ...payload, replacements: [{ from: '(', to: '（', regex: true }] }),
  })
).json()) as { ok: boolean; issues: Array<{ level: string; message: string }> };
console.log('坏正则 ok =', bad.ok, '| issues =', JSON.stringify(bad.issues));
const after = (await (await fetch(`${BASE}/api/glossary`)).json()) as { replacements: unknown[] };
console.log('坏正则写入后 replacements 未被清空 =', JSON.stringify(after.replacements));
