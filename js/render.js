// ══════════════════════════════════════════════════════════════════
// Flowinject v4.0 — render.js — Mermaid rendering, zoom/pan, file handling, saved list
// Part of the modular refactor from monolithic index.html (v3.12.2)
// All functions remain global-scope for backward compatibility.
// ══════════════════════════════════════════════════════════════════

// ── File handling ─────────────────────────────────────────────────
function handleFileSelect(e) {
  var f = e.target.files && e.target.files[0];
  if (f) handleFile(f, false);
  e.target.value = '';
}

function handleAppendSelect(e) {
  var f = e.target.files && e.target.files[0];
  if (f) handleFile(f, true);
  e.target.value = '';
}

// ── v3.12.1: Dedicated TOC load ───────────────────────────────────
// ↑ TOC button handler — loads file as a TOC unconditionally.
// Sets pipe._isTocLoad=true so handleFile() routes it as a TOC regardless
// of whether detectTOC() auto-detects it (handles edge cases where the
// TOC has fewer numbered entries than the auto-detect threshold).
function handleTocSelect(e) {
  var f = e.target.files && e.target.files[0];
  if (f) {
    pipe._isTocLoad = true; // signal to handleFile() to treat as TOC
    handleFile(f, false);
  }
  e.target.value = '';
}

// Show TOC detection banner in the Raw tab
function _showTocBanner(toc) {
  var banner = document.getElementById('toc-banner');
  var countEl = document.getElementById('toc-banner-count');
  var clusterEl = document.getElementById('toc-banner-clusters');
  if (!banner) return;

  // Chapter count
  var chapterCount = toc.entries.filter(function(e){ return e.level === 1 && e.label && /^\d/.test(e.label); }).length;
  if (countEl) countEl.textContent = chapterCount + ' chapters detected';

  // Cluster pills from registry
  if (clusterEl) {
    var clusterMap = ChapterRegistry.getClusterMap();
    var chips = Object.keys(clusterMap).map(function(k) {
      var cl = clusterMap[k];
      return '<span style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;background:var(--blue-100);color:var(--blue-700);border:1px solid var(--blue-200);">' +
        cl.code + ' ' + _esc(cl.label) + '</span>';
    }).join('');
    clusterEl.innerHTML = chips ||
      '<span style="font-size:10px;color:var(--blue-500);">Cluster structure will be auto-derived from numeric groupings</span>';
  }

  banner.style.display = 'block';
  // Auto-switch to Raw tab so user sees the banner
  switchLeftTab('raw');
}

function _dismissTocBanner() {
  var banner = document.getElementById('toc-banner');
  if (banner) banner.style.display = 'none';
}

// ── Chart name field auto-fill logic ─────────────────────────────
// _chartNameSource tracks how the current value was set:
//   'user'   — user typed it manually → never override
//   'system' — set by filename/processName → can be overridden by better data
//   ''       — field is empty
var _chartNameSource = '';

function _setChartName(value, source) {
  var inp = document.getElementById('chart-name-input');
  if (!inp || !value) return;
  inp.value = value;
  _chartNameSource = source;
}

function _getChartName() {
  var inp = document.getElementById('chart-name-input');
  return inp ? inp.value.trim() : '';
}

// Can we override the current chart name value?
// Yes if: empty, or set by system (not the user)
function _canOverrideChartName() {
  return _chartNameSource !== 'user' || !_getChartName();
}

// Derive a human-readable title from a filename and suggest it.
// On Load: always set (overrides previous system suggestion from prior session).
// On Append: only set if field is empty (TOC name shouldn't block chapter name).
function _suggestTitleFromFilename(filename, appendMode) {
  if (appendMode && _chartNameSource === 'user') return; // never override user
  // Strip extension
  var base = filename.replace(/\.[^.]+$/, '');
  // Replace separators with spaces, title-case
  var title = base
    .replace(/[_\-\.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, function(c){ return c.toUpperCase(); });
  // Remove leading chapter/section numbers: "4 2 " / "Ch04 " / "4.2 "
  title = title.replace(/^(Chapter|Ch|Section|Sec|Part)?\s*[\d\s\.]+\s*/i, '').trim() || title;
  if (title) _setChartName(title, 'system');
}

// Convert Mammoth HTML output to structured plain text that preserves
// document hierarchy: headings → # prefix, lists → bullet lines,
// tables → tab-separated rows with a blank line separator,
// bold phrases → **text** (retained as label hints for pre-parse)
function convertDocxHtmlToText(html) {
  if (!html) return '';
  var div = document.createElement('div');
  div.innerHTML = html;
  var lines = [];

  function walk(node) {
    if (node.nodeType === 3) return; // text nodes handled by parent
    var tag = (node.tagName || '').toLowerCase();

    if (tag === 'h1') {
      // H1 → heading (section boundary)
      lines.push('# ' + node.textContent.trim());
      lines.push('');
    } else if (tag === 'h2') {
      // H2 → sub-process (major sub-section within a process)
      // Prefix ensures classifyLine() routes this to 'subprocess' via SUBPROCESS_MARKERS
      lines.push('## ' + node.textContent.trim());
      lines.push('');
    } else if (tag === 'h3') {
      // H3 → cluster (grouping of related steps within a sub-process)
      lines.push('### ' + node.textContent.trim());
      lines.push('');
    } else if (tag === 'h4' || tag === 'h5' || tag === 'h6') {
      // H4+ → treat as step heading (deeper nesting, likely individual steps)
      lines.push(node.textContent.trim());
      lines.push('');
    } else if (tag === 'p') {
      var txt = node.textContent.trim();
      if (txt) lines.push(txt);
      lines.push('');
    } else if (tag === 'ul' || tag === 'ol') {
      var items = node.querySelectorAll('li');
      items.forEach(function(li, idx) {
        var prefix = tag === 'ol' ? (idx + 1) + '. ' : '- ';
        lines.push(prefix + li.textContent.trim());
      });
      lines.push('');
    } else if (tag === 'table') {
      // Each row becomes a line; cells tab-separated
      // Header row gets a ## prefix to hint at section context
      var rows = node.querySelectorAll('tr');
      rows.forEach(function(row, rowIdx) {
        var cells = Array.from(row.querySelectorAll('td,th'))
                        .map(function(c) { return c.textContent.trim(); })
                        .filter(Boolean);
        if (!cells.length) return;
        if (rowIdx === 0) {
          lines.push('### ' + cells.join(' | '));
        } else {
          lines.push(cells.join(' — '));
        }
      });
      lines.push('');
    } else {
      // Recurse into other elements
      Array.from(node.childNodes).forEach(walk);
    }
  }

  Array.from(div.childNodes).forEach(walk);

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function handleFile(file, append) {
  var ext = file.name.split('.').pop().toLowerCase();
  if (['txt','md','pdf','docx'].indexOf(ext) === -1) {
    showError('Unsupported format: .' + ext + ' — use TXT, MD, PDF or DOCX.');
    return;
  }
  showError('');

  // Show filename immediately so user sees something happened
  document.getElementById('fname').textContent = file.name;
  document.getElementById('filename-tag').style.display = 'inline-block';

  if (!append) {
    resetPipelineStages();
    setPipeDot('raw', 'running');
    _chartNameSource = '';
    var inp = document.getElementById('chart-name-input');
    if (inp) inp.value = '';
    _suggestTitleFromFilename(file.name, false);
    ChapterRegistry.inferFromFilename(file.name);
    pipe._tocText = null; pipe._chapterText = null; pipe._inputSources = [];
    if (!pipe._isTocLoad) {
      var tocBannerReset = document.getElementById('toc-banner');
      if (tocBannerReset) tocBannerReset.style.display = 'none';
    }
  } else {
    showToast('Appending "' + file.name + '"…');
    if (_chartNameSource !== 'user') _chartNameSource = '';
    _suggestTitleFromFilename(file.name, true);
  }

  var text = '';
  try {

    if (ext === 'txt' || ext === 'md') {
      text = await file.text();

    } else if (ext === 'pdf') {
      // Ensure pdf.js worker is configured
      if (typeof pdfjsLib !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
        if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
          pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }
      }
      var pdfBytes = await file.arrayBuffer();
      var pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
      var pageTexts = [];
      for (var pi = 1; pi <= pdf.numPages; pi++) {
        var pg = await pdf.getPage(pi);
        var ct = await pg.getTextContent();
        var lastY = null, lines = [], line = [];
        ct.items.forEach(function(item) {
          if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) {
            lines.push(line.join(' ')); line = [];
          }
          if (item.str && item.str.trim()) line.push(item.str);
          lastY = item.transform[5];
        });
        if (line.length) lines.push(line.join(' '));
        pageTexts.push(lines.filter(function(l) { return l.trim(); }).join('\n'));
      }
      text = pageTexts.join('\n\n').trim();
      if (!text) throw new Error('No extractable text — PDF may be image-based (scanned). Try a TXT export instead.');

    } else if (ext === 'docx') {
      var docxBytes = await file.arrayBuffer();
      var htmlResult = await mammoth.convertToHtml({ arrayBuffer: docxBytes });
      text = convertDocxHtmlToText(htmlResult.value).trim();
      if (!text) {
        var rawResult = await mammoth.extractRawText({ arrayBuffer: docxBytes });
        text = rawResult.value.trim();
      }
      if (!text) throw new Error('Could not extract text from DOCX.');
    }

  } catch(readErr) {
    setPipeDot('raw', '');
    showError('Could not read file: ' + readErr.message);
    console.error('[handleFile] read error:', readErr);
    return;
  }

  if (!text || !text.trim()) {
    setPipeDot('raw', '');
    showError('File appears empty: ' + file.name + ' (0 chars extracted)');
    return;
  }

  console.log('[handleFile] loaded', text.length, 'chars from', file.name, '(' + ext + ')');

  // Write into textarea and pipe.raw
  var _inputEl = document.getElementById('input-text');
  if (append && _inputEl && _inputEl.value.trim()) {
    pipe._chapterText = text;
    ChapterRegistry.inferFromFilename(file.name);
    if (!Array.isArray(pipe._inputSources)) pipe._inputSources = [];
    pipe._inputSources.push({ filename: file.name, role: 'chapter', chars: text.length });
    var sep = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n— ' + file.name + ' —\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    var combined = _inputEl.value + sep + text;
    _inputEl.value = combined;
    pipe.raw = combined;
    document.getElementById('fname').textContent = document.getElementById('fname').textContent + ' + ' + file.name;
  } else {
    if (!append) {
      pipe._tocText = text;
      pipe._chapterText = null;
      pipe._inputSources = [{ filename: file.name, role: 'load', chars: text.length }];
    }
    if (_inputEl) _inputEl.value = text;
    pipe.raw = text;
  }

  document.getElementById('raw-meta').textContent = text.length.toLocaleString() + ' chars';
  setPipeDot('raw', 'done');
  switchLeftTab('raw');

  // Hash (non-fatal, done after text is loaded)
  try {
    var hashBytes = new TextEncoder().encode(text);
    var _fileHash = await computeFileHash(hashBytes.buffer);
    if (!append && _fileHash) {
      var _chEntry = ChapterRegistry.getCurrent();
      var _docId = _chEntry ? chapterSlug(_chEntry.chapterNum) : slugify(file.name.replace(/\.[^.]+$/, ''));
      DocumentRegistry.update(_docId, { sourceFilename: file.name, fileHash: _fileHash, fileSizeBytes: file.size, status: 'pending' });
    }
  } catch(e) { /* non-fatal */ }

  // Auto-run pipeline
  await sleep(50);
  try { await runPipeline(); } catch(e) { console.error('[handleFile] pipeline err:', e); }
}

// ── Mermaid file load ─────────────────────────────────────────────
function loadMermaidFile(e) {
  var file = e.target.files && e.target.files[0];
  if (!file) return;
  var r = new FileReader();
  r.onload = function() { document.getElementById('mermaid-editor').value = r.result; scheduleRender(); };
  r.readAsText(file); e.target.value = '';
}

// ── Render ────────────────────────────────────────────────────────
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(function() {
    var code = document.getElementById('mermaid-editor').value.trim();
    if (!code) return;
    // Only auto-render if code has a valid diagram header — prevents error flash
    // when user switches diagram types and existing code doesn't match
    var first = code.split('\n')[0].toLowerCase();
    var validHeaders = ['flowchart ','flowchart\n','graph lr','graph td','graph tb','graph rl','sequencediagram','gantt','pie','erdiagram'];
    var hasValidHeader = validHeaders.some(function(h) { return first.startsWith(h); });
    // Also accept bare 'graph' keyword (any direction)
    if (!hasValidHeader && first.startsWith('graph')) hasValidHeader = true;
    if (!hasValidHeader) return; // silently skip — code isn't valid yet
    renderFromEditor();
  }, 900); // slightly longer debounce to avoid flicker during typing
}

function renderFromEditor() {
  var code = document.getElementById('mermaid-editor').value.trim();
  if (code) renderMermaid(injectColours(code)); else showChartPlaceholder();
}

/**
 * Render a Mermaid code string into the chart panel SVG.
 * Handles zoom/pan re-init, node edit handlers, and error display.
 * @param {string} code - Valid Mermaid diagram code
 * @returns {Promise<void>}
 */
async function renderMermaid(code) {
  var inner    = document.getElementById('chart-inner');
  var rErr     = document.getElementById('render-error');
  var controls = document.getElementById('graph-controls');
  rErr.style.display = 'none';
  try {
    inner.innerHTML = '';
    var result = await mermaid.render('fc' + Date.now(), code);
    var svgStr = result && result.svg ? result.svg : (typeof result === 'string' ? result : '');
    if (!svgStr) throw new Error('No SVG output from renderer');
    // Intercept Mermaid's own error SVG — it contains "syntax-error" text
    // When Mermaid can't parse code it returns an error SVG instead of throwing
    if (svgStr.includes('syntax-error') || svgStr.includes('Syntax error') || svgStr.includes('mermaid version')) {
      // Extract useful error text from the SVG
      var errMatch = svgStr.match(/<text[^>]*>([^<]*(?:error|Error|parse)[^<]*)<\/text>/i);
      var errMsg = errMatch ? errMatch[1] : 'Mermaid could not parse this diagram — check syntax';
      throw new Error(errMsg);
    }
    inner.innerHTML = svgStr;
    lastSVG = svgStr;
    controls.style.display = 'flex';
    document.getElementById('placeholder').style.display = 'none';
    document.getElementById('refine-bar').classList.add('visible');
    // Show diagram controls bar whenever a diagram rendered successfully (v3.9.0)
    _updateDiagramControlsBar();
    // Reset pan on every new render
    panX = 0; panY = 0;
    // Zoom-to-fit (v2.9.0) — scale diagram to fill the viewport on first render
    zoomToFit();
    // Attach double-click handlers for inline label editing
    setTimeout(attachNodeEditHandlers, 100);
    // Run validation checks
    var warnings = validateMermaidCode(code);
    renderValidationBar(warnings);
    if (currentRightTab !== 'graph' && currentRightTab !== 'saved') switchRightTab('graph');
  } catch (err) {
    // Show a clean, truncated error — not the raw Mermaid parse error wall
    var msg = err.message || 'Unknown render error';
    // Strip the very long "Expecting 'AMP', 'COLON'..." token lists
    msg = msg.replace(/Expecting\s+'[^']+(?:',\s*'[^']+')+/g, 'unexpected token');
    if (msg.length > 200) msg = msg.substring(0, 197) + '…';
    rErr.textContent = '⚠ ' + msg;
    rErr.style.display = 'block';
    controls.style.display = 'none';
    document.getElementById('placeholder').style.display = 'none';
  }
}

function showChartPlaceholder() {
  document.getElementById('graph-controls').style.display = 'none';
  document.getElementById('placeholder').style.display    = 'flex';
  document.getElementById('render-error').style.display   = 'none';
  var vbar = document.getElementById('validation-bar');
  if (vbar) { vbar.classList.remove('visible'); vbar.innerHTML = ''; }
  lastSVG = '';
}

function showError(msg) {
  var b = document.getElementById('error-box');
  b.textContent = msg; b.style.display = msg ? 'block' : 'none';
}

/**
 * Show or hide the loading spinner and disable the generate button.
 * @param {boolean} on  - true to show loading, false to hide
 * @param {string}  [msg] - Optional status message displayed in the spinner
 */
function setLoading(on, msg) {
  document.getElementById('spinner').style.display = on ? 'flex' : 'none';
  document.getElementById('spinner-msg').textContent = msg || 'Converting…';
  var btn = document.getElementById('convert-btn');
  btn.disabled = on;
  if (on) {
    btn.textContent = '⟳ ' + (msg || 'Generating…');
    document.getElementById('placeholder').style.display    = 'none';
    document.getElementById('graph-controls').style.display = 'none';
  } else {
    // Restore button text based on pipeline state
    btn.textContent = pipe.preparsed && pipe.preparsed.length ? '→ Generate Chart' : '▶ Run & Generate';
  }
}

function clearEditor() { document.getElementById('mermaid-editor').value = ''; showChartPlaceholder(); }

// ── Zoom ──────────────────────────────────────────────────────────
function adjustZoom(d) { zoomLevel = Math.min(10, Math.max(0.05, zoomLevel + d)); applyZoom(); }
function resetZoom()   { zoomLevel = 1; panX = 0; panY = 0; applyZoom(); }
function applyZoom()   {
  var inner = document.getElementById('chart-inner');
  if (!inner) return;
  inner.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoomLevel + ')';
  inner.style.transition = isPanning ? 'none' : 'transform 0.15s';
  document.getElementById('zoom-level').textContent = Math.round(zoomLevel * 100) + '%';
}

// Open the current SVG in a new browser tab at full native resolution
function openDiagramFullscreen() {
  if (!lastSVG) { showToast('No diagram to open — generate one first'); return; }
  var title = (document.getElementById('chart-name-input') || {}).value || 'Flowchart';
  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<title>' + escHtml(title) + ' — Full View</title>' +
    '<style>body{margin:0;background:#fff;display:flex;justify-content:center;padding:20px;}' +
    'svg{max-width:none!important;height:auto;}</style>' +
    '</head><body>' + lastSVG + '</body></html>';
  var win = window.open('', '_blank');
  if (win) { win.document.write(html); win.document.close(); }
  else showToast('Pop-up blocked — allow pop-ups for this site');
}

// Zoom-to-fit: scale the diagram so it fills the viewport width (v2.9.0)
function zoomToFit() {
  try {
    var inner     = document.getElementById('chart-inner');
    var container = inner && inner.parentElement;
    if (!inner || !container) return;
    var svg = inner.querySelector('svg');
    if (!svg) return;
    // Wait one frame for the SVG to be laid out
    requestAnimationFrame(function() {
      var svgW  = svg.getBoundingClientRect().width  || svg.viewBox.baseVal.width  || 800;
      var svgH  = svg.getBoundingClientRect().height || svg.viewBox.baseVal.height || 600;
      var contW = container.clientWidth  || 600;
      var contH = container.clientHeight || 400;
      if (!svgW || !svgH) return;
      var scale = Math.min(contW / svgW, contH / svgH, 1); // never zoom > 100%
      scale = Math.max(0.15, Math.min(scale, 1));
      zoomLevel = scale;
      panX = 0; panY = 0;
      applyZoom();
    });
  } catch(e) { /* silent — zoom-to-fit is best-effort */ }
}

// ── Fit to view ───────────────────────────────────────────────────
function fitToView() {
  var viewport = document.getElementById('chart-viewport');
  var inner    = document.getElementById('chart-inner');
  var svg      = inner ? inner.querySelector('svg') : null;
  if (!svg || !viewport) { resetZoom(); return; }

  // Get natural SVG size at scale=1
  var svgW = svg.viewBox.baseVal.width  || svg.getBoundingClientRect().width  / zoomLevel;
  var svgH = svg.viewBox.baseVal.height || svg.getBoundingClientRect().height / zoomLevel;
  var vpW  = viewport.clientWidth  - 48;  // padding
  var vpH  = viewport.clientHeight - 48;

  // Scale to fit with a little padding
  var scaleX = vpW / svgW;
  var scaleY = vpH / svgH;
  zoomLevel = Math.min(scaleX, scaleY, 1); // never upscale beyond 100%

  // Centre the diagram
  panX = (vpW - svgW * zoomLevel) / 2 + 24;
  panY = (vpH - svgH * zoomLevel) / 2 + 24;

  applyZoom();
}
var panX = 0, panY = 0;
var isPanning = false, panStartX = 0, panStartY = 0, panStartPanX = 0, panStartPanY = 0;

(function initPan() {
  var viewport = document.getElementById('chart-viewport');
  if (!viewport) return;

  viewport.addEventListener('mousedown', function(e) {
    // Only pan on left-click, not on buttons/inputs
    if (e.button !== 0) return;
    if (e.target.closest('button, input, a')) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartPanX = panX;
    panStartPanY = panY;
    viewport.classList.add('panning');
    e.preventDefault();
  });

  window.addEventListener('mousemove', function(e) {
    if (!isPanning) return;
    panX = panStartPanX + (e.clientX - panStartX);
    panY = panStartPanY + (e.clientY - panStartY);
    applyZoom();
  });

  window.addEventListener('mouseup', function() {
    if (!isPanning) return;
    isPanning = false;
    document.getElementById('chart-viewport').classList.remove('panning');
  });

  // Pinch/scroll zoom on the viewport
  viewport.addEventListener('wheel', function(e) {
    e.preventDefault();
    var delta = e.deltaY > 0 ? -0.1 : 0.1;
    // Zoom toward mouse position
    var rect = viewport.getBoundingClientRect();
    var mouseX = e.clientX - rect.left;
    var mouseY = e.clientY - rect.top;
    var prevZoom = zoomLevel;
    zoomLevel = Math.min(10, Math.max(0.05, zoomLevel + delta));
    // Adjust pan so zoom is centered on mouse
    var scale = zoomLevel / prevZoom;
    panX = mouseX - scale * (mouseX - panX);
    panY = mouseY - scale * (mouseY - panY);
    applyZoom();
  }, { passive: false });

  // Touch support — pinch to zoom, drag to pan
  var touches = {};
  var touchStartDist = 0, touchStartZoom = 0;
  var touchStartCX = 0, touchStartCY = 0;

  viewport.addEventListener('touchstart', function(e) {
    Array.from(e.changedTouches).forEach(function(t) { touches[t.identifier] = { x: t.clientX, y: t.clientY }; });
    var ids = Object.keys(touches);
    if (ids.length === 2) {
      var t1 = touches[ids[0]], t2 = touches[ids[1]];
      touchStartDist = Math.hypot(t2.x - t1.x, t2.y - t1.y);
      touchStartZoom = zoomLevel;
      touchStartCX = (t1.x + t2.x) / 2;
      touchStartCY = (t1.y + t2.y) / 2;
    } else if (ids.length === 1) {
      panStartX = touches[ids[0]].x;
      panStartY = touches[ids[0]].y;
      panStartPanX = panX;
      panStartPanY = panY;
    }
    e.preventDefault();
  }, { passive: false });

  viewport.addEventListener('touchmove', function(e) {
    Array.from(e.changedTouches).forEach(function(t) { touches[t.identifier] = { x: t.clientX, y: t.clientY }; });
    var ids = Object.keys(touches);
    if (ids.length === 2) {
      var t1 = touches[ids[0]], t2 = touches[ids[1]];
      var dist = Math.hypot(t2.x - t1.x, t2.y - t1.y);
      zoomLevel = Math.min(10, Math.max(0.05, touchStartZoom * (dist / touchStartDist)));
    } else if (ids.length === 1) {
      panX = panStartPanX + (touches[ids[0]].x - panStartX);
      panY = panStartPanY + (touches[ids[0]].y - panStartY);
    }
    applyZoom();
    e.preventDefault();
  }, { passive: false });

  viewport.addEventListener('touchend', function(e) {
    Array.from(e.changedTouches).forEach(function(t) { delete touches[t.identifier]; });
  });
})();

// ── Exports ───────────────────────────────────────────────────────
function exportSVG() {
  if (!lastSVG) return;
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lastSVG], { type: 'image/svg+xml' }));
  a.download = 'flowchart.svg'; a.click();
}

async function exportPNG() {
  if (!lastSVG) return;
  var svgEl = new DOMParser().parseFromString(lastSVG, 'image/svg+xml').documentElement;
  var w = parseFloat(svgEl.getAttribute('width'))  || 0;
  var h = parseFloat(svgEl.getAttribute('height')) || 0;
  var vb = svgEl.getAttribute('viewBox');
  if (vb && (!w || !h)) { var p = vb.split(/[\s,]+/); w = parseFloat(p[2]) || 900; h = parseFloat(p[3]) || 600; }
  w = w || 900; h = h || 600;
  var S = 3;
  var canvas = document.createElement('canvas');
  canvas.width = w * S; canvas.height = h * S;
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.scale(S, S);
  var url = URL.createObjectURL(new Blob([lastSVG], { type: 'image/svg+xml;charset=utf-8' }));
  var img = new Image();
  await new Promise(function(res, rej) { img.onload = res; img.onerror = rej; img.src = url; });
  ctx.drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
  canvas.toBlob(function(blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'flowchart@3x.png'; a.click();
  }, 'image/png');
}

// ── Save / Load ───────────────────────────────────────────────────
function openSaveDialog() {
  if (!lastSVG) { showToast('Nothing to save yet — generate a chart first'); return; }
  var inp  = document.getElementById('chart-name-input');
  // Only auto-fill from code if the field is blank — respect smart title chain
  if (!inp.value.trim()) {
    var code  = document.getElementById('mermaid-editor').value;
    var match = code.match(/\[([^\]]{3,40})\]/);
    inp.value = match ? match[1].substring(0, 40) : 'Chart ' + new Date().toLocaleDateString('en-GB');
  }
  document.getElementById('save-dialog').classList.add('open');
  setTimeout(function() { inp.focus(); inp.select(); }, 60);
  // v3.11.2: populate subprocess parent-picker (shows/hides automatically)
  _populateSaveDialogSubprocessPicker();
}

function closeSaveDialog() { document.getElementById('save-dialog').classList.remove('open'); }

// v3.11.5: ··· overflow menu toggle
// Kept for backward compat — routes to new export menu toggle
function _toggleActionOverflow() { _toggleExportMenu(); }

function _toggleExportMenu() {
  var menu = document.getElementById('action-export-menu');
  if (!menu) return;
  var isOpen = menu.style.display !== 'none';
  menu.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    setTimeout(function() {
      document.addEventListener('click', function _closeExportMenu(e) {
        var wrap = document.getElementById('action-export-wrap');
        if (wrap && !wrap.contains(e.target)) {
          menu.style.display = 'none';
          document.removeEventListener('click', _closeExportMenu);
        }
      });
    }, 10);
  }
}

document.getElementById('save-dialog').addEventListener('click', function(e) {
  if (e.target === document.getElementById('save-dialog')) closeSaveDialog();
});

document.getElementById('chart-name-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') confirmSave();
  if (e.key === 'Escape') closeSaveDialog();
});
// Mark field as user-typed as soon as they start editing
document.getElementById('chart-name-input').addEventListener('input', function() {
  if (this.value.trim()) _chartNameSource = 'user';
  else _chartNameSource = '';
});

function confirmSave() {
  confirmSaveWithMeta();
}

function loadChart(nameOrSlug) {
  var chart = getSaved().find(function(c) { return (c.slug || c.name) === nameOrSlug || c.name === nameOrSlug; });
  if (!chart) return;
  document.getElementById('mermaid-editor').value = chart.code;
  renderMermaid(chart.code);
  showToast('Loaded: ' + (chart.name || chart.slug));
}

function deleteChart(nameOrSlug) {
  putSaved(getSaved().filter(function(c) { return (c.slug || c.name) !== nameOrSlug && c.name !== nameOrSlug; }));
  renderSavedList();
  showToast('Deleted: ' + nameOrSlug);
}

// ── Step 6: Saved list with grouping (spec §9) ───────────────────
function renderSavedList() {
  var list   = document.getElementById('saved-list');
  var allCharts = getSaved();

  if (!allCharts.length) {
    list.innerHTML = '<div class="saved-empty"><div class="d">\u25c8</div><p>No saved charts yet \u2014 generate one and click Save</p></div>';
    return;
  }

  // Separate drafts from named saves
  var drafts = allCharts.filter(function(c){ return c.isDraft; });
  var charts = allCharts.filter(function(c){ return !c.isDraft; });

  // Group-by control bar
  var groupBar =
    '<div style="display:flex;gap:4px;align-items:center;padding:6px 8px 4px;flex-shrink:0;flex-wrap:wrap;">' +
      '<span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--gray-400);margin-right:2px;">Group:</span>' +
      _sgBtn('cluster', 'Cluster') +
      _sgBtn('chapter', 'Chapter') +
      _sgBtn('type',    'Type') +
      _sgBtn('tag',     'Tag') +
      _sgBtn('none',    'Recent') +
    '</div>';

  // Build groups
  var groups = _groupSaved(charts, _savedGroupBy);

  var html = groupBar;

  // Drafts section — always shown at top, dismissible per item
  if (drafts.length) {
    html += '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--amber-700);padding:8px 10px 3px;display:flex;align-items:center;gap:6px;">' +
      '⚑ Unsaved drafts (' + drafts.length + ')' +
      '<span style="font-size:10px;font-weight:400;color:var(--gray-400);">— click ◈ Save to keep permanently</span>' +
    '</div>';
    drafts.forEach(function(c) {
      var slug    = c.slug || c.name;
      var title   = (c.name || '').replace(/^\[Draft\] /, '');
      var date    = new Date(c.savedAt).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
      var slugEsc = slug.replace(/'/g, "\\'");
      html += '<div class="chart-card" style="border-color:var(--amber-200);background:var(--amber-50);">' +
        '<div class="card-icon" style="color:var(--amber-700);">⚑</div>' +
        '<div class="card-info">' +
          '<div class="card-name" style="color:var(--amber-700);">' + escHtml(title) + '</div>' +
          '<div class="card-meta">Draft · ' + date + ' · not saved to GitHub</div>' +
        '</div>' +
        '<div class="card-actions">' +
          '<button class="btn-xs primary" onclick="loadAndSaveDraft(\'' + slugEsc + '\')" title="Load and open Save dialog">◈ Save</button>' +
          '<button class="btn-xs" onclick="loadChart(\'' + slugEsc + '\')" title="Load without saving">▶ Load</button>' +
          '<button class="btn-xs danger" onclick="deleteChart(\'' + slugEsc + '\')" title="Discard draft">✕</button>' +
        '</div>' +
      '</div>';
    });
  }
  groups.forEach(function(g) {
    if (g.label) {
      html += '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--gray-500);padding:8px 10px 3px;">' + escHtml(g.label) + '</div>';
    }
    g.items.forEach(function(c) {
      var slug    = c.slug || c.name;
      var title   = c.name || c.slug;
      var lines   = (c.code || '').split('\n').length;
      var date    = new Date(c.savedAt).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
      var meta    = c.meta;
      var badges  = '';
      if (meta) {
        badges += '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:var(--blue-50);color:var(--blue-700);font-weight:600;">' + escHtml(meta.type) + '</span>';
        if (meta.cluster) badges += ' <span style="font-size:9px;padding:1px 5px;border-radius:3px;background:var(--gray-100);color:var(--gray-600);">' + escHtml(meta.cluster) + '</span>';
        if (meta.chapter) badges += ' <span style="font-size:9px;color:var(--gray-400);">§' + escHtml(meta.chapter) + '</span>';
      }
      var slugEsc = slug.replace(/'/g, "\\'");
      var crossRefHtml = '';
      if (meta && meta.crossRefs && meta.crossRefs.length) {
        crossRefHtml = '<div style="margin-top:3px;font-size:10px;color:var(--gray-400);">→ ' +
          meta.crossRefs.map(function(ref) {
            return '<a href="#" style="color:var(--blue-500);text-decoration:none;" onclick="event.preventDefault();loadChart(\'' + ref.replace(/'/g,"\\'") + '\')" title="Open ' + escHtml(ref) + '">' + escHtml(ref) + '</a>';
          }).join(' · ') + '</div>';
      }
      html += '<div class="chart-card">' +
        '<div class="card-icon">\u25fb</div>' +
        '<div class="card-info">' +
          '<div class="card-name">' + escHtml(title) + '</div>' +
          '<div class="card-meta">' + badges + ' ' + lines + ' lines \u00b7 ' + date + '</div>' +
          crossRefHtml +
        '</div>' +
        '<div class="card-actions">' +
          '<button class="btn-xs primary" onclick="loadChart(\'' + slugEsc + '\')">&#9654; Load</button>' +
          '<button class="btn-xs" onclick="_exportProcessHtml(getSavedEntry(\'' + slugEsc + '\'))" title="Export standalone HTML">&#8599; HTML</button>' +
          '<button class="btn-xs danger"  onclick="deleteChart(\'' + slugEsc + '\')">&#10005;</button>' +
        '</div>' +
      '</div>';
    });
  });

  list.innerHTML = html;
}

function _sgBtn(val, label) {
  var active = _savedGroupBy === val;
  return '<button style="font-size:10px;padding:2px 8px;border-radius:4px;cursor:pointer;font-family:inherit;border:1px solid ' +
    (active ? 'var(--blue-500)' : 'var(--gray-200)') + ';background:' +
    (active ? 'var(--blue-600)' : 'var(--white)') + ';color:' +
    (active ? 'white' : 'var(--gray-600)') + ';" onclick="setSavedGroupBy(\'' + val + '\')">' + label + '</button>';
}

function setSavedGroupBy(mode) {
  _savedGroupBy = mode;
  renderSavedList();
}

// Load a draft into the editor and open the Save dialog for naming
function loadAndSaveDraft(slug) {
  var chart = getSaved().find(function(c){ return (c.slug || c.name) === slug; });
  if (!chart) return;
  document.getElementById('mermaid-editor').value = chart.code;
  renderMermaid(chart.code);
  // Pre-fill the save dialog with the draft title (strip [Draft] prefix)
  var inp = document.getElementById('chart-name-input');
  if (inp) inp.value = (chart.name || '').replace(/^\[Draft\] /, '');
  switchRightTab('graph');
  setTimeout(function(){ openSaveDialog(); }, 300);
}

function _groupSaved(charts, mode) {
  if (mode === 'none') {
    // Sort by generatedAt descending
    var sorted = charts.slice().sort(function(a,b){ return (b.savedAt||0) - (a.savedAt||0); });
    return [{ label: '', items: sorted }];
  }

  if (mode === 'cluster') {
    var buckets = {};
    charts.forEach(function(c) {
      var key = (c.meta && c.meta.cluster) ? c.meta.clusterLabel || c.meta.cluster : 'Uncategorised';
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(c);
    });
    // Sort within each cluster by chapter number
    return Object.keys(buckets).sort().map(function(k) {
      var items = buckets[k].slice().sort(function(a,b){
        var ca = a.meta ? parseFloat(a.meta.chapter||'0') : 0;
        var cb = b.meta ? parseFloat(b.meta.chapter||'0') : 0;
        return ca - cb;
      });
      return { label: k, items: items };
    });
  }

  if (mode === 'chapter') {
    var buckets2 = {};
    charts.forEach(function(c) {
      var key = (c.meta && c.meta.chapter) ? '§' + c.meta.chapter + ' ' + (c.meta.chapterTitle||'') : 'Unknown Chapter';
      if (!buckets2[key]) buckets2[key] = [];
      buckets2[key].push(c);
    });
    // Sort within chapter: process first, subprocess second
    return Object.keys(buckets2).sort().map(function(k) {
      var items = buckets2[k].slice().sort(function(a,b){
        var ta = a.meta ? a.meta.type : 'z';
        var tb = b.meta ? b.meta.type : 'z';
        var order = { process:0, subprocess:1, reference:2 };
        return (order[ta]||3) - (order[tb]||3);
      });
      return { label: k, items: items };
    });
  }

  if (mode === 'type') {
    var order3 = ['process','subprocess','reference'];
    var buckets3 = {};
    charts.forEach(function(c) {
      var key = (c.meta && c.meta.type) ? c.meta.type : 'uncategorised';
      if (!buckets3[key]) buckets3[key] = [];
      buckets3[key].push(c);
    });
    return order3.concat(Object.keys(buckets3).filter(function(k){ return order3.indexOf(k) === -1; }))
      .filter(function(k){ return buckets3[k]; })
      .map(function(k) {
        var items = buckets3[k].slice().sort(function(a,b){
          var ca = a.meta ? parseFloat(a.meta.chapter||'0') : 0;
          var cb = b.meta ? parseFloat(b.meta.chapter||'0') : 0;
          return ca - cb;
        });
        return { label: k.charAt(0).toUpperCase() + k.slice(1) + 's', items: items };
      });
  }

  if (mode === 'tag') {
    var tagMap = {};
    charts.forEach(function(c) {
      var tags = (c.meta && c.meta.tags) ? c.meta.tags : ['untagged'];
      tags.forEach(function(t) {
        if (!tagMap[t]) tagMap[t] = [];
        tagMap[t].push(c);
      });
    });
    return Object.keys(tagMap).sort().map(function(t) {
      return { label: '#' + t, items: tagMap[t] };
    });
  }

  return [{ label: '', items: charts }];
}

