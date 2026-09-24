/**
 * 检查"仅自己可见"在两个软件里各自由谁控制 —— 上传前必须确认。
 *
 * 背景：B站 的可见性由 `copyright` 之外的 `is_only_self` 字段控制：
 *   is_only_self = 1 → 仅自己可见（草稿性质，观众看不到）
 *   is_only_self = 0 → 公开
 * 本次测试要求"仅自己可见"，而链路上有**两个**上传者：
 *   ① biliLive-tools —— 投完整弹幕版 + 纯享版（它用**自己的投稿预设**）
 *   ② 本项目 —— 追加切片（用 config.json 的 publish.isOnlySelf）
 * 两者必须都为 1，否则会出现"一部分分P 公开、一部分仅自己可见"的割裂稿件。
 *
 * 只读，不改任何东西。
 *
 * 用法：node --experimental-strip-types tools/check-only-self.ts
 */
import { loadConfig } from '../src/config.ts';
import { BiliLiveClient } from '../src/api.ts';

const cfg = loadConfig('config.json').config;
const client = new BiliLiveClient({ baseUrl: cfg.bililive.baseUrl, passKey: cfg.bililive.passKey });

const line = (s = ''): void => console.log(s);
line('='.repeat(90));
line('「仅自己可见」的两个控制点');
line('='.repeat(90));

/* ---- ① 本项目 ---- */
line('① 本项目（切片追加用）：config.json');
line(`   publish.isOnlySelf = ${JSON.stringify(cfg.publish.isOnlySelf)}` + (cfg.publish.isOnlySelf === 1 ? '  ✓ 仅自己可见' : '  ⚠ 不是仅自己可见'));
line(`   publish.tidWhitelist = ${JSON.stringify(cfg.publish.tidWhitelist)}`);
line(`   publish.defaultCategory = ${JSON.stringify(cfg.publish.defaultCategory)}`);
line('');

/* ---- ② biliLive-tools ---- */
line('② biliLive-tools（完整版/纯享版用）：它的投稿预设');
const raw = await client.getConfig();
const o = ((raw as { data?: unknown }).data ?? raw) as Record<string, unknown>;

interface Preset {
  id?: string;
  name?: string;
  isOnlySelf?: number | boolean;
  copyright?: number;
  tid?: number;
  title?: string;
  dtime?: number;
  [k: string]: unknown;
}
const bu = (o['biliUpload'] ?? {}) as Record<string, unknown>;
const presets = (bu['presets'] ?? o['biliUploadPresets'] ?? []) as Preset[];
line(`   找到 ${Array.isArray(presets) ? presets.length : 0} 个投稿预设`);
if (Array.isArray(presets)) {
  for (const p of presets) {
    const only = p.isOnlySelf;
    const flag = only === 1 || only === true ? '✓ 仅自己可见' : only === 0 || only === false ? '⚠ 公开' : '? 未设置';
    line(`   · id=${String(p.id)} name=${String(p.name ?? '')}  isOnlySelf=${JSON.stringify(only)} ${flag}`);
    for (const k of ['copyright', 'tid', 'dtime']) {
      if (k in p) line(`       ${k} = ${JSON.stringify(p[k])}`);
    }
  }
}

/* webhook 侧的默认上传预设（决定完整版用哪个预设） */
const w = (o['webhook'] ?? {}) as Record<string, unknown>;
line('');
line(`   webhook.uploadPresetId = ${JSON.stringify(w['uploadPresetId'])}`);
line(`   webhook.uid            = ${String(w['uid'] ?? '(无)').slice(0, 8)}…`);
line(`   webhook.open           = ${JSON.stringify(w['open'])}`);
line(`   webhook.uploadToSameMedia = ${JSON.stringify(w['uploadToSameMedia'])}`);
line(`   webhook.uploadNoDanmu  = ${JSON.stringify(w['uploadNoDanmu'])}`);
line('');

/* 预设里的 isOnlySelf 与 webhook 默认预设对齐了吗 */
const defId = String(w['uploadPresetId'] ?? 'default');
const def = Array.isArray(presets) ? presets.find((p) => String(p.id) === defId || String(p.name) === defId) : undefined;
line('='.repeat(90));
line('结论');
line('='.repeat(90));
if (!def) {
  line(`  ⚠ 找不到 webhook 指定的预设「${defId}」—— 需要人工确认它在 biliLive-tools 界面里的可见性设置。`);
} else {
  const only = def.isOnlySelf;
  const ok = only === 1 || only === true;
  line(`  webhook 用的预设「${String(def.name ?? def.id)}」：isOnlySelf=${JSON.stringify(only)} → ${ok ? '✓ 仅自己可见' : '⚠ 不是仅自己可见，完整版/纯享版会被公开！'}`);
  if (!ok) {
    line('');
    line('  ⇒ 要改成仅自己可见：在 biliLive-tools 的「设置 → 投稿 → 该预设」里勾上"仅自己可见"，');
    line('     或用本项目的 tools/blt-config-set.ts 改配置（需先确认字段路径）。');
  }
}
line('');
line(`  本项目切片侧：isOnlySelf=${JSON.stringify(cfg.publish.isOnlySelf)}` + (cfg.publish.isOnlySelf === 1 ? ' ✓' : ' ⚠'));
line('');
