(function () {
    'use strict';

    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);

    const dropZone = $('#dropZone');
    const fileInput = $('#fileInput');
    const controls = $('#controls');
    const results = $('#results');
    const stats = $('#stats');
    const progressBar = $('#progressBar');
    const progressFill = $('#progressFill');
    const progressText = $('#progressText');
    const pageRangeInput = $('#pageRange');
    const layoutModeSelect = $('#layoutMode');
    const fontThresholdInput = $('#fontThreshold');
    const fontThresholdVal = $('#fontThresholdVal');
    const btnConvert = $('#btnConvert');
    const btnReset = $('#btnReset');

    let currentPdf = null;
    let generatedHtml = '';

    // ======================== EVENT HANDLERS ========================

    ['dragenter', 'dragover'].forEach(e =>
        dropZone.addEventListener(e, (ev) => { ev.preventDefault(); dropZone.classList.add('dragover'); })
    );
    ['dragleave', 'drop'].forEach(e =>
        dropZone.addEventListener(e, (ev) => { ev.preventDefault(); dropZone.classList.remove('dragover'); })
    );
    dropZone.addEventListener('drop', (ev) => {
        const file = ev.dataTransfer.files[0];
        if (file && file.type === 'application/pdf') loadPdf(file);
    });
    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        if (e.target.files[0]) loadPdf(e.target.files[0]);
    });

    fontThresholdInput.addEventListener('input', () => {
        fontThresholdVal.textContent = fontThresholdInput.value + 'px';
    });

    btnConvert.addEventListener('click', runConversion);
    btnReset.addEventListener('click', resetAll);

    $$('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            $$('.tab').forEach(t => t.classList.remove('active'));
            $$('.tab-pane').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            $(`#tab${capitalize(tab.dataset.tab)}`).classList.add('active');
        });
    });

    $('#btnCopyHtml').addEventListener('click', () => {
        navigator.clipboard.writeText(generatedHtml).then(() => showToast('已复制到剪贴板'));
    });
    $('#btnDownloadHtml').addEventListener('click', () => {
        downloadFile('converted.html', generatedHtml, 'text/html');
    });
    $('#btnDownloadWithAssets').addEventListener('click', () => {
        downloadFile('converted_standalone.html', wrapStandaloneHtml(generatedHtml), 'text/html');
    });

    function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

    // ======================== PDF LOADING ========================

    async function loadPdf(file) {
        showProgress('加载 PDF...');
        const arrayBuffer = await file.arrayBuffer();
        currentPdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        controls.classList.remove('hidden');
        btnConvert.disabled = false;
        pageRangeInput.placeholder = `共 ${currentPdf.numPages} 页`;
        pageRangeInput.value = '';
        hideProgress();
        showToast(`已加载: ${file.name} (${currentPdf.numPages} 页)`);
    }

    // ======================== MAIN CONVERSION ========================

    async function runConversion() {
        if (!currentPdf) return;
        btnConvert.disabled = true;

        const startTime = performance.now();
        const pages = parsePageRange(pageRangeInput.value, currentPdf.numPages);
        const fontThreshold = parseInt(fontThresholdInput.value);
        const layoutMode = layoutModeSelect.value;

        showProgress('提取文本...');
        const allPagesData = [];

        for (let i = 0; i < pages.length; i++) {
            updateProgress((i / pages.length) * 50, `提取第 ${pages[i]} 页...`);
            const items = await extractPageItems(pages[i]);
            allPagesData.push(items);
        }

        updateProgress(55, '分析布局...');
        const structure = analyzeAllPages(allPagesData, layoutMode);

        updateProgress(85, '生成 HTML...');
        generatedHtml = buildHtml(structure, fontThreshold);

        updateProgress(100, '完成');
        const elapsed = Math.round(performance.now() - startTime);

        $('#htmlPreview').innerHTML = `<div class="paper-container">${generatedHtml}</div>`;
        const srcEl = $('#htmlSource');
        srcEl.textContent = generatedHtml;
        hljs.highlightElement(srcEl);

        stats.classList.remove('hidden');
        $('#statPages').textContent = pages.length;
        $('#statBlocks').textContent = structure.totalBlocks;
        $('#statColumns').textContent = structure.columnCount;
        $('#statTime').textContent = elapsed + 'ms';

        results.classList.remove('hidden');
        btnConvert.disabled = false;
        setTimeout(hideProgress, 800);
    }

    // ======================== TEXT EXTRACTION ========================

    async function extractPageItems(pageNum) {
        const page = await currentPdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.0 });
        const textContent = await page.getTextContent();

        return textContent.items
            .filter(item => item.str.trim().length > 0)
            .map(item => {
                const tx = item.transform;
                const fontSize = Math.abs(tx[3]);
                // PDF flags: bit 4 (16) = bold, bit 1 (2) = italic, bit 3 (8) = monospace
                const fn = (item.fontName || '').toLowerCase();
                const isBold = fn.includes('bold') || fn.includes('medi');
                const isItalic = fn.includes('italic') || fn.includes('ital');
                const isMono = fn.includes('t1x') || fn.includes('mono') ||
                    fn.includes('courier') || fn.includes('consol');

                return {
                    text: item.str,
                    x: tx[4],
                    y: viewport.height - tx[5],
                    width: item.width,
                    height: item.height,
                    fontSize: fontSize,
                    isBold: isBold,
                    isItalic: isItalic,
                    isMono: isMono,
                    fontFamily: item.fontName || '',
                    pageWidth: viewport.width,
                    pageHeight: viewport.height,
                    page: pageNum
                };
            });
    }

    // ======================== PAGE ANALYSIS ========================

    function analyzeAllPages(pagesData, mode) {
        if (pagesData.length === 0 || pagesData[0].length === 0) {
            return { title: '', authors: [], abstract: '', sections: [], references: [], columnCount: 1, totalBlocks: 0 };
        }

        const pageWidth = pagesData[0][0].pageWidth;
        const pageHeight = pagesData[0][0].pageHeight;

        // Detect column layout from first page
        const colCount = mode === 'auto' ? detectColumnCount(pagesData[0], pageWidth) : (mode === 'double' ? 2 : 1);
        const colGap = detectColumnGap(pagesData[0], pageWidth);

        // Process each page independently, then merge
        const allStructuredBlocks = [];

        for (let pIdx = 0; pIdx < pagesData.length; pIdx++) {
            const pageItems = pagesData[pIdx];
            const pageNum = pIdx + 1;
            const pageBlocks = processPage(pageItems, pageNum, pageWidth, pageHeight, colCount, colGap);
            allStructuredBlocks.push(...pageBlocks);
        }

        // Detect document structure from all blocks
        const structure = detectDocumentStructure(allStructuredBlocks, pageWidth, colCount);
        structure.columnCount = colCount;
        structure.totalBlocks = allStructuredBlocks.length;

        return structure;
    }

    function detectColumnGap(items, pageWidth) {
        // Use only body-text-sized items for gap detection (filter out title, headers)
        const bodyItems = items.filter(i => i.fontSize < 12 && i.width < pageWidth * 0.5);
        if (bodyItems.length < 10) {
            // Fallback: assume standard ACM/IEEE layout
            return { left: pageWidth * 0.48, right: pageWidth * 0.52, mid: pageWidth / 2 };
        }

        // Find the gap between columns by looking at x-coordinate distribution
        const midX = pageWidth / 2;
        let leftMax = 0;
        let rightMin = pageWidth;

        for (const item of bodyItems) {
            if (item.x < midX) {
                leftMax = Math.max(leftMax, item.x + item.width);
            } else {
                rightMin = Math.min(rightMin, item.x);
            }
        }

        // Ensure gap is reasonable
        if (leftMax >= rightMin) {
            return { left: pageWidth * 0.48, right: pageWidth * 0.52, mid: pageWidth / 2 };
        }

        return { left: leftMax, right: rightMin, mid: (leftMax + rightMin) / 2 };
    }

    function detectColumnCount(items, pageWidth) {
        const midX = pageWidth / 2;
        let leftCount = 0;
        let rightCount = 0;

        for (const item of items) {
            const itemMid = item.x + item.width / 2;
            if (itemMid < midX) leftCount++;
            else rightCount++;
        }

        const total = leftCount + rightCount;
        if (total === 0) return 1;
        return (Math.min(leftCount, rightCount) / Math.max(leftCount, rightCount)) > 0.2 ? 2 : 1;
    }

    function processPage(items, pageNum, pageWidth, pageHeight, colCount, colGap) {
        if (items.length === 0) return [];

        if (colCount === 2) {
            return processPageDoubleColumn(items, pageNum, pageWidth, pageHeight, colGap);
        } else {
            return processPageSingleColumn(items, pageNum, pageWidth, pageHeight);
        }
    }

    function processPageSingleColumn(items, pageNum, pageWidth, pageHeight) {
        const lines = groupItemsIntoLines(sortByY(items));
        return lines.map(line => lineToBlock(line, pageNum, pageWidth, 'full'));
    }

    function processPageDoubleColumn(items, pageNum, pageWidth, pageHeight, colGap) {
        // Step 1: Group ALL items into lines (regardless of column)
        const allLines = groupItemsIntoLines(sortByY(items));

        // Step 2: Classify each line
        const fullLines = [];
        const leftLines = [];
        const rightLines = [];

        for (const line of allLines) {
            const lineLeft = line.x;
            const lineRight = line.x + line.width;

            // Check if line spans the column gap
            if (lineLeft < colGap.left - 10 && lineRight > colGap.right + 10) {
                fullLines.push(line);
            }
            // Line is entirely in right column
            else if (lineLeft >= colGap.mid - 20) {
                rightLines.push(line);
            }
            // Line is entirely in left column
            else if (lineRight <= colGap.mid + 20) {
                leftLines.push(line);
            }
            // Line starts in left but extends into gap → treat as left column
            else if (lineLeft < colGap.mid) {
                leftLines.push(line);
            } else {
                rightLines.push(line);
            }
        }

        // Step 3: Convert to blocks
        const fullBlocks = fullLines.map(line => lineToBlock(line, pageNum, pageWidth, 'full'));
        const leftBlocks = leftLines.map(line => lineToBlock(line, pageNum, pageWidth, 'left'));
        const rightBlocks = rightLines.map(line => lineToBlock(line, pageNum, pageWidth, 'right'));

        // Step 4: Merge in reading order: full-width first, then left, then right
        return [...fullBlocks, ...leftBlocks, ...rightBlocks];
    }

    function sortByY(items) {
        return [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    }

    function groupItemsIntoLines(items) {
        if (items.length === 0) return [];

        const lines = [];
        let currentLine = [items[0]];
        let lastY = items[0].y;

        for (let i = 1; i < items.length; i++) {
            const item = items[i];
            const yDiff = Math.abs(item.y - lastY);

            // Items on the same line have very similar y coordinates
            // Use a tolerance based on font size (typically 3-5px for same-line items)
            if (yDiff < 4) {
                currentLine.push(item);
            } else {
                lines.push(buildLine(currentLine));
                currentLine = [item];
            }
            lastY = item.y;
        }
        lines.push(buildLine(currentLine));

        return lines;
    }

    function buildLine(items) {
        items.sort((a, b) => a.x - b.x);
        const text = items.map(i => i.text).join('');
        const x = items[0].x;
        const y = Math.min(...items.map(i => i.y));
        const right = Math.max(...items.map(i => i.x + i.width));
        const bottom = Math.max(...items.map(i => i.y + i.height));
        const avgFontSize = items.reduce((s, i) => s + i.fontSize, 0) / items.length;
        const hasBold = items.some(i => i.isBold);
        const hasItalic = items.some(i => i.isItalic);
        const hasMono = items.some(i => i.isMono);

        return {
            text,
            x,
            y,
            width: right - x,
            height: bottom - y,
            fontSize: avgFontSize,
            isBold: hasBold,
            isItalic: hasItalic,
            isMono: hasMono,
            centerX: (x + right) / 2,
            items
        };
    }

    function lineToBlock(line, pageNum, pageWidth, column) {
        return {
            text: line.text,
            x: line.x,
            y: line.y,
            width: line.width,
            height: line.height,
            fontSize: line.fontSize,
            isBold: line.isBold,
            isItalic: line.isItalic,
            isMono: line.isMono,
            column,
            page: pageNum,
            lineCount: 1
        };
    }

    // ======================== DOCUMENT STRUCTURE ========================

    function detectDocumentStructure(blocks, pageWidth, colCount) {
        if (blocks.length === 0) {
            return { title: '', authors: [], abstract: '', sections: [], references: '', totalBlocks: 0 };
        }

        // Sort blocks by page, then y position
        blocks.sort((a, b) => a.page - b.page || a.y - b.y);

        // Compute font size statistics (excluding code blocks)
        const textSizes = blocks.filter(b => !b.isMono).map(b => b.fontSize).sort((a, b) => a - b);
        const bodyFontSize = median(textSizes) || 10;

        // Classify each block
        const result = {
            title: '',
            authors: [],
            abstract: '',
            body: [],
            references: '',
            totalBlocks: blocks.length
        };

        let phase = 'header'; // header -> abstract -> body -> references
        let currentSection = null;
        let inCodeBlock = false;

        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            const text = block.text.trim();
            if (!text) continue;

            // ---- TITLE ----
            if (phase === 'header' && !result.title) {
                if (block.fontSize > bodyFontSize * 1.3 && block.isBold) {
                    result.title = text;
                    continue;
                }
                // Fallback: first large bold full-width block
                if (block.fontSize > bodyFontSize * 1.15 && block.column === 'full') {
                    result.title = text;
                    continue;
                }
            }

            // ---- AUTHORS ----
            if (result.title && phase === 'header') {
                if (block.column === 'full' || block.fontSize < bodyFontSize * 1.05) {
                    // Collect author-like blocks (before abstract)
                    if (block.fontSize <= bodyFontSize * 1.05 && block.fontSize >= bodyFontSize * 0.8) {
                        result.authors.push(text);
                        continue;
                    }
                }
                // Transition to next phase when we see abstract or section
                if (/^(?:abstract|摘要|ABSTRACT)/i.test(text)) {
                    phase = 'abstract';
                } else if (isSectionHeading(text, block.isBold)) {
                    phase = 'body';
                }
            }

            // ---- ABSTRACT ----
            if (phase === 'header' || phase === 'abstract') {
                const absMatch = text.match(/^(?:abstract|摘要|ABSTRACT)[:\s—–-]*(.*)/i);
                if (absMatch) {
                    phase = 'abstract';
                    const remainder = absMatch[1].trim();
                    if (remainder) result.abstract = remainder;
                    continue;
                }
            }

            if (phase === 'abstract') {
                // Abstract text continues until we hit a section heading
                if (isSectionHeading(text, block.isBold)) {
                    phase = 'body';
                    // Fall through to body handling
                } else {
                    result.abstract += (result.abstract ? ' ' : '') + text;
                    continue;
                }
            }

            // ---- REFERENCES ----
            const refMatch = text.match(/^(?:references|参考文献|REFERENCES|Bibliography)[:\s.]*/i);
            if (refMatch || (phase === 'references')) {
                phase = 'references';
                if (refMatch) {
                    result.references += text.replace(/^(?:references|参考文献|REFERENCES|Bibliography)[:\s.]*/i, '').trim();
                } else {
                    result.references += '\n' + text;
                }
                continue;
            }

            // ---- SECTION HEADINGS ----
            if (isSectionHeading(text, block.isBold)) {
                const title = cleanSectionTitle(text);
                currentSection = { title, content: [], isSub: isSubSectionHeading(text, block.isBold) };
                result.body.push(currentSection);
                continue;
            }

            // ---- CODE BLOCKS ----
            if (block.isMono) {
                // Group consecutive mono blocks
                if (currentSection && currentSection.content.length > 0) {
                    const lastContent = currentSection.content[currentSection.content.length - 1];
                    if (lastContent.type === 'code') {
                        lastContent.text += '\n' + text;
                        continue;
                    }
                }
                const codeBlock = { type: 'code', text };
                if (currentSection) {
                    currentSection.content.push(codeBlock);
                } else {
                    // No section yet, create implicit one
                    currentSection = { title: '', content: [codeBlock], isSub: false };
                    result.body.push(currentSection);
                }
                continue;
            }

            // ---- REGULAR BODY TEXT ----
            if (currentSection) {
                currentSection.content.push({ type: 'text', text });
            } else {
                // Before any section heading, might be continuation of abstract or intro
                if (result.abstract && !result.title) {
                    result.abstract += ' ' + text;
                } else {
                    currentSection = { title: '', content: [{ type: 'text', text }], isSub: false };
                    result.body.push(currentSection);
                }
            }
        }

        // Clean up: remove trailing empty sections
        while (result.body.length > 0 && result.body[result.body.length - 1].content.length === 0) {
            result.body.pop();
        }

        return result;
    }

    function isSectionHeading(text, isBold) {
        if (!isBold) return false;
        // Numbered sections: "1. Introduction", "2. Background", "3.1 Details"
        if (/^\d+(\.\d+)*\.?\s+[A-Z][a-zA-Z]{2,}/.test(text)) return true;
        // Roman numeral sections: "I. INTRODUCTION", "II. RELATED WORK"
        if (/^[IVX]+\.?\s+[A-Z][a-zA-Z]{2,}/.test(text)) return true;
        // Bold uppercase short text (common in ACM papers): "INTRODUCTION", "RELATED WORK"
        if (text.length >= 5 && text.length < 50 && text === text.toUpperCase() && /^[A-Z]/.test(text)) return true;
        return false;
    }

    function isSubSectionHeading(text, isBold) {
        if (/^\d+\.\d+\.?\s+[A-Z]/.test(text)) return true;
        return false;
    }

    function cleanSectionTitle(text) {
        // Remove leading number/roman numeral
        return text
            .replace(/^(\d+(\.\d+)*\.?\s*)/, '')
            .replace(/^([IVX]+\.?\s*)/, '')
            .trim();
    }

    function median(arr) {
        if (arr.length === 0) return 0;
        const mid = Math.floor(arr.length / 2);
        return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    }

    // ======================== HTML GENERATION ========================

    function buildHtml(structure, fontThreshold) {
        const { title, authors, abstract, body, references } = structure;
        let html = '';

        if (title) {
            html += `<div class="paper-title">${esc(title)}</div>\n`;
        }

        if (authors.length > 0) {
            html += '<div class="paper-authors">\n';
            // Try to detect author-affiliation pairs
            // Simple heuristic: even-indexed are names, odd-indexed are affiliations
            // But for this PDF, authors are just names on separate lines
            authors.forEach(a => {
                html += `  <div class="author">${esc(a)}</div>\n`;
            });
            html += '</div>\n';
        }

        if (abstract) {
            html += '<div class="paper-abstract">\n';
            html += '  <h2>Abstract</h2>\n';
            html += `  <p>${esc(abstract)}</p>\n`;
            html += '</div>\n';
        }

        let sectionNum = 0;
        body.forEach(section => {
            if (section.title) {
                sectionNum++;
                html += `<h3 class="section-title">${sectionNum}. ${esc(section.title)}</h3>\n`;
            }

            let prevType = null;
            section.content.forEach(item => {
                if (item.type === 'code') {
                    if (prevType !== 'code') {
                        html += '<pre class="code-block"><code>';
                    }
                    html += esc(item.text) + '\n';
                    prevType = 'code';
                } else {
                    if (prevType === 'code') {
                        html += '</code></pre>\n';
                    }
                    prevType = 'text';
                    if (item.text.length > 3) {
                        const indentClass = section.content.indexOf(item) === 0 ? ' no-indent' : '';
                        html += `<p class="body-text${indentClass}">${esc(item.text)}</p>\n`;
                    }
                }
            });
            if (prevType === 'code') {
                html += '</code></pre>\n';
            }
        });

        if (references) {
            html += '<h3 class="section-title">References</h3>\n';
            const refs = references.split('\n').filter(r => r.trim());
            refs.forEach(ref => {
                const trimmed = ref.trim();
                if (trimmed) {
                    html += `<p class="reference">${esc(trimmed)}</p>\n`;
                }
            });
        }

        return html;
    }

    function esc(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function wrapStandaloneHtml(bodyHtml) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Converted Paper</title>
<style>
body {
    font-family: 'Times New Roman', Georgia, serif;
    max-width: 800px;
    margin: 2rem auto;
    padding: 0 2rem;
    line-height: 1.6;
    color: #1a1a1a;
}
.paper-title { font-size: 1.6em; font-weight: bold; text-align: center; margin-bottom: 0.5em; }
.paper-authors { text-align: center; margin-bottom: 1.5em; }
.paper-authors .author { margin: 0.25em 0; font-size: 1em; }
.paper-abstract { margin: 1.5em 2em; }
.paper-abstract h2 { font-size: 1em; text-transform: uppercase; margin-bottom: 0.5em; }
.section-title { font-size: 1.1em; font-weight: bold; margin-top: 1.5em; margin-bottom: 0.5em; }
.body-text { text-align: justify; margin-bottom: 0.75em; text-indent: 1.5em; }
.body-text.no-indent { text-indent: 0; }
.reference { font-size: 0.85em; margin-bottom: 0.25em; padding-left: 1.5em; text-indent: -1.5em; }
.code-block {
    font-family: 'Courier New', monospace;
    font-size: 0.85em;
    background: #f5f5f5;
    padding: 1em;
    border-radius: 4px;
    overflow-x: auto;
    margin: 1em 0;
    line-height: 1.4;
    white-space: pre-wrap;
    text-indent: 0;
}
</style>
</head>
<body>
<div class="paper-container">
${bodyHtml}
</div>
</body>
</html>`;
    }

    // ======================== UTILITIES ========================

    function parsePageRange(input, maxPages) {
        if (!input || !input.trim()) {
            return Array.from({ length: maxPages }, (_, i) => i + 1);
        }
        const pages = new Set();
        input.split(',').forEach(part => {
            part = part.trim();
            if (part.includes('-')) {
                const [start, end] = part.split('-').map(Number);
                for (let i = Math.max(1, start); i <= Math.min(maxPages, end); i++) pages.add(i);
            } else {
                const p = parseInt(part);
                if (p >= 1 && p <= maxPages) pages.add(p);
            }
        });
        return [...pages].sort((a, b) => a - b);
    }

    function showProgress(text) {
        progressBar.classList.remove('hidden');
        progressFill.style.width = '0%';
        progressText.textContent = text;
    }

    function updateProgress(pct, text) {
        progressFill.style.width = pct + '%';
        progressText.textContent = text;
    }

    function hideProgress() {
        progressBar.classList.add('hidden');
    }

    function downloadFile(name, content, type) {
        const blob = new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
    }

    function showToast(msg) {
        const toast = document.createElement('div');
        toast.textContent = msg;
        Object.assign(toast.style, {
            position: 'fixed',
            bottom: '2rem',
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#6c5ce7',
            color: 'white',
            padding: '0.6rem 1.25rem',
            borderRadius: '6px',
            fontSize: '0.85rem',
            zIndex: '9999',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        });
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2500);
    }

    function resetAll() {
        currentPdf = null;
        generatedHtml = '';
        controls.classList.add('hidden');
        results.classList.add('hidden');
        stats.classList.add('hidden');
        hideProgress();
        fileInput.value = '';
    }

})();
