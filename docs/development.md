# Development Guide

## Prerequisites

- Node.js >= 20, npm >= 9 (npm workspaces).

## Install & run

```bash
npm install

# engine + everything, headless (no SIMRS needed)
npm run typecheck
npm test

# UI prototype with offline mock replay (no backend)
npm run dev:ui          # http://localhost:5173

# orchestrator API (separate terminal)
npm run dev:orchestrator # http://localhost:4500
```

In the UI, **Offline (mock replay)** runs the full 33-step canvas with no
backend. **Live (orchestrator)** talks to the running API.

## Layout

```
packages/   workflow-core, evomedis-client, audit-ledger,
            domain-ranap, domain-rajal, test-fixtures
apps/       orchestrator (Fastify), ui (React Flow)
docs/       architecture, api-catalog, risk-register, runbook, deployment
```

## How workspace resolution works

Packages are consumed **as source** during dev/test/build via path aliases,
so there is no build-before-test step:

- TypeScript: `paths` in `tsconfig.base.json`.
- Vitest: `resolve.alias` in `vitest.config.ts`.
- Vite (UI): `resolve.alias` in `apps/ui/vite.config.ts`.

The browser-safe `redact` lives at `@simrs-flow/audit-ledger/redaction` so
the UI bundle never imports `node:fs`. Keep that boundary: anything the UI or
client touches must not import the Node ledger directly.

## Commands

| Command | What |
|---|---|
| `npm run typecheck` | Single-pass `tsc` over all packages + apps (no emit) |
| `npm test` | Vitest across packages + apps |
| `npm run test:watch` | Vitest watch |
| `npm run build` | Build every workspace (UI emits a bundle) |
| `npm run lint` | ESLint |

## Testing strategy

- **Unit** — reducer, runner, parsers, redaction, normalizers.
- **Contract** — `evomedis-client` against `FixtureTransport`: valid, empty,
  malformed JSON, login page, PHP error, unknown endpoint, preview-block.
- **Dry-run integration** — full workflow runs against fixtures asserting
  *no mutating endpoint is ever sent* and gates hold in preview.
- **Replay determinism** — JSONL round-trip reduces to identical state; two
  deterministic runs produce byte-identical streams.
- **API** — orchestrator via `app.inject`: lifecycle, audit persistence,
  export.
- **UI store** — event projection + replay scrubbing.

Add a fixture for every bug before fixing it (golden-master discipline).

## Milestone map

| Milestone | Package(s) | State |
|---|---|---|
| 1 Visual prototype + core | workflow-core | ✅ |
| 2 Client + ledger | evomedis-client, audit-ledger | ✅ |
| 3 Ranap + rajal dry-run | domain-ranap, domain-rajal, test-fixtures | ✅ |
| 4 Orchestrator | apps/orchestrator | ✅ |
| 5 React Flow UI | apps/ui | ✅ |
| 6 Write gate | operator auth, allowlist enforcement, per-tx lock, two-person approval, live transport | ✅ |
| 7 Pilot | shadow mode, limited write, runbook | guarded harness + docs ready; live proof/manual comparison pending |

## Dashboard foundation checkpoint

The first dashboard foundation is implemented: CoreUI Run/History shell,
authenticated workflow/run reads and SSE, cookie-based browser read transport,
and restart-aware redacted JSONL history metadata/detail/export. Continue from
[`dashboard-foundation.md`](dashboard-foundation.md); it records exact contracts,
focused verification commands, deliberate deferrals, and the next phase order.

## Dashboard roadmap

The dashboard work is phased around the existing engine rather than replacing
it. See [`dashboard-evolution-plan.md`](dashboard-evolution-plan.md) for the
operating envelope, ownership decisions, Windows LAN deployment, and full
acceptance criteria.

| Phase | Deliverable | Acceptance |
|---|---|---|
| 0 | Named operational, host, network/IT, data, and escalation owners | One-patient-per-run scope and retention/backup decisions are written down |
| 1 | Offline CoreUI shell around the current run console | Fixture login/run/replay works without SIMRS and the safety boundary is visible |
| 2 | One Windows host serves the built UI + API to a second LAN PC | Fixture preview, authenticated reads/SSE, per-user auth, and redacted JSONL audit work from the second PC |
| 3 | Dashboard history/run detail and a durable catalog decision | Restart behavior is documented; JSONL replay remains authoritative |
| 4 | One-patient Rajal billing write pilot | Mutation identity, preconditions, verification, and compensation are tested |
| 5 | Automatic per-patient mode | Scope, kill switch, audit, final Verifikator review, and timeout/reversal tests pass |
| 6 | HTTPS, restart supervision, restore drill, and access review | Operational owner signs off on production controls |

Current implementation gaps that must remain explicit:

- the UI has no router or deep-link history URLs yet;
- active sessions, locks, gates, SSE subscribers, and in-flight event state are process-local;
- `FileLedger` JSONL is the implemented durable audit backend; SQLite and
  PostgreSQL are not implemented;
- the Rajal billing path currently generates executable mutation plans, but its
  approved production write/verification path still needs a live one-patient pilot.

## Documentation consistency checklist

Before merging documentation or deployment changes:

- every command exists in `package.json`, a workspace script, or `run.bat`;
- every environment variable exists in `.env.example` or is explicitly marked
  planned;
- host binding, port, CORS, static UI serving, and build-time UI URL claims
  match `apps/orchestrator/src/main.ts`, `server.ts`, and `config.ts`;
- auth, locks, gates, SSE, audit, and redaction claims match the implementation;
- routing, SQLite, searchable indexing, and completed Rajal writes are labeled
  planned until code and tests exist; CoreUI/history/auth claims match current code;
- no document promises live SIMRS success from fixture or unit tests;
- deployment claims are verified from a second LAN PC before pilot sign-off.

## Coding conventions

- TypeScript strict, ESM, `verbatimModuleSyntax`. Use `.js` extensions in
  relative imports (NodeNext/Bundler ESM).
- No `Date.now()`/`Math.random()` in engine code paths that must replay —
  inject a `Clock`/`IdFactory`.
- Mutating executors return `MutationPlan`s; they never call the network in
  preview.
- Never log raw responses; log redacted `CallRecord`s.

## Adding a workflow

1. Create `packages/domain-x` exporting a `WorkflowDefinition` and a
   `createXExecutors({ client })` factory.
2. Register it in `apps/orchestrator/src/registry.ts`.
3. Add fixtures + a dry-run integration test proving preview never writes.
4. Add the workflow to the UI picker in `apps/ui/src/app/App.tsx`.
5. Give every step an operator checklist (`reasoningEvidence` from
   `@simrs-flow/workflow-core`, see `docs/architecture.md` "Step reasoning") and
   a coverage test like "rajal checklist coverage". After changing executors,
   run `node --import tsx scripts/gen-rule-catalog.ts` — the generated rule
   catalog test fails otherwise. The generator treats any `'domain.name'`
   property in the executor file as a registry entry, so do not use that key
   shape for helper maps.
