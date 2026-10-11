/**
 * 真浏览器验收「标签栏重排」：
 *   ① 待删 / 回收站（一页两段）、② 稿件表现里的成本折叠卡片、③ 测试夹具默认隐藏，
 * 并截图；顺带确认设置里不再有那两个按钮、无未捕获异常。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.ts';

const BASE = 'http://127.0.0.1:3000';
const PORT = 9342;
const OUT = 'F:/deepseek/live_auto/data/verify-shots';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const edge = [
  `${process.env['ProgramFiles(x86)'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['ProgramFiles'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env['LOCALAPPDATA'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
].find((p) => p && fs.existsSync(p));
const userDataDir = path.join(os.tmpdir(), `tabs-${Date.now()}`);
const child = spawn(edge ?? '', [`--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check', '--headless=new', '--window-size=1500,1000', 'about:blank'], { stdio: 'ignore' }) as unknown as { kill: () => void };

class Cdp {
  errors: string[] = [];
  ws: WebSocket;
  seq = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  constructor(ws: WebSocket) { this.ws = ws; ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (typeof m.id === 'number') { const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params?.exceptionDetails?.exception?.description ?? '异常');
  }); }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> { const id = ++this.seq; return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evalJs<T = any>(expr: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败');
    return r.result.value as T;
  }
  async shot(name: string): Promise<string> {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const p = path.join(OUT, `${name}.png`);
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    return p;
  }
  static async attach(port: number): Promise<Cdp> {
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
        if (t?.webSocketDebuggerUrl) {
          const ws = new WebSocket(t.webSocketDebuggerUrl);
          const c = new Cdp(ws);
          await new Promise<void>((res, rej) => { ws.addEventListener('open', () => res(), { once: true }); ws.addEventListener('error', () => rej(new Error('ws 失败')), { once: true }); });
          await c.send('Runtime.enable'); await c.send('Page.enable');
          return c;
        }
      } catch { /* 端口未就绪 */ }
      if (Date.now() > deadline) throw new Error('等不到调试端口');
      await sleep(300);
    }
  }
}

let pass = 0, fail = 0;
const ok = (t: string, c: unknown, d = ''): void => { if (c) { pass++; console.log('  ✓ ' + t); } else { fail++; console.log('  ✗ ' + t + (d ? ' :: ' + d : '')); } };

const cdp = await Cdp.attach(PORT);
/**
 * 切页签前先把**页面内的筛选/搜索状态**复位。
 *
 * 为什么需要：页签状态会跨断言保留 —— 实测过两次假红：切片库那段把 clipLib.status 设成 FAILED 后，
 * 后面再造夹具的那段被静默筛掉，看起来像"功能坏了"（而其实只是筛选还在）。
 * 这类失败最耗时，因为它指向错误的方向。
 */
const resetPageState = async (): Promise<void> => {
  await cdp
    .evalJs(
      `(() => {
        try {
          if (typeof clipLib !== 'undefined') { clipLib.q = ''; clipLib.status = ''; clipLib.limit = 200; }
          if (typeof showFixtureTasks !== 'undefined') { /* 夹具开关保持现状：有断言依赖它 */ }
        } catch (e) { /* ignore */ }
        return true;
      })()`,
    )
    .catch(() => undefined);
};
try {
  await cdp.send('Page.navigate', { url: BASE + '/' });
  for (let i = 0; i < 60; i++) { if (await cdp.evalJs('!!document.querySelector("#tabs .tab")').catch(() => false)) break; await sleep(400); }

  const tabs = await cdp.evalJs<Array<{ view: string; label: string }>>(`[...document.querySelectorAll('#tabs .tab')].map((t) => ({ view: t.dataset.view, label: String(t.textContent).trim() }))`);
  console.log('  标签栏：' + tabs.map((t) => t.label).join(' · '));
  ok('★ 页签顺序：任务/实时监控/健康面板/待删·回收站/稿件表现/切片库/Prompt',
    JSON.stringify(tabs.map((t) => t.view)) === JSON.stringify(['tasks', 'monitor', 'health', 'trash', 'perf', 'clips', 'prompts']),
    JSON.stringify(tabs.map((t) => t.view)));
  ok('★ 没有「成本」页签了', !tabs.some((t) => t.view === 'cost'));
  /* 2026-10-11 用户要求「待删清单和回收站放一起」：两个页签合并成一个，页签名字里两个词都在 */
  ok('★ 待删与回收站合并成一个页签（名字里两个词都有）',
    !tabs.some((t) => t.view === 'pending') && /待删/.test(tabs.find((t) => t.view === 'trash')?.label ?? '') && /回收站/.test(tabs.find((t) => t.view === 'trash')?.label ?? ''),
    JSON.stringify(tabs.map((t) => t.label)));

  /* ⓪ 测试夹具默认隐藏（2026-10-11：实测每天 38–45 个任务里真实直播只有 2–7 场，其余是测试夹具）
      —— 造一个真夹具、看它是不是被藏起来、开关能不能放出来，最后**删掉它**（自己收尾）。 */
  const fixtureId = `uie2e-verify-${Date.now()}`;
  const fxFake = path.join(os.tmpdir(), `dsh-fixture-${Date.now()}.mp4`);
  try {
    fs.writeFileSync(fxFake, 'x');
    const led = new Ledger();
    led.createTask({
      id: fixtureId,
      roomId: '1',
      title: '【界面测试】夹具隐藏验证',
      stage: 'PUBLISHED',
      status: 'PUBLISHED',
      source: { segments: [], totalDuration: 60, rawFiles: [fxFake], fullVideoHasDanmaku: false },
      fullUpload: 'NOT_APPLICABLE',
      cost: { asrEstimate: 9.99, asrAudioSeconds: 0, llmActual: 9.99, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    await cdp.evalJs(`refreshAll(true).then(() => true)`);
    await sleep(1500);
    const hidden = await cdp.evalJs<{ inList: boolean; toggle: string; cardCount: number }>(`(() => ({
      inList: !!document.querySelector('#taskList .task[data-id="${fixtureId}"]'),
      toggle: String((document.getElementById('fixtureToggleBar') || {}).textContent || '').trim(),
      cardCount: document.querySelectorAll('#taskList .task').length,
    }))()`);
    console.log('  夹具检查：列表里 ' + (hidden.inList ? '有' : '没有') + '；开关「' + hidden.toggle + '」；列表卡片 ' + hidden.cardCount + ' 个');
    ok('★ 测试夹具默认不出现在任务列表里', !hidden.inList, JSON.stringify(hidden));
    ok('★ 开关如实报出藏了几个（不静默）', /显示测试夹具（\d+）/.test(hidden.toggle), hidden.toggle);
    const shown = await cdp.evalJs<{ inList: boolean; tag: boolean }>(`(() => {
      const cb = document.getElementById('showFixtures');
      cb.checked = true; cb.dispatchEvent(new Event('change'));
      const el = document.querySelector('#taskList .task[data-id="${fixtureId}"]');
      return { inList: !!el, tag: el ? /测试夹具/.test(String(el.textContent)) : false };
    })()`);
    ok('★ 勾上开关就能看到它', shown.inList, JSON.stringify(shown));
    ok('★ 夹具行带「🔧 测试夹具」标记（一眼分得清）', shown.tag, JSON.stringify(shown));
    await cdp.evalJs(`(() => { const cb = document.getElementById('showFixtures'); if (cb) { cb.checked = false; cb.dispatchEvent(new Event('change')); } return true; })()`);
    /* 成本卡片也要排除它（金额 9.99/9.99 是刻意的显眼值） */
    const costJson = (await (await fetch(BASE + '/api/tasks')).json()) as { monthly: { fixturesExcluded?: number; total: number } };
    ok('★ 成本统计把它排除在外并如实计数', costJson.monthly.fixturesExcluded !== undefined && costJson.monthly.total < 9, JSON.stringify(costJson.monthly));
  } finally {
    try { new Ledger().deleteTask(fixtureId); } catch { /* ignore */ }
    try { fs.rmSync(fxFake, { force: true }); } catch { /* ignore */ }
    await cdp.evalJs(`refreshAll(true).then(() => true)`).catch(() => undefined);
  }
  await resetPageState();
  await cdp.evalJs(`document.querySelector('#tabs .tab[data-view="trash"]').click()`);
  await sleep(1200);
  const trash = await cdp.evalJs(`(() => { const t = String((document.querySelector('#otherPage') || {}).textContent || '').replace(/\\s+/g,' ').trim(); return { head: t.slice(0, 90), hasAll: !!document.querySelector('#trashPurgeAll') }; })()`);
  console.log('  回收站页：' + trash.head);
  ok('★ 回收站页签渲染出内容（标题 + 说明）', /回收站/.test(trash.head), trash.head.slice(0, 60));
  ok('有「清空回收站」入口', trash.hasAll);
  /* ★ 2026-10-11 用户要求：「这里增加折叠功能 按时间 每天的折叠在一起」——
     187 项平铺读不下去，改成按天分组、默认只展开最近一天。 */
  const groups = await cdp.evalJs<{ days: number; openDays: number; summaries: string[]; toggle: boolean; restoreBtns: number; firstDayRows: number }>(`(() => {
    const ds = [...document.querySelectorAll('#otherPage details.trashday')];
    return {
      days: ds.length,
      openDays: ds.filter((d) => d.open).length,
      summaries: ds.slice(0, 4).map((d) => String(d.querySelector('summary').textContent).replace(/\\s+/g, ' ').trim()),
      toggle: !!document.getElementById('trashToggleAll'),
      restoreBtns: document.querySelectorAll('#otherPage [data-restore]').length,
      firstDayRows: ds[0] ? ds[0].querySelectorAll('.row').length : 0,
    };
  })()`);
  console.log('  回收站分组：' + groups.days + ' 天，展开 ' + groups.openDays + ' 天；摘要示例 ' + JSON.stringify(groups.summaries.slice(0, 2)));
  ok('★ 按天分组（每天一个可折叠块）', groups.days >= 1, JSON.stringify(groups));
  ok('★ 默认**全部收起**（用户 2026-10-11 要求改成折叠状态）', groups.openDays === 0, JSON.stringify(groups));
  ok('每天摘要写清了「N 项 · 空间」', groups.summaries.length > 0 && groups.summaries.every((s) => /\d+ 项 · /.test(s)), JSON.stringify(groups.summaries));
  ok('组内的条目仍带着恢复按钮', groups.restoreBtns >= 1, JSON.stringify(groups));
  /* ★ 2026-10-11 用户要求：「每个日期后面都添加可删除选项 添加只保留几天的设置 超长时间的自动删除」 */
  const dayActions = await cdp.evalJs<{ btns: number; expireNotes: number; purgeExpired: boolean; keepText: boolean }>(`(() => {
    const ds = [...document.querySelectorAll('#otherPage details.trashday')];
    const box = document.querySelector('#otherPage');
    return {
      btns: box.querySelectorAll('[data-day-purge]').length,
      expireNotes: ds.filter((d) => /到期|已过期/.test(String(d.querySelector('summary').textContent))).length,
      purgeExpired: !!document.getElementById('trashPurgeExpired'),
      keepText: /保留 \\d+ 天/.test(String(box.textContent)),
    };
  })()`);
  console.log('  每天的可删按钮：' + dayActions.btns + ' 个；带到期提示的天数：' + dayActions.expireNotes);
  ok('★ 每个日期后面都有「彻底删除这天」', dayActions.btns === groups.days && dayActions.btns >= 1, JSON.stringify(dayActions));
  ok('★ 每天都标了「还剩几天到期 / 已过期」', dayActions.expireNotes === groups.days, JSON.stringify(dayActions));
  ok('★ 有「立即清理过期项」入口（按保留天数清理）', dayActions.purgeExpired);
  ok('页面写明了当前保留天数（与设置同源）', dayActions.keepText);

  /* 点「彻底删除这天」时：① 必须弹确认；② **不能顺手把这一天折叠/展开**（它在 <summary> 里，
     原生 details 的默认行为会被 preventDefault 拦掉）。这里把 confirm 换成"取消"，什么都不删。 */
  const guarded = await cdp.evalJs<{ before: boolean; after: boolean; asked: string }>(`(() => {
    window.__confirmText = '';
    const old = window.confirm;
    window.confirm = (m) => { window.__confirmText = String(m); return false; };
    const d = document.querySelector('#otherPage details.trashday');
    const before = d.open;
    d.querySelector('[data-day-purge]').click();
    const after = d.open;
    window.confirm = old;
    return { before, after, asked: window.__confirmText.split('\\n')[0].slice(0, 60) };
  })()`);
  console.log('  点日期删除按钮（确认框里选取消）：折叠状态 ' + guarded.before + ' → ' + guarded.after + '；确认文案「' + guarded.asked + '」');
  ok('★ 点「彻底删除这天」不会连带折叠那一天', guarded.before === guarded.after, JSON.stringify(guarded));
  ok('确认文案说清了不可恢复', /不可恢复/.test(guarded.asked) || /不可恢复/.test(await cdp.evalJs<string>(`window.__confirmText`)), guarded.asked);
  if (groups.days >= 1 && groups.toggle) {
    const before = await cdp.evalJs<string>(`String(document.getElementById('trashToggleAll').textContent).trim()`);
    ok('★ 全收起时开关显示「全部展开」', /全部展开/.test(before), before);
    const expanded = await cdp.evalJs<{ openDays: number; label: string }>(`(() => {
      const b = document.getElementById('trashToggleAll'); b.click();
      const ds = [...document.querySelectorAll('#otherPage details.trashday')];
      return { openDays: ds.filter((d) => d.open).length, label: String(b.textContent).trim() };
    })()`);
    ok('★「全部展开」把每一天都展开', expanded.openDays === groups.days && /收起/.test(expanded.label), JSON.stringify(expanded));
    /* 再点一次回到默认的"全部收起"，截图才是用户看到的默认样子 */
    await cdp.evalJs(`document.getElementById('trashToggleAll').click()`);
    await sleep(300);
    const back = await cdp.evalJs<number>(`[...document.querySelectorAll('#otherPage details.trashday')].filter((d) => d.open).length`);
    ok('再点一次回到「全部收起」（默认状态）', back === 0, String(back));
  } else {
    console.log('  \x1b[90m（回收站为空，跳过"全部展开"这一条）\x1b[0m');
  }
  console.log('  截图：' + (await cdp.shot('tab-trash')));

  /* ② 待删段（与回收站**同一页**，2026-10-11 合并） */
  const pend = await cdp.evalJs(`(() => { const t = String((document.querySelector('#otherPage') || {}).textContent || '').replace(/\\s+/g,' ').trim(); const badge = document.getElementById('pendingTabBadge'); return { head: t.slice(0, 140), badge: badge ? String(badge.textContent) : '', runDue: !!document.querySelector('#pendingRunDue'), hasTrash: !!document.querySelector('#trashPurgeAll'), hasDayGroups: document.querySelectorAll('#otherPage details.trashday').length }; })()`);
  console.log('  合并页：' + pend.head.slice(0, 110));
  ok('★ 同一页里同时有待删段与回收站段', /待删/.test(pend.head) && /回收站/.test(pend.head), pend.head.slice(0, 80));
  ok('待删段的「立即执行到点的删除」在', pend.runDue);
  ok('回收站段的「清空回收站」与按天分组也在同一页', pend.hasTrash && pend.hasDayGroups >= 1, JSON.stringify({ hasTrash: pend.hasTrash, days: pend.hasDayGroups }));
  ok('★ 不再重复列出「最近已删除」那段历史', !/最近已删除/.test(pend.head), pend.head.slice(0, 120));
  /* 待删段落的按钮数 = 待删条目数（占位行不算）—— 顺带确认没有把按钮漏给别的段 */
  const delBtns = await cdp.evalJs<{ pendCount: number; pendBtns: number }>(`(() => {
    const firstTimeline = document.querySelector('#otherPage .timeline');
    const rows = firstTimeline ? [...firstTimeline.querySelectorAll('.row')] : [];
    const entries = rows.filter((r) => !/没有待删除的文件/.test(String(r.textContent))).length;
    return { pendCount: entries, pendBtns: firstTimeline ? firstTimeline.querySelectorAll('[data-pending-del]').length : 0 };
  })()`);
  console.log('  待删段：' + delBtns.pendCount + ' 行 / ' + delBtns.pendBtns + ' 个删除按钮');
  ok('待删段落的按钮数 = 待删条目数（不会多给也不会少给）', delBtns.pendBtns === delBtns.pendCount, JSON.stringify(delBtns));
  console.log('  页签角标：' + (pend.badge || '(空)'));
  console.log('  截图：' + (await cdp.shot('tab-pending')));

  /* ④ 切片库（2026-10-11 P0-3）：造一场带 2 条切片的临时场次 → 检索/筛选/导出都在 → 删掉它 */
  const libTaskId = `uie2e-lib-${Date.now()}`;
  try {
    const led = new Ledger();
    led.createTask({
      id: libTaskId,
      roomId: '1',
      title: '【界面测试】切片库验证场',
      stage: 'PUBLISHED',
      status: 'PUBLISHED',
      source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
      fullUpload: 'NOT_APPLICABLE',
      cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    led.setClips(libTaskId, [
      { index: 0, start: 10, end: 130, title: '切片库验证·已发布的一条', desc: '', tags: ['测试'], category: '生活', score: 9.1, selected: true, status: 'PUBLISHED', bvid: 'BV1LIBVERIFY1' },
      { index: 1, start: 200, end: 330, title: '切片库验证·失败的一条', desc: '', tags: ['测试'], category: '生活', score: 6.2, selected: true, status: 'FAILED' },
    ] as never);

    await resetPageState();
    await cdp.evalJs(`document.querySelector('#tabs .tab[data-view="clips"]').click()`);
    await sleep(1500);
    const lib = await cdp.evalJs<{ rows: number; head: string; hasExport: boolean; hasSearch: boolean; firstTitle: string; hasPreviewOrNote: boolean }>(`(() => {
      const box = document.querySelector('#otherPage');
      const rows = [...box.querySelectorAll('table.tbl tbody tr')];
      return {
        rows: rows.length,
        head: String(box.textContent).replace(/\\s+/g, ' ').slice(0, 90),
        hasExport: !!document.getElementById('libExport'),
        hasSearch: !!document.getElementById('libQ'),
        firstTitle: rows[0] ? String(rows[0].querySelector('td').textContent).trim() : '',
        hasPreviewOrNote: /试看|去这一场|未切片/.test(String(box.textContent)),
      };
    })()`);
    console.log('  切片库：' + lib.rows + ' 行；首个标题「' + lib.firstTitle + '」');
    ok('★ 切片库渲染出跨场次的切片表', lib.rows >= 2, JSON.stringify(lib));
    ok('有搜索框与导出入口', lib.hasSearch && lib.hasExport, JSON.stringify(lib));
    ok('每行都有动作（试看 / 去这一场 / 未切片）', lib.hasPreviewOrNote, lib.head);
    /* 搜索：只留"已发布"那一条 */
    await cdp.evalJs(`(() => { const q = document.getElementById('libQ'); q.value = '已发布的一条'; q.dispatchEvent(new Event('input')); return true; })()`);
    await sleep(1200);
    const filtered = await cdp.evalJs<{ rows: number; titles: string[] }>(`(() => {
      const rows = [...document.querySelectorAll('#otherPage table.tbl tbody tr')];
      return { rows: rows.length, titles: rows.map((r) => String(r.querySelector('td').textContent).trim()) };
    })()`);
    ok('★ 搜索真的过滤了（只剩 1 条匹配）', filtered.rows === 1 && /已发布的一条/.test(filtered.titles[0] ?? ''), JSON.stringify(filtered));
    /* 状态筛选：切到「失败」应只剩另一条 */
    await cdp.evalJs(`(() => { const q = document.getElementById('libQ'); q.value = ''; q.dispatchEvent(new Event('input')); return true; })()`);
    await sleep(1200);
    await cdp.evalJs(`(() => { const s = document.getElementById('libStatus'); s.value = 'FAILED'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(1200);
    const onlyFailed = await cdp.evalJs<{ rows: number; tags: string }>(`(() => {
      const rows = [...document.querySelectorAll('#otherPage table.tbl tbody tr')];
      return { rows: rows.length, tags: rows.map((r) => String(r.textContent)).join(' ').slice(0, 120) };
    })()`);
    ok('★ 状态筛选生效（只剩失败那条）', onlyFailed.rows === 1 && /失败/.test(onlyFailed.tags), JSON.stringify(onlyFailed));
    console.log('  截图：' + (await cdp.shot('tab-clips')));
  } finally {
    try { new Ledger().deleteTask(libTaskId); } catch { /* ignore */ }
  }
  await resetPageState();
  await cdp.evalJs(`document.querySelector('#tabs .tab[data-view="perf"]').click()`);
  await sleep(2500);
  const perfBefore = await cdp.evalJs(`(() => { const d = [...document.querySelectorAll('#otherPage details')].find((x) => /成本/.test(String(x.textContent))); return { has: !!d, open: d ? d.open : null, summary: d ? String(d.querySelector('summary').textContent).trim() : '' }; })()`);
  console.log('  稿件表现里的成本卡片：' + JSON.stringify(perfBefore));
  ok('★ 稿件表现页里有「成本」折叠卡片（默认收起）', perfBefore.has && perfBefore.open === false, JSON.stringify(perfBefore));
  ok('摘要写明了月份', /成本（月度汇总 · \d{4}-\d{2}）/.test(perfBefore.summary), perfBefore.summary);
  await cdp.evalJs(`(() => { const d = [...document.querySelectorAll('#otherPage details')].find((x) => /成本/.test(String(x.textContent))); if (d) d.open = true; return true; })()`);
  await sleep(500);
  const cost = await cdp.evalJs(`(() => { const d = [...document.querySelectorAll('#otherPage details')].find((x) => /成本/.test(String(x.textContent))); const t = d ? String(d.textContent).replace(/\\s+/g,' ') : ''; return { hasKpi: /本月合计/.test(t), hasTable: /按日分布/.test(t), snippet: t.slice(0, 150) }; })()`);
  console.log('  展开后：' + cost.snippet);
  ok('★ 展开后能看到「本月合计」等 KPI', cost.hasKpi);
  ok('★ 也有「按日分布」表', cost.hasTable);
  console.log('  截图：' + (await cdp.shot('perf-with-cost')));

  /* ④ 设置里不该再有那两个按钮 */
  await cdp.evalJs(`(() => { const b = document.getElementById('btnSetting'); if (b) b.click(); return true; })()`);
  await sleep(1500);
  const cfg = await cdp.evalJs(`(() => {
    const modal = document.querySelector('#cfgMask .modal') || document.querySelector('#cfgMask');
    const text = String((modal || {}).textContent || '');
    return { trash: !!document.getElementById('btnTrash'), pending: !!document.getElementById('btnPendingDelete'), tip: /搬到顶部标签栏/.test(text), snippet: text.replace(/\\s+/g, ' ').slice(0, 0) };
  })()`);
  ok('★ 设置里不再有「查看回收站 / 查看待删清单」按钮', !cfg.trash && !cfg.pending, JSON.stringify(cfg));
  ok('设置里留了指路说明（写了搬到顶部标签栏）', cfg.tip);

  /* 回收站保留天数：输入框 + 回显 + **保存真的落盘**（这里保存的是原值，不改用户配置）。
     用户要求是「添加只保留几天的设置 超长时间的自动删除」——所以必须确认这条设置真的生效。 */
  const cfgField = await cdp.evalJs<{ val: string; hint: string }>(`(() => {
    const el = document.getElementById('c_trashDays');
    const wrap = el ? el.closest('.field') : null;
    return { val: el ? String(el.value) : '(无)', hint: wrap ? String(wrap.textContent).replace(/\\s+/g, ' ') : '' };
  })()`);
  console.log('  回收站保留天数输入框：' + cfgField.val);
  ok('★ 设置里有「回收站保留天数」并回显当前值', /^\d+$/.test(cfgField.val), cfgField.val);
  ok('说明写清了「超期自动彻底删除」与「0 = 不用回收站」', /自动彻底删除/.test(cfgField.hint) && /0 = 不用回收站/.test(cfgField.hint), cfgField.hint.slice(0, 120));
  const saved = await cdp.evalJs<{ toasts: string[]; after: number | null }>(`(async () => {
    window.__toasts = [];
    const t = window.toast;
    if (typeof t === 'function' && !window.__toastWrapped) { window.__toastWrapped = true; window.toast = (m, ms) => { window.__toasts.push(String(m)); return t(m, ms); }; }
    document.getElementById('btnSaveCfg').click();
    await new Promise((r) => setTimeout(r, 3000));
    let after = null;
    try { const b = await (await fetch('/api/bootstrap')).json(); after = Number(b.config?.cleanup?.trashDays); } catch { /* ignore */ }
    return { toasts: window.__toasts || [], after };
  })()`);
  console.log('  保存结果：' + JSON.stringify(saved.toasts.slice(-1)) + '，服务端 cleanup.trashDays=' + String(saved.after));
  ok('★ 保存后服务端配置里就是输入框那个值（设置真的生效）', saved.after !== null && String(saved.after) === cfgField.val, JSON.stringify(saved));
  ok('保存给出了结果提示（不是静默）', saved.toasts.length > 0, JSON.stringify(saved.toasts));

  /* 设置面板瘦身（A1）：81 个输入平铺 → 分组折叠 + 搜索 + 常用快跳 + 危险标注 */
  const slim = await cdp.evalJs<{ groups: number; open: number; hasSearch: boolean; jumps: number; danger: number }>(`(() => {
    const ds = [...document.querySelectorAll('#cfgBody details.cfggroup')];
    return {
      groups: ds.length,
      open: ds.filter((d) => d.open).length,
      hasSearch: !!document.getElementById('cfgSearch'),
      jumps: document.querySelectorAll('#cfgBody [data-cfgjump]').length,
      danger: document.querySelectorAll('#cfgBody [data-danger]').length,
    };
  })()`);
  console.log('  设置面板：' + slim.groups + ' 个分组（展开 ' + slim.open + '），常用快跳 ' + slim.jumps + ' 个，危险标注 ' + slim.danger + ' 个');
  ok('★ 设置分成多个可折叠分组，且默认全部收起（先看目录）', slim.groups >= 5 && slim.open === 0, JSON.stringify(slim));
  ok('★ 有搜索框', slim.hasSearch);
  ok('★ 有「常用」快跳（不用在 81 个输入里翻）', slim.jumps >= 5, JSON.stringify(slim));
  ok('★ 危险字段带标记（trashDays / 删源 / 失败保留）', slim.danger >= 3, JSON.stringify(slim));

  /* ★ 边录边转写开关（2026-10-14，用户要求"给这个配置加个界面开关"）：
     要验的是"真的能点"（控件在 DOM 里）+ "点了不会误解"（文案里写清要重启才生效）。 */
  const incr = await cdp.evalJs<{ exists: boolean; text: string; hint: string }>(`(() => {
    const el = document.getElementById('c_incrementalEnabled');
    if (!el) return { exists: false, text: '', hint: '' };
    const span = el.nextElementSibling ? String(el.nextElementSibling.textContent) : '';
    const field = el.closest('.field');
    const hint = field && field.querySelector('.hintline') ? String(field.querySelector('.hintline').textContent) : '';
    return { exists: true, text: span, hint };
  })()`);
  ok('★ 设置里有「边录边转写」开关（c_incrementalEnabled）', incr.exists, JSON.stringify(incr));
  ok('★ 开关旁边写清了"需要重启服务才生效"（否则点了会以为坏了）', /重启服务/.test(incr.hint), incr.hint.slice(0, 90));
  /* ★ 断言必须**与当前配置值无关**：这个开关的初值来自 config.json（用户可能已经开了），
     所以只能验"点一下会翻转，且文案跟着翻转"，不能假设"点一下就是开"。
     （2026-10-14 实测踩过一次：用户已把开关存成 true，于是点击是"关" ⇒ 旧断言假红。） */
  const incrToggled = await cdp.evalJs<{ before: boolean; after: boolean; text: string }>(`(() => {
    const el = document.getElementById('c_incrementalEnabled');
    if (!el) return { before: false, after: false, text: '' };
    const before = el.classList.contains('on');
    el.click();
    const after = el.classList.contains('on');
    return { before, after, text: el.nextElementSibling ? String(el.nextElementSibling.textContent) : '' };
  })()`);
  ok('★ 点击后状态真的翻转（不是"点了没反应"）', incrToggled.after !== incrToggled.before, JSON.stringify(incrToggled));
  ok(
    '★ 翻转后文案与新状态一致（开启态要带"需重启服务才生效"）',
    incrToggled.after ? /开启/.test(incrToggled.text) && /需重启服务/.test(incrToggled.text) : /关闭/.test(incrToggled.text),
    incrToggled.text,
  );
  /* 点回原状：界面状态会跨断言保留（这个坑本项目踩过），不能给后面的断言留副作用 */
  await cdp.evalJs(`(() => { const el = document.getElementById('c_incrementalEnabled'); if (el && el.classList.contains('on')) el.click(); return true; })()`);
  const searched = await cdp.evalJs<{ note: string; visible: number; opened: number; groups: number }>(`(() => {
    const q = document.getElementById('cfgSearch');
    q.value = '保留天数'; q.dispatchEvent(new Event('input'));
    const ds = [...document.querySelectorAll('#cfgBody details.cfggroup')];
    return {
      note: String(document.getElementById('cfgSearchNote').textContent),
      visible: [...document.querySelectorAll('#cfgBody .field')].filter((f) => f.style.display !== 'none').length,
      opened: ds.filter((d) => d.open).length,
      groups: ds.length,
    };
  })()`);
  console.log('  搜索「保留天数」：' + searched.note + '；可见字段 ' + searched.visible + ' 个，自动展开 ' + searched.opened + '/' + searched.groups + ' 组');
  ok('★ 搜索能定位（只留匹配字段）', /匹配 \d+ 项/.test(searched.note) && searched.visible >= 1 && searched.visible <= 6, JSON.stringify(searched));
  ok('★ 命中的分组自动展开（不然搜了也看不到）', searched.opened >= 1 && searched.opened < searched.groups, JSON.stringify(searched));
  const expanded = await cdp.evalJs<{ open: number; label: string }>(`(() => {
    const q = document.getElementById('cfgSearch'); q.value = ''; q.dispatchEvent(new Event('input'));
    const b = document.getElementById('cfgExpandAll'); b.click();
    const ds = [...document.querySelectorAll('#cfgBody details.cfggroup')];
    return { open: ds.filter((d) => d.open).length, label: String(b.textContent).trim() };
  })()`);
  ok('★「全部展开」一键放开所有分组', expanded.open === slim.groups && /收起/.test(expanded.label), JSON.stringify(expanded));
  /* ★ 用户实测报的缺陷（2026-10-12）：设置瘦身**只有第一次打开生效** ——
     根因是幂等标记挂在 #cfgBody 自身，而每次打开都会重写它的子节点，第二次打开时标记仍在 ⇒ 增强被跳过。
     这里就按用户的操作复现：关掉设置、再打开一次，两次都必须是瘦身状态。 */
  await cdp.evalJs(`(() => { const x = document.querySelector('#cfgMask .x'); if (x) x.click(); return true; })()`);
  await sleep(600);
  await cdp.evalJs(`document.querySelector('#btnSetting').click()`);
  await sleep(1200);
  const second = await cdp.evalJs<{ groups: number; open: number; hasSearch: boolean; jumps: number }>(`(() => {
    const ds = [...document.querySelectorAll('#cfgBody details.cfggroup')];
    return {
      groups: ds.length,
      open: ds.filter((d) => d.open).length,
      hasSearch: !!document.getElementById('cfgSearch'),
      jumps: document.querySelectorAll('#cfgBody [data-cfgjump]').length,
    };
  })()`);
  console.log('  第二次打开设置：' + second.groups + ' 个分组（展开 ' + second.open + '），搜索框 ' + (second.hasSearch ? '有' : '没有'));
  ok('★ 第二次打开依然是瘦身状态（分组折叠 + 搜索框都在）', second.groups >= 5 && second.open === 0 && second.hasSearch && second.jumps >= 5, JSON.stringify(second));

  /* ④ 待办闭环（P0-3）：造一条真待办 → 点「忽略 24h」→ 条目消失 + 如实报数 → 清理。
     单元断言覆盖的是端点；这里覆盖的是**界面接线**（按钮 → api() → 重渲染），
     那正是"看得到、点不走"这类问题的藏身处。 */
  /* ⚠️ 这里**故意不用 uie2e- 前缀**：/api/todos 会过滤测试夹具（isFixtureTask），
     用夹具 id 造出来的场次永远不会出现在待办里（上一版就是这么假红的 —— 我一开始还误判成
     "服务端不重载台账"）。所以用一条普通的临时场次，跑完自己删掉。 */
  const todoTaskId = `auto-${Date.now()}-todocheck`;
  try {
    const led = new Ledger();
    led.createTask({
      id: todoTaskId,
      roomId: '1',
      title: '待办闭环验证场（临时，跑完即删）',
      stage: 'CLIPPED',
      status: 'CLIPPED',
      source: { segments: [], totalDuration: 600, rawFiles: [], fullVideoHasDanmaku: false },
      fullUpload: 'NOT_APPLICABLE',
      cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    /* 一条「已提交待确认且超过 1 小时」的切片 ⇒ /api/todos 必然产出 unconfirmed-publish 条目 */
    led.setClips(todoTaskId, [
      {
        index: 0,
        start: 0,
        end: 60,
        title: '待办闭环验证·已提交待确认',
        desc: '',
        tags: ['测试'],
        category: '生活',
        score: 8,
        selected: true,
        status: 'SUBMITTED',
        bvid: 'BV1TODO00001',
        submitTime: Date.now() - 90 * 60_000,
      },
    ] as never);

    /* 先让前端重新拉一次台账（服务端 Ledger 在内存里持有台账，直接写盘不会自动可见），再切到健康面板 */
    await cdp.evalJs(`refreshAll(true).then(() => true)`).catch(() => undefined);
    await sleep(1200);
    await resetPageState();
    await cdp.evalJs(`document.querySelector('#tabs .tab[data-view="health"]').click()`);
    await sleep(3000);
    const beforeClick = await cdp.evalJs<{ items: number; text: string }>(`(() => {
      const box = document.querySelector('#otherPage');
      const btns = [...box.querySelectorAll('[data-todo-snooze]')];
      return { items: btns.length, text: String(box.textContent).split(String.fromCharCode(10)).join(' ').slice(0, 120) };
    })()`);
    console.log(`  待办：${beforeClick.items} 条可忽略；片段「${beforeClick.text.slice(0, 60)}」`);
    ok('★ 健康面板出现了带「忽略 24h」的真待办', beforeClick.items > 0, JSON.stringify(beforeClick));

    if (beforeClick.items > 0) {
      await cdp.evalJs(`(() => { window.confirm = () => true; const b = document.querySelector('[data-todo-snooze]'); if (b) b.click(); return true; })()`);
      await sleep(2500);
      const after = await cdp.evalJs<{ hasTodo: boolean; text: string }>(`(() => {
        const box = document.querySelector('#otherPage');
        const txt = String(box.textContent).split(String.fromCharCode(10)).join(' ');
        return { hasTodo: txt.includes('已提交待确认'), text: txt.slice(0, 160) };
      })()`);
      ok('★ 点忽略后该条目不再显示（界面真的接上了端点）', !after.hasTodo, after.text);
      const apiAfter = (await (await fetch(BASE + '/api/todos')).json()) as { items: Array<Record<string, unknown>>; dismissedCount?: number };
      const stillThere = apiAfter.items.some((x) => String(x['key'] ?? '') === 'unconfirmed-publish');
      ok(
        '★ API 侧确认已隐藏且如实报数（不静默消失）',
        !stillThere ? true : (apiAfter.dismissedCount ?? 0) >= 1,
        JSON.stringify({ stillThere, dismissedCount: apiAfter.dismissedCount }),
      );
    }
  } finally {
    /* 清理：恢复被忽略的待办 + 删掉临时场次（绝不碰用户数据） */
    try {
      const boot = (await (await fetch(BASE + '/api/bootstrap')).json()) as { csrf: string };
      for (const key of ['unconfirmed-publish', 'failed-tasks', 'stuck-tasks', 'disk-low', 'pending-delete-due', 'duplicate-parts']) {
        await fetch(BASE + '/api/todos/undismiss', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-CSRF-Token': boot.csrf },
          body: JSON.stringify({ key }),
        });
      }
    } catch {
      /* ignore */
    }
    try {
      new Ledger().deleteTask(todoTaskId);
    } catch {
      /* ignore */
    }
    await cdp.evalJs(`refreshAll(true).then(() => true)`).catch(() => undefined);
  }

  /* ⑤ P1-4 就地动作：切片库里「已提交待确认」的行要有重投按钮；已发布的行不许有（不放假按钮）。
     ⚠️ 夹具 id **不用 uie2e- 前缀**：那会让它被当成测试夹具（上一轮在待办上踩过 —— 被规则过滤掉）。 */
  const repubTaskId = `auto-${Date.now()}-repubcheck`;
  try {
    const led = new Ledger();
    led.createTask({
      id: repubTaskId,
      roomId: '1',
      title: '重投动作验证场（临时，跑完即删）',
      stage: 'CLIPPED',
      status: 'CLIPPED',
      source: { segments: [], totalDuration: 600, rawFiles: [], fullVideoHasDanmaku: false },
      fullUpload: 'NOT_APPLICABLE',
      cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);
    led.setClips(repubTaskId, [
      { index: 0, start: 0, end: 60, title: '重投验证·已提交待确认', desc: '', tags: ['测试'], category: '生活', score: 8, selected: true, status: 'SUBMITTED', bvid: 'BV1REPUB0001' },
      { index: 1, start: 60, end: 120, title: '重投验证·已发布', desc: '', tags: ['测试'], category: '生活', score: 7, selected: true, status: 'PUBLISHED', bvid: 'BV1REPUB0001' },
    ] as never);

    await cdp.evalJs(`refreshAll(true).then(() => true)`).catch(() => undefined);
    await sleep(1200);
    await resetPageState();
    await cdp.evalJs(`document.querySelector('#tabs .tab[data-view="clips"]').click()`);
    await sleep(2500);
    /* ★ 先清掉页面里残留的筛选条件：前面那段切片库测试把 status 设成了 FAILED 并留在页内状态里，
       不清的话我这批夹具会被筛掉（实测就是这么得到 0 行的）—— 这是"页签状态会跨断言保留"的坑。 */
    await cdp.evalJs(`(() => { clipLib.q = ''; clipLib.status = ''; clipLib.limit = 200; return true; })()`);
    await resetPageState();
    await cdp.evalJs(`document.querySelector('#tabs .tab[data-view="clips"]').click()`);
    await sleep(2000);
    const repub = await cdp.evalJs<{ rows: number; withBtn: number; allSubmitted: boolean }>(`(() => {
      const rows = [...document.querySelectorAll('#otherPage table.tbl tbody tr')];
      const withBtn = rows.filter((r) => r.querySelector('[data-lib-republish]'));
      return {
        rows: rows.length,
        withBtn: withBtn.length,
        allSubmitted: withBtn.every((r) => String(r.textContent).includes('已提交待确认')),
      };
    })()`);
    console.log(`  切片库：${repub.rows} 行，其中 ${repub.withBtn} 行带重投按钮`);
    ok('★ 切片库里「已提交待确认」的行出现了重投按钮', repub.withBtn >= 1, JSON.stringify(repub));
    ok('★ 重投按钮只出现在「已提交待确认」的行（已发布的行没有假按钮）', repub.allSubmitted, JSON.stringify(repub));
  } finally {
    try {
      new Ledger().deleteTask(repubTaskId);
    } catch {
      /* ignore */
    }
    await cdp.evalJs(`refreshAll(true).then(() => true)`).catch(() => undefined);
  }

  ok('全程无未捕获异常', cdp.errors.length === 0, cdp.errors[0]?.slice(0, 160));
  console.log('\n  结果：PASS=' + pass + ' FAIL=' + fail);
} finally {
  try { await cdp.send('Browser.close'); } catch { /* ignore */ }
  child.kill();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exitCode = fail === 0 ? 0 : 1;
