# -*- coding: utf-8 -*-
"""pdf_toc.py 解析函数的单元测试。

运行方式（任选其一）:
    <venv python> -m pytest tests/ -q
    <venv python> tests/test_pdf_toc.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pdf_toc import (
    match_toc_line,
    detect_level,
    remove_duplicate_entries,
    parse_toc_text,
)


# ---- match_toc_line：4 种格式 + 反例 ----

def test_match_dot_leaders():
    r = match_toc_line("第1章 科幻早期...... 16")
    assert r == {"title": "第1章 科幻早期", "page": 16}


def test_match_tab():
    r = match_toc_line("第三章 跨越时空\t45")
    assert r == {"title": "第三章 跨越时空", "page": 45}


def test_match_multi_space():
    r = match_toc_line("2.1 太空与旅行     17")
    assert r == {"title": "2.1 太空与旅行", "page": 17}


def test_match_single_space():
    r = match_toc_line("2.2 时间旅行 19")
    assert r == {"title": "2.2 时间旅行", "page": 19}


def test_match_negatives():
    assert match_toc_line("") is None
    assert match_toc_line("12") is None           # 长度不足
    assert match_toc_line("123 456") is None      # title 全数字，不误判
    assert match_toc_line("这是一行没有页码的目录") is None


# ---- detect_level：1 / 2 / 3 级 ----

def test_detect_level_1():
    assert detect_level("第1章 科幻早期") == 1
    assert detect_level("第五章 太空歌剧") == 1
    assert detect_level("Chapter 2 Something") == 1
    assert detect_level("Part 1 Intro") == 1
    assert detect_level("一、序言") == 1
    assert detect_level("附录 索引") == 1
    assert detect_level("前言") == 1


def test_detect_level_2():
    assert detect_level("2.1 太空与旅行") == 2
    assert detect_level("第2节 细节") == 2


def test_detect_level_3():
    assert detect_level("2.1.1 马克·吐温的月球旅行") == 3


def test_detect_level_default():
    assert detect_level("随便一个标题") == 1


# ---- remove_duplicate_entries：整表重复 + 精确去重 ----

def test_dedup_whole_list():
    entries = [
        {"title": "A", "page": 1},
        {"title": "B", "page": 2},
        {"title": "A", "page": 1},
        {"title": "B", "page": 2},
    ]
    r = remove_duplicate_entries(entries)
    assert len(r) == 2
    assert [e["title"] for e in r] == ["A", "B"]


def test_dedup_exact():
    entries = [
        {"title": "A", "page": 1},
        {"title": "A", "page": 1},
        {"title": "B", "page": 2},
    ]
    r = remove_duplicate_entries(entries)
    assert len(r) == 2
    assert [e["title"] for e in r] == ["A", "B"]


def test_dedup_no_change():
    entries = [
        {"title": "A", "page": 1},
        {"title": "B", "page": 2},
    ]
    assert remove_duplicate_entries(entries) == entries


# ---- parse_toc_text：端到端（含层级与去重） ----

def test_parse_toc_text():
    sample = os.path.join(os.path.dirname(__file__), "sample_toc.txt")
    with open(sample, encoding="utf-8") as f:
        text = f.read()
    entries = parse_toc_text(text, dedup=True)
    titles = [e["title"] for e in entries]

    assert len(entries) == 10  # 11 行原始，去掉 1 条精确重复
    assert "第1章 科幻早期：一种文艺类型的诞生（1818—1919）" in titles
    assert "2.1.1 马克·吐温的月球旅行" in titles
    assert titles.count("2.1 太空与旅行") == 1  # 重复只保留一次


def test_parse_toc_text_levels():
    sample = os.path.join(os.path.dirname(__file__), "sample_toc.txt")
    with open(sample, encoding="utf-8") as f:
        text = f.read()
    entries = parse_toc_text(text, dedup=True)
    by_title = {e["title"]: e["level"] for e in entries}
    assert by_title["第2章 科幻的黄金时代"] == 1
    assert by_title["一、序言"] == 1
    assert by_title["2.1 太空与旅行"] == 2
    assert by_title["2.1.1 马克·吐温的月球旅行"] == 3


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn()
            print(f"  PASS  {fn.__name__}")
            passed += 1
        except AssertionError as e:
            print(f"  FAIL  {fn.__name__}: {e}")
    print(f"\n{passed}/{len(fns)} 通过")
    sys.exit(0 if passed == len(fns) else 1)
