// Node test harness for the faithful draw engine.
//   node test_engine.mjs
// Loads the generated tech-data.js via a window shim, then asserts the core
// Old World deck mechanics.

import { readFileSync } from 'node:fs';
import { DrawEngine, MAX_TECHS_AVAILABLE } from './engine.js';

// --- load tech-data.js (it assigns window.*) ---
const win = {};
const src = readFileSync(new URL('./tech-data.js', import.meta.url), 'utf8');
new Function('window', src)(win);
const TD = win.techData;
const ND = win.nationData;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); }
}
function section(name) { console.log('\n' + name); }

const mk = (over = {}) => {
  const e = new DrawEngine({ techs: TD.techs, bonusTechs: TD.bonusTechs });
  e.start({ nation: 'NATION_ROME', startingTechs: ND.startingTechs['NATION_ROME'] || [], seed: 42, ...over });
  return e;
};

section('hand size');
{
  const e = mk();
  ok(e.handSize() === MAX_TECHS_AVAILABLE, 'base hand size is 4');
  ok(e.hand.length <= 4 && e.hand.length > 0, 'initial hand has up to 4 cards');
  e.buildOracle();
  ok(e.handSize() === 5, 'hand size is 5 after Oracle built');
}

section('oracle sticks and is turn-stamped');
{
  const e = mk();
  // advance a few turns then build
  e.pickResearch(e.hand[0]);
  e.nextTurn(); e.nextTurn();
  const builtAt = e.turn;
  e.buildOracle();
  ok(e.oracleBuiltTurn === builtAt, 'oracle build turn recorded');
  ok(e.oracleActive(), 'oracle active on/after build turn');
  for (let i = 0; i < 5; i++) e.nextTurn();
  ok(e.oracleActive(), 'oracle still active many turns later (sticks)');
  ok(e.buildOracle() === false, 'cannot build oracle twice');
}

section('min 2 non-trashable cards guaranteed');
{
  // Across many seeds/draws, every dealt hand must contain >= 2 non-bonus cards
  // whenever at least 2 non-bonus techs are eligible.
  let violations = 0, hands = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const e = mk({ seed });
    for (let step = 0; step < 25; step++) {
      const nonBonus = e.hand.filter((id) => !e.isBonus(id)).length;
      // count eligible non-bonus currently drawable + already in hand
      if (e.hand.length >= 2) { hands++; if (nonBonus < 2) violations++; }
      const pick = e.hand.find((id) => !e.isBonus(id)) || e.hand[0];
      if (!pick) break;
      e.pickResearch(pick);
      let guard = 0;
      while (e.currentResearch && guard++ < 200) e.nextTurn();
      if (e.isDone()) break;
    }
  }
  ok(hands > 100, `sampled many hands (${hands})`);
  ok(violations === 0, `every full hand had >=2 non-bonus cards (violations: ${violations})`);
}

section('bonus cards are trashed (never reappear) when discarded');
{
  const e = mk({ seed: 7 });
  const seenTrashed = new Set();
  for (let step = 0; step < 40; step++) {
    // always pick a non-bonus so any bonus in hand gets discarded -> trashed
    const pick = e.hand.find((id) => !e.isBonus(id));
    if (!pick) { // only bonus in hand; take it
      if (e.hand[0]) { e.pickResearch(e.hand[0]); }
    } else {
      for (const id of e.hand) if (e.isBonus(id)) seenTrashed.add(id);
      e.pickResearch(pick);
    }
    let guard = 0;
    while (e.currentResearch && guard++ < 300) e.nextTurn();
    if (e.isDone()) break;
  }
  // none of the trashed bonus ids should ever be in a later hand or re-eligible
  let reappeared = 0;
  for (const id of seenTrashed) {
    if (e.state.get(id) === 'available' || e.state.get(id) === 'deck') reappeared++;
  }
  ok(seenTrashed.size > 0, `some bonus cards were discarded (${seenTrashed.size})`);
  ok(reappeared === 0, 'trashed bonus cards never returned to deck/hand');
}

section('scholar redraw: once per turn, only when enabled');
{
  const off = mk({ scholar: false });
  ok(off.canRedraw() === false, 'no redraw when scholar off');
  ok(off.redraw() === false, 'redraw() rejected when scholar off');

  const on = mk({ scholar: true, seed: 3 });
  const before = on.hand.slice();
  ok(on.canRedraw() === true, 'can redraw with scholar on');
  ok(on.redraw() === true, 'redraw succeeds');
  ok(on.canRedraw() === false, 'cannot redraw twice in one turn');
  // discarded cards excluded from the fresh hand
  const overlap = on.hand.filter((id) => before.includes(id));
  ok(overlap.length === 0, 'redrawn hand excludes just-discarded cards');
  on.pickResearch(on.hand[0]);
  on.nextTurn();
  ok(on.canRedraw() === true, 'redraw available again next turn');
}

section('completion deals a fresh hand and acquires the tech');
{
  const e = mk({ seed: 9 });
  const first = e.hand[0];
  e.pickResearch(first);
  let guard = 0;
  while (e.state.get(first) !== 'acquired' && guard++ < 500) e.nextTurn();
  ok(e.state.get(first) === 'acquired', 'picked tech eventually acquired');
  ok(e.acquiredOrder.some((a) => a.id === first), 'acquired list records it');
  ok(!e.hand.includes(first), 'acquired tech no longer in hand');
  ok(e.hand.length > 0 || e.isDone(), 'fresh hand dealt after completion');
}

section('determinism: same seed -> same draws');
{
  const a = mk({ seed: 123 });
  const b = mk({ seed: 123 });
  ok(JSON.stringify(a.hand) === JSON.stringify(b.hand), 'identical initial hands for same seed');
  const c = mk({ seed: 124 });
  // very likely different; not a hard guarantee but practically certain
  ok(JSON.stringify(a.hand) !== JSON.stringify(c.hand), 'different seed -> different hand (practically)');
}

section('prereqs gate availability');
{
  const e = mk({ seed: 5 });
  // A tech with prereqs not yet met must not appear in the opening hand.
  const gated = TD.techs.find((t) => (t.prereqs || []).length > 0);
  const acquiredStart = new Set(ND.startingTechs['NATION_ROME'] || []);
  const reachable = (gated.prereqs || []).every((p) => acquiredStart.has(p));
  if (!reachable) ok(!e.hand.includes(gated.id), `${gated.id} gated out of opening hand`);
  else ok(true, 'skipped (gated tech happened to be reachable)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
