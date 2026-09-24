/**
 * 精确修改 biliLive-tools 的一个配置字段（GET /config → 改一个键 → POST /config）。
 *
 * 为什么需要它：录制期间必须关掉 biliLive-tools 自己的**自动上传**（`webhook.open`），
 * 否则录制完成后会把录播自动投稿到 B站 账号 —— 本次只是验证本项目的触发链路，
 * 不该顺手往账号里投别人的直播间录播。
 *
 * 实测过的端点语义（从 app.asar 里读出来的真实实现）：
 *   · `GET  /config`      → `appConfig.getAll()`，返回完整配置
 *   · `POST /config`      → `appConfig.setAll(ctx.request.body)`，**整段替换**
 *   · `GET  /config/get`  → `appConfig.get(key)`，key 走 query
 *   · `/config/set`       → 存在但入参形状未能确定（传 `{key,value}` 与 `{path,value}`
 *                           都被拒为 "key and value is required"），所以不用它
 *
 * 所以这里的做法是「读全量 → 改一个键 → 写全量」，把改动面压到最小。
 *
 * 用法：
 *   node --experimental-strip-types tools/blt-config-set.ts --get webhook.open
 *   node --experimental-strip-types tools/blt-config-set.ts --set webhook.open=false
 */
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });
type Req = <T>(path: string, opts: Record<string, unknown>) => Promise<T>;
const req = (client as unknown as { request: Req }).request.bind(client) as Req;

const argv = process.argv.slice(2);
const line = (s = ''): void => console.log(s);

async function getAll(): Promise<Record<string, unknown>> {
  const raw = await req<unknown>('/config', { purpose: '读取完整配置', tag: 'config' });
  const o = ((raw as { data?: unknown })?.data ?? raw) as Record<string, unknown>;
  if (!o || typeof o !== 'object') throw new Error('GET /config 返回的不是对象');
  return o;
}

function parseValue(s: string): unknown {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  /* ⚠️ 空数组/空对象要能表达：`--set llmPresets=` 会把值设成**空字符串**，
     而原值是 `[]` —— 类型都变了。所以支持 `[]` / `{}` 直接写，
     以及其他以 [ 或 { 开头的 JSON 字面量。 */
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      /* 不是合法 JSON 就按字符串处理 */
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

const getArg = argv.includes('--get') ? argv[argv.indexOf('--get') + 1] : undefined;
const setArg = argv.includes('--set') ? argv[argv.indexOf('--set') + 1] : undefined;

if (getArg) {
  const all = await getAll();
  const parts = getArg.split('.');
  let cur: unknown = all;
  for (const p of parts) cur = (cur as Record<string, unknown>)?.[p];
  line(`${getArg} = ${JSON.stringify(cur)}`);
  process.exit(0);
}

if (!setArg) {
  line('用法：--get webhook.open   或   --set webhook.open=false');
  process.exit(1);
}

const eq = setArg.indexOf('=');
if (eq < 0) {
  line(`参数格式应为 key=value，收到：${setArg}`);
  process.exit(1);
}
const keyPath = setArg.slice(0, eq);
const value = parseValue(setArg.slice(eq + 1));
const parts = keyPath.split('.');

const all = await getAll();
line('='.repeat(84));
line(`准备把 ${keyPath} 设为 ${JSON.stringify(value)}`);
line('='.repeat(84));

/* 读旧值 */
let cur: unknown = all;
for (const p of parts) cur = (cur as Record<string, unknown>)?.[p];
const before = cur;
line(`  旧值：${JSON.stringify(before)}`);

/* 写新值（在副本上改，避免污染读到的对象） */
const clone = structuredClone(all);
let node = clone as Record<string, unknown>;
for (const p of parts.slice(0, -1)) {
  const next = node[p];
  if (!next || typeof next !== 'object') {
    line(`  ✗ 路径 ${keyPath} 的父级 ${p} 不存在，拒绝写入（不猜结构）`);
    process.exit(1);
  }
  node = next as Record<string, unknown>;
}
const last = parts[parts.length - 1]!;
node[last] = value;

/* 提交全量 */
try {
  const r = await req<unknown>('/config', { method: 'POST', body: clone, purpose: '写回配置（只改了一个键）', tag: 'config' });
  line(`  POST /config 返回：${JSON.stringify(r).slice(0, 120)}`);
} catch (e) {
  line(`  ✗ POST /config 失败：${(e as Error).message.slice(0, 150)}`);
  process.exit(1);
}

/* 复核 */
const after = await getAll();
let cur2: unknown = after;
for (const p of parts) cur2 = (cur2 as Record<string, unknown>)?.[p];
line(`  新值：${JSON.stringify(cur2)}`);
line(
  cur2 === value
    ? '  ✓ 已生效'
    : '  ✗ 未生效 —— 需要改为手工在 biliLive-tools 界面里改（或停掉它改 appConfig.json）',
);
line('');
