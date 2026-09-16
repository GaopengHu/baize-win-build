# -*- coding: utf-8 -*-
"""FunASR 切换回归验证（不依赖 funasr 本体，只测纯逻辑函数）。

验证点：
1. 帧级 timestamp -> 句级 cue 折算（_cues_from_timestamp / _flush）
2. sentence_info（带 spk）-> cue + 说话人重编号
3. spk 区间打标（_assign_speakers_by_range，含 ms/s 单位自适应）
4. 缺时间戳兜底（_fill_missing_times）
5. <|...|> 标签剥离
6. srt/vtt/txt 渲染（_write_outputs）
"""
import importlib.util
import json
import os
import sys
import tempfile

SCRIPT = os.path.join(os.path.dirname(__file__), "transcribe.py")
spec = importlib.util.spec_from_file_location("transcribe_under_test", SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

failures = []


def check(name, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}" + (f" -> {detail}" if detail and not cond else ""))
    if not cond:
        failures.append(name)


# ---------- 1. _strip_tags ----------
check("strip_tags 剥离时间戳标记",
      m._strip_tags("<|0.00,3.00|>你好世界<|3.00,4.10|>") == "你好世界")
check("strip_tags 普通文本不变", m._strip_tags("普通句子。") == "普通句子。")

# ---------- 2. _cues_from_timestamp：句末标点切句 ----------
text = "各位领导上午好。今天开会。"            # 8 字符 + 1 标点 = 每句 7 字
ts = [[i * 500, i * 500 + 400] for i in range(len(text))]  # 每字 500ms
cues = m._cues_from_timestamp(text, ts)
check("帧级时间戳切出 2 句", cues is not None and len(cues) == 2, str(cues))
if cues and len(cues) == 2:
    # "各位领导上午好。"共 8 字符（含句号），帧止 = 7*500+400 = 3900ms
    check("句1 文本含句号", cues[0]["text"] == "各位领导上午好。", cues[0]["text"])
    check("句1 起止时间取帧级", abs(cues[0]["start"] - 0.0) < 1e-6 and abs(cues[0]["end"] - 3.9) < 1e-6,
          f"{cues[0]['start']}~{cues[0]['end']}")
    check("句2 起于句1 后", abs(cues[1]["start"] - 4.0) < 1e-6, str(cues[1]["start"]))

# 长度不齐 -> 返回 None（走整段兜底）
check("timestamp 与文本不齐返回 None", m._cues_from_timestamp("abc", [[0, 1], [1, 2]]) is None)

# ---------- 3. sentence_info + 说话人 ----------
info = [
    {"text": "各位领导上午好。", "start": 2000, "end": 8000, "spk": 3},
    {"text": "今天开会。", "start": 8200, "end": 9900, "spk": 1},
]
cues2 = m._cues_from_sentence_info(info)
check("sentence_info 转换", len(cues2) == 2 and cues2[0]["start"] == 2.0 and cues2[0]["end"] == 8.0)
check("说话人重编号 3->1",
      m._renumber_speakers(cues2) and cues2[0]["spk"] == 1 and cues2[1]["spk"] == 2,
      str(cues2))

# ---------- 4. spk 区间（毫秒单位自适应）----------
cues3 = [
    {"text": "甲说话。", "start": 0.0, "end": 2.0},
    {"text": "乙说话。", "start": 2.5, "end": 4.0},
]
ok = m._assign_speakers_by_range(cues3, [[0, 2200, 0], [2300, 4500, 1]])  # ms 区间
check("spk 区间 ms 自适应 + 打标", ok and cues3[0]["spk"] == 1 and cues3[1]["spk"] == 2, str(cues3))

# 秒单位区间
cues3b = [
    {"text": "甲说话。", "start": 0.0, "end": 2.0},
    {"text": "乙说话。", "start": 2.5, "end": 4.0},
]
ok2 = m._assign_speakers_by_range(cues3b, [[0.0, 2.2, 5], [2.3, 4.5, 7]])
check("spk 区间秒单位 + 重编号", ok2 and cues3b[0]["spk"] == 1 and cues3b[1]["spk"] == 2, str(cues3b))

# ---------- 5. 缺时间戳兜底 ----------
cues4 = [
    {"text": "一二三四五六七八九十", "start": None, "end": None},
    {"text": "甲乙丙丁", "start": 10.0, "end": 14.0},
    {"text": "ABCDE", "start": None, "end": None},
]
m._fill_missing_times(cues4, "nonexistent_audio.m4a")  # probe 失败 -> duration 0
check("开头缺失段从 0 起", cues4[0]["start"] == 0.0, str(cues4[0]))
check("开头缺失段止于已知句起点", abs(cues4[0]["end"] - 10.0) < 1e-6, str(cues4[0]))
check("结尾缺失段起于已知句终点", abs(cues4[2]["start"] - 14.0) < 1e-6, str(cues4[2]))
check("时间轴单调", cues4[0]["start"] <= cues4[0]["end"] <= cues4[1]["start"] <= cues4[2]["end"])

# 全缺失 + 无音频时长：均分
cues5 = [{"text": "abc", "start": None, "end": None},
         {"text": "def", "start": None, "end": None}]
m._fill_missing_times(cues5, "nonexistent.m4a")
check("全缺失均分", cues5[0]["start"] == 0.0 and abs(cues5[1]["end"] - 2.0) < 1e-6, str(cues5))

# ---------- 6. 输出渲染 ----------
cues6 = [
    {"text": "各位领导上午好。", "start": 2.0, "end": 14.5, "spk": 1},
    {"text": "上半年收入增长。", "start": 15.0, "end": 62.0, "spk": 2},
]
out_dir = tempfile.mkdtemp(prefix="asr_ut_")
m._write_outputs(cues6, out_dir, "unit", ["srt", "vtt", "txt"], diarized=True)
srt = open(os.path.join(out_dir, "unit.srt"), encoding="utf-8").read()
vtt = open(os.path.join(out_dir, "unit.vtt"), encoding="utf-8").read()
txt = open(os.path.join(out_dir, "unit.txt"), encoding="utf-8").read()
check("srt 序号+时间轴", "1\n00:00:02,000 --> 00:00:14,500\n[发言人1] 各位领导上午好。" in srt, srt[:120])
check("srt 说话人2", "[发言人2]" in srt)
check("vtt 头+点分隔", vtt.startswith("WEBVTT") and "00:00:02.000 --> 00:00:14.500" in vtt)
check("txt 水印+时间轴+说话人",
      m.WATERMARK in txt and "[00:00:02] [发言人1]" in txt, txt[:160])

# 无说话人时不出前缀
m._write_outputs(cues6, out_dir, "unit2", ["srt"], diarized=False)
srt2 = open(os.path.join(out_dir, "unit2.srt"), encoding="utf-8").read()
check("非分离模式无说话人前缀", "[发言人" not in srt2)

# ---------- 7. ONNX 引擎输出形态解析（镜像 run_funasr_onnx 的内联逻辑） ----------
def parse_onnx_results(results):
    """与 run_funasr_onnx 相同的解析路径，供单测覆盖多形态输出。"""
    cues = []
    for item in results or []:
        if isinstance(item, dict):
            raw_text = item.get("preds") or item.get("text") or ""
            ts = item.get("timestamp")
        elif isinstance(item, str):
            raw_text, ts = item, None
        else:
            continue
        if isinstance(raw_text, (list, tuple)):
            raw_text = next((t for t in raw_text if t), "")
        text = m._strip_tags(raw_text)
        if not text:
            continue
        part = None
        if isinstance(ts, list) and ts:
            pairs, ok_ts = [], True
            for ent in ts:
                try:
                    pairs.append([float(ent[1]) * 1000.0, float(ent[2]) * 1000.0])
                except (TypeError, ValueError, IndexError):
                    ok_ts = False
                    break
            if ok_ts and len(pairs) == len(text):
                part = m._cues_from_timestamp(text, pairs)
        cues.extend(part or [{"text": text, "start": None, "end": None}])
    return cues

# 形态1：dict + preds 为 list[str]（新版 funasr_onnx 多 batch）
r1 = parse_onnx_results([{"preds": ["大家好。你好？"], "timestamp": [("大", 0.0, 0.2), ("家", 0.2, 0.4), ("好", 0.4, 0.6), ("。", 0.6, 0.7), ("你", 0.9, 1.1), ("好", 1.1, 1.3), ("？", 1.3, 1.4)]}])
check("ONNX preds列表+帧级时间戳切句", len(r1) == 2 and r1[0]["text"] == "大家好。" and abs(r1[0]["end"] - 0.7) < 1e-6, str(r1))

# 形态2：纯字符串列表（旧版 funasr_onnx）
r2 = parse_onnx_results(["旧版输出。第二句？"])
check("ONNX 旧版纯文本无时间戳", len(r2) == 1 and r2[0]["start"] is None, str(r2))
m._fill_missing_times(r2, "nonexistent.m4a")
check("ONNX 旧版兜底时间轴", r2[0]["start"] == 0.0 and abs(r2[0]["end"] - 1.0) < 1e-6, str(r2))

# 形态3：<|...|> 标签混入
r3 = parse_onnx_results([{"preds": "<|0.00,1.00|>带标签文本。"}])
check("ONNX 剥离尖括号标签", len(r3) == 1 and r3[0]["text"] == "带标签文本。", str(r3))

print("=" * 46)
if failures:
    print(f"FAILED: {len(failures)} -> {failures}")
    sys.exit(1)
print("ALL PASS")
