#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把内部采购制度 PDF/docx 原件转换为 Markdown。

用途：制度更新时把新版 PDF 放入 references/policies/_source/<主体>/ 后重跑本脚本，
输出到 references/policies/<主体>/，再人工校对并同步 L4_internal_policies.md。

用法:
    python convert_policies.py --src <pdf目录> --out <md输出目录>
    python convert_policies.py --src references/policies/_source/group \\
        --out references/policies/group

依赖: pypdf（PDF 提取）。docx 转换需 python-docx。
标题识别规则与集团制度版式匹配：第X章→二级标题，第X节/附件N→三级标题，
"第X条"保留为正文段（**第X条** 加粗），保证条号引用可检索。
"""
import argparse
import os
import re


def pdf_to_md(path):
    try:
        from pypdf import PdfReader
    except ImportError:
        raise SystemExit('缺少 pypdf：pip install pypdf')
    reader = PdfReader(path)
    raw = '\n'.join((page.extract_text() or '') for page in reader.pages)
    raw = re.sub(r'\r', '\n', raw)
    out = []
    for line in (ln.strip() for ln in raw.split('\n')):
        if not line:
            out.append('')
            continue
        if re.match(r'^第[一二三四五六七八九十百]+章', line):
            out.append('## ' + line)
        elif re.match(r'^(第[一二三四五六七八九十百]+节|(附件|附表)\s*\d+)', line) and len(line) < 40:
            out.append('### ' + line)
        else:
            m = re.match(r'^(第[一二三四五六七八九十百]+条)', line)
            if m:
                out.append('**%s** %s' % (m.group(1), line[len(m.group(1)):].strip()))
            else:
                out.append(line)
    return '\n'.join(out) + '\n'


def docx_to_md(path):
    try:
        from docx import Document
        from docx.oxml.ns import qn
        from docx.table import Table
        from docx.text.paragraph import Paragraph
    except ImportError:
        raise SystemExit('缺少 python-docx：pip install python-docx')

    def cell_text(cell):
        return ' '.join(p.text.strip() for p in cell.paragraphs if p.text.strip()).strip()

    def table_to_md(table):
        rows = [[cell_text(c).replace('|', '\\|') for c in row.cells] for row in table.rows]
        if not rows:
            return ''
        ncol = max(len(r) for r in rows)
        rows = [r + [''] * (ncol - len(r)) for r in rows]
        lines = ['| ' + ' | '.join(rows[0]) + ' |',
                 '|' + '|'.join(['---'] * ncol) + '|']
        lines += ['| ' + ' | '.join(r) + ' |' for r in rows[1:]]
        return '\n'.join(lines) + '\n'

    doc = Document(path)
    lines = []
    for child in doc.element.body.iterchildren():
        if child.tag == qn('w:p'):
            p = Paragraph(child, doc)
            text = p.text.strip()
            if not text:
                continue
            style = p.style.name if p.style is not None else ''
            m = re.match(r'^第[一二三四五六七八九十百]+章', text)
            heading = style.lower().startswith('heading') or bool(m)
            if heading:
                lines.append('## ' + text + '\n')
            else:
                m2 = re.match(r'^(第[一二三四五六七八九十百]+条)', text)
                lines.append(('**%s** %s' % (m2.group(1), text[len(m2.group(1)):].strip()))
                             if m2 else text + '\n')
        elif child.tag == qn('w:tbl'):
            lines.append(table_to_md(Table(child, doc)) + '\n')
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, help='制度原件目录（pdf/docx）')
    ap.add_argument('--out', required=True, help='Markdown 输出目录')
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    for name in sorted(os.listdir(args.src)):
        if name.startswith('.') or name.startswith('~$') or name.startswith('._'):
            continue
        src = os.path.join(args.src, name)
        if not os.path.isfile(src):
            continue
        base = re.sub(r'\.(pdf|docx|PDF|DOCX)$', '', name).strip()
        base = re.sub(r'[/\\\s]+', '_', base)
        try:
            md = pdf_to_md(src) if name.lower().endswith('.pdf') else (
                docx_to_md(src) if name.lower().endswith('.docx') else None)
            if md is None:
                continue
            out_path = os.path.join(args.out, base + '.md')
            with open(out_path, 'w', encoding='utf-8') as f:
                f.write(md)
            print('OK  %-60s %6d chars' % (name[:60], len(md)))
        except Exception as e:  # noqa: BLE001 — 单文件失败不阻断批次
            print('ERR %-60s %s' % (name[:60], e))


if __name__ == '__main__':
    main()
