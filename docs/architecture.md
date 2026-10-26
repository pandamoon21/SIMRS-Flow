# Architecture

SIMRS-Flow rewrites the EvoMedis automation helper around one contract:

```
WorkflowDefinition → Runner → WorkflowEvent → Store → React Flow
```

Everything else follows from keeping that pipeline clean. The runner never
touches the UI; the UI is a pure projection of an event stream; the same
reducer runs in the engine, the orchestrator, and the browser.

## Layers

```
 ┌─────────────────────────────────────────────────────────────┐
 │ apps/ui  (React + React Flow)                                 │
 │   Zustand store ← reducer ← WorkflowEvent (SSE or mock)       │
 └───────────────▲───────────────────────────────┬──────────────┘
                 │ REST commands                  │ SSE events
 ┌───────────────┴───────────────────────────────▼──────────────┐
 │ apps/orchestrator  (Fastify)                                  │
 │   RunService: EventBus → ledger + SSE fan-out, gate resolver  │
 └───────────────▲───────────────────────────────┬──────────────┘
                 │ runWorkflow()                  │ events
 ┌───────────────┴───────────────────────────────▼──────────────┐
 │ packages/workflow-core  (headless engine)                     │
 │   WorkflowDefinition · EventBus · reducer · WorkflowRunner    │
 └──▲─────────────▲────────────────────────────────▲────────────┘
    │             │                                 │
 domain-ranap  domain-rajal                   evomedis-client
 (33 steps)    (patient processor)            (safety-gated API)
                                                     │
                                              audit-ledger
                                              (redaction + JSONL)
```

## Packages

| Package | Responsibility | Runtime |
|---|---|---|
| `workflow-core` | Types, event bus, reducer, DAG validation, runner, JSONL replay | isomorphic |
| `evomedis-client` | Endpoint registry, safety-gated requests, parsers, transport | isomorphic |
| `audit-ledger` | Redaction (`/redaction` subpath is browser-safe) + append-only ledger | redaction: isomorphic; ledger: Node |
| `domain-ranap` | 33-step inpatient workflow, ported business rules in `logic/`, executors | isomorphic |
| `domain-rajal` | Outpatient batch workflow, per-record validators, executable mutation-plan executors | isomorphic |
| `test-fixtures` | Sanitized fixtures + mock event player | isomorphic |
| `apps/orchestrator` | Fastify REST + SSE over the engine | Node |
| `apps/ui` | React Flow canvas, inspector, console, replay, CoreUI Run/History shell | browser |

## Dashboard target architecture

The dashboard adds presentation and operational pages around the current engine;
it does not move workflow execution into React or replace the event contract.

```text
[ operator browser on LAN ]
          │ HTTPS (required before production; trusted-LAN HTTP only as an explicit pilot exception)
          ▼
[ dashboard shell ] ── REST commands + SSE run detail ──► [ orchestrator on one Windows PC ]
      │                                                       │
      │ CoreUI layout                                        ├─ per-user EvoMedis session
      │ React Flow run view                                  ├─ WorkflowRunner + domain executors
      │ Zustand event projection                             ├─ locks, gates, cancellation
      │                                                       ├─ redacted FileLedger JSONL
      │                                                       ▼
      └──────────────────────────────────────────────────── [ EvoMedis / SIMRS ]
```

The initial operating boundary is **one patient/episode per run** for repetitive
billing work. The operator selects the patient/episode, runs preview or an
approved write mode, and manually checks the final state in the SIMRS Verifikator
page. Automatic per-patient mode is planned convenience behavior, not batch
scheduling; it must retain allowlists, exact action identity, locks, audit,
cancellation, and final manual review.

CoreUI is the minimal presentation shell for Run and History views. The existing
`LoginGate`, React Flow canvas, Zustand store, shared reducer, node inspector,
run console, and SSE stream remain the reusable implementation. The UI has no
router yet. A searchable run catalog and SQLite index are planned only if
JSONL-backed history becomes insufficient; PostgreSQL is not required for the
first single-host, 1–5-user deployment.

SIMRS reversal actions are compensating mutations, not permission to skip
controls. A compensation must target the exact transaction/action ID created by
the run, re-check the patient/episode identity and allowed status, and verify the
resulting Verifikator state. Ambiguous ownership, parser drift, timeout, or a
mismatch stops the run for manual review. Hospital-specific or irreversible
financial reversal procedures remain outside generic automatic rollback.

See [`dashboard-evolution-plan.md`](dashboard-evolution-plan.md) for the phased
roadmap and [`deployment.md`](deployment.md) for the Windows LAN pilot.

## Current versus planned dashboard pieces

| Capability | Current state | Planned direction |
|---|---|---|
| Workflow execution | Headless runner, event contract, REST/SSE | Preserve unchanged |
| Detailed run view | React Flow canvas, inspector, console, replay | Embed as the Run page |
| Dashboard navigation | Local Run/History switch; no router | Add pages only when needed |
| UI shell | CoreUI structural shell over existing CSS | Polish incrementally; do not copy the full demo template |
| Run history | Active memory plus validated JSONL-backed summaries/replay/export | Add an index only if measured scan cost requires it |
| Rajal billing writes | Validation, per-record pruning, and executable mutation plans exist | Prove approved write/verification path in a controlled pilot |
| Patient data | SIMRS remains source of truth | Store minimum references, not a local PHI mirror |

## Data and deployment boundary

One Windows PC may serve the built static UI and orchestrator on the same port.
The host owns the EvoMedis calls and audit files; browsers never call SIMRS
directly. Per-user credentials and session cookies stay in orchestrator memory,
while redacted events are appended to the configured `AUDIT_LEDGER_DIR`. A
restart clears active sessions, locks, gates, and in-memory active run state;
completed terminal runs are reconstructed lazily from the audit ledger, while
interrupted runs are not resumed.

For the first LAN pilot, bind only to the trusted network, restrict the Windows
Firewall rule to the LAN subnet, use a persistent audit directory, and keep QA
authentication disabled. Login credentials cross the network, so HTTPS with an
internally trusted certificate is required before production use.

## The event contract

Every state change is a `WorkflowEvent` with a stable envelope
(`schema`, `eventId`, `seq`, `ts`, `runId`, `workflowId`, `workflowVersion`,
`type`, `source`). The bus stamps the envelope; callers supply only the payload.
Because state is a fold over events:

- **Replayable** — JSONL log → reducer → identical RunState.
- **Auditable** — the ledger is the event log, redacted.
- **Testable** — no UI or network needed to assert engine behavior.

The reducer (`reduceEvents`) is the single projection used by the engine
(for its own RunResult), the orchestrator (for `GET /api/runs/:id`), and the UI
store. There is exactly one implementation.

### Step reasoning (operator checklists)

Every executor-run step attaches a checklist of the decisions it actually made,
as ordinary evidence labelled `reasoning` (`packages/workflow-core/src/reasoning.ts`:
`reasoningEvidence`, `reasoningOf`). No new event type — it flows through the
stream, ledger and replay like any other evidence.

- Each item is `ok: true` (met), `false` (not met) or `null` (informational).
  Unread data is `false`/`null` with the reason, never a guessed ✓.
- An item fixed by a write carries the plan's `planId`; the UI shows it turning
  from ✗ into ✓ once that plan is verified (e.g. visite DPJP per day).
- Ranap builds checklists inline per step. Rajal wraps its registry once
  (`withRajalChecklists` in `packages/domain-rajal/src/executors.ts`): a step
  without its own checklist gets one from the records it kept/dropped and the
  plans it proposed.
- Coverage tests ("ranap checklist coverage", "rajal checklist coverage") fail
  when a step that ran carries no checklist. Gates are exempt — the runner
  resolves them.

## UI presentation layer

`apps/ui` is still a pure projection, but rawat jalan gets a second, purely
presentational mapping on top of the projection:

- `apps/ui/src/features/canvas/rajalPresentation.ts` maps the 21 real rajal node
  ids onto nine labelled tahapan columns, computes deterministic card geometry,
  and validates the `rajal.clinic-counts` evidence emitted by the filter
  executor. It reads `RunState` only — never the full event stream — so a replay
  seek backwards drops future evidence correctly.
- Node ids, `executorRef`, mutation ownership, and the JSONL export are
  unchanged; the mapping only overrides label/position/description in the UI.
- The recap on MULAI is derived from filter evidence, not from a second request:
  unique patients per poli after the visit filters, one cross-poli patient
  counted once per poli but once in the total. Unreadable history makes the
  recap `complete: false` and is labelled partial; absent evidence is shown as
  *waiting* or *unavailable*, never as zero.
- Rawat inap and any unrecognised rajal definition keep the original graph.

## The runner

`WorkflowRunner.run()`:

1. validates the definition (DAG, no dangling edges, executors resolve);
2. computes a deterministic topological order (ties broken by declaration order,
   matching the legacy pipeline sequence);
3. for each enabled node: emits `node.queued`/`started`, runs the executor,
   emits the terminal status, activates outgoing edges;
4. `gate` nodes defer to a `GateResolver` (auto-hold in preview);
5. `mutate` nodes in preview surface `MutationPlan`s — they never write;
6. critical-node failure/block ends the run; benign `skipped` does not block
   downstream.

Determinism comes from an injectable `Clock` and `IdFactory`. Tests use a
`fixedClock` + counter id factory to get byte-identical event streams.

## Execution modes

- **preview** (default everywhere): reads run; mutating endpoints are blocked
  at the client (`MutationBlockedInPreviewError`) and represented as plans.
- **write**: mutating endpoints allowed only with explicit per-call approval
  and only if on the workflow's `mutationAllowlist`; gates await an operator.

Mode is never auto-restored from saved config. A run records its mode and
workflow version in its first events.

## Orchestrator API

```
POST /api/auth/login                        { username, password } -> { token, operator }
POST /api/auth/logout
GET  /api/auth/me
GET  /api/health
GET  /api/workflows
GET  /api/workflows/:workflowId
GET  /api/rajal/unpaid?from&to[&instalasi&penjamin&unit]  (read-only; live session; unpaid-bill report → { patientIds, clinics, clinicsByPatientId, total })
GET  /api/ranap/discharged?from&to[&masukFrom&masukTo&verifikasi&bayar&kelPenjamin]  (read-only; live session; laporan pasien keluar → { rows })
GET  /api/naik-kelas                          (read; stored iur naik kelas snapshot + refresh status; never fetches unless no snapshot exists)
POST /api/naik-kelas/refresh                  (bearer; re-read the Google Sheets CSV export now)
POST /api/naik-kelas/source                   { source } (bearer; change the sheet link — Google Sheets only — and re-read)
POST /api/runs                              { workflowId, mode?, input?, enabled?, source? }
GET  /api/runs
GET  /api/runs/:runId
GET  /api/runs/:runId/events                (SSE)
POST /api/runs/:runId/cancel
POST /api/runs/:runId/pause                 (parks before the next step; 409 if not running)
POST /api/runs/:runId/resume                (409 if not paused)
POST /api/runs/:runId/gates/:nodeId/approve
POST /api/runs/:runId/gates/:nodeId/reject
POST /api/runs/:runId/mutations/:planId/approve   (bearer only; runs the mutation gate)
GET  /api/runs/:runId/export.jsonl
```

REST is used for commands, SSE for the event stream. Each run owns an
`EventBus`; `RunService` subscribes once and fans every event out to the audit
ledger (redacted) and connected SSE clients. New subscribers get full history
before live events. Historical terminal runs replay validated ledger events and
then close; corrupt/interrupted/version-mismatched files remain exportable but
fail closed for detail/SSE replay.

**Unified auth.** A successful EvoMedis login (`POST /api/auth/login`) is the
app login: the orchestrator logs into SIMRS with the user's credentials,
captures their `ci_session`, and issues a session token plus an HttpOnly app
cookie. Protected workflow/run reads, history export, `/api/auth/me`, and SSE
accept the bearer token or same-origin cookie. Creating a `write` run,
approving/rejecting a gate, and cancelling a write run require the bearer token
(`Authorization: Bearer`). The cookie never authorizes writes.

The operator (EvoMedis username) is recorded in run audit metadata. Critical
gates require two distinct operators (two-person rule), and a write run holds a
per-transaction lock so two runs cannot race one record. `source: "live"` runs
call SIMRS through `FetchTransport` using the logged-in user's cookie (auto
re-login on expiry); `source: "fixture"` (default) replays canned data.
Credentials live in orchestrator memory only.

## Why no Playwright / browser automation

The legacy userscript and Python tool proved the EvoMedis endpoints are directly
callable. API-only execution is faster, testable with fixtures, and auditable.
The legacy tools remain behavior oracles, not the product.

## Extending the system

- **New endpoint**: add to `evomedis-client/endpoints.ts` (+ contract test).
  Unknown endpoints are blocked.
- **New workflow node**: add to the domain `workflow.ts` and an executor in
  `executors.ts`; the executor ref must resolve in the registry.
- **New domain**: add a package exporting a `WorkflowDefinition` and executor
  factory; register it in `apps/orchestrator/src/registry.ts`.
- **New renderer**: consume `RunState` from the reducer. The contract is the
  event stream, so the renderer is replaceable.

See `development.md` for the milestone map and `risk-register.md` for the
safety controls.
