/**
 * 转写进度的**精确**测量与聚合（2026-10-15，用户需求：「精确进度」）。
 *
 * 为什么要单独一个模块：界面上原来那行「转写进度 N%（估算）」是**猜**出来的 ——
 * 它拿"本页第一次看到这个任务处于 TRANSCRIBING 的时刻"当锚点，再乘一个标称速度
 * （0.25 × 音频时长）。页面刚打开时锚点是假的 ⇒ 数字必然偏低（实测：真实跑了 16 分钟，
 * 界面上显示 1%）。用户要的是"已经转写多少、还剩多少时间"，猜的数字比没有更糟 ——
 * 它会让人做出错误的判断（以为还要跑 10 小时，于是去睡觉/或者手动杀掉）。
 *
 * 精确数据来自两个**实测**来源：
 *   ① 本地执行器（`tools/local-asr/transcribe-funasr.py`）把音频切成若干**子批**推理，
 *      每跑完一批就往 stderr 打一行 `##ASR-PROGRESS## {json}`：
 *      已经推进到本块音频的第几秒、本批用掉的墙上时间 ⇒ 速度是**实测**的，不是标称的；
 *   ② 每个调用单元（块）的**固定成本**（抽音频 + VAD + 模型加载 ≈ 实测 90–100 秒）
 *      也一起报上来 ⇒ "还剩几块没开始"的等待时间能算进去，而不是假装它不存在。
 *
 * 聚合口径（这是本模块的核心，也是它值得被单测钉死的原因）：
 *   · `audioTotalSec` = 各调用单元的音频秒数之和（不是视频总时长 —— 多分段时两者不同）；
 *   · `audioDoneSec`  = 各单元**已推进位置**之和，命中缓存/跳过的单元按整块计；
 *   · `pct`           = audioDoneSec / audioTotalSec（**测量值**，不是估算）；
 *   · `etaSec`        = 剩余音频 / 实测速度 + 还没开始的块数 × 单块固定成本。
 *
 * ⚠️ 为什么进度按"音频秒"而不是"块数"：块的粒度太粗（30 分钟一块时，一场 1 小时 43 分
 * 只有 4 块，进度会在 0/25/50/75/100 之间跳），用户看到的还是"不知道跑了多少"。
 */

/** 执行器往 stderr 打进度行时用的前缀（stderr 里混着 funasr 自己的日志，必须有哨兵） */
export const ASR_PROGRESS_PREFIX = '##ASR-PROGRESS##';

/** 执行器上报的阶段。`asr` 之外的阶段都没有细粒度百分比（单次库调用），只用于文案 */
export type AsrPhase = 'extract' | 'vad' | 'load' | 'asr';

/** 一行进度（执行器 → TS） */
export interface AsrTick {
  phase: AsrPhase;
  /** 已推进到的音频位置（相对本块起点，秒）；`asr` 阶段 = 最后一条已识别句子的结束位置 */
  doneSec: number;
  /** 本块音频总长（秒） */
  totalSec: number;
  /** 已识别的句子数 / 总句子数（`asr` 阶段才有） */
  segDone?: number;
  segTotal?: number;
  /** 实测速度：已识别语音秒 / 墙上秒（累计值，不是瞬时值） */
  speed?: number;
  /** 本块进程从启动到此刻的毫秒数（它在 `asr` 阶段的第一行 = 该块的固定成本） */
  elapsedMs?: number;
}

/** 阶段的中文文案（界面上直接显示） */
const PHASE_TEXT: Record<string, string> = {
  queued: '排队中',
  extract: '抽取音频',
  vad: '语音切句',
  load: '加载模型',
  asr: '识别中',
  done: '已完成',
};

export function phaseText(phase: string): string {
  return PHASE_TEXT[phase] ?? phase;
}

/**
 * 解析执行器的一行 stderr。
 *
 * 容错是必须的，不是"顺手加的"：这一行混在 funasr 自己的日志里（`sys.stdout` 被改道到 stderr），
 * 而且它只是**进度**——解析失败绝不能让转写失败。所以任何异常都返回 `undefined`。
 */
export function parseAsrProgressLine(line: string): AsrTick | undefined {
  const at = line.indexOf(ASR_PROGRESS_PREFIX);
  if (at < 0) return undefined;
  const payload = line.slice(at + ASR_PROGRESS_PREFIX.length).trim();
  if (!payload.startsWith('{')) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const phase = String(raw['phase'] ?? '');
  if (phase !== 'extract' && phase !== 'vad' && phase !== 'load' && phase !== 'asr') return undefined;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const doneSec = num(raw['done_sec']);
  const totalSec = num(raw['total_sec']);
  const tick: AsrTick = {
    phase,
    doneSec: Number.isFinite(doneSec) ? Math.max(0, doneSec) : 0,
    totalSec: Number.isFinite(totalSec) ? Math.max(0, totalSec) : 0,
  };
  const segDone = num(raw['seg_done']);
  const segTotal = num(raw['seg_total']);
  const speed = num(raw['speed']);
  const elapsedMs = num(raw['elapsed_ms']);
  if (Number.isFinite(segDone)) tick.segDone = Math.max(0, segDone);
  if (Number.isFinite(segTotal)) tick.segTotal = Math.max(0, segTotal);
  if (Number.isFinite(speed) && speed > 0) tick.speed = speed;
  if (Number.isFinite(elapsedMs)) tick.elapsedMs = Math.max(0, elapsedMs);
  return tick;
}

/**
 * 全项目通用的进度载荷（`asr` / `analyze` / `publish` 三条链共用）。
 *
 * `label` / `current` / `total` 是**原有契约**（`statusText()` 与界面早就在读它们），
 * 后面那些是可选的**精确**字段：只有转写会填，其余链路保持原样即可。
 */
export interface ProgressPayload {
  label: string;
  current: number;
  total: number;
  /** 精确百分比（0–100 整数）。只有拿到实测数据才有 —— 没有时界面**不显示**，不许猜 */
  pct?: number;
  /** 阶段中文文案（识别中 / 加载模型 / 语音切句 / 抽取音频） */
  phase?: string;
  audioDoneSec?: number;
  audioTotalSec?: number;
  /** 本阶段已用秒数（从进入 TRANSCRIBING 起算） */
  elapsedSec?: number;
  /** 预计剩余秒数；`null` = 算不出来（还没测到速度），界面显示"计算中" */
  etaSec?: number | null;
  /** 实测速度：音频秒 / 墙上秒 */
  speed?: number | null;
  chunksDone?: number;
  chunksTotal?: number;
  startedAt?: string;
  updatedAt?: string;
}

interface WindowState {
  total: number;
  done: number;
  /** 是否已经开始跑（与"跑完"不同：用于统计"还有几块要付固定成本"） */
  started: boolean;
  phase: string;
  speed: number | null;
  /** 该块实测的固定成本（秒）—— 有实测值就用实测，没有就用默认值 */
  loadSec: number | null;
}

/** 单块固定成本的默认值（秒）：抽音频 + VAD + Fun-ASR 模型加载，实测 ≈90–100 秒 */
export const DEFAULT_LOAD_SEC = 96;

/**
 * 进度聚合器。**纯逻辑**（不吃时钟、不碰文件），所以能在毫秒级单测里钉死。
 *
 * 一个实例对应**一次 transcribe() 调用**（= 一个任务的一场转写）。
 */
export class AsrProgressTracker {
  private readonly wins: WindowState[];
  private readonly startedAtMs: number;
  private readonly defaultLoadSec: number;
  /** 最近一次实测速度（跨块共享：同一台机器、同一次运行，速度不会突变） */
  private lastSpeed: number | null = null;
  /** 最近有进度的那个块的阶段（界面上显示"现在卡在哪一步"） */
  private lastPhase = 'queued';
  private updatedAtMs: number;

  constructor(windows: Array<{ audioSec: number }>, opts: { startedAtMs?: number; loadSec?: number } = {}) {
    this.startedAtMs = opts.startedAtMs ?? Date.now();
    this.defaultLoadSec = opts.loadSec && opts.loadSec > 0 ? opts.loadSec : DEFAULT_LOAD_SEC;
    this.updatedAtMs = this.startedAtMs;
    this.wins = windows.map((w) => ({
      total: Math.max(0, Number.isFinite(w.audioSec) ? w.audioSec : 0),
      done: 0,
      started: false,
      phase: 'queued',
      speed: null,
      loadSec: null,
    }));
  }

  /** 某个调用单元开始跑了（在挂起子进程之前调用） */
  markStarted(index: number): void {
    const w = this.wins[index];
    if (!w) return;
    w.started = true;
    if (w.phase === 'queued') w.phase = 'extract';
    this.lastPhase = w.phase;
  }

  /** 收到执行器的一行进度 */
  onTick(index: number, tick: AsrTick): void {
    const w = this.wins[index];
    if (!w) return;
    w.started = true;
    w.phase = tick.phase;
    this.lastPhase = tick.phase;
    this.updatedAtMs = Date.now();
    if (tick.speed && tick.speed > 0) {
      w.speed = tick.speed;
      this.lastSpeed = tick.speed;
    }
    /* ★ 只有**识别**阶段推进"已处理音频"。
       抽音频 / 切句 / 加载模型都是一次库调用、没有细粒度进度：执行器在它们结束时
       会报一行带**整块时长**的进度，若照单全收，界面会在开头就跳到 100%
       （单测第 2 节点住了这条 —— 它就是照着"第一版实现"的样子写的反例）。 */
    if (tick.phase !== 'asr') return;
    /* 固定成本：`asr` 阶段的**第一行**就是"这一块从启动到开始识别"的全部等待 */
    if (tick.elapsedMs !== undefined && w.loadSec === null) {
      w.loadSec = tick.elapsedMs / 1000;
    }
    /* 已推进位置：以执行器报的为准（它是**音频位置**，跨过静音段也是推进），
       但绝不后退（并发两块时两边的上报会交错，取最大值才不会让进度条来回跳）。 */
    const advanced = Math.min(w.total, tick.doneSec);
    if (advanced > w.done) w.done = advanced;
    /* 执行器报"整块结束"⇒ 直接算完成：末尾的静音不会被 VAD 覆盖，
       否则进度会永远停在 99%（实测：最后 8 秒静音就够卡住它）。 */
    if (tick.totalSec > 0 && tick.doneSec >= tick.totalSec - 0.5) w.done = w.total;
  }

  /** 某个调用单元结束了（识别完成 / 命中缓存 / dry-run 跳过 / 失败跳过）——都按"整块完成"计 */
  markDone(index: number): void {
    const w = this.wins[index];
    if (!w) return;
    w.done = w.total;
    w.started = true;
    w.phase = 'done';
    if (this.wins.every((x) => x.phase === 'done')) this.lastPhase = 'done';
    this.updatedAtMs = Date.now();
  }

  snapshot(nowMs = Date.now()): ProgressPayload {
    const audioTotalSec = this.wins.reduce((a, w) => a + w.total, 0);
    const audioDoneSec = this.wins.reduce((a, w) => a + Math.min(w.done, w.total), 0);
    const chunksTotal = this.wins.length;
    const chunksDone = this.wins.filter((w) => w.phase === 'done').length;
    const remainingAudio = Math.max(0, audioTotalSec - audioDoneSec);
    const pct = audioTotalSec > 0 ? Math.max(0, Math.min(100, Math.round((audioDoneSec / audioTotalSec) * 100))) : 0;

    /* 固定成本取"实测过的最大值"：宁可估多一点（用户更怕的是"以为马上好"）。 */
    const measured = this.wins.map((w) => w.loadSec).filter((x): x is number => x !== null);
    const loadSec = measured.length ? Math.max(...measured) : this.defaultLoadSec;
    const pendingStarts = this.wins.filter((w) => !w.started && w.phase !== 'done').length;

    let etaSec: number | null = null;
    if (audioTotalSec <= 0) {
      etaSec = 0;
    } else if (remainingAudio <= 0) {
      etaSec = 0;
    } else if (this.lastSpeed && this.lastSpeed > 0) {
      etaSec = Math.round(remainingAudio / this.lastSpeed + pendingStarts * loadSec);
    }
    /* 还没测到速度（正在抽音频/切句/加载模型）⇒ `null`：界面写"计算中"，
       绝不拿"标称速度"冒充，"还剩 3 分钟"里混进一个猜测值就等于骗人。 */
    const phase = this.lastPhase;
    const label =
      audioTotalSec > 0
        ? `转写中 ${pct}%（${fmtSecShort(audioDoneSec)} / ${fmtSecShort(audioTotalSec)} 音频，${phaseText(phase)}）`
        : `转写中（${phaseText(phase)}）`;
    return {
      label,
      current: chunksDone,
      total: chunksTotal,
      pct,
      phase: phaseText(phase),
      audioDoneSec: Math.round(audioDoneSec),
      audioTotalSec: Math.round(audioTotalSec),
      elapsedSec: Math.max(0, Math.round((nowMs - this.startedAtMs) / 1000)),
      etaSec,
      speed: this.lastSpeed === null ? null : Number(this.lastSpeed.toFixed(3)),
      chunksDone,
      chunksTotal,
      startedAt: new Date(this.startedAtMs).toISOString(),
      updatedAt: new Date(this.updatedAtMs).toISOString(),
    };
  }
}

/** 进度文案里的短时长（`44 分 12 秒` / `1 小时 43 分`）—— 比 `hh:mm:ss` 好读 */
export function fmtSecShort(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
