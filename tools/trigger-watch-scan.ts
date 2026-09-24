/**
 * 触发一次目录扫描（`/api/watch/scan`）并打印结论 —— 用来验证"新素材会不会被自动导入"。
 *
 * 为什么单独写：这一步要带 CSRF 头，而在 PowerShell 里传中文/JSON 很容易踩引号与编码的坑
 * （本项目已多次遇到）。落成脚本最稳。
 *
 * 用法：node --experimental-strip-types tools/trigger-watch-scan.ts [port]
 */
const port = Number(process.argv[2] ?? '3000');
const base = `http://127.0.0.1:${port}`;
const line = (s = ''): void => console.log(s);

const bootRes = await fetch(`${base}/api/bootstrap`);
if (!bootRes.ok) {
  console.error(`bootstrap 失败：HTTP ${bootRes.status}`);
  process.exit(1);
}
const boot = (await bootRes.json()) as { csrf?: string };
const csrf = String(boot.csrf ?? '');
line(`  csrf 长度：${csrf.length}`);

const res = await fetch(`${base}/api/watch/scan`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Origin: base },
  body: '{}',
});
line(`  POST /api/watch/scan → HTTP ${res.status}`);
const text = await res.text();
let j: Record<string, unknown> = {};
try {
  j = JSON.parse(text) as Record<string, unknown>;
} catch {
  line(`  响应不是 JSON：${text.slice(0, 200)}`);
  process.exit(1);
}
line(`  返回字段：${Object.keys(j).join(', ')}`);
line('');
line('  原始返回：');
line('  ' + JSON.stringify(j, null, 2).split('\n').join('\n  '));
line('');

interface Outcome {
  fileName?: string;
  videoPath?: string;
  skipped?: string;
  taskId?: string;
  imported?: boolean;
  sizeMB?: number;
}
const outs = (j['outcomes'] ?? j['lastOutcomes'] ?? j['results'] ?? []) as Outcome[];
if (Array.isArray(outs) && outs.length > 0) {
  line(`  本轮逐文件结论：${outs.length} 条`);
  for (const o of outs) {
    const tag = o.imported ? '\x1b[32mIMPORTED\x1b[0m' : o.skipped ? '\x1b[33mSKIP\x1b[0m' : '?';
    line(`  [${tag}] ${String(o.fileName ?? o.videoPath ?? '').slice(0, 62)}`);
    if (o.skipped) line(`          原因：${String(o.skipped).slice(0, 110)}`);
    if (o.taskId) line(`          任务：${String(o.taskId)}`);
  }
} else {
  line('  （该接口只返回汇总；逐文件结论请查 GET /api/watch 的 lastOutcomes）');
}
line('');
