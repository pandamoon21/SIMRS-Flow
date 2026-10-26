# Dashboard Evolution Plan

## Executive summary

SIMRS-Flow already has the correct execution boundary for a LAN dashboard:

```text
WorkflowDefinition → Runner → WorkflowEvent → Store → React Flow
```

The next step is not a rewrite. It is to add a dashboard shell and operational pages around the existing workflow console while preserving the headless engine, the orchestrator, the event contract, and the safety controls.

The initial operating envelope is deliberately small:

- one dedicated Windows PC hosts the application;
- 1–5 authenticated users access it over the hospital LAN;
- one run processes one patient/episode at a time;
- the tool reduces repetitive billing work; it does not replace SIMRS;
- operators still review the result in the SIMRS Verifikator page;
- reversible SIMRS actions may be compensated, but compensation must target the exact transaction/action identity;
- JSONL remains the authoritative audit record;
- PostgreSQL is not part of the first deployment.

> **Current-state note:** The first CoreUI Run/History shell, authenticated workflow/run reads and SSE, and JSONL-backed history metadata/detail/export are implemented. A multi-page router, SQLite/search index, automatic per-patient mode, and completed Rajal production write execution remain planned work. See [`dashboard-foundation.md`](dashboard-foundation.md) for the continuation checkpoint and exact current contracts.

## Goals

1. Give operators a clear dashboard for starting and monitoring one-patient billing runs.
2. Keep the existing React Flow canvas as the detailed workflow view.
3. Provide an obvious distinction between preview, confirmed write, and automatic per-patient operation.
4. Preserve per-user EvoMedis attribution, auditability, mutation allowlists, locks, gates, verification, and cancellation.
5. Deploy the first pilot on one Windows PC without introducing unnecessary infrastructure.
6. Store only the minimum local references needed to operate and audit a run.

## Non-goals

- Replacing SIMRS or becoming a second medical-record system.
- Mirroring complete patient or clinical data locally.
- Automating batches of patients or introducing a batch scheduler.
- Exposing the application to the public internet.
- Adding PostgreSQL before measured scale, reporting, or high-availability requirements exist.
- Treating a successful HTTP response as proof that a business mutation completed correctly.
- Bypassing manual Verifikator review, endpoint allowlists, transaction locks, or read-after-write verification.

## Users and responsibilities

| Role | Responsibility |
|---|---|
| Operator | Logs in with their own EvoMedis account, starts one-patient runs, reviews plans/results, and performs the final Verifikator check. |
| Supervisor/auditor | Reviews exceptional runs, corrections, exports, and access/retention decisions. |
| Operational owner | Approves the pilot scope, owns the process, and decides when automatic per-patient mode may be used. |
| Host owner | Maintains the Windows PC, application process, local data directory, and backup procedure. |
| Network/IT contact | Approves LAN access, firewall rules, IP/DNS, certificates, and any startup supervision. |
| SIMRS/data owner | Approves the data fields, endpoint contracts, retention, and reversal procedures. |

The operational owner, host owner, and escalation contacts must be named before live write use. A developer or operator should not silently become the owner of billing risk.

## Target information architecture

### 1. Dashboard / home

Shows only useful operational information:

- active runs and their statuses;
- recent completed, failed, cancelled, and needs-review runs;
- operator and workflow labels;
- a direct link to each run detail page;
- service health and a clear indication when the host is unavailable.

The first version can use the existing `GET /api/runs` endpoint and in-memory active-run list. Durable history after a process restart requires a later catalog/replay improvement.

### 2. Start billing run

The start page should make scope explicit before the run begins:

- exactly one patient/episode identifier;
- the selected workflow and version;
- source (`fixture` for development, `live` for approved pilot use);
- mode (`preview`, `write/confirmed`, or controlled `automatic per-patient`);
- a confirmation summary showing the patient/episode reference and intended workflow;
- a visible warning that the run does not process other patients.

Patient identifiers should not be persisted in browser local storage. The server-side audit should retain only the minimum reference required by the approved retention policy.

### 3. Run detail

Reuse the current operator console:

- React Flow canvas for node status;
- node inspector for plans, warnings, issues, and gates;
- run console for event/log summaries;
- SSE for live updates;
- replay/export for audit and troubleshooting;
- cancellation as the kill switch.

The event stream remains the source of truth. The dashboard must not create a second state model that can disagree with the reducer.

### 4. Verifikator/result review

The result page is a focused checklist, not a replacement for SIMRS:

- patient/episode identity;
- actions attempted and exact IDs returned;
- expected final status;
- actual status read from the Verifikator endpoint/page;
- any compensation action available for the exact created transaction/action;
- operator confirmation that the SIMRS page was checked.

If the Verifikator is read through HTML, the parser must be protected by sanitized fixtures and assert-based contract tests. An unexpected page structure must stop the run rather than produce a guessed success.

### 5. Audit/history

The first history surface can expose run summaries and JSONL export. The authoritative audit is the redacted append-only ledger under `AUDIT_LEDGER_DIR`.

A searchable catalog is future work. First try replaying/scanning JSONL. Add a small local SQLite index only when measured search requirements justify it. Keep JSONL authoritative even if an index is added.

### 6. Settings and health

Expose non-secret operational information only:

- workflow versions;
- current service health;
- configured execution posture;
- audit directory status;
- build/version information.

Never display passwords, session cookies, bearer tokens, or raw SIMRS responses.

## UI architecture decision

Use CoreUI incrementally as a presentation shell around the current UI:

- keep `LoginGate` outside the authenticated shell;
- put the existing canvas/input/inspector/console inside the dashboard content area;
- use CoreUI components for navigation, header, cards, tables, forms, alerts, and responsive layout;
- retain React Flow for workflow visualization and Zustand for the run projection store;
- add a router only when dashboard pages are actually split;
- do not copy the full CoreUI demo template or add Redux solely because the demo uses it;
- do not move execution logic into React components.

The CoreUI React library is suitable for this use. The free React admin template is a reference for layout conventions, not a mandate to replace the current application shell. The current open-source CoreUI React library and free admin template are MIT-licensed; retain their copyright and permission notices when copying substantial template code. Keep Pro packages/components outside the plan unless a separate license is approved.

## Execution modes

### Preview

- Reads and validations execute.
- Mutating endpoints are blocked and represented as `MutationPlan`s.
- No SIMRS write is sent.
- Gates hold or reject by design.

Preview is the default for startup and development.

### Confirmed write

- The operator explicitly selects write mode for this run.
- The run is bound to the authenticated operator's EvoMedis session.
- The workflow and endpoint mutation allowlists are enforced.
- Read-before-write preconditions must hold.
- Human gates and approvals are required according to risk.
- Read-after-write verification must pass before the workflow continues.
- The operator can cancel the run.

### Automatic per-patient

Automatic mode is a controlled convenience mode for one patient/episode. It reduces repetitive clicks; it does not mean unrestricted batch execution.

It may be enabled only after the pilot mutation and compensation contracts are proven. It must still:

- receive exactly one patient/episode input;
- show the scope, workflow, mode, operator, and run ID;
- enforce the mutation allowlist and transaction lock;
- retain idempotency/correlation data;
- stop on an ambiguous timeout or verification mismatch;
- preserve the audit trail and kill switch;
- finish with manual operator review in the Verifikator page.

Automatic mode must never silently continue to another patient or bypass a human gate for a critical mutation.

## Reversibility and compensation

SIMRS provides cancellation/reversal actions for several billing operations, including removing an added action, cancelling a transfer, cancelling verification, and cancelling a payment in supported states. These capabilities make a limited pilot possible, but they are not a reason to remove controls.

For every mutating step, record:

1. the target patient/episode/transaction identity;
2. the exact action ID returned by SIMRS;
3. the request correlation or idempotency key, if supported;
4. the precondition snapshot;
5. the operation sequence;
6. the corresponding compensation operation;
7. the result of the Verifikator read after the operation or compensation.

A compensation action may target only an exact known identity. Never delete by name, row index, or a broad field match that could select another operator's action. If the identity is ambiguous, stop and queue the run for manual review.

Compensation is itself a mutation and must be allowlisted, audited, authenticated, and verified. Hospital-specific or irreversible financial reversal procedures remain manual escalation paths.

## Data minimization and persistence

The local system should retain:

- run ID, workflow ID/version, mode, source, operator, timestamps, and status;
- the minimum patient/episode/transaction references needed to reconcile a run;
- redacted event data and mutation/verification outcomes;
- export and correction references required by the approved audit policy.

It should not become a local mirror of complete patient or clinical records. SIMRS remains the source of truth for patient and billing data.

Current persistence is intentionally split:

- active runs, sessions, gates, locks, and live event state are process-local;
- `FileLedger` writes redacted append-only JSONL when `AUDIT_LEDGER_DIR` is set;
- without `AUDIT_LEDGER_DIR`, the ledger is in memory and unsuitable for a pilot.

A process restart clears active sessions, locks, and in-memory run state. The JSONL audit files remain available. A future catalog can reconstruct run summaries from those files.

## Phased roadmap

### Phase 0 — ownership and approval

- Name the operational owner, host owner, network/IT contact, data owner, and escalation contact.
- Confirm that the tool may process the minimum necessary patient/billing references.
- Define retention, backup location, and whether trusted-LAN HTTP is a temporary pilot exception before HTTPS.

**Acceptance:** written pilot scope, named owners, and an approved one-patient-per-run boundary.

### Phase 1 — documentation and offline dashboard shell

- Publish this plan and align deployment, runbook, risk, and development docs.
- Prototype the CoreUI shell with fixture data only.
- Keep the current React Flow console as the first Run page.
- Do not add a database migration.

**Acceptance:** a new operator can understand the modes, safety boundary, and offline flow without reading source code.

### Phase 2 — Windows LAN pilot

- Build one static UI bundle and serve it from the orchestrator on the dedicated Windows host.
- Configure host binding, firewall, CORS, persistent JSONL, and per-user login.
- Protect dashboard read and SSE endpoints before they contain patient/billing references. Prefer same-origin authenticated app sessions (for example, an `HttpOnly`, `SameSite=Strict`, `Secure` cookie under HTTPS), because native browser `EventSource` cannot attach the current bearer header; never put tokens in URLs.
- Test from a second LAN PC with fixture preview before live access.

**Acceptance:** the second PC can load the dashboard, authenticate, run fixture preview, receive authenticated SSE updates, and produce a redacted audit file; unauthenticated clients cannot read run data.

### Phase 3 — dashboard history and catalog

- Add dashboard pages for active/recent runs and run detail.
- Reuse `GET /api/runs`, `GET /api/runs/:runId`, SSE, export, and the shared reducer.
- First reconstruct summaries from JSONL or on-demand scans.
- Evaluate a local SQLite index only if history/search becomes slow or operationally insufficient.

**Acceptance:** restart behavior is documented, recent runs are discoverable, and replay/export reconstructs the same state.

### Phase 4 — one-patient billing pilot

- Constrain the Rajal input UI to one patient/episode.
- Verify the Verifikator API/HTML contract using sanitized fixtures and assert-based parser tests.
- Finish actual write execution for the approved mutation(s), following the existing gate pattern where appropriate.
- Preserve exact IDs, preconditions, locks, correlation/idempotency behavior, read-after-write verification, and compensation metadata.

**Acceptance:** preview and limited-write tests pass against fixtures; the live pilot completes one patient at a time; an operator can inspect and correct a reversible error.

### Phase 5 — controlled automatic per-patient mode

- Add the mode only after Phase 4 proves mutation and compensation contracts.
- Make scope visible in the UI: one patient/episode, workflow, mode, operator, and run ID.
- Require final manual review and stop/queue on ambiguous verification.

**Acceptance:** timeout, duplicate, mismatch, parser-failure, and reversal tests pass; the mode has a named owner, kill switch, audit trail, and rollback procedure.

### Phase 6 — production hardening

- Deploy HTTPS with an internally trusted certificate.
- Add tested Windows startup supervision and recovery.
- Run a backup/restore drill, access review, patching procedure, and incident drill.
- Re-evaluate SQLite/PostgreSQL only from measured requirements.

**Acceptance:** the operational owner signs off on security, backup, recovery, retention, and support procedures.

## Open decisions

The following must be decided by the operational/data/network owners rather than inferred by code:

- who owns the pilot and billing correction decision;
- which roles may view patient/episode references;
- audit retention period and backup destination;
- whether trusted-LAN HTTP is allowed temporarily;
- who owns the Windows host and restarts the process;
- exact Verifikator API/HTML contract and parser fixtures;
- which mutation is the first live pilot;
- which compensation actions are approved for automatic use;
- when a failure must escalate to manual hospital procedure.

## Definition of done for the first dashboard pilot

- The dashboard loads from a dedicated Windows PC for another LAN client.
- The user logs in with their own EvoMedis account.
- One patient/episode can be selected and previewed.
- A write/automatic run cannot expand beyond that patient/episode.
- Every write is allowlisted, attributed, audited, cancellable, and verified.
- The operator can inspect the final Verifikator state and recover a reversible error using the exact action identity.
- JSONL audit storage is persistent and backed up.
- No passwords, session cookies, tokens, or raw responses are persisted or logged.
- The operating owner has approved the scope and recovery procedure.
