/**
 * 关掉标题匹配给定串的资源管理器窗口（清理测试攒下的窗口，避免影响后续判定）。
 *
 * 为什么需要：`explorer.exe` **复用已有的同路径窗口**，不会每次都新建。
 * 所以"新窗口是否出现"这种判据在同路径重复测试时会失真 —— 需要先把旧窗口关掉。
 *
 * 用法：
 *   node --experimental-strip-types tools/close-explorer-windows.ts "文档"
 *   node --experimental-strip-types tools/close-explorer-windows.ts --list
 */
import { execFileSync } from 'node:child_process';

const arg = process.argv[2];
if (!arg) {
  console.error('用法：node --experimental-strip-types tools/close-explorer-windows.ts <标题匹配串> | --list');
  process.exit(1);
}

function ps(script: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
  });
}

if (arg === '--list') {
  const out = ps('$sh=New-Object -ComObject Shell.Application; @($sh.Windows()) | ForEach-Object { try { $_.LocationName } catch {} }');
  const wins = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  console.log(`当前 ${wins.length} 个资源管理器窗口：`);
  for (const w of wins) console.log(`  · ${w}`);
  process.exit(0);
}

/* 转义单引号，避免匹配串破坏 PowerShell 单引号字符串 */
const safe = arg.replace(/'/g, "''");
const script =
  `$sh=New-Object -ComObject Shell.Application; ` +
  `$targets = @($sh.Windows()) | Where-Object { try { $_.LocationName -like '*${safe}*' } catch { $false } }; ` +
  `$n = 0; foreach ($w in $targets) { try { $w.Quit(); $n++ } catch {} }; Write-Output $n`;
try {
  const n = ps(script).trim();
  console.log(`已关闭 ${n} 个标题匹配「${arg}」的资源管理器窗口`);
} catch (e) {
  console.error(`关闭失败：${(e as Error).message.slice(0, 120)}`);
  process.exit(1);
}
