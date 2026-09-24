/**
 * 界面级端到端测试（Edge headless + CDP）。
 *
 * 与 `verify-ops.ts` 的区别：那个只测后端 HTTP；这个**真的把页面跑起来**，
 * 用真实的 DOM 点击去验证交互 —— 能抓到「代码写对了但页面上点不动」这类问题。
 *
 * 覆盖：
 *   1. 页面加载、无 JS 报错、关键元素存在、UI_BUILD 是最新版
 *   2. 任务卡片的「⋯」按钮可见且可点；点击/右键都能打开菜单，菜单项按状态显隐
 *   3. 能一次汇总本场已投稿件链接（删除不撤回稿件，用户需要链接去创作中心）
 *   4. 「删除任务…」弹出预览对话框，体积构成与「不会撤回投稿」都写清楚
 *   5. **真的点「确认删除」**删掉一个一次性任务（列表消失 + 目录被删）
 *   6. 设置面板：字幕与术语表字段齐全、术语表保存→回读→还原
 *   7. 详情页顶部「任务操作」栏（含投稿体检按钮）真的渲染出来且可见
 *   8. 截图留证（截图失败只警告，不影响断言）
 *
 * 用法：node tools/ui-e2e.ts [--headed]
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT_DIR, ensureDir, sleep } from '../src/util.ts';
import { sameVolume } from '../src/pending-delete.ts';
import * as LedgerMod from '../src/ledger.ts';

const HEADED = process.argv.includes('--headed');
const BASE = 'http://127.0.0.1:3000';
const PORT = 9333;
const SHOT_DIR = path.join(ROOT_DIR, 'data', 'ui-shots');
const UI_BUILD_EXPECTED = 'ui-2026-09-24-monitor-panel';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` :: ${detail}` : ''}`);
  }
}

/** 相等断言（便于报告"期望 X 实际 Y"） */
function eq<T>(name: string, actual: T, expected: T): void {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ============================================================================
 * 极简 CDP 客户端
 * ========================================================================== */

interface CdpTarget {
  type: string;
  webSocketDebuggerUrl?: string;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

class Cdp {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private consoleErrors: string[] = [];

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
      // 控制台报错与未捕获异常都收集起来，最后统一断言
      if (msg.method === 'Runtime.consoleAPICalled') {
        const p = msg.params as { type?: string; args?: Array<{ value?: unknown; description?: string }> };
        if (p.type === 'error') {
          this.consoleErrors.push(p.args?.map((a) => String(a.value ?? a.description ?? '')).join(' ') ?? '');
        }
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const p = msg.params as { exceptionDetails?: { exception?: { description?: string } } };
        this.consoleErrors.push(p.exceptionDetails?.exception?.description ?? '页面异常');
      }
    });
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
      setTimeout(() => reject(new Error('WebSocket 连接超时')), 10000);
    });
    return new Cdp(ws);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 命令超时：${method}`));
        }
      }, timeoutMs);
    });
  }

  /** 在页面里求值；expression 需是返回值的表达式（支持 await） */
  async evalJs<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{
      result: { value?: T; description?: string };
      exceptionDetails?: { exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`页面 JS 异常：${r.exceptionDetails.exception?.description ?? '未知'}`);
    return r.result.value as T;
  }

  get errors(): string[] {
    return this.consoleErrors;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/* ============================================================================
 * 截图（尽力而为）
 * ========================================================================== */

/**
 * 截图不是断言，只是给人看的证据。
 *
 * headless 下 `captureScreenshot` 偶尔会卡住（渲染进程忙 / 合成器不出帧），
 * 如果让它抛异常，整轮交互测试就在这里中断，后面的断言一条都跑不到 ——
 * 那是拿证据换结论，不划算。所以两次尝试用两条不同的 Chromium 路径，都失败就跳过。
 */
async function screenshot(cdp: Cdp, name: string): Promise<string> {
  ensureDir(SHOT_DIR);
  const file = path.join(SHOT_DIR, `${name}.png`);
  const variants: Array<Record<string, unknown>> = [
    { format: 'png', fromSurface: true, captureBeyondViewport: false },
    { format: 'png', fromSurface: false },
  ];
  for (let i = 0; i < variants.length; i++) {
    try {
      const r = await cdp.send<{ data: string }>('Page.captureScreenshot', variants[i]!, 12000);
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      const size = fs.statSync(file).size;
      console.log(`      \x1b[90m截图: ${path.relative(ROOT_DIR, file)} (${(size / 1024).toFixed(0)} KB)\x1b[0m`);
      return file;
    } catch (e) {
      if (i === variants.length - 1) {
        console.log(`      \x1b[33m截图跳过：${(e as Error).message}（不影响断言）\x1b[0m`);
        return '';
      }
      await sleep(500);
    }
  }
  return '';
}

/* ============================================================================
 * 主流程
 * ========================================================================== */

async function main(): Promise<void> {
  console.log('\x1b[1m界面级端到端测试\x1b[0m（Edge headless + CDP，真实点击）');
  console.log('─'.repeat(70));

  /* ---- 关于测试噪音：夹具任务的失败会写进**真实**的 data/errors.jsonl ----
   * 这个用例会点「从某阶段重跑」，夹具任务（`uie2e-fixture-*`）的 `source.rawFiles` 是空的，
   * 流水线于是抛 `buildSegmentMap: files 为空` 并把错误事件写进真实事件流。
   * 实测攒了 32 条，把监控面板的「近 24h 错误」顶到 50 并挂上红字阈值告警 —— 看起来像生产故障。
   *
   * ⚠️ **在这里 setErrorsPath 是没用的**：失败发生在**常驻服务进程**里，不是本进程。
   *   所以只能事后清理 —— 见文件末尾 finally 里按 `taskId.startsWith('uie2e-')` 精确摘除，
   *   与它清理 data/trash 用的是同一套前缀约定（绝不碰用户自己的条目）。 */

  /* ---- 服务可用性 ---- */
  try {
    const r = await fetch(`${BASE}/api/bootstrap`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    console.log(`  \x1b[31m服务不可达：${(e as Error).message}\x1b[0m`);
    console.log('  请先启动：.\\run.cmd');
    process.exit(1);
  }
  ok('服务在线', true);

  /* ---- 造一个固定的测试任务 ----
   * 这个测试原来直接用「列表里的第一张任务卡」，真实任务被删掉之后它就红了 ——
   * 界面测试不该依赖用户的数据。自己造一个带「已投稿切片」的任务，跑完再删掉。 */
  const fixture = `uie2e-fixture-${Date.now()}`;
  const fixtureDir = path.join(ROOT_DIR, 'data', 'tasks', fixture);
  /** 第二个夹具（自动导入）的 id 与目录，创建后填上 */
  let fixtureAuto = '';
  let fixtureAutoDir = '';
  try {
    const { Ledger } = await import('../src/ledger.ts');
    const { nowIso } = await import('../src/util.ts');
    const now = nowIso();
    new Ledger().createTask({
      id: fixture,
      roomId: '12345678',
      platform: 'Bilibili',
      title: '【界面测试】固定夹具任务',
      manual: true,
      status: 'CLIPPED',
      stage: 'CLIPPED',
      source: { segments: [], totalDuration: 1200, rawFiles: [], fullVideoHasDanmaku: false },
      clips: [
        {
          index: 0,
          start: 60,
          end: 100,
          title: '主播收到飞机礼物当场模仿起飞音效',
          desc: '测试用切片',
          tags: ['直播切片'],
          category: '游戏/单机游戏',
          score: 8.5,
          reason: '界面测试夹具',
          selected: true,
          status: 'PUBLISHED',
          bvid: 'BV1uie2e00001',
          degraded: false,
        },
        {
          index: 1,
          start: 200,
          end: 240,
          title: '有人中了20次红包？主播直呼搞不懂',
          desc: '测试用切片',
          tags: ['直播切片'],
          category: '游戏/单机游戏',
          score: 7.5,
          reason: '界面测试夹具',
          selected: true,
          status: 'CANDIDATE',
          degraded: false,
        },
      ],
      fullUpload: 'NOT_APPLICABLE',
      cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: now },
      createdAt: now,
      updatedAt: now,
    });
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, 'summary.md'), '# 界面测试夹具\n');
    ok('已造出界面测试夹具任务', true, fixture);

    /* 第二个夹具：**目录轮询自动导入**的任务。
       它与手动导入必须显示成不同的标记 —— 实测缺陷（用户报的）：
       两者走同一个 importLocal()，自动导入的任务也被标成「手动导入」，
       用户看到「1 候选 手动导入」根本分不清是谁建的。 */
    fixtureAuto = `uie2e-auto-${Date.now()}`;
    fixtureAutoDir = path.join(ROOT_DIR, 'data', 'tasks', fixtureAuto);
    fs.mkdirSync(fixtureAutoDir, { recursive: true });
    new Ledger().createTask({
      id: fixtureAuto,
      roomId: '12345678',
      platform: 'Bilibili',
      title: '【界面测试】自动导入夹具任务',
      importSource: 'auto',
      manual: false,
      status: 'ANALYZED',
      stage: 'ANALYZED',
      source: { segments: [], totalDuration: 900, rawFiles: [], fullVideoHasDanmaku: false },
      fullUpload: 'NOT_APPLICABLE',
      cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: now },
      createdAt: now,
      updatedAt: now,
    });
    ok('已造出「自动导入」夹具任务', true, fixtureAuto);
  } catch (e) {
    ok('已造出界面测试夹具任务', false, (e as Error).message);
  }
  /** 跑完把夹具删掉（顺带复用真实删除链路），并清掉它产生的错误报告 */
  const dropFixture = (): void => {
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      if (fixtureAutoDir) fs.rmSync(fixtureAutoDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    // 点「从某阶段重跑」会让夹具任务失败并落一份错误报告 —— 那是测试垃圾，清掉，
    // 否则用户的 error-report 目录里会堆一堆看起来像真故障的报告
    try {
      const dir = path.join(ROOT_DIR, 'data', 'error-report');
      for (const f of fs.readdirSync(dir)) {
        if (f.includes(fixture) || (fixtureAuto && f.includes(fixtureAuto))) fs.rmSync(path.join(dir, f), { force: true });
      }
    } catch {
      /* ignore */
    }
    try {
      new LedgerMod.Ledger().deleteTask(fixture);
    } catch {
      /* ignore */
    }
    try {
      if (fixtureAuto) new LedgerMod.Ledger().deleteTask(fixtureAuto);
    } catch {
      /* ignore */
    }
    /* 测试自己产生的回收站条目也要清掉。
     * 删除现在走回收站（这是特性），但测试每次跑都会留一条 `uie2e-*` 的垃圾条目 ——
     * 实测攒了 6 条，用户打开回收站会看到一堆「【界面测试】…」，很困惑。
     * 只清 taskId 以 uie2e- 开头的，绝不碰用户自己的条目。 */
    try {
      const trashDir = path.join(ROOT_DIR, 'data', 'trash');
      for (const name of fs.readdirSync(trashDir)) {
        const manifest = path.join(trashDir, name, 'manifest.json');
        if (!fs.existsSync(manifest)) continue;
        try {
          const j = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { taskId?: string };
          if (String(j.taskId ?? '').startsWith('uie2e-')) fs.rmSync(path.join(trashDir, name), { recursive: true, force: true });
        } catch {
          /* 坏清单跳过 */
        }
      }
    } catch {
      /* ignore */
    }
    /* ★ 错误事件流：夹具任务的失败会被**常驻服务**写进 data/errors.jsonl
       （在本进程 setErrorsPath 拦不住 —— 写盘的是服务）。
       实测攒了 32 条 `buildSegmentMap: files 为空`，把监控面板的「近 24h 错误」顶到 50
       并挂上红字阈值告警，看起来像生产故障。按 taskId 前缀精确摘掉自己的，
       与上面清 data/trash 同一套约定：只动 `uie2e-` 开头的。 */
    try {
      const errPath = path.join(ROOT_DIR, 'data', 'errors.jsonl');
      if (fs.existsSync(errPath)) {
        const rows = fs.readFileSync(errPath, 'utf8').split('\n').filter(Boolean);
        const kept = rows.filter((l) => {
          try {
            return !String((JSON.parse(l) as { taskId?: string }).taskId ?? '').startsWith('uie2e-');
          } catch {
            return true; // 坏行留着，别顺手删掉看不懂的东西
          }
        });
        if (kept.length !== rows.length) {
          fs.writeFileSync(errPath, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
          console.log(`  \x1b[90m已清掉本次测试写进 errors.jsonl 的 ${rows.length - kept.length} 条噪音\x1b[0m`);
        }
      }
    } catch {
      /* 清理失败不影响断言结论 */
    }
  };

  /* ---- 启动 Edge ---- */
  const edge = [
    `${process.env['ProgramFiles(x86)'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['LOCALAPPDATA'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].find((p) => p && fs.existsSync(p));
  if (!edge) {
    console.log('  \x1b[31m找不到 Edge\x1b[0m');
    process.exit(1);
  }

  const userDataDir = path.join(os.tmpdir(), `live_auto-cdp-${Date.now()}`);
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1600,1000',
    ...(HEADED ? [] : ['--headless=new']),
    'about:blank',
  ];
  console.log(`  \x1b[90m启动 Edge（${HEADED ? '有窗口' : 'headless'}）…\x1b[0m`);
  const child: ChildProcess = spawn(edge, args, { stdio: 'ignore', detached: false });

  /**
   * 关掉我们启动的 Edge。
   *
   * `child.kill()` 只能杀掉启动器进程：Edge 真正的浏览器进程是它再拉起来的，
   * 会活下来继续占着调试端口和临时 profile。下一次运行时新实例绑不上端口，
   * /json/list 就连到了上一轮那个「profile 已被删掉」的僵尸浏览器上 ——
   * 表现就是截图/求值随机卡住。所以这里按 profile 路径精确清进程树。
   */
  const cleanup = (): void => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    try {
      spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
            `Where-Object { $_.CommandLine -like '*${userDataDir.replace(/\\/g, '\\\\')}*' } | ` +
            `ForEach-Object { taskkill /PID $($_.ProcessId) /T /F 2>&1 | Out-Null }`,
        ],
        { stdio: 'ignore', timeout: 20000 },
      );
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  let cdp: Cdp | undefined;
  try {
    /* ---- 等调试端口 ---- */
    let target: CdpTarget | undefined;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as CdpTarget[];
        target = list.find((t) => t.type === 'page');
        if (target?.webSocketDebuggerUrl) break;
      } catch {
        /* 还没起来 */
      }
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('无法连接 Edge 调试端口');
    ok('Edge 调试端口就绪', true);

    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable').catch(() => undefined);
    ok('CDP 会话建立', true);

    /* 等到页面上某个表达式为真（默认 6 秒超时）。
       为什么不用固定 sleep：服务在跑真实任务时（转写/切片占满 CPU），一次请求往返可能好几秒，
       固定等待会偶发红灯 —— 实测出现过「同样的代码一次 104/0、一次 0 张卡全红」。
       ⚠️ 必须定义在**最前面**：后面每个小节都要用它，而 `const` 在定义之前使用会直接 ReferenceError。 */
    const waitFor = async (expr: string, timeoutMs = 6000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      const page = cdp;
      if (!page) return false;
      for (;;) {
        const v = await page.evalJs<unknown>(`(() => { try { return !!(${expr}); } catch { return false; } })()`);
        if (v === true) return true;
        if (Date.now() > deadline) return false;
        await sleep(200);
      }
    };

    /* ---- 固定视口 ----
     * headless 下 `--window-size` 并不总是生效，实测拿到的截图只有 500×450：
     * 三栏布局被挤扁，中栏（详情）几乎没宽度，截图完全不能反映真实界面，
     * 靠它断言「按钮可见」也会失真。用 CDP 明确设一次视口，稳。 */
    await cdp
      .send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
      .catch(() => undefined);
    const vp = await cdp.evalJs<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })');
    console.log(`      \x1b[90m视口: ${vp.w}×${vp.h}\x1b[0m`);
    await cdp.send('Page.bringToFront', {}, 4000).catch(() => undefined);

    /* ---- 导航 ---- */
    await cdp.send('Page.navigate', { url: BASE + '/' });
    let loaded = false;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try {
        if (await cdp.evalJs<boolean>('document.readyState === "complete"')) {
          loaded = true;
          break;
        }
      } catch {
        /* ignore */
      }
    }
    ok('页面加载完成', loaded);
    await sleep(3000); // 等 loadBootstrap + refreshAll

    /* ================= 1. 基础渲染 ================= */
    const build = await cdp.evalJs<string>('typeof UI_BUILD !== "undefined" ? UI_BUILD : "(未定义)"');
    ok('页面代码是最新版（含 UI_BUILD 标记）', build === UI_BUILD_EXPECTED, build);

    const basics = await cdp.evalJs<Record<string, boolean | string>>(`(() => ({
      taskList: !!document.querySelector('#taskList'),
      repairBtn: !!document.querySelector('#btnRepairStuck'),
      settingsBtn: !!document.querySelector('#btnSetting'),
      importBtn: !!document.querySelector('#btnImport'),
      brandText: (document.querySelector('#brandText') || {}).textContent || '',
    }))()`);
    ok(
      '关键元素存在（含顶栏设置按钮）',
      basics['taskList'] === true && basics['repairBtn'] === true && basics['settingsBtn'] === true && basics['importBtn'] === true,
      JSON.stringify(basics),
    );
    console.log(`      \x1b[90m顶栏信息: ${String(basics['brandText'])}\x1b[0m`);

    /* ================= 2. 任务卡片与「⋯」按钮 =================
     * 只看夹具那一张卡（真实任务可能一个都没有，测试不能依赖用户数据） */
    const sel = `#taskList .task[data-id="${fixture}"]`;
    /* 必须**等**卡片渲染出来再断言：页面是异步 fetch 完才画列表的，
       而服务端在跑流水线时（转写/切片占了事件循环）首屏可能就是几秒 ——
       直接断言"应该是 1 张"会得到 0 张这种假失败（实测就是这么红的）。 */
    await waitFor(`!!document.querySelector('${sel}')`, 20000).catch(() => undefined);
    const cardInfo = await cdp.evalJs<{ cards: number; moreBtns: number; visible: boolean; id: string }>(`(() => {
      const cards = document.querySelectorAll('${sel}');
      const mores = document.querySelectorAll('${sel} .more');
      let visible = false;
      if (mores[0]) {
        const st = getComputedStyle(mores[0]);
        visible = st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.1;
      }
      return { cards: cards.length, moreBtns: mores.length, visible, id: cards[0] ? cards[0].dataset.id : '' };
    })()`);
    ok('夹具任务卡片已渲染', cardInfo.cards === 1, `${cardInfo.cards} 张`);
    ok('卡片有「⋯」按钮', cardInfo.moreBtns === 1, `${cardInfo.moreBtns}/${cardInfo.cards}`);
    ok('「⋯」按钮可见（不用悬停就能看到）', cardInfo.visible, '按钮不可见 —— 用户会找不到入口');
    await screenshot(cdp, '01-task-list');

    /* ---- 来源标记：自动导入 vs 手动导入必须分得清（用户实测报的缺陷） ---- */
    const badges = await cdp.evalJs<{ manual: string; auto: string }>(`(() => {
      const meta = (id) => {
        const el = document.querySelector('#taskList .task[data-id="' + id + '"] .meta');
        return el ? el.textContent : '(卡片没渲染)';
      };
      return { manual: meta('${fixture}'), auto: meta('${fixtureAuto}') };
    })()`);
    ok('手动导入的任务标着「手动导入」', badges.manual.includes('手动导入'), badges.manual);
    ok('自动导入的任务标着「自动导入」', badges.auto.includes('自动导入'), badges.auto);
    ok('自动导入的任务**不**被标成「手动导入」', !badges.auto.includes('手动导入'), badges.auto);

    /* ================= 3. 「⋯」菜单 ================= */
    const taskStatus = await cdp.evalJs<string>(`(state.tasks.find((t) => t.id === '${fixture}') || {}).status || ''`);
    await cdp.evalJs(`document.querySelector('${sel} .more').click()`);
    await sleep(400);
    const menu = await cdp.evalJs<{ exists: boolean; items: string[]; rect: { x: number; y: number; w: number; h: number } | null }>(`(() => {
      const m = document.getElementById('taskMenu');
      if (!m) return { exists: false, items: [], rect: null };
      const r = m.getBoundingClientRect();
      return {
        exists: true,
        items: Array.from(m.querySelectorAll('button[data-op]')).map((b) => b.dataset.op),
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      };
    })()`);
    ok('点击「⋯」后菜单弹出', menu.exists === true);
    ok('菜单包含删除入口', menu.items.includes('delete'), menu.items.join(','));
    ok('菜单包含重跑与产物目录', ['retry', 'dir'].every((x) => menu.items.includes(x)), menu.items.join(','));
    const stopShown = menu.items.includes('stop');
    const stopExpected = ['TRANSCRIBING', 'ANALYZING', 'CLIPPING', 'PUBLISHING', 'PENDING', 'RECORDED', 'TRANSCRIBED'].includes(taskStatus);
    ok('「停止处理」按状态正确显隐', stopShown === stopExpected, `status=${taskStatus} 菜单=[${menu.items.join(',')}]`);
    if (menu.rect) {
      ok('菜单位置在视口内且尺寸正常', menu.rect.x >= 0 && menu.rect.y >= 0 && menu.rect.w > 100 && menu.rect.h > 50, JSON.stringify(menu.rect));
    }
    await screenshot(cdp, '02-task-menu');

    /* ---- 已投稿件链接汇总 ---- */
    const links = await cdp.evalJs<{ n: number; sample: string }>(`(async () => {
      const lines = await collectPublishedLinks('${fixture}');
      return { n: lines.length, sample: lines[0] || '' };
    })()`);
    ok('能一次汇总已投稿件链接', links.n > 0 && /bilibili\.com\/video\/BV/.test(links.sample), `${links.n} 条 · ${links.sample.slice(0, 60)}`);
    if (links.n > 0) ok('菜单为已投稿任务提供「复制全部稿件链接」', menu.items.includes('copy-links'), menu.items.join(','));

    /* ================= 4. 右键也能打开 ================= */
    await cdp.evalJs(`document.querySelector('#taskMenu') && document.querySelector('#taskMenu').remove()`);
    await cdp.evalJs(`(() => {
      const el = document.querySelector('${sel}');
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window }));
    })()`);
    await sleep(300);
    ok('右键任务卡片也能打开菜单', (await cdp.evalJs<boolean>(`!!document.getElementById('taskMenu')`)) === true);

    /* ================= 5. 删除预览对话框 ================= */
    await cdp.evalJs(`(() => {
      const m = document.getElementById('taskMenu');
      const btn = m && m.querySelector('button[data-op="delete"]');
      if (btn) btn.click();
    })()`);
    await sleep(1200);
    const dlg = await cdp.evalJs<{ open: boolean; title: string; hasConfirm: boolean; checkboxes: number; bodyText: string }>(`(() => {
      const mask = document.getElementById('infoMask');
      const body = document.getElementById('infoBody');
      const cbs = body ? body.querySelectorAll('input[type=checkbox]') : [];
      return {
        open: !!mask && mask.classList.contains('show'),
        title: (document.getElementById('infoTitle') || {}).textContent || '',
        hasConfirm: !!(body && body.querySelector('#doDelete')),
        checkboxes: cbs.length,
        bodyText: body ? String(body.innerText).slice(0, 500) : '',
      };
    })()`);
    ok('「删除任务…」打开了预览对话框', dlg.open === true);
    ok('对话框含「确认删除」按钮', dlg.hasConfirm === true);
    ok('对话框列出了可勾选项', dlg.checkboxes >= 1, `${dlg.checkboxes} 个复选框`);
    ok('提示里说明了「不会撤回已投稿件」', /不(会)?撤回|创作中心/.test(dlg.bodyText), dlg.bodyText.replace(/\n/g, ' ').slice(0, 120));
    ok('任务目录体积构成说明清楚', /压制产物/.test(dlg.bodyText), dlg.bodyText.replace(/\n/g, ' ').slice(0, 160));
    console.log(`      \x1b[90m标题: ${dlg.title}\x1b[0m`);
    await screenshot(cdp, '03-delete-dialog');

    await cdp.evalJs(`document.querySelector('#infoMask').classList.remove('show')`);
    await sleep(200);
    ok('对话框可关闭（未误删）', (await cdp.evalJs<boolean>(`!document.getElementById('infoMask').classList.contains('show')`)) === true);

    /* ================= 6. 无 JS 报错 ================= */
    const errs = cdp.errors.filter((e) => !/favicon|net::ERR_/i.test(e));
    ok('页面无 JavaScript 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

    /* ================= 7. 真删一次（造一个一次性任务） =================
     * 前面只验证到「对话框能弹出」。用户真正抱怨的是「点了没反应」，
     * 所以必须把「勾选 → 点确认删除 → 任务消失 → 目录没了」整条路真的走一遍。
     * 删的是脚本自己造的 uie2e-* 任务，不碰任何真实场次。 */
    const victim = `uie2e-${Date.now()}`;
    const victimDir = path.join(ROOT_DIR, 'data', 'tasks', victim);
    try {
      const { Ledger } = await import('../src/ledger.ts');
      const { nowIso } = await import('../src/util.ts');
      new Ledger().createTask({
        id: victim,
        roomId: '0',
        platform: 'Bilibili',
        title: '【界面测试】可安全删除的一次性任务',
        manual: true,
        status: 'ANALYZED',
        stage: 'ANALYZED',
        source: { segments: [], totalDuration: 60, rawFiles: [], fullVideoHasDanmaku: false },
        clips: [],
        fullUpload: 'NOT_APPLICABLE',
        cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: nowIso() },
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      fs.mkdirSync(victimDir, { recursive: true });
      fs.writeFileSync(path.join(victimDir, 'dummy.txt'), 'x'.repeat(2048));
      ok('已造出一次性测试任务', true, victim);
    } catch (e) {
      ok('已造出一次性测试任务', false, (e as Error).message);
    }

    await cdp.evalJs(`(async () => { await loadTasks(); renderTaskList(); })()`);
    await sleep(600);
    const hasVictim = await cdp.evalJs<boolean>(`!!document.querySelector('#taskList .task[data-id="${victim}"] .more')`);
    ok('新任务出现在列表里', hasVictim === true);

    if (hasVictim) {
      await cdp.evalJs(`document.querySelector('#taskList .task[data-id="${victim}"] .more').click()`);
      await sleep(400);
      await cdp.evalJs(`(() => {
        const m = document.getElementById('taskMenu');
        const b = m && m.querySelector('button[data-op="delete"]');
        if (b) b.click();
      })()`);
      await sleep(1200);
      ok('一次性任务的删除对话框打开', (await cdp.evalJs<boolean>(`!!document.getElementById('doDelete')`)) === true);
      await cdp.evalJs(`(() => {
        const t = document.getElementById('delTaskDir');
        if (t) t.checked = true;
        const c = document.getElementById('delClips');
        if (c) c.checked = false;
      })()`);
      await cdp.evalJs(`document.getElementById('doDelete').click()`);
      await sleep(2500);
      ok('点「确认删除」后任务从列表消失', (await cdp.evalJs<boolean>(`!document.querySelector('#taskList .task[data-id="${victim}"]')`)) === true);
      ok('任务目录也被真的删掉了', !fs.existsSync(victimDir));
    } else {
      try {
        const { Ledger } = await import('../src/ledger.ts');
        new Ledger().deleteTask(victim);
      } catch {
        /* ignore */
      }
      fs.rmSync(victimDir, { recursive: true, force: true });
    }
    await screenshot(cdp, '05-after-delete');

    /* ================= 8. 设置面板：字幕与术语表 ================= */
    await cdp.evalJs(`document.querySelector('#btnSetting').click()`);
    await sleep(1200);
    const cfgPanel = await cdp.evalJs<{ open: boolean; fields: Record<string, boolean>; text: string }>(`(() => {
      const body = document.getElementById('cfgBody');
      const ids = ['c_burnSubtitles', 'c_subtitleFontSize', 'c_subtitleMaxChars', 'c_glossaryAnchors', 'c_glossaryTerms', 'c_glossaryRepl', 'btnCopyHotWords', 'c_partTitleTemplate'];
      const fields = {};
      for (const id of ids) fields[id] = !!document.getElementById(id);
      return { open: !!body && body.innerText.length > 200, fields, text: body ? String(body.innerText).slice(0, 4000) : '' };
    })()`);
    ok('设置面板可打开', cfgPanel.open === true);
    const missing = Object.entries(cfgPanel.fields).filter(([, v]) => !v).map(([k]) => k);
    ok('字幕与术语表字段齐全', missing.length === 0, missing.length ? `缺：${missing.join(',')}` : `${Object.keys(cfgPanel.fields).length} 个字段`);
    ok('面板里能看到「字幕与术语表」分组', /字幕与术语表/.test(cfgPanel.text));
    ok('说明了热词为什么不能直传 ASR', /没有热词入参|只收/.test(cfgPanel.text));
    ok('分P 标题模板可配置并给出预览', /标题模板/.test(cfgPanel.text) && /可用变量/.test(cfgPanel.text));
    /* 完整版归属：规则是「默认由 biliLive-tools 投」，界面必须能看懂并且能改成例外 */
    const ownerUi = await cdp.evalJs<{ has: boolean; value: string; text: string }>(`(() => {
      const el = document.getElementById('c_fullVideoBy');
      return { has: !!el, value: el ? String(el.value) : '', text: el && el.parentElement ? String(el.parentElement.innerText) : '' };
    })()`);
    ok('设置里有「完整版由谁投稿」下拉', ownerUi.has);
    ok('默认选中 biliLive-tools（不是切片助手）', ownerUi.value === 'bililive-tools', ownerUi.value);
    ok('写明了默认规则与例外', /默认/.test(ownerUi.text) && /例外/.test(ownerUi.text), ownerUi.text.replace(/\n/g, ' ').slice(0, 120));
    /* AI 声明：切片是 AI 选段 + 自动投稿的，简介里必须有这一句，且要能改/能关 */
    const noticeUi = await cdp.evalJs<{ has: boolean; value: string; hint: string }>(`(() => {
      const el = document.getElementById('c_aiNotice');
      return { has: !!el, value: el ? String(el.value) : '', hint: el && el.parentElement ? String(el.parentElement.textContent) : '' };
    })()`);
    ok('设置里有「简介末尾的 AI 声明」输入框', noticeUi.has);
    ok('默认就带了声明文案（不是空的）', /AI/.test(noticeUi.value) && /投稿|切片/.test(noticeUi.value), noticeUi.value);
    ok('说明了声明不会被 250 字符截断掉', /截断/.test(noticeUi.hint), noticeUi.hint.replace(/\n/g, ' ').slice(0, 120));
    /* 待删清单入口：删源不可逆，用户必须能在界面上看见"还有多久会删"并反悔 */
    const pendingUi = await cdp.evalJs<{ btn: boolean; clickable: boolean; label: string }>(`(() => {
      const b = document.getElementById('btnPendingDelete');
      return { btn: !!b, clickable: !!b && typeof b.onclick === 'function', label: b ? String(b.textContent).trim() : '' };
    })()`);
    ok('设置里有「待删清单」入口', pendingUi.btn && pendingUi.clickable, pendingUi.label);
    ok('待删清单的说明写清了"宽限期内可取消"', /宽限期内可取消|宽限期/.test(cfgPanel.text));
    /* MCP 接入入口：token 在 config.json 里，用户必须能在界面上拿到并复制命令 */
    const mcpUi = await cdp.evalJs<{ btn: boolean; clickable: boolean; label: string }>(`(() => {
      const b = document.getElementById('btnMcp');
      return { btn: !!b, clickable: !!b && typeof b.onclick === 'function', label: b ? String(b.textContent).trim() : '' };
    })()`);
    ok('设置里有「MCP 接口」入口', mcpUi.btn && mcpUi.clickable, mcpUi.label);
    ok('说明了 MCP 只监听回环地址且必须带 token', /127\.0\.0\.1|token/.test(cfgPanel.text));
    await cdp.evalJs(`(() => {
      const el = document.getElementById('c_glossaryTerms');
      if (el) el.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await sleep(400);
    await screenshot(cdp, '06-settings-glossary');

    // 术语表编辑 → 保存 → 回读 → 还原（不留测试数据）
    const roundTrip = await cdp.evalJs<{ saved: boolean; same: boolean; after: string }>(`(async () => {
      const before = document.getElementById('c_glossaryTerms').value;
      const marker = '界面测试术语' + Date.now();
      document.getElementById('c_glossaryTerms').value = before + '\\n' + marker;
      await saveCfg();
      const boot = await api('/api/bootstrap');
      const after = (boot.glossary && boot.glossary.terms) || [];
      const saved = after.includes(marker);
      document.getElementById('c_glossaryTerms').value = before;
      await saveCfg();
      const boot2 = await api('/api/bootstrap');
      const after2 = (boot2.glossary && boot2.glossary.terms) || [];
      return { saved, same: JSON.stringify(after2) === JSON.stringify(after.filter((t) => t !== marker)), after: after2.join(',') };
    })()`);
    ok('术语表能在界面上保存并回读', roundTrip.saved === true, roundTrip.after);
    ok('保存后能还原（不留测试数据）', roundTrip.same === true, roundTrip.after);
    await cdp.evalJs(`closeCfg(); true`).catch(() => undefined);
    await sleep(300);

    /* ================= 9. 详情页操作栏 ================= */
    await cdp.evalJs(`document.querySelector('${sel}').click()`);
    await sleep(1500);
    const detail = await cdp.evalJs<{
      ops: string[];
      hasTip: boolean;
      visible: boolean;
      atTop: number;
      publishNote: boolean;
      auditVisible: boolean;
    }>(`(() => {
      const box = document.getElementById('detail');
      const scroller = box.closest('.scroll') || box.parentElement || box;
      scroller.scrollTop = 0;
      box.scrollIntoView({ block: 'start' });
      const btns = Array.from(box.querySelectorAll('[data-act]'));
      const del = box.querySelector('[data-act="delete-task"]');
      const audit = box.querySelector('[data-act="publish-audit"]');
      let visible = false;
      let atTop = -1;
      if (del) {
        const r = del.getBoundingClientRect();
        const st = getComputedStyle(del);
        visible = r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
        atTop = Math.round(r.top);
      }
      let auditVisible = false;
      if (audit) {
        const r2 = audit.getBoundingClientRect();
        auditVisible = r2.width > 0 && r2.height > 0;
      }
      return {
        ops: btns.map((b) => b.dataset.act),
        hasTip: /任务操作/.test(String(box.innerText)),
        visible,
        atTop,
        publishNote: /不会撤回投稿/.test(String(box.innerText)),
        auditVisible,
      };
    })()`);
    ok('详情页有任务操作按钮', detail.ops.length > 0, detail.ops.join(','));
    ok('详情页含删除按钮', detail.ops.includes('delete-task'), detail.ops.join(','));
    ok('删除按钮真实可见（不是只写进了 DOM）', detail.visible, `top=${detail.atTop}`);
    ok('详情页有「投稿体检」按钮且可见', detail.ops.includes('publish-audit') && detail.auditVisible, detail.ops.join(','));
    ok('详情页顶部标注了操作入口', detail.hasTip === true);

    /* ---- 9b. 「从某阶段重跑」弹窗里的 chip 必须真的能点 ----
     * 用户报过「这里的按键点不了」：代码写的是 `$('#retryStages .chip').forEach(...)`，
     * 而 `$` 是 querySelector（单个元素），对元素调 .forEach 抛 TypeError，
     * **整段绑定从不执行** —— 4 个 chip 一个都点不动，且页面上没有显眼报错。
     * 所以这里不只断言"弹窗打开了"，而是断言每个 chip 都**真的绑上了 onclick**。 */
    await cdp.evalJs(`document.querySelector('[data-act="retry-from"]').click()`);
    await sleep(900);
    const retryDlg = await cdp.evalJs<{ open: boolean; chips: number; bound: number; stages: string[] }>(`(() => {
      const mask = document.getElementById('infoMask');
      const chips = Array.from(document.querySelectorAll('#retryStages .chip'));
      return {
        open: !!mask && mask.classList.contains('show'),
        chips: chips.length,
        // onclick 属性为空 = 绑定那段代码没执行（就是那个 $/$$ 事故的表现）
        bound: chips.filter((c) => typeof c.onclick === 'function').length,
        stages: chips.map((c) => c.dataset.stage),
      };
    })()`);
    ok('「从某阶段重跑」弹窗能打开', retryDlg.open === true);
    eq('弹窗里有 4 个阶段可选', retryDlg.chips, 4);
    ok('4 个阶段按钮**全部绑定了点击处理**（不是只渲染出来）', retryDlg.bound === retryDlg.chips, `已绑定 ${retryDlg.bound}/${retryDlg.chips}；stages=${retryDlg.stages.join(',')}`);
    await screenshot(cdp, '09-retry-dialog'); // 趁弹窗还开着截图
    // 真的点一下：必须产生可见反馈（chip 高亮 / 弹窗关闭 / toast），不能毫无反应
    const clicked = await cdp.evalJs<{ reacted: boolean; detail: string }>(`(async () => {
      const chip = document.querySelector('#retryStages .chip[data-stage="ANALYZED"]');
      if (!chip) return { reacted: false, detail: '找不到 chip' };
      chip.click();
      await new Promise((r) => setTimeout(r, 1200));
      const on = chip.classList.contains('on');
      const dlgGone = !document.getElementById('infoMask').classList.contains('show');
      const toastShown = !!document.querySelector('.toast, #toast');
      return { reacted: on || dlgGone || toastShown, detail: 'on=' + on + ' 弹窗关闭=' + dlgGone + ' toast=' + toastShown };
    })()`);
    ok('点阶段按钮有实际反应（不是点了没反应）', clicked.reacted === true, clicked.detail);
    await cdp.evalJs(`document.getElementById('infoMask').classList.remove('show')`);
    await sleep(200);
    if (links.n > 0) {
      ok('详情页也为已投稿任务提供复制链接', detail.ops.includes('copy-links'), detail.ops.join(','));
      ok('详情页提醒「删除不撤回稿件」', detail.publishNote === true);
    }
    await sleep(300);
    await screenshot(cdp, '04-task-detail');

    /* ================= 10. 投稿体检（点开后能拿到报告） ================= */
    await cdp.evalJs(`document.querySelector('[data-act="publish-audit"]').click()`);
    // 体检要顺带查 B站（定时未到点的稿件详情会退避重试），给它足够时间：
    // 轮询到对话框出现为止，最多 60 秒 —— 用固定 sleep 会随机失败。
    let auditOpen = false;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      auditOpen = await cdp.evalJs<boolean>(`!!document.getElementById('infoMask') && document.getElementById('infoMask').classList.contains('show')`);
      if (auditOpen) break;
    }
    const auditDlg = await cdp.evalJs<{ open: boolean; text: string }>(`(() => {
      const mask = document.getElementById('infoMask');
      const body = document.getElementById('infoBody');
      return { open: !!mask && mask.classList.contains('show'), text: body ? String(body.innerText).slice(0, 4000) : '' };
    })()`);
    ok('「投稿体检」能打开报告', auditDlg.open === true, `轮询 ${auditOpen ? '成功' : '超时'}`);
    ok('报告含投稿批次', /投稿批次/.test(auditDlg.text));
    ok('报告含标题逐条检查', /标题逐条/.test(auditDlg.text));
    ok('报告明确只检测不改动', /只做检测/.test(auditDlg.text));
    await screenshot(cdp, '07-publish-audit');
    await cdp.evalJs(`document.querySelector('#infoMask').classList.remove('show')`);

    /* ================= 11. 导入录播：清单能列出、点选能带出参数 ================= */
    await cdp.evalJs(`document.querySelector('#btnImport').click()`);
    await sleep(1500);
    // 清单要扫盘 + ffprobe，等它渲染出结果行（最多 30 秒）
    let importRows = 0;
    for (let i = 0; i < 30; i++) {
      importRows = await cdp.evalJs<number>(`document.querySelectorAll('#impList .row[data-imp]').length`);
      if (importRows > 0) break;
      await sleep(1000);
    }
    ok('「导入录播」列出了可导入的录播（不再要求粘贴路径）', importRows > 0, `${importRows} 行`);
    ok('清单里有刷新入口与扫描统计', await cdp.evalJs<boolean>(`!!document.getElementById('impRefresh') && !!document.getElementById('impScanInfo')`));
    ok('清单还保留手动粘贴路径的兜底输入框', await cdp.evalJs<boolean>(`!!document.getElementById('impVideo')`));
    // 扫描范围必须能看、能改 —— 用户反馈过「我还有别的主播的录播，没有显示」
    ok('导入对话框里有「扫描目录」入口', await cdp.evalJs<boolean>(`!!document.getElementById('impDirsBox') && !!document.getElementById('impDirAdd')`));
    await cdp.evalJs(`document.getElementById('impDirsBox').open = true`);
    await sleep(500);
    const dirsText = await cdp.evalJs<string>(`String((document.getElementById('impDirs')||{}).innerText||'')`);
    ok('扫描目录里能看到 biliLive-tools 的自动目录', /来自 biliLive-tools|自动/.test(dirsText), dirsText.replace(/\n/g, ' ').slice(0, 120));
    ok('说明了本次实际扫描了哪些目录', /实际扫描/.test(dirsText), dirsText.replace(/\n/g, ' ').slice(0, 160));

    // 添加 / 移除一个临时扫描目录（真的改配置，跑完恢复）
    const tmpScanDir = path.join(os.tmpdir(), `live-auto-ui-scan-${Date.now()}`);
    try {
      fs.mkdirSync(tmpScanDir, { recursive: true });
      const addRes = await cdp.evalJs<{ ok: boolean; note: string; added: boolean; removed: boolean }>(`(async () => {
        const before = (await api('/api/recordings')).configuredDirs || [];
        const r = await api('/api/recordings/dirs', { method: 'POST', body: { add: ${JSON.stringify(tmpScanDir)} } });
        const mid = (r.configuredDirs || []).includes(${JSON.stringify(tmpScanDir)});
        const r2 = await api('/api/recordings/dirs', { method: 'POST', body: { remove: ${JSON.stringify(tmpScanDir)} } });
        const after = (r2.configuredDirs || []).includes(${JSON.stringify(tmpScanDir)});
        return { ok: r.ok === true, note: r.note || '', added: mid && JSON.parse(JSON.stringify(before)).length >= 0, removed: !after };
      })()`);
      ok('能在界面上添加扫描目录', addRes.ok && addRes.added, addRes.note);
      ok('能在界面上移除扫描目录', addRes.removed === true);
    } catch (e) {
      ok('能在界面上添加/移除扫描目录', false, (e as Error).message);
    } finally {
      fs.rmSync(tmpScanDir, { recursive: true, force: true });
    }

    if (importRows > 0) {
      // 点第一行 → 视频/标题应被自动带出，并触发预览
      await cdp.evalJs(`document.querySelector('#impList .row[data-imp]').click()`);
      await sleep(3000);
      const filled = await cdp.evalJs<{ video: string; title: string; preview: string }>(`(() => ({
        video: (document.getElementById('impVideo') || {}).value || '',
        title: (document.getElementById('impTitle') || {}).value || '',
        preview: String((document.getElementById('impPreview') || {}).innerText || '').slice(0, 2000),
      }))()`);
      ok('点选一行后自动填好视频路径', /[\\/]/.test(filled.video) && filled.video.length > 10, filled.video.slice(0, 80));
      ok('点选一行后自动填好标题', filled.title.length > 0, filled.title);
      ok('选中后有导入预览（时长/大小/弹幕/ASR）', /时长/.test(filled.preview) && /ASR/.test(filled.preview), filled.preview.replace(/\n/g, ' ').slice(0, 120));
      await screenshot(cdp, '08-import-recordings');
    } else {
      await screenshot(cdp, '08-import-recordings');
    }
    await cdp.evalJs(`document.querySelector('#infoMask').classList.remove('show')`);

    /* ================= 9. 排期栏的逐片操作（编辑 / 改发布时间 / 删除） =================
     * 用户需求：「这里我希望可以进行切片的操作，如删除和修改投稿的设置」——
     * 排期栏原来是只读的。这一节把三个入口都真点一遍（删除走完整 HTTP）。 */
    await cdp.evalJs(`(async () => { await loadSchedule(); })()`);
    await sleep(300);
    const sched = await cdp.evalJs<{ acts: string[]; rows: number }>(`(() => ({
      acts: Array.from(document.querySelectorAll('#schedule [data-sched-act]')).map((b) => b.dataset.schedAct),
      rows: document.querySelectorAll('#schedule .slot').length,
    }))()`);
    ok('排期栏渲染出了切片行', sched.rows > 0, `${sched.rows} 行`);
    ok('每片都有「编辑」入口', sched.acts.includes('edit'), JSON.stringify(sched.acts.slice(0, 6)));
    ok('每片都有「改发布时间」入口', sched.acts.includes('time'), JSON.stringify(sched.acts.slice(0, 6)));
    ok('每片都有「删除」入口', sched.acts.includes('del'), JSON.stringify(sched.acts.slice(0, 6)));

    /* ---- 9a. 改发布时间：不合法的时间必须被硬约束 #4 拦住 ---- */
    /* 排期按 dtime 升序（没有 dtime 的排最前），所以设置成功后那一行会**移位** ——
       必须记住这一片的 task+idx 再按它定位，不能假设还是第一行。 */
    const schedTarget = await cdp.evalJs<{ task: string; idx: string }>(`(() => {
      const b = document.querySelector('#schedule [data-sched-act="time"]');
      window.__schedTarget = { task: b.dataset.task, idx: b.dataset.idx };
      window.__schedRow = () => document.querySelector(
        '#schedule [data-sched-act="time"][data-task="' + window.__schedTarget.task + '"][data-idx="' + window.__schedTarget.idx + '"]');
      b.click();
      return window.__schedTarget;
    })()`);
    await sleep(300);
    const dlgOpen = await cdp.evalJs<boolean>(`!!document.getElementById('dtimeInput')`);
    ok('点「改发布时间」弹出了时间输入框', dlgOpen);
    if (dlgOpen) {
      await cdp.evalJs(`(() => {
        const d = new Date(Date.now() + 3600_000);            // 只留 1 小时 → 违反硬约束 #4
        const p = (n) => String(n).padStart(2, '0');
        document.getElementById('dtimeInput').value =
          d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
        document.getElementById('dtimeSave').click();
      })()`);
      await sleep(1000);
      const badTip = await cdp.evalJs<string>(`String((document.getElementById('dtimeTip') || {}).textContent || '')`);
      ok('不合规的时间被拒绝并说明原因（硬约束 #4）', /7200|硬约束/.test(badTip), badTip.slice(0, 120));

      /* ---- 9b. 合法时间（明天 08:00）应当保存进排期；再清空回到自动排期 ---- */
      await cdp.evalJs(`(() => {
        const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0);
        const p = (n) => String(n).padStart(2, '0');
        document.getElementById('dtimeInput').value =
          d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T08:00';
        document.getElementById('dtimeSave').click();
      })()`);
      await waitFor(`(() => {
        const c = (state.schedule.pending || []).find(
          (x) => x.taskId === window.__schedTarget.task && String(x.index) === String(window.__schedTarget.idx));
        return c && c.dtime;
      })()`);
      const after = await cdp.evalJs<{ hasDtime: number; text: string }>(`(() => {
        const row = window.__schedRow();
        const c = (state.schedule.pending || []).find(
          (x) => x.taskId === window.__schedTarget.task && String(x.index) === String(window.__schedTarget.idx));
        return {
          hasDtime: c && c.dtime ? 1 : 0,
          text: row ? String(row.closest('.slot').querySelector('.t').textContent) : '(那一行找不到了)',
        };
      })()`);
      eq('合法时间被接受（这一片带上了 dtime）', after.hasDtime, 1);
      ok('该行显示的是具体时间而不是「待定」', after.text !== '待定' && /\d{2}:\d{2}/.test(after.text), after.text);

      await cdp.evalJs(`window.__schedRow().click()`);
      await sleep(300);
      await cdp.evalJs(`(() => { document.getElementById('dtimeInput').value = ''; document.getElementById('dtimeSave').click(); })()`);
      await waitFor(`(() => {
        const c = (state.schedule.pending || []).find(
          (x) => x.taskId === window.__schedTarget.task && String(x.index) === String(window.__schedTarget.idx));
        return c && !c.dtime;
      })()`);
      const cleared = await cdp.evalJs<number>(`(() => {
        const c = (state.schedule.pending || []).find(
          (x) => x.taskId === window.__schedTarget.task && String(x.index) === String(window.__schedTarget.idx));
        return c && c.dtime ? 1 : 0;
      })()`);
      eq('清空后这一片回到自动排期（不再带 dtime）', cleared, 0);
      void schedTarget;
      await cdp.evalJs(`document.querySelector('#infoMask').classList.remove('show')`);
      await screenshot(cdp, '09-schedule-actions');
    }

    /* ---- 9c. 删除一条切片：真点按钮 → 真删（confirm 先替换成"同意"） ---- */    const beforeDel = await cdp.evalJs<number>(`(state.schedule.pending || []).length`);
    await cdp.evalJs(`window.confirm = () => true`);
    await cdp.evalJs(`document.querySelector('#schedule [data-sched-act="del"]').click()`);
    await waitFor(`(state.schedule.pending || []).length === ${beforeDel - 1}`);
    const afterDel = await cdp.evalJs<number>(`(state.schedule.pending || []).length`);
    ok('点「删除」后该切片从排期里消失', afterDel === beforeDel - 1, `${beforeDel} → ${afterDel}`);

    /* ================= 10. 本场设置：把「这一场由切片助手投完整版」真的写进台账 =================
     * 规则是「除非明确说明，完整版一律由 biliLive-tools 投」，所以这个例外开关必须**真能落库**
     * （原来那个「保存本场设置」按钮只是把值塞进前端变量，从没发出去）。 */
    await cdp.evalJs(`document.querySelector('#cfgMask').classList.remove('show')`);
    await cdp.evalJs(`(async () => { state.activeId = '${fixture}'; await loadDetail(); })()`);
    await sleep(600);
    const ovUi = await cdp.evalJs<{ has: boolean; text: string }>(`(() => {
      const el = document.getElementById('ovFullVideoBy');
      // 用 textContent 而不是 innerText：这块在折叠的 <details> 里，innerText 会返回空串
      return { has: !!el, text: el && el.parentElement ? String(el.parentElement.textContent) : '' };
    })()`);
    ok('详情页有「完整版由切片助手投（例外）」开关', ovUi.has);
    ok('开关写明了默认行为（由 biliLive-tools 投）', /biliLive-tools/.test(ovUi.text), ovUi.text.replace(/\n/g, ' ').slice(0, 110));

    await cdp.evalJs(`document.getElementById('ovFullVideoBy').click()`);
    await cdp.evalJs(`document.querySelector('[data-act="save-overrides"]').click()`);
    await waitFor(`true`, 200); // 让 PATCH 先发出去
    await sleep(1200);
    const saved = (await (await fetch(`${BASE}/api/task/${encodeURIComponent(fixture)}`)).json()) as {
      overrides?: { fullVideoBy?: string };
    };
    eq('打开开关保存后，台账里记下了 overrides.fullVideoBy=assistant', saved.overrides?.fullVideoBy, 'assistant');

    /* 关回去：默认规则不该被这次测试永久改掉 */
    await cdp.evalJs(`document.getElementById('ovFullVideoBy').click()`);
    await cdp.evalJs(`document.querySelector('[data-act="save-overrides"]').click()`);
    await sleep(1200);
    const reverted = (await (await fetch(`${BASE}/api/task/${encodeURIComponent(fixture)}`)).json()) as {
      overrides?: { fullVideoBy?: string };
    };
    ok('关掉开关后回到默认（不再记 assistant）', reverted.overrides?.fullVideoBy !== 'assistant', JSON.stringify(reverted.overrides));

    /* ================= 11. 实时监控面板：真点页签、真刷新、真等自动刷新 =================
     * 这一页的价值全在"盯着看"：如果定时器没启起来、或数据没变时整页重画导致闪烁，
     * 只有真的在浏览器里跑一遍才发现。所以这里验证三件事：
     *   ① 页签能点开，四个关键块都渲染出来（流水线 / 在等什么 / 目录轮询 / 它在干什么）
     *   ② 「立即刷新」能拉到新数据（lastAt 前进）
     *   ③ 自动刷新**真的在跑**（等一格，最后更新时间自己往前走） */
    await cdp.evalJs(`document.querySelector('#cfgMask').classList.remove('show')`);
    await cdp.evalJs(`$$('#tabs .tab').find((t) => t.dataset.view === 'monitor').click()`);
    await waitFor(`!!document.querySelector('#monUpdated')`, 6000);
    await sleep(900);

    const monUi = await cdp.evalJs<{ tab: boolean; on: boolean; upd: string; cards: string[]; kpis: number; hasAuto: boolean; hasRefresh: boolean }>(`(() => {
      const tab = $$('#tabs .tab').find((t) => t.dataset.view === 'monitor');
      const box = document.querySelector('#otherPage');
      return {
        tab: !!tab,
        on: !!(tab && tab.classList.contains('on')),
        upd: (document.querySelector('#monUpdated') || {}).textContent || '',
        cards: Array.from(box.querySelectorAll('.card h2')).map((h) => String(h.textContent).trim()),
        kpis: box.querySelectorAll('.kpi').length,
        hasAuto: !!document.querySelector('#monAuto'),
        hasRefresh: !!document.querySelector('[data-act="mon-refresh"]'),
      };
    })()`);
    ok('「实时监控」页签存在且被点亮', monUi.tab && monUi.on, JSON.stringify(monUi));
    ok('状态灯渲染出来（≥6 个 KPI）', monUi.kpis >= 6, `${monUi.kpis} 个`);
    ok('有「流水线」块（现在在干什么）', monUi.cards.some((c) => /流水线/.test(c)), JSON.stringify(monUi.cards));
    ok('有「在等什么」块', monUi.cards.some((c) => /在等什么/.test(c)), JSON.stringify(monUi.cards));
    ok('有「目录轮询」块（为什么没被导入）', monUi.cards.some((c) => /目录轮询/.test(c)), JSON.stringify(monUi.cards));
    ok('有「biliLive-tools 队列」块（它在压制/上传什么）', monUi.cards.some((c) => /biliLive-tools 队列/.test(c)), JSON.stringify(monUi.cards));
    ok('有「最近投稿」与「最近错误」块', monUi.cards.some((c) => /最近投稿/.test(c)) && monUi.cards.some((c) => /最近错误/.test(c)), JSON.stringify(monUi.cards));
    ok('有自动刷新间隔选择器与「立即刷新」按钮', monUi.hasAuto && monUi.hasRefresh);
    ok('显示「最后更新」时间', /最后更新/.test(monUi.upd), monUi.upd);
    await screenshot(cdp, '11-monitor-panel');

    const t0 = await cdp.evalJs<number>(`state.mon.lastAt`);
    await cdp.evalJs(`document.querySelector('[data-act="mon-refresh"]').click()`);
    await waitFor(`state.mon.lastAt > ${t0}`, 6000);
    ok('点「立即刷新」能拉到新数据', (await cdp.evalJs<number>(`state.mon.lastAt`)) > t0);

    /* 自动刷新：把间隔调到 3 秒（最小档），等一格后 lastAt 必须自己前进 */
    await cdp.evalJs(`(() => { const s = document.querySelector('#monAuto'); s.value = '3'; s.onchange(); })()`);
    const t1 = await cdp.evalJs<number>(`state.mon.lastAt`);
    await sleep(4200);
    const t2 = await cdp.evalJs<number>(`state.mon.lastAt`);
    ok('自动刷新真的在跑（3 秒档等 4.2 秒，数据自己刷新了）', t2 > t1, `${t1} → ${t2}`);
    /* 数据没变时不能整页重画：DOM 节点必须是同一个（否则页面会闪，也打断滚动/选择） */
    const stable = await cdp.evalJs<boolean>(`(() => {
      const box = document.querySelector('#otherPage');
      const first = box.firstElementChild;
      window.__monNode = first;
      return true;
    })()`);
    void stable;
    const t3 = await cdp.evalJs<number>(`state.mon.lastAt`);
    await sleep(4200);
    const sameNode = await cdp.evalJs<boolean>(`document.querySelector('#otherPage').firstElementChild === window.__monNode`);
    ok('数据没变时不重画（节点还是同一个，页面不闪）', sameNode && (await cdp.evalJs<number>(`state.mon.lastAt`)) > t3, `sameNode=${sameNode}`);

    /* 切走页签必须停表：没人看的时候不该每 3 秒问一次服务端 */
    await cdp.evalJs(`$$('#tabs .tab').find((t) => t.dataset.view === 'tasks').click()`);
    await sleep(300);
    ok('切回任务页后监控定时器已停止', (await cdp.evalJs<unknown>(`state.mon.timer`)) === null, String(await cdp.evalJs<unknown>(`state.mon.timer`)));

    /* ================= 12. 待删文件：真的点「立即删除」把它删掉 =================
     * 这是本项目**唯一会永久抹掉数据**的功能，所以只在单测里验证不够 ——
     * 这里在真浏览器里点一遍，验证：确认框把后果说清了、点完文件真的不在了、
     * 同盘进回收站（可恢复）、异盘明确警告"无法恢复"。
     *
     * 夹具做法：往**真实的** data/pending-delete.json 里塞两条指向临时文件的条目
     * （id 以 pd-uie2e- 开头），跑完按 id 前缀精确摘掉 —— 不覆盖用户已有的清单内容。 */
    const pdPath = path.join(ROOT_DIR, 'data', 'pending-delete.json');
    /* ⚠️ 同盘夹具必须**真的与回收站同盘**：`os.tmpdir()` 在 C:，而回收站在项目盘 ——
       一开始把"同盘"夹具建在临时目录里，它就被判成异盘（界面显示"跨盘·删除不可恢复"），
       文案断言全错。所以同盘那条放在项目 data/ 下（与回收站同一个根），异盘那条才用系统临时目录。 */
    const pdFixtureDir = path.join(ROOT_DIR, 'data', 'uie2e-pd-fixture');
    fs.mkdirSync(pdFixtureDir, { recursive: true });
    const sameVolFile = path.join(pdFixtureDir, '同盘-待删.docx.mp4');
    fs.writeFileSync(sameVolFile, Buffer.alloc(2048, 0x42));
    const otherVolFile = path.join(os.tmpdir(), `live-auto-uie2e-other-${Date.now()}.mp4`); // 系统临时目录（在 C:）
    let sameVolId = '';
    try {
      fs.writeFileSync(otherVolFile, Buffer.alloc(2048, 0x43));
      /* 前置自证：两条夹具的"盘符分流"必须与断言预期一致，否则后面的文案断言毫无意义 */
      const vol = {
        same: sameVolume(sameVolFile, path.join(ROOT_DIR, 'data', 'trash')),
        other: sameVolume(otherVolFile, path.join(ROOT_DIR, 'data', 'trash')),
      };
      ok('夹具分流正确（同盘夹具真的同盘、异盘夹具真的异盘）', vol.same === true && vol.other === false, JSON.stringify(vol));
      const dueAt = new Date(Date.now() + 30 * 60_000).toISOString(); // 排在真实条目**前面**，才能进监控面板的前 5 行
      const rawPd = fs.existsSync(pdPath) ? JSON.parse(fs.readFileSync(pdPath, 'utf8')) : { version: 1, entries: [] };
      sameVolId = `pd-uie2e-same-${Date.now()}`;
      const otherVolId = `pd-uie2e-other-${Date.now()}`;
      rawPd.entries = (rawPd.entries ?? []).concat([
        { id: sameVolId, path: sameVolFile, kind: 'clip', taskId: 'uie2e-fixture', reason: '界面测试夹具（同盘）', sizeBytes: 2048, createdAt: new Date().toISOString(), dueAt },
        { id: otherVolId, path: otherVolFile, kind: 'raw', taskId: 'uie2e-fixture', reason: '界面测试夹具（异盘）', sizeBytes: 2048, createdAt: new Date().toISOString(), dueAt },
      ]);
      fs.writeFileSync(pdPath, JSON.stringify(rawPd, null, 2), 'utf8');

      /* 诊断：页面上的 toast 与未捕获错误都记下来 —— 「点了没反应」这种故障
         只有把这两样抓出来才知道是"没绑上"还是"处理函数抛错了"。 */
      await cdp.evalJs(`(() => {
        window.__toasts = [];
        window.__errs = [];
        const t = window.toast;
        if (typeof t === 'function' && !window.__toastWrapped) {
          window.__toastWrapped = true;
          window.toast = (m, ms) => { window.__toasts.push(String(m)); return t(m, ms); };
        }
        window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
        window.__confirmText = '';
        window.confirm = (m) => { window.__confirmText = String(m); return true; };
        return true;
      })()`);

      /* ---- 12a. 待删清单弹窗（设置页入口）里的删除按钮 ----
         不删任何真实条目：只看"按钮在不在、文案对不对"。 */
      await cdp.evalJs(`document.querySelector('#btnSetting').click()`);
      await waitFor(`!!document.querySelector('#btnPendingDelete')`, 8000).catch(() => undefined);
      await sleep(400);
      const settingsUp = await cdp.evalJs<{ bound: boolean }>(`(() => {
        const b = document.querySelector('#btnPendingDelete');
        return { bound: !!b && typeof b.onclick === 'function' };
      })()`);
      if (settingsUp.bound) {
        await cdp.evalJs(`document.querySelector('#btnPendingDelete').click()`);
        const opened = await waitFor(`/待删清单/.test(String((document.querySelector('#infoTitle') || {}).textContent || ''))`, 8000);
        ok('设置页「查看待删清单」能打开待删清单弹窗', opened, '弹窗没打开');
        if (opened) {
          const rows = await cdp.evalJs<{ total: number; withDel: number; hasAll: boolean; firstTag: string }>(`(() => {
            const body = document.querySelector('#infoBody');
            const btns = body ? body.querySelectorAll('[data-pending-del]') : [];
            const row = btns[0] ? btns[0].closest('.row') : null;
            return {
              total: body ? body.querySelectorAll('.timeline .row').length : 0,
              withDel: btns.length,
              hasAll: !!document.querySelector('#pendingDelAll'),
              firstTag: row ? String(row.textContent).replace(/\\s+/g, ' ').slice(0, 140) : '',
            };
          })()`);
          ok('待删清单里每条待删都有「立即删除」按钮', rows.withDel > 0, JSON.stringify(rows));
          ok('有条目时给出「全部立即删除」入口', rows.hasAll || rows.withDel === 1, JSON.stringify(rows));
          ok('行内标注了删法（进回收站 / 跨盘不可恢复）', /删除→回收站|跨盘·删除不可恢复|文件已不在/.test(rows.firstTag), rows.firstTag);
          await screenshot(cdp, '12-pending-delete-dialog');
        }
      } else {
        ok('设置页「查看待删清单」入口已绑定（设置面板当前是否可渲染）', false, '按钮没绑上，弹窗测不了');
      }
      await cdp.evalJs(`document.querySelector('#cfgMask').classList.remove('show')`);
      /* ⚠️ 必须把 12a 开着的弹窗关掉：它还留在 DOM 里，`document.querySelector('[data-pending-del]')`
         会先命中弹窗里那一个（不在 <tr> 里），行文本与"全部立即删除"就都查不到了（实测踩过）。 */
      await cdp.evalJs(`window.closeInfo && window.closeInfo()`);
      await sleep(200);

      /* ---- 12b. 监控面板里的待删表：真的点「立即删除」把同盘那条删掉（选择器都限定在 #otherPage 内） ---- */
      await cdp.evalJs(`$$('#tabs .tab').find((t) => t.dataset.view === 'monitor').click()`);
      await waitFor(`!!document.querySelector('#otherPage [data-pending-del="${sameVolId}"]')`, 12000);
      const monRow = await cdp.evalJs<{ hasDel: boolean; tag: string; hasAll: boolean }>(`(() => {
        const b = document.querySelector('#otherPage [data-pending-del="${sameVolId}"]');
        const row = b ? b.closest('tr') : null;
        return { hasDel: !!b, tag: row ? String(row.textContent).replace(/\\s+/g, ' ') : '', hasAll: !!document.querySelector('#otherPage [data-pending-delall]') };
      })()`);
      ok('监控面板的待删表每行都有「立即删除」', monRow.hasDel, JSON.stringify(monRow));
      ok('同盘那条标着「删除→回收站」', /删除→回收站/.test(monRow.tag), monRow.tag.slice(0, 120));
      ok('多条待删时给出「全部立即删除」', monRow.hasAll, JSON.stringify(monRow));
      const otherTag = await cdp.evalJs<string>(`(() => {
        const b = document.querySelector('#otherPage [data-pending-del="${otherVolId}"]');
        const row = b ? b.closest('tr') : null;
        return row ? String(row.textContent).replace(/\\s+/g, ' ') : '';
      })()`);
      ok('异盘那条标着「跨盘·删除不可恢复」', /跨盘·删除不可恢复/.test(otherTag), otherTag.slice(0, 120));
      await screenshot(cdp, '12-pending-delete-monitor');

      /* 点同盘那条 → 确认框要写清"现在就删 / 7 天内可恢复"，文件真的消失 */
      await cdp.evalJs(`document.querySelector('#otherPage [data-pending-del="${sameVolId}"]').click()`);
      await waitFor(`!document.querySelector('#otherPage [data-pending-del="${sameVolId}"]')`, 12000);
      const confirmText = await cdp.evalJs<string>(`window.__confirmText`);
      ok('确认框说明了"现在就删、不等宽限期"', /现在就删/.test(confirmText), confirmText.split('\n')[0]);
      ok('确认框说明了"移入回收站，7 天内可恢复"', /7 天内可恢复/.test(confirmText), confirmText.replace(/\n/g, ' ').slice(0, 140));
      ok('点完之后文件真的不在了（同盘 → 回收站）', !fs.existsSync(sameVolFile), sameVolFile);
      ok('表格已重画，那一行消失', (await cdp.evalJs<boolean>(`!document.querySelector('#otherPage [data-pending-del="${sameVolId}"]')`)) === true);

      /* 点异盘那条 → 确认框必须出现"无法恢复"，且文件真的被永久删除 */
      await cdp.evalJs(`window.__confirmText = ''`);
      await cdp.evalJs(`document.querySelector('#otherPage [data-pending-del="${otherVolId}"]').click()`);
      await waitFor(`!document.querySelector('#otherPage [data-pending-del="${otherVolId}"]')`, 12000);
      const confirmText2 = await cdp.evalJs<string>(`window.__confirmText`);
      ok('异盘确认框警告"无法恢复"并列出文件名', /无法恢复/.test(confirmText2), confirmText2.replace(/\n/g, ' ').slice(0, 160));
      ok('异盘文件确实被永久删除', !fs.existsSync(otherVolFile), otherVolFile);
      const toasts = await cdp.evalJs<string[]>(`window.__toasts || []`);
      ok('删完给出了结果提示（含"回收站/永久删除"字样）', toasts.some((t) => /回收站|永久删除/.test(t)), JSON.stringify(toasts.slice(-2)));
      const pageErrs = await cdp.evalJs<string[]>(`window.__errs || []`);
      ok('整个删除流程没有未捕获异常', pageErrs.length === 0, JSON.stringify(pageErrs.slice(0, 2)));
    } finally {
      /* 精确摘掉夹具条目（按 id 前缀），不动用户的清单内容 */
      try {
        if (fs.existsSync(pdPath)) {
          const cur = JSON.parse(fs.readFileSync(pdPath, 'utf8'));
          cur.entries = (cur.entries ?? []).filter((e: { id?: string }) => !String(e.id ?? '').startsWith('pd-uie2e-'));
          fs.writeFileSync(pdPath, JSON.stringify(cur, null, 2), 'utf8');
        }
      } catch {
        /* 清理失败不影响断言结论 */
      }
      try { fs.rmSync(pdFixtureDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { if (fs.existsSync(otherVolFile)) fs.rmSync(otherVolFile, { force: true }); } catch { /* ignore */ }
      await cdp.evalJs(`document.querySelector('#cfgMask').classList.remove('show')`).catch(() => undefined);
    }

    /* 墓碑界面的验证**不放在这里**，而是独立成 `tools/verify-tombstone-ui.ts`。
       原因：那个用例要造「老任务已删 → 新任务被墓碑拦下」的状态，与这里的夹具互相干扰；
       而且本文件里前面的段落依赖用户真实数据（录播清单），一旦为空就会中断，
       把后面的用例一起带走（实测：录播清单变化时第 11 段红掉，第 12 段根本不执行）。
       墓碑是「防重复投稿」的最后一道防线，值得一个随时能单独跑、不受外部数据影响的用例。 */

    console.log('\n' + '─'.repeat(70));
    console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
    if (fail > 0) {
      console.log('\n失败项：');
      for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
      process.exitCode = 1;
    } else {
      console.log('\x1b[32m界面交互全部可用 —— 按钮能点、菜单能开、删除能真删、体检能出报告。\x1b[0m');
      console.log(`截图目录：${path.relative(ROOT_DIR, SHOT_DIR)}`);
    }
  } catch (e) {
    fail++;
    console.log(`\n  \x1b[31m测试异常：${(e as Error).message}\x1b[0m`);
    console.log((e as Error).stack?.split('\n').slice(1, 4).join('\n'));
    /* 页面自己报的错要一起打出来：不然"点了没反应"只能靠猜（未捕获异常被收集在 consoleErrors 里） */
    const pageErrs = cdp?.errors ?? [];
    if (pageErrs.length) {
      console.log(`  \x1b[33m页面收集到的 JS 报错（${pageErrs.length} 条，最多显示 3 条）：\x1b[0m`);
      for (const s of pageErrs.slice(0, 3)) console.log(`    · ${String(s).split('\n')[0]}`);
    }
    process.exitCode = 1;
  } finally {
    try {
      await cdp?.send('Browser.close', {}, 4000);
    } catch {
      /* 已经断开或超时都无所谓 */
    }
    cdp?.close();
    dropFixture();
    cleanup();
  }
}

main().catch((e) => {
  console.error('脚本崩溃：', (e as Error).message);
  process.exit(1);
});
