/**
 * 删除语义自测：只删切片产物 **不能** 把整个任务记录一起删掉。
 *
 * 背景（用户报的）：界面上只勾「切片产物」（文案写着"默认只删切片产物"），
 * 结果整条任务从列表里消失 —— 转写、弹幕信号、总结、投稿记录全没了。
 * 根因：`deleteTask` 在把文件移入回收站之后**无条件**调用了 `ledger.deleteTask(taskId)`。
 * 切了还能重切，任务记录没了就什么都没了，所以这条边界必须锁住。
 *
 * 运行：node test/delete-semantics.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/daemon.ts';
import { Ledger } from '../src/ledger.ts';

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
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

/** 造一个假任务：目录结构 + 台账记录 + 几个切片文件 */
function makeTask(tmpRoot: string, id: string): { taskDir: string; clipsDir: string; ledgerPath: string; configPath: string } {
  const dataDir = path.join(tmpRoot, 'data');
  const taskDir = path.join(dataDir, 'tasks', id);
  // ★ 切片目录由配置里的 clip.outputDir 决定（不是 dataDirOverride），
  //   所以测试要自己写一份配置指到临时目录，否则会去动项目根下的真实 data/clips。
  const clipsRoot = path.join(tmpRoot, 'clips');
  const clipsDir = path.join(clipsRoot, id);
  fs.mkdirSync(path.join(taskDir, 'full'), { recursive: true });
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'transcript.json'), JSON.stringify({ segments: [] }), 'utf8');
  fs.writeFileSync(path.join(taskDir, 'signals.json'), JSON.stringify({ peaks: [] }), 'utf8');
  fs.writeFileSync(path.join(taskDir, 'clips.json'), JSON.stringify({ clips: [] }), 'utf8');
  fs.writeFileSync(path.join(taskDir, 'full', 'P1-full.mp4'), Buffer.alloc(64 * 1024));
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(clipsDir, `0${i + 1}-clip.mp4`), Buffer.alloc(32 * 1024));
  }
  const ledgerPath = path.join(dataDir, 'ledger.json');
  const led = new Ledger({ path: ledgerPath });
  led.createTask({
    id,
    roomId: '12345678',
    platform: 'Bilibili',
    title: '删除语义测试',
    status: 'CLIPPED',
    stage: 'ANALYZED',
    source: { segments: [], totalDuration: 100, rawFiles: [], fullVideoHasDanmaku: false },
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
  // 用真实配置为底，只改 clip.outputDir 指到临时目录
  const configPath = path.join(tmpRoot, 'config.json');
  const realCfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')) as Record<string, unknown>;
  const clip = { ...((realCfg['clip'] as Record<string, unknown>) ?? {}), outputDir: clipsRoot };
  fs.writeFileSync(configPath, JSON.stringify({ ...realCfg, clip }, null, 2), 'utf8');
  return { taskDir, clipsDir, ledgerPath, configPath };
}

function makeOrch(tmpRoot: string, ledgerPath: string, configPath: string): Orchestrator {
  return new Orchestrator({
    configPath,
    dataDirOverride: path.join(tmpRoot, 'data'),
    ledger: new Ledger({ path: ledgerPath }),
  });
}

async function main(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-del-'));

  /* 错误事件流/报告也重定向到临时目录：它们是模块级常量，dataDirOverride 管不到，
     不隔离就会把测试错误写进真实的 data/errors.jsonl 与 data/error-report/。 */
  const { setErrorsPath, setErrorReportDir } = await import('../src/errors.ts');
  setErrorsPath(path.join(tmpRoot, 'errors.jsonl'));
  setErrorReportDir(path.join(tmpRoot, 'error-report'));

  // ⚠️ 隔离缺口：回收站根目录 `TRASH_DIR` 是 trash.ts 里的**模块级常量**（写死到项目
  //    `data/trash`），既不跟 `dataDirOverride` 也不跟配置走，所以本测试的删除动作
  //    会往真实回收站里写条目。测试自己记下前后差异并清理，避免污染用户数据。
  //    （删除仍走回收站是对的 —— 生产线更需要"删错了能捞回来"。）
  const trashRoot = path.join(process.cwd(), 'data', 'trash');
  const trashBefore = new Set<string>(
    fs.existsSync(trashRoot) ? fs.readdirSync(trashRoot) : [],
  );
  const ID = 'manual-del-test';
  const { clipsDir, taskDir, ledgerPath, configPath } = makeTask(tmpRoot, ID);
  const orch = makeOrch(tmpRoot, ledgerPath, configPath);

  /* ============ 场景 1：只删切片产物 ============ */
  section('场景 1：只删切片产物（界面上默认的勾选）');
  {
    const r = await orch.deleteTask(ID, { deleteClips: true, deleteRaw: false, deleteTaskDir: false });
    ok('切片目录已被删除', !fs.existsSync(clipsDir), `clipsDir 仍存在：${clipsDir}`);
    ok('任务目录仍在（转写/信号/总结没被牵连）', fs.existsSync(path.join(taskDir, 'transcript.json')), 'transcript.json 不见了');
    ok('**任务记录仍在台账里**（这是本次修复的核心）', orch.ledger.getTask(ID) !== undefined, '任务记录被一起删掉了');
    ok('返回说明里明确写了"任务记录已保留"', r.note.includes('任务记录已保留'), r.note);
    ok('释放字节数大于 0', r.freedBytes > 0, `freedBytes=${r.freedBytes}`);
  }

  /* ============ 场景 2：再删任务目录 ============ */
  section('场景 2：勾选任务目录（= 整体删除该任务）');
  {
    const r = await orch.deleteTask(ID, { deleteClips: true, deleteRaw: false, deleteTaskDir: true });
    ok('任务目录已删除', !fs.existsSync(taskDir), `taskDir 仍存在：${taskDir}`);
    ok('任务记录已从台账移除', orch.ledger.getTask(ID) === undefined, '任务记录还在');
    ok('返回说明里写的是"已一并移除"', r.note.includes('已一并移除'), r.note);
  }

  /* ============ 场景 3：删切片后再重切（记录保留的实际价值） ============ */
  section('场景 3：记录保留后才可能重切（转写文件还在）');
  {
    const ID2 = 'manual-del-test2';
    const made = makeTask(tmpRoot, ID2);
    const orch2 = makeOrch(tmpRoot, made.ledgerPath, made.configPath);
    await orch2.deleteTask(ID2, { deleteClips: true, deleteRaw: false, deleteTaskDir: false });
    const t = orch2.ledger.getTask(ID2);
    ok('任务记录可读', Boolean(t), '读不到任务记录');
    ok('记录里仍指向转写文件，且文件确实存在', Boolean(t?.transcriptPath && fs.existsSync(t.transcriptPath)), `transcriptPath=${t?.transcriptPath}`);
    ok('切片目录已空（可以重切）', !fs.existsSync(made.clipsDir), 'clipsDir 仍在');
  }

  /* ============ 场景 4：记录里没有 clipsPath 的任务（生产形态）============
   * 实测事故：界面上勾了「任务目录」并确认，任务从列表消失、回收站里也有条目，
   * 但 `data/tasks/<id>` **原地还在**（空的）。根因是删除流程里一个**只读**动作
   * （`ledger.deleteTask()` → `clipsArray()` → `taskFile()` → `taskDir()`）会 `ensureDir`，
   * 把刚移进回收站的目录又建了回来 —— 而记录里没有 `clipsPath` 时才会走那条回退路径，
   * 所以场景 2（那条记录带 clipsPath）一直是绿的，真实的场次却是红的。 */
  section('场景 4：记录里没有 clipsPath 时，任务目录也必须真的消失（回归）');
  {
    const ID3 = 'manual-del-noclipspath';
    const td3 = path.join(tmpRoot, 'data', 'tasks', ID3);
    fs.mkdirSync(td3, { recursive: true });
    fs.writeFileSync(path.join(td3, 'transcript.json'), '{"x":1}');
    /* ⚠️ 台账路径必须在 `data/` 下：任务目录是从**台账所在目录**推导的（tasks/<id>），
       写到 tmpRoot 根上会得到另一个目录，断言就会看着像产品缺陷。 */
    const led3 = new Ledger({ path: path.join(tmpRoot, 'data', 'ledger3.json') });
    led3.createTask({
      id: ID3,
      roomId: '12345678',
      platform: 'Bilibili',
      title: '没有 clipsPath 的任务',
      status: 'CLIPPED',
      stage: 'CLIPPED',
      source: { segments: [], totalDuration: 60, rawFiles: [], fullVideoHasDanmaku: false },
      fullUpload: 'NOT_APPLICABLE',
      cost: { asrEstimate: 0, asrAudioSeconds: 0, llmActual: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmCalls: 0, updatedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // createTask 只建目录、不写 clipsPath —— 正是生产的形态
    ok('（前置）记录里没有 clipsPath', led3.getTask(ID3)?.clipsPath === undefined, String(led3.getTask(ID3)?.clipsPath));
    const orch3 = new Orchestrator({ configPath, dataDirOverride: path.join(tmpRoot, 'data'), ledger: led3 });
    const r3 = await orch3.deleteTask(ID3, { deleteClips: true, deleteRaw: false, deleteTaskDir: true });
    ok('任务目录真的没了（不是"移走之后又被建回来"）', !fs.existsSync(td3), `taskDir 仍在：${td3}`);
    ok('台账记录也移除了', led3.getTask(ID3) === undefined, '记录还在');
    ok('报告里说了已移入回收站', /回收站/.test(r3.note), r3.note.slice(0, 80));
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });

  // 清掉本测试在真实回收站里留下的条目（只删本次新增的，绝不碰用户已有的）
  let cleaned = 0;
  try {
    for (const name of fs.readdirSync(trashRoot)) {
      if (trashBefore.has(name)) continue;
      fs.rmSync(path.join(trashRoot, name), { recursive: true, force: true });
      cleaned++;
    }
  } catch {
    /* 清理失败不影响断言结果 */
  }
  console.log(`\n  已清理本次测试在回收站留下的 ${cleaned} 个条目`);

  console.log('');
  if (fail === 0) {
    console.log(`\x1b[32m===== 删除语义自测：PASS=${pass} FAIL=0 =====\x1b[0m`);
    console.log('只删切片产物时会保留任务记录；只有勾选任务目录才整体删除。');
    process.exit(0);
  } else {
    console.log(`\x1b[31m===== 删除语义自测：PASS=${pass} FAIL=${fail} =====\x1b[0m`);
    for (const f of failures) console.log(`  · ${f}`);
    process.exit(1);
  }
}

await main();
