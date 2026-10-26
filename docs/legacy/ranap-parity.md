# Parity status against `ranap_v3.py`

`EvoMedis-Helper/ranap_v3.py` is the behavioural authority for inpatient
billing: 16,908 lines, ~550 functions, 133 distinct endpoint paths. This
document records how much of it the port reproduces, where it deliberately does
something else, and what is still unfinished.

Read it before assuming a behaviour is covered.

## Where it stands

| | Legacy | Port |
|---|---|---|
| Pipeline steps | `main()`, one procedure | 33 graph nodes |
| Endpoint registry | 133 paths called | 136 registered (`evomedis-client`) |
| Business rules | inline in `main()` and ~550 helpers | 21 pure modules under `domain-ranap/src/logic/` |
| Tests | none (the script *is* the test) | 1314 across the repo |

The rules are ported as pure functions — no network, no clock, no module
state — so each one is unit-tested against the Python's own behaviour rather
than against someone's reading of it. Several were verified differentially: the
Python function was extracted verbatim, run over the same inputs as the
TypeScript, and the outputs diffed.

## What is at parity

**Decisions.** Visit-candidate selection, the verified/paid rejections, SEP
matching (exact date, then the tolerance window, with the PPK filter and every
`matchType` the Python can produce), the BPJS card fallback rule, the newborn
(BYNY) SEP paths, room-stay normalisation and room-day assignment including
overlap priority and the anchor date, the titipan class comparison, origin
detection with the hemodialysis override, hanging-transaction and manual-blocker
collection, the penunjang result validators, IBS consistency, obat-pulang
matching, the balance check, the tampung-bayar payload and its refusal guards,
the per-run alert registry and its blocking rules, and the verification summary
row.

**Structure.** Every step `main()` performs has a node. The seven the original
24-node graph was missing — titipan evaluation, the hanging-transaction scan,
manual blockers, the pre-verification summary, gizi recovery, the balance check
and tampung bayar — plus two an adversarial review found later (`sync_tgl_masuk`,
`load_charges`) are all present.

**Both large repair loops.** `sinkronkan_tindakan_harian_inap` is
`logic/tindakanSync.ts` and `sinkronkan_visite_konsultasi_spesialis_group` is
`logic/visiteSync.ts`, each returning an ordered list of intended operations
that `executors.ts` turns into one `MutationPlan` per operation. Preconditions
and read-after-write rules are enforced for real by
`apps/orchestrator/src/mutationGate.ts`.

**Wire format.** Endpoint ids, HTTP methods and payload field names are checked
against the Python call site. The backend is case-sensitive and inconsistent on
purpose (`txtmedrec` vs `txtmedrec_pdft` vs `txtmedrec_inap` vs `nomedrec`;
`no_trans` vs `no_order`; `no_reg` vs `no_registrasikunjungan`), so the request
*shape* is asserted separately from the response: see the `request shapes` block
in `packages/domain-ranap/src/domain-ranap.test.ts`. A fixture-passing run does
**not** prove the payload was right — `FixtureTransport` keys on the endpoint id
and ignores parameters. Those tests are what prove it.

**Operator log.** Reproduced line for line per
[`ranap-log-format.md`](ranap-log-format.md), including the debug-only gating —
now also `_log_spesialis_v2_fallback` (ranap_v3.py:11406), the `DEBUG_MODE`-only
line that prints each colliding specialist row's CPPT match state before
`_pick_spesialis_keep_row` ranks them. It is
`visiteSync.spesialisV2FallbackLine`, gated by `PlanVisiteSyncArgs.debug`, and
it changes no decision — a test asserts that the same repairs are planned with
the switch on and off.

**The two write-response ladders.** Both are ported, driven across **re-plan
passes** rather than inline (see below):

- `_tampung_pelaksana_checked` (ranap_v3.py:4440-4597). Every `setPelaksana`
  plan now carries the legacy's own read-back — `_is_pelaksana_already_correct`
  (4377/4501) as a `readAfterWriteChecks` rule on
  `getdetail_komponen_transaksi` — so a write the backend accepted but did not
  store becomes a `mutation.failed`, not an unconfirmed `applied`. When a later
  pass of the same node sees that outcome it emits the DATABASE ERROR
  workaround: `_pick_intermediate_paramedis_name` (4328) picks an account that
  is neither the current nor the desired performer, that write is planned first,
  and the desired one follows. The legacy ceiling is preserved —
  `allow_intermediate_retry=False` on both inner calls (4546, 4580) means the
  ladder is climbed once per line per run, never recursively.
- `_ensure_tindakan_belum_terverifikasi` (ranap_v3.py:12286-12326) and
  `_ensure_tindakan_belum_terverifikasi_for_write` (4388). A charge line the
  planner had to refuse *because it is verified* now produces a
  `verifikator.batalVerifikasi` plan for its registration, guarded on the line
  still reading as verified (12292) and confirmed by the same re-read the Python
  performs afterwards (12303). The edit it unblocks is planned on the next pass,
  once the reopening has landed. Both sweeps do this — `sync_tindakan` and
  `sync_visite`.

**`emit_summary` sees the real outcome.** `execute_verifikasi` returns
`StepResult.needsReplan` while it has verification plans in flight, so on a
write run the graph does not reach `emit_summary` until every
`verifikator.simpanVerifikasi` plan is `verified`, `failed` or `invalidated`.
That is the Python's order: write, `_confirm_verifikasi_state` (15371), *then*
emit the row (16828). `tampung_bayar` reads the same real outcome, because
`main()` stages the payment only `if verified and balanced` (16855) — a
verification that landed but was never confirmed (`applied`) is refused, with
the status named in the step summary.

**`proses_tagihan_poli_asal` now has its write-dependent branch.**
`process_poli` first plans the source-POLI date writes it can decide directly:
`BIAYA OBAT` follows the SEP/source date, while POLI-origin lab/radiology rows
follow the related result-history dates. On write runs, re-plan passes then
re-read `poliklinik.getListTindakan`: still-transferred source rows with stale
obat/lab/radiology dates produce a guarded `poliklinik.batalTransfer` plan, and
a clean pending source produces the legacy `poliklinik.transferIgd` payload. The
Lab PK side branch that the Python runs before transferring the source POLI bill
is also guarded: inconsistent Lab PK transfer state plans
`laboratorium.batalTransfer`, unopened/untutup BHP plans `bukaBhp`/`tutupBhp`,
and only a closed Lab PK transaction with a readable total can plan
`laboratorium.transferLab`. Those writes carry read-after-write checks, including
row-wide `allEquals` checks for every Lab PK line reading `Tutup`/`Sudah`, so the
next branch is based on observed state, not on a dry-run assumption.

## Deliberate differences, and the control behind each

These are **not** unfinished work. Each one is a place where a faithful port
would have broken a safety control, so the port does something equivalent and
auditable instead.

1. **The mutate executors never write.** They emit `MutationPlan`s; the
   orchestrator's mutation gate replays the preconditions and applies them after
   approval (safety controls #1–#4). A preview run therefore reproduces every
   *decision* the Python makes and none of its *effects*.
2. **Un-verifying a bill is an approvable plan, not a side effect.** The Python
   calls `batal_verifikasi` inline whenever a verified line is in its way. That
   is a `critical`-risk write against a closed bill, so here it is a
   `MutationPlan` on the workflow's `mutationAllowlist` that needs two distinct
   operators (control #6) and shows the operator which lines it unblocks before
   it fires. The behaviour is the same; the moment of consent is different.
3. **An unapproved write run stops at `execute_verifikasi`.** The barrier that
   makes `emit_summary` see `verified` also means a run whose verification
   nobody approves parks there instead of finishing with an empty summary. The
   step summary and the operator log say so (`menunggu persetujuan operator`),
   and reaching the pass cap with the verification still unconfirmed reports
   `batas re-plan tercapai` plus a `replan_exhausted` warning rather than looking
   finished.
4. **The DATABASE ERROR discriminator is wider than the Python's.** The legacy
   escalates only when `"DATABASE ERROR"` appears in the write response
   (ranap_v3.py:4521). The mutation gate never hands the raw body back — the
   comparator collapses a "Database Error" page into
   `"write answered with a backend error page"` before the outcome is recorded —
   so the port escalates on that reason, on the literal phrase when it survives,
   or on a `verify`-phase failure, which is the legacy's other trigger (the write
   was acknowledged but did not read back). A `precondition`-phase failure is
   never escalated: nothing was written, so an intermediate performer would clear
   nothing.
5. **"Clear the performer" writes are read back** (`pelaksanaReadBackRule`,
   `packages/domain-ranap/src/executors.ts`). DPJB and oksigen want
   `nama_paramedis` *blank*, and the comparator treats a field read off rows as
   empty only when **every** selected row is blank
   (`packages/workflow-core/src/expectations.ts`, `case 'empty'`). When
   `kd_komponen` is known the rule is scoped with `where: { kd_komponen }`, so
   only the component the plan wrote is checked. When it is unknown every
   component of the line is in scope, so an unrelated component that still
   carries a performer makes verification fail — fail closed to operator review,
   never a false pass. The only plan with no rule is one whose `urut_tindakan`
   is unknown, which the gate refuses anyway. The legacy escalation still cannot
   fire for a clear: the DATABASE ERROR it works around is a *swap*, and
   `_pick_intermediate_paramedis_name` excludes the current name.
6. **`kd_paramedis` is a display name.** `tampung_pelaksana_tindakan` matches on
   the dropdown's own spelling, so `_resolve_exact_paramedis_name` (4460) snaps
   the desired name onto the registry entry before the payload is built. That
   used to happen only in the visite repair; it now happens for the daily sweep
   too.

## What is still genuinely unfinished

The code/fixture-parity inventory above compares decisions with `ranap_v3.py`; it is not an exhaustive transcription of the much wider [`ranap-v4` diagram](../references/evomedis-helper-ranap-v4.png). Branch verdicts are implemented in `packages/domain-ranap/src/executors.ts` (`ranap.detectOrigin`) and declared in `packages/domain-ranap/src/workflow.ts`; downstream charge reads and guards are in that executor file. The audit covers only branches whose labels and predicates can be supported by current code or readable evidence. Tiny diagram text cannot be transcribed reliably; an unreadable label is not evidence that a legacy rule is absent.

| Diagram label | Status | Node or reason | Test |
|---|---|---|---|
| IGD / POLI origin | Executable | `detect_origin` returns verdicts on `detect_origin__process_igd` and `detect_origin__process_poli`; the applicable origin runs, and the other edge/node is skipped. Mixed registrations can take both. Unsupported or contradictory origin yields `needs_review`, blocks both origin edges, and registers a blocking issue for downstream payment; it does **not** silently select an origin. | `ranap origin branch verdicts`: `takes only the IGD branch when the stay has IGD origin`, `takes only the POLI branch for the default stay`, `takes both branches when different registrations have IGD and POLI origins`, `holds both branches when no origin is supported by the charge or visit history` (`packages/domain-ranap/src/domain-ranap.test.ts`). |
| BYNY / no-origin continuation | Executable | `detect_origin` skips both origin-source branches for BYNY, but `load_charges` reads inpatient charges independently and downstream IBS/obat-pulang checks continue. The BYNY preview fixture produces no `kasir.tampungBayar` plan; this **does not** mean skipping the origin branches universally blocks downstream processing. | `ranap origin branch verdicts`: `skips both origins for BYNY without planning payment`; `ranap charge lines are loaded for every group`: `reads the inpatient charge list for a newborn too`, `sees a newborn IBS mismatch instead of reporting IBS consistent` (`packages/domain-ranap/src/domain-ranap.test.ts`). |
| Unreadable tiny labels in the Ranap diagram | Tidak terbaca — ditahan untuk klaim diagram | The PNG's small text does not establish reliable branch names or predicates. Do not invent an executor or infer that guard/parallel edges such as verified/paid, SEP comparison, or final verification/payment are exclusive choices. Their existing validators and payment refusal guards still apply. | No claim of exhaustive diagram-label coverage. |

The earlier elektromedik transfer read-back gap is closed through `elektromedik.getListTindakan`: every returned tindakan row must carry `status_kirim: "1"`; an empty or mixed read fails closed. This narrows one known code-parity gap, not all unknown diagram branches. `grep -rn 'ponytail:'` tracks deliberate simplifications, not diagram coverage.

## How to close a gap

1. Read the Python function in full. Note every threshold, keyword list,
   tie-break and early return — a dropped keyword is a billing bug, not a style
   difference.
2. Port the decision as a pure function in `domain-ranap/src/logic/`. Hoist
   every fetch into an explicit parameter and document which endpoint supplies
   it. No network, no module state, no implicit clock reads.
3. Unit-test it against the Python's behaviour, including the cases where the
   Python is surprising — those tests are what stop someone "fixing" a faithful
   oddity later.
4. Wire it in `executors.ts`: fetch, call, log, return a `StepResult`. If the
   step can write, it emits a plan; it does not call the endpoint. If the step
   has to react to its own write, give the plan a read-after-write rule and read
   the outcome out of `ctx.mutations` on the next pass — that is the only way a
   planner can observe a write, and it is how both retry ladders above work.
5. Add a request-shape assertion for any new read.
6. Delete the `ponytail:` comment and the entry above.
