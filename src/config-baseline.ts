/**
 * 配置基线与差异（2026-10-14，优化清单 P1-7 最后一件："你改过哪些项"）。
 *
 * 问题：设置面板有 81 个控件、config.json 有 240 个叶子字段，但**看不出哪些被动过** ——
 * 排障与交接时最需要的恰恰是这一条（"这套配置和你出厂时有哪里不一样"）。
 *
 * 做法（A 方案）：
 *   1. 首次读取时把**当时的生效配置**写一份 `data/config-baseline.json` 当基线（此后不再动它）；
 *   2. 界面拿基线与当前配置做纯函数差分，列出被改动的路径（值变了/新增/删除）；
 *   3. 基线文件可随时删掉重建（删了就会以当下为新基线），**不进台账、不参与任何业务逻辑**。
 *
 * 刻意保守：差异只用于**展示**，绝不参与校验或保存逻辑（避免"基线丢了导致保存行为变化"这种事）。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ConfigDiff {
  path: string;
  kind: 'changed' | 'added' | 'removed';
  from?: string;
  to?: string;
}

/** 把值压成一行短文本（只用于展示，不参与判断） */
function show(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 38)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.length} 项]`;
  if (typeof v === 'object') return '{…}';
  return String(v);
}

/** 只比叶子（对象/数组整体当叶子比，不做深递归合并 —— 数组顺序变了就算变了） */
export function diffConfig(baseline: unknown, current: unknown, prefix = ''): ConfigDiff[] {
  const out: ConfigDiff[] = [];
  const b = baseline as Record<string, unknown> | undefined;
  const c = current as Record<string, unknown> | undefined;
  const isObj = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

  if (isObj(b) && isObj(c)) {
    const keys = new Set([...Object.keys(b), ...Object.keys(c)]);
    for (const k of [...keys].sort()) {
      const p = prefix ? `${prefix}.${k}` : k;
      const inB = Object.prototype.hasOwnProperty.call(b, k);
      const inC = Object.prototype.hasOwnProperty.call(c, k);
      if (inB && !inC) out.push({ path: p, kind: 'removed', from: show(b[k]) });
      else if (!inB && inC) out.push({ path: p, kind: 'added', to: show(c[k]) });
      else out.push(...diffConfig(b[k], c[k], p));
    }
    return out;
  }

  /* 非对象（或类型不同）：整体比较 */
  const sb = JSON.stringify(baseline ?? null);
  const sc = JSON.stringify(current ?? null);
  if (sb !== sc && prefix) out.push({ path: prefix, kind: 'changed', from: show(baseline), to: show(current) });
  return out;
}

export const BASELINE_FILE = 'config-baseline.json';

/** 读基线；不存在则用**当前配置**创建一份（此后不再覆写） */
export function readOrCreateBaseline(opts: { dataDir: string; current: unknown }): { baseline: unknown; created: boolean; path: string } {
  const file = path.join(opts.dataDir, BASELINE_FILE);
  try {
    if (fs.existsSync(file)) {
      return { baseline: JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, created: false, path: file };
    }
    fs.writeFileSync(file, JSON.stringify(opts.current, null, 2) + '\n', 'utf8');
    return { baseline: opts.current, created: true, path: file };
  } catch {
    /* 读不到/写不了就当没有基线：界面退化为"不显示改过项"，绝不因此报错 */
    return { baseline: undefined, created: false, path: file };
  }
}
