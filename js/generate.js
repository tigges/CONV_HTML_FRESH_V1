// ══════════════════════════════════════════════════════════════════
// Flowinject v4.0 — generate.js — Claude API pipeline: smartAction, convert*, callAPI, buildPrompt, runExtraction, buildGraph
// Part of the modular refactor from monolithic index.html (v3.12.2)
// All functions remain global-scope for backward compatibility.
// ══════════════════════════════════════════════════════════════════

// ── Error handling ────────────────────────────────────────────────
/**
 * Standardised API/pipeline error handler.
 * Clears the loading state, logs to console, and shows a toast.
 * @param {Error|string} err - Error object or message string
 * @param {string} [context] - Short label for the failing operation, e.g. 'Pass 1'
 */
function handleAPIError(err, context) {
  setLoading(false);
  var msg = (err && err.message) ? err.message : String(err || 'Unknown error');
  console.error('[FC error' + (context ? ' — ' + context : '') + ']', err);
  showToast('⚠ ' + (context ? context + ': ' : '') + msg);
}

// ── Smart action — pipeline-aware single button ───────────────────
// Determines what to do based on current state:
// • No document → prompt user to load one
// • Document loaded, pipeline not run → run pipeline then generate
// • Pipeline done → generate chart directly
// • Ctrl+Enter shortcut always calls this
// ── Session cost tracker ─────────────────────────────────────────
var sessionCost = 0;
var MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },   // $ per M tokens
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
};

function addSessionCost(model, inputTokens, outputTokens) {
  var p = MODEL_PRICING[model] || MODEL_PRICING['claude-haiku-4-5-20251001'];
  sessionCost += (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
  var el = document.getElementById('session-cost');
  if (el) el.textContent = '$' + sessionCost.toFixed(4);
}

// ── Pre-flight cost estimate ──────────────────────────────────────
function updatePreflight() {
  var bar    = document.getElementById('preflight-bar');
  var text   = (pipe.clean || document.getElementById('input-text').value).trim();
  if (!text || !bar) { if (bar) bar.classList.remove('visible'); return; }

  var model   = document.getElementById('model-select').value;
  var chunked = document.getElementById('chunked-mode').checked;
  var pricing = MODEL_PRICING[model] || MODEL_PRICING['claude-haiku-4-5-20251001'];
  var modelName = model.includes('sonnet') ? 'Sonnet 4.6' : 'Haiku 4.5';

  // Rough token estimate: chars/4 for input text + ~300 for prompt overhead
  var chunks   = (pipe.chunks && pipe.chunks.length > 1 && chunked) ? pipe.chunks : [{ text: text }];
  var numCalls = chunks.length;
  var estInputTokens = 0;
  chunks.forEach(function(c) {
    estInputTokens += Math.ceil((c.text || text).length / 4) + 300;
  });
  var estOutputTokens = numCalls * 400; // typical output per call
  var estCost = (estInputTokens / 1e6) * pricing.input + (estOutputTokens / 1e6) * pricing.output;

  document.getElementById('pf-model').textContent  = modelName;
  document.getElementById('pf-tokens').textContent = estInputTokens.toLocaleString();
  document.getElementById('pf-calls').textContent  = numCalls + (numCalls > 1 ? ' (chunked)' : '');
  document.getElementById('pf-cost').textContent   = estCost < 0.0001 ? '<$0.0001' : '$' + estCost.toFixed(4);

  var costEl = document.getElementById('pf-cost');
  costEl.className = (estCost > 0.05 ? 'pf-val pf-warn' : 'pf-val');

  // Chunked note when enabled but only one chunk
  if (chunked && pipe.chunks && pipe.chunks.length <= 1) {
    document.getElementById('pf-calls').textContent = '1 (doc too short for chunking)';
  }

  bar.classList.add('visible');
}

// ── Run Pipeline Only (no API call) ──────────────────────────────
async function runPipelineOnly() {
  var hasText = document.getElementById('input-text').value.trim().length > 0;
  if (!hasText) { showToast('Load or paste a document first'); switchLeftTab('raw'); return; }
  var btn = document.getElementById('pipeline-only-btn');
  try {
    btn.disabled = true;
    btn.textContent = '⟳ Running…';
    updatePipelineStatus(false, 'Running pipeline…');
    await runPipeline();
    updatePreflight();
  } catch(err) {
    console.error('[runPipelineOnly]', err);
    showToast('Pipeline error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '⚙ Pipeline Only';
  }
}

// ── Tier 1: Rule-based diagram generator (no API call) ────────────
// Builds valid Mermaid directly from pre-parse tags.
// Quality: covers ~70% of well-structured procedural documents.
async function generateRuleBased() {
  if (!pipe.preparsed || !pipe.preparsed.length) {
    if (!document.getElementById('input-text').value.trim()) {
      showToast('Load or paste a document first'); return;
    }
    await runPipeline();
  }

  var dtype  = document.getElementById('diagram-type').value;
  var actors = pipe.actors.filter(function(a) { return a.selected; }).map(function(a) { return a.name; });
  var items  = pipe.preparsed.filter(function(p) {
    return ['step','decision','outcome','subprocess','process','condition'].indexOf(p.type) !== -1;
  });

  if (!items.length) { showToast('No actionable steps found — try running pipeline first'); return; }

  var mmd = '';

  if (dtype === 'swimlane' && actors.length >= 2) {
    mmd = buildRuleBasedSwimlane(items, actors);
  } else if (dtype === 'sequence' && actors.length >= 2) {
    mmd = buildRuleBasedSequence(items, actors);
  } else {
    mmd = buildRuleBasedFlowchart(items);
  }

  if (!mmd) { showToast('Could not generate diagram from pipeline tags'); return; }

  // Run the same repair + sanitise chain as Claude-generated output
  mmd = sanitiseLabels(repairMermaid(mmd));
  var coloured = injectColours(mmd);
  document.getElementById('mermaid-editor').value = coloured;
  switchRightTab('graph');
  await renderMermaid(coloured);
  validateGeneratedDiagram(coloured, dtype);
  pushHistory(coloured, dtype);
  showToast('⚡ Quick Chart generated — no API call used');
  updatePipelineStatus(true);
}

// Strip markdown, special chars, and truncate for safe use inside Mermaid node labels
function sanitiseRBLabel(text, maxLen) {
  return (text || '')
    .replace(/\*\*?([^*]+)\*\*?/g, '$1')   // strip **bold** / *italic*
    .replace(/`([^`]+)`/g, '$1')            // strip `code`
    .replace(/["\[\]{}()|]/g, ' ')          // strip Mermaid-reserved chars
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLen || 38)
    .trim();
}

function buildRuleBasedFlowchart(items) {
  var lines  = ['flowchart TD'];
  var nodeId = function(i) { return 'N' + i; };

  // Start node
  lines.push('  N_START(("Start"))');

  items.forEach(function(p, i) {
    var id    = nodeId(i);
    var label = sanitiseRBLabel(p.label, 38);
    if (p.type === 'decision') {
      lines.push('  ' + id + '{"' + label + '?"}');
    } else if (p.type === 'outcome') {
      lines.push('  ' + id + '(["' + label + '"])');
    } else if (p.type === 'subprocess' || p.type === 'process') {
      lines.push('  ' + id + '[["' + label + '"]]');
    } else {
      lines.push('  ' + id + '["' + label + '"]');
    }
  });

  // End node
  lines.push('  N_END(("End"))');

  // Connections
  lines.push('  N_START --> ' + nodeId(0));
  for (var i = 0; i < items.length - 1; i++) {
    if (items[i].type === 'decision') {
      lines.push('  ' + nodeId(i) + ' -->|Yes| ' + nodeId(i + 1));
    } else {
      lines.push('  ' + nodeId(i) + ' --> ' + nodeId(i + 1));
    }
  }
  lines.push('  ' + nodeId(items.length - 1) + ' --> N_END');

  return lines.join('\n');
}

function buildRuleBasedSwimlane(items, actors) {
  var orient    = (document.getElementById('lane-orient') || {value:'LR'}).value;
  var lines     = ['graph ' + orient];
  var laneItems = {};
  actors.forEach(function(a) { laneItems[a] = []; });

  // Bucket items into lanes
  items.forEach(function(p, i) {
    var lane = (p.actor && laneItems[p.actor] !== undefined)
               ? p.actor
               : (actors[1] || actors[0]);
    laneItems[lane].push({ p: p, i: i });
  });

  // Build a flat id map: original index → node id (includes lane prefix)
  var idMap = {};
  items.forEach(function(p, i) {
    var lane = (p.actor && laneItems[p.actor] !== undefined)
               ? p.actor : (actors[1] || actors[0]);
    idMap[i] = lane.substring(0, 2).toUpperCase() + i;
  });

  // Emit subgraphs — always emit all selected lanes to preserve structure
  actors.forEach(function(actor) {
    var bucket    = laneItems[actor];
    var safeActor = actor.replace(/[^a-zA-Z0-9_]/g, '_');
    lines.push('  subgraph ' + safeActor + '["' + actor + '"]');
    if (bucket.length) {
      bucket.forEach(function(entry) {
        var id    = idMap[entry.i];
        var label = sanitiseRBLabel(entry.p.label, 33);
        if (entry.p.type === 'decision') {
          lines.push('    ' + id + '{"' + label + '?"}');
        } else if (entry.p.type === 'outcome') {
          // Use subroutine shape [["..."]] — stadium ([...]) crashes inside subgraph in Mermaid 10.6
          lines.push('    ' + id + '[["' + label + '"]]');
        } else if (entry.p.type === 'subprocess' || entry.p.type === 'process') {
          lines.push('    ' + id + '[["' + label + '"]]');
        } else {
          lines.push('    ' + id + '["' + label + '"]');
        }
      });
    } else {
      // Empty lane placeholder so Mermaid renders the lane
      lines.push('    ' + safeActor + '_empty["—"]');
    }
    lines.push('  end');
  });

  // Sequential connections in original document order
  for (var i = 0; i < items.length - 1; i++) {
    if (items[i].type === 'decision') {
      lines.push('  ' + idMap[i] + ' -->|Yes| ' + idMap[i + 1]);
    } else {
      lines.push('  ' + idMap[i] + ' --> ' + idMap[i + 1]);
    }
  }

  return lines.join('\n');
}

function buildRuleBasedSequence(items, actors) {
  var lines = ['sequenceDiagram'];
  actors.forEach(function(a) { lines.push('  participant ' + a); });

  var prev = actors[1] || actors[0];
  items.slice(0, 20).forEach(function(p) {
    var from = (p.actor && actors.indexOf(p.actor) !== -1) ? p.actor : prev;
    var to   = from;
    if (p.type === 'outcome' || p.type === 'condition') {
      var idx = actors.indexOf(from);
      to = actors[(idx + 1) % actors.length] || from;
    }
    var label = sanitiseRBLabel(p.label, 35);
    lines.push('  ' + from + '->>+' + to + ': ' + label);
    prev = to;
  });

  return lines.join('\n');
}

async function smartAction() {
  var hasText = document.getElementById('input-text').value.trim().length > 0;
  var hasPipeline = pipe.preparsed && pipe.preparsed.length > 0;
  var hasApiKey = (document.getElementById('apikey').value.trim()
               || localStorage.getItem('fc_apikey') || '').length > 0;

  if (!hasText) {
    showToast('Load or paste a document first — then click the button');
    switchLeftTab('raw');
    return;
  }
  if (!hasApiKey) {
    showToast('Add your Anthropic API key in ⚙ Settings (top right)');
    document.getElementById('settings-gear-btn') && document.getElementById('settings-gear-btn').click();
    return;
  }
  if (!hasPipeline) {
    // Run pipeline first, then auto-generate
    updatePipelineStatus(false, 'Running pipeline…');
    await runPipeline();
    // Small pause so user can see the pre-parse results
    await sleep(400);
    await convert();
  } else {
    // Pipeline already done — go straight to generate
    await convert();
  }
}

// Update the pipeline status indicator and button text
function updatePipelineStatus(done, msg) {
  var status = document.getElementById('pipeline-status');
  var btn    = document.getElementById('convert-btn');
  if (!status || !btn) return;
  if (done) {
    status.textContent = '✓ Pipeline ready';
    status.style.color = 'var(--blue-400)';
    btn.textContent = '→ Generate Chart';
  } else if (msg) {
    status.textContent = msg;
    status.style.color = 'var(--gray-400)';
  } else {
    // No pipeline run yet
    status.textContent = '';
    btn.textContent = '▶ Run Pipeline + Generate';
  }
}

// ── AI Convert (with chunked mode) ───────────────────────────────
async function convert() {
  var apiKey  = (document.getElementById('apikey').value || '').trim()
             || localStorage.getItem('fc_apikey') || '';
  var model   = document.getElementById('model-select').value;
  var dtype   = document.getElementById('diagram-type').value;
  var chunked = document.getElementById('chunked-mode').checked;

  // v3.11.3: use chapter-only text when available (set by ↑ Append).
  // This prevents TOC content from contaminating Pass 1.
  // Fallback: pipe.clean (full combined text) — used for Load-only runs.
  var text = (pipe._chapterText || pipe.clean || pipe.raw || (document.getElementById('input-text') || {}).value || '').trim();
  if (!text)   { showError('Load or paste a document first.'); return; }
  if (!apiKey) { showError('Add your Anthropic API key in ⚙ Settings (top right).'); return; }

  showError('');
  switchRightTab('graph');

  if (chunked && pipe.chunks && pipe.chunks.length > 1) {
    await convertChunked(apiKey, model, dtype);
  } else {
    await convertSingle(apiKey, model, dtype, text);
  }
}

// Check that the generated Mermaid matches the requested diagram type.
// If not, make one automatic re-prompt with a correction instruction.
var DTYPE_HEADERS = {
  flowchart: /^flowchart\s+/i,
  swimlane:  /^graph\s+(LR|TD|RL|BT)\s*/i,
  sequence:  /^sequenceDiagram\s*/i,
};

async function validateAndFixOutputType(code, dtype, apiKey, model) {
  var expected = DTYPE_HEADERS[dtype];
  if (!expected) return code; // unknown type, pass through
  var firstLine = code.trim().split('\n')[0].trim();
  if (expected.test(firstLine)) return code; // correct, nothing to do

  // Wrong type detected — build a correction prompt
  console.warn('Output type mismatch: expected ' + dtype + ', got: ' + firstLine + ' — auto-correcting');
  var orient  = (document.getElementById('lane-orient') || {value:'LR'}).value;
  var correctHeader = dtype === 'flowchart' ? 'flowchart TD'
                    : dtype === 'swimlane'  ? 'graph ' + orient
                    : 'sequenceDiagram';
  var fixPrompt =
    'The following Mermaid diagram was generated as the wrong type.\n' +
    'Required type: ' + dtype + ' (must start with "' + correctHeader + '")\n' +
    'Current (wrong) output:\n' + code + '\n\n' +
    'Convert it to a valid ' + dtype + ' diagram starting with "' + correctHeader + '".\n' +
    'Output ONLY valid Mermaid code, no explanation, no code fences.';
  try {
    var fix = await callAPI(apiKey, model, fixPrompt);
    return fix.clean || code;
  } catch(e) {
    console.warn('Auto-fix failed:', e.message);
    return code; // fall back to original rather than crashing
  }
}

// ══════════════════════════════════════════════════════════════════
// ── TWO-PASS GENERATION (v2.5.0) ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════

var twoPassEnabled = false;

// ── v3.2.0: Detail level ─────────────────────────────────────────
// Controls how many steps Pass 1 is asked to extract, and Pass 2's node cap.
var DETAIL_LEVEL = 'standard'; // 'summary' | 'standard' | 'detailed'
var DETAIL_LEVEL_CONFIG = {
  summary:  { label: 'Summary',  pass1Cap: 10, pass2Cap: 12, instruction: 'Aim for the 8-12 most essential high-level steps only. Group sub-steps into single higher-level steps. Omit procedural detail.' },
  standard: { label: 'Standard', pass1Cap: 20, pass2Cap: 25, instruction: 'Aim for 15-20 steps, balancing completeness with readability.' },
  detailed: { label: 'Detailed', pass1Cap: 50, pass2Cap: 50, instruction: 'Include ALL meaningful steps up to 50. Preserve every sub-step, exception path, and decision branch. Do not group or summarise.' },
};

function setDetailLevel(level) {
  DETAIL_LEVEL = level;
  ['summary','standard','detailed'].forEach(function(l) {
    var btn = document.getElementById('dl-' + l);
    if (btn) btn.classList.toggle('active', l === level);
  });
  showToast('Detail level: ' + DETAIL_LEVEL_CONFIG[level].label + ' (' + DETAIL_LEVEL_CONFIG[level].pass2Cap + ' nodes max)');
}

function toggleTwoPass() {
  twoPassEnabled = !twoPassEnabled;
  var btn = document.getElementById('two-pass-btn');
  var badge = document.getElementById('pf-twopass-badge');
  var dlWrap = document.getElementById('detail-level-wrap');
  if (btn) {
    btn.style.background = twoPassEnabled ? 'rgba(59,130,246,0.35)' : 'rgba(255,255,255,0.08)';
    btn.style.color      = twoPassEnabled ? 'var(--white)' : 'rgba(255,255,255,0.6)';
    btn.style.borderColor= twoPassEnabled ? 'rgba(147,197,253,0.6)' : 'rgba(255,255,255,0.2)';
    btn.title = twoPassEnabled
      ? 'Two-pass ON — click to disable'
      : 'Two-pass mode: Pass 1 extracts structured entities, Pass 2 generates Mermaid';
  }
  if (badge)  badge.style.display  = twoPassEnabled ? '' : 'none';
  if (dlWrap) dlWrap.style.display = twoPassEnabled ? '' : 'none';
  showToast(twoPassEnabled ? '⊕ Two-pass ON — smarter extraction, 2 API calls' : '⊕ Two-pass OFF — single API call');
  updatePreflight();
}

// Pass 1: semantic extraction — returns structured process JSON
// Uses a cheap, focused prompt. ~500–800 input tokens, ~400–600 output tokens.

// --- extractCandidateDecisions ---
// Decision pre-pass: extracts candidate decision points from the pre-parsed
// pipeline result — NO API CALL. Uses items already classified as [DECISION]
// by preParse(), plus keyword scanning for conditionals not yet tagged.
// This replaces the previous LLM-based extractCandidateDecisions() and saves
// ~800–1200 tokens per run.
/**
 * Deterministically extract candidate decision points from pre-parsed data.
 * Falls back to keyword scan of raw text when preparsed is empty.
 * @param {string} _apiKey - unused (kept for call-site compatibility)
 * @param {string} _model  - unused (kept for call-site compatibility)
 * @param {string} text    - raw/cleaned text (fallback when preparsed empty)
 * @returns {Promise<{document_title:string, candidate_decisions:Array}>}
 */
async function extractCandidateDecisions(_apiKey, _model, text) {
  var decisions = [];
  var idCounter = 1;

  // ── Primary: use pre-parsed decisions (most accurate) ─────────────
  var preparsed = pipe.preparsed || [];
  preparsed.forEach(function(item) {
    if (item.type === 'decision' || item.type === 'condition') {
      decisions.push({
        id: 'D' + String(idCounter++).padStart(2, '0'),
        condition: item.text || item.label || '',
        signals: [item.text ? item.text.slice(0, 40) : ''],
        outcomes: ['Yes', 'No'],
        source_hint: (item.text || '').slice(0, 80),
      });
    }
  });

  // ── Fallback: keyword scan when pre-parse not yet run ─────────────
  if (decisions.length === 0 && text) {
    var DECISION_SIGNALS = [
      /\bif\b/i, /\bunless\b/i, /\bprovided that\b/i, /\bsubject to\b/i,
      /\bwhen\b.{0,40}\bthen\b/i, /\bexceeds?\b/i, /\bbelow\b.{0,20}\blimit\b/i,
      /\bverified\b|\bapproved\b|\bdeclined\b|\bpending\b/i,
      /\beligible\b|\bineligible\b/i, /\bonce\s+\w+ed\b/i,
      /\bescalate\s+(to|when|if)\b/i, /\brefer\s+to\b.{0,30}\bif\b/i,
    ];
    var sourceLines = text.split('\n');
    sourceLines.forEach(function(line) {
      var t = line.trim();
      if (t.length < 10) return;
      var matched = DECISION_SIGNALS.some(function(re) { return re.test(t); });
      if (matched) {
        decisions.push({
          id: 'D' + String(idCounter++).padStart(2, '0'),
          condition: t.slice(0, 80),
          signals: [t.slice(0, 40)],
          outcomes: ['Yes', 'No'],
          source_hint: t.slice(0, 80),
        });
      }
    });
  }

  // Record zero token cost in stats (no API call made)
  pipe.stats = pipe.stats || {};
  pipe.stats.prePassTokens = { input: 0, output: 0 };

  return {
    document_title: pipe.raw ? pipe.raw.split('\n')[0].slice(0, 60).trim() : 'unknown',
    candidate_decisions: decisions,
  };
}

// --- checkDecisionCoverage ---
// Compares candidate decisions from the pre-pass against Pass 1 entity
// decision nodes. Returns a coverage report stored in pipe.stats.decisionCoverage.
function checkDecisionCoverage(candidateDecisions, pass1Entities, threshold) {
  threshold = (threshold === undefined) ? 0.70 : threshold;

  if (!candidateDecisions || candidateDecisions.length === 0) {
    var report = { totalCandidates: 0, covered: 0, missing: [], coverageRatio: 1.0, passesThreshold: true };
    pipe.stats = pipe.stats || {};
    pipe.stats.decisionCoverage = report;
    return report;
  }

  // Build flat array of Pass 1 decision labels (lowercased)
  var p1DecisionLabels = [];
  if (pass1Entities && pass1Entities.steps) {
    pass1Entities.steps.forEach(function(s) {
      if ((s.type || '').toLowerCase() === 'decision' && s.label) {
        p1DecisionLabels.push(s.label.toLowerCase());
      }
    });
  }

  function tokenOverlap(a, b) {
    var aTokens = a.split(/\s+/).filter(function(t) { return t.length > 1; });
    var bTokens = b.split(/\s+/).filter(function(t) { return t.length > 1; });
    if (!aTokens.length || !bTokens.length) return 0;
    var bSet = {};
    bTokens.forEach(function(t) { bSet[t] = true; });
    var shared = aTokens.filter(function(t) { return bSet[t]; }).length;
    return shared / Math.max(aTokens.length, bTokens.length);
  }

  var covered = [];
  var missing = [];

  candidateDecisions.forEach(function(cand) {
    var condLower  = (cand.condition  || '').toLowerCase();
    var hintLower  = (cand.source_hint || '').toLowerCase();
    var matched = p1DecisionLabels.some(function(lbl) {
      if (tokenOverlap(condLower, lbl) >= 0.35) return true;
      if (tokenOverlap(hintLower, lbl) >= 0.30) return true;
      return false;
    });
    if (matched) { covered.push(cand); } else { missing.push(cand); }
  });

  var ratio = Math.round((covered.length / candidateDecisions.length) * 100) / 100;
  var report = {
    totalCandidates: candidateDecisions.length,
    covered:         covered.length,
    missing:         missing,
    coverageRatio:   ratio,
    passesThreshold: ratio >= threshold,
  };
  pipe.stats = pipe.stats || {};
  pipe.stats.decisionCoverage = report;
  return report;
}

// --- buildRepromptAddition ---
// Builds the addendum injected into Pass 1 prompt on a retry when
// checkDecisionCoverage() finds uncovered decision candidates.
function buildRepromptAddition(missingDecisions) {
  if (!missingDecisions || missingDecisions.length === 0) return '';

  var lines = [
    '\nCRITICAL — MISSING DECISION NODES: Your output is missing decision nodes',
    'for the following conditions found in the document. Each MUST appear as a',
    'node with type="decision" in your revised output. Do not remove any nodes',
    'already present.\n',
  ];

  missingDecisions.forEach(function(d) {
    var outcomes = (d.outcomes || []).join(' / ');
    lines.push('- ' + d.id + ': "' + (d.condition || '') + '" → outcomes: [' + outcomes + ']');
    lines.push('  (source: "' + (d.source_hint || '') + '")');
  });

  return lines.join('\n');
}

async function extractEntitiesPass1(apiKey, model, text, repromptAddition) {
  var useThinking = INTEL_FLAGS.extendedThinking && model.includes('sonnet');
  var glossaryContext = buildGlossaryContext();
  var prompt =
    'You are a business process analyst. Analyse the following document and extract its process structure as JSON.\n\n' +
    'Output ONLY a valid JSON object with this exact schema (no explanation, no markdown, no code fences):\n' +
    '{\n' +
    '  "processName": "short name for the overall process",\n' +
    '  "actors": ["list of all roles/systems that perform actions"],\n' +
    '  "steps": [\n' +
    '    {\n' +
    '      "id": "S1",\n' +
    '      "label": "Short Title Case Noun Phrase (3-5 words)",\n' +
    '      "sourceText": "the original sentence this step came from",\n' +
    '      "type": "step|decision|subprocess|outcome|condition",\n' +
    '      "actor": "Agent|Player|System — who performs this (must be from actors list)",\n' +
    '      "next": ["id of next step(s) — array for decisions"],\n' +
    '      "condition": "Yes|No or empty string for decision branches"\n' +
    '    }\n' +
    '  ],\n' +
    '  "parallelGroups": ["group name if steps run in parallel — leave empty array if none"],\n' +
    '  "exceptions": ["brief description of exception/error paths found in the document"]\n' +
    '}\n\n' +
    'LABEL RULES — apply to every "label" field without exception:\n' +
    '  - Write a SHORT Title Case noun phrase (3-5 words) that names the concept.\n' +
    '  - The label must stand alone as a process step name — NOT a sentence fragment.\n' +
    '  - Good: "Bonus Wager Calculation", "Real Balance Withdrawal", "Free Spin Activation"\n' +
    '  - Bad:  "The wager of these bonuses", "It\'s up to players", "He bets another"\n' +
    '  - Verb+Noun structure preferred: "Verify Identity", "Submit Withdrawal Request"\n\n' +
    'Rules:\n' +
    '  - Every decision step MUST have exactly two entries in "next" (one Yes, one No)\n' +
    '  - All actors must appear in the top-level actors array\n' +
    '  - Do not invent steps not present in the document\n' +
    '  - Do not include document metadata (author, title, date) as steps\n' +
    '  - ' + (DETAIL_LEVEL_CONFIG[DETAIL_LEVEL] || DETAIL_LEVEL_CONFIG.standard).instruction + '\n' +
    (glossaryContext ? '\nGLOSSARY (use these definitions):\n' + glossaryContext + '\n' : '') +
    '\nPRE-PARSED STRUCTURE HINTS (use these to identify process steps,\n' +
    'decisions and subprocesses — do not treat as the complete list):\n' +
    buildStructuredContext(pipe.preparsed, pipe._currentToc).slice(0, 6000) + '\n\n' +
    'FULL DOCUMENT (use for context, connections and narrative flow):\n' +
    text.slice(0, 12000) +
    (repromptAddition ? '\n\n' + repromptAddition : '');

  var result = await callAPI(apiKey, model, prompt, {
    maxTokens:      useThinking ? 12000 : 6000,
    thinking:       useThinking,
    thinkingBudget: 8000,
  });

  logTokenPass('Pass 1', Math.ceil(prompt.length / 4), result.usage);

  // Parse JSON from result — result.clean contains the text blocks only
  try {
    var start = result.clean.indexOf('{');
    var end   = result.clean.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object found');
    var extracted = JSON.parse(result.clean.substring(start, end + 1));
    return { data: extracted, usage: result.usage, _rawClean: result.clean };
  } catch(e) {
    console.warn('Pass 1 JSON parse failed:', e.message, '\nRaw:', result.clean.slice(0, 300));
    return { data: null, usage: result.usage, _rawClean: result.clean };
  }
}

// Pass 1 result → display in Analysis pane + store on pipe
function applyEntities(entities) {
  if (!entities) return;
  pipe.entities = entities;

  // Pre-fill chart name from processName if the name field is still blank
  if (entities.processName) {
    // Always upgrade from a system-set name to the LLM-extracted processName
    // Never override if the user has manually typed a name
    if (_canOverrideChartName()) {
      _setChartName(entities.processName, 'system');
    }
  }

  // Initialise selection state: all steps selected by default
  if (entities.steps) {
    entities.steps.forEach(function(s) {
      if (s._selected === undefined) s._selected = true;
    });
  }

  // Merge Pass-1 actors into pipe.actors (if not already present)
  if (entities.actors && entities.actors.length) {
    entities.actors.forEach(function(name) {
      var already = pipe.actors.find(function(a) { return a.name.toLowerCase() === name.toLowerCase(); });
      if (!already) {
        pipe.actors.push({ name: name, selected: true, color: getActorColor(pipe.actors.length) });
      }
    });
    renderAnalysisPane();
  }

  // Show entity summary in Analysis pane
  var entityDiv = document.getElementById('entity-summary');
  if (entityDiv && entities.steps) {
    var decisions = entities.steps.filter(function(s){ return s.type === 'decision'; }).length;
    var subprocs  = entities.steps.filter(function(s){ return s.type === 'subprocess'; }).length;
    entityDiv.innerHTML =
      '<div style="font-size:10px;font-weight:700;color:var(--blue-600);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;">⊕ Pass 1 — Extracted Entities</div>' +
      '<div style="display:flex;gap:12px;flex-wrap:wrap;">' +
        stat('Process', entities.processName || '—') +
        stat('Steps', entities.steps.length) +
        stat('Actors', (entities.actors || []).length) +
        stat('Decisions', decisions) +
        stat('Sub-processes', subprocs) +
        ((entities.exceptions || []).length ? stat('Exceptions', entities.exceptions.length) : '') +
      '</div>' +
      ((entities.exceptions || []).length
        ? '<div style="margin-top:6px;font-size:10px;color:var(--amber-700);">⚠ Exceptions detected: ' +
            escHtml(entities.exceptions.slice(0,3).join(' · ')) + '</div>'
        : '');
    entityDiv.style.display = 'block';
  }

  // v3.2.0: Show Pass 1 step editor
  renderPass1StepEditor(entities);
}

// ── v3.2.0: Pass 1 Step Editor ───────────────────────────────────

var STEP_TYPE_COLORS = {
  step:       { bg:'#dbeafe', color:'#1e40af', border:'#93c5fd' },
  decision:   { bg:'#fef9c3', color:'#92400e', border:'#fde68a' },
  subprocess: { bg:'#e0f2fe', color:'#0369a1', border:'#bae6fd' },
  process:    { bg:'#f0f9ff', color:'#0284c7', border:'#bae6fd' },
  outcome:    { bg:'#d1fae5', color:'#065f46', border:'#6ee7b7' },
  condition:  { bg:'#ede9fe', color:'#5b21b6', border:'#c4b5fd' },
};

function renderPass1StepEditor(entities) {
  var section = document.getElementById('pass1-editor-section');
  var listEl  = document.getElementById('pass1-step-list');
  var countEl = document.getElementById('pass1-step-count');
  if (!section || !listEl) return;

  if (!entities || !entities.steps || !entities.steps.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  var steps = entities.steps;
  var selectedCount = steps.filter(function(s) { return s._selected !== false; }).length;
  countEl.textContent = selectedCount + ' / ' + steps.length + ' selected';

  listEl.innerHTML = steps.map(function(s, i) {
    var checked   = s._selected !== false ? 'checked' : '';
    var typeStyle = STEP_TYPE_COLORS[s.type] || { bg:'#f3f4f6', color:'#374151', border:'#d1d5db' };
    var typeBadge = '<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;border:1px solid ' +
      typeStyle.border + ';background:' + typeStyle.bg + ';color:' + typeStyle.color + ';font-family:\'JetBrains Mono\',monospace;">' +
      escHtml((s.type||'step').substring(0,4).toUpperCase()) + '</span>';
    var actorBadge = s.actor
      ? '<span class="pass1-step-actor">@' + escHtml(s.actor) + '</span>'
      : '';
    var sourceRow = s.sourceText
      ? '<div style="font-size:9.5px;color:var(--gray-400);font-style:italic;margin-top:1px;line-height:1.3;">' + escHtml(s.sourceText.slice(0, 120)) + (s.sourceText.length > 120 ? '…' : '') + '</div>'
      : '';
    return '<div class="pass1-step-row' + (checked ? '' : ' excluded') + '" id="p1row-' + i + '">' +
      '<input type="checkbox" ' + checked + ' onchange="pass1ToggleStep(' + i + ', this.checked)" title="Include in Pass 2">' +
      '<span class="pass1-step-id">' + escHtml(s.id || String(i+1)) + '</span>' +
      typeBadge +
      '<div style="flex:1;min-width:0;">' +
        '<div><span class="pass1-step-label">' + escHtml(s.label || '') + '</span>' + actorBadge + '</div>' +
        sourceRow +
      '</div>' +
    '</div>';
  }).join('');
}

function pass1ToggleStep(idx, checked) {
  if (!pipe.entities || !pipe.entities.steps) return;
  pipe.entities.steps[idx]._selected = checked;
  var row = document.getElementById('p1row-' + idx);
  if (row) row.classList.toggle('excluded', !checked);
  var selectedCount = pipe.entities.steps.filter(function(s) { return s._selected !== false; }).length;
  var countEl = document.getElementById('pass1-step-count');
  if (countEl) countEl.textContent = selectedCount + ' / ' + pipe.entities.steps.length + ' selected';
}

function pass1SelectAll(value) {
  if (!pipe.entities || !pipe.entities.steps) return;
  pipe.entities.steps.forEach(function(s) { s._selected = value; });
  renderPass1StepEditor(pipe.entities);
}

async function pass1RunPass2() {
  if (!pipe.entities) { showToast('Run 2-Pass generation first to extract entities'); return; }
  var apiKey = localStorage.getItem('fc_apikey') || '';
  if (!apiKey) { showToast('API key required for Pass 2'); return; }

  // Build a filtered copy of entities with only selected steps
  var filteredEntities = Object.assign({}, pipe.entities, {
    steps: pipe.entities.steps.filter(function(s) { return s._selected !== false; }),
  });

  if (!filteredEntities.steps.length) { showToast('Select at least one step before running Pass 2'); return; }

  var dtype  = document.getElementById('diagram-type').value;
  var actors = pipe.actors.filter(function(a) { return a.selected; }).map(function(a) { return a.name; });
  var model  = document.getElementById('model-select') ? document.getElementById('model-select').value : 'claude-haiku-4-5-20251001';

  var btn = document.getElementById('btn-pass1-rerun');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Running…'; }

  try {
    var p2prompt  = buildPass2Prompt(dtype, filteredEntities, actors);
    var useThinkingP2 = INTEL_FLAGS.extendedThinking && model.includes('sonnet');
    var p2opts = useThinkingP2
      ? { maxTokens: 12000, thinking: true, thinkingBudget: 8000 }
      : { maxTokens: 6000 };
    var p2result  = await callAPI(apiKey, model, p2prompt, p2opts);
    var p2 = pass2ResultToMermaid(p2result.clean, dtype);
    var mmd = p2.fromSchema
      ? p2.mmd
      : sanitiseLabels(repairMermaid(p2.mmd));
    var coloured = injectColours(mmd);
    validateGeneratedDiagram(coloured, dtype);
    document.getElementById('mermaid-editor').value = coloured;
    switchRightTab('graph');
    await renderMermaid(coloured);
    pushHistory(coloured, dtype);
    showToast('▶ Pass 2 re-run with ' + filteredEntities.steps.length + ' steps → ' +
      (p2.fromSchema ? 'schema compiled' : 'raw Mermaid fallback'));
  } catch(e) {
    handleAPIError(e, 'Pass 2 re-run');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '▶ Run Pass 2'; }
  }
}

function stat(label, val) {
  return '<span style="font-size:10px;color:var(--gray-600);"><strong style="color:var(--gray-900);">' + val + '</strong> ' + label + '</span>';
}

// Build Pass-2 prompt from entity JSON
function buildPass2Prompt(dtype, entities, actors) {
  var glossaryContext = buildGlossaryContext();
  var outputContext   = buildOutputTemplateContext(entities.processName || '');
  var orient  = (document.getElementById('lane-orient') || {value:'LR'}).value;

  // Filter to actionable step types only — exclude noise types that don't become nodes
  var DIAGRAM_TYPES = ['step','decision','subprocess','process','outcome','condition'];
  var diagramSteps  = (entities.steps || []).filter(function(s) {
    return DIAGRAM_TYPES.indexOf((s.type || 'step').toLowerCase()) !== -1;
  });

  // Node cap: driven by detail level setting (v3.2.0)
  // For swimlane, ensure cap is at least laneCount * 3 so each lane gets meaningful nodes
  var dlCfg     = DETAIL_LEVEL_CONFIG[DETAIL_LEVEL] || DETAIL_LEVEL_CONFIG.standard;
  var laneCount = (actors.length >= 2 ? actors : (entities.actors || [])).length || 3;
  var maxNodes  = dtype === 'swimlane'
    ? Math.max(dlCfg.pass2Cap, laneCount * 3)   // never fewer than 3 nodes per lane
    : dlCfg.pass2Cap;

  if (diagramSteps.length > maxNodes) {
    var decisions    = diagramSteps.filter(function(s) { return (s.type||'').toLowerCase() === 'decision'; });
    var nonDecisions = diagramSteps.filter(function(s) { return (s.type||'').toLowerCase() !== 'decision'; });
    var keptDecisions = decisions.slice(0, Math.min(decisions.length, Math.floor(maxNodes * 0.4)));
    var slotsLeft     = maxNodes - keptDecisions.length;
    var sampled = [];
    if (nonDecisions.length > 0 && slotsLeft > 0) {
      var step = nonDecisions.length / slotsLeft;
      for (var si = 0; si < slotsLeft && si < nonDecisions.length; si++) {
        sampled.push(nonDecisions[Math.min(Math.round(si * step), nonDecisions.length - 1)]);
      }
      sampled = sampled.filter(function(s, i, arr) { return arr.indexOf(s) === i; });
    }
    var keptIds = new Set(keptDecisions.concat(sampled).map(function(s) { return s.id; }));
    diagramSteps = diagramSteps.filter(function(s) { return keptIds.has(s.id); });
  }

  var effectiveActors = actors.length >= 2 ? actors : (entities.actors || []);
  var stepList = diagramSteps.map(function(s) {
    var line = s.id + ': [' + (s.type || 'step').toUpperCase() + '] ' + s.label;
    if (s.actor)  line += ' (actor: ' + s.actor + ')';
    if (s.next && s.next.length === 2) line += ' → Yes:' + s.next[0] + ' No:' + s.next[1];
    else if (s.next && s.next.length) line += ' → ' + s.next.join(', ');
    return line;
  }).join('\n');

  // Schema example (compact, no comments)
  var schemaExample = JSON.stringify({
    nodes: [
      {id:'S0', type:'start',    label:'Start'},
      {id:'S1', type:'step',     label:'Verb Noun', lane: effectiveActors[0] || ''},
      {id:'S2', type:'decision', label:'Condition?'},
      {id:'S3', type:'end',      label:'End'},
    ],
    edges: [
      {from:'S0', to:'S1'},
      {from:'S1', to:'S2'},
      {from:'S2', to:'S3', label:'Yes'},
      {from:'S2', to:'S1', label:'No'},
    ],
    subgraphs: dtype === 'swimlane'
      ? [{id: effectiveActors[0] || 'Lane1', label: effectiveActors[0] || 'Lane1', nodes:['S1']}]
      : [],
  });

  var swimlaneNote = dtype === 'swimlane'
    ? '\n\nSWIMLANE RULES:\n' +
      '  - Each actor gets one subgraph. subgraph id = actor name (no spaces — use underscore)\n' +
      '  - Place every node in exactly one subgraph via the subgraphs[].nodes array\n' +
      '  - Start and End nodes: type="start" / type="end" — place in the first/last actor lane\n' +
      '  - Actors: ' + effectiveActors.join(', ')
    : '';

  return 'You are converting a process definition into a JSON graph.\n\n' +
    'Return ONLY a valid JSON object with keys: nodes, edges, subgraphs.\n' +
    'No markdown, no explanation, no code fences. Raw JSON only.\n\n' +
    'JSON SCHEMA:\n' +
    '  nodes:     array of {id, type, label, lane?}\n' +
    '             type must be one of: start | end | step | decision | subprocess | note\n' +
    '             id: short alphanumeric, no spaces (e.g. N1, AG2, PL3)\n' +
    '             lane: actor name (used for swimlane placement)\n' +
    '  edges:     array of {from, to, label?}\n' +
    '             label only on decision branches (Yes/No) or actor handoffs\n' +
    '  subgraphs: array of {id, label, nodes:[ids]}\n' +
    '             for swimlane: one subgraph per actor\n' +
    '             for flowchart: omit or use [] if no grouping needed\n\n' +
    'RULES:\n' +
    '  - Include exactly one node with type="start" and at least one type="end"\n' +
    '  - All edge from/to ids must match a node id\n' +
    '  - Labels: use the entity label verbatim; shorten only if over 6 words\n' +
    '  - Do NOT add nodes not in the steps list\n' +
    '  - Node labels: use the entity label field verbatim — never use sourceText directly\n' +
    '  - Every DECISION node MUST have exactly 2 exits: Yes path AND No path — never one exit\n' +
    '  - If the process loops (player retries, re-deposits, continues), draw the loop edge explicitly\n' +
    '  - Merge minor narrative steps into their nearest parent step — max 15 nodes total\n' +
    '  - Parallel paths (player can do A or B) must fork and rejoin with a merge node\n' +
    '  - Subprocesses (Free Spins, Loyalty Bonus) must be reached via a decision node in the main flow — never as parallel branches directly from Start\n' +
    '  - Start node must have exactly ONE outgoing edge\n\n' +
    'EXAMPLE OUTPUT:\n' + schemaExample + '\n\n' +
    'PROCESS TO CONVERT:\n' +
    'Name: ' + (entities.processName || 'Business Process') + '\n' +
    'Actors: ' + effectiveActors.join(', ') + '\n' +
    'Steps:\n' + stepList + '\n' +
    (entities.exceptions && entities.exceptions.length
      ? '\nKnown exceptions:\n' + entities.exceptions.map(function(e){ return '  - ' + e; }).join('\n') + '\n'
      : '') +
    swimlaneNote +
    (glossaryContext ? '\n\nGLOSSARY:\n' + glossaryContext : '') +
    (outputContext   ? '\n\nOUTPUT TEMPLATES:\n' + outputContext : '');
}

// ── v3.6.0: Stage 1 — LLM extraction ────────────────────────────
// Produces a fully-populated ExtractionResult.  No Mermaid knowledge.
/**
 * Run the full extraction pipeline: decision pre-pass (deterministic),
 * Pass 1 entity extraction, coverage check, entity assembly.
 * @param {string} apiKey - Anthropic API key
 * @param {string} model  - Model slug
 * @param {string} dtype  - Diagram type: 'flowchart' | 'swimlane' | 'sequence'
 * @param {string} text   - Pre-cleaned, pre-chunked document text
 * @param {string} [docId] - Optional document ID for registry tracking
 * @param {string} [sourceTitle] - Document title for display
 * @returns {Promise<ExtractionResult>}
 */
async function runExtraction(apiKey, model, dtype, text, docId, sourceTitle) {
  // Generate doc_id if not supplied
  if (!docId) {
    var slug = (sourceTitle || 'doc').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    docId = Date.now() + '-' + (slug || 'doc');
  }
  if (!sourceTitle) sourceTitle = 'Untitled Document';

  // ── TOC pre-pass (deterministic, no LLM) ────────────────────────
  var toc = detectTOC(text);
  console.log('TOC pre-pass:', toc.detected ? (toc.entries.length + ' entries, type=' + toc.doc_type_hint) : 'not detected');
  pipe._currentToc = toc; // available to buildStructuredContext() during this run
  // Wire to ChapterRegistry so chapter/cluster data is available at save time (spec §7)
  if (toc.detected) {
    ChapterRegistry.load(toc);
    // Also infer active chapter from the source filename
    var fnEl = document.getElementById('fname');
    if (fnEl && fnEl.textContent) ChapterRegistry.inferFromFilename(fnEl.textContent);
    // v3.11.0: wire DocumentRegistry — adds pending entries for all chapter headings
    DocumentRegistry.loadFromToc(toc, (currentProject && currentProject.slug) || 'general');
    // v3.11.3: if the text being extracted IS the combined text (no chapter isolation),
    // record it as _tocText so the source label in the context check is accurate.
    if (!pipe._chapterText && !pipe._tocText) pipe._tocText = text;
  }

  var stats = {
    pre_pass: { input: 0, output: 0 },
    pass_1:   { input: 0, output: 0 },
    pass_2:   { input: 0, output: 0 },
  };
  var rawPass1 = '';
  var rawPass2 = '';

  // ── v3.11.3: Pre-Pass-1 context size check ───────────────────────
  // Estimate token count of the text that will be sent to Pass 1.
  // 1 token ≈ 4 chars is a conservative estimate for English prose.
  (function _checkPass1Context() {
    var estTokens = Math.round(text.length / 4);
    // Always log so it's visible in DevTools
    var sourceLabel = pipe._chapterText
      ? 'chapter-only (TOC isolated)'
      : (pipe._inputSources && pipe._inputSources.length > 1 ? 'COMBINED (TOC + chapter)' : 'single document');
    console.log(
      'Pass 1 context: ~' + estTokens + ' tokens | ' +
      text.length.toLocaleString() + ' chars | source: ' + sourceLabel
    );
    if (pipe._inputSources && pipe._inputSources.length) {
      console.log('Input sources:', pipe._inputSources.map(function(s){
        return s.role + ':' + s.filename + '(' + s.chars.toLocaleString() + ' chars)';
      }).join(', '));
    }

    if (estTokens > PASS1_CONTEXT_TOKEN_THRESHOLD) {
      var breakdown = '';
      if (pipe._inputSources && pipe._inputSources.length) {
        breakdown = ' — sources: ' + pipe._inputSources.map(function(s){
          return '"' + s.filename + '" (' + Math.round(s.chars / 4).toLocaleString() + ' tokens, ' + s.role + ')';
        }).join(', ');
      }
      var warning = '⚠ Pass 1 context is ~' + estTokens.toLocaleString() + ' tokens'
        + ' (threshold ' + PASS1_CONTEXT_TOKEN_THRESHOLD.toLocaleString() + ')' + breakdown
        + '. Consider ↑ Load the chapter directly without the TOC appended, or reduce detail level.';
      console.warn(warning);
      // Surface in UI as a dismissible status message (non-blocking)
      var statusEl = document.getElementById('pipeline-status');
      if (statusEl) {
        statusEl.style.color = 'var(--amber-700)';
        statusEl.textContent = '⚠ Large context (~' + estTokens.toLocaleString() + ' tokens). ' +
          (pipe._chapterText ? '' : 'TOC may still be in context. ') +
          'See console for source breakdown.';
        setTimeout(function() {
          statusEl.style.color = '';
          updatePipelineStatus(true);
        }, 8000);
      }
    }
  })();

  // ── Decision pre-pass ────────────────────────────────────────────
  setLoading(true, 'Pre-pass — identifying decision points…');
  var prePasResult = await extractCandidateDecisions(apiKey, model, text);
  var candidateDecisions = prePasResult.candidate_decisions || [];
  if (pipe.stats && pipe.stats.prePassTokens) {
    stats.pre_pass.input  = pipe.stats.prePassTokens.input  || 0;
    stats.pre_pass.output = pipe.stats.prePassTokens.output || 0;
  }

  // ── Pass 1 with retry loop (max 2 attempts) ──────────────────────
  var useThinkingOnP1 = INTEL_FLAGS.extendedThinking && model.includes('sonnet');
  var pass1 = null;
  var MAX_P1_ATTEMPTS = 2;
  var retryTriggered = false;
  var finalCovReport = null;

  for (var attempt = 1; attempt <= MAX_P1_ATTEMPTS; attempt++) {
    var repromptAddition = '';

    if (attempt === 2 && pass1 && pass1.data) {
      var cov2 = checkDecisionCoverage(candidateDecisions, pass1.data);
      console.log('Decision coverage (attempt 1):', cov2);
      if (cov2.passesThreshold) { break; }
      repromptAddition = buildRepromptAddition(cov2.missing);
      retryTriggered = true;
      setLoading(true, 'Pass 1 retry — adding ' + cov2.missing.length + ' missing decision(s)…');
    } else {
      setLoading(true, useThinkingOnP1
        ? '🧠 Pass 1 — extended reasoning… (~5-15s)'
        : 'Pass 1 — Extracting process structure…');
    }

    pass1 = await extractEntitiesPass1(apiKey, model, text, repromptAddition);
    rawPass1 = pass1._rawClean || rawPass1;
    if (pass1.usage) {
      stats.pass_1.input  += pass1.usage.input_tokens  || 0;
      stats.pass_1.output += pass1.usage.output_tokens || 0;
    }

    if (!pass1.data) break;
    if (attempt === 1 && candidateDecisions.length > 0) {
      var cov1 = checkDecisionCoverage(candidateDecisions, pass1.data);
      console.log('Decision coverage (attempt 1):', cov1);
      if (cov1.passesThreshold) break;
    }
  }

  // Final coverage check
  var coverageRatio = 1.0;
  var coverageThreshold = 0.70;
  var coveragePassed = true;
  var coveredDecisions = [];
  var missingDecisions = [];

  if (pass1 && pass1.data && candidateDecisions.length > 0) {
    finalCovReport = checkDecisionCoverage(candidateDecisions, pass1.data);
    console.log('Decision coverage (final):', finalCovReport);
    coverageRatio     = finalCovReport.coverageRatio;
    coveragePassed    = finalCovReport.passesThreshold;
    coveredDecisions  = finalCovReport.covered !== undefined
      ? candidateDecisions.slice(0, finalCovReport.covered)
      : [];
    missingDecisions  = finalCovReport.missing || [];
  } else if (candidateDecisions.length === 0) {
    coverageRatio = 1.0; coveragePassed = true;
  }

  var entities = (pass1 && pass1.data) ? pass1.data : null;

  // ── Assign actor to every entity step ───────────────────────────
  var extractedActors = [];
  if (entities && entities.actors) {
    extractedActors = entities.actors.slice();
  }

  if (entities && entities.steps) {
    entities.steps.forEach(function(step) {
      if (!step.actor) {
        // Attempt ACTOR_PREFIX_MAP match on label then sourceText
        var actorTarget = step.label || step.sourceText || '';
        var mapped = detectActorPrefix(actorTarget);
        if (!mapped && step.sourceText) mapped = detectActorPrefix(step.sourceText);
        step.actor = mapped || (extractedActors[0] || 'System');
      }
      // Ensure actor appears in extractedActors list
      if (step.actor && extractedActors.indexOf(step.actor) === -1) {
        extractedActors.push(step.actor);
      }
    });
  }

  // ── Populate provenance on entities ─────────────────────────────
  var chunks = pipe.preparsed || [];
  function findProvenance(sourceText) {
    if (!sourceText || !chunks.length) return { chunk_index: 0, sentence: sourceText || '' };
    var best = { chunk_index: 0, sentence: sourceText, score: 0 };
    var lower = (sourceText || '').toLowerCase();
    chunks.forEach(function(ch, idx) {
      var chLower = (ch.text || '').toLowerCase();
      if (!chLower) return;
      // Simple token-overlap score
      var aToks = lower.split(/\s+/).filter(function(t){ return t.length > 2; });
      var bToks = chLower.split(/\s+/).filter(function(t){ return t.length > 2; });
      if (!aToks.length) return;
      var bSet = {};
      bToks.forEach(function(t){ bSet[t] = true; });
      var shared = aToks.filter(function(t){ return bSet[t]; }).length;
      var score = shared / Math.max(aToks.length, bToks.length);
      if (score > best.score) { best = { chunk_index: idx, sentence: ch.text || sourceText, score: score }; }
    });
    return { chunk_index: best.chunk_index, sentence: best.sentence };
  }

  var entitySteps = [];
  if (entities && entities.steps) {
    entitySteps = entities.steps.map(function(step) {
      var prov = findProvenance(step.sourceText || step.label);
      var conf = (step.confidence !== undefined) ? step.confidence : 0.8;
      return Object.assign({}, step, {
        provenance: prov,
        confidence: conf,
      });
    });
  }

  var decisionItems = candidateDecisions.map(function(d) {
    var prov = findProvenance(d.source_hint || d.condition);
    var isCovered = missingDecisions.indexOf(d) === -1 &&
      (finalCovReport ? finalCovReport.missing.indexOf(d) === -1 : true);
    return Object.assign({}, d, {
      provenance: prov,
      covered: isCovered,
    });
  });

  // ── Graveyard: uncovered decisions + junk-filtered items ────────
  var graveyard = [];
  // Decisions that were not covered by Pass 1
  missingDecisions.forEach(function(d) {
    graveyard.push({
      label:      d.condition || d.id || 'unknown',
      reason:     'below_coverage_threshold',
      provenance: findProvenance(d.source_hint || d.condition),
    });
  });
  // Junk-filtered items from pre-parse pipeline graveyard
  (pipe.graveyard || []).forEach(function(g) {
    graveyard.push({
      label:      g.text || '',
      reason:     g.reason || 'junk_filter',
      provenance: { chunk_index: 0, sentence: g.text || '' },
    });
  });

  // ── Assemble ExtractionResult ────────────────────────────────────
  // processName from Pass 1 is the most specific title available.
  // Always prefer it over filename-derived suggestion (system → system upgrade is fine).
  // Never override if the user manually typed something.
  var effectiveTitle = sourceTitle;
  if (entities && entities.processName) {
    var nameInp = document.getElementById('chart-name-input');
    if (_canOverrideChartName()) {
      effectiveTitle = entities.processName;
      _setChartName(entities.processName, 'system');
    } else {
      // User typed something specific — respect it as the title
      effectiveTitle = _getChartName() || sourceTitle;
    }
  }

  var extraction = {
    doc_id:        docId,
    source_title:  effectiveTitle,
    extracted_at:  new Date().toISOString(),
    model_used:    model,
    entities:      entitySteps,
    decisions:     decisionItems,
    graveyard:     graveyard,
    coverage: {
      ratio:            coverageRatio,
      threshold:        coverageThreshold,
      passed:           coveragePassed,
      retry_triggered:  retryTriggered,
    },
    actors:    extractedActors,
    keywords:  pipe.keywords || [],
    stats:     stats,
    _raw_pass1: rawPass1,
    _raw_pass2: rawPass2,
    // Carry full Pass 1 structured entities for buildGraph
    _entities_full: entities,
    // v3.8.0: TOC pre-pass result
    toc: {
      detected:      toc.detected,
      entry_count:   toc.entries.length,
      entries:       toc.entries,
      cluster_hint:  toc.cluster_hint,
      doc_type_hint: toc.doc_type_hint,
    },
  };

  return extraction;
}

// ── v3.6.0: Stage 2 — Deterministic graph construction ──────────
// Accepts an ExtractionResult, calls Pass 2 LLM, applies graph rules.
// Returns a graph object identical in shape to the current pipe.graph.
/**
 * Pass 2: build a structured graph from Pass 1 extraction result.
 * @param {ExtractionResult} extractionResult - Output of runExtraction()
 * @param {string} dtype - Diagram type
 * @returns {Promise<GraphObject|null>} Structured graph or null on failure
 */
async function buildGraph(extractionResult, dtype) {
  var entities = extractionResult._entities_full;
  if (!entities) return null;

  var actors = extractionResult.actors || [];

  // ── Pass 2: generate JSON graph from structured entities ─────────
  var useThinkingP2 = INTEL_FLAGS.extendedThinking && (extractionResult.model_used || '').includes('sonnet');
  setLoading(true, useThinkingP2
    ? '🧠 Pass 2 — reasoning about graph structure… (~5-15s)'
    : 'Pass 2 — Building diagram…');

  var updatedActors = pipe.actors.filter(function(a){ return a.selected; }).map(function(a){ return a.name; });
  var effectiveActors = updatedActors.length >= 2 ? updatedActors : actors;
  var p2prompt = buildPass2Prompt(dtype, entities, effectiveActors);
  var p2opts = useThinkingP2
    ? { maxTokens: 12000, thinking: true, thinkingBudget: 8000 }
    : { maxTokens: 6000 };

  var apiKey = (document.getElementById('apikey') || {}).value || '';
  var model  = extractionResult.model_used;
  var p2result = await callAPI(apiKey, model, p2prompt, p2opts);
  logTokenPass('Pass 2', Math.ceil(p2prompt.length / 4), p2result.usage);

  // Accumulate Pass 2 tokens into extraction stats
  if (p2result.usage) {
    extractionResult.stats.pass_2.input  = p2result.usage.input_tokens  || 0;
    extractionResult.stats.pass_2.output = p2result.usage.output_tokens || 0;
  }
  extractionResult._raw_pass2 = p2result.clean || '';

  // Parse graph from Pass 2 response
  var graph = null;
  var fromSchema = false;
  try {
    var s2 = p2result.clean.indexOf('{');
    var e2 = p2result.clean.lastIndexOf('}');
    if (s2 === -1 || e2 === -1) throw new Error('no JSON object');
    var parsed = JSON.parse(p2result.clean.substring(s2, e2 + 1));
    if (!parsed.nodes || !Array.isArray(parsed.nodes)) throw new Error('no nodes array');
    graph = parsed;
    fromSchema = true;
  } catch(ex) {
    console.warn('buildGraph: Pass 2 JSON parse failed (' + ex.message + ') — raw Mermaid fallback path');
    return { _rawFallback: p2result.clean, fromSchema: false };
  }

  // ── Deterministic graph rules ────────────────────────────────────

  // 0. Defensive: strip null/undefined entries the LLM may return
  graph.nodes     = (graph.nodes     || []).filter(function(n){ return n && n.id; });
  graph.edges     = (graph.edges     || []).filter(function(e){ return e && e.from && e.to; });
  graph.subgraphs = (graph.subgraphs || []).filter(function(sg){ return sg && sg.id; });

  // 1. Node type normalisation
  var VALID_TYPES = ['start', 'end', 'step', 'decision', 'subprocess', 'note'];
  (graph.nodes || []).forEach(function(n) {
    var t = (n.type || 'step').toLowerCase();
    if (VALID_TYPES.indexOf(t) === -1) t = 'step';
    n.type = t;
  });

  // 2. Subprocess classDef mapping: subprocess nodes get 'stepCl' class, not stop
  //    (tracked on the node so graphToMermaid can use it)
  (graph.nodes || []).forEach(function(n) {
    if (n.type === 'subprocess') {
      n._classDef = 'stepCl';
    }
  });

  // 3. Single-exit Start rule: if >1 edge leaves a start node, keep only first
  var startNodes = (graph.nodes || []).filter(function(n){ return n.type === 'start'; });
  startNodes.forEach(function(sn) {
    var outEdges = (graph.edges || []).filter(function(e){ return e.from === sn.id; });
    if (outEdges.length > 1) {
      console.warn('buildGraph: Start node "' + sn.id + '" has ' + outEdges.length + ' exits — trimming to 1');
      var keep = outEdges[0];
      graph.edges = (graph.edges || []).filter(function(e){
        if (e.from !== sn.id) return true;
        return e === keep;
      });
    }
  });

  // 4. Edge label completeness check (flag, do not throw)
  var emptyLabelCount = 0;
  (graph.edges || []).forEach(function(e) {
    var fromNode = (graph.nodes || []).find(function(n){ return n.id === e.from; });
    if (fromNode && fromNode.type === 'decision' && !e.label) {
      emptyLabelCount++;
    }
  });
  if (emptyLabelCount > 0) {
    pipe.stats = pipe.stats || {};
    pipe.stats.emptyDecisionEdges = emptyLabelCount;
    console.warn('buildGraph: ' + emptyLabelCount + ' decision edge(s) have empty labels');
  }

  // 5. Actor lane validation: every node must have an actor from extractionResult.actors
  var knownActors = extractionResult.actors || [];
  (graph.nodes || []).forEach(function(n) {
    if (n.type === 'start' || n.type === 'end') return; // start/end can be lane-free
    if (n.lane && knownActors.indexOf(n.lane) === -1) {
      console.warn('buildGraph: node "' + n.id + '" has unknown lane "' + n.lane + '" — falling back to System');
      n.lane = 'System';
    } else if (!n.lane && dtype === 'swimlane') {
      n.lane = knownActors[0] || 'System';
    }
  });

  graph._fromSchema = true;
  return graph;
}

// ── v3.11.0: LLM Cache ────────────────────────────────────────────
// Writes/reads Pass 1 + Pass 2 raw LLM output to GitHub cache/ folder.
// Spec §B.3. Cache files are lightweight — prompt TEMPLATE + parameters, not full prompt text.
// PASS1_PROMPT_VERSION / PASS2_PROMPT_VERSION must increment when prompts change structurally.
var PASS1_PROMPT_VERSION = 'v3.1';  // bump minor on wording change, major on schema change
var PASS2_PROMPT_VERSION = 'v2.0';  // bump minor on wording change, major on schema change

// ── v3.11.3: Pre-Pass-1 context size threshold ────────────────────
// Estimated token count above which a warning is shown identifying which
// documents are contributing to the context. 1 token ≈ 4 chars.
// 4,000 tokens ≈ 16,000 chars — a reasonable ceiling for a single chapter.
var PASS1_CONTEXT_TOKEN_THRESHOLD = 4000;

var _LlmCache = (function() {

  function _cachePath(projSlug, slug, pass) {
    return 'data/charts/' + projSlug + '/cache/' + slug + '_pass' + pass + '.json';
  }

  // Write a pass cache file to GitHub
  async function write(projSlug, slug, pass, model, usage, rawText, parsedObj, parseSuccess, parseError) {
    if (!ghPAT() || !projSlug) return;
    var promptVersion = pass === 1 ? PASS1_PROMPT_VERSION : PASS2_PROMPT_VERSION;
    var payload = {
      slug:          slug,
      pass:          pass,
      model:         model,
      cachedAt:      new Date().toISOString(),
      inputTokens:   usage ? (usage.input_tokens  || 0) : 0,
      outputTokens:  usage ? (usage.output_tokens || 0) : 0,
      promptVersion: promptVersion,
      response: {
        rawText:    rawText,
        parsedJson: parseSuccess ? parsedObj : null,
      },
      parseSuccess:  parseSuccess,
      parseError:    parseError || null,
    };
    var path = _cachePath(projSlug, slug, pass);
    try {
      var existing = await ghRead(path);
      await ghWrite(path, JSON.stringify(payload, null, 2),
        'Cache: ' + slug + ' pass' + pass,
        existing ? existing.sha : undefined);
    } catch(e) {
      console.warn('LlmCache.write p' + pass + ' failed:', e.message);
    }
  }

  // Read a pass cache file from GitHub
  // Returns null if not found or if promptVersion mismatch / hash mismatch
  async function read(projSlug, slug, pass, currentFileHash) {
    if (!ghPAT() || !projSlug) return null;
    var promptVersion = pass === 1 ? PASS1_PROMPT_VERSION : PASS2_PROMPT_VERSION;
    var path = _cachePath(projSlug, slug, pass);
    try {
      var rec = await ghRead(path);
      if (!rec) return null;
      var cached = JSON.parse(rec.content);
      // Invalidate on prompt version mismatch
      if (cached.promptVersion !== promptVersion) {
        console.log('LlmCache p' + pass + ': prompt version mismatch (' + cached.promptVersion + ' vs ' + promptVersion + ') — skipping cache');
        return null;
      }
      // Invalidate on file hash mismatch (pass 1 only)
      if (pass === 1 && currentFileHash && cached.fileHash && cached.fileHash !== currentFileHash) {
        console.log('LlmCache p1: file hash changed — skipping cache');
        return null;
      }
      if (!cached.parseSuccess) {
        console.log('LlmCache p' + pass + ': cached parse failed — skipping');
        return null;
      }
      console.log('LlmCache p' + pass + ': cache hit for ' + slug);
      return cached;
    } catch(e) {
      return null;
    }
  }

  // §B.3.5: Write intermediate extraction cache
  async function writeExtraction(projSlug, slug, extraction) {
    if (!ghPAT() || !projSlug) return;
    var path = 'data/charts/' + projSlug + '/cache/' + slug + '_extraction.json';
    // Strip large raw text fields — store only the parsed intermediate result
    var payload = {
      slug:        slug,
      cachedAt:    new Date().toISOString(),
      source_title: extraction.source_title || '',
      model_used:  extraction.model_used || '',
      entities:    extraction.entities || [],
      decisions:   extraction.decisions || [],
      actors:      extraction.actors || [],
      keywords:    extraction.keywords || [],
      coverage:    extraction.coverage || {},
      toc:         extraction.toc || {},
    };
    try {
      var existing = await ghRead(path);
      await ghWrite(path, JSON.stringify(payload, null, 2), 'Extraction cache: ' + slug, existing ? existing.sha : undefined);
    } catch(e) { console.warn('extraction cache write:', e.message); }
  }

  return { write, read, writeExtraction };
})();

// ── v3.6.0: Orchestration ────────────────────────────────────────
async function convertSingle(apiKey, model, dtype, text) {
  setLoading(true, 'Generating ' + dtype + '\u2026');
  try {
    if (twoPassEnabled) {
      // Stage 1: extract
      var chartTitle = (document.getElementById('chart-name-input') || {}).value || '';
      var extraction = await runExtraction(apiKey, model, dtype, text, null, chartTitle || 'Untitled Document');
      pipe.extraction = extraction;

      // v3.11.0: write Pass 1 cache to GitHub + update DocumentRegistry
      var _cacheSlug = null;
      var _cacheProjSlug = currentProject ? currentProject.slug : null;
      if (_cacheProjSlug && extraction._entities_full) {
        var _chEntry = ChapterRegistry.getCurrent();
        var _chNum   = _chEntry ? _chEntry.chapterNum : '0';
        _cacheSlug = dedupeSlug(
          processSlug(_chNum, extraction.source_title || 'doc'),
          allSavedSlugs()
        );
        // Write cache (fire-and-forget — don't block rendering)
        _LlmCache.write(
          _cacheProjSlug, _cacheSlug, 1, model,
          extraction.stats.pass_1,
          extraction._raw_pass1 || '',
          extraction._entities_full,
          !!extraction._entities_full,
          null
        ).catch(function(e){ console.warn('p1 cache write:', e.message); });
        // §B.3.5: write intermediate extraction cache (_extraction.json)
        _LlmCache.writeExtraction(
          _cacheProjSlug, _cacheSlug, extraction
        ).catch(function(e){ console.warn('extraction cache write:', e.message); });
        // Update DocumentRegistry
        var _docId = _chEntry ? chapterSlug(_chEntry.chapterNum) : _cacheSlug;
        DocumentRegistry.markPassComplete(_docId, 1, null);
        // v3.11.1: glossary auto-population — fire-and-forget post-Pass-1 hook (spec §B.4.3)
        // Runs asynchronously so it never blocks diagram rendering.
        Promise.resolve().then(function() {
          _autoPopulateGlossary(extraction._entities_full, _cacheSlug, _cacheProjSlug);
        });
      }

      if (extraction._entities_full) {
        applyEntities(extraction._entities_full);
        buildEntityRegistry(extraction._entities_full);

        // Stage 2: build graph
        var graph = await buildGraph(extraction, dtype);
        pipe.graph = graph;

        // v3.11.0: write Pass 2 cache
        if (_cacheProjSlug && _cacheSlug && graph) {
          _LlmCache.write(
            _cacheProjSlug, _cacheSlug, 2, model,
            extraction.stats.pass_2,
            extraction._raw_pass2 || '',
            graph._fromSchema ? graph : null,
            !!(graph._fromSchema || graph._rawFallback),
            null
          ).catch(function(e){ console.warn('p2 cache write:', e.message); });
          var _docId2 = ChapterRegistry.getCurrent() ? chapterSlug(ChapterRegistry.getCurrent().chapterNum) : _cacheSlug;
          DocumentRegistry.markPassComplete(_docId2, 2, null);
          // Push updated registry to GitHub (fire-and-forget)
          DocumentRegistry.pushToGitHub().catch(function(e){ console.warn('registry push:', e.message); });
        }

        // Aggregate total token usage across all stages
        var totalUsage = {
          input_tokens:  (extraction.stats.pre_pass.input  || 0) +
                         (extraction.stats.pass_1.input    || 0) +
                         (extraction.stats.pass_2.input    || 0),
          output_tokens: (extraction.stats.pre_pass.output || 0) +
                         (extraction.stats.pass_1.output   || 0) +
                         (extraction.stats.pass_2.output   || 0),
        };
        // Back-fill prePassTokens for updateTokenStatus display
        pipe.stats = pipe.stats || {};
        pipe.stats.prePassTokens = extraction.stats.pre_pass;

        // Stage 3: render
        var mmd, fromSchema = false;
        if (graph && graph._fromSchema) {
          mmd = graphToMermaid(graph, dtype);
          fromSchema = true;
        } else if (graph && graph._rawFallback) {
          mmd = sanitiseLabels(repairMermaid(graph._rawFallback));
        } else {
          mmd = null;
        }

        if (mmd) {
          var coloured = injectColours(normaliseMermaidLabels(mmd));
          validateGeneratedDiagram(coloured, dtype);
          logTokenPass('Two-pass',
            Math.ceil(((pipe.clean || '').length) / 4),
            totalUsage);
          document.getElementById('mermaid-editor').value = coloured;
          await renderMermaid(coloured);
          pushHistory(coloured, dtype);
          doAutosave();
          updateTokenStatus(totalUsage);
          // Transparency status line
          _showExtractionStatus(extraction);
          showToast(fromSchema ? '⊕ Schema → Mermaid compiled cleanly' : '⊕ Pass 2 fallback to raw Mermaid');
          return;
        }
      }
      showToast('Pass 1 extraction failed — falling back to single-pass generation');
    }

    // ── Single-pass path (no 2-Pass or Pass 1 failed) ─────────────
    var selectedActors = pipe.actors.filter(function(a){return a.selected;}).map(function(a){return a.name;});
    var prompt = getEffectivePrompt(dtype, text, selectedActors);
    var totalUsage2 = { input_tokens: 0, output_tokens: 0 };
    var result = await callAPI(apiKey, model, prompt);
    if (result.usage) { totalUsage2.input_tokens += result.usage.input_tokens || 0; totalUsage2.output_tokens += result.usage.output_tokens || 0; }
    var validated = await validateAndFixOutputType(result.clean, dtype, apiKey, model);
    var coloured  = injectColours(sanitiseLabels(repairMermaid(normaliseMermaidLabels(validated))));
    validateGeneratedDiagram(coloured, dtype);
    logTokenPass('Single-pass', Math.ceil(prompt.length / 4), totalUsage2);
    document.getElementById('mermaid-editor').value = coloured;
    await renderMermaid(coloured);
    pushHistory(coloured, dtype);
    doAutosave();
    updateTokenStatus(totalUsage2);
    setTimeout(function() { showLearnBanner(result.clean); }, 800);
  } catch(err) {
    handleAPIError(err, 'Generate');
    showChartPlaceholder();
  } finally {
    setLoading(false);
  }
}

// v3.7.0: _showExtractionStatus is redefined in the v3.7.0 settings/analysis block (later in this file).

async function convertChunked(apiKey, model, dtype) {
  var chunks = pipe.chunks;
  var actors = pipe.actors.filter(function(a){return a.selected;}).map(function(a){return a.name;});
  var total  = chunks.length;

  // Show progress bar
  var prog     = document.getElementById('chunk-progress');
  var progBar  = document.getElementById('chunk-progress-bar');
  var progStat = document.getElementById('chunk-progress-status');
  var progTitle= document.getElementById('chunk-progress-title');
  prog.style.display = 'flex';
  progTitle.textContent = 'Converting ' + total + ' chunks\u2026';

  var subgraphs = [];
  var totalInputTokens = 0, totalOutputTokens = 0;
  var allRaw = '';

  try {
    for (var i = 0; i < chunks.length; i++) {
      var chunk  = chunks[i];
      var pct    = Math.round(((i) / total) * 100);
      progBar.style.width  = pct + '%';
      progStat.textContent = 'Chunk ' + (i+1) + ' of ' + total + ': ' + chunk.title.substring(0,40) + '\u2026';

      var chunkPrompt = buildChunkPrompt(dtype, chunk.text, actors, i, total, chunk.title);
      var result = await callAPI(apiKey, model, chunkPrompt);
      allRaw += result.clean + '\n';
      // Strip the flowchart header from subsequent chunks for stitching
      var subCode = result.clean
        .replace(/^flowchart\s+\w+\s*/i, '')
        .replace(/^graph\s+\w+\s*/i, '')
        .replace(/^sequenceDiagram\s*/i, '');
      subgraphs.push({ title: chunk.title, code: subCode });
      if (result.usage) {
        totalInputTokens  += result.usage.input_tokens;
        totalOutputTokens += result.usage.output_tokens;
      }
      await sleep(300); // brief pause to avoid rate limiting
    }

    progBar.style.width  = '100%';
    progStat.textContent = 'Stitching ' + total + ' sections\u2026';

    // Stitch subgraphs together
    var stitched = stitchChunks(dtype, subgraphs, actors);
    var validated = await validateAndFixOutputType(stitched, dtype, apiKey, model);
    var coloured = injectColours(sanitiseLabels(repairMermaid(validated)));
    validateGeneratedDiagram(coloured, dtype);  // v2.6.0
    document.getElementById('mermaid-editor').value = coloured;
    await renderMermaid(coloured);
    pushHistory(coloured, dtype);
    updateTokenStatus({ input_tokens: totalInputTokens, output_tokens: totalOutputTokens });
    setTimeout(function() { showLearnBanner(allRaw); }, 800);

  } catch(err) {
    handleAPIError(err, 'Chunked generate');
    showChartPlaceholder();
  } finally {
    prog.style.display = 'none';
    progBar.style.width = '0%';
  }
}

function buildChunkPrompt(dtype, chunkText, actors, idx, total, title) {
  var glossaryContext  = buildGlossaryContext();
  var outputContext    = buildOutputTemplateContext(chunkText);
  var entityContext    = buildEntityRegistryContext();  // v2.6.0
  var base =
    'Output ONLY valid Mermaid code — no explanation, no markdown backticks, nothing else.\n\n' +
    'NODE LABEL RULES: 2-4 words max, Verb+Noun format, Title Case, decisions as questions.\n';
  if (entityContext)   base += entityContext + '\n';
  if (glossaryContext) base += 'GLOSSARY:\n' + glossaryContext + '\n';
  if (outputContext)   base += 'OUTPUT TEMPLATES:\n' + outputContext + '\n';

  var isFirst = idx === 0;
  var isLast  = idx === total - 1;
  // Use [["Start"]] / [["End"]] (subroutine shape) for terminals — stadium ([Start]) crashes
  // inside subgraph blocks in Mermaid 10.6 when dtype === 'swimlane'
  var startNode = dtype === 'swimlane' ? '[["Start"]]' : '([Start])';
  var endNode   = dtype === 'swimlane' ? '[["End"]]'   : '([End])';
  var context = '\nThis is section ' + (idx+1) + ' of ' + total + ': "' + title + '".\n' +
    (isFirst ? 'Include a ' + startNode + ' terminal at the beginning.\n' : 'This section continues from a previous section — do NOT add a ' + startNode + ' terminal.\n') +
    (isLast  ? 'Include a ' + endNode   + ' terminal at the end.\n'       : 'End with a connector node labeled [Continues...] — do NOT add a ' + endNode + ' terminal.\n');

  if (dtype === 'flowchart' || dtype === 'swimlane') {
    var prefix = 'SEC' + (idx+1);
    return base + context +
      'Create a Mermaid flowchart TD for this section only.\n' +
      'Prefix ALL node IDs with "' + prefix + '_" to avoid conflicts when sections are merged (e.g. ' + prefix + '_A, ' + prefix + '_B).\n' +
      '- Use [Step] for steps, {Decision?} for decisions\n' +
      '- Use --> arrows, max 10 nodes\n' +
      '\nSection text:\n\n' + chunkText.slice(0, 3000);
  }

  if (dtype === 'sequence') {
    return base + context +
      'Create a Mermaid sequenceDiagram for this section only.\n' +
      'Participants: ' + (actors.length >= 2 ? actors.join(', ') : 'Customer, Agent, System') + '\n' +
      '- Use ->> for messages, -->> for responses\n' +
      '- Max 8 messages for this section\n' +
      '\nSection text:\n\n' + chunkText.slice(0, 3000);
  }

  return base + '\nSection text:\n\n' + chunkText.slice(0, 3000);
}

function stitchChunks(dtype, subgraphs, actors) {
  if (dtype === 'sequence') {
    var parts = actors.length >= 2 ? actors : ['Customer', 'Agent', 'System'];
    var out = 'sequenceDiagram\n';
    parts.forEach(function(a) { out += '  participant ' + a + '\n'; });
    subgraphs.forEach(function(sg, i) {
      out += '\n  Note over ' + (parts[0]||'Customer') + ': \u2015 ' + sg.title.substring(0,30) + ' \u2015\n';
      out += sg.code.trim() + '\n';
    });
    return out;
  }

  // For flowchart / swimlane: wrap each chunk in a labelled subgraph
  // and connect using the actual last→first node IDs (not just subgraph blocks)
  var out = 'flowchart TD\n';
  var sectionFirstNodes = [];
  var sectionLastNodes  = [];

  // Node definition regex — captures ID followed by shape opener
  var nodeDefRe = /\b([A-Za-z_][A-Za-z0-9_-]*)\s*(?:\[(?!\[)|\{|\(\[)/g;

  subgraphs.forEach(function(sg, i) {
    var safeTitle = sg.title.replace(/[^a-zA-Z0-9 _-]/g, '').substring(0, 30) || ('Section ' + (i+1));
    out += '\n  subgraph SEC' + (i+1) + ' ["' + safeTitle + '"]\n';
    sg.code.trim().split('\n').forEach(function(line) {
      if (line.trim()) out += '    ' + line + '\n';
    });
    out += '  end\n';

    // Collect all defined node IDs in order of appearance
    var allIds = [];
    var nm;
    sg.code.split('\n').forEach(function(l) {
      nodeDefRe.lastIndex = 0;
      while ((nm = nodeDefRe.exec(l)) !== null) {
        if (allIds.indexOf(nm[1]) === -1) allIds.push(nm[1]);
      }
    });
    sectionFirstNodes.push(allIds.length ? allIds[0]  : null);
    sectionLastNodes.push (allIds.length ? allIds[allIds.length - 1] : null);
  });

  // Connect sections: last real node of section N → first real node of section N+1
  out += '\n  %% Cross-section connections\n';
  for (var i = 0; i < subgraphs.length - 1; i++) {
    var from = sectionLastNodes[i];
    var to   = sectionFirstNodes[i + 1];
    if (from && to && from !== to) {
      out += '  ' + from + ' -->|continues| ' + to + '\n';
    }
  }

  return out;
}

/**
 * Make an Anthropic Claude API call with automatic retry on 429/503/529.
 * @param {string} apiKey - Anthropic API key (sk-ant-...)
 * @param {string} model  - Model slug, e.g. 'claude-haiku-4-5-20251001'
 * @param {string} prompt - Full prompt string (user role)
 * @param {Object|number} [options] - Options object {maxTokens, thinking, thinkingBudget, _attempt}
 *   or legacy attempt number for internal retry recursion.
 * @returns {Promise<{clean:string, usage:Object, hadThinking:boolean}>}
 */
async function callAPI(apiKey, model, prompt, options) {
  // options may be an object {maxTokens, thinking, thinkingBudget, _attempt} or a legacy attempt number
  var attempt = (typeof options === 'number') ? options : ((options && options._attempt) || 1);
  var opts    = (typeof options === 'object' && options !== null) ? options : {};

  var useThinking = options && typeof options === 'object' && options.thinking && model.includes('sonnet');
  var thinkingBudget = opts.thinkingBudget || 8000;
  var maxTokens = opts.maxTokens || 2000;
  // max_tokens must exceed budget_tokens (spec constraint)
  if (useThinking) maxTokens = Math.max(maxTokens, thinkingBudget + 2000);

  var body = {
    model:      model,
    max_tokens: maxTokens,
    messages:   [{ role: 'user', content: prompt }],
  };

  if (useThinking) {
    body.thinking    = { type: 'enabled', budget_tokens: thinkingBudget };
    body.temperature = 1; // required by API when thinking is enabled
  }

  var headers = {
    'Content-Type':   'application/json',
    'x-api-key':      apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };

  // interleaved-thinking-2025-05-14 required for claude-sonnet-4-6
  // (older extended-thinking-2025-02-19 only works with claude-3-7-sonnet)
  if (useThinking) {
    headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
  }

  var res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body),
  });

  // Retry on 529 overloaded, 503 service unavailable, 429 rate limit — exponential backoff
  if ((res.status === 529 || res.status === 503 || res.status === 429) && attempt <= 3) {
    var waitMs  = Math.pow(2, attempt) * 3000; // 6s, 12s, 24s
    var waitSec = Math.round(waitMs / 1000);
    console.warn('API ' + res.status + ' — retry ' + attempt + '/3 in ' + waitSec + 's');
    setLoading(true, 'API busy — retrying in ' + waitSec + 's… (' + attempt + '/3)');
    await new Promise(function(r){ setTimeout(r, waitMs); });
    // Build retry opts with incremented attempt counter
    var nextOpts = (typeof options === 'object' && options !== null)
      ? Object.assign({}, options, { _attempt: attempt + 1 })
      : attempt + 1;
    return callAPI(apiKey, model, prompt, nextOpts);
  }

  if (!res.ok) {
    var e = await res.json().catch(function(){ return {}; });
    throw new Error((e.error && e.error.message) || 'API error ' + res.status);
  }
  var data = await res.json();
  if (data.error) throw new Error(data.error.message);

  // Filter to type === 'text' blocks only — thinking blocks (type: 'thinking' or
  // 'redacted_thinking') come first in the content array and must be skipped.
  var raw = (data.content || [])
    .filter(function(b) { return b.type === 'text'; })
    .map(function(b) { return b.text || ''; })
    .join('');

  if (!raw.trim()) throw new Error('Empty response — please try again.');
  var clean = raw.replace(/```mermaid\s*/gi, '').replace(/```\s*/g, '').trim();

  // Auto-retry once if Mermaid syntax is clearly broken (attempt 1 only, non-thinking calls)
  if (attempt === 1 && !useThinking) {
    try {
      var firstLine = clean.trim().split('\n')[0].toLowerCase();
      var validStart = firstLine.startsWith('flowchart') || firstLine.startsWith('graph') ||
                       firstLine.startsWith('sequencediagram') || firstLine.startsWith('sequenceDiagram');
      if (!validStart) throw new Error('Missing diagram header');
    } catch(syntaxErr) {
      console.warn('Auto-retry: bad Mermaid syntax on attempt 1, retrying with fix prompt');
      var fixPrompt =
        'The following Mermaid code has a syntax error: ' + syntaxErr.message + '\n\n' +
        'BROKEN CODE:\n' + clean + '\n\n' +
        'Fix the syntax error and output ONLY the corrected valid Mermaid code. No explanation, no backticks.';
      return callAPI(apiKey, model, fixPrompt, 2);
    }
  }

  return { clean: clean, usage: data.usage, hadThinking: useThinking };
}

// ── Token logging ─────────────────────────────────────────────────
/**
 * Record token counts before/after a pass for display in the Logic tab.
 * Call with the prompt character count (pre) and API response usage.
 * @param {string} passName - e.g. 'Pass 1', 'Pass 2', 'Single-pass'
 * @param {number} beforeTokens - estimated input tokens before offloading
 * @param {object} usage - { input_tokens, output_tokens } from API response
 */
function logTokenPass(passName, beforeTokens, usage) {
  if (!pipe.tokenLog) pipe.tokenLog = [];
  var after = (usage && usage.input_tokens) || 0;
  var saved = beforeTokens > 0 ? Math.round((1 - after / beforeTokens) * 100) : 0;
  pipe.tokenLog.push({
    pass:   passName,
    before: beforeTokens,
    after:  after,
    output: (usage && usage.output_tokens) || 0,
    savedPct: Math.max(0, saved),
  });
  console.log('[tokens] ' + passName + ': before=' + beforeTokens + ' after=' + after +
    ' saved=' + Math.max(0, saved) + '%');
}

/**
 * Render the token log summary table into the Logic tab.
 * Called by renderLogicSnapshot() when the tab is active.
 * @returns {string} HTML table string
 */
function renderTokenLogTable() {
  var log = pipe.tokenLog || [];
  if (!log.length) return '<p style="color:var(--gray-400);font-size:11px;">No API calls yet this session.</p>';
  var rows = log.map(function(r) {
    return '<tr><td>' + r.pass + '</td>' +
      '<td style="text-align:right">' + (r.before || '—') + '</td>' +
      '<td style="text-align:right">' + r.after + '</td>' +
      '<td style="text-align:right">' + r.output + '</td>' +
      '<td style="text-align:right;color:var(--green-600);font-weight:600">' + r.savedPct + '%</td>' +
      '</tr>';
  }).join('');
  return '<table style="width:100%;border-collapse:collapse;font-size:11px;">' +
    '<thead><tr style="background:var(--gray-100)">' +
    '<th style="text-align:left;padding:4px 6px">Pass</th>' +
    '<th style="text-align:right;padding:4px 6px">Before ↑</th>' +
    '<th style="text-align:right;padding:4px 6px">After ↑</th>' +
    '<th style="text-align:right;padding:4px 6px">Output ↓</th>' +
    '<th style="text-align:right;padding:4px 6px">Saved</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

// ── Node label normalisation (post-generation, no API call) ──────
// Lookup table of common iGaming CS terms → canonical display labels.
// Applied deterministically after every callAPI() response before render.
var NODE_LABEL_NORMALISE_MAP = {
  // KYC / Identity
  'KYC':                 'KYC Verification',
  'kyc':                 'KYC Verification',
  'AML':                 'AML Check',
  'aml':                 'AML Check',
  '2FA':                 'Two-Factor Auth',
  '2fa':                 'Two-Factor Auth',
  'MFA':                 'Multi-Factor Auth',
  'OTP':                 'One-Time Password',
  // Payment
  'PSP':                 'Payment Provider',
  'psp':                 'Payment Provider',
  'FTD':                 'First Deposit',
  'ftd':                 'First Deposit',
  'WD':                  'Withdrawal',
  'DEP':                 'Deposit',
  // Account
  'DOB':                 'Date of Birth',
  'PEP':                 'Politically Exposed',
  'RG':                  'Responsible Gaming',
  'Self-Excl':           'Self-Exclusion',
  'Self Excl':           'Self-Exclusion',
  // CS operations
  'CS':                  'Customer Support',
  'CRM':                 'CRM System',
  'SLA':                 'SLA Threshold',
  'T&C':                 "Terms & Conditions",
  'T and C':             'Terms & Conditions',
  'Fraud Dept':          'Fraud Team',
  'Fraud dept':          'Fraud Team',
  'SM':                  'Senior Manager',
  'TL':                  'Team Lead',
  'VIP Mgr':             'VIP Manager',
  // Status labels
  'Pend':                'Pending',
  'Approv':              'Approved',
  'Declin':              'Declined',
  'Verif':               'Verified',
};

/**
 * Post-process Mermaid code to normalise iGaming CS node labels.
 * Replaces abbreviated or inconsistent terms with canonical forms.
 * @param {string} code - Mermaid code string
 * @returns {string} Normalised code
 */
function normaliseMermaidLabels(code) {
  if (!code) return code;
  Object.keys(NODE_LABEL_NORMALISE_MAP).forEach(function(abbr) {
    var canonical = NODE_LABEL_NORMALISE_MAP[abbr];
    // Match inside node label delimiters: ["..."], {...}, [...], (["..."]) etc.
    // Use word boundaries to avoid partial replacements
    var escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp('\\b' + escaped + '\\b', 'g');
    code = code.replace(re, canonical);
  });
  return code;
}

function updateTokenStatus(usage) {
  var model = document.getElementById('model-select').value;
  var prePass = (pipe.stats && pipe.stats.prePassTokens)
    ? ' · Pre-pass: \u2191' + (pipe.stats.prePassTokens.input || 0).toLocaleString() +
      '/\u2193' + (pipe.stats.prePassTokens.output || 0).toLocaleString()
    : '';
  document.getElementById('api-status').textContent =
    '\u2191 ' + usage.input_tokens.toLocaleString() + ' / \u2193 ' + usage.output_tokens.toLocaleString() + ' tokens' + prePass;
  addSessionCost(model, usage.input_tokens || 0, usage.output_tokens || 0);
}

// ── MMD Export ────────────────────────────────────────────────────
function exportMMD() {
  var code = document.getElementById('mermaid-editor').value.trim();
  if (!code) { showToast('No Mermaid code to export'); return; }
  var blob = new Blob([code], { type: 'text/plain' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'flowchart.mmd';
  a.click();
  showToast('Downloaded flowchart.mmd');
}

// ── Share via URL ─────────────────────────────────────────────────
function shareViaURL() {
  var code = document.getElementById('mermaid-editor').value.trim();
  if (!code) { showToast('No chart to share — generate one first'); return; }
  try {
    // Compress with base64 encoding of URI-encoded string
    var encoded = btoa(unescape(encodeURIComponent(code)));
    var url = window.location.origin + window.location.pathname + '?c=' + encoded;
    _showShareBanner('⇗ Share this chart', url);
  } catch(e) {
    showToast('Could not generate share URL: ' + e.message);
  }
}

// Share the current project's Map view as a URL hash link.
// Recipients open the link and the app auto-navigates to the Map tab
// for that project, pulling data from GitHub (public read) as needed.
function shareProjectMapURL() {
  if (typeof currentProject === 'undefined' || !currentProject) {
    showToast('Select a project first — use the PROJECT selector in the config bar');
    return;
  }
  var base = window.location.origin + window.location.pathname;
  var hash = 'project=' + encodeURIComponent(currentProject.slug) + '&view=map';
  var url  = base + '#' + hash;
  _showShareBanner('⇗ Share project map — ' + currentProject.name, url);
}

function _showShareBanner(title, url) {
  var banner = document.getElementById('share-banner');
  var h4     = banner ? banner.querySelector('h4') : null;
  if (h4) h4.textContent = title;
  document.getElementById('share-url').value = url;
  if (banner) banner.style.display = 'block';
}

function copyShareURL() {
  var url = document.getElementById('share-url').value;
  navigator.clipboard.writeText(url).then(function() {
    showToast('Share URL copied to clipboard');
    document.getElementById('share-banner').style.display = 'none';
  });
}

// ── Shared-link bootstrap on startup ─────────────────────────────
// Handles two URL patterns on page load:
//   1. ?c=<base64>          — single chart (legacy, unchanged)
//   2. #project=<slug>&view=map — project Map view deep-link (v4.1.0)
function loadSharedChart() {
  // Pattern 1: single chart via query param
  try {
    var params  = new URLSearchParams(window.location.search);
    var encoded = params.get('c');
    if (encoded) {
      var code = decodeURIComponent(escape(atob(encoded)));
      if (code.trim()) {
        var coloured = injectColours(code);
        document.getElementById('mermaid-editor').value = coloured;
        showToast('Shared chart loaded from URL');
        setTimeout(function() { renderMermaid(coloured); }, 500);
        return; // do not process hash if query param present
      }
    }
  } catch(e) {
    console.warn('Could not load shared chart from URL:', e);
  }

  // Pattern 2: project map deep-link via hash
  _loadSharedProjectView();
}

// Parse #project=<slug>&view=map from the URL hash and navigate.
// Called once on startup from loadSharedChart().
// For recipients who don't have the project in localStorage, this
// fetches data/projects.json and the process list from GitHub
// (public read — no PAT required for public repos) and merges them
// into localStorage before switching to the Map tab.
function _loadSharedProjectView() {
  var hash = window.location.hash.replace(/^#/, '');
  if (!hash) return;
  var parts = {};
  hash.split('&').forEach(function(seg) {
    var kv = seg.split('=');
    if (kv.length === 2) parts[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]);
  });
  var projSlug = parts['project'];
  var view     = parts['view'];
  if (!projSlug || view !== 'map') return;

  // Defer until the DOM + project selector are ready
  setTimeout(function() {
    _activateSharedProjectMap(projSlug);
  }, 600);
}

// Activate Map tab for projSlug, loading from GitHub if needed.
async function _activateSharedProjectMap(projSlug) {
  try {
    showToast('Loading project map…');

    // 1. Try to find project in localStorage
    var projects = (typeof getProjects === 'function') ? getProjects() : [];
    var proj     = projects.find(function(p) { return p.slug === projSlug; });

    // 2. If not found locally, fetch from GitHub (public read)
    if (!proj) {
      var result = await _ghReadPublic('data/projects.json');
      if (result) {
        var remote = JSON.parse(result);
        proj = remote.find(function(p) { return p.slug === projSlug; });
        if (proj) {
          // Merge into localStorage so the project selector shows it
          var local  = (typeof getProjects === 'function') ? getProjects() : [];
          var exists = local.find(function(p) { return p.slug === projSlug; });
          if (!exists) { local.push(proj); if (typeof putProjects === 'function') putProjects(local); }
        }
      }
    }

    if (!proj) {
      showToast('Project "' + projSlug + '" not found — is the repo public or is a GitHub PAT set?');
      return;
    }

    // 3. Select this project
    if (typeof currentProject !== 'undefined') window.currentProject = proj;
    var sel = document.getElementById('gh-project');
    if (sel) {
      // Ensure the option exists in the selector
      var opt = sel.querySelector('option[value="' + projSlug + '"]');
      if (!opt) {
        opt = document.createElement('option');
        opt.value = projSlug;
        opt.textContent = proj.name;
        sel.insertBefore(opt, sel.lastElementChild); // before "+ Create new project…"
      }
      sel.value = projSlug;
    }
    if (typeof saveLastProject === 'function') saveLastProject(projSlug);

    // 4. Sync ChapterRegistry for this project
    if (typeof ChapterRegistry !== 'undefined') ChapterRegistry.restoreFromStorage(projSlug);

    // 5. If local saved list is empty for this project, attempt GitHub fetch
    var saved = (typeof getSaved === 'function') ? getSaved() : [];
    var hasLocal = saved.some(function(c) {
      return (c.meta && c.meta.project === projSlug) || (c.slug && c.slug.startsWith(projSlug + '-'));
    });
    if (!hasLocal) {
      await _mergeChartsFromGitHub(projSlug);
    }

    // 6. Navigate to Analysis → Map tab
    if (typeof switchRightTab === 'function') switchRightTab('analysis');
    // Small delay so renderAnalysisDashboard renders the container first
    setTimeout(function() {
      if (typeof _activateAnPill === 'function') _activateAnPill('map');
    }, 200);

    showToast('✓ Project map loaded: ' + proj.name);
  } catch(e) {
    console.warn('_activateSharedProjectMap failed:', e);
    showToast('Could not load project map: ' + e.message);
  }
}

// Fetch from GitHub without requiring a PAT (works for public repos).
// Returns decoded content string or null.
async function _ghReadPublic(path) {
  try {
    var base    = 'https://api.github.com/repos/' + GH_REPO + '/contents/';
    var branch  = typeof GH_BRANCH !== 'undefined' ? GH_BRANCH : 'main';
    var headers = { 'Accept': 'application/vnd.github.v3+json' };
    var pat     = (typeof ghPAT === 'function') ? ghPAT() : '';
    if (pat) headers['Authorization'] = 'token ' + pat;
    var res = await fetch(base + path + '?ref=' + branch, { headers: headers });
    if (!res.ok) return null;
    var data = await res.json();
    return decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
  } catch(e) { return null; }
}

// Fetch all .json sidecars for a project from GitHub and merge into localStorage.
// This lets recipients of a shared map link see the process corpus.
async function _mergeChartsFromGitHub(projSlug) {
  try {
    var base    = 'https://api.github.com/repos/' + GH_REPO + '/contents/';
    var branch  = typeof GH_BRANCH !== 'undefined' ? GH_BRANCH : 'main';
    var headers = { 'Accept': 'application/vnd.github.v3+json' };
    var pat     = (typeof ghPAT === 'function') ? ghPAT() : '';
    if (pat) headers['Authorization'] = 'token ' + pat;

    var dirRes = await fetch(base + 'data/charts/' + projSlug + '/processes?ref=' + branch, { headers: headers });
    if (!dirRes.ok) return;
    var files = await dirRes.json();
    if (!Array.isArray(files)) return;

    var jsonFiles = files.filter(function(f) { return f.name.endsWith('.json'); });
    if (!jsonFiles.length) return;

    var saved = (typeof getSaved === 'function') ? getSaved() : [];
    var changed = false;

    for (var i = 0; i < jsonFiles.length; i++) {
      var f = jsonFiles[i];
      var slug = f.name.replace('.json', '');
      var already = saved.find(function(c) { return (c.slug || '') === slug; });
      if (already) continue;

      // Fetch the sidecar JSON
      var jRes = await fetch(f.download_url);
      if (!jRes.ok) continue;
      var meta = await jRes.json();

      // Fetch the .mmd
      var mmdUrl = f.download_url.replace('.json', '.mmd');
      var mRes   = await fetch(mmdUrl);
      var code   = mRes.ok ? await mRes.text() : '';

      saved.push({
        slug:     slug,
        name:     meta.name || slug,
        code:     code,
        meta:     meta,
        savedAt:  meta.savedAt || new Date().toISOString(),
        version:  meta.version || 1,
        isDraft:  false,
        fromGitHub: true,
      });
      changed = true;
    }

    if (changed && typeof putSaved === 'function') putSaved(saved);
  } catch(e) {
    console.warn('_mergeChartsFromGitHub:', e.message);
  }
}

// ── Prompt editor ─────────────────────────────────────────────────
var promptEditorOpen = false;

function togglePromptEditor() {
  promptEditorOpen = !promptEditorOpen;
  var toggle = document.getElementById('prompt-editor-toggle');
  var body   = document.getElementById('prompt-editor-body');
  toggle.classList.toggle('open', promptEditorOpen);
  body.classList.toggle('open', promptEditorOpen);
  // Populate preview with the actual prompt that will be sent (same text slice as convert)
  if (promptEditorOpen) {
    var dtype  = document.getElementById('diagram-type').value;
    var actors = pipe.actors.filter(function(a) { return a.selected; }).map(function(a) { return a.name; });
    var structInput = pipe.preparsed && pipe.preparsed.length
      ? buildStructuredContext(pipe.preparsed, pipe._currentToc).slice(0, 7000)
      : (pipe.clean || '').slice(0, 8000);
    var preview = buildPrompt(dtype, structInput || '(paste or load a document first)', actors);
    document.getElementById('prompt-preview').value = preview;
  }
}

// Get the prompt to use — either edited or freshly built
function getEffectivePrompt(dtype, text, actors) {
  if (promptEditorOpen) {
    var edited = document.getElementById('prompt-preview').value.trim();
    if (edited) return edited;
  }
  return buildPrompt(dtype, text, actors);
}

// ── Refine chart ──────────────────────────────────────────────────
async function refineChart() {
  var instruction = document.getElementById('refine-input').value.trim();
  if (!instruction) { showToast('Type a refinement instruction first'); return; }
  var currentCode = document.getElementById('mermaid-editor').value.trim();
  if (!currentCode) { showToast('No chart to refine — generate one first'); return; }
  var apiKey = (document.getElementById('apikey').value || '').trim()
            || localStorage.getItem('fc_apikey') || '';
  if (!apiKey) { showError('Enter your Anthropic API key in ⚙ Settings.'); return; }

  var model = document.getElementById('model-select').value;
  showError('');
  setLoading(true, 'Refining chart…');

  var glossaryContext = buildGlossaryContext();
  var currentFirst = currentCode.trim().split('\n')[0].trim().toLowerCase();
  var isSwimlane = currentFirst.startsWith('graph ');

  var swimlaneRules = isSwimlane
    ? '\n\nSWIMLANE RULES (this is a graph LR/TD with subgraph lanes — strictly apply):\n' +
      '  - TERMINALS: use [["Start"]] and [["End"]] — NEVER ([Start]) or ([End]) — the stadium shape crashes inside subgraph blocks\n' +
      '  - DECISIONS: every decision node {Question?} MUST have BOTH -->|Yes| and -->|No| branches\n' +
      '  - ARROWS: use  A -->|Label| B  syntax only — NEVER --Label--> or -- Label -->\n' +
      '  - LABELS in arrows: must be wrapped in pipes: -->|Yes|  -->|No|  — never bare words between arrows\n' +
      '  - STEPS: use ID["Label"] — NEVER put Yes/No/True/False as node label IDs\n' +
      '  - LANE MEMBERSHIP: keep nodes in the correct subgraph; cross-lane arrows go OUTSIDE all subgraphs\n' +
      '  - Do not add new subgraphs or lanes unless specifically asked\n'
    : '';

  var refinePrompt =
    'You are a Mermaid.js diagram expert. You will be given an existing Mermaid diagram and an instruction to modify it.\n' +
    'Output ONLY the updated valid Mermaid code — no explanation, no backticks, nothing else.\n' +
    (glossaryContext ? '\nGLOSSARY:\n' + glossaryContext + '\n' : '') +
    swimlaneRules +
    '\nNODE LABEL RULES (apply to all new/changed nodes):\n' +
    '  - 2-4 words max per label, Title Case, Verb+Noun format\n' +
    '  - Decisions: rephrase as a question ending in ?\n' +
    '  - Do NOT use markdown formatting, asterisks, or quotes inside labels\n' +
    '\nEXISTING DIAGRAM:\n' + currentCode +
    '\n\nINSTRUCTION: ' + instruction +
    '\n\nRules:\n' +
    '- Preserve the overall structure and existing nodes unless the instruction specifically requires changing them\n' +
    '- Keep node IDs stable where possible\n' +
    '- Do NOT output any classDef or class assignment lines — styling is applied post-generation\n' +
    '- Output the complete updated diagram, not just the changed parts\n' +
    '- Every decision node MUST have both a Yes and a No exit path';

  try {
    var result = await callAPI(apiKey, model, refinePrompt);
    var coloured = injectColours(sanitiseLabels(repairMermaid(result.clean)));
    document.getElementById('mermaid-editor').value = coloured;
    await renderMermaid(coloured);
    pushHistory(coloured, document.getElementById('diagram-type').value);
    document.getElementById('refine-input').value = '';
    showToast('Chart refined');
    if (result.usage) updateTokenStatus(result.usage);
  } catch(err) {
    handleAPIError(err, 'Refine');
  } finally {
    setLoading(false);
  }
}
function buildPrompt(dtype, text, actors) {
  var glossaryContext  = buildGlossaryContext();
  var outputContext    = buildOutputTemplateContext(text || (pipe.clean || ''));
  var entityContext    = buildEntityRegistryContext();  // v2.6.0
  var structuredInput  = pipe.preparsed && pipe.preparsed.length
    ? buildStructuredContext(pipe.preparsed, pipe._currentToc)
    : null;

  // Auto-scale max nodes based on document complexity
  var nodeCount = pipe.preparsed && pipe.preparsed.length
    ? estimateNodeCount(pipe.preparsed)
    : (text.length < 2000 ? 8 : text.length < 5000 ? 15 : 22);

  var base =
    'Output ONLY valid Mermaid code — no explanation, no markdown backticks, nothing else.\n' +
    'STRICT OUTPUT FORMAT: Output ONLY node definitions and edge arrows.\n' +
    'NO classDef lines. NO class assignment lines. NO subgraph wrappers (unless swimlane).\n' +
    'NO preamble. NO explanation. NO backticks.\n\n' +
    'NODE LABEL RULES — apply to every node without exception:\n' +
    '  1. SHORT: 2-4 words maximum per label\n' +
    '  2. FORMAT: Verb + Noun — "Verify Identity", "Send Email", "Check Balance"\n' +
    '  3. DECISIONS: rephrase as a Question — "ID Verified?", "Over Limit?"\n' +
    '  4. TERMINALS: use ([Start]) for entry and ([End]) for all exit nodes in flowcharts — exact words required for colour coding\n' +
    '     EXCEPTION — for swim lane (graph LR/TD): use [["Start"]] and [["End"]] — the stadium shape ([...]) crashes inside subgraph blocks\n' +
    '  5. ACRONYMS: expand if in glossary, keep if widely understood (KYC, PSP)\n' +
    '  6. SPECIFICITY: preserve key domain terms; do not genericise\n' +
    '  7. TITLE CASE: Capitalise Each Word\n\n' +
    'ARROW LABEL RULES:\n' +
    '  - Only label arrows at decision branches: -->|Yes|  -->|No|  -->|Timeout|\n' +
    '  - Label handoff arrows between actors/lanes: -->|Submits Form|\n' +
    '  - All other arrows: no label (leave blank)\n' +
    '  - Arrow labels: 1-3 words max\n\n';

  if (entityContext) {
    base += entityContext + '\n\n';
  }

  if (glossaryContext) {
    base += 'GLOSSARY (expand these in labels where relevant):\n' + glossaryContext + '\n\n';
  }

  if (outputContext) {
    base += 'OUTPUT TEMPLATES (canonical node sequences for these known processes — follow them closely):\n' + outputContext + '\n\n';
  }

  // If pre-parse is available, use structured input instead of raw text
  var docSection;
  if (structuredInput) {
    docSection =
      'The document has been pre-parsed into tagged elements. Map them to Mermaid as follows:\n' +
      '  [HEADING]    → subgraph section name\n' +
      '  [PROCESS]    → top-level named subgraph (major process boundary)\n' +
      '  [SUBPROCESS] → nested subgraph within the enclosing process\n' +
      '  [CLUSTER]    → subgraph grouping for related steps\n' +
      '  [STEP]       → process node [Verb Noun]\n' +
      '  [DECISION]   → decision diamond {Question?} with Yes/No branches\n' +
      '  [CONDITION]  → arrow label or decision node\n' +
      '  [OUTCOME]    → terminal node or final step\n' +
      '  [POLICY]     → Note annotation over relevant actor (not a flow node)\n' +
      '  [ACTOR]      → swim lane name if using swimlane mode\n' +
      '  [NOTE]       → omit unless critical to understanding flow\n\n' +
      'PRE-PARSED DOCUMENT:\n' + structuredInput.slice(0, 7000);
  } else {
    docSection = 'Convert this document:\n\n' + text.slice(0, 8000);
  }

  if (dtype === 'flowchart') {
    return base +
      'Create a Mermaid flowchart TD. Max ' + nodeCount + ' nodes.\n' +
      '  - Terminals: A([Start]) and Z([End])\n' +
      '  - Steps:     B[Verb Noun]\n' +
      '  - Decisions: C{Question?} with -->|Yes| and -->|No| branches\n' +
      '  - Group phases with: subgraph "Phase Name" ... end\n' +
      '  - Every path must end at a terminal — no dead ends\n\n' + docSection;
  }

  if (dtype === 'swimlane') {
    var lanes = actors.length >= 2 ? actors : ['Player', 'Agent', 'System'];
    var prefixes = lanes.map(function(l, i) { return l.substring(0,2).toUpperCase() + (i+1); });
    var orient = (document.getElementById('lane-orient') || {value:'LR'}).value;
    var ownershipRules = lanes.map(function(l) {
      var name = l.toLowerCase();
      if (name === 'player' || name === 'customer' || name === 'client' || name === 'patient')
        return l + ': initiating actions only — what the ' + l + ' requests, submits, or triggers';
      if (name === 'agent' || name === 'advisor' || name === 'support' || name === 'clinician')
        return l + ': core handling steps — verification, decisions, responses, escalations';
      if (name === 'system' || name === 'platform' || name === 'kyc')
        return l + ': automated actions only — system checks, notifications, status updates';
      if (name === 'finance' || name === 'payment' || name === 'cashier')
        return l + ': payment processing, transaction verification, fund transfers';
      if (name === 'manager' || name === 'supervisor' || name === 'compliance')
        return l + ': escalation decisions, approvals, policy overrides';
      return l + ': actions owned by ' + l;
    }).join('\n  ');
    return base +
      'Create a Mermaid swim lane diagram using: graph ' + orient + '\n' +
      '(Use "graph ' + orient + '" — do NOT use "flowchart")\n' +
      'Lanes (declared in this order): ' + lanes.join(', ') + '\n' +
      'Node ID prefixes: ' + prefixes.join(', ') + '\n' +
      '\nLane ownership rules — strictly enforce:\n  ' + ownershipRules + '\n' +
      '\nIMPORTANT:\n' +
      '  - NEVER put customer-facing steps in the System lane\n' +
      '  - NEVER put agent processing steps in the Player lane\n' +
      '  - Lines tagged [actor:X] MUST go in the X lane\n' +
      '  - Untagged steps belong in the Agent lane by default (not System)\n' +
      '  - Each lane: subgraph LaneName ... end\n' +
      '  - Cross-lane arrows show handoffs: -->|Action label|\n' +
      '  - Start node in ' + lanes[0] + ' lane, End node in the lane that closes the process\n' +
      '  - TERMINALS: use [["Start"]] for entry and [["End"]] for exit — DO NOT use ([Start]) or ([End]) — the stadium shape crashes inside subgraphs in this Mermaid version\n' +
      '  - Steps: ID["Label"] — Decisions: ID{"Question?"}\n' +
      '  - Max ' + Math.ceil(nodeCount / lanes.length) + ' nodes per lane\n\n' + docSection;
  }

  if (dtype === 'sequence') {
    var parts = actors.length >= 2 ? actors : ['Customer', 'Agent', 'System'];
    return base +
      'Create a Mermaid sequenceDiagram.\n' +
      'Participants: ' + parts.join(', ') + '\n' +
      '  - Messages: ->> (solid), Responses: -->> (dashed)\n' +
      '  - Message text: Verb Noun, max 5 words\n' +
      '  - Note over X: Brief state annotation\n' +
      '  - alt/else/end for conditions, loop N times ... end for repeats\n' +
      '  - Max ' + Math.min(20, nodeCount) + ' messages\n\n' + docSection;
  }

  return base + docSection;
}

// ══════════════════════════════════════════════════════════════════
// ── GLOSSARY SYSTEM ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Storage keys
var GLOSSARY_KEY         = 'fc_glossary_v1';       // Global glossary (all projects)
var GLOSSARY_PROJECT_KEY = 'fc_glossary_project_v1'; // Project glossaries map {slug: [terms]}
var OUTPUT_GLOSSARY_KEY  = 'fc_output_glossary_v1';  // Output templates
var g_editingId          = null;   // ID of term currently being edited (global/project)
var g_currentTier        = 'global'; // 'global' | 'project' | 'output'
var og_editingId         = null;   // ID of output-template being edited

// ── Global glossary ───────────────────────────────────────────────
// [ { id, term, expansion, type, domain, addedAt, source } ]
// source: 'manual' | 'learned' | 'seed' | 'mixed-learned'

function getGlossary() {
  try { return JSON.parse(localStorage.getItem(GLOSSARY_KEY) || '[]'); }
  catch(e) { return []; }
}
function putGlossary(terms) {
  localStorage.setItem(GLOSSARY_KEY, JSON.stringify(terms));
}

// ── Project glossary ──────────────────────────────────────────────
// Stored as { slug: [terms] }

function getProjectGlossaries() {
  try { return JSON.parse(localStorage.getItem(GLOSSARY_PROJECT_KEY) || '{}'); }
  catch(e) { return {}; }
}
function putProjectGlossaries(map) {
  localStorage.setItem(GLOSSARY_PROJECT_KEY, JSON.stringify(map));
}
function getProjectGlossary(slug) {
  if (!slug) return [];
  var map = getProjectGlossaries();
  return map[slug] || [];
}
function putProjectGlossary(slug, terms) {
  if (!slug) return;
  var map = getProjectGlossaries();
  map[slug] = terms;
  putProjectGlossaries(map);
}
