# Dashboard Foundation Handoff

This document is the continuation point for the first SIMRS-Flow dashboard implementation slice. Read it with [`dashboard-evolution-plan.md`](dashboard-evolution-plan.md), which remains the product and rollout source of truth.

## Implemented in this slice

- A minimal CoreUI shell provides **Run** and **History** views without replacing the existing React Flow canvas, Zustand event projection, inspector, console, or workflow runner.
- The orchestrator uses Fastify 5 with compatible official CORS/static plugins; `npm audit --omit=dev` reports no vulnerabilities.
- The UI uses same-origin `/api` calls by default. Vite proxies `/api` to the local orchestrator during development.
- Login returns the existing opaque bearer token and sets the same value in an `HttpOnly`, `SameSite=Lax`, `Path=/` browser cookie.
- Authenticated GET and SSE routes accept bearer or cookie authentication. Write-run creation, gate approval/rejection, and write-run cancellation remain bearer-only.
- Completed terminal runs are reconstructed lazily from the redacted `FileLedger` JSONL after restart. Active runs, sessions, locks, gates, and SSE subscribers remain in memory.
- History metadata remains visible when a run is interrupted, corrupt, or uses an unavailable workflow version. Such runs are not replayed but their redacted raw JSONL remains exportable.

## Deliberately not implemented

- production live Rajal or Ranap billing writes beyond controlled mutation-gate pilots;
- automatic per-patient mode or batch scheduling;
- resuming interrupted runs;
- SQLite or PostgreSQL;
- React Router or deep links;
- browser automation.

## Authentication contract

`POST /api/auth/login` and the QA-only login return `{ token, operator }` and set the app session cookie. `POST /api/auth/logout` invalidates the session where applicable and clears the cookie.

The following routes require bearer or app-cookie authentication:

```text
GET /api/auth/me
GET /api/workflows
GET /api/workflows/:workflowId
GET /api/runs
GET /api/runs/:runId
GET /api/runs/:runId/events
GET /api/runs/:runId/export.jsonl
```

Write authorization still requires `Authorization: Bearer <token>`; the app cookie alone must not authorize writes. Tokens are never placed in URLs. SSE continues to emit unnamed `data:` frames so `EventSource.onmessage` receives them.

`APP_COOKIE_SECURE=1` adds the cookie's `Secure` attribute and is required under production HTTPS. Keep it `0` only for local development or an explicitly approved temporary HTTP LAN pilot.

## JSONL history contract

Each run file is append-only and begins with one metadata line:

```json
{"kind":"run.meta","runId":"...","workflowId":"...","workflowVersion":"...","mode":"preview","startedAt":"...","operator":"..."}
```

It is followed by redacted `WorkflowEvent` lines in file order. The parser validates the metadata, event schema, run/workflow identity, workflow version, and event sequence. A run is replayed only when it has a terminal event and the currently registered workflow version exactly matches the recorded version.

`GET /api/runs` merges current in-memory runs with ledger summaries; an active entry wins when the same run ID is present in both. Historical detail uses the shared `reduceEvents` reducer. Historical SSE replays validated events in order and then closes. Export returns the canonical redacted JSONL including `run.meta`.

Interrupted, corrupt, or version-mismatched files are fail-closed for detail/SSE replay but remain listable and exportable with a reason.

## Verification

From the repository root:

```bash
npx vitest run packages/audit-ledger/src/audit-ledger.test.ts
npx vitest run apps/orchestrator/src/auth.test.ts apps/orchestrator/src/server.test.ts
npm test --workspace @simrs-flow/ui
npm run typecheck
npm run lint
npm test
npm run build
npm audit --omit=dev
bash scripts/livetest.sh
```

The first two focused commands use the root Vitest configuration. Workspace-local Vitest commands for `audit-ledger` and `orchestrator` do not discover the root-relative test include pattern reliably; use the explicit root commands above.

## Restart check

1. Set a temporary persistent `AUDIT_LEDGER_DIR`.
2. Start the orchestrator, log in, create a fixture preview run, and wait for a terminal event.
3. Stop and restart the orchestrator with the same ledger directory.
4. Log in again and confirm the run appears in `GET /api/runs`.
5. Confirm detail replay, historical SSE close, and JSONL export.
6. Confirm an interrupted or corrupt file remains listed/exportable and refuses replay.

A restart does not resume a run. Reconcile any previously in-flight patient/episode manually against SIMRS before starting another write run.

## Continuation checklist

1. Run `git status --short --branch`; do not include `.claude/` or `.omo/evidence/` artifacts.
2. Read this file and [`dashboard-evolution-plan.md`](dashboard-evolution-plan.md).
3. Run the focused history/auth/UI tests before editing.
4. Preserve the event contract, shared reducer, preview default, allowlists, two-person critical approval, per-transaction lock, and bearer-only writes.
5. Keep the next change as a small independently testable checkpoint.

## Next phase order

1. Deploy this foundation behind HTTPS with restricted LAN/firewall access and validate from a second approved PC.
2. Add router/deep links or more CoreUI polish only if operator use demonstrates a need.
3. Add a SQLite history index only if measured JSONL scan latency becomes unacceptable; keep JSONL as the audit authority.
4. Separately design and approve the one-patient mutation pilot with exact mutation identity, read-before-write preconditions, read-after-write verification, compensation rules, and final manual Verifikator review. Draft: [`live-write-pilot-design.md`](live-write-pilot-design.md) (awaiting approver answers in its §8).
