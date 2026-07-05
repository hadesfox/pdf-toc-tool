// ===== Config =====
const CONFIG = {
  maxScanPages: 20,
  tocScoreThreshold: 0.3,
  ocrDPI: 300,
  scanDPI: 100,
};

// ===== State =====
const state = {
  file: null,
  pdfDoc: null,
  numPages: 0,
  hasTextLayer: false,
  tocPageIndices: [],
  tocEntries: [],
  offset: 0,
  outputBlob: null,
  outputFileName: '',
  ocrWorker: null,
};

// ===== PDF.js Setup =====
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ===== Utilities =====
const $ = (id) => document.getElementById(id);

function showStep(id) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function showProgress(title, detail, percent) {
  $('progress-title').textContent = title;
  if (detail !== undefined) $('progress-detail').textContent = detail;
  if (percent !== undefined) $('progress-fill').style.width = percent + '%';
}

function log(msg) {
  const area = $('log-area');
  area.classList.add('visible');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  area.appendChild(line);
  area.scrollTop = area.scrollHeight;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== PDF.js Wrapper =====
async function loadPDF(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdfDoc = await loadingTask.promise;
  return pdfDoc;
}

async function renderPageToCanvas(pdfDoc, pageIndex, dpi) {
  const page = await pdfDoc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

async function getPageText(pdfDoc, pageIndex) {
  const page = await pdfDoc.getPage(pageIndex + 1);
  const content = await page.getTextContent();
  // Group items by line (similar Y positions)
  const lines = {};
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const y = Math.round(item.transform[5] / 5) * 5;
    if (!lines[y]) lines[y] = [];
    lines[y].push({ text: item.str, x: item.transform[4] });
  }
  const sortedYs = Object.keys(lines).map(Number).sort((a, b) => b - a);
  return sortedYs.map(y => {
    return lines[y].sort((a, b) => a.x - b.x).map(i => i.text).join('');
  }).join('\n');
}

async function checkHasTextLayer(pdfDoc) {
  // Check first 3 pages for text
  for (let i = 0; i < Math.min(3, pdfDoc.numPages); i++) {
    const text = await getPageText(pdfDoc, i);
    if (text.trim().length > 20) return true;
  }
  return false;
}

// ===== OCR =====
async function initOCR() {
  if (state.ocrWorker) return state.ocrWorker;
  log('初始化 OCR 引擎 (chi_sim+eng)...');
  try {
    // 使用 CDN 路径加载 worker，避免 blob URL 被 CSP 拦截
    const worker = await Tesseract.createWorker('chi_sim+eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text') {
          showProgress('OCR 识别中', m.status, Math.round(m.progress * 100));
        } else {
          log(`OCR: ${m.status} ${Math.round((m.progress || 0) * 100)}%`);
        }
      },
      workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
    });
    state.ocrWorker = worker;
    return worker;
  } catch (err) {
    log(`OCR 引擎初始化失败: ${err.message}`);
    log('提示：浏览器安全策略阻止了 Worker 创建。请尝试 Chrome/Edge，或使用下方手动输入功能。');
    throw err;
  }
}

async function ocrCanvas(canvas) {
  const worker = await initOCR();
  const { data: { text } } = await worker.recognize(canvas);
  return text;
}

async function ocrPage(pdfDoc, pageIndex, dpi) {
  const canvas = await renderPageToCanvas(pdfDoc, pageIndex, dpi);
  return await ocrCanvas(canvas);
}

// ===== TOC Detection =====
function matchTOCLine(line) {
  const trimmed = line.trim();
  if (trimmed.length < 3) return null;
  // Pattern 1: title .... 123 (with dot leaders)
  let m = trimmed.match(/^(.+?)[\.\u2026\u00b7\ufe52\u05f4]{3,}\s*(\d{1,4})\s*$/);
  if (m) return { title: m[1].trim(), page: parseInt(m[2]) };
  // Pattern 2: title \t 123 (tab separated)
  m = trimmed.match(/^(.+?)\t+(\d{1,4})\s*$/);
  if (m) return { title: m[1].trim(), page: parseInt(m[2]) };
  // Pattern 3: title 123 (space before number, title must have 2+ chars)
  m = trimmed.match(/^(.{2,}?)\s{2,}(\d{1,4})\s*$/);
  if (m) return { title: m[1].trim(), page: parseInt(m[2]) };
  // Pattern 4: title 123 (single space, but title must look like a title)
  m = trimmed.match(/^(.{2,}?)\s+(\d{1,4})\s*$/);
  if (m && !/^\d+$/.test(m[1].trim())) return { title: m[1].trim(), page: parseInt(m[2]) };
  return null;
}

function scoreTOCPage(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 3) return 0;
  let matches = 0;
  for (const line of lines) {
    if (matchTOCLine(line)) matches++;
  }
  return matches / lines.length;
}

async function findTOCPages(pdfDoc, hasText) {
  const maxPages = Math.min(CONFIG.maxScanPages, pdfDoc.numPages);
  const scores = [];

  for (let i = 0; i < maxPages; i++) {
    showProgress('扫描目录页', `第 ${i + 1}/${maxPages} 页`, (i / maxPages) * 100);
    let text;
    if (hasText) {
      text = await getPageText(pdfDoc, i);
    } else {
      // OCR at low DPI for speed
      text = await ocrPage(pdfDoc, i, CONFIG.scanDPI);
    }
    const score = scoreTOCPage(text);
    scores.push({ index: i, score, text });
    log(`第${i + 1}页 TOC评分: ${(score * 100).toFixed(0)}%`);
  }

  // Find pages above threshold
  const tocPages = scores.filter(s => s.score >= CONFIG.tocScoreThreshold)
    .sort((a, b) => b.score - a.score);

  if (tocPages.length === 0) {
    // Fallback: take the best page if any has matches
    const best = scores.sort((a, b) => b.score - a.score)[0];
    if (best && best.score > 0) {
      tocPages.push(best);
    }
  }

  return tocPages.sort((a, b) => a.index - b.index);
}

// ===== TOC Parsing =====
function detectLevel(title) {
  // Level 1: 第X章/篇/部, Chapter X, Part X, 一、
  if (/^第[一二三四五六七八九十百\d]+[章篇部编]/.test(title)) return 1;
  if (/^Chapter\s+\d+/i.test(title)) return 1;
  if (/^Part\s+\d+/i.test(title)) return 1;
  if (/^[一二三四五六七八九十]+[\u3001.]/.test(title)) return 1;
  if (/^附录|^Appendix|^序|^前言|^引言|^后记|^索引|^致谢/.test(title)) return 1;
  // Level 3: X.X.X
  if (/^\d+\.\d+\.\d+/.test(title)) return 3;
  // Level 2: X.X
  if (/^\d+\.\d+/.test(title)) return 2;
  if (/^第[一二三四五六七八九十\d]+节/.test(title)) return 2;
  // Default
  return 1;
}

function parseTOCText(text) {
  const lines = text.split('\n');
  const entries = [];
  for (const line of lines) {
    const match = matchTOCLine(line);
    if (match) {
      entries.push({
        title: match.title,
        page: match.page,
        level: detectLevel(match.title),
      });
    }
  }
  return removeDuplicateEntries(entries);
}

function removeDuplicateEntries(entries) {
  if (entries.length < 2) return entries;

  // Detect whole-list duplication: the first half is identical to the second half.
  // This happens when OCR reads two TOC pages that contain the same visible content
  // (e.g. a duplicate scanned page, or a two-page spread that is processed twice).
  if (entries.length % 2 === 0) {
    const half = entries.length / 2;
    let repeated = true;
    for (let i = 0; i < half; i++) {
      const a = entries[i];
      const b = entries[i + half];
      if (a.title !== b.title || a.page !== b.page) {
        repeated = false;
        break;
      }
    }
    if (repeated) {
      return entries.slice(0, half);
    }
  }

  // Fallback: remove exact duplicate title+page pairs
  const seen = new Set();
  return entries.filter(e => {
    const key = e.title + '|' + e.page;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ===== Offset Detection =====
async function detectOffset(pdfDoc, entries, hasText) {
  if (!hasText || entries.length === 0) return 5; // default for scanned PDFs

  // Try to find the first entry's title in pages around its printed page number
  for (const entry of entries.slice(0, 3)) {
    if (!entry.page) continue;
    for (let offset = 0; offset <= 20; offset++) {
      const pageIndex = entry.page + offset - 1; // 0-based
      if (pageIndex < 0 || pageIndex >= pdfDoc.numPages) continue;
      try {
        const text = await getPageText(pdfDoc, pageIndex);
        // Check if title (or a significant part) appears on this page
        const titlePart = entry.title.substring(0, Math.min(6, entry.title.length));
        if (text.includes(titlePart) || text.includes(entry.title)) {
          log(`偏移检测: "${entry.title}" 在 PDF 第 ${pageIndex + 1} 页找到，偏移=${offset}`);
          return offset;
        }
      } catch (e) { /* skip */ }
    }
  }
  return 5; // default
}

function buildPythonScript(entries, offset, fileName) {
  const toc = entries.map(e => [e.level, e.title, e.page + offset]);
  const tocJson = JSON.stringify(toc, null, 2);
  return `# -*- coding: utf-8 -*-
"""
PDF 书签写入脚本
由 PDF 书签生成器 (https://hadesfox.github.io/pdf-toc-tool/) 自动生成

原始文件: ${fileName}
书签数量: ${entries.length}
页码偏移: ${offset}（印刷页码 + ${offset} = PDF 页码）

使用方法:
  1. 安装依赖:  pip install pymupdf
  2. 运行脚本:  python apply_toc.py 输入.pdf 输出.pdf
"""

import sys
import fitz

TOC = ${tocJson}


def add_bookmarks(input_path, output_path):
    doc = fitz.open(input_path)
    # 清除原有书签（如果存在的话）
    doc.set_toc([])
    # 写入新书签
    doc.set_toc(TOC)
    doc.save(output_path, garbage=4, deflate=True)
    doc.close()
    print(f"已保存: {output_path} (共 {len(TOC)} 个书签)")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("用法: python apply_toc.py <输入PDF> <输出PDF>")
        print("示例: python apply_toc.py \\"${fileName.replace(/"/g, '\\"')}\\" \\"${fileName.replace(/\.pdf$/i, '_bookmarked.pdf').replace(/"/g, '\\"')}\\"")
        sys.exit(1)
    add_bookmarks(sys.argv[1], sys.argv[2])
`;
}

function downloadLocalScript() {
  const script = buildPythonScript(state.tocEntries, state.offset, state.file.name);
  const blob = new Blob([script], { type: 'text/x-python;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'apply_toc.py';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  log('已下载本地处理脚本: apply_toc.py');
}

function downloadJSON() {
  const data = {
    source: state.file.name,
    offset: state.offset,
    generatedAt: new Date().toISOString(),
    toc: state.tocEntries.map(e => ({
      level: e.level,
      title: e.title,
      printedPage: e.page,
      pdfPage: e.page + state.offset,
    })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.file.name.replace(/\.pdf$/i, '') + '_toc.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  log('已下载 JSON 数据');
}

function showDownloadResult(success) {
  const l1 = state.tocEntries.filter(e => e.level === 1).length;
  const l2 = state.tocEntries.filter(e => e.level === 2).length;
  const l3 = state.tocEntries.filter(e => e.level === 3).length;
  const card = document.querySelector('#step-download .card');
  card.innerHTML = '';

  if (success) {
    card.innerHTML = `
      <div class="success-icon">✅</div>
      <h2>完成！</h2>
      <p id="result-summary">
        文件: <b>${escapeHtml(state.outputFileName)}</b><br>
        书签数: <b>${state.tocEntries.length}</b> 个
        （一级 ${l1} / 二级 ${l2} / 三级 ${l3}）<br>
        页码偏移: <b>${state.offset}</b>
      </p>
      <button class="btn primary large" id="btn-download">⬇ 下载 PDF</button>
      <button class="btn" id="btn-download-script">⬇ 也下载本地脚本（备用）</button>
      <button class="btn" id="btn-reset">处理另一个文件</button>
    `;
  } else {
    card.innerHTML = `
      <div class="success-icon" style="color: #f59e0b;">⚠️</div>
      <h2>浏览器无法直接保存此 PDF</h2>
      <p id="result-summary">
        这个 PDF 文件较大（扫描版或对象数很多），前端 pdf-lib 在保存时超出了浏览器调用栈限制。<br><br>
        文件: <b>${escapeHtml(state.file.name)}</b><br>
        书签数: <b>${state.tocEntries.length}</b> 个
        （一级 ${l1} / 二级 ${l2} / 三级 ${l3}）<br>
        页码偏移: <b>${state.offset}</b><br><br>
        请下载下面的 Python 脚本，在本地运行即可写入书签。
      </p>
      <button class="btn primary large" id="btn-download-script">⬇ 下载 Python 脚本</button>
      <button class="btn" id="btn-download-json">⬇ 下载 JSON 数据</button>
      <button class="btn" id="btn-reset">处理另一个文件</button>
    `;
  }

  // Re-bind buttons
  const btnDownload = $('btn-download');
  if (btnDownload) btnDownload.addEventListener('click', download);
  $('btn-download-script').addEventListener('click', downloadLocalScript);
  const btnJson = $('btn-download-json');
  if (btnJson) btnJson.addEventListener('click', downloadJSON);
  $('btn-reset').addEventListener('click', reset);
}

// ===== PDF Writing (pdf-lib) =====
function buildOutlineTree(entries) {
  const root = { children: [], level: 0 };
  const stack = [root];
  for (const entry of entries) {
    const node = {
      title: entry.title,
      pdfPageIndex: entry.pdfPageIndex,
      level: entry.level,
      children: [],
    };
    while (stack.length > 1 && stack[stack.length - 1].level >= entry.level) {
      stack.pop();
    }
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

function countVisible(nodes) {
  let count = 0;
  for (const node of nodes) {
    count++;
    count += countVisible(node.children);
  }
  return count;
}

function createOutlineItems(nodes, parentRef, context, pages) {
  const { PDFName, PDFNumber, PDFHexString, PDFDict } = PDFLib;
  const refs = [];

  for (const node of nodes) {
    const pageIndex = Math.max(0, Math.min(pages.length - 1, node.pdfPageIndex));
    const pageRef = pages[pageIndex].ref;
    const titleStr = '\uFEFF' + node.title;

    const dict = PDFDict.withContext(context);
    dict.set(PDFName.of('Title'), PDFHexString.of(titleStr));
    dict.set(PDFName.of('Parent'), parentRef);
    dict.set(PDFName.of('Dest'), context.obj([pageRef, PDFName.of('Fit')]));

    const ref = context.obj(dict);
    refs.push(ref);
  }

  // Set Prev/Next for siblings
  for (let i = 0; i < refs.length; i++) {
    const dict = context.lookup(refs[i]);
    if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
    if (i < refs.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
  }

  // Recursively create children
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].children && nodes[i].children.length > 0) {
      const childRefs = createOutlineItems(nodes[i].children, refs[i], context, pages);
      const dict = context.lookup(refs[i]);
      dict.set(PDFName.of('First'), childRefs[0]);
      dict.set(PDFName.of('Last'), childRefs[childRefs.length - 1]);
      dict.set(PDFName.of('Count'), PDFNumber.of(countVisible(nodes[i].children)));
    }
  }

  return refs;
}

async function generateBookmarkedPDF(file, entries, offset) {
  const { PDFDocument, PDFName, PDFNumber, PDFDict } = PDFLib;

  log('加载 PDF 到 pdf-lib...');
  const bytes = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  log('PDF 加载完成');

  const pages = pdfDoc.getPages();
  log(`获取到 ${pages.length} 页`);

  // Calculate PDF page indices (0-based)
  const entriesWithPages = entries.map(e => ({
    ...e,
    pdfPageIndex: e.page + offset - 1,
  })).filter(e => e.pdfPageIndex >= 0 && e.pdfPageIndex < pages.length);

  if (entriesWithPages.length === 0) {
    throw new Error('没有有效的书签条目');
  }

  // Build outline tree
  log('构建书签树...');
  const tree = buildOutlineTree(entriesWithPages);
  const context = pdfDoc.context;

  // Create outlines dictionary
  log('创建大纲字典...');
  const outlinesDict = PDFDict.withContext(context);
  outlinesDict.set(PDFName.of('Type'), PDFName.of('Outlines'));
  const outlinesRef = context.obj(outlinesDict);

  if (tree.length > 0) {
    const topRefs = createOutlineItems(tree, outlinesRef, context, pages);
    const outlinesRoot = context.lookup(outlinesRef);
    outlinesRoot.set(PDFName.of('First'), topRefs[0]);
    outlinesRoot.set(PDFName.of('Last'), topRefs[topRefs.length - 1]);
    outlinesRoot.set(PDFName.of('Count'), PDFNumber.of(countVisible(tree)));
  }

  // Replace existing outlines in catalog
  log('替换目录中的大纲...');
  pdfDoc.catalog.set(PDFName.of('Outlines'), outlinesRef);

  // Save with options that reduce stack usage for large PDFs
  log('开始保存 PDF，这可能需要一些时间...');
  const outputBytes = await pdfDoc.save({
    useObjectStreams: false,
    updateFieldAppearances: false,
  });
  log('PDF 保存完成');
  return new Blob([outputBytes], { type: 'application/pdf' });
}

// ===== UI: TOC Table =====
function renderTOCTable() {
  const tbody = $('toc-body');
  tbody.innerHTML = '';
  state.tocEntries.forEach((entry, index) => {
    const pdfPage = entry.page + state.offset;
    const tr = document.createElement('tr');
    tr.className = `level-${entry.level}`;
    tr.innerHTML = `
      <td>
        <select data-index="${index}" data-field="level">
          <option value="1" ${entry.level === 1 ? 'selected' : ''}>1</option>
          <option value="2" ${entry.level === 2 ? 'selected' : ''}>2</option>
          <option value="3" ${entry.level === 3 ? 'selected' : ''}>3</option>
        </select>
      </td>
      <td>
        <input type="text" data-index="${index}" data-field="title" value="${escapeHtml(entry.title)}">
      </td>
      <td>
        <input type="number" data-index="${index}" data-field="page" value="${entry.page}" min="1" max="9999">
      </td>
      <td class="pdf-page-cell">→ ${pdfPage}</td>
      <td>
        <button class="btn-delete" data-index="${index}">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Attach event listeners
  tbody.querySelectorAll('select, input').forEach(el => {
    el.addEventListener('change', onEntryEdit);
  });
  tbody.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', onEntryDelete);
  });

  updatePreview();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML.replace(/"/g, '&quot;');
}

function onEntryEdit(e) {
  const index = parseInt(e.target.dataset.index);
  const field = e.target.dataset.field;
  let value = e.target.value;
  if (field === 'level' || field === 'page') value = parseInt(value);
  state.tocEntries[index][field] = value;
  if (field === 'page' || field === 'level') renderTOCTable();
}

function onEntryDelete(e) {
  const index = parseInt(e.target.dataset.index);
  state.tocEntries.splice(index, 1);
  renderTOCTable();
}

function deduplicate() {
  const before = state.tocEntries.length;
  state.tocEntries = removeDuplicateEntries(state.tocEntries);
  const after = state.tocEntries.length;
  log(`清除重复：从 ${before} 条合并为 ${after} 条`);
  renderTOCTable();
}

function addEntry() {
  state.tocEntries.push({ title: '新书签', page: 1, level: 1 });
  renderTOCTable();
}

function updatePreview() {
  const preview = $('toc-preview');
  if (state.tocEntries.length === 0) {
    preview.classList.remove('visible');
    return;
  }
  const count = state.tocEntries.length;
  const l1 = state.tocEntries.filter(e => e.level === 1).length;
  const l2 = state.tocEntries.filter(e => e.level === 2).length;
  const l3 = state.tocEntries.filter(e => e.level === 3).length;
  const offsetVal = state.offset;
  preview.innerHTML = `共 <b>${count}</b> 个书签 · 一级 ${l1} / 二级 ${l2} / 三级 ${l3} · 偏移 ${offsetVal}（印刷页码 + ${offsetVal} = PDF页码）`;
  preview.classList.add('visible');

  // Update offset hint
  $('offset-hint').textContent = `印刷页码 + ${state.offset} = PDF页码`;
}

// ===== Main Flow =====
async function processFile(file) {
  state.file = file;
  showStep('step-processing');
  $('log-area').innerHTML = '';
  $('log-area').classList.remove('visible');
  showProgress('加载 PDF', file.name, 5);

  try {
    // 1. Load PDF
    state.pdfDoc = await loadPDF(file);
    state.numPages = state.pdfDoc.numPages;
    log(`PDF 加载完成: ${state.numPages} 页`);

    // Check existing bookmarks
    try {
      const outline = await state.pdfDoc.getOutline();
      if (outline && outline.length > 0) {
        const hasRealTitles = outline.some(item => {
          const t = (item.title || '').trim();
          return t && isNaN(Number(t));
        });
        if (hasRealTitles) {
          log(`注意: PDF 已有 ${outline.length} 个书签，将被替换`);
        }
      }
    } catch (e) { /* ignore */ }

    // 2. Check if text layer exists
    showProgress('检测文字层', '正在分析...', 10);
    state.hasTextLayer = await checkHasTextLayer(state.pdfDoc);
    log(`文字层: ${state.hasTextLayer ? '有' : '无（扫描版）'}`);

    // 3. Find TOC pages
    showProgress('扫描目录页', '正在扫描...', 15);
    const tocPages = await findTOCPages(state.pdfDoc, state.hasTextLayer);

    if (tocPages.length === 0 || tocPages[0].score === 0) {
      log('未检测到目录页，将使用手动模式');
      state.tocEntries = [];
      state.offset = 0;
      showStep('step-review');
      renderTOCTable();
      return;
    }

    state.tocPageIndices = tocPages.map(p => p.index);
    log(`检测到目录页: ${state.tocPageIndices.map(i => i + 1).join(', ')}`);

    // 4. Get TOC text (high quality)
    let tocText = '';
    for (let i = 0; i < state.tocPageIndices.length; i++) {
      const idx = state.tocPageIndices[i];
      showProgress('OCR 目录页', `第 ${idx + 1} 页 (${i + 1}/${state.tocPageIndices.length})`, 50 + i * 15);
      if (state.hasTextLayer) {
        tocText += await getPageText(state.pdfDoc, idx) + '\n';
      } else {
        tocText += await ocrPage(state.pdfDoc, idx, CONFIG.ocrDPI) + '\n';
      }
    }

    // 5. Parse TOC
    state.tocEntries = parseTOCText(tocText);
    log(`解析出 ${state.tocEntries.length} 个目录条目`);

    if (state.tocEntries.length === 0) {
      log('目录解析失败，使用手动模式');
      state.offset = 0;
      showStep('step-review');
      renderTOCTable();
      return;
    }

    // 6. Detect offset
    showProgress('计算页码偏移', '正在校准...', 85);
    state.offset = await detectOffset(state.pdfDoc, state.tocEntries, state.hasTextLayer);
    log(`页码偏移: ${state.offset}`);

    // 7. Show review
    showProgress('完成', '请检查并确认', 100);
    await delay(300);
    showStep('step-review');
    $('offset-input').value = state.offset;
    renderTOCTable();

    // Cleanup OCR worker
    if (state.ocrWorker) {
      await state.ocrWorker.terminate();
      state.ocrWorker = null;
    }
  } catch (err) {
    log(`错误: ${err.message}`);
    showProgress('处理失败', err.message, 0);
    console.error(err);

    // OCR Worker 创建失败（CSP 限制等）→ 切换到手动输入模式
    if (err.message.includes('Worker') || err.message.includes('CSP') || err.message.includes('Security') || err.message.includes('Content Security')) {
      log('自动识别失败，已切换到手动输入模式。请直接在下方表格中添加书签。');
      state.tocEntries = [];
      state.offset = 0;
      showStep('step-review');
      renderTOCTable();
    }
  }
}

async function generate() {
  try {
    showStep('step-processing');
    showProgress('生成 PDF', '正在写入书签...', 50);
    log(`开始生成: ${state.tocEntries.length} 个书签, 偏移=${state.offset}`);

    const blob = await generateBookmarkedPDF(state.file, state.tocEntries, state.offset);
    state.outputBlob = blob;
    state.outputFileName = state.file.name.replace(/\.pdf$/i, '') + '_bookmarked.pdf';

    showProgress('完成', '书签已写入', 100);
    showDownloadResult(true);
    showStep('step-download');
  } catch (err) {
    log(`生成失败: ${err.message}`);
    showProgress('生成失败', err.message, 0);
    console.error(err);

    // Browser pdf-lib cannot handle large scanned PDFs due to call stack limits.
    // Fall back to a local Python script that uses PyMuPDF.
    const isLargeFileError = err.message.includes('call stack') ||
      err.message.includes('too large') ||
      err.message.includes('Maximum');
    if (isLargeFileError) {
      log('已启用本地脚本回退方案，请在本地运行 Python 脚本写入书签');
      showDownloadResult(false);
      showStep('step-download');
    }
  }
}

function download() {
  const url = URL.createObjectURL(state.outputBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.outputFileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reset() {
  state.file = null;
  state.pdfDoc = null;
  state.tocEntries = [];
  state.offset = 0;
  state.outputBlob = null;
  $('log-area').innerHTML = '';
  $('log-area').classList.remove('visible');
  showStep('step-upload');
}

// ===== Event Listeners =====
function init() {
  const dropzone = $('dropzone');
  const fileInput = $('file-input');

  // Dropzone click
  dropzone.addEventListener('click', () => fileInput.click());

  // File input change
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) processFile(e.target.files[0]);
  });

  // Drag & drop
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files[0] && e.dataTransfer.files[0].name.endsWith('.pdf')) {
      processFile(e.dataTransfer.files[0]);
    }
  });

  // Offset controls
  $('offset-input').addEventListener('change', (e) => {
    state.offset = parseInt(e.target.value) || 0;
    renderTOCTable();
  });
  $('offset-up').addEventListener('click', () => {
    state.offset++;
    $('offset-input').value = state.offset;
    renderTOCTable();
  });
  $('offset-down').addEventListener('click', () => {
    state.offset--;
    $('offset-input').value = state.offset;
    renderTOCTable();
  });

  // Action buttons
  $('btn-add').addEventListener('click', addEntry);
  $('btn-dedup').addEventListener('click', deduplicate);
  $('btn-rescan').addEventListener('click', reset);
  $('btn-generate').addEventListener('click', generate);
  $('btn-download').addEventListener('click', download);
  $('btn-reset').addEventListener('click', reset);
}

init();
