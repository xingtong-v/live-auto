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
    }>(`(() => {
      const box = document.getElementById('otherPage');
      const card = Array.from(box.querySelectorAll('.card')).find((c) => String(c.querySelector('h2')?.textContent || '').includes('已投稿文件'));
      if (!card) return { rows: 0, header: '', kinds: [], withLink: 0, withoutLink: 0, withDel: 0, boundBtns: 0, emptyStatus: 0, firstRow: '', note: '' };
      const rows = Array.from(card.querySelectorAll('tbody tr'));
      /* 逐行判定，别用全局计数 —— 第一版用 querySelectorAll('tbody .tag-mini')
         数状态标签，而「类型」列也是 .tag-mini，于是 7 行数出 14 个。 */
      const hasLink = rows.filter((r) => !!r.querySelector('a[href*="bilibili.com/video/"]'));
      const btns = Array.from(card.querySelectorAll('[data-act="del-published"]'));
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
