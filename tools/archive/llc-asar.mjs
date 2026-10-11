/**
 * 从 biliLive-tools 的 app.asar 里按路径关键字导出源文件，用于**读源码**回答行为问题。
 *
 * 为什么需要它：用户问「biliLive-tools 分 4 段录播 + 切片助手，能不能是同一个稿件」。
 * 这类问题只能看它自己的上传实现（是否带 vid 走 editMedia、分段录制如何生成 record），
 * 靠猜或者靠文档都不算证据。
 *
 * 只读：导出到 data/llc-asar-out/，从不修改 biliLive-tools 的安装目录（硬约束：不改基建）。
 *
 * 用法：
 *   node tools/llc-asar.mjs list <关键字>          列出匹配的 asar 内部路径
 *   node tools/llc-asar.mjs dump <关键字> [输出目录]  导出匹配文件
 */
import fs from 'node:fs';
import path from 'node:path';

const ASAR = process.env['LLC_ASAR'] ?? 'C:\\Users\\demo\\Desktop\\新建文件夹 (2)\\biliLive-tools\\resources\\app.asar';

/** 极简 asar 解析：8 字节头（4 pickled size + 4 header size）+ JSON 目录树 + 依次排列的文件体 */
function readAsarIndex(buf) {
  const headerSize = buf.readUInt32LE(12);
  const json = buf.subarray(16, 16 + headerSize).toString('utf8');
  return { headerSize, index: JSON.parse(json) };
}

function walk(node, prefix, out) {
  for (const [name, v] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (v.files) walk(v, p, out);
    else out.push({ path: p, offset: Number(v.offset), size: v.size });
  }
  return out;
}

const [, , cmd, keyword, outDirArg] = process.argv;
if (!cmd || !keyword) {
  console.error('用法：node tools/llc-asar.mjs list|dump <关键字> [输出目录]');
  process.exit(2);
}
if (!fs.existsSync(ASAR)) {
  console.error(`找不到 asar：${ASAR}（可用环境变量 LLC_ASAR 覆盖）`);
  process.exit(1);
}

const buf = fs.readFileSync(ASAR);
const { headerSize, index } = readAsarIndex(buf);
const entries = walk(index, '', []);
const bodyStart = 16 + headerSize;
const re = new RegExp(keyword, 'i');
const hits = entries.filter((e) => re.test(e.path) && !/\.(png|jpg|jpeg|webp|ico|ttf|woff2?|map|node)$/i.test(e.path));

if (cmd === 'list') {
  console.log(`asar 内共 ${entries.length} 个文件，匹配 /${keyword}/i 的有 ${hits.length} 个：`);
  for (const h of hits.slice(0, 200)) console.log(`  ${h.path}  (${h.size} 字节)`);
  if (hits.length > 200) console.log(`  …另有 ${hits.length - 200} 个`);
} else if (cmd === 'dump') {
  const outDir = path.resolve(outDirArg ?? 'data/llc-asar-out');
  fs.mkdirSync(outDir, { recursive: true });
  let n = 0;
  for (const h of hits) {
    const dest = path.join(outDir, h.path.replace(/[\\/]/g, '__'));
    fs.writeFileSync(dest, buf.subarray(bodyStart + h.offset, bodyStart + h.offset + h.size));
    n++;
  }
  console.log(`已导出 ${n} 个文件到 ${outDir}`);
  for (const h of hits.slice(0, 200)) console.log(`  ${h.path}`);
} else {
  console.error(`未知命令：${cmd}`);
  process.exit(2);
}
