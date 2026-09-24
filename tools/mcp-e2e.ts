/**
 * MCP 端到端实测：对着**真实运行的服务**走一遍 Agent 会遇到的全流程。
 *
 * 为什么必须有这一层：单测用的是替身编排层，证明不了「HTTP 挂载点、鉴权、SSE 帧、
 * 真实编排层调用」这些串起来是通的 —— 而 Agent 面对的正是这些。
 *
 * 只做只读调用 + 一次确认串失败的删除（不会真删任何东西）。
 *
 * 用法：node tools/mcp-e2e.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config.json'), 'utf8')) as {
  mcp?: { enabled?: boolean; token?: string };
  ui?: { host?: string; port?: number };
};
const host = cfg.ui?.host ?? '127.0.0.1';
const port = cfg.ui?.port ?? 3000;
const url = `http://${host}:${port}/mcp`;
const token = cfg.mcp?.token ?? '';

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
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

interface RpcResponse {
  jsonrpc: string;
  id: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function rpc(method: string, params?: Record<string, unknown>, opts: { token?: string | null; accept?: string; id?: number } = {}): Promise<{ status: number; body: RpcResponse | null; raw: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const t = opts.token === undefined ? token : opts.token;
  if (t) headers['Authorization'] = `Bearer ${t}`;
  if (opts.accept) headers['Accept'] = opts.accept;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: opts.id ?? 1, method, ...(params ? { params } : {}) }),
  });
  const raw = await res.text();
  let body: RpcResponse | null = null;
  try {
    // SSE 帧：取 data: 那一行
    const line = raw.split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : raw) as RpcResponse;
  } catch {
    body = null;
  }
  return { status: res.status, body, raw };
}

const textOf = (r: { body: RpcResponse | null }): string => {
  const c = (r.body?.result as { content?: Array<{ text: string }> } | undefined)?.content;
  return c?.[0]?.text ?? '';
};

async function main(): Promise<void> {
  console.log(`\x1b[1mMCP 端到端实测\x1b[0m  ${url}`);
  console.log('─'.repeat(74));
  ok(Boolean(token), 'config.json 里已有 token', token ? `${token.slice(0, 12)}…` : '（缺失）');
  if (!token) process.exit(1);

  /* ---------------- 鉴权 ---------------- */
  section('1. 鉴权（本地口子也得设防）');
  {
    const noToken = await rpc('tools/list', undefined, { token: null });
    ok(noToken.status === 401, '不带 token → 401', `HTTP ${noToken.status}`);
    const wrong = await rpc('tools/list', undefined, { token: 'mcp-wrong' });
    ok(wrong.status === 401, 'token 不对 → 401', `HTTP ${wrong.status}`);
    const okR = await rpc('tools/list', undefined, { id: 2 });
    ok(okR.status === 200, 'token 正确 → 200', `HTTP ${okR.status}`);
  }

  /* ---------------- 握手 ---------------- */
  section('2. 握手与工具清单');
  let toolCount = 0;
  {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-e2e', version: '1' } }, { id: 3 });
    const res = init.body?.result as { protocolVersion?: string; serverInfo?: { name?: string }; capabilities?: { tools?: unknown } } | undefined;
    ok(res?.protocolVersion === '2025-06-18', '协议版本协商成功', res?.protocolVersion);
    ok(res?.serverInfo?.name === 'live-auto', 'serverInfo 正确', res?.serverInfo?.name);
    ok(Boolean(res?.capabilities?.tools), '声明了 tools 能力');

    const note = await rpc('notifications/initialized', undefined, { id: 4 });
    ok(note.status === 202, '通知回 202（不是 200+空 result）', `HTTP ${note.status}`);

    const list = await rpc('tools/list', undefined, { id: 5 });
    const tools = (list.body?.result as { tools?: Array<{ name: string; description: string; annotations?: { readOnlyHint?: boolean } }> })?.tools ?? [];
    toolCount = tools.length;
    ok(tools.length >= 15, `列出 ${tools.length} 个工具`);
    ok(tools.every((t) => t.name && t.description), '每个工具都有名字和描述');
    ok(tools.some((t) => t.annotations?.readOnlyHint), '只读工具带 readOnlyHint');

    const sse = await rpc('tools/list', undefined, { id: 6, accept: 'application/json, text/event-stream' });
    ok(sse.raw.startsWith('event: message'), '要求 SSE 时按 SSE 帧返回（部分客户端只认这种）', sse.raw.slice(0, 24));
    ok(Array.isArray((sse.body?.result as { tools?: unknown[] })?.tools), 'SSE 帧里也能解析出工具清单');
  }

  /* ---------------- 只读调用 ---------------- */
  section('3. 只读工具（真实编排层）');
  {
    const r = await rpc('tools/call', { name: 'list_tasks', arguments: { limit: 5 } }, { id: 10 });
    ok(!(r.body?.result as { isError?: boolean })?.isError, 'list_tasks 成功');
    const parsed = JSON.parse(textOf(r)) as { count: number; tasks: unknown[] };
    ok(typeof parsed.count === 'number', `返回结构可用（${parsed.count} 个任务）`);

    const w = await rpc('tools/call', { name: 'get_watch_status', arguments: {} }, { id: 11 });
    const wj = JSON.parse(textOf(w)) as { enabled?: boolean; intervalSec?: number };
    ok(wj.intervalSec !== undefined, 'get_watch_status 拿到了轮询配置', `每 ${wj.intervalSec}s`);

    const pd = await rpc('tools/call', { name: 'list_pending_delete', arguments: {} }, { id: 12 });
    const pdj = JSON.parse(textOf(pd)) as { stats?: { pendingCount?: number } };
    ok(pdj.stats !== undefined, 'list_pending_delete 拿到了统计', `待删 ${pdj.stats?.pendingCount} 项`);

    const gl = await rpc('tools/call', { name: 'get_glossary', arguments: {} }, { id: 13 });
    const glj = JSON.parse(textOf(gl)) as { anchors?: string[] };
    ok(Array.isArray(glj.anchors), 'get_glossary 拿到了术语表', `主播：${(glj.anchors ?? []).join('、')}`);

    const rec = await rpc('tools/call', { name: 'list_recordings', arguments: { limit: 5 } }, { id: 14 });
    ok(!(rec.body?.result as { isError?: boolean })?.isError, 'list_recordings 成功（会真扫盘）');
  }

  /* ---------------- 未配对工具的写操作：只测确认串，不真删 ---------------- */
  section('4. 危险操作的守卫（不真的执行）');
  {
    const bad = await rpc('tools/call', { name: 'delete_task', arguments: { taskId: 'manual-not-exist', confirm: '好啊' } }, { id: 20 });
    ok((bad.body?.result as { isError?: boolean })?.isError === true, 'delete_task 确认串不对 → 拒绝');
    ok(textOf(bad).includes('必须等于'), '错误里说明了正确的确认串', textOf(bad).slice(0, 80));

    const purge = await rpc('tools/call', { name: 'purge_trash', arguments: { confirm: 'yes' } }, { id: 21 });
    ok((purge.body?.result as { isError?: boolean })?.isError === true, 'purge_trash 确认串不对 → 拒绝');

    const unknown = await rpc('tools/call', { name: 'rm_rf_everything', arguments: {} }, { id: 22 });
    ok((unknown.body?.result as { isError?: boolean })?.isError === true, '未知工具 → isError');
  }

  /* ---------------- 非 POST ---------------- */
  section('5. 传输层细节');
  {
    const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { transport?: string; endpoint?: string };
    ok(res.status === 200 && body.transport === 'streamable-http', 'GET 返回传输形态说明（便于人工排查）');
    const res2 = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    ok(res2.status === 405, '不支持的方法 → 405', `HTTP ${res2.status}`);
  }

  console.log('\n' + '─'.repeat(74));
  console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m（共 ${toolCount} 个工具）`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('\x1b[31m实测异常：\x1b[0m', e instanceof Error ? e.message : e);
  process.exit(1);
});
