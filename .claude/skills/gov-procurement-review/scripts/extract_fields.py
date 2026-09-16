# -*- coding: utf-8 -*-
"""从政府采购文件中抽取合规排查所需的关键字段。

用法:
    python extract_fields.py <file.docx|file.txt> [-o fields.json]

输出 JSON；抽取不到的字段值为 null，供排查时标注"未检索到"。
依赖: 读取 .docx 需要 python-docx，缺失时请先转为 .txt。
"""
import re
import sys
import json
import os

NUM = r'([\d,，\.]+\s*(?:万元|元|万)?)'


def read_text(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in ('.docx',):
        try:
            from docx import Document
        except ImportError:
            raise SystemExit('缺少 python-docx：pip install python-docx，或先把文件另存为 .txt')
        doc = Document(path)
        parts = [p.text for p in doc.paragraphs]
        for tb in doc.tables:
            for row in tb.rows:
                parts.append(' | '.join(c.text.strip() for c in row.cells))
        return '\n'.join(parts)
    for enc in ('utf-8', 'gb18030', 'utf-16'):
        try:
            return open(path, encoding=enc).read()
        except (UnicodeDecodeError, UnicodeError):
            continue
    return open(path, encoding='utf-8', errors='ignore').read()


PATTERNS = {
    '采购方式': [
        (r'公开招标', '公开招标'), (r'邀请招标', '邀请招标'),
        (r'竞争性磋商', '竞争性磋商'), (r'竞争性谈判', '竞争性谈判'),
        (r'单一来源', '单一来源'), (r'\b询价', '询价'),
        (r'框架协议', '框架协议'), (r'合作创新', '合作创新'),
        # 兜底推定：不少公告只写"招标公告"而未出现"公开招标"四字
        (r'投标邀请书', '邀请招标（推定）'), (r'招标公告', '公开招标（推定）'),
    ],
    '标的类型': [(r'货物', '货物'), (r'工程', '工程'), (r'服务', '服务')],
    '评审方法': [
        (r'综合评分法', '综合评分法'), (r'最低评标价法', '最低评标价法'),
        (r'最低评审价法', '最低评标价法'), (r'质量优先法', '质量优先法'),
    ],
    '预算金额': [r'(?:采购)?预算(?:金额)?[^\d\n]{0,10}' + NUM],
    '最高限价': [r'最高限价[^\d\n]{0,10}' + NUM, r'最高限制单价[^\d\n]{0,10}' + NUM],
    '投标保证金': [r'(?:投标|磋商|响应)保证金[^\d\n]{0,20}(\d+(?:\.\d+)?)\s*%',
                   r'(?:投标|磋商|响应)保证金[^\d\n]{0,10}' + NUM],
    '履约保证金': [r'履约保证金[^\d\n]{0,20}(\d+(?:\.\d+)?)\s*%',
                   r'履约保证金[^\d\n]{0,10}' + NUM],
    '价格权重': [r'价格(?:分|部分)?[^\d\n]{0,15}(\d+(?:\.\d+)?)\s*分',
                 r'价格[^\d\n]{0,10}(\d+(?:\.\d+)?)\s*%'],
    '投标截止天数': [r'截止之日止[^\d\n]{0,12}(\d+)\s*(?:日|天)',
                     r'(?:不少于|不得少于|至少)\s*(\d+)\s*(?:日|天)',
                     r'(\d+)\s*(?:日|天)(?:内|后)?(?:提交|递交)(?:投标|响应)'],
    '中小企业预留': [r'专门面向中小企业', r'预留(?:采购)?份额', r'预留给小微企业'],
    '中小企业声明函': [r'中小企业声明函'],
    '本国产品声明函': [r'符合本国产品标准的声明函', r'本国产品'],
    '异常低价审查': [r'异常低价'],
    '最低限价': [r'最低限价', r'不得低于[^。\n]{0,15}(?:元|万元)'],
    '本地注册': [r'本地注册', r'在本市注册', r'在XX市注册', r'本地设有分支机构'],
    '指定品牌': [r'(?:品牌|型号)\s*[:：]\s*\S+', r'指定品牌', r'原厂(?:授权|证明)'],
    '特定行业业绩': [r'(?:本省|本市|本地区)[^。\n]{0,10}业绩', r'特定(?:行业|区域)'],
}


def extract(text):
    out = {}
    for key, pats in PATTERNS.items():
        found = None
        for p in pats:
            if isinstance(p, tuple):
                if re.search(p[0], text):
                    found = p[1]
                    break
            else:
                m = re.search(p, text)
                if m:
                    found = m.group(1).strip() if m.groups() else m.group(0).strip()
                    break
        out[key] = found
    # 布尔型：是否出现关键词
    for k in ('中小企业预留', '中小企业声明函', '本国产品声明函', '异常低价审查',
              '最低限价', '本地注册', '指定品牌', '特定行业业绩'):
        out[k] = bool(out.get(k))
    return out


def main():
    argv = sys.argv[1:]
    if not argv:
        raise SystemExit(__doc__)
    src = argv[0]
    dst = None
    if '-o' in argv:
        dst = argv[argv.index('-o') + 1]
    text = read_text(src)
    fields = extract(text)
    fields['_源文件'] = os.path.abspath(src)
    fields['_字符数'] = len(text)
    js = json.dumps(fields, ensure_ascii=False, indent=2)
    if dst:
        open(dst, 'w', encoding='utf-8').write(js)
        print('written', dst)
    else:
        print(js)


if __name__ == '__main__':
    main()
