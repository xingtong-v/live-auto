/**
 * 真实触发链路诊断：`/record-history/recent-clips`（自动轮询源）vs `/record-history/list`（全量历史）
 *
 * 为什么需要它：
 *   `data/trigger-state.json` 里 `processedRecordIds` 与 `firedLiveIds` **始终为空** ——
 *   也就是说"全自动"最核心的那一步（直播录完 → 自动开跑）在本机**从未真实发生过**，
 *   所有处理过的场次都是手动导入的。要判断这是"那几天确实没录"还是"触发链路坏了"，
 *   唯一可靠的办法是拿两个接口的真实返回做对比。
 *
 * 已知的两个坑（biliLive-tools 内部实现决定，都不会报错、只会静默返回空数组）：
 *   ① `platform` 必须是 `"Bilibili"`（首字母大写），否则整批被过滤；
 *   ② 房间号必须出现在 biliLive-tools 的 streamer 表里（即它确实录过这个直播间）。
 *
 * 房间清单取自 **biliLive-tools 自己的配置**（它才知道在录哪些主播），
 * 而不是本项目的 config.json —— 后者只有一个默认房间。
 *
 * 只读，不改任何状态。
 *
 * 用法：node --experimental-strip-types tools/trigger-diagnose.ts
 */
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';
import { readJson, exists } from '../src/util.ts';
import type { RecentClip } from '../src/types.ts';

const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

const line = (s: string): void => console.log(s);
line('='.repeat(96));
line('触发链路诊断（真实调用 biliLive-tools，只读）');
line('='.repeat(96));
line(`biliLive-tools: ${cfg.bililive.baseUrl}`);
line(`本项目默认房间: ${cfg.room.roomId} / ${cfg.room.platform}`);
line('');

/* ---- 0) 从 biliLive-tools 配置里取它真正在录的房间 ----
 *
 * ⚠️ 房间号有**三个不同的存放位置**，混用会得出完全错误的结论：
 *   ① `recorders[].channelId` —— **真正的直播录制**配置（这才是"它在录谁"）。
 *   ② `virtualRecord.config[].roomId` —— 文件夹监听（把落盘文件当录播导入）的配置。
 *   ③ `webhook.rooms` —— webhook 回调的房间级覆盖，**可能是遗留项**。
 *   本工具第一版只读 ③，结果只看到遗留的 34567890，误判"本项目默认房间没在录"。
 *   现在三处都读、分别列出，避免再被单一来源误导。
 */
line('--- ⓪ biliLive-tools 里三个房间号来源 ---');
const rooms: Array<{ roomId: string; platform: string; note: string }> = [];
try {
  const bltCfg = (await client.getConfig()) as unknown as Record<string, unknown>;
  const o = ((bltCfg as { data?: unknown }).data ?? bltCfg) as Record<string, unknown>;

  const recorders = (o['recorders'] ?? []) as Array<Record<string, unknown>>;
  const fromRecorders = recorders
    .map((r) => ({ id: String(r['channelId'] ?? ''), provider: String(r['providerId'] ?? 'Bilibili'), remarks: String(r['remarks'] ?? '') }))
    .filter((r) => r.id);
  line(`  ① recorders[].channelId（真实录制）: ${fromRecorders.length} 个`);
  for (const r of fromRecorders) line(`     · ${r.id} (${r.provider}) ${r.remarks}`);

  const vr = (o['virtualRecord'] ?? {}) as Record<string, unknown>;
  const vrCfg = (vr['config'] ?? []) as Array<Record<string, unknown>>;
  const fromVirtual = vrCfg.map((r) => String(r['roomId'] ?? '')).filter(Boolean);
  line(`  ② virtualRecord.config[].roomId（文件夹监听）: ${fromVirtual.length} 个 → ${fromVirtual.join(', ') || '(空)'}`);

  const webhook = (o['webhook'] ?? {}) as Record<string, unknown>;
  const webhookRooms = Object.keys((webhook['rooms'] ?? {}) as Record<string, unknown>);
  line(`  ③ webhook.rooms（回调覆盖，可能是遗留）: ${webhookRooms.length} 个 → ${webhookRooms.join(', ') || '(空)'}`);

  /* 真实录制房间作为权威清单 */
  for (const r of fromRecorders) rooms.push({ roomId: r.id, platform: r.provider, note: `recorders${r.remarks ? ` (${r.remarks})` : ''}` });

  if (!rooms.some((r) => r.roomId === cfg.room.roomId)) {
    line(`  ⚠ 本项目默认房间 ${cfg.room.roomId} 不在 recorders[] 里 —— 它不会为本项目产生新录制`);
  }
  if (fromVirtual.some((id) => !rooms.some((r) => r.roomId === id))) {
    const only = fromVirtual.filter((id) => !rooms.some((r) => r.roomId === id));
    line(`  ⚠ ${only.join(', ')} 只在"文件夹监听"里、不在 recorders[] 里 —— 该房间不会有直播录制，只有落盘文件`);
  }
} catch (e) {
  line(`  ✗ 读取 biliLive-tools 配置失败：${(e as Error).message}`);
}
if (rooms.length === 0) rooms.push({ roomId: cfg.room.roomId, platform: cfg.room.platform, note: '回退到本项目配置' });
line('');

/* ---- 本地触发状态 ---- */
interface TriggerState {
  processedRecordIds?: string[];
  firedLiveIds?: string[];
  baselineMs?: number;
  lastPollAt?: number;
  lastReconcileAt?: number;
  updatedAt?: string;
}
const statePath = 'data/trigger-state.json';
let st: TriggerState = {};
if (exists(statePath)) {
  st = readJson<TriggerState>(statePath);
  line('--- 本地触发状态 data/trigger-state.json ---');
  line(`  已处理录制 id: ${(st.processedRecordIds ?? []).length} 个`);
  line(`  已触发直播 id: ${(st.firedLiveIds ?? []).length} 个`);
  line(`  基线(不处理早于): ${st.baselineMs ? new Date(st.baselineMs).toLocaleString('sv') : '(无)'}`);
  line(`  最后轮询: ${st.lastPollAt ? new Date(st.lastPollAt).toLocaleString('sv') : '(无)'}`);
  line(`  最后对账: ${st.lastReconcileAt ? new Date(st.lastReconcileAt).toLocaleString('sv') : '(无)'}`);
  if ((st.processedRecordIds ?? []).length === 0 && (st.firedLiveIds ?? []).length === 0) {
    line('  ⚠ 两项都为空 = 自动触发从未真实跑过（所有场次都是手动导入的）');
  }
} else {
  line(`(没有 ${statePath})`);
}
line('');

/* ---- 逐房间对比两个接口 ---- */
line('--- ① 逐房间：recent-clips vs record-history/list ---');
let anyRecent = 0;
let anyHistory = 0;
for (const room of rooms) {
  let recent: RecentClip[] = [];
  try {
    recent = await client.recentClips(room.roomId, room.platform as 'Bilibili' | 'DouYu' | 'HuYa');
  } catch (e) {
    line(`  room ${room.roomId}: recent-clips 调用失败 ${(e as Error).message.slice(0, 80)}`);
  }
  let hist: Array<Record<string, unknown>> = [];
  let total = 0;
  try {
    const h = await client.recordHistoryList({ roomId: room.roomId, platform: room.platform, pageSize: 50 });
    hist = h.list as unknown as Array<Record<string, unknown>>;
    total = h.total;
  } catch (e) {
    line(`  room ${room.roomId}: record-history/list 调用失败 ${(e as Error).message.slice(0, 80)}`);
  }
  anyRecent += recent.length;
  anyHistory += hist.length;
  line('');
  line(`  ┌ room ${room.roomId} (${room.platform})`);
  line(`  │ recent-clips: ${recent.length} 条    record-history/list: ${hist.length} 条（total=${total}）`);
  for (const c of recent.slice(0, 5)) {
    /* ⚠️ recent-clips 的字段是**毫秒**时间戳（liveStartTime/recordStartTime/recordEndTime），
       而且**没有 liveEndTime** —— 项目触发逻辑读的是 recordEndTime（见 trigger.ts），
       本工具第一版按"秒 + liveEndTime"解读，结果打印出 `58695-05-06` 这种荒谬日期，
       基线过滤也随之全部失效。单位与字段名都以这里为准。 */
    const ms = (v: number | undefined): string => (v ? new Date(v).toLocaleString('sv') : '?');
    line(
      `  │   [recent] id=${String(c.id)} live=${ms(c.liveStartTime)} ` +
        `rec=${ms(c.recordStartTime)}→${ms(c.recordEndTime)} dur=${c.videoDuration ?? '?'}s size=${c.videoFileSize ?? '?'}B`,
    );
  }
  /* 历史记录里挑最近 5 条（按 record_end_time，单位毫秒） */
  const endOf = (h: Record<string, unknown>): number => Number(h['record_end_time'] ?? h['recordEndTime'] ?? 0);
  const sorted = [...hist].sort((a, b) => endOf(b) - endOf(a));
  for (const h of sorted.slice(0, 5)) {
    const endMs = endOf(h);
    line(
      `  │   [hist]   id=${String(h['id'])} rec_end=${endMs ? new Date(endMs).toLocaleString('sv') : '?'} ` +
        `dur=${String(h['video_duration'] ?? '?')}s size=${String(h['video_file_size'] ?? '?')} ` +
        `title=${String(h['title'] ?? '').slice(0, 30)}`,
    );
  }
  /* 基线过滤影响（单位：毫秒，与 state.baselineMs 同尺度） */
  const baseline = st.baselineMs ?? 0;
  if (baseline > 0) {
    const skipped = sorted.filter((h) => endOf(h) < baseline).length;
    const skipRecent = recent.filter((c) => (c.recordEndTime ?? 0) < baseline).length;
    const after = sorted.length - skipped;
    line(`  │ 基线过滤（按 record_end_time）：history ${skipped}/${sorted.length} 条、recent ${skipRecent}/${recent.length} 条早于基线`);
    line(`  │ ⇒ 基线之后仍有 ${after} 条历史录制，本应由自动触发处理`);
  }
  line('  └');
}

line('');
line('='.repeat(96));
line('结论');
line('='.repeat(96));
line(`  recent-clips 合计 ${anyRecent} 条；record-history/list 合计 ${anyHistory} 条`);
if (anyHistory > 0 && anyRecent === 0) {
  line('  ⚠ 历史里有录制、但 recent-clips 为空 ⇒ **轮询型自动触发拿不到数据**。');
  line('    由于 recent-clips 的窗口很短（只回看最近一小段），历史场次本来就取不到 ——');
  line('    这属于"轮询方式对历史无能为力"，不代表链路坏；但对**新录制**必须能取到。');
} else if (anyHistory > 0 && anyRecent > 0) {
  line('  ✓ 两个接口都有数据 ⇒ 触发链路的数据源是通的（先前为空是因为当时确实没有新录制）。');
} else if (anyHistory === 0) {
  line('  ⚠ 历史里也没有录制 ⇒ biliLive-tools 从未录制过这些房间。');
  line('    这不是本项目的问题：自动触发的前提是 biliLive-tools 真的在录。');
}
line('');
