// Plan simulation + order optimization on top of the faithful DrawEngine.
//
// A "tech order" can't be followed literally — you only research what's in your
// hand. So an order is a PRIORITY: on each decision point the auto-player takes the
// highest-priority wanted card present (bonus before main, since bonuses burn); when
// nothing wanted is in hand it DIGS — redraw with Scholar (banks science, ~free), or
// research the cheapest card to cycle to a new hand without Scholar.
//
// Because draws are random, everything is Monte-Carlo. The optimizer scores every
// candidate order on the SAME seed set (Common Random Numbers) so differences are
// real, not luck, then hill-climbs from a few smart seed orders.

import { DrawEngine } from './engine.js';
import { makeScienceCurve } from './science.js';

// ---------- parse an owtt plan (URL / query / index list / id list) ----------
export function parseOwttPlan(input, TD, NL) {
  const out = { nation: null, order: [] };
  if (!input) return out;
  let s = String(input).trim();

  // pull n= / o= from a URL or query string
  let query = null;
  if (s.includes('?')) query = s.slice(s.indexOf('?') + 1);
  else if (/(^|&)o=/.test(s) || /(^|&)n=/.test(s)) query = s;

  if (query) {
    const sp = new URLSearchParams(query);
    if (sp.has('n')) { const ni = parseInt(sp.get('n'), 10); if (NL[ni]) out.nation = NL[ni]; }
    if (sp.has('o')) out.order = decodeOrder(sp.get('o'), TD);
    return out;
  }

  // raw comma list: integers => owtt indices; otherwise treat as tech ids
  if (/^-?\d+(\s*,\s*-?\d+)*$/.test(s)) { out.order = decodeOrder(s, TD); return out; }
  out.order = s.split(/[,\s]+/).map((x) => x.trim()).filter((id) => TD.techs.some((t) => t.id === id) || TD.bonusTechs.some((b) => b.id === id));
  return out;
}

// Encode an ordered id list back into owtt's ?o= form (and ?n= for the nation).
export function encodeOwttOrder(ids, TD, nation, NL) {
  const nums = ids.map((id) => {
    const mi = TD.techs.findIndex((t) => t.id === id);
    if (mi > -1) return mi;
    const bi = TD.bonusTechs.findIndex((b) => b.id === id);
    return bi > -1 ? -(bi + 1) : null;
  }).filter((n) => n !== null);
  const ni = nation && NL ? NL.indexOf(nation) : -1;
  return (ni > -1 ? `n=${ni}&` : '') + 'o=' + nums.join(',');
}

// owtt order encoding: positive index -> techData.techs[n]; negative -> bonusTechs[-n-1].
function decodeOrder(o, TD) {
  const ids = [];
  o.split(',').map((n) => parseInt(n, 10)).filter((n) => !isNaN(n)).forEach((n) => {
    if (n >= 0 && TD.techs[n]) ids.push(TD.techs[n].id);
    else if (n < 0 && TD.bonusTechs[-n - 1]) ids.push(TD.bonusTechs[-n - 1].id);
  });
  return ids;
}

// ---------- prereq closure / ordering ----------
function buildIndex(TD) {
  const byId = new Map();
  for (const t of TD.techs) byId.set(t.id, { ...t, isBonus: false });
  for (const b of TD.bonusTechs) byId.set(b.id, { ...b, isBonus: true });
  return byId;
}
function prereqsOf(byId, id) {
  const t = byId.get(id);
  if (!t) return [];
  return t.isBonus ? (t.parent ? [t.parent] : []) : (t.prereqs || []);
}

// Expand explicit targets into a valid ordered closure: each tech's missing prereqs
// are inserted before it, cheapest-first (mirrors owtt's plan expansion).
export function expandPlan(targets, byId, startingSet) {
  const placed = new Set(startingSet);
  const order = [];
  const place = (id) => {
    if (placed.has(id) || !byId.has(id)) return;
    const need = prereqsOf(byId, id).filter((p) => !placed.has(p))
      .sort((a, b) => (byId.get(a)?.cost || 0) - (byId.get(b)?.cost || 0));
    for (const p of need) place(p);
    placed.add(id);
    order.push(id);
  };
  for (const id of targets) place(id);
  return order;
}

// ---------- auto-player ----------
function bestWanted(eng, rank) {
  let best = null, bk = null;
  for (const id of eng.hand) {
    if (!rank.has(id)) continue;
    const key = [eng.isBonus(id) ? 0 : 1, rank.get(id)]; // bonus first, then priority
    if (best == null || key[0] < bk[0] || (key[0] === bk[0] && key[1] < bk[1])) { best = id; bk = key; }
  }
  return best;
}
function cheapestCycle(eng) {
  let pool = eng.hand.filter((id) => !eng.isBonus(id));
  if (!pool.length) pool = eng.hand.slice();
  if (!pool.length) return null;
  return pool.reduce((a, b) => (eng.cost(b) < eng.cost(a) ? b : a));
}
// Strict mode: the next thing to research is the first not-yet-acquired item in order.
function strictNext(eng, order) {
  for (const id of order) if (eng.state.get(id) !== 'acquired') return id;
  return null;
}

// Decide what to research this turn (may redraw). Returns an id, or null to bank.
//   flexible (default): take the best wanted card present (bonus before main).
//   strict: research only the next-in-order item; redraw/dig past lower-priority
//           wanted cards — but still grab an on-plan bonus in hand so it isn't lost.
function chooseResearch(eng, order, rank, config) {
  const tryPick = () => {
    if (config.strict) {
      const next = strictNext(eng, order);
      if (next != null && eng.hand.includes(next)) return next;
      const wantedBonus = eng.hand.filter((id) => rank.has(id) && eng.isBonus(id));
      if (wantedBonus.length) return wantedBonus.reduce((a, b) => (rank.get(b) < rank.get(a) ? b : a));
      return null;
    }
    return bestWanted(eng, rank);
  };
  let pick = tryPick();
  if (pick == null && config.scholar && eng.canRedraw) { eng.redraw(); pick = tryPick(); }
  // You must always research something — never bank an empty turn. If nothing wanted
  // is in hand (even after a redraw), cycle on the cheapest card.
  if (pick == null) {
    if (config.strict) {
      // cycle on a non-plan card to preserve order; only take a plan card if forced
      const nonPlan = eng.hand.filter((id) => !rank.has(id));
      const src = nonPlan.length ? nonPlan : eng.hand;
      pick = src.length ? src.reduce((a, b) => (eng.cost(b) < eng.cost(a) ? b : a)) : null;
    } else {
      pick = cheapestCycle(eng);
    }
  }
  return pick;
}

// Drive one engine to plan completion (or failure). Returns timing + waste.
export function autoPlay(eng, order, config) {
  const rank = new Map(order.map((id, i) => [id, i]));
  const orderSet = new Set(order);
  const acquiredTurn = {};
  const maxTurns = config.maxTurns || 400;
  let lostBonus = false, guard = 0;
  const done = () => order.every((id) => eng.state.get(id) === 'acquired');

  while (!done() && guard++ < maxTurns) {
    if (config.oracleTurn && eng.turn === config.oracleTurn) eng.buildOracle();

    if (!eng.currentResearch) {
      const pick = chooseResearch(eng, order, rank, config);
      if (pick != null) eng.pickResearch(pick);
      // Scholar with nothing wanted: bank the turn (no pick) and redraw next turn.
    }
    eng.nextTurn();
    for (const a of eng.acquiredOrder) if (acquiredTurn[a.id] == null) acquiredTurn[a.id] = a.turn;

    // an on-plan bonus card got trashed -> plan can't complete
    for (const id of orderSet) if (eng.state.get(id) === 'trashed') { lostBonus = true; break; }
    if (lostBonus) break;
  }

  let wasted = 0;
  for (const a of eng.acquiredOrder) if (!orderSet.has(a.id)) wasted += eng.cost(a.id);
  const isDone = done();
  const completionTurn = isDone ? Math.max(...order.map((id) => acquiredTurn[id] || 0)) : null;
  return { acquiredTurn, completionTurn, lostBonus, wasted, totalScience: eng.totalScience, done: isDone };
}

function runOnce(TD, ND, nation, order, config, seed) {
  const eng = new DrawEngine({ techs: TD.techs, bonusTechs: TD.bonusTechs, scienceCurve: config.curve });
  eng.start({ nation, startingTechs: ND.startingTechs[nation] || [], seed, scholar: config.scholar });
  return autoPlay(eng, order, config);
}

// ---------- stats ----------
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

export function simulatePlan({ TD, ND, nation, targets, config, seeds }) {
  const byId = buildIndex(TD);
  const startingSet = new Set(ND.startingTechs[nation] || []);
  const order = expandPlan(targets, byId, startingSet);
  const curve = config.curve || makeScienceCurve(nation);
  const runs = seeds.map((s) => runOnce(TD, ND, nation, order, { ...config, curve }, s));

  const done = runs.filter((r) => r.done);
  const comp = done.map((r) => r.completionTurn);
  const perTarget = {};
  for (const id of targets) {
    const turns = done.map((r) => r.acquiredTurn[id]).filter((x) => x != null);
    perTarget[id] = { median: median(turns), p10: quantile(turns, 0.1), p90: quantile(turns, 0.9) };
  }
  return {
    order,
    runs: runs.length,
    successRate: done.length / runs.length,
    lostBonusRate: runs.filter((r) => r.lostBonus).length / runs.length,
    completion: { median: median(comp), mean: mean(comp), p10: quantile(comp, 0.1), p90: quantile(comp, 0.9) },
    wasted: { median: median(done.map((r) => r.wasted)), mean: mean(done.map((r) => r.wasted)) },
    perTarget,
  };
}

// ---------- optimizer (CRN + hill climb) ----------
function scoreOrder(TD, ND, nation, targets, config, seeds, byId, startingSet) {
  const order = expandPlan(targets, byId, startingSet);
  let sum = 0, fails = 0;
  const penalty = config.maxTurns || 400;
  for (const s of seeds) {
    const r = runOnce(TD, ND, nation, order, config, s);
    if (r.done) sum += r.completionTurn; else { sum += penalty; fails++; }
  }
  return { mean: sum / seeds.length, fails, order };
}

export function optimizePlan({ TD, ND, nation, targets, config, seeds, maxIters = 400 }) {
  const byId = buildIndex(TD);
  const startingSet = new Set(ND.startingTechs[nation] || []);
  const curve = config.curve || makeScienceCurve(nation);
  const cfg = { ...config, curve };
  const sc = (t) => scoreOrder(TD, ND, nation, t, cfg, seeds, byId, startingSet);

  // candidate seed orders: as given, cheapest-first, most-expensive-first
  const cost = (id) => byId.get(id)?.cost || 0;
  const cheapFirst = [...targets].sort((a, b) => cost(a) - cost(b));
  const dearFirst = [...targets].sort((a, b) => cost(b) - cost(a));
  const baseline = sc(targets);
  let best = baseline, bestTargets = targets.slice();
  for (const cand of [cheapFirst, dearFirst]) {
    const e = sc(cand);
    if (e.mean < best.mean - 1e-9) { best = e; bestTargets = cand.slice(); }
  }

  // hill climb: move one target to another position, accept improvements
  let iters = 0, improved = true;
  while (improved && iters < maxIters) {
    improved = false;
    for (let i = 0; i < bestTargets.length && iters < maxIters; i++) {
      for (let j = 0; j < bestTargets.length && iters < maxIters; j++) {
        if (i === j) continue;
        const cand = bestTargets.slice();
        const [x] = cand.splice(i, 1);
        cand.splice(j, 0, x);
        const e = sc(cand);
        iters++;
        if (e.mean < best.mean - 1e-9) { best = e; bestTargets = cand; improved = true; }
      }
    }
  }

  return {
    baseline: { targets, order: baseline.order, mean: baseline.mean, fails: baseline.fails },
    best: { targets: bestTargets, order: best.order, mean: best.mean, fails: best.fails },
    improvedTurns: baseline.mean - best.mean,
    iters,
  };
}

export const _internal = { buildIndex, expandPlan, bestWanted, cheapestCycle };
