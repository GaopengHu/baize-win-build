# asr-transcribe · 录音转写，数据不出域

> 把 m4a 会议录音转成带说话人、带时间戳的文字稿——**默认本地离线，国企录音不出域**，转完直接用于会议纪要整理。

一句话定位：**做"音频→文字稿"前处理的 ASR skill**，本地优先（FunASR Paraformer-Large INT8 ONNX 离线 + 完整版 CAM++ 说话人分离），云端兜底（OpenAI / 阿里云 DashScope 国产合规），下游无缝接会议纪要 / 访谈洞察。

## 为什么用它，而不是临时问 AI / 上传到在线工具

| 维度 | asr-transcribe | 在线工具(讯飞听见/通义听悟/Otter 等) | 裸 whisper CLI |
|---|---|---|---|
| 数据出域 | **默认本地、不出域**（国企/央企可用） | 必须上传第三方云 | 看怎么调，无约束 |
| 说话人分离 | ✅ 完整版 funasr + CAM++（本地） | ✅（但要上云） | ❌ 需自己拼 |
| 中文/专名优化 | ✅ `--lang zh` + `--hint-words` 热词；Paraformer 真实噪音中文显著优于 Whisper | 部分支持 | 易误判语种、整段乱码 |
| 下游衔接 | ✅ 直出纪要/访谈整理的标准输入 | ❌ 只给文字 | ❌ |
| 反幻觉纪律 | ✅ 文字稿强制水印、不得当【实证】源 | ❌ | ❌ |
| 合规兜底 | OpenAI **或**阿里云境内节点二选一 | 单一厂商 | 无 |

## 30 秒上手

```bash
# 打包后的应用会自动使用 bundled Python（主进程已把它加入 PATH）；
# 开发环境直接用系统 python（Windows）或 python3（macOS/Linux）

# 1) 装依赖（本地引擎，详见 references/install.md）
python -m pip install funasr-onnx modelscope   # 默认：INT8 ONNX，CPU 极快、无需 torch
#   ffmpeg 由应用内置：resources/ffmpeg/windows/ffmpeg.exe

# 2) 预下载模型（联网一次，之后离线）
python scripts/download_model.py --model onnx

# 3) 自检环境
python scripts/check_env.py

# 4) 转写（本地、出 srt+txt）
python scripts/transcribe.py "会议录音.m4a" --lang zh --formats srt,txt

# 要区分谁在说话（完整版 + CAM++）：
# python -m pip install funasr
# python scripts/download_model.py --model full
# python scripts/transcribe.py "会议录音.m4a" --engine funasr --diarize --lang zh --formats srt,txt
```

## 触发方式
对话里说：「把这段 m4a 转成文字」「会议录音转写，区分谁在说话」「听一下这个语音说了啥」即触发。
输出格式样例见 `references/output-format.md`。

## 安全边界（写死在 SKILL.md，不可豁免）
- 默认本地离线；**走云必须先征得用户同意**，涉密录音一律回避，token 不在日志回显。
- 文字稿顶部强制水印 `[本文为 ASR 机器转写，专名/数字/口径以原音频为准，未经人工校对]`，下游引用须二次核对，不得直接当【实证】源。
- 文件名用代号，不回显甲方真实名称。

## 它不做什么
不写正式会议纪要（→ meeting-minutes 等下游纪要 skill），不做访谈结构化洞察（→ interview-insight）。本 skill 只做"音频→文字稿"，转完主动移交。

## License
MIT License — Copyright (c) 2026 liu (博维管理咨询)
