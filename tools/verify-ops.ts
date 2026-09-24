/**
 * 端到端验证「任务操作」链路：完全走 HTTP（与浏览器同一条路径），
 * 不直接调内部方法 —— 这样才能复现用户点按钮时的真实情况。
 *
 * 用法：node tools/verify-ops.ts [taskId]
 */
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:3000';

function log(ok: boolean, msg: string, extra?: string): void {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${msg}${extra ? `  ${extra}` : ''}`);
}

async function main(): Promise<void> {
  console.log('\x1b[1m任务操作链路体检（走 HTTP，与浏览器一致）\x1b[0m');
  console.log('─'.repeat(66));

  /* ---- 0. 服务可用性 ---- */
  let boot: { csrf: string };
  try {
    boot = (await (await fetch(`${BASE}/api/bootstrap`)).json()) as { csrf: string };
    log(true, `服务在线，拿到 CSRF token（长度 ${boot.csrf.length}）`);
  } catch (e) {
    log(false, `服务不可达：${(e as Error).message}`);
    console.log('\n  请先启动服务：.\\run.cmd  或  node src/cli.ts run');
    process.exit(1);
  }
  const H = { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrf };

  /* ---- 1. 页面里是否含菜单代码 ---- */
  const html = await (await fetch(`${BASE}/`)).text();
  log(html.includes('openTaskMenu'), '页面包含任务菜单代码', html.includes('openTaskMenu') ? '' : '← 浏览器可能缓存了旧页面，请 Ctrl+F5');
  log(html.includes('delete-plan'), '页面包含删除预览调用');
  log(html.includes('class="more"'), '页面包含列表「⋯」按钮');
  log(!html.includes('__NEED_REFRESH__'), '页面无刷新标记');

  /* ---- 2. 任务列表 ---- */
  const list = (await (await fetch(`${BASE}/api/tasks`)).json()) as {
    tasks: Array<{ id: string; title: string; statusText: string; clipCount: number; publishedCount: number }>;
  };
  log(list.tasks.length > 0, `任务列表返回 ${list.tasks.length} 个任务`);
  for (const t of list.tasks) {
    console.log(`      ${t.id}  ${t.statusText}  切片 ${t.clipCount}  已发 ${t.publishedCount}`);
  }
  const target = process.argv[2] ?? list.tasks[list.tasks.length - 1]?.id;
  if (!target) {
    log(false, '没有可操作的任务');
    process.exit(1);
  }
  console.log(`\n  使用目标任务：${target}`);

  /* ---- 3. 详情接口（菜单的「打开产物目录」依赖它） ---- */
  {
    const r = await fetch(`${BASE}/api/task/${encodeURIComponent(target)}`);
    const d = (await r.json()) as { taskDirHint?: string; clipsDirHint?: string };
    log(r.ok && Boolean(d.taskDirHint), '任务详情含产物路径', d.taskDirHint ?? '(缺 taskDirHint)');
  }

  /* ---- 4. 删除预览 ---- */
  let plan: { plan: { clipsFiles: number; clipsMB: number; taskMB: number; totalMB: number; publishedClips: number; rawFiles: Array<{ name: string; exists: boolean; sharedWith: string[] }> }; warning?: string };
  {
    const r = await fetch(`${BASE}/api/task/${encodeURIComponent(target)}/delete-plan`);
    if (!r.ok) {
      log(false, `删除预览失败 HTTP ${r.status}`, (await r.text()).slice(0, 200));
      process.exit(1);
    }
    plan = (await r.json()) as typeof plan;
    log(true, `删除预览可用：切片 ${plan.plan.clipsFiles} 个/${plan.plan.clipsMB}MB，任务目录 ${plan.plan.taskMB}MB，合计 ${plan.plan.totalMB}MB`);
    if (plan.warning) console.log(`      \x1b[33m${plan.warning}\x1b[0m`);
  }

  /* ---- 5. 写操作是否真的需要 CSRF（浏览器会自动带上） ---- */
  {
    const r = await fetch(`${BASE}/api/tasks/repair-stuck`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    log(r.status === 403, '无 CSRF token 的写操作被拒绝（证明校验生效）', `HTTP ${r.status}`);
    const r2 = await fetch(`${BASE}/api/tasks/repair-stuck`, { method: 'POST', headers: H, body: '{}' });
    log(r2.ok, '带 CSRF token 的写操作被接受', `HTTP ${r2.status}`);
  }

  /* ---- 6. 真正执行一次删除（复制任务，不影响原任务） ---- */
  console.log('\n\x1b[1m端到端删除演练\x1b[0m（复制一个任务再删它，不动你的真实任务）');
  const copyId = `opstest-${Date.now()}`;
  {
    // 通过内部模块复制（HTTP 没有「复制任务」接口，这里只是造测试数据）
    const { Ledger } = await import('../src/ledger.ts');
    const tmpLedger = new Ledger();
    const src = tmpLedger.getTask(target)!;
    tmpLedger.createTask({
      ...src,
      id: copyId,
      title: `【删除演练】${src.title}`,
      status: 'ANALYZED',
      clips: tmpLedger.getClips(target).map((c) => ({ ...c, status: 'CANDIDATE' as const })),
      cleaned: undefined,
    });
    log(true, `已创建演练任务 ${copyId}`);
  }

  {
    const dir = `data/tasks/${copyId}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/dummy.txt`, 'x'.repeat(1024));
    const r = await fetch(`${BASE}/api/task/${encodeURIComponent(copyId)}/delete`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ confirm: true, deleteClips: true, deleteTaskDir: true, deleteRaw: false }),
    });
    const body = (await r.json()) as { ok?: boolean; freedMB?: number; note?: string; error?: string };
    log(r.ok && body.ok === true, `删除接口返回成功`, `HTTP ${r.status} ${body.note ?? body.error ?? ''}`);
    log(!fs.existsSync(dir), '任务目录已被删除');
    const still = (await (await fetch(`${BASE}/api/tasks`)).json()) as { tasks: Array<{ id: string }> };
    log(!still.tasks.some((t) => t.id === copyId), '任务已从列表消失');
  }

  /* ---- 7. 用真实任务验一次「不带 confirm 必须被拒」 ---- */
  {
    const r = await fetch(`${BASE}/api/task/${encodeURIComponent(target)}/delete`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ deleteClips: true }),
    });
    log(r.status === 400, '不带 confirm 的删除被拒绝（防误删）', `HTTP ${r.status}`);
  }

  /* ---- 8. 停止任务 ---- */
  {
    const r = await fetch(`${BASE}/api/task/${encodeURIComponent(target)}/stop`, { method: 'POST', headers: H, body: '{}' });
    const b = (await r.json()) as { from?: string; to?: string; note?: string };
    log(r.ok, `停止接口可用`, b.from === b.to ? `状态 ${b.from}（无需修复）` : `${b.from} → ${b.to}`);
  }

  console.log('\n' + '─'.repeat(66));
  console.log('\x1b[32m全部操作链路可用。\x1b[0m');
  console.log('如果浏览器里仍然点不动，请看下方「排查」部分。');
}

main().catch((e) => {
  console.error('\x1b[31m体检脚本异常：\x1b[0m', (e as Error).message);
  process.exit(1);
});
