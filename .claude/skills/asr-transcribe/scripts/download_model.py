#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
asr-transcribe / download_model.py  (v2.0)
FunASR 模型预下载脚本：把模型提前下载到本地缓存目录，之后转写完全离线。
默认走 ModelScope（中国大陆可直连，无需翻墙；内网环境请走离线拷贝，见 install.md）。

用法：
    python scripts/download_model.py --status                      # 只看缓存状态
    python scripts/download_model.py --model onnx                   # 默认：Paraformer-Large INT8 ONNX（约238MB）
    python scripts/download_model.py --model all                    # ONNX + 完整版 funasr（VAD/标点/CAM++）
    python scripts/download_model.py --model full                   # 同 all
    python scripts/download_model.py --model sv                     # 仅 CAM++ 说话人向量模型
    python scripts/download_model.py --model onnx --model-dir D:\\models\\funasr
"""
from __future__ import annotations

import argparse
import os
import sys

DEFAULT_MODEL_DIR = os.path.join(os.path.expanduser("~"), ".cache", "funasr")

DEFAULT_ONNX_MODEL_ID = "damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx"
FUNASR_MODEL_ID = "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
FUNASR_VAD_MODEL_ID = "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"
FUNASR_PUNC_MODEL_ID = "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch"
FUNASR_SV_MODEL_ID = "iic/speech_campplus_sv_zh-cn_16k-common"

PRESETS: dict[str, list[str]] = {
    "onnx": [DEFAULT_ONNX_MODEL_ID],
    "full": [FUNASR_MODEL_ID, FUNASR_VAD_MODEL_ID, FUNASR_PUNC_MODEL_ID, FUNASR_SV_MODEL_ID],
    "all": [DEFAULT_ONNX_MODEL_ID, FUNASR_MODEL_ID, FUNASR_VAD_MODEL_ID,
            FUNASR_PUNC_MODEL_ID, FUNASR_SV_MODEL_ID],
    "sv": [FUNASR_SV_MODEL_ID],
}


def resolve_model_dir(cli_dir: str = "") -> str:
    if cli_dir.strip():
        return cli_dir.strip()
    new_var = os.environ.get("ASR_MODEL_DIR", "").strip()
    if new_var:
        return new_var
    legacy = os.environ.get("ASR_WHISPER_MODEL_DIR", "").strip()
    if legacy and os.path.isdir(legacy):
        return legacy
    return DEFAULT_MODEL_DIR


def cache_status(model_dir: str) -> dict[str, bool]:
    """各预设是否已缓存（目录存在且含权重文件）。"""
    import glob as _glob

    def hit(folder: str) -> bool:
        d = os.path.join(model_dir, folder.rsplit("/", 1)[-1])
        return os.path.isdir(d) and bool(
            _glob.glob(os.path.join(d, "*.onnx"))
            + _glob.glob(os.path.join(d, "*.pt"))
            + _glob.glob(os.path.join(d, "model.*"))
        )

    return {
        "onnx(默认/离线首选)": hit(DEFAULT_ONNX_MODEL_ID),
        "完整版 funasr(转写)": hit(FUNASR_MODEL_ID),
        "VAD": hit(FUNASR_VAD_MODEL_ID),
        "标点": hit(FUNASR_PUNC_MODEL_ID),
        "CAM++(说话人分离)": hit(FUNASR_SV_MODEL_ID),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="预下载 FunASR 模型到本地缓存（ModelScope）")
    ap.add_argument("--model", default="onnx",
                    help="onnx（默认）/ full / all / sv，或单个 ModelScope ID")
    ap.add_argument("--model-dir", default="",
                    help=f"缓存根目录（默认：{DEFAULT_MODEL_DIR}）")
    ap.add_argument("--status", action="store_true", help="只打印缓存状态，不下载")
    args = ap.parse_args()

    model_dir = resolve_model_dir(args.model_dir)

    if args.status:
        print(f"[download] 缓存目录：{model_dir}")
        for name, ok in cache_status(model_dir).items():
            print(f"[download]   {'[已缓存]' if ok else '[缺失]  '} {name}")
        return

    key = args.model.strip()
    if key in PRESETS:
        repo_ids = PRESETS[key]
    elif "/" in key:
        repo_ids = [key]
    else:
        print(f"[download] 未知 --model={key!r}，可用：onnx / full / all / sv / <ModelScope ID>")
        sys.exit(2)

    try:
        from modelscope.hub.snapshot_download import snapshot_download
    except Exception as exc:
        print(f"[download] 缺少 modelscope：pip install -U modelscope （原始错误：{exc}）")
        sys.exit(1)

    os.makedirs(model_dir, exist_ok=True)
    failed: list[str] = []
    for repo_id in repo_ids:
        target = os.path.join(model_dir, repo_id.rsplit("/", 1)[-1])
        print(f"[download] {repo_id} -> {target}")
        try:
            snapshot_download(repo_id, local_dir=target)
            print(f"[download] 完成：{target}")
        except Exception as exc:  # noqa: BLE001 — 逐个尝试，失败继续
            print(f"[download] {repo_id} 失败：{exc}")
            failed.append(repo_id)

    if failed:
        print(f"[download] {len(failed)} 个失败：{failed}。内网环境请走离线拷贝（见 install.md）。")
        sys.exit(1)
    print(f"[download] 全部完成。转写可离线使用（--model-dir \"{model_dir}\" "
          f"或 ASR_MODEL_DIR={model_dir}）。")


if __name__ == "__main__":
    main()
