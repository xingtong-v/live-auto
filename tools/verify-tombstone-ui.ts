/**
 * 墓碑界面的**真浏览器**验证（Edge headless + CDP）。
 *
 * ## 为什么单独一个工具，而不是塞进 `tools/ui-e2e.ts`
 *
 * `ui-e2e.ts` 里前面的段落依赖**用户的真实数据**（录播清单、夹具切片），一旦某个前提变了
 * 就会中途抛异常，把后面的用例一起带走 —— 实测就是这样：录播清单变化时第 11 段红掉，
 * 第 12/13 段根本没执行。而墓碑是「防止在 B站 上产生重复稿件」的最后一道防线，
 * 它值得一个**随时能单独跑、不依赖任何外部数据**的用例。
 *
 * ## 验的是什么
 *
 * 后台语义（`test/fingerprint-tombstone.ts`，64 项）已经证明「墓碑能拦住投稿」。
 * 这里证明的是**用户能不能看见它、能不能推翻它** —— 只看后台的话，
 * 一个被墓碑拦下的切片在界面上和「没投出去」毫无区别，用户只会以为系统坏了。
 *
 * 夹具（全部 `tombui-` 前缀，跑完精确清理，不碰任何真实场次）：
 *   ① `tombui-old-*`：切片标 PUBLISHED + 登记指纹 → `deleteTask()` → 立碑；
 *   ② `tombui-new-*`：**同一录制源、同一区间、同一标题**（指纹必然相同），
 *      切片标 `blockedByTombstone` —— 这就是「任务被删后素材被重新导入重跑」的真实状态。
 *
 * 运行（需要服务已在 127.0.0.1:3000 上跑）：
 *   node --experimental-strip-types tools/verify-tombstone-ui.ts
 *   加 --headed 可以看着浏览器跑。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger, clipFingerprint } from '../src/ledger.ts';
import { ROOT_DIR, ensureDir, nowIso, sleep } from '../src/util.ts';

const BASE = 'http://127.0.0.1:3000';
const PORT = 9334; // 与 ui-e2e 的 9333 错开，两个工具可以同时跑
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

/* ============================================================================
 * 极简 CDP 客户端（只做这个用例需要的事）
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
      // 未捕获异常一定说明页面坏了 —— 收集起来最后统一断言
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
          url?: string;
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

  /** 在页面里求值；返回值经 JSON 往返（不要返回 DOM 节点） */
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

/* ============================================================================
 * 夹具
 * ========================================================================== */

const STAMP = Date.now();
const OLD_ID = `tombui-old-${STAMP}`;
const NEW_ID = `tombui-new-${STAMP}`;
const SRC = `tombui-src-${STAMP}`;
const T_START = 300;
const T_END = 366;
const T_TITLE = '墓碑界面用例：这段内容以前投过';
const OLD_BVID = 'BV1tombui0001';
const FP = clipFingerprint({ sourceVideoId: SRC, start: T_START, end: T_END, title: T_TITLE });

const ledger = new Ledger();

function mkTask(id: string, title: string, extraClip: Record<string, unknown>): void {
  const now = nowIso();
  ledger.createTask({
    id,
    roomId: '12345678',
    platform: 'Bilibili',
    recordingId: SRC,
    title,
    manual: true,
    status: 'CLIPPED',
    stage: 'CLIPPED',
    source: { segments: [], totalDuration: 1200, rawFiles: [], fullVideoHasDanmaku: false },
    clips: [
      {
        index: 0,
        start: T_START,
        end: T_END,
        title: T_TITLE,
        desc: '墓碑界面用例',
        tags: ['直播切片'],
        category: '游戏/单机游戏',
        score: 8,
        reason: '墓碑界面用例夹具',
        selected: true,
        degraded: false,
        ...extraClip,
      },
    ],
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: now },
    createdAt: now,
    updatedAt: now,
  } as never);
}

function cleanup(): void {
  try {
    for (const t of ledger.listTombstones()) {
      if (t.taskId.startsWith('tombui-')) ledger.releaseTombstone(t.fingerprint, { note: 'verify-tombstone-ui 收尾清理' });
    }
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(path.join(ROOT_DIR, 'data', 'tasks', OLD_ID), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT_DIR, 'data', 'tasks', NEW_ID), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  for (const id of [OLD_ID, NEW_ID]) {
    try {
      ledger.deleteTask(id);
    } catch {
      /* ignore */
    }
  }
}

/* ============================================================================
 * 主流程
 * ========================================================================== */

async function main(): Promise<void> {
  console.log('\x1b[1m墓碑界面验证\x1b[0m（Edge headless + CDP，真实点击）');
  console.log('─'.repeat(70));

  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error(`服务返回 ${h.status}`);
  } catch (e) {
    console.log(`  \x1b[31m服务不可达：${(e as Error).message}\x1b[0m`);
    console.log('  请先启动：.\\run.cmd');
    process.exit(1);
  }
  ok('服务在线', true);

  /* ---- 造夹具：老任务投过并删掉 → 立碑；新任务被同一个指纹拦下 ---- */
  try {
    mkTask(OLD_ID, '【墓碑用例】老任务（已删，指纹退役）', { status: 'PUBLISHED', bvid: OLD_BVID });
    ledger.registerFingerprint(FP, { taskId: OLD_ID, clipIndex: 0, bvid: OLD_BVID });
    const del = ledger.deleteTask(OLD_ID);
    ok('删除已投稿任务 → 指纹转为墓碑（不是丢掉）', del.tombstonedFingerprints === 1, JSON.stringify(del));
    ok('墓碑已落账', ledger.findTombstone(FP) !== undefined);

    mkTask(NEW_ID, '【墓碑用例】新任务（被墓碑拦下）', {
      status: 'PUBLISHED',
      bvid: OLD_BVID,
      fingerprint: FP,
      blockedByTombstone: FP,
    });
    ok('已造出被墓碑拦下的新任务', ledger.getClip(NEW_ID, 0)?.blockedByTombstone === FP);
  } catch (e) {
    console.log(`  \x1b[31m造夹具失败：${(e as Error).message}\x1b[0m`);
    cleanup();
    process.exit(1);
  }

  /* ---- 启动 Edge ---- */
  const edge = [
    `${process.env['ProgramFiles(x86)'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['LOCALAPPDATA'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].find((p) => p && fs.existsSync(p));
  if (!edge) {
    console.log('  \x1b[31m找不到 Edge\x1b[0m');
    cleanup();
    process.exit(1);
  }

  const userDataDir = path.join(os.tmpdir(), `live-auto-tombui-${STAMP}`);
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
    ok('Edge 调试端口就绪、CDP 会话建立', true);

    await cdp.send('Page.navigate', { url: BASE + '/' });
    const deadline = Date.now() + 20000;
    for (;;) {
      const ready = await cdp.evalJs<boolean>('!!document.querySelector("#taskList")').catch(() => false);
      if (ready) break;
      if (Date.now() > deadline) throw new Error('页面加载超时');
      await sleep(300);
    }
    ok('页面加载完成', true);

    /* ---- 打开被墓碑拦下的那个任务 ---- */
    const appearDeadline = Date.now() + 20000;
    let appeared = false;
    for (;;) {
      appeared = await cdp
        .evalJs<boolean>(`!!document.querySelector('#taskList .task[data-id="${NEW_ID}"]')`)
        .catch(() => false);
      if (appeared) break;
      // 列表可能还在首次加载：主动触发一次刷新
      await cdp.evalJs('typeof refreshAll === "function" ? refreshAll(true) : location.reload()').catch(() => undefined);
      if (Date.now() > appearDeadline) break;
      await sleep(500);
    }
    ok('任务列表出现了被墓碑拦下的任务', appeared);
    if (!appeared) throw new Error('任务卡片没渲染出来');

    await cdp.evalJs(`document.querySelector('#taskList .task[data-id="${NEW_ID}"]').click()`);
    const clipDeadline = Date.now() + 15000;
    for (;;) {
      const has = await cdp.evalJs<boolean>('!!document.querySelector("#detail .clip[data-clip=\\"0\\"]")').catch(() => false);
      if (has) break;
      if (Date.now() > clipDeadline) throw new Error('详情页切片卡片没渲染出来');
      await sleep(300);
    }

    /* ---- 1. 卡片上必须说清「为什么没投」，并且不是"失败" ---- */
    const ui = await cdp.evalJs<{
      pill: string;
      note: string;
      hasBtn: boolean;
      btnVisible: boolean;
      cardClass: string;
      hasRecut: boolean;
      bodyText: string;
    }>(`(() => {
      const card = document.querySelector('#detail .clip[data-clip="0"]');
      if (!card) return { pill: '', note: '', hasBtn: false, btnVisible: false, cardClass: '', hasRecut: false, bodyText: '' };
      const pill = card.querySelector('.pill.tomb');
      const note = card.querySelector('.tomb-note');
      const btn = card.querySelector('[data-act="release-tomb"]');
      let btnVisible = false;
      if (btn) { const r = btn.getBoundingClientRect(); btnVisible = r.width > 0 && r.height > 0; }
      return {
        pill: pill ? String(pill.textContent) : '',
        note: note ? String(note.textContent).replace(/\\s+/g, ' ') : '',
        hasBtn: !!btn,
        btnVisible,
        cardClass: String(card.className),
        hasRecut: !!card.querySelector('[data-act="recut"]'),
        bodyText: String(document.getElementById('detail').innerText).replace(/\\s+/g, ' '),
      };
    })()`);
    ok('切片卡片上有「墓碑拦截」徽标', /墓碑拦截/.test(ui.pill), ui.pill || '(没有徽标)');
    ok('卡片进入墓碑态（灰紫，区别于"失败"的红）', /(^|\s)tomb(\s|$)/.test(ui.cardClass), ui.cardClass);
    ok('正文说明了「这一片没有投稿（不是失败）」', /没有投稿/.test(ui.note), ui.note.slice(0, 160) || '(没有说明块)');
    ok('说明里给出了旧稿件的 bvid', ui.note.includes(OLD_BVID), ui.note.slice(0, 220));
    ok('说明里带上了原任务 id（知道是哪一场被删的）', ui.note.includes(OLD_ID), ui.note.slice(0, 240));
    ok('提供「解除墓碑」按钮且真实可见', ui.hasBtn && ui.btnVisible, `hasBtn=${ui.hasBtn} visible=${ui.btnVisible}`);
    ok('被拦下的卡片不显示「重新切片」（重切只会再撞一次墓碑）', !ui.hasRecut);
    await shot(cdp, '20-tombstone-blocked');

    /* ---- 2. 健康面板：墓碑 KPI + 清单表（用户平时唯一的入口） ---- */
    await cdp.evalJs('document.querySelector(\'#tabs .tab[data-view="health"]\').click()');
    let healthHtml = '';
    const healthDeadline = Date.now() + 15000;
    for (;;) {
      healthHtml = await cdp.evalJs<string>('String(document.getElementById("otherPage").innerHTML)').catch(() => '');
      if (/墓碑/.test(healthHtml) && new RegExp(OLD_ID).test(healthHtml)) break;
      if (Date.now() > healthDeadline) break;
      await sleep(400);
    }
    ok('健康面板有「墓碑」KPI', /墓碑/.test(healthHtml));
    ok('健康面板的墓碑清单里列出了这一条（含原任务 id）', healthHtml.includes(OLD_ID));
    ok('清单里有「解除」按钮', /data-act="releasetomb"/.test(healthHtml));
    await shot(cdp, '21-tombstone-health-panel');

    /* ---- 3. 点解除：确认框要说清后果，并且台账里的墓碑要真的没了 ---- */
    await cdp.evalJs('document.querySelector(\'#tabs .tab[data-view="tasks"]\').click()');
    await cdp.evalJs(`document.querySelector('#taskList .task[data-id="${NEW_ID}"]').click()`);
    await sleep(800);
    await cdp.evalJs(`window.__confirmText = ''; window.confirm = (m) => { window.__confirmText = String(m); return true; }`);
    const clicked = await cdp.evalJs<boolean>(
      `(() => { const b = document.querySelector('#detail .clip[data-clip="0"] [data-act="release-tomb"]'); if (!b) return false; b.click(); return true; })()`,
    );
    ok('点到了「解除墓碑」按钮', clicked);

    let released = false;
    const relDeadline = Date.now() + 15000;
    for (;;) {
      released = ledger.findTombstone(FP) === undefined;
      if (released) break;
      if (Date.now() > relDeadline) break;
      await sleep(400);
    }
    const confirmText = await cdp.evalJs<string>('window.__confirmText');
    ok('确认框点明了「允许同一内容再投一次」', /再次投稿|再投一次|重新投稿/.test(confirmText), confirmText.replace(/\n/g, ' ').slice(0, 200) || '(没有弹确认框)');
    ok('确认框给出了旧 bvid，要求先去核对', confirmText.includes(OLD_BVID), confirmText.replace(/\n/g, ' ').slice(0, 240));
    ok('★ 点完之后台账里的墓碑真的没了（不是只把界面藏起来）', released);

    let noteGone = false;
    const goneDeadline = Date.now() + 15000;
    for (;;) {
      noteGone = (await cdp.evalJs<boolean>('!document.querySelector("#detail .clip[data-clip=\\"0\\"] .tomb-note")').catch(() => false)) === true;
      if (noteGone) break;
      if (Date.now() > goneDeadline) break;
      await sleep(400);
    }
    ok('解除后卡片上的墓碑说明消失（界面跟着状态走）', noteGone);
    await shot(cdp, '22-tombstone-released');

    ok('全程页面没有未捕获异常', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | '));
  } catch (e) {
    fail++;
    failures.push(`测试异常：${(e as Error).message}`);
    console.log(`\n  \x1b[31m测试异常：${(e as Error).message}\x1b[0m`);
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
    cleanup();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log('\n' + '─'.repeat(70));
  console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (fail > 0) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
    process.exitCode = 1;
  } else {
    console.log('\x1b[32m墓碑在界面上看得见、说得清、推得翻。\x1b[0m');
  }
}

await main();
