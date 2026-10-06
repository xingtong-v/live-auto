/**
 * 「切片助手为什么在反复重启」的回归套件（无网络、不改动服务状态）。
 *
 * 实测结论（2026-10-06 23:34，逐秒观测）：**服务并没有在重启** ——
 * 计划任务每 10 分钟跑一次 launcher.ps1，而 launcher.ps1 是**给人双击的交互式启动器**：
 *   · 它创建可见控制台窗口 ⇒ 每 10 分钟在屏幕上闪一个窗口（用户看到的"反复重启"）；
 *   · 它只用 3 秒 HTTP 探活判断"服务在不在" ⇒ 服务忙时误判 → 起第二个实例（撞端口）
 *     → 收尾时按命令行特征把项目目录下的 node.exe 全杀掉 ⇒ **把健康的服务杀掉**；
 *   · 它启动服务后常驻前台持有 ⇒ 关掉窗口＝服务停掉，下一跳又开一个窗口。
 *
 * 修法：计划任务改跑 tools\ensure-service.ps1（隐藏窗口、只拉起、**从不杀进程**），
 * 交互式启动器留给人用。本套件把这些约束钉住：
 *   ① 守护脚本必须"端口在监听就什么都不做"，且**可执行代码里没有杀进程动作**；
 *   ② 计划任务的动作必须是守护脚本 + -WindowStyle Hidden；
 *   ③ launcher.ps1 的收尾清理**只能收自己的子进程**（不许按命令行特征扫全机）；
 *   ④ 实跑一次守护脚本：服务在跑时必须 0 退出、不改 pid、不新增 node 进程、不写日志。
 *
 * 用法：node test/service-watchdog.ts           （只做非破坏性检查）
 *       node test/service-watchdog.ts --live-restart   （额外做一次"杀掉服务→看门狗拉回"的实跑）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../src/util.ts';

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
function eq<T>(name: string, actual: T, expected: T): void {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function section(t: string): void {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

const LIVE_RESTART = process.argv.includes('--live-restart');
const TASK_NAME = '直播切片助手（live_auto）';
const watchdogPath = path.join(ROOT_DIR, 'tools', 'ensure-service.ps1');
const autostartPath = path.join(ROOT_DIR, 'tools', 'autostart.ps1');
const launcherPath = path.join(ROOT_DIR, 'launcher.ps1');
const PORT = 3000;

/** 去掉注释（行注释 + <# 块注释 #>），只看**会执行**的代码（注释里提到 Stop-Process 不算数） */
function executableLines(text: string): string {
  const noBlock = text.replace(/<#[\s\S]*?#>/g, '');
  return noBlock
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('#');
    })
    .join('\n');
}

console.log('\x1b[1m切片助手「反复重启」的根因回归\x1b[0m（静态约束 + 非破坏性实跑）');
console.log('─'.repeat(74));

/* ========================================================================== */
section('① 服务守护脚本：只拉起，绝不杀');
{
  ok('存在 tools\\ensure-service.ps1', fs.existsSync(watchdogPath));
  const txt = fs.readFileSync(watchdogPath, 'utf8');
  const code = executableLines(txt);
  ok('★ 可执行代码里没有 Stop-Process（注释里提到不算）', !/Stop-Process/.test(code), (code.match(/.*Stop-Process.*/) ?? [''])[0].trim());
  ok('★ 可执行代码里没有 taskkill', !/taskkill/i.test(code));
  ok('用 -WindowStyle Hidden 启动服务（否则又是"屏幕上闪窗口"）', /-WindowStyle\s+Hidden/.test(txt));
  ok('先检查端口是否在监听（端口被占就绝不起第二个实例）', /function Test-PortListening/.test(txt) && /if \(\$listening\) \{/.test(txt));
  ok('★ 端口在监听但探活失败时也不动手（判为"在跑但繁忙"）', /判定为「服务在跑但繁忙」/.test(txt));
  ok('只有真的启动了服务才写日志（平时静默，不刷屏）', /只有真的启动了服务才写一行日志/.test(txt));
  ok('等等就绪时有上限（不会永远挂着）', /\$WaitSec/.test(txt) && /仍\s*未就绪/.test(txt));
}

/* ========================================================================== */
section('② 所有 .ps1 必须是 UTF-8 带 BOM（否则 PS 5.1 按 ANSI 解码 → 中文乱码+解析失败）');
{
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'data' || e.name.startsWith('.venv')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ps1')) files.push(p);
    }
  };
  walk(ROOT_DIR);
  ok('找到 .ps1 文件', files.length >= 3, `${files.length} 个`);
  const bad: string[] = [];
  for (const f of files) {
    const b = fs.readFileSync(f);
    if (!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)) bad.push(path.relative(ROOT_DIR, f));
  }
  eq(`★ 每个 .ps1 都带 UTF-8 BOM（共 ${files.length} 个）`, bad, []);
  /* 反过来也钉一条：带 BOM 的脚本必须能被 PS 解析（写坏一个引号就会整脚本失败） */
  const parseErrors: Record<string, string> = {};
  for (const f of files.slice(0, 6)) {
    const r = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${f.replace(/'/g, "''")}',[ref]$null,[ref]$e); if($e -and $e.Count){ $e | ForEach-Object { $_.Message } }`,
      ],
      { encoding: 'utf8' },
    );
    const out = String(r.stdout ?? '').trim();
    if (out) parseErrors[path.relative(ROOT_DIR, f)] = out.slice(0, 120);
  }
  eq('★ 抽检的脚本语法都能通过 PS 解析', parseErrors, {});
}

/* ========================================================================== */
section('③ 计划任务的动作：无窗口的守护脚本（不是可见窗口的 launcher.ps1）');
{
  const xml = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Export-ScheduledTask -TaskName '${TASK_NAME}'`], {
    encoding: 'utf8',
  });
  ok('任务已注册', xml.includes('<Task'), xml.slice(0, 80));
  ok('★ 动作是 tools\\ensure-service.ps1', /ensure-service\.ps1/.test(xml), (xml.match(/<Arguments>.*?<\/Arguments>/) ?? [''])[0].slice(0, 200));
  ok('★ 动作带 -WindowStyle Hidden（用户看不到窗口闪）', /-WindowStyle Hidden/.test(xml));
  ok('动作带 -NonInteractive', /-NonInteractive/.test(xml));
  ok('动作**不再**直接跑 launcher.ps1', !/launcher\.ps1/.test(xml), (xml.match(/<Arguments>.*?<\/Arguments>/) ?? [''])[0].slice(0, 200));
  ok('看门狗仍然是每 10 分钟一跳', /<Interval>PT10M<\/Interval>/.test(xml));
  ok('只允许一个实例（IgnoreNew，避免并发撞端口）', /MultipleInstancesPolicy>IgnoreNew</.test(xml));
}

/* ========================================================================== */
section('④ 交互式 launcher.ps1：收尾只收自己的子进程（不许扫全机 node）');
{
  const lc = fs.readFileSync(launcherPath, 'utf8');
  const lcCode = executableLines(lc);
  ok('有 Test-Port（端口在监听也算"已在运行"，避免探活超时误判）', /function Test-Port/.test(lc));
  ok('★ 第 0 步把"端口被占但探活失败"判为在运行', /服务在跑但繁忙/.test(lc));
  ok('★ 清理动作按 ParentProcessId 限定为"自己的子进程"', /ParentProcessId -eq \$PID/.test(lcCode));
  ok('★ 不再有"扫全机 node 命令行含项目目录"的兜底清理', !/CommandLine[^\n]*\$ROOT/.test(lcCode), (lcCode.match(/.*CommandLine.*\$ROOT.*/) ?? [''])[0].trim());
  ok('"已在运行"时窗口自动关闭（不再停在按任意键 → 用户以为卡住）', /本窗口 8 秒后自动关闭/.test(lc));
  ok('launcher 里仍有"关闭窗口即停服务"的说明（这是给人用的设计）', /关闭本窗口不会停止已在运行的服务/.test(lc));
}

/* ========================================================================== */
section('⑤ 自启安装器：默认装无窗口看门狗，-VisibleLauncher 才回到可见窗口');
{
  const ac = fs.readFileSync(autostartPath, 'utf8');
  ok('新增 -VisibleLauncher 开关', /\$VisibleLauncher/.test(ac));
  ok(
    '★ 默认动作字符串指向守护脚本（-File "{0}" -Port {1} 里的 $watchdog）+ -WindowStyle Hidden',
    /-NonInteractive -WindowStyle Hidden/.test(ac) && /-f \$watchdog, \$port/.test(ac) && /\$watchdog = Join-Path \$ROOT 'tools\\ensure-service\.ps1'/.test(ac),
    (ac.match(/.*\$argLine = .*ensure.*/) ?? ac.match(/.*-f \$watchdog.*/) ?? [''])[0].trim(),
  );
  ok('可见窗口的老行为被显式标注为可选', /想要老的"看得见窗口"的行为：加 -VisibleLauncher/.test(ac));
  ok('状态输出会提示"任务动作是哪个脚本"', /任务动作/.test(ac) && /无窗口、只拉起、绝不杀进程/.test(ac));
}

/* ========================================================================== */
section('⑥ 非破坏性实跑：服务在跑时，守护脚本必须什么都不做');
{
  const probe = async (): Promise<{ up: boolean; pid?: number }> => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/bootstrap`);
      if (r.status !== 200) return { up: false };
    } catch {
      return { up: false };
    }
    const out = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*src\\cli.ts*' } | Select-Object -First 1).ProcessId`],
      { encoding: 'utf8' },
    );
    const pid = Number(String(out.stdout ?? '').trim());
    return { up: true, ...(Number.isFinite(pid) && pid > 0 ? { pid } : {}) };
  };

  const before = await probe();
  const logPath = path.join(ROOT_DIR, 'data', 'logs', 'watchdog.log');
  const logBefore = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';

  if (!before.up) {
    /* 服务不在运行时**不跑**守护脚本：它会（正确地）把服务拉起来，
       那是"改动生产状态"，不该由测试触发。这里显式说明，不静默跳过。 */
    console.log('  \x1b[33m· 服务当前不在运行 —— 跳过实跑（避免测试把服务拉起来）；静态约束仍然有效\x1b[0m');
  } else {
    const sw = Date.now();
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-NoLogo', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', watchdogPath, '-Port', String(PORT)],
      { encoding: 'utf8', timeout: 60000 },
    );
    const ms = Date.now() - sw;
    eq('守护脚本退出码 0', r.status, 0);
    ok(`跑得很快（${ms}ms：端口在监听 ⇒ 探活一次就返回）`, ms < 15000, `${ms}ms`);

    const after = await probe();
    ok('服务仍然在跑', after.up);
    eq('★ 服务 pid 没变（没有重启）', after.pid, before.pid);
    const logAfter = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    eq('★ 没有往 watchdog.log 写任何东西（静默通过）', logAfter.length, logBefore.length);
  }
}

/* ========================================================================== */
section('⑦ 可选的破坏性实跑（--live-restart：杀服务 → 看门狗拉回 → 确认存活）');
if (!LIVE_RESTART) {
  console.log('  \x1b[33m· 未加 --live-restart，跳过（这一步会短暂停掉服务，默认不跑）\x1b[0m');
} else {
  const api = async (p: string): Promise<Response> => fetch(`http://127.0.0.1:${PORT}${p}`);
  let queueBusy = true;
  try {
    const m = (await (await api('/api/monitor')).json()) as { queue?: { busy?: boolean; length?: number }; pipeline?: { status?: string } };
    queueBusy = Boolean(m.queue?.busy) || Number(m.queue?.length ?? 0) > 0 || Boolean(m.pipeline?.status);
  } catch {
    queueBusy = false;
  }
  if (queueBusy) {
    console.log('  \x1b[33m· 队列正在跑任务（本地 ASR 被打断会白烧 GPU）—— 拒绝在这一步杀服务\x1b[0m');
  } else {
    const pidOf = (): number => {
      const out = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*src\\cli.ts*' } | Select-Object -First 1).ProcessId`],
        { encoding: 'utf8' },
      );
      return Number(String(out.stdout ?? '').trim());
    };
    const oldPid = pidOf();
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${oldPid} -Force`], { encoding: 'utf8' });
    await new Promise((r) => setTimeout(r, 2000));
    const down = await api('/api/bootstrap').then(() => false).catch(() => true);
    ok('服务确实被停掉了', down);

    const logBefore = fs.existsSync(path.join(ROOT_DIR, 'data', 'logs', 'watchdog.log'))
      ? fs.readFileSync(path.join(ROOT_DIR, 'data', 'logs', 'watchdog.log'), 'utf8')
      : '';
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Start-ScheduledTask -TaskName '${TASK_NAME}'`], { encoding: 'utf8' });

    let up = false;
    for (let i = 0; i < 60; i++) {
      up = await api('/api/bootstrap').then((r) => r.status === 200).catch(() => false);
      if (up) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    ok('★ 看门狗把服务拉回来了', up);
    const newPid = pidOf();
    ok(`新服务 pid=${newPid}（旧 pid=${oldPid}）`, newPid > 0 && newPid !== oldPid);
    /* 关键：任务动作已经结束，服务必须还活着（证明隐藏 Start-Process 起的进程不会被连带收掉） */
    await new Promise((r) => setTimeout(r, 30000));
    ok('★ 任务结束后 30 秒服务仍然活着（不是"任务一结束就被收掉"）', await api('/api/bootstrap').then((r) => r.status === 200).catch(() => false));
    const logAfter = fs.existsSync(path.join(ROOT_DIR, 'data', 'logs', 'watchdog.log'))
      ? fs.readFileSync(path.join(ROOT_DIR, 'data', 'logs', 'watchdog.log'), 'utf8')
      : '';
    ok('watchdog.log 记了一行"服务不在运行 → 已启动"', logAfter.length > logBefore.length && /服务不在运行/.test(logAfter.slice(logBefore.length)));
  }
}

console.log(`\n\x1b[1m结果：PASS=${pass} FAIL=${fail}\x1b[0m`);
if (failures.length) {
  console.log('\x1b[31m失败项：\x1b[0m');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exitCode = fail === 0 ? 0 : 1;
