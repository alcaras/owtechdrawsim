// node test_planner.mjs
import { readFileSync } from 'node:fs';
import { parseOwttPlan, expandPlan, simulatePlan, optimizePlan, autoPlay, _internal } from './planner.js';
import { makeScienceCurve } from './science.js';
import { DrawEngine } from './engine.js';

const win = {};
new Function('window', readFileSync(new URL('./tech-data.js', import.meta.url), 'utf8'))(win);
const TD = win.techData, ND = win.nationData, NL = win.nationLookup;

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.error('  ✗ ' + m)); };
const section = (n) => console.log('\n' + n);

const seeds = Array.from({ length: 120 }, (_, i) => i * 2654435761 % 2147483647 + 1);

section('parse owtt url / order encoding');
{
  // build a known plan: Ironworking (techs[0]) and the first bonus (-1)
  const url = `https://x/?n=10&o=0,5,-1`;
  const p = parseOwttPlan(url, TD, NL);
  ok(p.nation === NL[10], 'nation decoded from n=10');
  ok(p.order[0] === TD.techs[0].id, 'positive index -> techs[0]');
  ok(p.order[1] === TD.techs[5].id, 'positive index -> techs[5]');
  ok(p.order[2] === TD.bonusTechs[0].id, 'negative -1 -> bonusTechs[0]');
  // id-list form
  const p2 = parseOwttPlan('TECH_PHALANX, TECH_SPOKED_WHEEL', TD, NL);
  ok(p2.order.length === 2 && p2.order[0] === 'TECH_PHALANX', 'id-list parse works');
}

section('expandPlan inserts prereqs before dependents');
{
  const byId = _internal.buildIndex(TD);
  const starting = new Set(ND.startingTechs['NATION_ROME'] || []);
  // Phalanx needs Labor Force needs Ironworking
  const order = expandPlan(['TECH_PHALANX'], byId, starting);
  const iIron = order.indexOf('TECH_IRONWORKING');
  const iLabor = order.indexOf('TECH_LABOR_FORCE');
  const iPhal = order.indexOf('TECH_PHALANX');
  ok(iPhal === order.length - 1, 'target placed last');
  ok(iLabor >= 0 && iLabor < iPhal, 'Labor Force inserted before Phalanx');
  // Ironworking: prereq of Labor Force; Rome may start with it
  if (!starting.has('TECH_IRONWORKING')) ok(iIron >= 0 && iIron < iLabor, 'Ironworking before Labor Force');
  else ok(iIron === -1, 'starting tech (Ironworking) not added to plan');
  // starting techs excluded
  for (const s of starting) ok(!order.includes(s), `starting ${s} excluded`);
}

section('simulatePlan: a reachable plan completes, timing is sane');
{
  const targets = ['TECH_PHALANX', 'TECH_SPOKED_WHEEL', 'TECH_DRAMA'];
  const config = { scholar: false, oracleTurn: null, maxTurns: 400 };
  const r = simulatePlan({ TD, ND, nation: 'NATION_ROME', targets, config, seeds });
  ok(r.successRate > 0.95, `plan completes almost always (rate ${r.successRate.toFixed(2)})`);
  ok(r.completion.median > 0 && r.completion.median < 120, `median completion turn sane (${r.completion.median})`);
  ok(r.perTarget['TECH_PHALANX'].median != null, 'per-target timing reported');
  ok(r.completion.p90 >= r.completion.p10, 'p90 >= p10');
}

section('Scholar digs faster (banks science) than no-Scholar for a deep single target');
{
  const targets = ['TECH_STEEL']; // needs Ironworking + Military Drill (Trapping)
  const base = { oracleTurn: null, maxTurns: 400 };
  const noS = simulatePlan({ TD, ND, nation: 'NATION_ROME', targets, config: { ...base, scholar: false }, seeds });
  const yesS = simulatePlan({ TD, ND, nation: 'NATION_ROME', targets, config: { ...base, scholar: true }, seeds });
  ok(yesS.completion.median <= noS.completion.median, `Scholar median <= no-Scholar (${yesS.completion.median} <= ${noS.completion.median})`);
  ok(yesS.wasted.mean <= noS.wasted.mean + 1e-9, `Scholar wastes <= no-Scholar science (${yesS.wasted.mean?.toFixed(0)} <= ${noS.wasted.mean?.toFixed(0)})`);
}

section('Oracle (built turn 1) never hurts completion time');
{
  const targets = ['TECH_PHALANX', 'TECH_STEEL', 'TECH_COINAGE'];
  const noO = simulatePlan({ TD, ND, nation: 'NATION_ROME', targets, config: { scholar: true, oracleTurn: null, maxTurns: 400 }, seeds });
  const yesO = simulatePlan({ TD, ND, nation: 'NATION_ROME', targets, config: { scholar: true, oracleTurn: 1, maxTurns: 400 }, seeds });
  ok(yesO.completion.median <= noO.completion.median, `Oracle median <= no-Oracle (${yesO.completion.median} <= ${noO.completion.median})`);
}

section('optimizer improves (or matches) a deliberately bad order');
{
  // give targets in a wasteful order; optimizer should not be worse than baseline
  const targets = ['TECH_COINAGE', 'TECH_PHALANX', 'TECH_DRAMA', 'TECH_SPOKED_WHEEL', 'TECH_STEEL'];
  const config = { scholar: false, oracleTurn: null, maxTurns: 400 };
  const opt = optimizePlan({ TD, ND, nation: 'NATION_ROME', targets, config, seeds, maxIters: 200 });
  ok(opt.best.mean <= opt.baseline.mean + 1e-6, `optimized mean <= baseline (${opt.best.mean.toFixed(1)} <= ${opt.baseline.mean.toFixed(1)})`);
  ok(opt.best.order.length >= targets.length, 'optimized order includes the closure');
  console.log(`    baseline ${opt.baseline.mean.toFixed(1)} → optimized ${opt.best.mean.toFixed(1)} turns (saved ${opt.improvedTurns.toFixed(1)})`);
}

section('determinism: same seeds -> identical stats');
{
  const targets = ['TECH_PHALANX', 'TECH_DRAMA'];
  const config = { scholar: true, oracleTurn: 5, maxTurns: 400 };
  const a = simulatePlan({ TD, ND, nation: 'NATION_GREECE', targets, config, seeds });
  const b = simulatePlan({ TD, ND, nation: 'NATION_GREECE', targets, config, seeds });
  ok(a.completion.median === b.completion.median && a.completion.mean === b.completion.mean, 'identical stats for identical seeds');
}

section('on-plan bonus is captured or reported lost (not silently ignored)');
{
  // include a bonus card in the plan; success+lostBonus should account for all runs
  const bonus = TD.bonusTechs.find((b) => b.parent === 'TECH_SPOKED_WHEEL') || TD.bonusTechs[7];
  const targets = ['TECH_SPOKED_WHEEL', bonus.id];
  const r = simulatePlan({ TD, ND, nation: 'NATION_ROME', targets, config: { scholar: true, oracleTurn: null, maxTurns: 400 }, seeds });
  ok(r.successRate + r.lostBonusRate >= 0.99, `every run either completes or loses the bonus (succ ${r.successRate.toFixed(2)} + lost ${r.lostBonusRate.toFixed(2)})`);
}

section('strict mode researches in exact priority order; flexible is no slower');
{
  const targets = ['TECH_DRAMA', 'TECH_PHALANX', 'TECH_SPOKED_WHEEL', 'TECH_STEEL'];
  const byId = _internal.buildIndex(TD);
  const order = expandPlan(targets, byId, new Set(ND.startingTechs['NATION_ROME']));
  const curve = makeScienceCurve('NATION_ROME');
  // strict (with Scholar, so digging never forces off-order research): along the
  // expanded order, acquisition turns are non-decreasing every run
  let monotonic = true;
  for (const s of seeds.slice(0, 40)) {
    const eng = new DrawEngine({ techs: TD.techs, bonusTechs: TD.bonusTechs, scienceCurve: curve });
    eng.start({ nation: 'NATION_ROME', startingTechs: ND.startingTechs['NATION_ROME'], seed: s, scholar: true });
    const r = autoPlay(eng, order, { scholar: true, oracleTurn: null, maxTurns: 400, strict: true });
    for (let i = 1; i < order.length; i++) {
      if ((r.acquiredTurn[order[i]] ?? 0) < (r.acquiredTurn[order[i - 1]] ?? 0)) { monotonic = false; break; }
    }
  }
  ok(monotonic, 'strict: techs acquired in exact order every run');

  const flex = simulatePlan({ TD, ND, nation: 'NATION_ROME', targets, config: { scholar: false, oracleTurn: null, maxTurns: 400, strict: false }, seeds });
  const strict = simulatePlan({ TD, ND, nation: 'NATION_ROME', targets, config: { scholar: false, oracleTurn: null, maxTurns: 400, strict: true }, seeds });
  ok(flex.completion.mean <= strict.completion.mean + 1e-6, `flexible mean <= strict mean (${flex.completion.mean.toFixed(1)} <= ${strict.completion.mean.toFixed(1)})`);
  console.log(`    flexible ${flex.completion.mean.toFixed(1)} vs strict ${strict.completion.mean.toFixed(1)} turns`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
