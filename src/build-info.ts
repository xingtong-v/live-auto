/**
 * 构建标识（build id）
 *
 * ============================================================================
 * 为什么需要（用户 2026-10-25 提：「加个版本号，让我知道修复的 bug 有没有更新到」）
 * ============================================================================
 * `APP_VERSION` 是手写的 `1.0.0`，改十次代码它也不动 —— 于是出现过一个很难受的场面：
 * 配额限流的修复**已经落盘、测试也全绿**，但 3000 端口跑的还是 07:37 启动的旧进程，
 * 用户点重投依旧被旧逻辑撞死，只能靠人去翻进程启动时间才能发现"没重启"。
 *
 * 所以这里给一个**由代码内容算出来的**构建号：
 *   · `running`：进程启动那一刻算出的指纹（不会变，代表"你正在跑的东西"）；
 *   · `onDisk` ：现在重新算一遍（代表"磁盘上最新的代码"）；
 *   · `stale`  ：两者不同 ⇒ 代码更新了但**没重启**，界面直接标红提醒。
 *
 * 参与指纹的文件：`src/**`（含 .ts/.js）、`web/src/**`、`package.json`、`tsconfig.json`。
 * **不参与**：`config.json` / `data/**` / `public/ui.html` —— 前两个是用户数据，
 * 第三个是构建产物（由 `npm run build:ui` 生成，改它不该让"代码版本"变化）。
 * ============================================================================
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface BuildSnapshot {
  /** 8 位十六进制指纹（内容摘要） */
  id: string;
  /** 参与指纹的文件数 */
  files: number;
  /** 这些文件里最新的 mtime（毫秒），用来给人看"代码最后什么时候动的" */
  latestMtimeMs: number;
}

export interface BuildStatus {
  running: BuildSnapshot;
  disk: BuildSnapshot;
  /** 磁盘代码比运行中的新 ⇒ 需要重启才生效 */
  stale: boolean;
  /** 给人看的一句话 */
  note: string;
}

const SCAN_DIRS = ['src', 'web/src'];
const SCAN_FILES = ['package.json', 'tsconfig.json'];

/** 递归收集参与指纹的文件（相对路径，正斜杠，排序后保证稳定） */
function collect(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(abs);
      } else if (e.isFile()) {
        out.push(abs);
      }
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(rootDir, d));
  for (const f of SCAN_FILES) {
    const abs = path.join(rootDir, f);
    if (fs.existsSync(abs)) out.push(abs);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** 算一次指纹（读文件内容，几十个文件量级，够快） */
export function computeBuild(rootDir: string): BuildSnapshot {
  const files = collect(rootDir);
  const h = crypto.createHash('sha256');
  let latest = 0;
  for (const abs of files) {
    const rel = path.relative(rootDir, abs).replace(/\\/g, '/');
    let buf: Buffer;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    h.update(rel);
    h.update('\0');
    h.update(buf);
    h.update('\0');
    try {
      const st = fs.statSync(abs);
      if (st.mtimeMs > latest) latest = st.mtimeMs;
    } catch {
      /* 读不到 mtime 不影响指纹 */
    }
  }
  return { id: h.digest('hex').slice(0, 8), files: files.length, latestMtimeMs: latest };
}

export class BuildInfo {
  private readonly rootDir: string;
  private readonly cacheMs: number;
  private readonly booted: BuildSnapshot;
  private diskCache?: { at: number; snap: BuildSnapshot };

  constructor(opts: { rootDir: string; cacheMs?: number }) {
    this.rootDir = opts.rootDir;
    this.cacheMs = opts.cacheMs ?? 3000;
    /* 进程启动即定格：之后磁盘怎么变，这个值都代表"你正在跑的那份代码" */
    this.booted = computeBuild(this.rootDir);
  }

  /** 进程启动时的构建（即"正在运行"的那份） */
  running(): BuildSnapshot {
    return this.booted;
  }

  /** 现在磁盘上的构建（带短缓存，避免每次 /api/bootstrap 都全量读文件） */
  onDisk(): BuildSnapshot {
    const now = Date.now();
    if (this.diskCache && now - this.diskCache.at < this.cacheMs) return this.diskCache.snap;
    const snap = computeBuild(this.rootDir);
    this.diskCache = { at: now, snap };
    return snap;
  }

  status(): BuildStatus {
    const running = this.running();
    const disk = this.onDisk();
    const stale = running.id !== disk.id;
    return {
      running,
      disk,
      stale,
      note: stale
        ? `代码已更新但**未重启**：运行中 ${running.id}，磁盘 ${disk.id} —— 重启服务后新修复才生效`
        : `已是最新代码（${running.id}）`,
    };
  }
}

/** 给人看的本地时间：10-25 01:31 */
export function fmtBuildTime(ms: number): string {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
