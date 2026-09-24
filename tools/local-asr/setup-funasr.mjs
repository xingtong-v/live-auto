/**
 * 本地部署 Fun-ASR-Nano 的环境准备（一次性、可重复执行）。
 *
 * ## 为什么用独立 venv
 *
 * 官方 [FunASR vLLM 指南](https://raw.githubusercontent.com/modelscope/FunASR/main/docs/vllm_guide_zh.md)
 * 明确要求"不要把它的环境与本机其它 ASR 环境混用"：Fun-ASR 依赖 torch + funasr，
 * 而现有的 `.venv-asr` 是 faster-whisper（ctranslate2）环境，混装会互相拽版本。
 * 所以这里建 `.venv-funasr`，与 `.venv-asr` 完全隔离。
 *
 * ## 两条路径
 *
 * - **PyTorch 路径（本脚本默认）**：`funasr` + `torch`。官方 bench RTFx 21（GPU），
 *   装起来轻、Windows 下最稳。够用来做"识别率 + 耗时"的对比。
 * - **vLLM 路径（`--vllm`）**：额外装 `vllm`，官方 bench RTFx 340（16 倍）。
 *   依赖重、对驱动/CUDA 版本敏感，放在 PyTorch 路径跑通之后再上。
 *
 * 用法：
 *   node tools/local-asr/setup-funasr.mjs            # PyTorch 路径
 *   node tools/local-asr/setup-funasr.mjs --vllm     # 额外装 vLLM
 *   node tools/local-asr/setup-funasr.mjs --check    # 只做环境自检，不安装
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENV = path.join(ROOT, '.venv-funasr');
const PY = path.join(VENV, 'Scripts', 'python.exe');
const LOG = path.join(ROOT, 'data', 'local-asr-test', 'setup-funasr.log');
const wantVllm = process.argv.includes('--vllm');
const checkOnly = process.argv.includes('--check');

fs.mkdirSync(path.dirname(LOG), { recursive: true });
/**
 * ⚠️ 日志必须**同步**写。
 *
 * 踩过的坑：一开始用 `fs.createWriteStream` + `console.log`，而安装步骤走的是 `spawnSync` ——
 * 它会阻塞事件循环，异步 stream 的缓冲在整个安装期间**一个字节都刷不到磁盘**，
 * 表现就是"任务在跑，但日志文件根本不存在"，完全没法监控进度。
 */
function say(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG, line + '\n', 'utf8');
  } catch {
    /* 日志写不进去不该中断安装 */
  }
}

function run(cmd, args, opts = {}) {
  say(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (out) {
    try {
      fs.appendFileSync(LOG, out.slice(-8000) + '\n', 'utf8');
    } catch {
      /* ignore */
    }
    const tail = out.split('\n').slice(-4).join('\n');
    console.log(tail);
  }
  return { code: r.status ?? 1, out };
}

/* ---------------- 0. 前置检查 ---------------- */
say('=== Fun-ASR 本地环境准备 ===');
const nvsmi = run('nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader']);
say(`GPU: ${nvsmi.out || '（读不到，稍后用 torch 判断）'}`);

if (checkOnly) {
  if (!fs.existsSync(PY)) {
    say(`✗ 环境不存在：${VENV}（去掉 --check 先安装）`);
    process.exit(1);
  }
} else {
  /* ---------------- 1. 建独立 venv ---------------- */
  if (!fs.existsSync(PY)) {
    say(`创建独立环境：${path.relative(ROOT, VENV)}`);
    const v = run('python', ['-m', 'venv', VENV]);
    if (v.code !== 0 || !fs.existsSync(PY)) {
      say('✗ venv 创建失败');
      process.exit(1);
    }
  } else {
    say(`复用已有环境：${path.relative(ROOT, VENV)}`);
  }

  const pip = (...args) => run(PY, ['-m', 'pip', ...args], { timeout: 3600_000 });

  /* ---------------- 2. torch（CUDA 版）----------------
   * ⚠️ 三个坑都踩过了，别再退回老路：
   *  ① 官方 `download.pytorch.org`：2.5 GB 下到一半 `ReadTimeoutError`（国内到那个 CDN 不稳）；
   *  ② 国内镜像 `mirrors.aliyun.com/pytorch-wheels/cu126/` 是**扁平文件列表**、不是 PEP 503 索引 ——
   *     用 `--index-url` 会得到 "No matching distribution found for torch (from versions: none)"，
   *     必须用 `--find-links`；
   *  ③ 即使用了 find-links，pip 自己的下载器仍会**中途停滞**（实测卡在 595 MB 九分钟不动，无报错）。
   *     → 所以主力方案改成 **curl 直接下 wheel**（可断点续传 `-C -`、进度可观测），下完再用 pip 装本地文件。
   * 40 系卡选 cu126；**刻意不提供 CPU-only 兜底**：静默装成 CPU 版会让基准数据失真，宁可失败并说清原因。
   */
  const WHEEL_DIR = path.join(ROOT, 'data', 'local-asr-test', 'wheels');
  fs.mkdirSync(WHEEL_DIR, { recursive: true });
  const TORCH_VER = '2.9.1'; // torch 与 torchaudio 必须配套，镜像上 2.9.1 两侧都有
  const MIRRORS = ['https://mirrors.aliyun.com/pytorch-wheels/cu126', 'https://mirror.sjtu.edu.cn/pytorch-wheels/cu126'];
  const pipSlow = ['--timeout', '180', '--retries', '10'];

  say(`安装 torch ${TORCH_VER}+cu126（约 2.5 GB）…`);
  const wheels = [];
  /** 每个包的最小体积（字节）：torch 是 2.4 GB，而 torchaudio 的 Windows 轮子只有约 2 MB ——
      一开始两者共用 ">50MB" 的判据，导致已经下好的 torchaudio 被判定为"没下完"而反复重下。 */
  const MIN_SIZE = { torch: 50 * 1024 * 1024, torchaudio: 1024 * 1024 };
  for (const pkg of ['torch', 'torchaudio']) {
    const name = `${pkg}-${TORCH_VER}%2Bcu126-cp312-cp312-win_amd64.whl`;
    const file = path.join(WHEEL_DIR, `${pkg}-${TORCH_VER}+cu126-cp312-cp312-win_amd64.whl`);
    const minSize = MIN_SIZE[pkg] ?? 1024 * 1024;
    let ok = fs.existsSync(file) && fs.statSync(file).size >= minSize;
    if (ok) say(`  ${pkg} 已有本地 wheel（${(fs.statSync(file).size / 1024 ** 2).toFixed(1)} MB），跳过下载`);
    for (const m of ok ? [] : MIRRORS) {
      say(`  下载 ${pkg} ← ${m}`);
      // curl 的 -C - 断点续传：中途断了重跑本脚本会接着下，不用从头再来
      const r = run('curl', ['-L', '-C', '-', '--retry', '5', '--retry-delay', '3', '--connect-timeout', '30', '-sS', '-o', file, `${m}/${name}`], {
        timeout: 3600_000,
      });
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (r.code === 0 && size >= minSize) {
        say(`  ✓ ${pkg} 下载完成：${(size / 1024 ** 2).toFixed(1)} MB`);
        ok = true;
        break;
      }
      say(`  ✗ 该源失败（${(size / 1024 ** 2).toFixed(1)} MB），换下一个`);
    }
    if (!ok) {
      say(`✗ ${pkg} 下载失败。可手动续传：`);
      say(`  curl -L -C - -o "${file}" "${MIRRORS[0]}/${name}"`);
      process.exit(1);
    }
    wheels.push(file);
  }

  say('用 pip 安装本地 wheel（依赖走清华 PyPI 镜像）…');
  const inst = pip('install', '--index-url', 'https://pypi.tuna.tsinghua.edu.cn/simple', ...wheels, ...pipSlow);
  if (inst.code !== 0) {
    say('✗ torch 安装失败（wheel 已下好，可手动重试：pip install <wheel 路径>）');
    process.exit(1);
  }
  say('  ✓ torch 安装完成');

  /* ---------------- 3. funasr + modelscope ---------------- */
  say('安装 funasr / modelscope / soundfile（用清华 PyPI 镜像加速）…');
  const fun = pip('install', '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple', 'funasr', 'modelscope', 'soundfile');
  if (fun.code !== 0) {
    say('⚠ 清华镜像失败，换官方 PyPI 重试');
    const fun2 = pip('install', 'funasr', 'modelscope', 'soundfile', ...pipSlow);
    if (fun2.code !== 0) {
      say('✗ funasr 安装失败');
      process.exit(1);
    }
  }

  /* ---------------- 4. 可选：vLLM ---------------- */
  if (wantVllm) {
    say('安装 vLLM（官方指南固定 0.19.1；依赖重，可能失败）…');
    const v = pip('install', 'vllm==0.19.1');
    if (v.code !== 0) {
      say('⚠ vLLM 安装失败 —— PyTorch 路径仍可用，先跑通再回头处理');
    }
  }
}

/* ---------------- 5. 自检 ---------------- */
say('=== 自检 ===');
const probe = `
import json, sys
info = {}
try:
    import torch
    info['torch'] = torch.__version__
    info['cuda_available'] = bool(torch.cuda.is_available())
    info['cuda_version'] = getattr(torch.version, 'cuda', None)
    if torch.cuda.is_available():
        info['gpu'] = torch.cuda.get_device_name(0)
except Exception as e:
    info['torch_error'] = str(e)
try:
    import funasr
    info['funasr'] = getattr(funasr, '__version__', 'unknown')
except Exception as e:
    info['funasr_error'] = str(e)
try:
    import modelscope
    info['modelscope'] = getattr(modelscope, '__version__', 'unknown')
except Exception as e:
    info['modelscope_error'] = str(e)
try:
    import vllm
    info['vllm'] = vllm.__version__
except Exception:
    info['vllm'] = None
print(json.dumps(info, ensure_ascii=False))
`;
const r = run(PY, ['-c', probe]);
try {
  const info = JSON.parse(r.out.split('\n').filter((l) => l.trim().startsWith('{')).at(-1) ?? '{}');
  say(`torch       : ${info.torch ?? '✗ ' + (info.torch_error ?? '')}`);
  say(`CUDA 可用   : ${info.cuda_available ? `是（${info.cuda_version}，${info.gpu}）` : '否 —— 会退到 CPU，慢很多'}`);
  say(`funasr      : ${info.funasr ?? '✗ ' + (info.funasr_error ?? '')}`);
  say(`modelscope  : ${info.modelscope ?? '✗ ' + (info.modelscope_error ?? '')}`);
  say(`vllm        : ${info.vllm ?? '（未装，PyTorch 路径可用）'}`);
  say(fs.existsSync(PY) ? `\n✓ 环境就绪：${path.relative(ROOT, PY)}` : '\n✗ 环境不完整');
  say(`日志：${path.relative(ROOT, LOG)}`);
} catch {
  say(`自检输出无法解析：${r.out.slice(-500)}`);
  process.exit(1);
}
