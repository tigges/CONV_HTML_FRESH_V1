// ══════════════════════════════════════════════════════════════════
// Flowinject v4.0 — storage.js — State, persistence, slugify, ChapterRegistry, DocumentRegistry, GitHub sync
// Part of the modular refactor from monolithic index.html (v3.12.2)
// All functions remain global-scope for backward compatibility.
// ══════════════════════════════════════════════════════════════════

// Global error trap — catches any runtime crash before app handlers initialise.
// Remove or no-op once the page-load crash is resolved.
window.onerror = function(m, s, l, c, e) { console.error('SCRIPT ERROR:', m, 'line:' + l, e); };

// ── Version ───────────────────────────────────────────────────────
// APP_VERSION is the only version string to update on each release.
// APP_BUILD_DATE is computed dynamically at page load — always the current date.
// All badges, title and exports derive from these two constants.
var APP_VERSION    = 'v4.0.0';
var APP_BUILD_DATE = (function() {
  var d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}());

// ── Intelligence Flags (v3.1.0) ──────────────────────────────────
// Each flag gates one pre-parse intelligence layer. Stored in localStorage
// so the user's choice survives page reload. Toggle from the Logic tab.
// Setting a flag to false bypasses that layer entirely — pipeline output
// reverts to the v3.0.5 baseline for that feature.
var INTEL_FLAGS_DEFAULTS = {
  junkFilter:       true,   // JUNK_RULES pre-filter: remove/graveyard document noise
  factScoring:      true,   // Semantic fact scoring: reclassify non-procedural text to NOTE
  smartLabel:       true,   // Smart label splitting: extract label from "Label: description" patterns
  preParseDedup:    true,   // Jaccard near-duplicate merge: collapse near-identical steps
  extendedThinking: true,   // Pass 1 extended thinking (Sonnet only — better entity extraction)
};

var INTEL_FLAG_META = {
  junkFilter:  {
    label: 'junkFilter',
    desc:  'Filters metadata, author attribution, version stamps, status lines and other document noise before classification. Confident removals are dropped silently; uncertain ones go to the Graveyard for review.',
    commit: 'intel-a (v3.1.0)',
  },
  factScoring: {
    label: 'factScoring',
    desc:  'Scores each line for "fact vs. process" using definition patterns, metric cues and procedural verb presence. Lines scoring ≥ 0.6 are reclassified to NOTE and excluded from Claude context.',
    commit: 'intel-b (v3.1.0)',
  },
  smartLabel: {
    label: 'smartLabel',
    desc:  'Extracts a short label from "Label: description", "Label — description" and "Label → description" formats before stop-word stripping. Produces more accurate node label proposals.',
    commit: 'intel-c (v3.1.0)',
  },
  preParseDedup: {
    label: 'preParseDedup',
    desc:  'Merges near-duplicate pre-parse items using Jaccard token similarity on their labels. Items with ≥ 85% token overlap are collapsed into the first occurrence. Reduces step-list bloat in long documents where the same action is repeated across sections.',
    commit: 'intel-d (v3.2.0)',
  },
  extendedThinking: {
    label: 'extendedThinking',
    desc:  '🧠 Enables extended thinking on Pass 1 when Sonnet is selected. Claude reasons privately before extracting entities — improves step classification, sub-process nesting and decision identification on complex SOPs. ~5-15s extra. Haiku is unaffected.',
    commit: 'intel-e (v3.3.0)',
  },
};

// ── Graph Schema (v3.4.0) ─────────────────────────────────────────
// Pass 2 now asks Claude for a JSON graph object, not raw Mermaid.
// graphToMermaid() is the deterministic compiler that converts it.
// Node types: start | end | step | decision | subprocess | note
var GRAPH_SCHEMA_EXAMPLE = {
  nodes: [
    { id: 'A', type: 'start',    label: 'Start' },
    { id: 'B', type: 'step',     label: 'Customer submits claim', lane: 'Agent' },
    { id: 'C', type: 'decision', label: 'Valid?' },
    { id: 'D', type: 'end',      label: 'End' },
  ],
  edges: [
    { from: 'A', to: 'B' },
    { from: 'B', to: 'C' },
    { from: 'C', to: 'D', label: 'Yes' },
    { from: 'C', to: 'B', label: 'No'  },
  ],
  subgraphs: [
    { id: 's1', label: 'Verification', nodes: ['B', 'C'] },
  ],
};

// Safe label for Mermaid — strip reserved chars, truncate
// Sanitise a label for Mermaid node syntax.
// Truncates at a natural word boundary if over the limit,
// keeping labels short enough that nodes don't blow out the diagram.
// Mermaid 10.6 with htmlLabels:false has no reliable multi-line support,
// so we keep labels short rather than attempting line-break injection.
function mmdLabel(text) {
  var s = (text || 'Step')
    .replace(/"/g, "'")
    .replace(/[<>{}[\]]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  var MAX = 28; // chars — beyond this nodes expand the diagram significantly
  if (s.length <= MAX) return s;
  // Try to cut at a word boundary
  var cut = s.lastIndexOf(' ', MAX);
  if (cut > MAX * 0.6) return s.substring(0, cut) + '…';
  return s.substring(0, MAX) + '…';
}

// Deterministic JSON graph → Mermaid compiler.
// Produces valid Mermaid 10.6.1 — no repairMermaid needed on its output.
function graphToMermaid(graph, dtype) {
  if (!graph || !graph.nodes) return null;
  // Defensive: strip any null/undefined entries the LLM may have injected
  var nodes     = (graph.nodes     || []).filter(function(n){ return n && n.id; });
  var edges     = (graph.edges     || []).filter(function(e){ return e && e.from && e.to; });
  var subgraphs = (graph.subgraphs || []).filter(function(sg){ return sg && sg.id; });
  var orient    = (document.getElementById('lane-orient') || { value: 'LR' }).value;

  var isSwim = dtype === 'swimlane';
  var header = isSwim ? ('graph ' + orient) : ('flowchart ' + orient);
  var lines  = [header];

  // Node shape renderer.
  // Swimlane (graph LR/TD) subgraphs crash on circle/stadium shapes in Mermaid 10.6.
  // Use [["label"]] subroutine rects for start/end in swimlane; use (("label")) circles
  // in plain flowcharts where subgraph nesting is not involved.
  function nodeShape(n) {
    var lbl = mmdLabel(n.label);
    switch ((n.type || 'step').toLowerCase()) {
      case 'start':
        // Circle in flowchart, subroutine rect in swimlane (Mermaid 10.6 subgraph crash fix)
        return isSwim
          ? n.id + '[["' + lbl + '"]]'
          : n.id + '(("' + lbl + '"))';
      case 'end':
        return isSwim
          ? n.id + '[["' + lbl + '"]]'
          : n.id + '(("' + lbl + '"))';
      case 'decision':
        return n.id + '{"' + lbl + '"}';
      case 'subprocess':
        return n.id + '[["' + lbl + '"]]';   // subroutine rect
      case 'note':
        return n.id + '["' + lbl + '"]';     // rect — note class added below
      default: // step, outcome, condition, process
        return n.id + '["' + lbl + '"]';
    }
  }

  // Emit subgraphs; track which nodes are placed inside
  var emittedNodes = {};
  subgraphs.forEach(function(sg) {
    lines.push('  subgraph ' + sg.id + '["' + mmdLabel(sg.label) + '"]');
    (sg.nodes || []).forEach(function(nid) {
      var n = nodes.find(function(x) { return x.id === nid; });
      if (n) { lines.push('    ' + nodeShape(n)); emittedNodes[nid] = true; }
    });
    lines.push('  end');
  });

  // Emit nodes not placed in any subgraph
  nodes.forEach(function(n) {
    if (!emittedNodes[n.id]) {
      lines.push('  ' + nodeShape(n));
    }
  });

  // Emit edges — always outside subgraph blocks
  // Cross-lane handoffs are labelled automatically with the target actor name
  var nodeMap = {};
  nodes.forEach(function(n) { nodeMap[n.id] = n; });

  edges.forEach(function(e) {
    if (!e.from || !e.to) return;
    var srcActor = (nodeMap[e.from] || {}).lane || '';
    var tgtActor = (nodeMap[e.to]   || {}).lane || '';
    var handoff  = (srcActor && tgtActor && srcActor !== tgtActor)
                   ? tgtActor : '';
    var edgeLabel = e.label
      ? e.label + (handoff ? ' · ' + handoff : '')
      : handoff;
    if (edgeLabel) {
      lines.push('  ' + e.from + ' -->|' + mmdLabel(edgeLabel) + '| ' + e.to);
    } else {
      lines.push('  ' + e.from + ' --> ' + e.to);
    }
  });

  // No classDef block emitted here — injectColours() is the single colour authority.
  // It strips and re-applies classDefs on every render path.
  // Exception: note nodes need an explicit class hint since their shape (rect) is
  // identical to step nodes. We emit 'class ID note' which injectColours preserves
  // if it finds no conflicting detection.
  nodes.forEach(function(n) {
    if ((n.type || '').toLowerCase() === 'note') {
      lines.push('  class ' + n.id + ' note');
    }
  });

  return lines.join('\n');
}

// Parse a Pass 2 API response (result.clean) → Mermaid string.
// Tries JSON schema first; falls back to treating text as raw Mermaid.
function pass2ResultToMermaid(rawClean, dtype) {
  try {
    var start = rawClean.indexOf('{');
    var end   = rawClean.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('no JSON object');
    var graph = JSON.parse(rawClean.substring(start, end + 1));
    if (!graph.nodes || !Array.isArray(graph.nodes)) throw new Error('no nodes array');
    var mmd = graphToMermaid(graph, dtype);
    if (!mmd) throw new Error('compiler returned null');
    pipe.graph = graph;
    return { mmd: mmd, fromSchema: true };
  } catch (e) {
    console.warn('Pass 2 JSON parse failed (' + e.message + ') — using raw Mermaid fallback');
    pipe.graph = null;
    var clean = rawClean.replace(/```mermaid\s*/gi, '').replace(/```\s*/g, '').trim();
    return { mmd: clean, fromSchema: false };
  }
}

function loadIntelFlags() {
  try {
    var saved = JSON.parse(localStorage.getItem('fc_intel_flags_v1') || '{}');
    var flags = {};
    Object.keys(INTEL_FLAGS_DEFAULTS).forEach(function(k) {
      flags[k] = (k in saved) ? !!saved[k] : INTEL_FLAGS_DEFAULTS[k];
    });
    return flags;
  } catch(e) { return Object.assign({}, INTEL_FLAGS_DEFAULTS); }
}

function saveIntelFlags() {
  localStorage.setItem('fc_intel_flags_v1', JSON.stringify(INTEL_FLAGS));
}

var INTEL_FLAGS = loadIntelFlags();

// ── Version sync ──────────────────────────────────────────────────
// APP_VERSION + APP_BUILD_DATE are the single source of truth.
// Update both constants on every release — badges, title and exports auto-update.
// Header badge format:  "v4.0.0 · 14 Apr 2026"  (from source, always accurate)
// Hover tooltip adds:   deploy time from document.lastModified (updates on git pull)
function syncVersion() {
  document.title = 'Flowinject ' + APP_VERSION;

  // Logic tab badge — version only (compact)
  var logicBadge = document.getElementById('logic-version-badge');
  if (logicBadge) logicBadge.textContent = APP_VERSION;

  // Header badge — version + build date from source (reliable) + deploy time on hover
  var headerBadge = document.getElementById('header-version-badge');
  if (headerBadge) {
    // Format APP_BUILD_DATE (YYYY-MM-DD) → "14 Apr 2026"
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var buildLabel = '';
    try {
      var bd = new Date(APP_BUILD_DATE + 'T12:00:00');
      if (!isNaN(bd.getTime())) {
        buildLabel = ' · ' + bd.getDate() + ' ' + months[bd.getMonth()] + ' ' + bd.getFullYear();
      }
    } catch(e) {}

    // Also show deploy time inline — document.lastModified is set by the server
    // on each Cloudways git pull, so it always reflects the last deployment time.
    var deployTime = '';
    var deployShort = '';
    try {
      var d = new Date(document.lastModified);
      if (!isNaN(d.getTime())) {
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        deployShort = hh + ':' + mm;
        deployTime  = d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear() + ' ' + hh + ':' + mm;
      }
    } catch(e) {}

    // Badge text: "v3.9.0 · 15 Apr 2026 · 14:32"
    headerBadge.textContent = APP_VERSION + buildLabel + (deployShort ? ' · ' + deployShort : '');
    headerBadge.title = 'Version ' + APP_VERSION +
      (deployTime ? ' · Deployed ' + deployTime : '');
  }
}
syncVersion(); // run immediately (header badge exists above this script tag)

// ── Library init ──────────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── Mermaid config factory ────────────────────────────────────────
// Single source of truth for mermaid.initialize() options.
// Called on init, layout-engine switch, cluster-bg toggle, and spacing/font changes.
// _dcSpacing and _dcFontSize are set by the controls bar density toggle.
function getMermaidConfig() {
  var engine = (document.getElementById('layout-engine') || {value:'dagre'}).value;

  // Spacing presets: normal / compact / dense
  var spacing = _dcSpacing || 'normal';
  var spacingMap = {
    normal:  { nodeSpacing: 50, rankSpacing: 60, padding: 24, fontSize: '13px' },
    compact: { nodeSpacing: 30, rankSpacing: 36, padding: 14, fontSize: '12px' },
    dense:   { nodeSpacing: 18, rankSpacing: 22, padding:  8, fontSize: '11px' },
  };
  var sp = spacingMap[spacing] || spacingMap.normal;

  var cfg = {
    startOnLoad: false,
    theme: 'default',
    themeVariables: {
      primaryColor:        '#dbeafe',
      primaryTextColor:    '#1e3a5f',
      primaryBorderColor:  '#2563eb',
      secondaryColor:      '#fef9c3',
      secondaryTextColor:  '#713f12',
      secondaryBorderColor:'#ca8a04',
      tertiaryColor:       '#dcfce7',
      tertiaryTextColor:   '#14532d',
      tertiaryBorderColor: '#16a34a',
      lineColor:           '#4b5563',
      edgeLabelBackground: '#f9fafb',
      background:          '#ffffff',
      mainBkg:             '#dbeafe',
      nodeBorder:          '#2563eb',
      clusterBkg:          _dcClusterOn ? '#f0f9ff' : 'transparent',
      clusterBorder:       _dcClusterOn ? '#bfdbfe' : 'transparent',
      titleColor:          '#1e40af',
      fontFamily:          'Inter, system-ui, sans-serif',
      fontSize:            sp.fontSize,
    },
    flowchart: {
      curve:           _dcCurve || 'basis',
      padding:         sp.padding,
      nodeSpacing:     sp.nodeSpacing,
      rankSpacing:     sp.rankSpacing,
      htmlLabels:      false,
      useMaxWidth:     false,   // let diagram use full panel width
      defaultRenderer: engine === 'elk' ? 'elk' : 'dagre',
    },
    sequence: { actorMargin:50, messageMargin:35, mirrorActors:false },
  };
  return cfg;
}

mermaid.initialize(getMermaidConfig());

// ── Layout engine switching (v2.9.0) ─────────────────────────────
// ELK is loaded via CDN (elkjs). When selected, Mermaid is re-initialised
// with defaultRenderer:'elk' inside flowchart config.
function onLayoutEngineChange() {
  var engine = (document.getElementById('layout-engine') || {value:'dagre'}).value;
  try { mermaid.initialize(getMermaidConfig()); } catch(e) { console.warn('Layout switch:', e.message); }
  showToast(engine === 'elk' ? 'ELK layout active — re-render to apply' : 'Dagre layout active — re-render to apply');
  // Re-render current diagram with new layout if one exists
  var code = document.getElementById('mermaid-editor').value.trim();
  if (code) renderFromEditor();
}

// ── App State ─────────────────────────────────────────────────────
let renderTimer = null;
let lastSVG = '';
let currentRightTab = 'code';
let currentLeftTab  = 'raw';
let zoomLevel = 1;
var STORAGE_KEY = 'fc_saved_v1';

// ══════════════════════════════════════════════════════════════════
// ── STORAGE & NAMING LAYER  (spec v3.9+, April 2026)             ──
// ══════════════════════════════════════════════════════════════════

// ── Step 1: slugify() ─────────────────────────────────────────────
// Spec §2: lowercase, strip punctuation except hyphens, collapse
// spaces/underscores to hyphens, trim leading/trailing hyphens.
/**
 * Derive a URL-safe slug from a human-readable string.
 * @param {string} text - Input string
 * @returns {string} Slug (lowercase, hyphen-separated)
 */
function slugify(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/&/g, 'and')          // ampersand → 'and' before stripping
    .replace(/[^a-z0-9\s-]/g, '') // strip all punctuation except hyphens
    .replace(/[\s_]+/g, '-')       // spaces/underscores → hyphens
    .replace(/-+/g, '-')           // collapse consecutive hyphens
    .replace(/^-+|-+$/g, '');      // trim leading/trailing hyphens
}

// Chapter slug: chapter number only, dots → hyphens (spec §2.2)
function chapterSlug(chapterNumber) {
  if (!chapterNumber) return '';
  return String(chapterNumber).replace(/\./g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

// Full process slug: {chapter-slug}-{slugify(processName)} (spec §2.3)
function processSlug(chapterNum, processName) {
  var cs = chapterSlug(chapterNum);
  var ps = slugify(processName);
  return cs && ps ? cs + '-' + ps : ps || cs || 'untitled';
}

// Collision guard: if slug exists in existingSlugs array, append -2, -3 …
function dedupeSlug(slug, existingSlugs) {
  if (!existingSlugs || existingSlugs.indexOf(slug) === -1) return slug;
  var n = 2;
  while (existingSlugs.indexOf(slug + '-' + n) !== -1) n++;
  return slug + '-' + n;
}

// ── Step 1 unit tests (run at load time, non-fatal) ───────────────
(function _slugifyTests() {
  function assert(cond, msg) { if (!cond) console.error('slugify test FAIL:', msg); }
  assert(slugify('SF Agent Manual')         === 'sf-agent-manual',       'basic');
  assert(slugify('Casino Support Docs v2')  === 'casino-support-docs-v2','version number');
  assert(slugify('Betway UK Procedures')    === 'betway-uk-procedures',  'UK abbreviation');
  assert(slugify('Bonus Hunters & Abusers') === 'bonus-hunters-and-abusers', 'ampersand');
  assert(slugify('6.7 — Bonus Hunters')     === '67--bonus-hunters'.replace('--','-'), 'chapter with em-dash');
  assert(slugify('')                         === '',                       'empty string');
  assert(chapterSlug('4.2')                 === '4-2',                   'chapter slug 4.2');
  assert(chapterSlug('1.0')                 === '1-0',                   'chapter slug 1.0');
  assert(chapterSlug('9.1')                 === '9-1',                   'chapter slug 9.1');
  assert(processSlug('4.2','Processing a Withdrawal') === '4-2-processing-a-withdrawal', 'full process slug');
  assert(dedupeSlug('4-2-withdrawal', [])                               === '4-2-withdrawal',   'no collision');
  assert(dedupeSlug('4-2-withdrawal', ['4-2-withdrawal'])               === '4-2-withdrawal-2', 'collision -2');
  assert(dedupeSlug('4-2-withdrawal', ['4-2-withdrawal','4-2-withdrawal-2']) === '4-2-withdrawal-3', 'collision -3');
  console.log('slugify: all unit tests passed');
}());

// ── Step 2: ChapterRegistry ───────────────────────────────────────
// Parses TOC pre-pass output into a queryable chapter/cluster map.
// Spec §7: wired to detectTOC() result; populates automatically on TOC load.
var ChapterRegistry = (function() {
  // Default cluster map for iGaming CS (used as fallback when TOC has no groupings)
  var DEFAULT_CLUSTER_MAP = {
    '1': { code: '1x', label: 'Platform Foundations & Account Management' },
    '2': { code: '2x', label: 'Player Issues & Disputes' },
    '3': { code: '3x', label: 'Payments — Deposits' },
    '4': { code: '4x', label: 'Payments — Withdrawals & Cashier' },
    '5': { code: '5x', label: 'Verification & Fraud' },
    '6': { code: '6x', label: 'Bonuses & Promotions' },
    '7': { code: '7x', label: 'Sports Betting' },
    '8': { code: '8x', label: 'Account Lifecycle' },
    '9': { code: '9x', label: 'Responsible Gambling & Safeguarding' },
  };

  // CLUSTER_MAP is rebuilt from TOC content when available; otherwise uses defaults
  var CLUSTER_MAP = Object.assign({}, DEFAULT_CLUSTER_MAP);

  // Build CLUSTER_MAP dynamically from TOC entries.
  // Groups chapters by their numeric prefix (1.x → cluster "1").
  // If TOC has level-0 group headings (e.g. "1 — Payments") those become cluster labels.
  // Otherwise uses the first chapter title under each numeric group.
  function _buildClusterMapFromToc(entries) {
    var dynamic = {};
    // Pass 1: collect any level-1 entries with no minor (i.e. "1 Title" not "1.2 Title")
    // and single-integer labels — these are cluster-level headings
    entries.forEach(function(e) {
      if (e.level !== 1) return;
      var lbl = String(e.label || '').trim();
      var isWhole = /^\d+$/.test(lbl);
      if (isWhole && e.title) {
        dynamic[lbl] = { code: lbl + 'x', label: e.title };
      }
    });
    // Pass 2: for every numeric prefix that has chapters but no explicit cluster heading,
    // synthesise a cluster from the first chapter title in that group
    entries.forEach(function(e) {
      if (!e.label) return;
      var prefix = String(e.label).split('.')[0];
      if (/^\d+$/.test(prefix) && !dynamic[prefix] && e.title) {
        dynamic[prefix] = { code: prefix + 'x', label: e.title.replace(/^\d+[\.\s]+/, '').trim() || e.title };
      }
    });
    return Object.keys(dynamic).length >= 2 ? dynamic : null;
  }

  var _entries = [];  // [{ chapterNum, chapterTitle, chapterSlug, cluster, clusterLabel }]
  var _current = null; // currently active chapter (set on document load)

  function _clusterFor(chapterNum) {
    var prefix = String(chapterNum || '').split('.')[0];
    return CLUSTER_MAP[prefix] || { code: prefix ? prefix + 'x' : 'gen', label: prefix ? 'Group ' + prefix : 'General' };
  }

  function load(tocResult) {
    _entries = [];
    if (!tocResult || !tocResult.detected || !tocResult.entries) return;
    // v3.12.1: rebuild CLUSTER_MAP dynamically from TOC content
    var dynamicMap = _buildClusterMapFromToc(tocResult.entries);
    if (dynamicMap) {
      CLUSTER_MAP = dynamicMap;
      console.log('ChapterRegistry: built dynamic cluster map from TOC (' + Object.keys(CLUSTER_MAP).length + ' clusters)');
    } else {
      CLUSTER_MAP = Object.assign({}, DEFAULT_CLUSTER_MAP);
      console.log('ChapterRegistry: using default iGaming cluster map');
    }
    tocResult.entries
      .filter(function(e) { return e.level === 1 && e.label; })
      .forEach(function(e) {
        var num = e.label.replace(/^Chapter\s*/i, '').trim();
        var cl  = _clusterFor(num);
        _entries.push({
          chapterNum:   num,
          chapterTitle: e.title || '',
          chapterSlug:  chapterSlug(num),
          cluster:      cl.code,
          clusterLabel: cl.label,
        });
      });
    console.log('ChapterRegistry: loaded ' + _entries.length + ' chapters');
  }

  function setCurrentChapter(chapterNum) {
    _current = _entries.find(function(e) { return e.chapterNum === String(chapterNum); }) || null;
  }

  // Infer active chapter from filename or first TOC entry that matches
  function inferFromFilename(filename) {
    if (!filename) return;
    // Match leading number like "4_2_" or "4.2 " or "ch04_02"
    var m = filename.match(/^(?:ch(?:apter)?[_\s-]*)?(\d+)[._-](\d+)/i);
    if (m) {
      var num = m[1] + '.' + m[2];
      setCurrentChapter(num);
      if (_current) console.log('ChapterRegistry: inferred chapter', num, 'from filename');
    }
  }

  function getCurrent() { return _current; }
  function getAll() { return _entries.slice(); }
  function getBySlug(slug) { return _entries.find(function(e){ return e.chapterSlug === slug; }) || null; }

  function toProjectJson(projectSlug, projectTitle) {
    var clusterCounts = {};
    _entries.forEach(function(e) {
      clusterCounts[e.cluster] = (clusterCounts[e.cluster] || 0) + 1;
    });
    var clusters = Object.keys(CLUSTER_MAP).map(function(k) {
      var cl = CLUSTER_MAP[k];
      return { code: cl.code, label: cl.label, docCount: clusterCounts[cl.code] || 0 };
    }).filter(function(c){ return c.docCount > 0; });

    return {
      slug:           projectSlug,
      title:          projectTitle,
      createdAt:      new Date().toISOString(),
      updatedAt:      new Date().toISOString(),
      tocLoadedAt:    new Date().toISOString(),
      totalDocuments: _entries.length,
      clusters:       clusters,
      processSlugs:   [],
    };
  }

  function getClusterMap() { return CLUSTER_MAP; }

  return { load: load, getCurrent: getCurrent, getAll: getAll, getBySlug: getBySlug,
           inferFromFilename: inferFromFilename, setCurrentChapter: setCurrentChapter,
           toProjectJson: toProjectJson, getClusterMap: getClusterMap };
}());

// ── Step 3: ProcessMetadata JS factory (mirrors Pydantic model) ───
// Spec §4 — all required fields validated; passQualityScore 0.0–1.0.
function makeProcessMetadata(opts) {
  // Required field guard
  var required = ['slug','title','type','chapter','chapterTitle','cluster','clusterLabel','project','nodeCount','sourceDocPath','generatedBy'];
  required.forEach(function(f) {
    if (opts[f] === undefined || opts[f] === null || opts[f] === '')
      throw new Error('ProcessMetadata: missing required field "' + f + '"');
  });

  // type enum
  if (['process','subprocess','reference'].indexOf(opts.type) === -1)
    throw new Error('ProcessMetadata: invalid type "' + opts.type + '"');

  // subprocess requires parentSlug
  if (opts.type === 'subprocess' && !opts.parentSlug)
    throw new Error('ProcessMetadata: subprocess requires parentSlug');

  // passQualityScore range
  var pqs = opts.passQualityScore !== undefined ? opts.passQualityScore : null;
  if (pqs !== null && (typeof pqs !== 'number' || pqs < 0 || pqs > 1))
    throw new Error('ProcessMetadata: passQualityScore must be 0.0–1.0 or null');

  return {
    slug:             opts.slug,
    title:            opts.title,
    type:             opts.type,
    chapter:          opts.chapter,
    chapterTitle:     opts.chapterTitle,
    cluster:          opts.cluster,
    clusterLabel:     opts.clusterLabel,
    project:          opts.project,
    parentSlug:       opts.parentSlug || null,
    subprocessSlugs:  opts.subprocessSlugs || [],
    crossRefs:        opts.crossRefs || [],
    tags:             opts.tags || [],
    nodeCount:        opts.nodeCount,
    passQualityScore: pqs,
    sourceDocPath:    opts.sourceDocPath,
    generatedAt:      opts.generatedAt || new Date().toISOString(),
    generatedBy:      opts.generatedBy,
    version:          opts.version || 1,
    notes:            opts.notes || null,
  };
}

// ── v3.11.0: Node annotations (spec §A.6) ────────────────────────
// Builds a nodeAnnotations map from pipe.graph nodes + pipe.extraction.entities.
// Called by buildMetadataFromPipe() so every saved sidecar gets annotations.
// Population rules:
//   note/warning/waitCondition  — sourced from entity provenance or step notes
//   glossaryTerms               — deterministic match of node label against glossary
//   ref                         — section heading from TOC entries matching provenance
function _buildNodeAnnotations(graph, extraction) {
  if (!graph || !graph.nodes || !graph.nodes.length) return {};
  var annotations = {};
  var entities = (extraction && extraction.entities) ? extraction.entities : [];
  var toc = (extraction && extraction.toc) ? extraction.toc : {};
  var tocEntries = toc.entries || [];

  // Build a quick lookup: entity label → entity
  var entityByLabel = {};
  entities.forEach(function(e) {
    var key = (e.label || '').toLowerCase().trim();
    if (key) entityByLabel[key] = e;
  });

  // Glossary terms for matching
  var glossaryTerms = [];
  try { glossaryTerms = getGlossary(); } catch(e) {}

  graph.nodes.forEach(function(node) {
    var lbl = (node.label || '').toLowerCase().trim();
    var entity = entityByLabel[lbl];

    // note: from provenance sentence
    var note = null;
    var warning = null;
    var waitCondition = null;
    var ref = null;

    if (entity) {
      var prov = entity.provenance;
      if (prov && prov.sentence) {
        var sent = prov.sentence;
        // Heuristic: sentences with "wait", "await", "pending" become waitCondition
        if (/\b(wait|await|pending|hold|until|before proceeding)\b/i.test(sent)) {
          waitCondition = sent;
        }
        // Sentences with escalation/warning signals → warning
        else if (/\b(escalate|supervisor|manager|compliance|breach|violation|alert)\b/i.test(sent)) {
          warning = sent;
        }
        // Everything else → note
        else if (sent && sent.length > 20) {
          note = sent;
        }
      }
    }

    // ref: match provenance chunk against TOC section headings
    if (entity && entity.provenance && entity.provenance.chunk_index !== undefined) {
      var chunkIdx = entity.provenance.chunk_index;
      // Find TOC entry whose lineIndex is closest to chunk position
      if (tocEntries.length) {
        var bestEntry = null;
        tocEntries.forEach(function(te) {
          if (te.lineIndex <= chunkIdx * 30) bestEntry = te; // rough heuristic
        });
        if (bestEntry) ref = bestEntry.label || bestEntry.title || null;
      }
    }

    // glossaryTerms: match label + note text against glossary
    var matchedTerms = [];
    var searchText = ((node.label || '') + ' ' + (note || '') + ' ' + (warning || '')).toLowerCase();
    glossaryTerms.forEach(function(gt) {
      var term = (gt.term || '').toLowerCase();
      if (term.length >= 2 && searchText.indexOf(term) !== -1) {
        matchedTerms.push(gt.term);
      }
    });

    // Only add annotation if at least one field is populated
    if (note || warning || waitCondition || ref || matchedTerms.length) {
      annotations[node.id] = {
        note:          note,
        ref:           ref,
        warning:       warning,
        glossaryTerms: matchedTerms.length ? matchedTerms : null,
        waitCondition: waitCondition,
      };
    }
  });

  return annotations;
}

// ── v3.11.0: DocumentRegistry ─────────────────────────────────────
// Tracks all source documents for a project: status, fileHash, timestamps.
// Spec §B.5. Backed by GitHub (data/charts/{project}/registry/document_registry.json)
// and mirrored in localStorage for fast in-app access.
var DOCREGISTRY_KEY_PREFIX = 'fc_docregistry_';

var DocumentRegistry = (function() {
  var _registry = null; // { projectSlug, updatedAt, documents[] }
  var _projSlug = null;

  function _storageKey(pSlug) { return DOCREGISTRY_KEY_PREFIX + (pSlug || 'general'); }

  function load(projSlug) {
    _projSlug = projSlug || 'general';
    try {
      var raw = localStorage.getItem(_storageKey(_projSlug));
      _registry = raw ? JSON.parse(raw) : _emptyRegistry(_projSlug);
    } catch(e) {
      _registry = _emptyRegistry(_projSlug);
    }
    return _registry;
  }

  function _emptyRegistry(pSlug) {
    return { projectSlug: pSlug, updatedAt: new Date().toISOString(), documents: [] };
  }

  function _save() {
    if (!_registry) return;
    _registry.updatedAt = new Date().toISOString();
    try { localStorage.setItem(_storageKey(_projSlug), JSON.stringify(_registry)); } catch(e) {}
  }

  function getOrCreate() {
    if (!_registry) load((currentProject && currentProject.slug) || 'general');
    return _registry;
  }

  // Wire TOC load: adds all chapter entries as pending documents
  function loadFromToc(toc, projSlug) {
    load(projSlug || (currentProject && currentProject.slug) || 'general');
    if (!toc || !toc.detected || !toc.entries) return;
    var level1 = toc.entries.filter(function(e){ return e.level === 1; });
    level1.forEach(function(entry) {
      var chNum   = entry.label || '0';
      var chTitle = entry.title || entry.label || '';
      var docId   = chapterSlug(chNum);
      var exists  = _registry.documents.find(function(d){ return d.docId === docId; });
      if (!exists) {
        _registry.documents.push({
          docId:           docId,
          chapterNumber:   chNum,
          chapterTitle:    chTitle,
          cluster:         (chNum.match(/^(\d+)/) || ['',''])[1] + 'x',
          sourceFilename:  null,
          sourceFilePath:  null,
          fileHash:        null,
          fileSizeBytes:   null,
          status:          'pending',
          processSlugs:    [],
          pass1CachedAt:   null,
          pass2CachedAt:   null,
          diagramSavedAt:  null,
          errorLog:        [],
        });
      }
    });
    _save();
  }

  // Update a document entry by docId (creates if not found)
  function update(docId, fields) {
    if (!_registry) getOrCreate();
    var doc = _registry.documents.find(function(d){ return d.docId === docId; });
    if (!doc) {
      doc = { docId: docId, chapterNumber: docId, chapterTitle: '', cluster: '', sourceFilename: null,
        sourceFilePath: null, fileHash: null, fileSizeBytes: null, status: 'pending',
        processSlugs: [], pass1CachedAt: null, pass2CachedAt: null, diagramSavedAt: null, errorLog: [] };
      _registry.documents.push(doc);
    }
    Object.assign(doc, fields);
    _save();
  }

  // Mark a pass complete
  function markPassComplete(docId, pass, errorMsg) {
    if (!_registry) getOrCreate();
    var now = new Date().toISOString();
    if (errorMsg) {
      update(docId, { status: 'error' });
      var doc = _registry.documents.find(function(d){ return d.docId === docId; });
      if (doc) doc.errorLog.push({ pass: pass, error: errorMsg, at: now });
      _save();
      return;
    }
    var fields = {};
    if (pass === 1) { fields.pass1CachedAt = now; fields.status = 'pass1_complete'; }
    if (pass === 2) { fields.pass2CachedAt = now; fields.status = 'pass2_complete'; }
    update(docId, fields);
  }

  // Mark diagram saved
  function markDiagramSaved(docId, processSlugVal) {
    if (!_registry) getOrCreate();
    var doc = _registry.documents.find(function(d){ return d.docId === docId; });
    if (!doc) return;
    doc.diagramSavedAt = new Date().toISOString();
    doc.status = 'complete';
    if (processSlugVal && doc.processSlugs.indexOf(processSlugVal) === -1) doc.processSlugs.push(processSlugVal);
    _save();
  }

  // Export full registry as JSON string
  function toJson() {
    return JSON.stringify(_registry || _emptyRegistry(_projSlug), null, 2);
  }

  // Push registry to GitHub
  async function pushToGitHub() {
    if (!ghPAT() || !currentProject) return;
    var projSlug = currentProject.slug;
    var path = 'data/charts/' + projSlug + '/registry/document_registry.json';
    try {
      var existing = await ghRead(path);
      await ghWrite(path, toJson(), 'Registry: update ' + projSlug, existing ? existing.sha : undefined);
    } catch(e) { console.warn('DocumentRegistry push failed:', e.message); }
  }

  return { load, loadFromToc, update, markPassComplete, markDiagramSaved, getOrCreate, toJson, pushToGitHub };
})();

// ── v3.11.0: SHA-256 file hash (Web Crypto API) ────────────────────
// Returns a hex string. No external dependency — uses built-in SubtleCrypto.
async function computeFileHash(arrayBuffer) {
  try {
    var hashBuf = await crypto.subtle.digest('SHA-256', arrayBuffer);
    var arr = Array.from(new Uint8Array(hashBuf));
    return arr.map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
  } catch(e) {
    return null;
  }
}

// Auto-tag builder (spec §5)
function buildAutoTags(clusterLabel, type, passEntities) {
  var STOP = new Set(['and','the','for','with','via','per','of','a','to','in','by','as','on','at','an','is','or','not','from']);
  var tags = [];
  // Cluster label words
  (clusterLabel || '').toLowerCase().split(/[\s&—\-\/,]+/).forEach(function(w) {
    w = w.trim().replace(/[^a-z0-9]/g,'');
    if (w.length >= 3 && !STOP.has(w)) tags.push(w);
  });
  // Pass 1 key entities (actor names, important labels)
  (passEntities || []).slice(0, 15).forEach(function(e) {
    var t = (e.label || '').toLowerCase().replace(/[^a-z0-9]/g,'');
    if (t.length >= 3 && !STOP.has(t)) tags.push(t);
  });
  // Type
  tags.push(type);
  // Deduplicate
  return tags.filter(function(t, i, a){ return a.indexOf(t) === i; });
}

// Build a ProcessMetadata object from the current pipe state
function buildMetadataFromPipe(slug, title, type, parentSlug) {
  var chapterEntry  = ChapterRegistry.getCurrent();
  var projectSlug   = currentProject ? currentProject.slug : 'general';
  var projectTitle  = currentProject ? currentProject.name : 'General';
  var nodeCount     = pipe.graph ? (pipe.graph.nodes || []).length : 0;
  var fname         = document.getElementById('fname') ? document.getElementById('fname').textContent : 'unknown';
  var model         = document.getElementById('model-select') ? document.getElementById('model-select').value : 'unknown';
  var entities      = (pipe.extraction && pipe.extraction.entities) ? pipe.extraction.entities : [];

  var chapter       = chapterEntry ? chapterEntry.chapterNum  : '0';
  var chapterTitle  = chapterEntry ? chapterEntry.chapterTitle : title;
  var cluster       = chapterEntry ? chapterEntry.cluster      : 'gen';
  var clusterLabel  = chapterEntry ? chapterEntry.clusterLabel : 'General';

  var tags = buildAutoTags(clusterLabel, type, entities);

  var pqs = null;
  if (pipe.extraction && pipe.extraction.coverage) {
    pqs = Math.round(pipe.extraction.coverage.ratio * 100) / 100;
  }

  // v3.11.0: build node annotations from current graph + extraction
  var nodeAnnotations = {};
  try {
    nodeAnnotations = _buildNodeAnnotations(pipe.graph, pipe.extraction);
  } catch(e) {
    console.warn('buildMetadataFromPipe: nodeAnnotations failed:', e.message);
  }

  var meta = makeProcessMetadata({
    slug:             slug,
    title:            title,
    type:             type,
    chapter:          chapter,
    chapterTitle:     chapterTitle,
    cluster:          cluster,
    clusterLabel:     clusterLabel,
    project:          projectSlug,
    parentSlug:       parentSlug || null,
    subprocessSlugs:  [],
    crossRefs:        [],
    tags:             tags,
    nodeCount:        nodeCount,
    passQualityScore: pqs,
    sourceDocPath:    'source/' + fname.replace(/\s+/g,'-'),
    generatedAt:      new Date().toISOString(),
    generatedBy:      model,
    version:          1,
    notes:            null,
  });

  // Attach nodeAnnotations to the sidecar (not part of ProcessMetadata spec, but stored alongside)
  if (Object.keys(nodeAnnotations).length) {
    meta.nodeAnnotations = nodeAnnotations;
  }

  return meta;
}

// ── Saved chart helpers (extend existing getSaved / putSaved) ─────
// Each saved chart entry now has the shape:
//   { slug, title, code, meta (ProcessMetadata), savedAt }
// The old flat { name, code, savedAt } shape is supported for back-compat.

function getSavedEntry(slug) {
  return getSaved().find(function(c){ return (c.slug || c.name) === slug; }) || null;
}

function putSavedEntry(entry) {
  var charts = getSaved();
  var idx = charts.findIndex(function(c){ return (c.slug || c.name) === (entry.slug || entry.name); });
  if (idx >= 0) {
    // Increment version on overwrite
    if (charts[idx].meta) entry.meta.version = (charts[idx].meta.version || 1) + 1;
    charts[idx] = entry;
  } else {
    charts.unshift(entry);
  }
  putSaved(charts);
}

// All existing slugs across saved charts
function allSavedSlugs() {
  return getSaved().map(function(c){ return c.slug || slugify(c.name || ''); });
}

// Update project.json processSlugs list
function _updateProjectProcessSlugs(slug) {
  if (!currentProject) return;
  var projects = getProjects();
  var proj = projects.find(function(p){ return p.slug === currentProject.slug; });
  if (!proj) return;
  proj.processSlugs = proj.processSlugs || [];
  if (proj.processSlugs.indexOf(slug) === -1) proj.processSlugs.push(slug);
  proj.updatedAt = new Date().toISOString();
  putProjects(projects);
}

// ── Step 4: enhanced save flow ────────────────────────────────────
// Replaces confirmSave() with full spec §8 implementation.
// Old confirmSave hook (lines below) still fires for back-compat.
function confirmSaveWithMeta() {
  var title = document.getElementById('chart-name-input').value.trim();
  if (!title) return;
  var code = document.getElementById('mermaid-editor').value.trim();
  if (!code) { showToast('Nothing to save — generate a chart first'); return; }

  // Resolve chapter from registry; infer from fname if not yet set
  if (!ChapterRegistry.getCurrent()) {
    var fnameEl = document.getElementById('fname');
    if (fnameEl) ChapterRegistry.inferFromFilename(fnameEl.textContent);
  }

  var chapterEntry  = ChapterRegistry.getCurrent();
  var chapterNum    = chapterEntry ? chapterEntry.chapterNum : '0';
  var processName   = (pipe.extraction && pipe.extraction.source_title) ? pipe.extraction.source_title : title;

  // Build slug + collision check
  var rawSlug   = processSlug(chapterNum, processName);
  var existing  = allSavedSlugs();
  var finalSlug = dedupeSlug(rawSlug, existing);

  // ── v3.11.2: Determine type ──────────────────────────────────────
  // Uses pipe.graph.nodes (more reliable than pipe.entities.steps):
  //   subprocess if pipe.graph has no start/end nodes AND has ≥1 subprocess node,
  //   OR if the classic step-count heuristic fires.
  // User override (checkbox in dialog) promotes to 'process'.
  var overrideEl = document.getElementById('save-type-override');
  var userForcedProcess = overrideEl && overrideEl.checked;
  var type = 'process';

  if (!userForcedProcess) {
    // Graph-based check (preferred — works after a 2-pass run)
    if (pipe.graph && pipe.graph.nodes && pipe.graph.nodes.length) {
      var gNodes       = pipe.graph.nodes;
      var hasStart     = gNodes.some(function(n){ return (n.type||'').toLowerCase() === 'start'; });
      var hasEnd       = gNodes.some(function(n){ return (n.type||'').toLowerCase() === 'end'; });
      var subprocNodes = gNodes.filter(function(n){ return (n.type||'').toLowerCase() === 'subprocess'; }).length;
      var stepNodes    = gNodes.filter(function(n){ var t=(n.type||'').toLowerCase(); return t==='step'||t==='process'; }).length;
      // A diagram with no start/end terminals that is mostly subprocess nodes is a subprocess fragment
      if (!hasStart && !hasEnd && subprocNodes > 0 && subprocNodes >= stepNodes) {
        type = 'subprocess';
      }
    }
    // Legacy fallback: pipe.entities.steps (single-pass or pre-graph)
    if (type === 'process' && pipe.entities && pipe.entities.steps) {
      var subprocCount = pipe.entities.steps.filter(function(s){
        return (s.type||'').toLowerCase() === 'subprocess';
      }).length;
      var stepCount = pipe.entities.steps.filter(function(s){ return (s.type||'').toLowerCase() === 'step'; }).length;
      if (subprocCount > 0 && subprocCount >= stepCount) type = 'subprocess';
    }
  }

  // ── v3.11.2: Resolve parentSlug ──────────────────────────────────
  // For subprocesses: read from the picker if shown, else try to infer
  // from saved process list (same chapter, type=process).
  var parentSlug = null;
  if (type === 'subprocess') {
    var pickerEl = document.getElementById('save-parent-slug-select');
    var pickedSlug = pickerEl ? pickerEl.value : '';
    if (pickedSlug) {
      parentSlug = pickedSlug;
    } else {
      // Auto-infer: find the most recently saved process in the same chapter
      var sameChapter = getSaved().filter(function(c){
        return !c.isDraft && c.meta && c.meta.type === 'process' &&
               c.meta.chapter === (chapterEntry ? chapterEntry.chapterNum : '0');
      });
      if (sameChapter.length) {
        parentSlug = sameChapter[0].slug || sameChapter[0].name;
      }
    }
    // If still no parentSlug, downgrade to process rather than throwing
    if (!parentSlug) {
      console.warn('confirmSaveWithMeta: subprocess detected but no parent found — saving as process');
      type = 'process';
    }
  }

  // Build metadata
  var meta;
  try {
    meta = buildMetadataFromPipe(finalSlug, title, type, parentSlug);
  } catch(e) {
    console.warn('ProcessMetadata build failed, saving without meta:', e.message);
    meta = null;
  }

  // Persist locally — promote any matching draft first (removes it cleanly)
  _promoteDraftIfExists(finalSlug);
  var entry = { slug: finalSlug, name: title, code: code, meta: meta, savedAt: Date.now() };
  putSavedEntry(entry);
  _updateProjectProcessSlugs(finalSlug);

  // ── v3.11.2: Back-link parent's subprocessSlugs ───────────────────
  // When saving a subprocess, add this slug to the parent's subprocessSlugs array
  // in localStorage, and queue a GitHub update for the parent sidecar.
  if (type === 'subprocess' && parentSlug) {
    _linkSubprocessToParent(finalSlug, parentSlug);
  }

  closeSaveDialog();
  showToast('✓ Saved: ' + title + ' [' + finalSlug + ']');

  // ── v3.11.2: Post-save sidecar validation ─────────────────────────
  // Fire-and-forget — logs warnings and flags the registry. Never blocks.
  Promise.resolve().then(function() {
    _validateSavedSidecar(finalSlug, meta);
  });

  // GitHub push (Step 5 path)
  if (ghPAT() && currentProject) {
    _pushProcessToGitHub(finalSlug, code, meta).then(function(){
      ghStatus('✓ Chart pushed', 'gh-ok');
    }).catch(function(e){
      console.warn('GitHub push failed:', e.message);
    });
  }
}

// ── Step 5: GitHub sync with processes/ path ──────────────────────
// New path: data/charts/{project-slug}/processes/{slug}.mmd + .json

// ── v3.11.2: Save dialog helpers ─────────────────────────────────

// Called when the save dialog opens (from openSaveDialog / the ◈ button).
// Detects whether the current pipe.graph looks like a subprocess and, if so,
// shows the parent-picker populated with all saved processes in the same chapter.
function _populateSaveDialogSubprocessPicker() {
  var row      = document.getElementById('save-subprocess-row');
  var select   = document.getElementById('save-parent-slug-select');
  var override = document.getElementById('save-type-override');
  if (!row || !select) return;

  // Reset state
  if (override) override.checked = false;
  var sel = select;
  sel.disabled = false;
  sel.style.opacity = '';

  // Determine if subprocess is likely
  var likelySubprocess = false;
  if (pipe.graph && pipe.graph.nodes && pipe.graph.nodes.length) {
    var gNodes       = pipe.graph.nodes;
    var hasStart     = gNodes.some(function(n){ return (n.type||'').toLowerCase() === 'start'; });
    var hasEnd       = gNodes.some(function(n){ return (n.type||'').toLowerCase() === 'end'; });
    var subprocNodes = gNodes.filter(function(n){ return (n.type||'').toLowerCase() === 'subprocess'; }).length;
    var stepNodes    = gNodes.filter(function(n){ var t=(n.type||'').toLowerCase(); return t==='step'||t==='process'; }).length;
    if (!hasStart && !hasEnd && subprocNodes > 0 && subprocNodes >= stepNodes) likelySubprocess = true;
  }
  if (!likelySubprocess && pipe.entities && pipe.entities.steps) {
    var spc = pipe.entities.steps.filter(function(s){ return (s.type||'').toLowerCase() === 'subprocess'; }).length;
    var sc  = pipe.entities.steps.filter(function(s){ return (s.type||'').toLowerCase() === 'step'; }).length;
    if (spc > 0 && spc >= sc) likelySubprocess = true;
  }

  if (!likelySubprocess) {
    row.style.display = 'none';
    return;
  }

  // Populate parent options: saved processes in the same chapter/cluster (non-subprocess)
  var chEntry = ChapterRegistry.getCurrent();
  var currentChapter = chEntry ? chEntry.chapterNum : null;
  var candidates = getSaved().filter(function(c){
    if (c.isDraft) return false;
    var m = c.meta || {};
    if (m.type === 'subprocess') return false;  // can't be a child of a child
    if (!currentChapter) return true;           // no chapter info: show all
    return m.chapter === currentChapter || !m.chapter;
  });

  // Rebuild option list
  sel.innerHTML = '<option value="">— none / set later —</option>';
  candidates.forEach(function(c) {
    var lbl = (c.name || c.slug || '');
    var m   = c.meta || {};
    if (m.chapter) lbl += ' (§' + m.chapter + ')';
    var opt = document.createElement('option');
    opt.value       = c.slug || slugify(c.name || '');
    opt.textContent = lbl;
    sel.appendChild(opt);
  });

  row.style.display = 'block';
}

// Checkbox: user overrides subprocess detection → grey out the picker
function _onSaveTypeOverride(checkbox) {
  var select = document.getElementById('save-parent-slug-select');
  if (!checkbox || !select) return;
  if (checkbox.checked) {
    select.value    = '';
    select.disabled = true;
    select.style.opacity = '0.4';
  } else {
    select.disabled = false;
    select.style.opacity = '';
  }
}

// Back-link: when a subprocess is saved, add its slug to the parent's subprocessSlugs
// in localStorage (and push an updated parent sidecar to GitHub if PAT is available).
function _linkSubprocessToParent(subprocSlug, parentSlugVal) {
  if (!subprocSlug || !parentSlugVal) return;
  try {
    var parentEntry = getSavedEntry(parentSlugVal);
    if (!parentEntry || !parentEntry.meta) {
      console.warn('_linkSubprocessToParent: parent not found in saved list:', parentSlugVal);
      return;
    }
    var subs = parentEntry.meta.subprocessSlugs || [];
    if (subs.indexOf(subprocSlug) === -1) {
      subs.push(subprocSlug);
      parentEntry.meta.subprocessSlugs = subs;
      parentEntry.meta.version = (parentEntry.meta.version || 1) + 1;
      putSavedEntry(parentEntry);
      console.log('_linkSubprocessToParent: added', subprocSlug, '→', parentSlugVal,
                  '(subprocessSlugs:', subs, ')');
      // Push updated parent sidecar to GitHub (fire-and-forget)
      if (ghPAT() && currentProject) {
        _pushProcessToGitHub(parentSlugVal, parentEntry.code, parentEntry.meta)
          .catch(function(e){ console.warn('parent sidecar re-push:', e.message); });
      }
    }
  } catch(e) {
    console.warn('_linkSubprocessToParent failed:', e.message);
  }
}

// ── v3.11.2: Post-save sidecar validation ─────────────────────────
// Runs after every save as a fire-and-forget Promise. Checks that
// parentSlug and subprocessSlugs are correctly populated. Logs warnings
// and flags the DocumentRegistry entry so issues are surfaced before the
// subprocess navigation view is built.
//
// Invariants:
//   [V1] type=subprocess → parentSlug must be non-null
//   [V2] type=subprocess → parentSlug must exist in saved list
//   [V3] type=process    → subprocessSlugs must be an array (may be empty)
//   [V4] meta must not be null
function _validateSavedSidecar(slug, meta) {
  var warnings = [];

  if (!meta) {
    warnings.push('[V4] meta is null — no sidecar for ' + slug);
  } else {
    if (meta.type === 'subprocess') {
      if (!meta.parentSlug) {
        warnings.push('[V1] type=subprocess but parentSlug is null on ' + slug);
      } else {
        var parentEntry = getSavedEntry(meta.parentSlug);
        if (!parentEntry) {
          warnings.push('[V2] parentSlug "' + meta.parentSlug + '" not found in saved list (slug: ' + slug + ')');
        }
      }
    }
    if (!Array.isArray(meta.subprocessSlugs)) {
      warnings.push('[V3] subprocessSlugs is not an array on ' + slug);
    }
  }

  if (warnings.length === 0) {
    console.log('Sidecar validation ✓', slug,
      meta ? '(type=' + meta.type + ', parentSlug=' + meta.parentSlug + ', subprocessSlugs=[' + (meta.subprocessSlugs||[]).join(',') + '])' : '');
    return;
  }

  warnings.forEach(function(w) { console.warn('Sidecar validation ⚠ ' + w); });

  // Flag in DocumentRegistry errorLog
  try {
    var reg = DocumentRegistry.getOrCreate();
    var doc = reg.documents.find(function(d){
      return (d.processSlugs || []).indexOf(slug) !== -1 || slug.startsWith(d.docId);
    });
    if (doc) {
      if (!Array.isArray(doc.errorLog)) doc.errorLog = [];
      warnings.forEach(function(w) {
        doc.errorLog.push({ pass: 'validation', error: w, at: new Date().toISOString() });
      });
      // [V1] and [V4] are critical — mark error so the batch runner re-queues
      var hasCritical = warnings.some(function(w){ return /\[V[14]\]/.test(w); });
      if (hasCritical && doc.status !== 'error') doc.status = 'error';
      try {
        var rkey = 'fc_docregistry_' + (currentProject ? currentProject.slug : 'general');
        reg.updatedAt = new Date().toISOString();
        localStorage.setItem(rkey, JSON.stringify(reg));
      } catch(e) { /* non-fatal */ }
    }
  } catch(e) {
    console.warn('_validateSavedSidecar: registry flag failed:', e.message);
  }

  // Surface V1 violations to the user (V2/V3 are console-only)
  if (warnings.some(function(w){ return w.indexOf('[V1]') !== -1; })) {
    showToast('⚠ Subprocess saved without parent link — open ◈ Save to fix');
  }
}

async function _pushProcessToGitHub(slug, mmdCode, meta) {
  var projSlug = currentProject.slug;
  var base     = 'data/charts/' + projSlug + '/processes/' + slug;

  // Push .mmd
  try {
    var existMmd = await ghRead(base + '.mmd');
    await ghWrite(base + '.mmd', mmdCode,
      'Save process: ' + slug + ' (v' + (meta ? meta.version : 1) + ')',
      existMmd ? existMmd.sha : undefined);
  } catch(e) { console.warn('mmd push:', e.message); }

  // Push .json sidecar
  if (meta) {
    try {
      var metaStr  = JSON.stringify(meta, null, 2);
      var existJson = await ghRead(base + '.json');
      await ghWrite(base + '.json', metaStr,
        'Sidecar: ' + slug,
        existJson ? existJson.sha : undefined);
    } catch(e) { console.warn('json sidecar push:', e.message); }
  }

  // Update project.json
  try {
    var projPath     = 'data/charts/' + projSlug + '/project.json';
    var existProjRec = await ghRead(projPath);
    var projJson;
    if (existProjRec) {
      projJson = JSON.parse(existProjRec.content);
      if (!Array.isArray(projJson.processSlugs)) projJson.processSlugs = [];
      if (projJson.processSlugs.indexOf(slug) === -1) projJson.processSlugs.push(slug);
      projJson.updatedAt = new Date().toISOString();
    } else {
      projJson = ChapterRegistry.toProjectJson(projSlug, currentProject.name);
      projJson.processSlugs = [slug];
    }
    await ghWrite(projPath, JSON.stringify(projJson, null, 2),
      'Update project.json: add ' + slug,
      existProjRec ? existProjRec.sha : undefined);
  } catch(e) { console.warn('project.json update:', e.message); }

  // v3.11.0: mark diagram saved in DocumentRegistry + push registry
  try {
    var _chE = ChapterRegistry.getCurrent();
    var _dId = _chE ? chapterSlug(_chE.chapterNum) : slug;
    DocumentRegistry.markDiagramSaved(_dId, slug);
    DocumentRegistry.pushToGitHub().catch(function(e){ console.warn('registry push:', e.message); });
  } catch(e) { /* non-fatal */ }
}

// Back-compat: keep old pushChartToGitHub for legacy saves
async function pushChartToGitHub(name, code, projectSlug) {
  // Route through new path if we have a PAT and current project
  if (ghPAT() && currentProject) {
    var chEntry = ChapterRegistry.getCurrent();
    var chNum   = chEntry ? chEntry.chapterNum : '0';
    var slug    = dedupeSlug(processSlug(chNum, name), allSavedSlugs());
    return _pushProcessToGitHub(slug, code, null);
  }
  // Old fallback path
  var slug  = (projectSlug || 'general').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  var fname = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() + '.mmd';
  var path  = 'data/charts/' + slug + '/processes/' + fname;
  try {
    var existing = await ghRead(path);
    await ghWrite(path, code, 'Save chart: ' + name, existing ? existing.sha : undefined);
  } catch(e) { console.warn('Chart GitHub push failed:', e.message); }
}

// loadChartsFromGitHub updated to read from processes/ subfolder
async function loadChartsFromGitHub(projectSlug) {
  var slug = (projectSlug || 'general').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  var path = 'data/charts/' + slug + '/processes';
  try {
    var pat = ghPAT();
    var headers = { 'Accept': 'application/vnd.github.v3+json' };
    if (pat) headers['Authorization'] = 'token ' + pat;
    var res = await fetch(GH_BASE + path + '?ref=' + GH_BRANCH, { headers: headers });
    if (!res.ok) return [];
    var files = await res.json();
    if (!Array.isArray(files)) return [];
    return files.filter(function(f){ return f.name.endsWith('.mmd'); })
                .map(function(f){ return { name: f.name.replace('.mmd',''), slug: f.name.replace('.mmd',''), path: f.path, sha: f.sha }; });
  } catch(e) { return []; }
}

// ── Step 6 state ─────────────────────────────────────────────────
var _savedGroupBy = 'cluster'; // 'cluster'|'chapter'|'type'|'tag'|'none'

// Pipeline data object — populated stage by stage
var pipe = {
  raw:       '',
  clean:     '',
  chunks:    [],
  preparsed: [],   // [{type, text, label, actor, sourceIdx, confidence}]
  actors:    [],
  keywords:  [],
  stats:     {},
  entities:  null, // v2.5.0: structured entity JSON from Pass 1
  entityRegistry: null, // v2.6.0: normalised entity map
  graph:      null, // v3.4.0: JSON graph from Pass 2 schema output
  extraction: null, // v3.6.0: ExtractionResult handoff object
  // v3.1.0: intelligence pipeline tracing
  graveyard: [],   // [{text, reason, rule, confidence:'hard'|'medium'|'soft'}]
  stages:    [],   // [{id, label, removed, graved, reclassified, changed, kept}]
  // v3.11.3: TOC/chapter context isolation
  // _tocText:     raw text of the TOC-only document (set on ↑ Load when TOC detected)
  // _chapterText: raw text of the most recently appended chapter (set on ↑ Append)
  //               Pass 1 uses _chapterText when present; falls back to clean.
  // _inputSources: [{filename, role:'toc'|'chapter', chars}] — for the context warning
  // _isTocLoad:   true when ↑ TOC button was used — forces TOC path in runPipeline()
  _tocText:      null,
  _chapterText:  null,
  _inputSources: [],
  _isTocLoad:    false,
};

// Actor colour palette
var ACTOR_COLORS = [
  { bg:'#EEEDFE', border:'#534AB7', text:'#3C3489' }, // Player  — purple
  { bg:'#E1F5EE', border:'#0F6E56', text:'#085041' }, // Agent   — teal
  { bg:'#FAECE7', border:'#993C1D', text:'#712B13' }, // System  — coral
  { bg:'#FBEAF0', border:'#993556', text:'#72243E' }, // Finance — pink
  { bg:'#F1EFE8', border:'#5F5E5A', text:'#444441' }, // Manager — slate
  { bg:'#EEEDFE', border:'#534AB7', text:'#3C3489' }, // fallback — purple
];

function getActorColor(idx) {
  return ACTOR_COLORS[idx % ACTOR_COLORS.length];
}

// ══════════════════════════════════════════════════════════════════
// ── ENTITY REGISTRY (v2.6.0) ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Build a normalised entity map from Pass-1 JSON.
// Stored on pipe.entityRegistry. Used to inject a consistent
// "known entities" block into every chunk prompt.
function buildEntityRegistry(entities) {
  if (!entities) return;
  var reg = {
    processName: entities.processName || '',
    actors: (entities.actors || []).map(function(a) { return a.trim(); }),
    processes: [],
    decisions: [],
    termMap: {},    // lower-case variant → canonical name
  };

  (entities.steps || []).forEach(function(s) {
    var canonical = s.label;
    if (s.type === 'decision')   reg.decisions.push(canonical);
    if (s.type === 'subprocess' || s.type === 'process') reg.processes.push(canonical);
    // Register common case variations
    reg.termMap[canonical.toLowerCase()] = canonical;
    reg.actors.forEach(function(a) {
      reg.termMap[a.toLowerCase()] = a;
    });
  });

  pipe.entityRegistry = reg;
}

// Returns a compact context string for injection into chunk prompts
function buildEntityRegistryContext() {
  var reg = pipe.entityRegistry;
  if (!reg) return '';
  var lines = ['ENTITY REGISTRY (use these exact names — do not invent variations):'];
  if (reg.processName)       lines.push('  Process: ' + reg.processName);
  if (reg.actors.length)     lines.push('  Actors: ' + reg.actors.join(', '));
  if (reg.processes.length)  lines.push('  Sub-processes: ' + reg.processes.join(', '));
  if (reg.decisions.length)  lines.push('  Decision points: ' + reg.decisions.join(', '));
  return lines.join('\n');
}

// ── Post-generation validation ────────────────────────────────────
// Rule-based checks run after every generation. Returns array of
// {level:'warn'|'error', msg} items. Displayed in the validation bar.
function validateGeneratedDiagram(code, dtype) {
  if (!code || !code.trim()) return;
  var issues = [];
  var lines   = code.split('\n');

  // Collect defined node IDs and arrow connections
  var definedNodes   = {};  // id → label
  var arrowSources   = {};  // id → [targets]
  var arrowTargets   = {};  // id → true
  var decisionNodes  = {};  // id → true
  var laneActors     = {};  // actor name → true (from subgraph lines)

  var nodeDefRE   = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*([\[{"(])/;
  var arrowRE     = /([A-Za-z_][A-Za-z0-9_-]*)\s*--?>?\|?[^|]*\|?\s*([A-Za-z_][A-Za-z0-9_-]*)/g;
  var arrowPipeRE = /([A-Za-z_][A-Za-z0-9_-]*)\s*-->?\|([^|]*)\|\s*([A-Za-z_][A-Za-z0-9_-]*)/g;
  var subgraphRE  = /subgraph\s+(\w+)/;

  lines.forEach(function(line) {
    var t = line.trim();
    if (!t || t.startsWith('%%') || t.startsWith('classDef') || t.startsWith('class ') ||
        t.startsWith('flowchart') || t.startsWith('graph') || t.startsWith('sequenceDiagram') ||
        t.startsWith('direction') || t === 'end') return;

    // Subgraph / lane actors
    var sgMatch = t.match(subgraphRE);
    if (sgMatch) { laneActors[sgMatch[1].toLowerCase()] = true; return; }

    // Node definitions
    var nd = t.match(nodeDefRE);
    if (nd && nd[2] !== '-' && !/-->/.test(t)) {
      var id = nd[1];
      // Extract label
      var labelMatch = t.match(/["']([^"']+)["']/) || t.match(/\[([^\]]+)\]/) || t.match(/\{([^}]+)\}/);
      definedNodes[id] = labelMatch ? labelMatch[1] : id;
      if (nd[2] === '{') decisionNodes[id] = true;
    }

    // Arrows
    var am;
    arrowRE.lastIndex = 0;
    while ((am = arrowRE.exec(t)) !== null) {
      var from = am[1], to = am[2];
      arrowSources[from] = arrowSources[from] || [];
      arrowSources[from].push(to);
      arrowTargets[to] = true;
    }
  });

  // Check 1: dead ends (nodes with no outgoing arrows, not End/terminal)
  Object.keys(definedNodes).forEach(function(id) {
    var label = (definedNodes[id] || '').toLowerCase();
    var isTerminal = /end|stop|finish|close|complet|resolv/.test(label);
    if (!isTerminal && !arrowSources[id]) {
      issues.push({ level: 'warn', msg: 'Dead end: "' + escHtml(definedNodes[id]) + '" has no outgoing path' });
    }
  });

  // Check 2: decision nodes with only one exit
  Object.keys(decisionNodes).forEach(function(id) {
    var exits = (arrowSources[id] || []).length;
    if (exits < 2) {
      issues.push({ level: 'error', msg: 'Decision "' + escHtml(definedNodes[id] || id) + '" has only ' + exits + ' exit — needs Yes and No branches' });
    }
  });

  // Check 3: declared actors not present in swimlane lanes
  if (dtype === 'swimlane' && pipe.entityRegistry) {
    pipe.entityRegistry.actors.forEach(function(actor) {
      var safe = actor.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
      if (!laneActors[safe] && !laneActors[actor.toLowerCase()]) {
        issues.push({ level: 'warn', msg: 'Actor "' + escHtml(actor) + '" not found in any lane' });
      }
    });
  }

  // Check 4: similar node labels (potential duplicates)
  var labels = Object.values(definedNodes).filter(function(l) { return l && l.length > 4; });
  for (var i = 0; i < labels.length; i++) {
    for (var j = i + 1; j < labels.length; j++) {
      if (isSimilarLabel(labels[i], labels[j])) {
        issues.push({ level: 'warn', msg: 'Similar nodes: "' + escHtml(labels[i]) + '" and "' + escHtml(labels[j]) + '" — consider merging' });
        break; // only one warning per pair group
      }
    }
  }

  renderValidationBar(issues);
}

function isSimilarLabel(a, b) {
  var al = a.toLowerCase(), bl = b.toLowerCase();
  // Must be at least 8 chars each to be worth comparing
  if (al.length < 8 || bl.length < 8) return false;
  // Exact match after normalisation
  if (al === bl) return true;
  // Token-based Jaccard: both labels must share tokens beyond common stop-words
  var stops = new Set(['the','a','an','is','are','and','or','to','of','in','on','at','by','for',
                       'player','agent','system','user','customer','request','with','from']);
  function tokens(s) {
    return s.split(/[^a-z0-9]+/).filter(function(t) {
      return t.length >= 3 && !stops.has(t);
    });
  }
  var at = tokens(al), bt = tokens(bl);
  if (!at.length || !bt.length) return false;
  var aSet = new Set(at), bSet = new Set(bt);
  var intersection = 0;
  aSet.forEach(function(t) { if (bSet.has(t)) intersection++; });
  var union = new Set([].concat(at, bt)).size;
  // Jaccard >= 0.65 = substantially the same label
  return union > 0 && (intersection / union) >= 0.65;
}

function renderValidationBar(issues) {
  var bar = document.getElementById('validation-bar');
  if (!bar) return;
  if (!issues || !issues.length) {
    bar.style.display = 'none';
    return;
  }
  // Show errors first, then warnings. Cap at 6 visible lines to avoid flood.
  var errors   = issues.filter(function(i) { return i.level === 'error'; });
  var warnings = issues.filter(function(i) { return i.level !== 'error'; });
  var sorted   = errors.concat(warnings);
  var MAX_SHOW = 6;
  var shown    = sorted.slice(0, MAX_SHOW);
  var hidden   = sorted.length - shown.length;

  bar.style.display = 'block';
  bar.innerHTML = shown.map(function(issue) {
    var icon  = issue.level === 'error' ? '✗' : '⚠';
    var color = issue.level === 'error' ? 'var(--red-600)' : 'var(--amber-700)';
    return '<div style="display:flex;align-items:flex-start;gap:6px;padding:3px 0;border-bottom:1px solid var(--gray-100);">' +
      '<span style="font-size:11px;font-weight:700;color:' + color + ';flex-shrink:0;">' + icon + '</span>' +
      '<span style="font-size:11px;color:var(--gray-700);">' + issue.msg + '</span>' +
    '</div>';
  }).join('') +
  (hidden > 0 ? '<div style="font-size:10px;color:var(--gray-400);padding:3px 0;">' + hidden + ' more issue' + (hidden > 1 ? 's' : '') + ' hidden</div>' : '') +
  '<div style="font-size:10px;color:var(--gray-400);margin-top:4px;text-align:right;">Post-gen validation · <a href="#" onclick="document.getElementById(\'validation-bar\').style.display=\'none\';return false;" style="color:var(--gray-400);">dismiss</a></div>';
}

// ── Helpers ───────────────────────────────────────────────────────
/** @returns {Array} All saved chart entries from localStorage */
function getSaved() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } }
/** @param {Array} c - Chart array to persist */
function putSaved(c) { localStorage.setItem(STORAGE_KEY, JSON.stringify(c)); }

/**
 * Show a brief toast notification at the bottom of the screen.
 * @param {string} msg - Message text
 */
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard'));
}

// ── Label sanitiser ───────────────────────────────────────────────
