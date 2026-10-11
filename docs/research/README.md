# Research harness reports (WP2)

This directory holds the stored output of the desk v4 research harness —
`artifacts/api-server/src/lib/multiasset/research/`. Each report exists as a
markdown file (what a human reads, and what the changelog cites) and a JSON file
(the machine-readable evidence: metrics, trades, management actions).

## How to run it

```bash
cd artifacts/api-server

# Real broker data (see research/data.ts for the exact MT5 export steps):
pnpm run research:run -- --mode intraday --data /path/to/EURUSD_M1.csv --seed 1

# The null gate: datasets with no exploitable structure.
pnpm run research:run -- --gate null --mode intraday --seeds 1,2,3 --bars 40000

# The positive control: a market with a deliberate, persistent edge.
pnpm run research:run -- --gate control --mode intraday --seeds 1,2,3 --bars 40000

# Add --compact to write the small JSON (aggregates + a trade sample).
```

Reports land in `research-reports/` unless `--out` says otherwise. A gate run
exits non-zero when the gate FAILS, so it can be wired into CI directly.

## What is stored here

| File | What it is |
|---|---|
| `baseline-null-intraday.{md,json}` | The CURRENT desk on a driftless random walk, seeds 1–3. The null gate. |
| `baseline-control-intraday.{md,json}` | The CURRENT desk on the positive control (regime-switching drift + AR(1) mean reversion), seeds 1–3. |

Both were produced **before** any v4 redesign of the decision path, so they are
the "before" measurement the programme is judged against.

## What these reports do and do not prove

They are generated data, not broker data. A driftless random walk and a
deliberately-edgeful synthetic series bracket the behaviour of the desk — they
show how it responds when there is nothing to find and when there is something —
but **neither one is evidence about any real instrument.** The real-data baseline
requires an M1 export from the owner's terminal; the harness reads it without
further changes.

Read `docs/mt5-live-desk-v4.md` §9 for the interpretation of these two runs.
