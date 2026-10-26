# Risk Register

Tracks every mutating capability, its blast radius, and the controls that
must hold before it can fire. Pairs with the safety controls in the root
`README.md` and the enforcement in `packages/evomedis-client/src/client.ts`.

## Risk scoring

| Risk | Definition | Default posture |
|---|---|---|
| low | Read-only or trivially reversible | Allowed in preview + write |
| medium | Auth/session side effects | Orchestrator-managed |
| high | Billing-adjacent, reversible with effort | Write + approval + verify |
| critical | Financial finalization, hard to reverse | Write + approval + two-eyes + verify |

## Critical mutations

### `kasir.tampungBayar` — stage payment batch
- **Blast radius:** creates a payment record against a patient transaction. Duplicate calls risk double-charging.
- **Preconditions (read-before-write):**
  - Not already paid: `kasir.getJumlahBayar` still reports `{tunai: "0", piutang: "0"}`.
  - `kasir.getHistoryPembayaran` is empty (reject-paid).
  - No `cek_order_belum_terlayani` / `cek_order_belum_transfer` blockers.
  - No `verifikator.cekTransaksiPenunjang` blocker.
  - Domain eligibility guards already pruned non-BPJS, rawat-inap, unclosed, blocked, unreadable, or already-paid records before the plan was proposed.
- **Idempotency:** idempotency key = `runId:no_transaksi`. The orchestrator holds a per-transaction or coarse discovery lock for the run.
- **Read-after-write:** re-read `getHistoryPembayaran`; a new kwitansi must appear. Mismatch → `mutation.failed` (flagged ambiguous — the write may have half-landed).
- **Approval:** required. `critical` risk, so two distinct operators must approve before the gate applies it.

### `verifikator.simpanVerifikasi` — close verification
- **Blast radius:** finalizes the bill; downstream BPJS claim depends on it.
- **Preconditions:**
  - `kasir.cekStatusVerifikasi` is still open for rajal plans; `cekStatusKeluar` contains "SUDAH KELUAR" for ranap plans.
  - No unserved/untransferred order blockers.
  - No `verifikator.cekTransaksiPenunjang` blocker.
  - Ranap also requires the admin fee / pre-verification summary eligibility checks before the plan is proposed.
- **Read-after-write:** `cekStatusVerifikasi` flips to verified **and** the penunjang blocker clears — a conjunction expressed as `readAfterWriteChecks`.
- **Approval:** required.

### `verifikator.batalVerifikasi` — reopen verification
- **Blast radius:** reverses a finalized bill. Only used to recover from a bad state before re-writing.
- **Preconditions:** an authenticated operator explicitly requests recovery.
- **Read-after-write:** `cekStatusVerifikasi` reopens.
- **Approval:** required; logged as a recovery action.

## High-risk mutations

### `kasir.updateTglMasuk` / `kasir.updateTgl`
- **Blast radius:** changes dates used for billing windows.
- **Preconditions:** target tindakan is not yet verified (else `batalVerifikasi` first).
- **Read-after-write:** re-read the record; date equals the written value.

### `rekamMedis.simpanSep` — write corrected SEP
- **Blast radius:** changes the SEP number tied to the BPJS claim.
- **Preconditions:** new SEP validated against `get_datariwayatsep`; differs from current.
- **Read-after-write:** re-read transaction; `no_sep` equals written value.

### `elektromedik.transferTagihan` / `batalTransfer`
- **Blast radius:** moves charges between bills.
- **Preconditions:** `cek_statusbayar` shows untransferred/transferred as appropriate.
- **Read-after-write:** charge appears/disappears on the target bill.

## Read-before-write and read-after-write enforcement

Controls 5 and 6 are machine-enforced, not operator-attested. The single
enforcement point is `apps/orchestrator/src/mutationGate.ts`, reached only via
`RunService.approveMutation` (`POST /api/runs/:runId/mutations/:planId/approve`,
bearer-only). For an approved plan it:

1. re-reads **every** `Precondition.check` through `EvoMedisClient` at the moment
   the write is about to fire — not when the plan was built — and compares the
   answer with `expected` using the tolerant comparator in
   `packages/workflow-core/src/expectations.ts`. Any check that no longer holds
   refuses the write and emits `mutation.invalidated`; the mutating endpoint is
   never called.
2. applies the write through the client, so the preview block, the allowlist and
   the approval requirement all still apply, and checks the acknowledgement the
   way `_write_result_is_success` (ranap_v3.py:1241) does.
3. re-reads every `readAfterWriteCheck` / `readAfterWriteChecks` rule. All must
   hold (a conjunction, matching `_confirm_verifikasi_state`, ranap_v3.py:15371)
   or `mutation.failed` is emitted with `ambiguous: true` — the write may have
   half-landed and needs manual reconciliation.

**Fail closed.** A guard that cannot be *evaluated* counts as not holding: the
read threw, the endpoint is unknown or is not a read endpoint, or the plan has no
payload that addresses the record. Each case refuses the write and records the
reason on the outcome.

The per-plan result is projected onto `RunState.mutations[planId]`
(`planned` → `approved` → `invalidated` | `applied` → `verified` | `failed`),
so the ledger and any later step can tell a planned write from a landed one.

### Residual gaps (not yet enforced)

- **Backend-assigned follow-up plans can be temporarily unaddressable.** Most
  current ranap and rajal plans carry executable `MutationPlan.payload`; the gate
  still refuses any plan that does not. The remaining expected refusals are
  follow-ups whose target line does not exist yet on the first pass, such as
  `updateTgl` / `setPelaksana` after adding a new charge. Those resolve through a
  write-mode re-plan pass once the add has landed and the backend-assigned
  `urut_tindakan` can be read.
- **A precondition is only as precise as its payload.** Per-line-item checks
  (`penatajasaInap.cekStatusVerifikasi`, which needs `kd_tindakan` and
  `urut_tindakan`) must set `Precondition.payload` explicitly; falling back to
  the plan's own payload can under-address the read, and an under-addressed read
  may answer "empty" and look like a pass. The source used is recorded as
  `payloadSource` on every check result — treat inherited payloads on broad
  checks as weak evidence.
- **Only live in-memory runs are covered.** A plan can be applied while its run is
  still in memory and non-terminal (typically parked at a gate). Historical runs
  replayed from the ledger are read-only.

## Cross-cutting controls

| # | Control | Where enforced |
|---|---|---|
| 1 | Default preview | `EXECUTION_MODE=preview`, runner default, client default |
| 2 | Write explicit per run | Run creation requires `mode: "write"` |
| 3 | Mutation allowlist | `ENDPOINTS` registry (`kind: "mutate"`) + per-workflow `mutationAllowlist` enforced in `EvoMedisClient` (`MutationNotAllowlistedError`) |
| 4 | Unknown endpoint blocked | `UnknownEndpointError` |
| 5 | Read-before-write | `MutationPlan.preconditions` replayed by the mutation gate immediately before the write; any check that no longer holds (or cannot be evaluated) refuses it → `mutation.invalidated` |
| 6 | Read-after-write | `readAfterWriteCheck(s)` replayed by the mutation gate immediately after the write; all rules must hold → `mutation.verified`, else `mutation.failed` |
| 7 | Patient identity gate | Domain executors validate medrec/registration |
| 8 | Reject if verified | `cekStatusVerifikasi` guard |
| 9 | Reject if paid | `getHistoryPembayaran` guard |
| 10 | Per-transaction lock | `TransactionLocks` in `RunService` (409 on conflict; keyed on `no_transaksi`/medrec+date) |
| 11 | Idempotency key | `MutationPlan.idempotencyKey`; a plan that already settled cannot be applied again (`already_settled`), and a concurrent second approval is refused while an apply is in flight |
| 12 | Human gate for finalization | `gate` node + `GateResolver` |
| 13 | Append-only audit | `@simrs-flow/audit-ledger` |
| 14 | Redaction | `redact()` applied before any persistence/log |
| 15 | Kill switch | `POST /api/runs/:id/cancel` + AbortSignal |
| 16 | Feature flag per node | `enabled` overrides at run creation |
| 17 | No hardcoded credentials | `SessionConfig` from env/secret store |
| 18 | No raw response logging | Client logs redacted `CallRecord` only |
| 19 | Skipped ≠ success | Distinct `skipped` status + amber UI |
| 20 | Run records workflow version | Event envelope `workflowVersion` |
| 21 | Operator authentication | Per-user EvoMedis login (`UserSessionStore`); session token authorizes all write actions |
| 22 | Two-person approval (critical) | `RunService` requires two distinct operators for `critical` gates *and* for applying a `critical`-risk `MutationPlan` |
| 23 | Per-user audit identity | Each user logs in with their own EvoMedis account; writes attributed to the real person |

## Dashboard and LAN pilot risks

These risks apply to the planned one-patient-per-run dashboard and must have an
owner before live use.

| Risk | Failure mode | Required mitigation | Pilot posture / owner |
|---|---|---|---|
| Broad PHI visibility | Run references could be exposed to an untrusted LAN client. | Authenticated workflow/run/history reads and same-origin SSE are implemented with bearer-or-HttpOnly-cookie auth; keep exact CORS, firewall restriction, minimum fields, and SIMRS as source of truth. | Blocking production item: data owner + application owner |
| Cookie-authenticated write | A browser cookie could be replayed by CSRF against a mutation endpoint. | Cookies authorize reads/SSE only; write creation, gate decisions, and write cancellation require the bearer header. Add CSRF protection before changing this split. | Required control: application owner |
| Corrupt/version-mismatched history | A restarted run could be replayed against the wrong workflow or malformed event stream. | Validate JSONL metadata/events and current workflow version; keep metadata/export visible but fail closed for detail/SSE; never resume interrupted runs. | Required control: application owner |
| Ledger append reordering | Overlapping async appends could scramble event sequence on disk. | Serialize per-run appends and await the ledger queue before completion/export; validate sequence on restart. | Required control: application owner |
| Plain HTTP credential exposure | EvoMedis credentials cross the LAN without transport encryption. | Use HTTPS with an internally trusted certificate before production; restrict the pilot to an approved trusted LAN and never expose it publicly. | Temporary exception only: network/IT owner |
| Single-host outage | Restart or failure clears active runs, sessions, locks, and gates even though JSONL remains. | Persistent `AUDIT_LEDGER_DIR`, startup/reconciliation procedure, backup/restore drill, and named host owner. | Accepted pilot limitation: host owner |
| JSONL backup failure | Audit files are lost or a backup cannot be restored. | Back up the whole ledger directory, restrict access, periodically restore to a separate directory, and record test results. | Open retention/backup decision: operational owner |
| Automatic scope drift | A convenience mode processes more than one patient/episode or skips review. | Enforce one-patient input, show scope/operator/run ID, retain allowlists/locks/audit/kill switch, and require final Verifikator review. | Allowed only after Phase 5 sign-off: operational owner |
| Verifikator parser drift | HTML markup changes and the parser reports a false success or wrong patient. | Prefer a structured endpoint; otherwise use sanitized fixtures, assert identity/status fields, and fail closed on unknown markup. | Must be proven before live pilot: workflow owner |
| Ambiguous timeout/duplicate | A mutation may have succeeded even though the HTTP response timed out; a retry duplicates it. | Use SIMRS idempotency/correlation if proven; otherwise read back by exact identity and queue ambiguous outcomes for manual review. | Open contract decision: SIMRS/data owner |
| Cross-run ownership | One run compensates an action created by another operator/run. | Persist exact action ID/correlation, use transaction locks, and never delete by name, index, or broad field match. | Required control; no safe bypass |
| Shared service-account fallback | Writes are attributed to a shared cookie rather than the real operator. | Use per-user EvoMedis login by default; require explicit approval and document any exception. | Exception only: operational owner |
| Unapproved reversal | A cancellation is assumed to restore state but has side effects or a status restriction. | Treat compensation as a new allowlisted mutation with preconditions, audit, read-after-write verification, and manual escalation for hospital-specific/irreversible finance steps. | Required control: supervisor |

Automatic per-patient mode is not a bypass for any cross-cutting control. The
operator's manual Verifikator check remains part of the definition of done.

## Open risk items (pilot)

- Audit log retention period — to be set by the process owner.
- Data visibility and role boundaries for patient/episode references — to be set by the data owner.
- Named operational, host, network/IT, SIMRS/data, and escalation owners.
- HTTPS certificate and firewall ownership — to be agreed before production.
- Exact Verifikator API/HTML contract and sanitized parser fixtures.
- First mutating endpoint proof — use the guarded `scripts/pilot-live-write.ts`
  harness with an explicit one-patient `PILOT_PATIENT_ALLOWLIST` and a narrowly
  scoped non-final `PILOT_MUTATION_ALLOWLIST`; no critical final verification or
  tampung bayar before a verified live proof plus manual SIMRS comparison.
- Whether SIMRS idempotency/correlation keys are actually stored and searchable.
- EvoMedis password policy / rotation — governed by the SIMRS side; the
  orchestrator never stores passwords on disk (memory only).
