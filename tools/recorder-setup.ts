/**
 * 把用户指定的直播间加进 biliLive-tools 的录制列表，并启动录制。
 *
 * 为什么要用脚本而不是手点界面：
 *   1. 要复现「本项目项目间协作」的那套配置（分段 59 分钟、sendToWebhook、
 *      不开"上传后删除素材"），手点容易漏；
 *   2. 每一步都要在日志里留下凭据 —— 录制是零费用的，但**投稿不是**，
 *      必须确保新增房间不会自动上传（`afterUploadDeletAction` 与上传预设）。
 *
 * 三种模式（互斥，默认 --preview）：
 *   --preview            只读出并打印「将要写入什么」，不改任何东西
 *   --apply              真正调用 /recorder/add
 *   --start              调用 /recorder/manager/batch_start_record 开始录制
 *   --stop               调用 /recorder/manager/batch_stop_record 停止录制
 *
 * ⚠️ 硬约束 #1：只通过 HTTP API 操作 biliLive-tools，绝不 fork/改它的源码。
 *
 * 用法：
 *   node --experimental-strip-types tools/recorder-setup.ts --preview --room 45678901
 *   node --experimental-strip-types tools/recorder-setup.ts --apply   --room 45678901
 */
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const argv = process.argv.slice(2);
const has = (f: string): boolean => argv.includes(f);
const argOf = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const roomId = argOf('--room') ?? '';
const mode = has('--apply')
  ? 'apply'
  : has('--start')
    ? 'start'
    : has('--stop')
      ? 'stop'
      : has('--restore-webhook')
        ? 'restore-webhook'
        : has('--info')
          ? 'info'
          : 'preview';

const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

/** api.ts 没暴露这些端点，直接借它的 request（保持同样的重试/脱敏/日志纪律） */
type Req = <T>(path: string, opts: Record<string, unknown>) => Promise<T>;
const req = (client as unknown as { request: Req }).request.bind(client) as Req;

const line = (s = ''): void => console.log(s);

interface Recorder {
  id?: string;
  providerId?: string;
  channelId?: string;
  remarks?: string;
  segment?: string | number;
  sendToWebhook?: boolean;
  autoRecord?: boolean;
  state?: string;
  [k: string]: unknown;
}

/** 把 webhook 配置写回去。
 *
 * ⚠️ 端点名是 `/config/set`（实测 `/config/save` 返回 404 —— asar 里只有
 *    `/config/set`、`/config/export`、`/config/import`、`/config/reset-bin` 等）。
 * body 传**完整的 webhook 段**：不猜它是深合并还是整段替换，传全量最安全。 */
async function saveWebhook(next: Record<string, unknown>): Promise<void> {
  await req('/config/set', {
    method: 'POST',
    body: { webhook: next },
    purpose: '更新 webhook 配置（关闭/恢复自动上传）',
    tag: 'recorder',
  });
}

/* ---- 0) 全局录制规则（决定新房间的继承行为） ---- */
const bltCfg = ((await client.getConfig()) as unknown as { data?: unknown }).data ?? (await client.getConfig());
const o = bltCfg as Record<string, unknown>;
const webhook = (o['webhook'] ?? {}) as Record<string, unknown>;
const recorderGlobal = (o['recorder'] ?? {}) as Record<string, unknown>;

line('='.repeat(96));
line(`biliLive-tools 录制器配置${roomId ? `（目标房间 ${roomId}）` : ''}  模式=${mode}`);
line('='.repeat(96));
line('全局录制规则：');
for (const k of ['savePath', 'nameRule', 'autoRecord', 'quality', 'segment', 'videoFormat', 'recorderType']) {
  line(`  recorder.${k} = ${JSON.stringify(recorderGlobal[k])}`);
}
line('全局 webhook（biliLive-tools 自己的自动化，与本项目无关）：');
for (const k of ['open', 'minSize', 'title', 'danmu', 'autoPartMerge', 'partMergeMinute', 'uploadNoDanmu', 'uploadToSameMedia', 'afterUploadDeletAction', 'uploadPresetId', 'uid']) {
  line(`  webhook.${k} = ${JSON.stringify(webhook[k])}`);
}
line('');

/* ---- 0b) ⚠️ 安全闸门：录制期间必须关掉 biliLive-tools 自己的自动上传 ----
 *
 * 为什么这是**必须**的一步（实测配置决定）：
 *   全局 `webhook.open=true` 且带 `uid=1000000000000000` + `uploadPresetId="default"` ——
 *   这意味着**任何**新录制的房间，录制完成后都会被 biliLive-tools 自动投稿到 B站账号。
 *   本次只是为了验证本项目的触发链路，绝不能顺手往账号里投一个别人的 9 万人气直播间录播：
 *     · 会占用每日投稿额度（实测账号今日已投 54）；
 *     · 会在账号的投稿历史里留下无关稿件；
 *     · 3 分钟的小分段还会触发 `minSize=20MB` 过滤，行为难以预测。
 *
 *   关掉 `webhook.open` 不影响本项目：本项目通过 `recent-clips` / `record-history/list`
 *   感知录制完成（见 src/trigger.ts），与 webhook 开关无关。
 */
line('⚠️ 安全闸门：biliLive-tools 的全局 webhook = ' + (webhook['open'] ? '\x1b[31m开启（会自动上传录播）\x1b[0m' : '\x1b[32m已关闭\x1b[0m'));
if (webhook['open'] && mode !== 'preview' && mode !== 'info') {
  const next = { ...webhook, open: false };
  await saveWebhook(next);
  line('  → 已临时关闭全局 webhook（录制期间不会自动上传）。测试结束后请用 --restore 恢复。');
  line('    恢复命令：node --experimental-strip-types tools/recorder-setup.ts --restore-webhook');
} else if (webhook['open']) {
  line('  （预览模式，未改动。--apply 时会自动关闭它）');
}
line('');

if (mode === 'restore-webhook') {
  const next = { ...webhook, open: true };
  await saveWebhook(next);
  line('✓ 已恢复全局 webhook（open=true）。');
  process.exit(0);
}


/* ---- 1) 现有 recorders ----
 *
 * ⚠️ 两个都实测踩过的坑：
 *   · `/recorder/list` 的真实返回是 `{payload:{data:[...]}}` —— 第一版只认 `data`，
 *     于是把"3 个 recorder"读成"0 个"，还据此写了错误的注释。
 *   · `/config.recorders` 是**启动时的快照**，新 `--apply` 加进去的房间不在里面，
 *     所以不能拿它复核"刚加成功没有"。
 *   结论：一律以 `/recorder/list` 的 `payload.data` 为准（它是活的）。
 */
function unwrapList(raw: unknown): Recorder[] {
  if (Array.isArray(raw)) return raw as Recorder[];
  const o = raw as { data?: unknown; payload?: { data?: unknown } } | null;
  const inner = o?.payload?.data ?? o?.data;
  if (Array.isArray(inner)) return inner as Recorder[];
  return [];
}

const listed = await req<unknown>('/recorder/list', { purpose: '读取录制列表', tag: 'recorder' });
let recorders = unwrapList(listed);
line(`现有录制房间：${recorders.length} 个`);
if (recorders.length === 0) {
  const fromConfig = (o['recorders'] ?? []) as Recorder[];
  if (fromConfig.length > 0) {
    line(`  （/recorder/list 为空，退回 /config.recorders 的 ${fromConfig.length} 个——注意那是启动快照）`);
    recorders = fromConfig;
  }
}
for (const r of recorders) {
  line(
    `  · ${String(r.channelId)} (${String(r.providerId)}) ${String(r.remarks ?? '')}` +
      ` segment=${String(r.segment ?? '(全局)')} sendToWebhook=${String(r.sendToWebhook ?? '(全局)')} autoRecord=${String(r.autoRecord ?? '(全局)')}`,
  );
}
line('');

if (mode === 'info' || !roomId) {
  if (!roomId && mode !== 'info') line('（未指定 --room，只做信息展示）');
  process.exit(0);
}

const existing = recorders.find((r) => String(r.channelId) === roomId);
if (existing) {
  line(`⚠ 房间 ${roomId} 已在录制列表里（id=${String(existing.id)}），跳过 add。`);
}
line('');

/* ---- 2) 解析直播间（拿 uid / 主播名，让 remarks 可读） ---- */
interface LiveInfo {
  roomId?: string | number;
  uid?: string | number;
  uname?: string;
  username?: string;
  title?: string;
  liveStatus?: number;
  [k: string]: unknown;
}
/* ⚠️ 解析端点实测都不可用（保持只读探测，失败就继续，用房间号当备注）：
     - /recorder/manager/resolve-channel  → HTTP 405（不是 POST）
     - /recorder/manager/resolve          → HTTP 405
     - /recorder/manager/live-info        → HTTP 500（"Cannot read properties of undefined"）
   所以这里只在能拿到信息时才用，拿不到就用 `room-<id>` 兜底，不阻塞流程。 */
let info: LiveInfo | undefined;
const resolveBody = { channelId: roomId, providerId: 'Bilibili', roomId, id: roomId };
for (const path of ['/recorder/manager/resolve-channel', '/recorder/manager/resolve', '/recorder/manager/live-info']) {
  try {
    const r = await req<{ data?: LiveInfo } | LiveInfo>(path, {
      method: 'POST',
      body: resolveBody,
      purpose: `解析直播间（${path}）`,
      tag: 'recorder',
      quiet: true,
      retry: 0,
      timeoutMs: 5000,
    });
    const d = (Array.isArray(r) ? r[0] : ((r as { data?: LiveInfo }).data ?? r)) as LiveInfo;
    if (d && (d.uid || d.uname || d.username || d.roomId)) {
      info = d;
      line(`解析成功（${path}）：`);
      line(`  roomId=${String(d.roomId ?? '')} uid=${String(d.uid ?? '')} 主播=${String(d.uname ?? d.username ?? '')} 标题=${String(d.title ?? '').slice(0, 40)}`);
      break;
    }
  } catch {
    /* 端点不可用是常态，静默跳过（上面注释已记录实测结果） */
  }
}
if (!info) {
  line('（解析端点不可用，主播名留空 —— 用 B站 匿名接口补一次）');
  /* 注意：`room/v1/Room/get_info` 的 data 里**没有 uname 字段**（第一版就踩了这个，
     remarks 变成空串）。主播名要另外查 `live_user/v1/UserInfo/get_anchor_in_room`。 */
  try {
    const r = await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://live.bilibili.com/' },
    });
    const j = (await r.json()) as { data?: Record<string, unknown> };
    const d = j.data ?? {};
    let uname = '';
    try {
      const r2 = await fetch(
        `https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room?roomid=${roomId}`,
        { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://live.bilibili.com/' } },
      );
      const j2 = (await r2.json()) as { data?: { info?: { uname?: string } } };
      uname = String(j2.data?.info?.uname ?? '');
    } catch {
      /* 拿不到主播名不致命 */
    }
    info = {
      roomId,
      ...(d['uid'] ? { uid: d['uid'] as number } : {}),
      uname,
      title: String(d['title'] ?? ''),
    };
    line(
      `  B站 匿名接口：uid=${String(d['uid'] ?? '?')} 主播=${uname || '(未取到)'} ` +
        `标题=${String(d['title'] ?? '').slice(0, 30)} 开播中=${d['live_status'] === 1} 人气=${String(d['online'] ?? '?')}`,
    );
  } catch (e) {
    line(`  B站 匿名接口也不可用：${(e as Error).message.slice(0, 70)}`);
  }
}
line('');

/* ---- 3) 构造要写入的 recorder ---- */
const remarks = String(info?.uname ?? '').trim() || (info?.uid ? `uid-${String(info.uid)}` : `room-${roomId}`);
/* 字段与现有 recorders 对齐；关键几项显式写死，避免继承到"会自动上传"的全局值：
   - sendToWebhook: true  → 录制完成后走 webhook（本项目感知路径之一）
   - autoRecord: true     → 开播自动开始录制
   - afterUploadDeletAction: 'none' → 硬约束 #11：绝不让它删素材
   - segment: '59'        → 与现有两个房间一致（单位是**分钟**，实测确认） */
const payload: Recorder = {
  providerId: 'Bilibili',
  channelId: roomId,
  remarks,
  disableAutoCheck: false,
  quality: 10000,
  segment: '59',
  sendToWebhook: true,
  autoRecord: true,
  saveGiftDanma: false,
  saveSCDanma: true,
  saveCover: true,
  videoFormat: 'auto',
  formatName: 'auto',
  codecName: 'auto',
  recorderType: 'bililive',
  source: 'auto',
  useM3U8Proxy: true,
  afterUploadDeletAction: 'none',
};

line('将要写入的 recorder（--apply 时才真正提交）：');
line(JSON.stringify(payload, null, 2));
line('');

if (mode === 'preview') {
  line('（预览模式，未做任何修改。确认无误后加 --apply）');
  process.exit(0);
}

/* ---- 4) 应用 ---- */
if (mode === 'apply') {
  if (existing) {
    line(`房间已存在（id=${String(existing.id)}），跳过 /recorder/add。`);
  } else {
    const r = await req<unknown>('/recorder/add', {
      method: 'POST',
      body: payload,
      purpose: '添加录制房间',
      tag: 'recorder',
    });
    line(`/recorder/add 返回：${JSON.stringify(r).slice(0, 200)}`);
    /* 复核必须重新拉一次**活的**列表（不能读 /config 的启动快照） */
    const after = unwrapList(await req<unknown>('/recorder/list', { purpose: '复核录制列表', tag: 'recorder' }));
    const added = after.find((x) => String(x.channelId) === roomId);
    if (added) {
      line(
        `✓ 已确认写入：${JSON.stringify({
          id: added.id,
          channelId: added.channelId,
          remarks: added.remarks,
          segment: added.segment,
          sendToWebhook: added.sendToWebhook,
          state: added.state,
        })}`,
      );
      recorders = after; // 后续 start/stop 要用这个含新房间的列表
    } else {
      line('✗ 活的录制列表里没找到刚加的房间（/recorder/add 可能未持久化）');
    }
  }
}

/** 取目标房间的 recorder id（start/stop 都靠它，比 channelIds 可靠） */
const targetIds = recorders.filter((r) => String(r.channelId) === roomId && r.id).map((r) => String(r.id));

if (mode === 'start' || mode === 'apply') {
  if (targetIds.length === 0) {
    line('✗ 拿不到该房间的 recorder id，无法开始录制（先跑一次不带 --start 的 --apply 让房间落库）');
  } else {
    const rs = await req<unknown>('/recorder/manager/batch_start_record', {
      method: 'POST',
      body: { ids: targetIds },
      purpose: '开始录制',
      tag: 'recorder',
    });
    line(`/recorder/manager/batch_start_record(ids=${targetIds.join(',')}) 返回：${JSON.stringify(rs).slice(0, 300)}`);
  }
}

if (mode === 'stop') {
  if (targetIds.length === 0) {
    line('✗ 拿不到该房间的 recorder id，无法停止录制');
  } else {
    const rs = await req<unknown>('/recorder/manager/batch_stop_record', {
      method: 'POST',
      body: { ids: targetIds },
      purpose: '停止录制',
      tag: 'recorder',
    });
    line(`/recorder/manager/batch_stop_record(ids=${targetIds.join(',')}) 返回：${JSON.stringify(rs).slice(0, 300)}`);
  }
}

/* ---- 5) 复核：录制任务状态 ---- */
try {
  const t = await client.taskList({ type: 'record', page: 1, pageSize: 10 });
  const tl = t.list ?? [];
  line('');
  line(`录制任务：runningTaskNum=${t.runningTaskNum}，共 ${tl.length} 条`);
  for (const it of tl.slice(0, 5)) line(`  · ${JSON.stringify(it).slice(0, 200)}`);
} catch (e) {
  line(`读取录制任务失败：${(e as Error).message.slice(0, 100)}`);
}
line('');
