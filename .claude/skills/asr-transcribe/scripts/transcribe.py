#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
asr-transcribe / transcribe.py  (v1.1)
录音转写主脚本：本地优先（whisperX / faster-whisper）+ 云端兜底（OpenAI / 阿里云 DashScope）。
支持 m4a/mp3/wav/aac/flac/ogg/mp4/mov；输出 .srt/.vtt/.txt（本地可带说话人分离）。

设计原则（对应保密红线）：
- 默认本地、数据不出域；--engine cloud 必须由调用方在征得用户同意后显式指定。
- 云端不做说话人分离，脚本会显式打印降级提示；token 不在日志回显。
- 所有 .txt 顶部写入"机器转写未校对"水印。
"""
import argparse, os, sys, shutil, subprocess, tempfile, glob
from pathlib import Path

WATERMARK = "[本文为 ASR 机器转写，专名/数字/口径以原音频为准，未经人工校对]"
AUDIO_EXT = {".m4a", ".mp3", ".wav", ".aac", ".flac", ".ogg", ".mp4", ".mov", ".wma", ".amr"}

# 本地模型缓存根目录：优先 --model-dir / ASR_WHISPER_MODEL_DIR 环境变量（由今点通主进程注入到 userData/models/whisper），
# fallback 到 ~/.cache/whisper（跨平台通用，不依赖任何特定开发机布局）。
DEFAULT_MODEL_DIR = os.path.join(os.path.expanduser("~"), ".cache", "whisper")
HF_MIRROR = "https://hf-mirror.com"


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
    """返回本地模型缓存根目录。优先显式指定，其次环境变量，最后默认目录。"""
    return (
        model_dir.strip()
        or os.environ.get("ASR_WHISPER_MODEL_DIR", "").strip()
        or DEFAULT_MODEL_DIR
    )


def local_model_path(model_name: str, model_dir: str = "") -> str | None:
    """查找本地缓存中是否已有对应模型（模型名可能是 large-v3/medium/small...，也可能是
    SysTran/faster-whisper-medium 风格的完整 repo id）。返回存在的目录路径，否则 None。"""
    # 支持直接传完整路径
    if os.path.isdir(model_name) and os.path.exists(os.path.join(model_name, "model.bin")):
        return model_name

    name = model_name.rsplit("/", 1)[-1]
    candidates = [
        os.path.join(model_cache_dir(model_dir), name),
        os.path.join(model_cache_dir(model_dir), model_name),
    ]
    # large-v3 的 CPU int8 权重文件名是 model.bin；部分模型可能是 ggml-*.bin
    for cand in candidates:
        if (
            os.path.isdir(cand)
            and (
                os.path.exists(os.path.join(cand, "model.bin"))
                or glob.glob(os.path.join(cand, "*.bin"))
            )
        ):
            return cand
    return None


def ensure_hf_endpoint():
    """离线模型不存在且未指定 HF_ENDPOINT 时，默认走 hf-mirror 镜像（中国大陆可直连）。"""
    if not os.environ.get("HF_ENDPOINT"):
        os.environ["HF_ENDPOINT"] = HF_MIRROR
        log(f"未设置 HF_ENDPOINT，默认使用镜像：{HF_MIRROR}")


def mod_ok(name):
    try:
        __import__(name); return True
    except Exception:
        return False


def ensure_ffmpeg():
    if bundled_ffmpeg_path() or has("ffmpeg"):
        return
    err("未检测到 ffmpeg。优先把 ffmpeg.exe 放到 resources/ffmpeg/windows/ffmpeg.exe，或者安装系统 ffmpeg（见 references/install.md）。")
    sys.exit(2)


def fmt_ts(t, vtt=False):
    h = int(t // 3600); m = int((t % 3600) // 60); s = int(t % 60); ms = int((t - int(t)) * 1000)
    sep = "." if vtt else ","
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


# ---------- 本地：whisperX（支持说话人分离）----------
def run_whisperx(audio, args, out_dir):
    if not has("whisperx") and not mod_ok("whisperx"):
        return False
    # 优先用本地缓存模型（离线可用）
    local = local_model_path(args.model, args.model_dir)
    model_arg = local if local else args.model
    if local:
        log(f"使用本地缓存模型：{local}")
    else:
        ensure_hf_endpoint()
    # whisperX/whisper 的 --output_format 只收单值或 "all"，不收 "srt,txt" 逗号串。
    # 多格式一律传 "all"，跑完再裁掉用户没要的扩展名（修 v1.0 静默失败 bug）。
    multi = len(args.formats) > 1
    fmt = "all" if multi else args.formats[0]
    cmd = ["whisperx", audio,
           "--model", model_arg,
           "--language", args.lang,
           "--output_dir", out_dir,
           "--output_format", fmt,
           "--compute_type", args.compute_type,
           "--batch_size", str(args.batch_size),
           "--device", args.device]
    if args.diarize:
        cmd.append("--diarize")
        token = args.hf_token or os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
        if not token:
            err("--diarize 需要 HuggingFace token：去 hf.co 接受 speaker-diarization 模型协议，"
                "用 --hf-token 传入或设 HF_TOKEN 环境变量。或先去掉 --diarize 出无说话人版本。")
            return False
        cmd += ["--hf_token", token]
        if args.speakers:
            cmd += ["--min_speakers", str(args.speakers), "--max_speakers", str(args.speakers)]
        else:
            if args.min_speakers: cmd += ["--min_speakers", str(args.min_speakers)]
            if args.max_speakers: cmd += ["--max_speakers", str(args.max_speakers)]
    if args.hint_words:
        cmd += ["--initial_prompt", args.hint_words]
    safe = ["***" if c.startswith("hf_") else c for c in cmd]   # 日志隐去 token
    log("本地 whisperX 转写中（数据不出域）：\n  " + " ".join(safe))
    if subprocess.run(cmd).returncode != 0:
        return False
    if multi:   # 裁掉用户没要的扩展名（whisperX 一次出 srt/vtt/txt/tsv/json）
        keep = {"." + e for e in args.formats}
        for p in glob.glob(os.path.join(out_dir, stem_of(audio) + ".*")):
            if os.path.splitext(p)[1].lower() not in keep:
                try: os.remove(p)
                except OSError: pass
    return True


# ---------- 本地：faster-whisper（无说话人分离，轻量兜底）----------
def run_faster_whisper(audio, args, out_dir, stem):
    if not mod_ok("faster_whisper"):
        return False
    from faster_whisper import WhisperModel
    # 优先用本地缓存模型（离线可用）
    local = local_model_path(args.model, args.model_dir)
    model_arg = local if local else args.model
    if local:
        log(f"使用本地缓存模型：{model_arg}")
    else:
        ensure_hf_endpoint()
    log("本地 faster-whisper 转写中（无说话人分离，数据不出域）……")
    model = WhisperModel(model_arg, device=args.device, compute_type=args.compute_type)
    segments, info = model.transcribe(audio, language=args.lang,
                                      initial_prompt=args.hint_words or None, vad_filter=True)
    segs = list(segments)
    _write_outputs(segs, out_dir, stem, args.formats)
    log(f"识别语种={info.language} 时长≈{info.duration:.0f}s 段数={len(segs)}")
    return True


def _write_outputs(segs, out_dir, stem, formats):
    os.makedirs(out_dir, exist_ok=True)
    if "srt" in formats:
        with open(os.path.join(out_dir, stem + ".srt"), "w", encoding="utf-8") as f:
            for i, s in enumerate(segs, 1):
                f.write(f"{i}\n{fmt_ts(s.start)} --> {fmt_ts(s.end)}\n{s.text.strip()}\n\n")
    if "vtt" in formats:
        with open(os.path.join(out_dir, stem + ".vtt"), "w", encoding="utf-8") as f:
            f.write("WEBVTT\n\n")
            for s in segs:
                f.write(f"{fmt_ts(s.start, True)} --> {fmt_ts(s.end, True)}\n{s.text.strip()}\n\n")
    if "txt" in formats:
        with open(os.path.join(out_dir, stem + ".txt"), "w", encoding="utf-8") as f:
            f.write(WATERMARK + "\n\n" + "\n".join(s.text.strip() for s in segs))


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


def done(out_dir, stem, engine, diar, local):
    files = glob.glob(os.path.join(out_dir, stem + ".*"))
    log("=" * 48)
    log(f"转写完成 | 引擎={engine} | 说话人分离={'是' if diar else '否'} | "
        f"数据{'未出域(本地)' if local else '已上传云端'}")
    for p in files: log(f"  -> {p}")
    log("下一步：要出正式纪要走 meeting-minutes 等下游纪要 skill；访谈走 interview-insight。")


def main():
    ap = argparse.ArgumentParser(description="录音转写（本地优先 + 云兜底）")
    ap.add_argument("audio", help="音频/视频文件路径")
    ap.add_argument("--engine", choices=["auto", "local", "cloud"], default="auto")
    ap.add_argument("--lang", default="zh", help="语种，中文录音务必 zh")
    ap.add_argument("--model", default="large-v3", help="本地模型，弱机用 medium/small；也接受本地模型目录路径")
    ap.add_argument("--model-dir", default="",
                    help=f"本地模型缓存根目录（默认：{DEFAULT_MODEL_DIR}）。目录下按模型名分子目录，如 <dir>/medium/model.bin")
    ap.add_argument("--cloud-provider", choices=["openai", "dashscope"], default="openai",
                    help="云兜底服务商：openai 或 dashscope(阿里云·国产合规)")
    ap.add_argument("--cloud-model", default="whisper-1", help="OpenAI 云端模型，如 gpt-4o-transcribe")
    ap.add_argument("--cloud-model-ds", default="paraformer-realtime-v2", help="DashScope 模型名")
    ap.add_argument("--diarize", action="store_true", help="说话人分离（仅本地 whisperX）")
    ap.add_argument("--speakers", type=int, default=0, help="已知确切人数")
    ap.add_argument("--min-speakers", type=int, default=0)
    ap.add_argument("--max-speakers", type=int, default=0)
    ap.add_argument("--formats", default="srt,txt", help="逗号分隔：srt,vtt,txt")
    ap.add_argument("--output-dir", default="./outputs")
    ap.add_argument("--device", default="cpu", help="cpu 或 cuda")
    ap.add_argument("--compute-type", default="int8", help="CPU 用 int8，GPU 用 float16")
    ap.add_argument("--batch-size", type=int, default=8)
    ap.add_argument("--hf-token", default="")
    ap.add_argument("--hint-words", default="", help="术语/人名热词，提升专名准确率")
    args = ap.parse_args()
    args.formats = [x.strip() for x in args.formats.split(",") if x.strip()] or ["srt"]

    audio = os.path.abspath(args.audio)
    if not os.path.exists(audio):
        err(f"文件不存在：{audio}"); sys.exit(2)
    if os.path.splitext(audio)[1].lower() not in AUDIO_EXT:
        log(f"警告：扩展名 {os.path.splitext(audio)[1]} 非常见音频格式，仍尝试解码。")
    stem = stem_of(audio)
    out_dir = os.path.abspath(args.output_dir)

    if args.engine in ("auto", "local"):
        ensure_ffmpeg()
        local = local_model_path(args.model, args.model_dir)
        if local:
            log(f"使用本地模型缓存：{model_cache_dir(args.model_dir)}（离线可用，不再联网下载）")
        else:
            log(f"本地缓存未命中 model={args.model}，将尝试下载模型到 {model_cache_dir(args.model_dir)}。"
                f"离线环境可先用 scripts/download_model.py 预下载。")
        if args.diarize or has("whisperx") or mod_ok("whisperx"):
            if run_whisperx(audio, args, out_dir):
                done(out_dir, stem, "本地 whisperX", args.diarize, True); return
            if args.diarize and args.engine == "local":
                err("whisperX/说话人分离失败。"); sys.exit(1)
        if run_faster_whisper(audio, args, out_dir, stem):
            done(out_dir, stem, "本地 faster-whisper", False, True); return
        if args.engine == "local":
            err("本地引擎不可用。请按 references/install.md 安装 whisperx 或 faster-whisper。")
            sys.exit(1)
        err("本地不可用。如需上云请显式 --engine cloud（音频会上传第三方，涉密录音回避）。")
        sys.exit(1)

    if args.engine == "cloud":
        label = f"云端 {args.cloud_provider}/" + (
            args.cloud_model_ds if args.cloud_provider == "dashscope" else args.cloud_model)
        if run_cloud(audio, args, out_dir, stem):
            done(out_dir, stem, label, False, False); return
        sys.exit(1)


if __name__ == "__main__":
    main()
