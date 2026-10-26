# Plan: Live Write Pilot Design Doc (SIMRS-Flow)

## Goal

Satu dokumen: `docs/live-write-pilot-design.md` — desain pilot mutasi live one-patient
yang bisa di-approve dan dieksekusi begitu host deploy tersedia. Ini langkah 4 dari
"Next phase order" di `docs/dashboard-foundation.md`, dan gerbang terakhir sebelum
pilot bisa jalan.

## Sources (baca sebelum menulis)

1. `docs/risk-register.md` — risk scoring, mutasi critical/high, approval rules
2. `docs/dashboard-foundation.md` — kontrak auth, JSONL, safety invariants
3. `docs/dashboard-evolution-plan.md` — operating envelope & non-goals
4. `apps/orchestrator/src/mutationGate.ts` — enforcement aktual (preconditions,
   read-after-write, state machine planned→approved→invalidated→applied→verified/failed)
5. `packages/evomedis-client/src/client.ts` — transport, relogin, timeout semantics
6. `docs/legacy/ranap-parity.md` & `docs/legacy/rajal-parity.md` — mutasi apa saja
   yang sudah diimplement dan diverifikasi terhadap legacy

## Structure of the doc (sections)

1. **Scope & objective** — one patient/episode/run, mode write, satu workflow dulu
   (rekomendasi: ranap verifikasi+tampung bayar ATAU rajal processor; pilih satu
   dan beri alasannya)
2. **Pre-conditions (hard gates)** — hal yang HARUS sudah benar sebelum pilot:
   host HTTPS LAN, AUDIT_LEDGER_DIR persisten, per-user login aktif, clock sync,
   dua operator terdaftar (untuk two-person approval), rollback/recovery manual
   procedure disepakati
3. **Mutation identity contract** — format identitas presisi per mutasi
   (domain + transaction kind + key fields + source values), verifikasi bahwa
   mutationGate sudah mengikat ini (cite file:line)
4. **Safety controls mapping** — tabel kontrol → enforcement point:
   allowlist, per-transaction lock, read-before-write, two-person approval
   (untuk critical), read-after-write, JSONL audit
5. **Pilot execution script** — langkah per langkah sesi pilot (siapa login,
   patient pilihan, preview dulu, apa yang di-approve, apa yang diverifikasi
   manual di SIMRS Verifikator, kapan dianggap sukses)
6. **Failure & compensation matrix** — tiap failure mode (timeout, invalidasi
   precondition, verify failed, ambiguous transport error) → aksi operator,
   termasuk aturan "do not re-run automatically"
7. **Success criteria & exit decision** — kriteria objektif; keputusan lanjut/
   ulang/stop setelah pilot
8. **Open questions for approver** — hal yang butuh keputusan manusia

## Steps

1. Baca semua sumber di atas (tol: mutationGate penuh — itu enforcement point)
2. Tulis draf `docs/live-write-pilot-design.md` mengikuti structure, cite
   file:line untuk setiap klaim "sudah di-enforce"
3. Update `docs/dashboard-foundation.md` langkah 4 dengan link ke draf
4. Commit `docs(pilot): draft live-write pilot design` + push
5. Laporkan: ringkasan isi + open questions yang butuh jawaban user/approver

## Definition of done

- Dokumen ada, lengkap 8 section, tiap klaim enforcement punya file:line
- Foundation doc ter-link
- Pushed ke origin/main
- Open questions terdaftar eksplisit (tidak mengarang keputusan approver)
