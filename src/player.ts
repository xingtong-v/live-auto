/**
 * 用**系统自带播放器**打开一个视频文件，并把它提到前台。
 *
 * 需求（用户第 4 轮，也是最简直接的一条）：
 *   "当我点击试看的时候 定位切片的产物目录 选择这个文件 然后用 win 系统自带的播放器前台播放给我看"
 *   ⇒ 不转码、不生成预览片段、不弹资源管理器，直接用系统播放器看。
 *
 * 本机实测到的三个障碍（都不是猜的，见 tools/probe-players.ts / verify-system-player.ts）：
 *   ① `.mp4` **没有有效的默认关联** —— `UserChoice` 为空，注册表里挂着一个坏的
 *      `QyClient_mp4`（奇游加速器）。所以 `Start-Process <file>`（走默认程序）
 *      会弹出**「打开方式」对话框**（前台进程名就叫 `OpenWith`），而不是播放视频。
 *      ⇒ 必须**绕过文件关联**，直接指定播放器可执行文件。
 *   ② 播放器进程起来后**窗口抢不到前台**（`SetForegroundWindow` 返回 False），
 *      因为前台被那个对话框占着，而且 Windows 有前台锁定。
 *      ⇒ 打开前先关掉「打开方式」对话框；打开后用 ALT 解锁 + AttachThreadInput
 *        （这套在 §12.7.1 已验证有效）。
 *   ③ 播放器启动需要时间，窗口不是立刻就有。
 *      ⇒ **轮询等 MainWindowHandle 出现**，不能 sleep 一次就查。
 *
 * 播放器查找顺序：Windows Media Player（系统自带）→ VLC → PotPlayer → MPC-HC。
 * 实测本机 WMP 在 `C:\Program Files (x86)\Windows Media Player\wmplayer.exe`
 * （**不在** `System32`，Win11 上那里没有）。
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from './logger.ts';

const execFileAsync = promisify(execFile);

export interface OpenInPlayerResult {
  ok: boolean;
  /** 实际使用的播放器（可读名） */
  player?: string;
  /** 播放器可执行文件路径 */
  exe?: string;
  /** 是否成功把窗口提到前台 */
  foreground?: boolean;
  error?: string;
}

/** 按优先级列出的候选播放器（系统自带优先） */
const CANDIDATES: Array<{ label: string; paths: string[] }> = [
  {
    label: 'Windows Media Player',
    paths: [
      'C:\\Program Files (x86)\\Windows Media Player\\wmplayer.exe',
      'C:\\Program Files\\Windows Media Player\\wmplayer.exe',
      'C:\\Windows\\System32\\wmplayer.exe',
    ],
  },
  { label: 'VLC', paths: ['C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', 'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'] },
  { label: 'PotPlayer', paths: ['C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe'] },
  { label: 'MPC-HC', paths: ['C:\\Program Files\\MPC-HC\\mpc-hc64.exe'] },
];

function findPlayer(): { label: string; exe: string } | undefined {
  for (const c of CANDIDATES) {
    for (const p of c.paths) {
      if (fs.existsSync(p)) return { label: c.label, exe: p };
    }
  }
  return undefined;
}

/** 跑一段 PowerShell（用 -EncodedCommand 传，避免引号/`$` 被外层吃掉的经典坑） */
async function runPs(script: string, timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, cwd: process.env['TEMP'] },
  );
  return stdout;
}

/**
 * 打开文件并把它提到前台。
 *
 * @param file      要播放的视频（通常是切片的 `cutOutput`）
 * @param opts.raise 是否尝试提到前台（默认 true）
 */
export async function openInSystemPlayer(
  file: string,
  opts: { logger?: Logger; raise?: boolean } = {},
): Promise<OpenInPlayerResult> {
  const log = opts.logger;
  if (!fs.existsSync(file)) return { ok: false, error: `文件不存在：${file}` };
  const player = findPlayer();
  if (!player) {
    return {
      ok: false,
      error:
        '没找到可用的系统播放器（已尝试 Windows Media Player / VLC / PotPlayer / MPC-HC）。' +
        '可用「在文件夹中打开」后手动播放。',
    };
  }

  const safeExe = player.exe.replace(/'/g, "''");
  const safeFile = file.replace(/'/g, "''");
  const raise = opts.raise !== false;

  /* 这段脚本做四件事：
       1. 关掉可能挡在前面的「打开方式」对话框（本机 .mp4 关联是坏的，会被弹出来）；
       2. 用**绝对路径**直接启动播放器（绕过文件关联）；
       3. 轮询等它的主窗口出现（播放器启动要时间，不能只 sleep 一次）；
       4. ALT 解锁 + AttachThreadInput 后 SetForegroundWindow，把窗口提到最前。 */
  const script = `
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint flags, UIntPtr e);
'@
# 1) 关掉「打开方式」对话框
foreach ($p in @(Get-Process -Name 'OpenWith' -ErrorAction SilentlyContinue)) {
  try { $p.CloseMainWindow() | Out-Null } catch {}
}
Start-Sleep -Milliseconds 400
foreach ($p in @(Get-Process -Name 'OpenWith' -ErrorAction SilentlyContinue)) {
  try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
}

# 2) 直接启动播放器（绕过文件关联）
try { Start-Process -FilePath '${safeExe}' -ArgumentList '"${safeFile}"' -ErrorAction Stop }
catch { Write-Output ('OPENFAIL=' + $_.Exception.Message); exit }

$procName = [IO.Path]::GetFileNameWithoutExtension('${safeExe}')
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 25 -and $h -eq [IntPtr]::Zero; $i++) {
  Start-Sleep -Milliseconds 400
  $p = Get-Process -Name $procName -ErrorAction SilentlyContinue |
       Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { $h = [IntPtr]$p.MainWindowHandle }
}
if ($h -eq [IntPtr]::Zero) { Write-Output 'OPENED-NOWINDOW'; exit }
Write-Output 'OPENED'

${raise ? `
# 3) 提到前台 —— 必须**轮询重试**，一次不够。
#    实测现象：Windows Media Player 是**单实例**，第二次打开文件时复用已有窗口，
#    窗口可能停在后台；单次 SetForegroundWindow 有时不生效（前台仍是 explorer）。
#    所以循环尝试，每轮重新取前台并判断是否已经是播放器；成功就退出。
$ok = $false
$tries = 0
for ($k = 0; $k -lt 18 -and -not $ok; $k++) {
  $tries = $k + 1
  # ★ 每轮**重新取一次**窗口句柄：播放器加载视频时可能重建窗口，
  #   拿旧句柄去 SetForegroundWindow 会打空（这是"有时成功有时失败"的一个来源）。
  $target = Get-Process -Name $procName -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $target) { Start-Sleep -Milliseconds 300; continue }
  $th = [IntPtr]$target.MainWindowHandle
  [void][W.U]::ShowWindow($th, 9)
  [W.U]::keybd_event(0x12,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 25; [W.U]::keybd_event(0x12,0,2,[UIntPtr]::Zero)
  $fg=[W.U]::GetForegroundWindow(); $tid=0; [void][W.U]::GetWindowThreadProcessId($fg,[ref]$tid)
  $my=[W.U]::GetCurrentThreadId(); $att=$false
  if ($tid -ne $my) { $att=[W.U]::AttachThreadInput($my,[uint32]$tid,$true) }
  [void][W.U]::SetForegroundWindow($th)
  if ($att) { [void][W.U]::AttachThreadInput($my,[uint32]$tid,$false) }
  Start-Sleep -Milliseconds 300
  # 判据：前台进程是不是播放器（不是"SetForegroundWindow 返回了什么"）
  $now=[W.U]::GetForegroundWindow(); $np=0; [void][W.U]::GetWindowThreadProcessId($now,[ref]$np)
  $npName = (Get-Process -Id $np -ErrorAction SilentlyContinue).ProcessName
  if ($npName -eq $procName) { $ok = $true }
}
Write-Output ('RAISED=' + $ok + ' tries=' + $tries)
` : ''}`;

  try {
    const out = await runPs(script);
    if (out.includes('OPENFAIL')) {
      const msg = out.split('OPENFAIL=')[1]?.split(/\r?\n/)[0] ?? '未知错误';
      log?.warn(`用系统播放器打开失败：${msg}`, { mod: 'ui' });
      return { ok: false, player: player.label, exe: player.exe, error: msg };
    }
    if (out.includes('OPENED-NOWINDOW')) {
      /* 播放器起来了但没抓到窗口句柄：视频大概率已经在放，只是我们没能确认/前置。
         这不算失败 —— 如实告诉调用方"打开了但没确认到前台"。 */
      log?.info(`已用 ${player.label} 打开，但没捕捉到窗口句柄（无法确认前台）`, { mod: 'ui' });
      return { ok: true, player: player.label, exe: player.exe, foreground: false };
    }
    const raised = /RAISED=(\w+)/.exec(out)?.[1] === 'True';
    log?.info(`已用 ${player.label} 打开切片产物（前台=${raised ? '是' : '否'}）`, { mod: 'ui' });
    return { ok: true, player: player.label, exe: player.exe, foreground: raised };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 200);
    log?.warn(`调用系统播放器异常：${msg}`, { mod: 'ui' });
    return { ok: false, player: player.label, exe: player.exe, error: msg };
  }
}
