# PDF 书签生成器 —— 完整技术方案

> 本方案用于指导 Code 模式编写/重构代码。实现前请通读全文，按「实现任务清单」逐项执行。

## 1. 项目概述

为「没有目录（书签）的 PDF」自动生成可点击书签的工具。典型场景：扫描版电子书（每页都是图片、无文字层、原书签只有页码数字 1–560）。

**产品形态（已确定）**：GitHub Pages 纯静态网页（浏览器端处理，文件零上传）+ 本地 Python 脚本兜底（处理超大扫描版 PDF）。

**在线地址**：https://hadesfox.github.io/pdf-toc-tool/
**仓库**：https://github.com/hadesfox/pdf-toc-tool
**本地代码**：`E:\workspace\WorkBuddy\2026-07-04-00-46-59\pdf-toc\`

## 2. 当前状态（已上线 v1）

### 2.1 网页端已实现功能（index.html / style.css / app.js）

| 模块 | 实现方式 | 状态 |
|------|---------|------|
| PDF 加载与渲染 | pdf.js 3.11.174（CDN） | ✅ 可用 |
| 文字层检测 | 前 3 页 getTextContent 长度 >20 | ✅ 可用 |
| 目录页定位 | 前 20 页启发式评分（行尾带数字的行占比） | ✅ 可用 |
| OCR（扫描版） | Tesseract.js v5（CDN，workerPath 显式指定） | ⚠️ 精度有限 |
| 目录解析 | 正则：4 种格式 + 层级检测 + 去重 | ✅ 可用 |
| 页码偏移检测 | 文字版：标题文本匹配；扫描版：默认 5 | ✅ 可用 |
| 书签预览编辑 | 表格：层级/标题/页码可改、可增删、可去重、偏移可调 | ✅ 可用 |
| 写回 PDF | pdf-lib 1.17.1 | ⚠️ 大文件栈溢出 |
| 大文件回退 | 失败后下载 `apply_toc.py`（PyMuPDF）+ JSON 数据 | ✅ 可用 |

### 2.2 已验证的本地结论（务必复用，勿重踩坑）

| 结论 | 说明 |
|------|------|
| **PaddleOCR 不可用** | 本机 OneDNN 后端兼容性 bug，跑不起来。勿再尝试 |
| **RapidOCR 可用** | `rapidocr-onnxruntime`，ONNX Runtime 推理，目录页识别成功，置信度 0.55–0.93 |
| **PyMuPDF 可用** | `pymupdf`，`doc.set_toc()` / `doc.save(garbage=4, deflate=True)` 写书签 |
| **偏移量规律** | 《科幻编年史》：PDF 页码 = 印刷页码 + 5 |
| **验证结果** | 用 RapidOCR 验证过 16 个书签标题与页码全部准确 |
| **环境** | Python 3.13.12 venv：`C:\Users\Fox244\.workbuddy\binaries\python\envs\default\Scripts\python.exe`；已装 pymupdf、rapidocr-onnxruntime |

## 3. 技术架构

```
┌─────────────────────────────────────────────┐
│  GitHub Pages 静态网页（浏览器端）           │
│  1. pdf.js 加载/渲染/提取文字层              │
│  2. 启发式扫描前20页定位目录页               │
│  3. 文字版→getTextContent；扫描版→Tesseract.js│
│  4. 正则解析 → 预览编辑（层级/标题/页码）    │
│  5. pdf-lib 写书签（小文件）                 │
│  6. 失败→下载本地脚本+JSON（大文件）         │
└────────────────────┬────────────────────────┘
                     │ 下载 apply_toc.py / pdf_toc.py + toc.json
                     ▼
┌─────────────────────────────────────────────┐
│  本地 Python 脚本（RapidOCR + PyMuPDF）      │
│  1. 渲染目录页 → RapidOCR 高精度识别         │
│  2. 解析 → 偏移 → set_toc() 写书签           │
│  3. 一条命令跑完，无浏览器调用栈限制         │
└─────────────────────────────────────────────┘
```

**分工原则**：网页做「轻量快速 + 可视化编辑」，本地脚本做「高精度 + 大文件写回」。文件始终不离开用户设备。

## 4. 核心流程（网页端）

```
上传 PDF
  → loadPDF() 加载
  → checkHasTextLayer()：前3页文本长度>20 → hasText
  → findTOCPages()：前20页逐页打分
       score = 匹配目录行数 / 非空行数，阈值 0.3
       （扫描版用 100dpi OCR，文字版直接取文本）
  → 命中页用 300dpi 重新 OCR（扫描版）拼成 tocText
  → parseTOCText()：逐行 matchTOCLine → {title, page, level}
  → removeDuplicateEntries() 去重
  → detectOffset()：文字版文本匹配标题；扫描版默认 5
  → step-review 表格预览（可编辑）→ 用户确认
  → generate()：pdf-lib 写书签
       ├─ 成功 → 下载 PDF
       └─ 失败（Maximum call stack / too large）
            → showDownloadResult(false)
            → 下载 apply_toc.py + toc.json → 本地运行
```

## 5. 已知问题与决策记录

### 5.1 【已解决】GitHub Pages CSP 拦截 Tesseract.js Worker
- **现象**：`Access to the script at 'blob:...' is denied by the document's Content Security Policy`
- **根因**：Tesseract.js 默认用 blob URL 创建 Web Worker，GitHub Pages 的 CSP 禁止内联 Worker
- **修复**：`createWorker` 显式传 `workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js'`
- **附加**：`processFile` catch 中检测 `Worker/CSP/Security` 关键词 → 自动切换手动输入模式

### 5.2 【已解决】pdf-lib 大文件栈溢出
- **现象**：165MB 扫描版 PDF 保存时 `Maximum call stack size exceeded`
- **根因**：全图片 PDF 对象图巨大，pdf-lib `save()` 序列化递归超浏览器栈上限
- **修复**：`save({ useObjectStreams: false, updateFieldAppearances: false })` 降栈使用；仍超限则走本地脚本回退
- **决策**：大文件一律走本地 Python 脚本（见 §7），不再尝试在浏览器写回

### 5.3 【未解决 · 本期重点】浏览器 OCR 精度不足，子节丢失
- **现象**：网页版处理《科幻编年史》只识别出 19 个一级书签，二级/三级全部为 0；但本地 RapidOCR 能识别出完整子节（如 `2.1 太空与旅行`、`2.1.1 马克·吐温…`）
- **根因**：Tesseract.js 浏览器端轻量模型对目录小字/点线排版识别率低；且 `detectLevel` 依赖标题前缀 `第X章`/`X.X`/`X.X.X` 判断层级，OCR 缺字就降级为 1 级
- **方案**：把「高精度识别」从浏览器迁移到本地 Python 完整 pipeline（§7 方案 A，推荐）；网页端保留快速预览与 JSON 编辑能力

## 6. 解析规则规格（前后端统一，勿改差异）

### 6.1 目录行匹配 matchTOCLine(line)
按优先级依次尝试，任一命中即返回 `{title, page}`：
```python
# 输入：单行文本（已 trim，长度 >= 3）
# 1. 引导点：  ^(.+?)[.…·‧] {3,}\s*(\d{1,4})\s*$
# 2. Tab 分隔： ^(.+?)\t+(\d{1,4})\s*$
# 3. 多空格：   ^(.{2,}?)\s{2,}(\d{1,4})\s*$
# 4. 单空格：   ^(.{2,}?)\s+(\d{1,4})\s*$ 且 title 不全是数字
# 均不命中 → None
```

### 6.2 层级检测 detectLevel(title)
```python
# 按顺序判断，返回 1/2/3：
# 1级: ^第[一二三四五六七八九十百\d]+[章篇部编]
#      ^Chapter\s+\d+    ^Part\s+\d+
#      ^[一二三四五六七八九十]+[、.]     （如 "一、"）
#      ^附录|^Appendix|^序|^前言|^引言|^后记|^索引|^致谢
# 3级: ^\d+\.\d+\.\d+
# 2级: ^\d+\.\d+
#      ^第[一二三四五六七八九十\d]+节
# 默认: 1
```

### 6.3 去重 removeDuplicateEntries(entries)
```python
# 1. 若条目数为偶数，检查前半与后半逐条 title+page 是否全同 → 保留前半
#    （处理 OCR 把同一目录页识别两遍 / 重复扫描页）
# 2. 否则按 title|page 精确去重
```

### 6.4 偏移检测
- 文字版：取前 3 条目，在 `印刷页码+offset` 附近页（offset 0→20）用 getTextContent 搜标题前 6 字，命中即得 offset
- 扫描版：默认 5（《科幻编年史》实测值），允许用户在网页手动调整

## 7. 本期改进方案

### 方案 A（推荐实现）：本地 Python 完整 pipeline —— `pdf_toc.py`

把「OCR → 解析 → 偏移 → 写书签」整体做成一个本地命令行工具，网页生成的 `apply_toc.py` 只是它的数据驱动简化版。工具目标：`python pdf_toc.py 输入.pdf [选项]` 一条命令完成。

**CLI 规格**：
```
python pdf_toc.py <input.pdf> [options]
  --output PATH      输出路径，默认 <input>_bookmarked.pdf
  --dpi N            精确识别渲染 DPI（默认 300）
  --scan-dpi N       目录页定位渲染 DPI（默认 100）
  --scan-pages N     扫描前 N 页找目录（默认 20）
  --offset N         手动指定偏移，跳过自动检测
  --toc-pages "5,6"  手动指定目录页（1-based，逗号分隔），跳过自动定位
  --json PATH        导入书签 JSON（格式见 §7.2），跳过 OCR 直接写书签
  --export-json PATH 导出识别结果 JSON（供网页/人工检查）
  --no-dedup         跳过去重
  --lang zh          指定 OCR 语言（zh/en/bilingual，默认 zh）
```

**流程（对应网页 §4，OCR 换 RapidOCR）**：
1. `fitz.open(input)`，检测文字层（前 3 页 get_text 长度 >20）
2. 定位目录页：有文字层直接取文本，无则渲染 `--scan-dpi` + RapidOCR，按 §6.1 打分（阈值 0.3）
3. 命中目录页用 `--dpi` 重渲染 + RapidOCR 精识别，拼接文本
4. §6.1/§6.2/§6.3 解析去重
5. 偏移：文字版文本匹配；扫描版默认 5（可 `--offset` 覆盖）
6. `doc.set_toc([])` 清旧书签 → `doc.set_toc(toc)` 写新书签（toc = [[level, title, pdf_page], ...]）
7. `doc.save(output, garbage=4, deflate=True)`
8. 输出统计：书签数、各级数量、偏移量；`--export-json` 时写 JSON

**RapidOCR 用法（已验证）**：
```python
from rapidocr_onnxruntime import RapidOCR
ocr = RapidOCR()
result, _ = ocr(image_path)   # result: list of [box, text, confidence]
# 渲染：用 pymupdf 的 page.get_pixmap(dpi=DPI)，保存临时 PNG 再喂给 RapidOCR
# 按 box[0][1]（左上角 y）排序行，同一行内按 x 排序 → 还原阅读顺序
```

### 方案 B（网页端增强，可选做）：失败时下载「完整版脚本」
- 现在失败下载的 `apply_toc.py` 只是「JSON 数据 + set_toc」。增强为：同时提供下载 `pdf_toc.py`（带完整 OCR 能力的独立工具），用户拿到后对任意 PDF 都能本地一条龙处理
- 网页本身不再需要为了精度换更强的 OCR 模型

### 方案 C（备选）：网页端加层级批量调整
- 在预览表格上方加「全部降为 1 级 / 按 X.X 前缀自动分层」按钮，缓解识别层级丢失，但不解决 OCR 漏子节的根本问题

### 结论
- 主推 **方案 A**，落地为 `pdf_toc.py`（本地完整 pipeline）
- 网页端改一行：失败回退提示文案改为「下载完整本地工具 pdf_toc.py」
- 方案 C 视时间可选加

## 8. 文件结构（目标态）

```
pdf-toc/
├── index.html          # 网页（已实现，微调文案）
├── style.css           # 样式（已实现）
├── app.js              # 前端逻辑（已实现，含大文件回退）
├── pdf_toc.py          # 【本期新增·核心】本地完整 pipeline（方案 A）
├── apply_toc.py        # 网页生成的数据驱动脚本（已实现，保持）
├── README.md           # 项目说明（已实现，补充 pdf_toc.py 用法）
├── PLAN.md             # 本方案文档
└── tests/
    ├── sample_toc.txt  # 【新增】构造的目录文本样本（含引导点/tab/多空格/中文编号/层级）
    └── test_pdf_toc.py # 【新增】针对解析函数（match/detect/dedup）的单元测试
```

## 9. 实现任务清单（Code 模式按此执行）

- [ ] **T1** 新建 `pdf_toc.py`，实现 §7 方案 A 全部 CLI 选项与流程
  - [ ] 参数解析（argparse，含 §7 全部选项）
  - [ ] 文字层检测 + 目录页定位（复用 §6.1 打分逻辑）
  - [ ] RapidOCR 集成（渲染→临时PNG→识别→按坐标还原行序）
  - [ ] 解析/层级/去重（§6.2/§6.3，与 JS 行为一致）
  - [ ] 偏移检测 + 写书签 + 保存
  - [ ] `--json` 导入 / `--export-json` 导出（格式见下）
- [ ] **T2** 新建 `tests/test_pdf_toc.py` + `tests/sample_toc.txt`，覆盖：4 种目录行格式、3 级层级、整表重复去重、精确去重
- [ ] **T3** 用真实文件回归测试：`科幻编年史(精) (盖伊·哈雷) (Z-Library).pdf`（E:/BaiduNetdiskDownload/pj/book/），验证：
  - 识别出的子节数量明显多于网页版（19 条全 1 级）
  - 偏移 = 5，章节页码与已知 16 书签一致
- [ ] **T4** 网页 `app.js` 回退文案改为「下载完整本地工具 pdf_toc.py」，下载内容改为完整脚本（打包 OCR 依赖说明）；提交并推送 GitHub Pages
- [ ] **T5** 更新 `README.md`：新增 pdf_toc.py 安装（pip install pymupdf rapidocr-onnxruntime）与用法示例

## 10. JSON 交换格式（网页 ↔ 本地脚本）

```json
{
  "source": "科幻编年史(精) (盖伊·哈雷) (Z-Library).pdf",
  "offset": 5,
  "generatedAt": "2026-07-05T10:00:00.000Z",
  "toc": [
    { "level": 1, "title": "第1章 科幻早期：一种文艺类型的诞生（1818—1919）", "printedPage": 16, "pdfPage": 21 },
    { "level": 2, "title": "2.1 太空与旅行", "printedPage": 17, "pdfPage": 22 }
  ]
}
```
- `pdf_toc.py --json toc.json input.pdf`：直接用 toc.pdfPage 写书签（校验 1<=pdfPage<=页数），忽略 OCR
- 网页下载的 JSON 与此格式一致（现有 downloadJSON 已输出该结构，可复用）

## 11. 验收标准

1. `python pdf_toc.py <科幻编年史.pdf>` 一条命令产出带书签 PDF；书签含二级/三级子节（≥30 条），偏移 5
2. 解析函数单测全部通过（pytest 或原生断言）
3. 小 PDF 网页端仍可直接下载带书签文件（pdf-lib 路径不受影响）
4. 大 PDF 网页端失败回退文案指向 pdf_toc.py，JSON 与脚本数据互通
5. GitHub Pages 重新构建成功（Ctrl+F5 可见新版本）

## 12. 环境备忘

- **Python venv**：`C:\Users\Fox244\.workbuddy\binaries\python\envs\default\Scripts\python.exe`
- **已装包**：pymupdf、rapidocr-onnxruntime
- **勿用**：paddlepaddle / paddleocr（OneDNN 兼容 bug）
- **测试文件**：`E:/BaiduNetdiskDownload/pj/book/科幻编年史(精) (盖伊·哈雷) (Z-Library).pdf`（165MB，565 页，扫描版）
- **部署**：`cd pdf-toc && git push origin master`，GitHub Pages 自动构建
