# asr-transcribe 安装与环境引导

## Python 环境约定
- 打包后的应用中，主进程会把 bundled Python 目录加入 PATH，直接用 `python`（Windows）或 `python3`（macOS/Linux）即可。
- 开发环境：使用系统 Python。
- **安装包**：`python -m pip install <包名>`
- 本 skill 不再使用任何 whisper 系模型（whisperX / faster-whisper / openai-whisper 均已移除，也不要再装）。

## 推荐路径：本地引擎（数据不出域，国企/央企录音首选）

本地引擎 = FunASR Paraformer-Large（阿里达摩院，非自回归，AISHELL-1 CER 约 2.8%，真实噪音中文显著优于 Whisper）。

### 1. ffmpeg（必装，负责解码 m4a / 切块）
- 优先方案：今点通会自动查找应用内置 ffmpeg（`resources/ffmpeg/windows/ffmpeg.exe`），并注入 `ASR_FFMPEG_PATH` 环境变量，用户无需额外安装
- Windows 临时方案：`winget install Gyan.FFmpeg --silent --accept-package-agreements --accept-source-agreements`（或 `choco install ffmpeg`），装完重开终端
- macOS：`brew install ffmpeg`
- Linux：`sudo apt install ffmpeg`
- 验证：`ffmpeg -version`

### 2. 默认引擎：funasr-onnx（INT8 量化，弱机/离线首选）
```
python -m pip install funasr-onnx modelscope
python scripts/download_model.py --model onnx     # Paraformer-Large INT8 ONNX，约 238MB
python scripts/transcribe.py "会议录音.m4a" --lang zh --formats srt,txt
```
- 依赖只有 onnxruntime + numpy，无需 torch，CPU 极快。
- 首次运行会自动从 ModelScope 拉模型（需联网一次）；之后完全离线。
- ONNX 版不做说话人分离（要分离见第 3 步）。

### 3. 完整版 funasr（自动标点 + CAM++ 说话人分离）
```
python -m pip install funasr modelscope
python scripts/download_model.py --model full     # 转写+VAD+标点+CAM++，约 2GB
python scripts/transcribe.py "会议录音.m4a" --engine funasr --diarize --lang zh --formats srt,txt
```
- `--diarize` 用 CAM++ 说话人向量模型做分离，**不再需要 HuggingFace token**（pyannote 已移除）。
- 中文录音务必 `--lang zh`。

### 4. 模型缓存与后台预热
- 默认缓存目录：`~/.cache/funasr`（应用运行时主进程注入 `ASR_MODEL_DIR`，指向 `userData/models/funasr`；旧变量 `ASR_WHISPER_MODEL_DIR` 若指向已有目录会自动沿用）。
- 查看状态：`python scripts/download_model.py --status`
- 预热一次（联网环境执行，之后离线）：`python scripts/download_model.py --model all`

### 5. 内网/涉密交付（完全离线拷贝）
1. 在联网机上跑 `python scripts/download_model.py --model all --model-dir D:\funasr-offline`
2. 把整个目录拷贝到目标机同名位置（或任意目录 + 设 `ASR_MODEL_DIR`）
3. 目标机无需访问 ModelScope/HuggingFace，直接转写。

---

## 备选路径：云端兜底（仅本地装不上、且用户同意上云时）
> 注意：音频会上传第三方，**涉密/国企录音请勿使用**；云端不做说话人分离。

### OpenAI
```
python -m pip install openai
set OPENAI_API_KEY=sk-xxx        # Windows 持久化: setx OPENAI_API_KEY sk-xxx
python scripts/transcribe.py "录音.m4a" --engine cloud --lang zh --formats srt,txt
```
默认模型 `whisper-1`；可 `--cloud-model gpt-4o-transcribe`。超 24MB 自动切块。

### 阿里云 DashScope（国产合规，境内节点）
```
python -m pip install dashscope
set DASHSCOPE_API_KEY=sk-xxx
python scripts/transcribe.py "录音.m4a" --engine cloud --cloud-provider dashscope --lang zh --formats srt,txt
```
模型 `paraformer-realtime-v2`，本地文件直传、无需 OSS。

---

## 装完自检
```
python scripts/check_env.py
```
看到“可走【本地完整版 FunASR + CAM++ 说话人分离】”即满血；只有 ONNX 则是“可走【本地 FunASR-ONNX INT8】”。
