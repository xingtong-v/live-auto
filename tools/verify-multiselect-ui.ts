/**
 * 任务列表「多选批量删除」的真浏览器验证（Edge headless + CDP），**零删除**。
 *
 * 为什么必须真浏览器验：这一块全是 DOM 交互（勾选框、点卡片=勾选、工具条计数、弹窗、二次确认），
 * 静态断言只能证明"代码写了"，证明不了"点了真的能用"。实测过的失效方式：
 *   · 函数写了但按钮没绑 → 点了没反应；
 *   · 模板字符串写坏一个反引号 → 整页白屏（控制台一句话都不说）；
 *   · 多选模式下点卡片仍去加载详情 → 勾选永远勾不上。
 *
 * ★ 安全性：把页面的 `window.fetch` 与 `confirm` **桩住** —— POST 被拦截并记录请求体，
 * 不做任何真实删除；跑完还会核对真实台账的任务数没变（证明桩确实生效）。
 *
 * 用法（服务需在线）：node --experimental-strip-types tools/verify-multiselect-ui.ts [--headed]
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT_DIR, ensureDir, sleep } from '../src/util.ts';
import { eq, launchBrowser, ok, report } from './ui-shared.ts';

const BASE = 'http://127.0.0.1:3000';
/* 与 ui-e2e（9333）、verify-perf-ui（9335）、verify-health-ui（9336）错开 */
const PORT = 9337;
const HEADED = process.argv.includes('--headed');


/* ---- 极简 CDP（与 verify-perf-ui / verify-health-ui 同一套写法） ---- */

async function main(): Promise<void> {
  console.log('\x1b[1m任务多选批量删除（真浏览器，零删除）\x1b[0m');
  console.log('─'.repeat(70));

  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error(`HTTP ${h.status}`);
  } catch (e) {
    console.log(`  \x1b[31m服务不可达：${(e as Error).message}\x1b[0m`);
    process.exit(1);
  }
  ok('服务在线', true);

  /* 真台账的任务数：跑完要对一遍，证明桩确实拦住了删除 */
  const api = (await (await fetch(BASE + '/api/tasks?limit=500')).json()) as { tasks?: unknown[] };
  const tasksBefore = (api.tasks ?? []).length;
  const publishedBefore = (api.tasks ?? []).filter((t) => ['PUBLISHED', 'ARCHIVED'].includes(String((t as { status?: string }).status))).length;
  console.log(`  \x1b[90m接口：任务 ${tasksBefore} 个，其中已发布 ${publishedBefore} 个\x1b[0m`);

  const { cdp, close } = await launchBrowser({ port: PORT, headed: HEADED });
  try {
    await cdp.send('Page.navigate', { url: BASE + '/' });
    for (let i = 0; i < 60; i++) {
      if (await cdp.evalJs<boolean>('!!document.querySelector("#taskList .task")').catch(() => false)) break;
      await sleep(400);
    }
    ok('任务列表渲染出来了', await cdp.evalJs<boolean>('!!document.querySelector("#taskList .task")'));

    /* ★ 桩：拦下所有写请求并记录；confirm 一律放行（不让弹窗卡住无头浏览器） */
    await cdp.evalJs(`(() => {
      window.__captured = [];
      const orig = window.fetch;
      window.fetch = async (url, opts) => {
        const u = String(url);
        const method = String((opts && opts.method) || 'GET').toUpperCase();
        if (method !== 'GET') {
          window.__captured.push({ url: u, method, body: opts && opts.body ? String(opts.body) : '' });
          if (u.includes('/api/task/delete-batch')) {
            return new Response(JSON.stringify({ ok: true, deleted: ['stub-a','stub-b'], failed: [], freedMB: 12.3, skippedCount: 0, trashIds: ['stub-trash'], publishedClips: 1, note: '（桩）已处理 2/2 个任务' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return orig(url, opts);
      };
      window.confirm = () => true;
      return true;
    })()`);

    /* ① 进入多选模式 */
    const before = await cdp.evalJs<number>('document.querySelectorAll("#taskList .task").length');
    const clicked = await cdp.evalJs<boolean>('(() => { const b = document.getElementById("btnMulti"); if (!b) return false; b.click(); return true; })()');
    ok('点得动「多选」按钮', clicked);
    await sleep(300);
    const boxes = await cdp.evalJs<number>('document.querySelectorAll("#taskList .task .pick").length');
    eq('★ 每张卡片都出现勾选框', boxes, before);
    const barText = await cdp.evalJs<string>('String(document.getElementById("multiBar").textContent)');
    ok(`工具条出现并显示已选 0 个（实际：${barText.replace(/\s+/g, ' ').trim().slice(0, 60)}）`, /已选\s*0\s*个/.test(barText), barText);

    /* ② 点卡片 = 勾选（不再切任务） */
    const picked = await cdp.evalJs<number>(`(() => {
      const cards = [...document.querySelectorAll('#taskList .task')];
      cards[0].click();
      return document.querySelectorAll('#taskList .task.picked').length;
    })()`);
    eq('★ 多选模式下点卡片是"勾选"（不再切换任务）', picked, 1);
    const afterOne = await cdp.evalJs<string>('String(document.getElementById("multiBar").textContent)');
    ok('工具条计数跟着涨到 1', /已选\s*1\s*个/.test(afterOne), afterOne.replace(/\s+/g, ' ').slice(0, 60));

    /* ③ 全选已发布 */
    const selAll = await cdp.evalJs<number>(`(() => {
      const b = document.querySelector('[data-multi="pub"]');
      if (!b) return -1;
      b.click();
      return document.querySelectorAll('#taskList .task.picked').length;
    })()`);
    ok(`★ 「全选已发布」勾上了 ${selAll} 个（接口说已发布 ${publishedBefore} 个）`, selAll > 0, String(selAll));
    const delBtnText = await cdp.evalJs<string>(`(() => { const b = document.querySelector('[data-multi="del"]'); return b ? b.textContent.trim() : ''; })()`);
    ok(`删除按钮把数量写在脸上（实际：${delBtnText}）`, /删除选中（\d+）/.test(delBtnText), delBtnText);

    /* ④ 打开删除对话框（不许直接删） */
    await cdp.evalJs(`document.querySelector('[data-multi="del"]').click()`);
    await sleep(400);
    const dlg = await cdp.evalJs<string>('String((document.getElementById("infoBody") || document.body).textContent)');
    ok('★ 先弹对话框（不是点一下就没）', dlg.includes('批量删除任务') || dlg.includes('已选中'), dlg.replace(/\s+/g, ' ').slice(0, 120));
    ok('对话框里有三个勾选项（切片产物 / 任务目录 / 源素材）', dlg.includes('切片产物') && dlg.includes('任务目录') && dlg.includes('源素材'), dlg.replace(/\s+/g, ' ').slice(0, 200));
    ok('★ 对话框写明不影响 B站 上的稿件', dlg.includes('B站 上的稿件不会被撤回或删除') || dlg.includes('不会被撤回'), dlg.replace(/\s+/g, ' ').slice(0, 240));
    eq('此刻还没有发出任何写请求（没确认就不许删）', await cdp.evalJs<number>('window.__captured.length'), 0);

    /* ⑤ 确认删除 → 只应发出一次 /api/task/delete-batch，且带 confirm:true */
    await cdp.evalJs(`(() => { const b = document.getElementById('doBatchDelete'); if (b) b.click(); })()`);
    await sleep(900);
    const cap = await cdp.evalJs<Array<{ url: string; body: string }>>('window.__captured');
    const batch = cap.filter((c) => c.url.includes('/api/task/delete-batch'));
    eq('★ 只发一次批量删除请求', batch.length, 1);
    const sent = batch[0] ? (JSON.parse(batch[0].body) as { ids?: string[]; confirm?: boolean; deleteClips?: boolean }) : {};
    eq('请求带 confirm: true（服务端强制）', sent.confirm, true);
    eq('默认只删切片产物（deleteClips=true，任务目录/源素材默认不勾）', [sent.deleteClips, (sent as { deleteTaskDir?: boolean }).deleteTaskDir, (sent as { deleteRaw?: boolean }).deleteRaw], [true, false, false]);
    eq('★ 送出的 id 数 = 界面上勾选的数', (sent.ids ?? []).length, selAll);

    /* ⑥ 收尾：桩拦下了删除 ⇒ 真实台账必须一条不少 */
    const api2 = (await (await fetch(BASE + '/api/tasks?limit=500')).json()) as { tasks?: unknown[] };
    eq('★ 真实台账任务数没变（桩生效，一个都没真删）', (api2.tasks ?? []).length, tasksBefore);

    const errs = cdp.errors;
    eq('★ 页面没有未捕获异常', errs.length, 0, errs.join(' | ').slice(0, 300));

    const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data?: string };
    if (shot.data) {
      const dir = path.join(ROOT_DIR, 'data', 'verify-shots');
      ensureDir(dir);
      const file = path.join(dir, `task-multiselect-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log(`  \x1b[90m截图：${file}\x1b[0m`);
    }
  } finally {
    await close();
  await report();
  }

  await report();
}

await main();
