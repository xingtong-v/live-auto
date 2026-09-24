/**
 * MCP 接口的单元验证。
 *
 * 这一层的风险不在"能不能跑"，而在**给 Agent 开了多大的口子**：
 * 它能把整条流水线驱动起来，包括删任务、清空回收站、花 ASR 的钱。
 * 所以断言的重点是安全策略，而不是"函数没抛异常"：
 *
 *  1. 危险操作必须**一字不差**的确认串（delete_task 要等于 taskId，purge_trash 要等于「永久删除」）；
 *  2. 没有 token / token 不对一律拒绝（本地服务的口子不能只靠"只有 127.0.0.1"）；
 *  3. 工具内部错误要按 MCP 约定放在 `result.isError`（JSON-RPC error 常被客户端吞掉细节，
 *     Agent 就看不到"为什么失败"、无法自我修正）；
 *  4. 工具定义本身要合法：名字唯一、描述非空、inputSchema 是 object、required 字段都在 properties 里；
 *  5. 每个 handler 调的必须是**真实存在的 orchestrator 方法**（用替身记录调用，防止"文档写了但没接上"）。
 *
 * 全部用替身，零网络、零费用、不碰真实数据。
 *
 * 用法：node test/mcp.ts
 */
import {
  buildMcpTools,
  checkMcpToken,
  generateMcpToken,
  handleMcpMessage,
  PURGE_CONFIRM_PHRASE,
  TOMBSTONE_RELEASE_CONFIRM_PHRASE,
  type McpOrchestrator,
} from '../src/mcp.ts';
import type { AppConfig } from '../src/config.ts';
import type { Logger } from '../src/logger.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string, extra?: string): void {
  if (cond) pass++;
  else {
    fail++;
    failures.push(msg);
  }
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${msg}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`);
}
function eq<T>(msg: string, actual: T, expected: T): void {
  ok(actual === expected, msg, actual === expected ? undefined : `期望 ${String(expected)}，实际 ${String(actual)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

/* ---------------- 替身 ---------------- */

const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined, child: () => quietLogger } as unknown as Logger;

/** 记录所有被调用的编排层方法与参数 —— 用来断言"工具真的接到了已有逻辑上" */
const calls: Array<{ method: string; args: unknown[] }> = [];
const resetCalls = (): void => {
  calls.length = 0;
};
const called = (method: string): boolean => calls.some((c) => c.method === method);

const tasks = [
  {
    id: 'manual-20260922-aaaa',
    status: 'ANALYZED',
    stage: 'ANALYZED',
    title: '来两下闪身步就好了',
    streamer: '甲主播',
    manual: true,
    createdAt: '2026-09-22T18:00:00.000Z',
    source: { rawFiles: ['C:/x/a.flv'], totalDuration: 1590, fullVideoHasDanmaku: false },
    cost: { asrEstimate: 0.88, llmActual: 0.02 },
    clips: [
      { index: 0, status: 'PUBLISHED', selected: true, title: 'A', start: 10, end: 100, tags: ['t'], desc: 'd', bvid: 'BV1xx' },
      { index: 1, status: 'CANDIDATE', selected: true, title: 'B', start: 200, end: 260, tags: [], desc: '' },
    ],
  },
];

function makeOrch(over: Partial<McpOrchestrator> = {}): McpOrchestrator {
  const base = {
    config: {
      mcp: { enabled: true, token: 'mcp-test-token' },
      asr: { unitPricePerHour: 2 },
    } as unknown as AppConfig,
    logger: quietLogger,
    ledger: {
      listTasks: (o: { limit: number }) => {
        calls.push({ method: 'ledger.listTasks', args: [o] });
        return tasks;
      },
      getTask: (id: string) => {
        calls.push({ method: 'ledger.getTask', args: [id] });
        return tasks.find((t) => t.id === id);
      },
      getClips: (id: string) => {
        calls.push({ method: 'ledger.getClips', args: [id] });
        return tasks.find((t) => t.id === id)?.clips ?? [];
      },
      getClip: (id: string, idx: number) => {
        calls.push({ method: 'ledger.getClip', args: [id, idx] });
        return tasks.find((t) => t.id === id)?.clips.find((c) => c.index === idx);
      },
      setClipStatus: (id: string, idx: number, status: string, patch: unknown) => {
        calls.push({ method: 'ledger.setClipStatus', args: [id, idx, status, patch] });
        const c = tasks[0]!.clips.find((x) => x.index === idx);
        return c ? { ...c, ...(patch as object) } : undefined;
      },
      setStatus: (id: string, status: string, extra: unknown) => {
        calls.push({ method: 'ledger.setStatus', args: [id, status, extra] });
      },
      clearError: (id: string) => {
        calls.push({ method: 'ledger.clearError', args: [id] });
      },
      listTombstones: () => {
        calls.push({ method: 'ledger.listTombstones', args: [] });
        return [
          {
            fingerprint: 'fp-tomb-1',
            taskId: 'auto-gone-0001',
            clipIndex: 2,
            title: '旧切片',
            bvid: 'BV1TOMB00001',
            at: '2026-09-23T10:00:00.000Z',
            retiredAt: '2026-09-23T17:00:00.000Z',
            reason: 'task-deleted',
            status: 'PUBLISHED',
          },
        ];
      },
      releaseTombstone: (fp: string, opts: unknown) => {
        calls.push({ method: 'ledger.releaseTombstone', args: [fp, opts] });
        if (fp !== 'fp-tomb-1') return { ok: false, error: '该指纹没有墓碑' };
        return { ok: true, released: { taskId: 'auto-gone-0001', clipIndex: 2, bvid: 'BV1TOMB00001', retiredAt: '2026-09-23T17:00:00.000Z', reason: 'task-deleted', status: 'PUBLISHED' } };
      },
    } as never,
    watcher: {
      status: () => {
        calls.push({ method: 'watcher.status', args: [] });
        return { enabled: true, dirs: ['C:/x'], lastOutcomes: [] };
      },
      scanOnce: async () => {
        calls.push({ method: 'watcher.scanOnce', args: [] });
        return [{ fileName: 'a.flv', skipped: '仍在写入' }];
      },
    },
    glossary: {
      load: () => {
        calls.push({ method: 'glossary.load', args: [] });
        return { anchors: ['甲主播'], terms: [], replacements: [] };
      },
      save: (raw: unknown) => {
        calls.push({ method: 'glossary.save', args: [raw] });
        return { glossary: raw, issues: [] };
      },
      stats: () => ({ anchors: 1, terms: 0, replacements: 0, hotWords: 1 }),
      path: 'data/glossary.json',
    },
    importLocal: async (input: unknown) => {
      calls.push({ method: 'importLocal', args: [input] });
      return { id: 'manual-new' };
    },
    stopTask: async (id: string) => {
      calls.push({ method: 'stopTask', args: [id] });
      return { ok: true };
    },
    enqueue: async (id: string, stage?: string) => {
      calls.push({ method: 'enqueue', args: [id, stage] });
    },
    trash: () => {
      calls.push({ method: 'trash', args: [] });
      return { entries: [] };
    },
    restoreFromTrash: (id: string) => {
      calls.push({ method: 'restoreFromTrash', args: [id] });
      return { ok: true, restored: [id], warnings: [] };
    },
    purgeTrash: (opts: unknown) => {
      calls.push({ method: 'purgeTrash', args: [opts] });
      return { purged: 1, bytes: 10 };
    },
    inspectDeletion: (id: string) => {
      calls.push({ method: 'inspectDeletion', args: [id] });
      return { title: 'x', clipsBytes: 1, clipsFiles: 1, taskDir: 'd' };
    },
    deleteTask: async (id: string, opts?: unknown) => {
      calls.push({ method: 'deleteTask', args: [id, opts] });
      return { ok: true, freedBytes: 1 };
    },
    runSelfCheck: async () => {
      calls.push({ method: 'runSelfCheck', args: [] });
      return { ok: true, steps: [] };
    },
  };
  return { ...base, ...over } as unknown as McpOrchestrator;
}

const INFO = { name: 'live-auto', version: 'test' };
const rpc = (orch: McpOrchestrator, method: string, params?: Record<string, unknown>, id: string | number = 1) =>
  handleMcpMessage(orch, { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, INFO);

const textOf = (r: { result?: unknown } | null): string => {
  const res = r?.result as { content?: Array<{ text: string }> } | undefined;
  return res?.content?.[0]?.text ?? '';
};
const isErr = (r: { result?: unknown } | null): boolean => Boolean((r?.result as { isError?: boolean } | undefined)?.isError);

async function main(): Promise<void> {
  console.log('\x1b[1mMCP 接口验证\x1b[0m（替身编排层，零网络、零费用）');
  console.log('─'.repeat(74));

  /* ================= 1. 握手 ================= */
  section('1. 协议握手');
  {
    const orch = makeOrch();
    const r = await rpc(orch, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } });
    const res = r?.result as { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string }; instructions?: string };
    eq('回显客户端支持的协议版本', res.protocolVersion, '2025-06-18');
    ok(Boolean(res.capabilities.tools), '声明了 tools 能力');
    eq('serverInfo.name', res.serverInfo.name, 'live-auto');
    ok(/list_tasks|retry_stage/.test(res.instructions ?? ''), 'instructions 里给了常用流程提示（Agent 靠它入门）');

    const old = await rpc(makeOrch(), 'initialize', { protocolVersion: '2024-11-05' });
    eq('客户端用旧协议也能协商（回显旧版本）', (old?.result as { protocolVersion: string }).protocolVersion, '2024-11-05');

    const unknown = await rpc(makeOrch(), 'initialize', { protocolVersion: '1999-01-01' });
    eq('未知协议版本 → 回我们最新的', (unknown?.result as { protocolVersion: string }).protocolVersion, '2025-06-18');

    const note = await rpc(makeOrch(), 'notifications/initialized');
    eq('通知不返回响应（MCP 规定，HTTP 层回 202）', note, null);

    const ping = await rpc(makeOrch(), 'ping');
    eq('ping 返回空结果', JSON.stringify(ping?.result), '{}');
  }

  /* ================= 2. 工具定义合法性 ================= */
  section('2. 工具定义（Agent 只能看到这里写的东西，写歪了它就不会用）');
  {
    const tools = buildMcpTools(makeOrch());
    ok(tools.length >= 15, `工具数量 ${tools.length}（覆盖任务/录播/待删/回收站/术语表）`);
    const names = tools.map((t) => t.name);
    eq('名字唯一', new Set(names).size, names.length);
    ok(
      tools.every((t) => t.description.length >= 20),
      '每个工具都有像样的描述（Agent 选工具全靠它）',
    );
    ok(
      tools.every((t) => (t.inputSchema as { type?: string }).type === 'object'),
      'inputSchema 都是 object（MCP 要求）',
    );
    const badRequired: string[] = [];
    for (const t of tools) {
      const s = t.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      for (const r of s.required ?? []) if (!s.properties?.[r]) badRequired.push(`${t.name}.${r}`);
    }
    ok(badRequired.length === 0, 'required 字段都在 properties 里（否则客户端校验会直接拒）', badRequired.join(', '));
    ok(names.includes('retry_stage') && names.includes('list_tasks'), '关键工具存在');
    ok(
      tools.filter((t) => t.readOnly).length >= 8,
      `只读工具 ${tools.filter((t) => t.readOnly).length} 个（先看清楚再动手，是给 Agent 的正确姿势）`,
    );

    // 危险工具必须带确认参数
    const del = tools.find((t) => t.name === 'delete_task')!;
    ok(
      (del.inputSchema as { required?: string[] }).required?.includes('confirm') === true,
      'delete_task 强制要求 confirm 参数',
    );
    const purge = tools.find((t) => t.name === 'purge_trash')!;
    ok(
      (purge.inputSchema as { required?: string[] }).required?.includes('confirm') === true,
      'purge_trash 强制要求 confirm 参数',
    );
  }

  /* ================= 3. tools/list ================= */
  section('3. tools/list');
  {
    const r = await rpc(makeOrch(), 'tools/list');
    const list = (r?.result as { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> }).tools;
    ok(list.length >= 15, `返回 ${list.length} 个工具`);
    ok(
      list.some((t) => t.name === 'list_tasks' && t.annotations?.readOnlyHint === true),
      '只读工具带 readOnlyHint 注解（客户端据此决定要不要提示用户）',
    );
  }

  /* ================= 4. 只读工具真的接到已有逻辑上 ================= */
  section('4. 工具 → 编排层（防止"文档写了但没接上"）');
  {
    let orch = makeOrch();
    resetCalls();
    const r1 = await rpc(orch, 'tools/call', { name: 'list_tasks', arguments: { limit: 5 } });
    ok(called('ledger.listTasks') && !isErr(r1), 'list_tasks 调到了 ledger.listTasks');
    ok(textOf(r1).includes('manual-20260922-aaaa'), '返回里带上了任务 id');
    ok(textOf(r1).includes('甲主播'), '返回里带上了主播名');

    orch = makeOrch();
    resetCalls();
    const r2 = await rpc(orch, 'tools/call', { name: 'get_task', arguments: { taskId: 'manual-20260922-aaaa' } });
    ok(called('ledger.getClips') && !isErr(r2), 'get_task 连带取了切片清单');
    ok(textOf(r2).includes('BV1xx'), '已投稿切片带上了 bvid');

    orch = makeOrch();
    resetCalls();
    const r3 = await rpc(orch, 'tools/call', { name: 'retry_stage', arguments: { taskId: 'manual-20260922-aaaa', fromStage: 'ANALYZED' } });
    ok(called('enqueue') && !isErr(r3), 'retry_stage 入队了');
    const enq = calls.find((c) => c.method === 'enqueue');
    eq('入队的阶段正确', enq?.args[1], 'ANALYZED');
    ok(called('ledger.clearError'), '重跑前清了错误态（否则界面一直显示失败）');

    orch = makeOrch();
    resetCalls();
    await rpc(orch, 'tools/call', { name: 'scan_watch_now', arguments: {} });
    ok(called('watcher.scanOnce'), 'scan_watch_now 调到了轮询器');

    orch = makeOrch();
    resetCalls();
    await rpc(orch, 'tools/call', { name: 'update_glossary', arguments: { terms: ['闪身步'] } });
    const saved = calls.find((c) => c.method === 'glossary.save');
    ok(Boolean(saved), 'update_glossary 调到了术语表保存');
    eq('未传的字段沿用原值（不会把主播名清空）', JSON.stringify((saved?.args[0] as { anchors: string[] }).anchors), JSON.stringify(['甲主播']));

    orch = makeOrch();
    resetCalls();
    await rpc(orch, 'tools/call', { name: 'edit_clip', arguments: { taskId: 'manual-20260922-aaaa', index: 1, title: '新标题', selected: false } });
    const st = calls.find((c) => c.method === 'ledger.setClipStatus');
    ok(Boolean(st), 'edit_clip 通过台账写回');
    ok((st?.args[3] as { edited?: boolean }).edited === true, '标记 edited（界面据此显示"已人工修改"）');
  }

  /* ================= 5. 危险操作必须确认 ================= */
  section('5. 危险操作的确认串（模型没法"顺手"删东西）');
  {
    let orch = makeOrch();
    resetCalls();
    const wrong = await rpc(orch, 'tools/call', { name: 'delete_task', arguments: { taskId: 'manual-20260922-aaaa', confirm: '好的' } });
    ok(isErr(wrong), 'delete_task 确认串不对 → 报错');
    ok(!called('deleteTask'), '**根本没有调用删除**（这才是关键：不是删完再报错）');
    ok(textOf(wrong).includes('manual-20260922-aaaa'), '错误信息里告诉它正确的确认串是什么');

    orch = makeOrch();
    resetCalls();
    const right = await rpc(orch, 'tools/call', { name: 'delete_task', arguments: { taskId: 'manual-20260922-aaaa', confirm: 'manual-20260922-aaaa' } });
    ok(called('deleteTask') && !isErr(right), '确认串正确 → 执行删除');

    orch = makeOrch();
    resetCalls();
    const purgeBad = await rpc(orch, 'tools/call', { name: 'purge_trash', arguments: { confirm: 'delete' } });
    ok(isErr(purgeBad) && !called('purgeTrash'), `purge_trash 确认串不对 → 不执行（正确短语是「${PURGE_CONFIRM_PHRASE}」）`);

    orch = makeOrch();
    resetCalls();
    const purgeOk = await rpc(orch, 'tools/call', { name: 'purge_trash', arguments: { confirm: PURGE_CONFIRM_PHRASE, ids: ['e1'] } });
    ok(called('purgeTrash') && !isErr(purgeOk), '确认串正确 → 执行');
    eq('只删指定条目', JSON.stringify((calls.find((c) => c.method === 'purgeTrash')?.args[0] as { ids: string[] }).ids), JSON.stringify(['e1']));

    // 可逆操作不该要求确认（否则 Agent 会到处碰壁）
    orch = makeOrch();
    resetCalls();
    const cancelR = await rpc(orch, 'tools/call', { name: 'stop_task', arguments: { taskId: 'manual-20260922-aaaa' } });
    ok(called('stopTask') && !isErr(cancelR), 'stop_task 这类可逆操作不需要确认串');
  }

  /* ================= 5b. 墓碑（"为什么这一片没投出去"） ================= */
  section('5b. 墓碑：能查、能解，但解除必须显式确认（解错了会在 B站 上多一个重复稿件）');
  {
    let orch = makeOrch();
    resetCalls();
    const list = await rpc(orch, 'tools/call', { name: 'list_tombstones', arguments: {} });
    ok(!isErr(list) && called('ledger.listTombstones'), 'list_tombstones 是只读工具，不需要确认串');
    ok(textOf(list).includes('BV1TOMB00001'), '返回里带上旧稿件的 bvid（用户要据此去创作中心核对）');
    ok(textOf(list).includes('task-deleted'), '返回里带上立碑原因');

    orch = makeOrch();
    resetCalls();
    const relBad = await rpc(orch, 'tools/call', { name: 'release_tombstone', arguments: { fingerprint: 'fp-tomb-1', confirm: '解除' } });
    ok(isErr(relBad), 'release_tombstone 确认串不对 → 报错');
    ok(!called('ledger.releaseTombstone'), '**根本没有调用解除**（不是解完再报错）');
    ok(textOf(relBad).includes(TOMBSTONE_RELEASE_CONFIRM_PHRASE), '错误信息里告诉它正确的确认串');

    orch = makeOrch();
    resetCalls();
    const relOk = await rpc(orch, 'tools/call', {
      name: 'release_tombstone',
      arguments: { fingerprint: 'fp-tomb-1', confirm: TOMBSTONE_RELEASE_CONFIRM_PHRASE, note: '已核对创作中心' },
    });
    ok(called('ledger.releaseTombstone') && !isErr(relOk), '确认串正确 → 执行解除');
    ok(textOf(relOk).includes('BV1TOMB00001'), '返回被解除的墓碑内容，便于回显给用户');

    orch = makeOrch();
    resetCalls();
    const relMiss = await rpc(orch, 'tools/call', {
      name: 'release_tombstone',
      arguments: { fingerprint: 'fp-不存在', confirm: TOMBSTONE_RELEASE_CONFIRM_PHRASE },
    });
    ok(isErr(relMiss), '解除不存在的墓碑 → isError（而不是假装成功）');
  }

  /* ================= 6. 错误形状 ================= */
  section('6. 错误怎么返回（决定 Agent 能不能自我修正）');
  {
    const unknownTool = await rpc(makeOrch(), 'tools/call', { name: '不存在的工具', arguments: {} });
    ok(isErr(unknownTool), '未知工具 → isError');
    ok(textOf(unknownTool).includes('tools/list'), '提示它去看 tools/list');

    const badStage = await rpc(makeOrch(), 'tools/call', { name: 'retry_stage', arguments: { taskId: 'x', fromStage: '乱写' } });
    ok(isErr(badStage) && textOf(badStage).includes('RECORDED'), '非法阶段 → 报错并列出合法值');

    const noTask = await rpc(makeOrch(), 'tools/call', { name: 'get_task', arguments: { taskId: '不存在' } });
    ok(isErr(noTask), '任务不存在 → isError');

    const badMethod = await rpc(makeOrch(), '不支持的/方法');
    eq('不支持的方法 → JSON-RPC error -32601', badMethod?.error?.code, -32601);

    // 工具内部抛错 → result.isError（不是 JSON-RPC error），否则细节会被客户端吞掉
    const throwing = makeOrch({
      stopTask: async () => {
        throw new Error('队列里没有这个任务');
      },
    });
    const r = await rpc(throwing, 'tools/call', { name: 'stop_task', arguments: { taskId: 'x' } });
    ok(r?.error === undefined, '内部错误不放在 JSON-RPC error 里');
    ok(isErr(r) && textOf(r).includes('队列里没有这个任务'), '而是放在 result.isError，且保留原始错误信息');
  }

  /* ================= 7. token ================= */
  section('7. token 鉴权（本地口子也不能不设防）');
  {
    const token = generateMcpToken();
    ok(/^mcp-[0-9a-f]{48}$/.test(token), '生成的 token 形状正确', token.slice(0, 12) + '…');
    ok(generateMcpToken() !== token, '每次生成都不同');

    const t = 'mcp-abc';
    eq('Authorization: Bearer <token> → 通过', checkMcpToken({ authorization: `Bearer ${t}` }, t).ok, true);
    eq('裸 token（不带 Bearer）也认', checkMcpToken({ authorization: t }, t).ok, true);
    eq('X-MCP-Token 头也认', checkMcpToken({ 'x-mcp-token': t }, t).ok, true);
    eq('没带头 → 拒绝', checkMcpToken({}, t).ok, false);
    eq('token 不对 → 拒绝', checkMcpToken({ authorization: 'Bearer wrong' }, t).ok, false);
    eq('配置为空（未启用）→ 拒绝', checkMcpToken({ authorization: `Bearer ${t}` }, '').ok, false);
    ok(checkMcpToken({}, t).reason?.includes('Authorization') === true, '拒绝时说清了该带什么头');

    // 数组头（Node 允许重复头）取第一个
    eq('重复头取第一个', checkMcpToken({ authorization: [`Bearer ${t}`, 'Bearer x'] }, t).ok, true);
  }

  console.log('\n' + '─'.repeat(74));
  console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('\x1b[31m验证异常：\x1b[0m', e instanceof Error ? e.message : e);
  process.exit(1);
});
