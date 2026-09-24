/**
 * 判定实验（**会花极小量的钱**：每个 40 秒窗口 ≈ ¥0.0088，合计不到 2 分）：
 * 把切片开头 40 秒**单独**送去云 ASR，得到的文本必然对应"切片开头这段音频"。
 * 再和"整场转写在同段时间上的文本"比 —— 两者一致就说明整场转写的时间轴是对的；
 * 若整场转写在 307–347s 的文字其实对应切片更靠后的位置，就说明整场转写被整体挪了位。
 *
 * 用法：node tools/asr-window-probe.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { BiliLiveClient } from '../src/api.ts';
import { loadConfig } from '../src/config.ts';
import { ROOT_DIR } from '../src/util.ts';

const cfg = loadConfig().config;
const client = BiliLiveClient.fromConfig(cfg);
const taskId = 'auto-20260923175913-qpq8';
const taskDir = path.join(ROOT_DIR, 'data', 'tasks', taskId);
const clipsJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'clips.json'), 'utf8'));
const tr = JSON.parse(fs.readFileSync(path.join(taskDir, 'transcript.json'), 'utf8'));
const segs = (tr.segments ?? []).map((s: { start?: unknown; end?: unknown; text?: unknown }) => ({
  start: Number(s.start),
  end: Number(s.end),
  text: String(s.text ?? ''),
}));

const fmt = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const WINDOW = 40;

for (const c of (clipsJson.clips ?? []).slice(0, 2)) {
  if (!c.cutOutput || !fs.existsSync(c.cutOutput)) continue;
  console.log(`\n========== clip[${c.index}] 取切片开头 0–${WINDOW}s 单独送 ASR ==========`);
  console.log(`（切片来自整场 ${fmt(c.start)} → ${fmt(c.end)}，所以这段音频 = 整场的 ${fmt(c.start)} → ${fmt(c.start + WINDOW)}）`);
  console.log('整场转写在这段里的文本（供对照）：');
  for (const s of segs.filter((x: { start: number; end: number }) => x.end > c.start && x.start < c.start + WINDOW)) {
    console.log(`   ${(s.start - c.start).toFixed(1)}s–${(s.end - c.start).toFixed(1)}s（切片内）  ${s.text.slice(0, 60)}`);
  }
  try {
    const t0 = Date.now();
    const srt = await client.subtitle({
      file: c.cutOutput,
      startTime: 0,
      endTime: WINDOW,
      offset: 0,
      song: false,
      timeoutMs: 300000,
    });
    console.log(`\n云 ASR 对 0–${WINDOW}s 的识别结果（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）：`);
    console.log(
      String(srt)
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .slice(0, 40)
        .map((l) => '   ' + l)
        .join('\n'),
    );
  } catch (e) {
    console.log(`ASR 调用失败：${(e as Error).message}`);
  }
}
