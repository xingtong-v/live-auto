/**
 * 在 biliLive-tools 的 asar 里找 `/bili` 路由组（`new Router({ prefix: "/bili" })`）
 * 以及其中 upload 相关的路由处理器，看请求体解构了哪些字段（是否含 aid）。
 *
 * 用法：node tools/find-blt-bili-router.ts
 */
import fs from 'node:fs';

const ASAR = 'C:\\Users\\demo\\Desktop\\新建文件夹 (2)\\biliLive-tools\\resources\\app.asar';
const text = fs.readFileSync(ASAR).toString('utf8');

/** 找所有 prefix:"/bili" 的 Router 声明 */
const routerRe = /new Router\(\{\s*prefix:\s*["'`]\/bili["'`]\s*\}\)/g;
const routers: number[] = [];
for (const m of text.matchAll(routerRe)) if (m.index !== undefined) routers.push(m.index);
console.log(`找到 ${routers.length} 个 prefix=/bili 的 Router\n`);

for (const idx of routers) {
  /* 从 Router 声明往后扫 60000 字符，列出其中注册的所有路由与处理器的入参解构 */
  const seg = text.slice(idx, idx + 60000);
  console.log('='.repeat(100));
  console.log(`Router @ ${idx}`);
  console.log('='.repeat(100));
  const routeRe = /router\$\d+\.(get|post|put|delete)\(\s*["'`]([^"'`]+)["'`]/g;
  const routes: string[] = [];
  for (const m of seg.matchAll(routeRe)) routes.push(`${m[1]!.toUpperCase()} ${m[2]}`);
  console.log('该 Router 下的路由：');
  for (const r of routes) console.log(`  ${r}`);

  /* 打印 upload 处理器本体（整段，直到下一个路由注册为止） */
  const upIdx = seg.indexOf('"/upload"');
  if (upIdx >= 0) {
    const rest = seg.slice(upIdx + 10);
    const nextRoute = rest.search(/router\$\d+\.(get|post|put|delete)\(/);
    const body = nextRoute > 0 ? rest.slice(0, nextRoute) : rest.slice(0, 6000);
    console.log('\n  ── /upload 处理器（完整）──');
    console.log(body.replace(/\r/g, ''));
    /* 额外列出处理器里出现的所有 data2.xxx 字段名 */
    const fields = [...new Set([...body.matchAll(/data2\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
    console.log(`\n  → 处理器读取的 data2 字段：${fields.join(', ')}`);
    console.log(`  → 是否含 aid 类字段：${fields.some((f) => /aid/i.test(f!)) ? '是' : '否'}`);
  } else {
    console.log('\n  （该 Router 里没找到 "/upload"）');
  }
  console.log('');
}

/** 全库找 `ctx.request.body` 解构里含 aid 的片段 */
console.log('='.repeat(100));
console.log('ctx.request.body 解构中含 aid 的位置');
console.log('='.repeat(100));
const re = /const\s*\{[^}]{0,200}\baid\b[^}]{0,200}\}\s*=\s*ctx\.request\.body/g;
let n = 0;
for (const m of text.matchAll(re)) {
  console.log(`  ${m[0].replace(/\s+/g, ' ').slice(0, 200)}`);
  if (++n >= 20) break;
}
if (n === 0) console.log('  （没有）');
