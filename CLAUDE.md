# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is the canonical guide (architecture, commands, conventions, testing, the public-mirror rules). It is imported below so there is one source to keep current. Put shared guidance there, not here. This file only holds notes that matter to Claude sessions specifically.

@AGENTS.md

## Quick reference

```bash
npm run typecheck && npm run lint && npm test   # gate before handing off a change
npx vitest run packages/domain-rajal            # one package
npx vitest run -t '<test name>'                 # one test
node --import tsx scripts/gen-rule-catalog.ts   # after editing any domain executors.ts
bash scripts/livetest.sh                        # E2E smoke (mock login server, no real SIMRS)
```

## Working against legacy and live SIMRS

- **Legacy sources** live in the sibling repo `../EvoMedis-Helper` (not in this repo): `rajal_v23.js` / `rajal_v19.js` (outpatient userscript), `ranap_v3.py` (inpatient), plus crawled route dumps `endpoints_routes*.txt` / `endpoints_index.txt`. Comments that cite `rajal_v23.js:887` or `ranap_v3.py:15371` point there.
- **The route dumps are historical.** A route listed there can be gone from the live server. `kasir/kasir/get_rencana_onko` is in all three dumps but answers 404 live. Confirm a route against live SIMRS before wiring a new endpoint.
- **Live probes are read-only and stay out of git.** Ad-hoc scripts go in `.data/live/` (gitignored). Build `EvoMedisClient` with `mode: 'preview'` so any mutation throws, and load credentials from `.env`. Never print patient names, No RM or `no_transaksi` from live output. `scripts/*-live-validate.ts` are the maintained read-only harnesses. `scripts/pilot-live-write.ts` is the only sanctioned live write path, and only with its patient/mutation allowlists.
- **Check recorded decisions before "fixing" a gap.** A step that looks broken may be an accepted decision. Look in `docs/risk-register.md` (Accepted gaps), the owner-decision tables in `docs/qa/run-e2e-2026-10.md`, and `docs/legacy/{rajal,ranap}-parity.md`.
