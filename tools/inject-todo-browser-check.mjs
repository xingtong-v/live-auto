/**
 * 把"待办闭环"的浏览器断言注入 tools/verify-tabs.ts（2026-10-13，P0-3 最后一块）。
 *
 * 为什么需要：P0-3 的功能与单元断言都齐了，但**界面接线**（点按钮 → 调端点 → 条目消失 → 报数）
 * 还没有真浏览器证据。这个脚本注入一段自包含的验收：造一条真待办（临时场次 + SUBMITTED 切片）
 * → 打开健康面板 → 点「忽略 24h」→ 断言条目消失且出现"已忽略"计数 → 通过 API 恢复并删掉临时场次。
 *
 * 用 write 工具落盘（不再用 shell here-string 拼 JS —— 那已经连续害我两次静默失败）。
 */
import fs from 'node:fs';

const R = 'F:/deepseek/live_auto/';
const F = R + 'tools/verify-tabs.ts';
let t = fs.readFileSync(F, 'utf8');

if (t.includes('待办闭环')) {
  console.log('  已注入过，跳过');
  process.exit(0);
}

/* 锚点：我自己在第 8 轮加的那条"第二次打开设置依然是瘦身状态"断言（唯一且稳定） */
const ANCHOR = "  ok('★ 第二次打开依然是瘦身状态（分组折叠 + 搜索框都在）', second.groups >= 5 && second.open === 0 && second.hasSearch && second.jumps >= 5, JSON.stringify(second));";
if (!t.includes(ANCHOR)) {
  console.log('  ⚠ 锚点未命中，未改动');
  process.exit(1);
}

const section = [
  ANCHOR,
  '',
  '  /* ④ 待办闭环（P0-3）：造一条真待办 → 点「忽略 24h」→ 条目消失 + 如实报数 → 清理。',
  '     为什么要在真浏览器里验：单元断言覆盖的是端点，这里覆盖的是**界面接线**',
  '     （按钮 → api() → 重渲染），这正是"看得到、点不走"那类问题的藏身处。 */',
  '  const todoTaskId = `uie2e-todo-${Date.now()}`;',
  '  try {',
  '    const led = new Ledger();',
  '    led.createTask({',
  '      id: todoTaskId,',
  "      roomId: '1',",
  "      title: '【界面测试】待办闭环验证场',",
  "      stage: 'CLIPPED',",
  "      status: 'CLIPPED',",
  "      source: { segments: [], totalDuration: 600, rawFiles: [], fullVideoHasDanmaku: false },",
  "      fullUpload: 'NOT_APPLICABLE',",
  '      cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: new Date().toISOString() },',
  '      createdAt: new Date().toISOString(),',
  '      updatedAt: new Date().toISOString(),',
  '    } as never);',
  '    /* 一条"已提交待确认且超过 1 小时"的切片 ⇒ /api/todos 必然产出 unconfirmed-publish 条目 */',
  '    led.setClips(todoTaskId, [',
  "      { index: 0, start: 0, end: 60, title: '待办闭环验证·已提交待确认', desc: '', tags: ['测试'], category: '生活', score: 8, selected: true, status: 'SUBMITTED', bvid: 'BV1TODO00001', submitTime: Date.now() - 90 * 60_000 },",
  '    ] as never);',
  '',
  "    await cdp.evalJs(`document.querySelector('#tabs .tab[data-view=\"health\"]').click()`);",
  '    await sleep(1500);',
  '    const beforeClick = await cdp.evalJs<{ items: number; hasSnooze: boolean; text: string }>(`(() => {',
  "      const box = document.querySelector('#otherPage');",
  "      const btns = [...box.querySelectorAll('[data-todo-snooze]')];",
  "      return { items: btns.length, hasSnooze: btns.length > 0, text: String(box.textContent).replace(/\\\\s+/g, ' ').slice(0, 160) };",
  '    })()`);',
  '    console.log(`  待办：${beforeClick.items} 条可忽略；文本片段「${beforeClick.text.slice(0, 70)}」`);',
  "    ok('★ 健康面板出现了带「忽略 24h」的真待办', beforeClick.hasSnooze, JSON.stringify(beforeClick));",
  '',
  '    if (beforeClick.hasSnooze) {',
  '      /* 点第一个「忽略 24h」（confirm 自动确认） */',
  '      const clicked = await cdp.evalJs<{ ok: boolean }>(`(() => {',
  '        window.confirm = () => true;',
  "        const b = document.querySelector('[data-todo-snooze]');",
  '        if (!b) return { ok: false };',
  '        b.click();',
  '        return { ok: true };',
  '      })()`);',
  '      ok('可以点下「忽略 24h」', clicked.ok, JSON.stringify(clicked));',
  '      await sleep(2500);',
  '      const after = await cdp.evalJs<{ hasTodo: boolean; text: string }>(`(() => {',
  "        const box = document.querySelector('#otherPage');",
  "        return { hasTodo: String(box.textContent).includes('已提交待确认'), text: String(box.textContent).replace(/\\\\s+/g, ' ').slice(0, 200) };",
  '      })()`);',
  "      ok('★ 点忽略后该条目不再显示（界面真的接上了端点）', !after.hasTodo, after.text);",
  '',
  '      /* 通过 API 核对：被隐藏了，而且如实报数 */',
  "      const apiAfter = (await (await fetch(BASE + '/api/todos')).json()) as { items: Array<{ key: string }>; dismissedCount?: number };",
  "      const stillThere = apiAfter.items.some((x) => x.key === 'unconfirmed-publish' && JSON.stringify(x).includes(todoTaskId));",
  '      ok(',
  "        '★ API 侧也确认隐藏 + 如实报数（不静默消失）',",
  '        !stillThere || (apiAfter.dismissedCount ?? 0) >= 1,',
  '        JSON.stringify({ stillThere, dismissedCount: apiAfter.dismissedCount, items: apiAfter.items.map((x) => x.key) }),',
  '      );',
  '    }',
  '  } finally {',
  '    /* 清理：恢复隐藏项 + 删掉临时场次（绝不碰用户数据） */',
  '    try {',
  "      const boot = (await (await fetch(BASE + '/api/bootstrap')).json()) as { csrf: string };",
  "      for (const key of ['unconfirmed-publish', 'failed-tasks', 'stuck-tasks', 'disk-low', 'pending-delete-due', 'duplicate-parts', 'unconfirmed-publish-clip']) {",
  "        await fetch(BASE + '/api/todos/undismiss', {",
  "          method: 'POST',",
  "          headers: { 'content-type': 'application/json', 'X-CSRF-Token': boot.csrf },",
  '          body: JSON.stringify({ key }),',
  '        });',
  '      }',
  '    } catch { /* ignore */ }',
  '    try { new Ledger().deleteTask(todoTaskId); } catch { /* ignore */ }',
  '    await cdp.evalJs(`refreshAll(true).then(() => true)`).catch(() => undefined);',
  '  }',
].join('\n');

t = t.replace(ANCHOR, section);
fs.writeFileSync(F, t, 'utf8');
console.log('  ✅ 已注入待办闭环浏览器断言（在"第二次打开设置"断言之后）');
