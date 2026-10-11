/**
 * 直接修 `appConfig.json` 的某个字段（当 `/config/set` 与 `POST /config` 都被忽略时用）。
 *
 * 为什么需要它：实测部分字段通过 HTTP 写入后**返回 success 但不落盘**
 * （`llmPresets` 就是 —— 旧值 "" → 期望 [] → 复核仍是 ""）。
 * 这种时候只能直接改文件。
 *
 * ⚠️ biliLive-tools 正在运行时可能持有内存副本并在下次保存时覆盖文件。
 *    所以本工具会：① 备份；② 改文件；③ 立刻复核；④ 提示需要重启才生效（若被覆盖）。
 *
 * 用法：
 *   node --experimental-strip-types tools/blt-file-set.ts --get llmPresets
 *   node --experimental-strip-types tools/blt-file-set.ts --set-json llmPresets='[]'
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join(process.env['APPDATA'] ?? '', 'biliLive-tools', 'appConfig.json');
const argv = process.argv.slice(2);
const argOf = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const line = (s = ''): void => console.log(s);

if (!fs.existsSync(FILE)) {
  console.error(`找不到 ${FILE}`);
  process.exit(1);
}
const doc = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Record<string, unknown>;

const getKey = argOf('--get');
if (getKey) {
  line(`${getKey} = ${JSON.stringify(doc[getKey])}`);
  process.exit(0);
}

const setArg = argOf('--set-json');
if (!setArg) {
  line('用法：--get <key>  或  --set-json <key>=<json>');
  process.exit(1);
}
const eq = setArg.indexOf('=');
if (eq < 0) {
  line('需要 key=json 形式');
  process.exit(1);
}
const key = setArg.slice(0, eq);
const jsonText = setArg.slice(eq + 1);
let value: unknown;
try {
  value = JSON.parse(jsonText) as unknown;
} catch (e) {
  line(`值不是合法 JSON：${(e as Error).message}`);
  process.exit(1);
}

line('='.repeat(80));
line(`直接改 appConfig.json：${key}`);
line('='.repeat(80));
line(`  旧值：${JSON.stringify(doc[key])}`);
doc[key] = value;

const backup = `${FILE}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(FILE, backup);
line(`  已备份：${path.basename(backup)}`);

fs.writeFileSync(FILE, JSON.stringify(doc, null, 2), 'utf8');
line(`  新值：${JSON.stringify(value)}`);

/* 复核（读回来） */
const after = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Record<string, unknown>;
const ok = JSON.stringify(after[key]) === JSON.stringify(value);
line(ok ? '  ✓ 已写入磁盘' : `  ✗ 写入未生效，读回是 ${JSON.stringify(after[key])}`);
line('');
line('  ⚠ 若 biliLive-tools 正在运行，它可能在下次保存配置时覆盖此文件；');
line('    改完后建议重启该软件，或在它的设置界面里确认一次。');
line('');
