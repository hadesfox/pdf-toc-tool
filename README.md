# PDF 书签生成器

为没有目录的 PDF 自动生成可点击书签。支持网页端（浏览器本地处理）与本地高精度工具两种方式，文件均不上传服务器。

## 功能

- 🔍 自动识别目录页（支持文字版和扫描版 PDF）
- 📝 OCR 文字识别（网页端 Tesseract.js；本地 RapidOCR 高精度）
- ✏️ 书签可编辑（标题、层级、页码）
- 📐 自动计算页码偏移
- 🔒 隐私零上传（所有处理在本地完成）

## 使用方式

### 方式一：Windows 一键版（推荐普通用户）

无需安装 Python，双击即用，内置图形界面 + 本地高精度 OCR（RapidOCR）。

> 下载：<https://github.com/hadesfox/pdf-toc-tool/releases/latest> → `pdf_toc.exe`

用法：双击 `pdf_toc.exe` → 选择 PDF → 点「生成书签」→ 完成（输出 `<原文件名>_bookmarked.pdf`）。
也可直接把 PDF 文件拖到 `pdf_toc.exe` 上。

### 方式二：本地 Python 工具 pdf_toc.py（适合开发者/大文件）

```bash
# 1. 安装依赖
pip install pymupdf rapidocr-onnxruntime

# 2. 一条命令生成书签
python pdf_toc.py 输入.pdf
# 输出：输入_bookmarked.pdf
```

常用选项：

```bash
python pdf_toc.py 输入.pdf --offset 5            # 手动指定页码偏移
python pdf_toc.py 输入.pdf --toc-pages "5,6"     # 手动指定目录页（1-based）
python pdf_toc.py 输入.pdf --export-json toc.json # 导出识别结果供检查
python pdf_toc.py 输入.pdf --json toc.json        # 直接按 JSON 写书签，跳过 OCR
```

无参数启动 `python pdf_toc.py` 会弹出图形界面。

### 方式三：网页端

1. 打开 <https://hadesfox.github.io/pdf-toc-tool/>
2. 拖入 PDF 文件
3. 等待自动识别完成
4. 检查/编辑书签条目
5. 调整页码偏移（如需要）
6. 点击「生成 PDF」下载（小文件直接在浏览器完成；大文件会引导下载本地工具）

## 技术栈

- 网页端：[pdf.js](https://mozilla.github.io/pdf.js/) + [tesseract.js](https://tesseract.projectnaptha.com/) + [pdf-lib](https://pdf-lib.js.org/)
- 本地工具：[PyMuPDF](https://pymupdf.readthedocs.io/) + [RapidOCR](https://github.com/RapidAI/RapidOCR)（onnxruntime）

## 工作原理

```
PDF → 渲染前20页 → 检测目录页(启发式评分)
                        ↓
              OCR / 文字提取 → 正则解析(标题+页码)
                        ↓
              自动计算偏移量 → 用户确认 → 写入书签
```

## License

MIT

