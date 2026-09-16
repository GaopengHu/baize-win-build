---
name: asr-transcribe
version: 1.1.0
category: 通用办公
agent_created: true
disable: false
description: >
  录音/语音文件转写（ASR）skill，本地优先 + 云端兜底。把 m4a/mp3/wav/aac/flac/视频
  音轨等转写为带时间戳、带说话人标注的文字稿（.srt/.vtt/.txt/.md），专门衔接会议 纪要、访谈洞察、经营分析会等下游
  skill。当用户提到"转写""语音转文字""录音转文字" "把这段录音转成文字""ASR""听录音整理""m4a 转文字""会议录音转写""访谈录音转写"
  "把腾讯会议/钉钉录音转成文字""加字幕""出字幕""srt""说话人分离""区分谁在说话"时触发。 当用户上传
  .m4a/.mp3/.wav/.aac/.flac/.mp4/.mov 音视频文件并要求转文字、整理、做纪要
  前处理时也触发。即使只说"听一下这个录音说了啥""帮我把这段语音弄成文字"，只要上下文是 把音频内容变成文本，就用此 skill。本 skill
  只做"音频→文字稿"这一段，不写正式会议纪要 （那是 meeting-minutes 等下游
  skill），不做访谈结构化洞察（interview-insight），转完 文字稿后按需移交对应下游 skill。
---

# asr-transcribe — 录音转写（ASR）

## 一句话定位
把录音变成"可直接用于纪要/访谈整理"的高质量文字稿。**本地优先（数据不出域）+ 云端兜底**，
默认输出带时间戳的 .srt/.vtt，按需带说话人标注。

## 保密红线（国企/央企录音，先过这一关）
1. **默认走本地引擎（whisperX 离线），音频不上传任何第三方。** 这是客户构成
   （≈70% 国企/央企）的硬约束。
2. **只有在本地不可用、且用户显式同意后**，才走云端 API。走云前必须一次性问清：
   「本地引擎不可用，是否允许把这段录音上传到云端 ASR？国企/涉密录音请回避。」
   用户不同意 → 停在"环境未就绪"，给安装引导，不擅自上云。
3. 文件名/落盘路径用代号，不在对话里回显甲方真实名称、涉密内容原文片段（除非用户要求看全文）。

## Python 执行环境
本 skill 的脚本使用 `python3` / `python` 执行：

- 打包后的应用中，主进程已把 bundled Python 目录加入 PATH，直接使用 `python` 即可。
- 开发环境使用系统 Python：`python`（Windows）或 `python3`（macOS/Linux）。
- **安装依赖**：`python -m pip install <包名>`
- 转写脚本路径相对于本 skill 根目录：`scripts/transcribe.py`

## 模型缓存目录
- 应用运行时，主进程会把模型缓存根目录注入到环境变量 `ASR_WHISPER_MODEL_DIR`（默认指向应用数据目录 `userData/models/whisper`，每用户独立、可写）。
- 直接用 `--model medium --model-dir "%ASR_WHISPER_MODEL_DIR%"` 指定即可（未设置时脚本自动 fallback 到 `~/.cache/whisper`）。

## 触发后立即做的事
1. **定位音频文件**：用户在对话中提供的文件路径（用户上传或给出绝对路径）。确认扩展名
   （m4a/mp3/wav/aac/flac/ogg/mp4/mov 均支持，whisperX 内部用 ffmpeg 解码）。
2. **跑环境自检**：`$PY scripts/check_env.py`
   - 探测 ffmpeg、whisperx、faster-whisper、（如需说话人分离）pyannote / HF_TOKEN、
     （如需云兜底）OPENAI_API_KEY / DASHSCOPE_API_KEY。
   - 自检结果决定走哪条分支，**不要假设环境已装好**。
3. **按自检结果选分支**（见下）。

## 决策分支
| 情况 | 动作 |
|---|---|
| 本地 whisperX + ffmpeg 就绪 | 走本地。需说话人分离则加 `--diarize`（要 HF_TOKEN） |
| 本地缺 whisperx/ffmpeg | 读 `references/install.md`，给一键安装命令，引导用户装；**装好再转** |
| 本地装不了 / 用户赶时间 + 同意上云 | 走云兜底（`--engine cloud`，国企优先 `--cloud-provider dashscope`），**降级：云端不做说话人分离** |
| 需说话人分离但缺 HF_TOKEN | 提示去 huggingface 接受模型协议拿 token；或先出无说话人版本 |

## 模型下载与本地缓存（关键：避免每次联网下载）
**强烈建议提前把模型预下载到本地缓存，之后转写完全离线，不再连 HuggingFace。**

默认缓存根目录：应用数据目录 `userData/models/whisper`（主进程自动注入 `ASR_WHISPER_MODEL_DIR`；未设置时 fallback `~/.cache/whisper`）
（可自定义：`--model-dir <目录>` 或环境变量 `ASR_WHISPER_MODEL_DIR`）

### 预下载模型（在联网环境执行一次）
```bash
$PY scripts/download_model.py --model medium
# 可选：下载 large-v3（体积大，精度最高）
$PY scripts/download_model.py --model large-v3
# 自定义目录 / 自定义镜像端点
$PY scripts/download_model.py --model medium --model-dir D:\models\whisper --endpoint https://hf-mirror.com
```
脚本默认使用 `hf-mirror.com` 镜像（中国大陆可直连），国内无需翻墙。

### 转写时指定本地模型
```bash
# 默认走缓存目录（命中 medium 则直接离线用）
$PY scripts/transcribe.py "<音频路径>" --engine local --lang zh --model medium --formats srt,txt
# 显式指定缓存目录
$PY scripts/transcribe.py "<音频路径>" --engine local --lang zh --model medium --model-dir D:\models\whisper --formats srt,txt
# 直接指定模型目录绝对路径
$PY scripts/transcribe.py "<音频路径>" --engine local --lang zh --model D:\models\whisper\medium --formats srt,txt
```
> 模型需按 `<模型名>/model.bin` 目录结构放在缓存根目录下（如 `...\whisper\medium\model.bin`）。
> 未命中本地缓存时才联网下载，且默认走镜像端点到 `~/.cache/huggingface`。

## 标准命令
本地（默认，带说话人分离、出 srt+vtt+txt）：
```
$PY scripts/transcribe.py "<音频路径>" \
  --engine auto --lang zh --diarize \
  --min-speakers 2 --max-speakers 6 \
  --formats srt,txt --output-dir ./outputs
```
不需要说话人分离（更快更稳）：
```
$PY scripts/transcribe.py "<音频路径>" --engine local --lang zh --formats srt,txt
```
云兜底（已获用户同意上云）：
```
# 默认 OpenAI；国企/国内业务优先用阿里云境内节点（国产合规）：
$PY scripts/transcribe.py "<音频路径>" --engine cloud --cloud-provider dashscope --lang zh --formats srt,txt
```
云端两家二选一：`--cloud-provider openai`（需 OPENAI_API_KEY）或 `dashscope`（需 DASHSCOPE_API_KEY，
阿里云 Paraformer，境内节点、本地文件直传）。两者均不做说话人分离。

关键参数：`--model`（默认 large-v3，弱机用 medium/small）、`--compute-type`
（CPU 用 int8）、`--speakers N`（已知确切人数时直接指定）、`--hf-token`、`--hint-words`
（行业术语/人名热词，提升专名准确率）。

## 转写质量纪律（交付前必看）
- **ASR 输出是机器转写，必有错。** 文字稿顶部自动加一行水印：
  `[本文为 ASR 机器转写，专名/数字/口径以原音频为准，未经人工校对]`，下游纪要/引用
  必须二次核对，不得直接当【实证】源。
- 中文录音务必 `--lang zh`，避免 whisper 自动语种判错导致整段乱码或翻译成英文。
- 长录音（>1.5h）默认分块处理，脚本已内置；如显存/内存不足，降 `--model` 与 `--batch-size`。
- 专名、领导职务、甲方代号用 `--hint-words` 喂进去；转写后仍要人工扫一遍领导姓名/职务
  （遵循内容政策与人名校对纪律）。

## 下游衔接（转完之后）
- 要出正式会议纪要 → 让位 **meeting-minutes**（销售会/经营分析会/项目管理会）
  等下游纪要 skill（如已安装）。
- 一对一深度访谈 → 让位 **interview-insight** 做结构化洞察（如已安装）。
- 本 skill 产出的 .txt/.srt 即这些 skill 的标准输入，转完主动询问是否接力。
- 若未安装下游 skill，直接将文字稿交付用户，提示可用于纪要整理。

## 产出与回执
转写完成后：列出生成的文件（.srt/.vtt/.txt 及可选 .md 分段稿），**用 present_files 工具
展示给用户**，一句话报识别时长 + 用的引擎 + 是否带说话人 + 是否本地（数据是否出域）。
