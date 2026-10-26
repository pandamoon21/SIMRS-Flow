# Operator Runbook

For the person running SIMRS-Flow against a live EvoMedis/SIMRS instance.
Read `risk-register.md` before enabling write mode.

## Golden rules

1. **Preview is the default and the safe state.** If unsure, run preview.
2. **Write mode is per-run and explicit.** It is never restored from config.
3. **Approve nothing you don't understand.** Each gate shows the planned
   mutation, its risk, and its read-after-write check. Read it.
4. **One run owns one transaction.** Don't start a second write run for the
   same `no_transaksi` while one is in flight.
5. **If a post-write check fails, stop.** The node becomes `needs_review`.
   Investigate before retrying — do not blindly re-run.

## Daily preview run

1. Start the orchestrator and UI (see `development.md` or the Windows LAN
   procedure in `deployment.md`).
2. **Log in** with your own EvoMedis username/password on the app's login
   screen. (The orchestrator logs into SIMRS on your behalf; your password is
   held in memory only.)
3. Select the workflow, source **Live**, and mode **preview**.
4. Enter exactly one patient/episode and confirm the displayed identity before
   starting. Do not paste a batch of patients into a single run.
5. Press **Start**. Watch nodes turn from pending → running → success.
6. Inspect any `needs_review` (purple) node — it holds a mutation plan.
7. The run ends at the **Gerbang Akhir** (final gate; blocked in preview). That's expected:
   preview never writes.
8. Open the corresponding SIMRS Verifikator page and compare the expected
   state before selecting any write mode.
9. Export the run (`GET /api/runs/:id/export.jsonl`) when the process owner
   requires a record.

### Filling the rawat jalan list from the unpaid report

In **Daftar No. RM** mode the panel **Ambil dari laporan belum bayar** reads
`laporan_belum_bayar` (read-only, live source only) like the legacy *Fetch*:

1. Set the period, instalasi and (optional) penjamin filter.
2. Choose **Semua poli** (poli list is replaced by the report's poli) or
   **Poli terpilih** (only patients under the poli chips already chosen).
3. Press **Ambil data**. The No. RM list is replaced and the period becomes
   the visit range (`Tanggal` → `Sampai`).
4. Trim the batch: remove a poli with its chip's ×, **Hapus semua** clears
   them, **Kosongkan** clears the No. RM list. The pilot still allows one
   patient per live run.

The Poli picker also lists every poli seen in this month's report, so a new
SIMRS clinic needs no code change to be selectable. Its SEP validation still
needs a mapping — see the gap table in `docs/legacy/rajal-parity.md`.

When the list holds more than one No. RM, the search under it finds an RM by
digits (`123456` or `0-12-34-56`); **Pakai ini saja** keeps only that patient.

### Filling the rawat inap input from the discharge report

The panel **Ambil dari laporan pasien keluar** reads the cashier's
*laporan pasien keluar rawat inap* (read-only, live source only). Choose the
discharge period (and optionally the admission period), **Verifikasi** and
**Bayar** (Semua / Sudah / Belum — default Belum/Belum), and penjamin, then
**Ambil data**. Search the result by No. RM and press **Pilih**: No. RM and
Tanggal (the patient's tgl masuk, which the run matches ± toleransi) are filled.

### Iur Naik Kelas page

The rail entry **Iur Naik Kelas** lists the doctors' Google Form responses.
The data is a stored copy: the host re-reads the sheet once a day
(`NAIK_KELAS_REFRESH_HOURS`) and the header shows when it was last read and
the next automatic read. Press **Ambil sekarang** for fresh data. If a read
fails, the previous copy stays on screen with a warning.

Search, filter (date preset/range, hak kelas, kelas ranap, dokter, and under
**Filter lanjutan** kasus/tindakan/kode grouping/klaim text plus IUR/billing
ranges such as `1 jt`), remove a filter with its chip's ×, sort by a column
header, and page with the top or bottom pager (type a page number to jump).
**Export XLSX** and **Cetak / PDF** cover every filtered row, not just the
current page. In the print menu pick the paper (A4, F4/Folio, Letter, Legal),
orientation and columns, then "Save as PDF" or a printer in the dialog (allow
pop-ups for the app). Landscape suits all 14 columns; portrait shrinks the
text to fit.

If the form's sheet moves, paste the new link under **Pengaturan lanjutan**
(saved on the host for every operator) or set `NAIK_KELAS_SHEET_URL`. The sheet
must be shared "anyone with the link"; a private sheet shows "sheet_not_public".

### Rekapitulasi

The cards at the top always show hari / minggu (Senin–hari ini) / bulan /
tahun ini; click one, a period tab, or set Dari/Sampai to choose the period
that drives the metrics, the chart and the table. Click a chart bar to narrow
the table to that day, month or shift (click again to clear). The table has
the same search, chips, pager, XLSX and print as Iur Naik Kelas. Rekap numbers
are still demo data until the billing query ships.

### Reading the rawat jalan canvas

On the rajal workflow the default view is **Tahapan**: nine labelled columns
(Persiapan, Tahap 1…8) with their own headers. A green header means every node
in that column finished; the header count shows `selesai/total` and any skipped
nodes. The columns are wide, so use the canvas controls:

- **Geser** (drag the empty canvas) to move horizontally to later tahapan.
- **Center** frames the whole graph; **Fit** zooms out to show all nine columns.
- **Selected** re-centres the currently selected card.
- **Follow** keeps the newest running node in view; turn it off if you want the
  camera to stay put while reviewing.

The **MULAI** card carries a queue recap once the visit filter has run: total
poli, unique patients per poli, and the combined total (a patient seen in two
poli counts once in each poli but once in the total). Before the filter finishes
the recap reads *menunggu pencocokan kunjungan*; if the history could not be read
it is labelled **data parsial** and the total is "terbaca", not complete. A recap
that is not available is shown as such — it is never displayed as zero.

Clicking a card only selects it and keeps the inspector closed. Use the card's
**Tinjau detail** / **Tinjau & setujui** button to open the inspector, where the
full evidence and any approve/reject actions live.

### Reading step checklists (Flexible view)

Every step shows *why* it decided what it did as a ✓/✗ checklist — in the
inspector, and on the canvas when the toolbar is switched to **Flexible**
(default is **Fixed**; choose **↓ Vertikal** or **→ Horizontal**, narrow screens
always use vertical; the choice is remembered per browser).

- ✓ met, ✗ not met, • information only. Data SIMRS did not return is ✗ or •
  with the reason — never a guessed ✓.
- Each ✗ branches sideways to its outcome: a planned write, a review, or a stop.
  The path taken is coloured; paths not taken are dashed.
- A ✗ fixed by a write (e.g. *Visite DPJP tgl 19 ✗ → tambah visite*) turns ✓
  only after that write is approved and verified.
- At most five items per step are shown, ✗ first; the rest fold into "+N".
- Fixture replays show checklists labelled **Contoh**; real checklists appear
  only on Live SIMRS runs.
- **Fixed** cards carry the same reasons under **Alasan** (✗ first, with what is
  wrong or planned); before a step runs they list the rules it decides by
  (**Akan diputuskan**), and once it ran the matching rule is ticked ✓.
- Camera: **Awal** = first step, **Saat ini** = the step running / waiting or the
  last one reached (disabled until a step has moved), **Akhir** = last step.

### Log view ("Log saja")

The Run page can show a run as a terminal log instead of the canvas. Pick the
default in Run setup (**Tampilan hasil: Kanvas / Log**) or switch any time with
**Kanvas | Log** in the command bar — switching never touches the run, and the
choice is remembered per browser.

- Each step opens with `hh:mm:ss ── [x/y] Nama ──` and closes with
  `✓ [x/y] Nama · 1.0s` (`✗` gagal · `■` berhenti · `⚠` perlu ditinjau ·
  `↷` dilewati · `⏸` menunggu keputusan · `●` berjalan). Executor lines in
  between are shown exactly as written, so the `label : value` columns stay
  aligned. A step skipped without logging is a single `↷` line.
- **Decisions** appear where they happen: a waiting gate gets **Setujui / Tolak**,
  a planned write on a confirmed-write run gets **Setujui rencana** — the same
  approvals as the Inspector (two-operator rule, preconditions and
  verification still apply on the server). Once decided the card becomes one
  line: *Disetujui oleh …*, *Ditolak …*, or *Disetujui otomatis (auto-approve)*.
  The bar **Menunggu keputusan (n)** above the log jumps to the first one.
- Left list: click a step to jump to it in the log, double-click to open it in
  the Inspector (narrow screens: **Lompat ke tahap…** dropdown).
- **Cari di log**: highlights matching lines, ‹ › or Enter / Shift+Enter move
  between hits; a No. RM matches with or without dashes. **Hanya masalah**,
  **Mode debug** and **Bersihkan** work like the console's filters.
- The log follows new lines only while you are at the bottom; **Ke terbaru**
  jumps back. The run ends with `════ SELESAI · n/y tahap · m masalah · durasi ════`.

## One-patient billing run (target procedure)

> **Live-write status (2026-10).** Non-final writes proven once each with
> read-after-write PASS via `pilot-live-write.ts`: `rekamMedis.simpanSep`
> (rajal) and `kasir.updateTglMasuk` (ranap). Final verification and
> `tampung bayar` (rajal first, then ranap) are **not yet live-proven**. Sites
> where one operator does the whole patient set `CRITICAL_APPROVALS=1`; the
> final gates then need one human approval instead of two. Approval, locking,
> preconditions, read-after-write checks and manual SIMRS comparison remain
> mandatory for every write.

This is the target operating loop for repetitive billing assistance. It is one
patient/episode per run, not a batch job and not a replacement for SIMRS.

1. Log in with the operator's own EvoMedis account.
2. Select one patient/episode and verify the patient, registration/transaction,
   date, and intended workflow before starting.
3. Run **preview** first. Read the planned actions, preconditions, and expected
   Verifikator state.
4. If the preview matches, start a separate **confirmed write** run or an
   approved **automatic per-patient** run. The mode is explicit per run and
   cannot be inferred from a saved setting.
5. Let the workflow complete only within the selected patient/episode. The
   existing allowlist, authentication, lock, gate, audit, cancellation, and
   read-after-write controls remain active.
6. Open the SIMRS Verifikator page and manually compare the final status,
   action IDs, and patient/episode identity. A successful HTTP response alone
   is not a business success.
7. Export/preserve the JSONL audit when required by the operating procedure.

Automatic per-patient mode reduces repetitive clicks; it does not authorize
batch processing or skip the final human check. If the operator cannot verify
the result, the run is not complete.

### Stop conditions

Stop the run and queue it for review if any of the following occurs:

- patient, episode, transaction, or action identity does not match;
- a precondition or status snapshot changes unexpectedly;
- a transaction lock conflict occurs;
- an endpoint is unknown or outside the workflow mutation allowlist;
- a request times out and the outcome is ambiguous;
- read-after-write or Verifikator verification does not match;
- the EvoMedis session expires and re-login fails;
- the Verifikator HTML/API contract is missing, malformed, or changed;
- the exact compensation/action ID cannot be proven.

Do not retry an ambiguous mutation blindly.

### Correcting a reversible error

1. Stop or cancel related runs.
2. Preserve the run ID and audit JSONL.
3. Identify the exact patient/episode/transaction and the exact action ID
   created by the run.
4. Use the corresponding approved SIMRS compensation action, such as remove
   the added action, cancel the transfer, cancel verification, or cancel the
   payment where the current status allows it.
5. Re-read the Verifikator page/API and confirm the corrected state.
6. Record the correction as a separate audited action and notify the process
   owner when required.

Never delete by name, row position, or a broad field match. If ownership or
identity is ambiguous, do not compensate automatically; escalate for manual
review. Hospital-specific or irreversible financial reversal procedures stay
manual.

### Windows host daily operation

- At startup, confirm the host is on the approved LAN, the orchestrator is
  running, `/api/health` is healthy, and the audit directory is writable.
- Before live use, run a fixture preview from an operator PC and confirm SSE
  updates.
- At shutdown, do not start new runs; let active runs finish or cancel them
  deliberately, then preserve their run IDs and audit files.
- After an unexpected restart, assume sessions, locks, gates, and active-run
  memory are gone. Operators log in again and reconcile any in-flight work
  against SIMRS before starting a new run.
- Follow the backup/restore procedure in `deployment.md`; do not treat a
  successful file copy as proof that restore works.

## Enabling a limited write pilot

Pre-conditions (all must hold):

- Dry-run parity confirmed for the target fixtures.
- The endpoint is on the workflow's `mutationAllowlist` (enforced by the
  client — an endpoint not listed is blocked even with approval).
- Each operator can log in with their own EvoMedis account (the login is the
  app login; the session token authorizes write actions).
- Two named approvers are available for any `critical` gate.
- `AUDIT_LEDGER_DIR` is set to a persistent location.
- `EVOMEDIS_BASE_URL` points at the live instance (required; no default),
  and runs are created with `source: "live"`.

Steps:

1. Log in, then create a run with `mode: "write"`. The UI sends your session
   token automatically; an API caller must send `Authorization: Bearer <token>`.
   Without a valid token the request is rejected (401).
2. The run proceeds through reads/validations as in preview. A write run also
   takes a per-transaction lock; a second write run on the same record is
   rejected (409) until the first finishes.
3. At each gate, the run pauses (`gate.waiting`). The inspector shows
   **Approve / Reject** (both require a logged-in operator).
4. Approve only after confirming the plan's preconditions still hold. A
   `critical` gate needs two *distinct* operators; the first approval reports
   `remainingApprovals: 1` and holds the run until the second approves.
5. After a write, the mutation gate performs the read-after-write check(s). A
   mismatch emits `mutation.failed` with an ambiguous-outcome warning; reconcile
   in SIMRS before continuing.

If your EvoMedis session expires mid-run, the orchestrator silently re-logs-in
using your retained in-memory password and retries once. The same one-retry path
is used when `kasir.getDataTransaksi` returns an empty/insufficient identity,
matching the legacy helper's forced session refresh for that read. If the retry
still cannot prove the identity, the run fails closed — reconcile in SIMRS before
continuing.

### Auto-approving a supervised pilot

Auto-approve removes only the human confirmation step. Use it for a supervised
pilot where the operator watches the run and has already accepted the scope —
never as a standing setting on a shared host.

- UI: in **Confirmed write** mode, tick **Auto-approve gate & mutasi** before
  starting the run. The toggle is not persisted; it must be re-armed each
  session.
- Host-wide: `AUTO_APPROVE_WRITES=1` makes every write run auto-approve.
- API: `POST /api/runs` with `{ "mode": "write", "autoApprove": true }` and an
  authenticated operator. It is refused (400) outside write mode.

What still applies, unchanged: the client-side endpoint allowlist, the
precondition replay immediately before each write, the read-after-write
verification, the per-transaction lock, and the append-only audit ledger.

What changes: every gate resolves at once, and every proposed plan fires as soon
as it appears. Because a `critical` gate and a `critical` plan each require two
*distinct* approvers, a second synthetic approver named `auto-approve` is
recorded alongside the real operator — `approvedBy` shows both, so the audit
trail never reads as a two-human sign-off.

### Guarded one-patient pilot harness

`scripts/pilot-live-write.ts` exists only for the controlled live proof. It runs
live preview first, starts a write run only for the same one patient/date, approves
at most one exact-preview-matching non-final/non-critical plan, verifies its
audit JSONL path, then cancels/stops before final verification or tampung bayar.
It is not proof by itself; manual SIMRS comparison is still required.

Required scope variables:

```powershell
$env:PILOT_PATIENT_ALLOWLIST = "<one-authorized-medrec>"
$env:PILOT_PATIENT = "<same-medrec>"
$env:PILOT_MUTATION_ALLOWLIST = "<one-safe-non-final-endpoint>"
$env:PILOT_USERNAME = "<operator username>"
node --import tsx scripts/pilot-live-write.ts --self-check
node --import tsx scripts/pilot-live-write.ts
```

Optional: `PILOT_DATE` narrows the preview date list; `PILOT_LEDGER_DIR` overrides
the JSONL directory. Lists accept comma, semicolon, or whitespace separators.
Never set a password env var or pass a password flag. With no masked TTY prompt
on Windows, copy the EvoMedis password to the local clipboard; the script reads it
once and clears the clipboard immediately.

## Cancelling a run (kill switch)

- UI: press **Cancel** (live runs only), or
- API: `POST /api/runs/:runId/cancel`.

Cancellation aborts the run's signal and releases any pending gate as
rejected. In-flight network calls honor the abort. A cancelled run is
terminal and recorded as `run.cancelled`.

## Pausing a run

- UI: press **Jeda** beside Stop; it turns into **Lanjutkan**.
- API: `POST /api/runs/:runId/pause` / `POST /api/runs/:runId/resume`
  (same auth as cancel: open for preview, operator token for write runs).

The step already running finishes first; the run then waits before its next
step (`run.paused`) until resumed (`run.resumed`). A paused run keeps its lock
and can still be cancelled. A **cancelled** run cannot be resumed — start a new
run instead (preview reads are safe to repeat).

## Recovering from a bad write

1. **Stop.** Cancel any related runs.
2. Identify the affected `no_transaksi` / registration from the audit log.
3. If a verification was wrongly closed: use the `verifikator.batalVerifikasi`
   capability (critical, requires approval) to reopen, then re-run preview to
   re-derive the correct state.
4. If a payment was wrongly staged: follow the hospital's manual reversal
   procedure — SIMRS-Flow does not auto-reverse payments.
5. Add a fixture reproducing the bug to `test-fixtures` before re-enabling.

## Reading the audit trail

Each run is one JSONL file under `AUDIT_LEDGER_DIR/<runId>.jsonl`, containing
a `run.meta` line then the redacted event stream. To reconstruct what
happened:

```bash
# inspect a run
cat .data/audit/<runId>.jsonl | jq 'select(.type|startswith("node."))'
```

Credentials, tokens, BPJS/family card numbers are redacted. Patient names are
masked to a 2-character tail.

## Health & troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `SessionExpiredError` in logs | EvoMedis cookie expired | auto re-login retries once; if it persists, log in again (password may have changed) |
| `Data transaksi kasir tidak terbaca` | `kasir.getDataTransaksi` still lacks a valid identity after the one re-login retry | stop; confirm the patient/transaction in SIMRS before rerunning |
| `LoginFailedError` / `401 login_failed` | wrong EvoMedis username/password | re-enter credentials |
| `UnexpectedResponseError` | PHP/HTML error page | backend issue; the node fails closed — safe |
| `UnknownEndpointError` | endpoint not in registry | add it to `endpoints.ts` with a risk level |
| `MutationBlockedInPreviewError` | a write attempted in preview | expected; switch to write mode if intended |
| `MutationNotAllowlistedError` | endpoint not on the workflow allowlist | add it to the workflow `mutationAllowlist` if intended |
| `401 operator_auth_required` | not logged in / session expired on a write action | log in again; the UI bounces to the login screen |
| `409 transaction locked` | another write run holds the record | wait for / cancel the in-flight run |
| `400 live source unavailable` | `source: "live"` with no login and no service-account cookie | log in, or set `EVOMEDIS_SESSION_COOKIE` |
| Node stuck `gate_waiting` | awaiting approval (or a second approver) | approve/reject in the inspector |
| `Database Error ... invalid input syntax for type smallint: ""` from `verifikator.simpanVerifikasi` | the session carries no `kd_user`, so the controller writes an empty `kd_user_verifikasi`. A login made by the API/orchestrator issues a session with `user_data=""`; only a real EvoMedis login page session carries `kd_user` | verify that verification can only be performed from a session established through the EvoMedis login page in a browser; do not retry the write from an API-authenticated session |
| SSE not updating | orchestrator/UI URL mismatch | check `VITE_ORCHESTRATOR_URL` / CORS origins |

## Escalation

- Duplicate payment/charge suspected → stop all runs, notify billing owner,
  preserve the audit JSONL.
- Repeated post-write mismatches → disable write mode, file fixtures, review.
