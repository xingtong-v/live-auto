/**
 * 实时监控 ·「上一轮对每个文件的结论」的真浏览器验证（Edge headless + CDP），零费用。
 *
 * 为什么要有它：这一块是**长清单**，用户的原话是
 *   「这里的显示的太多了 而且是导入过的 优化他」
 * （截图里 35 个文件、35 行「已导入过（任务 …）」+ 每行一句重复的重跑指引）。
 * 优化规则是「需要留意的才直接列，已导入过的默认收起」，而这类"默认收起"的改动
 * **只有真浏览器能验证**：DOM 里存在 ≠ 用户看得见。所以要实际点一下展开、再收回去。
 *
 * 用法（服务需在线）：node --experimental-strip-types tools/verify-health-ui.ts [--headed]
 * 无待处理结论时（outcomes 为空）会自动走空态分支，不会假绿。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT_DIR, ensureDir, sleep } from '../src/util.ts';

const BASE = 'http://127.0.0.1:3000';
/* 与 ui-e2e（9333）、verify-perf-ui（9335）错开 */
const PORT = 9336;
const HEADED = process.argv.includes('--headed');

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
function eq<T>(name: string, actual: T, expected: T, detail?: string): void {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), detail ?? `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ---- 极简 CDP（与 verify-monitor-ui.ts 同一套写法） ---- */
class Cdp {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly pageErrors: string[] = [];
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      let m: { id?: number; method?: string; params?: unknown };
      try {
        m = JSON.parse(String(ev.data)) as typeof m;
      } catch {
        return;
      }
      if (typeof m.id === 'number') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        const err = (m as { error?: { message?: string } }).error;
        if (err) p.reject(new Error(err.message ?? 'CDP 错误'));
        else p.resolve((m as { result?: unknown }).result);
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const p = m.params as { exceptionDetails?: { exception?: { description?: string } } };
        this.pageErrors.push(p.exceptionDetails?.exception?.description ?? '页面异常');
      }
    });
  }
  static async attach(port: number): Promise<Cdp> {
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
        if (t) {
          const ws = new WebSocket(t.webSocketDebuggerUrl!);
          const c = new Cdp(ws);
          await new Promise<void>((res, rej) => {
            ws.addEventListener('open', () => res(), { once: true });
            ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
          });
          await c.send('Runtime.enable');
          await c.send('Page.enable');
          return c;
        }
      } catch {
        /* 端口还没起来 */
      }
      if (Date.now() > deadline) throw new Error('等不到 Edge 调试端口');
      await sleep(300);
    }
  }
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalJs<T>(expr: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })) as {
      result?: { value?: unknown };
      exceptionDetails?: { exception?: { description?: string } };
    };
    if (r.exceptionDetails) throw new Error(`页面 JS 异常：${r.exceptionDetails.exception?.description ?? ''}`);
    return r.result?.value as T;
  }
  get errors(): string[] {
    return [...this.pageErrors];
  }
  close(): void { try { this.ws.close(); } catch { /* ignore */ } }
}

async function main(): Promise<void> {
  console.log('\x1b[1m实时监控 ·「上一轮结论」长清单（真浏览器）\x1b[0m');
  console.log('─'.repeat(70));

  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error(`HTTP ${h.status}`);
  } catch (e) {
    console.log(`  \x1b[31m服务不可达：${(e as Error).message}\x1b[0m`);
    console.log('  请先启动：.\\run.cmd');
    process.exit(1);
  }
  ok('服务在线', true);

  const mon = (await (await fetch(BASE + '/api/monitor')).json()) as Record<string, unknown>;
  const watch = (mon['watch'] ?? {}) as Record<string, unknown>;
  if (!('outcomes' in watch)) {
    console.log('  \x1b[31m/api/monitor 里没有 watch.outcomes —— 服务跑的还是旧代码？\x1b[0m');
    process.exit(1);
  }
  const outs = (watch['outcomes'] ?? []) as Array<Record<string, unknown>>;
  const isImportedSkip = (o: Record<string, unknown>): boolean => !o['taskId'] && /^已导入过/.test(String(o['skipped'] ?? ''));
  const imported = outs.filter(isImportedSkip);
  const okCount = outs.filter((o) => o['taskId']).length;
  const noteworthy = outs.filter((o) => !isImportedSkip(o));
  const otherCount = noteworthy.length - okCount;
  console.log(`  \x1b[90m接口：共 ${outs.length} 个 · 导入成功 ${okCount} · 已导入过 ${imported.length} · 其它 ${otherCount}\x1b[0m`);

  const edge = [
    `${process.env['ProgramFiles(x86)'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['LOCALAPPDATA'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].find((p) => p && fs.existsSync(p));
  if (!edge) {
    console.log('  \x1b[31m找不到 Edge\x1b[0m');
    process.exit(1);
  }
  const userDataDir = path.join(os.tmpdir(), `live-auto-healthui-${Date.now()}`);
  const child: ChildProcess = spawn(
    edge,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1700,1500',
      ...(HEADED ? [] : ['--headless=new']),
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  let cdp: Cdp | undefined;
  try {
    cdp = await Cdp.attach(PORT);
    await cdp.send('Page.navigate', { url: BASE + '/' });
    for (let i = 0; i < 60; i++) {
      if (await cdp.evalJs<boolean>('!!document.querySelector("#tabs .tab")').catch(() => false)) break;
      await sleep(400);
    }
    const clicked = await cdp.evalJs<boolean>(
      `(() => { const t = document.querySelector('#tabs .tab[data-view="monitor"]'); if (!t) return false; t.click(); return true; })()`,
    );
    ok('点得动「实时监控」页签', clicked);

    let html = '';
    for (let i = 0; i < 60; i++) {
      html = await cdp.evalJs<string>('String(document.getElementById("otherPage").innerHTML)').catch(() => '');
      if (html.includes('上一轮对每个文件的结论')) break;
      await sleep(500);
    }
    ok('渲染出「上一轮对每个文件的结论」', html.includes('上一轮对每个文件的结论'), html.slice(0, 160));

    /* 表头必须先给分类计数：一眼看出"没有需要我处理的" */
    const headText = await cdp.evalJs<string>(
      `(() => { const h = [...document.querySelectorAll('#otherPage h3')].find((x) => String(x.textContent).includes('上一轮对每个文件的结论')); return h ? h.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`,
    );
    ok(`表头带分类计数（实际：${headText.slice(0, 90)}）`, /共 \d+ 个 · 导入成功 \d+ · 已导入过 \d+ · 其它 \d+/.test(headText), headText);
    ok('计数与接口一致', headText.includes(`共 ${outs.length} 个`) && headText.includes(`已导入过 ${imported.length}`), headText);

    if (imported.length > 0) {
      /* ★ 核心：默认收起 —— DOM 里有，但用户看不见 */
      const collapsed = await cdp.evalJs<boolean>(
        `(() => { const p = document.getElementById('healthImported'); if (!p) return false; return p.style.display === 'none' || p.offsetParent === null; })()`,
      );
      ok(`★ 已导入过的 ${imported.length} 行默认收起（屏幕上看不见）`, collapsed);

      const visibleRows = await cdp.evalJs<number>(
        `(() => [...document.querySelectorAll('#otherPage .tbl tbody tr')].filter((tr) => tr.offsetParent !== null).length)()`,
      );
      /* ★ 这条断言原本数的是**整页**的表格行，随着面板长出别的表（正在录制、依赖、墓碑清单…）
         就变成了"数据一变就红"的脆弱断言 —— 实测 2026-10-07 报了 17 行，其中 12 行是这张表、
         其余是别的卡片。所以拆成两条：这张表的 12 行上限（设计意图）+ 整页别太离谱（防噪音）。 */
      const notableRows = await cdp.evalJs<number>(
        `(() => { const h = [...document.querySelectorAll('#otherPage h3')].find((x) => String(x.textContent).includes('上一轮对每个文件的结论'));
           if (!h) return -1; const t = h.nextElementSibling; if (!t || t.tagName !== 'TABLE') return 0;
           return [...t.querySelectorAll('tbody tr')].filter((tr) => tr.offsetParent !== null).length; })()`,
      );
      ok(`★ 「上一轮结论」那张表最多 12 行（实际 ${notableRows} 行）`, notableRows >= 0 && notableRows <= 12, `实际 ${notableRows} 行`);
      ok(`整页可见表格行数不至于成为一堵墙（实际 ${visibleRows} 行）`, visibleRows <= 24, `可见 ${visibleRows} 行`);

      const headerText = await cdp.evalJs<string>(
        `(() => { const h = document.querySelector('[data-g="health-imported"]'); return h ? h.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`,
      );
      ok(`折叠表头写清是什么（实际：${headerText}）`, headerText.includes('已导入过') && headerText.includes(`${imported.length} 个`), headerText);

      /* 点一下 → 展开，行数应等于 min(imported, 60) */
      const afterClick = await cdp.evalJs<{ visible: number; caret: string }>(
        `(() => { document.querySelector('[data-g="health-imported"]').click(); const p = document.getElementById('healthImported'); return { visible: p ? [...p.querySelectorAll('tbody tr')].filter((tr) => tr.offsetParent !== null).length : -1, caret: document.querySelector('[data-g="health-imported"] .caret').textContent }; })()`,
      );
      eq('★ 点开后能看到这些历史行', afterClick.visible, Math.min(imported.length, 60));
      ok('点开后箭头变了（暗示还能收回去）', afterClick.caret === '▾', afterClick.caret);

      /* 再点一下 → 收回 */
      const afterSecond = await cdp.evalJs<boolean>(
        `(() => { document.querySelector('[data-g="health-imported"]').click(); const p = document.getElementById('healthImported'); return p.style.display === 'none'; })()`,
      );
      ok('★ 再点一下收回（可逆，不是一次性展开）', afterSecond);

      /* 逐行文案不许再拖着重复的长句 */
      const badRows = await cdp.evalJs<string[]>(
        `(() => [...document.querySelectorAll('#otherPage td')].map((td) => td.textContent).filter((t) => t.includes('如确实要重跑')))()`,
      );
      eq('★ 行内文案里没有重复的「怎么重跑」长句', badRows.length, 0, badRows.slice(0, 2).join(' | '));

      const hint = await cdp.evalJs<string>(
        `(() => { const p = [...document.querySelectorAll('#otherPage .hintline')].find((x) => String(x.textContent).includes('不会被自动重导')); return p ? p.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`,
      );
      ok('「不会自动重导 + 怎么重跑」整块只写一次', hint.includes('不会被自动重导') && hint.includes('导入录播'), hint.slice(0, 160));
    } else {
      console.log('  \x1b[90m（本次没有「已导入过」的文件，跳过折叠那一组）\x1b[0m');
    }

    if (noteworthy.length === 0) {
      ok('没有需要处理的结论时给一句话（而不是一张空表）', html.includes('这一轮没有需要你处理的结论'), html.slice(0, 200));
    }

    const errs = cdp.errors;
    eq('★ 页面没有未捕获异常', errs.length, 0, errs.join(' | ').slice(0, 300));

    const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data?: string };
    if (shot.data) {
      const dir = path.join(ROOT_DIR, 'data', 'verify-shots');
      ensureDir(dir);
      const file = path.join(dir, `monitor-imported-collapsed-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log(`  \x1b[90m截图：${file}\x1b[0m`);
    }
  } finally {
    cdp?.close();
    try { child.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (failures.length) {
    console.log('\x1b[31m失败项：\x1b[0m');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

await main();
