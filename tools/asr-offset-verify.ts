/**
 * 验证 `/ai/subtitle` 的 **offset 语义** —— 这是字幕能否对齐声音的根本。
 *
 * ## 为什么必须验证
 *
 * `asr.ts` 的注释写着（我们当初的推断，**从未实测**）：
 *
 *   > offset=0 时 SRT 时间戳相对**本次提交的音频片段起点**，
 *   > 因此全局时间 = 段内时间戳 + globalStart
 *
 * `docs/api-observed.md` 里对应那条实测是「**已跳过**」（当时怕花钱没跑）。
 * 也就是说：**整条链路的字幕时间轴都建立在一个未验证的假设上**。
 *
 * 如果假设是错的（服务端返回的时间戳**已经**是绝对时间），我们就会**重复偏移**：
 * 第 1 个窗口（startTime=0）看不出问题，第 2 个窗口起越偏越远 ——
 * 表现正是用户报的「字幕和声音对不上」。
 *
 * ## 怎么验证（零成本）
 *
 * ASR 缓存里存了**每个窗口的原始 SRT**。只要看：
 *   - 该窗口的 `parts.startTime`（我们提交的起点，如 1800）
 *   - 该窗口 SRT 的第一条时间戳
 *
 * 如果 SRT 从 `00:00:0x` 开始 → 相对片段 → 我们的 `+globalStart` **正确**
 * 如果 SRT 从 `00:30:0x` 开始（≈ startTime）→ 已是绝对时间 → 我们**重复偏移了**
 *
 * 用法：node tools/asr-offset-verify.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { ASR_CACHE_DIR } from '../src/util.ts';
import type { AsrCacheEntry } from '../src/types.ts';

/** `00:30:01,200` → 1801.2 */
function parseSrtTime(t: string): number {
  const m = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(t);
  if (!m) return Number.NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number((m[4] ?? '0').padEnd(3, '0')) / 1000;
}

interface Sample {
  key: string;
  file: string;
  startTime: number;
  endTime: number;
  firstTs: number;
  lastTs: number;
  firstText: string;
  segmentCount: number;
}

const samples: Sample[] = [];
for (const f of fs.readdirSync(ASR_CACHE_DIR)) {
  if (!f.endsWith('.json')) continue;
  let e: AsrCacheEntry;
  try {
    e = JSON.parse(fs.readFileSync(path.join(ASR_CACHE_DIR, f), 'utf8')) as AsrCacheEntry;
  } catch {
    continue;
  }
  const srt = String(e.srt ?? '');
  const stamps = [...srt.matchAll(/^(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->/gm)]
    .map((m) => parseSrtTime(m[1] ?? ''))
    .filter((x) => Number.isFinite(x));
  const firstText = (/^\d+\s*\n[\d:,.]+\s*-->\s*[\d:,.]+\s*\n(.+)$/m.exec(srt)?.[1] ?? '').trim();
  if (stamps.length === 0) continue;
  samples.push({
    key: f.replace('.json', '').slice(0, 12),
    file: path.basename(String(e.parts?.videoFilePath ?? '?')).slice(0, 34),
    startTime: e.parts?.startTime ?? 0,
    endTime: e.parts?.endTime ?? 0,
    firstTs: stamps[0]!,
    lastTs: stamps[stamps.length - 1]!,
    firstText: firstText.slice(0, 40),
    segmentCount: (e.segments ?? []).length,
  });
}

console.log('\x1b[1mASR offset 语义验证\x1b[0m（用缓存里的原始 SRT，零成本）');
console.log('─'.repeat(96));
console.log('  假设（asr.ts 的注释）：SRT 时间戳相对**本次提交的片段起点** → 我们 + startTime');
console.log('  若成立：SRT 首条时间戳 ≈ 0；若相反（服务端已返回绝对时间）：SRT 首条 ≈ startTime');
console.log('');

// 只看 startTime > 0 的窗口 —— 只有这些能区分两种语义
const decisive = samples.filter((s) => s.startTime > 60).sort((a, b) => a.startTime - b.startTime);
const zeroWindows = samples.filter((s) => s.startTime <= 60);

console.log(`  缓存条目 ${samples.length} 个；其中 startTime>60s 的（有判定力）${decisive.length} 个，startTime≈0 的 ${zeroWindows.length} 个`);
console.log('');
if (decisive.length === 0) {
  console.log('  \x1b[33m没有 startTime>0 的缓存条目 —— 无法判定。\x1b[0m');
  console.log('  （本地缓存都是短素材/单窗口。要判定需跑一场跨多窗口的转写，或看下面的"间接证据"）');
} else {
  console.log('  \x1b[1m判定表\x1b[0m（startTime / SRT首条 / 差值 = 首条 - startTime）');
  let relativeVotes = 0;
  let absoluteVotes = 0;
  for (const s of decisive.slice(0, 20)) {
    const diff = s.firstTs - s.startTime;
    // 相对片段 → 首条≈0 → diff ≈ -startTime；绝对 → 首条≈startTime → diff ≈ 0
    const verdict = Math.abs(s.firstTs) < 5 ? '相对片段 ✅ 我们的 +startTime 正确' : Math.abs(diff) < 5 ? '绝对时间 ❌ 我们重复偏移了' : '不确定';
    if (verdict.startsWith('相对')) relativeVotes++;
    else if (verdict.startsWith('绝对')) absoluteVotes++;
    console.log(
      `  ${s.key}  start=${String(s.startTime).padStart(6)}s  首条=${s.firstTs.toFixed(1).padStart(8)}s  差=${diff.toFixed(1).padStart(8)}s  ${verdict}`,
    );
    console.log(`      ${s.file}  ${s.segmentCount} 段  首句：${s.firstText}`);
  }
  console.log('');
  console.log(
    absoluteVotes > relativeVotes
      ? '\x1b[31m判定：服务端返回的是**绝对时间** → 我们的 +globalStart 造成重复偏移（就是字幕对不上的原因）\x1b[0m'
      : relativeVotes > absoluteVotes
        ? '\x1b[32m判定：服务端返回的是**相对片段**的时间 → 我们的 +globalStart 正确\x1b[0m'
        : '\x1b[33m证据不足，无法判定\x1b[0m',
  );
}

/* ---- 间接证据：同一文件多个窗口的 SRT 时间范围是否重叠/连续 ---- */
console.log('\n\x1b[1m间接证据：同一文件多个窗口的时间范围\x1b[0m');
const byFile = new Map<string, Sample[]>();
for (const s of samples) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
for (const [file, list] of byFile) {
  if (list.length < 2) continue;
  console.log(`\n  ${file}（${list.length} 个窗口）`);
  for (const s of list.sort((a, b) => a.startTime - b.startTime)) {
    console.log(
      `      start=${String(s.startTime).padStart(6)}s  end=${String(s.endTime).padStart(6)}s  SRT 范围 ${s.firstTs.toFixed(0)}–${s.lastTs.toFixed(0)}s  ${s.segmentCount} 段`,
    );
  }
  // 若 SRT 范围都从 0 附近开始 → 相对语义；若随 startTime 平移 → 绝对语义
  const starts = list.map((s) => s.firstTs);
  const allNearZero = starts.every((x) => x < 30);
  const shifts = starts.filter((x) => x > 300).length;
  console.log(
    `      → ${
      allNearZero
        ? '\x1b[32m各窗口 SRT 都从 0 附近开始 = 相对片段（我们的实现正确）\x1b[0m'
        : shifts > 0
          ? `\x1b[31m有 ${shifts} 个窗口的 SRT 起点 >300s = 疑似绝对时间（需人工确认）\x1b[0m`
          : '\x1b[33m无法判定\x1b[0m'
    }`,
  );
}
