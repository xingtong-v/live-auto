/**
 * 「重新切片与投稿」的产物复用行为 —— 2026-10-17 加。
 *
 * 背景（用户明确口径）：点「重新切片与投稿」时 ——
 *   · 切片产物**存在**   ⇒ 重新**投稿**（不再提交一次 ffmpeg）；
 *   · 切片产物**不存在** ⇒ 重新**切片**再投稿。
 * 实现落在 `cutAndUploadClip` 的「幂等 3」：`cutOutput` 有值且文件在 ⇒ 复用，
 * 直接进投稿；否则走正常切割。配套：`PATCH /clip/:idx` 改区间时会 unset `cutOutput`
 * （旧产物对应旧区间，不清会错投旧内容）。
 *
 * 这里用**真 Publisher + 假传输层**钉住四条性质：
 *   1. 产物在 ⇒ 不调 cut、直接把**那个文件**投出去；
 *   2. 产物缺失 ⇒ 走切割（cut 被调）再投；
 *   3. 复用路径**仍过全部幂等闸门**（B站侧已有同名稿件 ⇒ 跳过投稿，不产生重复）；
 *   4. 全部已发布的任务重跑 ⇒ 空结果、零调用（那 19 片的场景：重跑不会双份）。
 *
 * 纯离线：不碰 B站、不切 ffmpeg、临时目录随用随清。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Publisher } from '../src/publish.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { clipFingerprint, Ledger } from '../src/ledger.ts';
import type { TaskRecord } from '../src/types.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: unknown, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(detail ? `${name} :: ${detail}` : name);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function section(t: string): void {
  console.log(`\x1b[1m${t}\x1b[0m`);
}

const silentLog = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  debug: (): void => {},
  child: (): unknown => silentLog,
};

interface Env {
  publisher: Publisher;
  task: TaskRecord;
  ledger: Ledger;
  uploads: Array<Record<string, unknown>>;
  cuts: Array<string>;
  cleanup: () => void;
}

/**
 * 起一个隔离环境。`clips` 的 status/cutOutput 由用例自己摆（这是被测变量）；
 * `archives` 是 mock 的「我的稿件列表」（幂等 2 的反查数据源）。
 */
function makeEnv(root: string, clips: Array<Record<string, unknown>>, archives: unknown[] = []): Env {
  const dataDir = path.join(root, 'data');
  const taskId = 'clip-reuse-001';
  const taskDir = path.join(dataDir, 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'clips-out'), { recursive: true });

  const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json'), logger: silentLog as never });
  ledger.createTask({
    id: taskId,
    roomId: '12345678',
    title: '产物复用测试场',
    liveStartTime: Math.floor(Date.now() / 1000) - 7200,
    stage: 'ANALYZED',
    source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: {
      asrEstimate: 0,
      asrAudioSeconds: 0,
      llmActual: 0,
      llmPromptTokens: 0,
      llmCompletionTokens: 0,
      llmCalls: 0,
      updatedAt: new Date().toISOString(),
    },
    transcriptPath: path.join(taskDir, 'transcript.json'),
    signalsPath: path.join(taskDir, 'signals.json'),
    clipsPath: path.join(taskDir, 'clips.json'),
  });
  ledger.setClips(
    taskId,
    clips.map((c, i) => ({
      index: i,
      start: 100 + i * 400,
      end: 250 + i * 400,
      title: `第${i + 1}段`,
      desc: '',
      tags: ['测试'],
      category: '游戏/单机游戏',
      score: 9,
      selected: true,
      status: 'CANDIDATE',
      ...c,
    })) as never,
  );

  const raw = path.join(root, 'raw.mp4');
  fs.writeFileSync(raw, 'x');
  ledger.updateTask(taskId, {
    recordingId: 'rec-1',
    source: { ...ledger.getTask(taskId)!.source, rawFiles: [raw], fullVideoPath: raw },
  });

  const realCfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')) as Record<string, unknown>;
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...realCfg,
        clip: {
          ...(realCfg['clip'] as object),
          burnDanmaku: false,
          burnSubtitles: false,
          avSyncRepair: false,
          concurrency: 1,
          ffmpegPresetId: '',
          outputDir: path.join(root, 'clips-out'),
        },
        publish: {
          ...(realCfg['publish'] as object),
          submitGapSec: 1200,
          firstPublishAt: '',
          dailyLimit: 0,
          minSubmitIntervalSec: 0,
          autoRetryOnce: false,
          coverFrom: 'preset',
          defaultCover: '',
          autoPublish: true,
          fullVideoBy: 'bililive-tools',
          resumeAid: '',
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const uploads: Array<Record<string, unknown>> = [];
  const cuts: string[] = [];
  const publisher = new Publisher({
    client: {
      userList: async (): Promise<unknown[]> => [{ uid: 12345, name: 'stub' }],
      anchorInfoByRoom: async (): Promise<{ uid: string; name: string }> => ({ uid: '12345', name: 'stub-anchor' }),
      cut: async (p: Record<string, unknown>): Promise<{ taskId: string }> => {
        const out = String(p['output']);
        cuts.push(out);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, 'x');
        return { taskId: `cut-${path.basename(out)}` };
      },
      taskDetail: async (): Promise<{ status: string; output: string }> => ({ status: 'completed', output: '' }),
      presetFfmpeg: async (): Promise<unknown[]> => [],
      biliArchives: async (): Promise<unknown[]> => archives,
      biliUpload: async (p: Record<string, unknown>): Promise<{ taskId: string }> => {
        uploads.push(p);
        return { taskId: `upload-${uploads.length}` };
      },
    } as never,
    config: loadConfig(configPath).config as AppConfig,
    ledger,
    logger: silentLog as never,
  });

  return {
    publisher,
    task: ledger.getTask(taskId)!,
    ledger,
    uploads,
    cuts,
    cleanup: (): void => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live_auto-reuse-'));
try {
  /* ---- 1. 产物存在 ⇒ 不重切、把那个文件投出去 ---- */
  section('1. 产物存在 ⇒ 复用（不调 cut），直接投稿');
  {
    const env = makeEnv(tmpRoot + '-1', [
      {
        status: 'PENDING_UPLOAD',
        cutOutput: path.join(tmpRoot + '-1', 'clips-out', '01-existing.mp4'),
      },
    ]);
    fs.writeFileSync(path.join(tmpRoot + '-1', 'clips-out', '01-existing.mp4'), 'existing-bytes');
    const res = await env.publisher.publishClips({ task: env.task, uid: 12345, submitTimeMs: Date.now() });
    eq('投稿 1 片', res.submitted, 1);
    eq('没有重新切割（cut 调用 0 次）', env.cuts.length, 0);
    eq('投稿载荷的 videos[0] 就是已有产物', String((env.uploads[0]?.['videos'] as string[])?.[0] ?? ''), path.join(tmpRoot + '-1', 'clips-out', '01-existing.mp4'));
    eq('切片状态推进到 SUBMITTED', env.ledger.getClip(env.task.id, 0)?.status, 'SUBMITTED');
    env.cleanup();
  }

  /* ---- 2. 产物缺失 ⇒ 走切割再投 ---- */
  section('2. 产物缺失 ⇒ 重新切割（cut 被调）再投稿');
  {
    const env = makeEnv(tmpRoot + '-2', [
      {
        status: 'PENDING_UPLOAD',
        cutOutput: path.join(tmpRoot + '-2', 'clips-out', '01-gone.mp4'), // 文件不存在
      },
    ]);
    const res = await env.publisher.publishClips({ task: env.task, uid: 12345, submitTimeMs: Date.now() });
    eq('投稿 1 片', res.submitted, 1);
    eq('重新切割了（cut 调用 1 次）', env.cuts.length, 1);
    eq('切片状态推进到 SUBMITTED', env.ledger.getClip(env.task.id, 0)?.status, 'SUBMITTED');
    env.cleanup();
  }

  /* ---- 3. 复用路径仍过幂等闸门：B站侧已有同名稿件 ⇒ 跳过、不产生重复 ---- */
  section('3. 复用路径不绕过幂等：B站已有同名稿件 ⇒ 跳过投稿');
  {
    const env = makeEnv(
      tmpRoot + '-3',
      [{ status: 'PENDING_UPLOAD', cutOutput: path.join(tmpRoot + '-3', 'clips-out', '01-existing.mp4') }],
      [{ bvid: 'BV1AbCdEfGhI', title: '第1段' }], // 反查命中同名
    );
    fs.writeFileSync(path.join(tmpRoot + '-3', 'clips-out', '01-existing.mp4'), 'existing-bytes');
    const res = await env.publisher.publishClips({ task: env.task, uid: 12345, submitTimeMs: Date.now() });
    eq('跳过（不重复投稿）', res.submitted, 0);
    eq('没调 biliUpload', env.uploads.length, 0);
    eq('没调 cut', env.cuts.length, 0);
    eq('切片被补记为 PUBLISHED（bvid 已回填）', env.ledger.getClip(env.task.id, 0)?.status, 'PUBLISHED');
    eq('bvid 来自反查', env.ledger.getClip(env.task.id, 0)?.bvid, 'BV1AbCdEfGhI');
    env.cleanup();
  }

  /* ---- 4. 全部已发布 ⇒ publishClips 层面仍是空结果零调用 ---- */
  section('4. 全部已发布（未经重置）⇒ 零调用');
  {
    const env = makeEnv(tmpRoot + '-4', [{ status: 'PUBLISHED', bvid: 'BV1xyz', cutOutput: path.join(tmpRoot + '-4', 'clips-out', '01.mp4') }]);
    fs.writeFileSync(path.join(tmpRoot + '-4', 'clips-out', '01.mp4'), 'x');
    const res = await env.publisher.publishClips({ task: env.task, uid: 12345, submitTimeMs: Date.now() });
    eq('投稿 0 片', res.submitted, 0);
    eq('零 cut', env.cuts.length, 0);
    eq('零 upload', env.uploads.length, 0);
    eq('状态没被碰（仍 PUBLISHED）', env.ledger.getClip(env.task.id, 0)?.status, 'PUBLISHED');
    env.cleanup();
  }

  /* ---- 5. 「重置 → 再同步」闭环：已确认发布的片复位后重跑 ⇒ 指纹命中恢复 PUBLISHED、不重投 ----
     这就是「重新切片与投稿」按钮现在的完整语义：retry 先把状态复位成 CANDIDATE，
     publishClips 重拾起每一片，已投过的片在「幂等 1（本地指纹）」秒回并恢复状态。
     ⚠️ 指纹的落表路径（真实链路）：SUBMITTING 时写入 clip.fingerprint（cutAndUploadClip），
     PUBLISHED+bvid 时 syncFingerprint 把它同步进指纹表 —— 所以这里要**按真实顺序**摆：
     先 SUBMITTING（带 fingerprint），再 PUBLISHED（带 bvid）。只摆 PUBLISHED 不带
     fingerprint 字段的话，syncFingerprint 会直接 return（测试第一版就栽在这里）。 */
  section('5. 重置 → 再同步：PUBLISHED 片复位重跑 ⇒ 指纹命中恢复，不重投');
  {
    const env = makeEnv(tmpRoot + '-5', [{ status: 'PENDING_UPLOAD', cutOutput: path.join(tmpRoot + '-5', 'clips-out', '01.mp4') }]);
    fs.writeFileSync(path.join(tmpRoot + '-5', 'clips-out', '01.mp4'), 'x');
    const fp = clipFingerprint({ sourceVideoId: env.task.recordingId ?? env.task.id, start: 100, end: 250, title: '第1段' });
    env.ledger.setClipStatus(env.task.id, 0, 'SUBMITTING', { fingerprint: fp });
    env.ledger.setClipStatus(env.task.id, 0, 'PUBLISHED', { bvid: 'BV1alreadyUp' });
    // retry 的复位动作（server.ts fromStage=CLIPPED 分支的行为）：非 CANDIDATE 一律复位，bvid/cutOutput 保留
    env.ledger.setClipStatus(env.task.id, 0, 'CANDIDATE');
    eq('复位后状态是 CANDIDATE', env.ledger.getClip(env.task.id, 0)?.status, 'CANDIDATE');
    const res = await env.publisher.publishClips({ task: env.task, uid: 12345, submitTimeMs: Date.now() });
    eq('没有产生新投稿', res.submitted, 0);
    eq('零 cut（指纹命中在切割之前就返回了）', env.cuts.length, 0);
    eq('零 upload（不会出现重复稿件）', env.uploads.length, 0);
    eq('状态被指纹同步回 PUBLISHED', env.ledger.getClip(env.task.id, 0)?.status, 'PUBLISHED');
    eq('bvid 保持不变', env.ledger.getClip(env.task.id, 0)?.bvid, 'BV1alreadyUp');
    env.cleanup();
  }

  /* ---- 6. 重置 → 再同步（混合场景）：已投出的恢复、真漏的补投 ----
     ⚠️ 边界要说清：指纹只能证明「**曾经投出过**」，不能证明「**B站上还在**」——
     稿件被删/锁定后指纹仍命中 ⇒ 恢复 PUBLISHED（与 B站 漂移）。
     「B站 上还在不在」的核对属于「切片库 → 稿件体检」（missingLocal 判定 +
     逐片「重新投稿这一片」，那条路径会清指纹）；重置流程尊重指纹，是防双份的底线。
     「真漏」的判定 = 指纹表**无记录**（连 submit 都没发生过）⇒ 正常补投。 */
  section('6. 重置 → 再同步（混合）：有指纹的恢复、无指纹的补投');
  {
    const env = makeEnv(tmpRoot + '-6', [
      { status: 'PENDING_UPLOAD', cutOutput: path.join(tmpRoot + '-6', 'clips-out', '01.mp4') },
      { status: 'PENDING_UPLOAD', cutOutput: path.join(tmpRoot + '-6', 'clips-out', '02.mp4') },
    ]);
    fs.writeFileSync(path.join(tmpRoot + '-6', 'clips-out', '01.mp4'), 'x');
    fs.writeFileSync(path.join(tmpRoot + '-6', 'clips-out', '02.mp4'), 'x');
    // #0 曾投出且已确认：按真实落表顺序摆（SUBMITTING 带 fingerprint → PUBLISHED 带 bvid 触发 syncFingerprint）
    const fp0 = clipFingerprint({ sourceVideoId: env.task.recordingId ?? env.task.id, start: 100, end: 250, title: '第1段' });
    env.ledger.setClipStatus(env.task.id, 0, 'SUBMITTING', { fingerprint: fp0 });
    env.ledger.setClipStatus(env.task.id, 0, 'PUBLISHED', { bvid: 'BV1up' });
    // #1 从未成功 submit 过：指纹表里没有它 ⇒ 「真漏」
    // retry 的复位：非 CANDIDATE 一律复位（bvid/cutOutput 保留）
    env.ledger.setClipStatus(env.task.id, 0, 'CANDIDATE');
    env.ledger.setClipStatus(env.task.id, 1, 'CANDIDATE');
    const res = await env.publisher.publishClips({ task: env.task, uid: 12345, submitTimeMs: Date.now() });
    eq('#0 指纹命中 ⇒ 恢复 PUBLISHED（不重投）', env.ledger.getClip(env.task.id, 0)?.status, 'PUBLISHED');
    eq('#1 真漏 ⇒ 被补投', res.submitted, 1);
    eq('#1 走了产物复用（cut 0 次 —— 产物在就直接投）', env.cuts.length, 0);
    eq('#1 状态推进到 SUBMITTED', env.ledger.getClip(env.task.id, 1)?.status, 'SUBMITTED');
    eq('投稿载荷用的是 #1 自己的产物', String((env.uploads[0]?.['videos'] as string[])?.[0] ?? ''), path.join(tmpRoot + '-6', 'clips-out', '02.mp4'));
    env.cleanup();
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n\x1b[1m结果：${pass} 通过 / ${fail} 失败\x1b[0m`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
