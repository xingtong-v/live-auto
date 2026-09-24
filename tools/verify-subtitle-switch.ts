/**
 * 顶栏「字幕」开关的**真浏览器**验证（Edge headless + CDP）。
 *
 * ## 为什么值得单独一个工具
 *
 * 这个开关不是普通布尔值：字幕曾经被**整体关掉**，原因是云端 ASR 的句级时间窗不可靠
 * （实测「15 个字的句子占了 0→30.9 秒」，烧出来与声音整体错位）。换成本地 Fun-ASR 之后
 * 字级时间戳才可信（实测偏差 ±0.2 秒）。所以按钮有**两个"组合态"**：
 *   · 本地引擎（local-funasr / whisper-cpp）→ 绿色 ok
 *   · 云端引擎（bililive-tools）→ 琥珀 warn，且开启前必须弹确认
 * 这三个行为（写配置、按引擎变色、云端要确认）都不是"看一眼就知道对不对"，
 * 所以用一个真浏览器用例钉住它。
 *
 * ## 它会不会改坏我的配置
 *
 * 会**临时**把 `clip.burnSubtitles` 切两次（开→关），跑完恢复成进入时的值；
 * 即使中途失败，`finally` 里也会用 HTTP 还原。全程不建任务、不切片、不投稿。
 *
 * 运行（需要服务已在 127.0.0.1:3000 上跑）：
 *   node --experimental-strip-types tools/verify-subtitle-switch.ts
 *   加 --headed 可以看着浏览器跑。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT_DIR, ensureDir, sleep } from '../src/util.ts';

const BASE = 'http://127.0.0.1:3000';
const PORT = 9336; // 与 ui-e2e(9333)/tombstone(9334)/diag(9335) 错开，可同时跑
const HEADED = process.argv.includes('--headed');
const SHOT_DIR = path.join(ROOT_DIR, 'data', 'ui-shots');

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
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

interface Bootstrap {
  csrf: string;
  config: { clip: { burnSubtitles: boolean }; asr: { provider: string } };
}

async function boot(): Promise<Bootstrap> {
  return (await (await fetch(`${BASE}/api/bootstrap`)).json()) as Bootstrap;
}

async function patchSubtitles(csrf: string, value: boolean): Promise<void> {
  const res = await fetch(`${BASE}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ patch: { clip: { burnSubtitles: value } } }),
  });
  if (!res.ok) throw new Error(`写配置失败 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
}

async function main(): Promise<void> {
  const first = await boot();
  const csrf = first.csrf;
  const provider = String(first.config.asr.provider ?? '');
  const local = provider === 'local-funasr' || provider === 'whisper-cpp';
  const original = Boolean(first.config.clip.burnSubtitles);

  console.log(`服务：${BASE}`);
  console.log(`转写引擎：\x1b[1m${provider}\x1b[0m（${local ? '本地 —— 期望绿色 ok，不弹确认' : '云端 —— 期望琥珀色 warn，开启前必须确认'}）`);
  console.log(`进入时 clip.burnSubtitles = \x1b[1m${original}\x1b[0m（跑完会还原）`);

  const edge = [
    `${process.env['ProgramFiles(x86)'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['LOCALAPPDATA'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].find((p) => p && fs.existsSync(p));
  if (!edge) throw new Error('找不到 Edge（msedge.exe）');

  const udd = path.join(os.tmpdir(), `la-subswitch-${Date.now()}`);
  const child = spawn(
    edge,
    [`--remote-debugging-port=${PORT}`, `--user-data-dir=${udd}`, ...(HEADED ? [] : ['--headless=new']), '--no-first-run', '--window-size=1600,1000', 'about:blank'],
    { stdio: 'ignore' },
  );

  const cleanup = (): void => {
    try { child.kill(); } catch { /* ignore */ }
    try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  try {
    /* ---------------- 连上 CDP ---------------- */
    let wsUrl: string | undefined;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
        if (wsUrl) break;
      } catch { /* 端口还没起来 */ }
    }
    if (!wsUrl) throw new Error('调试端口未就绪');
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });

    let seq = 0;
    const pending = new Map<number, (v: unknown) => void>();
    const pageErrors: string[] = [];
    ws.addEventListener('message', (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data)) as {
        id?: number;
        method?: string;
        result?: unknown;
        error?: unknown;
        params?: { exceptionDetails?: { exception?: { description?: string } } };
      };
      if (m.id !== undefined) { pending.get(m.id)?.(m.result ?? m.error); pending.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params?.exceptionDetails?.exception?.description ?? '未知异常');
      }
    });
    const send = <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
      new Promise<T>((res) => { const id = ++seq; pending.set(id, (v) => res(v as T)); ws.send(JSON.stringify({ id, method, params })); });
    const evalJs = async <T = unknown>(expr: string): Promise<T> => {
      const r = await send<{ result?: { value?: T }; exceptionDetails?: { exception?: { description?: string } } }>(
        'Runtime.evaluate',
        { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true },
      );
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? '页面 JS 异常');
      return r.result?.value as T;
    };
    /** 轮询直到条件成立（页面的写配置是异步的：await api → await loadBootstrap） */
    const waitFor = async (label: string, expr: string, timeoutMs = 10000): Promise<boolean> => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (await evalJs<boolean>(expr)) return true;
        await sleep(200);
      }
      console.log(`      ⚠ 等待超时：${label}`);
      return false;
    };

    /** 存一张截图留证（和 ui-e2e 一样落在 data/ui-shots/，那是运行期目录、不进仓库） */
    const shot = async (name: string): Promise<void> => {
      const r = await send<{ data?: string }>('Page.captureScreenshot', { format: 'png' });
      if (!r?.data) return;
      ensureDir(SHOT_DIR);
      const p = path.join(SHOT_DIR, `subtitle-switch-${name}.png`);
      fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
      console.log(`      \x1b[90m截图: ${path.relative(ROOT_DIR, p)}\x1b[0m`);
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(1500);

    /* ---------------- 1. 首屏状态 ---------------- */
    section('1. 首屏：开关存在，且反映当前配置');
    const loaded = await waitFor('bootstrap 加载完成', `document.querySelector('#subText') && document.querySelector('#subText').textContent !== '字幕：加载中…'`);
    ok('页面加载完成（顶栏字幕标签已渲染）', loaded);
    ok('开关元素存在', await evalJs<boolean>(`!!document.querySelector('#subSwitch')`));
    ok('标签存在', await evalJs<boolean>(`!!document.querySelector('#subText')`));
    const label0 = await evalJs<string>(`document.querySelector('#subText').textContent`);
    const on0 = await evalJs<boolean>(`document.querySelector('#subSwitch').classList.contains('on')`);
    ok('开关的 on 态与配置一致', on0 === original, `配置 ${original}，界面 ${on0}`);
    const expectOff = '字幕：关';
    if (!original) ok(`关闭态文案 = 「${expectOff}」`, label0 === expectOff, `实际「${label0}」`);
    else ok('开启态文案带引擎提示', /字幕：开/.test(label0), `实际「${label0}」`);
    await shot('off');

    /* 拦截 confirm：本地引擎下不该弹，云端引擎下必须弹 —— 两种都要能断言 */
    await evalJs(`window.__confirmCalls = 0; window.__confirmText = ''; window.confirm = (m) => { window.__confirmCalls++; window.__confirmText = String(m); return true; }; true`);

    /* ---------------- 2. 点一下：反向切换 ---------------- */
    const target = !original;
    section(`2. 点一下：把字幕切到「${target ? '开' : '关'}」`);
    await evalJs(`document.querySelector('#subSwitch').click(); true`);
    const wrote = await waitFor('配置写入生效', `(async () => { const b = await (await fetch('/api/bootstrap')).json(); return b.config.clip.burnSubtitles === ${target}; })()`);
    ok('点一下确实改了 clip.burnSubtitles（走 POST /api/config）', wrote);
    const after = await boot();
    ok('服务端配置已变为目标值', Boolean(after.config.clip.burnSubtitles) === target, `实际 ${after.config.clip.burnSubtitles}`);
    /* ⚠ 必须等**界面**到位再断言文案/颜色：写配置与界面刷新之间隔着一次 loadBootstrap()，
       只等服务端配置翻面会在两次往返之间抢跑（第一版就是这么假红的）。 */
    const domOn = await waitFor('界面切到目标态', `document.querySelector('#subSwitch').classList.contains('on') === ${target}`);

    if (target) {
      const label2 = await evalJs<string>(`document.querySelector('#subText').textContent`);
      const cls = await evalJs<string>(`document.querySelector('#subMode').className`);
      if (local) {
        ok('本地引擎 → 文案标注「本地 ASR」', label2.includes('本地 ASR'), `实际「${label2}」`);
        ok('本地引擎 → 组合态为绿色 ok', /\bok\b/.test(cls), `class="${cls}"`);
        ok('本地引擎 → 不弹确认（这是预期可用的组合）', (await evalJs<number>(`window.__confirmCalls`)) === 0);
      } else {
        ok('云端引擎 → 文案给出「可能错位」警告', label2.includes('错位'), `实际「${label2}」`);
        ok('云端引擎 → 组合态为琥珀色 warn', /\bwarn\b/.test(cls), `class="${cls}"`);
        const calls = await evalJs<number>(`window.__confirmCalls`);
        ok('云端引擎 → 开启前必须弹确认', calls >= 1, `confirm 调用 ${calls} 次`);
        const text = await evalJs<string>(`window.__confirmText`);
        ok('确认框里说明了原因（含实测数据）', /30\.9|句级时间窗|错位/.test(text), text.slice(0, 120));
      }
      ok('开关的 on 态已更新', domOn);
      await shot(local ? 'on-local' : 'on-cloud-warn');
    } else {
      ok('界面已切到关闭态', domOn);
      ok('关掉后文案回到「字幕：关」', (await evalJs<string>(`document.querySelector('#subText').textContent`)) === expectOff);
      ok('关掉后不再带 ok / warn 组合态', !/\b(ok|warn)\b/.test(await evalJs<string>(`document.querySelector('#subMode').className`)));
    }

    /* ---------------- 3. 再点一下：还原 ---------------- */
    section('3. 再点一下：还原到进入时的状态');
    await evalJs(`document.querySelector('#subSwitch').click(); true`);
    const back = await waitFor('配置还原生效', `(async () => { const b = await (await fetch('/api/bootstrap')).json(); return b.config.clip.burnSubtitles === ${original}; })()`);
    ok('配置已还原', back);
    const domBack = await waitFor('界面还原', `document.querySelector('#subSwitch').classList.contains('on') === ${original}`);
    ok('界面 on 态已还原', domBack);
    ok('文案也还原成进入时的那句', (await evalJs<string>(`document.querySelector('#subText').textContent`)) === label0, `进入时是「${label0}」`);

    /* ---------------- 4. 页面没被弄坏 ---------------- */
    section('4. 页面健康');
    ok('全程没有未捕获的 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    ok('任务列表仍然渲染（顶栏改动没影响主流程）', await evalJs<boolean>(`!!document.querySelector('#taskList')`));

    ws.close();
  } finally {
    /* 兜底还原：即使上面某步抛异常，也不能把用户的配置留在别的值上 */
    try {
      const now = await boot();
      if (Boolean(now.config.clip.burnSubtitles) !== original) {
        await patchSubtitles(csrf, original);
        console.log(`\n\x1b[33m[还原] finally 里把 clip.burnSubtitles 改回 ${original}\x1b[0m`);
      }
    } catch (e) {
      console.log(`\n\x1b[31m[还原失败] 请手动确认 clip.burnSubtitles，期望 ${original}：${(e as Error).message}\x1b[0m`);
    }
    cleanup();
  }

  console.log('\n' + '─'.repeat(74));
  console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  \x1b[31m·\x1b[0m ' + f);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\x1b[31m验证脚本自身出错：\x1b[0m' + (e as Error).message);
  process.exit(1);
});
