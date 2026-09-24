/**
 * 验证「试看」与「在文件管理器中定位」两个接口。
 *
 * 背景（用户需求）："在候选切片点击试看的时候，可以直接跳转的文件所在目录吗"。
 * 原实现只返回一段提示文字（含源文件路径），用户还得自己去资源管理器里找。
 * 现在 `/api/preview-cut` 会**真的打开文件管理器并选中源文件**，
 * 并新增 `/api/reveal` 让 UI 上任何路径都能一键定位。
 *
 * 本脚本覆盖：
 *   ① 试看返回的字段是否完整（起止点 / 源文件 / 所在目录 / 切片产物）
 *   ② `noOpen` 时**不**打开任何窗口（供自动化使用，避免测试时满屏弹资源管理器）
 *   ③ 真实调用时 `revealed=true`（本次会真的弹一个资源管理器窗口）
 *   ④ `/api/reveal` 的四种 kind
 *   ⑤ 安全边界：非法 taskId（路径穿越式）、未知 kind 都必须被拒
 *
 * 用法：
 *   node --experimental-strip-types tools/verify-reveal-api.ts <taskId> [--no-open] [--port 3000]
 *
 * ⚠️ 默认会真的打开资源管理器窗口（这正是要验证的行为）。只想看返回结构就加 --no-open。
 */
const argv = process.argv.slice(2);
const taskId = argv[0];
if (!taskId) {
  console.error('用法：node --experimental-strip-types tools/verify-reveal-api.ts <taskId> [--no-open] [--port 3000]');
  process.exit(1);
}
const noOpen = argv.includes('--no-open');
const pi = argv.indexOf('--port');
const port = pi > 0 ? Number(argv[pi + 1]) : 3000;
const base = `http://127.0.0.1:${port}`;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(detail ? `${name} :: ${detail}` : name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}
const line = (s = ''): void => console.log(s);

/* ---- 取 CSRF（服务要求 Origin + CSRF 双校验，硬约束 #15） ---- */
const boot = await fetch(`${base}/api/bootstrap`);
if (!boot.ok) {
  console.error(`服务不可用（${base}/api/bootstrap → HTTP ${boot.status}）`);
  process.exit(1);
}
const bootJson = (await boot.json()) as { csrf?: string };
const csrf = bootJson.csrf ?? '';
if (!csrf) {
  console.error('bootstrap 没有返回 csrf');
  process.exit(1);
}
const H: Record<string, string> = {
  'Content-Type': 'application/json',
  'X-CSRF-Token': csrf,
  Origin: base,
};
const post = async (p: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  let json: Record<string, unknown> = {};
  try {
    json = (await r.json()) as Record<string, unknown>;
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: r.status, json };
};

line('='.repeat(90));
line(`验证试看 / 定位接口（task=${taskId}，${base}）`);
line('='.repeat(90));

/* ---- ① noOpen：只验返回结构 ---- */
line('');
line('① 试看（noOpen=true，不打开窗口）');
{
  const { status, json } = await post('/api/preview-cut', { taskId, index: 0, noOpen: true });
  ok('HTTP 200', status === 200, `实际 ${status} ${JSON.stringify(json).slice(0, 120)}`);
  ok('返回起止秒数', typeof json['startSec'] === 'number' && typeof json['endSec'] === 'number', JSON.stringify({ s: json['startSec'], e: json['endSec'] }));
  ok('endSec > startSec', Number(json['endSec']) > Number(json['startSec']));
  ok('返回源文件路径', typeof json['sourcePath'] === 'string' && String(json['sourcePath']).length > 0, String(json['sourcePath'] ?? '(空)'));
  ok('返回所在目录（UI 直接展示用）', typeof json['sourceDir'] === 'string' && String(json['sourceDir']).length > 0, String(json['sourceDir'] ?? '(空)'));
  ok('noOpen 时 revealed=false（没有偷偷打开窗口）', json['revealed'] === false, `revealed=${String(json['revealed'])}`);
  ok('提示语里说明"不做转码预览"', String(json['note'] ?? '').includes('不做转码预览'));
  if (json['cutOutput']) ok('已切片的片段会带上 cutOutput', String(json['cutOutput']).length > 0);
}

/* ---- ② 真实打开 ---- */
line('');
line('② 试看（真实调用 —— 会弹出一个资源管理器窗口）');
if (noOpen) {
  line('  （--no-open 已跳过）');
} else {
  const { status, json } = await post('/api/preview-cut', { taskId, index: 0 });
  ok('HTTP 200', status === 200, `实际 ${status}`);
  ok('★ revealed=true（真的打开了文件管理器）', json['revealed'] === true, `revealed=${String(json['revealed'])} err=${String(json['revealError'] ?? '')}`);
  ok('返回了实际执行的命令（便于排查）', typeof json['revealHow'] === 'string' && String(json['revealHow']).length > 0, String(json['revealHow'] ?? ''));
  line(`    执行：${String(json['revealHow'] ?? '')}`);
}

/* ---- ③ /api/reveal 四种 kind ---- */
line('');
line('③ /api/reveal 的四种 kind');
for (const kind of ['source', 'cut', 'taskDir', 'full']) {
  const { status, json } = await post('/api/reveal', { taskId, kind, index: 0 });
  const good = status === 200 && json['ok'] === true;
  ok(`kind=${kind} 定位成功`, good, `HTTP ${status} ${good ? '' : JSON.stringify(json).slice(0, 120)}`);
  if (good) line(`    → ${String(json['target'] ?? '')}`);
}

/* ---- ④ 安全边界 ---- */
line('');
line('④ 安全边界（必须全部被拒）');
{
  const { status, json } = await post('/api/reveal', { taskId: '../../windows/win.ini', kind: 'source' });
  ok('路径穿越式 taskId 被拒', status >= 400, `HTTP ${status} ${JSON.stringify(json).slice(0, 80)}`);
}
{
  const { status, json } = await post('/api/reveal', { taskId, kind: 'bogus' });
  ok('未知 kind 被拒', status >= 400, `HTTP ${status} ${JSON.stringify(json).slice(0, 80)}`);
}
{
  const { status } = await post('/api/reveal', { taskId, kind: 'cut' });
  ok('kind=cut 缺 index 被拒', status >= 400, `HTTP ${status}`);
}
{
  /* 无 CSRF 必须被拒（硬约束 #15） */
  const r = await fetch(`${base}/api/reveal`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ taskId, kind: 'taskDir' }) });
  ok('缺 CSRF 被拒', r.status >= 400, `HTTP ${r.status}`);
}
{
  /* 错误 Origin 必须被拒 */
  const r = await fetch(`${base}/api/reveal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Origin: 'http://evil.example.com' },
    body: JSON.stringify({ taskId, kind: 'taskDir' }),
  });
  ok('非法 Origin 被拒', r.status >= 400, `HTTP ${r.status}`);
}

line('');
line(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  line('\x1b[31m失败项：\x1b[0m');
  for (const f of failures) line(`  - ${f}`);
}
process.exitCode = fail === 0 ? 0 : 1;
