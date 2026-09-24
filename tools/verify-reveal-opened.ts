/**
 * 修复后的端到端验证：调 `/api/reveal` 之后，**资源管理器窗口里是否真的出现了目标**。
 *
 * 这是对"试看没跳转"那个问题的收口验证 —— 之前的教训是
 * **不能把 `revealed:true`（命令发出去了）当成"用户看到了"**。
 * 所以判据换成：枚举资源管理器窗口的 LocationName，看目标目录名是否出现在里面。
 *
 * 用法：node --experimental-strip-types tools/verify-reveal-opened.ts <taskId> [--port 3000]
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const taskId = process.argv[2];
if (!taskId) {
  console.error('用法：node --experimental-strip-types tools/verify-reveal-opened.ts <taskId>');
  process.exit(1);
}
const pi = process.argv.indexOf('--port');
const port = pi > 0 ? Number(process.argv[pi + 1]) : 3000;
const base = `http://127.0.0.1:${port}`;
const line = (s = ''): void => console.log(s);

/** 枚举资源管理器窗口的 LocationName（-EncodedCommand 避免引号/`$` 被 shell 吃掉） */
function explorerWindows(): string[] {
  const ps =
    '$sh=New-Object -ComObject Shell.Application; @($sh.Windows()) | ForEach-Object { try { $_.LocationName } catch {} }';
  const b64 = Buffer.from(ps, 'utf16le').toString('base64');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { encoding: 'utf8' });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
/** 关闭标题里含指定串的窗口，避免影响下一次判定 */
function closeWindowsMatching(needle: string): void {
  const ps = `$sh=New-Object -ComObject Shell.Application; @($sh.Windows()) | Where-Object { try { $_.LocationName -like '*${needle}*' } catch { $false } } | ForEach-Object { try { $_.Quit() } catch {} }`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
}

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    line(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(detail ? `${name} :: ${detail}` : name);
    line(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

const boot = (await (await fetch(`${base}/api/bootstrap`)).json()) as { csrf?: string };
const H: Record<string, string> = { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrf ?? '', Origin: base };
const post = async (p: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};

line('='.repeat(92));
line(`验证「真的打开了」：task=${taskId}`);
line('='.repeat(92));
line(`  基线窗口：${explorerWindows().join(' | ') || '(无)'}`);
line('');

/* ---- ① source：应打开源文件所在目录（丙主播）并选中 flv ---- */
line('① kind=source（定位源文件 → 打开其所在目录并选中）');
closeWindowsMatching('丙主播');
await new Promise((r) => setTimeout(r, 1200));
{
  const { status, json } = await post('/api/reveal', { taskId, kind: 'source' });
  ok('接口返回成功', status === 200 && json['ok'] === true, `HTTP ${status} ${JSON.stringify(json).slice(0, 100)}`);
  const target = String(json['target'] ?? '');
  line(`     目标：${target}`);
  await new Promise((r) => setTimeout(r, 3200));
  const wins = explorerWindows();
  const dirName = path.basename(path.dirname(target));
  const hit = wins.some((w) => w.includes(dirName));
  ok(`★ 资源管理器窗口里出现了「${dirName}」`, hit, `当前窗口：${wins.join(' | ') || '(无)'}`);
  line(`     执行：${String(json['how'] ?? '')}`);
}

/* ---- ② taskDir：应打开任务目录 ---- */
line('');
line('② kind=taskDir（打开任务目录）');
closeWindowsMatching(taskId);
await new Promise((r) => setTimeout(r, 1200));
{
  const { status, json } = await post('/api/reveal', { taskId, kind: 'taskDir' });
  ok('接口返回成功', status === 200 && json['ok'] === true, `HTTP ${status}`);
  await new Promise((r) => setTimeout(r, 3200));
  const wins = explorerWindows();
  const hit = wins.some((w) => w.includes(taskId));
  ok(`★ 窗口里出现了任务目录名`, hit, `当前窗口：${wins.join(' | ') || '(无)'}`);
  line(`     执行：${String(json['how'] ?? '')}`);
}

/* ---- ③ 试看接口：也会打开源文件所在目录 ---- */
line('');
line('③ /api/preview-cut（试看）');
/* ⚠️ 判定前必须**先关掉已有窗口**：`explorer.exe` 对同一个目录是**复用**已有窗口、
   不新建的（Windows 既定行为，不是 bug）。所以"窗口列表里有没有它"才是正确判据，
   而"有没有新窗口出现"在同路径重复测试时会假失败 —— 第一版就这么误判过一次。 */
closeWindowsMatching('丙主播');
await new Promise((r) => setTimeout(r, 1500));
{
  const { status, json } = await post('/api/preview-cut', { taskId, index: 0 });
  ok('接口返回成功', status === 200, `HTTP ${status}`);
  ok('revealed=true', json['revealed'] === true, String(json['revealed']));
  await new Promise((r) => setTimeout(r, 3500));
  const wins = explorerWindows();
  const hit = wins.some((w) => w.includes('丙主播'));
  ok('★ 试看后存在「丙主播」目录窗口', hit, `当前窗口：${wins.join(' | ') || '(无)'}`);
  line(`     执行：${String(json['revealHow'] ?? '')}`);
}

line('');
line(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  line('\x1b[31m失败项：\x1b[0m');
  for (const f of failures) line(`  - ${f}`);
}
process.exitCode = fail === 0 ? 0 : 1;
