#!/usr/bin/env python3
"""feishu-kb-sync 提取脚本：按格式把原文转为提取产物

用法:
  extract.py pdf  <input.pdf> <output.txt>   # PDF → 纯文本（pymupdf get_text）
  extract.py word <input.docx> <output.md>   # Word → markdown（python-docx 标题样式 + 段落/表格顺序遍历）

策略（D-S12 按格式分流）：
  - PDF → txt：pymupdf get_text 整本提取，4s/433页，够 grep 粗筛
  - Word → md：标题样式（H1-H4）→ md 标题；正文按 body 顺序遍历段落+表格（w:p/w:tbl 交错，禁止只读 paragraphs）
"""

import sys
import os


def pdf_to_txt(src, dst):
    import fitz  # pymupdf
    doc = fitz.open(src)
    parts = []
    for page in doc:
        parts.append(page.get_text())
    text = "\n".join(parts)
    with open(dst, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"PDF→txt: {src} → {dst} ({doc.page_count}页, {len(text)}字)")


def word_to_md(src, dst):
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(src)
    lines = []

    def iter_block_items(parent):
        # 按 body 顺序遍历，w:p（段落）与 w:tbl（表格）交错
        from docx.oxml.ns import qn
        body = parent.element.body
        for child in body.iterchildren():
            if child.tag == qn("w:p"):
                yield Paragraph(child, parent)
            elif child.tag == qn("w:tbl"):
                yield Table(child, parent)

    for block in iter_block_items(doc):
        if isinstance(block, Paragraph):
            text = block.text.strip()
            if not text:
                continue
            style = block.style.name if block.style else ""
            # 标题样式：Heading 1-4 / 标题 1-4 → md #
            level = None
            for i in range(1, 5):
                if style in (f"Heading {i}", f"标题 {i}", f"heading {i}"):
                    level = i
                    break
            if level:
                lines.append(f"{'#' * level} {text}")
            else:
                lines.append(text)
        elif isinstance(block, Table):
            # 表格 → markdown 管道表
            rows = []
            for row in block.rows:
                cells = [c.text.strip().replace("\n", " ") for c in row.cells]
                rows.append(cells)
            if rows:
                header = rows[0]
                lines.append("| " + " | ".join(header) + " |")
                lines.append("| " + " | ".join(["---"] * len(header)) + " |")
                for r in rows[1:]:
                    lines.append("| " + " | ".join(r) + " |")
            lines.append("")

    with open(dst, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"Word→md: {src} → {dst} ({len(lines)}行)")


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    kind = sys.argv[1]
    src = sys.argv[2]
    dst = sys.argv[3]
    if not os.path.exists(src):
        print(f"源文件不存在: {src}", file=sys.stderr)
        sys.exit(1)
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    if kind == "pdf":
        pdf_to_txt(src, dst)
    elif kind == "word":
        word_to_md(src, dst)
    else:
        print(f"未知提取类型: {kind}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
