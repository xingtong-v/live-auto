/**
 * 「错误报告」按钮的真浏览器验证：点了到底有没有反应。
 *
 * 为什么单独有这么一个工具（用户报的「错误报告 目前没有任何效果」）：
 * 单测能证明接口不再 404，但**证明不了界面**。当时的故障恰恰在界面这一层：
 * 20 个「报告」按钮点下去弹窗根本不出现（接口 404 → 一个转瞬即逝的 toast），
 * 页面既没有异常也没有报错 —— 只有真浏览器点一遍才看得见。
 *
 * 断言（全部在真实 Edge 里做）：
 *   ① 健康 / 实时监控两个页签都有「报告」按钮，且逐个点开都能出弹窗、有内容；
 *   ② 弹窗标题、提示语、正文都到位（不是空壳）；
 *   ③ 报告文件缺失时的降级提示确实会渲染（直接调页面自己的 reportNote()，
 *      不往真实 errors.jsonl 里塞夹具 —— 那是别人的诊断数据）；
 *   ④ 全程零未捕获异常。
 *
 * 前置：服务已在 127.0.0.1:3000 运行（`node src/cli.ts run`）。
 * 用法：node --experimental-strip-types tools/verify-error-report-ui.ts [--headed]
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT_DIR, ensureDir, sleep } from '../src/util.ts';

const BASE = 'http://127.0.0.1:3000';
const PORT = 9338; // 与 ui-e2e(9333) / tombstone-ui(9334) / monitor-ui(9336) 错开
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

/* ============================================================================
 * 极简 CDP 客户端（与其它 verify-*-ui 工具同样的做法：只做本用例需要的事）
 * ========================================================================== */
class Cdp {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly pageErrors: string[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return;
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP 错误'));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const p = msg.params as { exceptionDetails?: { exception?: { description?: string } } };
        this.pageErrors.push(p.exceptionDetails?.exception?.description ?? '页面异常');
      }
    });
  }

  static async attach(port: number): Promise<Cdp> {
    const deadline = Date.now() + 20000;
    let target: { webSocketDebuggerUrl?: string } | undefined;
    for (;;) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
          type: string;
          webSocketDebuggerUrl?: string;
        }>;
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (target) break;
      } catch {
        /* 端口还没起来 */
      }
      if (Date.now() > deadline) throw new Error('等不到 Edge 调试端口');
      await sleep(300);
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl!);
    const cdp = new Cdp(ws);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    return cdp;
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalJs<T>(expr: string, timeoutMs = 15000): Promise<T> {
    const r = (await this.send(
      'Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true },
      timeoutMs,
    )) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } };
    if (r.exceptionDetails) throw new Error(`页面 JS 异常：${r.exceptionDetails.exception?.description ?? ''}`);
    return r.result?.value as T;
  }

  get errors(): string[] {
    return [...this.pageErrors];
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function shot(cdp: Cdp, name: string): Promise<void> {
  try {
    ensureDir(SHOT_DIR);
    const r = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data?: string };
    if (r.data) {
      fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(r.data, 'base64'));
      console.log(`  \x1b[90m截图: data/ui-shots/${name}.png\x1b[0m`);
    }
  } catch {
    /* 截图失败不影响结论 */
  }
}

interface DialogState {
  open: boolean;
  title: string;
  bodyLen: number;
  tip: string;
  hasWarn: boolean;
}

async function main(): Promise<void> {
  console.log('\x1b[1m「错误报告」按钮真浏览器验证\x1b[0m');
  console.log('─'.repeat(74));

  /* 前置：接口层有内容可点（没有事件的话这个验证没有意义，如实报出来） */
  const health = (await (await fetch(`${BASE}/api/health`)).json()) as { errors?: unknown[] };
  const mon = (await (await fetch(`${BASE}/api/monitor`)).json()) as { errors?: unknown[] };
  const nHealth = health.errors?.length ?? 0;
  const nMon = mon.errors?.length ?? 0;
  console.log(`接口层：/api/health errors=${nHealth} 条；/api/monitor errors=${nMon} 条`);
  ok('健康面板有错误事件可点（否则本验证无从下手）', nHealth > 0, `只有 ${nHealth} 条`);

  const edge = [
    `${process.env['ProgramFiles(x86)'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['LOCALAPPDATA'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].find((p) => p && fs.existsSync(p));
  if (!edge) throw new Error('找不到 Edge');

  const userDataDir = path.join(os.tmpdir(), `live-auto-errverify-${Date.now()}`);
  const child: ChildProcess = spawn(
    edge,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1600,1000',
      ...(HEADED ? [] : ['--headless=new']),
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  let cdp: Cdp | undefined;
  try {
    cdp = await Cdp.attach(PORT);
    await cdp.send('Page.navigate', { url: BASE + '/' });
    for (let i = 0; i < 80; i++) {
      if (await cdp.evalJs<boolean>('!!document.querySelector("#taskList")').catch(() => false)) break;
      await sleep(300);
    }
    ok('页面加载完成', true);

    const switchTo = async (view: string): Promise<void> => {
      await cdp!.evalJs(`document.querySelector('#tabs .tab[data-view="${view}"]').click()`);
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        const ready = await cdp!
          .evalJs<boolean>(
            `(() => { const e = document.querySelector('#otherPage .empty'); return !e || !/加载中/.test(e.textContent); })()`,
          )
          .catch(() => false);
        if (ready) break;
      }
      await sleep(400);
    };

    for (const [view, label] of [
      ['health', '健康'],
      ['monitor', '实时监控'],
    ] as const) {
      section(`【${label}页签】逐个点开「报告」按钮`);
      await switchTo(view);
      const total = await cdp.evalJs<number>(`document.querySelectorAll('#otherPage [data-act="openreport"]').length`);
      ok(`${label}页有「报告」按钮`, total > 0, `找到 ${total} 个`);
      if (total === 0) continue;

      /* 挨个点：只点第一个的话，"后面的按钮没绑上"这种问题永远发现不了 */
      const toTry = Math.min(total, 6);
      let opened = 0;
      let withContent = 0;
      const samples: string[] = [];
      for (let i = 0; i < toTry; i++) {
        const rid = await cdp.evalJs<string>(
          `document.querySelectorAll('#otherPage [data-act="openreport"]')[${i}].dataset.report`,
        );
        await cdp.evalJs(`(() => {
          document.querySelector('#infoMask').classList.remove('show');
          document.querySelectorAll('#otherPage [data-act="openreport"]')[${i}].click();
          return true;
        })()`);
        await sleep(900);
        const st = await cdp.evalJs<DialogState>(`(() => {
          const q = (s) => document.querySelector(s);
          const mask = q('#infoMask');
          const body = q('#infoBody');
          return {
            open: !!mask && mask.classList.contains('show'),
            title: q('#infoTitle') ? q('#infoTitle').textContent : '',
            bodyLen: body ? body.innerHTML.length : -1,
            tip: q('#infoTip') ? q('#infoTip').textContent : '',
            hasWarn: !!(body && body.querySelector('.warnbox')),
          };
        })()`);
        if (st.open) opened++;
        if (st.open && st.bodyLen > 150) withContent++;
        samples.push(`${rid.slice(0, 28)}… open=${st.open} len=${st.bodyLen}${st.hasWarn ? ' 降级' : ''}`);
      }
      ok(`${label}页：点开的弹窗都出现了（${opened}/${toTry}）`, opened === toTry, samples.join(' | '));
      ok(`${label}页：弹窗里都有内容（不是空壳）（${withContent}/${toTry}）`, withContent === toTry, samples.join(' | '));

      /* 最后一个弹窗留着做断言，然后截图 */
      const last = await cdp.evalJs<DialogState>(`(() => {
        const q = (s) => document.querySelector(s);
        const body = q('#infoBody');
        return {
          open: q('#infoMask').classList.contains('show'),
          title: q('#infoTitle') ? q('#infoTitle').textContent : '',
          bodyLen: body ? body.innerHTML.length : -1,
          tip: q('#infoTip') ? q('#infoTip').textContent : '',
          hasWarn: !!(body && body.querySelector('.warnbox')),
        };
      })()`);
      ok(`${label}页：标题写明是错误报告`, /^错误报告 · /.test(last.title), last.title);
      ok(`${label}页：给了一键复制的提示语`, last.tip.length > 0, last.tip);
      await shot(cdp, `32-errreport-${view}`);
    }

    section('【降级提示】报告文件不存在时的说明条');
    {
      /* 直接调页面自己的函数：既不往真实 errors.jsonl 塞夹具，又能证明渲染确实生效 */
      const r = await cdp.evalJs<{ missing: string; normal: string }>(`(() => {
        const a = reportNote({ reportFileMissing: true });
        const b = reportNote({});
        return { missing: a.note, normal: b.note };
      })()`);
      ok('reportFileMissing=true 时有提示条', /warnbox/.test(r.missing) && /原始报告文件已不存在/.test(r.missing), r.missing.slice(0, 80));
      ok('提示条说明了缺的是哪部分（请求上下文/日志/堆栈）', /请求上下文/.test(r.missing) && /堆栈/.test(r.missing));
      ok('提示条说清"内容是从事件行合成的"（不假装是原始报告）', /事件行合成/.test(r.missing), r.missing.slice(0, 120));
      ok('正常报告不显示提示条（不能无差别吓人）', r.normal === '', r.normal);
      const tipMissing = await cdp.evalJs<string>(`reportNote({ reportFileMissing: true }).tip`);
      ok('降级时的复制提示语也如实说明', /降级内容/.test(tipMissing), tipMissing);
    }

    ok('全程页面没有未捕获异常', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | '));
  } catch (e) {
    fail++;
    failures.push(`验证异常：${(e as Error).message}`);
    console.log(`\n  \x1b[31m验证异常：${(e as Error).message}\x1b[0m`);
    console.log((e as Error).stack?.split('\n').slice(1, 4).join('\n'));
  } finally {
    try {
      await cdp?.send('Browser.close', {}, 4000);
    } catch {
      /* ignore */
    }
    cdp?.close();
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log('\n' + '─'.repeat(74));
  console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (fail > 0) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
    process.exitCode = 1;
  } else {
    console.log('\x1b[32m「报告」按钮点得开、有内容，降级提示如实。\x1b[0m');
  }
}

await main();
