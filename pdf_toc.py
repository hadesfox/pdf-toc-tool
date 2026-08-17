# -*- coding: utf-8 -*-
"""
PDF 书签生成器 —— 本地完整 pipeline（RapidOCR + PyMuPDF）

为没有目录（书签）的 PDF 自动生成可点击书签。
支持文字版（直接取文本层）与扫描版（RapidOCR 高精度识别）。

用法（命令行）:
    python pdf_toc.py 输入.pdf [选项]

用法（图形界面）:
    python pdf_toc.py        # 无参数启动 tkinter 窗口
    双击打包好的 pdf_toc.exe # 直接弹窗

解析规则（match_toc_line / detect_level / remove_duplicate_entries）
与网页端 app.js 严格保持一致，勿改动差异。
"""

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone

import fitz  # PyMuPDF

# ============================================================================
# 解析规则（与 app.js 逐字对齐）
# ============================================================================

# 引导点字符集（与 app.js matchTOCLine 一致，含 PLAN §6.1 的 · / ‧）
_LEADER_CHARS = ".\u2026\u00b7\ufe52\u05f4\u2027"


def match_toc_line(line):
    """匹配单行目录文本，返回 {'title', 'page'} 或 None。"""
    s = line.strip()
    if len(s) < 3:
        return None
    # 1. 引导点： title .... 123
    m = re.match(r"^(.+?)[" + _LEADER_CHARS + r"]{3,}\s*(\d{1,4})\s*$", s)
    if m:
        return {"title": m.group(1).strip(), "page": int(m.group(2))}
    # 2. Tab 分隔： title \t 123
    m = re.match(r"^(.+?)\t+(\d{1,4})\s*$", s)
    if m:
        return {"title": m.group(1).strip(), "page": int(m.group(2))}
    # 3. 多空格： title（2+ 字符） 空格*2+ 123
    m = re.match(r"^(.{2,}?)\s{2,}(\d{1,4})\s*$", s)
    if m:
        return {"title": m.group(1).strip(), "page": int(m.group(2))}
    # 4. 单空格： title 123 且 title 不全是数字
    m = re.match(r"^(.{2,}?)\s+(\d{1,4})\s*$", s)
    if m and not re.fullmatch(r"\d+", m.group(1).strip()):
        return {"title": m.group(1).strip(), "page": int(m.group(2))}
    return None


def detect_level(title):
    """按优先级判断标题层级，返回 1/2/3。与 app.js detectLevel 一致。"""
    if re.match(r"^第[一二三四五六七八九十百\d]+[章篇部编]", title):
        return 1
    if re.match(r"^Chapter\s+\d+", title, re.IGNORECASE):
        return 1
    if re.match(r"^Part\s+\d+", title, re.IGNORECASE):
        return 1
    if re.match(r"^[一二三四五六七八九十]+[\u3001.]", title):
        return 1
    if re.match(r"^附录|^Appendix|^序|^前言|^引言|^后记|^索引|^致谢", title):
        return 1
    if re.match(r"^\d+\.\d+\.\d+", title):
        return 3
    if re.match(r"^\d+\.\d+", title):
        return 2
    if re.match(r"^第[一二三四五六七八九十\d]+节", title):
        return 2
    return 1


def remove_duplicate_entries(entries):
    """去重：先整表重复（前半==后半），再 title|page 精确去重。"""
    if len(entries) < 2:
        return entries
    if len(entries) % 2 == 0:
        half = len(entries) // 2
        repeated = True
        for i in range(half):
            a, b = entries[i], entries[i + half]
            if a["title"] != b["title"] or a["page"] != b["page"]:
                repeated = False
                break
        if repeated:
            return entries[:half]
    seen = set()
    result = []
    for e in entries:
        key = e["title"] + "|" + str(e["page"])
        if key in seen:
            continue
        seen.add(key)
        result.append(e)
    return result


def parse_toc_text(text, dedup=True):
    """解析目录文本为条目列表 [{title, page, level}]。"""
    entries = []
    for line in text.split("\n"):
        m = match_toc_line(line)
        if m:
            entries.append({
                "title": m["title"],
                "page": m["page"],
                "level": detect_level(m["title"]),
            })
    if dedup:
        return remove_duplicate_entries(entries)
    return entries


def score_toc_page(text):
    """目录页评分：匹配目录行数 / 非空行数。"""
    lines = [l for l in text.split("\n") if l.strip()]
    if len(lines) < 3:
        return 0.0
    matches = sum(1 for l in lines if match_toc_line(l))
    return matches / len(lines)


# ============================================================================
# PyMuPDF 辅助
# ============================================================================

def get_page_text(doc, page_index):
    """按阅读顺序（y 降序、同行 x 升序）提取单页文本。"""
    page = doc[page_index]
    words = page.get_text("words")  # [(x0,y0,x1,y1,word,block,line,no), ...]
    if not words:
        return ""
    lines = {}
    for w in words:
        x0, y0 = w[0], w[1]
        word = w[4]
        if not word or not word.strip():
            continue
        key = round(y0 / 5) * 5
        lines.setdefault(key, []).append((x0, word))
    sorted_ys = sorted(lines.keys(), reverse=True)  # PDF 原点左下，大 y = 上方
    out = []
    for y in sorted_ys:
        out.append("".join(t for _, t in sorted(lines[y], key=lambda p: p[0])))
    return "\n".join(out)


def check_has_text_layer(doc):
    """前 3 页文本长度 > 20 则认为有文字层。"""
    for i in range(min(3, doc.page_count)):
        text = doc[i].get_text("text").strip()
        if len(text) > 20:
            return True
    return False


def render_page_png(doc, page_index, dpi):
    """渲染单页为临时 PNG，返回文件路径（调用方负责删除）。"""
    page = doc[page_index]
    pix = page.get_pixmap(dpi=dpi)
    fd, path = tempfile.mkstemp(suffix=".png", prefix="pdf_toc_")
    os.close(fd)
    pix.save(path)
    return path


# ============================================================================
# RapidOCR（懒加载，避免 import 时加载 ONNX 模型）
# ============================================================================

_ocr_engines = {}


def _get_ocr(lang="zh"):
    """懒加载 RapidOCR 引擎。RapidOCR 1.x 内置 ch_PP-OCRv3（兼容中英混排），
    zh / en / bilingual 均使用内置模型。"""
    if lang not in _ocr_engines:
        from rapidocr_onnxruntime import RapidOCR
        _ocr_engines[lang] = RapidOCR()
    return _ocr_engines[lang]


def _reconstruct_text(result):
    """把 RapidOCR 结果按坐标还原阅读顺序。

    要点：
    - 按 y（左上角）主序、x 次序还原；
    - 纵向容差放大（标题与右对齐页码常有约 0.5~1.5 倍字高的纵向错位）；
    - 同一行内横向空隙超过阈值时补空格（点线区 OCR 常漏，标题与页码之间
      存在大空隙，必须拆开，否则会拼成「标题123」导致正则匹配失败）。
    """
    items = []
    heights = []
    for box, text, _conf in result:
        if not text or not text.strip():
            continue
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        top_y = min(ys)
        bottom_y = max(ys)
        left_x = min(xs)
        right_x = max(xs)
        items.append((top_y, left_x, right_x, text))
        heights.append(bottom_y - top_y)
    if not items:
        return ""
    items.sort(key=lambda t: (t[0], t[1]))
    heights.sort()
    median_h = heights[len(heights) // 2] if heights else 10
    line_gap = max(median_h * 1.8, 25.0)   # 同行纵向容差
    char_gap = max(median_h * 0.8, 6.0)    # 行内横向大空隙 → 补空格

    lines = []
    cur = []
    cur_top = None
    for top_y, left_x, right_x, text in items:
        if cur_top is None or (top_y - cur_top) <= line_gap:
            cur.append((left_x, right_x, text))
            if cur_top is None:
                cur_top = top_y
        else:
            lines.append(cur)
            cur = [(left_x, right_x, text)]
            cur_top = top_y
    if cur:
        lines.append(cur)

    out = []
    for line in lines:
        line.sort(key=lambda t: t[0])
        parts = []
        prev_right = None
        for left_x, right_x, text in line:
            if prev_right is not None and (left_x - prev_right) > char_gap:
                parts.append(" ")
            parts.append(text)
            prev_right = right_x
        out.append("".join(parts))
    return "\n".join(out)


def ocr_page(doc, page_index, dpi, lang="zh"):
    """渲染单页并 OCR，返回按阅读顺序拼接的文本。"""
    path = render_page_png(doc, page_index, dpi)
    try:
        engine = _get_ocr(lang)
        result, _ = engine(path)
        if not result:
            return ""
        return _reconstruct_text(result)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


# ============================================================================
# 目录定位 / 偏移检测
# ============================================================================

TOC_SCORE_THRESHOLD = 0.3


def find_toc_pages(doc, has_text, scan_pages=20, scan_dpi=100, lang="zh",
                   progress=None):
    """扫描前 scan_pages 页，按评分定位目录页，返回 [{index, score, text}]。"""
    max_pages = min(scan_pages, doc.page_count)
    scored = []
    for i in range(max_pages):
        if progress:
            progress("scan", f"扫描目录页 第 {i + 1}/{max_pages} 页",
                     int(i / max_pages * 60))
        if has_text:
            text = get_page_text(doc, i)
        else:
            text = ocr_page(doc, i, scan_dpi, lang)
        score = score_toc_page(text)
        scored.append({"index": i, "score": score, "text": text})
    toc_pages = [s for s in scored if s["score"] >= TOC_SCORE_THRESHOLD]
    if not toc_pages:
        best = max(scored, key=lambda s: s["score"]) if scored else None
        if best and best["score"] > 0:
            toc_pages = [best]
    toc_pages.sort(key=lambda s: s["index"])
    return toc_pages


def detect_offset(doc, entries, has_text):
    """文字版：标题文本匹配；扫描版：默认 5。"""
    if not has_text or not entries:
        return 5
    for entry in entries[:3]:
        page = entry.get("page")
        if not page:
            continue
        for offset in range(0, 21):
            page_index = page + offset - 1
            if page_index < 0 or page_index >= doc.page_count:
                continue
            try:
                text = get_page_text(doc, page_index)
            except Exception:
                continue
            title_part = entry["title"][:6]
            if title_part in text or entry["title"] in text:
                return offset
    return 5


def _parse_scanned_toc_page(doc, idx, lang):
    """扫描版目录页：150 + 300 双 DPI 识别后合并解析（提高鲁棒性）。

    不同 DPI 下 RapidOCR 的检测结果不完全一致：150dpi 标题捕获全但部分页码
    漏识别，300dpi 标题清晰但小页码偶发漏检。两者按归一化标题+页码合并去重。
    """
    def _norm(s):
        s = s.replace("（", "(").replace("）", ")")
        s = re.sub(r"(\d)[—–−一](?=\d)", r"\1-", s)
        return s.strip()

    texts = [ocr_page(doc, idx, 150, lang), ocr_page(doc, idx, 300, lang)]
    seen = set()
    merged = []
    for t in texts:
        for e in parse_toc_text(t, dedup=False):
            key = (_norm(e["title"]), e["page"])
            if key in seen:
                continue
            seen.add(key)
            merged.append(e)
    return merged


# ============================================================================
# 主流程
# ============================================================================

def _default_output(input_path):
    if input_path.lower().endswith(".pdf"):
        return input_path[:-4] + "_bookmarked.pdf"
    return input_path + "_bookmarked.pdf"


def _load_toc_json(path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    entries = []
    for item in data.get("toc", []):
        pdf_page = item.get("pdfPage")
        if pdf_page is None:
            pdf_page = item.get("printedPage", 1)
        entries.append({
            "title": item["title"],
            "page": int(item.get("printedPage", item.get("pdfPage", 1))),
            "pdfPage": int(pdf_page),
            "level": int(item.get("level", 1)),
        })
    return entries, int(data.get("offset", 0))


def run_pipeline(input_path, output_path=None, dpi=300, scan_dpi=100,
                 scan_pages=20, offset=None, toc_pages=None, json_path=None,
                 export_json=None, no_dedup=False, lang="zh", progress=None):
    """执行完整 pipeline，返回统计 dict。"""
    doc = fitz.open(input_path)
    try:
        page_count = doc.page_count
        if progress:
            progress("load", f"已加载 PDF（{page_count} 页）", 5)

        has_text = check_has_text_layer(doc)
        if progress:
            progress("detect", "文字层：" + ("有" if has_text else "无（扫描版）"), 8)

        if json_path:
            entries, json_offset = _load_toc_json(json_path)
            toc = []
            for e in entries:
                p = int(e["pdfPage"])
                if 1 <= p <= page_count:
                    toc.append([e.get("level", 1), e["title"], p])
            final_offset = json_offset
            if progress:
                progress("json", f"从 JSON 导入 {len(toc)} 条书签，跳过 OCR", 30)
        else:
            if toc_pages:
                toc_indices = [p - 1 for p in toc_pages if 1 <= p <= page_count]
            else:
                found = find_toc_pages(doc, has_text, scan_pages, scan_dpi,
                                       lang, progress)
                toc_indices = [s["index"] for s in found]
            if not toc_indices:
                raise ValueError(
                    "未检测到目录页，请用 --toc-pages 手动指定（如 --toc-pages 5,6）")

            if progress:
                progress("toc", f"目录页：{', '.join(str(i + 1) for i in toc_indices)}", 65)

            entries = []
            for n, idx in enumerate(toc_indices):
                if progress:
                    progress("ocr", f"识别目录页 第 {idx + 1} 页",
                             65 + int(n / len(toc_indices) * 25))
                if has_text:
                    entries.extend(parse_toc_text(get_page_text(doc, idx),
                                                  dedup=False))
                else:
                    entries.extend(_parse_scanned_toc_page(doc, idx, lang))
            if not no_dedup:
                entries = remove_duplicate_entries(entries)
            if not entries:
                raise ValueError("目录解析失败，未能提取到有效条目")

            final_offset = offset if offset is not None else \
                detect_offset(doc, entries, has_text)
            toc = []
            for e in entries:
                p = e["page"] + final_offset
                if 1 <= p <= page_count:
                    toc.append([e["level"], e["title"], p])

        if not toc:
            raise ValueError("没有有效书签可写入（页码均超出范围）")

        if progress:
            progress("write", f"写入 {len(toc)} 个书签...", 92)

        doc.set_toc([])   # 清旧书签
        doc.set_toc(toc)  # 写新书签
        if output_path is None:
            output_path = _default_output(input_path)
        doc.save(output_path, garbage=4, deflate=True)

        l1 = sum(1 for t in toc if t[0] == 1)
        l2 = sum(1 for t in toc if t[0] == 2)
        l3 = sum(1 for t in toc if t[0] == 3)

        if export_json:
            _export_json(export_json, input_path, final_offset, entries, has_text)

        if progress:
            progress("done", "完成", 100)

        return {
            "total": len(toc),
            "level_counts": {1: l1, 2: l2, 3: l3},
            "offset": final_offset,
            "output_path": output_path,
        }
    finally:
        doc.close()


def _export_json(path, source, offset, entries, has_text):
    data = {
        "source": os.path.basename(source),
        "offset": offset,
        "hasTextLayer": has_text,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "toc": [
            {
                "level": e["level"],
                "title": e["title"],
                "printedPage": e["page"],
                "pdfPage": e["page"] + offset,
            }
            for e in entries
        ],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ============================================================================
# 命令行
# ============================================================================

def _default_progress(stage, detail, percent):
    print(f"[{percent:3d}%] {detail}")


def main(argv=None, progress=None):
    if progress is None:
        progress = _default_progress
    parser = argparse.ArgumentParser(
        description="PDF 书签生成器（本地高精度版，RapidOCR + PyMuPDF）")
    parser.add_argument("input", help="输入 PDF 路径")
    parser.add_argument("--output", help="输出路径，默认 <input>_bookmarked.pdf")
    parser.add_argument("--dpi", type=int, default=300, help="精确识别渲染 DPI（默认 300）")
    parser.add_argument("--scan-dpi", type=int, default=100, help="目录页定位渲染 DPI（默认 100）")
    parser.add_argument("--scan-pages", type=int, default=20, help="扫描前 N 页找目录（默认 20）")
    parser.add_argument("--offset", type=int, default=None, help="手动指定偏移，跳过自动检测")
    parser.add_argument("--toc-pages", help="手动指定目录页（1-based，逗号分隔，如 5,6）")
    parser.add_argument("--json", dest="json_path", help="导入书签 JSON，跳过 OCR 直接写书签")
    parser.add_argument("--export-json", dest="export_json", help="导出识别结果 JSON")
    parser.add_argument("--no-dedup", action="store_true", help="跳过去重")
    parser.add_argument("--lang", choices=["zh", "en", "bilingual"], default="zh",
                        help="OCR 语言（默认 zh）")
    args = parser.parse_args(argv)

    if not os.path.isfile(args.input):
        print(f"错误：文件不存在 - {args.input}", file=sys.stderr)
        sys.exit(1)

    toc_pages = None
    if args.toc_pages:
        toc_pages = [int(x) for x in args.toc_pages.replace("，", ",").split(",")
                     if x.strip()]

    stats = run_pipeline(
        input_path=args.input,
        output_path=args.output,
        dpi=args.dpi,
        scan_dpi=args.scan_dpi,
        scan_pages=args.scan_pages,
        offset=args.offset,
        toc_pages=toc_pages,
        json_path=args.json_path,
        export_json=args.export_json,
        no_dedup=args.no_dedup,
        lang=args.lang,
        progress=progress,
    )

    lc = stats["level_counts"]
    print()
    print("=" * 46)
    print("完成！书签已写入：")
    print(f"  输出文件 : {stats['output_path']}")
    print(f"  书签总数 : {stats['total']} 个（一级 {lc[1]} / 二级 {lc[2]} / 三级 {lc[3]}）")
    print(f"  页码偏移 : {stats['offset']}")
    print("=" * 46)
    return stats


# ============================================================================
# 图形界面（tkinter，标准库零额外依赖）
# ============================================================================

def _extract_initial_file(argv):
    for a in argv or []:
        if not a.startswith("-") and a.lower().endswith(".pdf") and os.path.isfile(a):
            return a
    return None


def run_gui(argv=None):
    import queue
    import threading
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    initial_file = _extract_initial_file(argv)

    root = tk.Tk()
    root.title("PDF 书签生成器")
    root.geometry("560x430")
    root.minsize(520, 400)

    file_var = tk.StringVar(value=initial_file or "")
    offset_var = tk.StringVar()
    toc_pages_var = tk.StringVar()
    dpi_var = tk.StringVar(value="300")
    status_var = tk.StringVar(value="请选择 PDF 文件后点击「生成书签」")
    summary_var = tk.StringVar()

    q = queue.Queue()

    frame = ttk.Frame(root, padding=16)
    frame.pack(fill="both", expand=True)

    ttk.Label(frame, text="📚 PDF 书签生成器",
              font=("Microsoft YaHei", 15, "bold")).pack(anchor="w")
    ttk.Label(frame, text="本地处理 · 文件不上传 · 高精度 OCR（RapidOCR）",
              foreground="#888").pack(anchor="w", pady=(0, 12))

    # 文件选择
    file_row = ttk.Frame(frame)
    file_row.pack(fill="x", pady=4)
    ttk.Label(file_row, text="PDF 文件：").pack(side="left")
    ttk.Entry(file_row, textvariable=file_var).pack(side="left", fill="x", expand=True, padx=6)
    ttk.Button(file_row, text="选择…", command=lambda: _pick()).pack(side="right")

    def _pick():
        path = filedialog.askopenfilename(filetypes=[("PDF 文件", "*.pdf")])
        if path:
            file_var.set(path)

    # 高级选项
    adv = ttk.LabelFrame(frame, text="高级选项（可选）", padding=10)
    adv.pack(fill="x", pady=8)
    adv.columnconfigure(1, weight=1)
    ttk.Label(adv, text="页码偏移：").grid(row=0, column=0, sticky="w", pady=2)
    ttk.Entry(adv, textvariable=offset_var, width=10).grid(row=0, column=1, sticky="w", padx=6)
    ttk.Label(adv, text="（留空=自动检测）").grid(row=0, column=2, sticky="w")
    ttk.Label(adv, text="目录页：").grid(row=1, column=0, sticky="w", pady=2)
    ttk.Entry(adv, textvariable=toc_pages_var, width=10).grid(row=1, column=1, sticky="w", padx=6)
    ttk.Label(adv, text="（如 5,6；留空=自动定位）").grid(row=1, column=2, sticky="w")
    ttk.Label(adv, text="识别 DPI：").grid(row=2, column=0, sticky="w", pady=2)
    ttk.Entry(adv, textvariable=dpi_var, width=10).grid(row=2, column=1, sticky="w", padx=6)

    # 进度条 + 状态
    progress_bar = ttk.Progressbar(frame, mode="determinate", maximum=100)
    progress_bar.pack(fill="x", pady=(12, 4))
    ttk.Label(frame, textvariable=status_var, foreground="#333").pack(anchor="w")
    ttk.Label(frame, textvariable=summary_var, foreground="#0a7", wraplength=500,
              justify="left").pack(anchor="w", pady=(6, 0))

    # 按钮
    btn_row = ttk.Frame(frame)
    btn_row.pack(fill="x", pady=12)
    generate_btn = ttk.Button(btn_row, text="生成书签", command=lambda: _start())
    generate_btn.pack(side="left")
    open_btn = ttk.Button(btn_row, text="打开输出文件夹",
                          command=lambda: _open_out(), state="disabled")
    open_btn.pack(side="left", padx=8)

    last_output = {"dir": None}

    def _on_progress(stage, detail, percent):
        q.put(("progress", detail, percent))

    def _start():
        if not file_var.get():
            messagebox.showwarning("提示", "请先选择 PDF 文件")
            return
        generate_btn.config(state="disabled")
        open_btn.config(state="disabled")
        summary_var.set("")
        status_var.set("开始处理…")
        progress_bar["value"] = 0
        threading.Thread(target=_worker, daemon=True).start()

    def _worker():
        try:
            input_path = file_var.get()
            offset = None
            if offset_var.get().strip():
                offset = int(offset_var.get())
            toc_pages = None
            if toc_pages_var.get().strip():
                toc_pages = [int(x) for x in
                             toc_pages_var.get().replace("，", ",").split(",") if x.strip()]
            dpi = int(dpi_var.get() or "300")
            output_path = _default_output(input_path)
            stats = run_pipeline(input_path, output_path=output_path, dpi=dpi,
                                 offset=offset, toc_pages=toc_pages,
                                 progress=_on_progress)
            q.put(("done", stats))
        except Exception as e:  # noqa: BLE001
            q.put(("error", str(e)))

    def _poll():
        try:
            while True:
                msg = q.get_nowait()
                kind = msg[0]
                if kind == "progress":
                    _, detail, percent = msg
                    status_var.set(detail)
                    progress_bar["value"] = percent
                elif kind == "done":
                    _, stats = msg
                    lc = stats["level_counts"]
                    status_var.set("✅ 完成")
                    progress_bar["value"] = 100
                    summary_var.set(
                        f"输出：{stats['output_path']}\n"
                        f"书签 {stats['total']} 个（一级 {lc[1]} / 二级 {lc[2]} / 三级 {lc[3]}）· 偏移 {stats['offset']}")
                    last_output["dir"] = os.path.dirname(stats["output_path"])
                    generate_btn.config(state="normal")
                    open_btn.config(state="normal")
                elif kind == "error":
                    _, err = msg
                    status_var.set("❌ 失败")
                    messagebox.showerror("处理失败", err)
                    generate_btn.config(state="normal")
        except queue.Empty:
            pass
        root.after(100, _poll)

    def _open_out():
        d = last_output["dir"]
        if d and os.path.isdir(d):
            if hasattr(os, "startfile"):
                os.startfile(d)

    root.after(100, _poll)
    root.mainloop()


if __name__ == "__main__":
    argv = sys.argv[1:]
    frozen_windowed = bool(getattr(sys, "frozen", False)) and sys.stdout is None
    if frozen_windowed:
        # 打包后的窗口程序：双击或拖入 PDF 均走 GUI
        run_gui(argv)
    elif argv:
        main(argv)
    else:
        run_gui()
