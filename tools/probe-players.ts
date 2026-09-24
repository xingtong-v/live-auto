/**
 * 探测本机有哪些**系统自带/常见**视频播放器可用，并逐个验证能否真的把窗口开到前台。
 *
 * 为什么需要探测：用户要求"用 win 系统自带的播放器前台播放"，
 * 但实测本机 `.mp4` 的默认关联是 **`QyClient_mp4`（奇游电竞加速器）** ——
 * 走"默认程序"打开会被这个非播放器接管，等于打不开。
 * 所以必须**绕过文件关联**，直接定位播放器可执行文件。
 *
 * 探测顺序（先系统自带，再常见第三方）：
 *   1. 电影和电视（`Microsoft.ZuneVideo` 的 UWP App）—— Win10/11 自带
 *   2. Windows Media Player（旧版 `wmplayer.exe`；Win11 可能是 UWP 版）
 *   3. 常见第三方（PotPlayer / VLC / mpv / MPC-HC）—— 如果装了也能用
 *
 * 每个候选都会真的打开一次测试文件，并用 GetForegroundWindow 判断**是否到了前台** ——
 * 沿用本项目已确立的纪律：不看"命令有没有报错"，只看"用户能不能看到"。
 *
 * 用法：node --experimental-strip-types tools/probe-players.ts <测试视频>
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const testFile = process.argv[2];
if (!testFile || !fs.existsSync(testFile)) {
  console.error('用法：node --experimental-strip-types tools/probe-players.ts <存在的视频文件>');
  process.exit(1);
}
const line = (s = ''): void => console.log(s);

function ps(script: string, capture = true): string {
  const r = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    cwd: process.env['TEMP'],
    ...(capture ? {} : { stdio: 'ignore' as const }),
  });
  return typeof r === 'string' ? r : '';
}

function foreground(): string {
  try {
    return ps(`Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
'@
$h=[W.U]::GetForegroundWindow(); $p=0; [void][W.U]::GetWindowThreadProcessId($h,[ref]$p)
(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName`).trim();
  } catch {
    return '(取不到)';
  }
}

/** 把最近启动、且有主窗口的媒体类进程提到前台（返回是否成功） */
const RAISE = `
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint flags, UIntPtr e);
'@
$names = @('Video.UI','Microsoft.Media.Player','wmplayer','vlc','mpv','PotPlayerMini64','PotPlayer','mpc-hc64','mpc-hc')
$cand = @()
foreach ($n in $names) {
  foreach ($p in @(Get-Process -Name $n -ErrorAction SilentlyContinue)) {
    if ($p.MainWindowHandle -ne 0) { $cand += [pscustomobject]@{ Name=$p.ProcessName; H=$p.MainWindowHandle; T=$p.StartTime } }
  }
}
$cand = @($cand | Sort-Object T -Descending)
if ($cand.Count -eq 0) { Write-Output 'NORAISE'; exit }
$top = [IntPtr]$cand[0].H
[void][W.U]::ShowWindow($top, 9)
[W.U]::keybd_event(0x12,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [W.U]::keybd_event(0x12,0,2,[UIntPtr]::Zero)
$fg=[W.U]::GetForegroundWindow(); $tid=0; [void][W.U]::GetWindowThreadProcessId($fg,[ref]$tid)
$my=[W.U]::GetCurrentThreadId(); $att=$false
if ($tid -ne $my) { $att=[W.U]::AttachThreadInput($my,[uint32]$tid,$true) }
$r=[W.U]::SetForegroundWindow($top)
if ($att) { [void][W.U]::AttachThreadInput($my,[uint32]$tid,$false) }
Write-Output ('RAISED=' + $cand[0].Name + ' ret=' + $r)
`;

const safeFile = testFile.replace(/'/g, "''");

interface Candidate {
  label: string;
  /** PowerShell 片段：打开该播放器并加载文件 */
  open: string;
  /** 打开后前台进程名的可能值（小写比较） */
  expect: string[];
}

const candidates: Candidate[] = [
  {
    label: '① 电影和电视（Microsoft.ZuneVideo，Win 自带）',
    /* UWP App 用 shell:AppsFolder + 传文件参数不可靠，所以用 explorer 的 shell 动词打开；
       但 shell 动词又走文件关联（被奇游占了）—— 所以 UWP 这条路改用 AppsFolder 显式启动，
       文件通过命令行参数传给 App（多数 UWP 播放器支持）。 */
    open: `Start-Process 'shell:AppsFolder\\Microsoft.ZuneVideo_8wekyb3d8bbwe!Microsoft.ZuneVideo' -ArgumentList '"${safeFile}"'`,
    expect: ['video.ui', 'microsoft.zunevideo'],
  },
  {
    label: '② Windows Media Player（wmplayer.exe）',
    open: `Start-Process 'wmplayer.exe' -ArgumentList '"${safeFile}"'`,
    expect: ['wmplayer'],
  },
  {
    label: '③ Windows Media Player（UWP 版 shell:AppsFolder）',
    open: `Start-Process 'shell:AppsFolder\\Microsoft.Media.Player_8wekyb3d8bbwe!Microsoft.Media.Player' -ArgumentList '"${safeFile}"'`,
    expect: ['microsoft.media.player', 'video.ui'],
  },
  {
    label: '④ PotPlayer（若已安装）',
    open: `Start-Process 'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe' -ArgumentList '"${safeFile}"'`,
    expect: ['potplayermini64', 'potplayer'],
  },
  {
    label: '⑤ VLC（若已安装）',
    open: `Start-Process 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe' -ArgumentList '"${safeFile}"'`,
    expect: ['vlc'],
  },
];

line('='.repeat(94));
line('播放器可用性探测（每个都真的打开一次，用"前台进程"作判据）');
line('='.repeat(94));
line(`  测试文件：${testFile}`);
line(`  初始前台：${foreground()}`);
line('');
line('  本机 .mp4 关联（用于说明"为什么不能走默认程序"）：');
try {
  const a = ps(`$p=''; try { $p=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExtCom\\.mp4\\UserChoice' -ErrorAction Stop).ProgId } catch {}; Write-Output $p`);
  line(`     UserChoice ProgId = ${a.trim() || '(无)'}`);
} catch {
  /* ignore */
}
line('');

const usable: string[] = [];
for (const c of candidates) {
  line('─'.repeat(94));
  line(`  ${c.label}`);
  let sent = false;
  try {
    ps(c.open, false);
    sent = true;
  } catch (e) {
    line(`     ✗ 启动命令失败：${(e as Error).message.slice(0, 100)}`);
  }
  if (sent) {
    await new Promise((r) => setTimeout(r, 5000));
    let fg = foreground();
    if (!c.expect.includes(fg.toLowerCase())) {
      /* 试一次把它提上来 */
      try {
        const raised = ps(RAISE).trim();
        if (raised && !raised.startsWith('NORAISE')) line(`     提前台：${raised}`);
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 1800));
      fg = foreground();
    }
    const hit = c.expect.includes(fg.toLowerCase());
    line(`     ${hit ? '\x1b[32m✓ 成功（前台 = ' + fg + '）\x1b[0m' : '\x1b[31m✗ 未成功（前台 = ' + fg + '）\x1b[0m'}`);
    if (hit) {
      usable.push(c.label);
      /* 关掉它，避免影响下一个候选（用进程名结束，只关本次打开的那个） */
      try {
        ps(`foreach ($n in @('Video.UI','Microsoft.Media.Player','wmplayer','vlc','mpv','PotPlayerMini64','PotPlayer','mpc-hc64','mpc-hc')) { Get-Process -Name $n -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Stop-Process -Force -ErrorAction SilentlyContinue }`, false);
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  line('');
}

line('='.repeat(94));
line('结论');
line('='.repeat(94));
if (usable.length === 0) {
  line('  ⚠ 没有一个候选成功。需要考虑：');
  line('    · 用 explorer 的 "play" shell 动词（但它也走文件关联，可能同样被奇游接管）；');
  line('    · 或者回到"在界面内联播放"的方案（已实现，见 §12.8）。');
} else {
  line(`  ⇒ 可用（按推荐顺序）：`);
  for (const u of usable) line(`     · ${u}`);
}
line('');
