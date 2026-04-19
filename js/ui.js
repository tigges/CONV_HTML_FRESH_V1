// ══════════════════════════════════════════════════════════════════
// Flowinject v4.0 — ui.js — Glossary, History, Analysis dashboard, AutoSave, GitHub, Projects, init
// Part of the modular refactor from monolithic index.html (v3.12.2)
// All functions remain global-scope for backward compatibility.
// ══════════════════════════════════════════════════════════════════


// ── v3.11.1: Glossary auto-population (spec §B.4.3) ──────────────
// Called as a fire-and-forget hook after Pass 1 completes in convertSingle().
// Never blocks the main pipeline. Updates the project glossary in localStorage.
//
// What it extracts from entities:
//   - step labels (all types: step, decision, subprocess, outcome)
//   - actor names
//   - exceptions[] entries
//
// For each candidate term:
//   - If it already exists in the project glossary: add processSlug to seenInSlugs (dedup)
//   - If it already exists in the global glossary: skip (global takes precedence)
//   - Otherwise: add to project glossary as confirmed:false
//
// Filters: skip terms < 3 chars, pure numbers, common stop words.
function _autoPopulateGlossary(entities, processSlug, projectSlug) {
  if (!entities || !projectSlug) return;

  var STOP = new Set([
    'start','end','yes','no','and','the','for','with','via','per','of','a','to',
    'in','by','as','on','at','an','is','or','not','from','if','then','else',
    'step','process','check','review','action','item','done','next','back',
  ]);

  // Collect candidate raw strings from the entity payload
  var candidates = [];

  // Step labels
  (entities.steps || []).forEach(function(s) {
    if (s.label) candidates.push({ term: s.label.trim(), type: 'term', source: 'label' });
  });
  // Actor names
  (entities.actors || []).forEach(function(a) {
    if (a) candidates.push({ term: String(a).trim(), type: 'actor', source: 'actor' });
  });
  // Exceptions text (each exception may contain a useful abbreviated term)
  (entities.exceptions || []).forEach(function(ex) {
    if (ex) candidates.push({ term: String(ex).trim().split(/[\s,;:.]+/)[0], type: 'term', source: 'exception' });
  });

  // Normalise: keep only "interesting" tokens — acronyms (all-caps 2-6 chars) and
  // multi-word title-case phrases (3+ chars, not stop words).
  var toProcess = [];
  candidates.forEach(function(c) {
    var raw = c.term;
    if (!raw || raw.length < 2) return;

    // Acronym pattern: 2–6 uppercase letters (e.g. KYC, ARN, PSP, NR1)
    var acronymMatch = raw.match(/^[A-Z0-9]{2,6}$/);
    if (acronymMatch) {
      toProcess.push({ term: raw, type: c.type, source: c.source });
      return;
    }

    // Multi-word phrase: use the full label if it has at least 2 words and isn't trivial
    var words = raw.split(/\s+/);
    if (words.length >= 2) {
      var key = raw.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      if (key.length >= 3 && !STOP.has(key)) {
        toProcess.push({ term: raw, type: c.type, source: c.source });
      }
      return;
    }

    // Single word: only if it looks domain-specific (≥4 chars, not a stop word)
    var w = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (w.length >= 4 && !STOP.has(w)) {
      toProcess.push({ term: raw, type: c.type, source: c.source });
    }
  });

  if (!toProcess.length) return;

  // Deduplicate by lowercase term
  var seen = {};
  toProcess = toProcess.filter(function(c) {
    var k = c.term.toLowerCase();
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });

  // Load existing glossaries
  var globalTerms  = getGlossary();
  var projTerms    = getProjectGlossary(projectSlug);
  var globalKeys   = new Set(globalTerms.map(function(t){ return t.term.toLowerCase(); }));
  var projIndex    = {};
  projTerms.forEach(function(t){ projIndex[t.term.toLowerCase()] = t; });

  var added   = 0;
  var updated = 0;
  var now     = new Date().toISOString();

  toProcess.forEach(function(c) {
    var key = c.term.toLowerCase();

    // Skip terms that are already in the global glossary — no duplication
    if (globalKeys.has(key)) return;

    var existing = projIndex[key];
    if (existing) {
      // Increment seenInSlugs (dedup)
      if (processSlug) {
        if (!Array.isArray(existing.seenInSlugs)) existing.seenInSlugs = [];
        if (existing.seenInSlugs.indexOf(processSlug) === -1) {
          existing.seenInSlugs.push(processSlug);
          existing.updatedAt = now;
          updated++;
        }
      }
    } else {
      // New project-scoped term — confirmed: false until user reviews
      var newEntry = {
        id:           makeId(),
        term:         c.term,
        expansion:    '',          // user fills in later
        type:         c.type === 'actor' ? 'actor' : 'term',
        domain:       (currentProject && currentProject.cluster) ? currentProject.cluster : 'general',
        addedAt:      now,
        updatedAt:    now,
        source:       'learned',
        confirmed:    false,
        firstSeenIn:  processSlug || '',
        seenInSlugs:  processSlug ? [processSlug] : [],
      };
      projTerms.push(newEntry);
      projIndex[key] = newEntry;
      added++;
    }
  });

  if (added > 0 || updated > 0) {
    putProjectGlossary(projectSlug, projTerms);
    console.log('Glossary auto-populate: +' + added + ' new, ' + updated + ' updated (project: ' + projectSlug + ')');
    // Refresh glossary UI if it's currently visible
    if (g_currentTier === 'project') {
      try { renderGlossaryList(); } catch(e) {}
    }
  }
}

// ── Output glossary (templates) ───────────────────────────────────
// [ { id, processName, nodeSequence, diagramType, domain, addedAt } ]
// processName: e.g. "Withdrawal Request"
// nodeSequence: human-readable canonical step list
// diagramType: 'flowchart' | 'swimlane' | 'sequence' | 'any'

function getOutputGlossary() {
  try { return JSON.parse(localStorage.getItem(OUTPUT_GLOSSARY_KEY) || '[]'); }
  catch(e) { return []; }
}
function putOutputGlossary(templates) {
  localStorage.setItem(OUTPUT_GLOSSARY_KEY, JSON.stringify(templates));
}

function makeId() {
  return 'g' + Date.now() + Math.floor(Math.random() * 1000);
}

// ── Glossary tier switching ───────────────────────────────────────

function switchGlossaryTier(tier) {
  g_currentTier = tier;
  ['global','project','output'].forEach(function(t) {
    var btn = document.getElementById('gtier-' + t);
    if (btn) btn.classList.toggle('active', t === tier);
  });
  var toolbar = document.getElementById('g-toolbar-terms');
  var listEl   = document.getElementById('glossary-list');
  var formEl   = document.getElementById('g-add-form-container');
  var outPanel = document.getElementById('g-panel-output');

  if (tier === 'output') {
    if (toolbar)  toolbar.style.display  = 'none';
    if (listEl)   listEl.style.display   = 'none';
    if (formEl)   formEl.style.display   = 'none';
    if (outPanel) outPanel.style.display = 'flex';
    renderOutputGlossary();
  } else {
    if (toolbar)  toolbar.style.display  = '';
    if (listEl)   listEl.style.display   = '';
    if (formEl)   formEl.style.display   = '';
    if (outPanel) outPanel.style.display = 'none';
    renderGlossary();
  }
  updateGlossaryTierCounts();
}

function updateGlossaryTierCounts() {
  var globalCount  = getGlossary().length;
  var projSlug     = currentProject ? currentProject.slug : null;
  var projectCount = projSlug ? getProjectGlossary(projSlug).length : 0;
  var outputCount  = getOutputGlossary().length;
  var gc = document.getElementById('gtier-global-count');
  var pc = document.getElementById('gtier-project-count');
  var oc = document.getElementById('gtier-output-count');
  if (gc) gc.textContent = globalCount;
  if (pc) pc.textContent = projectCount;
  if (oc) oc.textContent = outputCount;
}

// ── Combined glossary access (for AI prompt context) ──────────────

function getAllTermsForContext() {
  var global  = getGlossary();
  var projSlug = currentProject ? currentProject.slug : null;
  var project  = projSlug ? getProjectGlossary(projSlug) : [];
  // Merge; project terms override global for same term+domain
  var merged = global.slice();
  project.forEach(function(pt) {
    var dupe = merged.findIndex(function(g) { return g.term === pt.term && g.domain === pt.domain; });
    if (dupe >= 0) merged[dupe] = pt; else merged.push(pt);
  });
  return merged;
}

// Build glossary context string for AI prompt
function buildGlossaryContext() {
  var terms  = getAllTermsForContext();
  var domain = getCurrentDomain();
  var relevant = terms.filter(function(t) {
    return t.domain === 'all' || t.domain === domain;
  });
  if (!relevant.length) return '';
  return relevant.map(function(t) {
    return '  ' + t.term + ' = ' + t.expansion + (t.type ? ' [' + t.type + ']' : '');
  }).join('\n');
}

// Build output template context string for AI prompt (if matching templates exist)
function buildOutputTemplateContext(text) {
  var templates = getOutputGlossary();
  if (!templates.length) return '';
  // Simple keyword match against processName
  var lower = (text || '').toLowerCase();
  var matched = templates.filter(function(t) {
    return lower.indexOf(t.processName.toLowerCase()) !== -1;
  });
  if (!matched.length) return '';
  return matched.map(function(t) {
    return '  Process: ' + t.processName +
      (t.diagramType && t.diagramType !== 'any' ? ' [preferred: ' + t.diagramType + ']' : '') +
      '\n  Expected node sequence:\n' +
      t.nodeSequence.split('\n').map(function(l) { return '    ' + l; }).join('\n');
  }).join('\n\n');
}

// ── Render glossary list ──────────────────────────────────────────
function renderGlossary() {
  var isProject = g_currentTier === 'project';
  var projSlug  = currentProject ? currentProject.slug : null;
  var terms     = isProject ? (projSlug ? getProjectGlossary(projSlug) : []) : getGlossary();

  var search  = (document.getElementById('g-search')       || {value:''}).value.toLowerCase();
  var fType   = (document.getElementById('g-filter-type')  || {value:''}).value;
  var fDomain = (document.getElementById('g-filter-domain')|| {value:''}).value;
  var list    = document.getElementById('glossary-list');
  if (!list) return;

  if (isProject && !projSlug) {
    list.innerHTML = '<div class="glossary-empty"><div class="icon">📁</div>' +
      '<p>Select a project first to manage project-specific terms.</p></div>';
    return;
  }

  // Filter
  var filtered = terms.filter(function(t) {
    var matchSearch = !search ||
      t.term.toLowerCase().indexOf(search) !== -1 ||
      (t.expansion || '').toLowerCase().indexOf(search) !== -1;
    var matchType   = !fType   || t.type   === fType;
    var matchDomain = !fDomain || t.domain === fDomain;
    return matchSearch && matchType && matchDomain;
  });

  if (!terms.length) {
    var tierLabel = isProject ? 'project' : 'global';
    list.innerHTML = '<div class="glossary-empty"><div class="icon">📖</div>' +
      '<p>No ' + tierLabel + ' terms yet. Click <strong>+ Add Term</strong> to build your glossary, ' +
      'or generate a chart and let the app suggest terms automatically.</p></div>';
    return;
  }

  if (!filtered.length) {
    list.innerHTML = '<div class="glossary-empty"><div class="icon">🔍</div>' +
      '<p>No terms match your filters.</p></div>';
    return;
  }

  // Sort: unconfirmed first (pending review), then alphabetical
  filtered.sort(function(a, b) {
    var aUnconf = a.confirmed === false ? 0 : 1;
    var bUnconf = b.confirmed === false ? 0 : 1;
    if (aUnconf !== bUnconf) return aUnconf - bUnconf;
    return a.term.localeCompare(b.term);
  });

  // Pending-review section header
  var pendingCount = filtered.filter(function(t){ return t.confirmed === false; }).length;
  var pendingHeader = (isProject && pendingCount > 0)
    ? '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--amber-700);padding:6px 10px 3px;display:flex;align-items:center;gap:6px;">' +
        '⚑ Pending review (' + pendingCount + ')' +
        '<span style="font-weight:400;color:var(--gray-400);">— auto-extracted from Pass 1. Confirm to keep, delete to discard.</span>' +
      '</div>'
    : '';

  var tierTag = isProject ? 'project' : 'global';
  var confirmedDividerShown = false;
  list.innerHTML = pendingHeader + filtered.map(function(t) {
    var domainLabel = t.domain === 'all' ? 'Global' : t.domain;
    var sourceTag   = '';
    if (t.source === 'learned')        sourceTag = '<span class="g-tag ref">auto-learned</span>';
    else if (t.source === 'mixed-learned') sourceTag = '<span class="g-tag mixed-learned">phrase-learned</span>';

    // Divider between unconfirmed and confirmed sections
    var divider = '';
    if (isProject && t.confirmed !== false && pendingCount > 0 && !confirmedDividerShown) {
      confirmedDividerShown = true;
      divider = '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--gray-400);padding:6px 10px 3px;">Confirmed terms</div>';
    }

    var isPending = isProject && t.confirmed === false;
    var rowStyle  = isPending ? 'border-color:var(--amber-200);background:var(--amber-50);' : '';
    var pendingBadge = isPending
      ? '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:var(--amber-100);color:var(--amber-700);border:1px solid var(--amber-200);margin-left:4px;">pending</span>'
      : '';
    var confirmBtn = isPending
      ? '<button class="btn-xs" onclick="confirmGlossaryTerm(\'' + t.id + '\')" title="Confirm this term" style="color:var(--green-700);">✓</button>'
      : '';
    var seenIn = (isPending && t.seenInSlugs && t.seenInSlugs.length)
      ? '<div style="font-size:10px;color:var(--gray-400);margin-top:1px;">seen in: ' + t.seenInSlugs.slice(0,3).map(escHtml).join(', ') + (t.seenInSlugs.length > 3 ? ' +' + (t.seenInSlugs.length - 3) + ' more' : '') + '</div>'
      : '';

    return divider +
      '<div class="glossary-row" id="grow-' + t.id + '" style="' + rowStyle + '">' +
        '<div class="g-term">' + escHtml(t.term) + pendingBadge + '</div>' +
        '<div class="g-body">' +
          '<div class="g-expansion">' + escHtml(t.expansion || '') + '</div>' +
          seenIn +
          '<div class="g-tags">' +
            (t.type   ? '<span class="g-tag ' + t.type   + '">'   + escHtml(t.type)        + '</span>' : '') +
            (t.domain ? '<span class="g-tag domain">'              + escHtml(domainLabel)   + '</span>' : '') +
            '<span class="g-tag ' + tierTag + '">' + tierTag + '</span>' +
            sourceTag +
          '</div>' +
        '</div>' +
        '<div class="g-actions">' +
          confirmBtn +
          '<button class="btn-xs" onclick="editTerm(\'' + t.id + '\')" title="Edit">✎</button>' +
          '<button class="btn-xs danger" onclick="deleteTerm(\'' + t.id + '\')" title="Delete">✕</button>' +
        '</div>' +
      '</div>';
  }).join('');

  updateGlossaryTierCounts();
}

// Alias used by _autoPopulateGlossary to refresh the visible list after a background update
function renderGlossaryList() { renderGlossary(); }

// ── v3.11.1: Confirm a pending auto-extracted term ────────────────
// Sets confirmed: true on the term and re-renders the glossary list.
function confirmGlossaryTerm(id) {
  var isProject = g_currentTier === 'project';
  var projSlug  = currentProject ? currentProject.slug : null;
  if (!isProject || !projSlug) return;
  var terms = getProjectGlossary(projSlug);
  var term  = terms.find(function(t){ return t.id === id; });
  if (!term) return;
  term.confirmed  = true;
  term.updatedAt  = new Date().toISOString();
  putProjectGlossary(projSlug, terms);
  renderGlossary();
  showToast('✓ Term confirmed: ' + term.term);
}

// ── Add / Edit form ───────────────────────────────────────────────
function showAddForm(prefillTerm, prefillExpansion) {
  g_editingId = null;
  renderGlossaryForm(prefillTerm || '', prefillExpansion || '', '', getCurrentDomain());
}

function editTerm(id) {
  var isProject = g_currentTier === 'project';
  var projSlug  = currentProject ? currentProject.slug : null;
  var terms     = isProject ? getProjectGlossary(projSlug) : getGlossary();
  var t = terms.find(function(x) { return x.id === id; });
  if (!t) return;
  g_editingId = id;
  renderGlossaryForm(t.term, t.expansion, t.type, t.domain);
}

function renderGlossaryForm(term, expansion, type, domain) {
  var container = document.getElementById('g-add-form-container');
  var tierLabel = g_currentTier === 'project' ? 'project' : 'global';
  container.innerHTML = '<div class="g-form" style="margin:8px 8px 0;">' +
    '<div style="font-size:10px;font-weight:700;color:var(--gray-400);margin-bottom:2px;text-transform:uppercase;letter-spacing:0.06em;">' +
      (g_editingId ? 'Editing' : 'New') + ' — ' + tierLabel + ' term' +
    '</div>' +
    '<div class="g-form-row">' +
      '<label>Term</label>' +
      '<input class="g-input mono" id="gf-term" placeholder="e.g. NR1" value="' + escHtml(term) + '" maxlength="60">' +
      '<label>Type</label>' +
      '<select class="g-select" id="gf-type">' +
        getGlossaryTypeOptions().map(function(o) {
          return '<option value="' + o.value + '"' + (type === o.value ? ' selected' : '') + '>' + o.label + '</option>';
        }).join('') +
      '</select>' +
      '<label>Domain</label>' +
      '<select class="g-select" id="gf-domain">' +
        [['all','Global'],['igaming','iGaming'],['generic','Generic'],
         ['banking','Banking'],['healthcare','Healthcare'],['ecommerce','E-commerce']].map(function(d) {
          return '<option value="' + d[0] + '"' + (domain === d[0] ? ' selected' : '') + '>' + d[1] + '</option>';
        }).join('') +
      '</select>' +
    '</div>' +
    '<div class="g-form-row">' +
      '<label>Expansion</label>' +
      '<input class="g-input" id="gf-expansion" placeholder="Full meaning, e.g. Not Registered / Unverified Player" value="' + escHtml(expansion) + '" maxlength="120">' +
    '</div>' +
    '<div class="g-form-btns">' +
      '<button class="btn-cancel" onclick="cancelGlossaryForm()">Cancel</button>' +
      '<button class="btn-save-confirm" onclick="saveGlossaryTerm()">' + (g_editingId ? 'Update' : 'Add Term') + '</button>' +
    '</div>' +
  '</div>';

  setTimeout(function() {
    var f = document.getElementById('gf-term');
    if (f) { f.focus(); if (!term) f.select(); }
  }, 50);

  container.querySelectorAll('.g-input').forEach(function(el) {
    el.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') saveGlossaryTerm();
      if (e.key === 'Escape') cancelGlossaryForm();
    });
  });
}

function cancelGlossaryForm() {
  document.getElementById('g-add-form-container').innerHTML = '';
  g_editingId = null;
}

function saveGlossaryTerm() {
  var isProject = g_currentTier === 'project';
  var projSlug  = currentProject ? currentProject.slug : null;
  if (isProject && !projSlug) { showToast('Select a project first'); return; }

  var term      = (document.getElementById('gf-term')      || {value:''}).value.trim();
  var expansion = (document.getElementById('gf-expansion') || {value:''}).value.trim();
  var type      = (document.getElementById('gf-type')      || {value:'ref'}).value;
  var domain    = (document.getElementById('gf-domain')    || {value:'all'}).value;

  // Normalise: ALL-CAPS if it looks like an acronym (all caps / digits / symbols only), else keep case
  if (/^[A-Z0-9&/_-]+$/.test(term.toUpperCase()) && term.length <= 10 && !/\s/.test(term)) {
    term = term.toUpperCase();
  }

  if (!term)      { showToast('Term (abbreviation) is required'); return; }
  if (!expansion) { showToast('Expansion (full meaning) is required'); return; }

  var terms = isProject ? getProjectGlossary(projSlug) : getGlossary();

  if (g_editingId) {
    var idx = terms.findIndex(function(t) { return t.id === g_editingId; });
    if (idx >= 0) {
      terms[idx].term      = term;
      terms[idx].expansion = expansion;
      terms[idx].type      = type;
      terms[idx].domain    = domain;
    }
    showToast('Updated: ' + term);
  } else {
    var existing = terms.find(function(t) { return t.term === term && t.domain === domain; });
    if (existing) { showToast(term + ' already exists in this domain — edit instead'); return; }
    terms.push({ id: makeId(), term: term, expansion: expansion, type: type, domain: domain, addedAt: Date.now(), source: 'manual' });
    showToast('Added: ' + term);
  }

  if (isProject) putProjectGlossary(projSlug, terms); else putGlossary(terms);
  cancelGlossaryForm();
  renderGlossary();
}

function deleteTerm(id) {
  var isProject = g_currentTier === 'project';
  var projSlug  = currentProject ? currentProject.slug : null;
  var terms     = (isProject ? getProjectGlossary(projSlug) : getGlossary()).filter(function(t) { return t.id !== id; });
  if (isProject) putProjectGlossary(projSlug, terms); else putGlossary(terms);
  renderGlossary();
  showToast('Term deleted');
}

// ── Import / Export (global + project) ───────────────────────────
function exportGlossary() {
  var isProject = g_currentTier === 'project';
  var projSlug  = currentProject ? currentProject.slug : null;
  var terms     = isProject ? getProjectGlossary(projSlug) : getGlossary();
  if (!terms.length) { showToast('Glossary is empty — nothing to export'); return; }
  var payload = {
    version: '1.0',
    tier: isProject ? 'project' : 'global',
    project: isProject ? (currentProject ? currentProject.name : projSlug) : null,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    terms: terms,
  };
  var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'flowchart-glossary-' + (isProject && projSlug ? projSlug + '-' : '') + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  showToast('Exported ' + terms.length + ' terms');
}

function importGlossary(e) {
  var file = e.target.files && e.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(ev) {
    try {
      var data     = JSON.parse(ev.target.result);
      var incoming = data.terms || data;
      if (!Array.isArray(incoming)) throw new Error('Invalid format');

      var isProject = g_currentTier === 'project';
      var projSlug  = currentProject ? currentProject.slug : null;
      if (isProject && !projSlug) { showToast('Select a project first to import project terms'); return; }

      var existing = isProject ? getProjectGlossary(projSlug) : getGlossary();
      var added = 0, skipped = 0;
      incoming.forEach(function(t) {
        if (!t.term || !t.expansion) { skipped++; return; }
        if (/^[A-Z0-9&/_-]+$/.test(t.term.toUpperCase()) && t.term.length <= 10 && !/\s/.test(t.term)) {
          t.term = t.term.toUpperCase();
        }
        t.id     = t.id || makeId();
        t.source = t.source || 'imported';
        var dupe = existing.find(function(x) { return x.term === t.term && x.domain === t.domain; });
        if (dupe) { skipped++; } else { existing.push(t); added++; }
      });
      if (isProject) putProjectGlossary(projSlug, existing); else putGlossary(existing);
      renderGlossary();
      showToast('Imported ' + added + ' terms' + (skipped ? ', ' + skipped + ' skipped (duplicates)' : ''));
    } catch(err) {
      showToast('Import failed: ' + err.message);
    }
    e.target.value = '';
  };
  reader.readAsText(file);
}

// ── Output Glossary (templates) ────────────────────────────────────

function renderOutputGlossary() {
  var templates = getOutputGlossary();
  var search    = (document.getElementById('og-search') || {value:''}).value.toLowerCase();
  var list      = document.getElementById('og-template-list');
  if (!list) return;

  var filtered = templates.filter(function(t) {
    return !search || t.processName.toLowerCase().indexOf(search) !== -1 ||
      (t.nodeSequence || '').toLowerCase().indexOf(search) !== -1;
  });

  if (!templates.length) {
    list.innerHTML = '<div class="og-empty">No output templates yet. Add canonical node sequences for known process types (e.g. "Withdrawal Request").</div>';
    updateGlossaryTierCounts();
    return;
  }
  if (!filtered.length) {
    list.innerHTML = '<div class="og-empty">No templates match your search.</div>';
    return;
  }

  filtered.sort(function(a, b) { return a.processName.localeCompare(b.processName); });

  list.innerHTML = filtered.map(function(t) {
    var diagramLabel = t.diagramType && t.diagramType !== 'any' ? t.diagramType : 'any type';
    var preview = (t.nodeSequence || '').split('\n').slice(0, 3).join(' → ');
    if ((t.nodeSequence || '').split('\n').length > 3) preview += ' …';
    return '<div class="og-template-row" id="ogrow-' + t.id + '">' +
      '<div class="og-proc-name">' + escHtml(t.processName) + '</div>' +
      '<div class="og-proc-body">' +
        '<div>' + escHtml(preview) + '</div>' +
        '<div class="og-proc-tags">' +
          '<span class="og-tag">' + escHtml(diagramLabel) + '</span>' +
          (t.domain ? '<span class="og-tag" style="background:var(--orange-50);color:var(--orange-600);border-color:var(--orange-200);">' + escHtml(t.domain) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="g-actions">' +
        '<button class="btn-xs" onclick="editOutputTemplate(\'' + t.id + '\')" title="Edit">✎</button>' +
        '<button class="btn-xs danger" onclick="deleteOutputTemplate(\'' + t.id + '\')" title="Delete">✕</button>' +
      '</div>' +
    '</div>';
  }).join('');

  updateGlossaryTierCounts();
}

function showAddOutputTemplate() {
  og_editingId = null;
  renderOutputTemplateForm('', '', 'any', getCurrentDomain());
}

function editOutputTemplate(id) {
  var t = getOutputGlossary().find(function(x) { return x.id === id; });
  if (!t) return;
  og_editingId = id;
  renderOutputTemplateForm(t.processName, t.nodeSequence, t.diagramType, t.domain);
}

function renderOutputTemplateForm(processName, nodeSequence, diagramType, domain) {
  var container = document.getElementById('og-add-form-container');
  container.innerHTML = '<div class="g-form" style="margin:0 0 10px;">' +
    '<div style="font-size:10px;font-weight:700;color:var(--gray-400);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.06em;">' +
      (og_editingId ? 'Editing' : 'New') + ' output template' +
    '</div>' +
    '<div class="g-form-row">' +
      '<label>Process Name</label>' +
      '<input class="g-input" id="ogf-name" placeholder="e.g. Withdrawal Request" value="' + escHtml(processName) + '" maxlength="80">' +
      '<label>Type</label>' +
      '<select class="g-select" id="ogf-dtype">' +
        [['any','Any'],['flowchart','Flowchart'],['swimlane','Swim Lane'],['sequence','Sequence']].map(function(d) {
          return '<option value="' + d[0] + '"' + (diagramType === d[0] ? ' selected' : '') + '>' + d[1] + '</option>';
        }).join('') +
      '</select>' +
      '<label>Domain</label>' +
      '<select class="g-select" id="ogf-domain">' +
        [['all','Global'],['igaming','iGaming'],['generic','Generic'],['banking','Banking'],['healthcare','Healthcare'],['ecommerce','E-commerce']].map(function(d) {
          return '<option value="' + d[0] + '"' + (domain === d[0] ? ' selected' : '') + '>' + d[1] + '</option>';
        }).join('') +
      '</select>' +
    '</div>' +
    '<div class="g-form-row" style="align-items:flex-start;">' +
      '<label style="margin-top:6px;">Node Sequence</label>' +
      '<textarea class="g-input" id="ogf-sequence" rows="5" placeholder="One step per line, in order:\nPlayer submits request\nAgent reviews details\nSystem validates limits\nFinance approves\nSystem processes payment" style="resize:vertical;font-size:11px;line-height:1.5;">' + escHtml(nodeSequence) + '</textarea>' +
    '</div>' +
    '<div class="g-form-btns">' +
      '<button class="btn-cancel" onclick="cancelOutputTemplateForm()">Cancel</button>' +
      '<button class="btn-save-confirm" onclick="saveOutputTemplate()">' + (og_editingId ? 'Update' : 'Add Template') + '</button>' +
    '</div>' +
  '</div>';

  setTimeout(function() {
    var f = document.getElementById('ogf-name');
    if (f) { f.focus(); }
  }, 50);
}

function cancelOutputTemplateForm() {
  document.getElementById('og-add-form-container').innerHTML = '';
  og_editingId = null;
}

function saveOutputTemplate() {
  var processName  = (document.getElementById('ogf-name')     || {value:''}).value.trim();
  var nodeSequence = (document.getElementById('ogf-sequence') || {value:''}).value.trim();
  var diagramType  = (document.getElementById('ogf-dtype')    || {value:'any'}).value;
  var domain       = (document.getElementById('ogf-domain')   || {value:'all'}).value;

  if (!processName)  { showToast('Process name is required'); return; }
  if (!nodeSequence) { showToast('Node sequence is required'); return; }

  var templates = getOutputGlossary();

  if (og_editingId) {
    var idx = templates.findIndex(function(t) { return t.id === og_editingId; });
    if (idx >= 0) {
      templates[idx].processName  = processName;
      templates[idx].nodeSequence = nodeSequence;
      templates[idx].diagramType  = diagramType;
      templates[idx].domain       = domain;
    }
    showToast('Updated: ' + processName);
  } else {
    var existing = templates.find(function(t) { return t.processName.toLowerCase() === processName.toLowerCase(); });
    if (existing) { showToast(processName + ' already exists — edit instead'); return; }
    templates.push({ id: makeId(), processName: processName, nodeSequence: nodeSequence, diagramType: diagramType, domain: domain, addedAt: Date.now() });
    showToast('Added template: ' + processName);
  }

  putOutputGlossary(templates);
  cancelOutputTemplateForm();
  renderOutputGlossary();
}

function deleteOutputTemplate(id) {
  var templates = getOutputGlossary().filter(function(t) { return t.id !== id; });
  putOutputGlossary(templates);
  renderOutputGlossary();
  showToast('Template deleted');
}

function exportOutputGlossary() {
  var templates = getOutputGlossary();
  if (!templates.length) { showToast('No output templates to export'); return; }
  var payload = { version: '1.0', exportedAt: new Date().toISOString(), appVersion: APP_VERSION, templates: templates };
  var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'flowchart-output-glossary-' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  showToast('Exported ' + templates.length + ' templates');
}

function importOutputGlossary(e) {
  var file = e.target.files && e.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(ev) {
    try {
      var data     = JSON.parse(ev.target.result);
      var incoming = data.templates || data;
      if (!Array.isArray(incoming)) throw new Error('Invalid format');
      var existing = getOutputGlossary();
      var added = 0, skipped = 0;
      incoming.forEach(function(t) {
        if (!t.processName || !t.nodeSequence) { skipped++; return; }
        t.id = t.id || makeId();
        var dupe = existing.find(function(x) { return x.processName.toLowerCase() === t.processName.toLowerCase(); });
        if (dupe) { skipped++; } else { existing.push(t); added++; }
      });
      putOutputGlossary(existing);
      renderOutputGlossary();
      showToast('Imported ' + added + ' templates' + (skipped ? ', ' + skipped + ' skipped' : ''));
    } catch(err) {
      showToast('Import failed: ' + err.message);
    }
    e.target.value = '';
  };
  reader.readAsText(file);
}

// ── Self-learning: extract new terms after conversion ─────────────
// ALL-CAPS acronym pattern: 2-6 uppercase letters, possibly with digits
var ACRONYM_RE = /\b([A-Z]{2,6}[0-9]?)\b/g;

// Terms to always ignore (Mermaid keywords, common words)
var LEARN_IGNORE = ['TD','LR','TB','RL','ID','OK','NO','YES','END','START',
  'AND','OR','NOT','IF','FOR','DO','TO','IN','IS','A','AN','THE'];

// Mixed-case domain term pattern: CamelCase or TitleCase words ≥6 chars
// that appear frequently enough to be domain-specific
var MIXED_TERM_RE = /\b([A-Z][a-z]{2,}(?:[A-Z][a-z]{2,})+)\b/g;  // CamelCase
var TITLE_TERM_RE = /\b([A-Z][a-z]{4,}(?:\s+[A-Z][a-z]{3,}){1,3})\b/g; // Title Case phrases

function extractNewTerms(mermaidCode) {
  var glossary = getAllTermsForContext();
  var known    = glossary.map(function(t) { return t.term; });
  var found    = {};
  var match;
  ACRONYM_RE.lastIndex = 0;
  var cleaned = mermaidCode.replace(/\b[A-Z]{1,3}[0-9]+\b/g, '');
  while ((match = ACRONYM_RE.exec(cleaned)) !== null) {
    var term = match[1];
    if (LEARN_IGNORE.indexOf(term) === -1 && known.indexOf(term) === -1) {
      found[term] = (found[term] || 0) + 1;
    }
  }
  return Object.keys(found).sort(function(a,b) { return found[b] - found[a]; }).slice(0, 8);
}

function extractNewTermsFromText(text) {
  var glossary = getAllTermsForContext();
  var known    = glossary.map(function(t) { return t.term.toLowerCase(); });
  var found    = {};
  var match;

  // ALL-CAPS acronyms
  ACRONYM_RE.lastIndex = 0;
  while ((match = ACRONYM_RE.exec(text)) !== null) {
    var term = match[1];
    if (LEARN_IGNORE.indexOf(term) === -1 && known.indexOf(term.toLowerCase()) === -1) {
      found[term] = (found[term] || 0) + 1;
    }
  }

  // CamelCase domain terms
  MIXED_TERM_RE.lastIndex = 0;
  while ((match = MIXED_TERM_RE.exec(text)) !== null) {
    var phrase = match[1];
    if (phrase.length >= 6 && known.indexOf(phrase.toLowerCase()) === -1) {
      found[phrase] = (found[phrase] || 0) + 1;
    }
  }

  // Title Case multi-word phrases (2-4 words, min freq 2)
  TITLE_TERM_RE.lastIndex = 0;
  while ((match = TITLE_TERM_RE.exec(text)) !== null) {
    var phrase = match[1];
    if (known.indexOf(phrase.toLowerCase()) === -1) {
      found[phrase] = (found[phrase] || 0) + 1;
    }
  }

  // Minimum frequency threshold: acronyms ≥1, mixed-case ≥2
  return Object.keys(found)
    .filter(function(t) {
      var isAcronym = /^[A-Z0-9&/_-]+$/.test(t);
      return isAcronym ? found[t] >= 1 : found[t] >= 2;
    })
    .sort(function(a,b) { return found[b] - found[a]; })
    .slice(0, 8);
}

var learnCandidates = []; // [{term, checked, isMixed}]

function showLearnBanner(mermaidCode) {
  var fromCode = extractNewTerms(mermaidCode);
  var fromText = pipe.clean ? extractNewTermsFromText(pipe.clean) : [];
  var allTerms = fromCode.slice();
  fromText.forEach(function(t) { if (allTerms.indexOf(t) === -1) allTerms.push(t); });
  allTerms = allTerms.slice(0, 8);

  if (!allTerms.length) return;

  learnCandidates = allTerms.map(function(t) {
    var isMixed = /[a-z]/.test(t); // has lowercase = mixed-case term
    return { term: t, checked: true, isMixed: isMixed };
  });

  var banner = document.getElementById('learn-banner');
  var list   = document.getElementById('learn-terms-list');
  list.innerHTML = learnCandidates.map(function(c, i) {
    return '<div class="learn-term-row">' +
      '<input type="checkbox" id="lc-' + i + '" ' + (c.checked ? 'checked' : '') +
        ' onchange="learnCandidates[' + i + '].checked = this.checked">' +
      '<label for="lc-' + i + '" style="cursor:pointer;">' +
        '<span class="learn-term-label">' + escHtml(c.term) + '</span>' +
        (c.isMixed ? ' <span style="font-size:9px;color:var(--purple-600,#7c3aed);font-weight:600;">phrase</span>' : '') +
      '</label>' +
      '<span class="learn-term-exp">— add expansion after saving</span>' +
    '</div>';
  }).join('');

  banner.style.display = 'block';
}

function dismissLearnBanner() {
  document.getElementById('learn-banner').style.display = 'none';
  learnCandidates = [];
}

function addLearnedTerms() {
  var toAdd    = learnCandidates.filter(function(c) { return c.checked; });
  var domain   = getCurrentDomain();
  var isProject = g_currentTier === 'project';
  var projSlug  = currentProject ? currentProject.slug : null;
  var terms    = isProject ? getProjectGlossary(projSlug) : getGlossary();
  var added    = 0;
  toAdd.forEach(function(c) {
    var dupe = terms.find(function(t) { return t.term === c.term; });
    if (!dupe) {
      var src = c.isMixed ? 'mixed-learned' : 'learned';
      terms.push({ id: makeId(), term: c.term, expansion: '(add expansion)', type: 'ref', domain: domain, addedAt: Date.now(), source: src });
      added++;
    }
  });
  if (isProject && projSlug) putProjectGlossary(projSlug, terms); else putGlossary(terms);
  dismissLearnBanner();
  if (added) {
    showToast(added + ' term' + (added > 1 ? 's' : '') + ' added — open Glossary tab to add expansions');
    switchRightTab('glossary');
  }
}

// Seed with common iGaming terms on first run
// ══════════════════════════════════════════════════════════════════
// ── DIAGRAM TYPE SUGGESTION ───────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function suggestDiagramType(preparsed, actors) {
  if (!preparsed || !preparsed.length) return null;

  var actorCount   = actors ? actors.filter(function(a) { return a.selected; }).length : 0;
  var decisions    = preparsed.filter(function(p) { return p.type === 'decision'; }).length;
  var steps        = preparsed.filter(function(p) { return p.type === 'step'; }).length;
  var processes    = preparsed.filter(function(p) { return p.type === 'process' || p.type === 'subprocess'; }).length;
  var policies     = preparsed.filter(function(p) { return p.type === 'policy'; }).length;
  var total        = preparsed.length;

  // Decision ratio: high = complex branching flowchart
  var decisionRatio = decisions / Math.max(total, 1);

  var suggestion = null;

  if (actorCount >= 2 && decisions >= 2) {
    suggestion = {
      type: 'swimlane',
      reason: actorCount + ' actors detected with decision points — Swim Lane recommended',
      confidence: 'high',
    };
  } else if (actorCount >= 2 && steps >= 4) {
    suggestion = {
      type: 'sequence',
      reason: actorCount + ' actors with ' + steps + ' interaction steps — Sequence recommended',
      confidence: 'medium',
    };
  } else if (processes >= 2 || decisionRatio > 0.3) {
    suggestion = {
      type: 'flowchart',
      reason: (processes >= 2 ? processes + ' process/sub-process blocks' : Math.round(decisionRatio * 100) + '% decision content') + ' — Flowchart recommended',
      confidence: 'high',
    };
  } else if (steps >= 6) {
    suggestion = {
      type: 'flowchart',
      reason: steps + ' process steps detected — Flowchart recommended',
      confidence: 'medium',
    };
  }

  return suggestion;
}

function renderSuggestion(suggestion) {
  var el = document.getElementById('diagram-suggestion');
  if (!suggestion) { el.classList.remove('visible'); el.innerHTML = ''; return; }
  el.classList.add('visible');
  el.innerHTML =
    '<span>💡 <strong>' + suggestion.confidence.toUpperCase() + ':</strong> ' + escHtml(suggestion.reason) + '</span>' +
    '<button class="sug-apply" onclick="applySuggestion(\'' + suggestion.type + '\')">Apply ↗</button>';
}

function applySuggestion(type) {
  document.getElementById('diagram-type').value = type;
  onDiagramTypeChange();
  showToast('Diagram type set to ' + type);
  document.getElementById('diagram-suggestion').classList.remove('visible');
}

// ══════════════════════════════════════════════════════════════════
// ── SESSION HISTORY ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

var sessionHistory = [];  // [{code, dtype, timestamp, nodeCount}] — in-memory, max 8

function pushHistory(code, dtype) {
  if (!code || !code.trim()) return;
  // Don't push if identical to last entry
  if (sessionHistory.length && sessionHistory[0].code === code) return;
  var lines    = code.split('\n').length;
  var preview  = code.trim().split('\n').slice(0, 2).join(' ').substring(0, 80);
  sessionHistory.unshift({
    code: code, dtype: dtype || 'flowchart',
    timestamp: Date.now(), lines: lines, preview: preview,
  });
  if (sessionHistory.length > 8) sessionHistory.pop();
}

function renderHistoryList() {
  var list = document.getElementById('history-list');
  if (!list) return;
  if (!sessionHistory.length) {
    list.innerHTML = '<div class="hist-empty"><div class="d">⟲</div><p>No history yet — generate a chart and previous versions will appear here</p></div>';
    return;
  }
  list.innerHTML = sessionHistory.map(function(h, i) {
    var ago  = formatAgo(h.timestamp);
    var dtype = h.dtype.charAt(0).toUpperCase() + h.dtype.slice(1);
    return '<div class="hist-card" onclick="restoreHistory(' + i + ')" title="Click to restore">' +
      '<div class="hist-num">' + (i + 1) + '</div>' +
      '<div class="hist-body">' +
        '<div class="hist-preview">' + escHtml(h.preview) + '</div>' +
        '<div class="hist-meta">' + dtype + ' · ' + h.lines + ' lines · ' + ago + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function restoreHistory(idx) {
  var h = sessionHistory[idx];
  if (!h) return;
  document.getElementById('mermaid-editor').value = h.code;
  renderMermaid(h.code);
  showToast('Restored version ' + (idx + 1));
}

function formatAgo(ts) {
  var diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60)  return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  return Math.floor(diff / 3600) + 'h ago';
}

// ── Glossary type expansion (add process/policy/cluster types) ────
function getGlossaryTypeOptions() {
  return [
    { value: 'actor',      label: 'Actor / Role' },
    { value: 'status',     label: 'Status' },
    { value: 'system',     label: 'System' },
    { value: 'process',    label: 'Process' },
    { value: 'subprocess', label: 'Sub-Process' },
    { value: 'policy',     label: 'Policy / Rule' },
    { value: 'cluster',    label: 'Cluster / Group' },
    { value: 'step',       label: 'Step / Action' },
    { value: 'ref',        label: 'Reference / Code' },
  ];
}

function seedGlossaryIfEmpty() {
  var existing = getGlossary();
  if (existing.length > 0) return;
  var seeds = [
    { term:'NR1',    expansion:'Not Registered / Unverified Player',    type:'status',     domain:'igaming' },
    { term:'DVS',    expansion:'Document Verification Service',          type:'subprocess', domain:'igaming' },
    { term:'KYC',    expansion:'Know Your Customer verification',        type:'process',    domain:'igaming' },
    { term:'PSP',    expansion:'Payment Service Provider',               type:'system',     domain:'all'     },
    { term:'ARN',    expansion:'Acquirer Reference Number',              type:'ref',        domain:'igaming' },
    { term:'AML',    expansion:'Anti-Money Laundering check',            type:'process',    domain:'all'     },
    { term:'VIP',    expansion:'High Value Player account',              type:'actor',      domain:'igaming' },
    { term:'2FA',    expansion:'Two-Factor Authentication',              type:'subprocess', domain:'all'     },
    { term:'T&C',    expansion:'Terms and Conditions',                   type:'policy',     domain:'all'     },
    { term:'SLA',    expansion:'Service Level Agreement',                type:'policy',     domain:'all'     },
    { term:'CDD',    expansion:'Customer Due Diligence process',         type:'process',    domain:'igaming' },
    { term:'PEP',    expansion:'Politically Exposed Person check',       type:'subprocess', domain:'all'     },
    { term:'EDD',    expansion:'Enhanced Due Diligence process',         type:'process',    domain:'igaming' },
  ];
  var seeded = seeds.map(function(s) {
    return Object.assign({ id: makeId(), addedAt: Date.now(), source: 'seed' }, s);
  });
  putGlossary(seeded);
  updateGlossaryTierCounts();
}

function seedOutputGlossaryIfEmpty() {
  if (getOutputGlossary().length > 0) return;
  var seeds = [
    {
      processName:  'Withdrawal Request',
      nodeSequence: 'Player submits withdrawal request\nAgent reviews request details\nSystem validates account limits\nSystem checks pending bonuses\nKYC / AML verification\nFinance approves or rejects\nSystem processes payment via PSP\nPlayer notified of outcome',
      diagramType:  'swimlane',
      domain:       'igaming',
    },
    {
      processName:  'KYC Verification',
      nodeSequence: 'Player uploads documents\nSystem performs OCR / validation\nAgent reviews document quality\nDVS checks identity\nEDD triggered if PEP / high risk\nAgent approves or rejects\nAccount status updated\nPlayer notified',
      diagramType:  'flowchart',
      domain:       'igaming',
    },
    {
      processName:  'Deposit Processing',
      nodeSequence: 'Player initiates deposit\nPSP receives transaction\nSystem checks deposit limits\nBonus eligibility evaluated\nFunds credited to wallet\nPlayer notified',
      diagramType:  'flowchart',
      domain:       'igaming',
    },
    {
      processName:  'Account Registration',
      nodeSequence: 'Player fills registration form\nSystem validates email / age\n2FA verification sent\nPlayer confirms account\nWelcome bonus applied\nKYC request triggered',
      diagramType:  'flowchart',
      domain:       'igaming',
    },
  ];
  var seeded = seeds.map(function(s) {
    return Object.assign({ id: makeId(), addedAt: Date.now() }, s);
  });
  putOutputGlossary(seeded);
  updateGlossaryTierCounts();
}

// ══════════════════════════════════════════════════════════════════
// ── INLINE NODE LABEL EDITING ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

var nodeEditState = { nodeId: null, originalLabel: null };

// After rendering, attach click handlers to node labels in the SVG
function attachNodeEditHandlers() {
  var inner = document.getElementById('chart-inner');
  if (!inner) return;
  var nodes = inner.querySelectorAll('.node');
  nodes.forEach(function(node) {
    node.style.cursor = 'pointer';
    node.addEventListener('dblclick', function(e) {
      e.stopPropagation();
      startNodeEdit(node, e);
    });
    // v3.1.0: single-click traces to source pre-parse item
    node.addEventListener('click', function(e) {
      if (e.detail > 1) return; // ignore double-click (handled above)
      var labelEl = node.querySelector('.label, text, foreignObject');
      if (!labelEl) return;
      var label = (labelEl.textContent || '').trim();
      traceNodeToSource(label);
    });
    // Tooltip hint
    node.title = 'Click → trace source · Double-click → edit label';
  });
}

// v3.1.0: Given a node label string, find the closest matching pre-parse item
// and highlight it in the Pre-Parse pane.
function traceNodeToSource(nodeLabel) {
  if (!pipe.preparsed || !pipe.preparsed.length || !nodeLabel) return;

  var labelLow = nodeLabel.toLowerCase().trim();

  // Score each pre-parse item by token overlap with the node label
  var bestIdx = -1, bestScore = 0;
  var labelTokens = labelLow.split(/\W+/).filter(function(t){ return t.length > 2; });

  pipe.preparsed.forEach(function(p, i) {
    var textLow = (p.label + ' ' + p.text).toLowerCase();
    var score = labelTokens.reduce(function(acc, tok) {
      return acc + (textLow.indexOf(tok) !== -1 ? 1 : 0);
    }, 0);
    // Exact label match is highest priority
    if (p.label.toLowerCase() === labelLow) score += 100;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  });

  if (bestIdx === -1 || bestScore === 0) return;

  // Switch to Pre-Parse tab and highlight the row
  switchLeftTab('preparse');
  var row = document.getElementById('pp-row-' + bestIdx);
  if (!row) return;

  // Clear any existing highlights
  document.querySelectorAll('.pp-row.traced').forEach(function(el) { el.classList.remove('traced'); });
  row.classList.add('traced');
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Auto-remove highlight after 3 seconds
  setTimeout(function() { row.classList.remove('traced'); }, 3000);
}

function startNodeEdit(svgNode, evt) {
  // Get the label text
  var labelEl = svgNode.querySelector('.label, text, foreignObject');
  if (!labelEl) return;
  var labelText = (labelEl.textContent || '').trim();
  if (!labelText) return;

  // Get node ID from class list (Mermaid adds 'node-id' class pattern)
  var classList = Array.from(svgNode.classList);
  var nodeId = classList.find(function(c) { return c !== 'node' && c !== 'default'; });
  if (!nodeId) return;

  nodeEditState.nodeId = nodeId;
  nodeEditState.originalLabel = labelText;

  // Position the edit input over the node
  var rect     = svgNode.getBoundingClientRect();
  var viewport = document.getElementById('chart-viewport').getBoundingClientRect();
  var overlay  = document.getElementById('node-edit-overlay');
  var input    = document.getElementById('node-edit-input');

  overlay.style.left = (rect.left - viewport.left) + 'px';
  overlay.style.top  = (rect.top  - viewport.top)  + 'px';
  overlay.style.width = Math.max(rect.width, 120) + 'px';
  overlay.style.display = 'block';
  input.value = labelText;
  input.style.width = '100%';
  setTimeout(function() { input.focus(); input.select(); }, 30);
}

function commitNodeEdit() {
  var input    = document.getElementById('node-edit-input');
  var overlay  = document.getElementById('node-edit-overlay');
  var newLabel = input.value.trim();
  overlay.style.display = 'none';

  if (!newLabel || !nodeEditState.nodeId || newLabel === nodeEditState.originalLabel) {
    nodeEditState = { nodeId: null, originalLabel: null };
    return;
  }

  // Update the Mermaid code in the editor
  var editor = document.getElementById('mermaid-editor');
  var code   = editor.value;
  var id     = nodeEditState.nodeId;
  // Replace the label in all node definition patterns for this ID
  var patterns = [
    // ID["old label"] or ID[old label]
    new RegExp('(\\b' + escapeRegex(id) + '\\s*\\[)[^\\]]*?(\\])', 'g'),
    // ID{"old"} or ID{old}
    new RegExp('(\\b' + escapeRegex(id) + '\\s*\\{)[^}]*?(\\})', 'g'),
    // ID(["old"]) or ID([old])
    new RegExp('(\\b' + escapeRegex(id) + '\\s*\\(\\[)[^\\]]*?(\\]\\))', 'g'),
  ];
  var updated = code;
  patterns.forEach(function(pat) {
    updated = updated.replace(pat, function(m, open, close) {
      return open + newLabel + close;
    });
  });

  if (updated !== code) {
    editor.value = updated;
    scheduleRender();
    doAutosave();
    showToast('Label updated: ' + newLabel);
  }
  nodeEditState = { nodeId: null, originalLabel: null };
}

function cancelNodeEdit() {
  document.getElementById('node-edit-overlay').style.display = 'none';
  nodeEditState = { nodeId: null, originalLabel: null };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Wire up edit input keys
document.getElementById('node-edit-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter')  { e.preventDefault(); commitNodeEdit(); }
  if (e.key === 'Escape') { cancelNodeEdit(); }
});
document.getElementById('node-edit-input').addEventListener('blur', function() {
  // Small delay so Enter key can fire first
  setTimeout(cancelNodeEdit, 150);
});

// ══════════════════════════════════════════════════════════════════
// ── EXPORT WITH METADATA ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function openExportDialog() {
  if (!lastSVG) { showToast('Generate a chart first'); return; }
  // Pre-fill title from first saved chart name or first node label
  var titleEl  = document.getElementById('exp-title');
  var code     = document.getElementById('mermaid-editor').value;
  var match    = code.match(/\[([^\]]{3,40})\]/);
  if (!titleEl.value) {
    titleEl.value = match ? match[1].substring(0, 60) : 'Flowchart';
  }
  var subEl = document.getElementById('exp-subtitle');
  if (!subEl.value) {
    subEl.value = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });
  }
  document.getElementById('export-dialog').classList.add('open');
}

function closeExportDialog() {
  document.getElementById('export-dialog').classList.remove('open');
}

document.getElementById('export-dialog').addEventListener('click', function(e) {
  if (e.target === document.getElementById('export-dialog')) closeExportDialog();
});

function buildAnnotatedSVG() {
  var title    = document.getElementById('exp-title').value.trim() || 'Flowchart';
  var subtitle = document.getElementById('exp-subtitle').value.trim();
  var domain   = document.getElementById('domain-preset').value;
  var version  = APP_VERSION;

  // Parse the existing SVG and add a header band
  var parser = new DOMParser();
  var svgDoc = parser.parseFromString(lastSVG, 'image/svg+xml');
  var svgEl  = svgDoc.documentElement;

  var w  = parseFloat(svgEl.getAttribute('width'))  || 900;
  var h  = parseFloat(svgEl.getAttribute('height')) || 600;
  var vb = svgEl.getAttribute('viewBox');
  if (vb) {
    var parts = vb.split(/[\s,]+/);
    if (!parseFloat(svgEl.getAttribute('width')))  w = parseFloat(parts[2]) || 900;
    if (!parseFloat(svgEl.getAttribute('height'))) h = parseFloat(parts[3]) || 600;
  }

  var HEADER = 52; // px header height
  var newH = h + HEADER;

  // Build annotated SVG string
  var annotated =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + newH + '" viewBox="0 0 ' + w + ' ' + newH + '">' +
    // White background
    '<rect width="' + w + '" height="' + newH + '" fill="#ffffff"/>' +
    // Blue header band
    '<rect width="' + w + '" height="' + HEADER + '" fill="#1d4ed8"/>' +
    // Title text
    '<text x="16" y="20" font-family="Inter,sans-serif" font-size="14" font-weight="700" fill="white">' + escHtml(title) + '</text>' +
    // Subtitle
    '<text x="16" y="38" font-family="Inter,sans-serif" font-size="11" fill="rgba(255,255,255,0.75)">' + escHtml(subtitle) + '</text>' +
    // Version + domain badge (right-aligned)
    '<text x="' + (w - 12) + '" y="20" font-family="Inter,sans-serif" font-size="10" fill="rgba(255,255,255,0.6)" text-anchor="end">Flowinject ' + version + '</text>' +
    '<text x="' + (w - 12) + '" y="36" font-family="Inter,sans-serif" font-size="10" fill="rgba(255,255,255,0.5)" text-anchor="end">' + escHtml(domain) + '</text>' +
    // Diagram content (shifted down by HEADER)
    '<g transform="translate(0,' + HEADER + ')">' + lastSVG + '</g>' +
    '</svg>';

  return { annotated: annotated, w: w, h: newH };
}

function exportWithMeta(previewOnly) {
  if (!lastSVG) return;
  var format = document.getElementById('exp-format').value;
  var title  = (document.getElementById('exp-title').value.trim() || 'flowchart')
                 .replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  var built  = buildAnnotatedSVG();

  if (previewOnly) {
    // Open in new tab for preview
    var blob = new Blob([built.annotated], { type: 'image/svg+xml' });
    window.open(URL.createObjectURL(blob), '_blank');
    return;
  }

  closeExportDialog();

  if (format === 'svg' || format === 'both') {
    var svgBlob = new Blob([built.annotated], { type: 'image/svg+xml' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(svgBlob); a.download = title + '.svg'; a.click();
  }

  if (format === 'png' || format === 'both') {
    renderSVGtoPNG(built.annotated, built.w, built.h, title + '@3x.png');
  }
}

async function renderSVGtoPNG(svgStr, w, h, filename) {
  var S = 3;
  var canvas = document.createElement('canvas');
  canvas.width = w * S; canvas.height = h * S;
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(S, S);
  var blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  var url  = URL.createObjectURL(blob);
  var img  = new Image();
  await new Promise(function(res, rej) { img.onload = res; img.onerror = rej; img.src = url; });
  ctx.drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(url);
  canvas.toBlob(function(b) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = filename; a.click();
  }, 'image/png');
}

// ══════════════════════════════════════════════════════════════════
// ── PRINT / PDF ───────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function printChart() {
  if (!lastSVG) { showToast('Generate a chart first'); return; }

  var title    = document.getElementById('exp-title') && document.getElementById('exp-title').value.trim();
  var code     = document.getElementById('mermaid-editor').value;
  var match    = code.match(/\[([^\]]{3,40})\]/);
  if (!title) title = match ? match[1] : 'Flowchart';

  var meta = new Date().toLocaleDateString('en-GB', { weekday:'long', year:'numeric', month:'long', day:'numeric' }) +
    ' · Flowinject ' + APP_VERSION +
    ' · ' + document.getElementById('domain-preset').value;

  document.getElementById('print-title').textContent = title;
  document.getElementById('print-meta').textContent  = meta;
  document.getElementById('print-svg').innerHTML     = lastSVG;
  document.getElementById('print-area').style.display = 'block';

  setTimeout(function() {
    window.print();
    document.getElementById('print-area').style.display = 'none';
  }, 100);
}

var SAMPLE_DOCUMENT = [
  'Withdrawal Request Processing — Agent Standard Operating Procedure',
  '',
  '1. Overview',
  'This process covers how CS agents handle player withdrawal requests from initial',
  'submission through to completion or rejection. All agents must follow this procedure',
  'in compliance with AML policy and DVS requirements.',
  '',
  '2. Withdrawal Request Sub-Process',
  'The player submits a withdrawal request via the platform. The system automatically',
  'logs the request and assigns a reference number. The agent receives the request in',
  'the work queue within 15 minutes of submission.',
  '',
  '3. Initial Status Check',
  'The agent must verify the player account status before processing. If the player',
  'status is NR1 (Not Registered / Unverified), the agent must initiate the KYC',
  'verification sub-process before proceeding. If the player is fully verified,',
  'proceed directly to the payment validation step.',
  '',
  '4. KYC Verification Sub-Process',
  'Request the player to submit identity documents via the DVS portal. The player',
  'must provide a valid government ID and proof of address. Documents must not be',
  'expired. If documents are rejected by DVS, notify the player and allow 3 attempts.',
  'After 3 failed attempts, escalate to the compliance team.',
  '',
  '5. Payment Validation',
  'Verify that the withdrawal method matches the original deposit method per T&C policy.',
  'Check the requested amount against the player account balance and withdrawal limits.',
  'If the amount exceeds the daily limit, escalate to the Finance team for manual review.',
  '',
  '6. Processing Decision',
  'If all checks pass, approve the withdrawal request and submit to the PSP.',
  'The PSP will process within 1-3 business days and return an ARN reference.',
  'If the PSP rejects the transaction, notify the player within 24 hours and',
  'request an alternative payment method.',
  '',
  '7. Completion',
  'Update the player account record with the transaction outcome. If approved,',
  'send a confirmation email with the ARN. If rejected, send a rejection notice',
  'with the reason. Close the case in the system.',
].join('\n');

function loadSampleDocument() {
  var inputEl = document.getElementById('input-text');
  inputEl.value = SAMPLE_DOCUMENT;
  pipe.raw = SAMPLE_DOCUMENT;
  document.getElementById('raw-meta').textContent = SAMPLE_DOCUMENT.length.toLocaleString() + ' chars';
  document.getElementById('filename-tag').style.display = 'inline-block';
  document.getElementById('fname').textContent = 'sample-withdrawal-process.txt';
  resetPipelineStages();
  setPipeDot('raw', 'done');
  switchLeftTab('raw');
  updatePipelineStatus(false);
  showToast('Sample iGaming CS document loaded — clicking the button below will run the pipeline and generate a chart');
  // Auto-run smartAction after a brief delay so user sees the raw text first
  setTimeout(function() { smartAction(); }, 800);
}

// ══════════════════════════════════════════════════════════════════
// ── AUTO-SAVE ─────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
// ── v3.11.0: HTML EXPORT  (spec §A.7)  ───────────────────────────
// ══════════════════════════════════════════════════════════════════
//
// Two export functions:
//   _exportProcessHtml(entry)  — single process diagram + annotation panel
//   _exportProjectMapHtml()    — full project master map with all saved processes
//
// Both produce self-contained .html files (no fetch(), no external files).
// Mermaid loaded from CDN. All data embedded as JSON in a <script> block.

function _exportInlineStyles() {
  return [
    '*{box-sizing:border-box;margin:0;padding:0;}',
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;color:#1f2937;background:#f9fafb;height:100vh;display:flex;flex-direction:column;}',
    '.toolbar{display:flex;align-items:center;gap:10px;padding:8px 16px;background:#fff;border-bottom:1px solid #e5e7eb;flex-shrink:0;}',
    '.toolbar h1{font-size:14px;font-weight:700;color:#111827;}',
    '.breadcrumb{font-size:11px;color:#6b7280;}',
    '.breadcrumb a{color:#2563eb;cursor:pointer;text-decoration:none;}',
    '.breadcrumb a:hover{text-decoration:underline;}',
    '.toolbar-right{margin-left:auto;display:flex;gap:6px;align-items:center;}',
    '.btn{font-size:11px;padding:4px 10px;border-radius:5px;border:1px solid #d1d5db;background:#fff;cursor:pointer;color:#374151;}',
    '.btn:hover{background:#f3f4f6;}',
    '.btn.active{background:#2563eb;color:#fff;border-color:#2563eb;}',
    '.main{display:flex;flex:1;overflow:hidden;}',
    '.diagram-pane{flex:1;overflow:auto;padding:16px;display:flex;align-items:flex-start;justify-content:center;}',
    '.diagram-pane svg{max-width:100%;height:auto;}',
    '.annotation-pane{width:320px;flex-shrink:0;border-left:1px solid #e5e7eb;background:#fff;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;}',
    '.annotation-pane.hidden{display:none;}',
    '.ann-title{font-size:12px;font-weight:600;color:#374151;padding-bottom:6px;border-bottom:1px solid #f3f4f6;}',
    '.ann-field{font-size:11px;line-height:1.5;}',
    '.ann-label{font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;font-size:10px;display:block;margin-bottom:2px;}',
    '.ann-warning{color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:4px;padding:4px 6px;}',
    '.ann-wait{color:#1e3a5f;background:#eff6ff;border:1px solid #bfdbfe;border-radius:4px;padding:4px 6px;}',
    '.crossref-list{margin-top:4px;}',
    '.crossref-link{display:block;font-size:11px;color:#2563eb;cursor:pointer;padding:2px 0;}',
    '.crossref-link:hover{text-decoration:underline;}',
    '.chip{display:inline-block;font-size:10px;padding:1px 6px;border-radius:3px;background:#eff6ff;color:#1e3a5f;border:1px solid #bfdbfe;margin:2px 2px 0 0;}',
    '.map-wrap{flex:1;overflow:auto;padding:16px;}',
    '.cluster-section{margin-bottom:20px;}',
    '.cluster-title{font-size:13px;font-weight:700;color:#374151;padding:6px 10px;background:#f3f4f6;border-radius:6px;margin-bottom:8px;}',
    '.process-card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;margin-bottom:6px;cursor:pointer;}',
    '.process-card:hover{border-color:#93c5fd;background:#eff6ff;}',
    '.process-title{font-size:13px;font-weight:600;color:#1f2937;}',
    '.process-meta{font-size:10px;color:#9ca3af;margin-top:2px;}',
    '@media(max-width:768px){.main{flex-direction:column;} .annotation-pane{width:100%;border-left:none;border-top:1px solid #e5e7eb;} .toolbar{flex-wrap:wrap;}}',
    // Card grid styles (used in master map view)
    '.cmap-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:12px 0;}',
    '@media(max-width:900px){.cmap-grid{grid-template-columns:repeat(2,1fr);}}',
    '@media(max-width:600px){.cmap-grid{grid-template-columns:1fr;}}',
    '.cmap-cluster{border-radius:12px;padding:14px 14px 10px;display:flex;flex-direction:column;gap:6px;border:1.5px solid transparent;}',
    '.cmap-cluster-header{display:flex;align-items:center;gap:8px;margin-bottom:4px;}',
    '.cmap-cluster-num{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;flex-shrink:0;}',
    '.cmap-cluster-title{font-size:13px;font-weight:700;color:#1f2937;}',
    '.cmap-process{background:rgba(255,255,255,0.72);border-radius:7px;padding:7px 10px;cursor:pointer;transition:box-shadow 0.12s;border:1px solid rgba(0,0,0,0.07);}',
    '.cmap-process:hover{box-shadow:0 2px 8px rgba(0,0,0,0.13);}',
    '.cmap-process-title{font-size:12px;font-weight:500;color:#1f2937;}',
    '.cmap-chapter{font-size:10px;color:#6b7280;margin-right:5px;}',
    '.cmap-chips{display:flex;flex-wrap:wrap;gap:3px;margin-top:4px;}',
    '.cmap-chip{font-size:9px;font-weight:600;padding:1px 6px;border-radius:10px;display:inline-flex;align-items:center;gap:3px;white-space:nowrap;}',
    '.cmap-legend{display:flex;flex-wrap:wrap;gap:10px;padding:10px 0 4px;border-top:1px solid #e5e7eb;margin-top:4px;font-size:10px;color:#4b5563;}',
    '.cmap-legend-dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:4px;vertical-align:middle;}',
  ].join('\n');
}

// Generate a single-process self-contained HTML export
// _exportCurrentHtml(): convenience wrapper called from the ↗ HTML action bar button.
// Uses the current Mermaid editor content + current pipe state without requiring a save first.
function _exportCurrentHtml() {
  var code  = document.getElementById('mermaid-editor').value.trim();
  if (!code) { showToast('Generate a diagram first'); return; }
  var name  = (document.getElementById('chart-name-input') || {}).value || '';
  if (!name && pipe.extraction) name = pipe.extraction.source_title || '';
  if (!name) name = 'diagram';
  // Try to find a matching saved entry (for annotations + meta), fall back to a minimal entry
  var slug    = slugify(name) || 'diagram';
  var saved   = getSavedEntry(slug) || getSaved().find(function(c){ return !c.isDraft && c.code === code; });
  var entry   = saved || { slug: slug, name: name, code: code, meta: null };
  _exportProcessHtml(entry);
}

function _exportProcessHtml(entry) {
  if (!entry || !entry.code) {
    showToast('Nothing to export — no diagram code'); return;
  }
  var title       = entry.name || entry.slug || 'diagram';
  var projTitle   = currentProject ? currentProject.name : 'Project';
  var meta        = entry.meta || {};
  var annotations = (meta.nodeAnnotations) ? meta.nodeAnnotations : {};
  var crossRefs   = (meta.crossRefs || []);
  var chapter     = meta.chapter || '';
  var mmdCode     = entry.code;

  var diagramData = JSON.stringify({
    title:       title,
    chapter:     chapter,
    projectTitle: projTitle,
    mmd:         mmdCode,
    annotations: annotations,
    crossRefs:   crossRefs,
    meta:        { slug: meta.slug || entry.slug, cluster: meta.cluster || '', clusterLabel: meta.clusterLabel || '', type: meta.type || 'process' },
  });

  var html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<title>' + _escExport(title) + ' — ' + _escExport(projTitle) + '</title>\n' +
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.6.1/mermaid.min.js"><\/script>\n' +
    '<style>\n' + _exportInlineStyles() + '\n</style>\n' +
    '</head>\n<body>\n' +
    '<div class="toolbar">\n' +
    '  <div>\n' +
    '    <div class="breadcrumb">Map › ' +
    (meta.clusterLabel ? _escExport(meta.clusterLabel) + ' › ' : '') +
    _escExport(title) + '</div>\n' +
    '    <h1 id="page-title">' + _escExport(title) + '</h1>\n' +
    '  </div>\n' +
    '  <div class="toolbar-right">\n' +
    '    <button class="btn" id="toggle-ann-btn" onclick="toggleAnnotations()">Annotated</button>\n' +
    '    <button class="btn" onclick="window.print()">Print</button>\n' +
    '  </div>\n' +
    '</div>\n' +
    '<div class="main" id="main-area">\n' +
    '  <div class="diagram-pane" id="diagram-pane"><div id="mermaid-target"></div></div>\n' +
    '  <div class="annotation-pane hidden" id="annotation-pane">\n' +
    '    <div class="ann-title" id="ann-panel-title">Click a node to see annotations</div>\n' +
    '    <div id="ann-panel-body"></div>\n' +
    '    <div id="ann-crossrefs"></div>\n' +
    '  </div>\n' +
    '</div>\n' +
    '<script>\n' +
    'const DIAGRAM_DATA = ' + diagramData + ';\n' +
    'var _annotationsVisible = false;\n' +
    'var _activeNodeId = null;\n' +
    '\n' +
    'mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose" });\n' +
    '\n' +
    'function _esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }\n' +
    '\n' +
    'function toggleAnnotations() {\n' +
    '  _annotationsVisible = !_annotationsVisible;\n' +
    '  var pane = document.getElementById("annotation-pane");\n' +
    '  var btn  = document.getElementById("toggle-ann-btn");\n' +
    '  if (_annotationsVisible) { pane.classList.remove("hidden"); btn.classList.add("active"); }\n' +
    '  else { pane.classList.add("hidden"); btn.classList.remove("active"); }\n' +
    '  sessionStorage.setItem("fc_viewer_annotated", _annotationsVisible ? "1" : "0");\n' +
    '}\n' +
    '\n' +
    'function showNodeAnnotation(nodeId) {\n' +
    '  _activeNodeId = nodeId;\n' +
    '  var ann = DIAGRAM_DATA.annotations[nodeId] || {};\n' +
    '  var title = document.getElementById("ann-panel-title");\n' +
    '  var body  = document.getElementById("ann-panel-body");\n' +
    '  var xrefs = document.getElementById("ann-crossrefs");\n' +
    '  title.textContent = nodeId;\n' +
    '  var html = "";\n' +
    '  if (ann.note)          html += \'<div class="ann-field"><span class="ann-label">Note</span>\' + _esc(ann.note) + "</div>";\n' +
    '  if (ann.warning)       html += \'<div class="ann-field"><span class="ann-label">⚠ Warning</span><div class="ann-warning">\' + _esc(ann.warning) + "</div></div>";\n' +
    '  if (ann.waitCondition) html += \'<div class="ann-field"><span class="ann-label">⏳ Wait for</span><div class="ann-wait">\' + _esc(ann.waitCondition) + "</div></div>";\n' +
    '  if (ann.ref)           html += \'<div class="ann-field"><span class="ann-label">Reference</span>\' + _esc(ann.ref) + "</div>";\n' +
    '  if (ann.glossaryTerms && ann.glossaryTerms.length) {\n' +
    '    html += \'<div class="ann-field"><span class="ann-label">Terms</span>\' + ann.glossaryTerms.map(function(t){ return \'<span class="chip">\' + _esc(t) + "</span>"; }).join("") + "</div>";\n' +
    '  }\n' +
    '  if (!html) html = \'<div style="font-size:11px;color:#9ca3af;">No annotations for this node.</div>\';\n' +
    '  body.innerHTML = html;\n' +
    '  // Cross-refs\n' +
    '  if (DIAGRAM_DATA.crossRefs && DIAGRAM_DATA.crossRefs.length) {\n' +
    '    xrefs.innerHTML = \'<div class="ann-field"><span class="ann-label">Related processes</span>\' +\n' +
    '      \'<div class="crossref-list">\' + DIAGRAM_DATA.crossRefs.map(function(r){ return \'<a class="crossref-link" onclick="alert(\\\'Open process: \\\' + \\\'\' + _esc(r) + \'\\\')">→ \' + _esc(r) + "</a>"; }).join("") + "</div></div>";\n' +
    '  } else { xrefs.innerHTML = ""; }\n' +
    '  if (!_annotationsVisible) toggleAnnotations();\n' +
    '}\n' +
    '\n' +
    'async function renderDiagram() {\n' +
    '  var target = document.getElementById("mermaid-target");\n' +
    '  try {\n' +
    '    var result = await mermaid.render("fc_export_" + Date.now(), DIAGRAM_DATA.mmd);\n' +
    '    var svg = result && result.svg ? result.svg : (typeof result === "string" ? result : "");\n' +
    '    target.innerHTML = svg;\n' +
    '    // Wire node click handlers\n' +
    '    target.querySelectorAll("svg .node").forEach(function(el) {\n' +
    '      var nodeId = (el.id || "").replace(/^flowchart-/,"").replace(/-\\d+$/,"");\n' +
    '      el.style.cursor = "pointer";\n' +
    '      el.addEventListener("click", function(){ showNodeAnnotation(nodeId); });\n' +
    '    });\n' +
    '  } catch(e) {\n' +
    '    target.innerHTML = \'<pre style="color:red;font-size:11px;">\' + _esc(e.message) + "</pre>";\n' +
    '  }\n' +
    '}\n' +
    '\n' +
    '// Restore toggle state from sessionStorage\n' +
    'if (sessionStorage.getItem("fc_viewer_annotated") === "1") toggleAnnotations();\n' +
    'renderDiagram();\n' +
    '<\/script>\n' +
    '</body>\n</html>';

  _downloadFile(_escExport(entry.slug || slugify(title)) + '_diagram.html', html, 'text/html');
  showToast('Exported: ' + title + '_diagram.html');
}

// ── v3.12.0: Cluster card grid map (from saved corpus) ────────────
// Renders the cluster card layout (like the reference screenshot) using
// saved process metadata. Zero LLM calls. Replaces/supplements the
// Mermaid diagram map in the Analysis → Map tab.
//
// CLUSTER_PALETTE: one background colour per cluster code prefix (1x–9x+)
var CLUSTER_PALETTE = [
  { bg: '#e8edf8', border: '#3b4fa8', dot: '#3b4fa8' }, // 1x — Platform (blue)
  { bg: '#fce8e6', border: '#c0392b', dot: '#c0392b' }, // 2x — Disputes (red)
  { bg: '#e6f4ea', border: '#27ae60', dot: '#27ae60' }, // 3x — Deposits (green)
  { bg: '#fff3e0', border: '#e67e22', dot: '#e67e22' }, // 4x — Withdrawals (orange)
  { bg: '#f3e8fd', border: '#8e44ad', dot: '#8e44ad' }, // 5x — Verification (purple)
  { bg: '#fffde7', border: '#c9a800', dot: '#c9a800' }, // 6x — Bonuses (yellow)
  { bg: '#e0f7fa', border: '#0097a7', dot: '#0097a7' }, // 7x — Sports (teal)
  { bg: '#fce4ec', border: '#e91e63', dot: '#e91e63' }, // 8x — Lifecycle (pink)
  { bg: '#f1f8e9', border: '#558b2f', dot: '#558b2f' }, // 9x — RG (olive)
];

function _clusterPalette(clusterCode) {
  // Extract numeric prefix from cluster code (e.g. "4x" → 4, "gen" → 0)
  var num = parseInt(clusterCode, 10);
  if (!num || num < 1) num = 1;
  return CLUSTER_PALETTE[(num - 1) % CLUSTER_PALETTE.length];
}

function _renderSavedCorpusMap(containerEl) {
  var allCharts = getSaved().filter(function(c){ return !c.isDraft; });

  if (!allCharts.length) {
    containerEl.innerHTML =
      '<div class="an-empty-state" style="padding:40px 20px;">' +
      '<span style="font-size:28px;">⊙</span>' +
      '<p>No saved charts yet.<br>Generate diagrams and click ◈ Save to build your corpus map.</p>' +
      '</div>';
    return;
  }

  // Build cluster groupings preserving order
  var clusterOrder = [];
  var clusters = {};
  allCharts.forEach(function(c) {
    var m       = c.meta || {};
    var cid     = m.cluster || 'gen';
    var cLabel  = m.clusterLabel || cid;
    if (!clusters[cid]) {
      clusters[cid] = { code: cid, label: cLabel, processes: [] };
      clusterOrder.push(cid);
    }
    clusters[cid].processes.push({
      slug:            c.slug || slugify(c.name || ''),
      title:           c.name || c.slug || '',
      chapter:         m.chapter || '',
      type:            m.type || 'process',
      parentSlug:      m.parentSlug || null,
      subprocessSlugs: m.subprocessSlugs || [],
      crossRefs:       m.crossRefs || [],
      nodeCount:       m.nodeCount || 0,
    });
  });

  // Sort processes within each cluster by chapter number
  clusterOrder.forEach(function(cid) {
    clusters[cid].processes.sort(function(a, b) {
      var na = parseFloat(a.chapter) || 999;
      var nb = parseFloat(b.chapter) || 999;
      return na - nb;
    });
  });

  // Build cross-reference slug → cluster lookup
  var slugToCluster = {};
  allCharts.forEach(function(c) {
    var slug = c.slug || slugify(c.name || '');
    var cid  = (c.meta || {}).cluster || 'gen';
    slugToCluster[slug] = cid;
  });

  // Render grid
  var gridHtml = '<div class="cmap-grid">';

  clusterOrder.forEach(function(cid, ci) {
    var cl      = clusters[cid];
    var pal     = _clusterPalette(cid);
    var num     = parseInt(cid, 10) || (ci + 1);

    // Only show top-level processes (not subprocesses) at cluster level
    var topProcs = cl.processes.filter(function(p){ return p.type !== 'subprocess'; });

    gridHtml +=
      '<div class="cmap-cluster" style="background:' + pal.bg + ';border-color:' + pal.border + '20;">' +
      '<div class="cmap-cluster-header">' +
        '<span class="cmap-cluster-num" style="background:' + pal.dot + ';">' + num + '</span>' +
        '<span class="cmap-cluster-title">' + _esc(cl.label) + '</span>' +
      '</div>';

    topProcs.forEach(function(p) {
      // Cross-ref chips: show one chip per unique target cluster
      var seenTargetClusters = {};
      var chips = '';
      (p.crossRefs || []).forEach(function(refSlug) {
        var tgtCid = slugToCluster[refSlug];
        if (!tgtCid || tgtCid === cid || seenTargetClusters[tgtCid]) return;
        seenTargetClusters[tgtCid] = true;
        var tgtPal = _clusterPalette(tgtCid);
        var tgtNum = parseInt(tgtCid, 10) || '?';
        var tgtLabel = (clusters[tgtCid] || {}).label || tgtCid;
        // Find the referenced process title
        var refProc = allCharts.find(function(c){ return (c.slug || slugify(c.name||'')) === refSlug; });
        var chipTitle = refProc ? refProc.name : refSlug;
        chips +=
          '<span class="cmap-chip" ' +
          'style="background:' + tgtPal.dot + '22;color:' + tgtPal.dot + ';border:1px solid ' + tgtPal.dot + '55;" ' +
          'title="→ ' + _esc(chipTitle) + '">' +
          '↗' + tgtNum + ' ' + _esc(tgtLabel.substring(0, 12)) +
          '</span>';
      });

      // Subprocess indicator
      var subBadge = p.subprocessSlugs && p.subprocessSlugs.length
        ? '<span class="cmap-chip" style="background:rgba(0,0,0,0.06);color:var(--gray-600);border:1px solid rgba(0,0,0,0.1);">' +
          p.subprocessSlugs.length + ' sub</span>'
        : '';

      gridHtml +=
        '<div class="cmap-process" onclick="_cmapOpenProcess(\'' + _esc(p.slug.replace(/'/g,"\\'")) + '\')">' +
          '<div class="cmap-process-title">' +
            (p.chapter ? '<span class="cmap-chapter">' + _esc(p.chapter) + '</span>' : '') +
            _esc(p.title) +
          '</div>' +
          ((chips || subBadge) ? '<div class="cmap-chips">' + chips + subBadge + '</div>' : '') +
        '</div>';
    });

    gridHtml += '</div>'; // close cmap-cluster
  });

  gridHtml += '</div>'; // close cmap-grid

  // Legend
  var legendHtml = '<div class="cmap-legend">';
  legendHtml += '<span style="font-weight:600;color:var(--gray-600);font-size:10px;">Cross-cluster tags:</span>';
  clusterOrder.forEach(function(cid, ci) {
    var cl  = clusters[cid];
    var pal = _clusterPalette(cid);
    var num = parseInt(cid, 10) || (ci + 1);
    legendHtml +=
      '<span>' +
        '<span class="cmap-legend-dot" style="background:' + pal.dot + ';"></span>' +
        num + ' ' + _esc(cl.label) +
      '</span>';
  });
  legendHtml += '</div>';

  containerEl.innerHTML = gridHtml + legendHtml;
}

// Called when a process card is clicked in the corpus map
function _cmapOpenProcess(slug) {
  var entry = getSavedEntry(slug);
  if (!entry) { showToast('Process not found: ' + slug); return; }
  // Load into editor + render + switch to Graph tab
  document.getElementById('mermaid-editor').value = entry.code;
  switchRightTab('graph');
  renderMermaid(entry.code);
  showToast('Loaded: ' + (entry.name || slug));
}

// Generate project master map HTML export (all saved processes + landscape Mermaid)
// Full spec §A.2–A.7: 4-level navigation (Master Map → Cluster → Process → Subprocess)
function _exportProjectMapHtml() {
  var allCharts = getSaved().filter(function(c){ return !c.isDraft; });
  if (!allCharts.length) { showToast('No saved charts to export'); return; }
  var projTitle = currentProject ? currentProject.name : 'Project';
  var projSlug  = currentProject ? currentProject.slug : 'general';

  // Build cluster groupings — include parentSlug + subprocessSlugs for navigation
  var clusters = {};
  allCharts.forEach(function(c) {
    var m       = c.meta || {};
    var cluster = m.cluster || 'gen';
    var cLabel  = m.clusterLabel || cluster;
    if (!clusters[cluster]) clusters[cluster] = { code: cluster, label: cLabel, processes: [] };
    clusters[cluster].processes.push({
      slug:            c.slug || slugify(c.name || ''),
      title:           c.name || c.slug || '',
      chapter:         m.chapter || '',
      type:            m.type || 'process',
      parentSlug:      m.parentSlug || null,
      subprocessSlugs: m.subprocessSlugs || [],
      crossRefs:       m.crossRefs || [],
      nodeCount:       m.nodeCount || 0,
      mmd:             c.code || '',
      annotations:     (m.nodeAnnotations) ? m.nodeAnnotations : {},
    });
  });

  // Embed glossary lookup for §B.4.4 definition chips
  var glossaryLookup = {};
  try {
    getGlossary().forEach(function(g) {
      if (g.term) glossaryLookup[g.term.toLowerCase()] = { term: g.term, expansion: g.expansion || g.fullForm || '', definition: g.definition || '', domain: g.domain || '' };
    });
    var projGloss = currentProject ? getProjectGlossary(currentProject.slug) : [];
    projGloss.forEach(function(g) {
      if (g.term && g.confirmed !== false) glossaryLookup[g.term.toLowerCase()] = { term: g.term, expansion: g.expansion || '', definition: g.definition || '', domain: g.domain || '' };
    });
  } catch(e) {}

  // Build master map Mermaid (spec §A.3.1: label = "{code} — {label}", node label = "{chapter} {title}")
  var mapLines = ['flowchart TD'];
  var totalNodes = allCharts.length;
  var clusterIds = Object.keys(clusters);
  var clusterNodeId = {};
  var shownProcs = totalNodes <= 60;
  var clusterEdges = {};

  clusterIds.forEach(function(cid, ci) {
    var cl   = clusters[cid];
    var csid = 'CL' + ci;
    clusterNodeId[cid] = csid;
    var heading = (cl.code !== cl.label ? cl.code + ' \u2014 ' : '') + cl.label;
    mapLines.push('  subgraph ' + csid + '["' + heading.replace(/"/g,"'") + '"]');
    if (shownProcs) {
      cl.processes.forEach(function(p, pi) {
        if (p.type !== 'subprocess') {
          var nid = csid + '_P' + pi;
          var nodeLabel = (p.chapter ? p.chapter + ' ' : '') + p.title.substring(0, 26);
          mapLines.push('    ' + nid + '["' + nodeLabel.replace(/"/g, "'") + '"]');
        }
      });
    } else {
      var procCount = cl.processes.filter(function(p){ return p.type !== 'subprocess'; }).length;
      mapLines.push('    ' + csid + '_cnt["' + procCount + ' processes"]');
    }
    mapLines.push('  end');
  });

  allCharts.forEach(function(c) {
    var m = c.meta || {};
    var srcCluster = m.cluster || 'gen';
    (m.crossRefs || []).forEach(function(refSlug) {
      var target = allCharts.find(function(tc){ return (tc.slug || slugify(tc.name||'')) === refSlug; });
      if (!target) return;
      var tgtCluster = (target.meta || {}).cluster || 'gen';
      if (tgtCluster === srcCluster) return;
      var key = [srcCluster, tgtCluster].sort().join('|');
      if (!clusterEdges[key]) {
        clusterEdges[key] = true;
        var srcId = clusterNodeId[srcCluster], tgtId = clusterNodeId[tgtCluster];
        if (srcId && tgtId) mapLines.push('  ' + srcId + ' -. crossRef .- ' + tgtId);
      }
    });
  });

  var masterMapMmd = mapLines.join('\n');
  var clustersJson = JSON.stringify(clusters);
  var glossaryJson = JSON.stringify(glossaryLookup);

  var html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<title>' + _escExport(projTitle) + ' \u2014 Process Map</title>\n' +
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.6.1/mermaid.min.js"><\/script>\n' +
    '<style>\n' + _exportInlineStyles() + '\n' +
    '.indent{margin-left:18px;border-left:2px solid #e5e7eb;padding-left:10px;}' +
    '.subprocess-badge{font-size:9px;padding:1px 5px;border-radius:3px;background:#eff6ff;color:#1e3a5f;border:1px solid #bfdbfe;margin-left:4px;}' +
    '.parent-link{font-size:11px;color:#2563eb;cursor:pointer;padding:4px 0;display:inline-block;}' +
    '.parent-link:hover{text-decoration:underline;}' +
    '.def-chip{display:inline-block;font-size:10px;padding:1px 6px;border-radius:3px;background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0;margin:2px 2px 0 0;cursor:help;position:relative;}' +
    '.def-chip:hover::after{content:attr(data-def);position:absolute;bottom:120%;left:0;white-space:pre-wrap;max-width:240px;background:#1f2937;color:#f9fafb;border-radius:5px;padding:5px 8px;font-size:10px;z-index:999;pointer-events:none;}' +
    '.node-highlight rect,.node-highlight polygon,.node-highlight circle,.node-highlight ellipse{stroke:#2563eb!important;stroke-width:2.5px!important;}' +
    '\n</style>\n</head>\n<body>\n' +
    '<div class="toolbar"><div>' +
    '<div class="breadcrumb" id="breadcrumb"><a onclick="showMasterMap()" style="color:#2563eb;cursor:pointer;">\u2299 Master Map</a></div>' +
    '<h1 id="page-title">' + _escExport(projTitle) + ' \u2014 Process Map</h1>' +
    '</div><div class="toolbar-right">' +
    '<button class="btn" id="toggle-ann-btn" onclick="toggleAnnotations()">Annotated</button>' +
    '<button class="btn" onclick="window.print()">Print</button>' +
    '</div></div>\n' +
    '<div class="main" id="main-area">' +
    '<div class="diagram-pane map-wrap" id="diagram-pane" style="flex-direction:column;align-items:stretch;"></div>' +
    '<div class="annotation-pane hidden" id="annotation-pane">' +
    '<div class="ann-title" id="ann-panel-title">Click a node</div>' +
    '<div id="ann-panel-body"></div><div id="ann-crossrefs"></div>' +
    '</div></div>\n' +
    '<script>\n' +
    'const MASTER_MMD=' + JSON.stringify(masterMapMmd) + ';\n' +
    'const CLUSTERS='   + clustersJson + ';\n' +
    'const GLOSSARY='   + glossaryJson + ';\n' +
    'const PALETTE=[' +
    '  {bg:"#e8edf8",dot:"#3b4fa8"},' + // 1x
    '  {bg:"#fce8e6",dot:"#c0392b"},' + // 2x
    '  {bg:"#e6f4ea",dot:"#27ae60"},' + // 3x
    '  {bg:"#fff3e0",dot:"#e67e22"},' + // 4x
    '  {bg:"#f3e8fd",dot:"#8e44ad"},' + // 5x
    '  {bg:"#fffde7",dot:"#c9a800"},' + // 6x
    '  {bg:"#e0f7fa",dot:"#0097a7"},' + // 7x
    '  {bg:"#fce4ec",dot:"#e91e63"},' + // 8x
    '  {bg:"#f1f8e9",dot:"#558b2f"},' + // 9x
    '];\n' +
    'function _pal(cid){var n=(parseInt(cid,10)||1)-1;return PALETTE[n%PALETTE.length]||PALETTE[0];}\n' +
    'var DIAGRAMS=(function(){var out=[];Object.keys(CLUSTERS).forEach(function(cid){CLUSTERS[cid].processes.forEach(function(p){out.push(Object.assign({cluster:cid,clusterLabel:CLUSTERS[cid].label},p));});});return out;})();\n' +
    'var _ann=sessionStorage.getItem("fc_viewer_annotated")==="1";\n' +
    'mermaid.initialize({startOnLoad:false,theme:"default",securityLevel:"loose"});\n' +
    'function _e(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}\n' +
    'function toggleAnnotations(){_ann=!_ann;sessionStorage.setItem("fc_viewer_annotated",_ann?"1":"0");document.getElementById("annotation-pane").classList.toggle("hidden",!_ann);document.getElementById("toggle-ann-btn").classList.toggle("active",_ann);}\n' +
    'function _crumb(parts){document.getElementById("breadcrumb").innerHTML=parts.map(function(p,i){return i<parts.length-1?\'<a onclick="\'+p.fn+\'" style="color:#2563eb;cursor:pointer;">\'+_e(p.l)+\'</a> \u203a \':_e(p.l);}).join("");}\n' +
    // ── Master Map ──
    'function showMasterMap(){history.pushState({view:"map"},"","#map");document.getElementById("page-title").textContent=' + JSON.stringify(projTitle) + '+" \u2014 Process Map";_crumb([{l:"\u2299 Master Map",fn:"showMasterMap()"}]);renderMasterMap();}\n' +
    'async function renderMasterMap(){\n' +
    '  var pane=document.getElementById("diagram-pane");\n' +
    '  pane.innerHTML=\'<div id="map-svg-tgt"></div>\';\n' +
    '  try{\n' +
    '    var r=await mermaid.render("fcmap_"+Date.now(),MASTER_MMD);\n' +
    '    var svg=r&&r.svg?r.svg:(typeof r==="string"?r:"");\n' +
    '    document.getElementById("map-svg-tgt").innerHTML=svg;\n' +
    '    document.getElementById("map-svg-tgt").querySelectorAll("svg .node").forEach(function(el){\n' +
    '      el.style.cursor="pointer";\n' +
    '      var lbl=el.querySelector("text");\n' +
    '      el.addEventListener("click",function(){\n' +
    '        var txt=lbl?lbl.textContent.trim():"";\n' +
    '        var match=DIAGRAMS.find(function(d){var nl=(d.chapter?d.chapter+" ":"")+d.title.substring(0,26);return nl.replace(/\'/g,\'"\')===txt||d.title===txt;});\n' +
    '        if(match)showProcess(match.slug);\n' +
    '      });\n' +
    '    });\n' +
    '    document.getElementById("map-svg-tgt").querySelectorAll("svg .cluster-label").forEach(function(el){\n' +
    '      el.style.cursor="pointer";\n' +
    '      el.addEventListener("click",function(e){e.stopPropagation();var txt=(el.querySelector("span")||el).textContent.trim();\n' +
    '        var cid=Object.keys(CLUSTERS).find(function(k){var cl=CLUSTERS[k];var h=(cl.code!==cl.label?cl.code+" \u2014 ":"")+cl.label;return h===txt||cl.label===txt;});\n' +
    '        if(cid)showCluster(cid);});\n' +
    '    });\n' +
    '  }catch(e){}\n' +
    '  renderClusterCards();\n' +
    '}\n' +
    'function renderClusterCards(){' +
    '  var pane=document.getElementById("diagram-pane");\n' +
    '  var slugToCluster={};\n' +
    '  Object.keys(CLUSTERS).forEach(function(cid){CLUSTERS[cid].processes.forEach(function(p){slugToCluster[p.slug]=cid;});});\n' +
    '  var html=\'<div class="cmap-grid">\';\n' +
    '  Object.keys(CLUSTERS).forEach(function(cid,ci){\n' +
    '    var cl=CLUSTERS[cid],pal=_pal(cid),num=parseInt(cid,10)||(ci+1);\n' +
    '    var procs=cl.processes.filter(function(p){return p.type!=="subprocess";});\n' +
    '    html+=\'<div class="cmap-cluster" style="background:\'+pal.bg+\';border-color:\'+pal.dot+\'20;">\';\n' +
    '    html+=\'<div class="cmap-cluster-header"><span class="cmap-cluster-num" style="background:\'+pal.dot+\';">\'+num+\'</span><span class="cmap-cluster-title">\'+_e(cl.label)+\'</span></div>\';\n' +
    '    procs.forEach(function(p){\n' +
    '      var seen={},chips="";\n' +
    '      (p.crossRefs||[]).forEach(function(rs){\n' +
    '        var tc=slugToCluster[rs];if(!tc||tc===cid||seen[tc])return;seen[tc]=true;\n' +
    '        var tp=_pal(tc),tn=parseInt(tc,10)||"?";\n' +
    '        var tLabel=(CLUSTERS[tc]||{}).label||tc;\n' +
    '        chips+=\'<span class="cmap-chip" style="background:\'+tp.dot+\'22;color:\'+tp.dot+\';border:1px solid \'+tp.dot+\'55;" title="→ \'+_e(tLabel)+"\\u2197"+tn+" "+_e(tLabel.substring(0,12))+\'</span>\';\n' +
    '      });\n' +
    '      var subBadge=(p.subprocessSlugs&&p.subprocessSlugs.length)?\'<span class="cmap-chip" style="background:rgba(0,0,0,0.06);color:#4b5563;border:1px solid rgba(0,0,0,0.1);">\'+p.subprocessSlugs.length+" sub</span>":"";\n' +
    '      html+=\'<div class="cmap-process" onclick="showProcess(\\\'\'+ p.slug +"\\\')\">\';\n' +
    '      html+=\'<div class="cmap-process-title">\'+(p.chapter?\'<span class="cmap-chapter">\'+_e(p.chapter)+"</span>":"")+_e(p.title)+"</div>";\n' +
    '      if(chips||subBadge)html+=\'<div class="cmap-chips">\'+chips+subBadge+"</div>";\n' +
    '      html+="</div>";\n' +
    '    });\n' +
    '    html+="</div>";\n' +
    '  });\n' +
    '  html+="</div>";\n' +
    '  // Legend\n' +
    '  html+=\'<div class="cmap-legend"><span style="font-weight:600;">Cross-cluster tags:</span>\';\n' +
    '  Object.keys(CLUSTERS).forEach(function(cid,ci){var cl=CLUSTERS[cid],pal=_pal(cid),num=parseInt(cid,10)||(ci+1);html+=\'<span><span class="cmap-legend-dot" style="background:\'+pal.dot+\';"></span>\'+num+" "+_e(cl.label)+"</span>";});\n' +
    '  html+="</div>";\n' +
    '  var ex=pane.querySelector("#crd");if(ex){ex.innerHTML=html;}else{var d=document.createElement("div");d.id="crd";d.innerHTML=html;pane.appendChild(d);}\n' +
    '}\n'
    // ── Cluster View (spec §A.2) ──
    'function showCluster(cid){var cl=CLUSTERS[cid];if(!cl)return;var lbl=(cl.code!==cl.label?cl.code+" \u2014 ":"")+cl.label;history.pushState({view:"cluster",cid:cid},"","#cluster-"+cid);document.getElementById("page-title").textContent=lbl;_crumb([{l:"\u2299 Master Map",fn:"showMasterMap()"},{l:lbl,fn:"showCluster(\'"+cid+"\')"}]);\n' +
    '  var pane=document.getElementById("diagram-pane");\n' +
    '  var procs=cl.processes.filter(function(p){return p.type!=="subprocess";});\n' +
    '  pane.innerHTML=procs.map(function(p){var subs=(p.subprocessSlugs||[]).map(function(ss){var sp=DIAGRAMS.find(function(d){return d.slug===ss;});if(!sp)return "";return \'<div class="indent"><div class="process-card" onclick="showProcess(\\\'\'+ sp.slug +\'\\\')" style="background:#f8fafc;"><div class="process-title">\'+_e(sp.title)+\'<span class="subprocess-badge">sub-process</span></div><div class="process-meta">\'+sp.nodeCount+\' nodes</div></div></div>\';}).join("");return \'<div class="process-card" onclick="showProcess(\\\'\'+ p.slug +\'\\\')">\' + \'<div class="process-title">\'+(p.chapter?\'<span style="color:#6b7280;font-size:10px;margin-right:4px;">\'+_e(p.chapter)+\'</span>\':"")+_e(p.title)+\'</div><div class="process-meta">\'+p.nodeCount+\' nodes</div></div>\'+subs;}).join("");\n' +
    '}\n' +
    // ── Process / Subprocess View ──
    'async function showProcess(slug){\n' +
    '  var d=DIAGRAMS.find(function(x){return x.slug===slug;});if(!d)return;\n' +
    '  var isSub=d.type==="subprocess"&&d.parentSlug;\n' +
    '  var cl=CLUSTERS[d.cluster]||{code:d.cluster,label:d.clusterLabel||d.cluster};\n' +
    '  var clLabel=(cl.code!==cl.label?cl.code+" \u2014 ":"")+cl.label;\n' +
    '  history.pushState({view:"process",slug:slug},"","#"+slug);\n' +
    '  document.getElementById("page-title").textContent=d.title;\n' +
    '  var crumbs=[{l:"\u2299 Master Map",fn:"showMasterMap()"},{l:clLabel,fn:"showCluster(\'"+d.cluster+"\')"}];\n' +
    '  if(isSub){var par=DIAGRAMS.find(function(x){return x.slug===d.parentSlug;});if(par)crumbs.push({l:par.title,fn:"showProcess(\'"+par.slug+"\')"});}\n' +
    '  crumbs.push({l:d.title,fn:"showProcess(\'"+slug+"\')"});\n' +
    '  _crumb(crumbs);\n' +
    '  var pane=document.getElementById("diagram-pane");\n' +
    '  pane.style.flexDirection="";\n' +
    '  pane.innerHTML=\'<div id="ps-tgt"></div>\';\n' +
    '  if(isSub){var parD=DIAGRAMS.find(function(x){return x.slug===d.parentSlug;});if(parD){var pl=document.createElement("div");pl.style.padding="6px 16px";pl.innerHTML=\'<a class="parent-link" onclick="showProcess(\\\'\'+ parD.slug +\'\\\')">\u2191 Parent: \'+_e(parD.title)+\'</a>\';pane.insertBefore(pl,pane.firstChild);}}\n' +
    '  try{\n' +
    '    var res=await mermaid.render("fcproc_"+Date.now(),d.mmd);\n' +
    '    var svg=res&&res.svg?res.svg:(typeof res==="string"?res:"");\n' +
    '    document.getElementById("ps-tgt").innerHTML=svg;\n' +
    '    document.getElementById("ps-tgt").querySelectorAll("svg .node").forEach(function(el){\n' +
    '      var nid=(el.id||"").replace(/^flowchart-/,"").replace(/-\\d+$/,"");\n' +
    '      var ann=d.annotations?d.annotations[nid]:null;\n' +
    '      el.style.cursor="pointer";\n' +
    '      if(ann&&ann.note)el.title=ann.note.substring(0,100)+(ann.note.length>100?"\u2026":"");\n' +
    '      el.addEventListener("click",function(){_showAnn(nid,d);});\n' +
    '    });\n' +
    '  }catch(e){document.getElementById("ps-tgt").innerHTML=\'<pre style="color:red;">\'+_e(e.message)+"</pre>";}\n' +
    '  var cr=document.getElementById("ann-crossrefs");\n' +
    '  if(d.crossRefs&&d.crossRefs.length){cr.innerHTML=\'<div class="ann-field" style="margin-top:8px;"><span class="ann-label">Related processes</span>\'+d.crossRefs.map(function(r){var td=DIAGRAMS.find(function(x){return x.slug===r;});return \'<a class="crossref-link" onclick="showProcess(\\\'\'+ r +\'\\\')">\u2192 \'+_e(td?td.title:r)+\'</a>\';}).join("")+"</div>";}else{cr.innerHTML="";}\n' +
    '}\n' +
    // ── Annotation Panel (spec §A.4.3 + §B.4.4 glossary chips) ──
    'function _showAnn(nodeId,d){\n' +
    '  document.querySelectorAll("svg .node").forEach(function(el){el.classList.remove("node-hl");});\n' +
    '  document.querySelectorAll("svg .node").forEach(function(el){if((el.id||"").replace(/^flowchart-/,"").replace(/-\\d+$/,"")==nodeId)el.classList.add("node-hl");});\n' +
    '  var ann=d&&d.annotations?d.annotations[nodeId]||{}:{};\n' +
    '  document.getElementById("ann-panel-title").textContent=nodeId;\n' +
    '  var html="";\n' +
    '  if(ann.note)html+=\'<div class="ann-field"><span class="ann-label">Note</span>\'+_e(ann.note)+"</div>";\n' +
    '  if(ann.warning)html+=\'<div class="ann-field"><span class="ann-label">\u26a0 Warning</span><div class="ann-warning">\'+_e(ann.warning)+"</div></div>";\n' +
    '  if(ann.waitCondition)html+=\'<div class="ann-field"><span class="ann-label">\u23f3 Wait for</span><div class="ann-wait">\'+_e(ann.waitCondition)+"</div></div>";\n' +
    '  if(ann.ref)html+=\'<div class="ann-field"><span class="ann-label">Reference</span>\'+_e(ann.ref)+"</div>";\n' +
    '  if(ann.glossaryTerms&&ann.glossaryTerms.length){html+=\'<div class="ann-field"><span class="ann-label">Terms</span>\';html+=ann.glossaryTerms.map(function(t){var g=GLOSSARY[t.toLowerCase()];if(g&&(g.expansion||g.definition)){var def=(g.expansion?g.expansion+": ":"")+g.definition;return \'<span class="def-chip" data-def="\'+_e(def.substring(0,180))+\'">\'+_e(t)+\'</span>\';}return \'<span class="chip">\'+_e(t)+\'</span>\';}).join("")+"</div>";}\n' +
    '  if(!html)html=\'<div style="font-size:11px;color:#9ca3af;">No annotations for this node.</div>\';\n' +
    '  document.getElementById("ann-panel-body").innerHTML=html;\n' +
    '  if(!_ann)toggleAnnotations();\n' +
    '}\n' +
    // Browser back + hash restore
    'window.addEventListener("popstate",function(e){if(!e.state)return;if(e.state.view==="process")showProcess(e.state.slug);else if(e.state.view==="cluster")showCluster(e.state.cid);else showMasterMap();});\n' +
    '(function init(){if(_ann){document.getElementById("annotation-pane").classList.remove("hidden");document.getElementById("toggle-ann-btn").classList.add("active");}var h=location.hash.replace("#","");if(h.startsWith("cluster-"))showCluster(h.replace("cluster-",""));else if(h&&h!=="map")showProcess(h);else showMasterMap();})();\n' +
    '<\/script>\n</body>\n</html>';

  _downloadFile(projSlug + '_map.html', html, 'text/html');
  showToast('Exported: ' + projSlug + '_map.html (' + allCharts.length + ' processes)');
}

// ── §A.7.3 Trigger 2: Export All ──────────────────────────────────
// Master map + every individual process diagram, downloaded sequentially.
async function _exportAllHtml() {
  var allCharts = getSaved().filter(function(c){ return !c.isDraft; });
  if (!allCharts.length) { showToast('No saved charts to export'); return; }
  showToast('Exporting ' + (allCharts.length + 1) + ' files\u2026 check Downloads');
  _exportProjectMapHtml();
  for (var i = 0; i < allCharts.length; i++) {
    await (function(entry, delay) {
      return new Promise(function(resolve) {
        setTimeout(function() { _exportProcessHtml(entry); resolve(); }, delay);
      });
    })(allCharts[i], 500 + i * 250);
  }
  showToast('\u2713 All ' + (allCharts.length + 1) + ' HTML files exported');
}

// HTML-escape for use inside exported HTML attribute/text contexts
function _escExport(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Trigger a browser download
function _downloadFile(filename, content, mimeType) {
  var blob = new Blob([content], { type: mimeType + ';charset=utf-8;' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

// ══════════════════════════════════════════════════════════════════
// ── AUTO-SAVE ─────────────────────────────────────────────────────

var AUTOSAVE_KEY   = 'fc_autosave_v1';  // sessionStorage — survives refresh, not browser close
var DRAFT_PREFIX   = 'fc_draft_';       // localStorage draft entries created after every generation
var DRAFT_MAX_AGE  = 86400000;          // 24 hours — drafts older than this are pruned on load
var autosaveTimer  = null;

// ── Tier 1: session autosave (existing — survives refresh) ────────
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(doAutosave, 30000); // 30 seconds
}

function doAutosave() {
  var code = document.getElementById('mermaid-editor').value.trim();
  if (!code) return;
  try {
    sessionStorage.setItem(AUTOSAVE_KEY, JSON.stringify({
      code:      code,
      raw:       pipe.raw ? pipe.raw.substring(0, 2000) : '',
      savedAt:   Date.now(),
      dtype:     document.getElementById('diagram-type').value,
    }));
    showAutosaveIndicator();
  } catch(e) {
    console.warn('Auto-save failed:', e);
  }
  // Also write Tier 2 draft
  _writeDraft(code);
}

// ── Tier 2: localStorage draft — survives browser close ──────────
// Written immediately after every LLM generation and on Tier 1 autosave.
// Promoted to a named entry by confirmSave(). Pruned after 24 hours.
function _writeDraft(code) {
  if (!code) return;
  try {
    var title  = (document.getElementById('chart-name-input') || {}).value || '';
    var dtype  = document.getElementById('diagram-type').value;
    var ts     = Date.now();
    var draftKey = DRAFT_PREFIX + ts;

    // Build a lightweight draft entry using the storage layer
    var chEntry  = ChapterRegistry.getCurrent();
    var chNum    = chEntry ? chEntry.chapterNum : '0';
    var procName = (pipe.extraction && pipe.extraction.source_title) ? pipe.extraction.source_title
                  : title || ('Draft ' + new Date(ts).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }));
    var rawSlug  = processSlug(chNum, procName);
    var drafts   = _getDrafts();
    var existing = drafts.map(function(d){ return d.slug; });
    var finalSlug = dedupeSlug('draft-' + rawSlug, existing);

    var entry = {
      slug:      finalSlug,
      name:      '[Draft] ' + procName,
      code:      code,
      savedAt:   ts,
      isDraft:   true,
      dtype:     dtype,
      meta:      null,  // no full metadata on drafts — set on promote
    };

    // Keep only the most recent draft per base slug (avoid accumulating duplicates)
    var baseSlug = 'draft-' + rawSlug;
    var charts = getSaved().filter(function(c){
      // Remove any previous draft for this same process
      return !(c.isDraft && c.slug && c.slug.startsWith(baseSlug));
    });
    charts.unshift(entry);
    putSaved(charts);

    // Update indicator
    var el = document.getElementById('autosave-indicator');
    if (el) {
      el.textContent = '✓ Draft saved';
      el.classList.add('saved');
      setTimeout(function(){ el.classList.remove('saved'); el.textContent = ''; }, 2500);
    }
  } catch(e) {
    console.warn('Draft write failed:', e.message);
  }
}

function _getDrafts() {
  return getSaved().filter(function(c){ return c.isDraft; });
}

// Prune drafts older than DRAFT_MAX_AGE — called on page load
function _pruneDrafts() {
  var cutoff = Date.now() - DRAFT_MAX_AGE;
  var charts = getSaved().filter(function(c){
    if (!c.isDraft) return true;  // keep named saves always
    return c.savedAt > cutoff;   // keep recent drafts
  });
  putSaved(charts);
  var pruned = getSaved().length; // for debug
}

// Promote a draft to a named save — called by confirmSaveWithMeta()
// Removes the draft entry and writes a proper named entry in its place.
function _promoteDraftIfExists(namedSlug) {
  var charts = getSaved().filter(function(c){
    // Remove any draft whose base slug matches (i.e. same process)
    if (!c.isDraft) return true;
    var base = c.slug ? c.slug.replace(/^draft-/, '') : '';
    var namedBase = namedSlug.replace(/-\d+$/, ''); // strip collision suffix
    return !base.startsWith(namedBase);
  });
  putSaved(charts);
}

function showAutosaveIndicator() {
  var el = document.getElementById('autosave-indicator');
  if (!el) return;
  el.textContent = '✓ Auto-saved';
  el.classList.add('saved');
  setTimeout(function() {
    el.classList.remove('saved');
    el.textContent = '';
  }, 2500);
}

function restoreAutosave() {
  try {
    var stored = sessionStorage.getItem(AUTOSAVE_KEY);
    if (!stored) return;
    var data = JSON.parse(stored);
    if (!data || !data.code) return;
    // Only restore if saved less than 2 hours ago
    if (Date.now() - data.savedAt > 7200000) return;

    var ago = Math.round((Date.now() - data.savedAt) / 60000);
    showToast('Restored auto-saved chart from ' + ago + ' min ago — check ⟲ History tab');

    // Restore code to editor
    document.getElementById('mermaid-editor').value = data.code;
    // Restore raw text if available
    if (data.raw) {
      document.getElementById('input-text').value = data.raw;
      pipe.raw = data.raw;
      document.getElementById('raw-meta').textContent = data.raw.length.toLocaleString() + ' chars';
    }
    // Restore diagram type
    if (data.dtype) document.getElementById('diagram-type').value = data.dtype;

    // Render after short delay (let Mermaid fully init)
    setTimeout(function() {
      var code = document.getElementById('mermaid-editor').value.trim();
      if (code) renderMermaid(code);
    }, 800);
  } catch(e) {
    console.warn('Auto-save restore failed:', e);
  }
}

// Hook auto-save into the editor
document.addEventListener('DOMContentLoaded', function() {
  var editor = document.getElementById('mermaid-editor');
  if (editor) {
    editor.addEventListener('input', function() {
      scheduleAutosave();
    });
  }
});

// ══════════════════════════════════════════════════════════════════
// ── KEYBOARD SHORTCUTS POPUP ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function toggleShortcuts() {
  var popup = document.getElementById('shortcuts-popup');
  popup.style.display = popup.style.display === 'block' ? 'none' : 'block';
}

// Close shortcuts popup on outside click or Escape
document.addEventListener('click', function(e) {
  var popup = document.getElementById('shortcuts-popup');
  if (popup && popup.style.display === 'block') {
    var btn = e.target.closest('[onclick*="toggleShortcuts"]');
    if (!btn && !popup.contains(e.target)) popup.style.display = 'none';
  }
  // Close settings popover on outside click
  var spop = document.getElementById('settings-popover');
  if (spop && spop.classList.contains('open')) {
    var gearBtn = e.target.closest('#settings-gear-btn');
    if (!gearBtn && !spop.contains(e.target)) spop.classList.remove('open');
  }
});

// ── v3.7.0: Settings popover ─────────────────────────────────────
function toggleSettingsPopover() {
  var pop = document.getElementById('settings-popover');
  pop.classList.toggle('open');
}

function stgSaveApiKey() {
  var val = (document.getElementById('apikey') || {}).value || '';
  if (val.trim()) {
    localStorage.setItem('fc_apikey', val.trim());
    _stgSetIndicator('stg-apikey-indicator', true);
  } else {
    localStorage.removeItem('fc_apikey');
    _stgSetIndicator('stg-apikey-indicator', false);
  }
  var btn = document.getElementById('stg-apikey-save');
  if (btn) { btn.textContent = 'Saved ✓'; setTimeout(function(){ btn.textContent = 'Save'; }, 2000); }
}

function stgSavePAT() {
  var val = (document.getElementById('gh-pat') || {}).value || '';
  if (val.trim()) {
    localStorage.setItem('fc_ghpat_persist', val.trim()); // persist across sessions
    sessionStorage.setItem('fc_ghpat', val.trim());
    _stgSetIndicator('stg-pat-indicator', true);
    var syncBtn = document.getElementById('gh-sync-btn');
    if (syncBtn) syncBtn.style.display = '';
  } else {
    localStorage.removeItem('fc_ghpat_persist');
    sessionStorage.removeItem('fc_ghpat');
    _stgSetIndicator('stg-pat-indicator', false);
  }
  var btn = document.getElementById('stg-pat-save');
  if (btn) { btn.textContent = 'Saved ✓'; setTimeout(function(){ btn.textContent = 'Save'; }, 2000); }
}

function _stgSetIndicator(id, saved) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = saved ? '✓ Saved' : '';
  el.style.color = 'var(--green-600)';
  el.style.fontSize = '10px';
  el.style.fontWeight = '600';
}

// ── v3.7.0: Analysis dashboard ───────────────────────────────────
var _analysisPillActive = 'overview';

function renderAnalysisDashboard() {
  var root = document.getElementById('analysis-dashboard-root');
  if (!root) return;
  if (!pipe.extraction || !pipe.extraction.coverage) {
    root.innerHTML = '<div class="analysis-placeholder" style="flex-direction:column;gap:12px;">' +
      '<div style="font-size:28px;opacity:0.25;">⊙</div>' +
      '<div style="font-size:13px;color:var(--gray-500);text-align:center;max-width:260px;">' +
        'Analysis requires a <strong>2-Pass</strong> run.<br>' +
        'Enable <strong>⊕ 2-Pass</strong> in the action bar, then click <strong>Generate Chart</strong>.' +
      '</div>' +
    '</div>';
    return;
  }
  var ex = pipe.extraction;

  root.innerHTML =
    '<div class="analysis-pill-bar" id="an-pill-bar" style="flex-shrink:0;margin:12px 16px 0;">' +
      _anPill('map',      'Map')       +
      _anPill('overview', 'Overview')  +
      _anPill('entities', 'Entities')  +
      _anPill('actors',   'Actors')    +
      _anPill('graveyard','Graveyard') +
      _anPill('tokens',   'Tokens')    +
    '</div>' +
    '<div class="analysis-dashboard" id="an-content">' +
      '<div class="analysis-panel" id="anp-map">'       + _anMap(ex)       + '</div>' +
      '<div class="analysis-panel" id="anp-overview">'  + _anOverview(ex)  + '</div>' +
      '<div class="analysis-panel" id="anp-entities">'  + _anEntities(ex)  + '</div>' +
      '<div class="analysis-panel" id="anp-actors">'    + _anActors(ex)    + '</div>' +
      '<div class="analysis-panel" id="anp-graveyard">' + _anGraveyard(ex) + '</div>' +
      '<div class="analysis-panel" id="anp-tokens">'    + _anTokens(ex)    + '</div>' +
    '</div>';

  _activateAnPill(_analysisPillActive || 'map');
}

function _anPill(id, label) {
  return '<button class="analysis-pill" data-anpill="' + id + '" onclick="_activateAnPill(\'' + id + '\')">' + label + '</button>';
}

function _activateAnPill(id) {
  _analysisPillActive = id;
  var bar = document.getElementById('an-pill-bar');
  if (!bar) return;
  bar.querySelectorAll('.analysis-pill').forEach(function(b) {
    b.classList.toggle('active', b.dataset.anpill === id);
  });
  ['map','overview','entities','actors','graveyard','tokens'].forEach(function(t) {
    var p = document.getElementById('anp-' + t);
    if (p) p.classList.toggle('active', t === id);
  });
  if (id === 'entities') _bindEntityRows();
  if (id === 'map') {
    // Render the saved corpus card grid into its container
    var cmapEl = document.getElementById('cmap-container');
    if (cmapEl) _renderSavedCorpusMap(cmapEl);
  }
}

// ── Map tab ───────────────────────────────────────────────────────
// Builds a process landscape from pipe.extraction data.
// Zero LLM calls. Two views: Mermaid cluster diagram + process card list.
function _anMap(ex) {
  var toc      = ex.toc      || { detected: false, entries: [] };
  var entities = ex.entities || [];
  var actors   = ex.actors   || [];

  // ── Section 1: Saved corpus card grid (primary — always available) ──
  var corpusSection =
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
      '<div class="an-section-title" style="margin:0;">⊙ Process Corpus</div>' +
      '<div style="display:flex;gap:6px;">' +
        '<button class="an-map-generate-btn" onclick="shareProjectMapURL()" style="font-size:11px;padding:4px 10px;" title="Share this project map via URL">⇗ Share Map</button>' +
        '<button class="an-map-generate-btn" onclick="_exportProjectMapHtml()" style="font-size:11px;padding:4px 10px;" title="Export interactive HTML map">↗ Export Map</button>' +
      '</div>' +
    '</div>' +
    '<div id="cmap-container"></div>';

  // ── Section 2: Live extraction map (secondary — shown after a run) ──
  var processes = _buildProcessList(toc, entities);
  var hasLive = processes.length > 0;

  var liveSection = '';
  if (hasLive) {
    var processCount   = processes.length;
    var subprocCount   = processes.reduce(function(n, p){ return n + p.subprocesses.length; }, 0);
    var decisionCount  = entities.filter(function(e){ return (e.type||'').toLowerCase() === 'decision'; }).length;
    var stepCount      = entities.filter(function(e){
      var t = (e.type||'').toLowerCase(); return t === 'step' || t === 'process';
    }).length;

    var meta = '<div class="an-map-meta" style="margin-bottom:6px;">' +
      '<span>Processes: <strong>' + processCount + '</strong></span>' +
      '<span>Sub-processes: <strong>' + subprocCount + '</strong></span>' +
      '<span>Steps: <strong>' + stepCount + '</strong></span>' +
      '<span>Decisions: <strong>' + decisionCount + '</strong></span>' +
      (toc.cluster_hint ? '<span>Cluster: <strong>' + _esc(toc.cluster_hint) + '</strong></span>' : '') +
    '</div>';

    var cards = processes.map(function(proc, pi) {
      var stepChips = proc.steps.slice(0, 6).map(function(s) {
        var t = (s.type||'step').toLowerCase();
        var cls = t === 'decision' ? ' decision' : t === 'subprocess' ? ' subprocess' : '';
        return '<span class="an-map-step-chip' + cls + '" title="' + _esc(s.label||'') + '">' +
          _esc((s.label||'').substring(0, 20)) + (s.label && s.label.length > 20 ? '…' : '') +
        '</span>';
      }).join('');
      var more = proc.steps.length > 6
        ? '<span class="an-map-step-chip" style="opacity:0.6;">+' + (proc.steps.length - 6) + '</span>' : '';

      var genBtn = '<button class="an-map-generate-btn" style="font-size:11px;padding:3px 8px;" ' +
        'onclick="anMapGenerateProcess(' + pi + ')" title="Generate diagram">▶</button>';

      return '<div class="an-map-process-card" id="an-map-card-' + pi + '">' +
        '<div class="an-map-process-header">' +
          '<span class="an-map-process-title">' + _esc(proc.title) + '</span>' +
          '<div style="display:flex;gap:4px;align-items:center;">' +
            '<span style="font-size:10px;color:var(--gray-400);">' + proc.steps.length + ' steps</span>' +
            genBtn +
          '</div>' +
        '</div>' +
        (proc.steps.length ? '<div class="an-map-process-steps">' + stepChips + more + '</div>' : '') +
      '</div>';
    }).join('');

    liveSection =
      '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--gray-200);">' +
        '<div class="an-section-title" style="margin-bottom:6px;">Current extraction: ' +
          _esc((ex.source_title || 'document')) +
        '</div>' +
        meta +
        '<div class="an-map-process-list">' + cards + '</div>' +
      '</div>';
  }

  return '<div class="an-map-wrap">' + corpusSection + liveSection + '</div>';
}

// Build a structured process list from toc + entities
function _buildProcessList(toc, entities) {
  var processes = [];

  // Primary source: TOC level-1 entries
  if (toc.detected && toc.entries && toc.entries.length) {
    var level1 = toc.entries.filter(function(e){ return e.level === 1; });
    var level2 = toc.entries.filter(function(e){ return e.level === 2; });

    level1.forEach(function(l1, i) {
      var nextL1Line = (level1[i+1] || {}).lineIndex || Infinity;
      // Sub-entries: TOC level 2 entries that fall between this and the next level 1
      var subs = level2.filter(function(l2){
        return l2.lineIndex > l1.lineIndex && l2.lineIndex < nextL1Line;
      });
      // Steps: entities whose provenance falls in this section
      var sectionSteps = entities.filter(function(e) {
        var ci = (e.provenance || {}).chunk_index || 0;
        return ci >= l1.lineIndex && ci < nextL1Line;
      });
      // Actors for this process
      var actorSet = {};
      sectionSteps.forEach(function(s){ if (s.actor) actorSet[s.actor] = true; });

      processes.push({
        title:       l1.title || l1.label || ('Process ' + (i+1)),
        label:       l1.label || '',
        lineIndex:   l1.lineIndex,
        subprocesses: subs.map(function(s){ return s.title; }),
        steps:       sectionSteps,
        actors:      Object.keys(actorSet),
      });
    });
  }

  // Fallback: if no TOC, group by subprocess entities from Pass 1
  if (!processes.length) {
    var subprocEntities = entities.filter(function(e){
      return (e.type||'').toLowerCase() === 'subprocess';
    });
    if (subprocEntities.length) {
      subprocEntities.forEach(function(sp, i) {
        processes.push({
          title:        sp.label || ('Process ' + (i+1)),
          label:        '',
          lineIndex:    (sp.provenance || {}).chunk_index || i,
          subprocesses: [],
          steps:        [],
          actors:       sp.actor ? [sp.actor] : [],
        });
      });
    } else {
      // Last resort: treat entire extraction as one process
      var actorSet2 = {};
      entities.forEach(function(e){ if (e.actor) actorSet2[e.actor] = true; });
      processes.push({
        title:        pipe.extraction.source_title || 'Process',
        label:        '',
        lineIndex:    0,
        subprocesses: [],
        steps:        entities,
        actors:       Object.keys(actorSet2),
      });
    }
  }

  return processes;
}

// Render the Mermaid landscape diagram into an-map-diagram
function _renderLandscapeDiagram() {
  var wrap = document.getElementById('an-map-diagram');
  if (!wrap) return;
  if (!pipe.extraction) return;

  var ex         = pipe.extraction;
  var toc        = ex.toc || { detected: false, entries: [] };
  var entities   = ex.entities || [];
  var processes  = _buildProcessList(toc, entities);

  if (!processes.length) {
    wrap.innerHTML = '<div class="an-empty-state">No processes to map.</div>';
    return;
  }

  // Build Mermaid flowchart: cluster map
  // Layout: each process is a subgraph; subprocesses are nodes inside
  var lines = ['flowchart TD'];
  var actorColors = ['#534AB7','#185FA5','#0F6E56','#854F0B','#6b7280'];
  var nodeCounter = 0;
  var allNodeIds  = [];
  var processNodeIds = []; // first node of each process for sequencing

  processes.forEach(function(proc, pi) {
    var safeId = 'P' + pi;
    var procTitle = proc.title.substring(0, 30);

    // Each process is a subgraph
    lines.push('  subgraph ' + safeId + '["' + procTitle.replace(/"/g,"'") + '"]');

    var firstNodeId = null;

    // Subprocess nodes
    if (proc.subprocesses.length) {
      proc.subprocesses.forEach(function(sp, si) {
        var nid = safeId + '_S' + si;
        lines.push('    ' + nid + '[["' + sp.substring(0,24).replace(/"/g,"'") + '"]]');
        allNodeIds.push({ id: nid, type: 'subprocess' });
        if (!firstNodeId) firstNodeId = nid;
      });
    }

    // Decision count badge node
    var decs = proc.steps.filter(function(s){ return (s.type||'').toLowerCase() === 'decision'; }).length;
    var steps = proc.steps.filter(function(s){ var t=(s.type||'').toLowerCase(); return t==='step'||t==='process'; }).length;
    if (steps + decs > 0) {
      var statId = safeId + '_stat';
      var statLabel = steps + ' steps' + (decs ? ', ' + decs + ' decisions' : '');
      lines.push('    ' + statId + '["' + statLabel + '"]');
      allNodeIds.push({ id: statId, type: 'stat' });
      if (!firstNodeId) firstNodeId = statId;
    }

    lines.push('  end');
    processNodeIds.push({ pid: safeId, firstNodeId: firstNodeId, proc: proc });
  });

  // Sequential connections between processes (if TOC has ordering)
  if (processNodeIds.length > 1) {
    for (var i = 0; i < processNodeIds.length - 1; i++) {
      var a = processNodeIds[i];
      var b = processNodeIds[i + 1];
      if (a.firstNodeId && b.firstNodeId) {
        lines.push('  ' + a.firstNodeId + ' --> ' + b.firstNodeId);
      }
    }
  }

  // classDefs
  lines.push('  classDef procStep     fill:#E6F1FB,stroke:#2563eb,stroke-width:1px,color:#1e3a5f');
  lines.push('  classDef procSubproc  fill:#EEEDFE,stroke:#7c3aed,stroke-width:1px,color:#3C3489');
  lines.push('  classDef procStat     fill:#f9fafb,stroke:#d1d5db,stroke-width:1px,color:#6b7280,font-size:11px');

  allNodeIds.forEach(function(n) {
    var cls = n.type === 'subprocess' ? 'procSubproc' : n.type === 'stat' ? 'procStat' : 'procStep';
    lines.push('  class ' + n.id + ' ' + cls);
  });

  var mmd = lines.join('\n');

  // Render into the diagram div
  wrap.innerHTML = '<div id="an-map-svg-target" style="min-height:80px;"></div>';
  try {
    mermaid.render('fcmap' + Date.now(), mmd).then(function(result) {
      var svgStr = result && result.svg ? result.svg : (typeof result === 'string' ? result : '');
      if (svgStr) {
        wrap.innerHTML = svgStr;
        wrap.querySelector('svg').style.maxWidth = 'none';
      } else {
        _renderLandscapeList(wrap);
      }
    }).catch(function(e) {
      console.warn('Landscape diagram render failed:', e.message);
      _renderLandscapeList(wrap);
    });
  } catch(e) {
    console.warn('Landscape diagram render failed:', e.message);
    _renderLandscapeList(wrap);
  }
}

// Fallback: plain text process tree when Mermaid fails
function _renderLandscapeList(wrap) {
  if (!pipe.extraction) return;
  var processes = _buildProcessList(pipe.extraction.toc || {}, pipe.extraction.entities || []);
  var html = processes.map(function(p) {
    var subs = p.subprocesses.map(function(s){
      return '<div style="margin-left:20px;font-size:11px;color:var(--gray-500);">↳ ' + _esc(s) + '</div>';
    }).join('');
    return '<div style="padding:6px 0;border-bottom:1px solid var(--gray-100);">' +
      '<div style="font-size:13px;font-weight:500;color:var(--gray-800);">' + _esc(p.title) + '</div>' +
      subs +
    '</div>';
  }).join('');
  wrap.innerHTML = html || '<div class="an-empty-state">No processes to display.</div>';
}

// Generate a diagram for a specific process from the map
async function anMapGenerateProcess(processIndex) {
  if (!pipe.extraction || !pipe.extraction._entities_full) {
    showToast('No extraction data — run a 2-pass conversion first'); return;
  }
  var processes = _buildProcessList(pipe.extraction.toc || {}, pipe.extraction.entities || []);
  var proc = processes[processIndex];
  if (!proc) return;

  // Filter entities to only this process's steps
  var filteredEntities = Object.assign({}, pipe.extraction._entities_full, {
    processName: proc.title,
    steps: proc.steps.length
      ? proc.steps.map(function(s) {
          // Find the matching step in _entities_full by label
          var full = (pipe.extraction._entities_full.steps || []).find(function(fs){
            return fs.label === s.label;
          });
          return full || { id: 'S' + Math.random().toString(36).slice(2), label: s.label, type: s.type || 'step', actor: s.actor };
        })
      : pipe.extraction._entities_full.steps,
    actors: proc.actors.length ? proc.actors : pipe.extraction.actors,
  });

  var btn = document.getElementById('an-map-card-' + processIndex);
  if (btn) btn.classList.add('active');

  var dtype = document.getElementById('diagram-type').value;
  var apiKey = (document.getElementById('apikey') || {}).value || '';

  showToast('Generating diagram for: ' + proc.title + '…');

  try {
    // Build a temporary extraction result for this process only
    var tempExtraction = Object.assign({}, pipe.extraction, {
      _entities_full: filteredEntities,
      source_title: proc.title,
      actors: proc.actors.length ? proc.actors : pipe.extraction.actors,
    });

    var graph = await buildGraph(tempExtraction, dtype);
    if (!graph) throw new Error('buildGraph returned null');
    pipe.graph = graph;

    var mmd = graph._fromSchema
      ? injectColours(sanitiseLabels(graphToMermaid(graph, dtype)))
      : injectColours(sanitiseLabels(repairMermaid(graph._rawFallback || '')));

    document.getElementById('mermaid-editor').value = mmd;
    switchRightTab('graph');
    await renderMermaid(mmd);
    pushHistory(mmd, dtype);
    showToast('✓ Diagram: ' + proc.title);
  } catch(e) {
    handleAPIError(e, 'Map generate');
  } finally {
    if (btn) btn.classList.remove('active');
  }
}

// ── Overview tab ─────────────────────────────────────────────────
function _anOverview(ex) {
  var cov   = ex.coverage || {};
  var ratio = cov.ratio || 0;
  var pct   = Math.round(ratio * 100);
  var passed = cov.passed;
  var fillColor = passed ? '#0F6E56' : '#854F0B';
  var badgeHtml = passed
    ? '<span class="an-badge-pass">Passed</span>'
    : '<span class="an-badge-fail">Failed</span>';

  var dt = ex.extracted_at ? new Date(ex.extracted_at) : null;
  var dtStr = dt ? (dt.getDate() + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getMonth()] + ' ' + dt.getFullYear() + ' · ' + String(dt.getUTCHours()).padStart(2,'0') + ':' + String(dt.getUTCMinutes()).padStart(2,'0') + ' UTC') : '—';

  // Actor node counts
  var actorCounts = {};
  (ex.entities || []).forEach(function(e) { actorCounts[e.actor] = (actorCounts[e.actor] || 0) + 1; });
  var maxActor = Math.max.apply(null, Object.values(actorCounts).concat([1]));
  var actorColors = ['#534AB7','#185FA5','#0F6E56','#854F0B'];
  var actorBarsHtml = (ex.actors || []).map(function(a, i) {
    var cnt  = actorCounts[a] || 0;
    var w    = Math.round((cnt / maxActor) * 100);
    var col  = actorColors[i % actorColors.length];
    return '<div class="an-actor-row">' +
      '<span class="an-actor-name">' + _esc(a) + '</span>' +
      '<div class="an-actor-bar-track"><div class="an-actor-bar-fill" style="width:' + w + '%;background:' + col + ';"></div></div>' +
      '<span class="an-actor-count">' + cnt + '</span>' +
    '</div>';
  }).join('');

  return '<div class="an-section-title">Document</div>' +
    '<div class="an-meta-grid">' +
      '<span class="an-meta-label">Document title</span><span class="an-meta-value">' + _esc(ex.source_title || '—') + '</span>' +
      '<span class="an-meta-label">Doc ID</span><span class="an-meta-value an-meta-mono">' + _esc(ex.doc_id || '—') + '</span>' +
      '<span class="an-meta-label">Extracted</span><span class="an-meta-value">' + dtStr + '</span>' +
      '<span class="an-meta-label">Model</span><span class="an-meta-value">' + _esc(ex.model_used || '—') + '</span>' +
    '</div>' +
    '<div class="an-coverage-wrap">' +
      '<div class="an-coverage-header"><span>Decision coverage</span>' + badgeHtml + '</div>' +
      '<div class="an-coverage-bar-track"><div class="an-coverage-bar-fill" style="width:' + pct + '%;background:' + fillColor + ';"></div></div>' +
      '<div class="an-coverage-footer"><span>Threshold: 70%</span><span>' + pct + '%</span></div>' +
    '</div>' +
    _anTocBlock(ex.toc) +
    '<div class="an-metric-cards">' +
      _anCard((ex.entities || []).length, 'Entities') +
      _anCard((ex.decisions || []).length, 'Decisions') +
      _anCard((ex.actors || []).length, 'Actors') +
      _anCard(cov.retry_triggered ? 'Yes' : 'No', 'Retry') +
    '</div>' +
    '<div class="an-section-title">Actors</div>' +
    '<div class="an-actor-bars">' + (actorBarsHtml || '<span style="font-size:12px;color:var(--gray-400);">No actors extracted.</span>') + '</div>';
}

function _anCard(val, label) {
  return '<div class="an-metric-card"><div class="an-metric-card-value">' + val + '</div><div class="an-metric-card-label">' + label + '</div></div>';
}

// v3.8.0: TOC block for Overview tab
function _anTocBlock(toc) {
  if (!toc) return '';
  var detectedBadge = toc.detected
    ? '<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;background:#E1F5EE;color:#085041;">Structure detected</span>'
    : '<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;background:var(--gray-100);color:var(--gray-500);">No structure</span>';

  var typeColors = {
    'procedural':   'background:#E6F1FB;color:#0C447C',
    'reference':    'background:#EEEDFE;color:#3C3489',
    'multi-process':'background:#FAEEDA;color:#633806',
  };
  var hint = toc.doc_type_hint || 'unknown';
  var typeStyle = typeColors[hint] || 'background:var(--gray-100);color:var(--gray-600)';
  var typePill = '<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;' + typeStyle + ';">' + _esc(hint) + '</span>';

  return '<div style="display:flex;flex-direction:column;gap:5px;padding:10px 12px;background:var(--gray-50);border:1px solid var(--gray-200);border-radius:8px;">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;">' +
      '<span style="font-size:12px;font-weight:500;color:var(--gray-700);">Document structure</span>' +
      detectedBadge +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:10px;font-size:12px;color:var(--gray-600);">' +
      '<span>' + toc.entry_count + ' section' + (toc.entry_count !== 1 ? 's' : '') + ' found</span>' +
      typePill +
      (toc.cluster_hint ? '<span style="color:var(--gray-500);">Cluster: ' + _esc(toc.cluster_hint) + '</span>' : '') +
    '</div>' +
  '</div>';
}

// ── Entities tab ─────────────────────────────────────────────────
var _entityFilter = 'all';

function _anEntities(ex) {
  var filters = ['all','step','decision','subprocess','outcome'];
  var pillsHtml = filters.map(function(f) {
    var label = f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1) + 's';
    return '<button class="an-filter-pill' + (f === _entityFilter ? ' active' : '') + '" onclick="_setEntityFilter(\'' + f + '\')">' + label + '</button>';
  }).join('');

  var rows = (ex.entities || []).map(function(e, i) {
    return _anEntityRow(e, i);
  }).join('');

  return '<div class="an-filter-pills" id="an-entity-filters">' + pillsHtml + '</div>' +
    '<div class="an-entity-list" id="an-entity-list">' + rows + '</div>';
}

function _anEntityRow(e, i) {
  var typeBadge = _entityTypeBadge(e.type);
  var conf = e.confidence !== undefined ? e.confidence : 0.8;
  var confPct = Math.round(conf * 100);
  var confColor = conf >= 0.8 ? '#0F6E56' : conf >= 0.5 ? '#854F0B' : '#dc2626';
  return '<div class="an-entity-row" data-entity-idx="' + i + '">' +
    typeBadge +
    '<span class="an-entity-label" title="' + _esc(e.label || '') + '">' + _esc(e.label || '') + '</span>' +
    (e.actor ? '<span class="an-actor-pill">' + _esc(e.actor) + '</span>' : '') +
    '<div class="an-conf-bar-wrap">' +
      '<div class="an-conf-bar-track"><div class="an-conf-bar-fill" style="width:' + confPct + '%;background:' + confColor + ';"></div></div>' +
      '<span class="an-conf-label">' + confPct + '%</span>' +
    '</div>' +
  '</div>';
}

function _entityTypeBadge(type) {
  var styles = {
    step:       'background:#E6F1FB;color:#0C447C',
    decision:   'background:#FAEEDA;color:#633806',
    subprocess: 'background:#EEEDFE;color:#3C3489',
    outcome:    'background:#EAF3DE;color:#27500A',
  };
  var s = styles[(type || 'step').toLowerCase()] || styles.step;
  return '<span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;' + s + ';flex-shrink:0;">' + _esc((type || 'step').toLowerCase()) + '</span>';
}

function _setEntityFilter(f) {
  _entityFilter = f;
  if (!pipe.extraction) return;
  var list = document.getElementById('an-entity-list');
  if (!list) return;
  document.querySelectorAll('.an-filter-pill').forEach(function(p) {
    p.classList.toggle('active', p.textContent.toLowerCase().startsWith(f === 'all' ? 'all' : f));
  });
  var entities = pipe.extraction.entities || [];
  var filtered = f === 'all' ? entities : entities.filter(function(e){ return (e.type||'').toLowerCase() === f; });
  list.innerHTML = filtered.map(function(e, i) { return _anEntityRow(e, i); }).join('');
  _bindEntityRows();
}

var _openEntityIdx = -1;
function _bindEntityRows() {
  var list = document.getElementById('an-entity-list');
  if (!list) return;
  list.querySelectorAll('.an-entity-row').forEach(function(row) {
    row.onclick = function() {
      var idx = parseInt(row.dataset.entityIdx, 10);
      var existing = list.querySelector('.an-provenance-box');
      if (existing) existing.remove();
      if (_openEntityIdx === idx) { _openEntityIdx = -1; return; }
      _openEntityIdx = idx;
      var entity = (pipe.extraction && pipe.extraction.entities) ? pipe.extraction.entities[idx] : null;
      if (!entity) return;
      var prov = (entity.provenance && entity.provenance.sentence) ? entity.provenance.sentence : '(no provenance recorded)';
      var box = document.createElement('div');
      box.className = 'an-provenance-box';
      box.textContent = prov;
      row.insertAdjacentElement('afterend', box);
    };
  });
}

// ── Actors tab ───────────────────────────────────────────────────
function _anActors(ex) {
  var actorColors = ['#534AB7','#185FA5','#0F6E56','#854F0B'];
  var entities = ex.entities || [];
  var actorCounts = {};
  entities.forEach(function(e) { actorCounts[e.actor] = (actorCounts[e.actor] || 0) + 1; });
  var total = entities.length || 1;
  var maxC = Math.max.apply(null, Object.values(actorCounts).concat([1]));

  var cards = (ex.actors || []).map(function(a, i) {
    var cnt   = actorCounts[a] || 0;
    var pct   = Math.round((cnt / total) * 100);
    var w     = Math.round((cnt / maxC) * 100);
    var col   = actorColors[i % actorColors.length];
    var steps = entities.filter(function(e){ return e.actor === a && (e.type||'').toLowerCase() === 'step'; }).length;
    var decs  = entities.filter(function(e){ return e.actor === a && (e.type||'').toLowerCase() === 'decision'; }).length;
    var subs  = entities.filter(function(e){ return e.actor === a && (e.type||'').toLowerCase() === 'subprocess'; }).length;
    return '<div class="an-actor-card">' +
      '<div class="an-actor-card-header">' +
        '<div class="an-actor-dot" style="background:' + col + ';"></div>' +
        '<span class="an-actor-card-name">' + _esc(a) + '</span>' +
        '<span class="an-actor-card-stat">' + cnt + ' nodes · ' + pct + '%</span>' +
      '</div>' +
      '<div class="an-actor-card-breakdown">Steps: ' + steps + ' · Decisions: ' + decs + ' · Subprocesses: ' + subs + '</div>' +
      '<div class="an-actor-bar-track"><div class="an-actor-bar-fill" style="width:' + w + '%;background:' + col + ';"></div></div>' +
    '</div>';
  }).join('');

  return '<div class="an-actor-cards">' + (cards || '<div class="an-empty-state">No actors extracted.</div>') + '</div>';
}

// ── Graveyard tab ────────────────────────────────────────────────
function _anGraveyard(ex) {
  var g = ex.graveyard || [];
  if (!g.length) {
    return '<div class="an-empty-state">' +
      '<span style="font-size:24px;">✓</span>' +
      'Nothing dropped — all detected entities were captured in the graph.' +
    '</div>';
  }
  var reasonColors = {
    junk_filter:              'background:var(--gray-100);color:var(--gray-600)',
    below_coverage_threshold: 'background:#FAEEDA;color:#633806',
    duplicate:                'background:var(--blue-50);color:var(--blue-700)',
  };
  var rows = g.map(function(item) {
    var rs = reasonColors[item.reason] || reasonColors.junk_filter;
    var prov = (item.provenance && item.provenance.sentence) ? item.provenance.sentence : '';
    return '<div class="an-graveyard-row">' +
      '<div class="an-graveyard-label">' +
        _esc(item.label || '—') +
        '<span class="an-reason-badge" style="' + rs + ';">' + _esc(item.reason || 'unknown') + '</span>' +
      '</div>' +
      (prov ? '<div class="an-graveyard-sentence">' + _esc(prov) + '</div>' : '') +
    '</div>';
  }).join('');
  return '<div class="an-graveyard-list">' + rows + '</div>';
}

// ── Tokens tab ───────────────────────────────────────────────────
function _anTokens(ex) {
  var stats = ex.stats || {};
  var stages = [
    { label: 'Decision pre-pass', s: stats.pre_pass  || { input: 0, output: 0 } },
    { label: 'Pass 1 extraction', s: stats.pass_1    || { input: 0, output: 0 } },
    { label: 'Pass 2 graph',      s: stats.pass_2    || { input: 0, output: 0 } },
  ];
  var totalIn = 0, totalOut = 0;
  var cards = stages.map(function(st) {
    var inp  = st.s.input  || 0;
    var out  = st.s.output || 0;
    var cost = (inp * 0.000003) + (out * 0.000015);
    totalIn  += inp; totalOut += out;
    return '<div class="an-token-card">' +
      '<div class="an-token-card-title">' + st.label + '</div>' +
      '<div class="an-token-row"><span>Input tokens</span><span>' + inp.toLocaleString() + '</span></div>' +
      '<div class="an-token-row"><span>Output tokens</span><span>' + out.toLocaleString() + '</span></div>' +
      '<hr class="an-token-divider">' +
      '<div class="an-token-row"><span>Est. cost</span><span>$' + cost.toFixed(4) + '</span></div>' +
    '</div>';
  }).join('');
  var totalCost = (totalIn * 0.000003) + (totalOut * 0.000015);
  return '<div class="an-token-cards">' + cards + '</div>' +
    '<div class="an-token-total">' +
      '<span class="an-token-total-label">Total this run</span>' +
      '<span class="an-token-total-value">' + (totalIn + totalOut).toLocaleString() + ' tokens · $' + totalCost.toFixed(4) + '</span>' +
    '</div>';
}

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── v3.7.0: Update Analysis tab state after a run ────────────────
function _updateAnalysisTabState() {
  var btn = document.getElementById('rtab-analysis');
  if (!btn) return;
  var hasData = pipe.extraction && pipe.extraction.coverage;
  // Tab is always clickable — remove disabled class entirely
  btn.classList.remove('rtab-analysis-disabled');
  // Update coverage dot
  var dot = btn.querySelector('.coverage-dot');
  if (dot) dot.remove();
  if (hasData) {
    var cov = pipe.extraction.coverage;
    var dotColor = cov.passed ? '#0F6E56' : '#854F0B';
    var dotEl = document.createElement('span');
    dotEl.className = 'coverage-dot';
    dotEl.style.background = dotColor;
    btn.appendChild(dotEl);
  }
}

// ── v3.7.0: Overwrite _showExtractionStatus to also update tab state
// and append "View analysis" link
function _showExtractionStatus(extraction) {
  try {
    if (!extraction) return;
    var cov    = extraction.coverage || {};
    var pct    = Math.round((cov.ratio || 0) * 100) + '%';
    var dropped = (extraction.graveyard || []).length;
    var actors  = (extraction.actors || []).join(' · ');
    var msg = 'Extraction: ' + pct + ' decision coverage · ' + dropped + ' dropped · ' + actors;
    var statusEl = document.getElementById('api-status');
    if (statusEl) {
      statusEl.innerHTML = _esc(msg) + ' &nbsp;<a href="#" style="color:var(--blue-500);font-size:11px;text-decoration:none;" onclick="event.preventDefault();switchRightTab(\'analysis\')">· View analysis ↗</a>';
    }
    console.log(msg);
  } catch(e) { /* non-critical */ }
  _updateAnalysisTabState();
  _updateDiagramControlsBar();
}

// ── v3.9.0 / v3.10.0: Diagram Controls Bar ───────────────────────
// State — all Tier 0 (instant, no API call) except actor exclude/apply
var _dcColorsOn    = true;
var _dcNotesOn     = true;
var _dcClusterOn   = true;
var _dcEdgeLabels  = true;
var _dcCurve       = 'basis';
var _dcFilter      = 'all';
var _dcDtype       = null;
var _dcSpacing     = 'normal';  // 'normal' | 'compact' | 'dense'
var _dcActorExcluded = {};

function _updateDiagramControlsBar() {
  var bar = document.getElementById('diagram-controls-bar');
  if (!bar) return;
  var hasDiagram = !!document.getElementById('chart-inner').querySelector('svg');
  if (!hasDiagram) return;
  bar.classList.add('visible');

  var orient = (document.getElementById('lane-orient') || {value:'TD'}).value;
  var dtype  = _dcDtype || document.getElementById('diagram-type').value;

  var ids = {
    'dc-orient-td':    orient === 'TD',
    'dc-orient-lr':    orient === 'LR',
    'dc-colors-on':    _dcColorsOn,
    'dc-colors-off':  !_dcColorsOn,
    'dc-cluster-on':   _dcClusterOn,
    'dc-cluster-off': !_dcClusterOn,
    'dc-edgelbl-on':   _dcEdgeLabels,
    'dc-edgelbl-off': !_dcEdgeLabels,
    'dc-curve-basis':  _dcCurve === 'basis',
    'dc-curve-linear': _dcCurve === 'linear',
    'dc-curve-step':   _dcCurve === 'step',
    'dc-spacing-normal':  _dcSpacing === 'normal',
    'dc-spacing-compact': _dcSpacing === 'compact',
    'dc-spacing-dense':   _dcSpacing === 'dense',
    'dc-notes-show':   _dcNotesOn,
    'dc-notes-hide':  !_dcNotesOn,
    'dc-filter-all':   _dcFilter === 'all',
    'dc-filter-decs':  _dcFilter === 'decisions',
    'dc-filter-key':   _dcFilter === 'steps',
    'dc-dtype-flowchart': dtype === 'flowchart',
    'dc-dtype-swimlane':  dtype === 'swimlane',
  };
  Object.keys(ids).forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.classList.toggle('active', ids[id]);
  });

  // Actor pills: show when pipe.extraction has actors
  var actorsGroup = document.getElementById('dc-actors-group');
  if (actorsGroup) {
    var hasActors = pipe.extraction && pipe.extraction.actors && pipe.extraction.actors.length >= 2;
    actorsGroup.style.display = hasActors ? '' : 'none';
    if (hasActors) _renderDcActorPills();
  }
}

function _renderDcActorPills() {
  var el = document.getElementById('dc-actor-pills');
  if (!el || !pipe.extraction) return;
  var actors = pipe.extraction.actors || [];
  var colors = ['#534AB7','#185FA5','#0F6E56','#854F0B','#6b7280'];
  el.innerHTML = actors.map(function(a, i) {
    var excluded = !!_dcActorExcluded[a];
    var col = colors[i % colors.length];
    return '<button class="dc-actor-pill' + (excluded ? ' excluded' : '') + '"' +
      ' style="background:' + (excluded ? '#f9fafb' : col + '18') + ';border-color:' + col + ';color:' + (excluded ? '#9ca3af' : col) + ';"' +
      ' title="' + (excluded ? 'Click to include' : 'Click to exclude') + ' actor"' +
      ' onclick="_dcToggleActor(\'' + a.replace(/'/g,"\\'") + '\')">' + a + '</button>';
  }).join('');
}

function _dcToggleActor(name) {
  _dcActorExcluded[name] = !_dcActorExcluded[name];
  _renderDcActorPills();
}

// ── Tier 0 setters — all instant, zero API calls ──────────────────

function dcSetOrient(val) {
  var sel = document.getElementById('lane-orient');
  if (sel) sel.value = val;
  _dcRerender();
}

function dcSetColors(on) { _dcColorsOn = on; _dcRerender(); }

function dcSetCluster(on) {
  _dcClusterOn = on;
  try { mermaid.initialize(getMermaidConfig()); } catch(e) {}
  _dcRerender();
}

function dcSetEdgeLabels(on) { _dcEdgeLabels = on; _dcRerender(); }

function dcSetCurve(curve) {
  _dcCurve = curve;
  try { mermaid.initialize(getMermaidConfig()); } catch(e) {}
  _dcRerender();
}

function dcSetNotes(show) { _dcNotesOn = show; _dcRerender(); }

function dcSetSpacing(s) {
  _dcSpacing = s;
  try { mermaid.initialize(getMermaidConfig()); } catch(e) {}
  _dcRerender();
}

function dcSetFilter(filter) { _dcFilter = filter; _dcRerender(); }

// Tier 0: diagram type — instant re-render of existing pipe.graph in new dtype.
// pipe.graph already has lane + subgraph data; graphToMermaid handles both dtypes.
function dcSetDtype(dtype) {
  _dcDtype = dtype;
  document.getElementById('diagram-type').value = dtype;
  onDiagramTypeChange();
  _dcRerender();
}

function _applyMermaidConfig() {
  try { mermaid.initialize(getMermaidConfig()); } catch(e) {}
}

// ── Core re-render ────────────────────────────────────────────────
function _dcRerender() {
  var dtype  = _dcDtype || document.getElementById('diagram-type').value;
  var orient = (document.getElementById('lane-orient') || {value:'TD'}).value;

  _updateDiagramControlsBar();

  // Single-pass fallback: no pipe.graph — operate on Mermaid source directly
  if (!pipe.graph) {
    var src = document.getElementById('mermaid-editor').value;
    if (!src) return;
    src = src.replace(/^(flowchart\s+)\w+/m, '$1' + orient)
             .replace(/^(graph\s+)\w+/m,     '$1' + orient);
    if (!_dcEdgeLabels) src = src.replace(/-->\|[^|]+\|/g, '-->');
    if (!_dcNotesOn)    src = src.split('\n').filter(function(l){ return !/ class \S+ note/.test(l); }).join('\n');
    var mmd = _dcColorsOn ? injectColours(src) : src.split('\n').filter(function(l){
      var t = l.trim(); return !t.startsWith('classDef ') && !t.startsWith('class ');
    }).join('\n');
    document.getElementById('mermaid-editor').value = mmd;
    renderMermaid(mmd);
    return;
  }

  // Two-pass path: clone graph, apply all filters
  var nodes     = (pipe.graph.nodes     || []).slice();
  var edges     = (pipe.graph.edges     || []).slice();
  var subgraphs = (pipe.graph.subgraphs || []).map(function(sg){
    return Object.assign({}, sg, { nodes: (sg.nodes||[]).slice() });
  });

  // Notes filter
  if (!_dcNotesOn) {
    var noteIds = {};
    nodes.forEach(function(n){ if ((n.type||'').toLowerCase() === 'note') noteIds[n.id] = true; });
    nodes     = nodes.filter(function(n){ return !noteIds[n.id]; });
    edges     = edges.filter(function(e){ return !noteIds[e.from] && !noteIds[e.to]; });
    subgraphs = subgraphs.map(function(sg){
      return Object.assign({}, sg, { nodes: sg.nodes.filter(function(id){ return !noteIds[id]; }) });
    });
  }

  // Detail filter: decisions only
  if (_dcFilter === 'decisions') {
    var keepIds = {};
    nodes.forEach(function(n){
      var t = (n.type||'').toLowerCase();
      if (t === 'decision' || t === 'start' || t === 'end') keepIds[n.id] = true;
    });
    edges.forEach(function(e){ if (keepIds[e.from] || keepIds[e.to]){ keepIds[e.from]=true; keepIds[e.to]=true; } });
    nodes     = nodes.filter(function(n){ return keepIds[n.id]; });
    edges     = edges.filter(function(e){ return keepIds[e.from] && keepIds[e.to]; });
    subgraphs = subgraphs.map(function(sg){
      return Object.assign({}, sg, { nodes: sg.nodes.filter(function(id){ return keepIds[id]; }) });
    });
  }

  // Detail filter: steps only (exclude notes, outcomes, conditions)
  if (_dcFilter === 'steps') {
    var EXCL = {note:true, outcome:true, condition:true};
    var stepKeep = {};
    nodes.forEach(function(n){ if (!EXCL[(n.type||'').toLowerCase()]) stepKeep[n.id]=true; });
    nodes     = nodes.filter(function(n){ return stepKeep[n.id]; });
    edges     = edges.filter(function(e){ return stepKeep[e.from] && stepKeep[e.to]; });
    subgraphs = subgraphs.map(function(sg){
      return Object.assign({}, sg, { nodes: sg.nodes.filter(function(id){ return stepKeep[id]; }) });
    });
  }

  // Edge labels filter
  if (!_dcEdgeLabels) {
    edges = edges.map(function(e){ return Object.assign({}, e, { label: '' }); });
  }

  var graph = { nodes: nodes, edges: edges, subgraphs: subgraphs, _fromSchema: true };

  // If switching to swimlane but subgraphs are empty (e.g. graph was originally
  // built as flowchart), reconstruct them from node.lane assignments.
  if (dtype === 'swimlane' && graph.subgraphs.length === 0) {
    var laneMap = {};
    graph.nodes.forEach(function(n) {
      var lane = n.lane || 'System';
      if (!laneMap[lane]) laneMap[lane] = [];
      laneMap[lane].push(n.id);
    });
    graph.subgraphs = Object.keys(laneMap).map(function(lane) {
      return { id: lane.replace(/[^a-zA-Z0-9_]/g,'_'), label: lane, nodes: laneMap[lane] };
    });
  }

  var mmd = graphToMermaid(graph, dtype);
  if (!mmd) return;

  // Always run sanitiseLabels — critical for swimlane (rewrites unsafe shapes,
  // fixes labels that break Mermaid's parser inside subgraph blocks).
  mmd = sanitiseLabels(mmd);
  mmd = _dcColorsOn ? injectColours(mmd) : mmd.split('\n').filter(function(l){
    var t = l.trim(); return !t.startsWith('classDef ') && !t.startsWith('class ');
  }).join('\n');

  document.getElementById('mermaid-editor').value = mmd;
  renderMermaid(mmd);
}

// Tier 1: actor filter — rebuilds graph via Pass 2 (~1 LLM call)
async function dcApplyActors() {
  if (!pipe.extraction || !pipe.extraction._entities_full) {
    showToast('No extraction data — run a 2-pass conversion first'); return;
  }
  var allActors   = pipe.extraction.actors || [];
  var activeActors = allActors.filter(function(a){ return !_dcActorExcluded[a]; });
  if (activeActors.length < 1) { showToast('Select at least one actor'); return; }

  pipe.actors.forEach(function(a){ a.selected = !_dcActorExcluded[a.name]; });

  var dtype = _dcDtype || document.getElementById('diagram-type').value;
  var btn   = document.getElementById('dc-apply-actors');
  btn.disabled = true; btn.textContent = '⟳ Rebuilding…';
  try {
    var graph = await buildGraph(pipe.extraction, dtype);
    if (!graph) throw new Error('buildGraph returned null');
    pipe.graph = graph;
    var mmd = graph._fromSchema ? injectColours(graphToMermaid(graph, dtype))
              : injectColours(sanitiseLabels(repairMermaid(graph._rawFallback || '')));
    document.getElementById('mermaid-editor').value = mmd;
    await renderMermaid(mmd);
    pushHistory(mmd, dtype);
    showToast('↺ Rebuilt with ' + activeActors.length + ' actor' + (activeActors.length !== 1 ? 's' : ''));
  } catch(e) {
    showToast('Rebuild error: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '↺ Apply';
  }
}


// ══════════════════════════════════════════════════════════════════
// ── GITHUB STORAGE LAYER ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

var GH_REPO   = 'tigges/CONV_V6_GIT_V1';
var GH_BRANCH = 'main';
var GH_BASE   = 'https://api.github.com/repos/' + GH_REPO + '/contents/';

function ghPAT() { return document.getElementById('gh-pat').value.trim(); }

function ghStatus(msg, cls) {
  var el = document.getElementById('gh-status');
  el.textContent = msg;
  el.className = cls || '';
  if (cls === 'gh-ok') setTimeout(function() { if (el.textContent === msg) el.textContent = ''; }, 3000);
}

// Read a file from the repo — returns { content (decoded), sha }
async function ghRead(path) {
  var pat = ghPAT();
  var headers = { 'Accept': 'application/vnd.github.v3+json' };
  if (pat) headers['Authorization'] = 'token ' + pat;
  var res = await fetch(GH_BASE + path + '?ref=' + GH_BRANCH, { headers: headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('GitHub read failed: ' + res.status);
  var data = await res.json();
  return { content: decodeURIComponent(escape(atob(data.content.replace(/\n/g, '')))), sha: data.sha };
}

// Write a file to the repo — creates or updates
async function ghWrite(path, content, message, sha) {
  var pat = ghPAT();
  if (!pat) throw new Error('GitHub PAT required to save');
  var body = {
    message:  message || 'Update ' + path,
    content:  btoa(unescape(encodeURIComponent(content))),
    branch:   GH_BRANCH,
  };
  if (sha) body.sha = sha;
  var res = await fetch(GH_BASE + path, {
    method: 'PUT',
    headers: {
      'Authorization': 'token ' + pat,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    var e = await res.json().catch(function(){return{};});
    throw new Error('GitHub write failed: ' + (e.message || res.status));
  }
  return await res.json();
}

// ── Glossary sync ─────────────────────────────────────────────────
async function syncGlossaryFromGitHub() {
  try {
    ghStatus('Fetching glossary…', 'gh-busy');
    var result = await ghRead('data/glossary.json');
    if (!result) {
      // First run — push local glossary to GitHub
      await pushGlossaryToGitHub();
      return;
    }
    var remote = JSON.parse(result.content);
    // Merge: GitHub is authoritative; add any local-only terms not in remote
    var local  = getGlossary();
    var mergedMap = {};
    remote.forEach(function(t) { mergedMap[t.id] = t; });
    local.forEach(function(t) {
      if (!mergedMap[t.id]) mergedMap[t.id] = t; // add local-only
    });
    var merged = Object.values(mergedMap);
    putGlossary(merged);
    ghStatus('✓ Glossary synced (' + merged.length + ' terms)', 'gh-ok');
    renderGlossary();
  } catch(e) {
    ghStatus('✗ ' + e.message, 'gh-err');
  }
}

async function pushGlossaryToGitHub() {
  try {
    ghStatus('Pushing glossary…', 'gh-busy');
    var terms = getGlossary();
    var existing = await ghRead('data/glossary.json');
    await ghWrite(
      'data/glossary.json',
      JSON.stringify(terms, null, 2),
      'Update glossary (' + terms.length + ' terms)',
      existing ? existing.sha : undefined
    );
    ghStatus('✓ Glossary pushed', 'gh-ok');
  } catch(e) {
    ghStatus('✗ ' + e.message, 'gh-err');
  }
}

// ── Chart sync — see storage layer above for pushChartToGitHub / loadChartsFromGitHub ──

// ── Master sync ───────────────────────────────────────────────────
async function githubSync() {
  if (!ghPAT()) { showToast('Enter a GitHub PAT first'); return; }
  var btn = document.getElementById('gh-sync-btn');
  btn.disabled = true;
  btn.textContent = '⇅ Syncing…';
  try {
    await syncGlossaryFromGitHub();
    await syncProjectsFromGitHub();
    showToast('✓ GitHub sync complete');
  } catch(e) {
    ghStatus('✗ Sync failed: ' + e.message, 'gh-err');
  } finally {
    btn.disabled = false;
    btn.textContent = '⇅ Sync';
  }
}

// Show sync button when PAT is entered
document.getElementById('gh-pat').addEventListener('input', function() {
  var hasPAT = this.value.trim().length > 10;
  document.getElementById('gh-sync-btn').style.display = hasPAT ? '' : 'none';
  sessionStorage.setItem('fc_ghpat', this.value);
});

// ══════════════════════════════════════════════════════════════════
// ── PROJECT DETECTION & MANAGEMENT ────────────────────────────────
// ══════════════════════════════════════════════════════════════════

var GH_PROJECTS_KEY   = 'fc_projects_v1';
var LAST_PROJECT_KEY  = 'fc_last_project_v1'; // persists last-used project slug
var currentProject    = null;

function getProjects() {
  try { return JSON.parse(localStorage.getItem(GH_PROJECTS_KEY) || '[]'); }
  catch(e) { return []; }
}
function putProjects(p) { localStorage.setItem(GH_PROJECTS_KEY, JSON.stringify(p)); }

function saveLastProject(slug) {
  if (slug) localStorage.setItem(LAST_PROJECT_KEY, slug);
  else      localStorage.removeItem(LAST_PROJECT_KEY);
}
function loadLastProject() {
  return localStorage.getItem(LAST_PROJECT_KEY) || null;
}

async function syncProjectsFromGitHub() {
  try {
    var result = await ghRead('data/projects.json');
    if (result) {
      var remote = JSON.parse(result.content);
      // Merge with local
      var local  = getProjects();
      var names  = remote.map(function(p) { return p.slug; });
      local.forEach(function(p) { if (names.indexOf(p.slug) === -1) remote.push(p); });
      putProjects(remote);
    }
    renderProjectSelector();
  } catch(e) { console.warn('Projects sync:', e.message); }
}

async function pushProjectsToGitHub() {
  if (!ghPAT()) return;
  try {
    var projects = getProjects();
    var existing = await ghRead('data/projects.json');
    await ghWrite(
      'data/projects.json',
      JSON.stringify(projects, null, 2),
      'Update projects (' + projects.length + ' projects)',
      existing ? existing.sha : undefined
    );
  } catch(e) { console.warn('Projects push:', e.message); }
}

function renderProjectSelector() {
  var sel      = document.getElementById('gh-project');
  var projects = getProjects();
  sel.innerHTML = '<option value="">— No project —</option>';
  projects.forEach(function(p) {
    var opt = document.createElement('option');
    opt.value = p.slug; opt.textContent = p.name;
    if (currentProject && currentProject.slug === p.slug) opt.selected = true;
    sel.appendChild(opt);
  });
  var newOpt = document.createElement('option');
  newOpt.value = '__new__'; newOpt.textContent = '+ Create new project…';
  sel.appendChild(newOpt);

  // Restore last-used project on first render if none selected yet
  if (!currentProject) {
    var lastSlug = loadLastProject();
    if (lastSlug) {
      var lastProj = projects.find(function(p) { return p.slug === lastSlug; });
      if (lastProj) {
        currentProject = lastProj;
        sel.value = lastSlug;
      }
    }
  }

  updateGlossaryTierCounts();
}

function onProjectChange() {
  var val = document.getElementById('gh-project').value;
  if (val === '__new__') {
    openProjectDialog('', 'Enter a name for the new project:');
    return;
  }
  var projects = getProjects();
  currentProject = projects.find(function(p) { return p.slug === val; }) || null;
  saveLastProject(currentProject ? currentProject.slug : null);
  if (currentProject) showToast('Project: ' + currentProject.name);
  updateGlossaryTierCounts();
  // Re-render glossary if project tier is active
  if (g_currentTier === 'project') renderGlossary();
}

// Auto-detect project name from document content after pipeline
function detectProjectFromDocument(text, preparsed) {
  var candidates = [];

  // Look for explicit brand/product names in headings
  if (preparsed) {
    preparsed.forEach(function(p) {
      if (p.type === 'heading' || p.type === 'process') {
        // Extract capitalised multi-word phrases
        var match = p.text.match(/^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})/);
        if (match && match[1].length > 4) candidates.push(match[1]);
      }
    });
  }

  // Look for document title patterns in first 500 chars
  var top = text.substring(0, 500);
  var titleMatch = top.match(/^([A-Z][^\n]{5,60})\n/);
  if (titleMatch) candidates.unshift(titleMatch[1].trim());

  // Return best candidate (first heading/title)
  var best = candidates[0];
  if (!best) return null;

  // Trim to reasonable length and clean
  return best.replace(/[-:—]+$/, '').trim().substring(0, 50);
}

function suggestProject(detectedName) {
  if (!detectedName) return;
  // Check if already exists
  var projects = getProjects();
  var slug     = detectedName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  var existing = projects.find(function(p) { return p.slug === slug; });
  if (existing) {
    // Auto-select it
    currentProject = existing;
    document.getElementById('gh-project').value = slug;
    return;
  }
  // Suggest creating it
  openProjectDialog(detectedName, 'Document suggests project name — confirm or edit:');
}

function openProjectDialog(name, sub) {
  document.getElementById('project-name-input').value = name || '';
  document.getElementById('project-dialog-sub').textContent = sub || 'Enter a project name:';
  document.getElementById('project-dialog').style.display = 'flex';
  setTimeout(function() {
    var inp = document.getElementById('project-name-input');
    inp.focus(); inp.select();
  }, 60);
}

// Enter key confirms, Escape cancels — wired once on first open
(function() {
  document.addEventListener('DOMContentLoaded', function() {}, false);
  var inp = document.getElementById('project-name-input');
  if (inp) {
    inp.addEventListener('keydown', function(e) {
      if (e.key === 'Enter')  { e.preventDefault(); confirmProject(); }
      if (e.key === 'Escape') { e.preventDefault(); closeProjectDialog(); }
    });
  }
})();

function closeProjectDialog() {
  document.getElementById('project-dialog').style.display = 'none';
  // Reset selector if user cancelled a "Create new" action
  if (document.getElementById('gh-project').value === '__new__') {
    document.getElementById('gh-project').value = currentProject ? currentProject.slug : '';
  }
}

function confirmProject() {
  var name = document.getElementById('project-name-input').value.trim();
  if (!name) { showToast('Enter a project name'); return; }
  var slug = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  var projects = getProjects();
  var existing = projects.find(function(p) { return p.slug === slug; });
  if (!existing) {
    projects.push({ name: name, slug: slug, createdAt: Date.now(), glossary: [] });
    putProjects(projects);
    pushProjectsToGitHub();
  }
  currentProject = { name: name, slug: slug };
  saveLastProject(slug);
  renderProjectSelector();
  document.getElementById('gh-project').value = slug;
  closeProjectDialog();
  updateGlossaryTierCounts();
  showToast('Project set: ' + name);
}

// Hook project detection into the pipeline
var _origRunPipeline = runPipeline;
runPipeline = async function() {
  await _origRunPipeline.apply(this, arguments);
  // After pipeline completes, try to detect project
  if (pipe.clean && pipe.preparsed) {
    var detected = detectProjectFromDocument(pipe.clean, pipe.preparsed);
    if (detected) suggestProject(detected);
  }
};

// GitHub push is now handled inside confirmSaveWithMeta() (storage layer above)

// ══════════════════════════════════════════════════════════════════
// ── SPLIT VIEW ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

var splitActive  = false;
var renderTimerB = null;
var zoomLevelB   = 1;

function toggleSplitView() {
  splitActive = !splitActive;
  var overlay = document.getElementById('split-overlay');
  var grid    = document.querySelector('.main-grid');
  var btn     = document.getElementById('split-toggle');

  if (splitActive) {
    overlay.style.display = 'flex';
    grid.classList.add('split-active');
    btn.classList.add('active');
    btn.textContent = '⊟ Split ON';
    // If there's a current chart, pre-load it into panel B for comparison
    var currentCode = document.getElementById('mermaid-editor').value.trim();
    if (currentCode && !document.getElementById('mermaid-editor-b').value.trim()) {
      document.getElementById('mermaid-editor-b').value = currentCode;
      renderPanelB();
    }
  } else {
    overlay.style.display = 'none';
    grid.classList.remove('split-active');
    btn.classList.remove('active');
    btn.textContent = '⊟ Split';
  }
}

function scheduledRenderB() {
  clearTimeout(renderTimerB);
  renderTimerB = setTimeout(renderPanelB, 700);
}

async function renderPanelB() {
  var code      = document.getElementById('mermaid-editor-b').value.trim();
  var innerB    = document.getElementById('chart-inner-b');
  var phB       = document.getElementById('split-placeholder-b');
  if (!code) { innerB.innerHTML = ''; phB.style.display = 'flex'; return; }
  try {
    var coloured  = injectColours(sanitiseLabels(repairMermaid(code)));
    var result    = await mermaid.render('fcb' + Date.now(), coloured);
    var svgStr    = result && result.svg ? result.svg : (typeof result === 'string' ? result : '');
    innerB.innerHTML = svgStr;
    phB.style.display = 'none';
    applyZoomB();
  } catch(e) {
    innerB.innerHTML = '<div style="padding:16px;color:var(--red-600);font-size:12px;">Syntax error: ' + escHtml(e.message) + '</div>';
    phB.style.display = 'none';
  }
}

function adjustZoomB(d) { zoomLevelB = Math.min(3, Math.max(0.25, zoomLevelB + d)); applyZoomB(); }
function resetZoomB()    { zoomLevelB = 1; applyZoomB(); }
function applyZoomB()    {
  var inner = document.getElementById('chart-inner-b');
  if (inner) inner.style.transform = 'scale(' + zoomLevelB + ')';
  document.getElementById('zoom-level-b').textContent = Math.round(zoomLevelB * 100) + '%';
}

function loadChartIntoB() {
  var charts = getSaved();
  var picker  = document.getElementById('chart-b-picker');
  var list    = document.getElementById('chart-b-picker-list');
  if (!charts.length) { showToast('No saved charts yet — save a chart first'); return; }
  // Toggle picker
  if (picker.style.display !== 'none') { picker.style.display = 'none'; return; }
  list.innerHTML = charts.map(function(c, i) {
    return '<div onclick="pickChartForB(' + i + ')" style="padding:7px 14px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--gray-100);" ' +
      'onmouseover="this.style.background=\'var(--blue-50)\'" onmouseout="this.style.background=\'\'">' +
      '<span style="font-weight:600">' + c.name + '</span>' +
      '<span style="color:var(--gray-400);font-size:10px;margin-left:6px;">' + (c.code ? c.code.split('\n').length + ' lines' : '') + '</span>' +
      '</div>';
  }).join('');
  picker.style.display = 'block';
  // Close on outside click
  setTimeout(function() {
    document.addEventListener('click', function closePicker(e) {
      if (!picker.contains(e.target)) { picker.style.display = 'none'; document.removeEventListener('click', closePicker); }
    });
  }, 10);
}

function pickChartForB(idx) {
  var chart = getSaved()[idx];
  if (!chart) return;
  document.getElementById('mermaid-editor-b').value = chart.code;
  document.getElementById('chart-b-picker').style.display = 'none';
  renderPanelB();
  showToast('Loaded into Panel B: ' + chart.name);
}

// ══════════════════════════════════════════════════════════════════
// ── 📊 LOGIC TAB — generated from live JS constants ───────────────
// ══════════════════════════════════════════════════════════════════

// Master tag definition table — single source of truth.
// When you add/change a detection rule, update this array.
// The tag table in the Logic tab is rendered FROM this array.
var TAG_DEFINITIONS = [
  {
    tag: 'NOTE', cssClass: 'note', priority: 1,
    triggers: 'definitions, "for example", "X is defined as", "this document", "please note"',
    mmdOutput: 'Omit from diagram',
    color: '#f3f4f6',
  },
  {
    tag: 'HEAD', cssClass: 'heading', priority: 2,
    triggers: '# markdown headings, "1. Title" numbered sections, ≥3 Title Case words on own line',
    mmdOutput: 'subgraph "Title"',
    color: '#1e3a5f',
  },
  {
    tag: 'PROC', cssClass: 'process', priority: 3,
    triggers: '"this process", "workflow:", "procedure:", "process consists of"',
    mmdOutput: 'Top-level subgraph',
    color: '#e0f2fe',
  },
  {
    tag: 'SUBP', cssClass: 'subprocess', priority: 4,
    triggers: '"sub-process", "step 2a:", numbered sections "2.1", "sub process"',
    mmdOutput: 'Nested subgraph',
    color: '#f0f9ff',
  },
  {
    tag: 'CLUS', cssClass: 'cluster', priority: 5,
    triggers: '"the following steps apply to", "in this phase", "these steps apply"',
    mmdOutput: 'Grouping subgraph',
    color: '#fff7ed',
  },
  {
    tag: 'POL', cssClass: 'policy', priority: 6,
    triggers: '"per policy", "in accordance with", "compliance requires", "pursuant to"',
    mmdOutput: 'Note annotation',
    color: '#fdf4ff',
  },
  {
    tag: 'DCSN', cssClass: 'decision', priority: 7,
    triggers: '"if ", "whether ", "unless ", "check if", "determine if", ends with "?"',
    mmdOutput: '{Decision?} diamond',
    color: '#fef9c3',
  },
  {
    tag: 'COND', cssClass: 'condition', priority: 8,
    triggers: '"upon ", "once ", "after ", "before ", "as soon as ", "on receipt"',
    mmdOutput: 'Arrow label or decision',
    color: '#ede9fe',
  },
  {
    tag: 'OUT', cssClass: 'outcome', priority: 9,
    triggers: '"therefore", "as a result", "will be approved/rejected", "escalate to"',
    mmdOutput: 'Terminal or final step',
    color: '#d1fae5',
  },
  {
    tag: 'STEP', cssClass: 'step', priority: 10,
    triggers: 'Known action verb (verify/check/review/send/…) OR short sentence ≤12 words (fallback). May carry [actor:X] attribution for swimlane placement.',
    mmdOutput: '[Process node] — placed in actor\'s lane if attributed',
    color: '#dbeafe',
  },
  {
    tag: 'STAT', cssClass: 'status', priority: 11,
    triggers: 'Known state word (Pending/Approved/Rejected/…) OR short Title Case noun phrase ≤5 words with no action verb',
    mmdOutput: 'Omit from diagram (UI/system state label, not a process node)',
    color: '#e0f2fe',
  },
];

// Bar chart colours per tag
var TAG_BAR_COLORS = {
  'note':      '#d1d5db',
  'heading':   '#1e3a5f',
  'process':   '#0369a1',
  'subprocess':'#0284c7',
  'cluster':   '#c2410c',
  'policy':    '#7e22ce',
  'decision':  '#92400e',
  'condition': '#5b21b6',
  'outcome':   '#065f46',
  'step':      '#1e40af',
  'status':    '#0369a1',
};

// ── Version changelog — add a new entry at the TOP for each release ──
var CHANGELOG = [
  {
    version: 'v4.2.0',
    date: '2026-04-19',
    summary: 'Consumer view — consumer.html: 3-step wizard UI (Inject → Run → View) wrapping the existing pipeline via Option B DOM shim',
    changes: [
      'consumer.html: new standalone page. Imports js/storage.js, js/pipeline.js, js/generate.js, js/render.js, js/ui.js unchanged. A hidden #flowinject-shim div provides all ~120 element IDs the pipeline modules reference, so zero changes were needed to any existing JS file.',
      'Step 1 — Inject: drag-drop zone supporting PDF, DOCX, TXT, MD. File card with icon, size, domain chip. Runs detectTOC() + preParse() deterministically on load. Green info box shows "Table of contents detected — N clusters found". Auto-detects project name (detectProjectFromDocument) and domain (keyword scoring). 800ms auto-advance to Step 2.',
      'Step 2 — Run: compact file summary card + project/context card with inline breadcrumb editing. Generate button (full width) + Set button (settings gear). Caption shows estimated time and cost derived from cluster count and model.',
      'Set popover: Free/Pay mode toggle (Preview = deterministic, Full diagrams = LLM). API key input shown only in Pay mode when no key is saved in localStorage. Advanced section (collapsed by default): model selector (Haiku/Sonnet/Opus), style (auto/flowchart/swimlane/sequence), domain, orientation. Settings persist in fc_consumer_prefs. On confirm, writes to shim elements so pipeline reads correct values.',
      'Auto-suggestion chips: amber chips shown near Set button when system auto-detects domain, style, or TOC structure. Clicking chip opens Set popover. Dismissable per-session. Shown in both Step 2 and Step 3 header.',
      'Step 3 — View (Preview mode): deterministic structure map built from TOC entries. Each cluster card shows icon (keyword-matched), name, and a "▶ Generate →" button. Clicking Generate on a single card runs the LLM pipeline for that cluster only (per-cluster pay), replaces button with "Open →" on completion.',
      'Step 3 — View (Full mode): full pipeline via smartAction(). 4-bullet progress list driven by setLoading() interception (keyword→stage mapping). After completion, map cards populated from getSaved(). Map/Diagram toggle. Diagram view with −/+/⤢ zoom. Export (SVG download) + Share (shareProjectMapURL) buttons.',
      'Consumer adapter: wraps setLoading, showToast, switchRightTab, renderAnalysisDashboard, renderProjectSelector as no-ops or consumer-specific implementations. All pro-tool UI chrome suppressed.',
      'Domain auto-detection: 6-domain scoring table (iGaming, Finance, Healthcare, Logistics, SaaS, Legal) on first 3000 chars. Cluster icon palette: 9 keyword→icon mappings + 9-colour fallback palette.',
      'APP_VERSION bumped to v4.2.0.',
    ],
  },
  {
    version: 'v4.1.0',
    date: '2026-04-19',
    summary: 'Share via URL — project map deep-link; recipients auto-navigate to Map tab with GitHub-backed chart data',
    changes: [
      'shareProjectMapURL(): new function in generate.js. Generates a URL of the form <page>#project=<slug>&view=map for the currently selected project. Uses the existing share-banner overlay (reuses _showShareBanner helper). Accessible via the new "⇗ Share Map" button in the Analysis → Map tab toolbar.',
      '_showShareBanner(title, url): extracted helper that updates the share-banner <h4> title and URL field before showing the overlay. Both shareViaURL() (single chart) and shareProjectMapURL() (project map) go through this helper.',
      '_loadSharedProjectView(): parses #project=<slug>&view=map from window.location.hash on startup. Triggered by loadSharedChart() after the existing ?c= query-param path returns early. Defers via setTimeout(600) so the DOM and project selector are fully initialised.',
      '_activateSharedProjectMap(slug): async function. (1) Looks up the project in localStorage; (2) Falls back to fetching data/projects.json from GitHub (public read, no PAT needed for public repos); (3) Merges the project into the local project list + project selector; (4) Restores ChapterRegistry for the project; (5) Calls _mergeChartsFromGitHub() if no local saved charts match the project; (6) Calls switchRightTab("analysis") then _activateAnPill("map").',
      '_ghReadPublic(path): lightweight GitHub file reader that uses GH_REPO/GH_BRANCH from ui.js globals, with optional PAT from ghPAT(). Returns decoded string or null.',
      '_mergeChartsFromGitHub(projSlug): reads data/charts/{slug}/processes directory listing from GitHub, downloads each .json sidecar + .mmd file that is not already in getSaved(), and inserts entries flagged fromGitHub:true into localStorage via putSaved(). Called once on deep-link navigation when local saved list has no matching charts.',
      '"⇗ Share Map" button added to the Process Corpus toolbar in Analysis → Map tab (next to "↗ Export Map"). Calls shareProjectMapURL().',
    ],
  },
  {
    version: 'v3.12.1',
    date: '2026-04-17',
    summary: 'TOC intelligence: dedicated ↑ TOC button, auto-detection in pipeline, dynamic cluster labels, CLUS in pre-parse editor',
    changes: [
      '↑ TOC button: new explicit button (blue highlight) next to ↑ Load. Forces TOC path even when detectTOC() auto-detect threshold is not met. Sets pipe._isTocLoad flag consumed by runPipeline().',
      'handleTocSelect(): routes file through handleFile(false) with pipe._isTocLoad=true so runPipeline() treats the content as a structure index.',
      'detectTOC() in runPipeline(): TOC detection now runs deterministically after Stage 4 (pre-parse), before any LLM call. ChapterRegistry.load() and DocumentRegistry.loadFromToc() fire immediately on load — no longer deferred to Generate Chart. Cluster structure and the Map tab corpus grid are populated as soon as a TOC is loaded.',
      'Dynamic cluster labels: ChapterRegistry._buildClusterMapFromToc() derives cluster names from TOC content. Pass 1: reads level-1 entries with whole-integer labels (e.g. "1 — Platform Foundations") as explicit cluster headings. Pass 2: synthesises from the first chapter title in each numeric group. Falls back to hardcoded iGaming defaults only if no numeric groupings are found.',
      'ChapterRegistry.getClusterMap(): new method exposing the active cluster map for the TOC banner.',
      'TOC detection banner: blue banner in the Raw tab shown when a TOC is detected. Displays chapter count and cluster pills derived from the TOC. "↑ Append to add chapters, → Generate Chart" guidance. Dismissable with ✕. Hidden on Clear.',
      '"cluster" added to PP_TYPES array: pre-parse editor cycle now includes CLUS as a manual type option (was previously impossible to set manually).',
      'pipe._isTocLoad field added to pipe object; cleared after runPipeline() consumes it.',
    ],
  },
  {
    version: 'v3.12.0',
    date: '2026-04-17',
    summary: 'Cluster card grid map — process corpus visualised as coloured cluster cards with cross-ref chips',
    changes: [
      '_renderSavedCorpusMap(containerEl): new function. Reads getSaved() and renders a 3-column CSS grid of cluster cards. Each card: coloured background + numbered circle matching cluster (1x–9x palette), process rows with chapter prefix, cross-ref chips (coloured by target cluster) on each process that has crossRefs, subprocess count badge. Legend bar at bottom matching screenshot reference.',
      'CLUSTER_PALETTE: 9-colour palette (blue/red/green/orange/purple/yellow/teal/pink/olive) for clusters 1x–9x. _clusterPalette(cid) helper resolves by numeric prefix.',
      '_cmapOpenProcess(slug): click handler on corpus map cards — loads the saved diagram into the editor and switches to Graph tab.',
      'Analysis → Map tab: _anMap() now renders the corpus card grid as the primary view (always available from saved data), with the live extraction process list as a secondary section below (only shown after a 2-pass run).',
      'HTML export (map file): renderClusterCards() in the exported viewer now uses the same card grid layout with PALETTE embedded as a JS constant. Cluster cards are clickable to showCluster(cid) and process rows click to showProcess(slug).',
      '_exportInlineStyles(): card grid CSS classes added (cmap-grid, cmap-cluster, cmap-process, cmap-chip, cmap-legend-dot, etc.).',
    ],
  },
  {
    version: 'v3.11.9',
    date: '2026-04-17',
    summary: 'Export dropdown: fix overflow clipping that prevented menu from opening',
    changes: [
      'Root cause: .tab-bar-actions had overflow:hidden, which clipped the position:absolute dropdown menu rendering it unclickable. Fixed by setting overflow:visible + position:relative on .tab-bar-actions.',
      '.panel changed from overflow:hidden to overflow:visible so the dropdown can escape the panel boundary. Left panel retains overflow:hidden via .panel:first-child override. Content clipping is preserved at the .tab-pane level which already has overflow:hidden.',
    ],
  },
  {
    version: 'v3.11.8',
    date: '2026-04-17',
    summary: 'Right panel layout fix — two-row tab bar, Logic in header, simplified Export dropdown',
    changes: [
      'Layout fix: tab-bar restructured into two explicit rows using flex-direction:column. Row 1 (.tab-bar-tabs): tab buttons, overflow-x:auto so they never wrap. Row 2 (.tab-bar-actions): action buttons, always single-line. Left panel retains single-row layout via override. Eliminates the two-row gray header that was squashing the content pane.',
      'Logic tab removed from right panel tab bar — moved to a "📊 Logic" link in the header bar (next to version badge and ?). Still renders the full logic tab pane via switchRightTab("logic").',
      'Right panel reduced to 6 tabs: Code | Graph | Analysis | Saved | History | Glossary.',
      'Export consolidated: all export options moved into a single "↓ Export ▾" dropdown button on the Graph tab. Menu has two sections — "This diagram": Mermaid (.mmd), Standalone HTML, SVG/PNG, Print/PDF — and "Whole project": Project map HTML, Export all HTML. No more scattered ↓MMD / ↗HTML / ⊙Map / ↓SVG/PNG / ··· buttons cluttering the action row.',
      'Graph tab action row now shows exactly 4 items: ◈ Save | ↓ Export ▾ | ⇗ Share | ⊟ Split.',
      'Code tab action row unchanged: ↑ Load | Clear | ▶ Render.',
      '_setCodeTabActions(show) and _setGraphTabActions(show): new helpers extracted from switchRightTab. switchRightTab is now clean and easy to follow.',
      '_toggleExportMenu(): replaces _toggleActionOverflow(). Old function kept as alias for backward compat.',
      'exp-item CSS class for export dropdown items (hover highlight).',
    ],
  },
  {
    version: 'v3.11.7',
    date: '2026-04-16',
    summary: 'Full spec §A+B implementation: 4-level navigation, cluster view, subprocess ↑ Parent, node hover, glossary chips, Export All',
    changes: [
      'Spec §A.2 — 4-level navigation: Master Map → Cluster → Process → Subprocess. showCluster(cid) now renders all processes in the cluster with subprocess children indented beneath their parent. Browser back button and pushState restored for all three levels.',
      'Spec §A.2 — Subprocess view: when a diagram has type="subprocess" and parentSlug, an "↑ Parent: {title}" link is shown above the diagram. Breadcrumb shows: Master Map › Cluster › Parent › Subprocess.',
      'Spec §A.3.1 — Cluster subgraph label format fixed: "{code} — {label}" (e.g. "4x — Withdrawals"). Node labels use "{chapter} {title}" format. Cluster header in card list now clickable → goes to cluster view.',
      'Spec §A.3.1/A.3.2 — Cluster card list: cluster titles are clickable links to cluster view. Subprocess nesting shown indented with "sub-process" badge inside cluster view.',
      'Spec §A.4.2 — Node hover tooltip: when a node has a note annotation, el.title is set to the first 100 chars. Browsers show this as a native tooltip on hover.',
      'Spec §A.4.3 — Node click highlights the active node in the SVG (CSS class node-hl, blue stroke override).',
      'Spec §B.4.4 — Glossary definition chips: at export time, global + project glossary (confirmed terms) are embedded as GLOSSARY const. glossaryTerms in nodeAnnotations render as green def-chip spans with CSS ::after tooltip showing expansion + definition on hover.',
      'Spec §A.7.3 Trigger 2 — "⇩ Export All HTML": new function _exportAllHtml() downloads master map + every individual process diagram as separate .html files sequentially (250ms delay between each to avoid browser blocking). Wired into ··· overflow menu.',
      'Spec §B.3.5 — _extraction.json intermediate cache: writeExtraction() added to _LlmCache. Writes entities/decisions/actors/coverage (not raw prompts) to data/charts/{project}/cache/{slug}_extraction.json after every Pass 1. Called fire-and-forget alongside the pass1 cache write.',
      'CLUSTERS data structure in map export now includes parentSlug + subprocessSlugs per process for navigation.',
    ],
  },
  {
    version: 'v3.11.6',
    date: '2026-04-16',
    summary: 'HTML export fixes: correct Mermaid version, split ↗ HTML / ⊙ Map buttons, no alert',
    changes: [
      'Mermaid CDN in both export functions fixed: was cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js (Mermaid 11) — now cdnjs.cloudflare.com/ajax/libs/mermaid/10.6.1/mermaid.min.js. Mermaid 11 changed classDef/class handling causing all node labels to render as "X". Now matches the app version exactly.',
      '↗ HTML action bar button split into two adjacent buttons: "↗ HTML" (exports current diagram only) and "⊙ Map" (exports full project map with all saved diagrams). Both visible on Graph tab after render. Eliminates the confusion of expecting a map from the single-diagram export.',
      'Single-process export: removed breadcrumb alert dialog ("This is a standalone export"). Breadcrumb now shows static text (Map › Cluster › Title) instead of clickable links that fired alert().',
      'Single-process export: breadcrumb now shows cluster label when available.',
    ],
  },
  {
    version: 'v3.11.5',
    date: '2026-04-16',
    summary: 'Null-node crash fix in graphToMermaid + layout fits 1366px laptop',
    changes: [
      'graphToMermaid(): defensive filter at entry — strips null/undefined entries from nodes[], edges[], subgraphs[] before any iteration. Prevents "Cannot read properties of undefined (reading \'id\')" crash when the LLM returns a nodes array containing null elements (common in swimlane mode).',
      'buildGraph(): same defensive filter applied before all five deterministic rules, so nulls are removed at source before reaching graphToMermaid.',
      'Header: height 50px→44px, gap 12px→8px, padding 20px→12px. Logo shrunk 30→26px. Brand tagline hidden ≤1400px, "Mermaid + Claude AI" badge hidden ≤1280px via @media.',
      'Config bar selects: inline font-size:13px removed from model-select, diagram-type, domain-preset HTML. New CSS rule covers all #apibar selects at 11px/3px padding uniformly.',
      'Action bar: ⎙ Print, ⇗ Share, ⊟ Split, ⊙ Export Map HTML collapsed into a ··· overflow button with a dropdown menu. Reduces visible action bar from 9 to 6 buttons on the Graph tab. Hidden buttons kept as zero-size elements for backward-compat JS show/hide calls.',
      '_toggleActionOverflow(): opens/closes the ··· dropdown, closes on outside click.',
    ],
  },
  {
    version: 'v3.11.4',
    date: '2026-04-16',
    summary: 'Layout fixes — all buttons visible on laptop + ↗ HTML export button in action bar',
    changes: [
      'Export HTML discoverability: ↗ HTML button added to the right-panel action bar (Graph tab, same row as ◈ Save / ↓ MMD / ↓ SVG/PNG). Visible immediately after any diagram renders. Calls _exportCurrentHtml() which uses the current editor content + pipe state, falling back to a saved entry match for annotations.',
      '_exportCurrentHtml(): new wrapper — exports the current diagram without requiring a prior ◈ Save. Falls back gracefully if no saved entry matches.',
      'Export HTML is now accessible from three places: (1) Graph tab action bar ↗ HTML, (2) Saved tab — ↗ HTML button on each card, (3) Analysis → Map pill — ↗ Export Map HTML button.',
      'Config bar (#apibar): flex-wrap: wrap added (was nowrap/overflow:hidden), padding reduced 5px→4px, gap 8px→6px. Items now wrap to a second row on narrow screens instead of being clipped.',
      'Tab bars: padding reduced 8px/13px→7px/10px, gap 5px→4px. flex-wrap: wrap added so tabs wrap instead of overflow.',
      'Tab-bar actions: gap 5px→4px, padding 0 10px→4px 8px, flex-wrap: wrap added.',
      'Right panel tab labels: emoji prefixes removed (⌨ Code → Code, ◻ Graph → Graph, etc.) to save ~20px per tab.',
      '⊟ Split button label shortened from "⊟ Split" to "⊟" (icon only, title tooltip retained).',
      '↓ Export button relabelled to ↓ SVG/PNG to clarify it is not the HTML export.',
    ],
  },
  {
    version: 'v3.11.3',
    date: '2026-04-16',
    summary: 'TOC context isolation — chapter-only Pass 1 input + pre-Pass-1 context size warning',
    changes: [
      'Root cause fixed: when ↑ Append is used after ↑ Load TOC, the old code concatenated TOC + chapter into inputEl then passed the full combined string to Pass 1. The 12,000-char window was dominated by TOC entries (39 headings in the test case), leaving no room for chapter content. Haiku returned invalid JSON causing "Pass 1 extraction failed" on nearly every chapter.',
      'Context isolation: pipe._chapterText — set by handleFile() on every ↑ Append to hold the chapter text alone. convert() now uses pipe._chapterText when present, falling back to pipe.clean for single-file loads. The TOC is preserved on pipe._tocText for ChapterRegistry/detectTOC use only. inputEl still displays the full combined text for user visibility — only Pass 1 input is isolated.',
      'pipe._inputSources: [{filename, role:"toc"|"chapter"|"load", chars}] — tracks every contributing document for the context warning breakdown.',
      'clearAll() and handleFile(append=false) both reset _tocText, _chapterText, _inputSources.',
      'PASS1_CONTEXT_TOKEN_THRESHOLD = 4000 (configurable constant). Pre-Pass-1 check in runExtraction(): estimates tokens (chars / 4), logs source label ("chapter-only (TOC isolated)" vs "COMBINED (TOC + chapter)") and source breakdown. If over threshold: console.warn with per-file token breakdown, surfaces amber warning in pipeline-status bar for 8 seconds.',
      'Raw tab meta now shows "N chars (chapter only · ~T tokens) · TOC isolated" when isolation is active, with a tooltip explaining the behaviour.',
    ],
  },
  {
    version: 'v3.11.2',
    date: '2026-04-16',
    summary: 'parentSlug + subprocessSlugs correctness — save flow fix, validation, subprocess picker',
    changes: [
      'Type determination fix: confirmSaveWithMeta() now uses pipe.graph.nodes (no start/end terminals + majority subprocess nodes → type=subprocess) as the primary signal, falling back to the legacy pipe.entities.steps heuristic. More reliable after a 2-pass run.',
      'parentSlug resolution: for subprocess saves, reads the save dialog parent picker first, then auto-infers from the most recently saved process in the same chapter. If no parent can be found, gracefully downgrades type to "process" instead of throwing or writing meta=null. Eliminates the silent metadata loss from the previous makeProcessMetadata throw-on-null-parentSlug path.',
      'subprocessSlugs back-link: _linkSubprocessToParent(subprocSlug, parentSlugVal) — adds the subprocess slug to the parent entry\'s subprocessSlugs[] in localStorage and re-pushes the parent sidecar to GitHub (fire-and-forget). Called immediately after local save, before GitHub push.',
      '_populateSaveDialogSubprocessPicker(): runs on every save dialog open. Shows a "Sub-process detected" amber row with a parent-process select (scoped to the same chapter) and an override checkbox. Hidden automatically when type=process is detected. Wired into openSaveDialog().',
      '_onSaveTypeOverride(checkbox): disables/enables the parent picker based on the override checkbox.',
      '_validateSavedSidecar(slug, meta): fire-and-forget post-save validator. Checks four invariants: [V1] type=subprocess → parentSlug non-null, [V2] parentSlug exists in saved list, [V3] subprocessSlugs is an array, [V4] meta is not null. Logs to console with slug detail (type/parentSlug/subprocessSlugs). Appends to DocumentRegistry errorLog and sets status=error for [V1]/[V4] violations. Surfaces [V1] violations to the user via showToast().',
    ],
  },
  {
    version: 'v3.11.1',
    date: '2026-04-16',
    summary: 'Glossary auto-population — post-Pass-1 hook, fire-and-forget (spec §B.4.3)',
    changes: [
      '_autoPopulateGlossary(entities, processSlug, projectSlug): called as a fire-and-forget Promise.resolve().then() after the Pass 1 cache write in convertSingle(). Never blocks rendering.',
      'Extraction: iterates extraction._entities_full.steps[].label, actors[], exceptions[]. Extracts acronyms (2–6 all-caps chars e.g. KYC, ARN) and multi-word title-case phrases. Filters stop words and trivial tokens.',
      'Logic: if term exists in global glossary → skip. If in project glossary → append processSlug to seenInSlugs (dedup). If new → add with confirmed:false, source:"learned", firstSeenIn, seenInSlugs. Writes via putProjectGlossary() — localStorage only, no GitHub round-trip.',
      'Glossary UI: pending terms (confirmed:false) sorted to top of project list with amber background + "pending" badge. "seenInSlugs" shown in row (up to 3 slugs). "✓" confirm button sets confirmed:true and re-renders list. Divider separates pending from confirmed.',
      'confirmGlossaryTerm(id): new function — sets confirmed:true + updatedAt, writes to localStorage, re-renders, shows toast.',
      'renderGlossaryList() alias: allows _autoPopulateGlossary to refresh the visible glossary panel after a background write without coupling to the internal renderGlossary() name.',
    ],
  },
  {
    version: 'v3.11.0',
    date: '2026-04-16',
    summary: 'Interactive HTML viewer, corpus storage — Part A+B of viewer & corpus spec',
    changes: [
      'Part A — Interactive HTML viewer: _exportProcessHtml() generates self-contained single-process .html with Mermaid CDN, annotation panel (click-to-reveal per node), cross-ref links, clean/annotated toggle, browser-history pushState navigation.',
      'Part A — Project master map export: _exportProjectMapHtml() generates {project-slug}_map.html — Mermaid cluster diagram of all clusters + card fallback, 4-level navigation (Master Map → Cluster → Process → Subprocess), 60-node cap with cluster-only fallback.',
      'Part A — Export buttons: "↗ HTML" button on every named saved chart card; "↗ Export Map HTML" button in Analysis Map tab toolbar. CLI: data/export.py --project {slug} [--slug {slug}].',
      'Part A — nodeAnnotations: _buildNodeAnnotations() derives note/warning/waitCondition/ref/glossaryTerms from pipe.graph + pipe.extraction.entities. Built automatically in buildMetadataFromPipe() and stored in .json sidecar as meta.nodeAnnotations.',
      'Part A — Inline styles helper _exportInlineStyles(): single source of truth for exported HTML CSS — used by both in-app JS exporter and CLI data/export.py.',
      'Part B — DocumentRegistry singleton: tracks every source document status (pending→pass1_complete→pass2_complete→complete→error). Wired to TOC load (loadFromToc()), handleFile() (update with fileHash+size), confirmSaveWithMeta() (markDiagramSaved). Backed by localStorage + GitHub push (data/charts/{project}/registry/document_registry.json).',
      'Part B — SHA-256 file hash: computeFileHash() via Web Crypto API (SubtleCrypto.digest). Called in handleFile() before text extraction; stored in DocumentRegistry for cache invalidation.',
      'Part B — LLM cache: _LlmCache singleton writes pass1/pass2 cache JSON to GitHub (data/charts/{project}/cache/{slug}_passN.json) after each convertSingle() run. Cache schema: slug/pass/model/cachedAt/promptVersion/tokens/response/parseSuccess. PASS1_PROMPT_VERSION + PASS2_PROMPT_VERSION constants for invalidation.',
      'Part B — Cache invalidation: prompt version mismatch or file hash mismatch → cache skipped. Cache hit logged to console.',
      'Part B — Python scripts: data/batch_process.py (resumable batch runner with registry, cache-aware skipping, exponential backoff retry), data/promote_glossary.py (promotes 3+ document project terms to global glossary candidates), data/export.py (CLI HTML export equivalent to in-app buttons).',
    ],
  },
  {
    version: 'v3.10.0',
    date: '2026-04-16',
    summary: 'Storage & naming layer, two-tier autosave, API retry, smart title autofill, multi-file append',
    changes: [
      'Storage & naming layer (spec v3.9+): slugify(), chapterSlug(), processSlug(), dedupeSlug() — deterministic slug derivation from TOC data. 11 console.assert unit tests at load time.',
      'ChapterRegistry singleton: parses detectTOC() output into chapter/cluster map (1x–9x). Wired to runExtraction() and handleFile(). inferFromFilename() infers chapter from filename.',
      'ProcessMetadata JS factory + Pydantic v2 Python model (data/process_metadata.py): all required fields validated, passQualityScore 0.0–1.0, subprocess requires parentSlug.',
      'Enhanced save flow: confirmSaveWithMeta() builds {chapter-slug}-{process-slug}, collision guard, full metadata sidecar, GitHub push to data/charts/{project}/processes/{slug}.mmd + .json.',
      'Grouped Saved list (5 modes): Cluster (default), Chapter, Type, Tag, Recent. crossRefs rendered as clickable links. Type/cluster/chapter badges on each card.',
      'Two-tier autosave: Tier 1 = sessionStorage (survives refresh). Tier 2 = localStorage draft written immediately after every generation (survives browser close). Drafts shown in amber section in Saved tab with ◈ Save / ▶ Load / ✕ actions. _promoteDraftIfExists() removes draft on named save. _pruneDrafts() removes drafts > 24h on page load.',
      'Smart chart name autofill (_chartNameSource flag): system values (filename, processName) can be upgraded by better data; user-typed values are never overridden. Load always resets field; Append overrides previous system suggestion.',
      'Append file button (↑ Append): concatenates second/third files with separator; enables TOC + chapter workflow. Pipeline re-runs on combined text.',
      'Pass 1/2 context limits: document text 5k → 12k chars, structure hints 2k → 6k chars, Pass 1 output 4096 → 6000 tokens, L cap 35 → 50 nodes.',
      'callAPI() auto-retry: exponential backoff (6s/12s/24s) on HTTP 529 overloaded, 503, 429. Spinner shows "API busy — retrying in Ns… (N/3)".',
      'Process Landscape Map: Analysis tab Map pill with Render Map button. _buildProcessList() from toc + entities. _renderLandscapeDiagram() Mermaid cluster diagram. anMapGenerateProcess() generates focused diagram per process (1 Pass 2 call).',
    ],
  },
  {
    version: 'v3.9.0',
    date: '2026-04-15',
    summary: 'Diagram controls bar — post-render interactive controls without re-extraction',
    changes: [
      'Diagram controls bar: appears below the rendered diagram after any successful graph render. Contains two tiers of controls clearly distinguished by cost.',
      'Tier 0 (instant, no API call): Layout toggle TD↔LR (re-runs graphToMermaid + injectColours on pipe.graph), Colours On/Off (strips classDef lines for plain rendering), Notes Show/Hide (filters note nodes from pipe.graph clone before re-render).',
      'Tier 1 (~1 Pass 2 LLM call, ~3-8s, marked with ⚡): Actor pills — click to include/exclude actors from the diagram, then Apply to rebuild via buildGraph(). Diagram type toggle Flowchart↔Swimlane — switches dtype and rebuilds graph via Pass 2.',
      'All Tier 1 operations use existing pipe.extraction._entities_full — no re-extraction, no Pass 1 call. Actor exclusion updates pipe.actors.selected state so subsequent manual runs are consistent.',
      '_dcRerender(): internal helper for Tier 0. Clones pipe.graph, applies filters, calls graphToMermaid() + injectColours(), renders without touching pipe.graph itself.',
      '_updateDiagramControlsBar(): called after every successful renderMermaid() and after _showExtractionStatus(). Actor and dtype groups only shown when pipe.extraction has ≥2 actors.',
    ],
  },
  {
    version: 'v3.8.0',
    date: '2026-04-15',
    summary: 'TOC pre-pass — deterministic document structure detection before LLM extraction',
    changes: [
      'detectTOC(rawText): new deterministic function (no LLM). Runs at the very start of runExtraction(), before buildStructuredContext() and before any API call. Detects: numbered headings (/^\\d+\\.\\d*\\s+[A-Z]/), chapter headings (/^Chapter\\s+\\d+/i), ALL CAPS section headings, TOC-style page-number lines, and **bold** wrapped lines from DOCX extraction.',
      'TocResult shape: { detected, entries[{level, label, title, lineIndex}], cluster_hint, doc_type_hint }. doc_type_hint: "multi-process" (>5 entries with mixed levels), "procedural" (procedural verbs in titles), "reference" (entries but no verbs), null (not detected). cluster_hint: keyword match against Payments/Bonuses/Verification/Sports/Accounts/Responsible/Technical.',
      'pipe.extraction.toc: new key on ExtractionResult. Always present after a run. Shape: { detected, entry_count, entries, cluster_hint, doc_type_hint }. Empty run: { detected:false, entry_count:0, entries:[], cluster_hint:null, doc_type_hint:null }.',
      'buildStructuredContext(preparsed, toc): second parameter added (optional, backward-compatible). When toc.detected, matching pre-parse items are prefixed with [SECTION_BOUNDARY] to annotate section starts in the Pass 1 prompt. Existing [DECISION_SIGNAL] prefix logic unchanged.',
      'pipe._currentToc: set by runExtraction() so all buildStructuredContext() call sites within a run (including inside extractEntitiesPass1) automatically receive the current toc.',
      'Analysis tab Overview: new TOC block below coverage gauge showing "Structure detected"/"No structure" badge, section count, doc_type_hint pill (colour-coded), and cluster_hint text.',
      'Preparation step for multi-document import (v3.10.0). No existing behaviour changed for documents with no detectable TOC.',
    ],
  },
  {
    version: 'v3.7.0',
    date: '2026-04-15',
    summary: 'Analysis tab + top bar optimisation — full transparency dashboard wired to pipe.extraction',
    changes: [
      'Top bar optimisation: API Key, GitHub PAT, and Chunked mode moved out of the config bar into a new ⚙ settings popover (320px, fixed top-right, closes on outside click). Row 2 now contains only: Model · thinking pill · Output · Layout · Domain · Project · Sync · status. Fits 1280px laptop screen without overflow.',
      'Settings popover (⚙): password inputs for API key and GitHub PAT with Save buttons (show "Saved ✓" for 2 seconds). Chunked mode checkbox. All three separated by 0.5px dividers. Saves to localStorage (fc_apikey) and sessionStorage (fc_ghpat) — same keys as before.',
      'Analysis tab: inserted between Graph and Saved in the output tab bar. Disabled (opacity 0.4, pointer-events none) before a run. Enabled and receives a coverage dot (green #0F6E56 if passed, amber #854F0B if failed) after each successful run.',
      'Analysis dashboard: full-width five-tab dashboard (Overview · Entities · Actors · Graveyard · Tokens). Reads exclusively from pipe.extraction. Shows placeholder if no run yet.',
      'Overview: document metadata grid, decision coverage gauge with pass/fail badge, 4 metric cards (Entities/Decisions/Actors/Retry), actor bar chart.',
      'Entities: filter pills (All/Steps/Decisions/Subprocesses/Outcomes), entity list with type badge, actor pill, confidence bar. Click row to expand provenance sentence; click again to collapse. One open at a time.',
      'Actors: one card per actor with colour dot, node count, breakdown (Steps/Decisions/Subprocesses), proportional bar.',
      'Graveyard: lists all dropped items with label, reason badge (junk_filter/below_coverage_threshold/duplicate), provenance sentence. Empty-state checkmark if nothing dropped.',
      'Tokens: three cards (pre-pass / Pass 1 / Pass 2) with input/output token counts and per-stage estimated cost ($0.0000 format). Total row sums all stages.',
      'Status bar: "Extraction: X% decision coverage · N dropped · ActorA · ActorB · View analysis ↗" — View analysis link switches to Analysis tab.',
      '_updateAnalysisTabState(): called after each run to enable the Analysis tab and update coverage dot.',
    ],
  },
  {
    version: 'v3.6.0',
    date: '2026-04-15',
    summary: 'Separate extraction from graph construction — clean staged pipeline with ExtractionResult handoff',
    changes: [
      'ExtractionResult schema (pipe.extraction): new typed handoff object produced by runExtraction() and consumed by buildGraph(). Fields: doc_id, source_title, extracted_at, model_used, entities (with provenance + actor + confidence per step), decisions (with provenance + covered flag), graveyard (uncovered decisions + junk-filtered items with reasons), coverage {ratio, threshold, passed, retry_triggered}, actors, keywords, stats {pre_pass, pass_1, pass_2 token counts}, _raw_pass1, _raw_pass2.',
      'runExtraction(apiKey, model, dtype, text, docId?, sourceTitle?): new async function. Owns all LLM extraction work — pre-pass, Pass 1 with retry loop, coverage check, actor assignment via ACTOR_PREFIX_MAP, provenance population, graveyard assembly. Returns a fully populated ExtractionResult. Makes zero Mermaid or graph calls.',
      'buildGraph(extractionResult, dtype): new async function. Accepts only an ExtractionResult — no raw text, no API key parameter (resolved from DOM). Calls Pass 2 LLM, then applies deterministic graph rules: node type normalisation, subprocess classDef mapping (subprocess → stepCl, not stop), single-exit Start rule enforcement, edge label completeness check (flagged in pipe.stats, no throw), actor lane validation (unknown lane → "System" fallback with warning).',
      'convertSingle() rewritten as clean orchestration sequence: runExtraction() → buildGraph() → graphToMermaid(). External interface unchanged (same 4 params, returns Mermaid string). No call sites updated.',
      'Transparency layer: console.log(pipe.extraction) added to debug snippet. _showExtractionStatus() logs extraction coverage ratio, dropped count, and actors after each successful two-pass run.',
      'Verification checks: six console.assert() statements added to debug block confirming runExtraction/buildGraph exist, are wired in convertSingle, graphToMermaid boundary is held in runExtraction.',
      'Outstanding issues from v3.4.7: subprocess classDef fix and single-exit Start rule are now implemented as deterministic rules in buildGraph() step 3.',
    ],
  },
  {
    version: 'v3.5.0',
    date: '2026-04-14',
    summary: 'Decision pre-pass + coverage check + Pass 1 retry — ensures all branch points are captured',
    changes: [
      'buildStructuredContext(): lines containing decision-signal words (if, approved, declined, threshold, eligible, escalate to, etc.) are now prefixed with [DECISION_SIGNAL] in the structured context sent to Pass 1.',
      'extractCandidateDecisions(apiKey, model, text): new async function. Lightweight pre-pass (max 1200 tokens) that extracts candidate decision points from the raw document before Pass 1. Returns {document_title, candidate_decisions[]} with condition, signals, outcomes, source_hint per decision.',
      'checkDecisionCoverage(candidateDecisions, pass1Entities, threshold=0.70): new pure function. Token-overlap match between candidate conditions/source hints and Pass 1 decision labels. Returns {totalCandidates, covered, missing[], coverageRatio, passesThreshold}. Stored in pipe.stats.decisionCoverage.',
      'buildRepromptAddition(missingDecisions): new pure function. Builds the CRITICAL — MISSING DECISION NODES addendum injected into a Pass 1 retry prompt.',
      'convertSingle(): pre-pass runs before Pass 1. Pass 1 now has a max-2-attempt retry loop. If coverage < 0.70 after attempt 1, reprompt addition is appended and Pass 1 reruns. Final coverage logged to console.',
      'updateTokenStatus(): now shows Pre-pass token counts alongside main totals. Stored in pipe.stats.prePassTokens.',
    ],
  },
  {
    version: 'v3.4.4',
    date: '2026-04-14',
    summary: 'Pass 1 prompt: pre-parsed structure hints + full document — better inter-process connections',
    changes: [
      'extractEntitiesPass1(): replaced single DOCUMENT block with two sections. PRE-PARSED STRUCTURE HINTS (up to 2000 chars of buildStructuredContext output) gives Claude the tagged skeleton; FULL DOCUMENT (up to 5000 chars) preserves narrative flow and inter-process connections. Net token increase ~500 tokens. Subprocess relationships and cross-section dependencies are now visible to Pass 1.',
    ],
  },
  {
    version: 'v3.4.3',
    date: '2026-04-14',
    summary: 'Pass 1 prompt: sourceText field + strict label quality rules',
    changes: [
      'Pass 1 schema: added "sourceText" field — Claude records the original sentence each step came from. Visible in the Pass 1 step editor as an italic subtitle under each label.',
      'Pass 1 label rules: replaced "2-4 words max, Verb+Noun" with explicit LABEL RULES block: short Title Case noun phrase (3-5 words), must stand alone as a step name, Good/Bad examples included, sentence fragments explicitly prohibited.',
      'Also fixed: missing "var DECISION_MARKERS = [" declaration (v3.4.1 regression) — caused SyntaxError at parse time, preventing all onclick handlers from registering.',
    ],
  },
  {
    version: 'v3.4.2',
    date: '2026-04-14',
    summary: 'Extended thinking on Pass 2 (graph generation) — mirrors Pass 1 pattern',
    changes: [
      'Pass 2 callAPI calls (convertSingle + pass1RunPass2) now pass {maxTokens:12000, thinking:true, thinkingBudget:8000} when INTEL_FLAGS.extendedThinking is on and Sonnet is selected. Same guard as Pass 1: model.includes("sonnet").',
      'convertSingle() Pass 2 spinner: shows "🧠 Pass 2 — reasoning about graph structure… (~5-15s)" when thinking active, "Pass 2 — Building diagram…" otherwise.',
      'updateThinkingIndicator(label): accepts optional label string — indicator text becomes "🧠 <label>" or "🧠 thinking" when no label provided. Allows call sites to contextualise which pass is thinking.',
      'toggleIntelFlag toast updated: now says "active on Pass 1 + Pass 2 with Sonnet".',
    ],
  },
  {
    version: 'v3.4.1',
    date: '2026-04-14',
    summary: 'Tighter STEP classifier: two-gate check replaces generic short-sentence fallback',
    changes: [
      'classifyLine(): short-sentence STEP fallback now requires Gate 1 (startsWithActionVerb) OR Gate 2 (glossary term present). Previously any ≤12-word lowercase sentence became STEP, inflating Pass 1 input with fragments and metadata.',
      'STEP_VERBS extended with iGaming CS domain verbs: unblock, clear, reset, enable, disable, mark, tag, set, track, ask, follow, compare, calculate, refund, withdraw, deposit, attempt, retry, fail, pass, match, reply.',
      'startsWithActionVerb() helper: checks position-0 word after stripping bullet/number prefix.',
      'matchesGlossaryTerm() helper: checks if any active glossary term (≥3 chars) appears in the line. _stepGlossaryTerms populated from getAllTermsForContext() at the start of each preParse() call.',
      'pipe.stats gains three counters: stepVerbMatches, stepGlossaryMatches, noteReclassified — visible at window.__fc_debug.pipe.stats after pipeline run.',
      'runAnalysis() now uses Object.assign to preserve pre-parse counters rather than overwriting pipe.stats.',
    ],
  },
  {
    version: 'v3.4.0',
    date: '2026-04-14',
    summary: 'Pass 2 JSON graph schema + deterministic Mermaid compiler — eliminates Mermaid syntax errors',
    changes: [
      'JSON graph schema output: buildPass2Prompt() now asks Claude to return a raw JSON object {nodes, edges, subgraphs} instead of Mermaid syntax. Node types: start | end | step | decision | subprocess | note.',
      'graphToMermaid() deterministic compiler: converts the JSON graph to valid Mermaid 10.6.1. All node shapes, subgraph blocks, edge arrows and classDef statements are emitted by JS — not by Claude. The [["label"]] subroutine shape is always used for start/end nodes (Mermaid 10.6 bug fix baked in). No repairMermaid() needed on schema output.',
      'pass2ResultToMermaid() adapter: parses JSON from result.clean, runs graphToMermaid(). Falls back to raw Mermaid + repairMermaid() if JSON.parse fails (backwards compat). pipe.graph stores the parsed graph object for debug.',
      'convertSingle() and pass1RunPass2() both use the schema path. repairMermaid() is now only called on: Quick Chart, chunked generation, single-pass, refine, and split-panel — all non-schema paths.',
      'Swimlane support: buildPass2Prompt() includes actor names as subgraph ids and instructs Claude to assign each node to the correct lane via subgraphs[].nodes.',
      'Sequence diagrams: sequence dtype bypasses the JSON schema (sequenceDiagram syntax is not representable in the graph schema) and falls back to single-pass Mermaid generation.',
    ],
  },
  {
    version: 'v3.3.0',
    date: '2026-04-13',
    summary: 'Extended thinking on Pass 1 for Sonnet — better entity extraction on complex SOPs',
    changes: [
      'INTEL_FLAGS.extendedThinking (intel-e): when Sonnet is selected and this flag is on, Pass 1 entity extraction uses Claude extended thinking (8K token budget). Claude reasons privately before outputting JSON — improves step classification, sub-process nesting, and decision identification on complex multi-section SOPs. Haiku calls are unaffected (guard: model.includes("sonnet")).',
      'callAPI() rewritten: accepts 4th argument as options object {maxTokens, thinking, thinkingBudget} while preserving legacy numeric attempt for auto-retry path. When thinking is active: sets anthropic-beta header to interleaved-thinking-2025-05-14 (required for claude-sonnet-4-6), temperature: 1 (API-enforced), max_tokens > budget_tokens (spec constraint). data.content filtered to type === "text" blocks — thinking and redacted_thinking blocks skipped.',
      '🧠 thinking indicator pill: shown next to model selector in config bar whenever Sonnet is selected and extendedThinking flag is on. Updates on model change and flag toggle.',
      'Pass 1 spinner message: shows "🧠 Pass 1 — extended reasoning… (~5-15s)" when thinking is active, normal message otherwise.',
      'Cost note: thinking tokens are counted within output_tokens — no separate field. Output token count will be ~5-10× higher for Pass 1 when thinking is active; cost display reflects this accurately.',
    ],
  },
  {
    version: 'v3.2.1',
    date: '2026-04-13',
    summary: 'Fix: SUBROUTINEEND parse crash; similar-node false positives; validation bar flood cap',
    changes: [
      'sanitiseLabels(): old double-quote stripping regex /(\\[[^\\]]*)"([^\\]]*\\])/ was removing the closing " from every quoted node label (N4["label"] → N4["label]), causing Mermaid to misparse [["Start"]] subroutine shapes as SUBROUTINEEND tokens → parse crash on line 1/6. Fixed: new bracket scanner only replaces interior quotes when a bracket expression contains > 2 quote characters.',
      'sanitiseLabels(): added < > stripping for decision labels {label} — previously only applied to bracket nodes [label].',
      'isSimilarLabel(): replaced substring-containment check with token Jaccard similarity (threshold 0.65, stop-words include actor names). Eliminates false-positive "consider merging" warnings for nodes that merely share common words like Player, Agent, Request.',
      'renderValidationBar(): errors shown first, then warnings. Display capped at 6 items with "N more issues hidden" overflow line. Prevents the 20-warning flood obscuring real errors.',
    ],
  },
  {
    version: 'v3.2.0',
    date: '2026-04-13',
    summary: 'Two-pass quality: step editor, detail level, smart sampling; preParseDedup; DOCX heading depth; NOTE context fix',
    changes: [
      'Pass 1 step editor: after 2-Pass extraction, the Analysis pane shows the full step list with type badges, checkboxes (All/None), and a ▶ Run Pass 2 button. User can prune/deselect steps before Pass 2 fires. Only selected steps are included in buildPass2Prompt(). Directly addresses the 25-node cap problem for complex documents.',
      'Detail level selector (S/M/L): shown in the action bar when 2-Pass is on. Summary (S) asks Pass 1 for ~10 high-level steps and caps Pass 2 at 12 nodes. Standard (M) is the default (20/25). Detailed (L) allows up to 35 steps and 35 nodes. Instruction injected into Pass 1 prompt.',
      'Smart Pass 2 node sampling: when step count exceeds the cap, decisions are always kept (up to 40% of slots), remaining slots filled by even sampling across the full step list. Replaces the previous slice(0, 25) which always truncated the end of the document.',
      'INTEL_FLAGS.preParseDedup (intel-d): Jaccard similarity dedup on preParse() output. Items with ≥ 85% token overlap are collapsed into the first occurrence. Active in pipeline diff panel. Reduces step-list bloat in long documents with repeated steps.',
      'DOCX heading depth mapping: convertDocxHtmlToText() now maps H1→heading (# prefix), H2→subprocess (## prefix), H3→cluster (### prefix), H4+→plain text. classifyLine() updated to route ## → subprocess and ### → cluster before the generic heading check.',
    ],
  },
  {
    version: 'v3.1.1',
    date: '2026-04-13',
    summary: 'Fix: version display always current; NOTE items excluded from AI context; Quick Chart repair chain',
    changes: [
      'Version display: APP_VERSION is now the single source of truth. Removed all hardcoded version strings from HTML — title tag, header badge, and Logic badge are empty in source and filled at runtime by syncVersion(). Print export sheet now uses APP_VERSION too. Added explicit "never hardcode elsewhere" comment.',
      'buildStructuredContext(): NOTE items now excluded from Claude context (previously only STATUS was filtered). This closes the v3.1.0 side-effect where fact-reclassified lines were still being sent to Claude as procedure steps.',
      'Quick Chart (⚡): generateRuleBased() now runs sanitiseLabels(repairMermaid()) on rule-based output before injectColours(), and calls validateGeneratedDiagram() after render. Previously bypassed the full repair chain entirely.',
    ],
  },
  {
    version: 'v3.1.0',
    date: '2026-04-13',
    summary: 'Intelligence layers: junk filter + graveyard, semantic fact scoring, smart label splitting — fully traceable and independently toggleable',
    changes: [
      'INTEL_FLAGS framework: three independently toggleable intelligence layers (junkFilter, factScoring, smartLabel). Each flag persisted to localStorage (fc_intel_flags_v1). Toggling any flag instantly re-runs pre-parse without a page reload. Visible in Logic tab → Intelligence layers section.',
      'intel-a — Junk filter (INTEL_FLAGS.junkFilter): 26-rule JUNK_RULES array with three confidence tiers. Hard (≥90%): silent drop. Medium (65–89%): routed to Graveyard frame for review. Soft (50–64%): Graveyard with ↩ Rescue button to add back to pipeline. Fixes known issues: author attribution tagged as STEP, status/version lines, document metadata.',
      'Graveyard section: collapsible panel at bottom of Pre-Parse tab. Shows all filtered items with tier badge (HIGH/MED/LOW), confidence %, reason, and rescue button for soft-confidence items.',
      'intel-b — Semantic fact scoring (INTEL_FLAGS.factScoring): scoreFactStatement() assigns 0–1 score using FACT_CUE_STARTERS, FACT_DEFINITION_PATTERN, FACT_MEASURE_PATTERN, minus penalties for action verbs and decision starters. Lines ≥ 0.6 reclassified to NOTE and excluded from Claude context. Signals shown inline on the pre-parse row.',
      'intel-c — Smart label splitting (INTEL_FLAGS.smartLabel): smartSplitLabel() extracts label from "Label: description", "Label — description", "Label → description", "Label - description" patterns before stop-word stripping. Only applied if the extracted label is shorter than the baseline proposeLabel() output.',
      'pipeline.stages tracing: pipe.stages[] records what each intelligence layer did (removed/graved/reclassified/changed/kept counts). Visible in Pipeline diff collapsible panel in Pre-Parse tab.',
      'Confidence pills: each pre-parse item shows a colour-coded confidence % pill (green ≥80%, amber 60–79%, red <60%). Reclassified items show the fact-scorer signals on hover and inline.',
    ],
  },
  {
    version: 'v3.0.5',
    date: '2026-04-13',
    summary: 'Fix: ELK layout renderer config for Mermaid 10.x; ELK marked beta',
    changes: [
      'ELK layout: corrected mermaid.initialize() config — Mermaid 10.x uses flowchart.defaultRenderer ("elk"|"dagre"), not a top-level layout object; previous config silently fell back to dagre on every render',
      'ELK selector now shows "ELK (beta)" — requires elkjs CDN to load; falls back to dagre gracefully if not available',
      'Dagre remains the default on page load (selected attribute added to option)',
    ],
  },
  {
    version: 'v3.0.1',
    date: '2026-04-13',
    summary: 'Fix: project selector + pre-parse CSV/print export',
    changes: [
      'Fixed CodeMirror init: replaced fragile Object.defineProperty sync with a re-entrancy-guarded cmSetValue() helper — eliminates the infinite-loop / early-exit that broke project selector and other post-init code',
      'Fixed project dialog Enter key: wired keydown listener on project-name-input so Enter confirms and Escape cancels',
      'Pre-parse CSV export (↓ CSV button): downloads a UTF-8 CSV (BOM for Excel) with columns #, Type, Actor, Proposed Label, Original Text — open in Excel or Google Sheets for offline annotation',
      'Pre-parse Print export (⎙ Print button): opens a formatted HTML review sheet in a new tab — type colour-coded badges, notes/correction column, print-ready layout — compare against original document offline then apply corrections in the interactive Pre-Parse pane',
    ],
  },
  {
    version: 'v3.0.0',
    date: '2026-04-13',
    summary: 'Major upgrade: Two-pass generation, Entity Registry, Interactive Pre-Parse editor, CodeMirror, ELK layout, source-diagram traceability',
    changes: [
      'v2.5.0 — Two-pass generation: ⊕ 2-Pass button enables Pass 1 (semantic entity extraction to JSON via Haiku — actors, steps, decisions, exceptions) → Pass 2 (Mermaid generation from structured JSON). Dramatically reduces hallucinated nodes and missed branches. Falls back to single-pass if Pass 1 fails. Pass 1 JSON visible in Analysis pane.',
      'v2.6.0 — Entity Registry: Pass 1 JSON builds pipe.entityRegistry (normalised actor/process/decision map). Injected into all chunk prompts and buildPrompt() as ENTITY REGISTRY block — ensures consistent naming across all chunks. Post-generation validation: dead ends, single-exit decisions, missing lane actors, similar duplicate labels — shown in validation bar.',
      'v2.7.0 — Interactive Pre-Parse editor: click a type badge to cycle through all types (step↔decision↔subprocess↔…). Click actor badge to cycle through detected actors or None. Click ✕ to delete an item. Drag rows to reorder. All changes persist to pipe.preparsed and are immediately used for the next Generate call.',
      'v2.8.0 — CodeMirror 5 syntax-highlighted editor: replaces the plain textarea with a Dracula-themed editor with Mermaid keyword highlighting (keywords pink, strings yellow, node IDs green, comments grey). Line numbers, bracket awareness, Ctrl+Enter/R/S shortcuts. Transparent textarea compatibility layer so all existing read/write code works unchanged.',
      'v2.9.0 — ELK layout engine: layout selector (Dagre / ELK) in toolbar. ELK uses layered orthogonal routing — significantly better for complex swimlanes and large flowcharts. Zoom-to-fit on every new render automatically scales the diagram to fill the viewport.',
      'v3.0.0 — Source-diagram traceability: click any node in the rendered diagram → app switches to Pre-Parse tab and highlights the matching source item with a blue glow (3-second auto-dismiss). Uses token-overlap scoring to find the best matching pre-parse item. Double-click still opens the inline label editor.',
    ],
  },
  {
    version: 'v2.4.2',
    date: '2026-04-13',
    summary: 'Mermaid repair pass + hardened refine prompt for swimlane arrow/decision syntax',
    changes: [
      'repairMermaid() pre-processor fixes malformed arrow syntax and orphaned Yes/No node definitions',
      'Refine prompt now swimlane-aware: injects SWIMLANE RULES block when editing a graph LR/TD diagram',
      'Refine prompt always requires both Yes and No exits on every decision node',
    ],
  },
  {
    version: 'v2.4.1',
    date: '2026-04-13',
    summary: 'Hotfix: stadium shape crash inside swimlane subgraphs (Mermaid 10.6 bug)',
    changes: [
      'Root cause: Mermaid 10.6.1 does not support the stadium shape ID([...]) inside subgraph blocks used by graph LR/TD swimlane diagrams — throws "got STADIUMEND" parse error',
      'sanitiseLabels(): when first line is "graph " (swimlane), rewrites all ID([...]) occurrences to ID[["..."]] (subroutine shape) as a safe post-processing fallback',
      'injectColours(): added subroutine pattern match [["..."]] — Start/End labels still receive green/red colour classDef assignments',
      'buildRuleBasedSwimlane(): Quick Chart swimlane now emits [["..."]] for outcome nodes instead of (["..."])',
      'buildPrompt() swimlane: instructs Claude to use [["Start"]] / [["End"]] and warns against ([Start]) / ([End]) inside graph subgraphs',
      'buildChunkPrompt(): swimlane dtype selects [["Start"]] / [["End"]] terminal shape',
    ],
  },
  {
    version: 'v2.4.0',
    date: '2026-04-13',
    summary: 'Glossary architecture redesign: two-tier (Global/Project), Output Templates, mixed-case auto-learning, project memory',
    changes: [
      'Two-tier glossary: Global tab (shared across all projects, seeded from iGaming terms) + Project tab (per-project terms stored under currentProject.slug in localStorage)',
      'Project selection memory: last-used project slug persisted to localStorage (fc_last_project_v1) and auto-restored on page load',
      'Output Templates (new glossary tier): canonical node sequences for known process types (e.g. "Withdrawal Request") — injected into AI prompts when process name is detected in document text',
      'Mixed-case auto-learning: extends beyond ALL-CAPS acronyms to detect CamelCase domain terms and repeated Title Case phrases (min 2 occurrences); shown with "phrase" badge in learn banner',
      'Glossary term case-preservation: short acronyms (≤10 chars, no spaces, all-caps/digits) are normalised to uppercase; longer mixed-case terms keep their original casing',
      'Tier count badges on glossary sub-tabs show live counts for Global, Project, and Output Templates',
      'Output glossary import/export as JSON, separate from input glossary export',
      'Project-tier learned terms stored in project glossary when project tier is active',
    ],
  },
  {
    version: 'v2.3.0',
    date: '2026-04-13',
    summary: 'DOCX structure preservation, output type validation, chunk overlap',
    changes: [
      'DOCX import: Mammoth now uses HTML conversion mode — h1/h2/h3 → # headings, <ul>/<ol> → bullet steps, <table> rows → structured lines with header context; raw text fallback retained',
      'Output type validation: post-generation check ensures first line matches requested type (flowchart/swimlane/sequence); automatic one-shot re-prompt if mismatch detected',
      'Chunk overlap: last 2 sentences of each chunk carried into the next to preserve cross-boundary context; prevents mid-process flow breaks in long documents',
    ],
  },
  {
    version: 'v2.2.0',
    date: '2026-04-13',
    summary: 'Swimlane improvements, actor attribution, ⚡ Quick Chart (Tier 1 rule-based generator)',
    changes: [
      'Tier 1 generator: ⚡ Quick Chart builds valid Mermaid from pipeline tags with zero API calls (flowchart, swimlane, sequence)',
      'Section-level actor inheritance: headings naming an actor propagate to all steps below until next heading',
      'Keyword-based actor inference: System/Finance/Manager detected from sentence body keywords even without explicit prefix',
      'Carry-forward: once a step is attributed, next unattributed step inherits the same actor',
      'Lane orientation toggle: graph LR (Top→Bottom) or graph TD (Left→Right) for swimlane',
      'Strengthened swimlane prompt: per-lane ownership rules, hard enforcement of [actor:X] tags, untagged → Agent default',
      'Fixed Quick Chart syntax errors: circular Start/End, markdown asterisks in labels, unquoted subgraph names',
      'All selected lanes always rendered (empty lane shows placeholder node)',
      'iGaming lane order: Player → Agent → System → Finance → Manager',
    ],
  },
  {
    version: 'v2.1.0',
    date: '2026-04-13',
    summary: 'Pre-parse improvements: STATUS tag, actor attribution, decimal heading detection',
    changes: [
      'New STATUS tag: short noun-phrase lines (Pending, Finance Tab, Cancelled…) no longer counted as STEPs',
      'Actor attribution field added to pre-parse items; shown as orange badge in Pre-Parse pane',
      'Fixed decimal heading detection: "4.2 Processing a Withdrawal" now tagged HEAD/SUBP not NOTE',
      'STATUS items excluded from node count estimate and structured context sent to Claude',
      'Single APP_VERSION constant drives page title, header badge, Logic tab badge at runtime',
    ],
  },
  {
    version: 'v2.0.2',
    date: '2026-04-13',
    summary: 'Initial GitHub setup — full Flowinject feature set',
    changes: [
      'Multi-format conversion: Flowchart, Swim Lane, Sequence via Claude AI',
      'Five-stage pipeline: Raw → Clean → Chunk → Pre-Parse → Analysis',
      'Domain presets: iGaming CS, Generic Business, Banking, Healthcare, E-commerce',
      'Glossary system with domain filtering and auto-learning of ALL-CAPS acronyms',
      'GitHub project sync, saved charts, history, split-view Panel B',
      'Export: SVG, PNG with meta header, MMD file, Print',
      'Share URL encodes chart in query string',
      'Mermaid 10.6.1, PDF.js 3.11, Mammoth 1.6 from CDN',
    ],
  },
];

function renderChangelog() {
  var el = document.getElementById('logic-changelog');
  if (!el) return;
  el.innerHTML = CHANGELOG.map(function(entry) {
    var isCurrent = entry.version === APP_VERSION;
    return '<div class="cl-entry' + (isCurrent ? ' current' : '') + '">' +
      '<div><span class="cl-version">' + escHtml(entry.version) + '</span>' +
      (isCurrent ? ' <span style="font-size:9px;background:var(--blue-100);color:var(--blue-700);border-radius:3px;padding:1px 5px;font-weight:700;">current</span>' : '') +
      '<span class="cl-date">' + escHtml(entry.date) + '</span></div>' +
      '<div class="cl-summary">' + escHtml(entry.summary) + '</div>' +
      '<ul class="cl-changes">' +
      entry.changes.map(function(c) { return '<li>' + escHtml(c) + '</li>'; }).join('') +
      '</ul></div>';
  }).join('');
}

function renderLogicTab() {
  // Update version badge
  var badge = document.getElementById('logic-version-badge');
  if (badge) badge.textContent = APP_VERSION;

  // Build tag table from TAG_DEFINITIONS
  var tbody = document.getElementById('logic-tag-tbody');
  if (tbody) {
    tbody.innerHTML = TAG_DEFINITIONS.map(function(def) {
      return '<tr>' +
        '<td class="logic-priority">' + def.priority + '</td>' +
        '<td><span class="ltag ' + def.cssClass + '">' + def.tag + '</span></td>' +
        '<td>' + escHtml(def.triggers) + '</td>' +
        '<td class="logic-mmd-out">' + escHtml(def.mmdOutput) + '</td>' +
      '</tr>';
    }).join('');
  }

  // v3.1.0: Render intelligence flags panel
  renderIntelFlagsPanel();

  // Render changelog
  renderChangelog();

  // Render live snapshot if pipeline has run
  renderLogicSnapshot();
}

function renderLogicSnapshot() {
  var area   = document.getElementById('logic-snapshot-area');
  var status = document.getElementById('logic-snap-status');
  if (!area) return;

  if (!pipe.preparsed || !pipe.preparsed.length) {
    area.innerHTML = '<div class="logic-snap-empty">Run the pipeline on a document to see tag distribution here</div>';
    if (status) status.textContent = 'run pipeline to populate';
    return;
  }

  // Count each type
  var counts = {};
  TAG_DEFINITIONS.forEach(function(d) { counts[d.cssClass] = 0; });
  pipe.preparsed.forEach(function(p) {
    if (counts.hasOwnProperty(p.type)) counts[p.type]++;
  });
  var total = pipe.preparsed.length;

  // Update status
  if (status) {
    var fname = document.getElementById('fname').textContent;
    status.textContent = total + ' elements' + (fname ? ' · ' + fname : '');
  }

  // Summary cards (top 5 non-zero types)
  var topTypes = TAG_DEFINITIONS
    .filter(function(d) { return counts[d.cssClass] > 0; })
    .sort(function(a, b) { return counts[b.cssClass] - counts[a.cssClass]; })
    .slice(0, 5);

  var cardsHTML = '';
  if (topTypes.length > 0) {
    cardsHTML = '<div class="logic-snap-grid">' +
      topTypes.map(function(d) {
        return '<div class="logic-snap-card">' +
          '<div class="logic-snap-count">' + counts[d.cssClass] + '</div>' +
          '<div class="logic-snap-label"><span class="ltag ' + d.cssClass + '" style="font-size:8px;">' + d.tag + '</span></div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  // Bar chart for all types with count > 0
  var maxCount = Math.max.apply(null, Object.values(counts));
  var barsHTML = '<div class="logic-bar-wrap">' +
    TAG_DEFINITIONS.filter(function(d) { return counts[d.cssClass] >= 0; })
    .map(function(def) {
      var c   = counts[def.cssClass];
      var pct = maxCount > 0 ? Math.round((c / maxCount) * 100) : 0;
      var col = TAG_BAR_COLORS[def.cssClass] || '#d1d5db';
      return '<div class="logic-bar-row">' +
        '<span class="logic-bar-label"><span class="ltag ' + def.cssClass + '" style="font-size:8px;padding:1px 4px;">' + def.tag + '</span></span>' +
        '<div class="logic-bar-track"><div class="logic-bar-fill" style="width:' + pct + '%;background:' + col + ';"></div></div>' +
        '<span class="logic-bar-count">' + (c > 0 ? c : '') + '</span>' +
      '</div>';
    }).join('') +
  '</div>';

  area.innerHTML = cardsHTML + barsHTML;

  // Token log section — appended below bar chart when API calls have been made
  var tokenSection = document.getElementById('logic-token-log');
  if (tokenSection) {
    if (pipe.tokenLog && pipe.tokenLog.length) {
      tokenSection.style.display = '';
      var logContainer = document.getElementById('logic-token-log-content');
      if (logContainer) logContainer.innerHTML = renderTokenLogTable();
    } else {
      tokenSection.style.display = 'none';
    }
  }
}

// Hook: update logic snapshot whenever pipeline completes
// (wraps the existing pipeline dot setter so no pipeline code changes needed)
var _origSetPipeDot = setPipeDot;
setPipeDot = function(stage, state) {
  _origSetPipeDot(stage, state);
  // When analysis completes, update logic snapshot if tab is open
  if (stage === 'analysis' && state === 'done' && currentRightTab === 'logic') {
    setTimeout(renderLogicSnapshot, 200);
  }
};

// ── Init ──────────────────────────────────────────────────────────
seedGlossaryIfEmpty();
seedOutputGlossaryIfEmpty();
showChartPlaceholder();
loadSharedChart();
restoreAutosave();
_pruneDrafts(); // remove localStorage drafts older than 24 hours

// ── CodeMirror initialisation (v2.8.0) ────────────────────────────
// Define a simple Mermaid highlighting mode for CodeMirror 5
(function() {
  if (typeof CodeMirror === 'undefined') return; // CDN not loaded yet — skip gracefully

  // Minimal tokenizer for Mermaid syntax
  CodeMirror.defineSimpleMode('mermaid', {
    start: [
      { regex: /%%.*$/, token: 'comment' },
      { regex: /(?:flowchart|graph|sequenceDiagram|gantt|pie|erDiagram)\b/, token: 'keyword' },
      { regex: /(?:subgraph|end|direction|participant|loop|alt|else|opt|par|and|note over|note left|note right)\b/, token: 'builtin' },
      { regex: /(?:TD|LR|TB|RL|BT)\b/, token: 'atom' },
      { regex: /"[^"]*"/, token: 'string' },
      { regex: /'[^']*'/, token: 'string' },
      { regex: /\[\[/, token: 'keyword', next: 'subroutine' },
      { regex: /\(\[/, token: 'keyword', next: 'stadium' },
      { regex: /\{[^}]*\}/, token: 'builtin' },    // decision
      { regex: /-->|---|\-\.-|===>|==>|--x|--o|<-->/, token: 'operator' },
      { regex: /\|[^|]*\|/, token: 'atom' },        // arrow labels
      { regex: /[A-Z_][A-Za-z0-9_-]*(?=[\[{(])/, token: 'variable' }, // node IDs
      { regex: /classDef|class\b/, token: 'keyword' },
    ],
    subroutine: [
      { regex: /"\]\]/, token: 'keyword', next: 'start' },
      { regex: /\]\]/, token: 'keyword', next: 'start' },
      { regex: /"[^"]*"/, token: 'string' },
      { regex: /[^\]"]+/, token: 'string' },
    ],
    stadium: [
      { regex: /"\]\)/, token: 'keyword', next: 'start' },
      { regex: /\]\)/, token: 'keyword', next: 'start' },
      { regex: /"[^"]*"/, token: 'string' },
      { regex: /[^\]"]+/, token: 'string' },
    ],
    meta: { lineComment: '%%' },
  });

  var textArea = document.getElementById('mermaid-editor');
  var wrap     = document.getElementById('cm-editor-wrap');
  if (!textArea || !wrap) return;

  // Mount CodeMirror onto the wrap div
  window.cmEditor = CodeMirror(wrap, {
    value:        textArea.value,
    mode:         'mermaid',
    theme:        'eclipse',
    lineNumbers:  true,
    lineWrapping: false,
    autofocus:    false,
    tabSize:      2,
    indentWithTabs: false,
    extraKeys: {
      'Ctrl-Enter':   function() { smartAction(); },
      'Ctrl-R':       function() { renderFromEditor(); },
      'Ctrl-S':       function() { openSaveDialog(); },
    },
  });

  // Sync CodeMirror → hidden textarea on user edits
  // Guard against re-entrancy (setValue also fires 'change')
  var _cmSyncing = false;
  window.cmEditor.on('change', function(cm) {
    if (_cmSyncing) return;
    _cmSyncing = true;
    // Write through to the raw textarea value via the prototype setter
    // so other code reading textArea.value sees the latest content
    var raw = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (raw && raw.set) raw.set.call(textArea, cm.getValue());
    else textArea.setAttribute('value', cm.getValue());
    scheduleRender();
    _cmSyncing = false;
  });

  // Expose a safe setter used by generate/refine/load paths
  // instead of Object.defineProperty (which caused infinite loops)
  window.cmSetValue = function(val) {
    if (!window.cmEditor) return;
    _cmSyncing = true;
    window.cmEditor.setValue(val || '');
    window.cmEditor.clearHistory();
    _cmSyncing = false;
  };

  // Patch the hidden textarea so direct .value writes route through cmSetValue
  // Use a per-element defineProperty (NOT on the prototype)
  var _desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  if (_desc && _desc.set) {
    Object.defineProperty(textArea, 'value', {
      configurable: true,
      get: function() {
        return window.cmEditor ? window.cmEditor.getValue() : _desc.get.call(textArea);
      },
      set: function(val) {
        if (_cmSyncing) { _desc.set.call(textArea, val); return; }
        if (window.cmEditor) {
          window.cmSetValue(val);
        } else {
          _desc.set.call(textArea, val);
        }
      },
    });
  }
})();

// Restore API key + PAT from storage (v3.7.0: inputs now live in settings popover)
// v4.0.0: one-time migration from legacy 'fc_api_key' key → 'fc_apikey'
(function() {
  var legacy = localStorage.getItem('fc_api_key');
  if (legacy && !localStorage.getItem('fc_apikey')) {
    localStorage.setItem('fc_apikey', legacy);
    localStorage.removeItem('fc_api_key');
    console.log('[FC] Migrated localStorage key fc_api_key → fc_apikey');
  }
  var savedKey = localStorage.getItem('fc_apikey');
  if (savedKey) {
    var inp = document.getElementById('apikey');
    if (inp) inp.value = savedKey;
    _stgSetIndicator('stg-apikey-indicator', true);
  }
  // GitHub PAT — try persistent localStorage first, fall back to sessionStorage
  var savedPAT = localStorage.getItem('fc_ghpat_persist') || sessionStorage.getItem('fc_ghpat');
  if (savedPAT) {
    var patInp = document.getElementById('gh-pat');
    if (patInp) patInp.value = savedPAT;
    sessionStorage.setItem('fc_ghpat', savedPAT); // keep session in sync
    _stgSetIndicator('stg-pat-indicator', true);
    var syncBtn = document.getElementById('gh-sync-btn');
    if (syncBtn) syncBtn.style.display = '';
  }
})();

// Load projects from localStorage into selector
renderProjectSelector();

// Pre-populate the logic tab static sections on load
setTimeout(renderLogicTab, 100);
setTimeout(updateThinkingIndicator, 150);
setTimeout(syncVersion, 0); // safety re-run after full DOM ready — ensures badge is always populated
setTimeout(onDiagramTypeChange, 0); // ensure orientation dropdown visible for default output type

// Set initial button state
updatePipelineStatus(false);

// Auto-sync from GitHub if PAT already set
(function() {
  if (sessionStorage.getItem('fc_ghpat')) {
    setTimeout(function() {
      syncGlossaryFromGitHub().catch(function(){});
      syncProjectsFromGitHub().catch(function(){});
    }, 1200);
  }
})();

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
  // Close shortcuts popup on Escape
  if (e.key === 'Escape') {
    var popup = document.getElementById('shortcuts-popup');
    if (popup) popup.style.display = 'none';
    return;
  }
  var mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  if (e.key === 'Enter') { e.preventDefault(); smartAction(); }
  if (e.key === 's' && !e.shiftKey) { e.preventDefault(); openSaveDialog(); }
  if (e.key === 'r') { e.preventDefault(); renderFromEditor(); }
});

console.log('Flowinject ' + APP_VERSION + ' ready');
// ── Dev helper ────────────────────────────────────────────────────
// Exposes architecture info in browser console — no sensitive data.
// Usage: console.log(window.__fc_debug)   or   window.__fc_debug.pipe
window.__fc_debug = {
  version:    APP_VERSION,
  buildDate:  APP_BUILD_DATE,
  pipe:       pipe,          // live pipeline state (read-only reference)
  intelFlags: INTEL_FLAGS,
  detailLevel: function() { return DETAIL_LEVEL; },
  fnMap: {
    callAPI:                callAPI.toString().substring(0, 120),
    runExtraction:          runExtraction.toString().substring(0, 120),
    buildGraph:             buildGraph.toString().substring(0, 120),
    extractEntitiesPass1:   extractEntitiesPass1.toString().substring(0, 120),
    buildPass2Prompt:       buildPass2Prompt.toString().substring(0, 120),
    preParse:               preParse.toString().substring(0, 120),
    buildStructuredContext: buildStructuredContext.toString().substring(0, 120),
    repairMermaid:          repairMermaid.toString().substring(0, 120),
    sanitiseLabels:         sanitiseLabels.toString().substring(0, 120),
    scoreJunk:              scoreJunk.toString().substring(0, 120),
    scoreFactStatement:     scoreFactStatement.toString().substring(0, 120),
    smartSplitLabel:        smartSplitLabel.toString().substring(0, 120),
  },
};

// ── v4.0.0 Verification checks ───────────────────────────────────
console.assert(typeof detectTOC === 'function', 'v4.0 check: detectTOC exists');
console.assert(typeof runExtraction === 'function', 'v4.0 check: runExtraction exists');
console.assert(typeof buildGraph    === 'function', 'v4.0 check: buildGraph exists');
console.assert(typeof handleAPIError === 'function', 'v4.0 check: handleAPIError exists');
console.assert(typeof normaliseMermaidLabels === 'function', 'v4.0 check: normaliseMermaidLabels exists');
