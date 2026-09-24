/**
 * 弹幕 → ASS 转换（烧进画面用）。
 *
 * ## 为什么需要这个模块
 *
 * 烧弹幕需要 ASS 文件，而录播只带 XML。有两条路径，**都不可靠，必须组合使用**：
 *
 * 1. **biliLive-tools 的 `POST /task/convertXml2Ass`**
 *    实测在 v3.21.0 上恒定报 `HTTP 500 保存类型错误`，且试遍 `preset` /
 *    `saveType` / `savePath` / `presetId` 各种组合都无效。**不可用**。
 *
 * 2. **DanmakuFactory CLI**（biliLive-tools 自带）
 *    实测 `-o ass -i xml <xml>` **只输出前 150 秒的 115 条**（XML 里共 891 条、
 *    时间轴 0–1384 秒），是它 XML 解析器的 bug。
 *    但 `-o json -i xml` 能导出**全部 891 条**，再 `-o ass -i json` 也能得到
 *    全部 891 条 —— 所以走 **JSON 中转**是可行的。
 *
 * 因此本模块的策略是：**先直转，用弹幕条数校验结果，不合理就自动走 JSON 中转**；
 * 两条路都不行时，用内置的 XML→ASS 兜底实现（不依赖外部程序，保证链路不断）。
 *
 * ## 时间轴一致性（关键）
 *
 * XML 里的 `p` 第一字段是**相对该场视频起点**的秒数（实测与视频时长一致），
 * 与转写、切片用的是同一基准，因此**不需要额外偏移**。
 * 这一点由 `signals.json` 的 `danmakuOffset` 独立校验过。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { exists, ensureDir } from './util.ts';
import { log as globalLog, type Logger } from './logger.ts';

export interface DanmakuConvertResult {
  /** 生成的 ASS 路径（失败时为 undefined） */
  assPath?: string;
  /** 实际使用的转换方式 */
  method: 'bililive-tools' | 'danmakufactory-direct' | 'danmakufactory-via-json' | 'builtin';
  /** 生成的弹幕条数 */
  dialogueCount: number;
  /** XML 里的弹幕条数（用于判断是否丢弹幕） */
  xmlCount: number;
  warnings: string[];
}

/* ============================================================================
 * 弹幕条数统计与校验
 * ========================================================================== */

/** 统计 XML 里的弹幕条数（`<d>` + 高能事件节点） */
export function countXmlDanmaku(xmlPath: string): number {
  try {
    const text = fs.readFileSync(xmlPath, 'utf8');
    const d = (text.match(/<d\s+p=/g) ?? []).length;
    const sc = (text.match(/<sc\s/g) ?? []).length;
    const guard = (text.match(/<guard\s/g) ?? []).length;
    return d + sc + guard;
  } catch {
    return 0;
  }
}

/** 统计 ASS 里的 Dialogue 行数 */
export function countAssDialogue(assPath: string): number {
  try {
    const text = fs.readFileSync(assPath, 'utf8');
    return (text.match(/^Dialogue:/gm) ?? []).length;
  } catch {
    return 0;
  }
}

/**
 * 去掉 UTF-8 BOM。
 *
 * ⚠️ 踩过三次的同一类坑：**Windows 工具链对 BOM 的处理不一致**。
 * 实测 DanmakuFactory 生成的 ASS **带 BOM**，而 biliLive-tools 的切片接口
 * 拿到带 BOM 的 ASS 会报 `HTTP 500`；剥掉 BOM 后立刻成功。
 * 所以凡是要交给别的程序消费的文本文件，一律写出**无 BOM** 版本。
 */
export function stripBom(assPath: string): boolean {
  try {
    const buf = fs.readFileSync(assPath);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      fs.writeFileSync(assPath, buf.subarray(3));
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 统计 ASS 里最后一条弹幕的时刻（秒），用于判断时间轴是否被截断 */
export function lastAssTime(assPath: string): number {
  try {
    const text = fs.readFileSync(assPath, 'utf8');
    let max = 0;
    const re = /^Dialogue:[^,]*,(\d+):(\d+):(\d+)[.:](\d+)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100;
      if (t > max) max = t;
    }
    return max;
  } catch {
    return 0;
  }
}

/* ============================================================================
 * DanmakuFactory
 * ========================================================================== */

export interface DanmakuFactoryOptions {
  /** DanmakuFactory.exe 路径 */
  exePath: string;
  /** 视频分辨率，影响滚动弹幕的行数与字号 */
  width?: number;
  height?: number;
  /** 字号 */
  fontSize?: number;
  fontName?: string;
  /** 单次执行超时（毫秒） */
  timeoutMs?: number;
}

/** 弹幕条数低于此比例就认为转换丢内容，需换方式重试 */
const LOSS_TOLERANCE = 0.8;

function runFactory(opts: DanmakuFactoryOptions, args: string[]): { ok: boolean; stderr: string } {
  try {
    const out = execFileSync(opts.exePath, args, {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { ok: true, stderr: String(out) };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return { ok: false, stderr: err.stderr ? String(err.stderr) : (err.message ?? '执行失败') };
  }
}

function commonArgs(opts: DanmakuFactoryOptions): string[] {
  const args = ['-r', `${opts.width ?? 1920}x${opts.height ?? 1080}`];
  if (opts.fontSize) args.push('-S', String(opts.fontSize));
  if (opts.fontName) args.push('-N', opts.fontName);
  // 弹幕少的时候不要因为「是否覆盖文件」的提示而失败
  args.push('--ignore-warnings');
  return args;
}

/**
 * 用 DanmakuFactory 把 XML 转成 ASS。
 *
 * 先直转并校验条数；丢内容就自动改走 JSON 中转（实测能拿到全部弹幕）。
 */
export function convertWithFactory(
  xmlPath: string,
  assOut: string,
  opts: DanmakuFactoryOptions,
  logger: Logger = globalLog,
): DanmakuConvertResult {
  const warnings: string[] = [];
  const xmlCount = countXmlDanmaku(xmlPath);
  ensureDir(path.dirname(assOut));

  /* ---- 路线 1：XML → ASS 直转 ---- */
  try {
    if (exists(assOut)) fs.unlinkSync(assOut);
    const r = runFactory(opts, ['-o', 'ass', assOut, '-i', 'xml', xmlPath, ...commonArgs(opts)]);
    const n = countAssDialogue(assOut);
    if (r.ok && n > 0 && (xmlCount === 0 || n >= xmlCount * LOSS_TOLERANCE)) {
      return finalizeAss(assOut, 'danmakufactory-direct', xmlCount, warnings);
    }
    warnings.push(
      `DanmakuFactory 的 XML→ASS 直转丢内容（XML ${xmlCount} 条 → ASS ${n} 条，` +
        `最晚 ${lastAssTime(assOut).toFixed(0)}s），改用 JSON 中转`,
    );
    logger.debug(warnings[warnings.length - 1]!);
  } catch (e) {
    warnings.push(`DanmakuFactory 直转异常：${(e as Error).message}`);
  }

  /* ---- 路线 2：XML → JSON → ASS ---- */
  const jsonTmp = `${assOut}.tmp.json`;
  try {
    if (exists(assOut)) fs.unlinkSync(assOut);
    if (exists(jsonTmp)) fs.unlinkSync(jsonTmp);
    const r1 = runFactory(opts, ['-o', 'json', jsonTmp, '-i', 'xml', xmlPath]);
    if (r1.ok && exists(jsonTmp)) {
      const r2 = runFactory(opts, ['-o', 'ass', assOut, '-i', 'json', jsonTmp, ...commonArgs(opts)]);
      const n = countAssDialogue(assOut);
      if (r2.ok && n > 0 && (xmlCount === 0 || n >= xmlCount * LOSS_TOLERANCE)) {
        return finalizeAss(assOut, 'danmakufactory-via-json', xmlCount, warnings);
      }
      warnings.push(`JSON 中转仍不完整（XML ${xmlCount} → ASS ${n}）`);
    } else {
      warnings.push(`DanmakuFactory 导出 JSON 失败：${r1.stderr.slice(0, 120)}`);
    }
  } catch (e) {
    warnings.push(`JSON 中转异常：${(e as Error).message}`);
  } finally {
    try {
      if (exists(jsonTmp)) fs.unlinkSync(jsonTmp);
    } catch {
      /* ignore */
    }
  }

  /* ---- 路线 3：内置兜底 ---- */
  warnings.push('外部转换均不完整，改用内置 XML→ASS 兜底实现（保证链路不断，样式较朴素）');
  const builtin = builtinXmlToAss(xmlPath, assOut, opts);
  if (builtin > 0) {
    return finalizeAss(assOut, 'builtin', xmlCount, warnings);
  }
  warnings.push('内置兜底也未能生成弹幕 —— 本片将不带弹幕');
  return { method: 'builtin', dialogueCount: 0, xmlCount, warnings };
}

/* ============================================================================
 * 内置兜底实现（不依赖任何外部程序）
 * ========================================================================== */

/** ASS 时间戳 H:MM:SS.cc */
function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(Math.min(99, cs)).padStart(2, '0')}`;
}

/** ASS 里需要转义的字符 */
function escAss(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, ' ');
}

interface RawD {
  time: number;
  /** 模式：1/2/3 滚动，4 底部固定，5 顶部固定，6 逆向，7 特殊 */
  mode: number;
  color: number;
  text: string;
}

/**
 * 极简 XML → ASS。
 *
 * 只做**保证能用**的最小实现：滚动弹幕随机分配轨道、固定弹幕置顶/置底。
 * 不做碰撞检测与密度控制 —— 它是兜底，不是主力；主力是 DanmakuFactory。
 */
export function builtinXmlToAss(xmlPath: string, assOut: string, opts: DanmakuFactoryOptions): number {
  let text: string;
  try {
    text = fs.readFileSync(xmlPath, 'utf8');
  } catch {
    return 0;
  }
  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const fontSize = opts.fontSize ?? Math.round(height / 27);
  const fontName = opts.fontName ?? 'Microsoft YaHei';

  const items: RawD[] = [];
  const re = /<d\s+p="([^"]+)"[^>]*>([\s\S]*?)<\/d>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const parts = m[1]!.split(',');
    const time = Number(parts[0]);
    if (!Number.isFinite(time)) continue;
    const mode = Number(parts[1] ?? 1) || 1;
    const color = Number(parts[3] ?? 0xffffff) || 0xffffff;
    const body = m[2]!.trim();
    if (!body) continue;
    items.push({ time, mode, color, text: body });
  }
  if (items.length === 0) return 0;

  // B站颜色是 0xRRGGBB，ASS 是 &HAABBGGRR
  const toAssColor = (c: number): string => {
    const r = (c >> 16) & 0xff;
    const g = (c >> 8) & 0xff;
    const b = c & 0xff;
    return `&H00${b.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${r.toString(16).padStart(2, '0')}`;
  };

  const lines: string[] = [
    '[Script Info]',
    '; Generated by live_auto builtin converter (DanmakuFactory unavailable or incomplete)',
    'ScriptType: v4.00+',
    'Collisions: Normal',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Scroll,${fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,1,7,0,0,0,1`,
    `Style: Top,${fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,1,8,0,0,0,1`,
    `Style: Bottom,${fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,1,2,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const scrollSec = 12;
  const fixSec = 5;
  const laneCount = Math.max(1, Math.floor((height * 0.85) / (fontSize * 1.4)));
  let lane = 0;
  let topLane = 0;
  let bottomLane = 0;

  for (const it of items) {
    const start = assTime(it.time);
    if (it.mode === 4) {
      const y = height - fontSize * (1.5 + bottomLane++ % 3);
      lines.push(
        `Dialogue: 0,${start},${assTime(it.time + fixSec)},Bottom,,0,0,0,,{\\pos(${Math.round(width / 2)},${Math.round(y)})}${escAss(it.text)}`,
      );
    } else if (it.mode === 5) {
      const y = fontSize * (1.5 + topLane++ % 3);
      lines.push(
        `Dialogue: 0,${start},${assTime(it.time + fixSec)},Top,,0,0,0,,{\\pos(${Math.round(width / 2)},${Math.round(y)})}${escAss(it.text)}`,
      );
    } else {
      // 滚动：{\move(x1,y1,x2,y2)} 从右到左
      const y = Math.round(fontSize * 1.4 * (lane++ % laneCount) + fontSize);
      lines.push(
        `Dialogue: 0,${start},${assTime(it.time + scrollSec)},Scroll,,0,0,0,,` +
          `{\\move(${width + 10},${y},-${Math.round(it.text.length * fontSize * 0.6)},${y})\\c${toAssColor(it.color)}}${escAss(it.text)}`,
      );
    }
  }

  try {
    ensureDir(path.dirname(assOut));
    fs.writeFileSync(assOut, lines.join('\n'), 'utf8');
    return countAssDialogue(assOut);
  } catch {
    return 0;
  }
}

/* ============================================================================
 * 自动探测 DanmakuFactory
 * ========================================================================== */

/**
 * 找出 DanmakuFactory.exe。
 *
 * 探测顺序：
 *   1. 显式配置（config.json 的 `danmaku.factoryPath`）
 *   2. 环境变量 `LIVE_AUTO_DANMAKU_FACTORY`
 *   3. 从**运行中的 biliLive-tools 进程**推断安装目录
 *      —— 这一步比读它的 appConfig.json 可靠：实测那里存的可能是历史遗留路径
 *   4. 几个常见安装位置
 */
export function findDanmakuFactory(explicit?: string): string | undefined {
  const rel = path.join('resources', 'app.asar.unpacked', 'resources', 'bin', 'DanmakuFactory.exe');
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (process.env['LIVE_AUTO_DANMAKU_FACTORY']) candidates.push(process.env['LIVE_AUTO_DANMAKU_FACTORY']);

  // 从进程推断
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "(Get-Process biliLive-tools -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1).Path",
      ],
      { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (out && out.toLowerCase().endsWith('.exe')) {
      candidates.push(path.join(path.dirname(out), rel));
    }
  } catch {
    /* 拿不到进程信息就算了，继续试其它位置 */
  }

  // 常见位置
  const home = process.env['USERPROFILE'] ?? '';
  for (const base of [
    path.join(home, 'Desktop'),
    path.join(home, 'AppData', 'Local', 'Programs'),
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ]) {
    candidates.push(path.join(base, 'biliLive-tools', rel));
  }

  for (const c of candidates) {
    if (c && exists(c)) return c;
  }
  return undefined;
}

/* ---------------------------------------------------------------------------
 * 转换后的统一收尾
 * ------------------------------------------------------------------------- */

/**
 * 转换成功后的统一处理：去 BOM + 校验条数。
 *
 * 去 BOM 是**必须**的：biliLive-tools 的切片接口拿到带 BOM 的 ASS 会直接 500。
 */
function finalizeAss(
  assPath: string,
  method: DanmakuConvertResult['method'],
  xmlCount: number,
  warnings: string[],
): DanmakuConvertResult {
  const hadBom = stripBom(assPath);
  if (hadBom) warnings.push('已移除 ASS 的 UTF-8 BOM（带 BOM 的 ASS 会让 biliLive-tools 的切片接口报 500）');
  return { assPath, method, dialogueCount: countAssDialogue(assPath), xmlCount, warnings };
}

/* ============================================================================
 * 统一的对外入口
 * ========================================================================== */

export interface ConvertDanmakuInput {
  taskId: string;
  /** 视频路径（用于推断分辨率） */
  videoPath: string;
  xmlPath: string;
  assOut: string;
  /** DanmakuFactory 路径；不传则跳过外部工具直接用内置实现 */
  factoryPath?: string;
  width?: number;
  height?: number;
  fontSize?: number;
  fontName?: string;
  /** 先尝试 biliLive-tools 的接口（实测在 3.21.0 上不可用，默认关） */
  tryBililiveApi?: (input: string, output: string) => Promise<void>;
  logger?: Logger;
}

/**
 * 把某场的弹幕 XML 转成可用于烧录的 ASS。
 * 返回结果里带 `method` 与条数，便于日志与 UI 交代「弹幕是怎么来的、是否完整」。
 */
export async function convertDanmakuToAss(input: ConvertDanmakuInput): Promise<DanmakuConvertResult> {
  const logger = input.logger ?? globalLog;
  const warnings: string[] = [];
  const xmlCount = countXmlDanmaku(input.xmlPath);

  // 路线 0（可选）：biliLive-tools 自带接口
  if (input.tryBililiveApi) {
    try {
      if (exists(input.assOut)) fs.unlinkSync(input.assOut);
      await input.tryBililiveApi(input.xmlPath, input.assOut);
      const n = countAssDialogue(input.assOut);
      if (n > 0 && (xmlCount === 0 || n >= xmlCount * LOSS_TOLERANCE)) {
        return finalizeAss(input.assOut, 'bililive-tools', xmlCount, warnings);
      }
      warnings.push(`biliLive-tools 的 convertXml2Ass 结果不完整或为空（${n}/${xmlCount}）`);
    } catch (e) {
      warnings.push(`biliLive-tools 的 convertXml2Ass 不可用：${(e as Error).message.slice(0, 120)}`);
    }
  }

  // 路线 1/2：DanmakuFactory
  if (input.factoryPath && exists(input.factoryPath)) {
    const r = convertWithFactory(
      input.xmlPath,
      input.assOut,
      {
        exePath: input.factoryPath,
        ...(input.width ? { width: input.width } : {}),
        ...(input.height ? { height: input.height } : {}),
        ...(input.fontSize ? { fontSize: input.fontSize } : {}),
        ...(input.fontName ? { fontName: input.fontName } : {}),
      },
      logger,
    );
    return { ...r, warnings: [...warnings, ...r.warnings] };
  }

  // 路线 3：内置兜底
  warnings.push(
    input.factoryPath
      ? `DanmakuFactory 路径不存在（${input.factoryPath}），使用内置兜底转换`
      : '未配置 DanmakuFactory 路径，使用内置兜底转换（样式较朴素）',
  );
  const n = builtinXmlToAss(input.xmlPath, input.assOut, {
    exePath: '',
    ...(input.width ? { width: input.width } : {}),
    ...(input.height ? { height: input.height } : {}),
    ...(input.fontSize ? { fontSize: input.fontSize } : {}),
    ...(input.fontName ? { fontName: input.fontName } : {}),
  });
  if (n > 0) return finalizeAss(input.assOut, 'builtin', xmlCount, warnings);
  return { method: 'builtin', dialogueCount: 0, xmlCount, warnings };
}
