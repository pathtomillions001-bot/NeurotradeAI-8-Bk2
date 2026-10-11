# Fix: the downloadable MT5 EA (v3.05) did not compile

## Problem

Downloading the bridge EA from the Desk (**Live Desk → bridge dialog → Download
NeurotradeBridge.mq5**) and compiling it in MetaEditor failed — the EA could not
be built by anybody:

```
declaration without type       NeurotradeBridge.mq5  1936  38
comma expected                 NeurotradeBridge.mq5  1936  52
cannot convert parameter 'PositionState' to 'int'   1874  30
undeclared identifier 'PM_TRAIL_MULT_SCALP'         1884  60
undeclared identifier 'PM_TRAIL_MULT_INTRADAY'      1885  60
undeclared identifier 'PM_TRAIL_MULT_SWING'         1885  85
cannot convert parameter 'PositionState' to 'int'   2043  48
possible loss of data due to type conversion from 'ulong' to 'long'  466  19
possible loss of data due to type conversion from 'ulong' to 'long'  471  16
```

The two `long`/`ulong` lines are warnings; everything else is fatal, and it all
cascades from a single cause.

## Root cause

**MQL5 resolves names in TEXT ORDER.** Its preprocessor is single-pass, so a
`#define`, a `struct` or a global variable referenced *above* its declaration is
an error — `undeclared identifier`, `declaration without type` — never a forward
reference. (C++ accepts some of these; MQL5 does not, and the file even says so
next to the state arrays it could not see.)

The v3.05 position-management state machine was appended to
`artifacts/mt5-ea/NeurotradeBridge.mq5` at the position its **functions** belong
in — after `ArmPlanFromJson()` and the command handlers — and it carried its own
shared state with it:

| Declaration (old line) | First use above it | Error reported |
| --- | --- | --- |
| `struct PositionState` (2196) | `ArmPlanFromJson()` 1873, `ParsePartials()` 1936 | declaration without type, cannot convert `PositionState` → `int` |
| `#define PM_TRAIL_MULT_*` (2178–2180) | `ArmPlanFromJson()` 1884, `ApplyManagementCommand()` 2026 | undeclared identifier |
| `g_ps`, `g_psCount`, `g_mgmtEvents`, `g_mgmtEventCount` (2266–2273) | `OnDeinit()` 429, `Sync()` 881 | undeclared identifier |

So the type never resolved, `ParsePartials()` was compiled with a bad parameter
list (`int ParsePartials(const string,int)`), and every call site that passed a
`PositionState` failed with it.

**Why the tests did not catch it.** `ea-download-parity.test.ts` asserts the
published download is byte-identical to the source and that it *contains* the
v3.05 markers (`PositionState`, `PsRestoreAll`, `ManageOnePosition`, …). A file
that *mentions* `PositionState` seventeen times passes that check whether or not
the name is declared before its first use. Nothing in the repository ever
checked declaration ORDER.

**Why the Desk could not tell users either.** The EA declares
`#property version "3.05"` and sent that version when pairing, but the
**heartbeat** body still reported `3.04` — and the heartbeat is the value the
desk stores as `terminal.eaVersion`. `docs/mt5-live-desk-v4.md` §2.3 ("Version
property and sync payload are `3.05`") was therefore inaccurate, and
`/api/bridge/status` could never distinguish a v3.05 terminal from a v3.04 one.

## Fix

**`artifacts/mt5-ea/NeurotradeBridge.mq5`** (and the published copy, via
`scripts/copy-mt5-ea.mjs`)

* **The v3.05 shared state now has a home before every use.** Its macros,
  structs (`PositionState`, `AtrHandleRec`, `TickRec`) and arrays (`g_ps`,
  `g_atrHandles`, `g_ticks`, `g_mgmtEvents`) were moved out of the state-machine
  section and into the **v3.05 position-manager SHARED STATE** section next to
  the plan and link state it belongs with, above `OnInit`. A comment at the old
  location points there, and the section carries the reason (single-pass
  preprocessor, text-order resolution) so the next splice does not repeat it.
  Only the machine's *functions* remain in the "POSITION MANAGEMENT STATE
  MACHINE" section.
* **`ulong beatStart` / `ulong beatMs`** — `GetTickCount64()` returns `ulong`;
  storing it in a `long` was the narrowing conversion MetaEditor warned about,
  and a wrapped counter would have logged a huge negative beat duration.
* **One version on the wire.** `#define EA_VERSION "3.05"` now feeds both the
  pairing and the heartbeat bodies, so the desk's "your EA is out of date" check
  sees what the file declares. The pairing body already reported 3.05; the
  heartbeat is the one that was wrong.
* Header note 23 records the fix in the file's own changelog.

**`artifacts/trading-platform/src/lib/ea-source-integrity.test.ts`** (new, wired
into `test`)

A static check of the shipped EA, pinning the failure mode that actually
shipped:

* every macro, struct and global is declared before its first use;
* no macro, type or global is declared twice (a re-spliced block);
* braces and parentheses balance (a splice that loses a line);
* the heartbeat timer keeps `GetTickCount64()` unsigned;
* the EA reports one version, and it is the `#property version` one;
* the position-manager state is declared above `ParsePartials()`.

It is deliberate about MQL5's own rules: only macros/types/variables are
order-checked (MQL5 resolves a *call* to a function defined later), a `#define`
body is not a use (it expands at the use site), and character literals —
`if(ch == '{')`, `if(ch != '"')` — are lexed as such rather than as strings.

**`artifacts/mt5-ea/v305-block.mq5`** carries a header warning that it is the
historical splice artifact and is not compiled; the declarations it used to
duplicate now live in the shared-state section.

## Verification

* `pnpm --filter @workspace/trading-platform run test` → 50/50 pass, including
  the 6 new integrity tests.
* The new test file was run against the **broken** revision
  (`git show HEAD:artifacts/mt5-ea/NeurotradeBridge.mq5`) and fails there with
  exactly the reported defects (`PositionState (line 2196) must be declared
  above its first use (line 1874)`, `GetTickCount64() must be held in a ulong`),
  then passes on the fixed file.
* `pnpm --filter @workspace/api-server exec tsx --test … ea-contract.test.ts
  position-manager.test.ts` → 41/41 pass (the MQL5 ↔ TypeScript wire contract is
  untouched by the move).
* `npx tsc -p artifacts/trading-platform/tsconfig.json --noEmit` → clean.
* The published download is re-synced: `public/downloads/NeurotradeBridge.mq5`
  is byte-identical to `artifacts/mt5-ea/NeurotradeBridge.mq5`.

## Not done here (deliberate)

* `EXPECTED_EA_VERSION` in `artifacts/api-server/src/routes/bridge.ts` is still
  `"3.04"`. Raising it to `3.05` would make the desk show the amber "older EA"
  banner to terminals on 3.04 — a product decision, not a compile fix.
* The build itself still cannot be verified in CI: MetaEditor is Windows-only,
  with no headless equivalent. The new test is a static check, and says so.
