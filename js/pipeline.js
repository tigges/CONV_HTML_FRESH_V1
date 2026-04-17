// ══════════════════════════════════════════════════════════════════
// Flowinject v4.0 — pipeline.js — repairMermaid, sanitiseLabels, injectColours, Clean, Chunk, Pre-Parse, Analyse stages
// Part of the modular refactor from monolithic index.html (v3.12.2)
// All functions remain global-scope for backward compatibility.
// ══════════════════════════════════════════════════════════════════

// ── Mermaid Repair Pass ───────────────────────────────────────────
// Runs BEFORE sanitiseLabels. Fixes common AI hallucination patterns
// that produce hard parser errors, especially in swimlane (graph LR/TD).
/**
 * Fix common Mermaid syntax errors introduced by Claude:
 * - Split packed node definitions
 * - Fix per-line syntax errors
 * - Strip orphaned Yes/No nodes
 * - Normalise stadium → subroutine for graph dtype
 * @param {string} code - Raw Mermaid code from API response
 * @returns {string} Repaired Mermaid code
 */
function repairMermaid(code) {
  if (!code) return code;
  var lines = code.split('\n');
  var first = lines[0].trim().toLowerCase();
  var isGraph = first.startsWith('graph ');
  var isFlowchart = first.startsWith('flowchart ');

  var repaired = [];
  var decisionIds = {};
  var arrowTargets = {};

  // ── Pass 0: split lines that pack multiple node definitions together ─
  // Claude sometimes outputs: PL1["Label1"]PL2["Label2"] on one line.
  // This splits them into separate lines before any other processing.
  var splitLines = [];
  lines.forEach(function(line) {
    var t = line.trim();
    // Only try to split non-arrow, non-directive lines that may have multiple nodes
    if (t && !t.startsWith('%%') && !t.startsWith('classDef') && !t.startsWith('class ') &&
        !t.startsWith('subgraph') && t !== 'end' && !t.startsWith('flowchart') &&
        !t.startsWith('graph ') && !t.startsWith('sequenceDiagram') &&
        !/-->|---/.test(t)) {
      // Match repeated nodeID["label"] or nodeID{label} or nodeID[["label"]] patterns
      var multiRE = /([A-Za-z_][A-Za-z0-9_-]*\s*(?:\[\[?[^\]]*\]\]?|\{[^}]*\}|\([^)]*\)))/g;
      var parts = [];
      var m;
      multiRE.lastIndex = 0;
      while ((m = multiRE.exec(t)) !== null) parts.push(m[0]);
      if (parts.length > 1) {
        // Multiple node definitions on one line — split them
        var indent = line.match(/^(\s*)/)[1];
        parts.forEach(function(p) { splitLines.push(indent + p.trim()); });
        return;
      }
    }
    splitLines.push(line);
  });
  lines.length = 0;
  splitLines.forEach(function(l) { lines.push(l); });

  // ── Pass 1: fix per-line syntax problems ───────────────────────
  lines.forEach(function(line) {
    var t = line.trim();

    // Skip blank, comment, directive lines
    if (!t || t.startsWith('%%') || t.startsWith('classDef') || t.startsWith('class ') ||
        t.startsWith('subgraph') || t === 'end' || t.startsWith('flowchart') ||
        t.startsWith('graph') || t.startsWith('sequenceDiagram') || t.startsWith('direction')) {
      repaired.push(line);
      return;
    }

    // Fix: --Yes--> style → -->|Yes|
    t = t.replace(/--([A-Za-z][A-Za-z0-9 ]*)-->/g, '-->|$1|');
    t = t.replace(/-->([A-Za-z][A-Za-z0-9 ]*)-->/g, '-->|$1|');
    t = t.replace(/--\s+([A-Za-z][A-Za-z0-9 ]*)\s+-->/g, '-->|$1|');

    // Fix: bare word between arrow and target → pipe label
    t = t.replace(/-->\s+([A-Za-z][A-Za-z0-9]*)\s+([A-Za-z_][A-Za-z0-9_]*)\b(?![\[{(])/g, function(m, label, target) {
      if (/^(yes|no|true|false|approve|reject|pass|fail|found|notfound|valid|invalid|ok|cancel|done)$/i.test(label)) {
        return '-->|' + label + '| ' + target;
      }
      return m;
    });

    // Fix: double-pipe empty label
    t = t.replace(/\|\|/g, '|—|');

    // Collect decision node IDs
    var decMatch = t.match(/([A-Za-z_][A-Za-z0-9_-]*)\s*\{/);
    if (decMatch) {
      decisionIds[decMatch[1]] = decisionIds[decMatch[1]] || { hasYes: false, hasNo: false };
    }

    // Track arrow pipe labels
    var arrowPipeRE = /([A-Za-z_][A-Za-z0-9_-]*)\s*-->?\|([^|]*)\|\s*([A-Za-z_][A-Za-z0-9_-]*)/g;
    var am;
    while ((am = arrowPipeRE.exec(t)) !== null) {
      var fromId = am[1], label = am[2].trim().toLowerCase(), toId = am[3];
      if (decisionIds[fromId]) {
        if (/^y(es)?$/i.test(label) || label === 'true' || label === 'pass' || label === 'approve' || label === 'valid') {
          decisionIds[fromId].hasYes = true;
        }
        if (/^no?$/i.test(label) || label === 'false' || label === 'fail' || label === 'reject' || label === 'invalid') {
          decisionIds[fromId].hasNo = true;
        }
      }
      arrowTargets[toId] = true;
    }

    repaired.push(t);
  });

  var result = repaired.join('\n');

  // ── Pass 2: strip orphaned Yes/No node definitions ─────────────
  if (isGraph || isFlowchart) {
    result = result.replace(
      /^[ \t]+([A-Za-z_][A-Za-z0-9_-]*)\["?(Yes|No|Approve|Reject|Pass|Fail|True|False)"?\]\s*$/gm,
      function(m, id, label) {
        if (/\d$/.test(id) || id.length <= 5) {
          return '  %% removed orphan branch label node: ' + id;
        }
        return m;
      }
    );
  }

  // ── Pass 3: belt-and-suspenders stadium→subroutine for graph ───
  if (isGraph) {
    result = result.replace(
      /([A-Za-z_][A-Za-z0-9_-]*)\s*\(\["?([^"\]]*)"?\]\)/g,
      function(m, id, label) { return id + '[["' + label + '"]]'; }
    );
    result = result.replace(
      /([A-Za-z_][A-Za-z0-9_-]*)\s*\(\[([^\]"]*)\]\)/g,
      function(m, id, label) { return id + '[["' + label + '"]]'; }
    );
  }

  return result;
}

// Strips characters that break Mermaid's parser from node labels.
/**
 * Sanitise node labels in Mermaid code to prevent parser errors.
 * Strips forbidden characters, escapes quotes, caps label length.
 * @param {string} code - Mermaid code
 * @returns {string} Sanitised code
 */
function sanitiseLabels(code) {
  if (!code) return code;
  var first = code.trim().split('\n')[0].trim().toLowerCase();
  var isGraph = first.startsWith('graph '); // swimlane uses "graph LR/TD"

  var result = code
    // Strip bare & in labels → 'and'
    .replace(/(\[)([^\]]*?)&([^\]]*?\])/g, function(m, open, before, after) {
      return open + before + 'and' + after;
    })
    // Strip < > inside node labels (Mermaid treats as HTML)
    .replace(/(\[)([^\]]*?)[<>]([^\]]*?\])/g, function(m, open, before, after) {
      return open + before + after;
    })
    // Strip < > inside decision labels {<text>}
    .replace(/(\{)([^}]*?)[<>]([^}]*?\})/g, function(m, open, before, after) {
      return open + before + after;
    })
    // Collapse multiple spaces inside labels
    .replace(/(\[)([^\]]+?)(\])/g, function(m, o, content, c) {
      return o + content.replace(/\s{2,}/g, ' ').trim() + c;
    })
    // Replace stray INTERIOR double-quotes inside bracket labels.
    // Only fires when a bracket expression has MORE than 2 quotes (open + close = 2 is normal).
    // Avoids stripping the closing " from standard ["label"] nodes.
    .replace(/\[[^\]]+\]/g, function(bracket) {
      var quoteCount = (bracket.match(/"/g) || []).length;
      if (quoteCount <= 2) return bracket; // Normal ["label"] — leave unchanged
      // More than 2 quotes: preserve opening/closing, replace interior ones with single-quotes
      var inner = bracket.slice(1, -1); // content between [ and ]
      if (inner.charAt(0) === '"' && inner.charAt(inner.length - 1) === '"') {
        var mid = inner.slice(1, -1).replace(/"/g, "'");
        return '[' + '"' + mid + '"' + ']';
      }
      return '[' + inner.replace(/"/g, "'") + ']';
    });

  // Mermaid 10.6 bug: stadium shape  ID([...])  crashes inside subgraph blocks.
  // Also: circle shape ID(("...")) crashes inside subgraph blocks.
  // When the diagram is a "graph" (swimlane), rewrite both to ID[["text"]]
  // (subroutine shape — safe inside subgraphs and visually distinct for terminals).
  if (isGraph) {
    // Rewrite ID(("label")) circles → subroutine rect
    result = result.replace(
      /([A-Za-z_][A-Za-z0-9_-]*)\s*\(\("?([^")\n]*)"?\)\)/g,
      function(m, id, label) { return id + '[["' + label + '"]]'; }
    );
    // Rewrite ID(["label"]) stadium → subroutine rect
    result = result.replace(
      /([A-Za-z_][A-Za-z0-9_-]*)\s*\(\["?([^"\]]*)"?\]\)/g,
      function(m, id, label) { return id + '[["' + label + '"]]'; }
    );
    // Also handle bare  ID([label])  without quotes
    result = result.replace(
      /([A-Za-z_][A-Za-z0-9_-]*)\s*\(\[([^\]"]*)\]\)/g,
      function(m, id, label) { return id + '[["' + label + '"]]'; }
    );
  }

  return result;
}
// Two-pass approach:
// Pass 1 — scan every line for node DEFINITIONS (ID[...] ID{...} ID([...]))
//           and record the type of each node ID.
//           Arrow source IDs (A --> B) are NOT definitions so are skipped.
// Pass 2 — emit classDef blocks + class assignments.
/**
 * Post-process Mermaid code to inject classDef colour blocks.
 * Classifies each node as start/end/decision/step/subprocess/note
 * and appends the appropriate classDef and class assignment lines.
 * Always called post-generation — never inside Claude prompts.
 * @param {string} code - Mermaid code (repaired and sanitised)
 * @returns {string} Code with classDef blocks appended
 */
function injectColours(code) {
  if (!code || !code.trim()) return code;
  var first = code.trim().split('\n')[0].trim().toLowerCase();
  // Only inject into flowchart/graph diagrams
  if (first.startsWith('sequencediagram') || first.startsWith('gantt') ||
      first.startsWith('pie') || first.startsWith('erdiagram')) return code;

  // Collect any explicit 'class ID note' hints emitted by graphToMermaid before stripping
  var explicitNotes = {};
  code.split('\n').forEach(function(l) {
    var m = l.trim().match(/^class\s+([A-Za-z_][A-Za-z0-9_-]*)\s+note$/);
    if (m) explicitNotes[m[1]] = true;
  });

  // Strip any existing classDef / class lines so we don't double-up on re-render
  var cleanLines = code.split('\n').filter(function(l) {
    var t = l.trim();
    return !t.startsWith('classDef ') && !t.startsWith('class ');
  });
  var cleanCode = cleanLines.join('\n');

  // ── Pass 1: collect node type by ID ──────────────────────────────
  // Priority: terminal > decision > subprocess > note > step
  var nodeType  = {}; // id -> 'start' | 'stop' | 'decision' | 'subprocess' | 'note' | 'step'
  var nodeLabel = {}; // id -> label text (for start/stop detection)

  var START_WORDS = ['start','begin','initiat','entry','open'];
  var STOP_WORDS  = ['end','stop','finish','exit','close','complet','terminat','reject','resolv'];

  function classifyTerminal(label) {
    var l = (label || '').toLowerCase();
    if (START_WORDS.some(function(w) { return l.indexOf(w) !== -1; })) return 'start';
    if (STOP_WORDS.some(function(w)  { return l.indexOf(w) !== -1; })) return 'stop';
    return 'stop'; // unknown terminals → red (safer than wrong green)
  }

  // Pattern: ID(("label")) — filled circle (used by graphToMermaid for start/end)
  var circlePat  = /(?:^|[\s;,])([A-Za-z_][A-Za-z0-9_-]*)\s*\(\("?([^")\n]*)"?\)\)/g;
  // Pattern: ID(["label"]) — stadium/pill (legacy terminal shape)
  var termPat    = /(?:^|[\s;,])([A-Za-z_][A-Za-z0-9_-]*)\s*\(\[([^\]]*)\]/g;
  // Pattern: ID([label]) — same without quotes
  var term2Pat   = /(?:^|[\s;,])([A-Za-z_][A-Za-z0-9_-]*)\s*\(\[([^\]]*)\]\)/g;
  // Pattern: ID[["label"]] — subroutine rect (subprocess)
  var subrtPat   = /(?:^|[\s;,])([A-Za-z_][A-Za-z0-9_-]*)\s*\[\["?([^"\]]*)"?\]\]/g;
  // Pattern: ID{"label"} — decision diamond
  var decPat     = /(?:^|[\s;,])([A-Za-z_][A-Za-z0-9_-]*)\s*\{/g;
  // Pattern: ID["label"] or ID[label] — step rect (lowest priority)
  var stepPat    = /(?:^|[\s;,])([A-Za-z_][A-Za-z0-9_-]*)\s*(?:\[(?!\[))/g;

  cleanCode.split('\n').forEach(function(line) {
    var t = line.trim();
    if (t.startsWith('%%') || t.startsWith('subgraph') || t === 'end' ||
        t.startsWith('flowchart') || t.startsWith('graph') ||
        t.startsWith('sequenceDiagram') || t.startsWith('direction')) return;
    if (/-->|---/.test(t) && !/[\[{\(]/.test(t)) return;

    var m;

    // Filled circle (("label")) — start/end — highest priority
    circlePat.lastIndex = 0;
    while ((m = circlePat.exec(line)) !== null) {
      var label = m[2] || '';
      nodeType[m[1]]  = classifyTerminal(label);
      nodeLabel[m[1]] = label;
    }

    // Stadium/pill ([...]) — legacy terminal
    termPat.lastIndex = 0;
    while ((m = termPat.exec(line)) !== null) {
      if (nodeType[m[1]]) continue;
      var label = m[2] || '';
      nodeType[m[1]]  = classifyTerminal(label);
      nodeLabel[m[1]] = label;
    }
    term2Pat.lastIndex = 0;
    while ((m = term2Pat.exec(line)) !== null) {
      if (nodeType[m[1]]) continue;
      var label = m[2] || '';
      nodeType[m[1]]  = classifyTerminal(label);
      nodeLabel[m[1]] = label;
    }

    // Subroutine [["..."]] — subprocess (blue, same as step)
    subrtPat.lastIndex = 0;
    while ((m = subrtPat.exec(line)) !== null) {
      if (!nodeType[m[1]]) {
        var label = m[2] || '';
        // Could be start/stop if label says so (legacy fallback)
        var cls = classifyTerminal(label);
        nodeType[m[1]]  = (cls === 'start' || cls === 'stop') ? cls : 'subprocess';
        nodeLabel[m[1]] = label;
      }
    }

    // Decision diamond
    decPat.lastIndex = 0;
    while ((m = decPat.exec(line)) !== null) {
      if (!nodeType[m[1]]) nodeType[m[1]] = 'decision';
    }

    // Step rect (lowest priority)
    stepPat.lastIndex = 0;
    while ((m = stepPat.exec(line)) !== null) {
      if (!nodeType[m[1]]) nodeType[m[1]] = 'step';
    }
  });

  // Apply explicit note hints from graphToMermaid
  Object.keys(explicitNotes).forEach(function(id) {
    nodeType[id] = 'note';
  });

  // ── Pass 2: emit classDef + assignments ───────────────────────────
  var classDefs =
    '\n  classDef step       fill:#dbeafe,stroke:#2563eb,stroke-width:1.5px,color:#1e3a5f\n' +
    '  classDef decision   fill:#fef9c3,stroke:#ca8a04,stroke-width:1.5px,color:#713f12\n' +
    '  classDef start      fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#14532d\n' +
    '  classDef stop       fill:#fee2e2,stroke:#dc2626,stroke-width:2px,color:#7f1d1d\n' +
    '  classDef subprocess fill:#ede9fe,stroke:#7c3aed,stroke-width:1.5px,color:#3b0764\n' +
    '  classDef note       fill:#f3f4f6,stroke:#9ca3af,stroke-width:1px,color:#6b7280\n';

  var assignments = [];
  Object.keys(nodeType).forEach(function(id) {
    var cls = nodeType[id];
    // subprocess uses 'subprocess' class; all others map directly
    assignments.push('  class ' + id + ' ' + cls);
  });

  if (assignments.length === 0) return cleanCode;
  return cleanCode + classDefs + assignments.join('\n') + '\n';
}
function setPipeDot(stage, state) {
  const el = document.getElementById('pd-' + stage);
  if (!el) return;
  el.className = 'pipe-dot' + (state === 'done' ? ' done' : state === 'running' ? ' running' : '');
}

// ── Tab switching ─────────────────────────────────────────────────
function switchLeftTab(tab) {
  currentLeftTab = tab;
  ['raw','clean','chunks','preparse','analysis'].forEach(function(t) {
    document.getElementById('ltab-' + t).classList.toggle('active', t === tab);
    document.getElementById('lpane-' + t).classList.toggle('active', t === tab);
  });
}

function switchRightTab(tab) {
  // Analysis tab: allow click even without extraction — show helpful prompt
  if (tab === 'analysis' && !(pipe.extraction && pipe.extraction.coverage)) {
    currentRightTab = 'analysis';
    ['code','graph','analysis','saved','history','glossary','logic'].forEach(function(t) {
      var btn  = document.getElementById('rtab-' + t);
      var pane = document.getElementById('rpane-' + t);
      if (btn)  btn.classList.toggle('active', t === 'analysis');
      if (pane) pane.classList.toggle('active', t === 'analysis');
    });
    _setGraphTabActions(false);
    _setCodeTabActions(false);
    renderAnalysisDashboard();
    return;
  }
  currentRightTab = tab;
  ['code','graph','analysis','saved','history','glossary','logic'].forEach(function(t) {
    var btn  = document.getElementById('rtab-' + t);
    var pane = document.getElementById('rpane-' + t);
    if (btn)  btn.classList.toggle('active', t === tab);
    if (pane) pane.classList.toggle('active', t === tab);
  });
  _setCodeTabActions(tab === 'code');
  _setGraphTabActions(tab === 'graph');
  if (tab === 'saved')    renderSavedList();
  if (tab === 'history')  renderHistoryList();
  if (tab === 'glossary') { updateGlossaryTierCounts(); renderGlossary(); }
  if (tab === 'logic')    renderLogicTab();
  if (tab === 'analysis') renderAnalysisDashboard();
}

function _setCodeTabActions(show) {
  ['action-load','action-clear','action-render'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.style.display = show ? '' : 'none';
  });
}

function _setGraphTabActions(show) {
  // Primary visible buttons
  ['action-save','action-share','split-toggle'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.style.display = show ? '' : 'none';
  });
  var expBtn = document.getElementById('action-export-btn');
  if (expBtn) expBtn.style.display = show ? '' : 'none';
  // Legacy compat stubs (always hidden)
  ['action-mmd','action-export','action-print','action-export-html','action-export-html-map','action-overflow-btn'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.style.display = 'none';
  });
}

// ── Diagram type hint ─────────────────────────────────────────────
function onDiagramTypeChange() {
  const t = document.getElementById('diagram-type').value;
  clearTimeout(renderTimer);
  var rErr = document.getElementById('render-error');
  if (rErr) rErr.style.display = 'none';
  document.getElementById('api-status').textContent =
    t === 'swimlane' ? '⚑ Select actors in Analysis tab first' :
    t === 'sequence' ? '⇄ Sequence diagram mode' : '';
  // Show lane orientation toggle for swimlane and flowchart (not sequence)
  var orientWrap = document.getElementById('lane-orient-wrap');
  if (orientWrap) orientWrap.style.display = (t === 'sequence') ? 'none' : 'inline-flex';
  updatePreflight();
}

// ── Pipeline: Run all 5 stages ────────────────────────────────────
async function runPipeline() {
  var rawText = document.getElementById('input-text').value;
  console.log('[pipeline] start — textarea chars:', rawText.length, '| pipe.raw chars:', (pipe.raw||'').length);
  if (!rawText.trim()) {
    // Fallback: textarea empty but pipe.raw has content — restore it
    if (pipe.raw && pipe.raw.trim()) {
      document.getElementById('input-text').value = pipe.raw;
      rawText = pipe.raw;
      console.log('[pipeline] restored textarea from pipe.raw, chars:', rawText.length);
    } else {
      showToast('Paste or load a document first'); return;
    }
  }

  var btn = document.getElementById('convert-btn');
  btn.disabled = true;
  btn.textContent = '⟳ Running pipeline…';

  try {
  console.log('[pipeline] start — chars:', rawText.length);
  // Stage 1: Raw
  pipe.raw = rawText;
  setPipeDot('raw', 'done');
  console.log('[pipeline] stage 1 raw done');
  // v3.11.3: show chapter-only size when isolation is active, plus a badge
  var rawMeta = document.getElementById('raw-meta');
  if (rawMeta) {
    if (pipe._chapterText) {
      var estTok = Math.round(pipe._chapterText.length / 4);
      rawMeta.textContent = pipe._chapterText.length.toLocaleString() + ' chars (chapter only · ~' + estTok.toLocaleString() + ' tokens) · TOC isolated';
      rawMeta.title = 'Pass 1 will only see the chapter text. The TOC has been isolated to ChapterRegistry only.';
    } else {
      rawMeta.textContent = rawText.length.toLocaleString() + ' chars';
      rawMeta.title = '';
    }
  }

  // Stage 2: Clean
  setPipeDot('clean', 'running');
  await sleep(30);
  console.log('[pipeline] stage 2 clean start');
  pipe.clean = cleanText(rawText);
  renderCleanPane();
  setPipeDot('clean', 'done');
  console.log('[pipeline] stage 2 clean done — chars:', pipe.clean.length);

  // Stage 3: Chunk
  setPipeDot('chunks', 'running');
  await sleep(30);
  console.log('[pipeline] stage 3 chunk start');
  pipe.chunks = chunkText(pipe.clean);
  renderChunksPane();
  setPipeDot('chunks', 'done');
  console.log('[pipeline] stage 3 chunk done — chunks:', pipe.chunks.length);

  // Stage 4: Pre-Parse (structure tagging)
  setPipeDot('preparse', 'running');
  await sleep(30);
  console.log('[pipeline] stage 4 preparse start');
  pipe.preparsed = preParse(pipe.clean);
  console.log('[pipeline] stage 4 preParse() done — items:', pipe.preparsed.length);
  renderPreParsePane();
  setPipeDot('preparse', 'done');
  console.log('[pipeline] stage 4 preparse done');

  // v3.12.1: TOC detection — runs deterministically after pre-parse, before any LLM call.
  // If a TOC is detected, populate ChapterRegistry + DocumentRegistry immediately.
  // This makes cluster structure available for the Map tab without requiring Generate Chart.
  (function _runTocDetection() {
    var textToScan = pipe._tocText || pipe.raw || '';
    if (!textToScan.trim()) return;
    var toc = detectTOC(textToScan);
    var forcedByButton = !!pipe._isTocLoad;
    pipe._isTocLoad = false; // consume the flag

    if (toc.detected && toc.entries.length >= 2) {
      pipe._currentToc = toc;
      pipe._tocText = textToScan; // confirm as TOC text
      ChapterRegistry.load(toc);
      DocumentRegistry.loadFromToc(toc, (currentProject && currentProject.slug) || 'general');
      _showTocBanner(toc);
      console.log('Pipeline TOC detection: ' + toc.entries.length + ' entries, type=' + toc.doc_type_hint);
    } else if (forcedByButton && toc.entries.length > 0) {
      // ↑ TOC button used explicitly — accept even if below auto-detect threshold
      pipe._currentToc = toc;
      pipe._tocText = textToScan;
      ChapterRegistry.load(toc);
      DocumentRegistry.loadFromToc(toc, (currentProject && currentProject.slug) || 'general');
      _showTocBanner(toc);
      console.log('Pipeline TOC detection (forced): ' + toc.entries.length + ' entries');
    }
  })();

  // Stage 5: Analyse
  setPipeDot('analysis', 'running');
  await sleep(30);
  console.log('[pipeline] stage 5 analysis start');
  runAnalysis(pipe.clean);
  console.log('[pipeline] stage 5 runAnalysis done');
  renderAnalysisPane();
  console.log('[pipeline] stage 5 renderAnalysisPane done');
  setPipeDot('analysis', 'done');
  console.log('[pipeline] stage 5 analysis done');

  // Re-enable button and update status
  btn.disabled = false;
  btn.textContent = '→ Generate Chart';
  updatePipelineStatus(true);
  console.log('[pipeline] updatePipelineStatus done');
  updatePreflight();
  console.log('[pipeline] updatePreflight done');

  // Suggest diagram type based on what was found
  var suggestion = suggestDiagramType(pipe.preparsed, pipe.actors);
  console.log('[pipeline] suggestDiagramType done:', suggestion && suggestion.type);
  renderSuggestion(suggestion);
  console.log('[pipeline] renderSuggestion done');

  var nodeEst = estimateNodeCount(pipe.preparsed);
  showToast('Pipeline done — ' + pipe.chunks.length + ' chunk' + (pipe.chunks.length !== 1 ? 's' : '') +
    ', ' + pipe.actors.length + ' actor' + (pipe.actors.length !== 1 ? 's' : '') + ' · ~' + nodeEst + ' nodes · click Generate Chart ↓');
  console.log('[pipeline] complete ✓');
  switchLeftTab('preparse');

  } catch(err) {
    console.error('[runPipeline] Error at stage:', err.message, err);
    showToast('Pipeline error: ' + err.message);
  } finally {
    btn.disabled = false;
    if (!pipe.preparsed || !pipe.preparsed.length) {
      btn.textContent = '▶ Run & Generate';
    } else {
      btn.textContent = '→ Generate Chart';
    }
  }
}

// ── Stage 2: Clean text ───────────────────────────────────────────
/**
 * Deterministic text cleaning — no API call required.
 * Strips page numbers, running headers/footers, watermarks, unicode
 * artifacts, and normalises whitespace.  Reduces Pass 1 context by ~10–15%.
 * @param {string} raw - Raw input text
 * @returns {string} Cleaned text
 */
function cleanText(raw) {
  if (!raw) return '';

  var text = raw;

  // ── Unicode normalisation ──────────────────────────────────────────
  text = text
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/\u2018|\u2019/g, "'")   // curly single quotes
    .replace(/\u201C|\u201D/g, '"')   // curly double quotes
    .replace(/\u2013/g, '-')          // en-dash
    .replace(/\u2014/g, ' - ')        // em-dash with spaces
    .replace(/\u2026/g, '...')        // ellipsis
    .replace(/\u00A0/g, ' ')          // non-breaking space
    .replace(/\uFEFF/g, '')           // BOM
    .replace(/[^\x09\x0A\x20-\x7E\u00C0-\uFFFF]/g, ''); // strip non-printable

  // ── Hyphenated line-break repair ──────────────────────────────────
  text = text.replace(/-\n([a-z])/g, '$1');

  // ── Tabs → spaces ─────────────────────────────────────────────────
  text = text.replace(/\t/g, '  ');

  // ── Page numbers: lines that are just a number (possibly dashed) ──
  // Matches: "12", "- 12 -", "— 12 —", "Page 12", "12 of 45"
  text = text.replace(/^[ \t]*[-–—]?\s*(?:Page\s+)?\d+(?:\s+of\s+\d+)?\s*[-–—]?[ \t]*$/gim, '');

  // ── Watermarks / classification banners ───────────────────────────
  // Removes lines that are purely CONFIDENTIAL / DRAFT / INTERNAL etc.
  text = text.replace(/^[ \t]*(?:CONFIDENTIAL|DRAFT|INTERNAL USE ONLY|PROPRIETARY|©.{0,80}|All rights reserved.*)[ \t]*$/gim, '');

  // ── Running headers / footers (repeated lines) ────────────────────
  // A line appearing 3+ times with no surrounding context is a running header.
  (function _stripRepeatedLines() {
    var lineList = text.split('\n');
    var freq = {};
    lineList.forEach(function(l) {
      var t = l.trim();
      if (t.length >= 8 && t.length <= 120) freq[t] = (freq[t] || 0) + 1;
    });
    var repeated = Object.keys(freq).filter(function(t) { return freq[t] >= 3; });
    if (repeated.length) {
      var reStr = repeated.map(function(t) {
        return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('|');
      var re = new RegExp('^[ \\t]*(?:' + reStr + ')[ \\t]*$', 'gm');
      text = text.replace(re, '');
    }
  })();

  // ── Trailing whitespace per line ──────────────────────────────────
  text = text.split('\n').map(function(l) { return l.trimEnd(); }).join('\n');

  // ── Collapse 3+ blank lines → 1 ──────────────────────────────────
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

function renderCleanPane() {
  const v = document.getElementById('clean-viewer');
  const e = document.getElementById('clean-empty');
  v.textContent = pipe.clean;
  v.style.display = 'block';
  e.style.display = 'none';
  document.getElementById('btn-copy-clean').style.display = '';
  const pct = pipe.raw.length
    ? Math.round((1 - pipe.clean.length / pipe.raw.length) * 100) : 0;
  document.getElementById('clean-meta').textContent =
    pipe.clean.length.toLocaleString() + ' chars' + (pct > 0 ? ' (' + pct + '% reduced)' : '');
}

// ── Stage 3: Chunk ────────────────────────────────────────────────
function chunkText(text, maxTokens) {
  maxTokens = maxTokens || 600;
  var OVERLAP_SENTENCES = 2; // carry last N sentences of previous chunk into next
  const segments = text.split(/\n\n+/);
  const chunks = [];
  let current = '';
  let idx = 0;
  let overlapTail = ''; // last sentences from previous chunk

  for (const seg of segments) {
    const combined = current ? current + '\n\n' + seg : seg;
    if (current && Math.ceil(combined.length / 4) > maxTokens) {
      chunks.push(makeChunk(current.trim(), idx++));
      // Extract overlap: last OVERLAP_SENTENCES sentences from current chunk
      var sentences = current.trim().split(/(?<=[.!?])\s+/);
      overlapTail = sentences.slice(-OVERLAP_SENTENCES).join(' ');
      // Start next chunk with overlap context + new segment
      current = overlapTail ? overlapTail + '\n\n' + seg : seg;
    } else {
      current = combined;
    }
  }
  if (current.trim()) chunks.push(makeChunk(current.trim(), idx));
  return chunks;
}

function makeChunk(text, idx) {
  const firstLine = text.split('\n')[0].replace(/^#+\s*/, '').replace(/^\d+\.\s*/, '').trim();
  const title = firstLine.substring(0, 55) || ('Section ' + (idx + 1));
  return { title, text, tokens: Math.ceil(text.length / 4), words: text.split(/\s+/).length, idx };
}

function renderChunksPane() {
  const list  = document.getElementById('chunk-list');
  const empty = document.getElementById('chunks-empty');
  empty.style.display = 'none';
  list.style.display  = 'flex';
  const total = pipe.chunks.reduce(function(a, c) { return a + c.tokens; }, 0);
  document.getElementById('chunks-meta').textContent =
    pipe.chunks.length + ' chunks · ~' + total.toLocaleString() + ' tokens total';

  list.innerHTML = pipe.chunks.map(function(c, i) {
    return '<div class="chunk-card" id="cc-' + i + '">' +
      '<div class="chunk-header" onclick="toggleChunk(' + i + ')">' +
        '<span class="chunk-title">' + escHtml(c.title) + '</span>' +
        '<div class="chunk-badges">' +
          '<span class="cbadge purple">§' + (i + 1) + '</span>' +
          '<span class="cbadge">~' + c.tokens + ' tok</span>' +
          '<span class="cbadge green">' + c.words + ' w</span>' +
        '</div>' +
      '</div>' +
      '<div class="chunk-body">' + escHtml(c.text.length > 500 ? c.text.substring(0, 500) + '\n…' : c.text) + '</div>' +
    '</div>';
  }).join('');
}

function toggleChunk(i) {
  document.getElementById('cc-' + i).classList.toggle('open');
}

// ── Stage 4: Pre-Parse — structure tagging ────────────────────────
//
// Classifies each sentence/line into one of:
//   heading   — section title / heading
//   step      — an action someone performs
//   decision  — a conditional / if / whether
//   condition — a trigger / when / upon
//   outcome   — a result / then / therefore
//   actor     — a role reference (standalone)
//   note      — background info / definitions / notes
//
// These tags are:
//   1. Shown in the Pre-Parse pipeline tab for transparency
//   2. Passed to the AI as structured input for better chart generation

// ── Intel-a: JUNK_RULES (v3.1.0) ─────────────────────────────────
// Three-tier confidence scoring for junk detection:
//   hard   (≥0.90) — removed silently, not shown in graveyard
//   medium (0.65–0.89) — sent to graveyard for review, NOT sent to AI
//   soft   (0.50–0.64) — sent to graveyard but marked "uncertain" — rescue available
//
// Each rule: { pattern, reason, confidence }
var JUNK_RULES = [
  // ── Hard drops (≥0.90): zero procedural value ──
  { pattern: /^page\s+\d+(\s+of\s+\d+)?$/i,                      reason: 'Page number',              confidence: 0.98 },
  { pattern: /^\d+\s*\/\s*\d+$/,                                  reason: 'Page fraction',             confidence: 0.98 },
  { pattern: /^https?:\/\//,                                      reason: 'URL',                       confidence: 0.97 },
  { pattern: /^www\./i,                                           reason: 'URL',                       confidence: 0.97 },
  { pattern: /^copyright\b/i,                                     reason: 'Copyright notice',          confidence: 0.97 },
  { pattern: /^all rights reserved\b/i,                           reason: 'Copyright notice',          confidence: 0.97 },
  { pattern: /^confidential\b/i,                                  reason: 'Document classification',   confidence: 0.96 },
  { pattern: /^internal use only\b/i,                             reason: 'Document classification',   confidence: 0.96 },
  { pattern: /^do not distribute\b/i,                             reason: 'Document classification',   confidence: 0.96 },
  { pattern: /^draft\b/i,                                         reason: 'Draft watermark',           confidence: 0.95 },
  { pattern: /^end of document\b/i,                               reason: 'Document footer',           confidence: 0.95 },
  { pattern: /^table of contents\b/i,                             reason: 'TOC header',                confidence: 0.95 },
  { pattern: /^contents\b$/i,                                     reason: 'TOC header',                confidence: 0.95 },
  { pattern: /^(version|revision|rev|v)\s*[\d.]+\b/i,            reason: 'Version stamp',             confidence: 0.94 },
  { pattern: /^(date|last updated|modified|effective date)\b/i,   reason: 'Document date line',        confidence: 0.93 },
  { pattern: /^(author|created by|written by|prepared by|updated by)\b/i, reason: 'Author attribution', confidence: 0.93 },
  { pattern: /^by\s+[A-Z][a-zA-Z]+/,                             reason: 'Author attribution',        confidence: 0.91 },
  { pattern: /^(training team|training department|hr department|cstrainingteam)\b/i, reason: 'Team attribution', confidence: 0.93 },
  { pattern: /^\(?\d+\)?$/,                                       reason: 'Lone number',               confidence: 0.92 },
  { pattern: /^\d+\.$/,                                           reason: 'Lone numbered item',        confidence: 0.92 },
  { pattern: /^[.\-_=*#~]{4,}$/,                                  reason: 'Separator line',            confidence: 0.98 },

  // ── Medium confidence (0.65–0.89): probably noise, send to graveyard ──
  { pattern: /^(note:|disclaimer:|warning:|tip:|nb:)\s*$/i,       reason: 'Standalone label',          confidence: 0.85 },
  { pattern: /^(approved|reviewed|signed)\s+by\b/i,              reason: 'Approval attribution',      confidence: 0.82 },
  { pattern: /^(document\s+(owner|control|id|reference|number))\b/i, reason: 'Document metadata',    confidence: 0.80 },
  { pattern: /^(status|revision history|change log|amendment)\s*:?\s*$/i, reason: 'Metadata section header', confidence: 0.78 },
  { pattern: /^(this document|this procedure|this policy|this guide)\b/i, reason: 'Self-referential intro', confidence: 0.75 },
  { pattern: /^(the purpose of this|the scope of this|this sop)\b/i, reason: 'Self-referential intro', confidence: 0.75 },
  { pattern: /^(introduction|overview|background|scope|purpose)\s*:?\s*$/i, reason: 'Section stub',   confidence: 0.72 },
  { pattern: /^(appendix|annex|exhibit)\s+[a-z0-9]/i,            reason: 'Appendix reference',        confidence: 0.70 },
  { pattern: /^(related (documents?|procedures?|policies?|sops?))\b/i, reason: 'Reference list header', confidence: 0.68 },
  { pattern: /^(terms and conditions|definitions and terms)\b/i,  reason: 'Glossary section',          confidence: 0.67 },

  // ── Soft confidence (0.50–0.64): uncertain — graveyard with rescue ──
  { pattern: /^[A-Z][a-zA-Z\s]{1,30}(team|department|division|group)\s*$/i, reason: 'Possible team name', confidence: 0.58 },
  { pattern: /^[A-Z]{2,}(\s+[A-Z]{2,}){0,2}\s*$/,               reason: 'All-caps short phrase — possibly a heading or acronym', confidence: 0.55 },
  { pattern: /^(n\/a|none|tbc|tbd|pending|n\.a\.)\s*$/i,         reason: 'Placeholder value',         confidence: 0.62 },
  { pattern: /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/,             reason: 'Date value',                confidence: 0.60 },
];

// Confidence tier boundaries
var JUNK_TIER_HARD   = 0.90; // hard drop — silent
var JUNK_TIER_MEDIUM = 0.65; // graveyard — hidden from AI but user-visible
var JUNK_TIER_SOFT   = 0.50; // graveyard — uncertain, rescue available

// Score a line against JUNK_RULES. Returns null if no match.
// Returns { confidence, reason, rule, tier:'hard'|'medium'|'soft' }
function scoreJunk(text) {
  var t = text.trim();
  if (!t || t.length < 2) return { confidence: 0.99, reason: 'Empty / trivial', rule: 'empty', tier: 'hard' };
  // Very short lines with no letters are almost certainly noise
  if (t.length < 4 && !/[a-zA-Z]{2,}/.test(t)) {
    return { confidence: 0.92, reason: 'Too short — no alphabetic content', rule: 'trivial', tier: 'hard' };
  }
  for (var i = 0; i < JUNK_RULES.length; i++) {
    var rule = JUNK_RULES[i];
    if (rule.pattern.test(t)) {
      var tier = rule.confidence >= JUNK_TIER_HARD ? 'hard'
               : rule.confidence >= JUNK_TIER_MEDIUM ? 'medium' : 'soft';
      return { confidence: rule.confidence, reason: rule.reason, rule: String(rule.pattern), tier: tier };
    }
  }
  return null;
}

// ── Intel-b: Semantic fact scoring (v3.1.0) ──────────────────────
// Returns { score, signals } — score 0-1 (higher = more fact-like, less procedural)
// Lines scoring ≥ FACT_SCORE_THRESHOLD are reclassified to 'note'.
var FACT_SCORE_THRESHOLD = 0.60;

var FACT_CUE_STARTERS_RE = /^(context|background|fact|statement|definition|policy|rule|constraint|assumption|premise|current state|concept|overview|introduction|summary)\b/i;
var FACT_DEFINITION_RE   = /\b(is|are|means|defined as|refers to|consists of|is described as|stands for)\b/i;
var FACT_MEASURE_RE      = /(%|\bas of\b|\bcurrently\b|\bbaseline\b|\btarget\b|\bthreshold\b|\bsla\b|\bkpi\b|\b\d+\s*(days?|hours?|minutes?|seconds?|weeks?)\b)/i;

var FACT_ACTION_VERBS_RE = /^(send|create|update|delete|add|remove|set|get|open|close|log|save|submit|upload|download|assign|escalate|notify|inform|redirect|advise|guide|process|handle|review|approve|reject|cancel|complete|reset|change|modify|request|contact|transfer|forward|post|click|select|enter|fill|search|navigate|enable|disable|verify|check|validate|confirm|resolve|investigate|issue|provide|collect|record|monitor|flag|block|generate|trigger|initiate|authorise|authorize|instruct|respond|return|archive|perform|document)\b/i;
var FACT_DECISION_START_RE = /^(if |when |whether |does |should |will |can |is |are |has |have |check |verify |confirm |validate |ensure )/i;
var FACT_ACTOR_ACTION_RE  = /\b(player|customer|user|agent|support|system|sm|manager|advisor|finance)\b/i;

function scoreFactStatement(text) {
  var t = text.trim();
  var lower = t.toLowerCase();
  var score = 0;
  var signals = [];

  if (FACT_CUE_STARTERS_RE.test(lower)) { score += 0.40; signals.push('fact-cue-starter'); }
  if (FACT_DEFINITION_RE.test(lower))   { score += 0.20; signals.push('definition-pattern'); }
  if (FACT_MEASURE_RE.test(lower))      { score += 0.15; signals.push('metric-or-baseline'); }

  // Non-procedural tone bonus (no question, no action verb at start)
  var hasQuestion  = lower.includes('?') || FACT_DECISION_START_RE.test(lower);
  var actionLike   = FACT_ACTION_VERBS_RE.test(lower);
  if (!hasQuestion && !actionLike) { score += 0.10; signals.push('non-procedural-tone'); }

  // Penalties
  if (hasQuestion || lower.endsWith('?')) { score -= 0.40; signals.push('decision-like'); }
  if (actionLike)                          { score -= 0.25; signals.push('action-like'); }
  if (FACT_ACTOR_ACTION_RE.test(lower) && actionLike) { score -= 0.20; signals.push('actor-action'); }

  var clamped = Math.max(0, Math.min(1, score));
  return { score: clamped, signals: signals };
}

// ── Intel-c: Smart label splitting (v3.1.0) ──────────────────────
// Extracts label + description from structured text patterns.
// To revert independently: replace smartSplitLabel() call in preParse()
// with just: label = proposeLabel(type, s);  and remove this function.
function smartSplitLabel(text) {
  var t = text.trim().replace(/^[-•*\d]+\.?\s*/, '');

  // Flow arrow
  if (t.indexOf(' -> ') !== -1) {
    var parts = t.split(' -> ');
    return { label: parts[0].trim(), description: parts.slice(1).join(' -> ').trim() };
  }
  // Em-dash
  var emDash = t.indexOf(' — ');
  if (emDash > 0 && emDash < 60) {
    return { label: t.slice(0, emDash).trim(), description: t.slice(emDash + 3).trim() };
  }
  // Colon (but not "If X: then Y" decision patterns)
  var colon = t.indexOf(':');
  if (colon > 0 && colon < 55 && !FACT_DECISION_START_RE.test(t)) {
    var lbl = t.slice(0, colon).trim();
    var words = lbl.split(/\s+/);
    // Only use colon split if label side is 1-5 words (avoids splitting mid-sentence)
    if (words.length >= 1 && words.length <= 5) {
      return { label: lbl, description: t.slice(colon + 1).trim() };
    }
  }
  // Simple dash (only if dash is early enough to be a separator)
  var dash = t.indexOf(' - ');
  if (dash > 0 && dash < 40) {
    return { label: t.slice(0, dash).trim(), description: t.slice(dash + 3).trim() };
  }
  // No split found — return full text as label, no description
  return { label: t, description: '' };
}

// ── Intel-d: Pre-parse deduplication (v3.2.0) ────────────────────
// Jaccard similarity on tokenised labels to find near-duplicate steps.
// Returns a similarity score 0–1; threshold 0.85 means "essentially the same step".
var DEDUP_STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','to','of','in','on','at','by','for',
  'and','or','with','this','that','will','should','must','please','step',
]);

function dedupTokenize(text) {
  return (text || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(function(t) { return t.length >= 3 && !DEDUP_STOP_WORDS.has(t); });
}

function labelJaccard(a, b) {
  var aTokens = dedupTokenize(a);
  var bTokens = dedupTokenize(b);
  if (!aTokens.length || !bTokens.length) return 0;
  var aSet = new Set(aTokens);
  var bSet = new Set(bTokens);
  var intersection = 0;
  aSet.forEach(function(t) { if (bSet.has(t)) intersection++; });
  var union = new Set([].concat(aTokens, bTokens)).size;
  return union === 0 ? 0 : intersection / union;
}

// Dedup threshold — items with label Jaccard >= this are merged
var DEDUP_THRESHOLD = 0.85;

// Runs dedup on a completed results array, returns { deduped, mergedCount }
function dedupPreParsed(results) {
  var kept = [];
  var mergedCount = 0;
  var seenLabels = [];

  results.forEach(function(item) {
    // Only dedup actionable types — never collapse headings or notes
    var actionable = ['step','decision','subprocess','process','outcome','condition'].indexOf(item.type) !== -1;
    if (!actionable) { kept.push(item); return; }

    var isDuplicate = seenLabels.some(function(existing) {
      return existing.type === item.type && labelJaccard(existing.label, item.label) >= DEDUP_THRESHOLD;
    });

    if (isDuplicate) {
      mergedCount++;
    } else {
      seenLabels.push(item);
      kept.push(item);
    }
  });

  return { deduped: kept, mergedCount: mergedCount };
}

// Patterns that are definitively background notes — checked BEFORE step classification
var NOTE_PATTERNS = [
  /^(note|please note|n\.b\.|nb:|important:|warning:|tip:)/i,
  /\bis defined as\b/i,
  /\brefers to\b/i,
  /\bmeans that\b/i,
  /\bfor example\b/i,
  /\bfor instance\b/i,
  /\be\.g\./i,
  /\bi\.e\./i,
  /\bsuch as\b/i,
  /\bincluding but not limited to\b/i,
  /\bthis document\b/i,
  /\bthis procedure\b/i,
  /\bthis policy\b/i,
  /\bthe purpose of\b/i,
  /\boverview\b/i,
  /\bbackground\b/i,
  /\bintroduction\b/i,
  /^[A-Z][a-z]+ is (a|an|the) /,  // "X is a Y" = definition
  /\babbreviation\b/i,
  /\bacronym\b/i,
];

var STEP_VERBS = [
  // original verbs
  'verify','check','review','send','receive','request','submit','approve','reject',
  'process','validate','confirm','notify','escalate','document','update','log',
  'create','close','open','contact','investigate','resolve','complete','inform',
  'issue','provide','collect','upload','download','assign','transfer','record',
  'monitor','flag','block','cancel','generate','trigger','initiate','authorise',
  'authorize','instruct','respond','return','forward','archive','perform','enter',
  // v3.4.1 additions — iGaming CS domain verbs
  'unblock','clear','reset','enable','disable','mark','tag','set','track',
  'ask','follow','compare','calculate','refund','withdraw','deposit',
  'attempt','retry','fail','pass','match','reply','disable',
];

// Gate 1 helper — checks if a cleaned line begins with an action verb
function startsWithActionVerb(text) {
  var first = text.trim().toLowerCase().split(/\s+/)[0].replace(/[^a-z]/g, '');
  return STEP_VERBS.indexOf(first) !== -1;
}

// Gate 2 helper — checks if any glossary term appears in the line
// Built once per preParse() call and reused across classifyLine() calls
var _stepGlossaryTerms = []; // populated by preParse() before classifyLine() runs

function matchesGlossaryTerm(text) {
  if (!_stepGlossaryTerms.length) return false;
  var lower = text.toLowerCase();
  return _stepGlossaryTerms.some(function(term) { return lower.indexOf(term) !== -1; });
}

// Per-preParse() step classification counters — merged into pipe.stats after preParse
var _classifyStats = { stepVerbMatches: 0, stepGlossaryMatches: 0, noteReclassified: 0 };

var DECISION_MARKERS = [
  'if ','whether ','unless ','in case ','provided that ','depending on ',
  'should the ','check if ','determine if ','assess whether ','verify if ',
  'is eligible','are eligible',
];

var CONDITION_MARKERS = [
  'upon ','once ','after ','before ','until ','whenever ','as soon as ',
  'following ','in the event ','at the point ','on receipt ','having ',
];

var OUTCOME_MARKERS = [
  'then ','therefore ','consequently ','as a result ','in that case ',
  'will be ','shall be ','must be ','is approved','is rejected',
  'escalate to ','refer to ','close the ','the case is ',
];

// New markers for process/policy/cluster
var PROCESS_MARKERS = [
  'process:','process consists','this process','the process','overall process',
  'workflow:','flow:','procedure:','procedure consists',
];
var SUBPROCESS_MARKERS = [
  'sub-process','subprocess','sub process','step \d','phase \d',
  'part \d','section \d','stage \d','\d+\.\d+', // e.g. 2.1, 3.2
];
var POLICY_MARKERS = [
  'per policy','per company policy','per the policy','in accordance with',
  'as per ','per our ','policy states','policy requires','regulatory',
  'compliance requires','must comply','in line with','pursuant to',
];
var CLUSTER_MARKERS = [
  'the following steps','the following actions','the following applies',
  'in this phase','in this stage','in this section','grouped under',
  'the below steps','these steps apply',
];

// Status/state labels: short noun phrases with no main verb — UI states, system statuses
var STATUS_MARKERS = [
  /^(pending|approved|rejected|declined|cancelled|closed|open|active|inactive|suspended|verified|unverified|complete|incomplete|processing|failed|success|submitted|locked|flagged|escalated|on hold|resolved|expired|blocked)$/i,
];
// Status detection: Title Case noun phrase ≤5 words with no action verb
var STATUS_NOUN_RE = /^[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z\/]+){0,4}$/;
var STATUS_VERB_EXCLUSION = /\b(is|are|was|were|will|should|must|can|may|verify|check|send|receive|submit|approve|reject|process|validate|confirm|notify|escalate|update|log|create|close|open|contact|investigate|resolve|complete|issue|provide|collect|upload|assign|transfer|record|monitor|flag|block|cancel|generate|trigger|initiate|authorise|authorize|instruct|respond|return|forward|archive|perform|enter|review|document|request|respond|inform)\b/i;

/**
 * Configurable actor prefix map for swimlane lane attribution.
 * Each entry maps a regex (tested against the lowercased line start)
 * to a canonical actor name used as a swimlane header.
 * Add or override entries here to customise actor detection per-project.
 */
var ACTOR_PREFIX_MAP = [
  // ── iGaming / CS core actors ──────────────────────────────────────
  { re: /^(the\s+)?(player|customer|client|user|punter|member)\b/i,           actor: 'Player'     },
  { re: /^(the\s+)?(agent|advisor|support|operator|staff|rep|representative|cs|csr)\b/i, actor: 'Agent' },
  { re: /^(the\s+)?(system|platform|bot|automated|kyc|backend|engine|api)\b/i, actor: 'System'   },
  { re: /^(the\s+)?(manager|supervisor|team lead|lead|compliance|head of)\b/i, actor: 'Manager'  },
  { re: /^(the\s+)?(finance|payment|cashier|treasury|fraud|risk|psp)\b/i,      actor: 'Finance'  },
  { re: /^(the\s+)?(vip|account manager|am)\b/i,                               actor: 'VIP Team' },
  { re: /^(the\s+)?(security|2fa|mfa|auth|verification)\b/i,                   actor: 'Security' },
  // ── Explicit @Actor: prefix pattern ──────────────────────────────
  { re: /^@([A-Z][a-zA-Z ]{1,24}):\s*/,                                        actor: null, _prefixExtract: true },
  // ── Bold actor: **Actor**: pattern ───────────────────────────────
  { re: /^\*\*([A-Z][a-zA-Z ]{1,24})\*\*:\s*/,                                 actor: null, _prefixExtract: true },
];

/**
 * Detect which actor owns a line based on ACTOR_PREFIX_MAP.
 * @param {string} line - A single text line
 * @returns {string|null} Actor name, or null if not detected
 */
function detectActorPrefix(line) {
  var t = line.trim();
  var lower = t.toLowerCase();
  for (var i = 0; i < ACTOR_PREFIX_MAP.length; i++) {
    var entry = ACTOR_PREFIX_MAP[i];
    var m = t.match(entry.re);
    if (m) {
      if (entry._prefixExtract && m[1]) return m[1].trim();
      return entry.actor;
    }
  }
  return null;
}

// Heading: markdown #, numbered section (1. Title), decimal section (4.2 Title), or Title Case line ≥3 words
// Deliberately strict — avoids catching "NOTE:", "e.g.", short phrases
var HEADING_RE = /^(#{1,4}\s+\S.{2,}|\d+\.\d*\s+[A-Z][a-z].{2,}|\d+\.\s+[A-Z][a-z].{5,40}$|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){2,}:?\s*$)/;
// Common false-positive starters that should NOT be headings
var HEADING_BLACKLIST = ['note','e.g.','i.e.','e.g','please','however','therefore','additionally','for example'];

function isHeading(line) {
  var t = line.trim();
  if (!HEADING_RE.test(t)) return false;
  var lower = t.toLowerCase();
  return !HEADING_BLACKLIST.some(function(b) { return lower.startsWith(b); });
}

function classifyLine(line) {
  var t = line.trim();
  if (!t || t.length < 4) return null;

  // Note — check first to prevent mis-classifying background text as steps
  if (NOTE_PATTERNS.some(function(pat) { return pat.test(t); })) return 'note';

  // v3.2.0: DOCX depth-aware heading routing
  // ## prefix (H2 from DOCX) → subprocess; ### prefix (H3) → cluster
  if (/^#{3,}\s/.test(t)) return 'cluster';
  if (/^#{2}\s/.test(t))  return 'subprocess';

  // Heading — strict check (now includes decimal sections like 4.2)
  if (isHeading(t)) return 'heading';

  var lower = t.toLowerCase();

  // Policy — highest specificity before other types
  if (POLICY_MARKERS.some(function(m) { return lower.indexOf(m) !== -1; })) return 'policy';

  // Process / Sub-process
  if (SUBPROCESS_MARKERS.some(function(m) { return lower.match(new RegExp(m)); })) return 'subprocess';
  if (PROCESS_MARKERS.some(function(m) { return lower.indexOf(m) !== -1; })) return 'process';

  // Cluster grouping
  if (CLUSTER_MARKERS.some(function(m) { return lower.indexOf(m) !== -1; })) return 'cluster';

  // Decision: contains conditional markers
  if (DECISION_MARKERS.some(function(m) { return lower.indexOf(m) !== -1; }) || t.endsWith('?')) return 'decision';

  // Condition: trigger/timing words at start
  if (CONDITION_MARKERS.some(function(m) { return lower.indexOf(m) !== -1; })) return 'condition';

  // Outcome: result words
  if (OUTCOME_MARKERS.some(function(m) { return lower.indexOf(m) !== -1; })) return 'outcome';

  // Status: known state words, or short Title Case noun phrase with no action verb
  if (STATUS_MARKERS.some(function(pat) { return pat.test(t.trim()); })) return 'status';
  var words = t.trim().split(/\s+/);
  if (words.length <= 5 && STATUS_NOUN_RE.test(t.trim()) && !STATUS_VERB_EXCLUSION.test(t)) return 'status';

  // Step: starts with a known action verb (Gate 1 explicit match)
  var stripped = t.replace(/^[-•*\d]+\.?\s*/, '').toLowerCase();
  if (STEP_VERBS.some(function(v) {
    return stripped.startsWith(v + ' ') ||
           stripped.startsWith('the ' + v) ||
           stripped.startsWith('agent ' + v) ||
           stripped.startsWith('player ' + v) ||
           stripped.startsWith('system ' + v);
  })) {
    _classifyStats.stepVerbMatches++;
    return 'step';
  }

  // Short sentence two-gate check (v3.4.1):
  // Previously any ≤12-word lowercase sentence became STEP — too noisy.
  // Now requires Gate 1 (action verb at start) OR Gate 2 (glossary term present).
  // If neither passes → NOTE (excluded from Claude context).
  var wordArr = stripped.split(/\s+/);
  var isShortSentence = wordArr.length <= 12 && wordArr.length > 1 && /^[a-z]/.test(stripped) &&
    !stripped.startsWith('note') && !stripped.startsWith('please note') &&
    !stripped.startsWith('for example') && !stripped.startsWith('e.g');

  if (isShortSentence) {
    // Gate 1: action verb anywhere in position 0
    if (startsWithActionVerb(stripped)) {
      _classifyStats.stepVerbMatches++;
      return 'step';
    }
    // Gate 2: glossary term match
    if (matchesGlossaryTerm(t)) {
      _classifyStats.stepGlossaryMatches++;
      return 'step';
    }
    // Neither gate passed — reclassify to NOTE
    _classifyStats.noteReclassified++;
    return 'note';
  }

  return 'note';
}

// Stop words to strip before extracting a node label
var LABEL_STOP_WORDS = [
  'the','a','an','this','that','these','those','is','are','was','were',
  'should','must','will','would','could','may','might','shall','can',
  'be','been','being','have','has','had','do','does','did',
  'to','of','in','on','at','by','for','with','from','and','or','but',
  'if','then','when','where','who','which','how','what','all','also',
  'please','note','additionally','furthermore','however','therefore',
  'agent','player','customer','user','system', // actors — too generic for labels
];

function stripStopWords(text) {
  var words = text.split(/\s+/);
  var filtered = words.filter(function(w) {
    return LABEL_STOP_WORDS.indexOf(w.toLowerCase()) === -1 && w.length > 1;
  });
  // If we filtered too aggressively, fall back to original
  return filtered.length >= 2 ? filtered : words;
}

// Convert a tagged line to a short proposed node label
function proposeLabel(type, text) {
  var t = text.trim().replace(/^[-•*\d]+\.?\s*/, '');
  if (type === 'heading') {
    return t.replace(/^#+\s*/, '').replace(/:$/, '').substring(0, 40);
  }
  if (type === 'decision') {
    var q = t.replace(/^(if|when|whether|check if|determine if|assess whether)\s*/i, '');
    var words = stripStopWords(q).slice(0, 5).join(' ');
    words = words.charAt(0).toUpperCase() + words.slice(1);
    return words.endsWith('?') ? words : words + '?';
  }
  if (type === 'step' || type === 'condition' || type === 'outcome' ||
      type === 'process' || type === 'subprocess') {
    var clean = t.replace(/^(the agent should|the player must|the system will|please|you should|we must|per policy|in accordance with|as per)\s*/i, '');
    var w = stripStopWords(clean).slice(0, 4);
    return w.map(function(x) { return x.charAt(0).toUpperCase() + x.slice(1).toLowerCase(); }).join(' ');
  }
  if (type === 'policy') {
    // Policy = short reference label
    return t.replace(/^(per|as per|in accordance with|per company)\s*/i, '')
             .split(/\s+/).slice(0, 4).join(' ');
  }
  return t.substring(0, 35);
}

// Domain default actor for unattributed steps — used when no prefix and no section context
var DOMAIN_DEFAULT_ACTOR = {
  igaming:    'Agent',   // CS procedures written from agent perspective
  generic:    'Employee',
  banking:    'Advisor',
  healthcare: 'Clinician',
  ecommerce:  'Support',
};

// Detect an actor name mentioned anywhere in a heading line
function detectActorInHeading(headingText) {
  var lower = headingText.toLowerCase();
  for (var i = 0; i < ACTOR_PREFIX_MAP.length; i++) {
    // Use the synonym list from the current domain preset for heading detection
    var entry = ACTOR_PREFIX_MAP[i];
    // Build a simple regex from the entry's regex source
    if (entry.re.test(lower)) return entry.actor;
  }
  return null;
}

// Keyword-based actor inference — fires when no prefix and no section actor
// Checks if the sentence body contains domain-specific keywords for System or Finance
var ACTOR_KEYWORD_MAP = [
  { keywords: ['system','platform','automated','bot','kyc check','kyc verification','backend',
               'verification system','automatically','auto-','notification sent','email sent',
               'sms sent','status update','status updated','flagged by','triggered by'],
    actor: 'System' },
  { keywords: ['payment','transaction','withdrawal amount','deposit amount','cashier',
               'treasury','fraud check','risk check','fund','balance','bank','transfer amount',
               'payout','refund','chargeback','finance review','finance team'],
    actor: 'Finance' },
  { keywords: ['manager','supervisor','team lead','compliance officer','vip team',
               'escalated to','referred to manager','approved by','sign-off'],
    actor: 'Manager' },
];

function detectActorByKeywords(sentence) {
  var lower = sentence.toLowerCase();
  for (var i = 0; i < ACTOR_KEYWORD_MAP.length; i++) {
    var entry = ACTOR_KEYWORD_MAP[i];
    if (entry.keywords.some(function(k) { return lower.indexOf(k) !== -1; })) {
      return entry.actor;
    }
  }
  return null;
}

/**
 * Pre-parse cleaned text into a structured array of tagged elements.
 * Classifies each line as step, decision, heading, actor, policy, etc.
 * Applies Intel-a (junk filter), Intel-b (fact scoring),
 * Intel-c (smart label split), Intel-d (deduplication) when enabled.
 * @param {string} text - Cleaned text (output of cleanText())
 * @returns {Array<{type:string, text:string, actor:string|null, score:number}>}
 */
function preParse(text) {
  var results      = [];
  var sectionActor = null;
  var lastActor    = null;
  var domain       = getCurrentDomain();
  var defaultActor = DOMAIN_DEFAULT_ACTOR[domain] || 'Agent';

  // v3.1.0: reset pipeline tracing state
  pipe.graveyard = [];
  pipe.stages    = [];

  // v3.4.1: reset classify-gate stats and build glossary term list for Gate 2
  _classifyStats = { stepVerbMatches: 0, stepGlossaryMatches: 0, noteReclassified: 0 };
  try {
    _stepGlossaryTerms = getAllTermsForContext()
      .map(function(t) { return (t.term || '').toLowerCase().trim(); })
      .filter(function(t) { return t.length >= 3; });
  } catch(e) {
    _stepGlossaryTerms = [];
  }

  // ── Intel-a: Junk filter stage ────────────────────────────────
  var junkStage   = { id: 'junk_filter', label: 'Junk filter', removed: 0, graved: 0, kept: 0, active: INTEL_FLAGS.junkFilter };
  var cleanLines  = [];
  text.split(/\n/).forEach(function(line) {
    var t = line.trim();
    if (!t) return;
    if (INTEL_FLAGS.junkFilter) {
      var junk = scoreJunk(t);
      if (junk) {
        if (junk.tier === 'hard') {
          junkStage.removed++;
          return; // silent drop
        } else {
          // medium / soft → graveyard
          pipe.graveyard.push({ text: t, reason: junk.reason, rule: junk.rule, confidence: junk.confidence, tier: junk.tier });
          junkStage.graved++;
          return; // excluded from further processing
        }
      }
    }
    junkStage.kept++;
    cleanLines.push(t);
  });
  pipe.stages.push(junkStage);

  // ── Intel-b & -c stage counters ───────────────────────────────
  var factStage  = { id: 'fact_score',  label: 'Fact scoring',    reclassified: 0, kept: 0, active: INTEL_FLAGS.factScoring };
  var labelStage = { id: 'smart_label', label: 'Smart label split', changed: 0,    kept: 0, active: INTEL_FLAGS.smartLabel  };

  cleanLines.forEach(function(t) {
    var sentences = t.split(/(?<=[.!?])\s+/);
    sentences.forEach(function(sentence) {
      var s = sentence.trim();
      if (!s || s.length < 4) return;

      var type = classifyLine(s) || 'note';

      // ── Intel-b: Fact scoring ──────────────────────────────────
      var factResult = null;
      var factReclassified = false;
      if (INTEL_FLAGS.factScoring && type !== 'heading' && type !== 'note') {
        factResult = scoreFactStatement(s);
        if (factResult.score >= FACT_SCORE_THRESHOLD) {
          type = 'note';
          factReclassified = true;
          factStage.reclassified++;
        } else {
          factStage.kept++;
        }
      }

      // When we hit a heading/subprocess, check if it names an actor
      if (type === 'heading' || type === 'subprocess' || type === 'process') {
        var headActor = detectActorInHeading(s);
        if (headActor) {
          sectionActor = headActor;
          lastActor    = headActor;
        } else if (type === 'heading') {
          sectionActor = null;
        }
      }

      // Determine actor for actionable items
      var actor = null;
      if (type === 'step' || type === 'subprocess' || type === 'process' || type === 'outcome' || type === 'decision') {
        var explicit = detectActorPrefix(s);
        actor = explicit
             || sectionActor
             || detectActorByKeywords(s)
             || lastActor
             || defaultActor;
        if (explicit || sectionActor) lastActor = actor;
      }

      // ── Intel-c: Smart label splitting ────────────────────────
      var label;
      if (INTEL_FLAGS.smartLabel && type !== 'heading' && type !== 'note') {
        var split = smartSplitLabel(s);
        // Only use split if it produced a shorter label than the baseline
        var baseline = proposeLabel(type, s);
        if (split.label && split.label.length < baseline.length) {
          label = split.label.charAt(0).toUpperCase() + split.label.slice(1);
          labelStage.changed++;
        } else {
          label = baseline;
          labelStage.kept++;
        }
      } else {
        label = proposeLabel(type, s);
        if (INTEL_FLAGS.smartLabel) labelStage.kept++;
      }

      // Confidence annotation on the item itself (for UI pill display)
      var itemConf = 1.0;
      var itemConfSig = null;
      if (factResult && !factReclassified) {
        // Low fact-score on a non-note → confident it IS a process item
        itemConf = Math.max(0.60, 1.0 - factResult.score);
      }
      if (factReclassified) {
        // Reclassified to note — confidence = fact score
        itemConf = factResult.score;
        itemConfSig = factResult.signals;
      }

      results.push({
        type:      type,
        text:      s,
        label:     label,
        actor:     actor,
        srcText:   s,
        // v3.1.0 traceability fields
        confidence:      Math.round(itemConf * 100) / 100,
        factScore:       factResult ? Math.round(factResult.score * 100) / 100 : null,
        factSignals:     factReclassified ? itemConfSig : null,
        factReclassified: factReclassified,
      });
    });
  });

  pipe.stages.push(factStage);
  pipe.stages.push(labelStage);

  // ── Intel-d: Pre-parse deduplication ──────────────────────────
  var dedupStage = { id: 'preparse_dedup', label: 'Pre-parse dedup', removed: 0, kept: 0, active: INTEL_FLAGS.preParseDedup };
  if (INTEL_FLAGS.preParseDedup) {
    var dedupResult = dedupPreParsed(results);
    results = dedupResult.deduped;
    dedupStage.removed = dedupResult.mergedCount;
    dedupStage.kept    = results.length;
  } else {
    dedupStage.kept = results.length;
  }
  pipe.stages.push(dedupStage);

  // v3.4.1: merge classify-gate stats into pipe.stats
  pipe.stats = pipe.stats || {};
  pipe.stats.stepVerbMatches    = _classifyStats.stepVerbMatches;
  pipe.stats.stepGlossaryMatches = _classifyStats.stepGlossaryMatches;
  pipe.stats.noteReclassified   = _classifyStats.noteReclassified;

  return results;
}

function estimateNodeCount(preparsed) {
  if (!preparsed || !preparsed.length) return 10;
  var countable = preparsed.filter(function(p) {
    return p.type === 'step' || p.type === 'decision' || p.type === 'outcome' ||
           p.type === 'process' || p.type === 'subprocess';
    // status items excluded — they don't become nodes
  }).length;
  return Math.min(30, Math.max(5, Math.ceil(countable * 0.65)));
}

// Build structured context string for AI prompt.
// Excludes STATUS (UI state labels, not nodes) and NOTE items.
// NOTE items are either genuine background context or lines reclassified by
// the fact-scorer (v3.1.0) — neither should be sent to Claude as procedure steps.
// ── v3.8.0: TOC pre-pass ─────────────────────────────────────────
// Deterministic (no LLM). Detects table-of-contents / heading structure
// from raw text. Returns a TocResult used by runExtraction() and stored
// on pipe.extraction.toc.
/**
 * Detect a Table of Contents structure in raw document text.
 * Returns a TocResult with `detected`, `entries`, `doc_type_hint`, `cluster_hint`.
 * Runs deterministically — no API call.
 * @param {string} rawText - Raw document text
 * @returns {{detected:boolean, entries:Array, doc_type_hint:string, cluster_hint:string}}
 */
function detectTOC(rawText) {
  var EMPTY = { detected: false, entries: [], cluster_hint: null, doc_type_hint: null };
  if (!rawText || typeof rawText !== 'string') return EMPTY;

  var lines = rawText.split(/\n/);
  var entries = [];

  // Priority 1: numbered headings  e.g. "1.2 Processing a Withdrawal" or "Chapter 3 Bonuses"
  var RE_NUMBERED  = /^(\d+)\.(\d*)\s{1,4}([A-Z][^\n]{2,60})$/;
  var RE_CHAPTER   = /^Chapter\s+(\d+)[:\s]\s*(.+)$/i;
  // Priority 2: ALL CAPS headings on their own line (min 4 chars, max 80)
  var RE_ALLCAPS   = /^[A-Z][A-Z\s\-\/]{3,79}$/;
  // Priority 3: TOC-style lines ending with page number  "Section title  12"
  var RE_PAGENUM   = /^(.{4,60})\s{2,}(\d{1,4})$/;
  // Priority 4: lines that were **bold** wrapped (common in docx extraction)
  var RE_BOLD      = /^\*\*(.{3,60})\*\*$/;

  lines.forEach(function(line, idx) {
    var t = line.trim();
    if (!t || t.length < 4 || t.length > 120) return;

    var m;

    // P1a: "1.2 Title"
    m = RE_NUMBERED.exec(t);
    if (m) {
      var major = parseInt(m[1], 10);
      var minor = m[2] ? parseInt(m[2], 10) : 0;
      var level = minor > 0 ? 2 : 1;
      entries.push({ level: level, label: m[1] + (m[2] ? '.' + m[2] : ''), title: m[3].trim(), lineIndex: idx });
      return;
    }

    // P1b: "Chapter N Title"
    m = RE_CHAPTER.exec(t);
    if (m) {
      entries.push({ level: 1, label: 'Chapter ' + m[1], title: m[2].trim(), lineIndex: idx });
      return;
    }

    // P2: ALL CAPS heading (skip if it looks like an acronym or short code)
    if (RE_ALLCAPS.test(t) && t.replace(/\s/g,'').length > 4 && !/^\d/.test(t)) {
      entries.push({ level: 1, label: '', title: t, lineIndex: idx });
      return;
    }

    // P3: "Title   12" (page-number TOC line)
    m = RE_PAGENUM.exec(t);
    if (m && /^\d+$/.test(m[2].trim())) {
      var pageNum = parseInt(m[2].trim(), 10);
      if (pageNum >= 1 && pageNum <= 999) {
        entries.push({ level: 1, label: 'p.' + pageNum, title: m[1].trim(), lineIndex: idx });
        return;
      }
    }

    // P4: **bold wrapped**
    m = RE_BOLD.exec(t);
    if (m) {
      entries.push({ level: 1, label: '', title: m[1].trim(), lineIndex: idx });
    }
  });

  // Deduplicate entries that are too close together (within 2 lines) — page-num false positives
  var deduped = [];
  entries.forEach(function(e) {
    var last = deduped[deduped.length - 1];
    if (last && Math.abs(e.lineIndex - last.lineIndex) < 2 && e.title === last.title) return;
    deduped.push(e);
  });
  entries = deduped;

  var detected = entries.length >= 2;

  // ── doc_type_hint ─────────────────────────────────────────────
  var docTypeHint = null;
  if (detected) {
    var hasLevels = entries.some(function(e){ return e.level > 1; });
    var PROCEDURAL_VERBS = ['process','handle','complete','verify','submit','approve','review','escalate','resolve','issue','request','manage','perform','check','confirm','assess','validate','generate','update'];
    var titlesLower = entries.map(function(e){ return e.title.toLowerCase(); }).join(' ');
    var hasProcVerb = PROCEDURAL_VERBS.some(function(v){ return titlesLower.indexOf(v) !== -1; });

    if (entries.length > 5 && hasLevels) {
      docTypeHint = 'multi-process';
    } else if (hasProcVerb) {
      docTypeHint = 'procedural';
    } else {
      docTypeHint = 'reference';
    }
  }

  // ── cluster_hint ──────────────────────────────────────────────
  var CLUSTER_KEYWORDS = {
    'Payments':     ['payment','withdraw','deposit','cashout','cash out','transfer','refund','payout'],
    'Bonuses':      ['bonus','promotion','free spin','freespin','reward','loyalty','wagering','wager'],
    'Verification': ['kyc','verify','verification','identity','document','id check','proof'],
    'Sports':       ['sport','betting','bet','odds','fixture','market','cashout','in-play'],
    'Accounts':     ['account','registration','sign up','login','password','profile'],
    'Responsible':  ['responsible gaming','self-exclusion','limit','cooling off','problem gambling'],
    'Technical':    ['technical','error','bug','system','platform','incident'],
  };
  var clusterHint = null;
  if (detected && entries.length > 0) {
    var topTitles = entries.slice(0, 6).map(function(e){ return e.title.toLowerCase(); }).join(' ');
    Object.keys(CLUSTER_KEYWORDS).forEach(function(cluster) {
      if (clusterHint) return;
      var hits = CLUSTER_KEYWORDS[cluster].filter(function(kw){ return topTitles.indexOf(kw) !== -1; });
      if (hits.length >= 1) clusterHint = cluster;
    });
  }

  return {
    detected:      detected,
    entries:       entries,
    cluster_hint:  clusterHint,
    doc_type_hint: docTypeHint,
  };
}

function buildStructuredContext(preparsed, toc) {
  if (!preparsed || !preparsed.length) return '';

  // Decision-signal words: lines containing these get a [DECISION_SIGNAL] prefix
  // so Pass 1 can identify branching conditions even when the pre-parser tagged them as steps
  var DECISION_SIGNAL_WORDS = [
    'if ', 'unless ', 'provided ', 'subject to', 'where applicable', 'in the event',
    'approved', 'declined', 'rejected', 'escalated', 'referred', 'flagged',
    'above ', 'below ', 'exceeds', 'threshold', 'limit', 'maximum', 'minimum',
    'verified', 'unverified', 'failed', 'passed', 'eligible', 'ineligible',
    'once ', 'upon ', 'after confirmation', 'pending', 'active', 'expired',
    'refer to', 'escalate to', 'contact', 'hand off', 'transfer to',
  ];

  // Build a Set of known TOC section titles for boundary annotation
  var tocTitleSet = {};
  if (toc && toc.detected && toc.entries) {
    toc.entries.forEach(function(e) {
      if (e.title) tocTitleSet[e.title.toLowerCase().trim()] = e.level;
    });
  }

  return preparsed
    .filter(function(p) { return p.type !== 'status' && p.type !== 'note'; })
    .map(function(p) {
      var line = '[' + p.type.toUpperCase() + ']';
      if (p.actor) line += '[actor:' + p.actor + ']';
      var rawLine = line + ' ' + p.text;

      // Prepend [DECISION_SIGNAL] if the text contains any signal word
      var lower = p.text.toLowerCase();
      var hasSignal = DECISION_SIGNAL_WORDS.some(function(w) { return lower.indexOf(w) !== -1; });

      // Prepend [SECTION_BOUNDARY] if this line matches a known TOC title
      var isBoundary = tocTitleSet.hasOwnProperty(p.text.toLowerCase().trim());

      var prefix = '';
      if (isBoundary) prefix += '[SECTION_BOUNDARY]';
      if (hasSignal)  prefix += '[DECISION_SIGNAL]';

      return prefix + rawLine;
    }).join('\n');
}

function renderPreParsePane() {
  try {
  var empty   = document.getElementById('preparse-empty');
  var content = document.getElementById('preparse-content');
  var list    = document.getElementById('preparse-list');
  var meta    = document.getElementById('preparse-meta');
  var btn     = document.getElementById('btn-copy-preparse');

  if (!pipe.preparsed || !pipe.preparsed.length) return;

  empty.style.display   = 'none';
  content.style.display = 'flex';
  btn.style.display     = '';
  var csvBtn   = document.getElementById('btn-export-preparse-csv');
  var printBtn = document.getElementById('btn-export-preparse-print');
  if (csvBtn)   csvBtn.style.display   = '';
  if (printBtn) printBtn.style.display = '';

  var counts = {};
  pipe.preparsed.forEach(function(p) { counts[p.type] = (counts[p.type] || 0) + 1; });
  var summary = Object.keys(counts).map(function(k) {
    return counts[k] + ' ' + k + (counts[k] > 1 ? 's' : '');
  }).join(' · ');
  meta.textContent = pipe.preparsed.length + ' elements · ' + summary + ' — click type badge or actor to edit';

  var actorNames = pipe.actors.map(function(a) { return a.name; });

  list.innerHTML = pipe.preparsed.map(function(p, i) {
    var tagLabel = p.type === 'status' ? 'STAT' : p.type.substring(0,4).toUpperCase();

    // v3.1.0: confidence pill
    var confPill = '';
    if (p.confidence !== undefined && p.confidence !== null) {
      var pct = Math.round(p.confidence * 100);
      var tier = pct >= 80 ? 'hi' : pct >= 60 ? 'mid' : 'lo';
      var title = p.factReclassified
        ? ('Reclassified by fact-scorer (score ' + pct + '%) — signals: ' + (p.factSignals || []).join(', '))
        : ('Classification confidence ' + pct + '%');
      confPill = '<span class="pp-conf-pill ' + tier + '" title="' + escHtml(title) + '">' + pct + '%</span>';
    }

    var typeBtn  = '<span class="pp-tag ' + p.type + '" style="cursor:pointer;" title="Click to change type" onclick="ppCycleType(' + i + ')">' + tagLabel + '</span>';
    var actorBtn = '<span class="pp-actor-badge" style="cursor:pointer;' + (p.actor ? '' : 'opacity:0.4;') + '" title="Click to change actor" onclick="ppCycleActor(' + i + ')">' +
      (p.actor ? escHtml(p.actor) : '+ actor') + '</span>';
    var delBtn   = '<button class="btn-xs danger" style="font-size:9px;padding:1px 4px;margin-left:4px;" onclick="ppDeleteItem(' + i + ')" title="Remove this item">✕</button>';

    // Reclassified-by-fact indicator
    var reclassNote = p.factReclassified
      ? '<div style="font-size:9px;color:#d97706;margin-top:2px;">⊙ reclassified by fact-scorer · signals: ' + escHtml((p.factSignals||[]).join(', ')) + '</div>'
      : '';

    return '<div class="pp-row" id="pp-row-' + i + '" draggable="true" ' +
      'ondragstart="ppDragStart(event,' + i + ')" ondragover="ppDragOver(event,' + i + ')" ' +
      'ondrop="ppDrop(event,' + i + ')" ondragleave="ppDragLeave(event,' + i + ')" ' +
      'style="cursor:grab;">' +
      typeBtn + confPill +
      '<div style="flex:1;min-width:0;">' +
        '<div class="pp-text">' + escHtml(p.text) + actorBtn + delBtn + '</div>' +
        '<div class="pp-label">→ ' + escHtml(p.label) + '</div>' +
        reclassNote +
      '</div>' +
    '</div>';
  }).join('');

  // v3.1.0: render graveyard and diff panels
  renderGraveyardSection();
  renderPipeDiffSection();
  } catch(err) {
    console.error('[renderPreParsePane]', err);
  }
}

// ── v3.1.0: Graveyard section ─────────────────────────────────────

function renderGraveyardSection() {
  var section = document.getElementById('graveyard-section');
  var countEl = document.getElementById('graveyard-counts');
  var metaEl  = document.getElementById('graveyard-meta');
  var listEl  = document.getElementById('graveyard-list');
  if (!section) return;

  var gy = pipe.graveyard || [];
  if (!INTEL_FLAGS.junkFilter || gy.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  var hardCount   = gy.filter(function(g) { return g.tier === 'hard'; }).length;
  var mediumCount = gy.filter(function(g) { return g.tier === 'medium'; }).length;
  var softCount   = gy.filter(function(g) { return g.tier === 'soft'; }).length;
  countEl.textContent = gy.length + ' filtered · ' + softCount + ' uncertain (rescuable)';

  metaEl.textContent = 'Items removed by junk filter before AI processing. ' +
    (softCount > 0 ? 'Uncertain items (' + softCount + ') can be rescued back into the pipeline.' : '');

  listEl.innerHTML = gy.map(function(g, i) {
    var pct      = Math.round(g.confidence * 100);
    var tierLabel = g.tier === 'hard' ? 'HIGH' : g.tier === 'medium' ? 'MED' : 'LOW';
    var rescueBtn = (g.tier === 'soft')
      ? '<button class="gy-rescue-btn" onclick="rescueFromGraveyard(' + i + ')" title="Add back to pre-parse list">↩ Rescue</button>'
      : '';
    return '<div class="gy-row">' +
      '<div>' +
        '<span class="gy-conf-badge ' + g.tier + '" title="Junk confidence ' + pct + '%">' + tierLabel + ' ' + pct + '%</span>' +
      '</div>' +
      '<div style="flex:1;min-width:0;">' +
        '<div class="gy-text">' + escHtml(g.text) + '</div>' +
        '<div class="gy-reason">' + escHtml(g.reason) + '</div>' +
      '</div>' +
      rescueBtn +
    '</div>';
  }).join('');
}

function toggleGraveyard() {
  var toggle = document.getElementById('graveyard-toggle');
  var body   = document.getElementById('graveyard-body');
  if (!toggle || !body) return;
  var isOpen = body.classList.contains('open');
  toggle.classList.toggle('open', !isOpen);
  body.classList.toggle('open', !isOpen);
}

function rescueFromGraveyard(idx) {
  var g = pipe.graveyard[idx];
  if (!g) return;
  // Re-classify the rescued text and push it into pipe.preparsed
  var type  = classifyLine(g.text) || 'note';
  var label = proposeLabel(type, g.text);
  pipe.preparsed.push({ type: type, text: g.text, label: label, actor: null, srcText: g.text, confidence: 1.0 - g.confidence, factScore: null, factSignals: null, factReclassified: false });
  pipe.graveyard.splice(idx, 1);
  renderPreParsePane();
  showToast('Rescued: "' + g.text.substring(0, 50) + '…" → tagged as ' + type.toUpperCase());
}

// ── v3.1.0: Pipeline Diff section ────────────────────────────────

function renderPipeDiffSection() {
  var section  = document.getElementById('pipe-diff-section');
  var summary  = document.getElementById('pipe-diff-summary');
  var rowsEl   = document.getElementById('pipe-diff-rows');
  if (!section) return;

  var stages = pipe.stages || [];
  var anyActivity = stages.some(function(s) {
    return s.removed > 0 || s.graved > 0 || s.reclassified > 0 || s.changed > 0;
  });

  if (!anyActivity && !stages.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  var totalAffected = stages.reduce(function(acc, s) {
    return acc + (s.removed||0) + (s.graved||0) + (s.reclassified||0);
  }, 0);
  summary.textContent = totalAffected > 0 ? totalAffected + ' items affected' : 'no changes';

  rowsEl.innerHTML = stages.map(function(s) {
    if (!s.active) {
      return '<div class="diff-stage-row">' +
        '<span class="diff-stage-name">' + escHtml(s.label) + '</span>' +
        '<span class="diff-stage-off">off (INTEL_FLAGS.' + escHtml(s.id.replace(/_([a-z])/g, function(m, c) { return c.toUpperCase(); })) + ' = false)</span>' +
      '</div>';
    }
    var parts = [];
    if (s.removed      > 0) parts.push('<span class="removed">−' + s.removed + (s.id === 'preparse_dedup' ? ' merged (duplicates)' : ' dropped') + '</span>');
    if (s.graved       > 0) parts.push('<span class="graved">⇣' + s.graved + ' to graveyard</span>');
    if (s.reclassified > 0) parts.push('<span class="graved">↻' + s.reclassified + ' reclassified→NOTE</span>');
    if (s.changed      > 0) parts.push('<span class="kept">✎' + s.changed + ' labels improved</span>');
    if (s.kept         > 0) parts.push('<span class="kept">✓' + s.kept + ' kept</span>');
    return '<div class="diff-stage-row">' +
      '<span class="diff-stage-name">' + escHtml(s.label) + '</span>' +
      '<span class="diff-stage-stat">' + parts.join(' &nbsp;·&nbsp; ') + '</span>' +
    '</div>';
  }).join('');
}

function togglePipeDiff() {
  var toggle = document.getElementById('pipe-diff-toggle');
  var body   = document.getElementById('pipe-diff-body');
  if (!toggle || !body) return;
  var isOpen = body.classList.contains('open');
  toggle.classList.toggle('open', !isOpen);
  body.classList.toggle('open', !isOpen);
}

// ── v3.1.0: Intel Flags panel in Logic tab ───────────────────────

function renderIntelFlagsPanel() {
  var grid = document.getElementById('intel-flag-grid');
  if (!grid) return;
  grid.innerHTML = Object.keys(INTEL_FLAGS).map(function(key) {
    var meta    = INTEL_FLAG_META[key] || {};
    var checked = INTEL_FLAGS[key] ? 'checked' : '';
    return '<div class="intel-flag-row">' +
      '<label class="intel-toggle" title="Toggle ' + escHtml(key) + '">' +
        '<input type="checkbox" ' + checked + ' onchange="toggleIntelFlag(\'' + key + '\', this.checked)">' +
        '<div class="intel-toggle-track"></div>' +
        '<div class="intel-toggle-thumb"></div>' +
      '</label>' +
      '<div class="intel-flag-info">' +
        '<div class="intel-flag-name">' + escHtml(meta.label || key) + '</div>' +
        '<div class="intel-flag-desc">' + escHtml(meta.desc || '') + '</div>' +
        '<div class="intel-flag-commit">commit: ' + escHtml(meta.commit || '') + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function toggleIntelFlag(key, value) {
  INTEL_FLAGS[key] = !!value;
  saveIntelFlags();
  // Update thinking indicator whenever a flag changes
  updateThinkingIndicator();
  // Re-run pre-parse if a document is loaded (for pre-parse layer flags)
  if (pipe.clean && key !== 'extendedThinking') {
    pipe.preparsed = preParse(pipe.clean);
    renderPreParsePane();
    var nodeEst = estimateNodeCount(pipe.preparsed);
    showToast('INTEL_FLAGS.' + key + ' = ' + INTEL_FLAGS[key] + ' — pre-parse refreshed (' + pipe.preparsed.length + ' items, ~' + nodeEst + ' nodes)');
  } else if (key === 'extendedThinking') {
    showToast('🧠 extendedThinking = ' + INTEL_FLAGS[key] + (INTEL_FLAGS[key] ? ' — active on Pass 1 + Pass 2 with Sonnet' : ' — disabled'));
  }
}

function updateThinkingIndicator(label) {
  var indicator = document.getElementById('thinking-indicator');
  if (!indicator) return;
  var modelEl = document.getElementById('model-select');
  var active = INTEL_FLAGS.extendedThinking && modelEl && modelEl.value.includes('sonnet');
  indicator.style.display = active ? '' : 'none';
  if (active) indicator.textContent = '🧠 ' + (label || 'thinking');
}

// ── Interactive pre-parse controls (v2.7.0) ───────────────────────
var PP_TYPES = ['step','decision','subprocess','process','cluster','policy','outcome','condition','heading','status','note'];
var ppDragIdx = null;

function ppCycleType(idx) {
  var p = pipe.preparsed[idx];
  if (!p) return;
  var cur = PP_TYPES.indexOf(p.type);
  p.type  = PP_TYPES[(cur + 1) % PP_TYPES.length];
  p.label = proposeLabel(p.type, p.text);
  renderPreParsePane();
}

function ppCycleActor(idx) {
  var p = pipe.preparsed[idx];
  if (!p) return;
  var actorNames = [''].concat(pipe.actors.map(function(a) { return a.name; }));
  var cur = actorNames.indexOf(p.actor || '');
  p.actor = actorNames[(cur + 1) % actorNames.length] || null;
  renderPreParsePane();
}

function ppDeleteItem(idx) {
  pipe.preparsed.splice(idx, 1);
  renderPreParsePane();
}

function ppDragStart(e, idx) {
  ppDragIdx = idx;
  e.dataTransfer.effectAllowed = 'move';
}

function ppDragOver(e, idx) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  var row = document.getElementById('pp-row-' + idx);
  if (row) row.style.borderColor = 'var(--blue-400)';
}

function ppDragLeave(e, idx) {
  var row = document.getElementById('pp-row-' + idx);
  if (row) row.style.borderColor = '';
}

function ppDrop(e, idx) {
  e.preventDefault();
  ppDragLeave(e, idx);
  if (ppDragIdx === null || ppDragIdx === idx) return;
  var items = pipe.preparsed;
  var moved = items.splice(ppDragIdx, 1)[0];
  items.splice(idx, 0, moved);
  ppDragIdx = null;
  renderPreParsePane();
}

// ── Pre-Parse Export (v3.1.0) ─────────────────────────────────────

// CSV export — open in Excel / Google Sheets for offline analysis
function exportPreParseCsv() {
  if (!pipe.preparsed || !pipe.preparsed.length) {
    showToast('Run pipeline first'); return;
  }
  var docTitle = document.getElementById('fname') ? (document.getElementById('fname').textContent || 'document') : 'document';
  var rows = [
    ['#', 'Type', 'Actor', 'Proposed Label', 'Original Text'],
  ];
  pipe.preparsed.forEach(function(p, i) {
    rows.push([
      i + 1,
      p.type,
      p.actor || '',
      p.label || '',
      p.text  || '',
    ]);
  });
  var csv = rows.map(function(row) {
    return row.map(function(cell) {
      var s = String(cell).replace(/"/g, '""');
      return /[,"\n\r]/.test(s) ? '"' + s + '"' : s;
    }).join(',');
  }).join('\r\n');

  var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM for Excel
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'preparse-' + docTitle.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '-' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
  showToast('Exported ' + pipe.preparsed.length + ' items as CSV');
}

// Printable HTML — opens in a new tab, ready to print / annotate offline
function exportPreParsePrint() {
  if (!pipe.preparsed || !pipe.preparsed.length) {
    showToast('Run pipeline first'); return;
  }
  var docTitle = document.getElementById('fname') ? (document.getElementById('fname').textContent || 'Document') : 'Document';
  var dateStr  = new Date().toLocaleDateString('en-GB', { year:'numeric', month:'long', day:'numeric' });

  // Type-colour map for the print sheet
  var TYPE_COLORS = {
    heading:   { bg:'#1e3a5f', text:'#fff' },
    process:   { bg:'#0369a1', text:'#fff' },
    subprocess:{ bg:'#0284c7', text:'#fff' },
    step:      { bg:'#1e40af', text:'#fff' },
    decision:  { bg:'#92400e', text:'#fff' },
    condition: { bg:'#5b21b6', text:'#fff' },
    outcome:   { bg:'#065f46', text:'#fff' },
    policy:    { bg:'#7e22ce', text:'#fff' },
    status:    { bg:'#0369a1', text:'#fff' },
    cluster:   { bg:'#c2410c', text:'#fff' },
    actor:     { bg:'#0f766e', text:'#fff' },
    note:      { bg:'#6b7280', text:'#fff' },
  };

  var rows = pipe.preparsed.map(function(p, i) {
    var c = TYPE_COLORS[p.type] || { bg:'#6b7280', text:'#fff' };
    var tagLabel = p.type === 'status' ? 'STAT' : p.type.substring(0,4).toUpperCase();
    return '<tr>' +
      '<td style="color:#6b7280;font-size:11px;padding:6px 8px;text-align:right;white-space:nowrap;">' + (i+1) + '</td>' +
      '<td style="padding:4px 6px;"><span style="display:inline-block;background:' + c.bg + ';color:' + c.text + ';font-size:10px;font-weight:700;padding:2px 7px;border-radius:3px;white-space:nowrap;">' + escHtml(tagLabel) + '</span></td>' +
      '<td style="padding:4px 6px;font-size:11px;color:#0369a1;font-weight:600;white-space:nowrap;">' + escHtml(p.actor || '—') + '</td>' +
      '<td style="padding:4px 8px;font-size:11px;color:#1e3a5f;font-weight:600;">' + escHtml(p.label || '') + '</td>' +
      '<td style="padding:4px 8px;font-size:12px;color:#374151;">' + escHtml(p.text || '') + '</td>' +
      '<td style="padding:4px 8px;min-width:160px;border-left:1px dashed #d1d5db;"><span style="font-size:10px;color:#9ca3af;">Notes / correction:</span><div style="margin-top:16px;border-bottom:1px solid #e5e7eb;"></div></td>' +
    '</tr>';
  }).join('');

  // Count by type
  var counts = {};
  pipe.preparsed.forEach(function(p){ counts[p.type] = (counts[p.type]||0)+1; });
  var summary = Object.keys(counts).sort().map(function(k){ return counts[k] + ' × ' + k; }).join(' &nbsp;·&nbsp; ');

  var html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<title>Pre-Parse Review — ' + escHtml(docTitle) + '</title>' +
    '<style>' +
    'body { font-family: Inter, system-ui, sans-serif; margin: 0; padding: 24px 32px; color: #111827; font-size: 13px; }' +
    'h1 { font-size: 18px; margin: 0 0 4px; } .sub { font-size: 12px; color: #6b7280; margin-bottom: 18px; }' +
    'table { width: 100%; border-collapse: collapse; } thead th { background: #f3f4f6; padding: 7px 8px; text-align: left; font-size: 11px; font-weight: 700; color: #374151; border-bottom: 2px solid #d1d5db; }' +
    'tr:nth-child(even) td { background: #f9fafb; }' +
    'tr:hover td { background: #eff6ff; }' +
    'td { vertical-align: top; border-bottom: 1px solid #e5e7eb; }' +
    '@media print { body { padding: 8px 12px; } thead th { font-size: 9px; } td { font-size: 10px; } }' +
    '.legend { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; }' +
    '.legend span { font-size:10px; font-weight:700; padding:2px 8px; border-radius:3px; }' +
    '</style></head><body>' +
    '<h1>Pre-Parse Review Sheet</h1>' +
    '<div class="sub">Document: <strong>' + escHtml(docTitle) + '</strong> &nbsp;·&nbsp; ' + dateStr + ' &nbsp;·&nbsp; ' + pipe.preparsed.length + ' items &nbsp;·&nbsp; Flowinject ' + APP_VERSION + '</div>' +
    '<div class="sub">' + summary + '</div>' +
    '<div class="legend">' +
    Object.keys(TYPE_COLORS).map(function(t){ var c=TYPE_COLORS[t]; return '<span style="background:'+c.bg+';color:'+c.text+';">' + t.substring(0,4).toUpperCase() + ' ' + t + '</span>'; }).join('') +
    '</div>' +
    '<table><thead><tr>' +
    '<th style="width:32px;">#</th><th style="width:56px;">Type</th><th style="width:80px;">Actor</th><th style="width:160px;">Proposed Label</th><th>Original Text</th><th style="width:200px;">Notes / Correction</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div style="margin-top:20px;font-size:11px;color:#9ca3af;">Generated by Flowinject — print this sheet and compare against your original document. Mark corrections then apply interactively in the Pre-Parse pane.</div>' +
    '</body></html>';

  var win = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
    showToast('Printable review sheet opened in new tab');
  } else {
    showToast('Pop-up blocked — allow pop-ups for this site');
  }
}
function validateMermaidCode(code) {
  var warnings = [];
  if (!code || code.trim().startsWith('sequenceDiagram')) return warnings;

  var lines = code.split('\n');
  var defined  = {};  // id -> label
  var hasSrc   = {};  // ids that appear as arrow sources
  var hasDst   = {};  // ids that appear as arrow targets

  // Collect node definitions
  var defRe = /\b([A-Za-z_][A-Za-z0-9_-]*)\s*(?:\[([^\]]*)\]|\{([^}]*)\}|\(\[([^\]]*)\]\)|\(([^)]*)\))/g;
  var arrRe = /([A-Za-z_][A-Za-z0-9_-]*)\s*--?>+(?:\|[^|]*\|)?\s*([A-Za-z_][A-Za-z0-9_-]*)/g;
  var m;

  lines.forEach(function(line) {
    var t = line.trim();
    if (t.startsWith('classDef') || t.startsWith('class ') || t.startsWith('%%') ||
        t.startsWith('subgraph') || t === 'end') return;

    defRe.lastIndex = 0;
    while ((m = defRe.exec(line)) !== null) {
      var id    = m[1];
      var label = (m[2] || m[3] || m[4] || m[5] || '').trim();
      if (label && !defined[id]) defined[id] = label;
    }

    arrRe.lastIndex = 0;
    while ((m = arrRe.exec(line)) !== null) {
      hasSrc[m[1]] = true;
      hasDst[m[2]] = true;
    }
  });

  // Dead-end nodes: defined, has no outgoing arrow, not a terminal (([...]))
  var termRe2 = /\b([A-Za-z_][A-Za-z0-9_-]*)\s*\(\[/g;
  var terminals = {};
  lines.forEach(function(line) {
    termRe2.lastIndex = 0;
    while ((m = termRe2.exec(line)) !== null) terminals[m[1]] = true;
  });

  Object.keys(defined).forEach(function(id) {
    if (!terminals[id] && defined[id] && !hasSrc[id] && hasDst[id]) {
      warnings.push({ level: 'warn', msg: 'Dead end: "' + defined[id] + '" has no outgoing path — add an arrow or connect to an End terminal' });
    }
  });

  // Duplicate labels (>70% word overlap)
  var ids = Object.keys(defined);
  for (var i = 0; i < ids.length; i++) {
    if (!defined[ids[i]]) continue;
    for (var j = i + 1; j < ids.length; j++) {
      if (!defined[ids[j]]) continue;
      var a = defined[ids[i]].toLowerCase().split(/\s+/);
      var b = defined[ids[j]].toLowerCase().split(/\s+/);
      var shared = a.filter(function(w) { return b.indexOf(w) !== -1 && w.length > 3; });
      var overlap = shared.length / Math.max(a.length, b.length);
      if (overlap >= 0.7 && a.length > 1) {
        warnings.push({ level: 'warn', msg: 'Similar nodes: "' + defined[ids[i]] + '" and "' + defined[ids[j]] + '" — consider merging' });
        break;
      }
    }
  }

  return warnings;
}


// ── Stage 4: Analyse ──────────────────────────────────────────────

// Domain presets: each group has a canonical display name and a list of
// synonym words that all mean the same actor in that domain.
// Detection picks the MOST FREQUENT synonym in the text, collapses the group
// to a single actor, and uses the canonical name as the label.
var DOMAIN_PRESETS = {
  igaming: {
    label: 'iGaming CS',
    // Lane order matters: Player first (customer journey), then Agent, then back-office
    groups: [
      { name: 'Player',     synonyms: ['player','customer','client','user','punter'] },
      { name: 'Agent',      synonyms: ['agent','support','advisor','operator','staff','representative','rep'] },
      { name: 'System',     synonyms: ['system','platform','bot','automated','kyc','backend'] },
      { name: 'Finance',    synonyms: ['finance','payment','cashier','treasury','fraud','risk'] },
      { name: 'Manager',    synonyms: ['manager','supervisor','team lead','lead','vip','compliance'] },
    ],
  },
  generic: {
    label: 'Generic Business',
    groups: [
      { name: 'Customer',   synonyms: ['customer','client','user','end user','consumer'] },
      { name: 'Employee',   synonyms: ['employee','staff','agent','advisor','representative','rep','operator'] },
      { name: 'System',     synonyms: ['system','platform','application','tool','software','bot','automated'] },
      { name: 'Manager',    synonyms: ['manager','supervisor','director','lead','approver'] },
      { name: 'Finance',    synonyms: ['finance','accounting','accounts','payment','treasury'] },
    ],
  },
  banking: {
    label: 'Banking / Finance',
    groups: [
      { name: 'Customer',   synonyms: ['customer','client','account holder','applicant','user'] },
      { name: 'Advisor',    synonyms: ['advisor','banker','agent','officer','representative','staff'] },
      { name: 'System',     synonyms: ['system','core banking','platform','automated','bot'] },
      { name: 'Compliance', synonyms: ['compliance','aml','kyc','risk','fraud','audit'] },
      { name: 'Manager',    synonyms: ['manager','supervisor','approver','authoriser','director'] },
    ],
  },
  healthcare: {
    label: 'Healthcare',
    groups: [
      { name: 'Patient',    synonyms: ['patient','client','service user','individual','user'] },
      { name: 'Clinician',  synonyms: ['clinician','doctor','physician','nurse','practitioner','gp','consultant'] },
      { name: 'Admin',      synonyms: ['admin','receptionist','coordinator','staff','administrator'] },
      { name: 'System',     synonyms: ['system','ehr','emr','platform','automated','portal'] },
      { name: 'Manager',    synonyms: ['manager','supervisor','director','lead'] },
    ],
  },
  ecommerce: {
    label: 'E-commerce',
    groups: [
      { name: 'Customer',   synonyms: ['customer','shopper','buyer','user','consumer'] },
      { name: 'Support',    synonyms: ['support','agent','advisor','staff','representative','rep'] },
      { name: 'System',     synonyms: ['system','platform','website','store','automated','bot'] },
      { name: 'Warehouse',  synonyms: ['warehouse','fulfilment','fulfillment','logistics','shipping','courier'] },
      { name: 'Manager',    synonyms: ['manager','supervisor','lead','approver'] },
    ],
  },
};

var PROCESS_WORDS = [
  'verify','submit','approve','reject','review','check','confirm','notify',
  'escalate','document','process','validate','send','receive','update','log',
  'create','close','open','request','respond','contact','investigate','resolve',
  'authenticate','authorise','authorize','flag','monitor','record','complete',
];

function getCurrentDomain() {
  var sel = document.getElementById('domain-preset');
  return sel ? sel.value : 'igaming';
}

function onDomainChange() {
  // If pipeline has already run, re-run the analysis stage only
  if (pipe.clean) {
    runAnalysis(pipe.clean);
    renderAnalysisPane();
    showToast('Actor groups updated for ' + DOMAIN_PRESETS[getCurrentDomain()].label);
  }
}

// Count how many times a word appears in text (case-insensitive, whole word)
function countOccurrences(text, word) {
  var re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 's?\\b', 'gi');
  var matches = text.match(re);
  return matches ? matches.length : 0;
}

function runAnalysis(text) {
  var domain = getCurrentDomain();
  var preset = DOMAIN_PRESETS[domain] || DOMAIN_PRESETS['igaming'];

  // For each group, sum occurrences of all synonyms.
  // Only include the group if at least one synonym appears.
  // Pick the most-frequent synonym as a "dominant term" note (for transparency).
  var detectedActors = [];
  preset.groups.forEach(function(group) {
    var totalCount = 0;
    var bestSynonym = '';
    var bestCount   = 0;

    group.synonyms.forEach(function(syn) {
      var n = countOccurrences(text, syn);
      totalCount += n;
      if (n > bestCount) { bestCount = n; bestSynonym = syn; }
    });

    if (totalCount > 0) {
      detectedActors.push({
        name:       group.name,
        dominant:   bestSynonym,   // most-used synonym in this doc
        count:      totalCount,    // total synonym hits
        color:      null,          // assigned below
        selected:   detectedActors.length < 4,
      });
    }
  });

  // Assign colours in order of detection
  detectedActors.forEach(function(a, i) {
    a.color = ACTOR_COLORS[i % ACTOR_COLORS.length];
  });

  pipe.actors = detectedActors;

  // Keywords
  var lower = text.toLowerCase();
  pipe.keywords = PROCESS_WORDS.filter(function(k) { return lower.indexOf(k) !== -1; });

  // Stats
  var words      = text.split(/\s+/).filter(Boolean).length;
  var sentences  = (text.match(/[.!?]+/g) || []).length;
  var paragraphs = text.split(/\n\n+/).filter(function(s) { return s.trim(); }).length;
  // Preserve pre-parse classify-gate counters (set by preParse, which runs before runAnalysis)
  pipe.stats = Object.assign(pipe.stats || {}, { words: words, sentences: sentences, paragraphs: paragraphs });
}

function renderAnalysisPane() {
  try {
  document.getElementById('analysis-empty').style.display   = 'none';
  document.getElementById('analysis-content').style.display = 'block';
  document.getElementById('analysis-meta').textContent      = pipe.stats.words.toLocaleString() + ' words';

  // Actor pills
  var pillsEl = document.getElementById('actor-pills');
  if (pipe.actors.length === 0) {
    pillsEl.innerHTML = '<span style="font-size:11px;color:var(--gray-400);">No roles detected for this domain — try a different Domain preset or add actors manually</span>';
  } else {
    pillsEl.innerHTML = pipe.actors.map(function(a, i) {
      var bg     = a.selected ? a.color.bg    : 'var(--white)';
      var color  = a.selected ? a.color.text  : 'var(--gray-500)';
      var border = a.color.border;
      var tip    = 'Detected as "' + a.dominant + '" (' + a.count + ' mentions)';
      return '<span class="actor-pill' + (a.selected ? ' selected' : '') + '"' +
        ' id="ap-' + i + '"' +
        ' title="' + escHtml(tip) + '"' +
        ' style="background:' + bg + ';border-color:' + border + ';color:' + color + ';"' +
        ' onclick="toggleActor(' + i + ')">' + escHtml(a.name) +
        '<span style="font-size:9px;opacity:0.6;margin-left:4px;">(' + a.count + ')</span>' +
        '</span>';
    }).join('');
  }

  // Keywords
  var kwEl = document.getElementById('keyword-list');
  kwEl.innerHTML = pipe.keywords.length
    ? pipe.keywords.map(function(k) { return '<span class="kw-tag">' + escHtml(k) + '</span>'; }).join('')
    : '<span style="font-size:11px;color:var(--gray-400);">No process keywords detected</span>';

  // Stats
  document.getElementById('doc-stats').innerHTML =
    '<span class="stat-item"><span class="stat-num">' + pipe.stats.words.toLocaleString() + '</span> words</span>' +
    '<span class="stat-item"><span class="stat-num">' + pipe.stats.sentences.toLocaleString() + '</span> sentences</span>' +
    '<span class="stat-item"><span class="stat-num">' + pipe.stats.paragraphs.toLocaleString() + '</span> paragraphs</span>' +
    '<span class="stat-item"><span class="stat-num">' + pipe.chunks.length + '</span> chunks</span>';

  renderSwimlanePreview();
  } catch(err) {
    console.error('[renderAnalysisPane]', err);
  }
}

function toggleActor(i) {
  var a = pipe.actors[i];
  a.selected = !a.selected;
  var pill = document.getElementById('ap-' + i);
  pill.style.background  = a.selected ? a.color.bg   : 'var(--white)';
  pill.style.color       = a.selected ? a.color.text : 'var(--gray-500)';
  pill.style.borderColor = a.color.border;
  pill.classList.toggle('selected', a.selected);
  renderSwimlanePreview();
}

function renderSwimlanePreview() {
  var selected = pipe.actors.filter(function(a) { return a.selected; });
  var el = document.getElementById('swimlane-preview');
  var dtype = document.getElementById('diagram-type').value;

  if (selected.length < 2) {
    el.textContent = selected.length === 0
      ? '(Select at least 2 actors above to preview structure)'
      : '(Select at least 2 actors to enable swim lanes / sequence)';
    return;
  }

  if (dtype === 'sequence') {
    var out = 'sequenceDiagram\n';
    selected.forEach(function(a) { out += '  participant ' + a.name + '\n'; });
    out += '  ' + selected[0].name + '->>' + selected[1].name + ': [action]\n';
    if (selected.length > 2) out += '  ' + selected[1].name + '->>' + selected[2].name + ': [action]\n';
    el.textContent = out;
  } else {
    var out2 = 'flowchart LR\n';
    selected.forEach(function(a) {
      var prefix = a.name.substring(0, 2).toUpperCase();
      out2 += '  subgraph ' + a.name + '\n    ' + prefix + '1[Step]\n  end\n';
    });
    el.textContent = out2;
  }
}

// ── Input / Drop ──────────────────────────────────────────────────
var inputEl  = document.getElementById('input-text');
var dropHint = document.getElementById('drop-hint');

inputEl.addEventListener('input', function() {
  pipe.raw = inputEl.value;
  document.getElementById('raw-meta').textContent = inputEl.value.length.toLocaleString() + ' chars';
  resetPipelineStages();
});

document.body.addEventListener('dragover',  function(e) { e.preventDefault(); dropHint.style.display = 'flex'; });
document.body.addEventListener('dragleave', function(e) { if (!e.relatedTarget) dropHint.style.display = 'none'; });
document.body.addEventListener('drop', function(e) {
  e.preventDefault(); dropHint.style.display = 'none';
  var f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleFile(f, false);
});

function resetPipelineStages() {
  ['clean','chunks','preparse','analysis'].forEach(function(s) { setPipeDot(s, ''); });
  document.getElementById('clean-viewer').style.display  = 'none';
  document.getElementById('clean-empty').style.display   = 'flex';
  document.getElementById('chunk-list').style.display    = 'none';
  document.getElementById('chunks-empty').style.display  = 'flex';
  document.getElementById('preparse-list') && (document.getElementById('preparse-list').innerHTML = '');
  document.getElementById('preparse-empty').style.display  = 'flex';
  document.getElementById('preparse-content').style.display = 'none';
  document.getElementById('analysis-empty').style.display   = 'flex';
  document.getElementById('analysis-content').style.display = 'none';
  document.getElementById('clean-meta').textContent    = '—';
  document.getElementById('chunks-meta').textContent   = '—';
  document.getElementById('preparse-meta').textContent = '—';
  document.getElementById('analysis-meta').textContent = '—';
  document.getElementById('btn-copy-clean').style.display    = 'none';
  document.getElementById('btn-copy-preparse').style.display = 'none';
  var csvBtn   = document.getElementById('btn-export-preparse-csv');
  var printBtn = document.getElementById('btn-export-preparse-print');
  if (csvBtn)   csvBtn.style.display   = 'none';
  if (printBtn) printBtn.style.display = 'none';
}

function clearAll() {
  var _raw = document.getElementById('input-text');
  if (_raw) _raw.value = '';
  pipe.raw = ''; pipe.clean = ''; pipe.chunks = []; pipe.preparsed = [];
  pipe.actors = []; pipe.keywords = [];
  pipe.entities = null; pipe.entityRegistry = null;
  pipe.graveyard = []; pipe.stages = [];
  pipe._tocText = null; pipe._chapterText = null; pipe._inputSources = []; pipe._isTocLoad = false;
  var tocBanner = document.getElementById('toc-banner');
  if (tocBanner) tocBanner.style.display = 'none';
  var ed = document.getElementById('entity-summary');
  if (ed) ed.style.display = 'none';
  var vb = document.getElementById('validation-bar');
  if (vb) vb.style.display = 'none';
  document.getElementById('raw-meta').textContent      = '0 chars';
  document.getElementById('filename-tag').style.display = 'none';
  showError('');
  setPipeDot('raw', '');
  resetPipelineStages();
  switchLeftTab('raw');
  updatePipelineStatus(false);
}

