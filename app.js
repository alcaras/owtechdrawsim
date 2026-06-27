// UI for the Old World tech-draw simulator. Wires the faithful DrawEngine to a
// game-like screen: a hand of cards you pick from, a Next-turn science tick, the
// Scholar redraw, a buildable Oracle, and a turn-by-turn history.
import { DrawEngine } from './engine.js';
import { makeScienceModel, makeScienceCurve, scienceBreakdown } from './science.js';
import { parseOwttPlan, encodeOwttOrder, simulatePlan, optimizePlan } from './planner.js';

const TD = window.techData;
const ND = window.nationData;
const NATIONS = window.nationLookup;

// ---------- icon paths (match owtt conventions) ----------
const SCI_ICON = 'img/icons/yields/science.png';
const LAW_ICON = 'img/icons/yields/laws.png';
const LAWS_BY_TECH = new Map(TD.techs.map((t) => [t.id, (t.unlocks && t.unlocks.laws) || []]));
const lawsOf = (id) => LAWS_BY_TECH.get(id) || [];
const techIcon = (id) => `img/icons/techs/${id.replace(/^TECH_/, '').toLowerCase()}.png`;
const bonusIcon = (iconName) => iconName ? `img/icons/bonus/${iconName.toLowerCase()}.png` : SCI_ICON;
const crestIcon = (slug) => `img/crests/${slug}.png`;
const nationName = (id) => (ND.nationNames.find((n) => n.id === id) || {}).name || id.replace('NATION_', '');
const nationColor = (id) => ND.colors[id] || { bg: '#caa45a', accent: '#caa45a', crest: '' };

const $ = (sel) => document.querySelector(sel);

// Cards a tech adds to the draw pool when researched: hard = main techs that list it
// as a prereq; soft = bonus cards whose parent is this tech.
const TECH_BY_ID = new Map(TD.techs.map((t) => [t.id, t]));
const DOWNSTREAM = (() => {
  const hard = new Map(), soft = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const t of TD.techs) for (const p of (t.prereqs || [])) push(hard, p, t.id);
  for (const b of TD.bonusTechs) if (b.parent) push(soft, b.parent, b.id);
  return { hard, soft };
})();
// Only count a downstream tech if researching THIS one actually makes it drawable —
// i.e. all its OTHER prerequisites are already acquired (conditional/multi-prereq unlocks).
function opensHTML(id) {
  const acq = (p) => engine.state.get(p) === 'acquired';
  const h = (DOWNSTREAM.hard.get(id) || []).filter((cid) => {
    const c = TECH_BY_ID.get(cid);
    return c && (c.prereqs || []).every((p) => p === id || acq(p));
  }).length;
  const s = (DOWNSTREAM.soft.get(id) || []).filter((bid) => {
    const st = engine.state.get(bid);
    return st !== 'acquired' && st !== 'trashed';
  }).length;
  let out = '';
  if (h) out += `<span class="op op-hard" title="Researching this adds ${h} new tech card${h > 1 ? 's' : ''} to your draw pool">⊞ ${h}</span>`;
  if (s) out += `<span class="op op-soft" title="Adds ${s} bonus card${s > 1 ? 's' : ''} to your draw pool">★ ${s}</span>`;
  return `<span class="card-opens">${out}</span>`;
}

let engine = null;
let _overflow = 0; // current carried-over science, for the preview on cards

// ---- undo / redo ----
let undoStack = [], redoStack = [];
// Record an undo step only when the action actually changed state (so no-ops like
// re-selecting a card or building the Oracle twice don't flood the stack).
function act(fn) {
  const snap = engine.snapshot();
  if (fn() !== false) {
    undoStack.push(snap);
    if (undoStack.length > 300) undoStack.shift();
    redoStack = [];
  }
  render();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(engine.snapshot());
  engine.restore(undoStack.pop());
  render();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(engine.snapshot());
  engine.restore(redoStack.pop());
  render();
}

// ---------- nation picker ----------
function buildPicker() {
  const grid = $('#nationGrid');
  grid.innerHTML = '';
  for (const id of NATIONS) {
    const c = nationColor(id);
    const btn = document.createElement('button');
    btn.className = 'nation-card';
    btn.style.setProperty('--accent', c.accent);
    btn.style.setProperty('--bg', c.bg);
    btn.innerHTML = `
      <span class="nation-crest-disc"><img class="nation-crest" src="${crestIcon(c.crest)}" alt="" onerror="this.style.visibility='hidden'" /></span>
      <span class="nation-name">${nationName(id)}</span>`;
    btn.addEventListener('click', () => startGame(id));
    grid.appendChild(btn);
  }
}

function startGame(nationId) {
  // Random seed each game unless the player typed one.
  const raw = $('#pickSeed').value.trim();
  const seed = raw === '' ? Math.floor(Math.random() * 0x100000000) : (parseInt(raw, 10) || 1);
  const scholar = $('#pickScholar').checked;
  engine = new DrawEngine({ techs: TD.techs, bonusTechs: TD.bonusTechs, scienceCurve: makeScienceModel(nationId) });
  engine.start({
    nation: nationId,
    startingTechs: ND.startingTechs[nationId] || [],
    seed,
    scholar,
  });
  window.__engine = engine; // exposed for debugging / headless drivers
  undoStack = []; redoStack = [];
  // Add a history entry so the browser Back button returns to the nation picker.
  history.pushState({ screen: 'game' }, '');
  showGameView();
  $('#scholarToggle').checked = scholar;
  applyTheme(nationId);
  render();
}

function applyTheme(nationId) {
  const c = nationColor(nationId);
  document.documentElement.style.setProperty('--nation-bg', c.bg);
  document.documentElement.style.setProperty('--nation-accent', c.accent);
}

function showPickerView() { $('#game').hidden = true; $('#picker').hidden = false; }
function showGameView() { $('#picker').hidden = true; $('#game').hidden = false; }
// Restart button: pop the game history entry (so Back/Forward stay in sync), else show.
function restart() {
  if (history.state && history.state.screen === 'game') history.back();
  else showPickerView();
}
// Browser Back/Forward: Back returns to the picker but KEEPS the game state so
// Forward resumes exactly where you were (engine isn't destroyed).
window.addEventListener('popstate', (e) => {
  const screen = (e.state && e.state.screen) || 'picker';
  if (screen === 'game' && engine) { applyTheme(engine.nation); render(); showGameView(); }
  else showPickerView();
});
if (!history.state) history.replaceState({ screen: 'picker' }, '');

// ---------- render ----------
function unlockPills(unlocks) {
  if (!unlocks) return '';
  const groups = [
    ['unit', unlocks.units], ['imp', unlocks.improvements],
    ['law', unlocks.laws], ['proj', unlocks.projects],
  ];
  const pills = [];
  for (const [kind, arr] of groups) {
    for (const name of (arr || [])) {
      const ic = kind === 'law' ? `<img class="pill-ic" src="${LAW_ICON}" alt="law" onerror="this.replaceWith('⚖')" />` : '';
      pills.push(`<span class="pill pill-${kind}">${ic}${escapeHtml(name)}</span>`);
    }
  }
  return pills.length ? `<div class="card-unlocks">${pills.join('')}</div>` : '';
}

function cardHTML(card) {
  const costHTML = `<span class="card-cost">${card.cost}<img src="${SCI_ICON}" alt="science" /></span>`;
  if (card.isBonus) {
    return `
      <button class="card card-bonus${card.isCurrent ? ' is-current' : ''}" data-id="${card.id}">
        <div class="card-trash-tag">burns if passed</div>
        <div class="card-icon">
          <img src="${bonusIcon(card.iconName)}" alt="" onerror="this.style.display='none';this.parentElement.classList.add('icon-star')" />
        </div>
        <div class="card-name">${escapeHtml(card.name)}</div>
        <div class="card-bonus-text">${escapeHtml(card.bonus || 'One-time bonus')}</div>
        <div class="card-foot">${costHTML}<span class="card-opens"></span></div>
        ${progressHTML(card)}
      </button>`;
  }
  const f = card.name[0];
  return `
    <button class="card${card.isCurrent ? ' is-current' : ''}" data-id="${card.id}">
      <div class="card-icon">
        <img src="${techIcon(card.id)}" alt="" onerror="this.style.display='none';this.parentElement.innerHTML='<span class=&quot;icon-fallback&quot;>${f}</span>'" />
      </div>
      <div class="card-name">${escapeHtml(card.name)}</div>
      ${unlockPills(card.unlocks)}
      <div class="card-foot">${costHTML}${opensHTML(card.id)}</div>
      ${progressHTML(card)}
    </button>`;
}

function progressHTML(card) {
  // solid = committed science; preview = the carried-over (overflow) science that would
  // collapse onto this card if you end the turn with it selected.
  const base = Math.min(100, (card.invested / card.cost) * 100);
  const withOv = Math.min(100, ((card.invested + _overflow) / card.cost) * 100);
  const prev = Math.max(0, withOv - base);
  return `<div class="card-prog"><i class="prog-solid" style="width:${base}%"></i><i class="prog-prev" style="width:${prev}%"></i></div>`;
}

function render() {
  const v = engine.view();
  _overflow = v.overflow;

  // topbar
  const c = nationColor(v.nation);
  $('#topCrest').src = crestIcon(c.crest);
  $('#topNation').textContent = nationName(v.nation);
  $('#statTurn').textContent = v.turn;
  const bd = scienceBreakdown(v.nation, v.turn, engine);
  if (bd.bonus > 0) {
    const tip = `base ${bd.base} + ${bd.contribs.map((c) => `${techName(c.id)} +${c.amount.toFixed(1)}`).join(', ')}`;
    $('#statSpt').innerHTML = `+${v.sciencePerTurn}<span class="sci-bonus" title="${tip}">⚛ +${bd.bonus}</span>`;
  } else {
    $('#statSpt').textContent = '+' + v.sciencePerTurn;
  }
  $('#statTotal').textContent = v.totalScience;
  $('#statDeck').textContent = v.deckSize;
  $('#seedLabel').textContent = 'seed ' + v.seed;

  // scholar / oracle controls
  $('#scholarToggle').checked = v.scholar;
  const oBtn = $('#oracleBtn');
  if (v.oracleBuiltTurn != null) {
    oBtn.disabled = true;
    oBtn.classList.add('built');
    oBtn.innerHTML = `Oracle built <span class="oracle-plus">T${v.oracleBuiltTurn} · +1</span>`;
  } else {
    oBtn.disabled = false;
    oBtn.classList.remove('built');
    oBtn.innerHTML = `Build Oracle <span class="oracle-plus">+1 card</span>`;
  }

  // research bar
  const rb = $('#researchBody');
  const carryNote = v.overflow ? `<span class="carry-tag" title="Carried-over science — applies to whichever card you have selected when you press Next turn">↻ +${v.overflow} carry</span>` : '';
  if (v.currentResearch) {
    const t = engine.get(v.currentResearch);
    const cost = t.cost, inv = engine.investedIn(v.currentResearch);
    const base = Math.min(100, (inv / cost) * 100);
    const prev = Math.max(0, Math.min(100, ((inv + v.overflow) / cost) * 100) - base);
    rb.innerHTML = `
      <span class="research-name">${t.isBonus ? '★' : ''}${escapeHtml(t.name)}</span>
      <div class="research-bar"><i class="rb-solid" style="width:${base}%"></i><i class="rb-prev" style="width:${prev}%"></i><b>${inv}${v.overflow ? `<span class="rb-ov">+${v.overflow}</span>` : ''} / ${cost}</b></div>
      ${carryNote}`;
  } else if (v.done) {
    rb.innerHTML = `<span class="research-empty">All available techs researched. 🎉</span>`;
  } else {
    rb.innerHTML = `<span class="research-empty">Pick a card below — you must be researching something to advance.</span>${carryNote}`;
  }

  // hand
  $('#hand').innerHTML = v.hand.map(cardHTML).join('') || '<div class="hand-empty">No cards to draw.</div>';
  $('#hand').querySelectorAll('.card').forEach((el) => {
    // Selecting a card is ephemeral (freely reversible) — not an undo step.
    el.addEventListener('click', () => { engine.pickResearch(el.dataset.id); render(); });
  });

  // actions
  $('#redrawBtn').disabled = !v.canRedraw;
  $('#nextBtn').disabled = !v.canEndTurn;
  $('#finishBtn').disabled = !v.canEndTurn;
  $('#undoBtn').disabled = !undoStack.length;
  $('#redoBtn').disabled = !redoStack.length;

  // history (newest first)
  $('#history').innerHTML = v.log.slice().reverse().map((e) =>
    `<li class="ev ev-${e.type}"><span class="ev-turn">T${e.turn}</span><span class="ev-text">${escapeHtml(e.text)}</span></li>`
  ).join('');

  // acquired ledger — count, total research science, and law tally (incl. starting techs)
  $('#acqCount').textContent = v.acquired.length;
  const totalSci = v.acquired.reduce((s, a) => s + a.science, 0);
  let lawCount = 0;
  for (const t of TD.techs) if (engine.state.get(t.id) === 'acquired') lawCount += lawsOf(t.id).length;
  $('#acqSci').innerHTML = totalSci ? `${totalSci}<img src="${SCI_ICON}" alt="science" />` : '';
  $('#acqLaws').innerHTML = lawCount ? `${lawCount}<img src="${LAW_ICON}" alt="laws" onerror="this.replaceWith('⚖')" />` : '';
  $('#acquired').innerHTML = v.acquired.map((a) => {
    const laws = lawsOf(a.id);
    const lawMark = laws.length ? `<img class="acq-law" src="${LAW_ICON}" alt="law" title="Unlocks ${laws.join(', ')}" onerror="this.replaceWith('⚖')" />` : '';
    return `<li><span class="acq-turn">T${a.turn}</span><span class="acq-name">${a.isBonus ? '★' : ''}${escapeHtml(a.name)}${lawMark}</span><span class="acq-sci">${a.science}<img src="${SCI_ICON}" alt="" /></span></li>`;
  }).join('');

  // draw pile + discard
  const p = v.piles;
  const chip = (c) => `<span class="chip${c.isBonus ? ' chip-bonus' : ''}">${c.isBonus ? '★' : ''}${escapeHtml(c.name)}<b>${c.cost}</b></span>`;
  $('#drawCount').textContent = p.draw.length;
  $('#drawList').innerHTML = p.draw.length
    ? `<div class="pile-row">${p.draw.map(chip).join('')}</div>`
    : '<div class="pile-empty">empty</div>';
  $('#discardCount').textContent = p.passed.length;
  $('#discardList').innerHTML = p.passed.length
    ? `<div class="pile-row">${p.passed.map(chip).join('')}</div>`
    : '<div class="pile-empty">empty</div>';
  $('#trashedCount').textContent = p.trashed.length;
  $('#trashedList').innerHTML = p.trashed.length
    ? `<div class="pile-row lost">${p.trashed.map(chip).join('')}</div>`
    : '<div class="pile-empty">empty</div>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

// ---------- wire controls ----------
// Auto-advance turns until the currently-selected tech completes (one undo step).
function finishTech() {
  if (!engine.currentResearch) return;
  act(() => {
    const target = engine.currentResearch;
    let guard = 0;
    while (engine.currentResearch === target && engine.canEndTurn() && guard++ < 2000) engine.nextTurn();
    return true;
  });
}
$('#finishBtn').addEventListener('click', finishTech);
$('#nextBtn').addEventListener('click', () => act(() => engine.nextTurn()));
$('#redrawBtn').addEventListener('click', () => act(() => engine.redraw()));
$('#oracleBtn').addEventListener('click', () => act(() => engine.buildOracle()));
$('#scholarToggle').addEventListener('change', (e) => act(() => engine.setScholar(e.target.checked)));
$('#undoBtn').addEventListener('click', undo);
$('#redoBtn').addEventListener('click', redo);
$('#restartBtn').addEventListener('click', restart);
$('#restartBtn2').addEventListener('click', restart);

// keyboard: space/enter = next turn, r = redraw, cmd/ctrl+Z = undo, +shift = redo
document.addEventListener('keydown', (e) => {
  if (!engine || $('#game').hidden) return;
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault(); e.shiftKey ? redo() : undo();
  } else if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault(); if (engine.canEndTurn()) finishTech();   // research current tech to completion
  } else if (e.key === 'n' && engine.canEndTurn()) {
    act(() => engine.nextTurn());                                // single turn
  } else if (e.key === 'r' && engine.view().canRedraw) {
    act(() => engine.redraw());
  }
});

// ---------- Plan & Optimize modal ----------
const techName = (id) => (engine?.get(id)?.name) || (TD.techs.find((t) => t.id === id) || TD.bonusTechs.find((b) => b.id === id) || {}).name || id;
const techCost = (id) => (TD.techs.find((t) => t.id === id) || TD.bonusTechs.find((b) => b.id === id) || {}).cost ?? 0;
const isBonusId = (id) => TD.bonusTechs.some((b) => b.id === id);

function planNation(parsed) {
  return parsed.nation || (engine && engine.nation) || NATIONS[0];
}
function planConfig() {
  const oracle = parseInt($('#planOracle').value, 10);
  return {
    scholar: $('#planScholar').checked,
    strict: $('#planStrict').checked,
    bonusPolicy: $('#planBonus').value,
    oracleTurn: Number.isFinite(oracle) && oracle > 0 ? oracle : null,
    maxTurns: 400,
  };
}
function planSeeds() {
  const n = Math.max(20, Math.min(1000, parseInt($('#planRuns').value, 10) || 160));
  return Array.from({ length: n }, (_, i) => i + 1);
}

function openPlan() {
  // prefill from current game
  if (engine) {
    $('#planScholar').checked = engine.scholar;
    if (engine.oracleBuiltTurn != null) $('#planOracle').value = engine.oracleBuiltTurn;
  }
  $('#planModal').hidden = false;
  $('#planInput').focus();
}
function closePlan() { $('#planModal').hidden = true; }

function withCompute(fn) {
  $('#planStatus').textContent = 'computing…';
  $('#planSimBtn').disabled = $('#planOptBtn').disabled = true;
  setTimeout(() => {
    try { fn(); }
    catch (e) { $('#planResults').innerHTML = `<div class="plan-err">${escapeHtml(e.message)}</div>`; }
    finally { $('#planStatus').textContent = ''; $('#planSimBtn').disabled = $('#planOptBtn').disabled = false; }
  }, 30);
}

function getPlanTargets() {
  const parsed = parseOwttPlan($('#planInput').value, TD, NATIONS);
  const nation = planNation(parsed);
  $('#planNationNote').textContent = `Nation: ${nationName(nation)}${parsed.nation ? ' (from plan)' : ' (current)'}`;
  if (!parsed.order.length) throw new Error('No techs parsed — paste an owtt URL, a ?o= list, or tech ids.');
  return { targets: parsed.order, nation };
}

function pillRow(ids) {
  return `<div class="seq">${ids.map((id, i) =>
    `<span class="seq-item${isBonusId(id) ? ' seq-bonus' : ''}"><b>${i + 1}</b>${isBonusId(id) ? '★' : ''}${escapeHtml(techName(id))}<i>${techCost(id)}</i></span>`
  ).join('')}</div>`;
}

function statsBlock(s) {
  const c = s.completion;
  const rangeTxt = c.median != null ? `${c.median} turns <span class="rng">(p10 ${c.p10} – p90 ${c.p90})</span>` : '—';
  const optional = s.bonusPolicy === 'optional';
  // second cell: bonus-cards-kept (optional mode w/ bonuses) else success rate
  const secondCell = (optional && s.bonusWanted)
    ? `<div><span class="sg-num">${s.bonusKept.mean.toFixed(1)} / ${s.bonusWanted}</span><span class="sg-lbl">Bonus cards kept (avg)</span></div>`
    : `<div><span class="sg-num">${(s.successRate * 100).toFixed(0)}%</span><span class="sg-lbl">Success rate</span></div>`;
  const warn = (!optional && s.lostBonusRate > 0.005)
    ? `<div class="plan-warn">⚠ Loses a required bonus card in ${(s.lostBonusRate * 100).toFixed(0)}% of runs (two on-plan bonuses can share a hand — one is trashed). Set Bonuses to “take when convenient” if that's acceptable.</div>` : '';
  const perRows = Object.entries(s.perTarget).map(([id, p]) =>
    `<tr><td class="pt-name">${isBonusId(id) ? '★' : ''}${escapeHtml(techName(id))}</td><td>${p.median ?? '—'}</td><td class="pt-rng">${p.p10 ?? '—'}–${p.p90 ?? '—'}</td></tr>`
  ).join('');
  return `
    <div class="stat-grid">
      <div><span class="sg-num">${rangeTxt}</span><span class="sg-lbl">Completion (median)</span></div>
      ${secondCell}
      <div><span class="sg-num">${s.wasted.median ?? 0}</span><span class="sg-lbl">Wasted science (median)</span></div>
      <div><span class="sg-num">${s.runs}</span><span class="sg-lbl">Runs</span></div>
    </div>
    ${warn}
    <table class="pt-table"><thead><tr><th>Tech</th><th>median turn</th><th>p10–p90</th></tr></thead><tbody>${perRows}</tbody></table>`;
}

function runSimulate() {
  withCompute(() => {
    const { targets, nation } = getPlanTargets();
    const s = simulatePlan({ TD, ND, nation, targets, config: planConfig(), seeds: planSeeds() });
    $('#planResults').innerHTML = `
      <h3>Simulation — your order</h3>
      <div class="seq-label">Priority (prereqs auto-inserted):</div>
      ${pillRow(s.order)}
      ${statsBlock(s)}`;
  });
}

function runOptimize() {
  withCompute(() => {
    const { targets, nation } = getPlanTargets();
    const config = planConfig();
    const seeds = planSeeds();
    const opt = optimizePlan({ TD, ND, nation, targets, config, seeds, maxIters: 250 });
    const before = simulatePlan({ TD, ND, nation, targets: opt.baseline.targets, config, seeds });
    const after = simulatePlan({ TD, ND, nation, targets: opt.best.targets, config, seeds });
    const saved = (before.completion.mean ?? 0) - (after.completion.mean ?? 0);
    const owtt = encodeOwttOrder(opt.best.order, TD, nation, NATIONS);
    $('#planResults').innerHTML = `
      <h3>Optimized order ${saved > 0.5 ? `<span class="saved">− ${saved.toFixed(1)} turns faster</span>` : '<span class="saved flat">≈ already near-optimal</span>'}</h3>
      <div class="seq-label">Recommended priority:</div>
      ${pillRow(opt.best.order)}
      ${statsBlock(after)}
      <div class="owtt-out"><span>Paste back into owtt:</span><code id="owttCode">${escapeHtml(owtt)}</code><button id="owttCopy" class="copy-btn">Copy</button></div>
      <details class="cmp"><summary>vs. your original order (${before.completion.mean?.toFixed(1)} turns mean)</summary>${pillRow(before.order)}${statsBlock(before)}</details>`;
    const copyBtn = $('#owttCopy');
    if (copyBtn) copyBtn.addEventListener('click', () => { navigator.clipboard?.writeText(owtt); copyBtn.textContent = 'Copied ✓'; });
  });
}

$('#planBtn').addEventListener('click', openPlan);
$('#planClose').addEventListener('click', closePlan);
$('#planModal').addEventListener('click', (e) => { if (e.target.id === 'planModal') closePlan(); });
$('#planSimBtn').addEventListener('click', runSimulate);
$('#planOptBtn').addEventListener('click', runOptimize);

buildPicker();
