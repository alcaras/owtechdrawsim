# Old World — Tech Draw Simulator

A faithful, interactive simulator of **Old World**'s technology card draws. Pick a
nation and research exactly the way the game deals it: a hand of four cards (five
with the Oracle), one Scholar redraw per turn, and bonus cards that burn forever if
you pass them. Science ticks up each turn from the [owglick](../owglick) curve.

Open `index.html` (or serve the folder) — no build step.

```bash
python3 -m http.server 8731   # then visit http://localhost:8731/
```

## How a turn works

1. Pick a nation. Your starting techs are pre-researched.
2. You're dealt a hand of cards. **Click one** to start researching it.
3. **Next turn** adds science to your current research, using the real
   per-turn **science curve from [owglick](../owglick)** (winning-game data, per
   nation where available, otherwise the all-nations aggregate).
4. When a tech finishes, the rest of the hand is discarded and a **fresh hand** is
   dealt — exactly like the game (`doTechsAvailable` fires on acquisition, not every
   turn).
5. **Scholar** (toggle): redraw the current hand once per turn. **Oracle** (build it
   on any turn): permanently bumps your hand from 4 to 5 cards.
6. **Restart** returns to the nation picker. Set a **seed** for a reproducible run.

The right-hand **History** logs every draw, pick, completion, redraw, trashed bonus,
and reshuffle. **Researched** lists each acquired tech with the turn and science spent.

## Faithful to the game

The draw engine (`engine.js`) mirrors `Player.cs` from the Old World reference source:

| Rule | Source | Implemented |
|---|---|---|
| Hand size = 4 + Oracle(+1) | `MAX_TECHS_AVAILABLE`, `iTechsAvailableChange` | ✓ |
| Special opening hand (over-fill by one, then top up after starting techs are acquired) | `initNation` | ✓ |
| ≥ 2 non-bonus cards per hand | `MIN_NON_TRASHABLE_TECHS_AVAILABLE = 2` | ✓ |
| Uniform-random card selection | `random(1..1000)`, highest wins | ✓ |
| Fresh hand on acquisition | `doTechsAvailable()` | ✓ |
| Non-bonus passed → reshuffles back | `setTechPassed` / `clearTechsPassed` | ✓ |
| Bonus (`bTrash`) discarded → gone forever | `setTechTrashed` | ✓ |
| Scholar redraw, once/turn, excludes discards | `bRedrawTechs`, `doTechsAvailable(true)` | ✓ |
| Prereqs gate availability | `canMakeTechAvailable` | ✓ |

The **opening hand** is genuinely special: at game start only the root (no-prereq)
techs are eligible, so the over-fill draws all of them, then your starting techs are
acquired (removing any from the hand) and the hand tops up. Net result — the first
hand is every non-starting root plus a few children, so e.g. Rome (starts
Ironworking + Stonecutting + Polis) opens with exactly Trapping / Divination /
Administration.

Each hand card shows its **science cost** (with the beaker) bottom-left and what it
*adds to your draw pool* bottom-right: **⊞ hard tech cards** (techs it unlocks as a
prereq) and **★ soft bonus cards** (bonus cards attached to it).

Out of scope for now: culture-gated nation unique-unit cards (a separate
culture-level system) are excluded from the draw pool. Tech prereqs use the
"all prerequisites acquired" rule.

## Plan & Optimize

Click **📋 Plan & Optimize** to analyze a research plan instead of playing by hand.

- **Paste a plan** — an owtt share URL (`?n=…&o=…`), a raw `?o=` index list, or a
  comma list of tech ids. Prerequisites are auto-inserted (cheapest-first).
- **Simulate** runs the plan over many random draws under a faithful auto-player:
  take the highest-priority *wanted* card in hand (bonus before main, since bonuses
  burn); when nothing wanted is in hand, **dig** — redraw with Scholar (banks
  science, ~free) or research the cheapest card to cycle without it. You get the
  median completion turn (p10–p90), success rate, **wasted science**, the turn each
  tech lands, and a warning if an on-plan bonus tends to get trashed.
- **Optimize** searches orderings (hill-climb with **Common Random Numbers** — every
  candidate scored on the same seed set) and reports the fastest order plus an
  `?o=` string to paste back into owtt.
- **Strict order** toggle — *off* (flexible, default) takes whatever wanted card
  appears, which is usually fastest; *on* chases your #1-priority tech next,
  redrawing past lower-priority cards, so techs land in your exact order (it still
  grabs an on-plan bonus rather than let it burn).

A real finding the tool surfaces: with **Scholar**, redraw-digging banks science with
zero waste, so completing a whole *set* becomes science-bound and order barely
matters — without it, you waste science cycling and order/luck count for more.

## Science curve

`science.js` embeds owglick's per-turn science rates (turns 5–60, interpolated;
extrapolated outside that range) for the 8 nations with enough sampled games, and
falls back to the all-nations aggregate for the rest.

## Files

```
index.html        # single-screen UI
engine.js         # pure, faithful draw engine (no DOM) — the spec lives here
planner.js        # plan parsing, prereq closure, auto-player, Monte-Carlo, optimizer
science.js        # owglick per-nation science curves
app.js            # UI: nation picker, hand, history, Plan & Optimize modal
styles.css        # parchment / game-like styling
tech-data.js      # COPIED from ../owtt (generated by its parser — don't hand-edit)
test_engine.mjs   # node assertions for the engine mechanics
test_planner.mjs  # node assertions for parsing, sim, and the optimizer
img/              # tech / bonus icons + nation crests (from ../owtt)
```

## Tests

```bash
node test_engine.mjs    # 25 assertions — draw mechanics
node test_planner.mjs   # 22 assertions — parsing, simulation, optimizer
```

`test_engine` covers hand size, Oracle stickiness, the ≥2-non-bonus guarantee,
permanent bonus trashing, Scholar redraw rules, completion → fresh hand, determinism
by seed, and prereq gating. `test_planner` covers owtt URL/order decoding, prereq
expansion, plan completion, the Scholar-digs-faster property, Oracle never hurting,
optimizer never regressing, determinism, and on-plan bonus loss accounting.

## Data

`tech-data.js` is the same generated artifact owtt deploys (costs, prereqs, nations,
starting techs, bonus cards, crests, icon slugs). Regenerate it with owtt's
`generate_tech_tree.py` and copy it here after a game patch.
