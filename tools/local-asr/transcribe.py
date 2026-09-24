#!/usr/bin/env python3
"""本地 ASR 执行器（faster-whisper / CTranslate2）。

## 为什么放在 TypeScript 项目外面

项目的硬约束之一是**不引入需要原生编译的依赖**（`node_modules` 里全是纯 JS）。
faster-whisper 是 Python + CTranslate2（原生扩展），所以它作为**可选的外部执行器**存在：
本项目只是 `spawn` 它，不把它变成构建依赖。这样 `npm run verify` 在任何机器上都不受影响。

## 输入（stdin 一个 JSON 对象）

    {
      "file":       "C:/path/to/audio.flv",   # 待转写媒体（音轨由 faster-whisper 内部用 PyAV 解码）
      "start_time": 0,                        # 秒，相对该文件起点；省略 = 从头
      "end_time":   1800,                     # 秒；与 start_time 必须成对出现
      "model":      "large-v3-turbo",         # 模型名（HuggingFace 上的 CT2 仓库）
      "model_dir":  "C:/.../models",          # 可选：模型缓存目录（默认 ./.models）
      "language":   "zh",                     # 语言；"auto" 表示自动检测
      "device":     "auto",                   # auto | cuda | cpu
      "compute_type": "auto",                 # auto | float16 | int8_float16 | int8
      "beam_size":  5,
      "vad_filter": true,                     # Silero VAD 去静音（能显著减少幻觉）
      "offset":     0                         # 输出的时间戳会加上它（对齐到全局时间）
    }

## 输出（stdout 一个 JSON 对象）

    {"ok": true, "segments": [{"start": 0.0, "end": 2.5, "text": "..."}], "language": "zh",
     "duration": 12.3, "device": "cuda", "compute_type": "float16", "elapsed_ms": 1234}

失败时：`{"ok": false, "error": "..."}` 并以非零码退出。

## 为什么直接接受 start_time/end_time 而不是自己切片

云端路径（biliLive-tools 的 `/ai/subtitle`）按窗口付费，所以项目侧已经有一套
"窗口规划 + 分段文件映射"的逻辑（`asr.ts` 的 `planWindows`）。本地执行器**沿用同一套窗口**，
这样两边产出的 `transcript.json` 结构一致，缓存键也不用改。
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback

# HuggingFace 官方域名在部分网络下不可达；未显式设置时用社区镜像。
# 必须在 import huggingface_hub **之前**设置才生效（它在导入时读该环境变量）。
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
# ★ 必须禁用 Xet 传输。新版 huggingface_hub 默认走 Xet（hf-xet 包），
#   它会去 `cas-server.xethub.hf.co` 取分块 —— 镜像不提供该服务，实测直接 401：
#     `CAS Client Error: HTTP status client error (401 Unauthorized), domain: cas-server.xethub.hf.co`
#   关掉之后回退到普通 HTTP 下载，镜像就能正常工作。
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
# Windows 上没开开发者模式时 HF 缓存无法建符号链接，会刷一大段警告；
# 功能不受影响（只是多占一点磁盘），这里静音掉以免污染 stderr。
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

# ★ 强制 stdout/stderr 用 UTF-8。
#   Windows 上 Python 默认按**系统 ANSI 代码页**（中文 = GBK/cp936）编码 stdout，
#   而我们输出的是 JSON（内含中文识别结果）—— 于是中文被 GBK 编码后写进 stdout，
#   调用方按 UTF-8 解码就得到一串乱码，**而且不报错**（实测：transcript.json 里
#   1378 个字符全是"锟斤拷"式乱码，但时间戳完全正确，很难第一眼发现）。
#   必须在任何输出之前重配置。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass


def register_cuda_dlls() -> list[str]:
    """把 pip 装的 CUDA 运行时 DLL 目录注册进 DLL 搜索路径。

    ## 为什么必须有这一步

    CTranslate2 的 CUDA 后端在 Windows 上是**动态加载** `cublas64_12.dll` / `cudnn64_9.dll` 的，
    而这两个库除非系统装了完整 CUDA Toolkit（3 GB 起），否则找不到 —— 实测报错：
        `Library cublas64_12.dll is not found or cannot be loaded`
    但 pip 上有官方拆分包（`nvidia-cublas-cu12` / `nvidia-cudnn-cu12` /
    `nvidia-cuda-runtime-cu12`，合计约 1.2 GB），装完 DLL 落在
    `site-packages/nvidia/<组件>/bin/`。Python 3.8+ 在 Windows 上**不再搜索 PATH**，
    必须显式 `os.add_dll_directory()`，且要在**导入 ctranslate2 之前**调用。

    返回注册成功的目录列表（供诊断输出）。
    """
    if sys.platform != "win32":
        return []
    try:
        import site  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return []
    roots: list[str] = []
    for sp in list(site.getsitepackages()) + [site.getusersitepackages()]:
        nvidia_root = os.path.join(str(sp), "nvidia")
        if os.path.isdir(nvidia_root):
            roots.append(nvidia_root)
    added: list[str] = []
    for root in roots:
        for comp in sorted(os.listdir(root)):
            bindir = os.path.join(root, comp, "bin")
            if os.path.isdir(bindir):
                try:
                    os.add_dll_directory(bindir)
                    added.append(bindir)
                except Exception:  # noqa: BLE001
                    pass
    # ★ 还必须把目录加进 PATH。
    #   实测：只调 add_dll_directory 时，CTranslate2 仍报
    #   `Library cublas64_12.dll is not found or cannot be loaded` ——
    #   因为 ctranslate2 是用 LoadLibrary 动态加载 cublas 的，而**依赖它的那些 DLL**
    #   （cudart / nvrtc / 各 cudnn 子库之间互相引用）解析时走的是进程 PATH，
    #   不走 add_dll_directory。两处都设才能生效（这一步是实测出来的，不是理论）。
    if added:
        os.environ["PATH"] = os.pathsep.join(added + [os.environ.get("PATH", "")])
    return added


# 必须在任何 ctranslate2 / faster_whisper 导入之前执行
CUDA_DLL_DIRS = register_cuda_dlls()


def emit(obj: dict, code: int = 0) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()
    sys.exit(code)


def build_transcribe_args(
    file: str, st: object, et: object, language: str, beam_size: int, vad_filter: bool
) -> tuple[list, dict]:
    """构造 transcribe() 的位置参数与关键字参数（构造与重试两条路径共用，避免漂移）。"""
    kwargs: dict = {
        "language": None if language == "auto" else language,
        "beam_size": beam_size,
        "vad_filter": vad_filter,
        # 保留时间戳：切片边界对齐（analyze.ts 的断句点吸附）依赖它
        "without_timestamps": False,
        # 长音频里能显著减少"复读式幻觉"
        "condition_on_previous_text": False,
    }
    if st is not None and et is not None:
        # 只解码需要的区间：[start, end]（秒，相对该文件）
        kwargs["clip_timestamps"] = [float(st), float(et)]
    return [file], kwargs


def main() -> None:
    started = time.time()
    try:
        raw = sys.stdin.read()
        spec = json.loads(raw)
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": f"参数解析失败：{e}"}, 2)

    file = str(spec.get("file") or "").strip()
    if not file:
        emit({"ok": False, "error": "缺少 file"}, 2)
    if not os.path.exists(file):
        emit({"ok": False, "error": f"文件不存在：{file}"}, 2)

    # start_time / end_time 必须成对（与云端接口的契约一致，见硬约束 #7）
    st = spec.get("start_time")
    et = spec.get("end_time")
    if (st is None) != (et is None):
        emit({"ok": False, "error": "start_time 与 end_time 必须成对提供"}, 2)
    offset = float(spec.get("offset") or 0)

    model_name = str(spec.get("model") or "large-v3-turbo")
    model_dir = spec.get("model_dir")
    if model_dir:
        os.makedirs(str(model_dir), exist_ok=True)
    language = str(spec.get("language") or "zh")
    device = str(spec.get("device") or "auto")
    compute_type = str(spec.get("compute_type") or "auto")
    beam_size = int(spec.get("beam_size") or 5)
    vad_filter = bool(spec.get("vad_filter", True))

    try:
        from faster_whisper import WhisperModel  # 延迟导入：让参数错误能先报出来
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": f"faster-whisper 未安装或不可用：{e}"}, 3)

    # device=auto：先试 GPU，**推理失败再退 CPU**。
    #
    # ⚠️ 关键：CTranslate2 的 CUDA 后端是**惰性加载**的 —— `WhisperModel(device='cuda')`
    #   可以构造成功，直到第一次 encode 才去加载 cublas64_12.dll / cudnn，此时才抛
    #   `Library cublas64_12.dll is not found or cannot be loaded`。
    #   所以"只在构造时 try/except"是不够的（实测就是这么漏掉的：GPU 构造成功 →
    #   推理时崩 → CPU 回退从没机会执行 → 整体失败）。
    #   正确做法是把**构造 + 一次真实推理**都放进同一个 try 里。
    attempts: list[tuple[str, str]] = []
    if device == "auto":
        attempts = [("cuda", "float16"), ("cuda", "int8_float16"), ("cpu", "int8")]
    else:
        attempts = [(device, compute_type)]

    last_err: str | None = None
    model = None
    segments_raw = None
    info = None
    used_device = used_compute = ""
    for dev, ct in attempts:
        try:
            candidate = WhisperModel(
                model_name,
                device=dev,
                compute_type=ct,
                download_root=str(model_dir) if model_dir else None,
            )
            # 只为对齐时间戳，这里就取一次（不额外花钱/时间）
            args, kwargs = build_transcribe_args(file, st, et, language, beam_size, vad_filter)
            segments_iter, candidate_info = candidate.transcribe(*args, **kwargs)
            # 真正触发一次推理：这一步才会加载 CUDA 库
            segments_raw = list(segments_iter)
            info = candidate_info
            model = candidate
            used_device, used_compute = dev, ct
            break
        except Exception as e:  # noqa: BLE001
            last_err = f"{dev}/{ct}: {e}"
            continue
    if model is None or segments_raw is None:
        emit({"ok": False, "error": f"转写失败（尝试过 {len(attempts)} 种配置）：{last_err}"}, 4)

    try:
        out = []
        for seg in segments_raw:
            text = str(seg.text or "").strip()
            if not text:
                continue
            out.append(
                {
                    "start": round(float(seg.start) + offset, 3),
                    "end": round(float(seg.end) + offset, 3),
                    "text": text,
                }
            )

        emit(
            {
                "ok": True,
                "segments": out,
                "language": getattr(info, "language", language),
                "language_probability": round(float(getattr(info, "language_probability", 0) or 0), 4),
                "duration": round(float(getattr(info, "duration", 0) or 0), 3),
                "device": used_device,
                "compute_type": used_compute,
                "elapsed_ms": int((time.time() - started) * 1000),
                "cuda_dll_dirs": len(CUDA_DLL_DIRS),
            }
        )
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": f"结果处理失败：{e}", "trace": traceback.format_exc()[-1500:]}, 5)


if __name__ == "__main__":
    main()
