---
name: asr-transcribe
version: 2.0.0
category: 通用办公
agent_created: true
disable: false
description: >
  录音/语音文件转写（ASR）skill，本地优先 + 云端兜底。本地引擎为 FunASR
  Paraformer-Large（阿里达摩院，默认 INT8 量化 ONNX，离线可用），把
  m4a/mp3/wav/aac/flac/视频音轨等转写为带时间戳、带说话人标注的文字稿
  （.srt/.vtt/.txt/.md），专门衔接会议纪要、访谈洞察、经营分析会等下游
  skill。当用户提到"转写""语音转文字""录音转文字""把这段录音转成文字""ASR""听录音整理""m4a 转文字""会议录音转写""访谈录音转写"
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

## 本地引擎（FunASR Paraformer-Large，阿里达摩院）
- 非自回归端到端模型，AISHELL-1 CER 约 2.8%，真实噪音中文显著优于 Whisper；
  中文、口音、方言、长录音很强，微调工具完善；纯中文离线首选。
- **默认 `--engine funasr-onnx`**：Paraformer-Large INT8 量化 ONNX（约 238MB），
  依赖只有 onnxruntime + numpy，无需 torch，CPU 极快，弱机/离线首选。
- **说话人分离 `--engine funasr --diarize`**：完整版 funasr（自动带 VAD + 标点），
  分离走 CAM++ 说话人向量模型，**无需 HuggingFace token**。
- 本 skill **不再使用任何 whisper 系模型**（whisperX / faster-whisper /
  openai-whisper 均已移除，不要再安装）。

## 保密红线（国企/央企录音，先过这一关）
1. **默认走本地引擎（FunASR 离线），音频不上传任何第三方。** 这是客户构成
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
- 应用运行时，主进程会把模型缓存根目录注入到环境变量 `ASR_MODEL_DIR`（默认指向应用数据目录 `userData/models/funasr`，每用户独立、可写；旧变量 `ASR_WHISPER_MODEL_DIR` 若指向已有目录会自动沿用）。
- 直接用 `--model onnx --model-dir "%ASR_MODEL_DIR%"` 指定即可（未设置时脚本自动 fallback 到 `~/.cache/funasr`）。

## 触发后立即做的事（分步 + 后台，禁止单条长命令占住工具）
1. **定位音频文件**：用户在对话中提供的文件路径（用户上传或给出绝对路径）。确认扩展名
   （m4a/mp3/wav/aac/flac/ogg/mp4/mov 均支持，内部用 ffmpeg 解码为 16k 单声道 wav）。
2. **跑环境自检**：`$PY scripts/check_env.py`
   - 探测 ffmpeg、funasr-onnx、完整版 funasr、modelscope、（如需云兜底）
     OPENAI_API_KEY / DASHSCOPE_API_KEY。
   - 自检结果决定走哪条分支，**不要假设环境已装好**。
3. **先装 Python 包（单独一步，约 1-5 分钟）**：
   `$PY -m pip install -q funasr-onnx modelscope`
   要说话人分离再加 `funasr`。**不要把 pip install 和转写拼在一条 bash 命令里**
   （`&&` 串起来必超工具超时；分步更稳：装包失败能立刻看到，不污染转写日志）。
   **pip 输出用 `Select-Object -Last 15` 截断**（Windows PowerShell 下全量输出会刷屏，
   只看尾部确认成功即可；成功标志是命令退出码 0，不是输出内容）。
4. **后台提交转写（秒退），再轮询**：
   ```
   $PY scripts/transcribe.py "<音频路径>" --lang zh --formats srt,txt --output-dir <绝对路径> --async
   # 回 JOB_ID=20260920-103000 后轮询（每 60~120 秒一次）：
   $PY scripts/transcribe.py --status 20260920-103000
   ```
   `--async` 提交后秒退，真正的下载+转写在后台进程跑，日志在
   `<缓存根>/../asr-jobs/<JOB_ID>/task.log`。**禁止不带 `--async` 直接跑长转写**，
   也禁止把“等几分钟”写成 sleep 占住工具调用。
5. **按自检结果选分支**（见下）。

## 决策分支
| 情况 | 动作 |
|---|---|
| 本地 funasr-onnx + ffmpeg 就绪 | 走本地默认。需说话人分离则加 `--engine funasr --diarize`（要完整版 funasr + CAM++，不要 HF_TOKEN） |
| 本地缺 funasr/ffmpeg/模型 | **agent 自动装**：缺 Python 包（funasr-onnx / funasr / modelscope / imageio-ffmpeg）由脚本自动 `pip install`；缺模型由脚本自动从 ModelScope 拉取（首次需联网一次，约 2~10 分钟，之后离线）。**不要让用户手动装**，直接跑转写命令，装好自动继续 |
| 本地装不了（无网/内网）/ 用户赶时间 + 同意上云 | 走云兜底（`--engine cloud`，国企优先 `--cloud-provider dashscope`），**降级：云端不做说话人分离** |
| 要说话人分离但只有 ONNX | 先出无说话人版本，同时引导装完整版 funasr + 下 CAM++ 模型 |

## 模型下载与本地缓存（agent 全自动，用户无需手动）
首次转写时脚本自动从 ModelScope 拉模型（联网一次，之后完全离线）。
`download_model.py` 只是提前预热/排查用的手动工具，日常转写不用碰。

默认缓存根目录：应用数据目录 `userData/models/funasr`（主进程自动注入 `ASR_MODEL_DIR`；未设置时 fallback `~/.cache/funasr`）
（可自定义：`--model-dir <目录>` 或环境变量 `ASR_MODEL_DIR`）

### 预下载模型（在联网环境执行一次）
```bash
$PY scripts/download_model.py --status
$PY scripts/download_model.py --model onnx     # 默认：Paraformer-Large INT8 ONNX，约 238MB
$PY scripts/download_model.py --model full     # 完整版 funasr（转写+VAD+标点+CAM++，约 2GB）
$PY scripts/download_model.py --model all      # 以上全部
# 自定义目录
$PY scripts/download_model.py --model onnx --model-dir D:\models\funasr
```
脚本默认使用 ModelScope（中国大陆可直连），国内无需翻墙。

### 转写时指定本地模型
```bash
# 默认走缓存目录（命中 onnx 则直接离线用）
$PY scripts/transcribe.py "<音频路径>" --lang zh --model onnx --formats srt,txt
# 显式指定缓存目录
$PY scripts/transcribe.py "<音频路径>" --lang zh --model onnx --model-dir D:\models\funasr --formats srt,txt
# 直接指定模型目录绝对路径
$PY scripts/transcribe.py "<音频路径>" --lang zh --model D:\models\funasr\speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx --formats srt,txt
```
> 未命中本地缓存时才从 ModelScope 拉取。内网环境走离线拷贝（见 `references/install.md` 第 5 节）。

## 标准命令（全部后台模式，禁止前台长占）
首次/长录音（必带 `--async`，秒退后轮询）：
```
$PY -m pip install -q funasr-onnx modelscope
$PY scripts/transcribe.py "<音频路径>" --lang zh --formats srt,txt --output-dir <绝对路径> --async
$PY scripts/transcribe.py --status <JOB_ID>     # 每 60~120 秒轮询一次，直到 done
```
带说话人分离（完整版 funasr + CAM++）：
```
$PY -m pip install -q funasr funasr-onnx modelscope
$PY scripts/transcribe.py "<音频路径>" \
  --engine funasr --diarize \
  --formats srt,txt --output-dir <绝对路径> --async
$PY scripts/transcribe.py --status <JOB_ID>
```
云兜底（已获用户同意上云）：
```
# 默认 OpenAI；国企/国内业务优先用阿里云境内节点（国产合规）：
$PY scripts/transcribe.py "<音频路径>" --engine cloud --cloud-provider dashscope --lang zh --formats srt,txt
```
云端两家二选一：`--cloud-provider openai`（需 OPENAI_API_KEY）或 `dashscope`（需 DASHSCOPE_API_KEY，
阿里云 Paraformer，境内节点、本地文件直传）。两者均不做说话人分离。

关键参数：`--engine`（默认 funasr-onnx；要分离用 funasr）、`--model`
（默认 onnx；也接受 ModelScope ID 或本地模型目录）、`--quantize/--no-quantize`
（ONNX INT8 开关，默认开）、`--hint-words`（行业术语/人名热词，完整版 funasr 生效，
提升专名准确率）。

## 转写质量纪律（交付前必看）
- **ASR 输出是机器转写，必有错。** 文字稿顶部自动加一行水印：
  `[本文为 ASR 机器转写，专名/数字/口径以原音频为准，未经人工校对]`，下游纪要/引用
  必须二次核对，不得直接当【实证】源。
- 中文录音务必 `--lang zh`。本地 Paraformer 主打中文/中英混说；纯英文录音建议走云端兜底。
- 长录音（>1.5h）注意内存；低配机保持默认 ONNX（不要切完整版），或分段转写。
- 专名、领导职务、甲方代号用 `--hint-words` 喂进去（完整版 funasr 生效）；转写后仍要人工扫一遍领导姓名/职务
  （遵循内容政策与人名校对纪律）。

## 下游衔接（转完之后）
- 要出正式会议纪要 → 让位 **meeting-minutes**（销售会/经营分析会/项目管理会）
  等下游纪要 skill（如已安装）。
- 一对一深度访谈 → 让位 **interview-insight** 做结构化洞察（如已安装）。
- 本 skill 产出的 .txt/.srt 即这些 skill 的标准输入，转完主动询问是否接力。
- 若未安装下游 skill，直接将文字稿交付用户，提示可用于纪要整理。

## 产出与回执（决定右侧"产物"面板能否显示，严格执行）
转写完成后（`--status` 报 done 后）：列出生成的文件（.srt/.vtt/.txt 及 .docx 等主交付文件），一句话报识别时长 +
用的引擎 + 是否带说话人 + 是否本地（数据是否出域）。

**必须**在回复末尾输出 artifact 代码块（每文件一行绝对路径，含 name 方便显示）。
右侧"产物"面板只认这个块——只写 bullet 文件名、只贴相对路径、只说"已生成"，
面板都会显示"暂无产物"。不要调用 present_files（该工具不存在）。

```artifact
[{"path": "C:\\Users\\xxx\\outputs\\会议录音.srt", "name": "会议录音.srt"},
 {"path": "C:\\Users\\xxx\\outputs\\会议录音.txt", "name": "会议录音.txt"}]
```

规则：
- path 用**绝对路径**（`--output-dir` 传绝对路径即可拿到，不要自己拼相对路径）。
- 有 .docx 主交付版时把它放第一位（面板按 docx > pdf > txt > srt 排序，首位即主交付）。
- 文件名含括号/空格/中文都没关系，artifact 块里原样写，不要改名也不要转义。
