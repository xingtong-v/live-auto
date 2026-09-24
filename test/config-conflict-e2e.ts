/**
 * 配置乐观锁的 **端到端** 自测：真的起一个 UiServer，走真实 HTTP 与 CSRF。
 *
 * 单元测试（test/config-conflict.ts）验证的是 ConfigStore 一层；
 * 这里补齐「界面拿旧版本号 POST /api/config」这条真实链路，
 * 确认服务端真的回 409、真的不落盘，并确认版本号一致时能正常保存。
 *
 * 安全约定：
 *   - 用独立端口（3179）+ 独立 Orchestrator 实例，不碰正在运行的服务；
 *   - 全程 dryRun 且不启动轮询，不发任何付费请求、不触发下载；
 *   - 会临时改 config.json（这是唯一事实来源，无法绕开），
 *     因此先做字节级备份，结束时在 finally 里恢复并逐字节校验。
 *
 * 运行：node test/config-conflict-e2e.ts
 */
import fs from 'node:fs';
import http from 'node:http';
import { Orchestrator } from '../src/daemon.ts';
import { UiServer } from '../src/server.ts';
import { CONFIG_PATH } from '../src/util.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(detail ? `${name} :: ${detail}` : name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

interface Reply { status: number; json: Record<string, unknown> }

function request(
  port: number,
  method: string,
  p: string,
  opts: { csrf?: string; body?: unknown } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: p,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(opts.csrf ? { 'X-CSRF-Token': opts.csrf } : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try {
            json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          } catch {
            json = { raw: text };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const PORT = 3179;
const backup = fs.readFileSync(CONFIG_PATH); // 字节级备份，结束原样写回
let ui: UiServer | undefined;
let orch: Orchestrator | undefined;
let passFail = 0;

try {
  orch = new Orchestrator({ dryRun: true });
  ui = new UiServer({ orchestrator: orch, port: PORT, openBrowser: false });
  await ui.start();

  const boot = await request(PORT, 'GET', '/api/bootstrap');
  const csrf = String(boot.json['csrf'] ?? '');
  const v0 = String(boot.json['configVersion'] ?? '');

  section('1. bootstrap 下发配置版本号');
  ok('GET /api/bootstrap 返回 200', boot.status === 200, `status=${boot.status}`);
  ok('带上了 configVersion', v0.length === 16, `v0="${v0}"`);

  const before = fs.readFileSync(CONFIG_PATH);
  const beforeSelect = (JSON.parse(before.toString('utf8')) as { llm: { select: { model: string } } }).llm.select.model;

  section('2. 模拟「外部改了配置」后界面拿旧版本号保存');
  {
    // 外部改动：往配置里塞一个只有外部才知道的标记
    const disk = JSON.parse(before.toString('utf8')) as Record<string, unknown>;
    const cfgR = disk as { clip?: Record<string, unknown> };
    cfgR.clip = { ...(cfgR.clip ?? {}), maxCandidates: 7 };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(disk, null, 2), 'utf8');

    const r = await request(PORT, 'POST', '/api/config', {
      csrf,
      body: { patch: { clip: { maxCandidates: 13 } }, configVersion: v0 },
    });
    ok('返回 409 CONFIG_CONFLICT', r.status === 409 && r.json['code'] === 'CONFIG_CONFLICT', `status=${r.status} code=${String(r.json['code'])}`);
    ok('错误文案说明了「未写入任何内容」', /未写入任何内容/.test(String(r.json['error'] ?? '')), String(r.json['error'] ?? '').slice(0, 120));
    const conflict = r.json['conflict'] as { wouldOverwrite?: string[]; changedByOthers?: string[] } | undefined;
    ok('列出了界面会覆盖掉的字段', Array.isArray(conflict?.wouldOverwrite) && conflict!.wouldOverwrite!.some((p) => p.includes('maxCandidates')), JSON.stringify(conflict?.wouldOverwrite ?? []));
    ok('列出了外部改动的字段', Array.isArray(conflict?.changedByOthers) && conflict!.changedByOthers!.some((p) => p.includes('maxCandidates')), JSON.stringify(conflict?.changedByOthers ?? []));

    const afterReject = (JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as { clip: { maxCandidates: number } }).clip.maxCandidates;
    ok('磁盘未被写入（仍是外部的 7）', afterReject === 7, `实际=${afterReject}`);
  }

  section('3. 用最新版本号保存则正常通过');
  {
    const boot2 = await request(PORT, 'GET', '/api/bootstrap');
    const v1 = String(boot2.json['configVersion'] ?? '');
    ok('版本号已随外部改动变化', v1 !== v0 && v1.length === 16, `v0=${v0} v1=${v1}`);
    const r = await request(PORT, 'POST', '/api/config', {
      csrf,
      body: { patch: { clip: { maxCandidates: 13 } }, configVersion: v1 },
    });
    ok('返回 200', r.status === 200, `status=${r.status} ${String(r.json['error'] ?? '')}`);
    ok('回传了新的 configVersion', String(r.json['configVersion'] ?? '').length === 16, `v=${String(r.json['configVersion'] ?? '')}`);
    const onDisk = (JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as { clip: { maxCandidates: number } }).clip.maxCandidates;
    ok('写入已落盘', onDisk === 13, `实际=${onDisk}`);
    const selectNow = (JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as { llm: { select: { model: string } } }).llm.select.model;
    ok('未提交的 llm.select.model 保持原值（这才是事故的根因）', selectNow === beforeSelect, `原本="${beforeSelect}" 现在="${selectNow}"`);
  }

  section('4. 强制覆盖（界面给出 force: true）');
  {
    const r = await request(PORT, 'POST', '/api/config', {
      csrf,
      body: { patch: { clip: { maxCandidates: 5 } }, force: true, configVersion: 'deadbeefdeadbeef' },
    });
    ok('force 时忽略版本号并写入', r.status === 200, `status=${r.status}`);
    const onDisk = (JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as { clip: { maxCandidates: number } }).clip.maxCandidates;
    ok('强制写入的值已落盘', onDisk === 5, `实际=${onDisk}`);
  }

  section('5. 缺 configVersion 时向后兼容（旧页面 / 调试脚本）');
  {
    const r = await request(PORT, 'POST', '/api/config', { csrf, body: { patch: { clip: { maxCandidates: 11 } } } });
    ok('没有版本号也能保存', r.status === 200, `status=${r.status}`);
    const onDisk = (JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as { clip: { maxCandidates: number } }).clip.maxCandidates;
    ok('写入已落盘', onDisk === 11, `实际=${onDisk}`);
  }
} catch (e) {
  passFail = 1;
  console.log(`\n\x1b[31m测试自身异常：${(e as Error).message}\x1b[0m`);
} finally {
  try {
    await ui?.stop();
  } catch {
    /* 关闭失败不影响结论 */
  }
  // 逐字节恢复：配置是唯一事实来源，绝不能因为一次测试把它改坏
  try {
    fs.writeFileSync(CONFIG_PATH, backup);
    const restored = fs.readFileSync(CONFIG_PATH);
    const same = restored.equals(backup);
    console.log(
      same
        ? `\n  \x1b[32m✓\x1b[0m config.json 已逐字节恢复（${backup.length} 字节）`
        : `\n  \x1b[31m✗\x1b[0m config.json 恢复后与备份不一致！请检查`,
    );
    if (!same) {
      fail++;
      failures.push('config.json 未能逐字节恢复');
    }
  } catch (e) {
    fail++;
    failures.push(`config.json 恢复失败：${(e as Error).message}`);
    console.log(`  \x1b[31m✗\x1b[0m config.json 恢复失败：${(e as Error).message}`);
  }
}

console.log(`\n\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\x1b[31m失败项：\x1b[0m');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exitCode = fail === 0 && passFail === 0 ? 0 : 1;
