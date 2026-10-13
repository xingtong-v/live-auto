/**
 * biliLive-tools 的 ffmpeg 任务审计（2026-10-13）。
 *
 * 回答一个问题：**到底是谁在吃 CPU，用的什么编码器**。分三类：
 *   · 切片（`/task/cut`，编码器由**我们**的 `clip.ffmpegOptionsOverride` 决定）
 *   · 弹幕版压制（biliLive-tools 自己"录制完成后自动压制"，由它的 `tool.home` 预设决定）
 *   · 其它（录制拉流等）
 *
 * ⚠️ 两类任务用的是**不同的预设**：改我们的 `clip.ffmpegOptionsOverride` 影响不到"弹幕版压制"；
 * 改 biliLive-tools 的 `tool.home.ffmpegPresetId` 也影响不到我们的切片。
 * 第一版工具没区分这点，把压制任务误报成"切片仍是 libx264"（还把同一条命令的两行日志算成两次）——
 * 所以这里显式分类 + 按 taskId 去重。
 *
 * 用法：node tools/check-cut-encoder.ts [--last 8]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const lastN = (() => {
  const i = argv.indexOf('--last');
  return i >= 0 ? Math.max(1, Number(argv[i + 1])) : 8;
})();

const defaultLog = path.join(os.homedir(), 'AppData', 'Roaming', 'biliLive-tools', 'logs', 'main.log');
const file = process.env.BLT_LOG || defaultLog;
if (!fs.existsSync(file)) {
  console.error(`找不到 biliLive-tools 日志：${file}\n可用 BLT_LOG=<路径> 指定。`);
  process.exit(2);
}

interface Job {
  taskId: string;
  at: string;
  kind: '切片' | '弹幕版压制' | '其它';
  output?: string;
  encoder?: string;
  params: string[];
}

const jobs = new Map<string, Job>();
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

for (const line of lines) {
  const at = /^\[([^\]]+)\]/.exec(line)?.[1] ?? '';
  const cmd = /command: (.+)$/.exec(line)?.[1];
  if (!cmd || !/-c:v\s/.test(cmd)) continue;
  /* 同一任务有**两行**日志：`ffmpeg task <id> has been added, command:` 与 `task <id> start, command: ffmpeg ...`
     —— 第二行没有 "ffmpeg" 前缀，所以正则得把两种形式都吃下，否则同一件事会被算成两次。 */
  const taskId = /(?:ffmpeg )?task ([0-9a-f-]{8,})/.exec(line)?.[1] ?? `${at}-${cmd.slice(0, 40)}`;
  if (jobs.has(taskId)) continue; // "has been added" 与 "start" 是同一任务的两行 → 去重
  /* 输出路径 = 命令行里**最后一个** `X:\…`（ffmpeg 的最后一个参数就是输出文件）。
     ⚠️ 不能按"引号内的路径 / 不带空格的路径"去抓：biliLive-tools 的日志里路径**没有引号且含空格**
     （`… \2026-10-13 19-52-02-563 【2D】用一加16打暗区突围！-弹幕版.mp4`），
     按空白切会把路径截成半截 → 误报"文件已不在"。滤波器里的转义路径是 `C\:/…`（反斜杠+冒号），
     与真路径的 `C:\`（冒号+反斜杠）不同，所以不会被这条规则误抓。 */
  const driveMatches = [...cmd.matchAll(/[A-Za-z]:\\/g)];
  const lastDrive = driveMatches.length ? driveMatches[driveMatches.length - 1]!.index : undefined;
  const output = lastDrive === undefined ? undefined : cmd.slice(lastDrive).replace(/^"|"$/g, '').trim();
  const kind: Job['kind'] = /-弹幕版\.mp4"?\s*$/.test(cmd.trim())
    ? '弹幕版压制'
    : /[\\/]clips[\\/]/.test(output ?? '')
      ? '切片'
      : '其它';
  const params: string[] = [];
  for (const key of ['-crf', '-cq', '-rc', '-b:v', '-preset', '-c:a']) {
    const m = new RegExp(`${key}\\s+(\\S+)`).exec(cmd);
    if (m) params.push(`${key} ${m[1]}`);
  }
  jobs.set(taskId, {
    taskId,
    at,
    kind,
    ...(output ? { output } : {}),
    ...(/-c:v\s+(\S+)/.exec(cmd)?.[1] ? { encoder: /-c:v\s+(\S+)/.exec(cmd)![1]! } : {}),
    params,
  });
}

const all = [...jobs.values()];
if (all.length === 0) {
  console.log('日志里没有找到带 -c:v 的 ffmpeg 任务。');
  process.exit(0);
}

const show = (title: string, list: Job[]): void => {
  if (list.length === 0) {
    console.log(`\n=== ${title}：无 ===`);
    return;
  }
  console.log(`\n=== ${title}（最近 ${list.length} 个）===`);
  for (const j of list) {
    const isNvenc = (j.encoder ?? '').includes('nvenc');
    const size =
      j.output && fs.existsSync(j.output) ? `${(fs.statSync(j.output).size / 1024 ** 2).toFixed(0)} MB` : '（文件已不在）';
    console.log(
      `  ${j.at}  \x1b[${isNvenc ? '32' : '33'}m${(j.encoder ?? '?').padEnd(11)}\x1b[0m ` +
        `${j.params.join(' ').padEnd(46)} ${size}`,
    );
    if (j.output) console.log(`      ${path.basename(j.output)}`);
  }
  const nvenc = list.filter((j) => (j.encoder ?? '').includes('nvenc')).length;
  console.log(`  小计：NVENC ${nvenc} / 软编 ${list.length - nvenc}`);
};

const slices = all.filter((j) => j.kind === '切片').slice(-lastN);
const burns = all.filter((j) => j.kind === '弹幕版压制').slice(-lastN);
const others = all.filter((j) => j.kind === '其它').slice(-Math.min(3, lastN));

show('切片（编码器由**我们**的 config.json 决定）', slices);
show('弹幕版压制（编码器由 biliLive-tools 的 tool.home 预设决定，与本项目配置无关）', burns);
show('其它 ffmpeg 任务（录制拉流等）', others);

if (slices.length) {
  const latest = slices[slices.length - 1]!;
  console.log(
    (latest.encoder ?? '').includes('nvenc')
      ? '\n\x1b[32m切片最新一次已在用 NVENC ✅\x1b[0m'
      : `\n\x1b[33m切片最新一次仍是 ${latest.encoder ?? '?'} —— 检查我们 config.json 的 clip.ffmpegOptionsOverride\x1b[0m`,
  );
}
if (burns.some((j) => !(j.encoder ?? '').includes('nvenc'))) {
  console.log(
    '\x1b[33m提示：弹幕版压制仍是软件编码 —— 整场 1080p60 重编码会长跑占 CPU（本次实测平均约 6 个核）。\n' +
      '      想让它也让路：在 biliLive-tools 里把「主页/一键压制」的 FFmpeg 预设换成 H.264(NVIDIA NVEnc)，\n' +
      '      或关掉"录制完成后自动压制弹幕版"（如果你不需要 P1 弹幕完整版）。\x1b[0m',
  );
}
