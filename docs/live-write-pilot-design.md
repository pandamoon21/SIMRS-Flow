# Live Write Pilot — Design Draft

Status: **DRAFT for approver review**. This document designs the first controlled
live write against the production EvoMedis/SIMRS instance. It does not authorize
anything by itself; every section marked **[APPROVER]** requires an explicit
human decision recorded on this document before the pilot runs.

Inputs this design builds on:

- `docs/dashboard-foundation.md` — next phase order, step 4 (this document);
- `docs/dashboard-evolution-plan.md` — operating envelope, roles, compensation rules;
- `docs/risk-register.md` — risk scoring, 23 cross-cutting controls, residual gaps;
- `scripts/pilot-live-write.ts` — the guarded harness that already exists;
- `apps/orchestrator/src/mutationGate.ts` — the single enforcement point for
  read-before-write and read-after-write.

## 1. Scope & objective

The pilot proves, on exactly one real patient/episode, that the new engine can
apply one non-final, non-critical billing mutation end-to-end with every safety
control firing as designed — and that the result matches what a human sees in
the SIMRS Verifikator page.

Boundaries (all inherited, none relaxed):

- one patient, one episode, one run (`dashboard-evolution-plan.md` envelope);
- **non-critical mutations only**: the harness (`scripts/pilot-live-write.ts:43-60`)
  hard-refuses `verifikator.simpanVerifikasi`, `verifikator.batalVerifikasi`,
  `kasir.tampungBayar`, and any endpoint with `riskLevel: 'critical'`;
- preview first, write second, manual SIMRS comparison last;
- recommended first endpoint: **`kasir.updateTglMasuk`** (shift a date on one
  unverified tindakan) — reversible, high-risk-not-critical, cheap to read back,
  already covered by preconditions/read-after-write in the risk register.

Out of scope for this pilot: final verification, tampung bayar, batch operation,
automatic per-patient mode. Those require separate approved designs after this
pilot's evidence exists.

## 2. Pre-conditions (hard gates before the pilot session)

| # | Gate | Evidence required |
|---|---|---|
| P1 | Deployed host per `docs/deployment.md` checklist (HTTPS or explicitly approved HTTP LAN exception, restricted bind, persistent `AUDIT_LEDGER_DIR`) | deployment checklist signed by host owner |
| P2 | Per-user EvoMedis login works on the deployed host for two distinct operators | manual login test, recorded |
| P3 | Clock sync verified on host (mutation ordering and audit timestamps depend on it) | `w32tm`/NTP status captured |
| P4 | Backup/restore drill on `AUDIT_LEDGER_DIR` completed once | restore test recorded (`risk-register.md` JSONL backup row) |
| P5 | Restart check reproduced on the deployed host (not just localhost) | `dashboard-foundation.md` restart check steps 1–6 |
| P6 | Compensation manual procedure agreed with SIMRS/data owner: who undoes what, using which SIMRS screens, for this specific mutation type | signed section 6 below |
| P7 | Patient for the pilot selected and authorized by the data owner; recorded in `PILOT_PATIENT_ALLOWLIST` | allowlist value recorded here (§8) |
| P8 | Verifikator parser proven against sanitized fixtures (`risk-register.md`: "Must be proven before live pilot") | fixture test evidence |

P1–P8 are pass/fail. The pilot does not start with any gate open.

## 3. Mutation identity contract

Every applied mutation is identified by the exact tuple the mutation gate binds:

```
domain            : ranap | rajal
endpoint          : e.g. kasir.updateTglMasuk
transaction       : no_transaksi            (SIMRS billing key)
line identity     : kd_tindakan + urut_tindakan   (for per-line mutations)
patient anchor    : medrec + tgl (registration/episode anchor)
run anchor        : runId
idempotency key   : MutationPlan.idempotencyKey = runId:no_transaksi
                    (risk-register.md control #11; a settled plan cannot re-apply)
```

Enforcement citations:

- identity + allowlist: `EvoMedisClient` refuses endpoints not in
  `mutationAllowlist` (`MutationNotAllowlistedError`) and unknown endpoints
  (`UnknownEndpointError`) — `risk-register.md` controls #3/#4;
- per-transaction lock: `TransactionLocks` in `RunService`, 409 on conflict,
  keyed on `no_transaksi` / medrec+date — control #10;
- idempotency: `MutationPlan.idempotencyKey`; concurrent second approval refused
  while an apply is in flight; already-settled plans are refused
  (`already_settled`) — control #11;
- preconditions are re-read **at apply time** (not plan time) by
  `mutationGate.ts`; any check that no longer holds — or cannot be evaluated —
  refuses the write and emits `mutation.invalidated` without calling the
  mutating endpoint (fail-closed, `risk-register.md` "Read-before-write…").

The residual gaps in `risk-register.md` apply and are accepted for this pilot:
backend-assigned follow-up plans (`urut_tindakan` unknown on first pass) resolve
through the write-mode re-plan pass; per-line precondition checks must set their
own `Precondition.payload` (weak inherited payloads are recorded as
`payloadSource` and treated as evidence, not proof).

## 4. Safety controls mapping (what fires, where)

| Control | Pilot behavior | Enforced at |
|---|---|---|
| Default preview | session starts preview; write run is a separate explicit action | run creation requires `mode: "write"` |
| Write authorization | bearer-only; app cookie never authorizes writes | orchestrator auth split (`dashboard-foundation.md`) |
| Mutation allowlist | only `PILOT_MUTATION_ALLOWLIST` ∩ workflow allowlist, non-critical | harness + `EvoMedisClient` |
| Two-person approval | n/a for non-critical pilot mutations (control #22 reserved for critical) | `RunService` |
| Read-before-write | all `Precondition.check` re-read at apply moment; fail-closed | `mutationGate.ts` |
| Read-after-write | all `readAfterWriteCheck(s)` re-read after apply; conjunction must hold | `mutationGate.ts` |
| Ambiguity flag | transport timeout / failed verification → `mutation.failed` with `ambiguous: true`; never auto-retried | `mutationGate.ts` + §6 below |
| Audit | every event appended redacted JSONL, in order | `@simrs-flow/audit-ledger` |
| Kill switch | `POST /api/runs/:runId/cancel` ends the run; active mutation apply completes or fails atomically | orchestrator |
| Identity | per-user EvoMedis login; write attributed to the real operator | `UserSessionStore` |

## 5. Pilot execution script (session runbook)

Performed by the pilot operator, observed by a second person (witness). One
session proves one mutation.

1. **Pre-flight** — verify P1–P8 are all green; note host time; open the
   Verifikator page for the target patient in a browser (for the manual
   comparison at the end).
2. **Scope the harness** — shell env: `PILOT_PATIENT_ALLOWLIST=<authorized medrec>`,
   `PILOT_PATIENT=<same>`, `PILOT_DATE=<episode date>`,
   `PILOT_MUTATION_ALLOWLIST=kasir.updateTglMasuk`, `PILOT_USERNAME=<operator>`.
   Password is prompted (masked) or clipboard mode; never in env or flags
   (`.env.example` pilot section).
3. **Preview run** — the harness runs the workflow live in preview mode against
   the real instance. Confirm the proposed `MutationPlan` targets exactly the
   authorized patient/transaction; confirm precondition checks all pass.
4. **Apply** — the harness applies exactly one eligible mutation through
   `RunService.approveMutation`. Expected terminal path:
   `planned → approved → applied → verified` with every
   `readAfterWriteCheck` holding.
5. **Manual SIMRS comparison** — in the Verifikator page (already open), the
   witness confirms the same fact the machine verified: the date actually
   changed, on the actually correct tindakan, for the actually correct patient.
6. **Stop** — the harness stops before final verification/payment and cancels
   the run (`scripts/pilot-live-write.ts` usage line 249). No second mutation in
   the same session.
7. **Record** — export the run JSONL; append to this document (§9 evidence log):
   run ID, endpoint, transaction identity, machine verdict, witness verdict,
   match/mismatch.

A mismatch between machine verdict and witness verdict is a **pilot stop**
regardless of which direction the mismatch goes.

## 6. Failure & compensation matrix

| Failure mode | Machine behavior | Operator action |
|---|---|---|
| Precondition no longer holds at apply | `mutation.invalidated`; mutating endpoint never called | Re-preview; investigate what changed; do not force |
| Read-after-write mismatch | `mutation.failed`, `ambiguous: true` | Treat as half-landed: manual reconciliation in SIMRS per §P6 procedure; record outcome |
| Transport timeout during write | `mutation.failed` with transport detail; **the write may have landed** | Same as ambiguity: read back by exact identity in SIMRS; never re-run automatically |
| Endpoint error (SIMRS rejects) | `mutation.failed` (not ambiguous) | Correct the cause (e.g. date format, state) and re-preview in a new session if appropriate |
| Engine/process crash mid-run | run stops; JSONL intact; locks/gates are in-memory and clear on restart | Reconcile the patient/episode manually against SIMRS before any new run (`dashboard-foundation.md` restart rule) |
| Wrong patient/transaction selected | hard-refused upstream (patient gate, transaction lock, allowlist) | Pilot stop; this is a control failure, not a retry |
| Needs compensation | `verifikator.batalVerifikasi`/`batalTransfer` class actions are separate allowlisted mutations with their own preconditions/audit — **not** automatic | Supervisor decision per `risk-register.md` "Unapproved reversal"; irreversible finance steps stay manual |

Standing rule: no automatic retry of any mutating call. Every retry is a human
decision in a fresh session.

## 7. Success criteria & exit decision

The pilot is **successful** when, for the session's single mutation:

- machine path reached `verified` with no ambiguity flag;
- the witness independently confirmed the same fact in the SIMRS Verifikator UI;
- the JSONL export contains the full ordered event trail including
  precondition reads, apply, and read-after-write results;
- no other patient/transaction was touched (confirmed by audit review).

**[APPROVER]** Exit decision after a successful pilot — choose one and record it:

- (a) repeat the pilot N more sessions with the same endpoint to build evidence;
- (b) extend the allowlist to the next non-critical endpoint (e.g.
  `rekamMedis.simpanSep` correction);
- (c) design the first **critical** mutation pilot (verification/tampung bayar)
  as a separate document with two-person approval and compensation drills;
- (d) stop — returns/reasons recorded.

## 8. Open questions for approvers

1. **[APPROVER]** Named owners per `dashboard-evolution-plan.md` roles
   (operational, host, network/IT, SIMRS/data) — required before P1 sign-off.
2. **[APPROVER]** Authorized patient/episode for the pilot (feeds
   `PILOT_PATIENT_ALLOWLIST`) and the date window — data owner.
3. **[APPROVER]** HTTPS certificate plan vs. explicit HTTP LAN exception —
   network/IT owner.
4. **[APPROVER]** First endpoint confirmation: `kasir.updateTglMasuk` (this
   draft's recommendation) or an alternative non-critical endpoint.
5. **[APPROVER]** Manual compensation procedure owner and exact SIMRS screens
   for the chosen endpoint (feeds P6).
6. **[APPROVER]** Audit retention period and backup cadence (open risk items).
7. **[APPROVER]** SIMRS idempotency/correlation: confirm whether backend-stored
   correlation keys are searchable; if not, the read-back-by-identity rule in
   §6 is the standing mitigation.

## 9. Evidence log (append per session)

| Date | Run ID | Endpoint | Transaction identity | Machine verdict | Witness verdict | Match | Notes |
|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | pilot not yet run |
