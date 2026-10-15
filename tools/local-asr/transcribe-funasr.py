"""
本地 Fun-ASR 转写（阿里云开源 Fun-ASR-Nano），接口与 `transcribe.py`（faster-whisper）**保持一致**：
stdin 收一个 JSON spec，stdout 吐一个 JSON 结果。这样 `compare-asr.ts` 只要换脚本与解释器路径，
就能用同一套指标对比"云端 fun-asr / 本地 whisper / 本地 Fun-ASR"三方。

## 为什么要自己拼 VAD + ASR
Fun-ASR-Nano 是"LLM 解码式"ASR（SenseVoice 编码器 + Qwen3-0.6B 解码器），
单次调用返回整段文本；而我们的字幕、切片边界都要**分段级时间戳**。
所以流程是：fsmn-vad 切句 → 每句送 Fun-ASR 识别 → 拼回带时间戳的段落，
与 whisper 的 `segments[{start,end,text}]` 结构对齐（apple-to-apple）。

## spec 字段
{
  "file":       "C:/path/to/audio.flv",   # 任意媒体，内部用 ffmpeg 抽 16k 单声道
  "start_time": 0, "end_time": 300,        # 只转这一段（秒）
  "model":      "FunAudioLLM/Fun-ASR-Nano-2512",
  "hub":        "ms",                      # ms=ModelScope（推荐，国内快）/ hf
  "device":     "cuda",                     # cuda | cpu | auto
  "language":   "中文",
  "hotwords":   ["腿宝", "钢蹦"],           # 可选：热词（Fun-ASR 原生支持）
  "engine":     "auto",                     # auto | vllm | pytorch
  "vad_model":  "fsmn-vad",
  "max_segment_sec": 60                     # 超过就再切细，避免个别长段拖慢
}

## 输出
{"ok": true, "engine": "pytorch", "segments": [{"start": 0.0, "end": 2.5, "text": "..."}],
 "language": "zh", "duration": 12.3, "device": "cuda", "elapsed_ms": 1234}
出错时：{"ok": false, "error": "...", "trace": "..."}
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import traceback

# stdout 只留给最终的 JSON：库的横幅/进度全部改道 stderr（见 emit() 的说明）
#
# ★ 必须**先把两个流强制成 UTF-8**。
#   Windows 上 Python 往管道写 stdout 默认用控制台代码页（本机是 GBK/cp936），
#   调用方（Node）按 UTF-8 解码就得到一串乱码 —— **而且不会报错**。
#   实测代价：一次三方对比里本地 Fun-ASR 的 CER 被算成 169%，看着像"模型完全不行"，
#   其实是把 GBK 字节当 UTF-8 解了。whisper 那个 runner 早就有一模一样的处理，我漏抄了。
sys.stdout.reconfigure(encoding="utf-8", errors="strict")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr


def _scrub_surrogates(value, counter: list) -> object:
    """把**孤立代理项**换掉（`\\udc83` 这类），保证 json.dumps 不会炸。

    为什么需要：2026-10-13 实测，模型输出里混进一个孤立代理项 ⇒
    `json.dumps(ensure_ascii=False)` 写 stdout 抛 `UnicodeEncodeError: surrogates not allowed`
    ⇒ **整次转写失败**（素材已经跑了 20 分钟，全部白跑）。这类字符是"坏字节被解码成了半个代理对"，
    正确的处理是替换成 U+FFFD 并**计数上报**（不静默：结果里带 `text_scrubbed`）。
    """
    if isinstance(value, str):
        if any(0xD800 <= ord(ch) <= 0xDFFF for ch in value):
            counter[0] += 1
            return value.encode("utf-8", "replace").decode("utf-8", "replace")
        return value
    if isinstance(value, dict):
        return {k: _scrub_surrogates(v, counter) for k, v in value.items()}
    if isinstance(value, list):
        return [_scrub_surrogates(v, counter) for v in value]
    return value


PROGRESS_PREFIX = "##ASR-PROGRESS##"

# 子批的默认大小（音频秒）。300 秒的由来：批要够大才不重复前向开销，又要够小才让界面
# 每 30–60 秒看到一次**真实**推进（本机 RTF ≈0.11 ⇒ 300 秒音频约 33 秒墙上时间）。
# TS 侧可用 `asr.localFunasr.progressBatchSec` 覆盖；传 0 表示关掉分批。
PROGRESS_BATCH_SEC = 300



def emit_progress(phase: str, done_sec: float, total_sec: float,
                  seg_done: int = None, seg_total: int = None,
                  speed: float = None, elapsed_ms: int = None) -> None:
    """把一行进度写到 **stderr**（带哨兵前缀），父进程边跑边解析。

    为什么走 stderr 而不是 stdout：stdout 是**结果通道**（`emit()` 的 JSON，
    父进程按"最后一个合法 JSON 行"解析）。往里塞进度行就等于污染结果契约 ——
    而 stderr 本来就是库的杂音通道，加一行带前缀的 JSON 不影响任何人。

    为什么需要它（2026-10-15 用户需求「精确进度」）：模型一次 `generate()` 就是一个黑盒，
    30 分钟一块的音频要跑好几分钟、期间**零输出** ⇒ 界面只能靠猜（实测显示 1%，
    而实际已经跑了 16 分钟）。把批次切开、每批报一次"已推进到本块第几秒" +
    实测速度，界面上的百分比与剩余时间就都是**量出来的**。

    任何异常都吞掉：进度是**观测**，绝不能因为它把转写弄失败。
    """
    payload: dict = {"phase": phase, "done_sec": round(float(done_sec), 3), "total_sec": round(float(total_sec), 3)}
    if seg_done is not None:
        payload["seg_done"] = int(seg_done)
    if seg_total is not None:
        payload["seg_total"] = int(seg_total)
    if speed is not None and speed > 0:
        payload["speed"] = round(float(speed), 4)
    if elapsed_ms is not None:
        payload["elapsed_ms"] = int(elapsed_ms)
    try:
        sys.stderr.write(PROGRESS_PREFIX + " " + json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def emit(obj: dict, code: int = 0) -> None:
    """
    只往**真正的 stdout** 写 JSON。

    ⚠️ 实测踩到：funasr 在 import 时会往 stdout 打版本横幅（`funasr version: 1.4.16`），
    模型加载与推理过程也会打进度 —— 这些会和 JSON 混在一起，调用方解析直接失败。
    所以进程一开始就把 `sys.stdout` 换成 stderr（库的杂音全部改道），
    真正的结果只写在保存下来的 `_REAL_STDOUT` 上。

    ⚠️ 另一个坑（2026-10-13）：模型偶尔吐出**孤立代理项**，`ensure_ascii=False` 写出去会抛
    `UnicodeEncodeError` ⇒ 整次转写失败。这里先擦掉并计数，且**再兜一层**：
    万一还有别的编码问题，退回 `ensure_ascii=True`（转义后一定合法）并标注，
    保证"跑完的活不会因为一个字符丢掉"。
    """
    counter = [0]
    safe = _scrub_surrogates(obj, counter)
    if isinstance(safe, dict) and counter[0] > 0:
        safe["text_scrubbed"] = counter[0]
        try:
            sys.stderr.write(f"[warn] 字幕文本里有 {counter[0]} 处非法代理字符，已替换为 U+FFFD\n")
        except Exception:
            pass
    try:
        payload = json.dumps(safe, ensure_ascii=False)
    except (UnicodeEncodeError, ValueError):
        payload = json.dumps(safe, ensure_ascii=True)
        safe["encoding_fallback"] = "ensure_ascii"
        payload = json.dumps(safe, ensure_ascii=True)
    try:
        _REAL_STDOUT.write(payload)
    except UnicodeEncodeError:
        _REAL_STDOUT.write(payload.encode("utf-8", "replace").decode("utf-8", "replace"))
    _REAL_STDOUT.flush()
    sys.exit(code)


def register_cuda_dlls() -> list[str]:
    """Windows 下 torch 的 CUDA 依赖（cudnn/cublas 等）需要显式加进 DLL 搜索路径。"""
    notes: list[str] = []
    if os.name != "nt":
        return notes
    candidates: list[str] = []
    try:
        import torch  # noqa: F401

        torch_lib = os.path.join(os.path.dirname(torch.__file__), "lib")
        candidates.append(torch_lib)
        nvidia_root = os.path.join(os.path.dirname(torch.__file__), "..", "nvidia")
        if os.path.isdir(nvidia_root):
            for pkg in os.listdir(nvidia_root):
                for sub in ("bin", "lib"):
                    p = os.path.join(nvidia_root, pkg, sub)
                    if os.path.isdir(p):
                        candidates.append(p)
    except Exception as e:  # pragma: no cover
        notes.append(f"torch 导入失败，跳过 DLL 注册：{e}")
    for p in candidates:
        if os.path.isdir(p):
            try:
                os.add_dll_directory(p)
            except Exception:
                pass
    if candidates:
        os.environ["PATH"] = os.pathsep.join(candidates + [os.environ.get("PATH", "")])
    return notes


def extract_audio(src: str, start: float, end: float, out_wav: str) -> None:
    """抽 16k 单声道 wav —— Fun-ASR 的前端就是按 16k 训练的。"""
    dur = max(0.1, end - start)
    cmd = [
        "ffmpeg", "-hide_banner", "-nostdin", "-y", "-v", "error",
        "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", src,
        "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", out_wav,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(out_wav):
        raise RuntimeError(f"ffmpeg 抽音频失败：{r.stderr.strip()[-300:]}")


PUNCT = "，。！？、；：,.!?;:…"


def _align_chars(text: str, stamps: list) -> list:
    """
    把"字级时间戳"对齐到文本的每个字符上，返回 `[(char, start, end), ...]`（相对片段起点，秒）。

    为什么要对齐而不是直接用：`timestamps` 的 token 可能是**多字符英文词**（如 "sorry"），
    而标点通常**没有 token**。直接按索引取会整体错位。
    做法：把每个 token 摊平成它的字符（时长按字符数均分），再按顺序与文本匹配；
    标点沿用前一个字符的结束时刻。
    """
    flat: list = []
    for t in stamps:
        if not isinstance(t, dict):
            continue
        tok = str(t.get("token") or "")
        if not tok:
            continue
        try:
            s = float(t.get("start_time"))
            e = float(t.get("end_time"))
        except (TypeError, ValueError):
            continue
        n = len(tok)
        for k, ch in enumerate(tok):
            flat.append((ch, s + (e - s) * k / n, s + (e - s) * (k + 1) / n))

    out: list = []
    fi = 0
    prev_end = None
    for ch in text:
        if fi < len(flat) and flat[fi][0] == ch:
            c, s, e = flat[fi]
            out.append((ch, s, e))
            prev_end = e
            fi += 1
        elif ch in PUNCT or ch.isspace():
            # 标点没有 token：挂在"上一个字结束"的位置，长度给 0（不参与时长计算）
            at = prev_end if prev_end is not None else (flat[fi][1] if fi < len(flat) else 0.0)
            out.append((ch, at, at))
        else:
            # 对不上（识别文本与 token 序列不一致）→ 放弃字级，交给调用方退化为比例分配
            return []
    return out if len(out) == len(text) else []


def _cues_from_stamps(text: str, stamps: list, seg_start: float, max_chars: int, min_dur: float) -> list:
    """
    用字级时间戳把一段文本切成**句级字幕**：按标点断句，时间取该句首字与末字的真实时刻。

    这比"按 VAD 段给时间戳"精确得多 —— 实测 VAD 段的时间戳起点偏差中位 1.96s、p90 8.9s
    （一条字幕覆盖两三句话），而字级对齐后每句都有自己的起止时刻。
    对齐失败时返回空列表，调用方退化为整段一条。
    """
    aligned = _align_chars(text, stamps)
    if not aligned:
        return []
    cues: list = []
    cur: list = []
    for item in aligned:
        cur.append(item)
        ch = item[0]
        if ch in PUNCT or len(cur) >= max_chars:
            cues.append(cur)
            cur = []
    if cur:
        cues.append(cur)

    out: list = []
    for i, group in enumerate(cues):
        body = "".join(c for c, _, _ in group).strip()
        if not body:
            continue
        starts = [s for _, s, _ in group]
        ends = [e for _, _, e in group]
        start = seg_start + min(starts)
        end = seg_start + max(ends)
        if end - start < min_dur:
            end = start + min_dur
        # 与下一条不能重叠（下一条的起点是硬约束）
        if i + 1 < len(cues):
            nxt = [s for _, s, _ in cues[i + 1]]
            if nxt:
                end = min(end, seg_start + min(nxt))
        if end > start:
            out.append({"start": round(start, 3), "end": round(end, 3), "text": body})
    return out


def _describe_result(res: object) -> object:
    """
    把模型返回的第一条结果压缩成可读结构（只用于 debug）。

    为什么需要它：Fun-ASR-Nano 的字级时间戳在不同版本里放在不同键下
    （`timestamp` / `timestamps` / `words`，单位可能是毫秒也可能是秒），
    与其猜，不如把真实结构打出来看一眼。
    """
    try:
        items = list(res) if isinstance(res, (list, tuple)) else [res]
        if not items:
            return {"items": 0}
        first = items[0]
        if not isinstance(first, dict):
            return {"type": type(first).__name__, "repr": repr(first)[:300]}
        out: dict = {"keys": sorted(first.keys()), "items": len(items)}
        for key in ("text", "timestamp", "timestamps", "words", "time_stamp", "sentence_info"):
            if key in first:
                v = first[key]
                if key == "text":
                    out[key] = str(v)[:120]
                elif isinstance(v, (list, tuple)):
                    out[key] = {"len": len(v), "head": [list(x) if isinstance(x, (list, tuple)) else x for x in v[:6]]}
                else:
                    out[key] = repr(v)[:200]
        return out
    except Exception as e:  # pragma: no cover
        return {"probe_error": f"{type(e).__name__}: {e}"}


def probe_duration(path: str) -> float:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=60,
        )
        return float(r.stdout.strip())
    except Exception:
        return 0.0


def main() -> None:
    """
    读 spec：默认从 stdin；给一个参数时把它当**spec 文件路径**读（UTF-8）。
    后者是为了排查方便 —— 在 PowerShell 里 `Get-Content -Raw | python` 会把中文
    按 GBK 编坏（实测报 "spec 不是合法 JSON"），从文件读就没有这层转码。
    """
    if len(sys.argv) > 1 and os.path.exists(sys.argv[1]):
        with open(sys.argv[1], 'r', encoding='utf-8') as f:
            raw = f.read()
    else:
        raw = sys.stdin.read()
    try:
        spec = json.loads(raw)
    except Exception as e:
        emit({"ok": False, "error": f"spec 不是合法 JSON：{e}（前 120 字：{raw[:120]!r}）"}, 1)

    file = str(spec.get("file") or "")
    if not file or not os.path.exists(file):
        emit({"ok": False, "error": f"文件不存在：{file}"}, 1)

    start = float(spec.get("start_time") or 0)
    end = float(spec.get("end_time") or 0) or (start + (probe_duration(file) or 0))
    model = str(spec.get("model") or "FunAudioLLM/Fun-ASR-Nano-2512")
    hub = str(spec.get("hub") or "ms")
    device = str(spec.get("device") or "auto")
    language = str(spec.get("language") or "中文")
    hotwords = [str(h) for h in (spec.get("hotwords") or []) if str(h).strip()]
    engine_pref = str(spec.get("engine") or "auto")
    vad_model = str(spec.get("vad_model") or "fsmn-vad")
    max_segment = float(spec.get("max_segment_sec") or 60)
    # 输出的时间戳要加上它，才能对齐到"整场"的全局时间轴。
    # 与 transcribe.py 的语义**完全一致**：多分段任务时靠它把"文件内时间"拼回全局时间。
    offset = float(spec.get("offset") or 0)

    t0 = time.time()
    dll_notes = register_cuda_dlls()
    tmpdir = tempfile.mkdtemp(prefix="funasr-")
    wav = os.path.join(tmpdir, "audio16k.wav")

    try:
        # 进度：抽取音频（ffmpeg 转 16k 单声道）。这一段没有细粒度百分比（单次 ffmpeg 调用），
        # 报出来是为了让界面能说清"现在卡在哪一步"，而不是一片空白。
        emit_progress("extract", 0, max(0.0, end - start), elapsed_ms=0)
        extract_audio(file, start, end, wav)
        duration = probe_duration(wav) or (end - start)
        emit_progress("extract", 0, duration, elapsed_ms=int((time.time() - t0) * 1000))

        import torch  # noqa: F401  仅用于确认可用性

        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"

        # ---- VAD：切句（Fun-ASR-Nano 单次返回整段文本，时间戳靠 VAD 边界给）----
        from funasr import AutoModel

        vad = AutoModel(model=vad_model, device=device, disable_update=True, disable_pbar=True)
        vad_out = vad.generate(input=wav, cache={}, max_end_silence_time=800)
        spans: list[tuple[float, float]] = []
        for item in vad_out or []:
            for seg in item.get("value") or []:
                # fsmn-vad 给的是毫秒 [[start, end], ...]
                if isinstance(seg, (list, tuple)) and len(seg) >= 2:
                    s, e = float(seg[0]) / 1000.0, float(seg[1]) / 1000.0
                    if e - s > 0.05:
                        spans.append((s, e))
        if not spans:
            spans = [(0.0, duration)]

        # 长段再切细：个别几十秒不间断的句子会让 LLM 解码变慢且更容易跑偏
        fine: list[tuple[float, float]] = []
        for s, e in spans:
            if e - s <= max_segment:
                fine.append((s, e))
            else:
                n = int((e - s) // max_segment) + 1
                step = (e - s) / n
                fine.extend((s + i * step, s + (i + 1) * step) for i in range(n))

        # 进度：VAD 切句完成（它跑在整块音频上，也是"固定成本"的一部分）
        emit_progress("vad", 0, duration, seg_total=len(fine), elapsed_ms=int((time.time() - t0) * 1000))

        # ---- ASR 引擎：优先 vLLM（官方 bench RTFx 340 vs PyTorch 21），失败退 PyTorch ----
        # 进度：从 VAD 之后到模型可用，是这一块里**最贵的一次性等待**（实测 ≈90–100 秒）。
        # 界面据此显示"加载模型"而不是一个假百分比。
        emit_progress("load", 0, duration, elapsed_ms=int((time.time() - t0) * 1000))
        engine = "pytorch"
        asr = None
        if engine_pref in ("auto", "vllm"):
            try:
                from funasr.auto.auto_model_vllm import AutoModelVLLM

                asr = AutoModelVLLM(model=model, hub=hub, device=device, disable_update=True)
                engine = "vllm"
            except Exception as e:
                if engine_pref == "vllm":
                    raise
                dll_notes.append(f"vLLM 不可用，退 PyTorch：{type(e).__name__}: {e}")
        if asr is None:
            asr = AutoModel(model=model, hub=hub, device=device, disable_update=True, disable_pbar=True, **_model_kwargs(spec))

        # ---- 逐句识别 ----
        import soundfile as sf
        import numpy as np

        audio, sr = sf.read(wav, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)

        """
        ⚠️ 必须**写成 wav 文件再传路径**，不能直接传 numpy 波形。
        实测：传数组会在模型内部炸 —— fun_asr_nano/model.py 的
          `contents = self.data_template(data_in[0])` → `for item in data:`
          报 `TypeError: 'NoneType' object is not iterable`（它期望数据列表/文件，不是裸波形）。
        官方 demo 也是走文件路径（`demo_vllm.py --input audio.wav`）。

        另外**尽量批量**：逐段调用会把同一套前端/编码器开销重复 N 次，
        实测 60 秒音频分成 7 段逐段跑，推理时间比批量高一个量级。
        （2026-10-15 更严谨的说法：实测那 10 倍差是"每段一次 generate"的**调用开销**，
          不是模型本身慢 —— 所以下面按"若干段一批"切分，批次数量控制在个位数。）
        """
        # (句子区间, wav 路径) **成对**保存。
        # 原来只留路径列表 `seg_paths`，而结果回填用的是区间列表 `fine` 去 zip ——
        # 一旦有区间因为太短被跳过（下面那个 continue），两者就错位了：
        # 文本会被贴到**别的**时间点上（字幕整体串位）。成对保存 + 按对推进，从根上消掉它。
        pairs: list[tuple[tuple[float, float], str]] = []
        for i, (s, e) in enumerate(fine):
            chunk = audio[int(s * sr): int(e * sr)]
            if chunk.size < int(0.05 * sr):
                continue
            p = os.path.join(tmpdir, f"seg-{i:04d}.wav")
            sf.write(p, chunk, sr)
            pairs.append(((s, e), p))

        asr_t0 = time.time()
        kwargs: dict = {"language": language}
        if hotwords:
            kwargs["hotwords"] = hotwords
        # CTC 字级时间戳：Fun-ASR-Nano 生成文本后做 forced alignment 得到每字的时间。
        # 不开的话只能拿 VAD 段边界当时间戳，粒度粗到一条字幕覆盖两三句
        # （实测中位偏差 1.96s、p90 8.9s；开了之后能细化到句/字级）。
        want_ts = spec.get("timestamps", True) is not False
        if want_ts:
            kwargs["output_timestamp"] = True
        """
        推理调优（默认值不一定是这台机器上最快的）：
        - `llm_dtype`：见 `_model_kwargs` —— 它是**模型级**参数，必须在 `AutoModel(...)` 里给；
          此前错传在 `generate()` 里 ⇒ 被静默忽略（实测 fp32/bf16 显存一模一样）。
          40 系卡支持 bf16（`dtype_map` 只认 bf16/fp16/fp32，官方在 vLLM 路径也强制 bf16；
          fp16 反而会产生退化重复输出）。
        - `max_length`：默认 512 个 token；十几字的短句根本用不到，EOS 不干净时就是白跑。
        """
        if spec.get("max_length"):
            kwargs["max_length"] = int(spec["max_length"])

        # ---- 子批：把"一次喂完"切成若干批，**只为让进度可见**（2026-10-15）----
        # 批大小按**音频秒数**控制（`progress_batch_sec`，默认 300 秒）：
        #   · 太小（逐段）→ 重复前向开销，实测慢一个量级；
        #   · 太大（一次喂完）→ 界面在整个块（几分钟到十几分钟）里没有任何真实进度。
        # 批与批之间**顺序拼接**结果 ⇒ 与"一次喂完"语义等价；批内仍是原来那个批量调用。
        try:
            batch_sec = float(spec.get("progress_batch_sec") or PROGRESS_BATCH_SEC)
        except Exception:
            batch_sec = float(PROGRESS_BATCH_SEC)
        batches: list[list[int]] = []
        if not pairs:
            batches = []
        elif batch_sec <= 0:
            # 0/负数 = 关掉分批（行为与历史逐字一致，也给"怀疑分批拖慢了"时留一个开关）
            batches = [list(range(len(pairs)))]
        else:
            cur: list[int] = []
            cur_audio = 0.0
            for idx, ((s, e), _p) in enumerate(pairs):
                cur.append(idx)
                cur_audio += max(0.0, e - s)
                if cur_audio >= batch_sec:
                    batches.append(cur)
                    cur = []
                    cur_audio = 0.0
            if cur:
                batches.append(cur)

        texts: list[str] = []
        results_items: list = []
        engine_note = ""
        raw_debug: object = None
        degraded = 0
        seg_done = 0
        speech_done = 0.0
        speed = 0.0
        for b_i, batch in enumerate(batches):
            paths = [pairs[i][1] for i in batch]
            try:
                # 批量：这一批一次喂进去（模型内部按 batch 处理）
                res = asr.generate(input=paths, **kwargs)
                items = list(res or [])
                if spec.get("debug_raw") and raw_debug is None:
                    # 把第一条结果的键与时间戳结构原样带出来，便于确认字级时间戳怎么取
                    raw_debug = _describe_result(res)
            except Exception as e:
                # 退路：**本批**逐段调用（慢，但至少能出结果）
                degraded += 1
                items = []
                for p in paths:
                    try:
                        r = asr.generate(input=p, **kwargs)
                    except TypeError:
                        r = asr.generate(input=p)
                    row = list(r or [])
                    items.append(row[0] if row else {})
            results_items.extend(items)
            seg_done += len(batch)
            speech_done += sum(max(0.0, e - s) for (s, e), _p in (pairs[i] for i in batch))
            speed = speech_done / max(1e-6, time.time() - asr_t0)
            # 进度：已推进到本块音频的第几秒（= 这一批最后一句的结束位置）。
            # 静音段也算"推进"——否则 30 分钟里 20% 是静音时，进度永远差一截。
            emit_progress(
                "asr",
                pairs[batch[-1]][0][1],
                duration,
                seg_done=seg_done,
                seg_total=len(pairs),
                speed=speed,
                elapsed_ms=int((time.time() - t0) * 1000),
            )
        if len(batches) > 1:
            engine_note = (
                f"分 {len(batches)} 批调用（每批约 {int(batch_sec)} 秒音频，共 {len(pairs)} 段）"
                + (f"；其中 {degraded} 批退化为逐段调用" if degraded else "")
            )
        elif batches:
            engine_note = f"批量 {len(pairs)} 段一次调用"
        else:
            engine_note = "没有可识别的句子（VAD 没切出语音）"
        texts = [str(it.get("text", "")).strip() if isinstance(it, dict) else str(it) for it in results_items]
        asr_ms = int((time.time() - asr_t0) * 1000)
        # 整块跑完：末尾的静音不会被 VAD 覆盖，显式报"到末尾"，
        # 否则进度会停在 99%（实测：最后 8 秒静音就够卡住它）。
        emit_progress(
            "asr",
            duration,
            duration,
            seg_done=len(pairs),
            seg_total=len(pairs),
            speed=speed,
            elapsed_ms=int((time.time() - t0) * 1000),
        )

        max_chars = int(spec.get("max_chars_per_cue") or 18)
        min_dur = float(spec.get("min_cue_dur") or 0.6)
        by_stamp = {"字级": 0, "VAD 段": 0}
        segments: list[dict] = []
        for (s, e), res_item in zip([sp for sp, _p in pairs], results_items, strict=False):
            text = ""
            stamps: list = []
            if isinstance(res_item, dict):
                text = str(res_item.get("text") or "").strip()
                for key in ("timestamps", "ctc_timestamps"):
                    v = res_item.get(key)
                    if isinstance(v, (list, tuple)) and v:
                        stamps = list(v)
                        break
            elif res_item:
                text = str(res_item).strip()
            if not text:
                continue
            # 优先：用字级时间戳切成句级字幕（时间精确到字）
            fine_cues = _cues_from_stamps(text, stamps, s, max_chars, min_dur) if stamps else []
            if fine_cues:
                for c in fine_cues:
                    c["start"] = round(c["start"] + offset, 3)
                    c["end"] = round(c["end"] + offset, 3)
                segments.extend(fine_cues)
                by_stamp["字级"] += len(fine_cues)
            else:
                segments.append(
                    {"start": round(s + offset, 3), "end": round(e + offset, 3), "text": text}
                )
                by_stamp["VAD 段"] += 1

        emit({
            "ok": True,
            "engine": engine,
            "model": model,
            "segments": segments,
            "language": language,
            "duration": round(duration, 3),
            "device": device,
            "elapsed_ms": int((time.time() - t0) * 1000),
            # 耗时拆分：模型加载是一次性成本，跟"每段音频要多久"必须分开看，
            # 否则拿冷启动的数字去比 RTF，会得出"本地慢几十倍"的错误结论
            "asr_ms": asr_ms,
            "segments_input": len(pairs),
            "batch_note": engine_note,
            # 进度观测的汇总（2026-10-15）：父进程据此把"这一块的固定成本"与实测速度
            # 写进日志/台账 —— 界面上"还需约 N 分钟"的准确性全靠这两个数。
            "progress": {
                "batches": len(batches),
                "batch_sec": int(batch_sec) if batch_sec > 0 else 0,
                "seg_total": len(pairs),
                "speech_sec": round(speech_done, 1),
                "asr_speed": round(speed, 4),
                "degraded_batches": degraded,
            },
            "timestamp_source": by_stamp,
            "raw_debug": raw_debug,
            "notes": dll_notes,
            # 精度与显存体检（2026-10-13 加）：
            #  · llm_dtype 回显**真正传给模型的那个值**（取自 _model_kwargs，而不是曾经的
            #    "我往 generate 里塞了什么" —— 那个值当初被 funasr 静默忽略，回显等于自欺）；
            #  · gpu_peak_mb 取自 torch 自己的峰值计数器 —— 比外部采样可靠得多
            #    （实测用"Node 起 pwsh 再采样 GPU 计数器"那套嵌套方案根本起不来，
            #     而且外部采样还会被同时运行的游戏/其它进程干扰）。
            "llm_dtype": str(_model_kwargs(spec).get("llm_dtype") or "fp32(默认)"),
            **_gpu_mem_stats(),
        })
    except Exception as e:
        emit({"ok": False, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-2000:], "notes": dll_notes}, 1)
    finally:
        try:
            import shutil

            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass


def _model_kwargs(spec: dict) -> dict:
    """构造 `AutoModel` 时要带的"模型级"参数（**不是** generate 参数）。

    ⚠️ 2026-10-13 实测踩到的坑：`llm_dtype` 属于**模型配置**，funasr 只在
    `funasr/models/fun_asr_nano/model.py` 的 **__init__** 里读它
    （`llm_conf.get("llm_dtype", "fp32")` → `model.to(dtype_map[...])`），
    而此前本项目一直把它混在 `asr.generate(**kwargs)` 里传 ⇒ **被静默忽略**：
    实测同素材 fp32/bf16 两次跑出来**显存一模一样（3493 MB）、字幕逐字相同**，
    只有耗时噪声 —— 也就是说"参数传了、也回显了，但根本没生效"。
    `AutoModel.__init__` 的文档写明 "All other config.yaml fields can be overridden"，
    所以模型级参数应当在这里给。
    """
    out: dict = {}
    if spec.get("llm_dtype"):
        out["llm_dtype"] = str(spec["llm_dtype"])
    return out


def _gpu_mem_stats() -> dict:
    """CUDA 峰值显存（MB）。非 CUDA / 任何异常一律返回空 dict —— 体检信息绝不影响主流程。

    为什么用 torch 的计数器而不是外部采样：
      · 计数器覆盖**从进程启动到此刻**的峰值，正好包含模型加载这一大块；
      · 外部采样（GPU Process Memory 性能计数器）要另起进程，实测那套嵌套方案起不来，
        而且同机若有游戏在跑，采样值会被干扰。
    """
    try:
        import torch

        if not torch.cuda.is_available():
            return {}
        return {
            "gpu_peak_mb": round(torch.cuda.max_memory_allocated() / 1048576),
            "gpu_reserved_mb": round(torch.cuda.max_memory_reserved() / 1048576),
        }
    except Exception:
        return {}


if __name__ == "__main__":
    main()
