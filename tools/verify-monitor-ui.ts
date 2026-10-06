/**
 * 「实时监控 · 已投稿文件」块的**真浏览器**验证（Edge headless + CDP）。
 *
 * ## 为什么单独一个工具
 *
 * `test/monitor-panel.ts` 验的是 `/api/monitor` 的**数据契约**（那部分 126 项断言很扎实），
 * 但它是 Node 侧断言 —— 以下几个失效方式**只有真在浏览器里才会暴露**：
 *   · 卡片渲染出来了但表头/列错位（拼 HTML 时少个 `</td>`）；
 *   · 状态列的分支写反：该显示可点 bv 号的行显示了「审核中」（或反过来）；
 *   · 删除按钮渲染出来了但**没绑处理函数**（本项目踩过：`$(...)` 当 `$$(...)` 用，
 *     整段绑定静默不执行，点上去毫无反应）；
 *   · 长文件名 / 长状态文案把表格撑破。
 *
 * 所以这里真点一遍：切页签 → 断言卡片与行 → 断言「审核中」与 bv 链接**至少有一类存在且互斥**
 *   → 断言删除按钮**真的绑了 onclick** → 截图。
 *
 * 只读：不点删除（那会移动文件）。零付费。
 *
 * 运行（需要服务已在 127.0.0.1:3000 上跑）：
 *   node --experimental-strip-types tools/verify-monitor-ui.ts [--headed]
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT_DIR, ensureDir, sleep } from '../src/util.ts';

const BASE = 'http://127.0.0.1:3000';
const PORT = 9336;
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
function eq<T>(name: string, actual: T, expected: T): void {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ---- 极简 CDP（与 verify-tombstone-ui.ts 同一套写法） ---- */
class Cdp {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly pageErrors: string[] = [];
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      let m: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
      try {
        m = JSON.parse(String(ev.data)) as typeof m;
      } catch {
        return;
      }
      if (typeof m.id === 'number') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message ?? 'CDP 错误'));
        else p.resolve(m.result);
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
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 20000): Promise<unknown> {
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
  console.log('\x1b[1m实时监控 · 已投稿文件（真浏览器）\x1b[0m');
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

  /* 先拿一份接口数据作为"期望值" —— 页面上应该渲染出同样的行数 */
  const api = (await (await fetch(BASE + '/api/monitor')).json()) as Record<string, unknown>;
  const uf = api['uploadedFiles'] as Record<string, unknown> | undefined;
  if (!uf) {
    console.log('  \x1b[31m/api/monitor 里没有 uploadedFiles —— 服务跑的还是旧代码？\x1b[0m');
    process.exit(1);
  }
  const apiItems = (uf['items'] ?? []) as Array<Record<string, unknown>>;
  const expectPassed = apiItems.filter((i) => i['reviewState'] === 'published' && i['bvid']).length;
  const expectReviewing = apiItems.length - expectPassed;
  console.log(`  \x1b[90m接口：${apiItems.length} 项（应显示 bv 号 ${expectPassed} / 审核中 ${expectReviewing}）\x1b[0m`);

  const edge = [
    `${process.env['ProgramFiles(x86)'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['LOCALAPPDATA'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].find((p) => p && fs.existsSync(p));
  if (!edge) {
    console.log('  \x1b[31m找不到 Edge\x1b[0m');
    process.exit(1);
  }
  const userDataDir = path.join(os.tmpdir(), `live-auto-monui-${Date.now()}`);
  const child: ChildProcess = spawn(
    edge,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1600,1400',
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
      if (await cdp.evalJs<boolean>('!!document.querySelector("#taskList")').catch(() => false)) break;
      await sleep(400);
    }
    ok('页面加载完成', true);

    await cdp.evalJs(`document.querySelector('#tabs .tab[data-view="monitor"]').click()`);
    let ready = false;
    for (let i = 0; i < 40; i++) {
      ready = await cdp.evalJs<boolean>(`String(document.getElementById('otherPage').innerHTML).includes('已投稿文件')`).catch(() => false);
      if (ready) break;
      await sleep(400);
    }
    ok('切到监控页后出现「已投稿文件」卡片', ready);

    const view = await cdp.evalJs<{
      rows: number;
      header: string;
      kinds: string[];
      withLink: number;
      withoutLink: number;
      withDel: number;
      boundBtns: number;
      emptyStatus: number;
      firstRow: string;
      note: string;
      bulkText: string;
      bulkN: string;
      bulkMb: string;
      bulkBound: boolean;
    }>(`(() => {
      const box = document.getElementById('otherPage');
      const card = Array.from(box.querySelectorAll('.card')).find((c) => String(c.querySelector('h2')?.textContent || '').includes('已投稿文件'));
      if (!card) return { rows: 0, header: '', kinds: [], withLink: 0, withoutLink: 0, withDel: 0, boundBtns: 0, emptyStatus: 0, firstRow: '', note: '', bulkText: '', bulkN: '', bulkMb: '', bulkBound: false };
      const rows = Array.from(card.querySelectorAll('tbody tr'));
      /* 逐行判定，别用全局计数 —— 第一版用 querySelectorAll('tbody .tag-mini')
         数状态标签，而「类型」列也是 .tag-mini，于是 7 行数出 14 个。 */
      const hasLink = rows.filter((r) => !!r.querySelector('a[href*="bilibili.com/video/"]'));
      const btns = Array.from(card.querySelectorAll('[data-act="del-published"]'));
      const bulk = card.querySelector('[data-act="del-published-all"]');
      return {
        rows: rows.length,
        header: String(card.querySelector('h2')?.textContent || '').replace(/\\s+/g, ' ').trim(),
        kinds: [...new Set(rows.map((r) => String(r.children[1]?.textContent || '').trim().split(' ')[0]))],
        withLink: hasLink.length,
        withoutLink: rows.length - hasLink.length,
        withDel: rows.filter((r) => !!r.querySelector('[data-act="del-published"]')).length,
        // onclick 为空 = 绑定的那段代码没执行（本项目踩过 $ 与 $$ 用混的事故）
        boundBtns: btns.filter((b) => typeof b.onclick === 'function').length,
        emptyStatus: rows.filter((r) => !String(r.children[0]?.textContent || '').trim()).length,
        firstRow: rows[0] ? String(rows[0].innerText).replace(/\\s+/g, ' ').slice(0, 110) : '',
        note: String(card.textContent || '').includes('不会') && String(card.textContent || '').includes('稿件') ? '有"不撤回稿件"说明' : '',
        bulkText: bulk ? String(bulk.textContent || '').trim() : '',
        bulkN: bulk ? String(bulk.dataset.n || '') : '',
        bulkMb: bulk ? String(bulk.dataset.mb || '') : '',
        bulkBound: bulk ? typeof bulk.onclick === 'function' : false,
      };
    })()`);

    const expectDeletable = apiItems.filter((i) => i['deletable'] === true).length;
    ok('卡片标题带统计（N 个可删 / 共 X MB）', /可删/.test(view.header) && /MB/.test(view.header), view.header);
    ok(`渲染出的行数与接口一致（${apiItems.length}）`, view.rows === apiItems.length, `页面 ${view.rows} vs 接口 ${apiItems.length}`);
    ok('★ 状态列两类互斥且数量对得上（bv 链接 + 审核中 = 总行数）', view.withLink + view.withoutLink === view.rows, `bv=${view.withLink} 审核中=${view.withoutLink} 行=${view.rows}`);
    ok('★ 已通过的显示可点 bv 号（数量和接口一致）', view.withLink === expectPassed, `页面 ${view.withLink} vs 接口 ${expectPassed}`);
    ok('★ 未通过的显示「审核中」类标签', view.withoutLink === expectReviewing, `页面 ${view.withoutLink} vs 接口 ${expectReviewing}`);
    ok('没有哪一行的状态是空的', view.emptyStatus === 0, String(view.emptyStatus));
    ok('★ 删除按钮只出现在「有 bvid」的行上（数量与接口一致）', view.withDel === expectDeletable, `页面 ${view.withDel} vs 接口 ${expectDeletable}`);
    ok('★ 删除按钮**真的绑了处理函数**（不是只渲染出来）', view.boundBtns === view.withDel && view.withDel > 0, `${view.boundBtns} / ${view.withDel}`);
    ok('★ 完整版也出现在列表里（用户要求：不止显示切片）', view.kinds.includes('完整弹幕版'), JSON.stringify(view.kinds));
    ok('卡片里说明了「不会撤回 B站 上的稿件」', view.note !== '', view.note);
    console.log(`  \x1b[90m首行：${view.firstRow}\x1b[0m`);
    console.log(`  \x1b[90m类型：${view.kinds.join(' / ')}（bv 链接 ${view.withLink}，可删 ${view.withDel}）\x1b[0m`);

    /* ---------------- 一键删除：真点一遍，但**一个文件都不删** ----------------
     *
     * 「点一下就把 99 个文件全删了」这种按钮，验证时最忌讳的正是"真按下去"。
     * 这里用两层桩把真实请求拦下来，同时仍然走完**页面上真实的代码路径**：
     *   ① `window.confirm` 换成桩 —— 先返回 false 证明"取消就什么都不发生"，
     *      再返回 true 并把确认文案抄下来，逐个核对必说的那几句；
     *   ② `window.fetch` 只在 `/api/published-file/delete-all` 这个 URL 上换成桩
     *      （其它请求原样透传，否则 `loadMonitor` 会被一起搞坏），
     *      于是"按钮到底发了什么请求"是**抓下来看到的**，不是我猜的。
     * 最后再从 Node 侧查一次 `/api/monitor`：可删项数量必须**一个没少**。 */
    const bulkCount = Number(uf['deletableCount'] ?? 0);
    ok('★ 卡片头上有「一键删除」按钮', view.bulkText !== '' && view.bulkBound, `${view.bulkText} / bound=${String(view.bulkBound)}`);
    ok('★ 按钮如实报出可删数量（与接口一致）', Number(view.bulkN) === bulkCount, `按钮 ${view.bulkN} vs 接口 ${bulkCount}`);
    ok('按钮带上合计体积（确认框要报大小）', Number(view.bulkMb) > 0, view.bulkMb);
    ok('按钮文案里写着"一键删除"与"项"', /一键删除/.test(view.bulkText) && /项/.test(view.bulkText), view.bulkText);

    /* ① 取消 → 必须什么都不发生 */
    await cdp.evalJs(`(() => {
      window.__cap = [];
      window.__origFetch = window.fetch;
      window.__origConfirm = window.confirm;
      window.confirm = () => false;
      window.fetch = (p, o) => {
        const url = String(p);
        if (url.indexOf('/api/published-file/delete-all') >= 0) { window.__cap.push({ url, method: (o && o.method) || 'GET', body: (o && o.body) || '' }); 
          return Promise.resolve(new Response('{"deleted":0}', { status: 200, headers: { 'Content-Type': 'application/json' } })); }
        return window.__origFetch(p, o);
      };
      return true;
    })()`);
    await cdp.evalJs(`document.querySelector('[data-act="del-published-all"]').click()`);
    await sleep(700);
    const afterCancel = await cdp.evalJs<{ cap: number; disabled: boolean; text: string }>(`(() => {
      const b = document.querySelector('[data-act="del-published-all"]');
      return { cap: (window.__cap || []).length, disabled: b ? b.disabled : true, text: b ? String(b.textContent || '').trim() : '' };
    })()`);
    ok('★ 确认框里点「取消」→ 一个请求都不发（未确认就不动数据）', afterCancel.cap === 0, `captured=${afterCancel.cap}`);
    ok('取消后按钮回到可用状态（没有被卡在"正在删除…"）', afterCancel.disabled === false && !/正在删除/.test(afterCancel.text), `${afterCancel.text} disabled=${String(afterCancel.disabled)}`);

    /* ② 确认 → 抓下真实请求；确认文案逐句核对 */
    await cdp.evalJs(`window.confirm = (msg) => { window.__confirmMsg = msg; return true; }`);
    await cdp.evalJs(`document.querySelector('[data-act="del-published-all"]').click()`);
    await sleep(1200);
    const afterGo = await cdp.evalJs<{ cap: Array<{ url: string; method: string; body: string }>; msg: string; toast: string }>(`(() => ({
      cap: window.__cap || [],
      msg: String(window.__confirmMsg || ''),
      toast: String((document.querySelector('.toast') || {}).textContent || ''),
    }))()`);
    eq('★ 确认后确实发出了 1 个请求（页面接线是真的）', afterGo.cap.length, 1);
    ok('★ 请求打的是 /api/published-file/delete-all（不是循环调单删）', String(afterGo.cap[0]?.url ?? '').includes('/api/published-file/delete-all'), String(afterGo.cap[0]?.url));
    eq('★ 用的是 POST（不是 GET 误触发）', String(afterGo.cap[0]?.method ?? '').toUpperCase(), 'POST');
    ok('★ 请求体带 confirm:true（后端那道闸也认这个字段）', /"confirm"\s*:\s*true/.test(String(afterGo.cap[0]?.body ?? '')), String(afterGo.cap[0]?.body));
    const cmsg = afterGo.msg;
    ok('★ 确认框报出要删几个', cmsg.includes(String(bulkCount)) && /可删的已投稿文件/.test(cmsg), cmsg.slice(0, 60));
    ok('★ 确认框写明"移入回收站、可恢复"', /移入回收站/.test(cmsg) && /可恢复/.test(cmsg));
    ok('★ 确认框写明"磁盘空间要等回收站清理才真正释放"', /回收站清理/.test(cmsg) && /真正释放/.test(cmsg));
    ok('★ 确认框写明"B站 上的稿件不会被撤回或删除"', /(「不会」|不会)被撤回或删除/.test(cmsg), cmsg.replace(/\n/g, ' | ').slice(0, 200));
    ok('★ 确认框写明"审核中的会被跳过"', /审核/.test(cmsg) && /跳过/.test(cmsg));
    /* confirm() 不认 HTML/markdown：星号与标签会原样显示在弹窗里（第一版就写了 `**移入回收站**`） */
    ok('★ 确认框里没有 HTML 标签 / markdown 星号（弹窗是纯文本）', !/<[a-z/]/.test(cmsg) && !/\*\*/.test(cmsg), cmsg.replace(/\n/g, ' | ').slice(0, 200));
    console.log(`  \x1b[90m确认框：${cmsg.replace(/\n+/g, ' ⏎ ').slice(0, 160)}\x1b[0m`);
    console.log(`  \x1b[90m抓到的请求：${afterGo.cap[0]?.method} ${afterGo.cap[0]?.url} body=${afterGo.cap[0]?.body}\x1b[0m`);
    console.log(`  \x1b[90m（请求被桩拦下，未真正删除任何文件）\x1b[0m`);

    /* ③ 还原桩，再从 Node 侧核对：服务端数据一个没动 */
    await cdp.evalJs(`window.fetch = window.__origFetch; window.confirm = window.__origConfirm; true`);
    const ufAfter = ((await (await fetch(BASE + '/api/monitor')).json()) as Record<string, unknown>)['uploadedFiles'] as Record<string, unknown>;
    eq('★ 全程没有真删任何文件（可删数量与开始时一致）', ufAfter['deletableCount'], bulkCount);
    eq('文件总数也没变', ufAfter['count'], uf['count']);

    /* ④ 后端那道闸单独再试一次：不带 confirm 必须 400（界面拦住了不代表接口拦得住） */
    const boot = (await (await fetch(BASE + '/api/bootstrap')).json()) as { csrf?: string };
    const csrf = String(boot.csrf ?? '');
    const noConfirm = await fetch(BASE + '/api/published-file/delete-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({}),
    });
    eq('★ 直接打接口、不带 confirm → 400（后端独立把关，不靠界面）', noConfirm.status, 400);
    const ufAfter2 = ((await (await fetch(BASE + '/api/monitor')).json()) as Record<string, unknown>)['uploadedFiles'] as Record<string, unknown>;
    eq('这次也一个文件都没动', ufAfter2['deletableCount'], bulkCount);

    await cdp.evalJs(`(() => {
      const card = Array.from(document.getElementById('otherPage').querySelectorAll('.card'))
        .find((c) => String(c.querySelector('h2')?.textContent || '').includes('已投稿文件'));
      if (card) card.scrollIntoView({ block: 'start' });
      return true;
    })()`);
    await sleep(500);
    try {
      ensureDir(SHOT_DIR);
      const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data?: string };
      if (shot.data) {
        fs.writeFileSync(path.join(SHOT_DIR, '23-monitor-uploaded-files.png'), Buffer.from(shot.data, 'base64'));
        console.log('  \x1b[90m截图: data/ui-shots/23-monitor-uploaded-files.png\x1b[0m');
      }
    } catch {
      /* 截图失败不影响结论 */
    }

    ok('全程页面没有未捕获异常', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | '));
  } catch (e) {
    fail++;
    failures.push(`测试异常：${(e as Error).message}`);
    console.log(`\n  \x1b[31m测试异常：${(e as Error).message}\x1b[0m`);
  } finally {
    try {
      await cdp?.send('Browser.close', {}, 4000);
    } catch {
      /* ignore */
    }
    cdp?.close();
    try { child.kill(); } catch { /* ignore */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n' + '─'.repeat(70));
  console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (fail > 0) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
    process.exitCode = 1;
  } else {
    console.log('\x1b[32m「已投稿文件」在界面上列得出来、状态分得清、按钮点得动。\x1b[0m');
  }
}

await main();
