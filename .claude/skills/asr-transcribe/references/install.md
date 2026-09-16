# asr-transcribe 安装与环境引导

## Python 环境约定
- 打包后的应用中，主进程会把 bundled Python 目录加入 PATH，直接用 `python`（Windows）或 `python3`（macOS/Linux）即可。
- 开发环境：使用系统 Python。
- **安装包**：`python -m pip install <包名>`

## 推荐路径：本地引擎（数据不出域，国企/央企录音首选）

### 1. ffmpeg（必装，负责解码 m4a / 切块）
- 优先方案：今点通会自动查找应用内置 ffmpeg（`resources/ffmpeg/windows/ffmpeg.exe`），并注入 `ASR_FFMPEG_PATH` 环境变量，用户无需额外安装
- Windows 临时方案：`winget install Gyan.FFmpeg --silent --accept-package-agreements --accept-source-agreements`（或 `choco install ffmpeg`），装完重开终端
- macOS：`brew install ffmpeg`
- Linux：`sudo apt install ffmpeg`
- 验证：`ffmpeg -version`

### 2. whisperX（转写 + 词级时间戳 + 说话人分离，主力）
```
python -m pip install whisperx
```
- 弱机/无显卡也能跑：转写时加 `--device cpu --compute-type int8 --model medium`
- 首次运行会自动下载模型（需联网一次，之后可做本地缓存）

### 2.1 预下载模型到本地缓存（推荐，避免每次联网下载）
模型下载默认走 `hf-mirror.com` 镜像（中国大陆可直连），下载后离线可用：
```
python scripts/download_model.py --model medium
python scripts/download_model.py --model large-v3   # 可选，体积大精度高
```
- 默认缓存目录：应用数据目录 `userData/models/whisper`（主进程注入 `ASR_WHISPER_MODEL_DIR`；未设置时 fallback `~/.cache/whisper`）
- 自定义目录：`--model-dir D:\models\whisper`（或设置 `ASR_WHISPER_MODEL_DIR` 环境变量）

### 3. 说话人分离的 HuggingFace token（要 --diarize 才需要）
1. 注册/登录 https://huggingface.co ，在设置里建一个 Read token
2. 到模型页点 Agree 接受协议（whisperX v3.8+ 用社区版分离模型）：
   - https://huggingface.co/pyannote/speaker-diarization-3.1
   - https://huggingface.co/pyannote/segmentation-3.0
3. 设环境变量 `HF_TOKEN`，或转写时 `--hf-token hf_xxx`

### 轻量兜底：faster-whisper（不做说话人分离，依赖更少）
```
$PY -m pip install faster-whisper
```
脚本在 whisperX 不可用时自动回退到它（只出文字稿/字幕，无说话人）。

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
看到“可走【本地 + 说话人分离】”即满血。
