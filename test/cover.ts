/**
 * 封面抽帧（`src/cover.ts` + publish.ts 的 resolveCover frame 分支）——2026-10-14，P2 收口。
 *
 * 断言刻意**不依赖 ffmpeg**（不同机器上 ffmpeg 未必在预期位置）：
 *   · 挑源逻辑（按评分排序、只要已切好且有产物的、没有就 undefined）—— 纯函数，直接测；
 *   · `coverFrom='preset'`（默认）⇒ **根本不尝试抽帧**（attempts 里不该有 frame）；
 *   · `coverFrom='frame'` + 输入不存在 ⇒ 如实记失败原因、并**回退**到老路径（不抛错）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickCoverSource } from '../src/cover.ts';
import { resolveCover } from '../src/publish.ts';
import { loadConfig } from '../src/config.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(title: string, cond: unknown, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${title}`);
  } else {
    fail++;
    failures.push(`${title}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${title}${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq(title: string, got: unknown, want: unknown): void {
  ok(title, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cover-'));
const realClip = path.join(tmp, 'clip-3.mp4');
fs.writeFileSync(realClip, 'x');
const presetJpg = path.join(tmp, 'preset.jpg');
fs.writeFileSync(presetJpg, 'x');

section('1. 挑源：按评分排序、只要已切好且有产物的');
{
  const picked = pickCoverSource([
    { index: 1, score: 6.2, cutOutput: realClip },
    { index: 7, score: 9.4, cutOutput: realClip },
    { index: 5, score: 8.1 }, // 没有产物 ⇒ 不可用
    { index: 9, score: 9.9, cutOutput: path.join(tmp, '不存在.mp4') }, // 产物不存在 ⇒ 不可用
  ]);
  eq('★ 选评分最高且产物存在的那一个', picked?.index, 7);
  eq('★ 没有可用切片 ⇒ undefined（调用方据此不传封面）', pickCoverSource([{ index: 0, score: 9 }]), undefined);
  eq('空数组 ⇒ undefined', pickCoverSource([]), undefined);
  eq('评分缺失时按 0 处理、不炸', pickCoverSource([{ index: 2, cutOutput: realClip }])?.index, 2);
}

section('2. ★ 默认 preset：根本不尝试抽帧');
{
  const cfg = loadConfig().config;
  const c = { ...cfg, publish: { ...cfg.publish, coverSource: 'preset' as const, coverFrom: 'preset' as const } };
  const r = resolveCover(c, { presetCover: presetJpg }, undefined);
  eq('拿到预设封面', r.source, 'preset');
  ok('★ attempts 里没有任何 frame 记录（说明压根没去抽帧）', !r.attempts.some((a) => a.source === 'frame'), JSON.stringify(r.attempts));
}

section('3. ★ frame 模式下抽帧失败 ⇒ 如实记原因并回退（不抛错）');
{
  const cfg = loadConfig().config;
  const c = { ...cfg, publish: { ...cfg.publish, coverSource: 'preset' as const, coverFrom: 'frame' as const } };
  const r = resolveCover(
    c,
    {
      presetCover: presetJpg,
      /* 候选指向**不存在的文件** ⇒ 抽帧必然失败（这条断言因此不依赖 ffmpeg） */
      frameCandidates: [{ index: 4, score: 9.1, cutOutput: path.join(tmp, '不存在的切片.mp4') }],
      frameOutPath: path.join(tmp, 'cover-frame.jpg'),
    },
    undefined,
  );
  const frameAttempt = r.attempts.find((a) => a.source === 'frame');
  ok('★ 记了一条 frame 的失败原因', Boolean(frameAttempt) && frameAttempt?.ok === false, JSON.stringify(r.attempts));
  eq('★ 回退到老路径（预设封面照常拿到）', r.source, 'preset');
  ok('回退后仍返回可用的封面文件', typeof r.cover === 'string' && fs.existsSync(r.cover), String(r.cover));
}

section('4. frame 模式但没有可用切片 ⇒ 说明原因并回退');
{
  const cfg = loadConfig().config;
  const c = { ...cfg, publish: { ...cfg.publish, coverSource: 'preset' as const, coverFrom: 'frame' as const } };
  const r = resolveCover(c, { presetCover: presetJpg, frameCandidates: [] }, undefined);
  const frameAttempt = r.attempts.find((a) => a.source === 'frame');
  ok('★ 原因写明"没有已切好且有产物的切片"', /没有已切好且有产物的切片/.test(frameAttempt?.reason ?? ''), JSON.stringify(r.attempts));
  eq('仍然回退到预设封面', r.source, 'preset');
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
}
process.exitCode = fail === 0 ? 0 : 1;
