/**
 * 「用完即删」延迟删除的单元验证。
 *
 * 这是本项目**唯一会永久抹掉数据**的功能（跨盘删源不走回收站），所以每条规则都要钉住：
 *
 *  1. 到点之前绝不删（宽限期内文件必须还在）；
 *  2. 取消之后绝不删（用户反悔必须真的生效）；
 *  3. 幂等：反查循环每 5 分钟跑一次，不能堆出成百上千条重复项；
 *  4. 同盘走回收站（可恢复），异盘才直接删（不可恢复）—— 两条路都要验到；
 *  5. 文件已经不在了要记账收工，不能报错卡住后面的条目；
 *  6. 单条失败不能中断整批（留在清单里带 error，下轮重试）。
 *
 * 全程在临时目录里跑（临时"源目录" + 临时回收站），零网络、零费用、不碰真实数据。
 *
 * 用法：node test/pending-delete.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cancelPendingDelete,
  deletePendingNow,
  listPendingDelete,
  runDueDeletions,
  sameVolume,
  scheduleDelete,
  volumeRoot,
} from '../src/pending-delete.ts';
import { listTrash } from '../src/trash.ts';
import type { Logger } from '../src/logger.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string, extra?: string): void {
  if (cond) pass++;
  else {
    fail++;
    failures.push(msg);
  }
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${msg}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`);
}
function eq<T>(msg: string, actual: T, expected: T): void {
  ok(actual === expected, msg, actual === expected ? undefined : `期望 ${String(expected)}，实际 ${String(actual)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const quietLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => quietLogger,
} as unknown as Logger;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-pending-'));
const trashRoot = path.join(root, 'trash');
const clipsDir = path.join(root, 'clips'); // 与回收站同盘 → 应走回收站
const rawsDir = path.join(root, 'raws'); // 同上（临时目录里无法造真异盘，用 sameVolume 单测覆盖分流）
/** 项目根：7b 要在"项目盘"上造一个真目录当 junction 目标（只建 `.junction-test-*`，跑完删掉） */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let stateSeq = 0;
const newState = (): string => path.join(root, `state-${++stateSeq}.json`);

function writeFile(p: string, bytes: number): string {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 0x41));
  return p;
}

function main(): void {
  console.log('\x1b[1m「用完即删」延迟删除验证\x1b[0m（临时目录，零网络、零费用）');
  console.log('─'.repeat(74));
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.mkdirSync(rawsDir, { recursive: true });

  /* ================= 1. 宽限期内不删 ================= */
  section('1. 排入清单 ≠ 立刻删（宽限期是用户唯一的反悔窗口）');
  {
    const state = newState();
    const clip = writeFile(path.join(clipsDir, 'task-A', '01.mp4'), 1024);
    const t0 = 1_700_000_000_000;
    const r = scheduleDelete([{ path: clip, kind: 'clip', taskId: 'task-A', reason: '全部切片已确认' }], {
      graceHours: 24,
      statePath: state,
      now: t0,
      logger: quietLogger,
    });
    eq('排入 1 项', r.added.length, 1);
    const entry = r.added[0]!;
    eq('到点时刻 = 24 小时后', entry.dueAt, new Date(t0 + 24 * 3600_000).toISOString());
    ok(entry.sizeBytes > 0, '记录了体积（界面要显示能省多少盘）', String(entry.sizeBytes));

    const run = runDueDeletions({ statePath: state, now: t0 + 3600_000, trashRoot, logger: quietLogger });
    eq('1 小时后执行：什么都没删', run.deleted, 0);
    ok(fs.existsSync(clip), '文件还在（宽限期内绝不提前删）');
    eq('仍列为待删', listPendingDelete({ statePath: state, now: t0 }).stats.pendingCount, 1);
  }

  /* ================= 2. 到点后：同盘走回收站 ================= */
  section('2. 到点后同盘删除 → 进回收站（还能恢复）');
  {
    const state = newState();
    const clip = writeFile(path.join(clipsDir, 'task-B', '01.mp4'), 2048);
    const t0 = 1_700_000_000_000;
    scheduleDelete([{ path: clip, kind: 'clip', taskId: 'task-B', reason: '全部切片已确认' }], {
      graceHours: 24,
      statePath: state,
      now: t0,
      logger: quietLogger,
    });
    ok(sameVolume(clip, trashRoot), '（前置）成片与回收站同盘');
    const run = runDueDeletions({ statePath: state, now: t0 + 25 * 3600_000, trashRoot, logger: quietLogger });
    eq('删除了 1 项', run.deleted, 1);
    eq('没有失败项', run.failed, 0);
    ok(!fs.existsSync(clip), '原路径已不存在');
    const trash = listTrash(trashRoot);
    ok(trash.length >= 1, `回收站里有 ${trash.length} 个条目（可恢复）`, trash[0]?.id);
    const view = listPendingDelete({ statePath: state, now: t0 + 25 * 3600_000 });
    eq('清单里标记为已删除', view.deleted.length, 1);
    eq('删除方式记为回收站', view.deleted[0]?.deletedBy, 'trash');
    eq('待删清空', view.stats.pendingCount, 0);
  }

  /* ================= 3. 取消必须真的生效 ================= */
  section('3. 宽限期内取消 → 到点也不删');
  {
    const state = newState();
    const raw = writeFile(path.join(rawsDir, '录播.flv'), 4096);
    const t0 = 1_700_000_000_000;
    const r = scheduleDelete([{ path: raw, kind: 'raw', taskId: 'task-C', reason: '全部切片已确认' }], {
      graceHours: 24,
      statePath: state,
      now: t0,
      logger: quietLogger,
    });
    const id = r.added[0]!.id;
    const c = cancelPendingDelete(id, { statePath: state, logger: quietLogger });
    ok(c.ok, '取消成功');
    const run = runDueDeletions({ statePath: state, now: t0 + 48 * 3600_000, trashRoot, logger: quietLogger });
    eq('到点后没有删除', run.deleted, 0);
    ok(fs.existsSync(raw), '源文件还在（取消真的生效了）');
    const view = listPendingDelete({ statePath: state, now: t0 + 48 * 3600_000 });
    eq('归入"已取消"', view.cancelled.length, 1);
    eq('不再算作待删', view.stats.pendingCount, 0);
    ok(!cancelPendingDelete(id, { statePath: state }).ok, '重复取消返回 false（不报错）');
    ok(!cancelPendingDelete('pd-不存在', { statePath: state }).ok, '取消不存在的条目返回 false');
  }

  /* ================= 4. 幂等 ================= */
  section('4. 幂等：反查循环每 5 分钟跑一次不能堆重复项');
  {
    const state = newState();
    const clip = writeFile(path.join(clipsDir, 'task-D', '01.mp4'), 512);
    const raw = writeFile(path.join(rawsDir, 'D.flv'), 512);
    const inputs = [
      { path: clip, kind: 'clip' as const, taskId: 'task-D', reason: '全部切片已确认' },
      { path: raw, kind: 'raw' as const, taskId: 'task-D', reason: '全部切片已确认' },
    ];
    const first = scheduleDelete(inputs, { graceHours: 24, statePath: state, now: 1_700_000_000_000, logger: quietLogger });
    eq('第一次排入 2 项', first.added.length, 2);
    const second = scheduleDelete(inputs, { graceHours: 24, statePath: state, now: 1_700_000_100_000, logger: quietLogger });
    eq('第二次不再重复排', second.added.length, 0);
    eq('并且报告为已存在', second.skipped.length, 2);
    eq('清单里仍然只有 2 条', listPendingDelete({ statePath: state }).stats.pendingCount, 2);

    /* 取消后再排（**默认策略**）：必须保持取消 —— 反查循环每 5 分钟调一次，
       如果默认就把用户取消掉的条目排回来，"取消"就是假的。
       要重新排入得显式 `reviveCancelled: true`（见第 13 节）。 */
    cancelPendingDelete(first.added[0]!.id, { statePath: state, logger: quietLogger });
    const third = scheduleDelete([inputs[0]!], { graceHours: 24, statePath: state, now: 1_700_000_200_000, logger: quietLogger });
    eq('取消之后**默认**不再自动排入', third.added.length, 0);
    eq('并且明确报告被用户取消过', third.heldCancelled.length, 1);
    eq('清单里还是只有 1 条待删（另一条保持取消）', listPendingDelete({ statePath: state }).stats.pendingCount, 1);
  }

  /* ================= 5. 文件已不在：记账收工，不报错 ================= */
  section('5. 到点时文件已经不在了（用户自己删了）→ 记账收工');
  {
    const state = newState();
    const gone = path.join(rawsDir, '已经没了.flv');
    const t0 = 1_700_000_000_000;
    scheduleDelete([{ path: gone, kind: 'raw', taskId: 'task-E', reason: '全部切片已确认', sizeBytes: 123 }], {
      graceHours: 24,
      statePath: state,
      now: t0,
      logger: quietLogger,
    });
    const run = runDueDeletions({ statePath: state, now: t0 + 25 * 3600_000, trashRoot, logger: quietLogger });
    eq('不算删除失败', run.failed, 0);
    eq('标记为已处理', listPendingDelete({ statePath: state }).deleted.length, 1);
    ok(run.notes.some((n) => n.includes('已不存在')), 'notes 里说明了原因', run.notes[0]);
  }

  /* ================= 6. 目录删除（成片目录整包） ================= */
  section('6. 删目录：成片目录整包带走');
  {
    const state = newState();
    const dir = path.join(clipsDir, 'task-F');
    writeFile(path.join(dir, '01.mp4'), 1024);
    writeFile(path.join(dir, '02.mp4'), 1024);
    const t0 = 1_700_000_000_000;
    const r = scheduleDelete([{ path: dir, kind: 'clip', taskId: 'task-F', reason: '清理本场成片目录' }], {
      graceHours: 24,
      statePath: state,
      now: t0,
      logger: quietLogger,
    });
    ok(r.added[0]!.sizeBytes >= 2048, '目录体积被算出来了（不是 0）', String(r.added[0]!.sizeBytes));
    const run = runDueDeletions({ statePath: state, now: t0 + 25 * 3600_000, trashRoot, logger: quietLogger });
    eq('删除 1 项', run.deleted, 1);
    ok(!fs.existsSync(dir), '目录已不在原位置');
  }

  /* ================= 7. 盘符分流 ================= */
  section('7. 同盘/异盘分流（异盘"移入回收站"要整份复制，20 GB 不现实）');
  {
    ok(sameVolume('F:\\deepseek\\live_auto\\data\\clips\\x.mp4', 'F:\\deepseek\\live_auto\\data\\trash'), '同盘 → true');
    const other = process.platform === 'win32' ? 'C:\\Users\\public\\x.flv' : '/tmp/x.flv';
    const trashOnF = process.platform === 'win32' ? 'F:\\deepseek\\live_auto\\data\\trash' : '/var/x';
    ok(!sameVolume(other, trashOnF), '异盘 → false（走直接删除）');
    ok(!sameVolume('', trashOnF), '空路径不抛异常');
  }

  /* ========= 7b. junction / 符号链接必须被解析（永久删除那一侧的护栏） =========
   *
   * 背景（真事）：用户把 `C:\…\Downloads\Bilibili` 和项目 `data/` 都做成了指向 `D:` 的 junction。
   * 老实现只比 `path.parse(resolve(x)).root`（盘符字符串），于是
   *     目标   C:\…\Bilibili\xxx.ts   → 判成 C:
   *     回收站 F:\…\data\trash        → 判成 F:
   * 得出"跨盘"，本该进回收站（可恢复）的文件走了 `fs.rmSync` —— **永久删除**。
   * 2026-09-24 排进清单的 13 个文件（5.84 GB）界面上显示的就是「跨盘·删除不可恢复」，
   * 靠用户在宽限期内叫停才没删。
   *
   * 这里造一个**真的跨盘 junction** 把这件事钉死（Windows 上建 junction 不需要管理员权限）：
   * 链接放系统盘、目标放项目盘，物理上同一卷 → 必须走回收站。 */
  section('7b. junction 必须解析（否则"可恢复的删除"会变成永久删除）');
  if (process.platform !== 'win32') {
    console.log('  \x1b[90m— 非 Windows：junction 不适用，跳过（sameVolume 仍走 realpath）\x1b[0m');
  } else {
    const jTarget = fs.mkdtempSync(path.join(PROJECT_ROOT, '.junction-test-')); // 真目录，在项目盘
    const jLink = path.join(os.tmpdir(), `live-auto-junction-${process.pid}-${Date.now()}`); // 链接，在系统盘
    try {
      fs.symlinkSync(jTarget, jLink, 'junction');
    } catch (e) {
      ok(false, '前置：能创建 junction', (e as Error).message);
    }
    if (fs.existsSync(jLink)) {
      try {
        eq('junction 解析到目标所在卷', volumeRoot(jLink), volumeRoot(jTarget));
        ok(volumeRoot(jLink) !== volumeRoot(os.tmpdir()), 'junction 所在盘 ≠ 目标所在盘（确实是跨盘链接）', `${volumeRoot(jLink)} vs ${volumeRoot(os.tmpdir())}`);
        ok(!sameVolume(jLink, os.tmpdir()), 'junction 路径 vs 系统盘回收站 → false（没有过度纠正）');

        /* 真正的场景：待删文件**只**通过 junction 路径访问（名义 C:），回收站也在目标里（名义 F:）。
           两者物理同一卷 → 必须进回收站；老实现会判成跨盘并 rmSync 永久删掉。 */
        const jTrash = path.join(jTarget, 'trash');
        const viaLink = path.join(jLink, 'raws', 's1.flv');
        fs.mkdirSync(path.dirname(viaLink), { recursive: true });
        fs.writeFileSync(viaLink, Buffer.alloc(4096, 0x41));
        ok(sameVolume(viaLink, jTrash), 'junction 下的文件与同卷回收站 → true（老实现这里是 false）');

        const state = newState();
        const t0 = 1_700_000_000_000;
        scheduleDelete([{ path: viaLink, kind: 'raw', taskId: 'task-J', reason: 'junction 回归' }], {
          graceHours: 24,
          statePath: state,
          now: t0,
          logger: quietLogger,
        });
        const pre = listPendingDelete({ statePath: state, now: t0, trashRoot: jTrash });
        eq('界面预告：会进回收站（不是"不可恢复"）', pre.pending[0]?.willTrash, true);

        const run = runDueDeletions({ statePath: state, now: t0 + 25 * 3600_000, trashRoot: jTrash, logger: quietLogger });
        eq('删除了 1 项', run.deleted, 1);
        eq('没有失败项', run.failed, 0);
        const post = listPendingDelete({ statePath: state, now: t0 + 25 * 3600_000, trashRoot: jTrash });
        eq('走的是回收站（可恢复），不是 rm', post.deleted[0]?.deletedBy, 'trash');
        ok(!fs.existsSync(viaLink), '原位置已清空');
        ok(listTrash(jTrash).length >= 1, '回收站里能找到它（真能恢复）');
      } finally {
        /* ⚠️ 删 junction 只能用 unlink：万一对链接做 recursive rm 跟进了目标，
           删掉的就是真目录（这个项目已经在 junction 上栽过一次，不再赌）。 */
        try {
          fs.unlinkSync(jLink);
        } catch {
          /* 已经没了 */
        }
        fs.rmSync(jTarget, { recursive: true, force: true });
      }
    }
  }

  /* ================= 8. 统计信息 ================= */
  section('8. 界面要用的统计');
  {
    const state = newState();
    const t0 = 1_700_000_000_000;
    scheduleDelete(
      [
        { path: writeFile(path.join(rawsDir, 's1.flv'), 1024 * 1024), kind: 'raw', taskId: 'task-G', reason: 'x' },
        { path: writeFile(path.join(rawsDir, 's2.flv'), 2 * 1024 * 1024), kind: 'raw', taskId: 'task-G', reason: 'x' },
      ],
      { graceHours: 24, statePath: state, now: t0, logger: quietLogger },
    );
    const view = listPendingDelete({ statePath: state, now: t0 });
    eq('待删 2 项', view.stats.pendingCount, 2);
    eq('能省 3 MB', view.stats.pendingBytes, 3 * 1024 * 1024);
    ok(view.stats.nextDueAt !== undefined, '给出了最早到点时刻（界面显示"什么时候会删"）', view.stats.nextDueAt);
    eq('当前没有到点的', view.stats.dueNowCount, 0);
    const later = listPendingDelete({ statePath: state, now: t0 + 25 * 3600_000 });
    eq('到点后 dueNowCount 变成 2', later.stats.dueNowCount, 2);
  }

  /* ================= 9. 损坏的清单文件不能让流水线崩 ================= */
  section('9. 清单文件损坏 → 当空清单处理，不抛异常');
  {
    const state = newState();
    fs.writeFileSync(state, '{ 这不是 JSON', 'utf8');
    const view = listPendingDelete({ statePath: state });
    eq('读损坏文件得到空清单', view.stats.pendingCount, 0);
    const r = scheduleDelete([{ path: path.join(rawsDir, 'x.flv'), kind: 'raw', taskId: 'task-H', reason: 'x' }], {
      graceHours: 24,
      statePath: state,
      now: 1_700_000_000_000,
      logger: quietLogger,
    });
    eq('仍能正常排入（覆盖损坏文件）', r.added.length, 1);
  }

  /* ================= 10. 立即删除（界面上那个按钮）：不等宽限期 ================= */
  section('10. 立即删除：不等宽限期，但删法与到点删除**完全一致**');
  {
    const state = newState();
    const clip = writeFile(path.join(clipsDir, 'task-I', '01.mp4'), 3072);
    const t0 = 1_700_000_000_000;
    const r = scheduleDelete([{ path: clip, kind: 'clip', taskId: 'task-I', reason: '全部切片已确认' }], {
      graceHours: 24,
      statePath: state,
      now: t0,
      logger: quietLogger,
    });
    const id = r.added[0]!.id;
    const before = listPendingDelete({ statePath: state, now: t0, trashRoot });
    eq('（前置）还没到点', before.stats.dueNowCount, 0);
    eq('（前置）界面能看出这条会进回收站（点之前就要说清后果）', before.pending[0]!.willTrash, true);
    eq('（前置）界面能看出文件还在', before.pending[0]!.existsNow, true);

    const del = deletePendingNow([id], { statePath: state, trashRoot, logger: quietLogger });
    eq('立即删除 1 项', del.deleted.length, 1);
    eq('没有失败项', del.failed.length, 0);
    eq('走的是回收站（同盘）', del.deleted[0]!.by, 'trash');
    ok(!fs.existsSync(clip), '原始路径上的文件已经不在');
    ok(del.bytes > 0, '报告了释放的字节数（界面 toast 要用）', String(del.bytes));
    ok(listTrash(trashRoot).some((t) => t.id === del.deleted[0]!.trashId), '回收站里能查到它（7 天内可恢复）', del.deleted[0]!.trashId);

    const after = listPendingDelete({ statePath: state, now: t0, trashRoot });
    eq('从待删清单里移出', after.stats.pendingCount, 0);
    eq('记入"已删除"历史', after.deleted.length, 1);
    eq('标记为**手动**立即删除（与到点自动删区分开）', after.deleted[0]!.deletedManually, true);
    eq('删除方式留痕', after.deleted[0]!.deletedBy, 'trash');
  }

  /* ================= 11. 只删指定的那一条 + 自动删不标成手动 ================= */
  section('11. 立即删除只动指定的那一条；到点自动删不标成"手动"');
  {
    const state = newState();
    const t0 = 1_700_000_000_000;
    const files = ['a.mp4', 'b.mp4', 'c.mp4'].map((n) => writeFile(path.join(clipsDir, 'task-J', n), 512));
    scheduleDelete(
      files.map((f, i) => ({ path: f, kind: 'clip' as const, taskId: 'task-J', reason: `第 ${i} 条` })),
      { graceHours: 24, statePath: state, now: t0, logger: quietLogger },
    );
    const ids = listPendingDelete({ statePath: state, now: t0 }).pending.map((e) => e.id);
    eq('（前置）3 条待删', ids.length, 3);
    const del = deletePendingNow([ids[1]!], { statePath: state, trashRoot, logger: quietLogger });
    eq('只删了 1 条', del.deleted.length, 1);
    ok(fs.existsSync(files[0]!) && !fs.existsSync(files[1]!) && fs.existsSync(files[2]!), '只有中间那一条被删掉，其它两条原样保留');
    const view = listPendingDelete({ statePath: state, now: t0 });
    eq('剩下 2 条仍在待删里', view.stats.pendingCount, 2);

    // 到点自动删：同一次运行里删掉剩下两条，它们不应被标成"手动"
    const auto = runDueDeletions({ statePath: state, now: t0 + 25 * 3600_000, trashRoot, logger: quietLogger });
    eq('到点自动删除 2 条', auto.deleted, 2);
    const done = listPendingDelete({ statePath: state }).deleted;
    eq('自动删的条目没被标成手动', done.filter((e) => e.deletedManually).length, 1);
    eq('手动那条 + 自动两条 = 3 条历史', done.length, 3);
  }

  /* ================= 12. 立即删除的边界 ================= */
  section('12. 立即删除的边界：未知 id / 已取消 / 已删过 / 文件已不在 / 异盘');
  {
    /* 12a. 不给 id：什么都不删（接口层也会挡，但这里保证库函数本身安全） */
    const s1 = newState();
    const x = writeFile(path.join(clipsDir, 'task-K', '01.mp4'), 256);
    scheduleDelete([{ path: x, kind: 'clip', taskId: 'task-K', reason: 'x' }], { graceHours: 24, statePath: s1, now: 1_700_000_000_000, logger: quietLogger });
    const none = deletePendingNow([], { statePath: s1, trashRoot, logger: quietLogger });
    eq('空 ids → 什么都不删', none.deleted.length, 0);
    ok(fs.existsSync(x), '文件还在');

    /* 12b. 未知 id / 路径不可注入：只认清单里的 id */
    const unknown = deletePendingNow(['pd-不存在的东西'], { statePath: s1, trashRoot, logger: quietLogger });
    eq('未知 id 被跳过而不是报错', unknown.skipped.length, 1);
    ok(/没有这个条目/.test(unknown.skipped[0]!.reason), '跳过原因说清了', unknown.skipped[0]!.reason);

    /* 12c. 已取消的条目：不能因为手滑就删掉（用户的"反悔"必须压过一切） */
    const raw = writeFile(path.join(rawsDir, 'K.flv'), 1024);
    const r2 = scheduleDelete([{ path: raw, kind: 'raw', taskId: 'task-K', reason: 'x' }], { graceHours: 24, statePath: s1, now: 1_700_000_000_000, logger: quietLogger });
    const rawId = r2.added[0]!.id;
    cancelPendingDelete(rawId, { statePath: s1, logger: quietLogger });
    const cancelled = deletePendingNow([rawId], { statePath: s1, trashRoot, logger: quietLogger });
    eq('已取消的条目不会被删', cancelled.deleted.length, 0);
    eq('并且说明了原因', /已取消/.test(cancelled.skipped[0]!.reason), true);
    ok(fs.existsSync(raw), '文件还在（取消真的生效）');

    /* 12d. 重复点删除：第二次是 no-op，不报错、不影响别的条目 */
    const again = deletePendingNow([rawId], { statePath: s1, trashRoot, logger: quietLogger });
    eq('对已取消的条目重复操作仍是 no-op', again.deleted.length, 0);
    ok(fs.existsSync(x), '其它条目不受影响');

    /* 12e. 文件已经不在了：记账收工（用户自己删过了） */
    const s2 = newState();
    const gone = path.join(rawsDir, '已经不在了.flv');
    const r3 = scheduleDelete([{ path: gone, kind: 'raw', taskId: 'task-L', reason: 'x', sizeBytes: 999 }], { graceHours: 24, statePath: s2, now: 1_700_000_000_000, logger: quietLogger });
    const goneDel = deletePendingNow([r3.added[0]!.id], { statePath: s2, trashRoot, logger: quietLogger });
    eq('文件已不在也算处理成功（不报错）', goneDel.deleted.length, 1);
    eq('释放字节按 0 计（不虚报）', goneDel.bytes, 0);
    eq('清单里标记为已删除', listPendingDelete({ statePath: s2 }).deleted.length, 1);

    /* 12f. 异盘：界面必须先告诉用户"不可恢复"，删法是真的 rm */
    const s3 = newState();
    const far = writeFile(path.join(rawsDir, 'far.flv'), 2048);
    const otherTrash = process.platform === 'win32' ? 'Q:\\trash' : '/mnt/trash';
    const r4 = scheduleDelete([{ path: far, kind: 'raw', taskId: 'task-M', reason: 'x' }], { graceHours: 24, statePath: s3, now: 1_700_000_000_000, logger: quietLogger });
    const view = listPendingDelete({ statePath: s3, trashRoot: otherTrash });
    eq('异盘时界面能看出"不会进回收站"', view.pending[0]!.willTrash, false);
    const farDel = deletePendingNow([r4.added[0]!.id], { statePath: s3, trashRoot: otherTrash, logger: quietLogger });
    eq('异盘走永久删除', farDel.deleted[0]!.by, 'rm');
    ok(!fs.existsSync(far), '文件确实被永久删掉了（这正是确认框要警告的事）');
    ok(/永久删除/.test(farDel.deleted[0]!.note), '结果说明里写明了"永久删除"', farDel.deleted[0]!.note);
  }

  /* ====== 13. 取消必须是永久的 + 复活必须原地（否则界面上"点不掉、到点却会删"） ======
   *
   * 背景：反查循环每 5 分钟对每个"本场全部切片已确认"的场次调一次 `scheduleDelete`。
   * 老实现按路径去重时**不看 cancelled**，于是用户点完「取消」5 分钟后又被排回去 ——
   * 界面那一刻写着"已取消"，铡刀却重新架好了。
   * 而且重新排入是**追加一条新记录**，而 id 由路径派生（`pd-<hash>`）→ 两条同 id：
   * `cancelPendingDelete` / `deletePendingNow` 用 `find(e => e.id === id)` 命中的是**旧的已取消那条**，
   * 于是「取消失败、立即删除也被跳过」，文件变成**界面上管不住**。 */
  section('13. 取消必须永久生效；重新排入必须原地复活（同 id 只能有一条活记录）');
  {
    const state = newState();
    const raw = writeFile(path.join(rawsDir, 'cancel-durable.flv'), 4096);
    const t0 = 1_700_000_000_000;
    const input = { path: raw, kind: 'raw' as const, taskId: 'task-N', reason: '本场全部切片已确认' };
    const r1 = scheduleDelete([input], { graceHours: 24, statePath: state, now: t0, logger: quietLogger });
    const id = r1.added[0]!.id;
    eq('第一次排入 1 项', r1.added.length, 1);

    /* 13a. 用户取消 */
    eq('取消成功', cancelPendingDelete(id, { statePath: state, logger: quietLogger }).ok, true);
    eq('取消后不再列为待删', listPendingDelete({ statePath: state, now: t0 }).stats.pendingCount, 0);

    /* 13b. 自动循环又来了（不传 reviveCancelled）→ 必须**保持取消** */
    const r2 = scheduleDelete([input], { graceHours: 24, statePath: state, now: t0 + 5 * 60_000, logger: quietLogger });
    eq('自动循环不会重新排入（added = 0）', r2.added.length, 0);
    eq('但会明确报告"这一条被用户取消过"', r2.heldCancelled.length, 1);
    eq('heldCancelled 里带的是原来那条的 id', r2.heldCancelled[0]!.existingId, id);
    eq('清单里仍然是 0 条待删（取消没有被抹掉）', listPendingDelete({ statePath: state, now: t0 + 5 * 60_000 }).stats.pendingCount, 0);

    /* 13c. 到点了也不会删（自动清理只认 pending） */
    const run = runDueDeletions({ statePath: state, now: t0 + 25 * 3600_000, trashRoot, logger: quietLogger });
    eq('到点后依然什么都没删', run.deleted, 0);
    ok(fs.existsSync(raw), '文件还在（"取消"经得起自动循环和时间两重考验）');

    /* 13d. 显式复活：**原地**复用同一条记录，id 不变、不新增条目 */
    const r3 = scheduleDelete([input], { graceHours: 1, statePath: state, now: t0 + 26 * 3600_000, logger: quietLogger, reviveCancelled: true });
    eq('显式复活：added 保持 0（没有新记录）', r3.added.length, 0);
    eq('显式复活：revived 1 条', r3.revived.length, 1);
    eq('复活的是同一条（id 不变）', r3.revived[0]!.id, id);
    const afterRevive = listPendingDelete({ statePath: state, now: t0 + 26 * 3600_000 });
    eq('复活后重新列为待删', afterRevive.pending.length, 1);
    eq('宽限期按新的 now 重新计算（1 小时后到点）', afterRevive.pending[0]!.dueAt, new Date(t0 + 27 * 3600_000).toISOString());
    eq('取消痕迹已清除', afterRevive.pending[0]!.cancelledAt, undefined);

    /* 13e. 复活后还能再取消（同 id 唯一，按 id 查得到活记录） */
    eq('复活后可以再取消', cancelPendingDelete(id, { statePath: state, logger: quietLogger }).ok, true);
    const viewAfter = listPendingDelete({ statePath: state, now: t0 + 26 * 3600_000 });
    eq('再次取消后没有待删', viewAfter.stats.pendingCount, 0);
    eq('取消历史有 1 条（不是两条同 id 堆着）', viewAfter.cancelled.length, 1);

    /* 13f. 历史脏数据：清单里真的存在同 id 两条（一取消一活）时，
        「取消 / 立即删除」必须命中**活的**那条，否则界面上按钮点了没反应、文件却会到点被删。
        这里直接往状态文件里塞一条手工构造的活记录来复现。 */
    const s4 = newState();
    const dup = writeFile(path.join(rawsDir, 'dup-id.flv'), 2048);
    const dupId = `pd-dup-${Date.now()}`;
    const now = new Date(1_700_000_000_000).toISOString();
    fs.writeFileSync(
      s4,
      JSON.stringify({
        version: 1,
        entries: [
          { id: dupId, path: dup, kind: 'raw', taskId: 'task-O', reason: '旧的已取消那条', sizeBytes: 2048, createdAt: now, dueAt: now, cancelledAt: now },
          { id: dupId, path: dup, kind: 'raw', taskId: 'task-O', reason: '新的活那条', sizeBytes: 2048, createdAt: now, dueAt: now },
        ],
      }),
      'utf8',
    );
    eq('前置：同 id 两条，其中 1 条是活的', listPendingDelete({ statePath: s4, now: 1_700_000_000_000 }).stats.pendingCount, 1);
    eq('取消命中活的那条（不是旧的已取消条目）', cancelPendingDelete(dupId, { statePath: s4, logger: quietLogger }).ok, true);
    eq('取消后真的没有待删了', listPendingDelete({ statePath: s4, now: 1_700_000_000_000 }).stats.pendingCount, 0);
    ok(fs.existsSync(dup), '文件还在');

    /* 13g. 同 id 两条时「立即删除」也要命中活的那条（否则用户点了"立即删除"却什么都没发生） */
    const s5 = newState();
    const dup2 = writeFile(path.join(rawsDir, 'dup-id-2.flv'), 2048);
    const dupId2 = `pd-dup2-${Date.now()}`;
    fs.writeFileSync(
      s5,
      JSON.stringify({
        version: 1,
        entries: [
          { id: dupId2, path: dup2, kind: 'raw', taskId: 'task-P', reason: '旧的已取消那条', sizeBytes: 2048, createdAt: now, dueAt: now, cancelledAt: now },
          { id: dupId2, path: dup2, kind: 'raw', taskId: 'task-P', reason: '新的活那条', sizeBytes: 2048, createdAt: now, dueAt: now },
        ],
      }),
      'utf8',
    );
    const dupDel = deletePendingNow([dupId2], { statePath: s5, trashRoot, logger: quietLogger });
    eq('立即删除命中了活的那条（deleted = 1）', dupDel.deleted.length, 1);
    eq('同盘 → 进回收站', dupDel.deleted[0]!.by, 'trash');
    ok(!fs.existsSync(dup2), '文件确实被删了（用户的点击不是"点了没反应"）');
  }

  console.log('\n' + '─'.repeat(74));
  console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响结论 */
  }
  if (fail > 0) process.exitCode = 1;
}

try {
  main();
} catch (e) {
  console.error('\x1b[31m验证异常：\x1b[0m', e instanceof Error ? e.message : e);
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(1);
}
