# -*- coding: utf-8 -*-
"""把 Markdown 规则库导出为结构化 JSON（+ CSV），供程序/其他平台直接消费。

用法:
    python export_rules.py                      # 默认读 ../references/rules，输出 rules.json / rules.csv
    python export_rules.py --out /path/rules.json

设计要点:
- 规则库是"源码"，本脚本是"编译器"，JSON 是"产物"。改规则后请重跑本脚本。
- 字段映射见 FIELD_MAP；未识别的中文名原样保留在 extra 中，避免信息丢失。
"""
import re
import os
import json
import csv
import argparse

HERE = os.path.dirname(os.path.abspath(__file__))
RULES_DIR = os.path.normpath(os.path.join(HERE, '..', 'references', 'rules'))

FILES = {
    'L0_redlines.md': 'L0',
    'L1_by_method.md': 'L1',
    'L2_by_policy.md': 'L2',
    'L4_internal_policies.md': 'L4',
}

# L4 内部制度规则的 ID 前缀（INT-xx），与其余层共用同一段解析逻辑
RULE_ID_PREFIXES = ('RED', 'M', 'P', 'INT')

FIELD_MAP = {
    '依据': 'basis',
    '原文': 'clause',
    '法规原文': 'clause',
    '触发表述': 'patterns',
    '判定': 'condition',
    '等级': 'severity',
    '整改': 'suggestion',
    '整改建议': 'suggestion',
    '建议': 'suggestion',
    '补充': 'supplement',
    '注意': 'note',
    '要点': 'point',
    '风险': 'risk',
    '用法': 'usage',
    '处理': 'handling',
}

RULE_RE = re.compile(r'^###\s+((?:RED|M\d{2}|P\d{2}|INT)-\d{1,2})\s+(.+?)\s*$')
SEC_RE = re.compile(r'^##\s+(.+?)\s*$')
FIELD_RE = re.compile(r'^-\s+\*\*(.+?)\*\*[^：:]*[：:]\s*(.*)$')


def split_patterns(s):
    if not s:
        return []
    parts = re.split(r'[、；;]', s)
    out = []
    for p in parts:
        p = p.strip().strip('"“”\'').strip()
        p = re.sub(r'^\d+\.\s*', '', p)
        if len(p) >= 2:
            out.append(p)
    return out


def norm_severity(s):
    if not s:
        return None
    m = re.match(r'^([ABC])', s.strip())
    return m.group(1) if m else s.strip()[:4]


def parse(path, layer):
    rules = []
    cur_sec = None
    cur = None
    last_field = None
    for ln in open(path, encoding='utf-8'):
        ln = ln.rstrip()
        m = SEC_RE.match(ln)
        if m:
            cur_sec = m.group(1)
            continue
        m = RULE_RE.match(ln)
        if m:
            if cur:
                rules.append(cur)
            cur = {
                'rule_id': m.group(1),
                'layer': layer,
                'section': cur_sec,
                'title': m.group(2),
                'severity': None,
                'basis': None,
                'clause': None,
                'patterns': [],
                'condition': None,
                'suggestion': None,
                'extra': {},
            }
            last_field = None
            continue
        if cur is None:
            continue
        m = FIELD_RE.match(ln)
        if m:
            cn, val = m.group(1), m.group(2).strip()
            key = FIELD_MAP.get(cn)
            if key == 'patterns':
                cur['patterns'] = split_patterns(val)
            elif key == 'severity':
                cur['severity'] = norm_severity(val)
            elif key:
                cur[key] = val
                last_field = key
            else:
                cur['extra'][cn] = val
                last_field = ('extra', cn)
            continue
        # 续行：追加到上一个字段（保留编号列表等）
        if ln.strip() and not ln.startswith('#') and not ln.startswith('---'):
            if isinstance(last_field, tuple):
                cur['extra'][last_field[1]] += ' ' + ln.strip()
            elif last_field and cur.get(last_field):
                cur[last_field] += ' ' + ln.strip()
    if cur:
        rules.append(cur)
    for r in rules:
        if not r['extra']:
            r.pop('extra')
        r['search_text'] = ' '.join(x for x in
                                    [r['title'], ' '.join(r['patterns']),
                                     r.get('condition') or '', r.get('clause') or ''] if x)
    return rules


def build_index(rules):
    idx = {'by_layer': {}, 'by_severity': {}, 'by_section': {}}
    for r in rules:
        idx['by_layer'].setdefault(r['layer'], []).append(r['rule_id'])
        idx['by_severity'].setdefault(r['severity'] or '未分级', []).append(r['rule_id'])
        idx['by_section'].setdefault(r['section'] or '未分类', []).append(r['rule_id'])
    return idx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', default=RULES_DIR)
    ap.add_argument('--out')
    a = ap.parse_args()

    all_rules = []
    for fn, layer in FILES.items():
        p = os.path.join(a.dir, fn)
        if not os.path.exists(p):
            print('!! missing', p)
            continue
        rs = parse(p, layer)
        print('%-18s %s -> %d 条' % (fn, layer, len(rs)))
        all_rules += rs

    meta = {
        'name': 'gov-procurement-review rules',
        'version': '1.1.0',
        'compiled_at': '2026-06-16',
        'total': len(all_rules),
        'layers': {k: sum(1 for r in all_rules if r['layer'] == k)
                   for k in ('L0', 'L1', 'L2', 'L4')},
        'severity': {k: sum(1 for r in all_rules if r['severity'] == k) for k in ('A', 'B', 'C')},
        'source_files': list(FILES.keys()),
        'note': '本文件由 export_rules.py 从 Markdown 规则库编译生成，请勿手工编辑；改规则后重跑脚本。'
                'L4 为集团/公司内部制度层（INT-xx），依据 references/policies/ 下的制度全文。',
    }
    data = {'meta': meta, 'index': build_index(all_rules), 'rules': all_rules}

    out = a.out or os.path.join(a.dir, 'rules.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print('written', out, os.path.getsize(out), 'bytes')

    csv_out = os.path.splitext(out)[0] + '.csv'
    cols = ['rule_id', 'layer', 'section', 'title', 'severity', 'basis', 'clause',
            'condition', 'suggestion']
    with open(csv_out, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction='ignore')
        w.writeheader()
        for r in all_rules:
            row = dict(r)
            row['patterns'] = ''
            w.writerow(row)
    print('written', csv_out)
    print('total', len(all_rules), '| severity', meta['severity'])


if __name__ == '__main__':
    main()
