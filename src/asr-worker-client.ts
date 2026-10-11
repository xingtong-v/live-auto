/**
 * ASR 独立进程的**父进程侧客户端**（2026-10-11，第 5 步）。
 *
 * 职责边界（刻意划清，便于回退）：
 *   · 本文件只负责"起 worker、握手、转任务、收结果、超时/心跳兜底、收尸"；
 *   · **不做重试策略** —— 崩一次重试、崩两次降级到进程内路径，由调用方（daemon）决定；
 *   · 不知道 TranscribeResult 之外的任何业务（术语表、落盘、进度上报都在调用方那边接）。
 *
 * 为什么值得单独一个文件：它是"ASR 出问题不拖垮主链"的唯一入口。把它做成纯客户端之后，
 * 主链只需要 `try { await transcribeInWorker(job) } catch { 走原来的进程内路径 }` ——
 * 降级不是第二套实现，而是"少一次尝试"。
 */
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { ROOT_DIR } from './util.ts';
import type { MediaSegment } from './media-plan.ts';

export interface WorkerJob {
  taskId: string;
  totalDuration: number;
  allowPaid: boolean;
  segments: MediaSegment[];
  /** 与进程内路径共用同一份缓存目录，保证结果可复用 */
  cacheDir: string;
  /**
   * dry-run 安全阀（云端 ASR 才受影响：本地引擎不产生费用，`asr.ts` 里那道闸对它本来就不适用）。
   *
   * 为什么必须跟着任务走：dry-run 被拦下时落地的是**空转写 + 一条特定前缀的 gap reason**，
   * 而守护进程靠那个前缀区分"设计内的安全拦截"和"真跑挂了"。
   * 不传的话，同一场在独立进程里会得到**另一种**原因 —— 明明只是 dry-run，却会被报成转写失败。
   */
  dryRun?: boolean;
}

/** 与进程内 `Transcriber.transcribe()` 的返回**同形状**（worker 直接回传整个结果对象） */
export type WorkerResult = Record<string, unknown>;

/** worker 不可用（起不来 / 握手失败 / 心跳丢失 / 超时 / 崩溃）——调用方据此降级 */
export class AsrWorkerError extends Error {
  readonly kind: 'spawn' | 'handshake' | 'heartbeat' | 'timeout' | 'crash' | 'error';
  constructor(kind: AsrWorkerError['kind'], message: string) {
    super(message);
    this.name = 'AsrWorkerError';
    this.kind = kind;
  }
}

export interface TranscribeInWorkerOptions {
  onProgress?: (p: { label: string; current: number; total: number }) => void;
  /** 整体超时（秒）；默认 4 小时，与 asr.localFunasr.timeoutSec 默认一致 */
  timeoutSec?: number;
  /**
   * 整体超时的**毫秒直给**（给了就优先于 `timeoutSec`，且**不受 60 秒下限约束**）。
   *
   * 这个下限是给生产用的：现实中转写一次至少几分钟，配一个小值只会把好好的转写掐掉。
   * 但"超时后确实会收尸、会归类成 `timeout`"这条必须能被测试**在毫秒级**证明 ——
   * 否则它永远只能靠"等 60 秒"来验，久而久之就没人验了。所以留一个显式的测试口子。
   */
  timeoutMs?: number;
  /** worker 堆上限（MB）；默认 2048。OOM 时只死 worker，守护进程不受影响 */
  maxOldSpaceMb?: number;
  /** 握手超时（毫秒）：起不来就尽快降级，别让主链干等 */
  handshakeMs?: number;
  /**
   * 刚 fork 出子进程时回调（诊断/故障注入用）。
   * 守护进程据此把 worker 的 pid 写进日志 —— 它吃满内存时，用户能照着这个 pid 找到并结束它。
   * 回调里的异常**不会**影响转写（这里不是业务逻辑，不该有机会把主链带崩）。
   */
  onSpawn?: (child: ChildProcess) => void;
  /** 心跳间隔 / 丢失容忍（毫秒） */
  heartbeatMs?: number;
  /** 测试用：替换 worker 脚本路径 */
  forkPath?: string;
}

/**
 * 在独立进程里跑一次转写。
 * 任何失败都以 `AsrWorkerError` 抛出（并保证子进程已被杀掉），**不抛别的异常类型** ——
 * 这样调用方的 catch 分支不必猜"这是业务失败还是 worker 失败"。
 */
export async function transcribeInWorker(job: WorkerJob, opts: TranscribeInWorkerOptions = {}): Promise<WorkerResult> {
  const script = opts.forkPath ?? path.join(ROOT_DIR, 'src', 'asr-worker.ts');
  const handshakeMs = opts.handshakeMs ?? 30_000;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const timeoutMs = opts.timeoutMs !== undefined ? Math.max(1, opts.timeoutMs) : Math.max(60_000, (opts.timeoutSec ?? 4 * 3600) * 1000);

  let child: ChildProcess;
  try {
    child = fork(script, [], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      execArgv: [`--max-old-space-size=${opts.maxOldSpaceMb ?? 2048}`],
    });
  } catch (e) {
    throw new AsrWorkerError('spawn', `起 worker 失败：${(e as Error).message}`);
  }
  try {
    opts.onSpawn?.(child);
  } catch {
    /* 诊断回调不该有机会把转写带崩 */
  }

  return await new Promise<WorkerResult>((resolve, reject) => {
    let settled = false;
    let gotReady = false;
    let gotDone = false;
    let lastPong = Date.now();
    let hb: NodeJS.Timeout | undefined;
    const timers: NodeJS.Timeout[] = [];

    const cleanup = (): void => {
      for (const t of timers) clearTimeout(t);
      if (hb) clearInterval(hb);
      child.removeAllListeners();
      if (!child.killed) child.kill();
    };
    const fail = (kind: AsrWorkerError['kind'], message: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new AsrWorkerError(kind, message));
    };
    const succeed = (r: WorkerResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };

    /* 整体超时：ASR 卡死时要能收尸，否则主链会一直挂着 */
    timers.push(
      setTimeout(() => fail('timeout', `worker 转写超过 ${Math.round(timeoutMs / 1000)}s 未完成（已杀掉）`), timeoutMs),
    );
    /* 握手超时：起不来就尽快降级到进程内路径 */
    timers.push(
      setTimeout(() => {
        if (!gotReady) fail('handshake', `worker ${Math.round(handshakeMs / 1000)}s 内没有握手（脚本加载失败？）`);
      }, handshakeMs),
    );

    child.on('message', (raw) => {
      const msg = raw as { type?: string; label?: string; current?: number; total?: number; result?: unknown; message?: string };
      if (msg?.type === 'ready') {
        gotReady = true;
        try {
          child.send({ type: 'job', job });
        } catch (e) {
          fail('spawn', `向 worker 投递任务失败：${(e as Error).message}`);
          return;
        }
        /* 握手成功后开始心跳：worker 卡在 native 调用里时不会回 pong */
        hb = setInterval(() => {
          if (Date.now() - lastPong > heartbeatMs * 3) {
            fail('heartbeat', `worker 心跳丢失超过 ${Math.round((heartbeatMs * 3) / 1000)}s（已杀掉）`);
            return;
          }
          try {
            child.send({ type: 'ping' });
          } catch {
            /* 发送失败交给 exit 处理 */
          }
        }, heartbeatMs);
        return;
      }
      if (msg?.type === 'pong') {
        lastPong = Date.now();
        return;
      }
      if (msg?.type === 'progress') {
        opts.onProgress?.({ label: String(msg.label ?? ''), current: Number(msg.current ?? 0), total: Number(msg.total ?? 0) });
        return;
      }
      if (msg?.type === 'done') {
        gotDone = true;
        succeed((msg.result ?? {}) as WorkerResult);
        return;
      }
      if (msg?.type === 'error') {
        fail('error', `worker 报错：${String(msg.message ?? '未知')}`);
      }
    });

    child.on('exit', (code, signal) => {
      /* 正常路径下 done 已经 resolve 并 kill 掉了子进程，这里不会再走到 */
      if (gotDone) return;
      fail('crash', `worker 提前退出（code=${String(code)} signal=${String(signal)}）${gotReady ? '' : '，且从未握手'}`);
    });
    child.on('error', (e) => fail('spawn', `worker 进程错误：${e.message}`));
  });
}
