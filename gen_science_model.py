#!/usr/bin/env python3
"""Decompose owglick's empirical science curve into per-tech contributions.

Reads owglick's cached games (../owglick/data/raw/games/*.json), and for each
winning player correlates per-turn SCIENCE rate with which science-moving techs
they had researched by that turn. A non-negative least-squares fit (controlling
for turn via within-turn centering) yields a science weight w_t per tech.

Emits science-model.js:
    window-free ES module exporting:
      scienceTechs : [techId, ...]
      scienceWeights : {techId: w_t}            // extra science/turn once you have it
      avgHas : {techId: [[turn, fraction], ...]} // average possession by turn

Model used by the engine:
    science(turn) = nationBaseline(turn) + Σ_t w_t * ( has_t(turn) - avgHas_t(turn) )
so an average player reproduces the baseline curve; rushing science techs pushes
the curve up early (and compounds), neglecting them drags it down.

Run:  python3 gen_science_model.py
"""
import json, glob, os

SINCE = "2026-05-07"           # match owglick's recency window
TURNS = list(range(5, 61, 5))  # owglick sample grid

# Candidate science-moving techs (from the game XML: improvements/specialists/laws
# /projects that yield SCIENCE, attributed to the tech that unlocks them).
CANDIDATES = [
    "TECH_DIVINATION",     # Shrines (+10 science)
    "TECH_SCHOLARSHIP",    # Libraries: Philosopher/Scribe specialist slots + %science
    "TECH_MONASTICISM",    # Monasteries (+20 science)
    "TECH_HYDRAULICS",     # Watermill (+20 science)
    "TECH_WINDLASS",       # Windmill (+20 science)
    "TECH_METAPHYSICS",    # Archive project
    "TECH_ARCHITECTURE",   # Philosophy law / Baths
]

GAMES = os.path.join(os.path.dirname(__file__), "..", "owglick", "data", "raw", "games")


def load_rows():
    rows = []          # (turn, y_rate, {tech: 0/1})
    n_games = 0
    for f in glob.glob(os.path.join(GAMES, "*.json")):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        mm = d.get("match_metadata", {})
        if (mm.get("save_date") or "") < SINCE:
            continue
        win = (mm.get("winner") or {}).get("winner_player_xml_id")
        if win is None:
            continue
        sci = next((y for y in d.get("yield_history", [])
                    if y.get("yield_type") == "YIELD_SCIENCE" and y.get("player_id") == win), None)
        th = next((t for t in d.get("tech_discovery_history", []) if t.get("player_id") == win), None)
        if not sci or not th:
            continue
        rate = {e["turn"]: e["rate"] for e in sci["data"] if e.get("rate") is not None}
        techturn = {}
        for e in th["data"]:
            name = e.get("tech_name")
            if name and name not in techturn:
                techturn[name] = e["turn"]
        n_games += 1
        for T in TURNS:
            if T not in rate:
                continue
            has = {c: (1.0 if (c in techturn and techturn[c] <= T) else 0.0) for c in CANDIDATES}
            rows.append((T, rate[T], has))
    return rows, n_games


def nnls_cd(X, y, iters=800):
    """Non-negative least squares via cyclic coordinate descent on the normal eqs."""
    m, n = len(X), len(X[0])
    A = [[sum(X[r][i] * X[r][j] for r in range(m)) for j in range(n)] for i in range(n)]
    b = [sum(X[r][i] * y[r] for r in range(m)) for i in range(n)]
    w = [0.0] * n
    for _ in range(iters):
        for i in range(n):
            if A[i][i] <= 1e-9:
                continue
            s = b[i] - sum(A[i][j] * w[j] for j in range(n) if j != i)
            w[i] = max(0.0, s / A[i][i])
    return w


def main():
    rows, n_games = load_rows()
    if not rows:
        raise SystemExit("No games found — check ../owglick/data/raw/games")

    # per-turn means for centering
    by_turn = {T: [] for T in TURNS}
    for (T, y, has) in rows:
        by_turn[T].append((y, has))
    mean_y = {T: (sum(y for y, _ in v) / len(v) if v else 0.0) for T, v in by_turn.items()}
    avg_has = {c: {T: (sum(h[c] for _, h in v) / len(v) if v else 0.0)
                   for T, v in by_turn.items()} for c in CANDIDATES}

    # centered design
    X, Y = [], []
    for (T, y, has) in rows:
        X.append([has[c] - avg_has[c][T] for c in CANDIDATES])
        Y.append(y - mean_y[T])
    w = nnls_cd(X, Y)
    weights = {c: round(w[i], 2) for i, c in enumerate(CANDIDATES)}

    # report
    print(f"games: {n_games}   rows: {len(rows)}\n")
    print(f"{'tech':24} {'w (sci/turn)':>13} {'avgHas@30':>10} {'avgHas@50':>10}")
    for c in CANDIDATES:
        print(f"{c:24} {weights[c]:>13} {avg_has[c][30]:>10.2f} {avg_has[c][50]:>10.2f}")
    swing = sum(weights[c] * (1 - avg_has[c][30]) for c in CANDIDATES)
    drag = sum(weights[c] * (0 - avg_has[c][30]) for c in CANDIDATES)
    print(f"\nat turn 30: rushing ALL science techs ≈ +{swing:.1f} sci/turn vs avg; "
          f"neglecting ALL ≈ {drag:.1f}")

    # emit science-model.js
    techs = [c for c in CANDIDATES]
    avg_js = {c: [[T, round(avg_has[c][T], 4)] for T in TURNS] for c in CANDIDATES}
    out = (
        "// GENERATED by gen_science_model.py — do not edit by hand.\n"
        "// Per-tech science contributions decomposed from owglick winning-game data.\n"
        f"// games={n_games}, since={SINCE}\n\n"
        f"export const scienceTechs = {json.dumps(techs)};\n\n"
        f"export const scienceWeights = {json.dumps(weights)};\n\n"
        f"export const avgHas = {json.dumps(avg_js)};\n"
    )
    path = os.path.join(os.path.dirname(__file__), "science-model.js")
    open(path, "w").write(out)
    print("\nwrote", path)


if __name__ == "__main__":
    main()
