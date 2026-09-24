/**
 * UI 精确诊断：把页面跑起来后，逐项检查「为什么点不动」。
 * 用法：node tools/ui-diag.ts
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT_DIR, sleep, ensureDir } from '../src/util.ts';

const BASE = 'http://127.0.0.1:3000';
const PORT = 9335;

async function main(): Promise<void> {
  const edge = [
    `${process.env['ProgramFiles(x86)'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['LOCALAPPDATA'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].find((p) => p && fs.existsSync(p));
  if (!edge) throw new Error('找不到 Edge');

  const udd = path.join(os.tmpdir(), `la-diag-${Date.now()}`);
  const child = spawn(
    edge,
    [`--remote-debugging-port=${PORT}`, `--user-data-dir=${udd}`, '--headless=new', '--no-first-run', '--window-size=1600,1000', 'about:blank'],
    { stdio: 'ignore' },
  );

  const cleanup = (): void => {
    try { child.kill(); } catch { /* ignore */ }
    try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  try {
    let wsUrl: string | undefined;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
        if (wsUrl) break;
      } catch { /* ignore */ }
    }
    if (!wsUrl) throw new Error('调试端口未就绪');

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true });
      ws.addEventListener('error', () => rej(new Error('ws 失败')), { once: true });
    });

    let seq = 0;
    const pending = new Map<number, (v: unknown) => void>();
    const logs: string[] = [];
    ws.addEventListener('message', (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data)) as {
        id?: number;
        method?: string;
        /** CDP 命令的返回值（形如 { result: { result: {...} } }） */
        result?: unknown;
        /** CDP 命令级的错误 */
        error?: unknown;
        params?: {
          type?: string;
          args?: Array<{ value?: unknown }>;
          exceptionDetails?: { exception?: { description?: string } };
        };
      };
      if (m.id !== undefined) { pending.get(m.id)?.(m.result ?? m.error); pending.delete(m.id); return; }
      if (m.method === 'Runtime.consoleAPICalled') {
        logs.push(`[${m.params?.type}] ` + (m.params?.args ?? []).map((a) => String(a.value ?? '')).join(' '));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        logs.push('[exception] ' + (m.params?.exceptionDetails?.exception?.description ?? ''));
      }
    });
    const send = <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
      new Promise<T>((res) => { const id = ++seq; pending.set(id, (v) => res(v as T)); ws.send(JSON.stringify({ id, method, params })); });
    const evalJs = async <T = unknown>(expr: string): Promise<T> => {
      const r = await send<{ result?: { value?: T }; exceptionDetails?: { exception?: { description?: string } } }>('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'JS 异常');
      return r.result?.value as T;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(4500);

    console.log('\x1b[1m1) 页面控制台日志\x1b[0m');
    for (const l of logs.slice(0, 20)) console.log('   ' + l.slice(0, 160));

    console.log('\n\x1b[1m2) 关键元素是否存在\x1b[0m');
    const els = await evalJs<Record<string, boolean>>(`(() => {
      const ids = ['taskList','detail','schedule','btnSetting','btnRepairStuck','btnCheckNow','btnImport','statusFilters','viewTasks','tabs'];
      const o = {};
      for (const id of ids) o[id] = !!document.getElementById(id);
      return o;
    })()`);
    for (const [k, v] of Object.entries(els)) console.log(`   ${v ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} #${k}`);

    console.log('\n\x1b[1m3) 全局函数与状态\x1b[0m');
    const fns = await evalJs<Record<string, string>>(`(() => ({
      openTaskMenu: typeof openTaskMenu,
      openDeleteDialog: typeof openDeleteDialog,
      handleTaskOp: typeof handleTaskOp,
      renderTaskList: typeof renderTaskList,
      renderDetail: typeof renderDetail,
      closeTaskMenu: typeof closeTaskMenu,
      stateTasks: typeof state !== 'undefined' ? String(state.tasks.length) : 'n/a',
      activeId: typeof state !== 'undefined' ? String(state.activeId) : 'n/a',
      detailNull: typeof state !== 'undefined' ? String(state.detail === null) : 'n/a',
    }))()`);
    for (const [k, v] of Object.entries(fns)) console.log(`   ${k} = ${v}`);

    console.log('\n\x1b[1m4) 事件是否绑定到「⋯」按钮\x1b[0m');
    const bind = await evalJs<{ hasBtn: boolean; hasOnclick: boolean; rect: { x: number; y: number; w: number; h: number } | null; overlap: string }>(`(() => {
      const b = document.querySelector('#taskList .task .more');
      if (!b) return { hasBtn: false, hasOnclick: false, rect: null, overlap: '' };
      const r = b.getBoundingClientRect();
      // 检查该点是否真的命中这个按钮（可能被别的元素盖住）
      const hit = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
      return {
        hasBtn: true,
        hasOnclick: typeof b.onclick === 'function',
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        overlap: hit ? (hit.className || hit.tagName) : 'null',
      };
    })()`);
    console.log(`   按钮存在=${bind.hasBtn}  onclick已绑定=${bind.hasOnclick}`);
    console.log(`   位置=${JSON.stringify(bind.rect)}`);
    console.log(`   该点实际命中的元素: ${bind.overlap}  ${bind.overlap.includes('more') ? '\x1b[32m(就是按钮本身 ✓)\x1b[0m' : '\x1b[31m(被别的元素盖住了 ✗)\x1b[0m'}`);

    console.log('\n\x1b[1m5) 直接调用 openTaskMenu 测试\x1b[0m');
    try {
      const r = await evalJs<string>(`(() => {
        const el = document.querySelector('#taskList .task .more');
        const id = el ? el.dataset.more : (state.tasks[0] ? state.tasks[0].id : null);
        if (!id) return 'no-task';
        openTaskMenu(id, el || document.querySelector('#taskList .task'));
        const m = document.getElementById('taskMenu');
        if (!m) return 'menu-not-created';
        return 'created: ' + Array.from(m.querySelectorAll('button[data-op]')).map(b => b.dataset.op).join(',');
      })()`);
      console.log(`   结果: ${r}`);
      if (r.startsWith('created')) console.log('   \x1b[32m✓ 函数本身正常 → 问题在事件绑定\x1b[0m');
      else console.log('   \x1b[31m✗ 函数本身有问题\x1b[0m');
    } catch (e) {
      console.log(`   \x1b[31m调用抛错: ${(e as Error).message.slice(0, 200)}\x1b[0m`);
    }

    console.log('\n\x1b[1m6) 详情区为什么停在「正在加载…」\x1b[0m');
    const detail = await evalJs<{ text: string; len: number }>(`(() => {
      const d = document.getElementById('detail');
      return { text: d ? String(d.innerText).slice(0, 60) : 'no-element', len: d ? d.innerHTML.length : 0 };
    })()`);
    console.log(`   #detail 内容: "${detail.text}"  (innerHTML ${detail.len} 字符)`);

    console.log('\n\x1b[1m7) 列表项结构（检查 title 遮挡）\x1b[0m');
    const card = await evalJs<string>(`(() => {
      const el = document.querySelector('#taskList .task');
      if (!el) return 'no-card';
      const name = el.querySelector('.name');
      const more = el.querySelector('.more');
      const nr = name ? name.getBoundingClientRect() : null;
      const mr = more ? more.getBoundingClientRect() : null;
      const overlap = (nr && mr) ? !(mr.left >= nr.right || mr.right <= nr.left || mr.top >= nr.bottom || mr.bottom <= nr.top) : null;
      return JSON.stringify({ nameRect: nr ? {x:Math.round(nr.x),y:Math.round(nr.y),w:Math.round(nr.width),h:Math.round(nr.height)} : null,
        moreRect: mr ? {x:Math.round(mr.x),y:Math.round(mr.y),w:Math.round(mr.width),h:Math.round(mr.height)} : null,
        textOverlapsButton: overlap });
    })()`);
    console.log('   ' + card);

    console.log('\n\x1b[1m8) 截图\x1b[0m');
    ensureDir(path.join(ROOT_DIR, 'data', 'ui-shots'));
    const shot = await send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    const f = path.join(ROOT_DIR, 'data', 'ui-shots', 'diag.png');
    fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
    console.log('   ' + path.relative(ROOT_DIR, f));

    ws.close();
  } finally {
    cleanup();
  }
}

main().catch((e) => {
  console.error('诊断失败：', (e as Error).message);
  process.exit(1);
});
