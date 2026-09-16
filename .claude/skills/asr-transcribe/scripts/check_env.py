#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""环境自检：优先探测应用内置 ffmpeg，再探测系统 ffmpeg。"""
from __future__ import annotations

import os
import platform
import shutil
from pathlib import Path


def has(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def mod(name: str) -> bool:
    try:
        __import__(name)
        return True
    except Exception:
        return False


def bundled_ffmpeg_path() -> Path | None:
    """返回应用内置 ffmpeg 的路径（开发态和打包态都兼容）。"""
    candidates = []

    # 1) 允许用环境变量显式覆盖（由 Electron 主进程注入）
    env_path = os.environ.get("ASR_FFMPEG_PATH", "").strip()
    if env_path:
        candidates.append(Path(env_path))

    # 2) 项目源码目录下的内置资源
    project_root = Path(__file__).resolve().parents[3]
    candidates.append(project_root / "resources" / "ffmpeg" / "windows" / "ffmpeg.exe")

    # 3) 打包后 resources 目录（如果未来把 ffmpeg 跟着 extraResources 打进去）
    app_root = Path(__file__).resolve().parents[4]
    candidates.append(app_root / "resources" / "ffmpeg" / "windows" / "ffmpeg.exe")

    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def main() -> None:
    bundled = bundled_ffmpeg_path()
    ff = bundled is not None or has("ffmpeg")
    wx = has("whisperx") or mod("whisperx")
    fw = mod("faster_whisper")
    hf = bool(os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN"))
    oa = bool(os.environ.get("OPENAI_API_KEY"))
    ds = bool(os.environ.get("DASHSCOPE_API_KEY"))
    model_dir = (
        os.environ.get("ASR_WHISPER_MODEL_DIR", "").strip()
        or os.path.join(os.path.expanduser("~"), ".cache", "whisper")
    )
    found_models = sorted(
        p.name for p in Path(model_dir).glob("*") if p.is_dir() and list(p.glob("*.bin"))
    ) if os.path.isdir(model_dir) else []

    print("=== asr-transcribe 环境自检 ===")
    if bundled:
        print(f"内置 ffmpeg             : OK ({bundled})")
    else:
        print(f"内置 ffmpeg             : 未找到")
    print(f"系统 ffmpeg             : {'OK' if has('ffmpeg') else '缺失'}")
    print(f"whisperX(转写+说话人分离): {'OK' if wx else '缺失'}")
    print(f"faster-whisper(轻量兜底) : {'OK' if fw else '缺失'}")
    print(f"模型缓存目录            : {model_dir}")
    print(f"已缓存模型              : {', '.join(found_models) if found_models else '无'}")
    print(f"HF_TOKEN(说话人分离需要) : {'已设' if hf else '未设'}")
    print(f"OPENAI_API_KEY(云兜底)   : {'已设' if oa else '未设'}")
    print(f"DASHSCOPE_API_KEY(国产云): {'已设' if ds else '未设'}")
    print("-" * 34)

    if ff and wx and hf:
        print("结论：可走【本地 + 说话人分离】，最优。数据不出域。")
    elif ff and wx:
        print("结论：可走【本地 whisperX】（无说话人分离需设 HF_TOKEN）。数据不出域。")
    elif ff and fw:
        print("结论：可走【本地 faster-whisper】（无说话人分离）。数据不出域。")
    elif oa or ds:
        prov = "阿里云 DashScope(国产合规)" if ds else "OpenAI"
        print(f"结论：本地未就绪；可走云端({prov})。上云前须征得用户同意（涉密录音回避）。")
    else:
        print("结论：均未就绪。请按 references/install.md 安装本地引擎（推荐）。")
    print("安装命令见：references/install.md")


if __name__ == "__main__":
    main()
