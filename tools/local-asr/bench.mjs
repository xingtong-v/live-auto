/**
 * 本地 ASR 基准测试：跑一次转写，同时采样 CPU / 内存 / 显存占用。
 * 用法：node tools/local-asr/bench.mjs <spec.json> [标签]
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';

const specPath = process.argv[2];
const label = process.argv[3] ?? 'bench';
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

const NVSMI = 'C:\\Windows\\System32\\nvidia-smi.exe';
const PY = 'F:/deepseek/live_auto/.venv-asr/Scripts/python.exe';

/** 采样一次系统占用 */
function sample() {
  // PowerShell 取 node/python 进程树的内存与 CPU
  const ps = `
$procs = Get-Process -Name python,ffmpeg -ErrorAction SilentlyContinue
$mem = 0; $cpu = 0
foreach ($p in $procs) { $mem += $p.WorkingSet64; $cpu += $p.CPU }
$total = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
$free = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1KB
[PSCustomObject]@{ mem = $mem; cpu = $cpu; totalMem = $total; freeMem = $free } | ConvertTo-Json -Compress
`;
  let out = { mem: 0, cpu: 0, totalMem: 1, freeMem: 1 };
  try {
    out = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 20000 }).trim());
  } catch { /* 忽略采样失败 */ }
  let gpu = null;
  try {
    const g = execFileSync(NVSMI, ['--query-gpu=utilization.gpu,memory.used,power.draw,temperature.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 10000 }).trim();
    const [util, memUsed, power, temp] = g.split(',').map((s) => Number(s.trim()));
    gpu = { util, memUsed, power, temp };
  } catch { /* 无 GPU 数据 */ }
  return { ...out, gpu };
}

const samples = [];
const py = spawn(PY, ['F:/deepseek/live_auto/tools/local-asr/transcribe.py'], { stdio: ['pipe', 'pipe', 'pipe'] });
let out = '';
let err = '';
py.stdout.on('data', (d) => (out += d.toString('utf8')));
py.stderr.on('data', (d) => (err += d.toString('utf8')));

const timer = setInterval(() => samples.push(sample()), 2000);
samples.push(sample());

py.stdin.write(JSON.stringify(spec), 'utf8');
py.stdin.end();

const t0 = Date.now();
py.on('close', (code) => {
  clearInterval(timer);
  samples.push(sample());
  const wallSec = (Date.now() - t0) / 1000;

  console.log(`\n===== ${label} =====`);
  console.log(`  退出码 ${code}  墙钟 ${wallSec.toFixed(1)}s`);

  let j = null;
  try {
    j = JSON.parse(out);
  } catch { /* 下面统一处理 */ }

  if (!j || !j.ok) {
    console.log(`  ✗ 失败: ${j ? j.error : out.slice(0, 200)}`);
    if (err.trim()) console.log(`  stderr 尾部: ${err.trim().split('\n').slice(-4).join(' | ')}`);
    process.exit(1);
  }

  console.log(`  设备 ${j.device}/${j.compute_type}   语言 ${j.language}(p=${j.language_probability})`);
  console.log(`  音频 ${j.duration.toFixed(1)}s   段落 ${j.segments.length}   转写耗时 ${(j.elapsed_ms / 1000).toFixed(1)}s`);
  console.log(`  实时率 RTF = ${(j.elapsed_ms / 1000 / j.duration).toFixed(3)}  (越小越快)`);
  console.log(`  CUDA DLL 目录注册数 = ${j.cuda_dll_dirs ?? 'n/a'}`);

  const gpus = samples.filter((s) => s.gpu).map((s) => s.gpu);
  const mems = samples.map((s) => Math.round(s.mem / 1024 / 1024));
  console.log(`\n  ── 运行期资源占用（${samples.length} 次采样）──`);
  if (gpus.length) {
    const util = gpus.map((g) => g.util);
    const vram = gpus.map((g) => g.memUsed);
    const power = gpus.map((g) => g.power);
    const temp = gpus.map((g) => g.temp);
    console.log(`  显存占用   : 峰值 ${Math.max(...vram)} MB   均值 ${Math.round(vram.reduce((a, b) => a + b, 0) / vram.length)} MB`);
    console.log(`  GPU 利用率 : 峰值 ${Math.max(...util)}%   均值 ${Math.round(util.reduce((a, b) => a + b, 0) / util.length)}%`);
    console.log(`  功耗       : 峰值 ${Math.max(...power)} W   均值 ${Math.round(power.reduce((a, b) => a + b, 0) / power.length)} W`);
    console.log(`  温度       : 峰值 ${Math.max(...temp)}°C`);
  } else {
    console.log(`  GPU: 未采到数据`);
  }
  console.log(`  进程内存   : 峰值 ${Math.max(...mems)} MB`);
  const last = samples[samples.length - 1];
  console.log(`  系统内存   : 总 ${(last.totalMem / 1024 ** 3).toFixed(1)} GB，转写后空闲 ${(last.freeMem / 1024 ** 3).toFixed(1)} GB`);
  fs.writeFileSync(`data/local-asr-test/bench-${label}.json`, JSON.stringify({ label, wallSec, result: j, samples }, null, 2), 'utf8');
});
