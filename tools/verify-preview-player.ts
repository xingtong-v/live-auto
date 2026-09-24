/**
 * 验证「试看」的最终语义：**定位切片产物 + 用系统播放器前台播放**。
 *
 * 用户第 4 轮需求："点击试看的时候 定位切片的产物目录 选择这个文件
 *                   然后用 win 系统自带的播放器前台播放给我看"
 *
 * 本工具做客观验证（沿用本项目已确立的纪律：**不看返回值，看前台进程**）：
 *   ① 接口返回 ok / player / playerForeground / cutOutput / cutDir
 *   ② 调完之后**前台进程确实是播放器**（这才是"用户能看到"的证据）
 *   ③ 资源管理器里确实定位并选中了那个产物
 *   ④ 未切片的候选要**如实返回 notCut**，而不是假装成功
 *   ⑤ `inline:true` 时仍可退回浏览器内联播放（带 Range）
 *
 * 用法：node --experimental-strip-types tools/verify-preview-player.ts <taskId> [index]
 */
import { execFileSync } from 'node:child_process';

const taskId = process.argv[2];
const index = Number(process.argv[3] ?? '0');
if (!taskId) {
  console.error('用法：node --experimental-strip-types tools/verify-preview-player.ts <taskId> [index]');
  process.exit(1);
}
const base = 'http://127.0.0.1:3000';
const line = (s = ''): void => console.log(s);

function ps(script: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    cwd: process.env['TEMP'],
  });
}
function foreground(): string {
  try {
    return ps(`Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
'@
$h=[W.U]::GetForegroundWindow(); $p=0; [void][W.U]::GetWindowThreadProcessId($h,[ref]$p)
(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName`).trim();
  } catch {
    return '(取不到)';
  }
}
function explorerWindows(): string[] {
  try {
    return ps(`$sh=New-Object -ComObject Shell.Application; @($sh.Windows()) | ForEach-Object { try { $_.LocationName } catch {} }`)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
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
line(`验证「试看 = 系统播放器前台播放」：task=${taskId} index=${index}`);
line('='.repeat(92));
line(`  调用前前台进程：${foreground()}`);
line(`  调用前资源管理器窗口：${explorerWindows().join(' | ') || '(无)'}`);

/* ---- ① 主路径 ---- */
line('');
line('① POST /api/preview-cut（默认：定位 + 系统播放器）');
const t0 = Date.now();
const r = await post('/api/preview-cut', { taskId, index });
const cost = Date.now() - t0;
ok('HTTP 200', r.status === 200, `实际 ${r.status}`);
line(`     说明：${String(r.json['note'] ?? '')}`);
line(`     耗时：${cost}ms（不转码，应该很快）`);

if (r.json['notCut']) {
  line('     （该候选还没切片产物 —— 符合预期的分支）');
  ok('未切片时如实返回 notCut', r.json['ok'] === false && r.json['notCut'] === true);
  line('');
  line(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  process.exit(fail === 0 ? 0 : 1);
}

ok('ok=true', r.json['ok'] === true, String(r.json['note'] ?? ''));
ok('返回了播放器名', typeof r.json['player'] === 'string' && String(r.json['player']).length > 0, String(r.json['player'] ?? '(无)'));
ok('返回切片产物路径', typeof r.json['cutOutput'] === 'string' && String(r.json['cutOutput']).length > 0, String(r.json['cutOutput'] ?? '(无)'));
ok('返回产物所在目录', typeof r.json['cutDir'] === 'string' && String(r.json['cutDir']).length > 0, String(r.json['cutDir'] ?? '(无)'));
line(`     播放器：${String(r.json['player'] ?? '?')}`);
line(`     产物：${String(r.json['cutOutput'] ?? '')}`);

/* ---- ② 客观判据：前台是不是播放器 ---- */
line('');
line('② 客观判据：前台进程（这是"用户能看到"的唯一证据）');
await new Promise((res) => setTimeout(res, 2500));
const fg = foreground();
line(`     调用后前台：${fg}`);
ok(
  '★ 前台是播放器（wmplayer/vlc/potplayer/mpc）',
  /wmplayer|vlc|potplayer|mpc/i.test(fg),
  `实际前台=${fg}（playerForeground=${String(r.json['playerForeground'])})`,
);
ok('接口自报 playerForeground=true', r.json['playerForeground'] === true, String(r.json['playerForeground']));

/* ---- ③ 资源管理器定位 ---- */
line('');
line('③ 资源管理器是否定位到产物目录');
const wins = explorerWindows();
line(`     当前窗口：${wins.join(' | ') || '(无)'}`);
const cutDir = String(r.json['cutDir'] ?? '');
const dirName = cutDir ? cutDir.split(/[\\/]/).filter(Boolean).pop() ?? '' : '';
ok('★ 资源管理器里有该产物目录的窗口', Boolean(dirName) && wins.some((w) => w.includes(dirName)), `期望包含「${dirName}」，实际 ${wins.join(' | ') || '(无)'}`);

/* ---- ④ inline 回退仍可用 ---- */
line('');
line('④ inline:true 回退（浏览器内联播放）');
const r2 = await post('/api/preview-cut', { taskId, index, inline: true });
ok('返回 videoUrl', typeof r2.json['videoUrl'] === 'string' && String(r2.json['videoUrl']).startsWith('/api/preview/'), String(r2.json['videoUrl'] ?? '(无)'));
if (typeof r2.json['videoUrl'] === 'string') {
  const vr = await fetch(`${base}${String(r2.json['videoUrl'])}`, { headers: { Range: 'bytes=0-1023' } });
  ok('videoUrl 可取到且支持 Range', (vr.status === 200 || vr.status === 206) && String(vr.headers.get('accept-ranges') ?? '').includes('bytes'), `HTTP ${vr.status} accept-ranges=${String(vr.headers.get('accept-ranges'))}`);
}

line('');
line(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  line('\x1b[31m失败项：\x1b[0m');
  for (const f of failures) line(`  - ${f}`);
}
process.exitCode = fail === 0 ? 0 : 1;
