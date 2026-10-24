/**
 * 「切片投稿方式」开关（追加切片投稿 / 单独投稿）的**真实分流**测试 —— 2026-10-16 加。
 *
 * 背景（用户要求）：切片投稿要能二选一 —— `追加切片投稿`（切片作为同一个稿件的分P）
 * 或 `单独投稿`（每片一稿）。这不是文案改动，而是**分流判据**的改动，而这个仓库
 * 恰好在这类改动上翻过车：`publish.multiPart` 当年配了却**在自动流程里从没被读取**，
 * 结果一场 8 个切片被投成 8 个独立稿件（占 8 个额度，事后要人工去 B站 一个个删）。
 *
 * 所以这里不看注释、不看配置，而是**走真实的 publishStage 分流**，断言：
 *   1. 显式「单独投稿」→ 走每片一稿，且不再等 biliLive-tools 的完整版稿件；
 *   2. 显式「追加切片投稿」→ 走多分P 追加（即使 multiPart 残留成 false 也以开关为准）；
 *   3. 两个键都没设的老配置 + multiPart=false → 仍然**拦住**（旧的防错保护不能丢）；
 *   4. 两个键都没设 + multiPart=true → 老行为逐字不变（追加、可用 resumeAid）。
 * 外加 `resolveClipPublishMode()` / `validateConfig()` 的口径表。
 *
 * 全程离线：假 publisher / 假 client / 临时 dataDir，不碰 B站、不切片、不投稿。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/daemon.ts';
import { Ledger } from '../src/ledger.ts';
import { resolveClipPublishMode, validateConfig, type AppConfig, type PublishConfig } from '../src/config.ts';

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
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

/**
 * 造一个临时环境：一场 ANALYZED 的直播 + 3 个选中切片 + 一份临时配置。
 *
 * `publishPatch` 直接覆盖 `config.json` 的 publish 段，用来摆出四种组合
 * （开关 + multiPart 的一致/矛盾、显式/未设）。
 */
function makeEnv(
  tmpRoot: string,
  publishPatch: Record<string, unknown>,
): { orch: Orchestrator; taskId: string; calls: Record<string, unknown[]> } {
  const dataDir = path.join(tmpRoot, 'data');
  const taskId = 'cpm-test-0001';
  const taskDir = path.join(dataDir, 'tasks', taskId);
  fs.mkdirSync(path.join(taskDir, 'full'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'clips', taskId), { recursive: true });

  const ledger = new Ledger({ path: path.join(dataDir, 'ledger.json') });
  ledger.createTask({
    id: taskId,
    roomId: '12345678',
    title: '切片投稿方式测试场',
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

  const clips = [0, 1, 2].map((i) => ({
    index: i,
    start: 100 + i * 400,
    end: 250 + i * 400,
    title: `第${i + 1}段`,
    desc: '',
    tags: ['测试'],
    category: '游戏/单机游戏',
    score: 8 - i,
    selected: true,
    status: 'CANDIDATE' as const,
  }));
  ledger.setClips(taskId, clips as never);

  /* 完整版 / 纯享版产物（真的写文件 —— 多分P 路径会 exists() 检查它们；
     缺了就会在"没有可用产物"处提前返回，于是 publishAsMultiPart 根本不会被调用，
     那样本测试会误报成"没走多分P"。multipart-routing 的替身也做了同一件事）。 */
  const fullPath = path.join(taskDir, 'full', 'full-p1.mp4');
  fs.writeFileSync(fullPath, 'x');
  fs.writeFileSync(path.join(taskDir, 'full', 'pure-p2.mp4'), 'x');
  ledger.updateTask(taskId, { source: { ...ledger.getTask(taskId)!.source, fullVideoPath: fullPath } });

  const realCfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')) as Record<string, unknown>;
  const configPath = path.join(tmpRoot, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...realCfg,
        publish: {
          ...(realCfg['publish'] as object),
          /* ★ 与本用例相关的键**一律显式给值**，绝不从线上配置继承 ——
             线上 config.json 是可变的（用户会改、别的会话也在实测它），
             继承会让用例的结果随线上配置漂移（实测：另一个会话把线上切成单独投稿时，
             本套件的"老配置"用例就假红了）。默认摆成"老配置"：两个模式键都不给，
             由 publishPatch 决定这一节要测什么。 */
          multiPart: true,
          fullVideoBy: 'bililive-tools',
          clipPublishMode: undefined,
          resumeAid: '',
          resumeTitleTemplate: '',
          ...publishPatch,
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const orch = new Orchestrator({ configPath, dataDirOverride: dataDir, ledger });

  /* ---- 假 publisher：只记录"走了哪条路"，不碰网络/ffmpeg ---- */
  const calls: Record<string, unknown[]> = { publishClips: [], publishAsMultiPart: [] };
  const fakePublisher = {
    publishClips: async (opts: Record<string, unknown>) => {
      calls['publishClips']!.push(opts);
      /* ⚠️ 必须区分 skipUpload：多分P 路径下这个调用**只切片**（切完停在 CUT，
         由后面的 publishMultiPart 统一投），单独投稿路径下它真的投出去（SUBMITTED）。
         替身若一律置 SUBMITTED，多分P 阶段会认为"这些切片都已经投过了"而提前返回 ——
         于是 publishAsMultiPart 永远不被调用，测试会误报成"没走多分P"（第一版就是这样错的）。 */
      const skipUpload = opts['skipUpload'] === true;
      const targets = orch.ledger.getClips(taskId).filter((c) => c.selected);
      const out = targets.map((c) => {
        const p = path.join(dataDir, 'clips', taskId, `${c.index}.mp4`);
        fs.writeFileSync(p, 'x');
        orch.ledger.setClipStatus(taskId, c.index, skipUpload ? 'CUT' : 'SUBMITTED', { cutOutput: p });
        return { clipIndex: c.index, ok: true, output: p, warnings: [] as string[], bvid: `BVfake${c.index}` };
      });
      return {
        results: out,
        submitted: skipUpload ? 0 : out.length,
        skipped: skipUpload ? out.length : 0,
        failed: 0,
        quota: { todayCount: 0, remain: 10, requested: out.length },
      };
    },
    publishAsMultiPart: async (opts: Record<string, unknown>) => {
      calls['publishAsMultiPart']!.push(opts);
      const clipList = opts['clips'] as Array<{ index: number; title: string }>;
      const parts = clipList.map((c) => ({ path: path.join(dataDir, 'clips', taskId, `${c.index}.mp4`), title: c.title, kind: 'clip' as const, clipIndex: c.index }));
      for (const c of clipList) orch.ledger.setClipStatus(taskId, c.index, 'SUBMITTED', { cutOutput: parts.find((p) => p.clipIndex === c.index)?.path });
      return { ok: true, uploadTaskId: 'fake-mp-1', mainTitle: '切片投稿方式测试场 2026-10-16', parts, warnings: [], mode: 'create' as const };
    },
    readPartCount: async (): Promise<number | undefined> => 2,
  };
  (orch as unknown as { publisher: unknown }).publisher = fakePublisher;

  /* 告警换空实现：`beginPublishWait` 会 alerter.send（真实渠道 = Server酱），
     否则每跑一次测试就给用户推一条通知（multipart-routing 里踩过）。 */
  (orch as unknown as { alerter: unknown }).alerter = {
    send: async () => [],
    failure: async () => {},
    publishFailed: async () => {},
    publishSuccess: async () => {},
    analysisDone: async () => {},
    recordingDone: async () => {},
    taskRecap: async () => {},
    diskLow: async () => {},
    testChannel: async () => ({ channel: 'stub', ok: true, message: 'stub' }),
  };

  /* 假 client：publishStage 开头要 userList()；稿件列表给空（自动查找落空） */
  (orch as unknown as { client: unknown }).client = {
    userList: async () => [{ uid: 12345, name: 'stub' }],
    biliArchives: async () => [],
    biliUpload: async () => ({ taskId: 'fake-upload-1' }),
  };

  return { orch, taskId, calls };
}

const silentLog = { info: (): void => {}, warn: (): void => {}, error: (): void => {}, debug: (): void => {}, child: (): unknown => silentLog };

/** 走真实的 publishStage（公开入口），返回它的结果。
 *  ⚠️ 契约类拦截是**抛异常**（StageError 一路抛到调用方，由队列层兜），不是返回 ok:false ——
 *  所以这里把异常也收成同一形状，两种结果都好断言。 */
async function runStage(orch: Orchestrator, taskId: string): Promise<{ ok: boolean; stoppedAt: string; error?: string }> {
  try {
    return (await orch.publishStage(taskId, silentLog as never)) as { ok: boolean; stoppedAt: string; error?: string };
  } catch (e) {
    return { ok: false, stoppedAt: 'CLIPPED', error: (e as Error).message };
  }
}

async function main(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cpm-'));

  /* 错误事件流/报告重定向到临时目录（模块级常量，dataDirOverride 管不到） */
  const { setErrorsPath, setErrorReportDir } = await import('../src/errors.ts');
  setErrorsPath(path.join(tmpRoot, 'errors.jsonl'));
  setErrorReportDir(path.join(tmpRoot, 'error-report'));

  /* ======================================================================
   * 一、口径表：resolveClipPublishMode（显式优先，未设时按 multiPart 反推）
   * ==================================================================== */
  section('1. 口径表：resolveClipPublishMode（新键优先；没设时按 multiPart 反推 = 老配置行为不变）');
  {
    const r = (p: Partial<PublishConfig>): string => resolveClipPublishMode({ multiPart: true, ...p } as PublishConfig);
    eq('显式 standalone（即使 multiPart=true）⇒ standalone', r({ clipPublishMode: 'standalone' }), 'standalone');
    eq('显式 append（即使 multiPart=false）⇒ append', r({ clipPublishMode: 'append', multiPart: false }), 'append');
    eq('没设 + multiPart=true ⇒ append（老行为）', r({ multiPart: true }), 'append');
    eq('没设 + multiPart=false ⇒ standalone（老行为）', r({ multiPart: false }), 'standalone');
  }

  /* ======================================================================
   * 二、显式「单独投稿」：每片一稿，且不再等完整版稿件
   * ==================================================================== */
  section('2. 显式「单独投稿」（multiPart 残留 true 也以开关为准）→ 每片一稿，不等完整版稿件');
  {
    const { orch, taskId, calls } = makeEnv(path.join(tmpRoot, 'a'), {
      clipPublishMode: 'standalone',
      multiPart: true,
      fullVideoBy: 'bililive-tools',
    });
    const res = await runStage(orch, taskId);
    const cut = calls['publishClips']![0] as Record<string, unknown> | undefined;

    ok('走 publishClips（每片一稿）', calls['publishClips']!.length === 1, `实际 ${calls['publishClips']!.length} 次`);
    ok('★ 不再调 publishAsMultiPart（不追加进任何已有稿件）', calls['publishAsMultiPart']!.length === 0, `实际 ${calls['publishAsMultiPart']!.length} 次`);
    ok('★ publishClips 不带 skipUpload（真的投出去，而不是"先切片等完整版"）', cut?.['skipUpload'] !== true, `实际 skipUpload=${String(cut?.['skipUpload'])}`);
    ok('本场没有停在「等 biliLive-tools 完整版稿件」', orch.ledger.getTask(taskId)!.publishWait === undefined, JSON.stringify(orch.ledger.getTask(taskId)!.publishWait));
    ok('阶段没报错（旧代码在这里会抛 contract 错误）', res.ok === true, `ok=${String(res.ok)} error=${String(res.error)}`);
    ok('3 个切片全部投出', orch.ledger.getClips(taskId).filter((c) => c.status === 'SUBMITTED').length === 3, orch.ledger.getClips(taskId).map((c) => c.status).join(','));
  }

  /* ======================================================================
   * 三、显式「追加切片投稿」：multiPart 残留 false 也以开关为准
   * ==================================================================== */
  section('3. 显式「追加切片投稿」（multiPart 残留 false）→ 仍走多分P 追加');
  {
    const { orch, taskId, calls } = makeEnv(path.join(tmpRoot, 'b'), {
      clipPublishMode: 'append',
      multiPart: false,
      fullVideoBy: 'assistant',
    });
    const res = await runStage(orch, taskId);
    const cut = calls['publishClips']![0] as Record<string, unknown> | undefined;
    ok('走多分P（publishAsMultiPart 被调用一次）', calls['publishAsMultiPart']!.length === 1, `实际 ${calls['publishAsMultiPart']!.length} 次`);
    ok('多分P 前的切片带 skipUpload=true（先切片、不单独投）', cut?.['skipUpload'] === true, `实际 ${String(cut?.['skipUpload'])}`);
    ok('阶段没报错', res.ok === true, `ok=${String(res.ok)} error=${String(res.error)}`);
  }

  /* ======================================================================
   * 四、老配置（两个键都没设）+ multiPart=false → 仍然拦住（防错保护不能丢）
   * ==================================================================== */
  section('4. 老配置没设开关 + multiPart=false + 完整版归 biliLive-tools → 仍然拦住（不投出一堆单片）');
  {
    const { orch, taskId, calls } = makeEnv(path.join(tmpRoot, 'c'), {
      multiPart: false,
      clipPublishMode: undefined,
      fullVideoBy: 'bililive-tools',
    });
    /* 配置里显式删掉这个键，模拟"加入开关之前的老配置" */
    const cfgPath = path.join(tmpRoot, 'c', 'config.json');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { publish: Record<string, unknown> };
    delete raw.publish['clipPublishMode'];
    fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8');

    const res = await runStage(orch, taskId);
    ok('阶段失败（拦住）', res.ok === false, `ok=${String(res.ok)}`);
    ok('原因指向 publish.multiPart', /必须开启 publish\.multiPart/.test(String(res.error)), String(res.error));
    ok('★ 一个稿件都没投出去（失败要"关死"，不能偷偷投出单片）', calls['publishClips']!.length === 0 && calls['publishAsMultiPart']!.length === 0, `publishClips=${calls['publishClips']!.length} multiPart=${calls['publishAsMultiPart']!.length}`);
  }

  /* ======================================================================
   * 五、老配置 + multiPart=true → 老行为逐字不变（追加 + 续传 aid）
   * ==================================================================== */
  section('5. 老配置没设开关 + multiPart=true → 追加（可用 resumeAid 续传）');
  {
    const { orch, taskId, calls } = makeEnv(path.join(tmpRoot, 'd'), {
      multiPart: true,
      clipPublishMode: undefined,
      fullVideoBy: 'assistant',
    });
    const res = await runStage(orch, taskId);
    const mp = calls['publishAsMultiPart']![0] as Record<string, unknown> | undefined;
    ok('走多分P 追加', calls['publishAsMultiPart']!.length === 1, `实际 ${calls['publishAsMultiPart']!.length} 次`);
    ok('完整版路径仍传给多分P（老行为）', typeof mp?.['fullVideoPath'] === 'string' || mp?.['fullVideoPath'] === undefined, `fullVideoPath=${String(mp?.['fullVideoPath'])}`);
    ok('阶段没报错', res.ok === true, `ok=${String(res.ok)} error=${String(res.error)}`);
  }

  /* ======================================================================
   * 六、校验口径：显式开关是"明确意图"，不该被硬约束拦住
   * ==================================================================== */
  section('6. validateConfig：显式「单独投稿」不再报错（否则开关点了没反应），老错位仍然报错');
  {
    const base = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')) as AppConfig;
    const withPublish = (patch: Partial<PublishConfig>): AppConfig => ({ ...base, publish: { ...base.publish, ...patch } });
    const errs = (c: AppConfig): string[] => validateConfig(c).filter((i) => i.level === 'error').map((i) => i.field);
    const warns = (c: AppConfig): string[] => validateConfig(c).filter((i) => i.level === 'warn').map((i) => i.field);

    ok(
      '★ 显式 standalone + multiPart=false + bililive-tools ⇒ 无 error（正是"单独投稿"该有的样子）',
      !errs(withPublish({ clipPublishMode: 'standalone', multiPart: false, fullVideoBy: 'bililive-tools' })).includes('publish.multiPart'),
      errs(withPublish({ clipPublishMode: 'standalone', multiPart: false, fullVideoBy: 'bililive-tools' })).join(','),
    );
    ok(
      '★ standalone + multiPart 残留 true ⇒ 不报错，但给一条 warn 说明 multiPart 会被忽略',
      !errs(withPublish({ clipPublishMode: 'standalone', multiPart: true, fullVideoBy: 'bililive-tools' })).includes('publish.multiPart') &&
        warns(withPublish({ clipPublishMode: 'standalone', multiPart: true, fullVideoBy: 'bililive-tools' })).includes('publish.clipPublishMode'),
      warns(withPublish({ clipPublishMode: 'standalone', multiPart: true, fullVideoBy: 'bililive-tools' })).join(','),
    );
    ok(
      '★ 显式 append + multiPart=false ⇒ 报错（两个口径打架时以开关为准，但必须让人看见）',
      errs(withPublish({ clipPublishMode: 'append', multiPart: false, fullVideoBy: 'bililive-tools' })).includes('publish.multiPart'),
      errs(withPublish({ clipPublishMode: 'append', multiPart: false, fullVideoBy: 'bililive-tools' })).join(','),
    );
    ok(
      '★ 老配置（没设开关）+ multiPart=false ⇒ 仍然报错（防错保护一字未减）',
      errs(withPublish({ clipPublishMode: undefined, multiPart: false, fullVideoBy: 'bililive-tools' })).includes('publish.multiPart'),
      errs(withPublish({ clipPublishMode: undefined, multiPart: false, fullVideoBy: 'bililive-tools' })).join(','),
    );
    /* ⚠️ 只钉"与切片投稿方式有关的那两条规则"，不断言"线上配置零错误"：
       线上配置会被用户与别的会话随时改动（实测被切到单独投稿过），
       那种漂移不该让本用例变红 —— 与本开关无关的历史告警也不该。 */
    ok(
      '线上配置在「切片投稿方式」这两条规则上是干净的（没有自相矛盾）',
      errs(base).filter((f) => f === 'publish.multiPart').length === 0,
      errs(base).join(','),
    );
  }

  console.log('\n' + '─'.repeat(74));
  console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log('  \x1b[31m·\x1b[0m ' + f);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\x1b[31m测试脚本自身出错：\x1b[0m' + (e as Error).message);
  process.exit(1);
});
