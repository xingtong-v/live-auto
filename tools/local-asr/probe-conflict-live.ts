/**
 * 对**正在运行的**服务发一次故意过期的保存请求，确认乐观锁在真实进程里生效。
 *
 * 这是一个只读式探针：请求必然被 409 拒绝，所以 config.json 不该有任何变化。
 * 用法：node tools/local-asr/probe-conflict-live.ts [port]
 */
import fs from 'node:fs';
import { CONFIG_PATH } from '../../src/util.ts';

const port = Number(process.argv[2] ?? 3000);
const base = `http://127.0.0.1:${port}`;

const before = fs.readFileSync(CONFIG_PATH, 'utf8');
const boot = (await (await fetch(`${base}/api/bootstrap`)).json()) as { csrf: string; configVersion: string };
console.log(`服务端口        : ${port}`);
console.log(`bootstrap 版本  : ${boot.configVersion}`);

const res = await fetch(`${base}/api/config`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrf },
  body: JSON.stringify({ patch: { clip: { maxCandidates: 3 } }, configVersion: '0000000000000000' }),
});
const body = (await res.json()) as {
  code?: string;
  error?: string;
  conflict?: { wouldOverwrite?: string[]; changedByOthers?: string[]; actual?: string };
};

console.log(`HTTP 状态       : ${res.status}`);
console.log(`code            : ${body.code}`);
console.log(`会覆盖掉的字段  : ${(body.conflict?.wouldOverwrite ?? []).join('、') || '(无)'}`);
console.log(`外部改动的字段  : ${(body.conflict?.changedByOthers ?? []).join('、') || '(无)'}`);
console.log(`错误文案        : ${(body.error ?? '').slice(0, 150)}`);

const after = fs.readFileSync(CONFIG_PATH, 'utf8');
const unchanged = before === after;
console.log(`\nconfig.json 未被改动 : ${unchanged ? '✓' : '✗'}`);

const live = (await (await fetch(`${base}/api/bootstrap`)).json()) as { config: { clip: { maxCandidates: number } } };
console.log(`服务里 maxCandidates 仍为 : ${live.config.clip.maxCandidates}（应为 20，未被探针改成 3）`);

const okAll =
  res.status === 409 &&
  body.code === 'CONFIG_CONFLICT' &&
  unchanged &&
  live.config.clip.maxCandidates !== 3;
console.log(okAll ? '\n结论：乐观锁在运行中的服务上生效 ✓' : '\n结论：未达预期 ✗');
process.exitCode = okAll ? 0 : 1;
