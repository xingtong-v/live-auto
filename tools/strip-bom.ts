/**
 * 一次性修复：剥掉文本文件开头的 UTF-8 BOM。
 *
 * 用 Node 读写成 Buffer，不经过任何 shell 的编码转换 ——
 * 这正是本项目踩过四次的坑，所以修复工具本身绝不能再用 PowerShell 做文本往返。
 *
 * 用法：node tools/strip-bom.ts [相对路径…]     不给参数则扫描全仓库（.ps1 例外，它需要 BOM）
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'logs', 'dist']);
const TEXT_EXT = /\.(ts|js|mjs|cjs|json|md|html|css|cmd|bat|txt|yml|yaml|ass|srt|example)$/i;

let fixed = 0;

function strip(p: string): boolean {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(p);
  } catch {
    return false;
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    fs.writeFileSync(p, buf.subarray(3));
    console.log(`  已剥掉 BOM: ${path.relative(ROOT_DIR, p)}`);
    fixed++;
    return true;
  }
  return false;
}

const args = process.argv.slice(2);
if (args.length > 0) {
  for (const a of args) strip(path.resolve(ROOT_DIR, a));
} else {
  const walk = (dir: string, depth = 0): void => {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      // .ps1 例外：PowerShell 脚本按项目约定**必须**带 BOM
      if (!TEXT_EXT.test(e.name) || path.extname(e.name).toLowerCase() === '.ps1') continue;
      strip(full);
    }
  };
  walk(ROOT_DIR);
}

console.log(fixed > 0 ? `\n共修复 ${fixed} 个文件。` : '\n没有需要修复的文件。');
