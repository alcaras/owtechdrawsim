# owtechdrawsim — Design Brief

A visual-design pass to make this feel like a polished companion to **Old World**
(the 4X game by Mohawk Games). The mechanics, data, and interactions are done and
correct — this brief is about **look and feel only**.

**Live:** https://alcaras.github.io/owtechdrawsim/
**Repo:** static site, no build step (details in §5).

---

## 1. What it is

An interactive simulator of Old World's **technology card draws**. You pick a nation,
then research exactly the way the game deals it: a hand of 4 cards (5 with the Oracle),
one Scholar redraw per turn, bonus cards that burn if you pass them, science ticking up
each turn. There's also a "Plan & Optimize" panel that Monte-Carlos a research order.

The whole point is that it should **feel like sitting in Old World's tech screen** —
the cards are the hero. The user is attaching a screenshot of the real in-game tech
cards as the north-star reference (see §3).

## 2. The goal

Elevate the current "warm parchment" theme into something that reads as **authentically
Old World**: classical-antiquity, hand-drawn-map / illuminated-manuscript feeling,
tactile cards, confident typography, restrained ornament. Right now it's clean but
generic-warm; we want it to look like it belongs next to the game.

Quality bar: a player who knows Old World should glance at it and think "oh, this gets
it." Avoid generic SaaS/Material/Tailwind-default aesthetics.

## 3. Reference

- **Attached by the user:** a screenshot of Old World's in-game tech cards / research
  UI. **This is the primary visual target** — match its card framing, iconography
  treatment, type, and palette as closely as the web medium allows. Put it here:
  `design/reference-game-cards.png` and study it before touching anything.
- **Current state** (this app), for the teardown below:
  - `design/current-1-picker.png` — nation picker
  - `design/current-2-game.png` — main game screen (the important one)
  - `design/current-3-plan-modal.png` — Plan & Optimize modal

## 4. Current state — component teardown

The layout is a 3-zone CSS grid: **topbar** (HUD) across the top, **board** (research +
hand) on the left, **ledger** (history + piles) as a right rail. It collapses to a
single column under 860px.

1. **Nation picker** (`#picker`) — a grid of `.nation-card`s, each a colored crest disc
   (`.nation-crest-disc` filled with the nation's team color) + name. Functional but
   flat. Opportunity: make each nation feel like a faction badge/banner; richer crest
   treatment; a more evocative title/landing.

2. **Topbar / HUD** (`.topbar`) — crest + nation name, then stat readouts (Turn,
   Science/turn with a blue "⚛ +N from techs" badge `.sci-bonus`, Total science), then
   controls (undo/redo, Scholar switch, Build Oracle, Plan & Optimize, Restart). Feels
   like a web toolbar; could read like a game HUD / resource bar.

3. **Tech cards** (`.card`, `.card-bonus`) — **the centerpiece; spend most effort here.**
   Each card has: an icon (`.card-icon`), name (`.card-name`), "unlocks" pills
   (`.card-unlocks .pill` — units/improvements/laws/projects; law pills carry a law
   icon), a footer (`.card-foot`) with science **cost + beaker** on the left
   (`.card-cost`) and what it **adds to your draw pool** on the right (`.card-opens`:
   `⊞ N` hard tech cards in blue, `★ N` soft bonus cards in gold), and a thin progress
   bar (`.card-prog`: solid committed science + a striped "carry" preview segment).
   **Bonus cards** (`.card-bonus`) are dashed + show a "burns if passed" tag
   (`.card-trash-tag`) and an effect line (`.card-bonus-text`). The selected card has
   `.is-current`. Match the game's card frame/border/material; make hover + selected
   states satisfying; bonus cards should feel distinct and ephemeral.

4. **Current-research bar** (`#researchBody`) — name + a progress bar with two segments
   (`.rb-solid` committed, `.rb-prev` striped carry preview) and a "↻ +N carry" tag
   (`.carry-tag`). This is the "what am I researching now" focus; could be more
   prominent/elegant.

5. **History log** (`#history`, `.ev` rows with `.ev-turn` + `.ev-text`) — turn-stamped
   events, color-coded by type (`ev-complete`, `ev-trash`, `ev-redraw`, `ev-oracle`,
   `ev-draw`, `ev-pick`, `ev-reshuffle`). Reads like a console; could feel like a
   chronicle/annal.

6. **Ledger sections** (right rail, collapsible `<details>`): **Researched** (count +
   total science + law tally in the summary; rows with a law icon marker), **Draw pile**,
   **Discard** (passed — reshuffles back), **Trashed** (bonus cards gone for good,
   collapsed by default). Card chips are `.chip` / `.chip-bonus`. Make these feel like
   tidy stacks/piles rather than lists, without losing scannability.

7. **Plan & Optimize modal** (`#planModal`) — a form (paste an owtt URL / toggles) plus
   a results readout: a priority "sequence" of pill chips (`.seq-item`), a 4-up stat grid
   (`.stat-grid`/`.sg-num`/`.sg-lbl`), a per-tech timing table (`.pt-table`), and a
   "paste back into owtt" code line. It's information-dense; needs hierarchy and polish
   so it doesn't read as a plain form.

## 5. Hard constraints (do not break)

- **Stack:** plain static files — `index.html` + vanilla ES-module JS
  (`app.js`, `engine.js`, `planner.js`, `science.js`, `science-model.js`) + `styles.css`
  + generated `tech-data.js`. **No build step, no framework, no npm, no bundler.**
  Served from GitHub Pages. Keep it that way.
- **Primary deliverable is `styles.css`.** You may also edit `index.html` and the HTML
  *template strings* inside `app.js` (search for `cardHTML`, `unlockPills`, `statsBlock`,
  the `render()` function, `buildPicker`) to add wrapper elements / classes / ornaments —
  but **do not change app/engine logic, data shapes, or behavior.**
- **Do not rename or remove these DOM ids** (JavaScript binds to them):
  `picker, game, nationGrid, topCrest, topNation, statTurn, statSpt, statTotal,
  scholarToggle, oracleBtn, planBtn, undoBtn, redoBtn, restartBtn, restartBtn2,
  researchBody, hand, redrawBtn, nextBtn, history, acquired, acqCount, acqSci, acqLaws,
  drawCount, drawList, discardCount, discardList, trashedCount, trashedList, seedLabel,
  pickScholar, pickSeed, planModal, planClose, planInput, planScholar, planStrict,
  planOracle, planRuns, planNationNote, planSimBtn, planOptBtn, planStatus, planResults,
  owttCopy`.
- **Card / history / ledger / modal innards are rebuilt by `render()`** via template
  strings in `app.js` (not static in `index.html`). To restructure those, edit those
  template strings; the class names listed in §4 are your styling hooks — keep them or
  update both places together.
- **Don't touch:** `engine.js`, `planner.js`, `science*.js`, `tech-data.js`,
  `gen_science_model.py`, the test files. Faithful labels/numbers stay as-is.
- **Keep it responsive** (works at phone widths; there's a single-column breakpoint at
  860px) and reasonably **accessible** (legible contrast, focus states, the toggles
  remain operable). Respect `prefers-reduced-motion` for any new animation.
- **Performance:** `render()` runs on every action and re-sets innerHTML — avoid styles
  that cause heavy reflow/jank with ~5 cards + a long history list.

## 6. Asset inventory (use these — don't invent new art unless you generate it)

All under `img/`:

- **Tech icons:** `img/icons/techs/<slug>.png` where slug = tech id minus `TECH_`,
  lowercased (e.g. `TECH_SPOKED_WHEEL` → `spoked_wheel.png`).
- **Bonus-card sprites:** `img/icons/bonus/<iconName>.png` (each bonus tech has an
  `iconName` in `tech-data.js`).
- **Yield icons:** `img/icons/yields/` — notably `science.png` (the beaker, used as the
  cost unit) and `laws.png` (the law icon).
- **Other unlock icons:** `img/icons/{unit,improvement,law,project,resources,specialists}/`.
- **Nation crests:** `img/crests/<slug>.png`.
- **Per-nation team colors:** `tech-data.js` → `window.nationData.colors[NATION_X] =
  { bg, accent, crest }`. Already used for the picker tint + topbar band; lean into them.
- **Fonts:** currently system sans only. You may introduce a webfont (e.g. a humanist
  serif / classical display face for headings + a clean text face) via a `<link>` in
  `index.html` — keep it to 1–2 families, and it must degrade gracefully. A serif
  display face for the game-y headings would go a long way.

## 7. Direction notes (suggestions, not prescriptions)

- **Palette:** the warm parchment + gold + dark-ink base is right; push it toward Old
  World's specific palette (aged paper, oxblood/terracotta, bronze/gold, ink). Use the
  per-nation accent as a controlled pop, not everywhere.
- **Material & texture:** subtle paper grain, deckled/engraved card edges, a hint of
  letterpress depth — tactile but not skeuomorphic-noisy. Cards should look pickable.
- **Type:** a confident display serif for nation names / headings / the "Next turn"
  CTA; a tidy face for numbers (tabular figures already used in places). Establish real
  hierarchy in the modal and ledger.
- **Iconography:** the game's icons are already available — frame/contain them
  consistently (e.g. roundels, plinths) so units/improvements/laws read at a glance.
- **States & motion:** make selected/hover/disabled obviously distinct; a small, classy
  deal/flip on new hands and a fill on the progress bars would add life. Keep it subtle
  and reduced-motion-aware.
- **Bonus cards** should feel like fleeting opportunities (foil/aged, the "burns if
  passed" warning prominent).

## 8. Deliverables

1. A reworked **`styles.css`** (the main artifact), plus any **`index.html`** /
   **`app.js` template-string** edits needed to support the design (keeping every
   constraint in §5).
2. Optional: a webfont `<link>` and any small SVG/CSS ornaments (inline, no new build
   deps).
3. A short note on the direction taken and any 1–2 alternates worth considering.
4. Keep all three surfaces cohesive: picker, game, and modal.

## 9. How to preview

```bash
cd owtechdrawsim
python3 -m http.server 8731    # open http://localhost:8731/
```
Pick a nation, click cards to research, hit **Next turn** a few times to see progress
bars / carry preview / history fill in, and open **Plan & Optimize** to see the modal.

## 10. Non-goals

- No new features, no mechanic/label/number changes, no copy rewrites beyond cosmetic.
- No framework migration or build tooling.
- Don't alter the engine, planner, science model, data, or tests.
