#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
asr-transcribe / transcribe.py  (v2.0)
录音转写主脚本：本地 FunASR Paraformer-Large（INT8 量化 ONNX 默认）+ 云端兜底。
支持 m4a/mp3/wav/aac/flac/ogg/mp4/mov；输出 .srt/.vtt/.txt（--diarize 带说话人分离）。

引擎说明：
- 默认 --engine funasr-onnx：funasr-onnx 包 + Paraformer-Large INT8 ONNX 模型，
  依赖小（onnxruntime + numpy），CPU 快、无需 torch，是弱机/离线首选。
- --engine funasr（完整版 funasr 包，torch）：自动带 VAD + 标点；
  加 --diarize 时用 CAM++ 做说话人分离。
- 任何本地引擎都不再用 whisper 系模型（whisperX / faster-whisper 已彻底移除）。

设计原则（对应保密红线）：
- 默认本地、数据不出域；--engine cloud 必须由调用方在征得用户同意后显式指定。
- 云端不做说话人分离，脚本会显式打印降级提示；token 不在日志回显。
- 所有 .txt 顶部写入"机器转写未校对"水印。
"""
from __future__ import annotations

import argparse
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

WATERMARK = "[本文为 ASR 机器转写，专名/数字/口径以原音频为准，未经人工校对]"
AUDIO_EXT = {".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg",
             ".mp4", ".mov", ".wma", ".amr"}

# Windows 控制台默认 GBK：打印中文/特殊符号（tqdm 进度条、中文路径）直接崩
# UnicodeEncodeError，导致后台任务秒变 failed。本进程及所有子进程统一 UTF-8。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

# 本地模型缓存根目录：优先 --model-dir / ASR_MODEL_DIR 环境变量（由今点通主进程注入
# 到 userData/models/funasr），fallback 到 ~/.cache/funasr。
# 兼容读取旧变量 ASR_WHISPER_MODEL_DIR（老版本缓存目录），写新目录时不再使用它。
DEFAULT_MODEL_DIR = os.path.join(os.path.expanduser("~"), ".cache", "funasr")

# ONNX 默认模型（FunASR 官方 ModelScope ID，INT8 量化，约 238MB）
DEFAULT_ONNX_MODEL_ID = "damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx"
# 完整版 funasr 模型 ID（带时间戳 + 自动标点）
FUNASR_MODEL_ID = "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
FUNASR_VAD_MODEL_ID = "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"
FUNASR_PUNC_MODEL_ID = "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch"
# CAM++ 说话人向量模型（完整版 funasr 说话人分离用）
FUNASR_SV_MODEL_ID = "iic/speech_campplus_sv_zh-cn_16k-common"

SENT_END = set("。！？!?；;…—")


def log(msg): print(f"[asr] {msg}", flush=True)
def err(msg): print(f"[asr][ERROR] {msg}", file=sys.stderr, flush=True)
def has(cmd): return shutil.which(cmd) is not None
def stem_of(audio): return os.path.splitext(os.path.basename(audio))[0]


def bundled_ffmpeg_path() -> str | None:
    """优先返回应用内置的 ffmpeg.exe，其次才允许走系统 PATH。"""
    candidates = []

    env_path = os.environ.get("ASR_FFMPEG_PATH", "").strip()
    if env_path:
        candidates.append(Path(env_path))

    # 开发态：项目根目录/resources/ffmpeg/windows/ffmpeg.exe
    project_root = Path(__file__).resolve().parents[3]
    candidates.append(project_root / "resources" / "ffmpeg" / "windows" / "ffmpeg.exe")

    # 打包态：应用资源目录内的 ffmpeg（若未来通过 extraResources 放入）
    app_root = Path(__file__).resolve().parents[4]
    candidates.append(app_root / "resources" / "ffmpeg" / "windows" / "ffmpeg.exe")

    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return None


def ffmpeg_cmd() -> str:
    return bundled_ffmpeg_path() or "ffmpeg"


def model_cache_dir(model_dir: str = "") -> str:
    """返回本地模型缓存根目录。优先显式指定，其次新环境变量，最后默认目录。

    兼容：如果新变量/ASR_MODEL_DIR 都没设，但旧 ASR_WHISPER_MODEL_DIR 指向了
    已有模型的目录，则沿用它，避免老用户重新下载。
    """
    if model_dir.strip():
        return model_dir.strip()
    new_var = os.environ.get("ASR_MODEL_DIR", "").strip()
    if new_var:
        return new_var
    legacy = os.environ.get("ASR_WHISPER_MODEL_DIR", "").strip()
    if legacy and os.path.isdir(legacy):
        return legacy
    return DEFAULT_MODEL_DIR


def local_model_path(model_name: str, model_dir: str = "") -> str | None:
    """查找本地缓存中是否已有对应模型。

    model_name 可以是：
    - 本地目录绝对路径（目录下含 model.onnx / model.pt / *.onnx 即命中）；
    - ModelScope ID（如 damo/...-onnx），取最后一段作目录名查找；
    - 简写（onnx / funasr / sv），映射到各自默认目录名。
    返回存在的目录路径，否则 None。
    """
    if os.path.isdir(model_name) and any(
        glob.glob(os.path.join(model_name, pat)) for pat in ("*.onnx", "*.pt", "model.*")
    ):
        return model_name

    short_map = {
        "onnx": DEFAULT_ONNX_MODEL_ID.rsplit("/", 1)[-1],
        "funasr": FUNASR_MODEL_ID.rsplit("/", 1)[-1],
        "sv": FUNASR_SV_MODEL_ID.rsplit("/", 1)[-1],
    }
    folder = short_map.get(model_name.strip().lower(), model_name.rsplit("/", 1)[-1])
    candidates = [
        os.path.join(model_cache_dir(model_dir), folder),
        os.path.join(model_cache_dir(model_dir), model_name),
    ]
    for cand in candidates:
        if os.path.isdir(cand) and any(
            glob.glob(os.path.join(cand, pat)) for pat in ("*.onnx", "*.pt", "model.*")
        ):
            return cand
    return None


def mod_ok(name):
    try:
        __import__(name); return True
    except Exception:
        return False


def ensure_py_dep(import_name: str, pip_name: str) -> bool:
    """缺包自动 pip 安装（agent 全自动，无需用户手动）。

    首次运行需联网一次；安装失败返回 False，调用方再降级/报错。
    """
    if mod_ok(import_name):
        return True
    log(f"缺 {pip_name}，正在自动安装（首次需联网一次，约 1-3 分钟）…")
    try:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", pip_name],
                       check=False)
    except Exception as exc:  # noqa: BLE001
        err(f"自动安装 {pip_name} 失败：{exc}")
        return False
    if mod_ok(import_name):
        log(f"{pip_name} 自动安装完成。")
        return True
    err(f"{pip_name} 安装后仍不可导入，请按 references/install.md 手动安装。")
    return False


def ensure_ffmpeg():
    if bundled_ffmpeg_path() or has("ffmpeg"):
        return
    # 自动兜底：pip 装 imageio-ffmpeg，自带 ffmpeg 二进制，无需用户装系统 ffmpeg
    if ensure_py_dep("imageio_ffmpeg", "imageio-ffmpeg"):
        try:
            from imageio_ffmpeg import get_ffmpeg_exe
            if os.path.exists(get_ffmpeg_exe()):
                log("已通过 imageio-ffmpeg 自动提供 ffmpeg。")
                return
        except Exception:
            pass
    err("未检测到 ffmpeg。请把 ffmpeg.exe 放到 resources/ffmpeg/windows/ffmpeg.exe，"
        "或安装系统 ffmpeg（见 references/install.md）。")
    sys.exit(2)


def to_mono_wav(audio: str) -> tuple[str, str | None]:
    """转成 16k 单声道 wav（FunASR 输入要求）。已是 wav 则直接返回原路径。"""
    if os.path.splitext(audio)[1].lower() == ".wav":
        return audio, None
    tmp = tempfile.mkdtemp(prefix="asr_wav_")
    out = os.path.join(tmp, "in.wav")
    subprocess.run([ffmpeg_cmd(), "-y", "-i", audio, "-ar", "16000", "-ac", "1", out],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    return out, tmp


def probe_duration(audio: str) -> float:
    try:
        r = subprocess.run(
            [ffmpeg_cmd(), "-i", audio],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            text=True, check=False)
        m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", r.stderr or "")
        if m:
            return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    except Exception:
        pass
    try:  # ffprobe 兜底
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                            "format=duration", "-of",
                            "default=noprint_wrappers=1:nokey=1", audio],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           text=True, check=False)
        return float((r.stdout or "").strip())
    except Exception:
        return 0.0


_TAG_RE = re.compile(r"<\|[^|]*\|>")


def _strip_tags(text: str) -> str:
    """剥离 FunASR 输出里混入的 <|start,end|> 时间戳标签。"""
    return _TAG_RE.sub("", text or "").strip()


def _cues_from_timestamp(text: str, timestamp: list) -> list[dict] | None:
    """帧级 timestamp（与文本等长，每字 [start_ms, end_ms]）-> 按句末标点切句。

    长度对不上返回 None（调用方走整段兜底）。时间单位毫秒。
    """
    if not text or not timestamp or len(timestamp) != len(text):
        return None
    cues: list[dict] = []
    cur_start: float | None = None
    cur_end: float | None = None
    buf: list[str] = []

    def _flush():
        nonlocal cur_start, cur_end, buf
        if not buf:
            return
        cues.append({"text": "".join(buf),
                     "start": (cur_start or 0.0) / 1000.0,
                     "end": (cur_end or 0.0) / 1000.0})
        cur_start, cur_end, buf = None, None, []

    for ch, ts in zip(text, timestamp):
        try:
            s_ms, e_ms = float(ts[0]), float(ts[1])
        except (TypeError, ValueError, IndexError):
            return None
        if cur_start is None:
            cur_start = s_ms
        cur_end = e_ms
        buf.append(ch)
        if ch in SENT_END:
            _flush()
    _flush()
    return cues or None


def _cues_from_sentence_info(sentence_info: list[dict]) -> list[dict]:
    """完整版 funasr 的 sentence_info（start/end 毫秒，可带 spk）-> cue 列表。"""
    cues = []
    for s in sentence_info or []:
        text = _strip_tags(s.get("text", ""))
        if not text:
            continue
        cue = {"text": text,
               "start": float(s.get("start", 0) or 0) / 1000.0,
               "end": float(s.get("end", 0) or 0) / 1000.0}
        if s.get("spk") is not None:
            cue["spk"] = s.get("spk")
        cues.append(cue)
    return cues


def _renumber_speakers(cues: list[dict]) -> bool:
    """把任意 spk 编号按首次出现顺序重排为 1..N。改出任一 cue 即返回 True。"""
    mapping: dict = {}
    changed = False
    for cue in cues:
        if cue.get("spk") is None:
            continue
        raw = cue["spk"]
        if raw not in mapping:
            mapping[raw] = len(mapping) + 1
        if cue["spk"] != mapping[raw]:
            cue["spk"] = mapping[raw]
            changed = True
    return changed or bool(mapping)


def _assign_speakers_by_range(cues: list[dict], spk_ranges: list) -> bool:
    """按 spk 区间 [start, end, spk] 给 cue 打标。

    区间单位自适应：若最大值 > 1000 视为毫秒，否则视为秒。命中任一 cue 返回 True，
    打标后自动重编号。
    """
    if not spk_ranges:
        return False
    flat = [v for r in spk_ranges for v in r[:2]]
    ms_unit = max(flat) > 1000 if flat else False
    hit = False
    for cue in cues:
        if cue.get("start") is None or cue.get("end") is None:
            continue
        mid = (cue["start"] + cue["end"]) / 2.0
        mid_cmp = mid * 1000.0 if ms_unit else mid
        best = None
        for r in spk_ranges:
            try:
                s, e, spk = float(r[0]), float(r[1]), r[2]
            except (TypeError, ValueError, IndexError):
                continue
            if s <= mid_cmp <= e:
                best = spk
                break
        if best is not None:
            cue["spk"] = best
            hit = True
    if hit:
        _renumber_speakers(cues)
    return hit


def _fill_missing_times(cues: list[dict], audio: str) -> None:
    """缺时间戳兜底：按已知锚点前后夹逼，未知段均分；全未知则按估算语速均分。

    时长来源：probe 音频失败则全未知段共分 2.0s（单测确定性行为）。
    """
    if not cues:
        return
    for cue in cues:
        if cue.get("start") is not None and cue.get("end") is not None:
            continue
        n_chars = max(len(cue.get("text", "")), 1)
        cue["_chars"] = n_chars
    duration = probe_duration(audio)
    if duration <= 0:
        # 无音频时长：已知锚点夹逼，未知段按字数均分；全未知则总长按 1s/句估算
        anchors = [(i, c) for i, c in enumerate(cues)
                   if c.get("start") is not None and c.get("end") is not None]
        if not anchors:
            total = float(len(cues))  # 1s/句
            cursor = 0.0
            total_chars = sum(c.get("_chars", 1) for c in cues)
            for cue in cues:
                share = total * cue.get("_chars", 1) / total_chars
                cue["start"], cue["end"] = cursor, cursor + share
                cursor += share
        else:
            # 段间插值：前后锚点之间按字数比例分配
            bounds = [(-1, 0.0)] + [(i, c["end"]) for i, c in anchors] + \
                     [(len(cues), None)]
            for (li, l_end), (ri, _) in zip(bounds[:-1], bounds[1:]):
                gap = cues[li + 1:ri]
                if not gap:
                    continue
                r_start = cues[ri]["start"] if ri < len(cues) else None
                if r_start is None:  # 尾部：从 l_end 起按 1s/句延展
                    cursor = l_end
                    for cue in gap:
                        cue["start"], cue["end"] = cursor, cursor + 1.0
                        cursor += 1.0
                else:
                    total_chars = sum(c.get("_chars", 1) for c in gap)
                    span = max(r_start - l_end, 0.0)
                    cursor = l_end
                    for cue in gap:
                        share = span * cue.get("_chars", 1) / total_chars if total_chars else 0.0
                        cue["start"], cue["end"] = cursor, cursor + share
                        cursor += share
        for cue in cues:
            cue.pop("_chars", None)
        # 单调兜底
        prev = 0.0
        for cue in cues:
            cue["start"] = max(cue["start"], prev)
            cue["end"] = max(cue["end"], cue["start"])
            prev = cue["end"]
        return
    # 有音频时长：未知段按语速（字数比例）嵌入总时长
    total_chars = sum(c.get("_chars", 1) for c in cues)
    cursor = 0.0
    for cue in cues:
        if cue.get("start") is not None and cue.get("end") is not None:
            cursor = max(cursor, cue["end"])
            cue.pop("_chars", None)
            continue
        share = duration * cue.get("_chars", 1) / total_chars if total_chars else 0.0
        cue["start"], cue["end"] = cursor, cursor + share
        cursor += share
        cue.pop("_chars", None)


def fmt_ts(t, vtt=False):
    t = max(float(t or 0.0), 0.0)
    h = int(t // 3600); m = int((t % 3600) // 60); s = int(t % 60)
    ms = int(round((t - int(t)) * 1000))
    sep = "." if vtt else ","
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def _fmt_clock(t) -> str:
    t = max(float(t or 0.0), 0.0)
    return f"[{int(t // 3600):02d}:{int((t % 3600) // 60):02d}:{int(t % 60):02d}]"


def _spk_label(spk) -> str:
    return f"[发言人{spk}]"


def _write_outputs(cues, out_dir, stem, formats, diarized=False):
    """渲染 srt/vtt/txt。cues 元素：{text, start, end, spk?}。"""
    os.makedirs(out_dir, exist_ok=True)
    with_spk = diarized and any(c.get("spk") is not None for c in cues)

    def line_text(c):
        prefix = (_spk_label(c["spk"]) + " ") if with_spk and c.get("spk") is not None else ""
        return prefix + c["text"].strip()

    if "srt" in formats:
        with open(os.path.join(out_dir, stem + ".srt"), "w", encoding="utf-8") as f:
            for i, c in enumerate(cues, 1):
                f.write(f"{i}\n{fmt_ts(c['start'])} --> {fmt_ts(c['end'])}\n"
                        f"{line_text(c)}\n\n")
    if "vtt" in formats:
        with open(os.path.join(out_dir, stem + ".vtt"), "w", encoding="utf-8") as f:
            f.write("WEBVTT\n\n")
            for c in cues:
                f.write(f"{fmt_ts(c['start'], True)} --> {fmt_ts(c['end'], True)}\n"
                        f"{line_text(c)}\n\n")
    if "txt" in formats:
        with open(os.path.join(out_dir, stem + ".txt"), "w", encoding="utf-8") as f:
            f.write(WATERMARK + "\n\n")
            for c in cues:
                prefix = ""
                if with_spk and c.get("spk") is not None:
                    prefix = f"{_fmt_clock(c['start'])} {_spk_label(c['spk'])} "
                elif not with_spk:
                    prefix = f"{_fmt_clock(c['start'])} "
                f.write(prefix + c["text"].strip() + "\n")


# ---------- 本地：funasr-onnx（默认，INT8 ONNX，依赖最小）----------
def _resolve_onnx_dir(args) -> str | None:
    """定位 ONNX 模型目录：优先本地缓存，否则尝试 ModelScope 快照目录。"""
    local = local_model_path(args.model, args.model_dir)
    if local:
        return local
    try:
        from modelscope.hub.snapshot_download import snapshot_download
        model_id = args.model if "/" in args.model else DEFAULT_ONNX_MODEL_ID
        log(f"本地缓存未命中，尝试从 ModelScope 拉取：{model_id}")
        return snapshot_download(model_id)
    except Exception as exc:  # noqa: BLE001
        err(f"ONNX 模型不可用（本地无缓存、ModelScope 下载失败）：{exc}")
        return None


def run_funasr_onnx(audio, args, out_dir, stem) -> bool:
    if not ensure_py_dep("funasr_onnx", "funasr-onnx"):
        return False
    # funasr_onnx 内部非 wav 输入走 pydub 解码：缺包同样自动装，
    # 否则长音频直接抛 ModuleNotFoundError 被吞成"返回空结果"
    if os.path.splitext(audio)[1].lower() != ".wav":
        if not ensure_py_dep("pydub", "pydub"):
            return False
    # ONNX 需要经 modelscope 拉模型：缺包同样自动装
    if not local_model_path(args.model, args.model_dir):
        if not ensure_py_dep("modelscope", "modelscope"):
            return False
    try:
        from funasr_onnx import Paraformer
    except Exception:
        return False
    model_dir = _resolve_onnx_dir(args)
    if not model_dir:
        return False
    log(f"本地 FunASR-ONNX（Paraformer-Large INT8，数据不出域）：{model_dir}")
    # funasr_onnx 内部经 imageio-ffmpeg/pydub 找 ffmpeg：系统 PATH 未必有，
    # 把内置 ffmpeg 目录抬到 PATH 最前，否则 load_wav 报 ffmpeg 未找到
    _ff = bundled_ffmpeg_path()
    if _ff:
        os.environ["PATH"] = str(Path(_ff).parent) + os.pathsep + os.environ.get("PATH", "")
        os.environ["IMAGEIO_FFMPEG_EXE"] = _ff
    wav, wav_tmp = to_mono_wav(audio)
    try:
        model = Paraformer(model_dir, batch_size=args.batch_size,
                           quantize=getattr(args, "quantize", True))
        results = model(wav)
    except Exception as exc:  # noqa: BLE001
        err(f"funasr-onnx 推理失败：{exc}")
        return False
    finally:
        if wav_tmp:
            shutil.rmtree(wav_tmp, ignore_errors=True)

    # 多形态输出归一化（与 _selftest_funasr.py 第 7 节镜像保持一致）：
    # 形态1 dict(preds=list[str] + timestamp[(字,起s,止s)])；
    # 形态2 纯字符串列表；形态3 preds 混入 <|..|> 标签。
    cues: list[dict] = []
    for item in results or []:
        if isinstance(item, dict):
            raw_text = item.get("preds") or item.get("text") or ""
            ts = item.get("timestamp")
        elif isinstance(item, str):
            raw_text, ts = item, None
        else:
            continue
        if isinstance(raw_text, (list, tuple)):
            raw_text = next((t for t in raw_text if t), "")
        text = _strip_tags(raw_text)
        if not text:
            continue
        part = None
        if isinstance(ts, list) and ts:
            pairs, ok_ts = [], True
            for ent in ts:
                try:
                    pairs.append([float(ent[1]) * 1000.0, float(ent[2]) * 1000.0])
                except (TypeError, ValueError, IndexError):
                    ok_ts = False
                    break
            if ok_ts and len(pairs) == len(text):
                part = _cues_from_timestamp(text, pairs)
        cues.extend(part or [{"text": text, "start": None, "end": None}])

    if not cues:
        err("funasr-onnx 返回空结果。")
        return False
    _fill_missing_times(cues, audio)
    _write_outputs(cues, out_dir, stem, args.formats, diarized=False)
    dur = max((c["end"] or 0.0) for c in cues)
    log(f"识别完成 段数={len(cues)} 时长≈{dur:.0f}s（ONNX INT8，无说话人分离）")
    return True


# ---------- 本地：完整版 funasr（含 VAD/标点；--diarize 走 CAM++）----------
def run_funasr_full(audio, args, out_dir, stem) -> bool:
    if not ensure_py_dep("funasr", "funasr"):
        return False
    # CAM++ 分离只在 --diarize 时需要 modelscope 拉 sv 模型；提前自动装好
    if args.diarize and not local_model_path(args.sv_model, args.model_dir):
        if not ensure_py_dep("modelscope", "modelscope"):
            return False
    try:
        from funasr import AutoModel
    except Exception:
        return False

    model_dir = local_model_path(args.model, args.model_dir)
    model_id = model_dir or (args.model if "/" in args.model else FUNASR_MODEL_ID)
    log(f"本地完整版 FunASR（Paraformer-Large，数据不出域）：{model_id}")
    wav, wav_tmp = to_mono_wav(audio)
    try:
        model = AutoModel(model=model_id,
                          vad_model="fsmn-vad" if not local_model_path(
                              FUNASR_VAD_MODEL_ID.rsplit("/", 1)[-1], args.model_dir) else
                          local_model_path(FUNASR_VAD_MODEL_ID.rsplit("/", 1)[-1],
                                           args.model_dir),
                          punc_model="ct-punc" if not local_model_path(
                              FUNASR_PUNC_MODEL_ID.rsplit("/", 1)[-1], args.model_dir) else
                          local_model_path(FUNASR_PUNC_MODEL_ID.rsplit("/", 1)[-1],
                                           args.model_dir),
                          device="cuda:0" if args.device == "cuda" else "cpu",
                          disable_update=True)
        res = model.generate(input=wav, batch_size_s=int(args.batch_size) * 10,
                             hotword=args.hint_words or None)
    except Exception as exc:  # noqa: BLE001
        err(f"完整版 funasr 推理失败：{exc}")
        return False
    finally:
        if wav_tmp:
            shutil.rmtree(wav_tmp, ignore_errors=True)

    if not res:
        err("完整版 funasr 返回空结果。")
        return False
    first = res[0] if isinstance(res, list) else res
    text = _strip_tags(first.get("text", "") if isinstance(first, dict) else str(first))
    if not text:
        err("完整版 funasr 返回空文本。")
        return False

    cues: list[dict] = []
    sent_info = first.get("sentence_info") if isinstance(first, dict) else None
    if isinstance(sent_info, list) and sent_info:
        cues = _cues_from_sentence_info(sent_info)
    elif isinstance(first.get("timestamp") if isinstance(first, dict) else None, list):
        cues = _cues_from_timestamp(text, first["timestamp"]) or []
    if not cues:
        cues = [{"text": text, "start": None, "end": None}]

    diarized = False
    if args.diarize:
        if _run_camplus_diarize(wav if os.path.exists(wav) else audio, args, cues):
            diarized = True
        else:
            log("CAM++ 说话人分离失败，降级为无说话人版本。")

    _fill_missing_times(cues, audio)
    _write_outputs(cues, out_dir, stem, args.formats, diarized=diarized)
    dur = max((c["end"] or 0.0) for c in cues)
    log(f"识别完成 段数={len(cues)} 时长≈{dur:.0f}s（完整版 FunASR"
        f"{'，CAM++ 说话人分离' if diarized else ''}）")
    return True


def _run_camplus_diarize(wav: str, args, cues: list[dict]) -> bool:
    """CAM++ 说话人分离：sv 模型出向量 → 按最大重叠把 spk 区间映射到 cue。"""
    try:
        from funasr import AutoModel
    except Exception:
        err("缺完整版 funasr：pip install funasr（说话人分离需完整版引擎）。")
        return False
    sv_dir = local_model_path(args.sv_model, args.model_dir)
    sv_id = sv_dir or args.sv_model
    log(f"CAM++ 说话人分离中：{sv_id} …")
    try:
        sv_model = AutoModel(model=sv_id, device="cpu", disable_update=True)
        # funasr 的 sv pipeline 需要“句子级 wav + spk 区间”；
        # 此处走简化路径：整段推理拿 spk 区间，再映射到 cue。
        res = sv_model.generate(input=wav)
    except Exception as exc:  # noqa: BLE001
        err(f"CAM++ 推理失败：{exc}")
        return False
    first = res[0] if isinstance(res, list) and res else (res or {})
    ranges = []
    if isinstance(first, dict):
        # 兼容两种形态：sentence_info 带 spk / spk_labels 区间列表
        for s in first.get("sentence_info", []) or []:
            if s.get("spk") is not None:
                ranges.append([s.get("start", 0), s.get("end", 0), s.get("spk")])
        for lab in first.get("spk_labels", []) or []:
            try:
                ranges.append([lab[0], lab[1], lab[2]])
            except (TypeError, IndexError):
                continue
    if not ranges:
        err("CAM++ 未返回说话人区间。")
        return False
    return _assign_speakers_by_range(cues, ranges)


# ---------- 云端兜底 ----------
def file_size_mb(p): return os.path.getsize(p) / 1024 / 1024


def split_audio(audio, chunk_sec=600):
    """超 24MB 时按时长切块，避免云端 25MB 限制。返回 wav 块列表。"""
    tmp = tempfile.mkdtemp(prefix="asr_chunks_")
    pat = os.path.join(tmp, "chunk_%03d.wav")
    subprocess.run([ffmpeg_cmd(), "-y", "-i", audio, "-ar", "16000", "-ac", "1",
                    "-f", "segment", "-segment_time", str(chunk_sec), pat],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    return sorted(glob.glob(os.path.join(tmp, "chunk_*.wav")))


def run_cloud(audio, args, out_dir, stem):
    if args.cloud_provider == "dashscope":
        return run_cloud_dashscope(audio, args, out_dir, stem)
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        err("云端兜底需要 OPENAI_API_KEY 环境变量（或 --cloud-provider dashscope 走国产合规云）。")
        return False
    if not ensure_py_dep("openai", "openai"):
        return False
    try:
        from openai import OpenAI
    except Exception:
        err("缺 openai 库：pip install openai")
        return False
    ensure_ffmpeg()
    log("【降级提示】云端 OpenAI 不做说话人分离；音频将上传第三方——涉密录音请勿使用。")
    client = OpenAI()
    chunks = [audio] if file_size_mb(audio) < 24 else split_audio(audio)
    all_text, idx, srt_lines, offset = [], 1, [], 0.0
    for ci, ch in enumerate(chunks):
        with open(ch, "rb") as fh:
            resp = client.audio.transcriptions.create(
                model=args.cloud_model, file=fh, language=args.lang,
                response_format="verbose_json")
        for seg in getattr(resp, "segments", []) or []:
            st = seg.start + offset; en = seg.end + offset; t = seg.text.strip()
            all_text.append(t)
            srt_lines.append(f"{idx}\n{fmt_ts(st)} --> {fmt_ts(en)}\n{t}\n"); idx += 1
        offset += getattr(resp, "duration", 0) or 0
        log(f"云端块 {ci+1}/{len(chunks)} 完成")
    _write_cloud(out_dir, stem, args.formats, srt_lines, all_text)
    return True


def run_cloud_dashscope(audio, args, out_dir, stem):
    """国产合规云：阿里云 DashScope Paraformer，本地文件直传、无需 OSS。
    比 OpenAI 更适合国内业务（境内节点），但仍属上云——涉密录音同样回避。"""
    key = os.environ.get("DASHSCOPE_API_KEY")
    if not key:
        err("DashScope 兜底需要 DASHSCOPE_API_KEY 环境变量。")
        return False
    if not ensure_py_dep("dashscope", "dashscope"):
        return False
    try:
        import dashscope
        from dashscope.audio.asr import Recognition
    except Exception:
        err("缺 dashscope 库：pip install dashscope")
        return False
    ensure_ffmpeg()
    log("【降级提示】DashScope 不做说话人分离；音频上传阿里云境内节点——涉密录音请勿使用。")
    dashscope.api_key = key
    wav = os.path.join(tempfile.mkdtemp(prefix="asr_ds_"), "in.wav")
    subprocess.run([ffmpeg_cmd(), "-y", "-i", audio, "-ar", "16000", "-ac", "1", wav],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    rec = Recognition(model=args.cloud_model_ds, format="wav", sample_rate=16000, callback=None)
    result = rec.call(wav)
    sents = result.get_sentence() if hasattr(result, "get_sentence") else None
    if not sents:
        err("DashScope 返回空结果，请检查 API key/额度/模型名。")
        return False
    all_text, srt_lines = [], []
    for i, s in enumerate(sents, 1):
        st, en = s["begin_time"] / 1000.0, s["end_time"] / 1000.0
        t = s["text"].strip(); all_text.append(t)
        srt_lines.append(f"{i}\n{fmt_ts(st)} --> {fmt_ts(en)}\n{t}\n")
    _write_cloud(out_dir, stem, args.formats, srt_lines, all_text)
    return True


def _write_cloud(out_dir, stem, formats, srt_lines, all_text):
    os.makedirs(out_dir, exist_ok=True)
    if "srt" in formats:
        open(os.path.join(out_dir, stem + ".srt"), "w", encoding="utf-8").write("\n".join(srt_lines))
    if "txt" in formats:
        open(os.path.join(out_dir, stem + ".txt"), "w", encoding="utf-8").write(
            WATERMARK + "\n\n" + "\n".join(all_text))


def _jobs_dir() -> str:
    """后台任务目录：<缓存根>/../asr-jobs（与模型缓存同级，用户数据目录下）。"""
    return os.path.join(os.path.dirname(model_cache_dir()), "asr-jobs")


def _job_paths(job_id: str) -> dict:
    base = os.path.join(_jobs_dir(), job_id)
    return {"dir": base,
            "args": os.path.join(base, "args.json"),
            "log": os.path.join(base, "task.log"),
            "status": os.path.join(base, "status.json"),
            "pid": os.path.join(base, "pid")}


def _write_status(paths: dict, **fields) -> None:
    import json as _json
    import time as _time
    status = {"updated_at": _time.strftime("%Y-%m-%d %H:%M:%S")}
    try:
        if os.path.exists(paths["status"]):
            with open(paths["status"], "r", encoding="utf-8") as f:
                status.update(_json.load(f))
    except Exception:
        pass
    status.update(fields)
    with open(paths["status"], "w", encoding="utf-8") as f:
        _json.dump(status, f, ensure_ascii=False, indent=2)


def _read_status(paths: dict) -> dict | None:
    import json as _json
    try:
        with open(paths["status"], "r", encoding="utf-8") as f:
            return _json.load(f)
    except Exception:
        return None


def submit_background_job(argv: list[str]) -> str:
    """以后台进程重跑本次转写（去掉 --async），秒退并打印 JOB_ID + 轮询命令。"""
    import datetime as _dt
    import json as _json
    job_id = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    paths = _job_paths(job_id)
    os.makedirs(paths["dir"], exist_ok=True)
    child_argv = [a for a in argv if a != "--async"]
    with open(paths["args"], "w", encoding="utf-8") as f:
        _json.dump(child_argv, f, ensure_ascii=False)
    with open(paths["pid"], "w", encoding="utf-8") as f:
        f.write(str(os.getpid()))
    _write_status(paths, state="queued", progress="任务已提交，后台转写中…")
    log_path = paths["log"]
    child_env = dict(os.environ, ASR_JOB_ID=job_id)
    if os.name == "nt":
        # Windows：DETACHED_PROCESS + 独立日志，bash 返回后进程继续跑
        DETACHED = 0x00000008
        with open(log_path, "ab") as lf:
            subprocess.Popen([sys.executable, os.path.abspath(__file__), *child_argv[1:]],
                             stdout=lf, stderr=subprocess.STDOUT,
                             env=child_env,
                             creationflags=DETACHED, close_fds=True)
    else:
        with open(log_path, "ab") as lf:
            subprocess.Popen([sys.executable, os.path.abspath(__file__), *child_argv[1:]],
                             stdout=lf, stderr=subprocess.STDOUT,
                             env=child_env,
                             start_new_session=True, close_fds=True)
    print(f"[asr] JOB_ID={job_id}")
    print(f"[asr] 后台转写中，轮询：python scripts/transcribe.py --status {job_id}")
    print(f"[asr] 日志：{log_path}")
    return job_id


def show_job_status(job_id: str) -> int:
    """打印后台任务状态。返回码：0=完成，1=失败，2=进行中。"""
    import json as _json
    paths = _job_paths(job_id)
    if not os.path.exists(paths["status"]):
        err(f"任务不存在：{job_id}（目录 {paths['dir']}）")
        return 1
    st = _read_status(paths) or {}
    state = st.get("state", "running")
    print(f"[asr] 任务 {job_id} 状态：{state}")
    if st.get("progress"):
        print(f"[asr] {st['progress']}")
    if state == "done":
        for p in st.get("files", []):
            print(f"File written: {p}")
        return 0
    if state == "failed":
        print(f"[asr] 失败原因：{st.get('error', '未知')}")
        print(f"[asr] 完整日志：{paths['log']}")
        return 1
    # running/queued：尾部日志给 agent 判断进度
    try:
        with open(paths["log"], "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(size - 2000, 0))
            tail = f.read().decode("utf-8", "replace").strip().splitlines()[-5:]
        for line in tail:
            print(f"[asr][log] {line}")
    except Exception:
        pass
    print(f"[asr] 未完成，稍后继续轮询：python scripts/transcribe.py --status {job_id}")
    return 2


def done(out_dir, stem, engine, diar, local, job_paths: dict | None = None):
    files = sorted(glob.glob(os.path.join(out_dir, stem + ".*")))
    abs_files = []
    for p in files:
        try:
            abs_files.append(os.path.abspath(p))
        except Exception:
            abs_files.append(p)
    log("=" * 48)
    log(f"转写完成 | 引擎={engine} | 说话人分离={'是' if diar else '否'} | "
        f"数据{'未出域(本地)' if local else '已上传云端'}")
    # 右侧"产物"面板兜底扫描认 "File written: <绝对路径>" 这一行 ——
    # shell 跑脚本的输出默认不被面板信任，只有这行能被 extractFilePathFromText 抓到。
    # agent 回复里的 artifact 代码块仍是主通道，这里只是双保险。
    for p in abs_files:
        log(f"File written: {p}")
    if job_paths is not None:
        _write_status(job_paths, state="done", progress="转写完成", files=abs_files)
    log("下一步：要出正式纪要走 meeting-minutes 等下游纪要 skill；访谈走 interview-insight。")


def main():
    # --status <JOB_ID>：纯轮询，不做转写（agent 后台任务轮询用）
    if "--status" in sys.argv:
        idx = sys.argv.index("--status")
        try:
            job_id = sys.argv[idx + 1]
        except IndexError:
            err("用法：python scripts/transcribe.py --status <JOB_ID>")
            sys.exit(2)
        sys.exit(show_job_status(job_id))

    ap = argparse.ArgumentParser(description="录音转写（本地 FunASR Paraformer + 云兜底）")
    ap.add_argument("audio", nargs="?", help="音频/视频文件路径")
    ap.add_argument("--engine", choices=["auto", "funasr-onnx", "funasr", "cloud"],
                    default="auto",
                    help="本地引擎：funasr-onnx（默认，INT8 ONNX，依赖最小）/ "
                         "funasr（完整版，支持 --diarize 说话人分离）")
    ap.add_argument("--lang", default="zh", help="语种，中文录音务必 zh（本地 Paraformer 主打中文/中英混说）")
    ap.add_argument("--model", default="onnx",
                    help="本地模型：onnx（默认，Paraformer-Large INT8 ONNX）/ "
                         "ModelScope ID / 本地模型目录绝对路径")
    ap.add_argument("--model-dir", default="",
                    help=f"本地模型缓存根目录（默认：{DEFAULT_MODEL_DIR}）")
    ap.add_argument("--sv-model", default=FUNASR_SV_MODEL_ID,
                    help="CAM++ 说话人向量模型（ModelScope ID 或本地目录）")
    ap.add_argument("--quantize", action=argparse.BooleanOptionalAction, default=True,
                    help="ONNX 是否启用 INT8 量化推理（默认开；低配机勿关）")
    ap.add_argument("--cloud-provider", choices=["openai", "dashscope"], default="openai",
                    help="云兜底服务商：openai 或 dashscope(阿里云·国产合规)")
    ap.add_argument("--cloud-model", default="whisper-1", help="OpenAI 云端模型，如 gpt-4o-transcribe")
    ap.add_argument("--cloud-model-ds", default="paraformer-realtime-v2", help="DashScope 模型名")
    ap.add_argument("--diarize", action="store_true",
                    help="说话人分离（需完整版 funasr + CAM++，自动切换 --engine funasr）")
    ap.add_argument("--speakers", type=int, default=0, help="已知确切人数（预留，当前 CAM++ 自动聚类）")
    ap.add_argument("--min-speakers", type=int, default=0, help="预留（兼容旧命令）")
    ap.add_argument("--max-speakers", type=int, default=0, help="预留（兼容旧命令）")
    ap.add_argument("--formats", default="srt,txt", help="逗号分隔：srt,vtt,txt")
    ap.add_argument("--output-dir", default="./outputs")
    ap.add_argument("--device", default="cpu", help="cpu 或 cuda（仅完整版 funasr 有效）")
    ap.add_argument("--batch-size", type=int, default=8)
    ap.add_argument("--hf-token", default="",
                    help="已废弃：FunASR 本地说话人分离不再需要 HF_TOKEN，保留仅为兼容旧命令")
    ap.add_argument("--hint-words", default="", help="术语/人名热词（完整版 funasr 生效）")
    ap.add_argument("--async", dest="run_async", action="store_true",
                    help="后台任务模式：提交后秒退，打印 JOB_ID，用 --status <JOB_ID> 轮询。长录音/首次下载必用，避免占住工具调用超时")
    args = ap.parse_args()
    args.formats = [x.strip() for x in args.formats.split(",") if x.strip()] or ["srt"]

    if args.hf_token:
        log("提示：--hf-token 已废弃（FunASR 无需 HuggingFace token），已忽略。")

    # 后台模式：先落盘任务再秒退，真正的转写在子进程里跑
    if args.run_async:
        if not args.audio:
            err("--async 需要同时给音频路径"); sys.exit(2)
        submit_background_job(sys.argv)
        return

    # 子进程（后台任务）携带 ASR_JOB_ID 环境变量：done()/失败时写 status.json
    job_id = os.environ.get("ASR_JOB_ID", "").strip()
    _bg_paths = _job_paths(job_id) if job_id else None
    if _bg_paths is not None:
        _write_status(_bg_paths, state="running", progress="转写进行中…")

    try:
        _run(args, _bg_paths)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — 后台任务异常必须落盘，否则轮询永远 running
        err(f"转写异常：{exc}")
        if _bg_paths is not None:
            _write_status(_bg_paths, state="failed", error=str(exc))
        sys.exit(1)
    except BaseException as exc:  # KeyboardInterrupt / 进程被杀同样落盘
        if _bg_paths is not None:
            _write_status(_bg_paths, state="failed", error=f"{type(exc).__name__}: {exc}")
        raise


def _run(args, _bg_paths: dict | None = None):
    if not args.audio:
        err("缺少音频路径"); sys.exit(2)
    audio = os.path.abspath(args.audio)
    if not os.path.exists(audio):
        err(f"文件不存在：{audio}"); sys.exit(2)
    if os.path.splitext(audio)[1].lower() not in AUDIO_EXT:
        log(f"警告：扩展名 {os.path.splitext(audio)[1]} 非常见音频格式，仍尝试解码。")
    stem = stem_of(audio)
    out_dir = os.path.abspath(args.output_dir)

    if args.engine in ("auto", "funasr-onnx", "funasr"):
        ensure_ffmpeg()
        # --diarize 强制完整版 funasr（ONNX 不做说话人分离）
        want = "funasr" if args.diarize else (
            args.engine if args.engine in ("funasr-onnx", "funasr") else "funasr-onnx")
        local = local_model_path(args.model if want == "funasr-onnx" else
                                 ("funasr" if args.model == "onnx" else args.model),
                                 args.model_dir)
        if local:
            log(f"使用本地模型缓存：{model_cache_dir(args.model_dir)}（离线可用，不再联网下载）")
        else:
            log(f"本地缓存未命中，将按需从 ModelScope 拉取到 {model_cache_dir(args.model_dir)}。"
                f"离线环境可先用 scripts/download_model.py 预下载。")
        if want == "funasr":
            if run_funasr_full(audio, args, out_dir, stem):
                done(out_dir, stem, "本地完整版 FunASR",
                     args.diarize, True, _bg_paths); return
            if args.diarize and args.engine == "funasr":
                err("完整版 funasr/说话人分离失败.")
                if _bg_paths is not None:
                    _write_status(_bg_paths, state="failed",
                                  error="完整版 funasr/说话人分离失败")
                sys.exit(1)
            log("完整版 funasr 不可用，回退 funasr-onnx …")
        if run_funasr_onnx(audio, args, out_dir, stem):
            done(out_dir, stem, "本地 FunASR-ONNX（Paraformer-Large INT8）", False, True,
                 _bg_paths)
            return
        if args.engine in ("funasr-onnx", "funasr"):
            err("本地引擎不可用。请按 references/install.md 安装 funasr-onnx 或 funasr。")
            if _bg_paths is not None:
                _write_status(_bg_paths, state="failed", error="本地引擎不可用")
            sys.exit(1)
        err("本地不可用。如需上云请显式 --engine cloud（音频会上传第三方，涉密录音回避）。")
        if _bg_paths is not None:
            _write_status(_bg_paths, state="failed", error="本地引擎不可用")
        sys.exit(1)

    if args.engine == "cloud":
        label = f"云端 {args.cloud_provider}/" + (
            args.cloud_model_ds if args.cloud_provider == "dashscope" else args.cloud_model)
        if run_cloud(audio, args, out_dir, stem):
            done(out_dir, stem, label, False, False, _bg_paths); return
        if _bg_paths is not None:
            _write_status(_bg_paths, state="failed", error="云端转写失败")
        sys.exit(1)


if __name__ == "__main__":
    main()
