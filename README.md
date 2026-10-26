# SIMRS-Flow

Safety-first, pilot-stage rewrite of the EvoMedis/SIMRS automation helper (rawat jalan + rawat inap) with a **React Flow** workflow canvas, an **event-driven headless engine**, a **typed API client**, an **append-only audit ledger**, and a local/intranet **orchestrator API**.

This repository implements the plan in `REACT_FLOW_REWRITE_PLAN.md`. The guiding contract is:

```
WorkflowDefinition → Runner → WorkflowEvent → Store → React Flow
```

The runner never touches the UI. It only emits events; the UI is a pure projection of the event stream. This makes runs **replayable**, **auditable**, and **testable without a browser**.

## Why this shape

- **React Flow is a view, not an engine.** All execution lives in `@simrs-flow/workflow-core`, which runs headless in Node or the browser.
- **API-only execution.** No Playwright. The legacy userscript and Python tools proved the EvoMedis endpoints can be called directly.
- **Safety first.** Default mode is `preview` (dry-run). Mutating endpoints are allowlisted, converted to `MutationPlan`s in preview, and require explicit approval in `write` mode.
- **Two domains, one engine.** `domain-rajal` (rawat jalan) and `domain-ranap` (rawat inap) share the same core, client, and ledger.

## Dashboard operating envelope

The dashboard evolution is intentionally narrow: one dedicated Windows host, 1–5 LAN users, and one patient/episode per billing run. It is an operator dashboard around SIMRS, not a replacement medical-record system or a batch scheduler. Operators use their own EvoMedis accounts, review the final state in the SIMRS Verifikator page, and use only approved reversible compensation actions when correction is needed.

The current durable audit backend is the redacted append-only JSONL `FileLedger`. CoreUI, routed dashboard pages, a searchable catalog, SQLite, and completed Rajal production-write execution are phased work rather than current features. See [`docs/dashboard-evolution-plan.md`](docs/dashboard-evolution-plan.md) for the roadmap, Windows LAN deployment plan, ownership decisions, and acceptance criteria.

> **Ponytail:** PostgreSQL is deliberately deferred; add a database only when measured history/search, multi-host coordination, or reporting requirements justify the operational cost.

## Workspace layout

```
simrs-flow/
  apps/
    ui/             React + React Flow frontend (Vite)
    orchestrator/   Fastify REST + SSE workflow runner API
  packages/
    workflow-core/  WorkflowDefinition, event bus, reducer, runner
    evomedis-client/ Typed, safety-gated EvoMedis API client
    domain-ranap/   Rawat inap 33-step workflow, ported rules in logic/, executors
    domain-rajal/   Rawat jalan batch workflow + executors
    audit-ledger/   Redacted append-only JSONL run ledger
    test-fixtures/  Sanitized fixtures + replay helpers
  docs/             Architecture, dashboard plan, API catalog, risk register, runbook
```

## Prerequisites

- Node.js >= 20
- npm >= 9 (the repo uses npm workspaces)

## Setup

> **Launchers:** on Windows use [`run.bat`](run.bat), on Linux/macOS use
> [`run.sh`](run.sh) — run either without arguments for a menu, or with one
> command (see [Launchers](#launchers-runbat--runsh)). Both auto-install
> dependencies on first use. The steps below are the underlying npm commands,
> which work on every platform.

```bash
# 1. Install dependencies (root installs all workspaces)
npm install

# 2. Configure environment
cp .env.example .env
# edit .env — at minimum set EVOMEDIS_BASE_URL when you reach live mode

# 3. Type-check and test the engine (no SIMRS needed)
npm run typecheck
npm test

# 4. Run the UI prototype (mock event replay, no API)
npm run dev:ui

# 5. Run the orchestrator API (separate terminal)
npm run dev:orchestrator
```

The UI boots in **preview** mode and can replay a full mock rawat-inap run with zero SIMRS access.

## Run canvas (rawat jalan & rawat inap)

The Run page renders the workflow definition as a React Flow graph — it is a pure
projection of `WorkflowDefinition` + `RunState`, never a second engine.

- **Rawat jalan (rajal)** gets a deterministic **tahapan** layout on the default
  preset: the 21 real nodes are grouped into **nine labelled columns** (Persiapan,
  Tahap 1…8) with aligned headers overlaying the pane. Intra-column edges route
  top→bottom; cross-column edges keep the left→right Bezier handles. The mapping
  lives in `apps/ui/src/features/canvas/rajalPresentation.ts`. When a definition
  is not the known rajal topology the canvas falls back to the original graph and
  shows a notice — no node is ever hidden.
- **MULAI** shows a queue recap projected from the filter's
  `rajal.clinic-counts` evidence: unique patients per poli that survived the visit
  filters, with cross-poli patients counted once in the total. Before the filter
  finishes it shows a *waiting* state; a partial history read is labelled and
  never treated as complete. A missing recap is **never** rendered as zero.
- **Rawat inap (ranap)** keeps its original layout, presets, and interaction.
- Operator controls: **Center**/**Fit** frame the whole graph (Fit shows all nine
  columns), **Selected** centres the selection, **Follow** tracks the frontier and
  is unaffected by recap updates. Selecting a card keeps the inspector closed;
  the review button opens it for evidence and approvals. Approval buttons live in
  the inspector only.

The layout can be exercised offline with the replay fixture:

```ts
import { mockEventStream } from '@simrs-flow/test-fixtures';
mockEventStream(rajalWorkflow, { runId: 'demo', clinicCounts: { /* synthetic */ } });
```

## Scripts

| Command | Description |
|---|---|
| `npm run build` | Build every workspace |
| `npm run typecheck` | Project-wide TypeScript build (`tsc -b`) |
| `npm run lint` | ESLint across all packages |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run dev:ui` | Vite dev server for the React Flow UI |
| `npm run dev:orchestrator` | Orchestrator API in watch mode |

### Launchers (`run.bat` / `run.sh`)

[`run.bat`](run.bat) (Windows) and [`run.sh`](run.sh) (Linux/macOS) wrap the
npm scripts above behind a menu (no arguments) or a one-word CLI. They load
`.env`, and run `npm install` automatically when `node_modules` is missing.
On Linux, make the script executable once: `chmod +x run.sh`.

| Command (`run.bat <cmd>` / `./run.sh <cmd>`) | What it does |
|---|---|
| `install` | Install all workspace dependencies |
| `dev` | Orchestrator **and** UI together (two windows on Windows; one terminal, Ctrl+C stops both, on Linux) |
| `ui` | UI dev server only → port 5173 |
| `api` | Orchestrator only (watch) → port 4500 |
| `typecheck` / `lint` / `test` / `test:watch` | Verify |
| `livetest` | Live smoke test (`scripts/livetest.sh`; Windows needs Git Bash) |
| `build` | Build every workspace (UI bundle → `apps/ui/dist`), then clean emitted output |
| `start` | **Production:** API + UI on one port (builds first if `apps/ui/dist` is missing) |
| `clean` | Remove emitted `.js`/`.d.ts` next to source + `apps/ui/dist` |
| `free-port` | Stop whatever holds port 4500 / 5173 (asks first) |

**Develop and test need no build** — packages are consumed as TypeScript
source. Only `build` is needed for deployment (it emits the static UI bundle).
Because `tsc` emits `.js`/`.d.ts` next to source that would otherwise shadow
the `.ts` under Vitest/tsx, `build` cleans that output automatically; `clean`
does it on demand.

### Access from other PCs (LAN)

The orchestrator binds **`0.0.0.0` by default** on Windows and Linux, so other
PCs on the LAN can open it; the dev UI (Vite) listens on the LAN too. On start
it prints the addresses to use, e.g. `[orchestrator] open: http://192.168.1.50:4500/`.
The Settings & health page lists the same addresses.

- This PC only: set `ORCHESTRATOR_HOST=127.0.0.1` in `.env`.
- `QA_AUTH_TOKEN` (local QA login) never leaves the machine: with it set and
  `ORCHESTRATOR_HOST` unset the orchestrator falls back to `127.0.0.1` with a
  warning; an explicit LAN host plus a QA token refuses to start.
- Windows: allow inbound TCP 4500 in Windows Firewall (Private/LAN profile).
  Linux: e.g. `sudo ufw allow from 192.168.0.0/16 to any port 4500 proto tcp`.

### Production deploy (one port, API + UI)

```bash
cp .env.example .env        # set EVOMEDIS_BASE_URL, AUDIT_LEDGER_DIR; keep QA_AUTH_TOKEN empty
run.bat build               # Linux: ./run.sh build   (UI bundle -> apps/ui/dist)
run.bat start               # Linux: ./run.sh start   (serves API + UI on :4500)
```

Then open `http://<host-ip>:4500/` from any PC on the LAN. `start` serves the
built UI from `apps/ui/dist` through the orchestrator (no nginx needed for a
LAN pilot), so the browser talks to the API on the same origin — no CORS or
`VITE_ORCHESTRATOR_URL` setup. Set `AUDIT_LEDGER_DIR` to a persistent folder,
otherwise run history is lost on restart. To keep it running after logout,
use a Windows service wrapper (e.g. NSSM) or the systemd unit in
[`docs/deployment.md`](docs/deployment.md).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — system design and the event contract
- [`CHANGELOG.md`](CHANGELOG.md) — notable changes per release
- [`docs/dashboard-evolution-plan.md`](docs/dashboard-evolution-plan.md) — dashboard scope, roadmap, and pilot acceptance criteria
- [`docs/api-catalog.md`](docs/api-catalog.md) — EvoMedis endpoint registry
- [`docs/risk-register.md`](docs/risk-register.md) — mutation risk levels and verification rules
- [`docs/runbook.md`](docs/runbook.md) — operator runbook and recovery
- [`docs/deployment.md`](docs/deployment.md) — deployment topology, auth, and configuration
- [`docs/development.md`](docs/development.md) — contributor guide and milestone map

## Safety model (summary)

1. Startup is always **preview/dry-run**.
2. `write` mode is explicit per run and never auto-restored from saved config.
3. Mutating endpoints are **allowlisted** per workflow (enforced in the client); unknown endpoints are blocked.
4. Mutations in preview become **MutationPlan**s — nothing is sent.
5. Write requires plan **approval**, read-before-write, and read-after-write verification.
6. Users sign in with their own **EvoMedis account** (the app login *is* the EvoMedis login); that session authorizes write actions, and `critical` gates require **two-person approval**.
7. A **per-transaction lock** stops two write runs racing the same record.
8. Every run records its workflow version and an append-only audit trail.
9. PHI, credentials, and tokens are **redacted** from logs.

See `docs/risk-register.md` for the full control list.

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Free to use, modify and share for
noncommercial purposes (including hospitals and other public or charitable
organizations); selling it or using it commercially is not permitted.
