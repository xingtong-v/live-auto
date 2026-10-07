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
/* 与 tools/ui-e2e.ts（9333）错开：两个工具可能同时在跑，抢同一个调试端口会互相踢掉 */
const PORT = 9335;
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

/**
 * 等页面把某个条件变成真（默认最多 8 秒）。
 *
 * 为什么必须有它（2026-10-08 实测的假红）：这个页面是**异步渲染**的 —— 切页签后要等
 * `/api/performance` 回来才画卡片，之后还会因为数据刷新整块重画。旧写法在 `html` 快照上
 * 判断完就直接 `document.getElementById('perfGoneToggle').click()`：只要那一下赶在渲染之前
 * （或夹在两次重画之间），按钮要么还不存在、要么刚点完就被重画覆盖，
 * 于是后面四条断言一起红 —— 而重跑一次又全绿。所有交互前都要先等元素真的在。
 */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 8000, stepMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond().catch(() => false)) return true;
    if (Date.now() > deadline) return false;
    await sleep(stepMs);
  }
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

    /* 行数：接口给的「在库」稿件都要渲染出来；「稿件已不存在」的行默认不显示（用户 2026-10-07 的要求） */
    const liveRows = rows.filter((r) => r['gone'] !== true);
    const goneRows = rows.filter((r) => r['gone'] === true);
    const trCount = await cdp.evalJs<number>(
      `(() => { const card = [...document.querySelectorAll('#otherPage .card')].find((c) => String(c.innerHTML).includes('已发布稿件表现')); if (!card) return -1; return card.querySelectorAll('tbody tr').length; })()`,
    );
    eq('★ 渲染的行数 = 接口给的「在库」稿件数（已删除的默认不显示）', trCount, Math.min(liveRows.length, 100));

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
      const bvid = String(gone['bvid']);
      const inDom = async () =>
        cdp!.evalJs<boolean>(`!!document.querySelector('#otherPage a[href="https://www.bilibili.com/video/${bvid}"]')`);
      ok('★ 已删除稿件默认不显示（用户要求「已删除的文件 不进行显示」）', (await inDom()) === false);
      ok(
        `★ 但给出「已隐藏 ${goneRows.length} 个」的说明，不是静默消失`,
        html.includes(`已隐藏 ${goneRows.length} 个`),
        html.slice(-320),
      );
      /* ⚠️ 先等按钮真的渲染出来再点（旧写法直接 getElementById('perfGoneToggle').click()，
         一旦赶在渲染之前就是"点了没反应"，后面四条断言连坐）。 */
      const toggleReady = await waitFor(async () =>
        cdp!.evalJs<boolean>(`!!document.getElementById('perfGoneToggle')`).catch(() => false),
      );
      const clicked =
        toggleReady &&
        (await cdp.evalJs<boolean>(
          `(() => { const b = document.getElementById('perfGoneToggle'); if (!b) return false; b.click(); return true; })()`,
        ));
      ok('有「显示它们」按钮且点得动', clicked, toggleReady ? '按钮在，但点击返回 false' : '等了 8 秒也没等到按钮渲染出来');
      let shownText = '';
      for (let i = 0; i < 30; i++) {
        shownText = await cdp.evalJs<string>(
          `(() => { const a = document.querySelector('#otherPage a[href="https://www.bilibili.com/video/${bvid}"]'); return a ? a.closest('tr').textContent : ''; })()`,
        ).catch(() => '');
        if (shownText) break;
        await sleep(300);
      }
      ok('★ 展开后能看到它，并标出「稿件已不存在」', shownText.includes('稿件已不存在'), shownText.slice(0, 120));
      ok('展开后「数据日期」写的是「已删除」而不是数字', shownText.includes('已删除'), shownText.slice(0, 160));
      /* 再点一次要能收回去：展开是一次性的开关，不能只出不进（也顺便把页面恢复成默认样子） */
      await waitFor(async () => cdp!.evalJs<boolean>(`!!document.getElementById('perfGoneToggle')`).catch(() => false));
      await cdp.evalJs<boolean>(`(() => { const b = document.getElementById('perfGoneToggle'); if (!b) return false; b.click(); return true; })()`);
      let backHidden = false;
      for (let i = 0; i < 30; i++) {
        if ((await inDom().catch(() => true)) === false) { backHidden = true; break; }
        await sleep(300);
      }
      ok('★ 再点一次能收回去（回到默认的隐藏状态）', backHidden);
      html = await cdp.evalJs<string>('String(document.getElementById("otherPage").innerHTML)').catch(() => '');
    } else {
      console.log('  \x1b[90m（本次没有已删除稿件，跳过这一组）\x1b[0m');
    }

    /* 多分P 标注：分P 数 > 1 的行要标出规模 */
    const multi = rows.find((r) => Number(r['partCount'] ?? 1) > 1);
    if (multi) {
      /* 上一次刚点过"收回隐藏行"，页面会整块重画 —— 等到这一行回来再断言（否则读到空字符串） */
      const want = `同一稿件 ${Number(multi['partCount'])} 个分P`;
      let t = '';
      await waitFor(async () => {
        t = await cdp!
          .evalJs<string>(
            `(() => { const a = document.querySelector('#otherPage a[href="https://www.bilibili.com/video/${String(multi['bvid'])}"]'); return a ? a.closest('tr').textContent : ''; })()`,
          )
          .catch(() => '');
        return t.includes(want);
      });
      ok(`多分P 稿件标出「${want}」`, t.includes(want), t.slice(0, 140));
    }

    /* ★ 排序可选（用户 2026-10-08：「这里的排序 可以改成可选的吗 比如稿件时间 播放 点赞 等」）：
       切到「点赞 → 降序」后，**第一行必须是接口数据里点赞最多的那个稿件**（行序由页面重排，
       不是接口给的顺序 —— 接口一直按播放降序）。再切升序验证方向生效，最后切回播放降序，
       免得把用户的选择留在点赞上（选择会记进 localStorage）。 */
    const withLike = rows.filter((r) => typeof r['like'] === 'number');
    const firstBvid = async (): Promise<string> => {
      const href = await cdp!
        .evalJs<string>(`(() => { const a = document.querySelector('#otherPage .card a[href^="https://www.bilibili.com/video/"]'); return a ? String(a.getAttribute('href')) : ''; })()`)
        .catch(() => '');
      return href ? href.split('/').pop()! : '';
    };
    /* 排序控件同样要等它渲染出来（页面重画期间它可能短暂不在 DOM 里） */
    const hasSort = await waitFor(async () =>
      cdp!.evalJs<boolean>(`!!document.getElementById('perfSortKey') && !!document.getElementById('perfSortDir')`).catch(() => false),
    );
    ok('★ 表现列表有排序选择器与方向按钮', hasSort);
    /* 切排序前再确认一次控件可用（重画会把 <select> 换掉，绑在旧节点上的操作会静默失效） */
    if (hasSort) await waitFor(async () => cdp!.evalJs<boolean>(`!!document.getElementById('perfSortKey')`).catch(() => false));
    /* 换排序后页面要重排：**别拿固定 sleep 去赌**（1.2 秒是猜的），等到期望的那一行出现再断言 */
    const waitFirstBvid = async (want: string): Promise<string> => {
      let seen = '';
      await waitFor(async () => {
        seen = await firstBvid();
        return seen === want;
      });
      return seen;
    };
    const waitDir = async (wantAsc: boolean): Promise<string> => {
      let text = '';
      await waitFor(async () => {
        text = await cdp!
          .evalJs<string>(`String((document.getElementById('perfSortDir') || {}).textContent || '')`)
          .catch(() => '');
        return wantAsc ? /升序/.test(text) : /降序/.test(text);
      });
      return text;
    };
    if (withLike.length >= 2 && hasSort) {
      const topLike = [...withLike].sort((a, b) => Number(b['like']) - Number(a['like']))[0]!;
      const bottomLike = [...withLike].sort((a, b) => Number(a['like']) - Number(b['like']))[0]!;
      await cdp.evalJs(
        `(() => { const s = document.getElementById('perfSortKey'); s.value = 'like'; s.dispatchEvent(new Event('change')); return true; })()`,
      );
      eq(
        `★ 切到「点赞」后第一行是点赞最多的（${String(topLike['bvid'])} ${String(topLike['like'])} 赞）`,
        await waitFirstBvid(String(topLike['bvid'])),
        String(topLike['bvid']),
      );
      const dirText = await waitDir(false);
      ok('方向按钮显示「↓ 降序」', /降序/.test(dirText), dirText);
      await cdp.evalJs(`document.getElementById('perfSortDir').click()`);
      eq(
        `★ 切成升序后第一行变成点赞最少的（${String(bottomLike['bvid'])} ${String(bottomLike['like'])} 赞）`,
        await waitFirstBvid(String(bottomLike['bvid'])),
        String(bottomLike['bvid']),
      );
      let headText = '';
      await waitFor(async () => {
        headText = await cdp!.evalJs<string>('String(document.getElementById("otherPage").innerHTML)').catch(() => '');
        return /按点赞升序/.test(headText);
      });
      ok('抬头文案跟着排序走', /按点赞升序/.test(headText), headText.slice(-160));

      /* ★ 2026-10-08 用户报「发布时间时 没有正确排序」：那是接口那一列**恒为空**（只有 1 行有值），
         不是排序逻辑的问题。修完接口后再锁一条端到端的：切「发布时间」行序要真的跟着变。 */
      const withPub = rows.filter((r) => typeof r['publishedAt'] === 'string');
      if (withPub.length >= 2) {
        const newest = [...withPub].sort((a, b) => String(b['publishedAt']).localeCompare(String(a['publishedAt'])))[0]!;
        const oldest = [...withPub].sort((a, b) => String(a['publishedAt']).localeCompare(String(b['publishedAt'])))[0]!;
        await cdp.evalJs(
          `(() => { const s = document.getElementById('perfSortKey'); s.value = 'publishedAt'; s.dispatchEvent(new Event('change')); return true; })()`,
        );
        await sleep(1200);
        /* ⚠️ 方向要**显式摆到降序**：上一组（点赞）把方向留在了升序，不能假设默认值 ——
           第一版就是漏了这句，于是拿"升序的结果"去比"降序的期望"，两条断言全红（页面其实是对的）。 */
        const dirTo = async (wantAsc: boolean): Promise<void> => {
          await cdp!.evalJs(
            `(() => { const b = document.getElementById('perfSortDir'); if (!b) return false; const isAsc = /升序/.test(String(b.textContent)); if (isAsc !== ${wantAsc}) b.click(); return true; })()`,
          );
          await waitDir(wantAsc);
        };
        await dirTo(false);
        eq(
          `★ 切「发布时间」降序后第一行是最新的（${String(newest['bvid'])} ${String(newest['publishedAt'])}）`,
          await waitFirstBvid(String(newest['bvid'])),
          String(newest['bvid']),
        );
        /* 升序：该是最早的那条（没有发布时间的行会沉底，正好不会干扰第一行） */
        await dirTo(true);
        eq(
          `★ 升序后第一行是最早的（${String(oldest['bvid'])} ${String(oldest['publishedAt'])}）`,
          await waitFirstBvid(String(oldest['bvid'])),
          String(oldest['bvid']),
        );
        const pubCol = await cdp.evalJs<string>(
          `(() => { const h = [...document.querySelectorAll('#otherPage .card th')].find((x) => /发布时间/.test(String(x.textContent))); return h ? String(h.textContent) : ''; })()`,
        );
        ok('表里有「发布时间」这一列（排序依据看得见）', /发布时间/.test(pubCol), pubCol);
      } else {
        console.log('  \x1b[90m（有发布时间的稿件不足 2 个，跳过「发布时间」这一组）\x1b[0m');
      }

      /* 收尾：切回「播放 · 降序」，避免影响用户下次打开（localStorage 记住了选择） */
      await cdp.evalJs(
        `(() => { const s = document.getElementById('perfSortKey'); s.value = 'view'; s.dispatchEvent(new Event('change')); const b = document.getElementById('perfSortDir'); if (b && /升序/.test(String(b.textContent))) b.click(); return true; })()`,
      );
      let resetHtml = '';
      await waitFor(async () => {
        resetHtml = await cdp!.evalJs<string>('String(document.getElementById("otherPage").innerHTML)').catch(() => '');
        return /按播放降序/.test(resetHtml);
      });
      ok('收尾切回播放降序', /按播放降序/.test(resetHtml), resetHtml.slice(-160));
    } else {
      console.log('  \x1b[90m（有播放数据的稿件不足 2 个，跳过排序这一组）\x1b[0m');
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
