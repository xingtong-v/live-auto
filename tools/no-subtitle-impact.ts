/**
 * 分析：**不做字幕**能省掉什么、什么还会漏进成片。
 *
 * 关键问题：ASR 的坏时间戳除了"字幕挂错地方"，会不会也影响**切片边界**（开头/结尾选在哪）？
 * 这里直接量两个已发布切片的"开头有多久没人说话"，并标出 ASR 给的窗口边界。
 *
 * 用法：node tools/no-subtitle-impact.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { computeEnergyProfile, findSpeechOffset, findSpeechOnset } from '../src/speech-energy.ts';
import { ROOT_DIR } from '../src/util.ts';

const taskId = 'auto-20260923175913-qpq8';
const taskDir = path.join(ROOT_DIR, 'data', 'tasks', taskId);
const clipsJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'clips.json'), 'utf8')) as { clips?: Array<{ index: number; start: number; end: number; cutOutput?: string }>; };
const tr = JSON.parse(fs.readFileSync(path.join(taskDir, 'transcript.json'), 'utf8')) as { segments?: Array<{ start: number; end: number; text: string }> };
const segs = (tr.segments ?? []).map((s) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text) }));
const SPEECH_DB = -28;
const ledger = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data', 'ledger.json'), 'utf8')) as {
  tasks?: Record<string, { source?: { rawFiles?: string[] } }>;
};
const src = (ledger.tasks?.[taskId]?.source?.rawFiles ?? [])[0] ?? '';
/* ⚠️ 修正模拟必须用**源文件**的剖面（绝对时间轴）：
   切片产物的时间轴是 0 基的，拿 clip.start（绝对秒）去查它会越界，结果永远是"找不到人声"。 */
const srcProfile = src ? computeEnergyProfile(src, { binSec: 0.5 }) : undefined;

for (const clip of clipsJson.clips ?? []) {
  const len = clip.end - clip.start;
  const profile = computeEnergyProfile(clip.cutOutput ?? '', { binSec: 0.5 });
  if (!profile) continue;
  const dbAt = (t: number): number => {
    const i = Math.floor(t / profile.binSec);
    return 20 * Math.log10(Math.max(1e-6, profile.rms[i] ?? 0));
  };
  /* 切片内第一次"有说话动静"的时刻 */
  let firstSpeech = -1;
  for (let t = 0; t < len; t += 0.5) {
    if (dbAt(t) >= SPEECH_DB) {
      firstSpeech = t;
      break;
    }
  }
  /* 结尾往前找最后一次说话 */
  let lastSpeech = -1;
  for (let t = len - 0.5; t >= 0; t -= 0.5) {
    if (dbAt(t) >= SPEECH_DB) {
      lastSpeech = t;
      break;
    }
  }
  const lead = firstSpeech > 0 ? firstSpeech : 0;
  const tail = lastSpeech >= 0 ? len - lastSpeech : 0;
  /* ASR 在该窗口的第一段（决定 LLM 会怎么挑起点） */
  const firstSeg = segs.find((s) => s.end > clip.start && s.start < clip.end);
  console.log(`\nclip[${clip.index}] ${clip.start.toFixed(1)} → ${clip.end.toFixed(1)}（${len.toFixed(0)}s）`);
  console.log(`  开头无人说话：**${lead.toFixed(1)} 秒**（第一次超过 ${SPEECH_DB} dB 在 ${firstSpeech.toFixed(1)}s）`);
  console.log(`  结尾无人说话：${tail.toFixed(1)} 秒`);
  console.log(`  ASR 在该窗口的第一段：${firstSeg ? `${(firstSeg.start - clip.start).toFixed(1)}s → ${(firstSeg.end - clip.start).toFixed(1)}s（${(firstSeg.end - firstSeg.start).toFixed(1)}s 窗口）「${firstSeg.text.slice(0, 26)}」` : '(无)'}`);
  console.log(`  → 切片起点=ASR 窗口起点？${firstSeg && Math.abs(firstSeg.start - clip.start) < 0.05 ? '**是**（起点直接落在那个离谱窗口的开头）' : '不是'}`);

  /* 新的「能量边界修正」会怎么处理这片（trimSec=30 与配置默认一致） */
  const TRIM = 30;
  const onset = findSpeechOnset(srcProfile, clip.start, TRIM);
  const offset = findSpeechOffset(srcProfile, clip.end, TRIM);
  console.log(`  能量修正模拟（上限 ${TRIM}s）：`);
  console.log(
    `    起点：${clip.start.toFixed(1)}s → ${onset === undefined ? '找不到人声，保持' : `${onset.toFixed(1)}s${onset - clip.start >= 4 ? `（裁掉开头 ${(onset - clip.start).toFixed(1)}s 空转）` : '（死气不足 4 秒，不动）'}`}`,
  );
  console.log(
    `    结尾：${clip.end.toFixed(1)}s → ${offset === undefined ? '找不到人声，保持' : `${offset.toFixed(1)}s${clip.end - offset >= 4 ? `（裁掉结尾 ${(clip.end - offset).toFixed(1)}s）` : '（死气不足 4 秒，不动）'}`}`,
  );
}

