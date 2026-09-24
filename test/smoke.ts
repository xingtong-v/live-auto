/**
 * 冒烟测试：把真实模块组装成常驻服务跑一遍，验证「能被启动、能自检、能开 UI、能优雅退出」。
 *
 * 与 `test/e2e-offline.ts` 的分工：
 *   - e2e-offline 验证**业务链路**（触发 → 转写 → 分析 → 切片 → 投稿 → 幂等 → 清理），用 mock biliLive-tools。
 *   - smoke 验证**服务形态**（编排器构造、启动自检、健康快照、UI 服务端 + 安全校验、优雅停止），
 *     默认连真实 biliLive-tools（只读接口），因此也顺带验证了真实环境的连通性。
 *
 * 用法：
 *   node test/smoke.ts                 # 连真实的 biliLive-tools（只读，无费用）
 *   node test/smoke.ts --port 3111     # 指定 UI 端口
 *   node test/smoke.ts --json          # 只输出机器可读结果
 */
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Orchestrator } from '../src/daemon.ts';
import { UiServer } from '../src/server.ts';
import { Ledger } from '../src/ledger.ts';
import { ROOT_DIR, ensureDir, nowIso, writeJsonAtomic } from '../src/util.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
/** 需要人工处理的环境项（不是代码缺陷，但要显式列出） */
const envIssues: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    if (!JSON_ONLY) console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` :: ${detail}` : ''}`);
    if (!JSON_ONLY) console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` :: ${detail}` : ''}`);
  }
}

function section(t: string): void {
  if (JSON_ONLY) return;
  console.log(`\n\x1b[1m${t}\x1b[0m`);
  console.log('─'.repeat(Math.max(20, Math.min(74, t.length * 2 + 8))));
}

const JSON_ONLY = process.argv.includes('--json');
const portArg = process.argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 0;

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmpRoot = path.join(os.tmpdir(), `live_auto-smoke-${stamp}`);
  ensureDir(tmpRoot);

  // 用临时台账，避免污染真实 data/
  const smokeLedger = new Ledger({ path: path.join(tmpRoot, 'ledger.json') });
  const orch = new Orchestrator({ ledger: smokeLedger, dataDirOverride: tmpRoot });
  orch.logger.setConsole(false);

  /* ⚠️ 错误事件流也要隔离：`dataDirOverride` 管不到它（它是模块级常量）。
     不隔离的话，测试产生的错误会写进**真实**的 data/errors.jsonl，
     把健康面板的「近 24h 错误」冲成噪音 —— 实测 83 条里只有 9 条是真的。 */
  const { setErrorsPath, setErrorReportDir } = await import('../src/errors.ts');
  setErrorsPath(path.join(tmpRoot, 'errors.jsonl'));
  setErrorReportDir(path.join(tmpRoot, 'error-report'));

  const results: Record<string, unknown> = {};

  try {
    /* ---------------- 1. 配置与硬约束 ---------------- */
    section('1. 配置加载与硬约束校验');
    const cfg = orch.config;
    ok('配置文件已加载', Boolean(orch.store.path), orch.store.path);
    ok('UI 只监听回环地址（硬约束 #2）', ['127.0.0.1', 'localhost', '::1'].includes(cfg.ui.host), cfg.ui.host);
    ok('platform 为 Bilibili（陷阱 #1）', cfg.room.platform === 'Bilibili', cfg.room.platform);
    ok('dtime 首片余量 > 7200 秒（硬约束 #4）', cfg.publish.submitGapSec > 7200, String(cfg.publish.submitGapSec));
    ok('试跑期 is_only_self = 1（硬约束 #10）', cfg.publish.isOnlySelf === 1, String(cfg.publish.isOnlySelf));
    const errs = orch.store.errors;
    ok('配置无硬约束错误', errs.length === 0, errs.map((e) => `[${e.field}] ${e.message}`).join('；'));

    /* ---------------- 2. 启动自检（真实接口，只读） ---------------- */
    section('2. 启动自检（连真实 biliLive-tools，只读）');
    const checks = await orch.selfCheck();
    results.selfCheck = checks;
    for (const c of checks) {
      // 区分「环境问题」与「代码问题」：
      // 版本差异、未配合集、biliLive-tools 侧开关属于**需要人工处理的环境项**，
      // 自检正确报出来就是合格表现，不应让冒烟测试失败。
      const isEnvIssue =
        /版本|合集|上传后删除素材|磁盘|ffprobe|ASR 字幕识别模型|账号/.test(c.item);
      ok(`自检项「${c.item}」${isEnvIssue && !c.ok ? '（环境项，已正确报出）' : ''}`, c.ok || isEnvIssue, c.detail);
      if (!c.ok) {
        if (!JSON_ONLY) console.log(`      \x1b[33m→ ${c.fix ?? '见上文说明'}\x1b[0m`);
        envIssues.push(`${c.item}：${c.detail}`);
      }
    }
    ok('自检本身可完成（不抛异常）', checks.length > 0, `${checks.length} 项`);
    ok('自检覆盖了关键陷阱（≥8 项）', checks.length >= 8, `${checks.length} 项`);

    /* ---------------- 3. 健康快照 ---------------- */
    section('3. 健康快照');
    const health = await orch.health();
    results.health = health;
    ok('健康快照可生成', typeof health.version === 'string');
    ok('包含 biliLive-tools 连接状态', typeof health.bililive.ok === 'boolean', health.bililive.message);
    ok('包含账号有效期', health.account !== undefined, JSON.stringify(health.account));
    ok('包含磁盘信息', health.disk !== undefined, JSON.stringify(health.disk));
    /* dailyLimit === 0 是**合法配置**（用户显式关闭限额），不能断言它必须 > 0 ——
       否则一关额度全测就红（实测踩过：0/0 被判失败）。这里只校验字段存在且类型正确。 */
    ok(
      '包含今日投稿数与上限',
      typeof health.todayPublished === 'number' &&
        health.todayPublished >= 0 &&
        typeof health.dailyLimit === 'number' &&
        health.dailyLimit >= 0,
      `${health.todayPublished}/${health.dailyLimit}${health.dailyLimit === 0 ? '（不限额）' : ''}`,
    );
    ok('包含素材占用统计', health.storage.tasks >= 0, JSON.stringify({ rawGB: health.storage.rawGB, fullGB: health.storage.fullVideoGB }));
    ok('包含 prompt 指纹（缓存失效判断依据）', health.prompts.length === 4, health.prompts.map((p) => `${p.name}:${p.bytes}B`).join(' '));
    ok('健康快照里没有凭据字段', !JSON.stringify(health).includes(cfg.bililive.passKey), '健康快照泄露了 passKey');

    /* ---------------- 4. UI 服务端 ---------------- */
    section('4. Web UI 服务端（Origin / CSRF / Range / 路径遍历防护）');
    const ui = new UiServer({ orchestrator: orch, port: PORT, openBrowser: false });
    await ui.start();
    const base = ui.url;
    results.uiUrl = base;

    // 页面
    const page = await fetchWithTimeout(`${base}/`);
    const html = await page.text();
    ok('GET / 返回单页 UI', page.status === 200 && html.includes('<title>直播切片助手</title>'), `HTTP ${page.status}`);
    ok('页面注入了 CSRF token 与运行信息', html.includes('window.__BOOT__') && html.includes('csrf'), '未找到 __BOOT__ 注入');
    ok('页面不含未脱敏凭据', !html.includes(cfg.bililive.passKey), '页面泄露了 passKey');
    ok(
      '带安全响应头（防 iframe 嵌套 / MIME 嗅探）',
      page.headers.get('x-frame-options') === 'DENY' && page.headers.get('x-content-type-options') === 'nosniff',
      `x-frame-options=${page.headers.get('x-frame-options')}`,
    );

    // bootstrap
    const bootRes = await fetchWithTimeout(`${base}/api/bootstrap`);
    const boot = (await bootRes.json()) as { csrf: string; config: { bililive: { passKey: string } }; mode: { autoPublish: boolean } };
    ok('GET /api/bootstrap 可用', bootRes.status === 200 && typeof boot.csrf === 'string');
    ok('bootstrap 返回的配置里凭据已遮蔽', boot.config.bililive.passKey.includes('***'), boot.config.bililive.passKey);

    // 任务列表与排期
    const tasksRes = await fetchWithTimeout(`${base}/api/tasks`);
    const tasks = (await tasksRes.json()) as { tasks: unknown[]; monthly: { disclaimer: string } };
    ok('GET /api/tasks 可用', tasksRes.status === 200 && Array.isArray(tasks.tasks));
    ok('成本汇总标注了「估算值」口径', /估算/.test(tasks.monthly.disclaimer), tasks.monthly.disclaimer.slice(0, 60));

    const schedRes = await fetchWithTimeout(`${base}/api/schedule`);
    const sched = (await schedRes.json()) as { pending: unknown[]; published: unknown[]; retention: unknown[] };
    ok('GET /api/schedule 可用', schedRes.status === 200 && Array.isArray(sched.pending) && Array.isArray(sched.retention));

    // CSRF 防护：不带 token 的写操作必须被拒
    const noCsrf = await fetchWithTimeout(`${base}/api/check-now`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    ok('无 CSRF token 的写操作被拒绝（硬约束 #15）', noCsrf.status === 403, `HTTP ${noCsrf.status}`);

    // Origin 防护：非回环来源必须被拒
    const badOrigin = await fetchWithTimeout(`${base}/api/tasks`, { headers: { Origin: 'http://evil.example.com' } });
    ok('非回环 Origin 被拒绝（陷阱 #22）', badOrigin.status === 403, `HTTP ${badOrigin.status}`);

    // Host 头校验（防 DNS rebinding）。
    // ★ 必须用 node:http 手工发请求：fetch 是 forbidden header name 的实现，
    //   不允许覆盖 Host，用 fetch 测这一项会得到假阳性。
    const badHostStatus = await rawRequestStatus(base, '/api/tasks', 'evil.example.com');
    ok('非回环 Host 被拒绝（防 DNS rebinding）', badHostStatus === 403, `HTTP ${badHostStatus}`);

    // 带 token 的写操作应通过（check-now 会打真实只读接口）
    const withCsrf = await fetchWithTimeout(
      `${base}/api/check-now`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrf }, body: '{}' },
      30000,
    );
    ok('带 CSRF token 的写操作被接受', withCsrf.status === 200, `HTTP ${withCsrf.status}`);

    // 预览接口：路径遍历与类型白名单
    const traversal = await fetchWithTimeout(`${base}/api/preview/abc/..%2F..%2F..%2Fconfig.json`);
    ok('预览接口拒绝路径遍历（硬约束 #15）', traversal.status === 400 || traversal.status === 403, `HTTP ${traversal.status}`);
    const badType = await fetchWithTimeout(`${base}/api/preview/some-task/secret.exe`);
    ok('预览接口拒绝白名单外的类型', badType.status === 415 || badType.status === 404, `HTTP ${badType.status}`);
    const missing = await fetchWithTimeout(`${base}/api/preview/some-task/missing.json`);
    ok('预览接口对任务目录内的缺失文件返回 404（而不是 500）', missing.status === 404, `HTTP ${missing.status}`);

    // 404 与错误处理
    const unknown = await fetchWithTimeout(`${base}/api/nope`);
    ok('未知 API 返回 404 且带说明', unknown.status === 404, `HTTP ${unknown.status}`);

    // 自检按钮对应的端点
    const sc = await fetchWithTimeout(
      `${base}/api/selfcheck`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrf }, body: '{}' },
      60000,
    );
    ok('POST /api/selfcheck 可用', sc.status === 200, `HTTP ${sc.status}`);

    // 平台绑定校验：不能监听 0.0.0.0
    let refusedNonLoopback = false;
    try {
      const bad = new UiServer({ orchestrator: orch, host: '0.0.0.0', port: 0 });
      await bad.stop();
      void bad;
    } catch (e) {
      refusedNonLoopback = /回环地址/.test((e as Error).message);
    }
    ok('拒绝绑定非回环地址（硬约束 #2 有代码级防线）', refusedNonLoopback);

    await ui.stop();
    ok('UI 服务可优雅停止', true);

    /* ---------------- 5. 生命周期 ---------------- */
    section('5. 编排器生命周期');
    await orch.start({ polling: false }); // 不启动轮询，避免对真实接口做长期请求
    ok('orchestrator.start() 成功（不启用轮询）', true);
    const st = orch.trigger.stateSnapshot();
    ok('触发状态可读', typeof st.processedCount === 'number', JSON.stringify(st));
    // 触发状态文件应已落盘（重启后不重复触发的前提）
    const triggerStatePath = path.join(tmpRoot, 'trigger-state.json');
    ok('触发状态已落盘（重启后可续）', fs.existsSync(triggerStatePath), triggerStatePath);
    orch.stop();
    ok('orchestrator.stop() 优雅退出', true);
    // stop() 内部会 flush；台账文件应存在（内容可以只有 version/tasks 骨架）
    ok('停止后台账已落盘', fs.existsSync(path.join(tmpRoot, 'ledger.json')), path.join(tmpRoot, 'ledger.json'));

    /* ---------------- 6. 产物与版本信息 ---------------- */
    section('6. 交付物完整性');
    const required = [
      'README.md',
      'config.example.json',
      'package.json',
      'tsconfig.json',
      'start.bat',
      'start.ps1',
      '.gitignore',
      'public/ui.html',
      'prompts/chunk.md',
      'prompts/summary.md',
      'prompts/select.md',
      'prompts/retitle.md',
      'docs/api-observed.md',
      'src/cli.ts',
      'src/daemon.ts',
      'src/server.ts',
      'src/api.ts',
      'src/trigger.ts',
      'src/danmaku.ts',
      'src/media.ts',
      'src/asr.ts',
      'src/llm.ts',
      'src/analyze.ts',
      'src/publish.ts',
      'src/ledger.ts',
      'src/cleanup.ts',
      'src/errors.ts',
      'src/alert.ts',
      'src/probe.ts',
      'src/redact.ts',
      'src/logger.ts',
      'src/types.ts',
      'src/util.ts',
      'src/config.ts',
      'test/mock-server.ts',
      'test/e2e-offline.ts',
      'test/redact-selftest.ts',
    ];
    const missing2 = required.filter((f) => !fs.existsSync(path.join(ROOT_DIR, f)));
    ok(`交付物清单完整（${required.length} 项）`, missing2.length === 0, `缺失：${missing2.join(', ')}`);

    const fixtures = fs.existsSync(path.join(ROOT_DIR, 'test', 'fixtures')) ? fs.readdirSync(path.join(ROOT_DIR, 'test', 'fixtures')) : [];
    ok('存在 WP1 实测 fixture', fixtures.length >= 8, `${fixtures.length} 个：${fixtures.slice(0, 5).join(', ')}…`);

    // .gitignore 必须挡住凭据与运行期数据
    const gi = fs.readFileSync(path.join(ROOT_DIR, '.gitignore'), 'utf8');
    for (const pattern of ['config.json', 'data/', 'ledger.json', 'decisions.jsonl', 'errors.jsonl', 'performance.jsonl', 'error-report/', 'node_modules/']) {
      ok(`.gitignore 忽略 ${pattern}`, gi.includes(pattern));
    }

    /* ---------------- 7. 凭据泄露审计（源码级） ---------------- */
    section('7. 凭据泄露审计');
    const passKey = cfg.bililive.passKey;
    const scanned = scanSources(path.join(ROOT_DIR, 'src'), ['.ts']);
    const leakedInSrc = scanned.filter((s) => passKey && s.text.includes(passKey));
    ok('src/ 中不含真实 passKey', leakedInSrc.length === 0, leakedInSrc.map((s) => s.file).join(', '));

    const scannedOther = [
      ...scanSources(path.join(ROOT_DIR, 'docs'), ['.md']),
      ...scanSources(path.join(ROOT_DIR, 'prompts'), ['.md']),
      ...scanSources(path.join(ROOT_DIR, 'test'), ['.ts', '.json', '.xml']),
      ...scanSources(path.join(ROOT_DIR, 'public'), ['.html']),
    ];
    const leakedOther = scannedOther.filter((s) => passKey && s.text.includes(passKey));
    ok('docs/prompts/test/public 中不含真实 passKey', leakedOther.length === 0, leakedOther.map((s) => s.file).join(', '));

    const exampleText = fs.readFileSync(path.join(ROOT_DIR, 'config.example.json'), 'utf8');
    ok('config.example.json 不含真实凭据', !passKey || !exampleText.includes(passKey));
    ok('config.example.json 用占位文案提示填写', /在此填写/.test(exampleText), '示例配置缺少占位说明');

    // 不应存在「调用 /user/export」的代码（硬约束：它会输出含 cookie 的原始数据）
    const exportCalls = scanSources(path.join(ROOT_DIR, 'src'), ['.ts']).filter(
      (s) => /request\(\s*['"`]\/user\/export/.test(s.text) || /fetch\([^)]*\/user\/export/.test(s.text),
    );
    ok('src/ 中没有调用 /user/export', exportCalls.length === 0, exportCalls.map((s) => s.file).join(', '));

    results.pass = pass;
    results.fail = fail;
    results.failures = failures;
  } catch (e) {
    fail++;
    failures.push(`未捕获异常：${(e as Error).message}`);
    if (!JSON_ONLY) {
      console.error(`\n\x1b[31m冒烟测试抛出异常：\x1b[0m`);
      console.error((e as Error).stack);
    }
  } finally {
    try {
      orch.stop();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  if (JSON_ONLY) {
    console.log(JSON.stringify({ ...results, envIssues }, null, 2));
  } else {
    console.log(`\n\x1b[1m===== 冒烟测试结果：PASS=${pass} FAIL=${fail} =====\x1b[0m`);
    if (envIssues.length) {
      console.log(`\n\x1b[33m需要人工处理的环境项（${envIssues.length}）—— 自检已正确报出，不视为代码缺陷：\x1b[0m`);
      for (const e of envIssues) console.log(`  \x1b[33m· ${e}\x1b[0m`);
    }
    if (fail > 0) {
      console.log('\n失败项：');
      for (const f of failures) console.log(`  \x1b[31m· ${f}\x1b[0m`);
      process.exitCode = 1;
    } else {
      console.log('\n\x1b[32m服务形态与交付物完整性均通过。\x1b[0m');
    }
  }
  void nowIso;
  void writeJsonAtomic;
  void http;
}

/** 用 node:http 手工发请求，以便设置 fetch 不允许覆盖的 Host 头 */
function rawRequestStatus(base: string, pathname: string, host: string): Promise<number> {
  return new Promise((resolve) => {
    const u = new URL(base);
    const req = http.request(
      {
        host: u.hostname,
        port: Number(u.port),
        path: pathname,
        method: 'GET',
        headers: { Host: host },
        timeout: 6000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', () => resolve(0));
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
    req.end();
  });
}

/** 递归扫描指定目录下指定扩展名的文件内容 */
function scanSources(dir: string, exts: string[]): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'data' || e.name.startsWith('.')) continue;
        walk(full);
      } else if (exts.includes(path.extname(e.name).toLowerCase())) {
        try {
          out.push({ file: path.relative(ROOT_DIR, full).replace(/\\/g, '/'), text: fs.readFileSync(full, 'utf8') });
        } catch {
          /* 读不了就跳过 */
        }
      }
    }
  };
  walk(dir);
  return out;
}

main().catch((e) => {
  console.error('\x1b[31m冒烟测试脚本自身崩溃：\x1b[0m');
  console.error((e as Error).stack);
  process.exit(1);
});
