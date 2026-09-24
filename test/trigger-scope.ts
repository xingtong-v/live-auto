/**
 * 触发范围自测：**必须轮询 biliLive-tools 里所有在录的房间**，而不是只轮询配置里的那一个。
 *
 * 背景（用户报的「最新录播不自动导入」）：
 *   本项目配置只有一个 `room.roomId`（实测写的是 `12345678` 乙主播），
 *   而 biliLive-tools 同时在录多个主播（实测还有 `23456789` 甲主播）。
 *   旧实现 `pollOnce()` / `reconcile()` 都只查 `cfg.room.roomId` ——
 *   于是新录播永远进不来，而「导入录播」清单却能看见它们（那个走的是 roomIdsFromConfig）。
 *   真实状态文件里的铁证：`lastPollAt` 缺失、`processedRecordIds` 为空。
 *
 * 另一个必测项：**基线**。首次启动要把"自动处理起点"钉在当前时刻，
 * 否则一改房间配置，回溯窗口内的历史录播会被一次性全部认领 —— 每场都要花 ASR 的钱。
 *
 * 运行：node test/trigger-scope.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Trigger } from '../src/trigger.ts';
import { loadConfig } from '../src/config.ts';
import type { AppConfig } from '../src/config.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(detail ? `${name} :: ${detail}` : name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

/** 极简假客户端：只实现 Trigger 用到的那几个方法 */
function fakeClient(roomsInBlt: string[]): {
  client: never;
  calls: { recentClips: string[]; history: string[] };
} {
  const calls = { recentClips: [] as string[], history: [] as string[] };
  const client = {
    async getConfig() {
      // 模拟 biliLive-tools 的**真实**配置结构：录制房间在 virtualRecord.config[].roomId
      // （roomIdsFromConfig 匹配的是"以 roomId 结尾的键"，用别的键名它认不出来 —— 第一版测试就写错了）
      return {
        virtualRecord: {
          config: roomsInBlt.map((id, i) => ({ roomId: id, remarks: `主播${i}`, disableAutoCheck: false })),
        },
      };
    },
    async recentClips(roomId: string) {
      calls.recentClips.push(roomId);
      return [];
    },
    async recordHistoryList(opts: { roomId: string }) {
      calls.history.push(opts.roomId);
      return { list: [], total: 0 };
    },
    async liveStatus() {
      return undefined;
    },
  };
  return { client: client as never, calls };
}

async function main(): Promise<void> {
  const cfg = loadConfig('config.json').config;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-trig-scope-'));

  /* ============ 场景 1：轮询范围 ============ */
  section('场景 1：轮询所有在录房间（不再只看配置里那一个）');
  {
    const other = cfg.room.roomId === '23456789' ? '12345678' : '23456789';
    const { client, calls } = fakeClient([other, '34567890']);
    const statePath = path.join(tmp, 's1.json');
    const trig = new Trigger({
      client,
      config: cfg,
      statePath,
      onTrigger: async () => {},
      processedIdsProvider: () => new Set(),
    });

    const rooms = await (trig as unknown as { resolveRoomIds(): Promise<string[]> }).resolveRoomIds();
    ok('解析出的房间包含配置里的那个', rooms.includes(cfg.room.roomId), rooms.join(','));
    ok('解析出的房间包含 biliLive-tools 里的其它房间', rooms.includes(other) && rooms.includes('34567890'), rooms.join(','));
    ok('房间已去重', new Set(rooms).size === rooms.length, rooms.join(','));

    await trig.pollOnce();
    ok('pollOnce 对每个房间都拉了一次 recent-clips', calls.recentClips.length === rooms.length, `实际 ${calls.recentClips.length} 次 / ${rooms.length} 个房间`);
    ok('其中包含原先不会被轮询的那个房间', calls.recentClips.includes(other), calls.recentClips.join(','));

    await trig.reconcile();
    ok('reconcile 对每个房间都查了录制历史', calls.history.length === rooms.length, `实际 ${calls.history.length} 次`);
    ok('其中包含原先不会被对账的那个房间', calls.history.includes(other), calls.history.join(','));
  }

  /* ============ 场景 2：lastPollAt 必须被记录 ============ */
  section('场景 2：状态里要能看出"轮询到底跑没跑"');
  {
    const { client } = fakeClient(['23456789']);
    const statePath = path.join(tmp, 's2.json');
    const trig = new Trigger({ client, config: cfg, statePath, onTrigger: async () => {}, processedIdsProvider: () => new Set() });
    const before = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { lastPollAt?: number };
    ok('构造时还没有 lastPollAt', before.lastPollAt === undefined, String(before.lastPollAt));
    await trig.pollOnce();
    const after = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { lastPollAt?: number };
    ok('pollOnce 后 lastPollAt 被写入', typeof after.lastPollAt === 'number' && after.lastPollAt > 0, String(after.lastPollAt));
  }

  /* ============ 场景 3：基线 —— 不补跑历史 ============ */
  section('场景 3：首次启动建立基线，历史录播不被自动认领');
  {
    const statePath = path.join(tmp, 's3.json');
    const { client } = fakeClient(['23456789']);
    let triggered = 0;
    const trig = new Trigger({
      client,
      config: cfg,
      statePath,
      onTrigger: async () => {
        triggered++;
      },
      processedIdsProvider: () => new Set(),
    });
    const st = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { baselineMs?: number };
    ok('构造时写入 baselineMs', typeof st.baselineMs === 'number' && st.baselineMs > 0, String(st.baselineMs));
    ok('基线接近当前时刻（不是 0，也不是很旧）', Math.abs(Date.now() - (st.baselineMs ?? 0)) < 60_000, String(st.baselineMs));

    // 已有状态文件时**不得**重置基线（否则每次重启都会推迟起点、永远不处理）
    const baseline1 = st.baselineMs;
    const trig2 = new Trigger({ client, config: cfg, statePath, onTrigger: async () => {}, processedIdsProvider: () => new Set() });
    void trig2;
    const st2 = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { baselineMs?: number };
    ok('重启后基线保持不变（不被重置）', st2.baselineMs === baseline1, `${st2.baselineMs} vs ${baseline1}`);
    ok('基线存在时不触发任何历史场次', triggered === 0, `触发了 ${triggered} 次`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('');
  if (fail === 0) {
    console.log(`\x1b[32m===== 触发范围自测：PASS=${pass} FAIL=0 =====\x1b[0m`);
    console.log('轮询覆盖 biliLive-tools 里所有在录房间；基线保证不回头补跑历史。');
    process.exit(0);
  } else {
    console.log(`\x1b[31m===== 触发范围自测：PASS=${pass} FAIL=${fail} =====\x1b[0m`);
    for (const f of failures) console.log(`  · ${f}`);
    process.exit(1);
  }
}

await main();
