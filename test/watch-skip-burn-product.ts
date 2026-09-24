/**
 * 回归测试：目录轮询**跳过 biliLive-tools 的压制产物**（只处理原始录制）。
 *
 * 背景（用户确认的分工，2026-09-24）：
 *   biliLive-tools 负责「压制弹幕版 + 纯享版，并把这两个分P 投到同一稿件」；
 *   切片助手负责「从**原始录制**选片、切片、把切片追加进那个稿件」。
 *   压制产物是对方的中间产物，切片助手不该再处理它 —— 实测代价：
 *     · 白花钱：同一段 3 分钟素材，原始 `.ts` 处理完一遍后，
 *       `-弹幕版-<uuid>.mp4` 又跑了一次 ASR ¥0.046 + LLM ¥0.032；
 *     · 可能重复投稿：同场产出两条切片，标题不同则指纹也不同，去重拦不住。
 *
 * ⚠️ 关键安全约束（本测试重点覆盖）：
 *   **只在同目录、同分段号确实存在「未烧弹幕的原始录制」时才跳过**。
 *   盘上如果只剩压制产物（原始被「用完即删」清掉了），必须仍然导入 —— 有源总比没源好。
 *
 * 做法：直接驱动 `WatchImporter.scanOnce()`，用假的候选列表与假的导入函数，
 * 断言"哪些文件被交给导入、哪些被跳过、跳过原因是什么"。
 *
 * 运行：node --experimental-strip-types test/watch-skip-burn-product.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WatchImporter } from '../src/watch-import.ts';
import type { RecordingCandidate } from '../src/recordings.ts';

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
const silentLog = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  debug: (): void => {},
  child: (): unknown => silentLog,
};

const DIR = 'C:\\fake\\Bilibili\\丙主播';

/** 造一个候选（只填测试用得到的字段） */
function cand(over: Partial<RecordingCandidate> & { videoPath: string; fileName: string }): RecordingCandidate {
  const base = {
    sizeBytes: 100 * 1024 * 1024,
    sizeMB: 100,
    danmaSource: 'none' as const,
    title: '哈喽',
    titleSource: 'filename' as const,
    hasDanmakuInPicture: false,
    usable: true,
    segmentCount: 1,
    source: 'scan' as const,
    ...over,
  };
  /* `variants` 必须存在：`scanOnce()` 会用 `c.variants.map(...)` 取"最后修改时间"
     来判断文件是否还在写入。缺了它会在流水线里抛 TypeError（第一版就漏了）。 */
  return {
    ...base,
    variants: [
      {
        videoPath: base.videoPath,
        fileName: base.fileName,
        sizeBytes: base.sizeBytes,
        sizeMB: base.sizeMB,
        hasDanmakuInPicture: base.hasDanmakuInPicture,
        ...(base.partIndex !== undefined ? { partIndex: base.partIndex } : {}),
        mtimeMs: Date.now() - 3600_000,
      },
    ],
  } as unknown as RecordingCandidate;
}

interface Env {
  imported: string[];
  scan: () => Promise<Array<{ fileName: string; skipped?: string; taskId?: string }>>;
  run: (cands: RecordingCandidate[]) => Promise<Array<{ fileName: string; skipped?: string; taskId?: string }>>;
}

/**
 * 造一个隔离环境：假候选 + 假导入；返回"实际被导入的文件名"。
 *
 * `ledgerTasks` 是一个**可变的数组**：测试可以在中途清空它来模拟
 * "用户把这个任务删掉了"（删除会把台账记录一起移除），
 * 这正是"删任务后同一文件被重复导入"那个事故的成因。
 */
function makeEnv(tmpRoot: string, cands: RecordingCandidate[], ledgerTasks: unknown[] = []): Env {
  fs.mkdirSync(tmpRoot, { recursive: true });
  const imported: string[] = [];
  const importer = new WatchImporter({
    config: { import: { watch: { enabled: true, dirs: [DIR], intervalSec: 60, stableSec: 0, maxDepth: 3, minSizeMB: 5, requireDanmaku: false, importExisting: true } } } as never,
    /** 台账用可变数组喂，测试可以中途清空来模拟"任务被删除" */
    ledger: { listTasks: () => ledgerTasks } as never,
    logger: silentLog as never,
    statePath: path.join(tmpRoot, 'watch-state.json'),
    importFn: async (input: { videoPath: string }) => {
      imported.push(path.basename(input.videoPath));
      return { id: `t-${imported.length}` };
    },
    /** 直接喂候选，绕开扫盘/ffprobe；`importedBy` 按当前台账动态算，模拟真实情况 */
    listFn: async () => ({
      candidates: cands.map((c) => {
        const owned = ledgerTasks.find(
          (t) => ((t as { source?: { rawFiles?: string[] } }).source?.rawFiles ?? []).some((f) => f === c.videoPath),
        ) as { id: string; status: string } | undefined;
        return owned
          ? { ...c, importedBy: { taskId: owned.id, status: owned.status } }
          : c;
      }),
      scanRoots: [DIR],
    }),
  } as never);

  const scan = (): Promise<Array<{ fileName: string; skipped?: string; taskId?: string }>> =>
    (importer as unknown as { scanOnce: () => Promise<Array<{ fileName: string; skipped?: string; taskId?: string }>> }).scanOnce();

  return {
    imported,
    scan,
    /**
     * ⚠️ 必须跑**两轮**：稳定性判定要求"体积连续两轮不变"（`stableSec` 只是额外的时间门槛），
     * 所以第一轮只会登记基线（结论是"首次发现，等下一轮确认写完"），
     * 第二轮才真正导入。模拟一次真实轮询周期，而不是只调一次就把结论当最终结果
     * —— 第一版测试只调一次，于是"什么都没导入"，看起来像功能坏了。
     */
    run: async (cs: RecordingCandidate[]) => {
      void cs;
      await scan(); // 第 1 轮：登记基线
      return await scan(); // 第 2 轮：真正判定与导入
    },
  };
}

async function main(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skipburn-'));

  /* ====================================================================
   * 1. 核心场景：同目录有原始录制时，压制产物必须被跳过
   * ================================================================== */
  section('1. 同目录有原始录制 → 压制产物被跳过、原始录制被导入');
  {
    const env = makeEnv(path.join(tmpRoot, 'a'), [
      cand({ videoPath: path.join(DIR, '00-48-58-767 哈喽.ts'), fileName: '00-48-58-767 哈喽.ts' }),
      cand({
        videoPath: path.join(DIR, '00-48-58-767 哈喽-弹幕版-6e88e7c6-1c78-4827-917b-c7e62ad18fc9.mp4'),
        fileName: '00-48-58-767 哈喽-弹幕版-6e88e7c6-1c78-4827-917b-c7e62ad18fc9.mp4',
        hasDanmakuInPicture: true,
      }),
    ]);
    const outs = await env.run([]);
    ok('原始 .ts 被导入', env.imported.includes('00-48-58-767 哈喽.ts'), `实际导入：${env.imported.join(', ')}`);
    ok(
      '★ 压制产物**没有**被导入',
      !env.imported.some((f) => f.includes('弹幕版')),
      `实际导入：${env.imported.join(', ')}`,
    );
    const skipped = outs.find((o) => o.fileName.includes('弹幕版'));
    ok('压制产物出现在"跳过"结论里且原因可读', Boolean(skipped?.skipped?.includes('压制产物')), String(skipped?.skipped ?? '(没有该结论)'));
    ok('原始录制没有被误跳过', !outs.find((o) => o.fileName === '00-48-58-767 哈喽.ts')?.skipped);
  }

  /* ====================================================================
   * 2. 安全边界：盘上只剩压制产物时必须仍然导入（否则就真的丢素材了）
   * ================================================================== */
  section('2. 同目录**没有**原始录制 → 压制产物仍要导入（不能丢素材）');
  {
    const env = makeEnv(path.join(tmpRoot, 'b'), [
      cand({
        videoPath: path.join(DIR, '全是压制产物 哈喽-弹幕版.mp4'),
        fileName: '全是压制产物 哈喽-弹幕版.mp4',
        hasDanmakuInPicture: true,
      }),
    ]);
    await env.run([]);
    ok(
      '★ 没有原始录制时，压制产物被导入（有源总比没源好）',
      env.imported.some((f) => f.includes('弹幕版')),
      `实际导入：${env.imported.join(', ') || '(无)'}`,
    );
  }

  /* ====================================================================
   * 3. 分段场景：按分段号配对，不能跨分段误配
   * ================================================================== */
  section('3. 分段录制：PART000 的压制产物只与 PART000 的原始录制配对');
  {
    const env = makeEnv(path.join(tmpRoot, 'c'), [
      cand({ videoPath: path.join(DIR, 'x_PART000.ts'), fileName: 'x_PART000.ts', partIndex: 0 }),
      cand({ videoPath: path.join(DIR, 'x_PART001.ts'), fileName: 'x_PART001.ts', partIndex: 1 }),
      cand({ videoPath: path.join(DIR, 'x-弹幕版_PART001.mp4'), fileName: 'x-弹幕版_PART001.mp4', hasDanmakuInPicture: true, partIndex: 1 }),
    ]);
    const outs = await env.run([]);
    ok('两个原始分段都被导入', env.imported.includes('x_PART000.ts') && env.imported.includes('x_PART001.ts'), `实际：${env.imported.join(', ')}`);
    ok('PART001 的压制产物被跳过', !env.imported.includes('x-弹幕版_PART001.mp4'), `实际：${env.imported.join(', ')}`);
    ok('跳过原因标明是压制产物', Boolean(outs.find((o) => o.fileName === 'x-弹幕版_PART001.mp4')?.skipped?.includes('压制产物')));
  }

  /* ====================================================================
   * 4. 回归保护：普通原始文件照常导入
   * ================================================================== */
  section('4. 回归保护：没有压制产物时，原始录制照常导入');
  {
    const env = makeEnv(path.join(tmpRoot, 'd'), [
      cand({ videoPath: path.join(DIR, 'a.flv'), fileName: 'a.flv' }),
      cand({ videoPath: path.join(DIR, 'b.ts'), fileName: 'b.ts' }),
    ]);
    await env.run([]);
    ok('两个原始文件都被导入', env.imported.length === 2, `实际：${env.imported.join(', ')}`);
    ok('没有任何跳过', !env.imported.some((f) => f.includes('弹幕版')));
  }

  /* ====================================================================
   * 5. 删任务后不得重复导入（实测事故：2026-09-24 凌晨同一个文件被导入两次）
   * ================================================================== */
  section('5. 用户删掉自动导入的任务后，同一个文件不得被再次自动导入');
  {
    const videoPath = path.join(DIR, '01-01-56-910 哈喽.ts');
    const ledgerTasks: unknown[] = [];
    const env = makeEnv(path.join(tmpRoot, 'e'), [cand({ videoPath, fileName: '01-01-56-910 哈喽.ts' })], ledgerTasks);

    /* 第 1 轮周期：正常导入，并把任务记进"台账" */
    await env.run([]);
    ok('第一次被正常导入', env.imported.length === 1, `实际：${env.imported.join(', ') || '(无)'}`);
    ledgerTasks.push({ id: 't-1', status: 'CLIPPED', source: { rawFiles: [videoPath] } });

    /* 台账里还有这个任务时：不应重复导入 */
    const r2 = await env.run([]);
    ok('台账还在时不会重复导入', env.imported.length === 1, `实际导入 ${env.imported.length} 次`);
    void r2;

    /* ★ 模拟"用户在界面上把任务删了"：删除会把台账记录一起移除 */
    ledgerTasks.length = 0;
    const r3 = await env.run([]);
    ok(
      '★ 任务被删除后**仍然不会**重复导入（靠状态文件拦住）',
      env.imported.length === 1,
      `实际导入 ${env.imported.length} 次 —— 若为 2 次说明又白跑了一遍 ASR+LLM`,
    );
    const skipReason = r3.find((o) => String(o.fileName).includes('哈喽'))?.skipped ?? '';
    ok('跳过原因说明了"已导入过 + 该任务已从台账删除"', skipReason.includes('已导入过'), skipReason.slice(0, 90));
    ok('并指引用户走「导入录播」手动重跑', skipReason.includes('导入录播'), skipReason.slice(0, 90));
  }

  console.log(`\n\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (failures.length) {
    console.log('\x1b[31m失败项：\x1b[0m');
    for (const f of failures) console.log(`  - ${f}`);
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exitCode = fail === 0 ? 0 : 1;
}

await main();
