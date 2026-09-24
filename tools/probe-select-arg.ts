/**
 * 找出 `explorer.exe /select,<file>` 在**含空格路径**下的正确传参方式。
 *
 * 背景：`explorer.exe /select,"C:\...\2026-09-23 21-53-17-917 哈喽.flv"` 通过 Node 的
 * `spawn('explorer.exe', [arg])` 调用时，Node 会给含空格的参数自动加引号，
 * 而 explorer 对 `/select,` 的解析规则与常规命令行不同 —— 实测结果是
 * **打开了「文档」文件夹**（参数被当成了空/无效路径），而不是目标目录。
 *
 * 每个用例用一个**唯一命名的目录 + 文件**作为判据：窗口标题里出现随机串才算成功。
 * 这样不会被"本来就开着的窗口"或默认的「文档」干扰。
 *
 * 用法：node --experimental-strip-types tools/probe-select-arg.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const line = (s = ''): void => console.log(s);

function explorerWindows(): string[] {
  const ps = '$sh=New-Object -ComObject Shell.Application; @($sh.Windows()) | ForEach-Object { try { $_.LocationName } catch {} }';
  const b64 = Buffer.from(ps, 'utf16le').toString('base64');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { encoding: 'utf8' });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
function closeMatching(needle: string): void {
  const ps = `$sh=New-Object -ComObject Shell.Application; @($sh.Windows()) | Where-Object { try { $_.LocationName -like '*${needle}*' } catch { $false } } | ForEach-Object { try { $_.Quit() } catch {} }`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
}

/** 每个用例独立跑：建唯一目录 → 调用 → 看窗口 */
interface Case {
  name: string;
  run: (dir: string, file: string) => void;
  /** 期望窗口标题里出现什么：目录名（打开目录） */
  expectDir: boolean;
}

const cases: Case[] = [
  {
    name: '1) explorer.exe  [ "/select,<file>" ]            （当前实现）',
    run: (_d, f) => {
      spawnSync('explorer.exe', [`/select,${f}`], { stdio: 'ignore' });
    },
    expectDir: true,
  },
  {
    name: '2) explorer.exe  [ "/select,", "<file>" ]        （逗号与路径分成两个参数）',
    run: (_d, f) => {
      spawnSync('explorer.exe', ['/select,', f], { stdio: 'ignore' });
    },
    expectDir: true,
  },
  {
    name: '3) explorer.exe  [ "/select,\\"<file>\\"" ]      （自己带引号）',
    run: (_d, f) => {
      spawnSync('explorer.exe', [`/select,"${f}"`], { stdio: 'ignore' });
    },
    expectDir: true,
  },
  {
    name: '4) explorer.exe  [ "/select,<file>" ] 用 shell:true',
    run: (_d, f) => {
      spawnSync(`explorer.exe /select,"${f}"`, { stdio: 'ignore', shell: true });
    },
    expectDir: true,
  },
  {
    name: '5) cmd /c start "" explorer.exe "/select,<file>"',
    run: (_d, f) => {
      spawnSync('cmd.exe', ['/c', 'start', '', 'explorer.exe', `/select,${f}`], { stdio: 'ignore' });
    },
    expectDir: true,
  },
  {
    name: '6) 退路：explorer.exe [ "<dir>" ]（不选中，只打开目录）',
    run: (d) => {
      spawnSync('explorer.exe', [d], { stdio: 'ignore' });
    },
    expectDir: true,
  },
];

line('='.repeat(96));
line('探测 /select, 在含空格路径下的正确传参（判据：窗口标题出现唯一随机串）');
line('='.repeat(96));
line('');

const results: Array<{ name: string; hit: boolean }> = [];

for (const c of cases) {
  const tag = `dsh-sel-${Math.random().toString(36).slice(2, 10)}`;
  /* 目录名与文件名都带空格 —— 这正是真实场景（"2026-09-23 21-53-17-917 哈喽.flv"） */
  const dir = path.join(os.tmpdir(), `${tag} dir`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${tag} file.txt`);
  fs.writeFileSync(file, 'x');

  closeMatching(tag);
  await new Promise((r) => setTimeout(r, 800));
  const before = explorerWindows();

  line('─'.repeat(96));
  line(`  ${c.name}`);
  try {
    c.run(dir, file);
  } catch (e) {
    line(`     ✗ 抛错：${(e as Error).message.slice(0, 90)}`);
  }
  await new Promise((r) => setTimeout(r, 3200));

  const after = explorerWindows();
  const hit = after.some((w) => w.includes(tag));
  const appeared = after.filter((w) => !before.includes(w));
  results.push({ name: c.name, hit });
  line(`     ${hit ? '\x1b[32m✓ 出现了目标目录窗口\x1b[0m' : '\x1b[31m✗ 没有出现目标目录\x1b[0m'}`);
  if (appeared.length) line(`     新出现的窗口：${appeared.join(' | ')}`);

  closeMatching(tag);
  await new Promise((r) => setTimeout(r, 800));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  line('');
}

line('='.repeat(96));
line('汇总');
line('='.repeat(96));
for (const r of results) line(`  ${r.hit ? '\x1b[32m可用\x1b[0m' : '\x1b[31m无效\x1b[0m'}  ${r.name}`);
line('');
