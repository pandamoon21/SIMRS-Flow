import { describe, it, expect } from 'vitest';
import { WorkflowRunner, evaluateExpectation, reasoningOf, verificationRulesOf } from '@simrs-flow/workflow-core';
import { EvoMedisClient, FixtureTransport, isMutating, type TransportRequest } from '@simrs-flow/evomedis-client';
import {
  rajalFixtures,
  RAJAL_DISCOVERY_INPUT,
  RAJAL_HAPPY_INPUT,
  RAJAL_UNPAID_REPORT_EMPTY_HTML,
  RAJAL_UNPAID_REPORT_HTML,
} from '@simrs-flow/test-fixtures';
import {
  rajalWorkflow,
  createRajalExecutors,
  buildRajalTampungBayarPayload,
  buildRajalUnpaidReportQuery,
  evaluateRajalExitDate,
  evaluateRajalExitDateResponse,
  evaluateRajalLabPdfGet,
  evaluateRajalLabPdfHead,
  evaluateRajalOncologyPlan,
  evaluateRajalOrderBlocker,
  evaluateRajalPenunjangBlocker,
  fetchRajalUnpaidBatch,
  formatPatientId,
  formatRajalLegacyDate,
  isRadiologyTreatmentName,
  isRegularLabTreatmentName,
  mapRajalClinicToSepPoli,
  normalizeClinicLabel,
  normalizeRajalPaymentConfig,
  parseRajalUnpaidReport,
  rajalClinicCandidates,
  rajalPaymentTypeCode,
  rajalShiftCode,
  resolveRajalClinicMatch,
  extractRajalClinicFromSection,
  selectRajalUnpaidBatch,
  verifyRajalTreatmentGroups,
  rajalTreatmentChecklist,
  RAJAL_INSTALASI_OPTIONS,
  RAJAL_PAYMENT_TYPE_OPTIONS,
  RAJAL_SHIFT_OPTIONS,
  RAJAL_TREATMENT_TEMPLATES,
  RAJAL_UNMAPPED_CLINIC_UNITS,
  resolveRajalLisPdfTarget,
} from '../src/index.js';
import { evaluateRajalConsultVisit, isUnknownPenunjangTreatmentName, sepPoliMatches } from './legacyConfig.js';

function previewClient(overrides: Record<string, never> | Record<string, any> = {}) {
  // SEP validation reads the BPJS card from the guarantor tab and matches the
  // visit against the patient's SEP history; both responses live in the shared
  // package fixture so the orchestrator smoke test sees the same happy path.
  const transport = new FixtureTransport({ ...rajalFixtures, ...overrides });
  const client = new EvoMedisClient(
    { baseUrlV1: 'https://simrs.example.local/app/index.php', cookie: 'ci_session=valid' },
    { mode: 'preview', transport },
  );
  return { client, transport };
}

/** Billed tindakan rows: registration plus one penunjang treatment. */
function tindakanFixture(penunjang: string) {
  return {
    'poliklinik.getListTindakan': {
      text: JSON.stringify({
        rows: [
          { nama_tindakan: 'PENDAFTARAN PASIEN', jumlah: '50000', flag: 'Belum', urut_tindakan: '1' },
          { nama_tindakan: penunjang, jumlah: '100000', flag: 'Belum', urut_tindakan: '2' },
        ],
      }),
    },
  };
}

function pdfBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x25, 0x50, 0x44, 0x46]);
  return bytes;
}

async function runRajal(overrides: Record<string, any>, runId: string, input = RAJAL_HAPPY_INPUT) {
  const { client, transport } = previewClient(overrides);
  const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
  const result = await runner.run({ mode: 'preview', input, runId });
  return { result, transport };
}

/** The happy fixture's visit rows, for a test that routes several medrecs. */
function rajalHistoryRowsFor(_patientId: string): unknown[] {
  const entry = rajalFixtures['kasir.getHistoryKunjungan'] as { text: string };
  return (JSON.parse(entry.text) as { rows: unknown[] }).rows;
}

/** Safety control #1: a preview run must never touch a mutating endpoint. */
function mutatingCalls(transport: FixtureTransport) {
  return transport.calls.filter((call) => isMutating(call.headers['x-endpoint-id'] ?? ''));
}

describe('rajal helpers', () => {
  it('reformats a 6-digit medrec', () => {
    expect(formatPatientId('012345')).toBe('0-01-23-45');
    expect(formatPatientId('0-01-23-45')).toBe('0-01-23-45');
    expect(formatPatientId('  789012 ')).toBe('0-78-90-12');
  });

  it('maps legacy clinic aliases to SEP poli candidates', () => {
    expect(mapRajalClinicToSepPoli('HAEMODIALISIS')).toBe('hemodialisa');
    expect(mapRajalClinicToSepPoli('BEDAH DIGESTIVE')).toBe('bedah digestif');
    expect(mapRajalClinicToSepPoli('THT')).toBe('tht-kl');
    expect(mapRajalClinicToSepPoli('POLI DALAM, GINJAL DAN HIPERTENSI')).toBe('ginjal-hipertensi');
    expect(rajalClinicCandidates('POLI DALAM, GINJAL DAN HIPERTENSI')).toContain('GINJAL HIPERTENSI');
  });

  it('maps the gastro clinic to its live SEP poli without matching a PENYAKIT DALAM SEP', () => {
    const gastro = resolveRajalClinicMatch('POLI PENYAKIT DALAM GASTROENTEROHEPATOLOGI', ['DALAM', 'GASTROENTEROHEPATOLOGI']);
    expect(gastro.matchedClinic).toBe('GASTROENTEROHEPATOLOGI');
    const candidates = rajalClinicCandidates('GASTROENTEROHEPATOLOGI');
    expect(sepPoliMatches('GASTROENTEROLOGI-HEPATOLOGI ', candidates)).toBe(true);
    expect(sepPoliMatches('PENYAKIT DALAM', candidates)).toBe(false);
    // Discovery passes raw report headings: the longest mapping key must win.
    expect(mapRajalClinicToSepPoli('POLI PENYAKIT DALAM GASTROENTEROHEPATOLOGI')).toBe('gastroenterologi-hepatologi');
    expect(sepPoliMatches('PENYAKIT DALAM', rajalClinicCandidates('POLI PENYAKIT DALAM GASTROENTEROHEPATOLOGI'))).toBe(false);
    expect(mapRajalClinicToSepPoli('POLI JANTUNG ANAK')).toBe('anak kardiologi');
    expect(mapRajalClinicToSepPoli('POLI DALAM')).toBe('penyakit dalam');
  });

  it('never maps a blank clinic onto a real poli', () => {
    // `source.includes(normalized)` with an empty normalized string matched the
    // first mapping entry, so an unset clinic silently became 'anak'.
    expect(mapRajalClinicToSepPoli('')).toBe('');
    expect(mapRajalClinicToSepPoli('   ')).toBe('');
    expect(rajalClinicCandidates('')).toEqual([]);
    expect(rajalClinicCandidates('  ')).toEqual([]);
  });

  it('keeps the unmapped-unit list to the three known polis', () => {
    expect([...RAJAL_UNMAPPED_CLINIC_UNITS]).toEqual(['JANTUNG ARITMIA', 'HEMOFILIA', 'BEDAH VASKULAR']);
  });

  it('leaves JANTUNG ARITMIA, HEMOFILIA and BEDAH VASKULAR unmapped instead of borrowing a poli', () => {
    // Prefixing with POLI must not defeat the guard (normalizeClinicLabel strips it).
    for (const unit of ['JANTUNG ARITMIA', 'HEMOFILIA', 'BEDAH VASKULAR']) {
      for (const raw of [unit, `POLI ${unit}`]) {
        const mapped = mapRajalClinicToSepPoli(raw);
        // Unmapped branch: the raw name, lowercased and trimmed — no mapping.
        expect(mapped).toBe(raw.toLowerCase().trim());
        expect(mapped).not.toBe('jantung dan pembuluh darah');
        const candidates = rajalClinicCandidates(raw);
        expect(candidates).not.toContain('JANTUNG DAN PEMBULUH DARAH');
        // Raw-name candidates only; the stripped-POLI form is still offered.
        expect(candidates).toContain(unit);
        expect(sepPoliMatches(unit, candidates)).toBe(true);
      }
    }
    // The raw unit list carries a trailing kd_unit, which the normalizer keeps.
    expect(normalizeClinicLabel('POLI JANTUNG ARITMIA (251)')).toBe('JANTUNG ARITMIA 251');
    expect(mapRajalClinicToSepPoli('POLI JANTUNG ARITMIA (251)')).toBe('poli jantung aritmia (251)');
    expect(rajalClinicCandidates('POLI JANTUNG ARITMIA (251)')).not.toContain('JANTUNG DAN PEMBULUH DARAH');
    // HEMOFILIA and BEDAH VASKULAR sit near mapped keys too.
    expect(mapRajalClinicToSepPoli('POLI HEMOFILIA')).toBe('poli hemofilia');
    expect(mapRajalClinicToSepPoli('POLI BEDAH VASKULAR')).toBe('poli bedah vaskular');
    expect(rajalClinicCandidates('POLI BEDAH VASKULAR')).not.toContain('BEDAH');
  });

  it('keeps JANTUNG, JANTUNG ANAK and JANTUNG INTERVENSI mapped', () => {
    expect(mapRajalClinicToSepPoli('POLI JANTUNG')).toBe('jantung dan pembuluh darah');
    expect(mapRajalClinicToSepPoli('POLI JANTUNG ANAK')).toBe('anak kardiologi');
    expect(mapRajalClinicToSepPoli('POLI JANTUNG INTERVENSI')).toBe('pelayanan vaskular');
    expect(rajalClinicCandidates('POLI JANTUNG')).toContain('JANTUNG DAN PEMBULUH DARAH');
  });

  it('does not let a JANTUNG SEP resolve an ARITMIA visit', () => {
    // `sepPoliMatches` is bidirectional containment, so before the guard the
    // ARITMIA candidates were ["JANTUNG DAN PEMBULUH DARAH"] and a plain JANTUNG
    // SEP matched — enough for validate_sep to plan a wrong simpanSep.
    const aritmia = rajalClinicCandidates('POLI JANTUNG ARITMIA');
    expect(sepPoliMatches('JANTUNG DAN PEMBULUH DARAH', aritmia)).toBe(false);
    expect(sepPoliMatches('Pelayanan vaskular', aritmia)).toBe(false);
    // Containment stays bidirectional (legacy `poliMatches`): a bare "JANTUNG"
    // SEP still contains the raw-name candidate. The difference the guard makes
    // is that candidates are the ARITMIA raw name, never the JANTUNG poli — so
    // a SEP naming that poli no longer resolves the visit.
    expect(aritmia).not.toContain('JANTUNG DAN PEMBULUH DARAH');
    expect(rajalClinicCandidates('POLI JANTUNG')).toEqual(['JANTUNG DAN PEMBULUH DARAH']);
    // Sanity: the containment rule itself is unchanged for mapped clinics.
    expect(sepPoliMatches('POLI JANTUNG DAN PEMBULUH DARAH ', rajalClinicCandidates('POLI JANTUNG'))).toBe(true);
  });

  it('keeps legacy treatment templates grouped', () => {
    expect(RAJAL_TREATMENT_TEMPLATES.find((template) => template.id === 'obat_or_hd')?.rows).toEqual([
      'A|registration|PENDAFTARAN PASIEN',
      'B|obat|BIAYA OBAT',
      'B|hd|HAEMODIALISA',
    ]);
  });

  it('classifies penunjang treatments the way the legacy script did', () => {
    expect(isRadiologyTreatmentName('USG')).toBe(true);
    expect(isRadiologyTreatmentName('CT SCAN THORAX')).toBe(true);
    expect(isRadiologyTreatmentName('USG DOPPLER')).toBe(false); // legacy: exact "usg" only
    expect(isRegularLabTreatmentName('LABORATORIUM KLINIK')).toBe(true);
    expect(isRegularLabTreatmentName('LABORATORIUM PA')).toBe(false);
    // The billing desk posts a `BIAYA RADIOLOGI` line per study; it is a
    // radiology charge, so the radiology guard must engage for it.
    expect(isRadiologyTreatmentName('BIAYA RADIOLOGI')).toBe(true);
    expect(isRadiologyTreatmentName('biaya radiologi thorax')).toBe(true);
    expect(isRadiologyTreatmentName('  BIAYA RADIOLOGI THORAX ')).toBe(true);
    // Anchored: a study name is still matched by its own keywords, and a
    // radiology word that is not a billing line stays with the fallback.
    expect(isRadiologyTreatmentName('RONTGEN THORAX')).toBe(true);
    expect(isRadiologyTreatmentName('MRI LUMBAL')).toBe(true);
    expect(isRadiologyTreatmentName('KONSUL RADIOLOGI')).toBe(false);
  });

  it('classifies same-day poli visits and rejects unreadable evidence', () => {
    const base = { visitDate: '2026-06-10', unit: 'POLI PENYAKIT DALAM' };
    const one = { tgl_masuk: '10/06/2026', nama_unit: 'POLI PENYAKIT DALAM' };
    expect(evaluateRajalConsultVisit({ ...base, history: [one] })).toBe('single_clinic');
    expect(evaluateRajalConsultVisit({ ...base, history: [one, { tgl_masuk: '2026-06-10', nama_unit: 'POLI ANAK' }] })).toBe('consult');
    expect(evaluateRajalConsultVisit({ ...base, history: [one, { tgl_masuk: '2026-06-09', nama_unit: 'POLI ANAK' }] })).toBe('single_clinic');
    expect(evaluateRajalConsultVisit({ ...base, history: [{ tgl_masuk: '', nama_unit: 'POLI ANAK' }] })).toBe('unknown');
    expect(evaluateRajalConsultVisit({ ...base, visitDate: '2026-15-10', history: [one] })).toBe('unknown');
    expect(evaluateRajalConsultVisit({ ...base, unit: '', history: [one] })).toBe('unknown');
    expect(evaluateRajalConsultVisit({ ...base, history: [{ tgl_masuk: '2026-06-10', nama_unit: '' }] })).toBe('unknown');
  });

  it('holds unknown penunjang while leaving routine billed treatments alone', () => {
    expect(isUnknownPenunjangTreatmentName('USG ABDOMEN')).toBe(true);
    expect(isUnknownPenunjangTreatmentName('PENUNJANG LAIN')).toBe(true);
    expect(isUnknownPenunjangTreatmentName('PENUNJANG XYZ')).toBe(true);
    expect(isUnknownPenunjangTreatmentName('BIAYA OBAT')).toBe(false);
    expect(isUnknownPenunjangTreatmentName('PENDAFTARAN PASIEN')).toBe(false);
    // A known radiology charge is not unknown: it is routed to the radiology
    // guard, which fails closed when the order/result evidence is missing.
    expect(isUnknownPenunjangTreatmentName('BIAYA RADIOLOGI')).toBe(false);
    expect(isUnknownPenunjangTreatmentName('BIAYA RADIOLOGI THORAX')).toBe(false);
  });

  it('formats penunjang order dates the way the order-history endpoints echo them', () => {
    expect(formatRajalLegacyDate('2026-06-10')).toBe('10-Jun-2026');
    expect(formatRajalLegacyDate('2026-01-01')).toBe('01-Jan-2026');
  });

  it('ports the regular-lab LIS PDF URL and byte-size decisions', () => {
    expect(resolveRajalLisPdfTarget('cetak_hasil_pdf.php?no_lab=ABC', 'LAB-1')).toEqual({ kind: 'old-lis' });
    expect(resolveRajalLisPdfTarget('<iframe src="pdf.php?no_transaksi=LAB-2"></iframe>', 'LAB-1')).toEqual({
      kind: 'pdf',
      noTransaksi: 'LAB-2',
    });
    expect(evaluateRajalLabPdfHead({ 'content-type': 'application/pdf', 'content-length': '7407' })!.hasResult).toBe(false);
    expect(evaluateRajalLabPdfHead({ 'content-type': 'application/pdf', 'content-length': '7408' })!.hasResult).toBe(true);
    expect(evaluateRajalLabPdfHead({ 'content-type': 'application/pdf', 'transfer-encoding': 'chunked' })?.hasResult).toBe(true);
    expect(evaluateRajalLabPdfGet(200, pdfBytes(7407)).hasResult).toBe(false);
    expect(evaluateRajalLabPdfGet(200, pdfBytes(7408)).hasResult).toBe(true);
    expect(evaluateRajalLabPdfGet(200, new Uint8Array([1, 2, 3, 4])).hasResult).toBe(false);
  });
});

describe('rajal dry-run', () => {
  it('processes the batch to the payment gate without writing', async () => {
    const { client, transport } = previewClient();
    const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
    const result = await runner.run({ mode: 'preview', input: RAJAL_HAPPY_INPUT, runId: 'rajal_test' });

    expect(result.state.nodes.normalize_ids!.status).toBe('success');
    expect(result.state.nodes.filter_records!.status).toBe('success');
    expect(result.state.nodes.validate_transaction!.status).toBe('success');
    expect(result.state.nodes.check_payment!.status).toBe('success');

    // submit_payment proposes a plan, never writes.
    const submit = result.state.nodes.submit_payment!;
    expect(submit.status).toBe('needs_review');
    expect(submit.proposedMutations[0]!.endpointId).toBe('kasir.tampungBayar');

    const mutatingCalls = transport.calls.filter((c) => c.url.includes('tampung_bayar'));
    expect(mutatingCalls).toHaveLength(0);
  });
  it('emits privacy-safe unique patient counts per poli after the visit filters', async () => {
    const byPatient: Record<string, Array<Record<string, string>>> = {
      '0-01-23-45': [
        { no_registrasikunjungan: 'SYN-REG-1', no_transaksi: 'SYN-TRX-1', kd_unit: 'A', nama_unit: 'POLI ANAK', status_bayar: 'Belum', nama_penjamin: 'BPJS PBI', tgl_masuk: '2026-06-10' },
        { no_registrasikunjungan: 'SYN-REG-2', no_transaksi: 'SYN-TRX-2', kd_unit: 'A', nama_unit: 'POLI ANAK', status_bayar: 'Belum', nama_penjamin: 'BPJS PBI', tgl_masuk: '2026-06-10' },
      ],
      '0-12-34-56': [
        { no_registrasikunjungan: 'SYN-REG-3', no_transaksi: 'SYN-TRX-3', kd_unit: 'A', nama_unit: 'POLI ANAK', status_bayar: 'Belum', nama_penjamin: 'BPJS PBI', tgl_masuk: '2026-06-10' },
        { no_registrasikunjungan: 'SYN-REG-4', no_transaksi: 'SYN-TRX-4', kd_unit: 'D', nama_unit: 'POLI PENYAKIT DALAM', status_bayar: 'Belum', nama_penjamin: 'BPJS PBI', tgl_masuk: '2026-06-10' },
      ],
      '0-23-45-67': [
        { no_registrasikunjungan: 'SYN-REG-5', no_transaksi: 'SYN-TRX-5', kd_unit: 'D', nama_unit: 'POLI PENYAKIT DALAM', status_bayar: 'Belum', nama_penjamin: 'BPJS PBI', tgl_masuk: '2026-06-10' },
      ],
    };
    const { result, transport } = await runRajal(
      {
        'kasir.getHistoryKunjungan': (req: TransportRequest) => {
          const patientId = new URLSearchParams(req.body).get('nomedrec') ?? '';
          return { text: JSON.stringify({ rows: byPatient[patientId] ?? [] }) };
        },
      },
      'rajal_clinic_counts',
      { patientIds: ['012345', '123456', '234567'], clinics: ['ANAK', 'DALAM', 'BEDAH'], date: '2026-06-10' },
    );

    const evidence = result.state.nodes.filter_records!.evidence.find((item) => item.label === 'rajal.clinic-counts');
    expect(evidence).toMatchObject({
      source: 'filter_records',
      data: {
        basis: 'matched-visits',
        complete: true,
        totalClinics: 3,
        totalPatients: 3,
        clinics: [
          { clinic: 'ANAK', patientCount: 2 },
          { clinic: 'DALAM', patientCount: 2 },
          { clinic: 'BEDAH', patientCount: 0 },
        ],
      },
    });
    expect(JSON.stringify(evidence)).not.toMatch(/SYN-|0-01-23-45|0-12-34-56|0-23-45-67/);
    expect(result.state.nodes.filter_records!.status).toBe('success');
    expect(transport.calls.filter((call) => call.headers['x-endpoint-id'] === 'kasir.getHistoryKunjungan')).toHaveLength(3);
  });
  it('ends a batch with one outcome per patient: who passed, who was dropped, where and why', async () => {
    const { result } = await runRajal(
      {
        'kasir.getHistoryKunjungan': (req: TransportRequest) => {
          const patientId = new URLSearchParams(req.body).get('nomedrec') ?? '';
          if (patientId === '0-23-45-67') return { text: JSON.stringify({ total: 0 }) }; // unreadable: no rows array
          if (patientId === '0-34-56-78') return { text: JSON.stringify({ rows: [] }) }; // nothing to bill
          return { text: JSON.stringify({ rows: rajalHistoryRowsFor(patientId) }) };
        },
      },
      'rajal_patient_outcomes',
      { patientIds: ['012345', '234567', '345678'], clinics: ['PENYAKIT DALAM'], date: '2026-06-10' },
    );
    const node = result.state.nodes.emit_batch_summary!;
    const rows = node.evidence.find((item) => item.label === 'rajal.patient-outcomes')?.data as { rows: Array<Record<string, unknown>> };
    expect(rows.rows.map((row) => [row.patientId, row.status])).toEqual([
      ['0-01-23-45', 'lolos'],
      ['0-23-45-67', 'dilewati'],
      ['0-34-56-78', 'dilewati'],
    ]);
    expect(rows.rows[1]!.reason).toBe('riwayat kunjungan tidak terbaca');
    expect(rows.rows[2]!.reason).toMatch(/tidak ada kunjungan yang cocok/);
    expect(node.summary).toMatch(/1 lolos, 2 dilewati dari 3 pasien/);
    const lines = result.state.logs.filter((log) => log.nodeId === 'emit_batch_summary').map((log) => log.message);
    expect(lines.some((line) => line.startsWith('• 0-23-45-67 — dilewati'))).toBe(true);
  });

  it('counts only readable survivors and marks the recap incomplete when one history read fails', async () => {
    const { result, transport } = await runRajal(
      {
        'kasir.getHistoryKunjungan': (req: TransportRequest) => {
          const patientId = new URLSearchParams(req.body).get('nomedrec') ?? '';
          if (patientId === '0-23-45-67') return { text: JSON.stringify({ total: 0 }) };
          return {
            text: JSON.stringify({
              rows: [
                { no_registrasikunjungan: `SYN-${patientId}`, no_transaksi: `SYN-TRX-${patientId}`, kd_unit: 'A', nama_unit: 'POLI ANAK', status_bayar: 'Belum', nama_penjamin: 'BPJS PBI', tgl_masuk: '2026-06-10' },
              ],
            }),
          };
        },
      },
      'rajal_clinic_counts_partial',
      { patientIds: ['012345', '234567'], clinics: ['ANAK', 'DALAM'], date: '2026-06-10' },
    );

    const evidence = result.state.nodes.filter_records!.evidence.find((item) => item.label === 'rajal.clinic-counts');
    expect(evidence?.data).toEqual({
      basis: 'matched-visits',
      complete: false,
      totalClinics: 2,
      totalPatients: 1,
      clinics: [
        { clinic: 'ANAK', patientCount: 1 },
        { clinic: 'DALAM', patientCount: 0 },
      ],
    });
    // The unreadable read is surfaced by load_history and must not be repaired
    // by the aggregate; no extra SIMRS call is made to fill the gap.
    expect(result.state.nodes.load_history!.status).toBe('needs_review');
    expect(transport.calls.filter((call) => call.headers['x-endpoint-id'] === 'kasir.getHistoryKunjungan')).toHaveLength(2);
  });

  it('reports a known zero match as zero rather than treating it as unavailable', async () => {
    const { result } = await runRajal(
      {
        'kasir.getHistoryKunjungan': { text: JSON.stringify({ rows: [] }) },
      },
      'rajal_clinic_counts_zero',
      { patientIds: ['012345'], clinics: ['ANAK', 'DALAM'], date: '2026-06-10' },
    );
    const node = result.state.nodes.filter_records!;
    expect(node.status).toBe('skipped');
    expect(node.summary).toBe('Tidak ada kunjungan yang cocok');
    expect(node.evidence.find((item) => item.label === 'rajal.clinic-counts')?.data).toEqual({
      basis: 'matched-visits',
      complete: true,
      totalClinics: 2,
      totalPatients: 0,
      clinics: [
        { clinic: 'ANAK', patientCount: 0 },
        { clinic: 'DALAM', patientCount: 0 },
      ],
    });
  });

  it('skips an already-paid record', async () => {
    const { client } = previewClient({
      'poliklinik.getListTindakan': {
        text: JSON.stringify({
          rows: [
            { nama_tindakan: 'PENDAFTARAN PASIEN', jumlah: '50000', flag: 'Sudah', urut_tindakan: '1' },
            { nama_tindakan: 'BIAYA OBAT', jumlah: '100000', flag: 'Sudah', urut_tindakan: '2' },
          ],
        }),
      },
    });
    const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
    const result = await runner.run({ mode: 'preview', input: RAJAL_HAPPY_INPUT, runId: 'rajal_paid' });
    expect(result.state.nodes.check_payment!.status).toBe('skipped');
    expect(result.state.edges.check_payment__check_verification!.status).toBe('skipped');
  });

  it('detects consult only from the current patient history and still plans payment', async () => {
    const { result, transport } = await runRajal({
      'kasir.getHistoryKunjungan': (req: TransportRequest) => {
        const medrec = new URLSearchParams(req.body).get('nomedrec');
        const own = { no_registrasikunjungan: 'REG-RJ-1', no_transaksi: '01-200001', kd_unit: 'P01', nama_unit: 'POLI PENYAKIT DALAM', status_bayar: 'Belum', nama_penjamin: 'BPJS PBI', tgl_masuk: '2026-06-10' };
        return { text: JSON.stringify({ rows: medrec === '0-01-23-45' ? [own, { ...own, no_transaksi: '01-200099', no_registrasikunjungan: 'REG-RJ-99', kd_unit: 'P02', nama_unit: 'POLI ANAK' }] : [] }) };
      },
    }, 'rajal_consult', { ...RAJAL_HAPPY_INPUT, patientIds: ['012345'] });
    expect(result.events.some((event) => event.message?.includes('Konsul terdeteksi: 01-200001 (POLI PENYAKIT DALAM → POLI ANAK)'))).toBe(true);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(1);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('does not infer a consult from another patient on the same date', async () => {
    const { result } = await runRajal({
      'kasir.getHistoryKunjungan': (req: TransportRequest) => {
        const own = { no_registrasikunjungan: 'REG-RJ-1', no_transaksi: '01-200001', kd_unit: 'P01', nama_unit: 'POLI PENYAKIT DALAM', status_bayar: 'Belum', nama_penjamin: 'BPJS PBI', tgl_masuk: '2026-06-10' };
        return { text: JSON.stringify({ rows: new URLSearchParams(req.body).get('nomedrec') === '0-01-23-45' ? [own] : [{ ...own, no_transaksi: '01-200088', nama_unit: 'POLI ANAK' }] }) };
      },
    }, 'rajal_other_patient', { ...RAJAL_HAPPY_INPUT, patientIds: ['012345', '123456'] });
    expect(result.events.some((event) => event.message?.includes('Konsul terdeteksi: 01-200001'))).toBe(false);
    expect(result.events.some((event) => event.message?.includes('Kunjungan satu poli: 01-200001'))).toBe(true);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(1);
  });

  it('reviews an unknown penunjang treatment without staging payment', async () => {
    const { result, transport } = await runRajal(tindakanFixture('PENUNJANG LAIN'), 'rajal_unknown_penunjang');
    expect(result.state.nodes.validate_treatment!.status).toBe('needs_review');
    expect(result.state.nodes.validate_treatment!.summary).toMatch(/Penunjang belum digolongkan pada 01-200001: PENUNJANG LAIN/);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(Object.keys(result.state.mutations)).toHaveLength(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('holds an unclassified USG treatment instead of bypassing radiology validation', async () => {
    const { result, transport } = await runRajal(tindakanFixture('USG ABDOMEN'), 'rajal_usg_unclassified');
    expect(result.state.nodes.validate_treatment!.status).toBe('needs_review');
    expect(result.state.nodes.validate_treatment!.summary).toContain('USG ABDOMEN');
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('passes validate_treatment when an include keyword matches a treatment row', async () => {
    const { client } = previewClient();
    const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
    const result = await runner.run({
      mode: 'preview',
      input: { ...RAJAL_HAPPY_INPUT, tindakanIncludeKeywords: ['BIAYA OBAT'] },
      runId: 'rajal_treatment_match',
    });

    expect(result.state.nodes.validate_treatment!.status).toBe('success');
    expect(result.state.nodes.validate_treatment!.summary).toMatch(/1\/2 treatment row\(s\) matched filters/);
  });

  it('needs review when treatment include filters match nothing', async () => {
    const { client } = previewClient();
    const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
    const result = await runner.run({
      mode: 'preview',
      input: { ...RAJAL_HAPPY_INPUT, tindakanIncludeKeywords: ['TINDAKAN TIDAK ADA'] },
      runId: 'rajal_treatment_empty',
    });

    expect(result.state.nodes.validate_treatment!.status).toBe('needs_review');
    expect(result.state.nodes.validate_treatment!.summary).toMatch(/No treatments matched filters/);
  });

  it('blocks when matching treatments are below the operator minimum', async () => {
    const { client } = previewClient();
    const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
    const result = await runner.run({
      mode: 'preview',
      input: { ...RAJAL_HAPPY_INPUT, tindakanIncludeKeywords: ['BIAYA OBAT'], tindakanMinCount: 2 },
      runId: 'rajal_treatment_minimum',
    });

    expect(result.state.nodes.validate_treatment!.status).toBe('blocked');
    expect(result.state.nodes.validate_treatment!.summary).toMatch(/minimum 2/);
  });

  it('blocks and avoids payment planning when an excluded treatment is present', async () => {
    const { client } = previewClient();
    const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
    const result = await runner.run({
      mode: 'preview',
      input: { ...RAJAL_HAPPY_INPUT, tindakanExcludeKeywords: ['PENDAFTARAN PASIEN'] },
      runId: 'rajal_treatment_excluded',
    });

    expect(result.state.nodes.validate_treatment!.status).toBe('blocked');
    expect(result.state.nodes.validate_treatment!.summary).toMatch(/Excluded treatment/);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(result.events.some((event) => event.type === 'mutation.planned')).toBe(false);
  });


  it('plans payment for every matching rajal record', async () => {
    const { client } = previewClient({
      'kasir.getHistoryKunjungan': {
        text: JSON.stringify({
          rows: [
            {
              no_registrasikunjungan: 'REG-RJ-1',
              no_transaksi: '01-200001',
              kd_unit: 'P01',
              nama_unit: 'POLI PENYAKIT DALAM',
              status_bayar: 'Belum',
              nama_penjamin: 'BPJS PBI',
              tgl_masuk: '2026-06-10',
            },
            {
              no_registrasikunjungan: 'REG-RJ-2',
              no_transaksi: '01-200002',
              kd_unit: 'P01',
              nama_unit: 'POLI PENYAKIT DALAM',
              status_bayar: 'Belum',
              nama_penjamin: 'BPJS PBI',
              tgl_masuk: '2026-06-10',
            },
          ],
        }),
      },
    });
    const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
    const result = await runner.run({ mode: 'preview', input: RAJAL_HAPPY_INPUT, runId: 'rajal_multi_record' });

    expect(result.state.nodes.validate_transaction!.summary).toBe('2 transaksi Rawat Jalan');
    expect(result.state.nodes.validate_treatment!.summary).toMatch(/across 2 record\(s\)/);
    expect(result.state.nodes.submit_payment!.proposedMutations.map((plan) => plan.payloadSummary.no_transaksi)).toEqual([
      '01-200001',
      '01-200002',
    ]);
  });
  it('filters visit records by the requested rawat jalan date', async () => {
    const { client } = previewClient({
      'kasir.getHistoryKunjungan': {
        text: JSON.stringify({
          rows: [
            {
              no_registrasikunjungan: 'REG-RJ-WRONG-DATE',
              no_transaksi: '01-999999',
              kd_unit: 'P01',
              nama_unit: 'POLI PENYAKIT DALAM',
              status_bayar: 'Belum',
              nama_penjamin: 'BPJS PBI',
              tgl_masuk: '2026-06-09',
            },
            {
              no_registrasikunjungan: 'REG-RJ-RIGHT-DATE',
              no_transaksi: '01-200001',
              kd_unit: 'P01',
              nama_unit: 'POLI PENYAKIT DALAM',
              status_bayar: 'Belum',
              nama_penjamin: 'BPJS PBI',
              tgl_masuk: '2026-06-10',
            },
          ],
        }),
      },
    });
    const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
    const result = await runner.run({ mode: 'preview', input: RAJAL_HAPPY_INPUT, runId: 'rajal_date_filter' });

    expect(result.state.nodes.filter_records!.summary).toBe('1 kunjungan cocok');
    expect(result.state.nodes.submit_payment!.proposedMutations?.[0]?.payloadSummary).toMatchObject({
      no_transaksi: '01-200001',
    });
  });

  it('sends no mutating endpoint anywhere in a full preview run', async () => {
    const { result, transport } = await runRajal({}, 'rajal_no_mutation');
    expect(result.state.nodes.submit_payment!.status).toBe('needs_review');
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('blocks when an untransferred penunjang visit is still unpaid', async () => {
    const { result, transport } = await runRajal(
      {
        'kasir.getHistoryKunjungan': {
          text: JSON.stringify({
            rows: [
              {
                no_registrasikunjungan: 'REG-RJ-1',
                no_transaksi: '01-200001',
                kd_unit: 'P01',
                nama_unit: 'POLI PENYAKIT DALAM',
                status_bayar: 'Belum',
                nama_penjamin: 'BPJS PBI',
                tgl_masuk: '2026-06-10',
              },
              {
                no_registrasikunjungan: 'REG-PJ-9',
                no_transaksi: '14-300001',
                kd_unit: 'PJ1',
                nama_unit: 'Penunjang Laboratorium Klinik',
                status_bayar: 'Belum',
                nama_penjamin: 'BPJS PBI',
                tgl_masuk: '2026-06-10',
              },
            ],
          }),
        },
      },
      'rajal_untransferred_penunjang',
    );

    expect(result.state.nodes.filter_records!.status).toBe('blocked');
    expect(result.state.nodes.filter_records!.summary).toMatch(/14-300001/);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('keeps clean patients when another patient has an untransferred penunjang visit', async () => {
    const { result, transport } = await runRajal(
      {
        'kasir.getHistoryKunjungan': ({ body }: { body?: string }) => {
          const medrec = Object.fromEntries(new URLSearchParams(body ?? '')).nomedrec;
          return {
            text: JSON.stringify({
              rows:
                medrec === '0-67-89-01'
                  ? [
                    {
                      no_registrasikunjungan: 'REG-RJ-BAD',
                      no_transaksi: '01-200002',
                      kd_unit: 'P01',
                      nama_unit: 'POLI PENYAKIT DALAM',
                      status_bayar: 'Belum',
                      nama_penjamin: 'BPJS PBI',
                      tgl_masuk: '2026-06-10',
                    },
                    {
                      no_registrasikunjungan: 'REG-PJ-BAD',
                      no_transaksi: '14-300002',
                      kd_unit: 'PJ1',
                      nama_unit: 'Penunjang Laboratorium Klinik',
                      status_bayar: 'Belum',
                      nama_penjamin: 'BPJS PBI',
                      tgl_masuk: '2026-06-10',
                    },
                  ]
                  : [RECORD_BASE],
            }),
          };
        },
      },
      'rajal_penunjang_partial',
      { ...RAJAL_HAPPY_INPUT, patientIds: ['012345', '678901'] },
    );

    expect(result.state.nodes.filter_records!.status).toBe('needs_review');
    expect(result.state.nodes.filter_records!.summary).toMatch(/14-300002/);
    expect(result.state.nodes.submit_payment!.proposedMutations.map((plan) => plan.payloadSummary.no_transaksi)).toEqual([
      '01-200001',
    ]);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });
});

/**
 * Penunjang guards. Legacy only engages a check when the bill actually carries
 * a treatment of that modality, then blocks the record while the order is
 * untransferred or unresulted.
 */
describe('rajal Setup write switches', () => {
  it('Tampung bayar off: no payment plan, every check and the batch summary still run', async () => {
    const { result, transport } = await runRajal({}, 'rajal_no_tampung', { ...RAJAL_HAPPY_INPUT, enableTampungBayar: false } as typeof RAJAL_HAPPY_INPUT);
    expect(result.state.nodes.submit_payment!.status).toBe('skipped');
    expect(result.state.nodes.submit_payment!.summary).toMatch(/Tampung bayar dimatikan/);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(result.state.nodes.emit_batch_summary!.status).toBe('success');
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('Verifikasi off: an unverified visit is dropped, never verified or paid', async () => {
    const { result } = await runRajal({}, 'rajal_no_verif', { ...RAJAL_HAPPY_INPUT, enableVerifikasi: false } as typeof RAJAL_HAPPY_INPUT);
    expect(result.state.nodes.check_verification!.proposedMutations).toHaveLength(0);
    expect(result.state.nodes.check_verification!.summary).toMatch(/Verifikasi dimatikan/);
    expect(result.state.nodes.submit_payment!.proposedMutations ?? []).toHaveLength(0);
  });

  it('checklists lead with the No. RM and the batch summary lists each patient', async () => {
    const { result } = await runRajal({}, 'rajal_rm_labels');
    expect(reasoningOf(result.state.nodes.filter_records!.evidence)!.items[0]!.label).toMatch(/^0-01-23-45 · /);
    // Every per-visit item names its patient, including the executor-built checklists (SEP, bayar).
    for (const id of ['normalize_ids', 'filter_records', 'validate_sep', 'check_payment', 'emit_batch_summary']) {
      const items = reasoningOf(result.state.nodes[id]!.evidence)!.items;
      expect(items.length, id).toBeGreaterThan(0);
      expect(items.every((item) => item.subject === '0-01-23-45'), id).toBe(true);
    }
    expect(reasoningOf(result.state.nodes.resolve_clinics!.evidence)!.items.every((item) => !item.subject)).toBe(true);
    expect(reasoningOf(result.state.nodes.emit_batch_summary!.evidence)!.items).toEqual([
      expect.objectContaining({ label: '0-01-23-45', ok: true }),
    ]);
  });
});

describe('rajal penunjang guards', () => {
  const RADIOLOGY_CLEAN = {
    ...tindakanFixture('USG'),
    'poliklinik.getHistoryIrad': {
      text: JSON.stringify({ rows: [{ tgl_order: '2026-06-10 09:15', status_approve: '1' }] }),
    },
    'radiologi.getDataKunjungan': {
      text: JSON.stringify({ rows: [{ no_transaksi: 'RAD-1', tgl_transaksi: '2026-06-10' }] }),
    },
    'radiologi.getHasilPemeriksaan': {
      text: JSON.stringify({ total: 1, rows: [{ deskripsi: 'Kesan: dalam batas normal' }] }),
    },
  };

  it('passes radiology when the order is approved and the report exists', async () => {
    const { result, transport } = await runRajal(RADIOLOGY_CLEAN, 'rajal_radiology_clean');
    expect(result.state.nodes.validate_radiology!.status).toBe('success');
    expect(result.state.nodes.validate_radiology!.summary).toBe('1 tindakan radiologi sudah ada hasilnya');
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('blocks radiology when the billed study has no report yet', async () => {
    const { result, transport } = await runRajal(
      { ...RADIOLOGY_CLEAN, 'radiologi.getHasilPemeriksaan': { text: JSON.stringify({ total: 0, rows: [] }) } },
      'rajal_radiology_pending',
    );
    const node = result.state.nodes.validate_radiology!;
    expect(node.status).toBe('blocked');
    expect(node.summary).toMatch(/Hasil radiologi belum ada pada 01-200001/);
    expect(node.summary).toMatch(/RAD-1/);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('blocks radiology when the order is neither approved nor served', async () => {
    const { result } = await runRajal(
      {
        ...RADIOLOGY_CLEAN,
        'poliklinik.getHistoryIrad': {
          text: JSON.stringify({ rows: [{ tgl_order: '2026-06-10 09:15', status_approve: '0', tgl_terlayani: '' }] }),
        },
      },
      'rajal_radiology_unapproved',
    );

    expect(result.state.nodes.validate_radiology!.status).toBe('blocked');
    expect(result.state.nodes.validate_radiology!.summary).toMatch(
      /Order radiologi belum disetujui pada 01-200001/,
    );
  });

  it('passes a BIAYA RADIOLOGI charge once the order is approved and the report exists', async () => {
    const { result, transport } = await runRajal(
      { ...RADIOLOGY_CLEAN, ...tindakanFixture('BIAYA RADIOLOGI') },
      'rajal_biaya_radiologi_clean',
    );

    // Not the unknown-penunjang fallback: the visit survives validate_treatment
    // and reaches the radiology guard, which finds approved order + report.
    expect(result.events.some((event) => event.message?.includes('Penunjang belum digolongkan'))).toBe(false);
    expect(result.state.nodes.validate_treatment!.status).not.toBe('needs_review');
    expect(result.state.nodes.validate_radiology!.status).toBe('success');
    expect(result.state.nodes.validate_radiology!.summary).toBe('1 tindakan radiologi sudah ada hasilnya');
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('blocks a BIAYA RADIOLOGI charge when no radiology order exists', async () => {
    const { result, transport } = await runRajal(
      {
        ...tindakanFixture('BIAYA RADIOLOGI'),
        'poliklinik.getHistoryIrad': { text: JSON.stringify({ rows: [] }) },
      },
      'rajal_biaya_radiologi_no_order',
    );

    // Not dropped as "belum digolongkan" any more: the charge is known, so the
    // visit survives validate_treatment and reaches the radiology guard.
    expect(result.events.some((event) => event.message?.includes('Penunjang belum digolongkan'))).toBe(false);
    expect(result.state.nodes.validate_treatment!.status).not.toBe('needs_review');
    const radiology = result.state.nodes.validate_radiology!;
    expect(radiology.status).toBe('blocked');
    expect(radiology.summary).toMatch(/Order radiologi belum ada pada 01-200001/);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(Object.keys(result.state.mutations)).toHaveLength(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  const ELEKTRO_CLEAN = {
    ...tindakanFixture('PENUNJANG ELEKTROMEDIK EKG'),
    'elektromedikHasil.getDataPasien': {
      text: JSON.stringify({ rows: [{ no_transaksi: 'EKG-1', tgl_transaksi: '2026-06-10' }] }),
    },
    'elektromedikHasil.getListHasilPemeriksaan': {
      text: JSON.stringify({ total: 1, rows: [{ deskripsi: 'Sinus rhythm' }] }),
    },
  };

  it('passes elektromedik when every result carries a description', async () => {
    const { result, transport } = await runRajal(ELEKTRO_CLEAN, 'rajal_elektro_clean');
    expect(result.state.nodes.validate_elektromedik!.status).toBe('success');
    expect(result.state.nodes.validate_elektromedik!.summary).toBe('1 tindakan elektromedik sudah ada hasilnya');
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('blocks elektromedik when the result has no description', async () => {
    const { result, transport } = await runRajal(
      {
        ...ELEKTRO_CLEAN,
        'elektromedikHasil.getListHasilPemeriksaan': { text: JSON.stringify({ total: 1, rows: [{ deskripsi: '' }] }) },
      },
      'rajal_elektro_pending',
    );

    const node = result.state.nodes.validate_elektromedik!;
    expect(node.status).toBe('blocked');
    expect(node.summary).toMatch(/Hasil elektromedik belum ada pada 01-200001/);
    expect(node.summary).toMatch(/EKG-1/);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('blocks elektromedik when fewer results exist than billed treatments', async () => {
    const { result } = await runRajal(
      { ...ELEKTRO_CLEAN, 'elektromedikHasil.getDataPasien': { text: JSON.stringify({ rows: [] }) } },
      'rajal_elektro_missing',
    );

    expect(result.state.nodes.validate_elektromedik!.status).toBe('blocked');
    expect(result.state.nodes.validate_elektromedik!.summary).toMatch(
      /Hasil elektromedik kurang pada 01-200001: 1 tindakan elektromedik ditagih vs 0/,
    );
  });

  const LAB_PA_CLEAN = {
    ...tindakanFixture('LABORATORIUM PA'),
    'kemoterapi.getHistoryOrderPa': {
      text: JSON.stringify({
        rows: [{ no_transaksi: 'PA-1', tgl_transaksi: '10-Jun-2026', kd_jenis_pemeriksaan: '1' }],
      }),
    },
    'kemoterapi.getDetailHistoryOrderPa': {
      text: JSON.stringify({ rows: [{ nama_pemeriksaan: 'Histopatologi' }] }),
    },
    'pa.hasilCetak': { text: `HASIL PEMERIKSAAN PATOLOGI ANATOMI\n${'Makroskopik: jaringan. '.repeat(8)}` },
  };

  it('passes lab PA when the order has detail lines and a printable result', async () => {
    const { result, transport } = await runRajal(LAB_PA_CLEAN, 'rajal_labpa_clean');
    expect(result.state.nodes.validate_lab_pa!.status).toBe('success');
    expect(result.state.nodes.validate_lab_pa!.summary).toBe('1 tindakan lab pa sudah ada hasilnya');
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('blocks lab PA when the printout has no result', async () => {
    const { result, transport } = await runRajal(
      { ...LAB_PA_CLEAN, 'pa.hasilCetak': { text: 'Data tidak ada' } },
      'rajal_labpa_pending',
    );

    const node = result.state.nodes.validate_lab_pa!;
    expect(node.status).toBe('blocked');
    expect(node.summary).toMatch(/Hasil Lab PA belum ada pada 01-200001/);
    expect(node.summary).toMatch(/PA-1/);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('blocks lab PA when no PA order exists for the visit date', async () => {
    const { result } = await runRajal(
      {
        ...LAB_PA_CLEAN,
        'kemoterapi.getHistoryOrderPa': {
          text: JSON.stringify({ rows: [{ no_transaksi: 'PA-OLD', tgl_transaksi: '09-Jun-2026' }] }),
        },
      },
      'rajal_labpa_wrong_date',
    );

    expect(result.state.nodes.validate_lab_pa!.status).toBe('blocked');
    expect(result.state.nodes.validate_lab_pa!.summary).toMatch(
      /Order Lab PA belum ada pada 01-200001: tidak ada order PA tanggal 10-Jun-2026/,
    );
  });

  const LAB_CLEAN = {
    ...tindakanFixture('LABORATORIUM KLINIK'),
    'penatajasaInap.getHistoryILab': {
      text: JSON.stringify({ rows: [{ no_transaksi: 'LAB-1', tgl_transaksi: '10-Jun-2026' }] }),
    },
    'laboratoriumHasil.cetakLis': {
      text: '<html><body><iframe src="http://lis.example.local/pdf.php?no_transaksi=LAB-1"></iframe></body></html>',
    },
    'laboratoriumHasil.lisPdfHead': {
      text: '',
      headers: { 'content-type': 'application/pdf', 'content-length': '7408' },
    },
  };

  it('passes regular lab when the LIS PDF is larger than the empty report', async () => {
    const { result, transport } = await runRajal(LAB_CLEAN, 'rajal_lab_clean');
    expect(result.state.nodes.validate_lab!.status).toBe('success');
    expect(result.state.nodes.validate_lab!.summary).toBe('1 tindakan laboratorium sudah ada hasilnya');
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('blocks regular lab when the LIS PDF is the empty report', async () => {
    const { result, transport } = await runRajal(
      {
        ...LAB_CLEAN,
        'laboratoriumHasil.lisPdfHead': {
          text: '',
          headers: { 'content-type': 'application/pdf', 'content-length': '7407' },
        },
      },
      'rajal_lab_pending',
    );

    const node = result.state.nodes.validate_lab!;
    expect(node.status).toBe('blocked');
    expect(node.summary).toMatch(/Hasil laboratorium belum ada pada 01-200001/);
    expect(node.summary).toMatch(/LAB-1/);
    expect(node.summary).toMatch(/Content-Length: 7407/);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('falls back to GET when the LIS PDF headers are inconclusive', async () => {
    const { result, transport } = await runRajal(
      {
        ...LAB_CLEAN,
        'laboratoriumHasil.lisPdfHead': { text: '', headers: { 'content-type': 'application/pdf' } },
        'laboratoriumHasil.lisPdf': { text: '%PDF', bodyBytes: pdfBytes(7408) },
      },
      'rajal_lab_get_fallback',
    );

    expect(result.state.nodes.validate_lab!.status).toBe('success');
    expect(transport.calls.some((call) => call.headers['x-endpoint-id'] === 'laboratoriumHasil.lisPdf')).toBe(true);
  });

  it('blocks regular lab when the LIS printout reports no data', async () => {
    const { result } = await runRajal(
      { ...LAB_CLEAN, 'laboratoriumHasil.cetakLis': { text: 'Data tidak ada' } },
      'rajal_lab_empty_lis',
    );

    expect(result.state.nodes.validate_lab!.status).toBe('blocked');
    expect(result.state.nodes.validate_lab!.summary).toMatch(/data tidak ada/);
  });

  it('blocks regular lab when no lab order exists for the visit date', async () => {
    const { result } = await runRajal(
      { ...LAB_CLEAN, 'penatajasaInap.getHistoryILab': { text: JSON.stringify({ rows: [] }) } },
      'rajal_lab_no_order',
    );

    expect(result.state.nodes.validate_lab!.status).toBe('blocked');
    expect(result.state.nodes.validate_lab!.summary).toMatch(
      /Order laboratorium belum ada pada 01-200001: 1 tindakan lab ditagih tetapi tidak ada order lab tanggal 10-Jun-2026/,
    );
  });

  it('leaves a check untouched when the bill has no treatment of that modality', async () => {
    const { result } = await runRajal({}, 'rajal_penunjang_absent');
    expect(result.state.nodes.validate_radiology!.summary).toBe('Tidak ada tindakan radiologi yang ditagih');
    expect(result.state.nodes.validate_elektromedik!.summary).toBe('Tidak ada tindakan elektromedik yang ditagih');
    expect(result.state.nodes.validate_lab_pa!.summary).toBe('Tidak ada tindakan lab pa yang ditagih');
    expect(result.state.nodes.validate_lab!.summary).toBe('Tidak ada tindakan laboratorium yang ditagih');
  });
});

/** SEP parity: the SEP must belong to this visit date and this poli. */
describe('rajal treatment reasoning', () => {
  it('spells out every treatment rule as a met / not-met line', () => {
    expect(rajalTreatmentChecklist(['PENDAFTARAN PASIEN', 'ODC KECIL'], [
      { group: 'A', key: 'reg', name: 'PENDAFTARAN PASIEN' },
      { group: 'B', key: 'obat', name: 'BIAYA OBAT' },
      { group: 'B', key: 'hd', name: 'HAEMODIALISA' },
    ], ['ODC'])).toEqual([
      { label: 'Tidak ada tindakan "ODC"', ok: false, detail: 'ditemukan: ODC KECIL' },
      { label: 'Grup A: PENDAFTARAN PASIEN', ok: true, detail: 'ada: PENDAFTARAN PASIEN' },
      { label: 'Grup B: BIAYA OBAT / HAEMODIALISA', ok: false, detail: 'tidak ditagihkan' },
    ]);
  });

  it('attaches the checklist to the Tindakan step for the operator', async () => {
    const { result } = await runRajal({}, 'rajal_treatment_reasoning', {
      ...RAJAL_HAPPY_INPUT, skipTreatments: ['ODC'],
    } as typeof RAJAL_HAPPY_INPUT);
    const reasoning = reasoningOf(result.state.nodes.validate_treatment!.evidence);
    expect(reasoning?.items[0]).toMatchObject({ label: 'Tidak ada tindakan "ODC"', ok: true });
  });
});

describe('rajal SEP validation', () => {
  it('skips SEP validation when sepCheckRequired is false, and payment still runs', async () => {
    const { result, transport } = await runRajal({}, 'rajal_sep_off', { ...RAJAL_HAPPY_INPUT, sepCheckRequired: false } as typeof RAJAL_HAPPY_INPUT);
    expect(result.state.nodes.validate_sep!.status).toBe('skipped');
    expect(result.state.nodes.validate_sep!.summary).toMatch(/dinonaktifkan/);
    expect(transport.calls.some((call) => call.headers['x-endpoint-id'] === 'pendaftaran.getRiwayatSep')).toBe(false);
    expect(result.state.nodes.check_payment!.status).toBe('success');
    expect(result.state.nodes.submit_payment!.proposedMutations[0]!.endpointId).toBe('kasir.tampungBayar');
  });

  it('accepts a same-day SEP whose tgl_sep carries a timestamp', async () => {
    // BPJS rows can carry "2026-06-10 00:00:00"; a raw string compare dropped the
    // visit into the "no SEP that day" branch and blocked the transaction.
    const { result } = await runRajal(
      {
        'pendaftaran.getRiwayatSep': {
          text: JSON.stringify([
            { tgl_sep: '2026-06-10 00:00:00', jns_pelayanan: 'RJTL', poli_tujuan: 'PENYAKIT DALAM', no_sep: '0123456789012345' },
          ]),
        },
      },
      'rajal_sep_timestamp',
    );
    expect(result.state.nodes.validate_sep!.status).toBe('success');
  });

  it('accepts a same-day SEP whose tgl_sep is DD/MM/YYYY', async () => {
    const { result } = await runRajal(
      {
        'pendaftaran.getRiwayatSep': {
          text: JSON.stringify([
            { tgl_sep: '10/06/2026', jns_pelayanan: 'RJTL', poli_tujuan: 'PENYAKIT DALAM', no_sep: '0123456789012345' },
          ]),
        },
      },
      'rajal_sep_dmy',
    );
    expect(result.state.nodes.validate_sep!.status).toBe('success');
  });

  it('accepts a same-day RJTL SEP whose poli tujuan maps to the clinic', async () => {
    const { result } = await runRajal({}, 'rajal_sep_ok');
    expect(result.state.nodes.validate_sep!.status).toBe('success');
    expect(result.state.nodes.validate_sep!.summary).toMatch(/cocok dengan tanggal kunjungan dan poli tujuan/);
  });

  it('blocks when no same-day RJTL SEP matches the clinic', async () => {
    const { result, transport } = await runRajal(
      {
        'pendaftaran.getRiwayatSep': {
          text: JSON.stringify([
            { tgl_sep: '2026-06-10', jns_pelayanan: 'RJTL', poli_tujuan: 'MATA', no_sep: '0999999999999999' },
          ]),
        },
      },
      'rajal_sep_wrong_poli',
    );

    expect(result.state.nodes.validate_sep!.status).toBe('blocked');
    expect(result.state.nodes.validate_sep!.summary).toMatch(
      /No RJTL SEP dated 2026-06-10 for poli PENYAKIT DALAM on transaction 01-200001/,
    );
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('blocks when the visit has an inpatient SEP only', async () => {
    const { result } = await runRajal(
      {
        'pendaftaran.getRiwayatSep': {
          text: JSON.stringify([
            { tgl_sep: '2026-06-10', jns_pelayanan: 'RITL', poli_tujuan: 'PENYAKIT DALAM', no_sep: '0123456789012345' },
          ]),
        },
      },
      'rajal_sep_ritl',
    );

    expect(result.state.nodes.validate_sep!.status).toBe('blocked');
    expect(result.state.nodes.validate_sep!.summary).toMatch(/No RJTL SEP dated 2026-06-10/);
  });

  it('blocks when the patient has no BPJS card number', async () => {
    const { result } = await runRajal(
      { 'pendaftaran.getDataPenjaminTab': { text: JSON.stringify({ no_asuransi: '' }) } },
      'rajal_sep_no_card',
    );

    expect(result.state.nodes.validate_sep!.status).toBe('blocked');
    expect(result.state.nodes.validate_sep!.summary).toBe('No BPJS card number for transaction 01-200001');
  });

  it('plans a SEP correction (never writes) when the transaction carries the wrong SEP', async () => {
    const { result, transport } = await runRajal(
      {
        'kasir.getDataTransaksi': {
          text: JSON.stringify({ jenis_sep: 'Rawat Jalan', no_sep: '0000000000000001' }),
        },
      },
      'rajal_sep_mismatch',
    );

    const node = result.state.nodes.validate_sep!;
    expect(node.status).toBe('needs_review');
    expect(node.summary).toMatch(/SEP tidak cocok pada 1\/1 transaksi/);
    expect(node.proposedMutations[0]!.endpointId).toBe('rekamMedis.simpanSep');
    expect(node.proposedMutations[0]!.payloadSummary).toMatchObject({ no_sep: '0123456789012345' });
    // The read-after-write rule must target a read the backend answers:
    // `kasir.getDataTransaksi` returns an empty body live, and verifying
    // against it marked a successful `simpanSEP` as `failed` (legacy never
    // reads the SEP back at all).
    const rules = verificationRulesOf(node.proposedMutations[0]!);
    expect(rules.map((rule) => rule.endpointId)).toEqual(['pendaftaran.getRiwayatSep']);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  // Assertion changed deliberately: this case used to pass only because
  // `validate_sep` built its same-day sibling set from the raw visit history.
  // Legacy builds it from `matching` (source line 1057) — the records that
  // passed the clinic filter — so the fallback needs *both* poli selected. With
  // only PENYAKIT DALAM selected the legacy blocks, and so does the port now.
  it('blocks rather than borrowing a SEP from a clinic the operator did not select', async () => {
    const { result } = await runRajal(
      {
        'kasir.getHistoryKunjungan': {
          text: JSON.stringify({
            rows: [
              {
                no_registrasikunjungan: 'REG-RJ-1',
                no_transaksi: '01-200001',
                kd_unit: 'P01',
                nama_unit: 'POLI PENYAKIT DALAM',
                status_bayar: 'Belum',
                nama_penjamin: 'BPJS PBI',
                tgl_masuk: '2026-06-10',
              },
              {
                no_registrasikunjungan: 'REG-RJ-2',
                no_transaksi: '01-200002',
                kd_unit: 'P02',
                nama_unit: 'POLI MATA',
                status_bayar: 'Belum',
                nama_penjamin: 'BPJS PBI',
                tgl_masuk: '2026-06-10',
              },
            ],
          }),
        },
        'pendaftaran.getRiwayatSep': {
          text: JSON.stringify([
            { tgl_sep: '2026-06-10', jns_pelayanan: 'RJTL', poli_tujuan: 'MATA', no_sep: '0777777777777777' },
          ]),
        },
      },
      'rajal_sep_unselected_sibling',
    );

    expect(result.state.nodes.validate_sep!.status).toBe('blocked');
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
  });

  it('falls back to a unique sibling-clinic SEP on a multi-poli day', async () => {
    const { client } = previewClient({
      'kasir.getHistoryKunjungan': {
          text: JSON.stringify({
            rows: [
              {
                no_registrasikunjungan: 'REG-RJ-1',
                no_transaksi: '01-200001',
                kd_unit: 'P01',
                nama_unit: 'POLI PENYAKIT DALAM',
                status_bayar: 'Belum',
                nama_penjamin: 'BPJS PBI',
                tgl_masuk: '2026-06-10',
              },
              {
                no_registrasikunjungan: 'REG-RJ-2',
                no_transaksi: '01-200002',
                kd_unit: 'P02',
                nama_unit: 'POLI MATA',
                status_bayar: 'Belum',
                nama_penjamin: 'BPJS PBI',
                tgl_masuk: '2026-06-10',
              },
            ],
          }),
      },
      'pendaftaran.getRiwayatSep': {
        text: JSON.stringify([
          { tgl_sep: '2026-06-10', jns_pelayanan: 'RJTL', poli_tujuan: 'MATA', no_sep: '0777777777777777' },
        ]),
      },
    });
    const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
    const result = await runner.run({
      mode: 'preview',
      // Both poli selected: that is what makes the MATA visit a *sibling* of the
      // PENYAKIT DALAM visit rather than an unrelated encounter.
      input: { ...RAJAL_HAPPY_INPUT, clinics: ['PENYAKIT DALAM', 'MATA'] },
      runId: 'rajal_sep_sibling',
    });

    const node = result.state.nodes.validate_sep!;
    expect(node.status).toBe('needs_review');
    expect(node.proposedMutations[0]!.payloadSummary).toMatchObject({ no_sep: '0777777777777777' });
  });
});


/**
 * The deterministic half of each legacy guard, tested without I/O. These are
 * the rules a reviewer can check against the userscript line by line.
 */
describe('rajal legacy decisions', () => {
  describe('resolveClinicMatch (source lines 293-331)', () => {
    it('strips a leading POLI and matches the clinic exactly', () => {
      expect(normalizeClinicLabel('POLI KEBIDANAN & KANDUNGAN')).toBe('KEBIDANAN DAN KANDUNGAN');
      const match = resolveRajalClinicMatch('POLI PENYAKIT DALAM', ['PENYAKIT DALAM']);
      expect(match).toMatchObject({ matchedClinic: 'PENYAKIT DALAM', ambiguous: false, unitNorm: 'PENYAKIT DALAM' });
    });

    it('prefers the longer, more specific clinic over a shorter substring', () => {
      // 'BEDAH ANAK' is an exact hit (3000); 'ANAK' only a suffix (1904).
      const match = resolveRajalClinicMatch('POLI BEDAH ANAK', ['ANAK', 'BEDAH ANAK']);
      expect(match.matchedClinic).toBe('BEDAH ANAK');
      expect(match.ambiguous).toBe(false);
    });

    it('reports ambiguity when two selected clinics tie', () => {
      // Both clinics merely contain the unit label, and both normalize to the
      // same length, so no tie-break separates them. Legacy refuses to guess.
      const match = resolveRajalClinicMatch('POLI BEDAH', ['BEDAH ANAK', 'BEDAH MATA']);
      expect(match.ambiguous).toBe(true);
      expect(match.matchedClinic).toBe('');
      expect(match.matches).toEqual(['BEDAH ANAK', 'BEDAH MATA']);
    });

    it('treats entries that normalize alike as one poli, not a tie', () => {
      // Live 2026-10-20: section titles gave "DALAM" and " DALAM"; the visit read as ambiguous.
      const match = resolveRajalClinicMatch('POLI DALAM', ['DALAM', ' DALAM', 'POLI DALAM']);
      expect(match).toMatchObject({ matchedClinic: 'DALAM', ambiguous: false });
      expect(extractRajalClinicFromSection('POLI  DALAM ')).toBe('DALAM');
    });

    it('returns no match for an unrelated unit and for an empty selection', () => {
      expect(resolveRajalClinicMatch('POLI MATA', ['PENYAKIT DALAM']).matchedClinic).toBe('');
      expect(resolveRajalClinicMatch('POLI MATA', []).matchedClinic).toBe('');
      expect(resolveRajalClinicMatch('', ['MATA']).matchedClinic).toBe('');
    });
  });

  describe('verifyTreatmentGroups (source lines 762-782)', () => {
    const groups = [
      { group: 'A', key: 'registration', name: 'PENDAFTARAN PASIEN' },
      { group: 'B', key: 'obat', name: 'BIAYA OBAT' },
      { group: 'B', key: 'hd', name: 'HAEMODIALISA' },
    ];

    it('treats one group letter as OR', () => {
      const viaObat = verifyRajalTreatmentGroups(['PENDAFTARAN PASIEN', 'BIAYA OBAT'], groups, []);
      const viaHd = verifyRajalTreatmentGroups(['PENDAFTARAN PASIEN', 'HAEMODIALISA RUTIN'], groups, []);
      expect(viaObat).toEqual({ ok: true, matched: { registration: 'PENDAFTARAN PASIEN', obat: 'BIAYA OBAT' } });
      expect(viaHd).toEqual({ ok: true, matched: { registration: 'PENDAFTARAN PASIEN', hd: 'HAEMODIALISA RUTIN' } });
    });

    it('treats different group letters as AND', () => {
      const verdict = verifyRajalTreatmentGroups(['BIAYA OBAT'], groups, []);
      expect(verdict).toEqual({ ok: false, kind: 'group', group: 'A', expected: ['PENDAFTARAN PASIEN'] });
    });

    it('names every alternative of the group it could not satisfy', () => {
      const verdict = verifyRajalTreatmentGroups(['PENDAFTARAN PASIEN'], groups, []);
      expect(verdict).toEqual({ ok: false, kind: 'group', group: 'B', expected: ['BIAYA OBAT', 'HAEMODIALISA'] });
    });

    it('rejects on a skip treatment case-insensitively', () => {
      const verdict = verifyRajalTreatmentGroups(['PENDAFTARAN PASIEN', 'Tindakan ODC Mata'], groups, ['odc']);
      expect(verdict).toEqual({ ok: false, kind: 'skip', keyword: 'odc', found: 'Tindakan ODC Mata' });
    });

    it('matches group names case-sensitively, as legacy did', () => {
      // Legacy line 776 uses a bare `includes`, so a lower-case bill row does
      // not satisfy an upper-case requirement. Faithful, not a slip.
      const verdict = verifyRajalTreatmentGroups(['pendaftaran pasien', 'BIAYA OBAT'], groups, []);
      expect(verdict).toEqual({ ok: false, kind: 'group', group: 'A', expected: ['PENDAFTARAN PASIEN'] });
    });

    it('passes when the operator configured no groups at all', () => {
      expect(verifyRajalTreatmentGroups(['APAPUN'], [], [])).toEqual({ ok: true, matched: {} });
    });

    it('checks the skip list before the groups', () => {
      expect(verifyRajalTreatmentGroups(['ODC'], groups, ['ODC'])).toMatchObject({ ok: false, kind: 'skip' });
    });
  });

  describe('rencana onko (source lines 886-889)', () => {
    it('blocks a plan naming chemotherapy, in any case', () => {
      expect(evaluateRajalOncologyPlan({ isi_perencanaan: 'Rencana KEMOTERAPI siklus 3' })).toEqual({
        blocking: true,
        plan: 'Rencana KEMOTERAPI siklus 3',
        readable: true,
      });
    });

    it('passes a plan that does not name chemotherapy', () => {
      expect(evaluateRajalOncologyPlan({ isi_perencanaan: 'Kontrol rutin' })).toMatchObject({
        blocking: false,
        readable: true,
      });
    });

    it('reports an unreadable response instead of calling it clean', () => {
      // Legacy's optional chaining silently paid here; `readable: false` is what
      // lets the executor return needs_review rather than success.
      for (const response of [null, undefined, {}, 'oops', [], { isi_perencanaan: 42 }]) {
        expect(evaluateRajalOncologyPlan(response), String(JSON.stringify(response))).toMatchObject({
          blocking: false,
          readable: false,
        });
      }
    });
  });

  describe('exit date (source lines 891-892)', () => {
    it('accepts a populated exit date', () => {
      expect(evaluateRajalExitDate('2026-06-10 12:30:00')).toEqual({
        readable: true,
        present: true,
        date: '2026-06-10 12:30:00',
      });
    });

    it('blocks an empty exit date', () => {
      expect(evaluateRajalExitDate('  ')).toMatchObject({ readable: true, present: false });
    });

    it('reports an absent field separately from an empty one', () => {
      expect(evaluateRajalExitDate(undefined)).toMatchObject({ readable: false, present: false });
      expect(evaluateRajalExitDate(null)).toMatchObject({ readable: false, present: false });
    });

    it('reads the exit date off a getdatacarakeluar_tab reply', () => {
      expect(evaluateRajalExitDateResponse({ tgl_keluar: '2026-06-10 12:30:00' })).toEqual({
        readable: true,
        present: true,
        date: '2026-06-10 12:30:00',
      });
    });

    it('treats an absent, null or empty tgl_keluar as "not discharged", as legacy does', () => {
      // `!ck?.tgl_keluar` (source line 892) cannot tell these apart, and neither
      // should we once the discharge tab itself has answered — all three block.
      for (const response of [{}, { tgl_keluar: null }, { tgl_keluar: '' }, { cara_keluar: 'X' }]) {
        expect(evaluateRajalExitDateResponse(response), JSON.stringify(response)).toMatchObject({
          readable: true,
          present: false,
        });
      }
    });

    it('reports a reply that is not a discharge record at all', () => {
      for (const response of [null, undefined, [], 'Data tidak ada', 42]) {
        expect(evaluateRajalExitDateResponse(response), JSON.stringify(response)).toMatchObject({
          readable: false,
          present: false,
        });
      }
    });
  });

  describe('pre-verification blockers (source lines 1005-1011)', () => {
    it('blocks an order check only when the total is above zero', () => {
      expect(evaluateRajalOrderBlocker({ total: 2, nama_unit: 'RADIOLOGI' })).toMatchObject({
        blocking: true,
        total: 2,
        namaUnit: 'RADIOLOGI',
      });
      expect(evaluateRajalOrderBlocker({ total: '3' })).toMatchObject({ blocking: true, total: 3 });
    });

    it('does not block on a string "0" total', () => {
      // Legacy's `if(o1?.total)` blocks here because "0" is truthy in JS, which
      // would refuse every clean transaction. ranap_v3.py:3773 reads the same
      // endpoint as int(total) > 0; the port follows the Python.
      expect(evaluateRajalOrderBlocker({ total: '0' })).toMatchObject({ blocking: false, total: 0 });
      expect(evaluateRajalOrderBlocker({ total: 0 })).toMatchObject({ blocking: false });
      expect(evaluateRajalOrderBlocker({})).toMatchObject({ blocking: false });
    });

    it('blocks a penunjang check when the reply carries any field', () => {
      expect(evaluateRajalPenunjangBlocker({})).toMatchObject({ blocking: false });
      expect(evaluateRajalPenunjangBlocker({ nama_unit: 'LABORATORIUM' })).toMatchObject({
        blocking: true,
        namaUnit: 'LABORATORIUM',
      });
      expect(evaluateRajalPenunjangBlocker('Masih ada transaksi penunjang')).toMatchObject({
        blocking: true,
        data: 'Masih ada transaksi penunjang',
      });
      expect(evaluateRajalPenunjangBlocker('')).toMatchObject({ blocking: false });
    });

    it('treats an empty array as clean and a populated array as a blocker', () => {
      // The endpoint sometimes answers with a bare list. Legacy's
      // `Object.keys(pc).length` is truthy for any element, so a non-empty list
      // must block — while an empty one means "nothing outstanding".
      expect(evaluateRajalPenunjangBlocker([])).toMatchObject({ blocking: false, total: 0 });
      expect(evaluateRajalPenunjangBlocker([{ nama_unit: 'LABORATORIUM' }])).toMatchObject({ blocking: true });
      expect(evaluateRajalPenunjangBlocker([{ total: 1 }])).toMatchObject({ blocking: true, total: 1 });
    });

    it('fails closed when the penunjang reply cannot be interpreted', () => {
      // An unreadable reply must never read as "verified": the payment guards
      // downstream treat `blocking: false` as permission to pay.
      expect(evaluateRajalPenunjangBlocker(null)).toMatchObject({ blocking: true });
      expect(evaluateRajalPenunjangBlocker(undefined)).toMatchObject({ blocking: true });
      expect(evaluateRajalPenunjangBlocker(0)).toMatchObject({ blocking: true });
      expect(evaluateRajalPenunjangBlocker({})).toMatchObject({ blocking: false });
    });
  });

  describe('payment vocabularies (source lines 61-84)', () => {
    it('maps legacy payment and shift labels to the codes the cashier endpoint stores', () => {
      expect(RAJAL_PAYMENT_TYPE_OPTIONS.map((option) => [option.label, option.code])).toEqual([
        ['TUNAI', '1'],
        ['PIUTANG', '2'],
        ['SETOR BSI', '3'],
        ['EDC BRI', '4'],
        ['EDC BNI', '5'],
        ['EDC MANDIRI', '6'],
        ['TRANSFER BSI', '7'],
        ['TRANSFER BRI', '9'],
        ['TRANSFER BNI', '10'],
        ['QRIS', '11'],
        ['TRANSFER MANDIRI', '12'],
        ['Keuangan', '13'],
        ['PIUTANG BPJS', '14'],
        ['PIUTANG UMUM', '15'],
        ['EDC BSI', '17'],
      ]);
      expect(RAJAL_SHIFT_OPTIONS.map((option) => [option.label, option.code])).toEqual([
        ['Shift 1', '1'],
        ['Shift 2', '2'],
        ['Shift 3', '3'],
      ]);
      expect(rajalPaymentTypeCode('QRIS')).toBe('11');
      expect(rajalPaymentTypeCode('11')).toBe('11');
      expect(rajalShiftCode('Shift 3')).toBe('3');
      expect(rajalShiftCode('shift malam 3')).toBe('3');
      expect(normalizeRajalPaymentConfig({ shift: 'Shift 2', type: 'QRIS', payerCode: ' 14 ' })).toEqual({
        shift: '2',
        type: '11',
        payerCode: '14',
      });
    });
  });

  describe('tampung bayar payload (source lines 1021-1032)', () => {
    it('builds every field the cashier endpoint expects', () => {
      const rows = [{ nama_tindakan: 'PENDAFTARAN PASIEN' }];
      const payload = buildRajalTampungBayarPayload({
        noReg: 'REG-RJ-1',
        noTransaksi: '01-200001',
        kdUnit: 'P01',
        total: '150000',
        sudah: '0',
        tindakanRows: rows,
      });

      expect(payload).toEqual({
        no_reg: 'REG-RJ-1',
        no_transaksi: '01-200001',
        kd_unit: 'P01',
        ck_retur: 'false',
        kd_penjamin: '15',
        // A form-encoded string nested inside a form field — the backend
        // re-parses it, so the encoding is part of the contract.
        dt_bayar:
          'cmbshift_pembayaran=1&cmbjenis_pembayaran=14&txtdiskonpn_pembayaran=&txtdiskonrp_pembayaran=&txtpembulatan_pembayaran=&cmbkartu_pembayaran=&txtjumlah_pembayaran=150000&txtjmltagihan_pembayaran=150000&txtjmldibayar_pembayaran=0',
        tindakan: JSON.stringify(rows),
      });
    });

    it('honours an operator payment config as legacy labels or raw codes', () => {
      const payload = buildRajalTampungBayarPayload({
        noReg: 'R',
        noTransaksi: 'T',
        kdUnit: 'U',
        total: '10',
        sudah: '5',
        tindakanRows: [],
        payment: { shift: 'Shift 2', type: 'QRIS', payerCode: '14' },
      });
      expect(payload.kd_penjamin).toBe('14');
      expect(Object.fromEntries(new URLSearchParams(payload.dt_bayar ?? ''))).toMatchObject({
        cmbshift_pembayaran: '2',
        cmbjenis_pembayaran: '11',
        txtjmldibayar_pembayaran: '5',
      });
    });
  });
});

/**
 * Batch discovery — legacy `doFetch` (source line 1451) plus `parseLaporanHTML`
 * (line 514). This is the only legacy step that decides *which* records a run
 * is about, so it is tested as a pure function over the report markup plus one
 * request-shape assertion over the real GET.
 */
describe('rajal batch discovery', () => {
  it('scrapes patients out of the first bordered table, section by section', () => {
    const report = parseRajalUnpaidReport(RAJAL_UNPAID_REPORT_HTML);

    expect(report.sections).toEqual(['POLI PENYAKIT DALAM', 'POLI MATA', 'LABORATORIUM KLINIK']);
    expect(report.patients.map((row) => [row.no, row.noTransaksi, row.noRM, row.penjamin, row.section])).toEqual([
      [1, '01-200001', '0-01-23-45', 'BPJS PBI', 'POLI PENYAKIT DALAM'],
      [2, '01-200002', '0-67-89-01', 'UMUM', 'POLI PENYAKIT DALAM'],
      [3, '01-200003', '0-01-23-45', 'BPJS NON PBI', 'POLI MATA'],
      [4, '13-400001', '0-99-88-77', 'BPJS PBI', 'LABORATORIUM KLINIK'],
    ]);
    expect(report.stats).toMatchObject({ total: 4, filtered: 4 });
    expect(report.stats.bySection).toEqual({
      'POLI PENYAKIT DALAM': 2,
      'POLI MATA': 1,
      'LABORATORIUM KLINIK': 1,
    });
  });

  it('ignores commented-out cells rather than letting them shift the columns', () => {
    // Row 2 carries a commented `<td>` between the discharge time and the sex
    // column, exactly as the live report does. Counting it would push penjamin
    // out of cell 5 and read the medrec off the wrong column.
    const row = parseRajalUnpaidReport(RAJAL_UNPAID_REPORT_HTML).patients.find((item) => item.no === 2);
    expect(row).toMatchObject({ noRM: '0-67-89-01', penjamin: 'UMUM' });
  });

  it('skips the header row, the subtotal row and the second table', () => {
    const report = parseRajalUnpaidReport(RAJAL_UNPAID_REPORT_HTML);
    // A `colspan="12"` subtotal never becomes a patient, the `<th>` header row
    // has no `<td>` at all, and `TABEL LAIN` lives in a later bordered table
    // that legacy's `tables[0]` never reaches.
    expect(report.patients).toHaveLength(4);
    expect(report.sections).not.toContain('TABEL LAIN');
  });

  it('reports a reply with no bordered table as unread, not as empty', () => {
    // The client does not surface the HTTP status to a caller, so a 500, a
    // login redirect and a genuinely quiet period would otherwise be
    // indistinguishable. Whether the report rendered its table at all is the
    // only evidence there is, and "not read" must never read as "nothing due".
    expect(parseRajalUnpaidReport('<html><body>Data tidak ada</body></html>')).toEqual({
      readable: false,
      patients: [],
      sections: [],
      stats: { total: 0, filtered: 0, bySection: {}, byPenjamin: {} },
    });
  });

  it('reports a rendered table with no data row as a readable, empty period', () => {
    const report = parseRajalUnpaidReport(RAJAL_UNPAID_REPORT_EMPTY_HTML);
    expect(report).toMatchObject({ readable: true, patients: [], stats: { total: 0 } });
    expect(selectRajalUnpaidBatch(report)).toMatchObject({ readable: true, patientIds: [], clinics: [] });
  });

  it('filters by penjamin substring, case-insensitively', () => {
    const report = parseRajalUnpaidReport(RAJAL_UNPAID_REPORT_HTML, { penjamin: 'bpjs' });
    expect(report.patients.map((row) => row.noTransaksi)).toEqual(['01-200001', '01-200003', '13-400001']);
    expect(report.stats).toMatchObject({ total: 4, filtered: 3 });
  });

  it('filters by any of the comma-separated unit substrings', () => {
    const report = parseRajalUnpaidReport(RAJAL_UNPAID_REPORT_HTML, { unit: 'mata, laboratorium' });
    expect(report.patients.map((row) => row.section)).toEqual(['POLI MATA', 'LABORATORIUM KLINIK']);
  });

  it('turns the report into the batch a run would be given', () => {
    const batch = selectRajalUnpaidBatch(
      parseRajalUnpaidReport(RAJAL_UNPAID_REPORT_HTML, { penjamin: 'BPJS' }),
      { penjamin: 'BPJS' },
    );

    // Duplicates are kept in `patientIds` — legacy writes `rmList` into the
    // textarea and only counts `uniqueRM` separately.
    expect(batch.patientIds).toEqual(['0-01-23-45', '0-01-23-45', '0-99-88-77']);
    expect(batch.uniquePatientIds).toEqual(['0-01-23-45', '0-99-88-77']);
    // `POLI ` is stripped; LABORATORIUM KLINIK is an AUTO_EXCLUDE section.
    expect(batch.clinics).toEqual(['PENYAKIT DALAM', 'MATA']);
    expect(batch.excludedSections).toEqual(['LABORATORIUM KLINIK']);
  });

  it('maps each medrec to the clinics it was seen under, excluding penunjang sections', () => {
    const batch = selectRajalUnpaidBatch(parseRajalUnpaidReport(RAJAL_UNPAID_REPORT_HTML));
    // The same patient appears under two poli; the lab row contributes nothing.
    expect(batch.clinicsByPatientId).toEqual({
      '0-01-23-45': ['PENYAKIT DALAM', 'MATA'],
      '0-67-89-01': ['PENYAKIT DALAM'],
    });
  });

  it('narrows the clinic chips with the unit filter, not just the rows', () => {
    const batch = selectRajalUnpaidBatch(
      parseRajalUnpaidReport(RAJAL_UNPAID_REPORT_HTML, { unit: 'MATA' }),
      { unit: 'MATA' },
    );
    expect(batch.clinics).toEqual(['MATA']);
    expect(batch.patientIds).toEqual(['0-01-23-45']);
  });

  it('builds the eighteen-parameter report query legacy sends', () => {
    expect(buildRajalUnpaidReportQuery({ from: '2026-06-10', to: '2026-06-10' })).toEqual({
      cmbinstalasi: '1',
      cmbunit: '',
      cmbshift: '',
      txtperiode1: '2026-06-10',
      txtperiode2: '2026-06-10',
      namaunit: '',
      cmbpenjamin: '',
      ckstatus: 'false',
      ckstatustidakbatal: 'true',
      kd_ruangperawatan: '',
      nama_ruangperawatan: '',
      kd_kamarperawatan: '',
      nama_kamarperawatan: '',
      ckbaru: 'false',
      cklama: 'false',
      ckkasusbaru: 'false',
      ckkasuslama: 'false',
      kd_icdx: '',
    });
    expect(buildRajalUnpaidReportQuery({ instalasi: '14', from: 'a', to: 'b' }).cmbinstalasi).toBe('14');
    expect(RAJAL_INSTALASI_OPTIONS.map((option) => option.code)).toEqual(['1', '14', '2', '3']);
  });

  it('GETs the report with every parameter in the query string', async () => {
    // `laporanBelumBayar.preview` is a GET, and the client only form-encodes a
    // body for POSTs — parameters handed to the body would vanish. Only the
    // recorded request proves they travelled.
    const { client, transport } = previewClient();
    const batch = await fetchRajalUnpaidBatch(client, {
      instalasi: '1',
      from: '2026-06-10',
      to: '2026-06-10',
      penjamin: 'BPJS',
    });

    const call = transport.calls.find((item) => item.headers['x-endpoint-id'] === 'laporanBelumBayar.preview')!;
    expect(call).toBeDefined();
    expect(call.method).toBe('GET');
    expect(call.body).toBeUndefined();
    expect(call.url).toMatch(/laporan\/laporan_belum_bayar\/preview\?/);
    expect(Object.fromEntries(new URL(call.url).searchParams)).toEqual(
      buildRajalUnpaidReportQuery({ instalasi: '1', from: '2026-06-10', to: '2026-06-10' }),
    );
    expect(batch.uniquePatientIds).toEqual(['0-01-23-45', '0-99-88-77']);
    expect(batch.clinics).toEqual(['PENYAKIT DALAM', 'MATA']);
    // Reading a report never mutates anything.
    expect(mutatingCalls(transport)).toHaveLength(0);
  });
});

/** Visit-history rows, spread so a test can vary one field. */
function historyFixture(rows: Record<string, unknown>[]) {
  return { 'kasir.getHistoryKunjungan': { text: JSON.stringify({ rows }) } };
}

const RECORD_BASE = {
  no_registrasikunjungan: 'REG-RJ-1',
  no_transaksi: '01-200001',
  kd_unit: 'P01',
  nama_unit: 'POLI PENYAKIT DALAM',
  status_bayar: 'Belum',
  nama_penjamin: 'BPJS PBI',
  tgl_masuk: '2026-06-10',
};

/**
 * Auto-fetch as a *run* — legacy `doFetch` (source line 1451) reaching the
 * pipeline rather than sitting beside it. `rajal.normalizeIds` owns the fetch
 * because that node is `critical`: a report that could not be read has to stop
 * the run, not hand the graph an empty batch every downstream node would
 * benignly skip its way through and report as a clean, finished run.
 */
describe('rajal auto-fetch runs', () => {
  /** Endpoint ids in call order, for "what did this run actually read". */
  function endpointsCalled(transport: FixtureTransport): string[] {
    return transport.calls.map((call) => call.headers['x-endpoint-id'] ?? '');
  }

  /** Every medrec the visit-history endpoint was queried with, in order. */
  function medrecsRead(transport: FixtureTransport): string[] {
    return transport.calls
      .filter((call) => call.headers['x-endpoint-id'] === 'kasir.getHistoryKunjungan')
      .map((call) => Object.fromEntries(new URLSearchParams(call.body ?? '')).nomedrec ?? '');
  }

  async function runDiscovery(
    input: Record<string, unknown>,
    runId: string,
    overrides: Record<string, any> = {},
  ) {
    const { client, transport } = previewClient(overrides);
    const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
    const result = await runner.run({ mode: 'preview', input, runId });
    return { result, transport };
  }

  /** `RAJAL_DISCOVERY_INPUT` with one discovery field varied. */
  function discoveryInput(discovery: Record<string, unknown>, rest: Record<string, unknown> = {}) {
    return {
      ...RAJAL_DISCOVERY_INPUT,
      discovery: { ...RAJAL_DISCOVERY_INPUT.discovery, ...discovery },
      ...rest,
    };
  }

  it('discovers its own batch and bills the patients the report named', async () => {
    const { result, transport } = await runDiscovery(RAJAL_DISCOVERY_INPUT, 'rajal_discovery', {
      ...historyFixture([RECORD_BASE]),
    });

    const normalize = result.state.nodes.normalize_ids!;
    expect(normalize.status).toBe('success');
    // Three BPJS rows in the fixture report, two distinct medrecs.
    expect(normalize.summary).toBe('2 No. RM unik dari 3 baris belum bayar');
    // The report's own section headings become the clinic list; the
    // LABORATORIUM KLINIK grouping is billed through its poli and is excluded.
    expect(result.state.nodes.resolve_clinics!.summary).toBe('Poli diproses: PENYAKIT DALAM, MATA');
    expect(medrecsRead(transport)).toEqual(['0-01-23-45', '0-99-88-77']);
    expect(result.state.nodes.submit_payment!.proposedMutations.length).toBeGreaterThan(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('GETs the report with the period in the query string and the filters left client-side', async () => {
    // `laporanBelumBayar.preview` is a GET; parameters handed to the body would
    // vanish. `penjamin` and `unit` are scrapes of the rendered report, so
    // `cmbpenjamin` stays empty on the wire — only the recorded request shows it.
    const { transport } = await runDiscovery(RAJAL_DISCOVERY_INPUT, 'rajal_discovery_shape', {
      ...historyFixture([RECORD_BASE]),
    });

    const call = transport.calls.find((item) => item.headers['x-endpoint-id'] === 'laporanBelumBayar.preview')!;
    expect(call).toBeDefined();
    expect(call.method).toBe('GET');
    expect(call.body).toBeUndefined();
    expect(Object.fromEntries(new URL(call.url).searchParams)).toEqual(
      buildRajalUnpaidReportQuery({ instalasi: '1', from: '2026-06-10', to: '2026-06-10' }),
    );
  });

  it('processes a patient discovered under two poli for both of them', async () => {
    // Legacy `mergeAutoClinicPatients` (source line 361) records both sections
    // the medrec appeared under, and both become clinic chips, so both of the
    // patient's visits match.
    const { result } = await runDiscovery(
      discoveryInput({ unit: 'PENYAKIT DALAM, MATA' }),
      'rajal_discovery_two_clinics',
      {
        ...historyFixture([
          RECORD_BASE,
          {
            ...RECORD_BASE,
            no_registrasikunjungan: 'REG-RJ-2',
            no_transaksi: '01-200003',
            kd_unit: 'P02',
            nama_unit: 'POLI MATA',
          },
        ]),
        'pendaftaran.getRiwayatSep': {
          text: JSON.stringify([
            { tgl_sep: '2026-06-10', jns_pelayanan: 'RJTL', poli_tujuan: 'PENYAKIT DALAM', no_sep: '0123456789012345' },
            { tgl_sep: '2026-06-10', jns_pelayanan: 'RJTL', poli_tujuan: 'MATA', no_sep: '0123456789012345' },
          ]),
        },
      },
    );

    // The unit filter drops the lab section, so exactly one patient is found.
    expect(result.state.nodes.normalize_ids!.summary).toBe('1 No. RM unik dari 2 baris belum bayar');
    expect(result.state.nodes.resolve_clinics!.summary).toBe('Poli diproses: PENYAKIT DALAM, MATA');
    expect(result.state.nodes.filter_records!.summary).toBe('2 kunjungan cocok');
    expect(
      result.state.nodes.submit_payment!.proposedMutations.map((plan) => plan.payloadSummary.no_transaksi).sort(),
    ).toEqual(['01-200001', '01-200003']);
  });

  it('drops a discovered patient seen under no selected poli', async () => {
    // Legacy `removePatientIdsForClinic` (source line 373). `0-67-89-01` was
    // only ever listed under PENYAKIT DALAM, so selecting MATA removes it;
    // `0-99-88-77` was never auto-mapped to any poli (its only section is the
    // excluded lab grouping) and legacy's `beforeManaged` guard leaves it alone.
    const { result, transport } = await runDiscovery(
      discoveryInput({ penjamin: undefined, maxPatients: 5 }, { clinics: ['MATA'] }),
      'rajal_discovery_narrowed',
      { ...historyFixture([{ ...RECORD_BASE, nama_unit: 'POLI MATA' }]) },
    );

    expect(result.state.nodes.normalize_ids!.summary).toBe('3 No. RM unik dari 4 baris belum bayar');
    expect(result.state.nodes.resolve_clinics!.summary).toBe('Poli diproses: MATA');
    expect(medrecsRead(transport)).toEqual(['0-01-23-45', '0-99-88-77']);
  });

  it('keeps a discovered patient whose report section is an alias of the selected chip', async () => {
    // The form's default chip is the mapping alias `DALAM`, while the report
    // section reads `POLI PENYAKIT DALAM`. Legacy matched the two through the
    // clinic resolver, so an exact string compare dropped every patient and
    // completed the batch with no payment plan at all.
    const { result, transport } = await runDiscovery(
      discoveryInput({ penjamin: undefined, maxPatients: 5 }, { clinics: ['DALAM'] }),
      'rajal_discovery_alias',
      { ...historyFixture([RECORD_BASE]) },
    );

    expect(result.state.nodes.resolve_clinics!.summary).toBe('Poli diproses: DALAM');
    expect(medrecsRead(transport)).toEqual(['0-01-23-45', '0-67-89-01', '0-99-88-77']);
    expect(result.state.nodes.submit_payment!.proposedMutations.length).toBeGreaterThan(0);
  });

  it('keeps POLI ANAK patients for the ANAK chip', async () => {
    // The report labels the section `POLI ANAK` while the operator's chip is
    // the bare `ANAK`; only the resolver bridges those. An exact set compare
    // dropped the patient, so the batch reached SEP validation empty.
    const { result, transport } = await runDiscovery(
      discoveryInput({ penjamin: undefined, maxPatients: 5 }, { clinics: ['ANAK'] }),
      'rajal_discovery_anak',
      {
        'laporanBelumBayar.preview': {
          text: RAJAL_UNPAID_REPORT_HTML.replace('<b>POLI MATA</b>', '<b>POLI ANAK</b>'),
        },
        ...historyFixture([{ ...RECORD_BASE, nama_unit: 'POLI ANAK' }]),
      },
    );

    expect(result.state.nodes.resolve_clinics!.summary).toBe('Poli diproses: ANAK');
    expect(result.state.nodes.start_batch!.summary).not.toBe('Batch of 0 patient(s) started');
    expect(result.state.nodes.filter_records!.summary).toBe('2 kunjungan cocok');
    // The plain fixture has no SEP for POLI ANAK, so the run stops there rather
    // than planning a payment off a record whose SEP was never validated.
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('drops every discovered patient seen only under another poli and bills nothing', async () => {
    // Every patient whose report section maps to a poli is seen only under
    // PENYAKIT DALAM, so selecting ANAK drops them; the one patient the report
    // never mapped to a poli (its only section is the excluded lab grouping) is
    // left alone by legacy's `beforeManaged` guard, and its own visit does not
    // match ANAK either — so no payment may be planned.
    const { result, transport } = await runDiscovery(
      discoveryInput({ penjamin: undefined, maxPatients: 5 }, { clinics: ['ANAK'] }),
      'rajal_discovery_all_filtered',
      { ...historyFixture([RECORD_BASE]) },
    );

    const resolve = result.state.nodes.resolve_clinics!;
    expect(resolve.status).toBe('success');
    expect(resolve.logs.some((log) => /Dropped discovered patient\(s\) seen under no selected poli/.test(log.message))).toBe(true);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('reports an empty period as an empty batch, not as a failure', async () => {
    const { result, transport } = await runDiscovery(RAJAL_DISCOVERY_INPUT, 'rajal_discovery_empty', {
      'laporanBelumBayar.preview': { text: RAJAL_UNPAID_REPORT_EMPTY_HTML },
    });

    const normalize = result.state.nodes.normalize_ids!;
    expect(normalize.status).toBe('skipped');
    expect(normalize.summary).toBe(
      'Tidak ada yang ditagih: 2026-06-10 → 2026-06-10 berisi 0 baris belum bayar, tidak ada yang cocok dengan instalasi Rawat Jalan, penjamin "BPJS"',
    );
    // A benign skip, so the graph runs on and finds nothing — no failure, and
    // nothing beyond the report was ever read.
    expect(result.status).toBe('completed');
    expect(result.state.nodes.resolve_clinics!.status).toBe('skipped');
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(endpointsCalled(transport)).toEqual(['laporanBelumBayar.preview']);
  });

  it('never turns a failed discovery read into an empty batch', async () => {
    const { result, transport } = await runDiscovery(RAJAL_DISCOVERY_INPUT, 'rajal_discovery_throw', {
      'laporanBelumBayar.preview': () => {
        throw new Error('ECONNREFUSED');
      },
    });

    const normalize = result.state.nodes.normalize_ids!;
    expect(normalize.status).toBe('blocked');
    expect(normalize.summary).toMatch(/^Gagal membaca laporan cari otomatis untuk 2026-06-10 → 2026-06-10/);
    expect(normalize.summary).toMatch(/laporan yang gagal dibaca bukan laporan kosong/);
    // `normalize_ids` is critical, so the run stops rather than reporting a
    // tidy "nothing to do".
    expect(result.status).toBe('failed');
    expect(result.state.nodes.submit_payment!.status).not.toBe('success');
    expect(endpointsCalled(transport)).toEqual(['laporanBelumBayar.preview']);
  });

  it('treats a report that never rendered its table as unread, not as empty', async () => {
    // A 500 or a login redirect arrives as markup and the client does not
    // surface the status, so the missing table is the only evidence available.
    const { result } = await runDiscovery(RAJAL_DISCOVERY_INPUT, 'rajal_discovery_no_table', {
      'laporanBelumBayar.preview': { status: 500, text: '<html><body>Internal Server Error</body></html>' },
    });

    expect(result.state.nodes.normalize_ids!.status).toBe('blocked');
    expect(result.state.nodes.normalize_ids!.summary).toMatch(/dijawab tanpa tabel laporan/);
    expect(result.status).toBe('failed');
  });

  it('takes the whole discovered batch without a cap, and refuses one above an explicit cap', async () => {
    const open = await runDiscovery(discoveryInput({ maxPatients: undefined }), 'rajal_discovery_uncapped');
    expect(open.result.state.nodes.normalize_ids!.status).toBe('success');

    // An explicit cap blocks before a single patient record is read, and names the real count.
    const { result, transport } = await runDiscovery(
      discoveryInput({ maxPatients: 1 }),
      'rajal_discovery_capped',
    );

    const normalize = result.state.nodes.normalize_ids!;
    expect(normalize.status).toBe('blocked');
    expect(normalize.summary).toMatch(/Ditemukan 2 pasien.*melebihi batas 1 pasien/);
    expect(result.status).toBe('failed');
    expect(endpointsCalled(transport)).toEqual(['laporanBelumBayar.preview']);
  });

  it('caps the poli-narrowed batch, not the whole report (live shape)', async () => {
    // Live 2026-10-15: a SYARAF chip blocked on "607 patient(s)" — the whole
    // report — because the cap counted ids before the chip prune. Under MATA
    // the fixture keeps 2 of 3 ids (the MATA patient + the unmapped one).
    const narrowed = await runDiscovery(
      discoveryInput({ penjamin: undefined, maxPatients: 2 }, { clinics: ['MATA'] }),
      'rajal_discovery_chip_cap',
    );
    expect(narrowed.result.state.nodes.normalize_ids!.status).toBe('success');

    const tight = await runDiscovery(
      discoveryInput({ penjamin: undefined, maxPatients: 1 }, { clinics: ['MATA'] }),
      'rajal_discovery_chip_cap_tight',
    );
    expect(tight.result.state.nodes.normalize_ids!.summary).toMatch(
      /Ditemukan 2 pasien di poli terpilih \(3 di laporan\).*melebihi batas 1 pasien/,
    );
  });

  it('refuses a discovery whose period is missing or backwards', async () => {
    const missing = await runDiscovery(discoveryInput({ from: '' }), 'rajal_discovery_no_period');
    expect(missing.result.state.nodes.load_config!.status).toBe('failed');
    expect(missing.result.state.nodes.load_config!.summary).toMatch(/butuh periode/);

    const backwards = await runDiscovery(
      discoveryInput({ from: '2026-06-30', to: '2026-06-01' }),
      'rajal_discovery_backwards',
    );
    expect(backwards.result.state.nodes.load_config!.summary).toMatch(/terbalik/);
    // Neither ever reached the report.
    expect(endpointsCalled(missing.transport)).toEqual([]);
    expect(endpointsCalled(backwards.transport)).toEqual([]);
  });

  it('blocks when every section the report carried is a penunjang grouping', async () => {
    const { result } = await runDiscovery(
      discoveryInput({ unit: 'LABORATORIUM', maxPatients: 5 }),
      'rajal_discovery_no_clinic',
    );

    expect(result.state.nodes.normalize_ids!.status).toBe('success');
    expect(result.state.nodes.resolve_clinics!.status).toBe('blocked');
    expect(result.state.nodes.resolve_clinics!.summary).toMatch(/tidak memuat seksi poli yang bisa ditagih/);
    expect(result.status).toBe('failed');
  });

  it('leaves the typed-list path exactly as it was', async () => {
    const { result, transport } = await runRajal({}, 'rajal_no_discovery');

    // No `discovery` on the input, so the report is never read and the node
    // reports the same summary it always did.
    expect(endpointsCalled(transport)).not.toContain('laporanBelumBayar.preview');
    expect(result.state.nodes.load_config!.summary).toBe('1 pasien, 1 poli');
    expect(result.state.nodes.normalize_ids!.summary).toBe('1 No. RM unik');
    expect(result.state.nodes.resolve_clinics!.summary).toBe('Poli diproses: PENYAKIT DALAM');
    expect(medrecsRead(transport)).toEqual(['0-01-23-45']);
  });
});

/** The guards a previous pass had left out of the graph entirely. */
describe('rajal ported guards', () => {
  it('skips a record whose unit matches two selected clinics', async () => {
    const { client, transport } = previewClient(
      historyFixture([{ ...RECORD_BASE, no_transaksi: '01-200009', kd_unit: 'P09', nama_unit: 'POLI BEDAH' }]),
    );
    const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
    const result = await runner.run({
      mode: 'preview',
      input: { ...RAJAL_HAPPY_INPUT, clinics: ['BEDAH ANAK', 'BEDAH MATA'] },
      runId: 'rajal_clinic_ambiguous',
    });

    const node = result.state.nodes.filter_records!;
    expect(node.status).toBe('needs_review');
    expect(node.summary).toMatch(/cocok dengan dua poli terpilih/);
    expect(node.summary).toMatch(/BEDAH ANAK \| BEDAH MATA/);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('still bills the unambiguous records when only some are ambiguous', async () => {
    const { client } = previewClient({
      ...historyFixture([
        { ...RECORD_BASE, no_transaksi: '01-200009', kd_unit: 'P09', nama_unit: 'POLI BEDAH' },
        {
          ...RECORD_BASE,
          no_registrasikunjungan: 'REG-RJ-OK',
          no_transaksi: '01-200010',
          kd_unit: 'P10',
          nama_unit: 'POLI BEDAH ANAK',
        },
      ]),
      'pendaftaran.getRiwayatSep': {
        text: JSON.stringify([
          { tgl_sep: '2026-06-10', jns_pelayanan: 'RJTL', poli_tujuan: 'BEDAH ANAK', no_sep: '0123456789012345' },
        ]),
      },
    });
    const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
    const result = await runner.run({
      mode: 'preview',
      input: { ...RAJAL_HAPPY_INPUT, clinics: ['BEDAH ANAK', 'BEDAH MATA'] },
      runId: 'rajal_clinic_partly_ambiguous',
    });

    expect(result.state.nodes.filter_records!.summary).toMatch(/1 kunjungan cocok; 1 dilewati karena ambigu/);
    expect(
      result.state.nodes.submit_payment!.proposedMutations.map((plan) => plan.payloadSummary.no_transaksi),
    ).toEqual(['01-200010']);
  });

  /**
   * Exit date. Legacy line 891 reads `getdatacarakeluar_tab`, now registered
   * as `poliklinik.getDataCaraKeluarTab`; the port used to substitute
   * `tgl_keluar` off the `gethistorykunjungan` row, which was never confirmed
   * to carry it for outpatient rows.
   */
  it('passes when the discharge tab carries an exit date', async () => {
    const { result } = await runRajal({}, 'rajal_exit_date_ok');
    const node = result.state.nodes.validate_exit_date!;
    expect(node.status).toBe('success');
    expect(node.summary).toBe('1 kunjungan sudah punya tanggal keluar');
  });

  it('blocks payment when the discharge tab has no exit date', async () => {
    const { result, transport } = await runRajal(
      { 'poliklinik.getDataCaraKeluarTab': { text: JSON.stringify({ tgl_keluar: '' }) } },
      'rajal_no_exit_date',
    );

    expect(result.state.nodes.validate_exit_date!.status).toBe('blocked');
    expect(result.state.nodes.validate_exit_date!.summary).toMatch(/Belum ada tanggal keluar pada 1 kunjungan: 01-200001/);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('blocks when the discharge tab answers without a tgl_keluar field', async () => {
    // Legacy's test is `!ck?.tgl_keluar`: once the tab itself has answered, an
    // absent field means the same thing as an empty one — not discharged.
    const { result } = await runRajal(
      { 'poliklinik.getDataCaraKeluarTab': { text: JSON.stringify({ cara_keluar: '' }) } },
      'rajal_exit_date_absent',
    );

    expect(result.state.nodes.validate_exit_date!.status).toBe('blocked');
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
  });

  it('does not pass the exit-date guard when the discharge tab cannot be read', async () => {
    // An array is a well-formed JSON reply that is not a discharge record.
    const { result } = await runRajal(
      { 'poliklinik.getDataCaraKeluarTab': { text: JSON.stringify([]) } },
      'rajal_exit_date_unreadable',
    );

    const node = result.state.nodes.validate_exit_date!;
    expect(node.status).not.toBe('success');
    expect(node.status).toBe('needs_review');
    expect(node.summary).toMatch(/Exit date unreadable on 1\/1 record\(s\): 01-200001/);
  });

  it('fails the exit-date guard rather than passing when the read errors', async () => {
    const { result, transport } = await runRajal(
      { 'poliklinik.getDataCaraKeluarTab': { status: 500, text: '<b>Fatal error</b>: undefined index' } },
      'rajal_exit_date_error',
    );

    expect(result.state.nodes.validate_exit_date!.status).toBe('failed');
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  /** Transaction-type read. Parity item 13: an unreadable read is review, not a crash. */
  it('flags the transaction-type guard for review rather than failing when the read errors', async () => {
    const { result, transport } = await runRajal(
      { 'kasir.getDataKunjunganTab': { status: 500, text: '<b>Fatal error</b>: undefined index' } },
      'rajal_tx_error',
    );

    // The visit-tab read is the type discriminator; when it errors the record is
    // dropped as unreadable, the node surfaces needs_review, and the run is NOT
    // failed — an unreadable read must never kill the whole batch.
    expect(result.state.nodes.validate_transaction!.status).toBe('needs_review');
    expect(result.state.status).not.toBe('failed');
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  /** A Rawat Inap visit tab (kd_instalasi '2') is rejected, never billed as rajal. */
  it('rejects a transaction whose visit tab is Rawat Inap', async () => {
    const { result, transport } = await runRajal(
      { 'kasir.getDataKunjunganTab': { text: JSON.stringify({ kd_instalasi: '2', no_registrasikunjungan: 'REG-RJ-1' }) } },
      'rajal_tx_inap',
    );

    expect(result.state.nodes.validate_transaction!.status).toBe('blocked');
    expect(result.state.nodes.validate_transaction!.summary).toMatch(/Rawat Inap/);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  /** Oncology plan. Legacy line 887; SIMRS dropped `kasir.getRencanaOnko` (404, 2026-10-27). */
  it('skips the oncology check without calling the removed endpoint, and keeps paying', async () => {
    const { result, transport } = await runRajal({}, 'rajal_onko_gone');
    const node = result.state.nodes.check_rencana_onko!;
    expect(node.status).toBe('skipped');
    expect(node.summary).toMatch(/tidak lagi menyediakan rencana onkologi/);
    expect(transport.calls.some((c) => c.headers['x-endpoint-id'] === 'kasir.getRencanaOnko')).toBe(false);
    expect(result.state.nodes.submit_payment!.proposedMutations.length).toBeGreaterThan(0);
  });

  it('blocks when a required treatment group is unsatisfied', async () => {
    const { client } = previewClient();
    const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
    const result = await runner.run({
      mode: 'preview',
      input: {
        ...RAJAL_HAPPY_INPUT,
        treatmentGroups: [
          { group: 'A', key: 'registration', name: 'PENDAFTARAN PASIEN' },
          { group: 'B', key: 'hd', name: 'HAEMODIALISA' },
        ],
      },
      runId: 'rajal_group_unsatisfied',
    });

    const node = result.state.nodes.validate_treatment!;
    expect(node.status).toBe('blocked');
    expect(node.summary).toMatch(/Required treatment group B unsatisfied on 01-200001/);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
  });

  it('passes when either alternative of an OR group is billed', async () => {
    const { client } = previewClient();
    const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
    const result = await runner.run({
      mode: 'preview',
      input: {
        ...RAJAL_HAPPY_INPUT,
        treatmentGroups: [
          { group: 'A', key: 'registration', name: 'PENDAFTARAN PASIEN' },
          { group: 'B', key: 'obat', name: 'BIAYA OBAT' },
          { group: 'B', key: 'hd', name: 'HAEMODIALISA' },
        ],
      },
      runId: 'rajal_group_or',
    });

    expect(result.state.nodes.validate_treatment!.status).toBe('success');
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(1);
  });

  it('blocks on a legacy skip treatment anywhere on the bill', async () => {
    const { client } = previewClient({
      'poliklinik.getListTindakan': {
        text: JSON.stringify({
          rows: [
            { nama_tindakan: 'PENDAFTARAN PASIEN', jumlah: '50000', flag: 'Belum', urut_tindakan: '1' },
            { nama_tindakan: 'PAKET ODC MATA', jumlah: '100000', flag: 'Belum', urut_tindakan: '2' },
          ],
        }),
      },
    });
    const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client }));
    const result = await runner.run({
      mode: 'preview',
      input: { ...RAJAL_HAPPY_INPUT, skipTreatments: ['ODC'] },
      runId: 'rajal_skip_treatment',
    });

    const node = result.state.nodes.validate_treatment!;
    expect(node.status).toBe('blocked');
    expect(node.summary).toMatch(/Excluded treatment found on 01-200001: "ODC" \(found: "PAKET ODC MATA"\)/);
  });

  it('blocks payment when an order is still unserved', async () => {
    const { result, transport } = await runRajal(
      { 'kasir.cekOrderBelumTerlayani': { text: JSON.stringify({ total: 2, nama_unit: 'RADIOLOGI' }) } },
      'rajal_order_unserved',
    );

    const node = result.state.nodes.check_verification!;
    expect(node.status).toBe('blocked');
    expect(node.summary).toMatch(/Unserved order\(s\) on 01-200001: 2 outstanding at RADIOLOGI/);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('blocks payment when an order has not been transferred onto the bill', async () => {
    const { result } = await runRajal(
      { 'kasir.cekOrderBelumTransfer': { text: JSON.stringify({ total: 1, nama_unit: 'DEPO FARMASI' }) } },
      'rajal_order_untransferred',
    );

    expect(result.state.nodes.check_verification!.status).toBe('blocked');
    expect(result.state.nodes.check_verification!.summary).toMatch(/Untransferred order\(s\) on 01-200001/);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
  });

  it('blocks payment when a penunjang transaction is still unverified', async () => {
    const { result } = await runRajal(
      {
        'verifikator.cekTransaksiPenunjang': {
          text: JSON.stringify({ nama_unit: 'LABORATORIUM KLINIK', no_transaksi: '13-400001' }),
        },
      },
      'rajal_penunjang_unverified',
    );

    expect(result.state.nodes.check_verification!.status).toBe('blocked');
    expect(result.state.nodes.check_verification!.summary).toMatch(
      /Unverified penunjang transaction on 01-200001: LABORATORIUM KLINIK/,
    );
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
  });

  it('treats an empty penunjang reply as clean and lets the record be paid', async () => {
    // The live backend answers this endpoint with HTTP 200 and an *empty* body
    // for a clean registration. Legacy's `postFetch` returns `null` and
    // `if(pc && Object.keys(pc).length)` reads that as "no blocker", so the
    // record continues to payment; the port must not end the batch with
    // `check_verification: failed`, nor refuse a bill the backend cleared.
    const { result, transport } = await runRajal(
      { 'verifikator.cekTransaksiPenunjang': { text: '' } },
      'rajal_penunjang_empty_reply',
    );

    expect(result.state.nodes.check_verification!.status).not.toBe('failed');
    expect(result.state.nodes.check_verification!.summary).not.toMatch(/Unverified penunjang/);
    expect(result.state.nodes.check_verification!.proposedMutations.some((plan) => plan.endpointId === 'verifikator.simpanVerifikasi')).toBe(true);
    expect(result.state.nodes.submit_payment!.proposedMutations.some((plan) => plan.endpointId === 'kasir.tampungBayar')).toBe(true);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('blocks payment when the penunjang reply is a non-empty array', async () => {
    // The endpoint sometimes answers with a bare list; a populated list is a
    // blocker, and treating it as "clean" would let a bill be staged while an
    // unverified penunjang transaction is still outstanding.
    const { result, transport } = await runRajal(
      {
        'verifikator.cekTransaksiPenunjang': {
          text: JSON.stringify([{ nama_unit: 'RADIOLOGI', no_transaksi: '13-400002' }]),
        },
      },
      'rajal_penunjang_array_blocker',
    );

    expect(result.state.nodes.check_verification!.status).toBe('blocked');
    const plans = result.state.nodes.submit_payment!.proposedMutations;
    expect(plans.some((plan) => plan.endpointId === 'kasir.tampungBayar')).toBe(false);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('plans the verification write when the transaction is still open', async () => {
    const { result, transport } = await runRajal({}, 'rajal_verification_planned');
    const node = result.state.nodes.check_verification!;
    expect(node.status).toBe('needs_review');
    const plan = node.proposedMutations[0]!;
    expect(plan.endpointId).toBe('verifikator.simpanVerifikasi');
    expect(plan.payload).toEqual({ no_registrasikunjungan: 'REG-RJ-1' });
    expect(plan.payloadSummary).toEqual({ no_registrasikunjungan: 'REG-RJ-1' });
    expect(verificationRulesOf(plan).map((rule) => rule.endpointId)).toEqual([
      'kasir.cekStatusVerifikasi',
      'kasir.cekOrderBelumTerlayani',
      'kasir.cekOrderBelumTransfer',
      'verifikator.cekTransaksiPenunjang',
    ]);
    expect(verificationRulesOf(plan)[0]).toMatchObject({ field: '', match: 'equals', expected: '1' });
    expect(verificationRulesOf(plan)[3]).toMatchObject({ match: 'empty', expected: 0 });
    expect(mutatingCalls(transport)).toHaveLength(0);
  });

  it('still plans payment for a record that was already verified', async () => {
    // Regression: the port used to drop already-verified records from `payable`,
    // so an unpaid-but-verified bill was never paid. Legacy's `else` branch
    // (source line 1017) falls straight through to tampung_bayar.
    const { result } = await runRajal({ 'kasir.cekStatusVerifikasi': { text: '1' } }, 'rajal_already_verified');
    expect(result.state.nodes.check_verification!.status).toBe('success');
    expect(result.state.nodes.check_verification!.summary).toMatch(/sudah terverifikasi/);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(1);
  });

  it('keeps the clean record when one treatment list is unreadable', async () => {
    const { result } = await runRajal(
      {
        ...historyFixture([
          RECORD_BASE,
          {
            ...RECORD_BASE,
            no_registrasikunjungan: 'REG-RJ-2',
            no_transaksi: '01-200002',
          },
        ]),
        'poliklinik.getListTindakan': ({ body }: { body?: string }) => {
          const noTransaksi = Object.fromEntries(new URLSearchParams(body ?? '')).no_transaksi;
          return {
            text: JSON.stringify(
              noTransaksi === '01-200002'
                ? { total: 0 }
                : {
                    rows: [
                      { nama_tindakan: 'PENDAFTARAN PASIEN', jumlah: '50000', flag: 'Belum', urut_tindakan: '1' },
                      { nama_tindakan: 'BIAYA OBAT', jumlah: '100000', flag: 'Belum', urut_tindakan: '2' },
                    ],
                  },
            ),
          };
        },
      },
      'rajal_treatment_partial_unreadable',
    );

    expect(result.state.nodes.validate_treatment!.status).toBe('needs_review');
    expect(result.state.nodes.validate_treatment!.summary).toMatch(/01-200002/);
    expect(result.state.nodes.submit_payment!.proposedMutations.map((plan) => plan.payloadSummary.no_transaksi)).toEqual([
      '01-200001',
    ]);
  });

  it('keeps the clean payment plan when another payable record has an order blocker', async () => {
    const { result } = await runRajal(
      {
        ...historyFixture([
          RECORD_BASE,
          {
            ...RECORD_BASE,
            no_registrasikunjungan: 'REG-RJ-2',
            no_transaksi: '01-200002',
          },
        ]),
        'kasir.cekOrderBelumTerlayani': ({ body }: { body?: string }) => {
          const noTransaksi = Object.fromEntries(new URLSearchParams(body ?? '')).no_transaksi;
          return { text: JSON.stringify(noTransaksi === '01-200002' ? { total: 1, nama_unit: 'RADIOLOGI' } : { total: 0 }) };
        },
      },
      'rajal_verification_partial_blocker',
    );

    expect(result.state.nodes.check_verification!.status).toBe('needs_review');
    expect(result.state.nodes.check_verification!.summary).toMatch(/01-200002/);
    expect(result.state.nodes.submit_payment!.proposedMutations.map((plan) => plan.payloadSummary.no_transaksi)).toEqual([
      '01-200001',
    ]);
    expect(result.state.edges.check_verification__submit_payment!.status).not.toBe('skipped');
  });
});

/**
 * Reads that fail must never read as clean. A validator returning success
 * because it could not see its input is worse than no validator at all.
 */
describe('rajal failed reads', () => {
  it('reports an unreadable verification status instead of assuming verified', async () => {
    const { result } = await runRajal(
      { 'kasir.cekStatusVerifikasi': { text: 'Internal Server Error' } },
      'rajal_verification_unreadable',
    );

    const node = result.state.nodes.check_verification!;
    expect(node.status).toBe('needs_review');
    expect(node.summary).toMatch(/Verification status unreadable on 01-200001/);
    expect(result.state.edges.check_verification__submit_payment!.status).toBe('skipped');
  });

  it('reports an unreadable payment state instead of assuming paid', async () => {
    // A bill whose rows carry no `flag` is unread — check_payment must surface it
    // for review rather than pay it or silently drop it, and nothing is planned.
    const { result } = await runRajal(
      {
        'poliklinik.getListTindakan': {
          text: JSON.stringify({
            rows: [
              { nama_tindakan: 'PENDAFTARAN PASIEN', jumlah: '50000', urut_tindakan: '1' },
              { nama_tindakan: 'BIAYA OBAT', jumlah: '100000', urut_tindakan: '2' },
            ],
          }),
        },
      },
      'rajal_payment_unreadable',
    );

    const node = result.state.nodes.check_payment!;
    expect(node.status).toBe('needs_review');
    expect(node.summary).toMatch(/Payment state unreadable on 1\/1 record\(s\)/);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(result.state.edges.check_payment__check_verification!.status).toBe('skipped');
  });

  it('preserves payment for a readable bill when another payment state is unreadable', async () => {
    const { result } = await runRajal({
      ...historyFixture([RECORD_BASE, { ...RECORD_BASE, no_transaksi: '01-200002', no_registrasikunjungan: 'REG-RJ-2' }]),
      'poliklinik.getListTindakan': ({ body }: TransportRequest) => {
        const unreadable = new URLSearchParams(body).get('no_transaksi') === '01-200002';
        return { text: JSON.stringify({ rows: [
          { nama_tindakan: 'PENDAFTARAN PASIEN', jumlah: '50000', flag: unreadable ? '' : 'Belum', urut_tindakan: '1' },
          { nama_tindakan: 'BIAYA OBAT', jumlah: '100000', flag: unreadable ? '' : 'Belum', urut_tindakan: '2' },
        ] }) };
      },
    }, 'rajal_partial_payment_unreadable');
    expect(result.state.nodes.check_payment!.status).toBe('needs_review');
    expect(result.state.nodes.check_payment!.summary).toMatch(/01-200002/);
    expect(result.state.edges.check_payment__check_verification!.status).not.toBe('skipped');
    expect(result.state.nodes.submit_payment!.proposedMutations.map((plan) => plan.payloadSummary.no_transaksi)).toEqual(['01-200001']);
  });

  it('reports an unreadable visit history instead of reporting no visits', async () => {
    const { result } = await runRajal(
      { 'kasir.getHistoryKunjungan': { text: JSON.stringify({ total: 0 }) } },
      'rajal_history_unreadable',
    );

    const node = result.state.nodes.load_history!;
    expect(node.status).toBe('needs_review');
    expect(node.summary).toMatch(/Riwayat kunjungan gagal dibaca untuk 1\/1 pasien/);
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
  });

  it('reports an unreadable treatment list instead of an empty bill', async () => {
    const { result } = await runRajal(
      { 'poliklinik.getListTindakan': { text: JSON.stringify({ total: 0 }) } },
      'rajal_tindakan_unreadable',
    );

    expect(result.state.nodes.validate_treatment!.status).toBe('needs_review');
    expect(result.state.nodes.validate_treatment!.summary).toMatch(/Treatment list unreadable on 01-200001/);
  });

  it('fails the SEP step rather than reporting no SEP when the bridge is down', async () => {
    // `fetchSepHistory` retries and then rethrows; the runner turns the throw
    // into `failed`, which stops the downstream payment plan.
    const { result, transport } = await runRajal(
      { 'pendaftaran.getRiwayatSep': { text: 'Gateway Timeout' } },
      'rajal_sep_bridge_down',
    );

    expect(result.state.nodes.validate_sep!.status).toBe('failed');
    expect(result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(mutatingCalls(transport)).toHaveLength(0);
  });
});

/**
 * Request shapes. `FixtureTransport` keys on the endpoint id and ignores the
 * payload, so every behavioural test above passes even when a field name is
 * wrong or a GET's parameters were handed to a body the client discards. Only
 * the recorded request proves the wire shape. The legacy call site is cited for
 * each assertion.
 */
describe('rajal request shapes', () => {
  const MEDREC = '0-01-23-45';

  function callFor(transport: FixtureTransport, endpointId: string) {
    const call = transport.calls.find((item) => item.headers['x-endpoint-id'] === endpointId);
    expect(call, `no call recorded for ${endpointId}`).toBeDefined();
    return call!;
  }

  /** The decoded form body of the first recorded call to `endpointId`. */
  function bodyOf(transport: FixtureTransport, endpointId: string): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(callFor(transport, endpointId).body ?? ''));
  }

  /** The decoded query string of the first recorded call to `endpointId`. */
  function queryOf(transport: FixtureTransport, endpointId: string): Record<string, string> {
    return Object.fromEntries(new URL(callFor(transport, endpointId).url).searchParams);
  }

  it('sends the medrec under the field name each controller expects', async () => {
    const { transport } = await runRajal({}, 'rajal_shape_medrec');

    // `nomedrec` with explicit paging — legacy source line 1043.
    expect(bodyOf(transport, 'kasir.getHistoryKunjungan')).toEqual({ nomedrec: MEDREC, page: '1', rows: '10' });
    // `txtmedrec_pdft` — pendaftaran only (legacy `getCardNumber`, line 785).
    expect(bodyOf(transport, 'pendaftaran.getDataKunjungan')).toEqual({ txtmedrec_pdft: MEDREC });
    // `txtmedrec` — the kasir transaction detail carries the *medrec*, not the
    // registration number (legacy line 894 sends `pid`).
    expect(bodyOf(transport, 'kasir.getDataTransaksi')).toEqual({
      txtmedrec: MEDREC,
      no_transaksi: '01-200001',
      kd_unit: 'P01',
      no_registrasikunjungan: 'REG-RJ-1',
    });
  });

  it('sends the cashier reads with their checkbox flags', async () => {
    const { transport } = await runRajal({}, 'rajal_shape_kasir');

    // The billed lines come from the poli-side controller (the kasir billing
    // endpoints are dead on the live backend) — paged like every grid read.
    expect(bodyOf(transport, 'poliklinik.getListTindakan')).toEqual({
      no_transaksi: '01-200001',
      page: '1',
      rows: '100',
    });
    // The transaction-type discriminator is the visit tab; `getDataTransaksi`
    // only supplies the current SEP.
    expect(bodyOf(transport, 'kasir.getDataKunjunganTab')).toEqual({
      no_registrasikunjungan: 'REG-RJ-1',
      kd_unit: 'P01',
      no_transaksi: '01-200001',
    });
    // Legacy source line 1012 — keyed on the transaction alone.
    expect(bodyOf(transport, 'kasir.cekStatusVerifikasi')).toEqual({ no_transaksi: '01-200001' });
  });

  it('keys the per-record blockers on the registration, as legacy does', async () => {
    const { transport } = await runRajal({}, 'rajal_shape_record_blockers');

    // Legacy source line 891 — same for the discharge tab.
    expect(bodyOf(transport, 'poliklinik.getDataCaraKeluarTab')).toEqual({
      no_registrasikunjungan: 'REG-RJ-1',
    });
    expect(callFor(transport, 'poliklinik.getDataCaraKeluarTab').url).toMatch(
      /poliklinik\/poliklinik\/getdatacarakeluar_tab$/,
    );
  });

  it('sends all three pre-verification blockers with the fields legacy sent', async () => {
    const { transport } = await runRajal({}, 'rajal_shape_blockers');

    // Legacy source lines 1006-1007: reg + transaction + unit on both.
    const orderArgs = { no_registrasikunjungan: 'REG-RJ-1', no_transaksi: '01-200001', kd_unit: 'P01' };
    expect(bodyOf(transport, 'kasir.cekOrderBelumTerlayani')).toEqual(orderArgs);
    expect(bodyOf(transport, 'kasir.cekOrderBelumTransfer')).toEqual(orderArgs);
    // Legacy source line 1010: the registration only.
    expect(bodyOf(transport, 'verifikator.cekTransaksiPenunjang')).toEqual({ no_registrasikunjungan: 'REG-RJ-1' });
  });

  it('sends the SEP reads with the card number padded to 13 digits', async () => {
    const { transport } = await runRajal({}, 'rajal_shape_sep');

    // Legacy source line 790.
    expect(bodyOf(transport, 'pendaftaran.getDataPenjaminTab')).toEqual({ no_registrasikunjungan: 'REG-RJ-1' });
    // Legacy source lines 805-809: `padStart(13,'0')`.
    expect(bodyOf(transport, 'pendaftaran.getRiwayatSep')).toEqual({ no_kartu: '1234567890123' });
  });

  it('sends the radiology reads under their per-controller field names', async () => {
    const { transport } = await runRajal(
      {
        ...tindakanFixture('USG'),
        'poliklinik.getHistoryIrad': {
          text: JSON.stringify({ rows: [{ tgl_order: '2026-06-10 09:15', status_approve: '1' }] }),
        },
        'radiologi.getDataKunjungan': {
          text: JSON.stringify({ rows: [{ no_transaksi: 'RAD-1', tgl_transaksi: '2026-06-10' }] }),
        },
        'radiologi.getHasilPemeriksaan': { text: JSON.stringify({ total: 1 }) },
      },
      'rajal_shape_radiology',
    );

    // `nomedrec` + paging — legacy source line 913.
    expect(bodyOf(transport, 'poliklinik.getHistoryIrad')).toEqual({ nomedrec: MEDREC, page: '1', rows: '10' });
    // `txtmedreccari_hslrad` — the result-search grid's own field name (legacy
    // source line 917), and **no paging**: legacy sends none, and `rows: '10'`
    // would cap a heavy day's studies at ten, shrinking the count comparison.
    // Legacy names the action `get_datapasien`, which this controller does not
    // expose (`getdatakunjungan` is its result search) — see the parity doc.
    expect(bodyOf(transport, 'radiologi.getDataKunjungan')).toEqual({
      txtmedreccari_hslrad: MEDREC,
    });
    // Legacy source line 920.
    expect(bodyOf(transport, 'radiologi.getHasilPemeriksaan')).toEqual({ no_transaksi: 'RAD-1' });
  });

  it('searches elektromedik results on the hasil controller, under no_medicalrecord', async () => {
    const { transport } = await runRajal(
      {
        ...tindakanFixture('PENUNJANG ELEKTROMEDIK EKG'),
        'elektromedikHasil.getDataPasien': {
          text: JSON.stringify({ rows: [{ no_transaksi: 'EKG-1', tgl_transaksi: '2026-06-10' }] }),
        },
        'elektromedikHasil.getListHasilPemeriksaan': {
          text: JSON.stringify({ total: 1, rows: [{ deskripsi: 'Sinus rhythm' }] }),
        },
      },
      'rajal_shape_elektromedik',
    );

    // Legacy source line 933 reads `elektromedik/hasil_pemeriksaan/get_datapasien`
    // — the *result* search, which the route dump confirms exists. The port used
    // to substitute the registrasi controller's visit history, which lists
    // orders that have no result yet. `no_medicalrecord`, not `nomedrec`, and no
    // paging: legacy sends none.
    expect(callFor(transport, 'elektromedikHasil.getDataPasien').url).toMatch(
      /elektromedik\/hasil_pemeriksaan\/get_datapasien$/,
    );
    expect(bodyOf(transport, 'elektromedikHasil.getDataPasien')).toEqual({ no_medicalrecord: MEDREC });
    expect(bodyOf(transport, 'elektromedikHasil.getListHasilPemeriksaan')).toEqual({ no_transaksi: 'EKG-1' });
    // The registrasi-controller substitute is not called any more.
    expect(
      transport.calls.some((call) => call.headers['x-endpoint-id'] === 'elektromedik.getHistoryKunjungan'),
    ).toBe(false);
  });

  it('puts the PA order parameters in the query string, where a GET needs them', async () => {
    const { transport } = await runRajal(
      {
        ...tindakanFixture('LABORATORIUM PA'),
        'kemoterapi.getHistoryOrderPa': {
          text: JSON.stringify({
            rows: [{ no_transaksi: 'PA-1', tgl_transaksi: '10-Jun-2026', kd_jenis_pemeriksaan: '2' }],
          }),
        },
        'kemoterapi.getDetailHistoryOrderPa': { text: JSON.stringify({ rows: [{ nama_pemeriksaan: 'Histo' }] }) },
        'pa.hasilCetak': { text: `HASIL PA\n${'Makroskopik: jaringan. '.repeat(8)}` },
      },
      'rajal_shape_labpa',
    );

    // POST body — legacy source line 948.
    expect(bodyOf(transport, 'kemoterapi.getHistoryOrderPa')).toEqual({ nomedrec: MEDREC, page: '1', rows: '10' });
    // Legacy line 953 passes `{}` as the body and `{no_trans}` as params, and
    // the client only form-encodes a POST — a GET's parameters must live in the
    // query string or they vanish entirely.
    expect(callFor(transport, 'kemoterapi.getDetailHistoryOrderPa').method).toBe('GET');
    expect(queryOf(transport, 'kemoterapi.getDetailHistoryOrderPa')).toEqual({ no_trans: 'PA-1' });
    // Legacy line 713 — a GET with three query parameters, and
    // `kd_jenis_pemeriksaan` comes off the matched order row.
    expect(callFor(transport, 'pa.hasilCetak').method).toBe('GET');
    expect(queryOf(transport, 'pa.hasilCetak')).toEqual({
      no_medicalrecord: MEDREC,
      no_transaksi: 'PA-1',
      kd_jenis_pemeriksaan: '2',
    });
  });

  it('sends the regular lab reads with nomedrec and the order number', async () => {
    const { transport } = await runRajal(
      {
        ...tindakanFixture('LABORATORIUM KLINIK'),
        'penatajasaInap.getHistoryILab': {
          text: JSON.stringify({ rows: [{ no_transaksi: 'LAB-1', tgl_transaksi: '10-Jun-2026' }] }),
        },
        'laboratoriumHasil.cetakLis': {
          text: '<html><body><iframe src="http://lis.example.local/pdf.php?no_transaksi=LAB-1"></iframe></body></html>',
        },
        'laboratoriumHasil.lisPdfHead': {
          text: '',
          headers: { 'content-type': 'application/pdf', 'content-length': '7408' },
        },
      },
      'rajal_shape_lab',
    );

    // Legacy source line 968.
    expect(bodyOf(transport, 'penatajasaInap.getHistoryILab')).toEqual({ nomedrec: MEDREC, page: '1', rows: '10' });
    // Legacy source line 556 — the lab *order* number, not the bill.
    expect(bodyOf(transport, 'laboratoriumHasil.cetakLis')).toEqual({ no_transaksi: 'LAB-1' });
    // Legacy lines 603-611: HEAD the same-origin LIS PDF, with the extracted lab order number in the query.
    expect(callFor(transport, 'laboratoriumHasil.lisPdfHead').method).toBe('HEAD');
    expect(queryOf(transport, 'laboratoriumHasil.lisPdfHead')).toEqual({ no_transaksi: 'LAB-1' });
    expect(callFor(transport, 'laboratoriumHasil.lisPdfHead').url).toBe(
      'https://simrs.example.local/lis_new/pdf.php?no_transaksi=LAB-1',
    );
  });
});

describe('rajal safety model', () => {
  it('sends no mutating endpoint and keeps every plan on the allowlist', async () => {
    const { result, transport } = await runRajal({}, 'rajal_safety');

    expect(mutatingCalls(transport)).toHaveLength(0);

    const allowlist = rajalWorkflow.policies?.mutationAllowlist ?? [];
    const plans = Object.values(result.state.nodes).flatMap((node) => node.proposedMutations);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect(allowlist, `${plan.endpointId} must be allowlisted`).toContain(plan.endpointId);
      expect(plan.requiresApproval).toBe(true);
      expect(plan.preconditions.length).toBeGreaterThan(0);
    }
  });

  it('requires a closed verification before staging payment', async () => {
    // Legacy verifies *before* it pays, so at write time `cekStatusVerifikasi`
    // must read "1". The previous plan asserted `'0'`, which would have refused
    // every legitimate payment once preconditions are replayed — and the plan
    // was reachable while the verification was still open.
    const { result } = await runRajal({}, 'rajal_precondition_sanity');
    const payment = result.state.nodes.submit_payment!.proposedMutations.find(
      (plan) => plan.endpointId === 'kasir.tampungBayar',
    );
    expect(payment).toBeDefined();
    expect(payment!.preconditions.map((check) => check.check)).toEqual([
      'kasir.cekStatusVerifikasi',
      'poliklinik.getListTindakan',
      'kasir.getHistoryPembayaran',
      'kasir.cekOrderBelumTerlayani',
      'kasir.cekOrderBelumTransfer',
      'verifikator.cekTransaksiPenunjang',
    ]);
    const verificationCheck = payment!.preconditions[0]!;
    expect(verificationCheck.expected).toBe('1');
    expect(verificationCheck.payload).toEqual({ no_transaksi: '01-200001' });
  });

  it('gives every precondition a body it can actually be replayed with', async () => {
    // `RunService` re-reads each `check` immediately before the write, using the
    // precondition's own `payload`/`query` and falling back to the plan's. The
    // cashier write spells the registration `no_reg`, where every guard read
    // wants `no_registrasikunjungan` — so an inherited body would query an
    // unscoped registration and the answer would be meaningless.
    const { result } = await runRajal({}, 'rajal_precondition_bodies');
    const plans = Object.values(result.state.nodes).flatMap((node) => node.proposedMutations);
    expect(plans.length).toBeGreaterThan(0);

    for (const plan of plans) {
      for (const check of plan.preconditions) {
        const body = { ...(check.payload ?? {}), ...(check.query ?? {}) };
        expect(Object.keys(body).length, `${plan.endpointId} → ${check.check} has no replay body`).toBeGreaterThan(0);
        expect(body, `${plan.endpointId} → ${check.check} must not inherit no_reg`).not.toHaveProperty('no_reg');
      }
    }
  });

  it('does not refuse the happy path when its own preconditions are evaluated', async () => {
    // The comparator is tolerant on purpose, and a precondition written against
    // the wrong shape fails closed — which reads as a refusal, not a bug, once
    // enforcement is live. Replay each check against the very fixture the run
    // just read and assert it still holds.
    const { result } = await runRajal({}, 'rajal_precondition_holds');
    const observed: Record<string, unknown> = {
      'poliklinik.getListTindakan': {
        rows: [
          { nama_tindakan: 'PENDAFTARAN PASIEN', jumlah: '50000', flag: 'Belum', urut_tindakan: '1' },
          { nama_tindakan: 'BIAYA OBAT', jumlah: '100000', flag: 'Belum', urut_tindakan: '2' },
        ],
      },
      // A clean registration answers `{}` from one endpoint and `{total: 0}`
      // from another; both must read as "no blocker".
      'kasir.cekOrderBelumTerlayani': { total: 0 },
      'kasir.cekOrderBelumTransfer': {},
      'verifikator.cekTransaksiPenunjang': {},
      'kasir.getHistoryPembayaran': [],
      'kasir.cekStatusVerifikasi': '1',
      'pendaftaran.getRiwayatSep': [
        { tgl_sep: '2026-06-10', jns_pelayanan: 'RJTL', poli_tujuan: 'PENYAKIT DALAM', no_sep: '0123456789012345' },
      ],
    };

    const plans = Object.values(result.state.nodes).flatMap((node) => node.proposedMutations);
    for (const plan of plans) {
      for (const check of plan.preconditions) {
        expect(observed, `no canned reply for ${check.check}`).toHaveProperty(check.check);
        // `cekStatusVerifikasi` is read twice with opposite expectations: the
        // verification plan runs while the bill is still open ('0'), the payment
        // plan only after it closed ('1'). The reply has to match the plan.
        const reply =
          check.check === 'kasir.cekStatusVerifikasi'
            ? plan.endpointId === 'verifikator.simpanVerifikasi'
              ? '0'
              : '1'
            : observed[check.check];
        const verdict = evaluateExpectation(
          {
            expected: check.expected,
            ...(check.field !== undefined ? { field: check.field } : {}),
            ...(check.match ? { match: check.match } : {}),
          },
          reply,
        );
        expect(verdict.holds, `${plan.endpointId} → ${check.check}: ${verdict.reason}`).toBe(true);
      }
    }
  });

  it('plans no payment when the kasir rows are missing or disagree with the billed lines', async () => {
    const empty = await runRajal({ 'kasir.getListTindakan': { text: JSON.stringify({ rows: [] }) } }, 'rajal_kasir_empty');
    expect(empty.result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(empty.result.state.nodes.submit_payment!.summary).toMatch(/0 baris kasir vs 2 baris tindakan poli/);
    const one = JSON.parse((rajalFixtures['kasir.getListTindakan'] as { text: string }).text).rows.slice(0, 1);
    const short = await runRajal({ 'kasir.getListTindakan': { text: JSON.stringify({ rows: one }) } }, 'rajal_kasir_short');
    expect(short.result.state.nodes.submit_payment!.proposedMutations).toHaveLength(0);
  });

  it('carries the full tampung bayar payload in the plan', async () => {
    const { result } = await runRajal({}, 'rajal_payment_payload');
    const payment = result.state.nodes.submit_payment!.proposedMutations.find(
      (plan) => plan.endpointId === 'kasir.tampungBayar',
    )!;

    expect(payment.payload).toEqual(payment.payloadSummary);
    expect(payment.payloadSummary).toMatchObject({
      no_reg: 'REG-RJ-1',
      no_transaksi: '01-200001',
      kd_unit: 'P01',
      ck_retur: 'false',
      kd_penjamin: '15',
    });
    // The cashier grid's rows travel with the payment, verbatim: each carries
    // no_transaksi (live kasir.php:7743 reads it) and the other kasir fields.
    const kasirRows = JSON.parse((rajalFixtures['kasir.getListTindakan'] as { text: string }).text).rows;
    expect(JSON.parse(String(payment.payloadSummary.tindakan))).toEqual(kasirRows);
    expect(kasirRows.every((row: Record<string, unknown>) => row.no_transaksi === '01-200001')).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(String(payment.payloadSummary.dt_bayar)))).toEqual({
      cmbshift_pembayaran: '1',
      cmbjenis_pembayaran: '14',
      txtdiskonpn_pembayaran: '',
      txtdiskonrp_pembayaran: '',
      txtpembulatan_pembayaran: '',
      cmbkartu_pembayaran: '',
      txtjumlah_pembayaran: '150000',
      txtjmltagihan_pembayaran: '150000',
      txtjmldibayar_pembayaran: '0',
    });
    expect(verificationRulesOf(payment)).toEqual([
      expect.objectContaining({
        endpointId: 'kasir.getHistoryPembayaran',
        query: { no_registrasikunjungan: 'REG-RJ-1', no_transaksi: '01-200001' },
        field: 'length',
        expected: 1,
      }),
    ]);
  });
});

describe('rajal operator reasoning', () => {
  it('explains SEP and payment status per transaction', async () => {
    const { result } = await runRajal({}, 'rajal_reasoning');
    const sep = reasoningOf(result.state.nodes.validate_sep!.evidence);
    expect(sep?.items[0]).toMatchObject({ ok: true });
    expect(sep?.items[0]?.detail).toMatch(/sudah terpasang/);
    const payment = reasoningOf(result.state.nodes.check_payment!.evidence);
    expect(payment?.items[0]).toMatchObject({ ok: true });
    expect(payment?.items[0]?.detail).toMatch(/belum dibayar/);
  });
});

describe('rajal checklist coverage', () => {
  it('every step that ran explains itself with a checklist', async () => {
    const { result } = await runRajal({}, 'rajal_coverage');
    const missing = Object.values(result.state.nodes)
      .filter((node) => ['success', 'failed', 'blocked', 'needs_review'].includes(node.status))
      .filter((node) => !reasoningOf(node.evidence)?.items.length)
      .map((node) => node.id);
    expect(missing).toEqual([]);
    const pay = reasoningOf(result.state.nodes.submit_payment!.evidence);
    const planIds = result.state.nodes.submit_payment!.proposedMutations?.map((plan) => plan.id) ?? [];
    expect(planIds.length).toBeGreaterThan(0);
    expect(pay?.items.map((item) => item.planId)).toEqual(planIds);
  });
});

describe('rajal kelengkapan berkas (opt-in)', () => {
  const berkasOverrides = {
    ...tindakanFixture('THORAX PA'),
    'uploadBerkas.getDataPiutang': { text: JSON.stringify({ total: 1, rows: [{ no_registrasikunjungan: 'REG-RJ-1', no_sep: 'SEP-RJ-1', tgl_masuk: '2026-06-10' }] }) },
    'eklaim.cetakSimplifikasi': { text: '%PDF', bodyBytes: pdfBytes(16) },
  };
  const reader = (keys: string[]) => ({
    read: async (_pdf: Uint8Array, opts: { cacheKey: string }) => {
      keys.push(opts.cacheKey);
      return { pageCount: 5, photoPages: 0, ocrRun: 0, fromCache: false, pages: [
        { page: 2, source: 'teks' as const, docTypes: ['rincian_biaya'], labels: ['Perincian biaya'] },
        { page: 3, source: 'teks' as const, docTypes: ['sep'], labels: ['SEP'] },
        { page: 4, source: 'teks' as const, docTypes: ['verifikasi_rajal'], labels: ['Lembar verifikasi rawat jalan'] },
      ] };
    },
  });

  it('stays off unless enabled, and lists the visit documents when on', async () => {
    const off = await runRajal(berkasOverrides, 'rj_berkas_off');
    expect(off.result.state.nodes.check_berkas!.status).not.toBe('success');
    expect(off.transport.calls.some((c) => c.headers['x-endpoint-id'] === 'eklaim.cetakSimplifikasi')).toBe(false);

    const keys: string[] = [];
    const { client, transport } = previewClient(berkasOverrides);
    const runner = new WorkflowRunner(rajalWorkflow, createRajalExecutors({ client, berkas: reader(keys) }));
    const result = await runner.run({ mode: 'preview', input: RAJAL_HAPPY_INPUT, runId: 'rj_berkas', enabled: { check_berkas: true } });
    const node = result.state.nodes.check_berkas!;
    // Billed THORAX PA without a radiology result page → a notice, never a block.
    expect(node.status).toBe('needs_review');
    expect(node.summary).toContain('Hasil radiologi');
    expect(keys).toEqual(['0-01-23-45_2026-06-10_2026-06-10_P01']);
    const pdfCall = transport.calls.find((c) => c.headers['x-endpoint-id'] === 'eklaim.cetakSimplifikasi');
    expect(pdfCall?.url).toContain('kd_instalasi=1');
    const lines = result.state.logs.filter((l) => l.nodeId === 'check_berkas').map((l) => l.message);
    expect(lines).toContain('Kelengkapan Berkas:');
    expect(lines.some((l) => /2\. Lembar verifikasi rawat jalan ✓ hal\. 4/.test(l))).toBe(true);
    // The notice does not take visits out of the batch.
    expect(result.state.nodes.validate_sep!.status).not.toBe('pending');
  });
});
