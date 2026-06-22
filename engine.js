// Faithful Old World tech-draw engine.
//
// Mirrors the real game's deck logic from Player.cs:
//   - hand size = MAX_TECHS_AVAILABLE (4) + Oracle (+1)
//   - MIN_NON_TRASHABLE_TECHS_AVAILABLE = 2 guaranteed non-bonus cards
//   - uniform-random selection per slot (random 1..1000, highest wins == pick one at random)
//   - per-tech states: deck -> available -> {acquired | passed | trashed}
//       * non-bonus unpicked card  -> passed   (recoverable when the deck exhausts: clearTechsPassed)
//       * bonus / bTrash card      -> trashed  (gone forever)
//   - a fresh hand is dealt when a tech is ACQUIRED (doTechsAvailable), not every turn
//   - Scholar: redraw the current hand once per turn, excluding the just-discarded cards
//
// The engine is pure (no DOM); it takes the tech graph + an injected RNG so it is
// deterministic and unit-testable.

export const MAX_TECHS_AVAILABLE = 4;
export const MIN_NON_TRASHABLE = 2;

// Deterministic, seedable PRNG (mulberry32) so a seed reproduces a run exactly,
// the way Old World seeds draws per turn.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Default science curve: owglick baseline, ~turn + 7 science/turn.
export const defaultScienceCurve = (turn) => turn + 7;

export class DrawEngine {
  /**
   * @param {object} opts
   * @param {Array}  opts.techs       main techs   [{id,name,cost,prereqs,unlocks}]
   * @param {Array}  opts.bonusTechs  bonus cards  [{id,name,cost,parent,bonus,nation?,cultureRequired?,iconName}]
   * @param {function} [opts.scienceCurve]
   */
  constructor({ techs, bonusTechs, scienceCurve = defaultScienceCurve }) {
    this.techs = techs;
    this.bonusTechs = bonusTechs;
    this.scienceCurve = scienceCurve;
    this.byId = new Map();
    for (const t of techs) this.byId.set(t.id, { ...t, isBonus: false });
    for (const b of bonusTechs) this.byId.set(b.id, { ...b, isBonus: true, cost: b.cost });
  }

  get(id) { return this.byId.get(id); }
  isBonus(id) { return !!this.byId.get(id)?.isBonus; }
  cost(id) { return this.byId.get(id)?.cost ?? 0; }

  /**
   * Begin a fresh game.
   * @param {object} opts
   * @param {string|null} opts.nation
   * @param {string[]}    opts.startingTechs  ids pre-acquired for the nation
   * @param {number}      opts.seed
   * @param {boolean}     opts.scholar  whether the Scholar trait is active (toggle)
   */
  start({ nation = null, startingTechs = [], seed = 1, scholar = false, freeTechs = 0 } = {}) {
    this.nation = nation;
    this.seed = seed >>> 0;
    this._rngState = this.seed;       // serializable RNG state (for undo/redo)
    this.scholar = scholar;
    this.oracleBuiltTurn = null;     // null until built; then sticks forever
    this.turn = 1;
    this.totalScience = 0;
    this.overflow = 0;               // carried science after a completion
    this.redrawUsedThisTurn = false;
    this.currentResearch = null;
    this.invested = new Map();       // techId -> science poured in (persists across passes)
    this.acquiredOrder = [];         // [{id, turn, science}] in completion order
    this.log = [];

    // state machine
    this.state = new Map();          // id -> 'deck'|'available'|'passed'|'trashed'|'acquired'
    for (const id of this.byId.keys()) this.state.set(id, 'deck');
    // Starting techs are NOT acquired yet — the opening hand (initNation) draws from
    // roots first, THEN starting techs are acquired. Acquiring early would wrongly make
    // their children eligible during phase 1.
    const starts = new Set(startingTechs.filter((id) => this.state.has(id)));
    this._startingTechs = starts;

    this.hand = [];
    this._log('start', `Playing ${nation || 'no nation'} — seed ${this.seed}.`);
    if (starts.size) this._log('start', `Starting techs: ${[...starts].map((id) => this.get(id)?.name || id).join(', ')}.`);
    this.freeTechs = freeTechs;
    this._initHand();
    return this;
  }

  // The opening hand is special (Player.cs initNation): an over-fill of
  // (hand size + 1) drawn with NO reshuffle and NO min-non-trashable rule, then —
  // starting techs already being acquired — a top-up of (hand size - available - 1).
  // Starting techs are pre-acquired here, which is equivalent to the game drawing
  // then removing them. Net opening = every non-starting root tech, plus a few
  // children once 3+ of your starting techs were roots.
  _initHand() {
    const target = this.handSize();
    const draw = () => {
      const id = this._drawOne(new Set(), true); // no min-non-trashable on the opener
      if (id == null) return false;
      this.state.set(id, 'available');
      this.hand.push(id);
      return true;
    };
    let n1 = target - this.hand.length + 1;           // phase 1: over-fill by one (roots only)
    for (let i = 0; i < n1; i++) if (!draw()) break;
    // phase 2: acquire starting techs, removing them from the hand if they were drawn
    for (const id of this._startingTechs) {
      this.state.set(id, 'acquired');
      const i = this.hand.indexOf(id);
      if (i >= 0) this.hand.splice(i, 1);
    }
    // phase 3 (free techs) omitted unless configured; phase 4 top-up (children now eligible):
    let n4 = target - this.hand.length - 1;
    for (let i = 0; i < n4; i++) if (!draw()) break;
    this._log('draw', this.hand.length
      ? `Opening hand: ${this.hand.map((id) => this._label(id)).join(', ')}.`
      : 'No techs to draw.');
  }

  // ---- derived ----
  oracleActive() { return this.oracleBuiltTurn != null && this.turn >= this.oracleBuiltTurn; }
  handSize() { return MAX_TECHS_AVAILABLE + (this.oracleActive() ? 1 : 0); }
  canRedraw() { return this.scholar && !this.redrawUsedThisTurn && this.hand.length > 0; }
  isDone() {
    // nothing left to research and nothing in hand
    return this.hand.length === 0 && this._eligible().length === 0;
  }

  // A tech/bonus is eligible to be drawn into a hand when its state is 'deck',
  // its prereqs are acquired, and (for bonus cards) its parent is acquired.
  // Culture-gated nation unique-unit cards are a separate system (culture level),
  // so they're excluded from normal tech draws.
  _eligible() {
    const acquired = (id) => this.state.get(id) === 'acquired';
    const out = [];
    for (const [id, st] of this.state) {
      if (st !== 'deck') continue;
      const t = this.get(id);
      if (t.isBonus) {
        if (t.cultureRequired) continue;
        if (t.nation && t.nation !== this.nation) continue;
        if (t.parent && !acquired(t.parent)) continue;
        out.push(id);
      } else {
        if ((t.prereqs || []).every((p) => acquired(p))) out.push(id);
      }
    }
    return out;
  }

  // Pick one eligible tech at random (uniform). Honors a slot-level exclusion set
  // and the non-trashable restriction. Reshuffles the passed pile once if dry.
  _drawOne(exclude, includeTrashable) {
    let pool = this._eligible().filter(
      (id) => !exclude.has(id) && (includeTrashable || !this.isBonus(id))
    );
    if (pool.length === 0) {
      // clearTechsPassed(): recoverable cards return to the deck, then retry once.
      let reshuffled = false;
      for (const [id, st] of this.state) {
        if (st === 'passed') { this.state.set(id, 'deck'); reshuffled = true; }
      }
      if (reshuffled) {
        this._log('reshuffle', 'Deck exhausted — reshuffling passed techs.');
        pool = this._eligible().filter(
          (id) => !exclude.has(id) && (includeTrashable || !this.isBonus(id))
        );
      }
    }
    if (pool.length === 0) return null;
    const idx = Math.floor(this._rand() * pool.length);
    return pool[idx];
  }

  // mulberry32 step over serializable state.
  _rand() {
    this._rngState |= 0; this._rngState = (this._rngState + 0x6d2b79f5) | 0;
    let t = Math.imul(this._rngState ^ (this._rngState >>> 15), 1 | this._rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Fill a fresh hand, guaranteeing MIN_NON_TRASHABLE non-bonus cards if available.
  // (Player.cs doTechsAvailable fill loop.)
  _dealHand(exclude = new Set()) {
    const N = this.handSize();
    const hand = [];
    for (let i = N - 1; i >= 0; i--) {
      const nonTrashInHand = hand.filter((id) => !this.isBonus(id)).length;
      const needNonTrash = MIN_NON_TRASHABLE - nonTrashInHand - i > 0;
      const id = this._drawOne(exclude, !needNonTrash);
      if (id == null) break;
      this.state.set(id, 'available');
      hand.push(id);
    }
    this.hand = hand;
    if (hand.length) {
      this._log('draw', `Drew: ${hand.map((id) => this._label(id)).join(', ')}.`);
    } else {
      this._log('draw', 'No techs left to draw.');
    }
    return hand;
  }

  // Discard everything currently in hand except `keep`.
  _discardHand(keep = null) {
    for (const id of this.hand) {
      if (id === keep) continue;
      if (this.isBonus(id)) {
        this.state.set(id, 'trashed');
        this._log('trash', `Lost bonus card "${this.get(id).name}" (unpicked).`);
      } else {
        this.state.set(id, 'passed');
      }
    }
    this.hand = [];
  }

  // ---- player actions ----

  // Choose which card in hand to research. Carried-over (overflow) science is NOT
  // committed here — like the game, it only collapses onto your pick when you end the
  // turn, so you can freely change your mind first.
  pickResearch(id) {
    if (!this.hand.includes(id)) return false;
    if (id === this.currentResearch) return true;
    this.currentResearch = id;
    this._log('pick', `Researching ${this._label(id)} (${this.investedIn(id)}/${this.cost(id)})${this.overflow ? ` +${this.overflow} carry on next turn` : ''}.`);
    return true;
  }

  // Scholar redraw: discard the whole hand (passed/trashed as usual) and deal a fresh
  // one that excludes the just-discarded cards. Once per turn. Clears current research.
  redraw() {
    if (!this.canRedraw()) return false;
    const discarded = new Set(this.hand);
    this._discardHand(null);
    this.currentResearch = null;
    this.redrawUsedThisTurn = true;
    this._log('redraw', 'Scholar redraw.');
    this._dealHand(discarded);
    return true;
  }

  // Build the Oracle this turn; the +1 card sticks from now on.
  buildOracle() {
    if (this.oracleBuiltTurn != null) return false;
    this.oracleBuiltTurn = this.turn;
    this._log('oracle', `Built the Oracle (turn ${this.turn}). Hands now show ${MAX_TECHS_AVAILABLE + 1} cards.`);
    return true;
  }

  setScholar(on) { this.scholar = !!on; }

  // You must always be researching something to end a turn.
  canEndTurn() { return !this.isDone() && this.currentResearch != null; }

  // Advance one turn: gain this turn's science, add any carried-over science, pour it
  // all into the current research, then handle completion. Requires a current pick.
  nextTurn() {
    if (!this.canEndTurn()) return false;
    const gain = this.scienceCurve(this.turn);
    this.totalScience += gain;
    const pool = gain + this.overflow;          // carry collapses onto the chosen tech
    this.overflow = 0;
    this._invest(this.currentResearch, pool);
    this._log('tick', `Turn ${this.turn}: +${gain}${pool > gain ? ` (+${pool - gain} carry)` : ''} science → ${this._label(this.currentResearch)} (${this.investedIn(this.currentResearch)}/${this.cost(this.currentResearch)}).`);
    this._maybeComplete();
    this.turn += 1;
    this.redrawUsedThisTurn = false;
    return true;
  }

  _invest(id, amount) {
    this.invested.set(id, (this.invested.get(id) || 0) + amount);
  }
  investedIn(id) { return this.invested.get(id) || 0; }

  // Complete the current research if it has enough science; deal the next hand.
  _maybeComplete() {
    const id = this.currentResearch;
    if (id == null) return;
    const cost = this.cost(id);
    if (this.investedIn(id) < cost) return;
    this.overflow += this.investedIn(id) - cost;
    this.invested.set(id, cost);
    this.state.set(id, 'acquired');
    this.acquiredOrder.push({ id, turn: this.turn, science: cost });
    this._log('complete', `✓ ${this.get(id).name} researched (${cost} science${id.includes('BONUS') ? '' : ''}).`);
    this._discardHand(id);          // discard the rest of the hand
    this.currentResearch = null;
    this._dealHand();               // fresh hand on acquisition
  }

  // ---- helpers ----
  _label(id) {
    const t = this.get(id);
    if (!t) return id;
    return t.isBonus ? `★${t.name}` : t.name;
  }
  _log(type, text) {
    this.log.push({ turn: this.turn, type, text });
  }

  // ---- undo / redo support: snapshot & restore the full mutable state ----
  snapshot() {
    return structuredClone({
      nation: this.nation, seed: this.seed, _rngState: this._rngState,
      scholar: this.scholar, oracleBuiltTurn: this.oracleBuiltTurn,
      turn: this.turn, totalScience: this.totalScience, overflow: this.overflow,
      redrawUsedThisTurn: this.redrawUsedThisTurn, currentResearch: this.currentResearch,
      invested: this.invested, acquiredOrder: this.acquiredOrder,
      log: this.log, state: this.state, hand: this.hand,
    });
  }
  restore(snap) {
    const s = structuredClone(snap);
    Object.assign(this, s);
    return this;
  }

  // Draw pile / discard breakdown for the UI.
  //   draw   = eligible to be dealt right now (prereqs/parent met, state 'deck')
  //   locked = in the deck but not yet drawable (prereqs/parent unmet)
  //   passed = discarded non-bonus techs (will reshuffle back when the deck dries up)
  //   trashed = bonus cards lost forever
  piles() {
    const draw = new Set(this._eligible());
    const card = (id) => {
      const t = this.get(id);
      return { id, name: t.name, isBonus: t.isBonus, cost: t.cost };
    };
    const out = { draw: [], locked: [], passed: [], trashed: [] };
    for (const [id, st] of this.state) {
      const t = this.get(id);
      if (t.isBonus && t.cultureRequired) continue; // culture cards aren't part of normal draws
      if (st === 'deck') (draw.has(id) ? out.draw : out.locked).push(card(id));
      else if (st === 'passed') out.passed.push(card(id));
      else if (st === 'trashed') out.trashed.push(card(id));
    }
    const byCost = (a, b) => a.cost - b.cost || a.name.localeCompare(b.name);
    out.draw.sort(byCost); out.locked.sort(byCost); out.passed.sort(byCost); out.trashed.sort(byCost);
    return out;
  }

  // Snapshot for the UI.
  view() {
    return {
      nation: this.nation,
      seed: this.seed,
      turn: this.turn,
      totalScience: this.totalScience,
      sciencePerTurn: this.scienceCurve(this.turn),
      overflow: this.overflow,
      handSize: this.handSize(),
      oracleActive: this.oracleActive(),
      oracleBuiltTurn: this.oracleBuiltTurn,
      scholar: this.scholar,
      canRedraw: this.canRedraw(),
      canEndTurn: this.canEndTurn(),
      currentResearch: this.currentResearch,
      hand: this.hand.map((id) => {
        const t = this.get(id);
        return {
          id,
          name: t.name,
          cost: t.cost,
          isBonus: t.isBonus,
          bonus: t.bonus || null,
          iconName: t.iconName || null,
          unlocks: t.unlocks || null,
          invested: this.investedIn(id),
          isCurrent: id === this.currentResearch,
        };
      }),
      acquired: this.acquiredOrder.map((a) => ({ ...a, name: this.get(a.id).name, isBonus: this.isBonus(a.id) })),
      log: this.log,
      piles: this.piles(),
      done: this.isDone(),
    };
  }
}
