// UI for the Old World tech-draw simulator. Wires the faithful DrawEngine to a
// game-like screen: a hand of cards you pick from, a Next-turn science tick, the
// Scholar redraw, a buildable Oracle, and a turn-by-turn history.
import { DrawEngine } from './engine.js';
import { makeScienceCurve } from './science.js';

const TD = window.techData;
const ND = window.nationData;
const NATIONS = window.nationLookup;

// ---------- icon paths (match owtt conventions) ----------
const SCI_ICON = 'img/icons/yields/science.png';
const techIcon = (id) => `img/icons/techs/${id.replace(/^TECH_/, '').toLowerCase()}.png`;
const bonusIcon = (iconName) => iconName ? `img/icons/bonus/${iconName.toLowerCase()}.png` : SCI_ICON;
const crestIcon = (slug) => `img/crests/${slug}.png`;
const nationName = (id) => (ND.nationNames.find((n) => n.id === id) || {}).name || id.replace('NATION_', '');
const nationColor = (id) => ND.colors[id] || { bg: '#caa45a', accent: '#caa45a', crest: '' };

const $ = (sel) => document.querySelector(sel);

let engine = null;

// ---------- nation picker ----------
function buildPicker() {
  const grid = $('#nationGrid');
  grid.innerHTML = '';
  for (const id of NATIONS) {
    const c = nationColor(id);
    const btn = document.createElement('button');
    btn.className = 'nation-card';
    btn.style.setProperty('--accent', c.accent);
    btn.innerHTML = `
      <img class="nation-crest" src="${crestIcon(c.crest)}" alt="" onerror="this.style.visibility='hidden'" />
      <span class="nation-name">${nationName(id)}</span>`;
    btn.addEventListener('click', () => startGame(id));
    grid.appendChild(btn);
  }
}

function startGame(nationId) {
  const seed = parseInt($('#pickSeed').value, 10) || 1;
  const scholar = $('#pickScholar').checked;
  engine = new DrawEngine({ techs: TD.techs, bonusTechs: TD.bonusTechs, scienceCurve: makeScienceCurve(nationId) });
  engine.start({
    nation: nationId,
    startingTechs: ND.startingTechs[nationId] || [],
    seed,
    scholar,
  });
  window.__engine = engine; // exposed for debugging / headless drivers
  $('#picker').hidden = true;
  $('#game').hidden = false;
  $('#scholarToggle').checked = scholar;
  applyTheme(nationId);
  render();
}

function applyTheme(nationId) {
  const c = nationColor(nationId);
  document.documentElement.style.setProperty('--nation-bg', c.bg);
  document.documentElement.style.setProperty('--nation-accent', c.accent);
}

function restart() {
  engine = null;
  $('#game').hidden = true;
  $('#picker').hidden = false;
}

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
      pills.push(`<span class="pill pill-${kind}">${escapeHtml(name)}</span>`);
    }
  }
  return pills.length ? `<div class="card-unlocks">${pills.join('')}</div>` : '';
}

function cardHTML(card) {
  if (card.isBonus) {
    return `
      <button class="card card-bonus${card.isCurrent ? ' is-current' : ''}" data-id="${card.id}">
        <div class="card-trash-tag">burns if passed</div>
        <div class="card-icon">
          <img src="${bonusIcon(card.iconName)}" alt="" onerror="this.style.display='none';this.parentElement.classList.add('icon-star')" />
        </div>
        <div class="card-name">${escapeHtml(card.name)}</div>
        <div class="card-bonus-text">${escapeHtml(card.bonus || 'One-time bonus')}</div>
        <div class="card-cost">${card.cost}<img src="${SCI_ICON}" alt="sci" /></div>
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
      <div class="card-cost">${card.cost}<img src="${SCI_ICON}" alt="sci" /></div>
      ${progressHTML(card)}
    </button>`;
}

function progressHTML(card) {
  if (!card.invested) return '<div class="card-prog"><i style="width:0%"></i></div>';
  const pct = Math.min(100, Math.round((card.invested / card.cost) * 100));
  return `<div class="card-prog"><i style="width:${pct}%"></i></div>`;
}

function render() {
  const v = engine.view();

  // topbar
  const c = nationColor(v.nation);
  $('#topCrest').src = crestIcon(c.crest);
  $('#topNation').textContent = nationName(v.nation);
  $('#statTurn').textContent = v.turn;
  $('#statSpt').textContent = '+' + v.sciencePerTurn;
  $('#statTotal').textContent = v.totalScience;
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
  if (v.currentResearch) {
    const card = v.hand.find((h) => h.id === v.currentResearch);
    const t = engine.get(v.currentResearch);
    const cost = t.cost, inv = card ? card.invested : engine.investedIn(v.currentResearch);
    const pct = Math.min(100, Math.round((inv / cost) * 100));
    rb.innerHTML = `
      <span class="research-name">${t.isBonus ? '★' : ''}${escapeHtml(t.name)}</span>
      <div class="research-bar"><i style="width:${pct}%"></i><b>${inv} / ${cost}</b></div>`;
  } else if (v.done) {
    rb.innerHTML = `<span class="research-empty">All available techs researched. 🎉</span>`;
  } else {
    rb.innerHTML = `<span class="research-empty">Pick a card below to begin${v.overflow ? ` (${v.overflow} science banked)` : ''}.</span>`;
  }

  // hand
  $('#hand').innerHTML = v.hand.map(cardHTML).join('') || '<div class="hand-empty">No cards to draw.</div>';
  $('#hand').querySelectorAll('.card').forEach((el) => {
    el.addEventListener('click', () => {
      engine.pickResearch(el.dataset.id);
      render();
    });
  });

  // actions
  $('#redrawBtn').disabled = !v.canRedraw;
  $('#nextBtn').disabled = v.done;

  // history (newest first)
  $('#history').innerHTML = v.log.slice().reverse().map((e) =>
    `<li class="ev ev-${e.type}"><span class="ev-turn">T${e.turn}</span><span class="ev-text">${escapeHtml(e.text)}</span></li>`
  ).join('');

  // acquired ledger
  $('#acqCount').textContent = v.acquired.length;
  $('#acquired').innerHTML = v.acquired.map((a) =>
    `<li><span class="acq-turn">T${a.turn}</span><span class="acq-name">${a.isBonus ? '★' : ''}${escapeHtml(a.name)}</span><span class="acq-sci">${a.science}<img src="${SCI_ICON}" alt="" /></span></li>`
  ).join('');

  // draw pile + discard
  const p = v.piles;
  const chip = (c) => `<span class="chip${c.isBonus ? ' chip-bonus' : ''}">${c.isBonus ? '★' : ''}${escapeHtml(c.name)}<b>${c.cost}</b></span>`;
  $('#drawCount').textContent = p.draw.length;
  $('#lockedCount').textContent = p.locked.length ? `+${p.locked.length} locked` : '';
  $('#drawList').innerHTML =
    (p.draw.length ? `<div class="pile-row">${p.draw.map(chip).join('')}</div>` : '<div class="pile-empty">empty</div>') +
    (p.locked.length ? `<div class="pile-divider">Locked by prereqs</div><div class="pile-row dim">${p.locked.map(chip).join('')}</div>` : '');
  $('#discardCount').textContent = p.passed.length + p.trashed.length;
  $('#discardList').innerHTML =
    (p.passed.length ? `<div class="pile-divider">Passed — reshuffles back</div><div class="pile-row">${p.passed.map(chip).join('')}</div>` : '') +
    (p.trashed.length ? `<div class="pile-divider lost">Trashed — gone for good</div><div class="pile-row lost">${p.trashed.map(chip).join('')}</div>` : '') +
    (!p.passed.length && !p.trashed.length ? '<div class="pile-empty">empty</div>' : '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

// ---------- wire controls ----------
$('#nextBtn').addEventListener('click', () => { engine.nextTurn(); render(); });
$('#redrawBtn').addEventListener('click', () => { engine.redraw(); render(); });
$('#oracleBtn').addEventListener('click', () => { engine.buildOracle(); render(); });
$('#scholarToggle').addEventListener('change', (e) => { engine.setScholar(e.target.checked); render(); });
$('#restartBtn').addEventListener('click', restart);
$('#restartBtn2').addEventListener('click', restart);

// keyboard: space / enter = next turn, r = redraw
document.addEventListener('keydown', (e) => {
  if (!engine || $('#game').hidden) return;
  if (e.code === 'Space' || e.code === 'Enter') {
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    e.preventDefault(); engine.nextTurn(); render();
  } else if (e.key === 'r' && engine.view().canRedraw) {
    engine.redraw(); render();
  }
});

buildPicker();
