#!/usr/bin/env python3
"""feishu-kb-sync 提取脚本：按格式把原文转为提取产物

用法:
  extract.py pdf  <input.pdf>   <output.md>   # PDF → Markdown（文本块、页面标记、基础标题和列表）
  extract.py pptx <input.pptx> <output.md>   # PPTX → Markdown（逐页标题、段落、列表和表格）
  extract.py word <input.docx> <output.md>   # Word → Markdown（标题样式 + 段落/表格顺序遍历）

策略：
  - PDF → md：使用 PyMuPDF 按阅读顺序读取文本块，保留页面标记，依据字号识别明显标题，
    将常见项目符号和编号列表整理为 Markdown；扫描型 PDF 仍需要 OCR 后再进入本脚本。
  - PPTX → md：使用 Python 标准库读取 PPTX 内部 XML，按幻灯片顺序提取标题、段落、项目符号、
    编号列表和表格；图片、动画、主题和复杂视觉布局不作为正文转换。
  - Word → md：标题样式（H1-H4）→ Markdown 标题；正文按 body 顺序遍历段落+表格（w:p/w:tbl
    交错，避免只读取 paragraphs）。
"""

import os
import posixpath
import re
import statistics
import sys
import xml.etree.ElementTree as ET
import zipfile


PDF_BULLET_RE = re.compile(r"^\s*[•●◦▪‣∙○]\s*(.+)$")
PDF_PAREN_NUMBER_RE = re.compile(r"^\s*(\d+)\)\s+(.+)$")
PDF_SENTENCE_END_RE = re.compile(r"[。！？!?；;：:,，]$")

PPTX_A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
PPTX_P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
PPTX_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PPTX_PR_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
PPTX_NS = {
    "a": PPTX_A_NS,
    "p": PPTX_P_NS,
    "r": PPTX_R_NS,
    "pr": PPTX_PR_NS,
}


def _xml_name(namespace, local_name):
    return f"{{{namespace}}}{local_name}"


# ---- PDF → Markdown ----


def _normalize_pdf_line(text):
    """清理 PDF 文本块中的空白，同时保留 Markdown 所需的行结构。"""
    return re.sub(r"[ \t]+", " ", str(text).strip())


def _markdownize_pdf_line(line):
    """将常见 PDF 项目符号整理为 Markdown 列表。"""
    bullet = PDF_BULLET_RE.match(line)
    if bullet:
        return f"- {bullet.group(1).strip()}"

    numbered = PDF_PAREN_NUMBER_RE.match(line)
    if numbered:
        return f"{numbered.group(1)}. {numbered.group(2).strip()}"

    return line


def _pdf_text_blocks(page):
    """按页面阅读顺序返回文本块及其排版信息。"""
    data = page.get_text("dict", sort=True)
    for block in data.get("blocks", []):
        if block.get("type") != 0:
            continue

        lines = []
        sizes = []
        bold = False
        for line in block.get("lines", []):
            parts = []
            for span in line.get("spans", []):
                text = span.get("text", "")
                if text:
                    parts.append(text)
                size = span.get("size")
                if isinstance(size, (int, float)) and size > 0:
                    sizes.append(float(size))
                flags = span.get("flags", 0)
                if isinstance(flags, int) and flags & 16:
                    bold = True

            line_text = _normalize_pdf_line("".join(parts))
            if line_text:
                lines.append(line_text)

        if lines:
            yield {
                "text": "\n".join(lines),
                "size": max(sizes, default=0.0),
                "bold": bold,
                "line_count": len(lines),
            }


def _heading_level(block, body_size):
    """只把版式明显突出的单行文本转换为标题，避免误伤普通段落。"""
    text = " ".join(block["text"].split())
    if not text or block["line_count"] != 1 or len(text) > 120:
        return 0
    if PDF_BULLET_RE.match(text):
        return 0
    numbered = bool(re.match(r"^\s*\d+[.)]\s+", text))
    if text.startswith(("#", ">")) or PDF_SENTENCE_END_RE.search(text):
        return 0

    size = block["size"]
    if not body_size or not size:
        return 0

    ratio = size / body_size
    if numbered and ratio < 1.25:
        return 0
    if ratio >= 1.8:
        return 1
    if ratio >= 1.35:
        return 2
    if block["bold"] and ratio >= 1.1:
        return 3
    return 0


def _pdf_block_to_markdown(block, body_size):
    level = _heading_level(block, body_size)
    lines = [_markdownize_pdf_line(line) for line in block["text"].splitlines()]
    if level:
        return f"{'#' * level} {' '.join(lines).strip()}"
    return "\n".join(lines)


def pdf_to_markdown(src, dst):
    import fitz  # pymupdf

    doc = fitz.open(src)
    try:
        pages = []
        sizes = []
        for page in doc:
            blocks = list(_pdf_text_blocks(page))
            pages.append(blocks)
            sizes.extend(block["size"] for block in blocks if block["size"] > 0)

        body_size = statistics.median(sizes) if sizes else 0.0
        parts = []
        for page_number, blocks in enumerate(pages, start=1):
            parts.append(f"<!-- page: {page_number} -->")
            if not blocks:
                parts.append("<!-- no extractable text on this page -->")
                continue
            parts.extend(_pdf_block_to_markdown(block, body_size) for block in blocks)

        markdown = "\n\n".join(part for part in parts if part.strip()).strip()
        with open(dst, "w", encoding="utf-8") as f:
            f.write(markdown + ("\n" if markdown else ""))
        print(f"PDF→md: {src} → {dst} ({doc.page_count}页, {len(markdown)}字)")
    finally:
        doc.close()



def pdf_to_text(src, dst):
    """保留旧缓存布局的 PDF 纯文本提取行为。"""
    import fitz  # pymupdf

    doc = fitz.open(src)
    try:
        text = "\n".join(page.get_text() for page in doc)
        with open(dst, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"PDF→txt: {src} → {dst} ({doc.page_count}页, {len(text)}字)")
    finally:
        doc.close()

# ---- PPTX → Markdown ----


def _normalize_pptx_text(text):
    """清理 PPTX XML 文本节点中的空白和显式换行。"""
    text = str(text or "").replace("\r", " ").replace("\n", " ")
    return re.sub(r"[ \t]+", " ", text).strip()


def _pptx_slide_paths(archive):
    """依据 presentation.xml 的关系顺序返回幻灯片 XML 路径。"""
    names = set(archive.namelist())
    fallback = sorted(
        (name for name in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
        key=lambda name: int(re.search(r"slide(\d+)\.xml$", name).group(1)),
    )

    try:
        presentation = ET.fromstring(archive.read("ppt/presentation.xml"))
        relationships = ET.fromstring(archive.read("ppt/_rels/presentation.xml.rels"))
    except (KeyError, ET.ParseError):
        return fallback

    targets = {}
    for relationship in relationships.findall("pr:Relationship", PPTX_NS):
        relation_id = relationship.attrib.get("Id")
        target = relationship.attrib.get("Target")
        relation_type = relationship.attrib.get("Type", "")
        if relation_id and target and relation_type.endswith("/slide"):
            targets[relation_id] = target

    slide_id_list = presentation.find("p:sldIdLst", PPTX_NS)
    if slide_id_list is None:
        return fallback

    paths = []
    for slide_id in slide_id_list.findall("p:sldId", PPTX_NS):
        relation_id = slide_id.attrib.get(_xml_name(PPTX_R_NS, "id"))
        target = targets.get(relation_id)
        if not target:
            continue
        if target.startswith("/"):
            slide_path = posixpath.normpath(target.lstrip("/"))
        else:
            slide_path = posixpath.normpath(posixpath.join("ppt", target))
        if slide_path in names and slide_path not in paths:
            paths.append(slide_path)

    return paths or fallback


def _pptx_shape_position(shape):
    """读取形状左上角坐标，用于将 XML 中的对象整理为阅读顺序。"""
    transforms = (
        shape.find("p:spPr/a:xfrm", PPTX_NS),
        shape.find("p:xfrm", PPTX_NS),
        shape.find("p:grpSpPr/a:xfrm", PPTX_NS),
    )
    for transform in transforms:
        if transform is None:
            continue
        offset = transform.find("a:off", PPTX_NS)
        if offset is None:
            continue
        try:
            return float(offset.attrib.get("y", "0")), float(offset.attrib.get("x", "0"))
        except ValueError:
            continue
    return float("inf"), float("inf")


def _pptx_iter_shapes(container):
    """递归遍历普通文本形状和表格形状，跳过图片等不可读对象。"""
    for child in list(container):
        local_name = child.tag.rsplit("}", 1)[-1]
        if local_name == "grpSp":
            yield from _pptx_iter_shapes(child)
        elif local_name in ("sp", "graphicFrame"):
            yield child


def _pptx_placeholder_type(shape):
    placeholder = shape.find("p:nvSpPr/p:nvPr/p:ph", PPTX_NS)
    return placeholder.attrib.get("type", "") if placeholder is not None else ""


def _pptx_paragraphs(tx_body):
    """读取文本框或表格单元格中的段落，并识别列表属性。"""
    if tx_body is None:
        return []

    list_style = tx_body.find("a:lstStyle", PPTX_NS)
    paragraphs = []
    for paragraph in tx_body.findall("a:p", PPTX_NS):
        text_parts = []
        for child in paragraph.iter():
            if child.tag == _xml_name(PPTX_A_NS, "t"):
                text_parts.append(child.text or "")
            elif child.tag == _xml_name(PPTX_A_NS, "br"):
                text_parts.append(" ")
        text = _normalize_pptx_text("".join(text_parts))
        if not text:
            continue

        paragraph_properties = paragraph.find("a:pPr", PPTX_NS)
        level = 0
        if paragraph_properties is not None:
            try:
                level = max(0, int(paragraph_properties.attrib.get("lvl", "0")))
            except ValueError:
                level = 0

        style_properties = None
        if list_style is not None:
            style_properties = list_style.find(f"a:lvl{level + 1}pPr", PPTX_NS)

        def has_bullet_properties(properties):
            if properties is None:
                return False
            return any(
                properties.find(f"a:{name}", PPTX_NS) is not None
                for name in ("buAutoNum", "buChar", "buNone")
            )

        bullet_properties = (
            paragraph_properties
            if has_bullet_properties(paragraph_properties)
            else style_properties
        )
        bullet_kind = None
        if bullet_properties is not None:
            if bullet_properties.find("a:buAutoNum", PPTX_NS) is not None:
                bullet_kind = "number"
            elif bullet_properties.find("a:buChar", PPTX_NS) is not None:
                bullet_kind = "bullet"

        paragraphs.append({"text": text, "level": level, "bullet": bullet_kind})
    return paragraphs


def _pptx_table_markdown(graphic_frame):
    table = graphic_frame.find(".//a:tbl", PPTX_NS)
    if table is None:
        return ""

    rows = []
    for row in table.findall("a:tr", PPTX_NS):
        cells = []
        for cell in row.findall("a:tc", PPTX_NS):
            paragraphs = _pptx_paragraphs(cell.find("a:txBody", PPTX_NS))
            text = " ".join(paragraph["text"] for paragraph in paragraphs).strip()
            cells.append(text.replace("|", "\\|"))
        if cells:
            rows.append(cells)

    if not rows:
        return ""

    width = max(len(row) for row in rows)
    rows = [row + [""] * (width - len(row)) for row in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
    lines.extend("| " + " | ".join(row) + " |" for row in rows[1:])
    return "\n".join(lines)


def _pptx_paragraph_markdown(paragraph):
    indent = "  " * paragraph["level"]
    if paragraph["bullet"] == "number":
        return f"{indent}1. {paragraph['text']}"
    if paragraph["bullet"] == "bullet":
        return f"{indent}- {paragraph['text']}"
    return paragraph["text"]


def _pptx_slide_content(root):
    shape_tree = root.find(".//p:spTree", PPTX_NS)
    if shape_tree is None:
        return None, []

    shapes = []
    for order, shape in enumerate(_pptx_iter_shapes(shape_tree)):
        local_name = shape.tag.rsplit("}", 1)[-1]
        y, x = _pptx_shape_position(shape)
        if local_name == "sp":
            paragraphs = _pptx_paragraphs(shape.find("p:txBody", PPTX_NS))
            if paragraphs:
                shapes.append({
                    "kind": "text",
                    "paragraphs": paragraphs,
                    "title": _pptx_placeholder_type(shape) in ("title", "ctrTitle"),
                    "position": (y, x, order),
                })
        elif local_name == "graphicFrame" and shape.find(".//a:tbl", PPTX_NS) is not None:
            shapes.append({
                "kind": "table",
                "shape": shape,
                "title": False,
                "position": (y, x, order),
            })

    title_shapes = [shape for shape in shapes if shape["title"]]
    title = None
    if title_shapes:
        title = " ".join(
            paragraph["text"]
            for shape in title_shapes
            for paragraph in shape["paragraphs"]
        ).strip()

    body = [shape for shape in shapes if not shape["title"]]
    body.sort(key=lambda shape: shape["position"])
    return title, body


def pptx_to_markdown(src, dst):
    with zipfile.ZipFile(src, "r") as archive:
        slide_paths = _pptx_slide_paths(archive)
        parts = []
        for slide_number, slide_path in enumerate(slide_paths, start=1):
            root = ET.fromstring(archive.read(slide_path))
            title, body = _pptx_slide_content(root)
            slide_parts = [f"<!-- slide: {slide_number} -->"]
            if title:
                slide_parts.append(f"# {title}")

            for shape in body:
                if shape["kind"] == "table":
                    table_markdown = _pptx_table_markdown(shape["shape"])
                    if table_markdown:
                        slide_parts.append(table_markdown)
                else:
                    paragraphs = [
                        _pptx_paragraph_markdown(paragraph)
                        for paragraph in shape["paragraphs"]
                    ]
                    paragraphs = [paragraph for paragraph in paragraphs if paragraph.strip()]
                    if paragraphs:
                        slide_parts.append("\n".join(paragraphs))

            if len(slide_parts) == 1:
                slide_parts.append("<!-- no extractable text on this slide -->")
            parts.extend(slide_parts)

        markdown = "\n\n".join(part for part in parts if part.strip()).strip()
        with open(dst, "w", encoding="utf-8") as f:
            f.write(markdown + ("\n" if markdown else ""))
    print(f"PPTX→md: {src} → {dst} ({len(slide_paths)}页, {len(markdown)}字)")


# ---- Word → Markdown ----


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
        pdf_to_markdown(src, dst)
    elif kind == "pdf-text":
        pdf_to_text(src, dst)
    elif kind == "pptx":
        pptx_to_markdown(src, dst)
    elif kind == "word":
        word_to_md(src, dst)
    else:
        print(f"未知提取类型: {kind}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
