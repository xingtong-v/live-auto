/**
 * ASR 独立进程（2026-10-11，优化第二批「ASR 拆独立进程」第 4 步的 worker 本体）。
 *
 * 目标（**不是提速**）：把 ASR **阶段主管**从守护进程里挪出去 ——
 *   · 大素材转写不再拖慢主进程事件循环（界面/HTTP 不再发卡）；
 *   · 转写 OOM/崩溃**只死自己**，守护进程与看门狗不受影响（早期那次 OOM 是整条链一起死）；
 *   · 转写与"录制监听"不再共享一个进程，互不牵连。
 *
 * 协议（只走 JSON，父进程用 `child_process.fork` 起它）：
 *   父 → 子  { type:'job', job:{ taskId, totalDuration, allowPaid, segments, cacheDir } }
 *   子 → 父  { type:'ready' }                                 启动握手
 *            { type:'progress', label, current, total }        进度（转发给界面）
 *            { type:'done', transcript, stats }                成功
 *            { type:'error', message }                         失败（随后进程退出）
 *   父 → 子  { type:'ping' }  ⇒  { type:'pong' }               心跳
 *
 * ⚠️ 两个刻意的设计决定：
 *   ① **不通过 IPC 传配置**：worker 自己 `loadConfig()` 读盘 —— 免得把 passKey 之类的密钥
 *      在进程间搬来搬去；父进程只传"这一次任务需要的最小事实"。
 *   ② **不通过 IPC 传函数**：`media` 适配器含闭包，跨进程传不了 —— 所以传的是可序列化的
 *      `segments`，worker 侧用 `planSegmentCalls()`（与主进程同一份纯函数）重建，
 *      两边切出来的窗口必然一致（这条等价性有 `test/media-plan.ts` 兜着）。
 */
import { loadConfig } from './config.ts';
import { BiliLiveClient } from './api.ts';
import { AsrCache, Transcriber } from './asr.ts';
import { planSegmentCalls, type MediaSegment } from './media-plan.ts';
import { log } from './logger.ts';

interface Job {
  taskId: string;
  totalDuration: number;
  allowPaid: boolean;
  segments: MediaSegment[];
  cacheDir: string;
  /** dry-run 安全阀（与进程内路径同语义，见 WorkerJob 的注释） */
  dryRun?: boolean;
}

const send = (msg: Record<string, unknown>): void => {
  /* 父进程可能已经退出（被 kill 或崩溃）—— send 会静默失败，这里不当作错误 */
  try {
    process.send?.(msg);
  } catch {
    /* ignore */
  }
};

process.on('uncaughtException', (e) => {
  send({ type: 'error', message: `worker 未捕获异常：${(e as Error).message}` });
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  send({ type: 'error', message: `worker 未处理的 Promise 拒绝：${String((e as Error)?.message ?? e)}` });
  process.exit(1);
});

process.on('message', (raw) => {
  const msg = raw as { type?: string; job?: Job };
  if (msg?.type === 'ping') {
    send({ type: 'pong' });
    return;
  }
  if (msg?.type !== 'job' || !msg.job) return;
  const job = msg.job;
  void (async () => {
    try {
      const cfg = loadConfig().config;
      /* worker 只跑本地/已配置的 ASR；付费与否由父进程的 allowPaid 决定（默认不付费） */
      cfg.runtime.allowPaid = job.allowPaid === true;
      const transcriber = new Transcriber({
        client: BiliLiveClient.fromConfig(cfg, log),
        config: cfg,
        cache: new AsrCache(job.cacheDir, log),
      });
      /* 与主进程同一份纯函数：同样的 segments + 同样的区间 ⇒ 同样的调用单元 */
      const adapter = {
        planCalls: (range: { start: number; end: number }) => planSegmentCalls(job.segments, range).calls,
        fileStat: (file: string) => {
          try {
            const st = statOf(file);
            return { size: st.size, updatedAt: st.updatedAt };
          } catch {
            return { size: -1, updatedAt: 0 };
          }
        },
      };
      const res = await transcriber.transcribe({
        taskId: job.taskId,
        media: adapter,
        totalDuration: job.totalDuration,
        allowPaid: job.allowPaid === true,
        /* ⚠️ dryRun 必须一起带过来：不传的话，"dry-run 被拦下"这条会退化成另一种失败，
           守护进程就分不清"设计内拦截"与"真跑挂了"（见 WorkerJob 的注释）。 */
        ...(job.dryRun ? { dryRun: true } : {}),
        onProgress: (p) => send({ type: 'progress', label: p.label, current: p.current, total: p.total }),
      });
      /* 回传**整个结果对象**：形状与进程内路径一致，调用方不必区分两条路（少一处漂移点） */
      send({ type: 'done', result: res as unknown as Record<string, unknown> });
      process.exit(0);
    } catch (e) {
      send({ type: 'error', message: (e as Error).message });
      process.exit(1);
    }
  })();
});

/* 握手：父进程据此判断"worker 起来了、代码能加载"（起不来就回退进程内路径） */
send({ type: 'ready' });

import fs from 'node:fs';
function statOf(f: string): { size: number; updatedAt: number } {
  const st = fs.statSync(f);
  return { size: st.size, updatedAt: Math.round(st.mtimeMs) };
}
