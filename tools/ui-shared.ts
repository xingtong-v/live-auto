/**
 * 浏览器验收的**共享件**（2026-10-14）。
 *
 * ## 为什么
 * 此前 9 个 `verify-*-ui.ts` / `ui-e2e.ts` 各自复制了同一套东西：
 * `class Cdp`（8 份）、`function ok/eq`（每个一份）、Edge 探测 + spawn + attach + kill（每个一份）、
 * 汇总与退出码（每个一份）—— 合计约 4790 行里 ~700 行是同一段管道。
 * 后果不是"不好看"，而是**修一处要改十处**：例如"等元素再点、别拿固定 sleep 赌渲染"那次的修复、
 * 以及 2026-10-14 加的「切页签前复位页面筛选状态」（防跨段假红）—— 都只落在了一个脚本里。
 *
 * ## 用法（脚本只改开头与结尾，断言体一字不动）
 * ```ts
 * import { launchBrowser, section, report, sleep } from './ui-shared.ts';
 * const BASE = 'http://127.0.0.1:3000';
 * const { cdp, close } = await launchBrowser({ port: 9336, headed: process.argv.includes('--headed') });
 * try {
 *   await cdp.navigate(BASE + '/');
 *   ok('…', …); eq('…', a, b);              // ok/eq 从本模块 import
 * } finally { await close(); }
 * await report();                            // 打印 PASS/FAIL 并设置退出码
 * ```
 *
 * ## 与原实现的三处刻意差异
 *   1. **端口由调用方给**（原脚本各占 9333/9335/9336… 是为了"同时跑多个不打架"）。共享后仍保留这个能力，
 *      但不再强迫每个脚本记一个号；
 *   2. `cdp.errors`（未捕获异常收集）**内置**：原来只有部分脚本自己挂 `Runtime.exceptionThrown`，
 *      于是"页面没有未捕获异常"这条断言只在部分页面被守住 —— 现在人人都有；
 *   3. `close()` 同时杀浏览器、删临时 user-data-dir、清截图目录之外的痕迹（与原脚本的 finally 等价）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ===================== 断言与汇总（原每个脚本各写一份） ===================== */
let pass = 0;
let fail = 0;
const failures: string[] = [];

export function ok(name: string, cond: unknown, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(detail ? `${name} :: ${detail}` : name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

export function eq<T>(name: string, actual: T, expected: T, detail?: string): void {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), detail ?? `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

export function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/** 打印汇总并设置退出码（原脚本各自的结尾块） */
export async function report(): Promise<void> {
  console.log('\n' + '─'.repeat(74));
  console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
  }
  process.exitCode = fail === 0 ? 0 : 1;
  await sleep(50);
}

/* ===================== 极简 CDP（原 8 份各写一遍） ===================== */
export class Cdp {
  private seq = 0;
  private pending = new Map<number, (v: unknown) => void>();
  /** ★ 页面未捕获异常（原来只有部分脚本收集；现在内置，人人都有这条护栏） */
  readonly errors: string[] = [];

  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String((ev as MessageEvent).data)) as {
        id?: number;
        method?: string;
        params?: { exceptionDetails?: { text?: string; exception?: { description?: string } } };
        result?: unknown;
      };
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails;
        this.errors.push(String(d?.exception?.description ?? d?.text ?? 'unknown').slice(0, 300));
      }
      if (msg.id !== undefined) {
        const fn = this.pending.get(msg.id);
        if (fn) {
          this.pending.delete(msg.id);
          fn(msg.result);
        }
      }
    };
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<Record<string, unknown>> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, (v) => {
        clearTimeout(timer);
        resolve((v ?? {}) as Record<string, unknown>);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 求值；失败返回 undefined（调用方自己判断），不抛 */
  /* 返回类型刻意是 T（不是 T | undefined）：与原实现一致 —— 9 个脚本的既有代码都按 T 用，
     收紧类型会连带 9 个文件报错（运行时仍可能是 undefined，调用方自己 catch） */
  async evalJs<T = unknown>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).catch(() => ({}));
    return (r as { result?: { value?: T } }).result?.value as T;
  }

  /** 等元素出现（**等元素再点，别拿固定 sleep 赌渲染** —— 这条是踩出来的） */
  async waitFor(selector: string, timeoutMs = 20000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evalJs<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`).catch(() => false)) return true;
      await sleep(200);
    }
    return false;
  }

  /** 导航 + 等骨架（#tabs .tab 是所有页面共有的锚点） */
  async navigate(url: string, readySelector = '#tabs .tab'): Promise<void> {
    await this.send('Page.navigate', { url });
    await this.waitFor(readySelector);
  }

  async shot(file: string): Promise<string> {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(String((r as { data?: string }).data ?? ''), 'base64'));
    return file;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  /** 连到已开着调试端口的浏览器（也可直接连用户自己的 Edge/Chrome） */
  static async attach(port: number, timeoutMs = 20000): Promise<Cdp> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        const page = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise<void>((res, rej) => {
            ws.addEventListener('open', () => res(), { once: true });
            ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
          });
          const c = new Cdp(ws);
          await c.send('Runtime.enable');
          await c.send('Page.enable');
          return c;
        }
      } catch {
        /* 端口还没起来 */
      }
      if (Date.now() > deadline) throw new Error(`等不到调试端口 ${port}`);
      await sleep(300);
    }
  }
}

/* ===================== 浏览器生命周期（原每个脚本各写一遍） ===================== */
/** 找 Edge（与原脚本同一条探测链；找不到返回 undefined） */
export function findEdge(): string | undefined {
  return [
    `${process.env['ProgramFiles(x86)'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['LOCALAPPDATA'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].find((p) => Boolean(p) && fs.existsSync(p));
}

/**
 * **用真实鼠标事件**点一个元素（CDP `Input.dispatchMouseEvent`，按元素中心坐标）。
 *
 * ⚠️ 为什么不能图省事写 `el.click()`（2026-10-13 实测教训）：
 * 本项目界面里的 `.switch` 开关**不响应程序化 click** —— 用 `el.click()` 点
 * `#c_funasrTimestamps`（既有开关）、`#c_incrementalEnabled`、`#c_funasrBf16` 三个，
 * class 与文案**一个都不变**，看起来像"功能坏了"；换成真实鼠标事件后立刻正常。
 * 也就是说：**用 `click()` 做 UI 验收会得出假红/假绿**，这类控件必须发真事件。
 *
 * 返回 true 表示"元素找到并发了点击"；是否真的生效要由调用方再读一次状态。
 */
export async function clickReal(cdp: Cdp, selector: string): Promise<boolean> {
  /* ⚠️ 三个坑（2026-10-13 实测，全都表现为"点了没反应"）：
     ① 元素常在折线以下（设置面板很长）⇒ 直接按 rect 点会点空；
     ② `scrollIntoView` 可能是**平滑滚动**，紧接着读 rect 拿到的是**旧坐标**（本函数第一版就栽在这：
        rect.y 读到 1613/1836，`document.elementFromPoint` 返回 null）⇒ 必须等滚动结束**再读一次**；
     ③ 本项目 `.switch` 不响应程序化 `el.click()`（既有开关也一样）⇒ 必须发真实鼠标事件。 */
  const scrolled = await cdp.evalJs<boolean>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    return true;
  })()`);
  if (!scrolled) return false;
  await sleep(450); // 等平滑滚动走完（②）
  const rect = await cdp.evalJs<{ x: number; y: number; hit: boolean } | null>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: hit === el || (hit !== null && el.contains(hit)) };
  })()`);
  if (!rect) return false;
  /* ④ 兜底：`scrollIntoView` 未必能把这个面板滚进视口（实测两个开关的落点校验都是 false，
     连既有的 `#c_funasrTimestamps` 也一样 —— 说明是"元素在视口外"而不是"功能坏了"）。
     这时直接把**视口撑高**到元素下方，比继续和滚动容器较劲可靠得多。 */
  let hit = rect.hit;
  let x = rect.x;
  let y = rect.y;
  if (!hit) {
    const h = Math.min(4000, Math.max(1400, y + 300));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1700, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(350);
    const again = await cdp.evalJs<{ x: number; y: number; hit: boolean } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const h = document.elementFromPoint(cx, cy);
      return { x: cx, y: cy, hit: h === el || (h !== null && el.contains(h)) };
    })()`);
    if (again) {
      x = again.x;
      y = again.y;
      hit = again.hit;
    }
  }
  const base = { x, y, button: 'left' as const, clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
  /* 落点自检：坐标上不是这个元素（被遮挡/仍在视口外）时，调用方应当知道"这次点击可能没生效" */
  return hit;
}

/**
 * 起一个 headless（或 `headed:true` 可见）Edge 并连上它。
 * 返回 `{ cdp, close }`；`close()` 会杀浏览器并清理临时 user-data-dir。
 */
export async function launchBrowser(opts: { port: number; headed?: boolean; windowSize?: string }): Promise<{ cdp: Cdp; close: () => Promise<void>; pid?: number }> {
  const edge = findEdge();
  if (!edge) throw new Error('找不到 Edge（原脚本也依赖它；装了 Chrome 的话可自行传路径）');
  const userDataDir = path.join(os.tmpdir(), `live-auto-ui-${Date.now()}`);
  const child: ChildProcess = spawn(
    edge,
    [
      `--remote-debugging-port=${opts.port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--window-size=${opts.windowSize ?? '1700,1500'}`,
      ...(opts.headed ? [] : ['--headless=new']),
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );
  const cdp = await Cdp.attach(opts.port).catch(async (e: unknown) => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    throw e;
  });
  return {
    cdp,
    pid: child.pid,
    close: async () => {
      cdp.close();
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      await sleep(300);
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/** 截图目录（各脚本原来各写一套路径） */
export function shotPath(name: string): string {
  return path.join(process.cwd(), 'data', 'verify-shots', `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
}
