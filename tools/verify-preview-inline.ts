/**
 * 验证「试看」新语义：**返回一个可在界面内联播放的 mp4**（而不是打开资源管理器）。
 *
 * 覆盖：
 *   ① 首次调用会真的生成 mp4（含编码器与耗时）
 *   ② 返回的 `videoUrl` 可被 HTTP 取到，且是 `video/mp4`
 *   ③ 响应支持 **HTTP Range**（否则播放器不能拖动进度）
 *   ④ 第二次调用**命中缓存**、不再重复转码
 *   ⑤ 默认**不**打开资源管理器（用户明确不要这个行为）
 *   ⑥ `/api/preview/_preview/../..` 这类路径遍历必须被拒
 *
 * 用法：node --experimental-strip-types tools/verify-preview-inline.ts <taskId> [index]
 */
const taskId = process.argv[2];
const index = Number(process.argv[3] ?? '0');
if (!taskId) {
  console.error('用法：node --experimental-strip-types tools/verify-preview-inline.ts <taskId> [index]');
  process.exit(1);
}
const base = 'http://127.0.0.1:3000';

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

const boot = (await (await fetch(`${base}/api/bootstrap`)).json()) as { csrf?: string };
const H: Record<string, string> = { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrf ?? '', Origin: base };
const post = async (p: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};

line('='.repeat(92));
line(`验证「试看 = 界面内联播放」：task=${taskId} index=${index}`);
line('='.repeat(92));

/* ---- ① 首次生成 ---- */
line('');
line('① 首次调用（会真的转码）');
const t0 = Date.now();
const first = await post('/api/preview-cut', { taskId, index });
const wall = Date.now() - t0;
ok('HTTP 200', first.status === 200, `实际 ${first.status} ${JSON.stringify(first.json).slice(0, 120)}`);
ok('ok=true（片段生成成功）', first.json['ok'] === true, String(first.json['note'] ?? first.json['error'] ?? ''));
line(`     说明：${String(first.json['note'] ?? '')}`);
ok('★ 返回 videoUrl（界面内联播放地址）', typeof first.json['videoUrl'] === 'string' && String(first.json['videoUrl']).startsWith('/api/preview/'), String(first.json['videoUrl'] ?? '(无)'));
ok('默认不打开资源管理器（revealed=false）', first.json['revealed'] === false, `revealed=${String(first.json['revealed'])}`);
line(`     生成耗时 ${(wall / 1000).toFixed(1)}s，编码器 ${String(first.json['encoder'] ?? '?')}，` +
  `${first.json['bytes'] ? (Number(first.json['bytes']) / 1024 / 1024).toFixed(1) + ' MB' : '?'}`);

const videoUrl = String(first.json['videoUrl'] ?? '');

/* ---- ② videoUrl 可取到且是 video/mp4 ---- */
line('');
line('② 播放地址可用性');
if (!videoUrl) {
  ok('有 videoUrl 才能继续', false, '上一步没返回 videoUrl');
} else {
  const r = await fetch(`${base}${videoUrl}`, { headers: { Range: 'bytes=0-1023' } });
  ok('HTTP 200/206', r.status === 200 || r.status === 206, `实际 ${r.status}`);
  ok('Content-Type 是 video/mp4', String(r.headers.get('content-type') ?? '').includes('video/mp4'), String(r.headers.get('content-type')));
  ok('★ 支持 HTTP Range（播放器可拖动进度）', String(r.headers.get('accept-ranges') ?? '').includes('bytes'), String(r.headers.get('accept-ranges')));
  const buf = Buffer.from(await r.arrayBuffer());
  ok('前 1KB 是有效 mp4（含 ftyp box）', buf.length > 8 && buf.includes(Buffer.from('ftyp')), `前 12 字节：${buf.subarray(0, 12).toString('hex')}`);
}

/* ---- ③ 缓存命中 ---- */
line('');
line('③ 第二次调用应命中缓存（不重复转码）');
const t1 = Date.now();
const second = await post('/api/preview-cut', { taskId, index });
const wall2 = Date.now() - t1;
ok('ok=true', second.json['ok'] === true);
ok('★ fromCache=true', second.json['fromCache'] === true, `fromCache=${String(second.json['fromCache'])}`);
ok('★ 第二次明显更快（<1.5s）', wall2 < 1500, `实际 ${wall2}ms（首次 ${wall}ms）`);
line(`     第二次耗时 ${wall2}ms`);

/* ---- ④ 路径遍历防御 ---- */
line('');
line('④ 路径遍历必须被拒');
for (const bad of ['..%2F..%2Fpackage.json', '....//package.json', '..%5C..%5Cconfig.json']) {
  const r = await fetch(`${base}/api/preview/_preview/${bad}`);
  ok(`拒绝 ${bad}`, r.status >= 400, `实际 HTTP ${r.status}`);
}
{
  const r = await fetch(`${base}/api/preview/_preview/nonexistent.mp4`);
  ok('不存在的文件返回 404', r.status === 404, `实际 HTTP ${r.status}`);
}
{
  /* 扩展名白名单：即便在预览目录里，也不该允许任意类型 */
  const r = await fetch(`${base}/api/preview/_preview/x.exe`);
  ok('非白名单扩展名被拒', r.status >= 400, `实际 HTTP ${r.status}`);
}

line('');
line(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  line('\x1b[31m失败项：\x1b[0m');
  for (const f of failures) line(`  - ${f}`);
}
process.exitCode = fail === 0 ? 0 : 1;
