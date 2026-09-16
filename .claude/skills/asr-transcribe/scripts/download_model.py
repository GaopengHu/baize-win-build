#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
asr-transcribe / download_model.py  (v1.0)
Whisper 模型预下载脚本：把模型提前下载到本地缓存目录，之后转写完全离线，
不再每次联网。默认走 hf-mirror.com 镜像（中国大陆可直连）。

用法（推荐）：
    # 下载 medium 到默认缓存目录（~/.cache/whisper/medium）
    python scripts/download_model.py --model medium

    # 下载 large-v3 到指定目录
    python scripts/download_model.py --model large-v3 --model-dir D:\models\whisper

    # 指定镜像
    python scripts/download_model.py --model small --endpoint https://hf-mirror.com
"""
import argparse
import os
import sys


DEFAULT_MODEL_DIR = os.path.join(os.path.expanduser("~"), ".cache", "whisper")
HF_MIRROR = "https://hf-mirror.com"


def main():
    ap = argparse.ArgumentParser(description="预下载 Whisper / faster-whisper 模型到本地缓存")
    ap.add_argument("--model", default="medium",
                    help="模型名：tiny/base/small/medium/large-v3（默认 medium，中文质量与体积平衡）")
    ap.add_argument("--model-dir", default="",
                    help=f"缓存根目录（默认：{DEFAULT_MODEL_DIR}），模型会下载到 <dir>/<model>/")
    ap.add_argument("--endpoint", default="",
                    help="HuggingFace 端点；不填默认使用 hf-mirror.com，可设 --endpoint '' 走官方源")
    args = ap.parse_args()

    model_dir = (
        args.model_dir.strip()
        or os.environ.get("ASR_WHISPER_MODEL_DIR", "").strip()
        or DEFAULT_MODEL_DIR
    )

    # 镜像端点：默认 hf-mirror；显式传空串则用官方
    if args.endpoint is not None and args.endpoint != "":
        os.environ["HF_ENDPOINT"] = args.endpoint
    elif not os.environ.get("HF_ENDPOINT"):
        os.environ["HF_ENDPOINT"] = HF_MIRROR
        print(f"[download] 未指定端点，使用镜像：{HF_MIRROR}")

    # faster-whisper 的仓库命名：SysTran/faster-whisper-<model>
    repo_ids = [
        f"Systran/faster-whisper-{args.model}",
        f"openai/whisper-{args.model}",
    ]

    try:
        from huggingface_hub import snapshot_download
    except Exception as exc:
        print(f"[download] 缺少 huggingface_hub：pip install -U huggingface_hub （原始错误：{exc}）")
        sys.exit(1)

    target = os.path.join(model_dir, args.model)
    os.makedirs(target, exist_ok=True)

    last_err = None
    for repo_id in repo_ids:
        print(f"[download] 尝试 {repo_id} -> {target}")
        try:
            snapshot_download(
                repo_id=repo_id,
                local_dir=target,
                resume_download=True,
            )
            # 校验关键文件存在
            bin_files = [f for f in os.listdir(target) if f.endswith(".bin")]
            if not bin_files:
                print(f"[download] 警告：{target} 下未发现 .bin 权重文件，尝试下一个仓库…")
                continue
            print(f"[download] 完成：{repo_id} 已下载到 {target}")
            print(f"[download] 之后转写可离线使用：--model-dir \"{model_dir}\" 或 ASR_WHISPER_MODEL_DIR={model_dir}")
            return
        except Exception as exc:  # noqa: BLE001 — 逐仓库尝试，失败继续
            last_err = exc
            print(f"[download] {repo_id} 失败：{exc}")

    print(f"[download] 全部仓库下载失败，最后一次错误：{last_err}")
    print("[download] 可尝试：--endpoint https://hf-mirror.com，或手动从 hf-mirror.com 下载后解压到 "
          f"以下目录（需含 model.bin / config.json / tokenizer.json / vocabulary.txt）：")
    print(f"          {target}")
    sys.exit(1)


if __name__ == "__main__":
    main()