/**
 * 「配置 / 环境检查函数」的单元验证（无网络）。
 *
 * 现在只有一项：硬约束 #11 —— biliLive-tools 的「上传后删除素材」必须全部为 none。
 *
 * 为什么值得单独一个测试文件：这个开关**可以按房间单独覆盖**
 * （`webhook.rooms.<房间号>.afterUploadDeletAction`），而原实现用
 * `Object.keys(flat).find(...)` 只取第一个匹配键 → 「全局 none + 某房间 deleteAfterCheck」
 * 会被判为"已关闭"（**假绿**）。实测本机就是这个状态（房间 34567890 = deleteAfterCheck），
 * 后果是稿件过审后源视频被 biliLive-tools 删掉，转写与切片读到不存在的文件。
 *
 * 用法：node test/config-checks.ts
 */
import { checkAfterUploadDelete } from '../src/cleanup.ts';
import { loadConfig } from '../src/config.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` :: ${detail}` : ''}`);
  }
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
  console.log('─'.repeat(Math.max(20, Math.min(74, t.length * 2 + 8))));
}

const cfg = loadConfig().config;

console.log('\x1b[1m配置与环境检查\x1b[0m（硬约束 #11：上传后删除素材必须全部关闭）');
console.log('─'.repeat(74));

section('1. 全局开关');
{
  const r1 = checkAfterUploadDelete(cfg, { webhook: { afterUploadDeletAction: 'none' } });
  ok('全局 none → 合格', r1.ok, r1.message);
  ok('合格时也说明查了几处配置', /1 处配置/.test(r1.message), r1.message);

  const r2 = checkAfterUploadDelete(cfg, { webhook: { afterUploadDeletAction: 'deleteAfterCheck' } });
  ok('全局 deleteAfterCheck → 不合格', !r2.ok);
  ok('消息里点名「全局」', /全局/.test(r2.message), r2.message);
  ok('给出了 deleteAfterCheck 的专门修复说明（竞态）', /引用计数|加锁/.test(r2.fix ?? ''), r2.fix ?? '');

  const r3 = checkAfterUploadDelete(cfg, { webhook: { afterUploadDeletAction: 'delete' } });
  ok('全局 delete → 不合格', !r3.ok);
}

section('2. 房间级覆盖（原实现漏报的情形）');
{
  // ★ 这条是本文件存在的理由：全局 none、某房间开着 —— 必须判为不合格
  const r = checkAfterUploadDelete(cfg, {
    webhook: {
      afterUploadDeletAction: 'none',
      rooms: { 34567890: { afterUploadDeletAction: 'deleteAfterCheck' } },
    },
  });
  ok('全局 none + 房间级 deleteAfterCheck → 不合格（不再假绿）', !r.ok, r.message);
  ok('消息里指名了房间号', /34567890/.test(r.message), r.message);
  ok('提醒了「房间级覆盖会盖住全局」', /覆盖|逐个房间/.test(r.message), r.message);
  ok('修复建议里也带上了房间号', /34567890/.test(r.fix ?? ''), r.fix ?? '');

  const multi = checkAfterUploadDelete(cfg, {
    webhook: {
      afterUploadDeletAction: 'none',
      rooms: { 111: { afterUploadDeletAction: 'delete' }, 222: { afterUploadDeletAction: 'deleteAfterCheck' } },
    },
  });
  ok('多个房间有问题时全部报出', /111/.test(multi.message) && /222/.test(multi.message), multi.message);

  const clean = checkAfterUploadDelete(cfg, {
    webhook: { afterUploadDeletAction: 'none', rooms: { 333: { afterUploadDeletAction: 'none' } } },
  });
  ok('全局与所有房间都是 none → 合格', clean.ok, clean.message);
  ok('合格消息里说明了检查了几处', /2 处配置/.test(clean.message), clean.message);
}

section('3. 边界与健壮性');
{
  const none = checkAfterUploadDelete(cfg, { tool: { home: {} } });
  ok('读不到该字段时不误报为合格（给出人工确认提示）', none.ok && /人工|未能/.test(none.message), none.message);

  const cyc: Record<string, unknown> = { webhook: {} };
  (cyc['webhook'] as Record<string, unknown>)['self'] = cyc;
  let threw = false;
  try {
    checkAfterUploadDelete(cfg, cyc);
  } catch {
    threw = true;
  }
  ok('循环引用不抛异常', !threw);

  // 字段名大小写不敏感（不同版本的键名风格不一致）
  const upper = checkAfterUploadDelete(cfg, { Webhook: { AfterUploadDeletAction: 'delete' } });
  ok('字段名大小写不敏感', !upper.ok, upper.message);
}

console.log('\n' + '─'.repeat(74));
console.log(`\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (fail > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
  process.exitCode = 1;
} else {
  console.log('\x1b[32m硬约束 #11 的检查覆盖了「全局 + 每个房间」，行为符合预期。\x1b[0m');
}
