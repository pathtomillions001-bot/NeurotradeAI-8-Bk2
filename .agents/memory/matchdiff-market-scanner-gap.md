---
name: Matches/Differs (DIGITMATCH/DIGITDIFF) silently never trading
description: Root cause of matches/differs being enabled in settings but never executing.
---

`market-scanner.ts` never modeled a "matchdiff" family at all (no `wantMatchDiff` detection,
nothing pushed into `enabledFamilies` for it), and separately hard-excluded Bull/Bear from
digit-family analysis (`!isBullBear` guards). If a user enabled only DIGITMATCH/DIGITDIFF (no
direction/over-under/even-odd), `enabledFamilies` came back empty, `isEligible: false`,
`score: 0` — which trips confidence-fusion's hard "market ineligible" gate before any
downstream digit-match logic ever runs.

**Why:** every other family (direction, overunder, evenodd) was wired into the scanner's
eligibility scoring; matchdiff was added later downstream (agent-coordinator, ai.ts) without
updating the scanner that gates everything upstream.

**How to apply:** if a contract-type family is enabled in Settings but trades never execute for
it, check `market-scanner.ts`'s `enabledFamilies` construction first — a family missing there
silently zeroes eligibility regardless of how correct the downstream analysis logic is. Also
worth checking: confidence-fusion.ts's EV gate uses one flat `expectedValue >= minEV` threshold
for every contract type, which may still block structurally low-payout types like DIGITDIFF
even after the scanner allows them through (unconfirmed — flagged as a follow-up).
