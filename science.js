// Real science-per-turn curves from owglick (per-ankh.app winning-game data,
// Glicko-weighted), sampled at turns 5,10,…,60. Values are science/turn (rate).
// Source: owglick out/benchmarks.json -> curves.nations[*].series.SCIENCE.
//
// Only 8 nations have enough samples; the rest fall back to ALL.
export const scienceCurves = {
  ALL:       [[5,17.6],[10,20.5],[15,23.1],[20,27.6],[25,32.4],[30,38.5],[35,45.2],[40,52.1],[45,57.6],[50,63.9],[55,73.0],[60,83.8]],
  BABYLONIA: [[5,17.2],[10,20.6],[15,23.4],[20,30.0],[25,38.5],[30,46.9],[35,55.4],[40,68.1],[45,76.0],[50,83.5],[55,83.3],[60,91.7]],
  TAMIL:     [[5,15.6],[10,17.7],[15,21.0],[20,24.7],[25,28.7],[30,32.6],[35,36.8],[40,42.5],[45,46.4],[50,51.3],[55,59.3],[60,67.9]],
  YUEZHI:    [[5,18.7],[10,20.6],[15,22.9],[20,25.5],[25,29.8],[30,37.8],[35,49.6],[40,50.4],[45,56.7],[50,62.9],[55,78.3],[60,88.6]],
  PERSIA:    [[5,17.4],[10,19.1],[15,22.1],[20,25.8],[25,29.9],[30,34.2],[35,38.1],[40,44.2],[45,50.7],[50,56.7],[55,65.0],[60,76.6]],
  HITTITE:   [[5,18.7],[10,21.8],[15,24.2],[20,27.3],[25,32.0],[30,35.1],[35,42.8],[40,46.6],[45,59.4],[50,65.2],[55,83.3],[60,85.2]],
  ASSYRIA:   [[5,15.9],[10,19.8],[15,21.7],[20,26.2],[25,29.7],[30,34.1],[35,36.8],[40,45.5],[45,50.2],[50,59.0],[55,62.3],[60,68.0]],
  AKSUM:     [[5,19.0],[10,21.7],[15,23.1],[20,27.6],[25,29.4],[30,33.5],[35,38.4],[40,47.6],[45,47.1],[50,43.4],[55,54.1],[60,62.9]],
};

import { scienceTechs, scienceWeights, scienceProvenance, avgHas } from './science-model.js';

// Map an owtt nation id (NATION_ROME) to an owglick key; fall back to ALL.
export function curveKeyFor(nationId) {
  if (!nationId) return 'ALL';
  const k = nationId.replace(/^NATION_/, '');
  return scienceCurves[k] ? k : 'ALL';
}

// Build science(turn) -> rounded science/turn for a nation, with linear
// interpolation between samples and linear extrapolation outside [5,60].
export function makeScienceCurve(nationId) {
  const pts = scienceCurves[curveKeyFor(nationId)];
  return (turn) => Math.max(1, Math.round(rateAt(pts, turn)));
}

// Endogenous science model: the per-nation baseline plus contributions from the
// science-moving techs the player has actually researched, centered on the average
// possession so an average path reproduces the baseline curve. See gen_science_model.py.
export function makeScienceModel(nationId) {
  const pts = scienceCurves[curveKeyFor(nationId)];
  return (turn, engine) => Math.max(1, Math.round(rateAt(pts, turn) + techBonus(turn, engine)));
}

// Build/specialist ramp delay (turns) before a science tech's income comes online.
// Applied ONLY to mechanic-estimated weights — the data-derived weights (Divination,
// Monasticism) already include realized build/specialist/city effects empirically, so
// adding a delay there would double-count the lag.
const SCIENCE_DELAY = {
  TECH_SCHOLARSHIP: 12, // libraries + Philosopher/Scribe specialists
  TECH_HYDRAULICS: 8,   // watermill
  TECH_WINDLASS: 8,     // windmill
  TECH_METAPHYSICS: 5,  // Archive project
  TECH_ARCHITECTURE: 2, // Philosophy law (near-instant)
};
function delayOf(t) { return scienceProvenance[t] === 'mechanic' ? (SCIENCE_DELAY[t] ?? 6) : 0; }
export function scienceBuildDelay(t) { return delayOf(t); }

// One science tech's current contribution to science/turn. A mechanic tech's income
// only switches on `delay` turns after it's researched (build time); both the player's
// possession and the average baseline are shifted by the delay to stay consistent.
function techContribution(t, turn, engine) {
  const acquired = engine && engine.state && engine.state.get(t) === 'acquired';
  const delay = delayOf(t);
  let has = acquired ? 1 : 0;
  let center = clampInterp(avgHas[t], turn);
  if (acquired && delay > 0 && engine.acqTurnMap && engine.acqTurnMap.get(t) != null) {
    const at = engine.acqTurnMap.get(t);
    has = Math.max(0, Math.min(1, (turn - at) / delay)); // linear ramp as you build it up
    center = clampInterp(avgHas[t], turn - delay / 2);   // shift baseline by the ramp midpoint
  }
  return (scienceWeights[t] || 0) * (has - center);
}

function techBonus(turn, engine) {
  if (!engine || !engine.state) return 0;
  let b = 0;
  for (const t of scienceTechs) b += techContribution(t, turn, engine);
  return b;
}

// Breakdown for the UI: baseline, per-tech contributions you currently have, total.
export function scienceBreakdown(nationId, turn, engine) {
  const pts = scienceCurves[curveKeyFor(nationId)];
  const base = rateAt(pts, turn);
  const contribs = [];
  for (const t of scienceTechs) {
    const has = engine && engine.state && engine.state.get(t) === 'acquired';
    if (!has) continue;
    const at = engine.acqTurnMap && engine.acqTurnMap.get(t);
    const building = delayOf(t) > 0 && at != null && turn < at + delayOf(t);
    contribs.push({ id: t, amount: techContribution(t, turn, engine), src: scienceProvenance[t], building });
  }
  const total = Math.max(1, Math.round(rateAt(pts, turn) + techBonus(turn, engine)));
  return { base: Math.round(base), total, bonus: total - Math.round(base), contribs };
}

// Linear interpolation for [[turn,val]] points with flat (clamped) extrapolation.
function clampInterp(pts, turn) {
  if (!pts || !pts.length) return 0;
  if (turn <= pts[0][0]) return pts[0][1];
  if (turn >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    if (turn <= pts[i][0]) {
      const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
      return v0 + ((v1 - v0) / (t1 - t0)) * (turn - t0);
    }
  }
  return pts[pts.length - 1][1];
}

// owglick's earliest sample is turn 5; before that, per-nation differences aren't
// data-supported (every nation has ~one city at turn 1). So anchor all nations to a
// shared turn-1 value (the all-nations extrapolation) and let them diverge toward
// their real turn-5 figure — avoids a fake spread in starting science.
const ALL_T1 = (() => {
  const [t0, v0] = scienceCurves.ALL[0], [t1, v1] = scienceCurves.ALL[1];
  return v0 + ((v1 - v0) / (t1 - t0)) * (1 - t0);
})();

function rateAt(pts, turn) {
  const first = pts[0], last = pts[pts.length - 1];
  if (turn <= first[0]) {
    if (turn <= 1) return ALL_T1;
    const [t1s, v1s] = pts[0]; // interpolate shared turn-1 anchor -> nation's turn-5
    return ALL_T1 + ((v1s - ALL_T1) / (t1s - 1)) * (turn - 1);
  }
  if (turn >= last[0]) {
    const [t0, v0] = pts[pts.length - 2], [t1, v1] = pts[pts.length - 1];
    return v1 + ((v1 - v0) / (t1 - t0)) * (turn - t1); // extrapolate up
  }
  for (let i = 1; i < pts.length; i++) {
    if (turn <= pts[i][0]) {
      const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
      return v0 + ((v1 - v0) / (t1 - t0)) * (turn - t0);
    }
  }
  return last[1];
}
