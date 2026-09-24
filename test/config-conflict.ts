/**
 * 配置保存的乐观锁自测：界面里的**过期表单**不能静默覆盖外部改动。
 *
 * 背景（真实事故）：我在命令行把 `llm.select.model` 改成 "deepseek-v4-pro"，
 * 随后用户在**早就打开的**设置面板上点了一次「保存配置」（他只改了别的项），
 * 界面把表单里那份「打开面板那一刻」的快照整体回存，`select.model` 被写回空串，
 * 选片档模型就这么无声无息地没了 —— 日志里只有一行「配置已热加载」。
 *
 * 修法：`/api/bootstrap` 下发 configVersion（config.json 内容的 sha1 前 16 位），
 * 界面保存时原样回传；服务端发现磁盘版本已变就**拒绝写入**并列出差异，
 * 由用户选「重新加载」还是「强制覆盖」。
 *
 * 运行：node test/config-conflict.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../src/config.ts';

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auto-cfgconflict-'));
const configPath = path.join(tmpRoot, 'config.json');

const base = {
  llm: { summary: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test', model: 'deepseek-chat' }, select: { model: '' } },
  clip: { maxCandidates: 20 },
};
fs.writeFileSync(configPath, JSON.stringify(base, null, 2), 'utf8');

const readModel = (): string =>
  (JSON.parse(fs.readFileSync(configPath, 'utf8')) as { llm: { select: { model: string } } }).llm.select.model;
const readRaw = (): string => fs.readFileSync(configPath, 'utf8');

section('1. 版本号随内容变化');
{
  const store = new ConfigStore(configPath);
  const v1 = store.fileVersion;
  ok('读到非空版本号', v1.length === 16, `v1=${v1}`);
  ok('reloadIfChanged 在同内容下返回 false', store.reloadIfChanged() === false);
  const again = new ConfigStore(configPath).fileVersion;
  ok('同样内容得到同样版本号（内容哈希，不是时间戳）', again === v1, `v1=${v1} again=${again}`);
}

section('2. 核心事故复现：外部改动不被过期表单覆盖');
{
  const store = new ConfigStore(configPath);
  const staleVersion = store.fileVersion; // 界面打开设置面板那一刻拿到的版本

  // 外部（命令行 / 别的程序）把选片档模型配上
  const disk = JSON.parse(readRaw()) as Record<string, unknown>;
  (disk['llm'] as { select: { model: string } }).select.model = 'deepseek-v4-pro';
  fs.writeFileSync(configPath, JSON.stringify(disk, null, 2), 'utf8');
  const afterExternal = new ConfigStore(configPath).fileVersion;

  // 界面拿着过期表单保存：patch 里 select.model 还是表单里的空串
  const formPatch = { llm: { select: { model: '' } } };
  const r = store.save(formPatch as never, staleVersion);

  ok('保存被拒绝（返回 conflict）', Boolean(r.conflict), JSON.stringify(r.conflict ?? {}).slice(0, 160));
  ok('磁盘上的 select.model 仍是外部写入的值', readModel() === 'deepseek-v4-pro', `实际="${readModel()}"`);
  ok('冲突里报出了会被覆盖的字段', (r.conflict?.stalePaths ?? []).some((p) => p.includes('select.model')), JSON.stringify(r.conflict?.stalePaths ?? []));
  ok('冲突里报出了外部改动的字段', (r.conflict?.changedPaths ?? []).some((p) => p.includes('select.model')), JSON.stringify(r.conflict?.changedPaths ?? []));
  ok('冲突里带上了磁盘版本号', r.conflict?.actual === afterExternal, `actual=${r.conflict?.actual} expected=${afterExternal}`);
}

section('3. 版本一致时正常写入');
{
  const store = new ConfigStore(configPath);
  const v = store.fileVersion;
  const r = store.save({ clip: { maxCandidates: 8 } } as never, v);
  ok('无冲突', !r.conflict);
  ok('patch 已生效', (JSON.parse(readRaw()) as { clip: { maxCandidates: number } }).clip.maxCandidates === 8);
  ok('回传了新版本号', typeof r.version === 'string' && r.version.length === 16, `version=${r.version}`);
  ok('新版本号与磁盘现状一致', r.version === new ConfigStore(configPath).fileVersion);
  ok('外部写入的 select.model 未被清掉（未提交的字段保持原值）', readModel() === 'deepseek-v4-pro', `实际="${readModel()}"`);
}

section('4. 不带版本号时行为不变（内部调用如生成 MCP token）');
{
  const store = new ConfigStore(configPath);
  const r = store.save({ clip: { maxCandidates: 15 } } as never);
  ok('不传 expectVersion 不做校验', !r.conflict);
  ok('写入生效', (JSON.parse(readRaw()) as { clip: { maxCandidates: number } }).clip.maxCandidates === 15);
}

section('5. 强制覆盖（用户明确选择「以界面为准」）');
{
  const store = new ConfigStore(configPath);
  const stale = 'deadbeefdeadbeef';
  const before = readRaw();
  const rejected = store.save({ clip: { maxCandidates: 3 } } as never, stale);
  ok('过期版本被拒', Boolean(rejected.conflict));
  ok('拒绝时文件一个字节都没动', readRaw() === before);
  const forced = store.save({ clip: { maxCandidates: 3 } } as never); // 语义等价于 force：不校验
  ok('强制写入成功', !forced.conflict);
  ok('强制写入的值已落盘', (JSON.parse(readRaw()) as { clip: { maxCandidates: number } }).clip.maxCandidates === 3);
}

section('6. 掩码安全阀仍然有效（不能被乐观锁改坏）');
{
  const store = new ConfigStore(configPath);
  const v = store.fileVersion;
  const r = store.save({ llm: { summary: { apiKey: 'sk-***st' } } } as never, v);
  ok('掩码值被识别并忽略', r.maskedIgnored.length === 1, JSON.stringify(r.maskedIgnored));
  const onDisk = (JSON.parse(readRaw()) as { llm: { summary: { apiKey: string } } }).llm.summary.apiKey;
  ok('真实 Key 未被掩码串覆盖', onDisk === 'sk-test', `实际="${onDisk}"`);
}

console.log(`\n\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\x1b[31m失败项：\x1b[0m');
  for (const f of failures) console.log(`  - ${f}`);
}
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败不影响结论 */
}
process.exitCode = fail === 0 ? 0 : 1;
