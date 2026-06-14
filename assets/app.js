(function () {
    'use strict';

    const $ = (s) => document.querySelector(s);
    const $$ = (s) => document.querySelectorAll(s);

    // DOM refs
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
    let extractedData = null;
    let generatedHtml = '';

    // ======================== EVENT HANDLERS ========================

    // Drag & Drop
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

    // Tabs
    $$('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            $$('.tab').forEach(t => t.classList.remove('active'));
            $$('.tab-pane').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            $(`#tab${capitalize(tab.dataset.tab)}`).classList.add('active');
        });
    });

    // Export buttons
    $('#btnCopyHtml').addEventListener('click', () => {
        navigator.clipboard.writeText(generatedHtml).then(() => {
            showToast('已复制到剪贴板');
        });
    });
    $('#btnDownloadHtml').addEventListener('click', () => {
        downloadFile('converted.html', generatedHtml, 'text/html');
    });
    $('#btnDownloadWithAssets').addEventListener('click', () => {
        const standalone = wrapStandaloneHtml(generatedHtml);
        downloadFile('converted_standalone.html', standalone, 'text/html');
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
        const allItems = [];

        for (let i = 0; i < pages.length; i++) {
            updateProgress((i / pages.length) * 50, `提取第 ${pages[i]} 页...`);
            const items = await extractPageItems(pages[i]);
            allItems.push(...items);
        }

        updateProgress(55, '分析布局...');
        const layout = analyzeLayout(allItems, layoutMode);

        updateProgress(70, '检测文档结构...');
        const structure = detectStructure(layout);

        updateProgress(85, '生成 HTML...');
        generatedHtml = buildHtml(structure, fontThreshold);

        // Update UI
        updateProgress(100, '完成');

        const elapsed = Math.round(performance.now() - startTime);

        $('#htmlPreview').innerHTML = `<div class="paper-container">${generatedHtml}</div>`;
        hljs.highlightElement($('#htmlSource'));

        // Stats
        stats.classList.remove('hidden');
        $('#statPages').textContent = pages.length;
        $('#statBlocks').textContent = layout.blocks.length;
        $('#statColumns').textContent = layout.columnCount;
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

        return textContent.items.map(item => {
            const tx = item.transform;
            // pdf.js transform: [a, b, c, d, e, f]
            // e = x position, f = y position (from bottom)
            return {
                text: item.str,
                x: tx[4],
                y: viewport.height - tx[5], // convert to top-down
                width: item.width,
                height: item.height,
                fontSize: Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]) || Math.abs(tx[3]),
                fontWeight: item.fontName?.includes('Bold') ? 'bold' : 'normal',
                fontFamily: item.fontName || '',
                pageWidth: viewport.width,
                pageHeight: viewport.height,
                page: pageNum
            };
        }).filter(item => item.text.trim().length > 0);
    }

    // ======================== LAYOUT ANALYSIS ========================

    function analyzeLayout(allItems, mode) {
        if (allItems.length === 0) {
            return { blocks: [], columnCount: 1, pageWidth: 595, pageHeight: 842 };
        }

        const pageWidth = allItems[0].pageWidth;
        const pageHeight = allItems[0].pageHeight;

        // Group items into lines per page
        const linesByPage = {};
        allItems.forEach(item => {
            if (!linesByPage[item.page]) linesByPage[item.page] = [];
            linesByPage[item.page].push(item);
        });

        const allLines = [];
        for (const page of Object.keys(linesByPage).sort((a, b) => a - b)) {
            const pageItems = linesByPage[page];
            const lines = groupIntoLines(pageItems, pageHeight);
            lines.forEach(l => allLines.push(l));
        }

        // Detect columns
        let colCount;
        if (mode === 'auto') {
            colCount = detectColumnCount(allLines, pageWidth);
        } else {
            colCount = mode === 'double' ? 2 : 1;
        }

        // Group lines into blocks
        const blocks = groupIntoBlocks(allLines, pageWidth, colCount);

        return { blocks, columnCount: colCount, pageWidth, pageHeight, lines: allLines };
    }

    function groupIntoLines(items, pageHeight) {
        // Sort by page, then y, then x
        items.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);

        const lines = [];
        let currentLine = [];
        let lastY = null;
        let lastPage = null;
        const yTolerance = 3; // pixels

        for (const item of items) {
            const sameY = lastY !== null && Math.abs(item.y - lastY) < yTolerance && item.page === lastPage;

            if (sameY) {
                currentLine.push(item);
            } else {
                if (currentLine.length > 0) {
                    lines.push(buildLine(currentLine));
                }
                currentLine = [item];
            }
            lastY = item.y;
            lastPage = item.page;
        }
        if (currentLine.length > 0) lines.push(buildLine(currentLine));
        return lines;
    }

    function buildLine(items) {
        items.sort((a, b) => a.x - b.x);
        const text = items.map(i => i.text).join('');
        const x = items[0].x;
        const y = items[0].y;
        const right = Math.max(...items.map(i => i.x + i.width));
        const bottom = Math.max(...items.map(i => i.y + i.height));
        const avgFontSize = items.reduce((s, i) => s + i.fontSize, 0) / items.length;
        const hasBold = items.some(i => i.fontWeight === 'bold');
        const pageWidth = items[0].pageWidth;
        const page = items[0].page;

        return {
            text,
            x,
            y,
            width: right - x,
            height: bottom - y,
            fontSize: avgFontSize,
            fontWeight: hasBold ? 'bold' : 'normal',
            centerX: (x + right) / 2,
            pageWidth,
            page,
            items
        };
    }

    function detectColumnCount(lines, pageWidth) {
        const midX = pageWidth / 2;
        let leftCount = 0, rightCount = 0, bothCount = 0;

        for (const line of lines) {
            if (line.x < midX - 20 && line.x + line.width > midX + 20) {
                bothCount++;
            } else if (line.x < midX) {
                leftCount++;
            } else {
                rightCount++;
            }
        }

        const total = leftCount + rightCount;
        if (total === 0) return 1;

        // If lines cross the middle significantly, likely single column
        if (bothCount > total * 0.3) return 1;

        // If both sides have substantial content, double column
        const ratio = Math.min(leftCount, rightCount) / Math.max(leftCount, rightCount);
        return ratio > 0.3 ? 2 : 1;
    }

    function groupIntoBlocks(lines, pageWidth, colCount) {
        const blocks = [];
        let currentBlock = [];
        let lastPage = null;
        let lastY = null;
        const lineGapThreshold = 25;

        for (const line of lines) {
            const isNewPage = lastPage !== null && line.page !== lastPage;
            const gap = isNewPage ? Infinity : (lastY !== null ? line.y - lastY : 0);

            if (isNewPage || gap > lineGapThreshold) {
                if (currentBlock.length > 0) {
                    blocks.push(buildBlock(currentBlock, pageWidth, colCount));
                }
                currentBlock = [line];
            } else {
                currentBlock.push(line);
            }
            lastPage = line.page;
            lastY = line.y;
        }
        if (currentBlock.length > 0) blocks.push(buildBlock(currentBlock, pageWidth, colCount));

        return blocks;
    }

    function buildBlock(lines, pageWidth, colCount) {
        const text = lines.map(l => l.text).join(' ');
        const avgFontSize = lines.reduce((s, l) => s + l.fontSize, 0) / lines.length;
        const hasBold = lines.some(l => l.fontWeight === 'bold');
        const x = Math.min(...lines.map(l => l.x));
        const y = lines.map(l => l.y).sort((a, b) => a - b)[0];
        const width = Math.max(...lines.map(l => l.x + l.width)) - x;

        // Classify block
        const midX = pageWidth / 2;
        let column = 'full';
        if (colCount === 2) {
            if (x < midX - 10) column = 'left';
            else if (x > midX + 10) column = 'right';
        }

        return {
            text,
            lines,
            fontSize: avgFontSize,
            fontWeight: hasBold ? 'bold' : 'normal',
            x,
            y,
            width,
            column,
            page: lines[0].page
        };
    }

    // ======================== STRUCTURE DETECTION ========================

    function detectStructure(layout) {
        const { blocks, columnCount } = layout;
        if (blocks.length === 0) {
            return { title: '', authors: [], abstract: '', sections: [], references: [], columnCount };
        }

        // Sort blocks by page then y
        blocks.sort((a, b) => a.page - b.page || a.y - b.y);

        // Find font size statistics
        const fontSizes = blocks.map(b => b.fontSize).sort((a, b) => a - b);
        const medianFontSize = fontSizes[Math.floor(fontSizes.length / 2)];
        const bodyFontSize = medianFontSize;

        let title = '';
        let authors = [];
        let abstractText = '';
        const sections = [];
        let referencesText = '';
        let foundAbstract = false;
        let foundReferences = false;

        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            const text = block.text.trim();
            if (!text) continue;

            // Title: first bold block, or first block with significantly larger font
            if (!title && block.fontSize > bodyFontSize * 1.15 && block.column === 'full') {
                title = text;
                continue;
            }

            // Authors: full-width block(s) after title, smaller font, centered
            if (title && authors.length === 0 && !foundAbstract) {
                if (block.column === 'full' && block.fontSize <= bodyFontSize * 1.05) {
                    if (block.x + block.width > block.pageWidth * 0.3) {
                        authors.push(text);
                        continue;
                    }
                }
            }

            // Abstract detection
            const abstractMatch = /^(?:abstract|摘要|ABSTRACT)[:\s.]*/i;
            if (abstractMatch.test(text)) {
                foundAbstract = true;
                abstractText = text.replace(abstractMatch, '').trim();
                // Check if abstract continues in next block
                if (i + 1 < blocks.length && blocks[i + 1].fontSize <= bodyFontSize * 1.05) {
                    abstractText += ' ' + blocks[i + 1].text.trim();
                }
                continue;
            }

            if (foundAbstract && !abstractText && block.column === 'full') {
                abstractText = text;
                foundAbstract = false;
                continue;
            }

            if (foundAbstract && !referencesText && block.column === 'full' && block.fontSize <= bodyFontSize * 1.05) {
                if (!abstractText) abstractText = text;
                else abstractText += ' ' + text;
                if (i + 1 < blocks.length && blocks[i + 1].column !== 'full') {
                    foundAbstract = false;
                }
                continue;
            }

            // References detection
            const refMatch = /^(?:references|参考文献|REFERENCES|Bibliography)[:\s.]*/i;
            if (refMatch.test(text)) {
                foundReferences = true;
                referencesText = text.replace(refMatch, '').trim();
                continue;
            }

            if (foundReferences) {
                referencesText += '\n' + text;
                continue;
            }

            // Section headings: bold, numbered (1. Introduction, 2. Method, etc.)
            const sectionMatch = /^(\d+\.?\s+[A-Z][A-Za-z\s]+)/;
            const subsectionMatch = /^(\d+\.\d+\.?\s+[A-Za-z]+)/;
            if (block.fontWeight === 'bold' && sectionMatch.test(text)) {
                sections.push({
                    type: 'section',
                    title: text.replace(/^\d+\.?\s*/, ''),
                    content: []
                });
                continue;
            }

            if (block.fontWeight === 'bold' && subsectionMatch.test(text)) {
                sections.push({
                    type: 'subsection',
                    title: text.replace(/^\d+\.\d+\.?\s*/, ''),
                    content: []
                });
                continue;
            }

            // Roman numeral sections (I. INTRODUCTION, II. RELATED WORK, etc.)
            const romanMatch = /^([IVX]+\.?\s+[A-Z][A-Za-z\s]+)/;
            if (block.fontWeight === 'bold' && romanMatch.test(text)) {
                sections.push({
                    type: 'section',
                    title: text.replace(/^[IVX]+\.?\s*/, ''),
                    content: []
                });
                continue;
            }

            // Content blocks → attach to current section
            if (sections.length > 0) {
                sections[sections.length - 1].content.push(text);
            }
        }

        // If no sections found, treat remaining blocks as body
        if (sections.length === 0) {
            const bodyBlocks = blocks.filter(b =>
                b.text.trim() &&
                b.text.trim() !== title &&
                !authors.includes(b.text.trim()) &&
                !abstractText.includes(b.text.trim())
            );
            sections.push({ type: 'body', title: '', content: bodyBlocks.map(b => b.text.trim()) });
        }

        return { title, authors, abstract: abstractText, sections, references: referencesText, columnCount };
    }

    // ======================== HTML GENERATION ========================

    function buildHtml(structure, fontThreshold) {
        const { title, authors, abstract, sections, references, columnCount } = structure;
        let html = '';

        if (title) {
            html += `<div class="paper-title">${escapeHtml(title)}</div>\n`;
        }

        if (authors.length > 0) {
            html += '<div class="paper-authors">\n';
            authors.forEach(a => {
                html += `  <div class="author">${escapeHtml(a)}</div>\n`;
            });
            html += '</div>\n';
        }

        if (abstract) {
            html += '<div class="paper-abstract">\n';
            html += '  <h2>Abstract</h2>\n';
            html += `  <p>${escapeHtml(abstract)}</p>\n`;
            html += '</div>\n';
        }

        sections.forEach((section, idx) => {
            const num = idx + 1;
            if (section.type === 'section') {
                html += `<h3 class="section-title">${num}. ${escapeHtml(section.title)}</h3>\n`;
            } else if (section.type === 'subsection') {
                html += `<h4 class="subsection-title">${escapeHtml(section.title)}</h4>\n`;
            }

            section.content.forEach((para, pi) => {
                if (para.length > 5) {
                    const isFirst = pi === 0 && section.type !== 'body';
                    html += `<p class="body-text${isFirst ? ' no-indent' : ''}">${escapeHtml(para)}</p>\n`;
                }
            });
        });

        if (references) {
            html += `<h3 class="section-title">References</h3>\n`;
            const refs = references.split('\n').filter(r => r.trim());
            refs.forEach(ref => {
                html += `<p class="reference">${escapeHtml(ref.trim())}</p>\n`;
            });
        }

        return html;
    }

    function escapeHtml(text) {
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
.paper-authors .author { margin: 0.25em 0; }
.paper-authors .affiliation { font-size: 0.85em; color: #555; }
.paper-abstract { margin: 1.5em 2em; }
.paper-abstract h2 { font-size: 1em; text-transform: uppercase; margin-bottom: 0.5em; }
.section-title { font-size: 1.1em; font-weight: bold; margin-top: 1.5em; margin-bottom: 0.5em; }
.subsection-title { font-size: 1em; font-weight: bold; margin-top: 1em; margin-bottom: 0.5em; }
.body-text { text-align: justify; margin-bottom: 0.75em; text-indent: 1.5em; }
.body-text.no-indent { text-indent: 0; }
.reference { font-size: 0.85em; margin-bottom: 0.25em; padding-left: 1.5em; text-indent: -1.5em; }
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
                for (let i = Math.max(1, start); i <= Math.min(maxPages, end); i++) {
                    pages.add(i);
                }
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
        extractedData = null;
        controls.classList.add('hidden');
        results.classList.add('hidden');
        stats.classList.add('hidden');
        hideProgress();
        fileInput.value = '';
    }

})();
