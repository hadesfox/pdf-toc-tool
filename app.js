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
  const worker = await Tesseract.createWorker('chi_sim+eng', 1, {
    logger: m => {
      if (m.status === 'recognizing text') {
        showProgress('OCR 识别中', m.status, Math.round(m.progress * 100));
      } else {
        log(`OCR: ${m.status} ${Math.round((m.progress || 0) * 100)}%`);
      }
    }
  });
  state.ocrWorker = worker;
  return worker;
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
  // Deduplicate (OCR might produce duplicates)
  const seen = new Set();
  return entries.filter(e => {
    const key = e.title + e.page;
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
  const { PDFName, PDFNumber, PDFHexString } = PDFLib;
  const refs = [];

  for (const node of nodes) {
    const pageIndex = Math.max(0, Math.min(pages.length - 1, node.pdfPageIndex));
    const pageRef = pages[pageIndex].ref;
    // Create outline item with UTF-16BE BOM for Chinese support
    const titleStr = '\uFEFF' + node.title;
    const ref = context.obj({
      Title: PDFHexString.of(titleStr),
      Parent: parentRef,
      Dest: [pageRef, PDFName.of('Fit')],
    });
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
      dict.set(PDFName.of('Count'), PDFNumber.of(childRefs.length));
    }
  }

  return refs;
}

async function generateBookmarkedPDF(file, entries, offset) {
  const { PDFDocument, PDFName, PDFNumber, PDFHexString } = PDFLib;

  const bytes = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.load(bytes);
  const pages = pdfDoc.getPages();

  // Calculate PDF page indices (0-based)
  const entriesWithPages = entries.map(e => ({
    ...e,
    pdfPageIndex: e.page + offset - 1,
  })).filter(e => e.pdfPageIndex >= 0 && e.pdfPageIndex < pages.length);

  if (entriesWithPages.length === 0) {
    throw new Error('没有有效的书签条目');
  }

  // Build outline tree
  const tree = buildOutlineTree(entriesWithPages);
  const context = pdfDoc.context;

  // Create outlines dictionary
  const outlinesRef = context.obj({ Type: 'Outlines' });

  if (tree.length > 0) {
    const topRefs = createOutlineItems(tree, outlinesRef, context, pages);
    const outlinesDict = context.lookup(outlinesRef);
    outlinesDict.set(PDFName.of('First'), topRefs[0]);
    outlinesDict.set(PDFName.of('Last'), topRefs[topRefs.length - 1]);
    outlinesDict.set(PDFName.of('Count'), PDFNumber.of(countVisible(tree)));
  }

  // Replace existing outlines in catalog
  pdfDoc.catalog.set(PDFName.of('Outlines'), outlinesRef);

  // Save
  const outputBytes = await pdfDoc.save();
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

    const l1 = state.tocEntries.filter(e => e.level === 1).length;
    const l2 = state.tocEntries.filter(e => e.level === 2).length;
    const l3 = state.tocEntries.filter(e => e.level === 3).length;

    $('result-summary').innerHTML = `
      文件: <b>${escapeHtml(state.outputFileName)}</b><br>
      书签数: <b>${state.tocEntries.length}</b> 个
      （一级 ${l1} / 二级 ${l2} / 三级 ${l3}）<br>
      页码偏移: <b>${state.offset}</b>
    `;

    showProgress('完成', '书签已写入', 100);
    showStep('step-download');
  } catch (err) {
    log(`生成失败: ${err.message}`);
    showProgress('生成失败', err.message, 0);
    console.error(err);
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
  $('btn-rescan').addEventListener('click', reset);
  $('btn-generate').addEventListener('click', generate);
  $('btn-download').addEventListener('click', download);
  $('btn-reset').addEventListener('click', reset);
}

init();
