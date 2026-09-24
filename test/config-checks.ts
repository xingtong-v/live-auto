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
import fs from 'node:fs';
import path from 'node:path';
import { checkAfterUploadDelete } from '../src/cleanup.ts';
import { loadConfig } from '../src/config.ts';
import { ROOT_DIR } from '../src/util.ts';

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
function eq<T>(name: string, actual: T, expected: T): void {
  ok(name, actual === expected, actual === expected ? undefined : `期望 ${String(expected)}，实际 ${String(actual)}`);
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

section('4. 热词配置（术语表 → 本地 Fun-ASR）与界面接线');
{
  /* 默认必须**开着**：热词是零成本、零风险的一档提升，默认关掉等于用户永远用不上
     （而这条线此前正是"能力在、没接线"的典型）。 */
  const d = loadConfig().config.asr.localFunasr;
  ok('默认开启热词', d.hotwordsEnabled !== false, String(d.hotwordsEnabled));
  ok('默认热词上限是正整数', Number.isFinite(d.hotwordsMax) && d.hotwordsMax > 0, String(d.hotwordsMax));

  /* 界面接线：开关存在、**被绑上**、并且会被回写进配置 patch。
     "开关没绑"在本项目真实发生过（点了没反应、保存下去永远是 false），
     所以这三件事都要静态钉住，而不是靠肉眼看页面。 */
  const html = fs.readFileSync(path.join(ROOT_DIR, 'public', 'ui.html'), 'utf8');
  ok('配置面板有热词开关', /id="c_funasrHotwords"/.test(html));
  ok('有热词上限输入框', /id="c_funasrHotwordsMax"/.test(html));
  ok('热词开关被绑上（tgl 逐个绑定）', /tgl\('#c_funasrHotwords'/.test(html));
  ok('时间戳开关也被绑上（此前漏绑，点了没反应）', /tgl\('#c_funasrTimestamps'/.test(html));
  ok('两个字段都会回写进配置 patch', /hotwordsEnabled: on\('#c_funasrHotwords'\)/.test(html) && /hotwordsMax: num\('#c_funasrHotwordsMax'\)/.test(html));
  ok('界面写清了"只有本地 Fun-ASR 支持热词"', /只有它支持热词|只有本地 Fun-ASR/.test(html));

  /* 示例配置要让新用户看得见这两个开关 */
  const example = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config.example.json'), 'utf8')) as {
    asr?: { localFunasr?: { hotwordsEnabled?: boolean; hotwordsMax?: number } };
  };
  eq('config.example.json 里有 localFunasr 段', typeof example.asr?.localFunasr, 'object');
  eq('示例里默认开启热词', example.asr?.localFunasr?.hotwordsEnabled, true);
}

section('5. 不许有 BOM（本次真踩：PowerShell 改配置时加上了 BOM，服务直接起不来）');
{
  /* 实测事故：用 PowerShell 的 `Set-Content -Encoding UTF8` 往 config.json 插两行，
     它（Windows PowerShell 5.1）会写成 **UTF-8 with BOM**，而 `loadConfig` 是裸
     `JSON.parse` → 报 `Unexpected token '﻿'`，服务启动即挂。
     这类事故的特点是"上一步看着成功了"，所以要用测试钉住。
     ⚠️ `.ps1` 是**必须**带 BOM 的（见 README 的编码陷阱），这里要排除。 */
  const check = [
    'config.json',
    'config.example.json',
    'package.json',
    'tsconfig.json',
    'public/ui.html',
    'src/config.ts',
    'src/asr.ts',
  ];
  for (const rel of check) {
    const buf = fs.readFileSync(path.join(ROOT_DIR, rel));
    const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    ok(`${rel} 没有 BOM`, !bom, bom ? '开头是 EF BB BF —— 用编辑器另存为「UTF-8 无 BOM」' : undefined);
  }
  // .ps1 反过来：必须带 BOM，否则中文注释在 PowerShell 5.1 下会乱码/报错
  const ps1 = fs.readFileSync(path.join(ROOT_DIR, 'launcher.ps1'));
  ok('launcher.ps1 **必须**带 BOM（Windows PowerShell 5.1 的编码要求）', ps1[0] === 0xef && ps1[1] === 0xbb && ps1[2] === 0xbf);
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
