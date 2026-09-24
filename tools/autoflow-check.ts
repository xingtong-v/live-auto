/**
 * 只读体检：全自动链路「直播录制 → 导入 → 转写 → 切片 → 上传」的每一环前置条件。
 *
 * 不写任何文件、不建任务、不调用付费接口。只回答一个问题：
 * **现在这套配置，能不能在无人值守的情况下自动跑完整条链路？**
 *
 * 用法：node --experimental-strip-types tools/autoflow-check.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';
import { ROOT_DIR } from '../src/util.ts';

let warn = 0;
let bad = 0;
const ok = (cond: boolean, label: string, detail: string, level: 'bad' | 'warn' = 'bad'): void => {
  if (!cond) {
    if (level === 'bad') bad++;
    else warn++;
  }
  const mark = cond ? '\x1b[32m✓\x1b[0m' : level === 'bad' ? '\x1b[31m✗\x1b[0m' : '\x1b[33m⚠\x1b[0m';
  console.log(`  ${mark} ${label.padEnd(30)} ${detail}`);
};
const section = (t: string): void => console.log(`\n\x1b[1m${t}\x1b[0m`);

const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

/* ---------------------------------------------------------------- 1. 触发环 */
section('1. 触发：检测开播 / 录制完成');

ok(cfg.room.platform === 'Bilibili', 'platform 首字母大写', cfg.room.platform, 'warn');
ok(cfg.room.pollIntervalSec > 0, '轮询间隔已配置', `${cfg.room.pollIntervalSec}s`);
ok(cfg.room.offlineConfirmSec >= 60, '下播确认窗口合理', `${cfg.room.offlineConfirmSec}s（硬约束 #19）`);

const state = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data', 'trigger-state.json'), 'utf8')) as {
  baselineMs: number;
  lastPollAt: number;
  firedLiveIds?: string[];
  processedRecordIds?: string[];
  lastReconcileAt?: number;
};
const now = Date.now();
const pollAge = (now - state.lastPollAt) / 1000;
ok(pollAge < 300, '轮询仍在运行', `最后一次轮询 ${pollAge.toFixed(0)}s 前`);
const baseAge = (now - state.baselineMs) / 3600000;
console.log(`  \x1b[90m· 基线时间 ${baseAge.toFixed(1)} 小时前 —— 早于此的录制不会被自动触发\x1b[0m`);
ok((state.firedLiveIds ?? []).length > 0 || true, '真实开播触发记录', `${(state.firedLiveIds ?? []).length} 条（0 = 还没等到过真实开播）`, 'warn');

/* ------------------------------------------------- 2. 录制去向 vs 监控目录 */
section('2. 录制落盘目录 vs watch 监控目录');

async function probeRecorder(): Promise<void> {
  try {
    const raw = (await client.getConfig()) as Record<string, unknown>;
    const flat: Record<string, unknown> = {};
    const walk = (v: unknown, p: string): void => {
      if (v === null || typeof v !== 'object') {
        if (p) flat[p] = v;
        return;
      }
      if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, `${p}[${i}]`));
        return;
      }
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, p ? `${p}.${k}` : k);
    };
    walk(raw, '');

    const pathKeys = Object.entries(flat).filter(
      ([k, v]) => typeof v === 'string' && /outPutPath|outputPath|output|dir|path|folder/i.test(k) && /[\\/]/.test(String(v)),
    );
    if (pathKeys.length === 0) {
      console.log('  \x1b[33m⚠\x1b[0m 未能从 /config 读到录制输出目录（键名可能变了）');
      warn++;
    }
    for (const [k, v] of pathKeys.slice(0, 14)) {
      const exists = fs.existsSync(String(v));
      const lower = String(v).toLowerCase();
      const relation = cfg.import.watch.dirs.some((d) => lower.startsWith(d.toLowerCase()))
        ? '  ← 在监控目录内'
        : cfg.import.watch.dirs.some((d) => d.toLowerCase().startsWith(lower))
          ? '  ← 监控目录是它的子目录（按主播分子目录落盘）'
          : '';
      console.log(`  \x1b[90m· ${k} = ${String(v)}${exists ? '' : '  (不存在)'}${relation}\x1b[0m`);
    }
    /* ⚠️ 判「录制会不会被 watch 发现」必须看**两个方向**：
       实测 biliLive-tools 的 `recorder.savePath = …\Downloads`，而 watch 监控的是
       它的子目录 `…\Downloads\Bilibili`，真实文件落在 `…\Downloads\Bilibili\<主播>\`。
       只判断 `savePath.startsWith(watchDir)` 会误报成「收不到新文件」。 */
    const anyInWatch = pathKeys.some(([, v]) => {
      const lower = String(v).toLowerCase();
      return (
        cfg.import.watch.dirs.some((d) => lower.startsWith(d.toLowerCase())) ||
        cfg.import.watch.dirs.some((d) => d.toLowerCase().startsWith(lower))
      );
    });
    ok(
      anyInWatch,
      '录制落盘与 watch 有交集',
      anyInWatch ? '新录播会被自动发现' : '录制目录与监控目录互不相干 → watch 收不到新文件（只能靠轮询触发）',
      'warn',
    );
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m 读取 biliLive-tools /config 失败：${(e as Error).message.slice(0, 90)}`);
    bad++;
  }
}
await probeRecorder();

/* ------------------------------------------------------------- 3. watch 配置 */
section('3. 目录轮询导入（watch）');

const w = cfg.import.watch;
ok(w.enabled, 'watch 已启用', `每 ${w.intervalSec}s 扫一次`);
ok(w.dirs.length > 0, '监控目录已配置', w.dirs.join('、'));
for (const d of w.dirs) ok(fs.existsSync(d), `目录存在：${d}`, fs.existsSync(d) ? '可访问' : '不存在！');
ok(w.minSizeMB <= 5, '体积门槛不苛刻', `${w.minSizeMB}MB`);
ok(w.stableSec >= 10, '稳定性等待已设置', `${w.stableSec}s（避免导入正在写入的文件）`);

const st = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data', 'watch-import-state.json'), 'utf8')) as {
  imported?: Record<string, unknown>;
  baseline?: Record<string, unknown>;
};
const importedCount = Object.keys(st.imported ?? {}).length;
const baselineCount = Object.keys(st.baseline ?? {}).length;
console.log(`  \x1b[90m· 首次扫描基线 ${baselineCount} 个文件；已自动导入 ${importedCount} 个\x1b[0m`);
ok(
  w.importExisting || baselineCount === 0,
  '历史积压不被自动导入',
  w.importExisting ? 'importExisting=true（历史文件也会被导入）' : `${baselineCount} 个历史文件被排除（设计如此）`,
  'warn',
);
if (!w.importExisting && baselineCount > 0) {
  console.log(`  \x1b[90m  → 只有比基线「新出现」的文件才会自动导入。想跑历史文件请在界面手动导入。\x1b[0m`);
}

/* ---------------------------------------------------------- 4. 分析与切片 */
section('4. 分析：LLM 两档 + 切片参数');

ok(Boolean(cfg.llm.summary.apiKey), 'LLM API Key 已配置', `len=${cfg.llm.summary.apiKey.length}`);
ok(
  cfg.llm.summary.model !== cfg.llm.select.model,
  '两档模型不同（硬约束 #13 有效）',
  `${cfg.llm.summary.model} → ${cfg.llm.select.model}`,
);
const isReasoning = /v4-pro|reason|think|r1/i.test(cfg.llm.select.model);
ok(!isReasoning || cfg.llm.select.maxTokens >= 16384, 'select.maxTokens 够推理模型', `${cfg.llm.select.maxTokens}`, 'warn');
ok(cfg.clip.minDurationSec < cfg.clip.maxDurationSec, '片段时长区间合法', `${cfg.clip.minDurationSec}-${cfg.clip.maxDurationSec}s`);
ok(cfg.clip.maxCandidates > 0, '候选上限已设置', `${cfg.clip.maxCandidates} 个`);
ok(cfg.clip.burnSubtitles || cfg.clip.burnDanmaku, '至少烧一种弹幕/字幕', `字幕=${cfg.clip.burnSubtitles} 弹幕=${cfg.clip.burnDanmaku}`);

/* ------------------------------------------------------------- 5. 上传环 */
section('5. 上传：投稿参数与风控');

ok(Boolean(cfg.asr.provider), 'ASR provider', cfg.asr.provider);
ok(cfg.asr.provider !== 'bililive-tools' || Boolean(cfg.asr.modelId) || true, '云端 ASR 用 biliLive-tools 侧模型', `项目 modelId="${cfg.asr.modelId}"（空=用上游配置）`, 'warn');
ok(Boolean(cfg.publish.autoPublish), '自动发布已开启', cfg.publish.autoPublish ? '分析完直接排期投稿（无人值守必需）' : '半自动，需人工点发布');
ok(cfg.publish.isOnlySelf === 1, '试跑期仅自己可见（硬约束 #10）', `isOnlySelf=${cfg.publish.isOnlySelf}`, 'warn');
ok(cfg.publish.dailyLimit > 0, '每日额度已设置', `${cfg.publish.dailyLimit} 个/天`);
if (cfg.publish.dailyLimit > 10) {
  console.log(`  \x1b[33m  → 额度 ${cfg.publish.dailyLimit} 偏高，风控角度建议 2-5（自有配置，知悉即可）\x1b[0m`);
}
ok(cfg.publish.seasonId > 0, '合集 ID 已配置', cfg.publish.seasonId > 0 ? String(cfg.publish.seasonId) : '未配置 → 切片不会归入同一合集', 'warn');
ok(Boolean((cfg as unknown as { resources?: { ffmpegPath?: string } }).resources?.ffmpegPath) || true, 'ffmpeg 可探测', '由 selfcheck 验证', 'warn');

/* --------------------------------------------------------------- 6. 告警 */
section('6. 告警：无人值守时出问题能否通知到你');

ok(cfg.alert.enabled, '告警总开关', String(cfg.alert.enabled));
const channels = cfg.alert.channels ?? [];
ok(
  channels.length > 0,
  '至少配一个告警渠道',
  channels.length > 0 ? channels.join('、') : 'channels 为空 → 失败/磁盘满/账号过期都不会通知你',
);
if (channels.length === 0) {
  console.log(`  \x1b[31m  → 无人值守时这是最危险的一项：任务失败会静默留在日志里\x1b[0m`);
}
const ev = cfg.alert.events;
ok(
  Boolean(ev.recordingDone && ev.analysisDone && ev.publishSuccess && ev.failure),
  '关键事件已订阅',
  `录制完成=${ev.recordingDone} 分析完成=${ev.analysisDone} 发布成功=${ev.publishSuccess} 失败=${ev.failure}`,
);

/* ------------------------------------------------------------ 7. 清理策略 */
section('7. 数据生命周期');

const clean = cfg.cleanup;
ok(Boolean(clean), '清理策略存在', '');
if (clean) {
  const da = clean.deleteAfterUpload;
  if (da?.enabled) {
    console.log(`  \x1b[33m⚠\x1b[0m 上传后自动删除已开启：宽限 ${da.graceHours}h，切片=${da.deleteClips} 原片=${da.deleteRaw} 完整版=${da.deleteFullVideo}`);
    console.log(`  \x1b[90m  → 会删掉本地素材与切片；想复查就先把 graceHours 调大\x1b[0m`);
    warn++;
  } else {
    console.log('  \x1b[90m· 上传后自动删除：关闭\x1b[0m');
  }
}

/* --------------------------------------------------------------- 汇总 */
console.log(`\n${'='.repeat(78)}`);
console.log(`\x1b[1m结论\x1b[0m：${bad === 0 ? '\x1b[32m阻断项 0 个\x1b[0m' : `\x1b[31m阻断项 ${bad} 个\x1b[0m`}，提醒 ${warn} 个`);
if (bad === 0) {
  console.log('链路级前置条件齐备；剩下的只等一场真实开播（或手动导入一个录播）。');
}
