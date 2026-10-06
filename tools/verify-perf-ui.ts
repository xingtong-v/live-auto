/**
 * 「稿件表现」页的**真浏览器**验证（Edge headless + CDP），零费用、不投任何稿。
 *
 * 为什么要真浏览器：这一页是纯前端渲染（`renderPerf` 拼 HTML），
 * 后端接口对了不代表页面对 —— 实测过的失效方式有：
 *   · 函数写了但没接上页签（点了没反应，页面停在别处）；
 *   · 模板字符串写坏一个反引号 → 整页白屏、控制台一句话都不说；
 *   · 字段名漂移（后端给 `pulledTotal`、页面读 `pulled`）→ 永远显示「未拉取」。
 * 所以这里用真浏览器点开页签，把**渲染出来的行**和 `/api/performance` 的实参逐项比对。
 *
 * 用法（服务需在线）：node --experimental-strip-types tools/verify-perf-ui.ts [--headed]
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT_DIR, ensureDir, sleep } from '../src/util.ts';

const BASE = 'http://127.0.0.1:3000';
const PORT = 9333;
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
function eq<T>(name: string, actual: T, expected: T): void {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
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
  console.log('\x1b[1m稿件表现页（真浏览器）\x1b[0m');
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

  /* 先拿接口数据作为期望值：页面上应该渲染出同样的标题/播放数 */
  const api = (await (await fetch(BASE + '/api/performance')).json()) as Record<string, unknown>;
  const rows = (api['rows'] ?? []) as Array<Record<string, unknown>>;
  const archiveTotal = Number(api['archiveTotal'] ?? 0);
  const pulledTotal = Number(api['pulledTotal'] ?? 0);
  if (!('pulledTotal' in api)) {
    console.log('  \x1b[31m/api/performance 里没有 pulledTotal —— 服务跑的还是旧代码？\x1b[0m');
    process.exit(1);
  }
  const withView = rows.filter((r) => typeof r['view'] === 'number');
  console.log(`  \x1b[90m接口：${archiveTotal} 个稿件，其中 ${pulledTotal} 个有播放数据\x1b[0m`);

  const edge = [
    `${process.env['ProgramFiles(x86)'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['LOCALAPPDATA'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].find((p) => p && fs.existsSync(p));
  if (!edge) {
    console.log('  \x1b[31m找不到 Edge\x1b[0m');
    process.exit(1);
  }
  const userDataDir = path.join(os.tmpdir(), `live-auto-perfui-${Date.now()}`);
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
    ok('界面加载出来了（有页签）', await cdp.evalJs<boolean>('!!document.querySelector("#tabs .tab")'));

    /* 点开「稿件表现」页签 */
    const clicked = await cdp.evalJs<boolean>(
      `(() => { const t = document.querySelector('#tabs .tab[data-view="perf"]'); if (!t) return false; t.click(); return true; })()`,
    );
    ok('有「稿件表现」页签且点得动', clicked);

    let html = '';
    for (let i = 0; i < 60; i++) {
      html = await cdp.evalJs<string>('String(document.getElementById("otherPage").innerHTML)').catch(() => '');
      if (html.includes('已发布稿件表现') && !html.includes('正在拉取')) break;
      await sleep(500);
    }
    ok('渲染出了「已发布稿件表现」卡片（不是停在加载中）', html.includes('已发布稿件表现'), html.slice(0, 160));
    ok('★ 页面没有白屏：相关性与列表两张卡都在', html.includes('LLM 评分 vs 实际播放') && html.includes('稿件数'), html.slice(0, 200));

    /* 行数：接口的 rows 都应该渲染出来（含未拉取/已删除的行） */
    const trCount = await cdp.evalJs<number>(
      `(() => { const card = [...document.querySelectorAll('#otherPage .card')].find((c) => String(c.innerHTML).includes('已发布稿件表现')); if (!card) return -1; return card.querySelectorAll('tbody tr').length; })()`,
    );
    eq('★ 渲染的行数 = 接口给的稿件数', trCount, Math.min(rows.length, 100));

    /* 逐个抽查：有播放数据的行必须显示出数字，且标题与接口一致 */
    for (const r of withView.slice(0, 3)) {
      const bvid = String(r['bvid']);
      const view = String(r['view']);
      const title = String(r['title'] ?? '');
      const cdpTitle = await cdp.evalJs<string>(
        `(() => { const a = document.querySelector('#otherPage a[href="https://www.bilibili.com/video/${bvid}"]'); return a ? a.textContent : ''; })()`,
      );
      eq(`行 ${bvid} 的标题与接口一致`, cdpTitle, title);
      const shown = await cdp.evalJs<string>(
        `(() => { const a = document.querySelector('#otherPage a[href="https://www.bilibili.com/video/${bvid}"]'); if (!a) return ''; const tr = a.closest('tr'); return tr ? tr.textContent : ''; })()`,
      );
      ok(`行 ${bvid} 渲染出播放数 ${view}`, shown.includes(view), shown.slice(0, 120));
      ok(`行 ${bvid} 不是「未拉取」`, !shown.includes('未拉取'), shown.slice(0, 120));
    }

    /* 状态标注：锁定/已删除的稿件必须标出来，而不是显示 0 */
    const locked = rows.find((r) => typeof r['unavailable'] === 'string');
    if (locked) {
      const t = await cdp.evalJs<string>(
        `(() => { const a = document.querySelector('#otherPage a[href="https://www.bilibili.com/video/${String(locked['bvid'])}"]'); return a ? a.closest('tr').textContent : ''; })()`,
      );
      ok(`锁定稿件标出「${String(locked['unavailable'])}」`, t.includes(String(locked['unavailable'])), t.slice(0, 120));
      ok('锁定稿件不显示 0 播放（取不到就是取不到）', t.includes('—'), t.slice(0, 120));
      ok('锁定稿件的「数据日期」写的是「取不到」', t.includes('取不到'), t.slice(0, 160));
    } else {
      console.log('  \x1b[90m（本次没有锁定稿件，跳过这一组）\x1b[0m');
    }
    const gone = rows.find((r) => r['gone'] === true);
    if (gone) {
      const t = await cdp.evalJs<string>(
        `(() => { const a = document.querySelector('#otherPage a[href="https://www.bilibili.com/video/${String(gone['bvid'])}"]'); return a ? a.closest('tr').textContent : ''; })()`,
      );
      ok('已删除稿件标出「稿件已不存在」', t.includes('稿件已不存在'), t.slice(0, 120));
    } else {
      console.log('  \x1b[90m（本次没有已删除稿件，跳过这一组）\x1b[0m');
    }

    /* 多分P 标注：分P 数 > 1 的行要标出规模 */
    const multi = rows.find((r) => Number(r['partCount'] ?? 1) > 1);
    if (multi) {
      const t = await cdp.evalJs<string>(
        `(() => { const a = document.querySelector('#otherPage a[href="https://www.bilibili.com/video/${String(multi['bvid'])}"]'); return a ? a.closest('tr').textContent : ''; })()`,
      );
      ok(`多分P 稿件标出「同一稿件 ${Number(multi['partCount'])} 个分P」`, t.includes(`同一稿件 ${Number(multi['partCount'])} 个分P`), t.slice(0, 140));
    }

    /* 相关性表：没有可统计项时必须是解释文案，不能是一张全 0 的表（用户就是因为全 0 才报障的） */
    const corrTotal = ((api['correlation'] ?? []) as Array<Record<string, unknown>>).reduce((a, c) => a + Number(c['count'] ?? 0), 0);
    const corrCard = await cdp.evalJs<string>(
      `(() => { const card = [...document.querySelectorAll('#otherPage .card')].find((c) => String(c.innerHTML).includes('LLM 评分 vs 实际播放')); return card ? card.innerHTML : ''; })()`,
    );
    if (corrTotal === 0) {
      ok('★ 相关性无法统计时给出解释（不是一张全 0 的表）', !corrCard.includes('<tbody>'), corrCard.slice(0, 200));
      ok('解释里说明了原因', corrCard.includes('既有 LLM 评分') || corrCard.includes('还统计不了'), corrCard.slice(0, 300));
    } else {
      const corrRows = await cdp.evalJs<number>(
        `(() => { const card = [...document.querySelectorAll('#otherPage .card')].find((c) => String(c.innerHTML).includes('LLM 评分 vs 实际播放')); return card ? card.querySelectorAll('tbody tr').length : -1; })()`,
      );
      eq('相关性表 4 档都渲染出来', corrRows, 4);
    }

    /* 页面上不能有未捕获异常（白屏类故障只会出现在这里） */
    const errs = cdp.errors;
    eq('★ 页面没有未捕获异常', errs.length, 0, errs.join(' | ').slice(0, 300));

    /* 截图留证（给人看的） */
    const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data?: string };
    if (shot.data) {
      const dir = path.join(ROOT_DIR, 'data', 'verify-shots');
      ensureDir(dir);
      const file = path.join(dir, `perf-page-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
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
