/**
 * 改 biliLive-tools 的**投稿预设**（`presets.json`），例如把 `is_only_self` 打开。
 *
 * 为什么需要它：本次测试要求稿件"仅自己可见"，链路上有两个上传者 ——
 *   · 本项目（追加切片）：读 config.json 的 `publish.isOnlySelf`，已是 1；
 *   · biliLive-tools（投完整弹幕版 + 纯享版）：读它自己的**投稿预设**。
 * 预设里控制可见性的字段是 **`is_only_self`**（snake_case！不是 isOnlySelf ——
 * 按驼峰搜是搜不到的，实测踩过这个坑）：
 *   is_only_self = 0 → 公开；= 1 → 仅自己可见。
 * 实测默认预设是 0，也就是**完整版会被公开**，与切片侧不一致。
 *
 * 预设不在 `/config`（appConfig.json）里，也不在 `/preset/*` HTTP 路由
 * （只有 danmu/ffmpeg/video/subtitle-style），而是独立文件
 * `%APPDATA%/biliLive-tools/presets.json`，形如：
 *   [ { id:"default", name:"默认配置", config:{ …, is_only_self:0, tid:138, uid:… } }, … ]
 *
 * ⚠️ biliLive-tools 正在运行时，它对 presets.json 可能持有内存副本；直接改文件
 *    有被覆盖的风险。所以本工具**同时**尝试通过 `POST /config`（setAll）提交，
 *    并在最后复核。两条路都失败时会明确让你去界面里改。
 *
 * 用法：
 *   node --experimental-strip-types tools/blt-preset-set.ts --list
 *   node --experimental-strip-types tools/blt-preset-set.ts --set is_only_self=1 --preset default
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const PRESETS = path.join(process.env['APPDATA'] ?? '', 'biliLive-tools', 'presets.json');
const argv = process.argv.slice(2);
const argOf = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const line = (s = ''): void => console.log(s);

interface PresetConfig {
  is_only_self?: number;
  tid?: number;
  copyright?: number;
  title?: string;
  tag?: string[];
  uid?: number;
  [k: string]: unknown;
}
interface Preset {
  id: string;
  name?: string;
  config: PresetConfig;
}

if (!fs.existsSync(PRESETS)) {
  console.error(`找不到预设文件：${PRESETS}`);
  process.exit(1);
}
const presets = JSON.parse(fs.readFileSync(PRESETS, 'utf8')) as Preset[];

/* ---- --list ---- */
line('='.repeat(90));
line(`biliLive-tools 投稿预设（${PRESETS}）`);
line('='.repeat(90));
for (const p of presets) {
  const only = p.config?.is_only_self;
  const flag = only === 1 ? '\x1b[32m仅自己可见\x1b[0m' : only === 0 ? '\x1b[31m公开\x1b[0m' : '(未设置)';
  line(`  · id=${p.id.padEnd(14)} name=${String(p.name ?? '').padEnd(12)} is_only_self=${JSON.stringify(only)} → ${flag}`);
  line(`      tid=${String(p.config?.tid)} copyright=${String(p.config?.copyright)} uid=${String(p.config?.uid ?? '').slice(0, 8)}…`);
  line(`      title=${JSON.stringify(String(p.config?.title ?? '').slice(0, 50))}`);
  line(`      tags=${JSON.stringify((p.config?.tag ?? []).slice(0, 6))}`);
}
line('');

const setArg = argOf('--set');
const presetId = argOf('--preset');
if (!setArg) {
  line('（只读模式。要改：--set is_only_self=1 [--preset default]）');
  process.exit(0);
}

const eq = setArg.indexOf('=');
if (eq < 0) {
  line(`--set 需要 key=value 形式，收到：${setArg}`);
  process.exit(1);
}
const key = setArg.slice(0, eq);
const rawVal = setArg.slice(eq + 1);
const value: unknown = rawVal === 'true' ? true : rawVal === 'false' ? false : /^-?\d+$/.test(rawVal) ? Number(rawVal) : rawVal;

const targets = presetId ? presets.filter((p) => p.id === presetId) : presets;
if (targets.length === 0) {
  line(`没有 id=${String(presetId)} 的预设`);
  process.exit(1);
}

line('='.repeat(90));
line(`准备修改 ${targets.length} 个预设的 ${key} = ${JSON.stringify(value)}`);
line('='.repeat(90));
for (const t of targets) {
  const before = t.config?.[key];
  t.config = { ...(t.config ?? {}), [key]: value };
  line(`  ${t.id}: ${JSON.stringify(before)} → ${JSON.stringify(value)}`);
}

/* 备份 */
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(PRESETS, '..', `presets.json.backup-${stamp}`);
fs.copyFileSync(PRESETS, backup);
line(`  已备份原文件：${path.basename(backup)}`);

/* 写文件 */
fs.writeFileSync(PRESETS, JSON.stringify(presets, null, 2), 'utf8');
line('  ✓ 已写入 presets.json');

/* 同时尝试通过 HTTP 提交（若 biliLive-tools 有内存副本，这样能让它跟上）。
 *
 * ⚠️⚠️ 这里有个**踩过的坑**：第一版按 `/preset/i` 匹配 `/config` 里的键名，
 * 结果匹配到了 `llmPresets` —— 那是 **LLM 供应商预设**（原本是空数组），
 * 被我们写成了投稿预设数组，等于污染了对方一个无关配置。
 * 教训：**键名形似不代表语义相同**，不能凭名字猜。所以现在改成白名单：
 * 只认语义明确的键（`biliUploadPresets` / `uploadPresets`），
 * 一个都没有就什么都不写 —— 预设本来就是独立文件，写文件已经足够。 */
try {
  const cfg = loadConfig('config.json').config;
  const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });
  type Req = <T>(p: string, o: Record<string, unknown>) => Promise<T>;
  const req = (client as unknown as { request: Req }).request.bind(client) as Req;
  const all = (await req<unknown>('/config', { purpose: '读取配置', tag: 'preset' })) as Record<string, unknown>;
  const doc = ((all as { data?: unknown })?.data ?? all) as Record<string, unknown>;
  /** 只允许这几个**语义明确**的键承载投稿预设（不按模糊匹配猜） */
  const SAFE_KEYS = ['biliUploadPresets', 'uploadPresets'];
  const present = SAFE_KEYS.filter((k) => Array.isArray(doc[k]));
  if (present.length > 0) {
    const next = { ...doc };
    for (const k of present) next[k] = presets;
    await req('/config', { method: 'POST', body: next, purpose: '同步预设到运行实例', tag: 'preset' });
    line(`  ✓ 已通过 POST /config 同步（${present.join(', ')}）`);
  } else {
    line('  · /config 里没有语义明确的投稿预设键 → 只写文件（预设本来就是独立文件）。');
    line('    若 biliLive-tools 正开着且界面里看到的还是旧值：在它的设置页里切一下预设再切回来，');
    line('    或重启该软件即可让它重读 presets.json。');
  }
} catch (e) {
  line(`  · HTTP 同步跳过（不影响文件已写入）：${(e as Error).message.slice(0, 90)}`);
}

/* 复核 */
const after = JSON.parse(fs.readFileSync(PRESETS, 'utf8')) as Preset[];
line('');
line('复核：');
for (const p of after) {
  line(`  ${p.id}: ${key}=${JSON.stringify(p.config?.[key])}`);
}
line('');
