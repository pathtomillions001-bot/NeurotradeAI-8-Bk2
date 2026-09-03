# NeuroTrade AI — user guide

A quick-start guide for new users, built from this repository's own code and live defaults.

| File | What it is |
| --- | --- |
| `NeuroTrade-AI-User-Guide.pdf` | The guide (8 pages). |
| `build_user_guide.py` | Generates the PDF. |
| `guide_lib.py` | Diagram primitives, table/paragraph styles, the screenshot-or-schematic flowable. |
| `capture-screenshots.mjs` | Playwright script that captures real screens into `shots/`. |
| `shots/` | Drop `dashboard.png`, `fab.png`, `bots.png`, `architecture.png` here. |

## Rebuild

```bash
python3 -m venv .venv && .venv/bin/pip install reportlab pillow
.venv/bin/python docs/guide/build_user_guide.py
```

ReportLab and Pillow are the only dependencies. No LaTeX, no browser needed.

## Diagrams vs screenshots

Every figure is drawn as an annotated **schematic** of the real layout — deliberately, because the build
environment cannot run a browser. A figure is never a fabricated image of the product: each one is captioned
as a schematic, and the note line says exactly which file would replace it.

To swap in real captures:

```bash
npm i -D playwright && npx playwright install chromium
node docs/guide/capture-screenshots.mjs          # writes shots/*.png
.venv/bin/python docs/guide/build_user_guide.py  # figures become screenshots
```

Any figure with a matching `shots/<name>.png` renders the PNG with a green "● screenshot" tag; figures without
one keep their schematic. The guide therefore always states, per figure, whether you are looking at a capture or
a diagram.

## Keeping it honest

The guide's defaults and behaviour notes were read from:

- `lib/db/src/index.ts` — `INIT_DDL` column defaults (the shipped settings values)
- `artifacts/api-server/src/routes/bots.ts` + `lib/bot-catalog.ts` — the five bot definitions
- `artifacts/api-server/src/lib/agent-coordinator.ts` — the staged agent pipeline
- `artifacts/api-server/src/lib/engine-arbiter.ts` — the one-engine-at-a-time rule
- `artifacts/api-server/src/lib/speed-ai-engine.ts` — the FAB engine
- `artifacts/trading-platform/src/pages/*.tsx` — every label quoted in the guide

If you change a default, a bot, or a settings label, regenerate the PDF so the guide and the app cannot drift.
