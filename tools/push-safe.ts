/**
 * 往 GitHub 推送的**保险路径**：直连不通时自动换可达 IP 再推。
 *
 * ## 为什么需要它（2026-10-08 实测）
 * 这台机器上 `github.com` 被 DNS 解析到 `20.205.243.166`，而**那个 IP 的 443 是被挡的**：
 *   · `Test-NetConnection github.com -Port 443` → False
 *   · 但同名的其它 GitHub IP（140.82.112.3 / 140.82.113.3 / 20.27.177.113 …）TCP 是通的
 *   · 于是表现成"昨天还能推，今天突然 Failed to connect / Connection was reset"，
 *     重试多少次都一样 —— 因为问题不在重试次数，而在**连的是哪个 IP**。
 * 试出来的可用组合（本次）：`github.com:443 → 20.27.177.113` + `http.version=HTTP/1.1`。
 * IP 会轮换，所以这里每次现探现用，不写死。
 *
 * ## 用法
 *   node tools/push-safe.ts              # 先直连推；失败就探路，找到能用的入口再推
 *   node tools/push-safe.ts --check      # 只探路并打印结果（不推送）
 *   node tools/push-safe.ts --remote origin --branch main
 *
 * 只做两件事：`git ls-remote` 探路 + `git push`。不发别的东西、不改仓库配置
 * （`-c http.curloptResolve=…` 是**一次性**覆盖，不落盘）。
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const remote = args[args.indexOf('--remote') + 1] && args.includes('--remote') ? args[args.indexOf('--remote') + 1]! : 'origin';
const branch = args[args.indexOf('--branch') + 1] && args.includes('--branch') ? args[args.indexOf('--branch') + 1]! : 'main';

/** GitHub 常见的 HTTPS 入口 IP（顺序只是"先试哪个"，不保证一直有效） */
const CANDIDATE_IPS = ['20.27.177.113', '140.82.113.3', '140.82.114.3', '140.82.112.3', '140.82.121.3'];
const HTTP_VERSIONS = ['HTTP/1.1', 'HTTP/2'];

const run = (argv: string[], timeoutMs = 90_000): { ok: boolean; out: string; err: string } => {
  try {
    const out = execFileSync('git', argv, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out, err: '' };
  } catch (e) {
    const err = String((e as { stderr?: Buffer | string }).stderr ?? (e as Error).message);
    const out = String((e as { stdout?: Buffer | string }).stdout ?? '');
    return { ok: false, out, err };
  }
};

const lastLine = (s: string): string =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-1)[0] ?? '';

const url = ((): string => {
  const r = run(['remote', 'get-url', remote]);
  if (!r.ok) {
    console.error(`拿不到远端 ${remote} 的地址：${lastLine(r.err)}`);
    process.exit(1);
  }
  return r.out.trim();
})();
const host = ((): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'github.com';
  }
})();
console.log(`远端 ${remote} = ${url}（host ${host}）`);

/* ① 先直连试一次（能用就别折腾） */
const direct = run(['ls-remote', '--heads', url, branch], 45_000);
if (direct.ok) {
  console.log('✓ 直连可用');
  if (CHECK_ONLY) process.exit(0);
  const push = run(['push', remote, branch]);
  console.log(push.ok ? '✓ 已推送' : `✗ 推送失败：${lastLine(push.err)}`);
  process.exit(push.ok ? 0 : 1);
}
console.log(`✗ 直连不通：${lastLine(direct.err).slice(0, 120)}`);
console.log('  开始探路（可达 IP × HTTP 版本）…');

/* ② 逐个试（用 ls-remote 探，便宜且只读） */
let hit: { ip: string; ver: string } | undefined;
for (const ip of CANDIDATE_IPS) {
  for (const ver of HTTP_VERSIONS) {
    const probe = run(['-c', `http.curloptResolve=${host}:443:${ip}`, '-c', `http.version=${ver}`, 'ls-remote', '--heads', url, branch], 60_000);
    if (probe.ok) {
      const sha = probe.out.trim().split(/\s+/)[0] ?? '';
      console.log(`✓ 找到可用入口：${host} → ${ip}（${ver}），远端 ${branch} = ${sha.slice(0, 12)}`);
      hit = { ip, ver };
      break;
    }
    console.log(`  ✗ ${ip} · ${ver}：${lastLine(probe.err).slice(0, 90)}`);
  }
  if (hit) break;
}
if (!hit) {
  console.error('✗ 所有候选入口都不通 —— 这台机器现在直连 GitHub 是被挡的，需要代理/VPN 或换网络。');
  process.exit(1);
}
if (CHECK_ONLY) {
  console.log(`（--check 模式，未推送）要用它推送：git -c http.curloptResolve=${host}:443:${hit.ip} -c http.version=${hit.ver} push ${remote} ${branch}`);
  process.exit(0);
}

/* ③ 用找到的入口推。
 *
 * ⚠️ 推送失败时要打**完整**的远端输出：第一次用这个工具时只打了 stderr 的最后一行
 * （`error: failed to push some refs`），把真正的 `remote: Internal Server Error`
 * 和它的 Request ID 藏掉了 —— 那正是唯一有用的信息（GitHub 侧 500，不是我们的问题）。
 * 远端 500 是瞬时的，所以这里带重试。 */
const pushArgs = ['-c', `http.curloptResolve=${host}:443:${hit.ip}`, '-c', `http.version=${hit.ver}`, 'push', remote, branch];
let pushed = false;
for (let attempt = 1; attempt <= 3 && !pushed; attempt++) {
  const push = run(pushArgs, 300_000);
  const detail = `${push.out}\n${push.err}`.trim();
  if (push.ok) {
    console.log(detail);
    pushed = true;
    break;
  }
  console.error(`✗ 第 ${attempt} 次推送失败，远端原文：\n${detail.split(/\r?\n/).map((l) => `    ${l}`).join('\n')}`);
  const transient = /Internal Server Error|timed out|Connection was reset|Failed to connect|temporarily unavailable/i.test(detail);
  if (!transient || attempt === 3) {
    console.error(
      transient
        ? '✗ 三次都被远端/网络拒了 —— 稍后再试（GitHub 侧 500 通常几分钟就恢复；本地提交是安全的，不会丢）'
        : '✗ 不是瞬时错误（多半是非快进 / 权限），先 git fetch 看一眼分叉，别硬推',
    );
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, attempt * 15_000));
}
console.log('✓ 已推送（走的是一次性路由覆盖，没改仓库配置）');
