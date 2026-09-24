/**
 * 录播素材清单：扫描本机可用的录播文件，给出时长、弹幕配套、ASR 缓存与预估费用。
 *
 * 用途：跑真实全流程前先看清「有哪些素材、跑一场要花多少钱、哪些已经付过费」，
 * 并**识别出损坏文件**（录制中断导致 MP4 没有 moov atom，ffprobe 读不出时长）。
 *
 * 用法：
 *   node tools/list-recordings.ts                 # 扫描默认目录
 *   node tools/list-recordings.ts --dir <目录>     # 指定目录（不递归到已扫描的父目录，避免重复）
 *   node tools/list-recordings.ts --json          # 机器可读
 *   node tools/list-recordings.ts --all           # 连损坏文件一起列
 */
import fs from 'node:fs';
import path from 'node:path';
import { AsrCache, Transcriber } from '../src/asr.ts';
import { BiliLiveClient } from '../src/api.ts';
import { ConfigStore } from '../src/config.ts';
import { probeMedia, type ProbeResult } from '../src/media.ts';
import { exists, fileSize, fmtBytes, fmtDuration } from '../src/util.ts';
import { log } from '../src/logger.ts';

const JSON_ONLY = process.argv.includes('--json');
const SHOW_ALL = process.argv.includes('--all');
const dirArgIdx = process.argv.indexOf('--dir');

interface Entry {
  video: string;
  name: string;
  group: string;
  sizeBytes: number;
  durationSec: number;
  resolution: string;
  codec: string;
  /** 同名弹幕文件 */
  danma?: string;
  danmaKind?: string;
  /** 文件是否可解析（损坏文件会被排除在推荐之外） */
  usable: boolean;
  brokenReason?: string;
  estCost: number;
  cacheHit: number;
  windows: number;
}

/** 递归收集视频文件；用 realpath 去重，避免「父目录 + 子目录」重复扫同一批文件 */
function scanVideos(roots: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (p: string): void => {
    let key: string;
    try {
      key = fs.realpathSync.native(p);
    } catch {
      key = path.resolve(p);
    }
    key = key.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  for (const root of roots) {
    if (!exists(root)) continue;
    const walk = (d: string, depth: number): void => {
      if (depth > 4) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (/\.(flv|ts|mp4|mkv|m4s)$/i.test(e.name)) add(full);
      }
    };
    walk(root, 0);
  }
  return out;
}

/** 找出与视频同名的弹幕文件（.xml 优先于 .ass，与任务书 §4.1 的信令口径一致） */
function findDanma(video: string): string | undefined {
  const base = path.join(path.dirname(video), path.basename(video, path.extname(video)));
  for (const ext of ['.xml', '.ass']) {
    if (exists(base + ext)) return base + ext;
  }
  return undefined;
}

async function main(): Promise<void> {
  const store = new ConfigStore();
  const cfg = store.config;
  const home = process.env['USERPROFILE'] ?? '';

  const roots =
    dirArgIdx >= 0 && process.argv[dirArgIdx + 1]
      ? [process.argv[dirArgIdx + 1]!]
      : [path.join(home, 'Downloads', 'Bilibili')];

  if (!JSON_ONLY) {
    console.log('\x1b[1m录播素材清单\x1b[0m');
    console.log('-'.repeat(72));
    console.log(`扫描目录 : ${roots.join('  |  ')}`);
  }

  const files = scanVideos(roots);
  if (files.length === 0) {
    console.log('没找到任何录播文件。');
    return;
  }

  // 真实的缓存命中统计：借用 Transcriber.preflight（与运行期完全同一套逻辑，
  // 自己重算缓存键容易与实现漂移，导致「显示已缓存但实际仍会付费」）
  const cache = new AsrCache(cfg.asr.cacheDir, log);
  const transcriber = new Transcriber({
    client: new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey }),
    config: cfg,
    logger: log,
    cache,
  });

  /** 探测结果缓存：同一文件只 ffprobe 一次 */
  const probeCache = new Map<string, ProbeResult>();
  const probeOf = (f: string): ProbeResult => {
    const hit = probeCache.get(f);
    if (hit) return hit;
    const r = probeMedia(f);
    probeCache.set(f, r);
    return r;
  };

  const list: Entry[] = [];

  for (const f of files) {
    const size = fileSize(f);
    if (size < 5 * 1024 * 1024) continue; // 太小的多半是碎片
    const probe = probeOf(f);
    const usable = probe.exists && probe.duration > 0;
    const danma = findDanma(f);

    let cacheHit = 0;
    let windows = 0;
    if (usable) {
      const adapter = {
        planCalls: (range: { start: number; end: number }) => [
          {
            file: f,
            inFileStart: range.start,
            inFileEnd: range.end,
            globalStart: range.start,
            globalEnd: range.end,
            offset: 0,
            windowIndex: 0,
          },
        ],
        fileStat: (file: string) => {
          try {
            const st = fs.statSync(file);
            return { size: st.size, updatedAt: Math.round(st.mtimeMs) };
          } catch {
            return { size: -1, updatedAt: 0 };
          }
        },
      };
      const pre = transcriber.preflight(adapter, probe.duration);
      cacheHit = pre.cacheHits;
      windows = pre.windows.length;
    }

    const group = path.basename(path.dirname(f));
    list.push({
      video: f,
      name: path.basename(f),
      group,
      sizeBytes: size,
      durationSec: probe.duration,
      resolution: probe.width && probe.height ? `${probe.width}x${probe.height}` : '-',
      codec: probe.videoCodec ? `${probe.videoCodec}/${probe.audioCodec ?? '?'}` : '-',
      ...(danma ? { danma, danmaKind: path.extname(danma).slice(1) } : {}),
      usable,
      ...(usable ? {} : { brokenReason: (probe.error ?? '无法解析').split('\n')[0]!.slice(0, 60) }),
      estCost: (probe.duration / 3600) * cfg.asr.unitPricePerHour,
      cacheHit,
      windows,
    });
  }

  const usableList = list.filter((e) => e.usable).sort((a, b) => a.durationSec - b.durationSec);
  const brokenList = list.filter((e) => !e.usable);

  if (JSON_ONLY) {
    console.log(
      JSON.stringify(
        { scanned: list.length, usable: usableList.length, broken: brokenList.length, pricePerHour: cfg.asr.unitPricePerHour, entries: list },
        null,
        2,
      ),
    );
    return;
  }

  const stats = cache.stats();
  console.log(`ASR 缓存 : ${stats.count} 个分段（${fmtDuration(stats.audioSeconds)} 音频已付过费，重跑不再计费）`);
  console.log(`单价     : ¥${cfg.asr.unitPricePerHour}/小时（估算值，拿不到对方账单）`);
  console.log('');
  console.log(`可用录播 ${usableList.length} 个（按时长升序，越靠前越省钱）：`);
  console.log('');

  const header = ['#', '时长', '大小', '分辨率', '弹幕', 'ASR 缓存', '预估费用', '位置', '文件名'];
  const rows = usableList.map((e, i) => [
    String(i + 1),
    fmtDuration(e.durationSec),
    fmtBytes(e.sizeBytes),
    e.resolution,
    e.danma ? `${e.danmaKind} ✓` : '无',
    e.windows > 0 ? `${e.cacheHit}/${e.windows}` : '-',
    `¥${e.estCost.toFixed(2)}`,
    e.group.length > 12 ? `${e.group.slice(0, 11)}…` : e.group,
    e.name.length > 40 ? `${e.name.slice(0, 38)}…` : e.name,
  ]);

  /** 按显示宽度补齐（中文字符占 2 列） */
  const width = (s: string): number => [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - width(s)));
  const widths = header.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ''))));
  console.log(header.map((h, i) => pad(h, widths[i]!)).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(r.map((c, i) => pad(c ?? '', widths[i]!)).join('  '));

  if (brokenList.length) {
    console.log('');
    console.log(`\x1b[33m不可用文件 ${brokenList.length} 个\x1b[0m（录制中断导致 MP4 未收尾，ffprobe 读不出时长）：`);
    if (SHOW_ALL) {
      for (const e of brokenList) {
        console.log(`  ${fmtBytes(e.sizeBytes).padStart(9)}  ${e.name}`);
        console.log(`            原因: ${e.brokenReason ?? '未知'}`);
      }
    } else {
      const totalBytes = brokenList.reduce((a, e) => a + e.sizeBytes, 0);
      console.log(`  合计占用 ${fmtBytes(totalBytes)}，可用 --all 查看明细`);
      console.log(`  典型原因: moov atom not found（MP4 索引缺失）—— 建议直接删掉或重新录制`);
    }
  }

  console.log('');
  const cheapest = usableList.filter((e) => e.durationSec >= 300 && e.danma).slice(0, 5);
  if (cheapest.length) {
    console.log('\x1b[1m推荐用于全流程验证（有弹幕 + 成本最低）：\x1b[0m');
    for (const e of cheapest) {
      const tag = e.cacheHit >= e.windows ? '  \x1b[32m[ASR 已缓存]\x1b[0m' : '';
      console.log(`  ¥${e.estCost.toFixed(2).padStart(5)}  ${fmtDuration(e.durationSec).padStart(9)}  ${pad(e.group, 12)}  ${e.name}${tag}`);
    }
  }
  const noDanma = usableList.filter((e) => !e.danma && e.durationSec >= 300).slice(0, 3);
  if (noDanma.length && cheapest.length === 0) {
    console.log('\x1b[1m可用素材（无弹幕，选片将依赖语音密度兜底）：\x1b[0m');
    for (const e of noDanma) console.log(`  ¥${e.estCost.toFixed(2).padStart(5)}  ${fmtDuration(e.durationSec).padStart(9)}  ${e.name}`);
  }
  const fullyCached = usableList.filter((e) => e.windows > 0 && e.cacheHit >= e.windows);
  if (fullyCached.length) {
    console.log('');
    console.log('\x1b[32m以下素材的 ASR 已全部缓存（重跑零成本）：\x1b[0m');
    for (const e of fullyCached) console.log(`  ${fmtDuration(e.durationSec).padStart(9)}  ${e.name}`);
  }
}

main().catch((e) => {
  console.error('扫描失败：', (e as Error).message);
  process.exit(1);
});
