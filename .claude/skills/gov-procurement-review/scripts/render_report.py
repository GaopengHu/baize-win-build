# -*- coding: utf-8 -*-
"""把排查结果渲染为 Markdown 报告。

用法:
    python render_report.py --input findings.json [--output 排查报告.md] [--template ../references/templates/report.md]

findings.json 结构:
{
  "meta": {"文件名称":"", "采购人":"", "采购方式":"", "标的类型":"", "预算金额":"", "法域":"政府采购法体系"},
  "findings": [
    {"id":"RED-01", "level":"A", "title":"限定所有制形式或所在地",
     "location":"第三章 3.2条", "quote":"投标人须为在XX市注册登记的独立法人",
     "basis":"《政府采购法实施条例》第二十条第(七)项", "clause":"非法限定供应商的所有制形式、组织形式或者所在地",
     "risk":"供应商可据此质疑投诉", "suggestion":"删除地域限定，改为客观履约能力要求"}
  ],
  "pending": [{"事项":"...", "需确认内容":"..."}],
  "coverage": {"L0": 30, "L1": 12, "L2": 8, "规则库版本": "1.0.0"}
}
"""
import json
import sys
import os
import argparse

LEVEL_DESC = {
    'A': 'A 违法（须整改后方可发布）',
    'B': 'B 瑕疵（建议整改）',
    'C': 'C 建议（可优化）',
    '存疑': '存疑（规则库未覆盖，需人工判断）',
}
ORDER = {'A': 0, 'B': 1, 'C': 2, '存疑': 3}


def render(data):
    meta = data.get('meta', {})
    findings = sorted(data.get('findings', []), key=lambda f: ORDER.get(f.get('level', 'C'), 9))
    pending = data.get('pending', [])
    cov = data.get('coverage', {})

    CN = ['一', '二', '三', '四', '五', '六', '七', '八']
    ci = 2 if data.get('law_note') else 1  # 结论摘要的章节序号

    L = []
    L.append('# 政府采购文件合规排查报告\n')
    L.append('## 一、基本信息\n')
    L.append('| 项目 | 内容 |')
    L.append('|---|---|')
    for k, v in meta.items():
        L.append('| %s | %s |' % (k, v or '—'))
    L.append('')

    # 法域判定：第 2 步画像分诊的结论，决定后续规则是否适用
    if data.get('law_note'):
        L.append('## 二、法域判定（关键前置结论）\n')
        L.append(data['law_note'] + '\n')
        L.append('')

    L.append('## %s、结论摘要\n' % ('三' if data.get('law_note') else '二'))
    L.append('| 严重度 | 数量 | 说明 |')
    L.append('|---|---|---|')
    for lv in ('A', 'B', 'C', '存疑'):
        n = sum(1 for f in findings if f.get('level') == lv)
        L.append('| %s | %d | %s |' % (lv, n, LEVEL_DESC[lv].split('（')[1].rstrip('）')))
    has_a = any(f.get('level') == 'A' for f in findings)
    L.append('')
    L.append('**总体结论**：%s\n' % ('不建议发布，存在违法条款须整改' if has_a else '修改后发布'))
    L.append('')

    L.append('## %s、问题清单\n' % CN[ci + 1])
    if not findings:
        L.append('未发现符合规则库判定的问题。注意：这不等于绝对合规，请核对第四、五节的待确认项与覆盖范围。\n')
    for f in findings:
        L.append('### [%s] %s %s\n' % (f.get('level', ''), f.get('id', ''), f.get('title', '')))
        for label, key in (('位置', 'location'), ('原文引用', 'quote'), ('判定依据', 'basis'),
                           ('法规原文', 'clause'), ('风险', 'risk'), ('整改建议', 'suggestion')):
            v = f.get(key)
            if v:
                L.append('- **%s**：%s' % (label, v))
        L.append('')
        L.append('---\n')

    comp = data.get('compliant', [])
    if comp:
        L.append('## %s、已核验符合项\n' % CN[ci + 2])
        L.append('以下要点经核对未发现问题（参照政府采购规则检验）：\n')
        for c in comp:
            L.append('- %s' % c)
        L.append('')

    L.append('## %s、待人工确认项\n' % CN[ci + 2 + (1 if comp else 0)])
    if pending:
        L.append('| 序号 | 事项 | 需确认内容 |')
        L.append('|---|---|---|')
        for i, p in enumerate(pending, 1):
            L.append('| %d | %s | %s |' % (i, p.get('事项', ''), p.get('需确认内容', '')))
    else:
        L.append('（无）')
    L.append('')

    off = 1 if comp else 0
    total = sum(v for k, v in cov.items() if isinstance(v, int))
    L.append('## %s、覆盖范围声明\n' % CN[ci + 3 + off])
    L.append('本次共检查规则 **%d 条**：\n' % total)
    for k, v in cov.items():
        if isinstance(v, int):
            L.append('- %s：%d 条' % (k, v))
    L.append('')
    L.append('**未覆盖领域**：\n')
    for item in ('地方性法规、规章及地方集采目录、采购限额标准（需提供地区+年度）',
                 '行业特殊规定（如医疗器械、军工、涉密采购）',
                 '事实判断类问题（技术参数排他性、报价合理性等）',
                 '工程类适用《招标投标法》体系的规则（本规则库仅部分覆盖）',
                 '采购文件之外的行为合规（评审现场组织、信息发布时效的实际执行）'):
        L.append('1. %s' % item)
    L.append('')

    L.append('## %s、免责声明\n' % CN[ci + 4 + off])
    L.append('本报告由智能体依据规则库进行**发布前初筛**，供采购人内部参考，不构成法律意见，'
             '不替代财政部门的认定与监督检查。正式发布前，请结合本单位内控制度与法律审核流程复核。\n')
    L.append('---\n')
    L.append('*规则库版本 %s | 依据文件以中央层面现行有效法规为准*\n' % cov.get('规则库版本', '1.0.0'))
    return '\n'.join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--output')
    a = ap.parse_args()
    data = json.load(open(a.input, encoding='utf-8'))
    md = render(data)
    if a.output:
        open(a.output, 'w', encoding='utf-8').write(md)
        print('written', a.output)
    else:
        print(md)


if __name__ == '__main__':
    main()
