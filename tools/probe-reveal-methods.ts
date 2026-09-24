/**
 * 客观判定：哪种"打开文件管理器"的方法**真的**能把目标目录显示出来。
 *
 * 为什么不能靠"命令没报错"来判断：实测 `Start-Process -LiteralPath <dir>` 返回成功、
 * 不抛错，但**一个窗口都没打开** —— 这正是用户"点了没跳转"的根因。
 * （`-LiteralPath` 根本就不是 `Start-Process` 的参数，它属于 `Get-Item` 这类 cmdlet。）
 *
 * 判据设计：每次创建一个**唯一命名**的临时目录（名字里带随机串），
 * 然后执行待测方法，最后枚举资源管理器窗口标题里**是否出现了那个随机串**。
 * 随机串只可能来自本次操作 —— 因此这个判据不会被"本来就开着的窗口"干扰。
 *
 * 用法：node --experimental-strip-types tools/probe-reveal-methods.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const line = (s = ''): void => console.log(s);

/** 枚举资源管理器窗口的 LocationName（用 -EncodedCommand 传 PowerShell，避免引号/`$` 被 shell 吃掉） */
function explorerWindows(): string[] {
  const ps = '$sh=New-Object -ComObject Shell.Application; @($sh.Windows()) | ForEach-Object { try { $_.LocationName } catch {} }';
  const b64 = Buffer.from(ps, 'utf16le').toString('base64');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { encoding: 'utf8' });
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

interface Case {
  name: string;
  /** 返回值仅作记录；判据以窗口为准 */
  run: (dir: string, file: string) => string;
}

const cases: Case[] = [
  {
    name: 'A) powershell Start-Process -FilePath <dir>',
    run: (dir) => {
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process', '-FilePath', dir], { stdio: 'ignore' });
      return 'Start-Process -FilePath';
    },
  },
  {
    name: 'B) powershell Start-Process -LiteralPath <dir>（当前实现用的）',
    run: (dir) => {
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process', '-LiteralPath', dir], { stdio: 'ignore' });
      return 'Start-Process -LiteralPath';
    },
  },
  {
    name: 'C) cmd /c start "" <dir>',
    run: (dir) => {
      spawnSync('cmd.exe', ['/c', 'start', '', dir], { stdio: 'ignore' });
      return 'cmd /c start';
    },
  },
  {
    name: 'D) explorer.exe <dir>（直接进程调用）',
    run: (dir) => {
      spawnSync('explorer.exe', [dir], { stdio: 'ignore' });
      return 'explorer.exe <dir>';
    },
  },
  {
    name: 'E) explorer.exe /select,<file>',
    run: (_dir, file) => {
      spawnSync('explorer.exe', [`/select,${file}`], { stdio: 'ignore' });
      return 'explorer.exe /select,';
    },
  },
  {
    name: 'F) cmd /c start "" explorer.exe /select,<file>',
    run: (_dir, file) => {
      spawnSync('cmd.exe', ['/c', 'start', '', 'explorer.exe', `/select,${file}`], { stdio: 'ignore' });
      return 'cmd /c start explorer /select';
    },
  },
];

line('='.repeat(94));
line('探测「打开文件管理器」各方法的真实效果');
line('='.repeat(94));
line(`  已有窗口（基线）：${explorerWindows().join(' | ') || '(无)'}`);
line('');

const results: Array<{ name: string; opened: boolean; note: string }> = [];

for (const c of cases) {
  /* 唯一目录：名字里带随机串，窗口标题命中它才说明"这个目录真的被打开了" */
  const tag = `dsh-reveal-${Math.random().toString(36).slice(2, 10)}`;
  const dir = path.join(os.tmpdir(), tag);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sample.txt');
  fs.writeFileSync(file, 'x');

  line('─'.repeat(94));
  line(`  ${c.name}`);
  line(`     目标目录：${dir}`);
  let how = '';
  try {
    how = c.run(dir, file);
  } catch (e) {
    line(`     ✗ 调用抛错：${(e as Error).message.slice(0, 90)}`);
  }
  line(`     执行：${how}`);

  /* 给资源管理器时间把窗口建出来 */
  await new Promise((r) => setTimeout(r, 3000));

  const wins = explorerWindows();
  /* 判据：窗口标题里出现随机串（LocationName 是不含盘符的目录名）或完整路径 */
  const hit = wins.some((w) => w.includes(tag));
  results.push({ name: c.name, opened: hit, note: hit ? '窗口已出现' : '没有对应窗口' });
  line(`     ${hit ? '\x1b[32m✓ 目录窗口已出现\x1b[0m' : '\x1b[31m✗ 没有出现该目录的窗口\x1b[0m'}   当前窗口：${wins.join(' | ') || '(无)'}`);

  /* 清掉刚才开的窗口，避免影响下一个用例的判据 */
  if (hit) {
    const ps = `$sh=New-Object -ComObject Shell.Application; @($sh.Windows()) | Where-Object { try { $_.LocationName -like '*${tag}*' } catch { $false } } | ForEach-Object { try { $_.Quit() } catch {} }`;
    const b64 = Buffer.from(ps, 'utf16le').toString('base64');
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 800));
  line('');
}

line('='.repeat(94));
line('汇总');
line('='.repeat(94));
for (const r of results) {
  line(`  ${r.opened ? '\x1b[32m可用\x1b[0m' : '\x1b[31m无效\x1b[0m'}  ${r.name}`);
}
line('');
const usable = results.filter((r) => r.opened);
if (usable.length === 0) {
  line('  ⚠ 没有任何方法生效 —— 需要换思路（例如直接用 Shell COM 的 Explore/Select）。');
} else {
  line(`  ⇒ 采用其中最简单可靠的：${usable[0]!.name}`);
}
line('');
