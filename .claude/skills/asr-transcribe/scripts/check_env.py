#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""环境自检：本地 FunASR 栈（ONNX / 完整版 / CAM++）+ 内置 ffmpeg + 云兜底 + 模型缓存。"""
from __future__ import annotations

import glob
import os
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


def resolve_model_dir() -> str:
    if os.environ.get("ASR_MODEL_DIR", "").strip():
        return os.environ["ASR_MODEL_DIR"].strip()
    legacy = os.environ.get("ASR_WHISPER_MODEL_DIR", "").strip()
    if legacy and os.path.isdir(legacy):
        return legacy
    return os.path.join(os.path.expanduser("~"), ".cache", "funasr")


def cached_models(model_dir: str) -> list[str]:
    if not os.path.isdir(model_dir):
        return []
    found = []
    for p in Path(model_dir).iterdir():
        if not p.is_dir():
            continue
        if (glob.glob(str(p / "*.onnx")) or glob.glob(str(p / "*.pt"))
                or (p / "model.pt").exists() or (p / "model.onnx").exists()):
            found.append(p.name)
    return sorted(found)


def main() -> None:
    bundled = bundled_ffmpeg_path()
    ff = bundled is not None or has("ffmpeg")
    onnx = mod("funasr_onnx")
    full = mod("funasr")
    ms = mod("modelscope")
    oa = bool(os.environ.get("OPENAI_API_KEY"))
    ds = bool(os.environ.get("DASHSCOPE_API_KEY"))
    model_dir = resolve_model_dir()
    found_models = cached_models(model_dir)

    print("=== asr-transcribe 环境自检（FunASR Paraformer-Large）===")
    if bundled:
        print(f"内置 ffmpeg                : OK ({bundled})")
    else:
        print("内置 ffmpeg                : 未找到")
    print(f"系统 ffmpeg                : {'OK' if has('ffmpeg') else '缺失'}")
    print(f"funasr-onnx(默认/INT8/离线): {'OK' if onnx else '缺失'}")
    print(f"完整版 funasr(标点/分离)   : {'OK' if full else '缺失'}")
    print(f"modelscope(模型下载)       : {'OK' if ms else '缺失'}")
    print(f"模型缓存目录               : {model_dir}")
    print(f"已缓存模型                 : {', '.join(found_models) if found_models else '无'}")
    print(f"OPENAI_API_KEY(云兜底)      : {'已设' if oa else '未设'}")
    print(f"DASHSCOPE_API_KEY(国产云)   : {'已设' if ds else '未设'}")
    print("-" * 38)

    if ff and onnx and full and found_models:
        print("结论：可走【本地完整版 FunASR + CAM++ 说话人分离】，最优。数据不出域。")
    elif ff and onnx and found_models:
        print("结论：可走【本地 FunASR-ONNX INT8】（无说话人分离；要分离请装完整版 funasr）。数据不出域。")
    elif ff and (onnx or full):
        print("结论：引擎已装但模型未缓存；跑 scripts/download_model.py 预下载后即可离线。")
    elif oa or ds:
        prov = "阿里云 DashScope(国产合规)" if ds else "OpenAI"
        print(f"结论：本地未就绪；可走云端({prov})。上云前须征得用户同意（涉密录音回避）。")
    else:
        print("结论：均未就绪。请按 references/install.md 安装本地引擎（推荐）。")
    print("安装命令见：references/install.md")


if __name__ == "__main__":
    main()
