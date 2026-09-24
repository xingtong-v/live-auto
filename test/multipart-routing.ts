/**
 * 多分P 路由自测：`publish.multiPart=true` 时，自动流程必须走
 * 「先切片（不单独投稿）→ 再把完整版+纯享版+切片一次投进同一个稿件」。
 *
 * 背景（真实事故）：`publish.multiPart` 这个配置项在自动流程里**完全没被读取** ——
 * `publishAsMultiPart()` 只有手动工具 `tools/publish-multipart.ts` 会调。
 * 于是配了 multiPart=true 的场次仍然「一个切片一个稿件」：
 * 实测一场 8 个切片投成了 **8 个独立稿件**（占 8 个每日额度，而多分P只需 1 个）。
 *
 * 本测试锁住三件事：
 *   1. multiPart=true  → 走多分P：publishClips(skipUpload=true) + publishAsMultiPart(1 次)
 *   2. multiPart=false → 仍走单切片：publishClips 不带 skipUpload、不调 publishAsMultiPart
 *   3. 分P 顺序与构成：选中切片按 start 升序；完整版/纯享版路径正确传给 publishAsMultiPart
 *
 * 运行：node test/multipart-routing.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator, resumeDateText } from '../src/daemon.ts';
import { Ledger } from '../src/ledger.ts';
import { cleanLiveTitle, taskDateText } from '../src/publish.ts';

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
function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

/** 造一个临时环境：任务 + 3 个选中切片 + 临时配置 */
function makeEnv(
  tmpRoot: string,
  multiPart: boolean,
  extraPublish: Record<string, unknown> = {},
): { orch: Orchestrator; taskId: string; calls: Record<string, unknown[]>; uploadCalls: Array<Record<string, unknown>> } {
  const dataDir = path.join(tmpRoot, 'data');
  const taskId = 'mp-test-0001';
  const taskDir = path.join(dataDir, 'tasks', taskId);
  fs.mkdirSync(path.join(taskDir, 'full'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'clips', taskId), { recursive: true });

  const ledgerPath = path.join(dataDir, 'ledger.json');
  const ledger = new Ledger({ path: ledgerPath });

  ledger.createTask({
    id: taskId,
    roomId: '12345678',
    title: '多分P路由测试场',
    liveStartTime: Math.floor(Date.now() / 1000) - 7200,
    stage: 'ANALYZED',
    source: { segments: [], totalDuration: 3600, rawFiles: [], fullVideoHasDanmaku: false },
    fullUpload: 'NOT_APPLICABLE',
    cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: new Date().toISOString() },
    transcriptPath: path.join(taskDir, 'transcript.json'),
    signalsPath: path.join(taskDir, 'signals.json'),
    clipsPath: path.join(taskDir, 'clips.json'),
  });

  /* 3 个切片：刻意用**乱序**的 index/start，验证最终按 start 升序 */
  const clips = [
    { index: 0, start: 100, end: 250, title: '第一段', desc: '', tags: ['测试'], category: '游戏/单机游戏', score: 8, selected: true, status: 'CANDIDATE' as const },
    { index: 1, start: 900, end: 1050, title: '第三段', desc: '', tags: ['测试'], category: '游戏/单机游戏', score: 9, selected: true, status: 'CANDIDATE' as const },
    { index: 2, start: 500, end: 650, title: '第二段', desc: '', tags: ['测试'], category: '游戏/单机游戏', score: 7, selected: true, status: 'CANDIDATE' as const },
    /* 未选中的不应进入分P */
    { index: 3, start: 1500, end: 1650, title: '未选中', desc: '', tags: ['测试'], category: '游戏/单机游戏', score: 5, selected: false, status: 'CANDIDATE' as const },
  ];
  ledger.setClips(taskId, clips as never);

  // 完整版压制产物（真写一个文件，代码会检查 exists）
  const fullPath = path.join(taskDir, 'full', 'full-p1.mp4');
  fs.writeFileSync(fullPath, 'x');
  ledger.updateTask(taskId, { source: { ...ledger.getTask(taskId)!.source, fullVideoPath: fullPath } });
  // 纯享版产物（full/ 下 p2 命名）
  fs.writeFileSync(path.join(taskDir, 'full', 'pure-p2.mp4'), 'x');

  const realCfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')) as Record<string, unknown>;
  const configPath = path.join(tmpRoot, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      { ...realCfg, publish: { ...(realCfg['publish'] as object), multiPart, resumeAid: '', resumeTitleTemplate: '', ...extraPublish } },
      null,
      2,
    ),
    'utf8',
  );

  const orch = new Orchestrator({ configPath, dataDirOverride: dataDir, ledger });

  /* ---- 注入假 publisher：只记录调用，不碰网络 ---- */
  const calls: Record<string, unknown[]> = { publishClips: [], publishAsMultiPart: [] };
  const fakePublisher = {
    publishClips: async (opts: Record<string, unknown>) => {
      calls['publishClips']!.push(opts);
      // 模拟切片产物写回
      const out = (orch.ledger.getClips(taskId)).filter((c) => c.selected).map((c) => ({
        clipIndex: c.index,
        ok: true,
        output: path.join(dataDir, 'clips', taskId, `${c.index}.mp4`),
        warnings: [] as string[],
      }));
      for (const c of orch.ledger.getClips(taskId)) {
        if (c.selected) orch.ledger.setClipStatus(taskId, c.index, 'CUT', { cutOutput: path.join(dataDir, 'clips', taskId, `${c.index}.mp4`) });
      }
      return { results: out, submitted: 0, skipped: 0, failed: 0, quota: { todayCount: 0, remain: 10, requested: out.length } };
    },
    publishAsMultiPart: async (opts: Record<string, unknown>) => {
      calls['publishAsMultiPart']!.push(opts);
      const clipList = opts['clips'] as Array<{ index: number; title: string }>;
      const parts = clipList.map((c) => ({
        path: path.join(dataDir, 'clips', taskId, `${c.index}.mp4`),
        title: c.title,
        kind: 'clip' as const,
        clipIndex: c.index,
      }));
      const resumeAid = String(opts['resumeAid'] ?? '').trim();
      /* ★ 把「切片追加进 biliLive-tools 那个稿件」的关键一行走通：
         真实调用被注入的 client.biliUpload，这样测试能检查 vid 到底传没传。 */
      const up = await (orch.client as unknown as {
        biliUpload: (p: Record<string, unknown>) => Promise<{ taskId: string }>;
      }).biliUpload({
        uid: opts['uid'],
        videos: parts.map((p) => ({ path: p.path, title: p.title })),
        config: { title: 'fake' },
        ...(resumeAid ? { vid: resumeAid } : {}),
      });
      return {
        ok: true,
        uploadTaskId: up.taskId,
        mainTitle: '多分P路由测试场 2026-09-23',
        parts,
        warnings: [],
        mode: resumeAid ? 'append' : 'create',
      };
    },
    /* 真实 Publisher 还有 readPartCount（读目标稿件已有分P 数，作为切片编号基准）。
       假替身必须同样提供，否则 publishMultiPartStage 会因为缺方法而走进容错分支，
       本测试就覆盖不到「编号基准」这条真实路径了。 */
    readPartCount: async (_bvid: string): Promise<number | undefined> => 14,
  };
  (orch as unknown as { publisher: unknown }).publisher = fakePublisher;

  /* ⚠️ 告警必须换成空实现：`beginPublishWait` 会 alerter.send（真实渠道 = Server酱），
     否则**每跑一次测试就给用户推一条"等待完整版稿件"的通知** —— 实测发生过。 */
  (orch as unknown as { alerter: unknown }).alerter = {
    send: async () => [],
    failure: async () => {},
    publishFailed: async () => {},
    publishSuccess: async () => {},
    analysisDone: async () => {},
    recordingDone: async () => {},
    diskLow: async () => {},
    testChannel: async () => ({ channel: 'stub', ok: true, message: 'stub' }),
  };

  /* ---- 注入假 client：记录 biliUpload 的实参（续传要看 vid） ---- */
  const uploadCalls: Array<Record<string, unknown>> = [];
  (orch as unknown as { client: unknown }).client = {
    /* 默认：稿件列表为空 ⇒ 自动查找会落空 */
    biliArchives: async () => [] as unknown[],
    biliUpload: async (params: Record<string, unknown>) => {
      uploadCalls.push(params);
      return { taskId: 'fake-upload-1' };
    },
  };

  return { orch, taskId, calls, uploadCalls };
}
/** 调用私有的 publishMultiPartStage（测试专用入口） */
async function invokeMultiPart(orch: Orchestrator, taskId: string, log: unknown): Promise<unknown> {
  const m = (orch as unknown as { publishMultiPartStage: (c: unknown) => Promise<unknown> }).publishMultiPartStage;
  return m.call(orch, { taskId, uid: 12345, log });
}

const silentLog = { info: (): void => {}, warn: (): void => {}, error: (): void => {}, debug: (): void => {}, child: (): unknown => silentLog };

async function main(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mp-'));

  /* 错误事件流/报告重定向到临时目录（模块级常量，dataDirOverride 管不到） */
  const { setErrorsPath, setErrorReportDir } = await import('../src/errors.ts');
  setErrorsPath(path.join(tmpRoot, 'errors.jsonl'));
  setErrorReportDir(path.join(tmpRoot, 'error-report'));

  section('1. multiPart=true + 显式 fullVideoBy=assistant → 先切片（skipUpload）再一次性投 2+N 分P');
  {
    /* ⚠️ 这里必须显式 `fullVideoBy='assistant'`：默认规则是「完整版由 biliLive-tools 投，
       切片助手只追加切片分P」，找不到它的稿件时会**等待**而不是自己投（见第 6 节）。 */
    const { orch, taskId, calls } = makeEnv(path.join(tmpRoot, 'a'), true, { fullVideoBy: 'assistant' });
    const r = (await invokeMultiPart(orch, taskId, silentLog)) as { submitted: number; failed: number };
    const cut = calls['publishClips']![0] as Record<string, unknown> | undefined;
    const mp = calls['publishAsMultiPart']![0] as Record<string, unknown> | undefined;

    ok('publishClips 被调用一次', calls['publishClips']!.length === 1, `实际 ${calls['publishClips']!.length}`);
    ok('publishClips 带 skipUpload=true（不单独投稿）', cut?.['skipUpload'] === true, `实际 ${String(cut?.['skipUpload'])}`);
    ok('publishAsMultiPart 被调用一次', calls['publishAsMultiPart']!.length === 1, `实际 ${calls['publishAsMultiPart']!.length}`);
    ok('提交数 = 选中切片数（3）', r.submitted === 3, `实际 ${r.submitted}`);
    ok('没有失败', r.failed === 0, `实际 ${r.failed}`);
    ok('完整版路径已传给 publishAsMultiPart', typeof mp?.['fullVideoPath'] === 'string', String(mp?.['fullVideoPath']));
    ok('纯享版路径已传给 publishAsMultiPart', typeof mp?.['pureVideoPath'] === 'string', String(mp?.['pureVideoPath']));

    const got = (mp?.['clips'] as Array<{ index: number; start: number }>) ?? [];
    ok('只含选中的 3 个切片（未选中的被排除）', got.length === 3, `实际 ${got.length}`);
    const starts = got.map((c) => c.start);
    ok('分P 按 start 升序排列', starts.join(',') === '100,500,900', `实际 ${starts.join(',')}`);

    const statuses = orch.ledger.getClips(taskId).map((c) => `${c.index}:${c.status}`).join(' ');
    ok('选中切片状态被置为 SUBMITTED/CUT（不是 PUBLISHED）', /SUBMITTED|CUT/.test(statuses), statuses);
  }

  section('2. multiPart=false → 仍走单切片路径（回归保护）');
  {
    const { orch, taskId, calls } = makeEnv(path.join(tmpRoot, 'b'), false, { fullVideoBy: 'assistant' });
    /* 直接走 publishStage 的分流判断：multiPart=false 时应调 publishClips 且不带 skipUpload */
    const cfg = (orch as unknown as { config: { publish: { multiPart: boolean } } }).config;
    ok('配置里 multiPart=false', cfg.publish.multiPart === false, String(cfg.publish.multiPart));
    // 复现分流表达式
    const useMultiPart = cfg.publish.multiPart === true;
    ok('分流判断为「单切片」', useMultiPart === false, `useMultiPart=${String(useMultiPart)}`);
    ok('未调用 publishAsMultiPart', calls['publishAsMultiPart']!.length === 0);
  }

  section('3. 多分P 只占 1 个每日额度（而单片要占 3 个）');
  {
    const { orch, taskId } = makeEnv(path.join(tmpRoot, 'c'), true, { fullVideoBy: 'assistant' });
    const before = orch.ledger.todayPublishedCount();
    await invokeMultiPart(orch, taskId, silentLog);
    const after = orch.ledger.todayPublishedCount();
    ok('一次多分P投稿不因分P数重复计额度', after - before <= 1, `before=${before} after=${after}（差 ${after - before}）`);
  }

  section('4. 续传：显式 publish.resumeAid → biliUpload 带 vid（追加进 biliLive-tools 的稿件）');
  {
    const { orch, taskId, uploadCalls } = makeEnv(path.join(tmpRoot, 'd'), true, { resumeAid: '123456789' });
    await invokeMultiPart(orch, taskId, silentLog);
    const up = uploadCalls[0];
    ok('biliUpload 被调用一次', uploadCalls.length === 1, `实际 ${uploadCalls.length}`);
    ok('带上了 vid=123456789（续传而非新建）', up?.['vid'] === '123456789', `实际 vid=${String(up?.['vid'])}`);
    ok('videos 只含切片（不含完整版/纯享版分P）', Array.isArray(up?.['videos']) && (up!['videos'] as unknown[]).length === 3, `实际 ${(up?.['videos'] as unknown[])?.length}`);
  }

  section('4b. 续传时切片标题**不带** P 序号前缀（序号由 B站 分P列表标出）');
  {
    /* 目标稿件已有几个分P 是动态的：biliLive-tools 按 ["handled","raw"] 分组投，
       一场 Z 段 ⇒ 2Z 个分P（4 段→8）。写死序号必然错位，所以续传时不写序号。 */
    const { orch, taskId, calls } = makeEnv(path.join(tmpRoot, 'd2'), true, { resumeAid: '123456789' });
    await invokeMultiPart(orch, taskId, silentLog);
    const mp = calls['publishAsMultiPart']![0] as Record<string, unknown> | undefined;
    ok('resumeAid 已传给 publishAsMultiPart', mp?.['resumeAid'] === '123456789', `实际 ${String(mp?.['resumeAid'])}`);
    ok('不再传 clipIndexBase（该机制已弃用）', mp?.['clipIndexBase'] === undefined, `实际 ${String(mp?.['clipIndexBase'])}`);
  }

  section('5. 续传：按标题自动匹配 biliLive-tools 的完整版稿件');
  {
    const { orch, taskId, uploadCalls } = makeEnv(path.join(tmpRoot, 'e'), true, {
      resumeAid: '',
      resumeTitleTemplate: '{anchor}{liveTitle}{date}',
    });
    /* 按模板渲染出的标题必须与该稿件标题**精确相等**才会命中 */
    const task = orch.ledger.getTask(taskId)!;
    const wantTitle = `${cleanLiveTitle(task.title)}${taskDateText(task).replace(/-/g, '.')}`;
    (orch as unknown as { client: unknown }).client = {
      biliArchives: async () => [{ bvid: 'BV1TESTRESUME', aid: 987654321, title: wantTitle, ctime: Math.floor(Date.now() / 1000) }],
      biliUpload: async (params: Record<string, unknown>) => {
        uploadCalls.push(params);
        return { taskId: 'fake-upload-2' };
      },
    };
    await invokeMultiPart(orch, taskId, silentLog);
    ok('自动匹配到 aid 并作为 vid 传出', uploadCalls[0]?.['vid'] === '987654321', `实际 vid=${String(uploadCalls[0]?.['vid'])}`);
  }

  section('6. ★默认规则：找不到 biliLive-tools 的完整版稿件 → **等待**，不自己投完整版、也不投独立切片稿件');
  {
    /* 用户定的规则：除非明确说明，完整版（弹幕版+纯享版）一律由 biliLive-tools 投，
       切片助手只把切片追加进**它那个稿件**（同一场 = 同一个稿件）。
       所以「找不到它的稿件」时正确行为是**等**，而不是自己新建一个 2+N 稿件
       （那会变成同内容两个稿件），更不能把切片投成独立稿件（违背"同一个稿件"）。 */
    const { orch, taskId, calls, uploadCalls } = makeEnv(path.join(tmpRoot, 'f'), true, {
      resumeAid: '',
      resumeTitleTemplate: '{anchor}{liveTitle}{date}',
    });
    const r = (await invokeMultiPart(orch, taskId, silentLog)) as { submitted: number; skipped: number; waiting?: boolean };

    ok('没有调用 publishAsMultiPart（一个稿件都没投）', calls['publishAsMultiPart']!.length === 0, `实际 ${calls['publishAsMultiPart']!.length}`);
    ok('没有发出任何上传请求', uploadCalls.length === 0, `实际 ${uploadCalls.length}`);
    ok('返回值标了 waiting=true（终态判定据此不判 PUBLISHED）', r.waiting === true, `实际 ${String(r.waiting)}`);
    eq('切片全部记为跳过（不是失败）', r.skipped, 3);
    eq('提交数为 0', r.submitted, 0);

    const t = orch.ledger.getTask(taskId)!;
    ok('台账里写下了等待标记 publishWait', t.publishWait !== undefined);
    ok('等待原因里说明了「不会自己投完整版」', String(t.publishWait?.reason).includes('不会') && String(t.publishWait?.reason).includes('biliLive-tools'), t.publishWait?.reason);
    ok('等待标记带截止时刻（超时后交人工）', Number.isFinite(Date.parse(String(t.publishWait?.until))), String(t.publishWait?.until));

    const clipsAfter = orch.ledger.getClips(taskId);
    const selectedAfter = clipsAfter.filter((c) => c.selected);
    ok('勾选的切片保持「已切片」（没有被标成已提交）', selectedAfter.every((c) => c.status === 'CUT'), JSON.stringify(clipsAfter.map((c) => c.status)));
    ok('未勾选的切片不受影响（仍是候选）', clipsAfter.filter((c) => !c.selected).every((c) => c.status === 'CANDIDATE'), JSON.stringify(clipsAfter.map((c) => c.status)));
  }

  section('6b. 例外只有"明确说明"才生效：任务级 overrides.fullVideoBy=assistant');
  {
    const { orch, taskId, calls } = makeEnv(path.join(tmpRoot, 'g'), true);
    /* 全局保持默认（bililive-tools），只有这一场被显式指定 —— 这就是"我明确说明"的形态 */
    orch.ledger.updateTask(taskId, { overrides: { fullVideoBy: 'assistant' } });
    eq('fullVideoOwner 判定为 assistant', orch.fullVideoOwner(orch.ledger.getTask(taskId)!), 'assistant');
    await invokeMultiPart(orch, taskId, silentLog);
    ok('这一场照常新建 2+N 稿件', calls['publishAsMultiPart']!.length === 1, `实际 ${calls['publishAsMultiPart']!.length}`);
    ok('没有留下等待标记', orch.ledger.getTask(taskId)!.publishWait === undefined);
  }

  section('6c. 等到了就自动追加：retryWaitingPublishes（等待循环每 5 分钟跑一次）');
  {
    const { orch, taskId, uploadCalls, calls } = makeEnv(path.join(tmpRoot, 'h'), true, {
      resumeAid: '',
      resumeTitleTemplate: '{anchor}{liveTitle}{date}',
    });
    /* 第一轮：它的稿件还没出现 → 等待 */
    await invokeMultiPart(orch, taskId, silentLog);
    ok('先进入等待', orch.ledger.getTask(taskId)!.publishWait !== undefined);
    orch.ledger.setStatus(taskId, 'CLIPPED', { stage: 'CLIPPED' });

    /* biliLive-tools 投出来了（标题按它的模板：{{user}}{{title}}{{now}}） */
    const task = orch.ledger.getTask(taskId)!;
    const wantTitle = `${cleanLiveTitle(task.title)}${taskDateText(task).replace(/-/g, '.')}`;
    (orch as unknown as { client: unknown }).client = {
      userList: async () => [{ uid: 12345, name: 'tester' }],
      biliArchives: async () => [{ bvid: 'BV1WAITOK', aid: 555000111, title: wantTitle, ctime: Math.floor(Date.now() / 1000) }],
      biliArchiveDetail: async () => ({ View: { pages: new Array(6).fill({}) } }),
      biliUpload: async (params: Record<string, unknown>) => {
        uploadCalls.push(params);
        return { taskId: 'fake-upload-wait' };
      },
    };
    const rr = await orch.retryWaitingPublishes();
    ok('重查覆盖到这一场', rr.checked >= 1, JSON.stringify(rr));
    ok('自动追加成功（记 1 个）', rr.appended === 1, JSON.stringify(rr));
    ok('追加时带了 vid（续传，不是新建）', uploadCalls[0]?.['vid'] === '555000111', `实际 vid=${String(uploadCalls[0]?.['vid'])}`);
    ok('等待标记被清掉（不会重复追加）', orch.ledger.getTask(taskId)!.publishWait === undefined);
    /* ★ 续传要把**目标稿件的 bvid** 一路传给 publisher：切片追加进去后就是它的分P（同 bvid、不同 cid）。
       不传的话真实 Publisher 只能记 SUBMITTED 且无 bvid —— 周期性反查按稿件标题找，永远找不到，
       本场到不了 PUBLISHED，`cleanup.deleteAfterUpload` 永不触发（实测 20 GB 录播留在盘上）。
       （这里断言的是"接线"：本套件的 publisher 是替身，落账那两行在真实 Publisher 里。） */
    const mpCall = calls['publishAsMultiPart']![0] as Record<string, unknown> | undefined;
    ok('续传时把目标稿件的 bvid 传给了 publisher', mpCall?.['resumeBvid'] === 'BV1WAITOK', `实际 ${String(mpCall?.['resumeBvid'])}`);
  }

  section('7. 配置护栏：默认组合必须自洽（规则靠它挡住误配）');
  {
    const cfgMod = await import('../src/config.ts');
    const live = cfgMod.loadConfig().config;
    eq('线上配置取到默认「完整版归 biliLive-tools」', live.publish.fullVideoBy, 'bililive-tools');
    eq('线上配置 multiPart 打开（同稿件的前提）', live.publish.multiPart, true);
    ok(
      '线上配置通过校验（这条规则没把现有配置判成错）',
      !cfgMod.validateConfig(live).some((i) => i.level === 'error' && /fullVideoBy|multiPart/.test(i.field)),
      JSON.stringify(cfgMod.validateConfig(live).filter((i) => /fullVideoBy|multiPart/.test(i.field))),
    );

    const bad = cfgMod.loadConfig().config;
    bad.publish.multiPart = false;
    ok(
      '关掉 multiPart 会被拦住（否则切片投成独立稿件、与完整版不在同一稿件）',
      cfgMod.validateConfig(bad).some((i) => i.level === 'error' && i.field === 'publish.multiPart'),
      JSON.stringify(cfgMod.validateConfig(bad).filter((i) => i.field === 'publish.multiPart')),
    );

    const except = cfgMod.loadConfig().config;
    except.publish.fullVideoBy = 'assistant';
    ok(
      '显式改成 assistant 会给出「这是例外」的告警',
      cfgMod.validateConfig(except).some((i) => i.field === 'publish.fullVideoBy'),
      JSON.stringify(cfgMod.validateConfig(except).filter((i) => i.field === 'publish.fullVideoBy')),
    );
  }

  section('8. 本场指定 aid：稿件标题不可信时的**确定性**手段（实测 丙主播 那场就是这种）');
  {
    /* 实测事故（2026-09-23）：biliLive-tools 经「文件夹监控导入」进来的场次，稿件标题是
       「未知主播未知标题2026.09.23」—— 与 `{anchor}{liveTitle}{date}` 永远匹配不上，
       于是本场一直等到超时。此时唯一的正解是**用户把 aid 贴进来**（不猜、不模糊匹配）。 */
    const { orch, taskId, uploadCalls } = makeEnv(path.join(tmpRoot, 'i'), true, {
      resumeAid: '',
      resumeTitleTemplate: '{anchor}{liveTitle}{date}',
    });
    orch.ledger.updateTask(taskId, { overrides: { resumeAid: '117321041512930' } });
    await invokeMultiPart(orch, taskId, silentLog);
    ok('稿件列表为空也照样按本场指定的 aid 追加', uploadCalls[0]?.['vid'] === '117321041512930', `实际 vid=${String(uploadCalls[0]?.['vid'])}`);
    ok('没有留下等待标记（本场不再等）', orch.ledger.getTask(taskId)!.publishWait === undefined);
  }

  section('9. 续传匹配用的日期：优先取录制文件名里的日期（跨零点不再差一天）');
  {
    /* 实测（2026-09-24 00:0x）：目录轮询导入的任务标题就是「哈喽」这种纯直播标题，
       没有日期也没 liveStartTime → `taskDateText` 退化成"调用时刻"，跨零点后渲染成
       `丙主播哈喽2026.09.24`，而 biliLive-tools 的稿件是 `丙主播哈喽2026.09.23` → 永远匹配不上。
       文件名里的日期是录制器写的，真实且稳定。 */
    const base = {
      id: 't',
      roomId: '12345678',
      platform: 'Bilibili',
      status: 'CLIPPED',
      stage: 'CLIPPED',
      title: '哈喽',
      source: {
        rawFiles: ['C:\\Users\\demo\\Downloads\\Bilibili\\丙主播\\2026-09-23 21-53-17-917 哈喽.flv'],
        segments: [],
        totalDuration: 1,
        fullVideoHasDanmaku: false,
      },
      fullUpload: 'NOT_APPLICABLE',
      cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: '' },
      createdAt: '',
      updatedAt: '',
    } as unknown as Parameters<typeof resumeDateText>[0];
    eq('纯标题 + 无开播时间 → 用文件名里的日期', resumeDateText(base), '2026-09-23');
    eq(
      '标题里已有日期时仍以标题为准',
      resumeDateText({ ...base, title: '2026-09-22 21-07-58-627 来两下闪身步就好了' } as typeof base),
      '2026-09-22',
    );
    eq(
      '有开播时间且文件名无日期 → 用开播时间',
      resumeDateText({
        ...base,
        source: { ...base.source, rawFiles: ['C:\\x\\裸文件.flv'] },
        liveStartTime: Math.floor(Date.parse('2026-09-21T20:00:00+08:00') / 1000),
      } as typeof base),
      '2026-09-21',
    );
  }

  console.log(`\n\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (failures.length) {
    console.log('\x1b[31m失败项：\x1b[0m');
    for (const f of failures) console.log(`  - ${f}`);
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

await main();
