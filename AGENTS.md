# Repository Guidelines

## Project Overview

`simrs-flow` is an npm-workspace monorepo (source-available under PolyForm Noncommercial 1.0.0) that automates hospital billing operations against the **EvoMedis / SIMRS** web app (RS PKU Gombong instance) by calling its HTTP endpoints directly — **no Playwright, no userscript, no browser automation in the product**. Two domains share one headless workflow engine:

- **ranap** (*rawat inap*, inpatient) — 34-node verification (incl. the opt-in OCR `check_berkas` notice) + `tampung_bayar` workflow ported from legacy `ranap_v3.py`.
- **rajal** (*rawat jalan*, outpatient) — unpaid-bill batch workflow ported from a legacy GreasyFork userscript.

It is intentionally **safety-first**: preview (dry-run) is the default, mutations are allowlisted and plan/approve gated, critical steps need two operators, and every event is written to a redacted append-only audit ledger. The repo is pilot-stage: one Windows host, LAN-only, one patient/episode per live run.

Domain vocabulary you will meet in code: `rajal`/`ranap` (outpatient/inpatient), `kunjungan` (visit), `nomedrec`/`no RM` (medical record no.), `resep`/`obat` (prescription/drug), `penunjang` (lab/radiology), `poli` (clinic), `SEP` (BPJS claim letter), `titipan`/`kelas` (room class), `tampung bayar` (payment staging), `verifikator` (billing verification step), `visite` (doctor round), `gizi` (nutrition), `IBS` (inpatient billing).

## Architecture & Data Flow

Headless engine contract, shared by both apps and all packages:

```
WorkflowDefinition → WorkflowRunner → WorkflowEvent → Store → React Flow
```

- **Layering:** `apps/ui` (React 18 + React Flow + Zustand) speaks **HTTP/SSE only** to `apps/orchestrator` (Fastify 5). The orchestrator executes workflows **in-process** against `packages/*`. The UI never touches SIMRS or a database.
- **Single writer:** `packages/evomedis-client` (`EvoMedisClient`) is the only outbound SIMRS path, constructed with `{ mode, transport, mutationAllowlist }`. Executors never write; they emit `MutationPlan`s.
- **Single enforcement point:** `apps/orchestrator/src/mutationGate.ts` is the only place an approved mutation is applied. It re-evaluates preconditions **immediately before** the write, then replays read-after-write verification. Any unevaluable check fails closed.
- **Ledger:** `packages/audit-ledger` writes one redacted JSONL file per run (`AUDIT_LEDGER_DIR`, default `./.data/audit`). Append-only, never rewritten or truncated. If the ledger is unwritable, run creation returns HTTP 503.
- **Determinism:** executors must read time from `ctx.clock.now()` (never `new Date()`), and ids from `ctx.ids`. Tests inject a fixed clock + counter id factory.

Concrete data flow for one preview run:

1. `apps/ui/src/app/LoginGate.tsx` → `api.login()` (`apps/ui/src/api/client.ts`) → `POST /api/auth/login` → `sessions.login()` (`apps/orchestrator/src/sessions.ts`) logs into EvoMedis, captures the `ci_session` cookie, returns an opaque bearer token + HttpOnly cookie. Credentials live in RAM only.
2. UI calls `api.createRun({ workflowId, mode, input, source: 'live' })` → `POST /api/runs` → `RunService.createRun()` (`apps/orchestrator/src/RunService.ts`): resolves workflow from `registry.ts`, resolves the EvoMedis cookie, acquires a per-transaction lock (`locks.ts`, write runs only), records the run in the ledger, builds an `EventBus`, and starts a `WorkflowRunner`.
3. `packages/workflow-core/src/runner.ts` validates the DAG, walks topological order, emits `node.queued`/`node.started`, runs each executor, emits terminal status, activates edges.
4. Every event fans out to: `applyEvent` projection state, a redacted ledger append (serially chained promise), and SSE sinks (`GET /api/runs/:runId/events`).
5. UI `streamEvents` → `useRunStore.pushEvent` → `applyEvent` → canvas/inspector/console re-render. The store is a **pure projection**; it contains no business logic.
6. Approving a mutation (`POST /api/runs/:runId/mutations/:planId/approve`) → `RunService.approveMutation` → `applyApprovedMutation` (`mutationGate.ts`) → `EvoMedisClient` → SIMRS.
7. Run ends (`run.completed` / `failed` / `cancelled`), lock releases; the JSONL file is the canonical record and is exportable at `/api/runs/:runId/export.jsonl`.

**Key invariants (enforced in code, not just docs):**

- Preview by default; `EXECUTION_MODE` is deployment posture and does **not** auto-enable writes. Write runs require an authenticated operator (401 otherwise).
- Mutations fail closed at three layers: registry endpoint allowlist, `EvoMedisClient` (preview/approval/allowlist re-check), mutation gate preconditions + verification.
- Critical-risk gates/plans require 2 distinct operator approvals (`gateApprovalsRequired` / `planApprovalsRequired`).
- Cookies never authorize writes — mutations require the bearer token.
- No patient-count limit per run (rajal batches whole clinic-days); ranap stays one patient per run by its own input check. Rajal auto-fetch takes an optional `discovery.maxPatients` cap.
- `packages/evomedis-client/src/transport.ts` falls back to `FixtureTransport` so the UI works fully offline.

## Key Directories

| Path | Purpose |
| --- | --- |
| `apps/ui/src/` | React app: `app/App.tsx` shell (no router, local page state), `store/runStore.ts` (Zustand projection), `api/client.ts` (REST + SSE), `features/{canvas,panels,run,history,review,dashboard,settings}/` (presentational), `ui/primitives.tsx` |
| `apps/orchestrator/src/` | Fastify API: `main.ts` (wiring), `server.ts` (routes), `RunService.ts` (orchestration core), `registry.ts` (`WORKFLOWS`), `mutationGate.ts`, `locks.ts`, `sessions.ts`, `auth.ts`, `reloginTransport.ts`, `config.ts`, `rules.ts` (rule catalog serving), `naikKelas.ts` (IUR naik kelas logic) |
| `packages/workflow-core/src/` | Framework-agnostic engine: `types.ts` (single source of truth for all contracts), `runner.ts`, `reducer.ts`, `eventBus.ts`, `definition.ts`, `expectations.ts`, `jsonl.ts`, `ids.ts`, `reasoning.ts` |
| `packages/domain-*/src/ruleCatalog.generated.ts` | **Generated — do not hand-edit.** Rebuilt by `scripts/gen-rule-catalog.ts`; `ruleCatalog.test.ts` fails when the committed file is stale |
| `packages/evomedis-client/src/` | Typed safety-gated SIMRS client: `client.ts`, `endpoints.ts` (registry + `isMutating`), `errors.ts`, `session.ts`, `transport.ts` (`FetchTransport`, `FixtureTransport`), `parsers.ts` |
| `packages/domain-ranap/src/` | Inpatient workflow (`workflow.ts`), I/O shell (`executors.ts`, very large), pure decision rules in `logic/*.ts` (co-located `*.test.ts`) |
| `packages/domain-rajal/src/` | Outpatient batch workflow + `legacyConfig.ts` (ported verdicts/config) |
| `packages/audit-ledger/src/` | `ledger.ts` (`Ledger`, `FileLedger`, `MemoryLedger`), `redaction.ts` (isomorphic subpath export), `history.ts` (JSONL replay validation) |
| `packages/test-fixtures/src/` | Synthetic EvoMedis fixtures (`ranap.ts`, `rajal.ts`) + `mockEvents.ts` (`mockEventStream`) |
| `scripts/` | Dev/pilot/QA helpers, invoked directly (not npm scripts) — see below |
| `docs/` | Architecture, API catalog, risk register, runbook, parity specs against legacy code |

## Development Commands

Requires **Node >= 22 and npm >= 9**. Dev and test consume package TypeScript source via aliases, so **no build is needed** for daily work (only deployment builds the UI).

```bash
npm install                     # root; installs all workspaces
cp .env.example .env            # set EVOMEDIS_BASE_URL before live mode

npm run dev:ui                  # Vite UI on http://localhost:5173 (proxies /api → 127.0.0.1:4500)
npm run dev:orchestrator        # Fastify API on ORCHESTRATOR_PORT (default 4500), tsx --watch

npm run typecheck               # tsc -p tsconfig.json (noEmit)
npm run lint                    # eslint . --ext .ts,.tsx
npm test                        # vitest run
npm run test:watch              # vitest
npm run build                   # all workspaces; UI bundle → apps/ui/dist
npm run clean
```

Single test / coverage (no npm script wrappers):

```bash
npx vitest run packages/domain-ranap/src/logic/sep.test.ts
npx vitest run -t '<test name>'
npx vitest run --coverage
```

Windows helpers — `run.bat` wraps everything (`install|dev|ui|api|typecheck|lint|test|test:watch|livetest|build|start|clean|free-port`), auto-installs deps and loads `.env`; `run.bat build` additionally deletes emitted `.js`/`.d.ts` next to source (they would otherwise shadow `.ts` under Vitest/tsx).

Regenerate the rule catalog after editing any executor (`executors.ts`); the domain test fails until you do:

```bash
node --import tsx scripts/gen-rule-catalog.ts
```

Live harnesses (hit the real EvoMedis host, never part of `npm test`):

```bash
bash scripts/livetest.sh                                                   # E2E smoke vs mock login server
node --import tsx scripts/ranap-live-validate.ts <user> <pass> [noRm] [tgl] # read-only inpatient validation
node --import tsx scripts/rajal-live-validate.ts <user> <pass> [from] [to] [maxPerPoli]
node --import tsx scripts/pilot-live-write.ts                              # guarded single-patient live WRITE
```

## Code Conventions & Common Patterns

**Formatting & naming** — TypeScript + ES modules, 2-space indent, explicit exports, small focused modules. `camelCase` for variables/functions, `PascalCase` for types/classes/components, packages under `@simrs-flow/*`. Conventional Commits (`feat:`, `fix:`), imperative subjects.

**ESM specifics** — `type: module` everywhere and `verbatimModuleSyntax: true`: relative imports between `.ts` files need an explicit **`.js`** extension, and type-only imports must use `import type`.

**Error handling — two deliberate idioms:**
- Domain/client throws **typed error classes** (`packages/evomedis-client/src/errors.ts`: `EvoMedisError`, `UnknownEndpointError`, `MutationBlockedInPreviewError`, `MutationNotApprovedError`, `MutationNotAllowlistedError`, `SessionExpiredError`, `LoginFailedError`, `UnexpectedResponseError`, `TransportError`).
- Executor outcomes are **result objects, not exceptions** (`StepResult { status, summary, issues }`, `StepStatus = success|failed|skipped|blocked|needs_review`). Runner-level failures emit `run.failed` instead of rejecting the HTTP request.
- HTTP errors in the orchestrator are ad hoc: `httpError(statusCode, message)` assigns `statusCode` onto an `Error`.

**Async** — `async/await`; ledger appends are chained to preserve order and isolate failures; `AbortController`/`AbortSignal` for cancellation; SSE reconnect with backoff in `apps/ui/src/api/client.ts`.

**Dependency injection** — no container. Constructor injection and factory functions: `new RunService(ledger, options)`, `buildExecutors(args)` / `createClient(args)` in `registry.ts`, injected `Clock`/`IdFactory`. Tests exploit the same seams (optional `transport`, `workflows`, `registry` parameters).

**State management** — Zustand single store (`useRunStore`), event-sourced: `pushEvent` folds through the same `applyEvent` reducer used by the engine and orchestrator. No Redux, no Context for run state, no router.

**Validation** — no schema library (no zod/yup/joi/valibot). Validation is hand-rolled: `validateDefinition` (workflow-core), `parseLedgerHistory` field/schema/seq checks (audit-ledger), endpoint registry lookups, tolerant comparison in `expectations.ts`.

**Module layout** — `index.ts` barrel per package; pure decisions live in `logic/*.ts` while the executor file is deliberately a thin I/O shell. Comments carry rationale and legacy citations (e.g. `ranap_v3.py:15371`) — keep them when porting.

**Safety rules for new code:**
- New endpoint → add to `packages/evomedis-client/src/endpoints.ts`; unknown endpoints are blocked.
- New domain → register in `apps/orchestrator/src/registry.ts` and add the UI picker in `apps/ui/src/app/App.tsx`.
- New package alias → add it in **all three** places: `tsconfig.base.json` paths, `vitest.config.ts` aliases, `apps/ui/vite.config.ts` aliases.
- Redact before persisting/logging anything from SIMRS (use `@simrs-flow/audit-ledger/redaction`).
- QA-only knobs (`QA_AUTH_TOKEN`, `QA_AUTH_OPERATOR`, `VITE_QA_AUTH`) must never be enabled in production.
- Deferred work is marked with `Ponytail:` comments; `grep -rn 'ponytail:'` is the backlog.

## Important Files

- `package.json` / `tsconfig.base.json` / `tsconfig.json` — workspaces, scripts, path aliases, strictness.
- `vitest.config.ts` — the only test config (root; aliases + coverage).
- `.eslintrc.cjs` — ESLint (classic config; `no-explicit-any` and `no-console` are off, `no-unused-vars` warns with `^_` ignores).
- `.env.example` — every supported env var (`ORCHESTRATOR_PORT`, `ORCHESTRATOR_HOST`, `ORCHESTRATOR_CORS_ORIGINS`, `EVOMEDIS_BASE_URL(_V2)`, `EVOMEDIS_SESSION_COOKIE_NAME`, `EVOMEDIS_TIMEOUT_MS`, `EXECUTION_MODE`, `AUDIT_LEDGER_DIR`, `DEBUG_HTTP`, `VITE_ORCHESTRATOR_URL`, `UI_DIR`, `PILOT_*`, `QA_*`). `EVOMEDIS_SESSION_COOKIE` and `QA_AUTH_TOKEN` are secrets.
- `.github/workflows/ci.yml` — the only CI: Node 22, `npm ci → typecheck → lint → test → build`.
- `run.bat` — Windows launcher/menu.
- `apps/orchestrator/src/{main,server,RunService,mutationGate,registry}.ts` — API entry, routes, orchestration core, the only write path, workflow registry.
- `packages/workflow-core/src/types.ts` — the authoritative contract (definitions, plans, preconditions, verification rules, `WorkflowEvent` schema `simrs.workflow.event.v1`).
- `packages/evomedis-client/src/transport.ts` — `FetchTransport` / `FixtureTransport` (the universal HTTP stub).
- `docs/architecture.md` — layers, package responsibilities, event contract, REST/SSE API, auth, single-host boundary.
- `docs/api-catalog.md` — 142-entry EvoMedis endpoint registry (2 auth / 111 read / 29 mutate).
- `docs/risk-register.md` — mutation risk scoring, per-endpoint preconditions and read-after-write rules.
- `docs/runbook.md` — operator procedures, kill switch, error→fix table. `docs/development.md` — contributor guide and "add a domain" steps.
- `docs/legacy/{ranap,rajal}-parity.md` — read before assuming a legacy step is implemented; they document deliberate gaps.
- `docs/superpowers/{specs,plans}/` — dated design specs and implementation plans (newest work, e.g. `run-log-mode-plan.md`). Check for an existing plan before designing a feature from scratch.

**Known placeholders — do not mistake for real data:** `/api/billing/summary` and `/api/patients` return deterministic demo values, and presence/sticky-notes state is process-memory only. Dashboard numbers are mock.

## Runtime/Tooling Preferences

- **Node.js >= 22, npm >= 9, npm workspaces.** No Bun, pnpm, or yarn — the lockfile is `package-lock.json` (v3) and there is no `packageManager` field.
- **No Docker** (no Dockerfile/compose). **No bundler except Vite**, and Vite is used for the UI and dev server only; the orchestrator runs unbundled through `tsx` (`node --import tsx src/main.ts`).
- **No codegen, no migrations, no seeding** — the only persistence is the append-only JSONL ledger. PostgreSQL is explicitly deferred.
- TypeScript is strict: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`; `moduleResolution: Bundler`.
- Build order follows tsconfig `references` (`tsc -b` per package): `workflow-core → audit-ledger → evomedis-client → {domain-ranap, domain-rajal, test-fixtures}`, then apps. Package output goes to `packages/*/dist`.
- Ports: orchestrator `4500` (bind `127.0.0.1`), UI dev `5173` (strictPort, proxies `/api`), livetest smoke `4711`, mock login server `4799`.
- One Windows host may serve the built UI and the orchestrator on a single port via `UI_DIR` + `@fastify/static`.

## Testing & QA

- **Vitest ^1.6.0**, configured solely by root `vitest.config.ts`: `globals: true`, `environment: 'node'`, include `packages/**/*.test.ts` and `apps/**/*.test.ts`. There is **no** setup file and **no** separate UI test config.
- **Convention: co-located `*.test.ts` beside the module under test.** No `__tests__/` folders and no `.spec.ts` files exist; because `include` matches only `*.test.ts` (and not `*.tsx`), there are effectively **no component/DOM tests** — UI logic is tested through exported pure helpers (`app.test.ts` covers `gateActionError`, `liveStartBlockerOf`, `currentNodeOf`, `buildRanapInput`, …).
- **`@simrs-flow/test-fixtures` is the shared fixture package.** It exports `ranapFixtures` / `rajalFixtures` (maps keyed by endpoint id), named inputs (`RANAP_HAPPY_INPUT`, `RANAP_DEBUG_INPUT`, `RAJAL_HAPPY_INPUT`, …), scenario overrides + expected constants, legacy report HTML, and `mockEventStream()` for deterministic offline replay. Reuse it instead of inventing new fixtures.
- **Mocking:** no msw, nock, supertest, or snapshots. HTTP is stubbed by `FixtureTransport` (records calls in `.calls`; `404` for unregistered endpoint ids) — assert request shape against `.calls`, since fixtures are keyed by endpoint id and do not prove request correctness. The orchestrator is tested in-process with Fastify `app.inject()`; time is controlled with `vi.useFakeTimers()`; failures with `vi.spyOn`. UI tests use hand-rolled `sessionStorage`/`fetch`/`FakeEventSource` shims, keeping the suite jsdom-free.
- **Deterministic tests only** — never call live external services in unit tests. Live validation lives in `scripts/*-live-validate.ts` / `scripts/livetest*.sh` / `scripts/pilot-live-write.ts` and is run manually.
- **Coverage** is configured (v8, `text` + `html`) but has no thresholds and no npm script; CI does not run it. `npx vitest run --coverage` when needed.
- CI (`.github/workflows/ci.yml`) runs on push/PR to `main`: `npm ci → npm run typecheck → npm run lint → npm test → npm run build`.
- Before handing off a change: `npm run typecheck && npm run lint && npm test` (and `npm run build` if the UI bundle or workspace build is affected). Never commit build output or a populated `.env`.

## Commit & Pull Request Guidelines

Conventional Commit subjects, imperative and specific (e.g. `fix: accept evomedis root base url`). PRs should include a short summary, linked issue/context, the validation commands you ran, and screenshots or logs for UI/API behavior changes; call out any `.env` additions and never commit credentials, session data, production URLs, or patient data. Treat changes to the mutation gate, allowlist, ledger, and redaction as security-sensitive.
