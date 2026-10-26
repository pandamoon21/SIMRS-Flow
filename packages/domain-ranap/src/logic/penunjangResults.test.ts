import { describe, expect, it } from 'vitest';

import {
  boolApprovedFlag,
  buildHasilLookupWindow,
  buildPenunjangValidationAlert,
  collectDirectHasilRowsForGroup,
  collectPenunjangHistories,
  collectPenunjangValidationCandidates,
  filterHistoryRowsForDateRange,
  findHasilRowByNoTransaksi,
  hasMeaningfulHasilValue,
  parseNoTransaksiDate,
  rowsFromPayload,
  validateHasilElektromedik,
  validateHasilLaboratoriumPk,
  validateHasilPa,
  validateHasilRadiologi,
  validatePenunjangResultsForGroup,
} from './penunjangResults.js';
import type { PenunjangCandidate, PenunjangValidation } from './penunjangResults.js';
import type { LegacyRow } from './types.js';

const NO_RM = '0-12-34-56';
const LAB_TRX = '01-100326-000123';
const PA_TRX = '17-100326-000045';
const RAD_TRX = '02-110326-000077';
const ELM_TRX = '61-110326-000091';

/** One room stay, 10 Mar → 12 Mar 2026, registration R100. */
const ROOM_ROWS: readonly LegacyRow[] = [
  {
    no_transaksi: '03-100326-000001',
    no_registrasikunjungan: 'R100',
    kd_kamarperawatan: 'K1',
    nama_unit: 'MULTAZAM / KELAS 3',
    tgl_masuk: '2026-03-10 08:00:00',
    tgl_keluar: '2026-03-12 10:00:00',
  },
];

// ── primitives ───────────────────────────────────────────────────

describe('rowsFromPayload', () => {
  it('reads a rows envelope, a bare array, and nothing else', () => {
    expect(rowsFromPayload({ rows: [{ a: 1 }], total: 1 })).toEqual([{ a: 1 }]);
    expect(rowsFromPayload([{ a: 1 }, { b: 2 }])).toHaveLength(2);
    expect(rowsFromPayload({ data: [{ a: 1 }] })).toEqual([]);
    expect(rowsFromPayload('')).toEqual([]);
    expect(rowsFromPayload(null)).toEqual([]);
  });
});

describe('parseNoTransaksiDate', () => {
  it('reads DDMMYY out of the second segment', () => {
    expect(parseNoTransaksiDate('03-100326-000123')).toEqual(new Date(2026, 2, 10));
    expect(parseNoTransaksiDate('  61-011226-000001 ')).toEqual(new Date(2026, 11, 1));
  });

  it('rejects a short prefix and an impossible calendar date', () => {
    expect(parseNoTransaksiDate('3-100326-000123')).toBeNull();
    expect(parseNoTransaksiDate('03-320326-000123')).toBeNull();
    expect(parseNoTransaksiDate('03-310226-000123')).toBeNull();
    expect(parseNoTransaksiDate('')).toBeNull();
  });
});

describe('boolApprovedFlag', () => {
  it('accepts the legacy set, case-sensitively', () => {
    expect(boolApprovedFlag('1')).toBe(true);
    expect(boolApprovedFlag(' true ')).toBe(true);
    expect(boolApprovedFlag('True')).toBe(true);
    expect(boolApprovedFlag('APPROVED')).toBe(true);
    // The Python set has no upper-case "TRUE" and no lower-case "approve".
    expect(boolApprovedFlag('TRUE')).toBe(false);
    expect(boolApprovedFlag('approve')).toBe(false);
    expect(boolApprovedFlag('0')).toBe(false);
    expect(boolApprovedFlag(undefined)).toBe(false);
  });
});

describe('hasMeaningfulHasilValue', () => {
  it('strips markup and rejects the placeholder values', () => {
    expect(hasMeaningfulHasilValue('<b>12.3</b> g/dL')).toBe(true);
    expect(hasMeaningfulHasilValue('  -  ')).toBe(false);
    expect(hasMeaningfulHasilValue('NULL')).toBe(false);
    expect(hasMeaningfulHasilValue('NONE')).toBe(false);
    expect(hasMeaningfulHasilValue('<p> </p>')).toBe(false);
    expect(hasMeaningfulHasilValue(null)).toBe(false);
    // Case-sensitive against the upper-case forms, as written in the Python.
    expect(hasMeaningfulHasilValue('none')).toBe(true);
  });
});

describe('filterHistoryRowsForDateRange', () => {
  const rows: readonly LegacyRow[] = [
    { no_transaksi: 'A', tgl_transaksi: '2026-03-09 23:00:00' },
    { no_transaksi: 'B', tgl_order: '2026-03-10' },
    { no_transaksi: 'C', tgl_masuk: '12-03-2026 10:00:00' },
    { no_transaksi: 'D', tgl_transaksi: '2026-03-13' },
    { no_transaksi: 'E', tgl_transaksi: 'bukan tanggal' },
  ];

  it('keeps rows inside the inclusive range and drops undated ones', () => {
    const kept = filterHistoryRowsForDateRange(rows, '2026-03-10', '2026-03-12');
    expect(kept.map((row) => row['no_transaksi'])).toEqual(['B', 'C']);
  });

  it('ignores a bound it cannot parse', () => {
    const kept = filterHistoryRowsForDateRange(rows, '', '2026-03-10');
    expect(kept.map((row) => row['no_transaksi'])).toEqual(['A', 'B']);
  });
});

describe('collectPenunjangHistories', () => {
  it('shapes the four payloads into row lists', () => {
    const histories = collectPenunjangHistories({
      lab: { rows: [{ no_transaksi: LAB_TRX }] },
      pa: { rows: [{ no_transaksi: PA_TRX }] },
      rad: [{ no_transaksi: RAD_TRX }],
      ok: undefined,
    });
    expect(histories.lab).toHaveLength(1);
    expect(histories.pa[0]?.['no_transaksi']).toBe(PA_TRX);
    expect(histories.rad).toHaveLength(1);
    expect(histories.ok).toEqual([]);
  });
});

describe('buildHasilLookupWindow', () => {
  it('brackets the transaction date by 14 days', () => {
    expect(buildHasilLookupWindow('03-100326-000123')).toEqual({
      startDate: '2026-02-24',
      endDate: '2026-03-24',
    });
  });

  it('falls back to the injected clock when the number carries no date', () => {
    expect(buildHasilLookupWindow('LAB/2026/1', 14, new Date(2026, 6, 26))).toEqual({
      startDate: '2026-07-12',
      endDate: '2026-08-09',
    });
  });
});

describe('findHasilRowByNoTransaksi', () => {
  it('scans pages in order and returns the matching row', () => {
    const row = findHasilRowByNoTransaksi(
      [{ rows: [{ no_transaksi: 'A' }] }, { rows: [{ no_transaksi: RAD_TRX, tgl_masuk: '2026-03-11' }] }],
      RAD_TRX,
    );
    expect(row['tgl_masuk']).toBe('2026-03-11');
  });

  it('returns {} when the transaction is absent and stops at the first empty page', () => {
    expect(findHasilRowByNoTransaksi([{ rows: [{ no_transaksi: 'A' }] }], RAD_TRX)).toEqual({});
    expect(
      findHasilRowByNoTransaksi([{ rows: [] }, { rows: [{ no_transaksi: RAD_TRX }] }], RAD_TRX),
    ).toEqual({});
  });
});

describe('collectDirectHasilRowsForGroup', () => {
  it('filters to the stay, drops deleted rows, de-duplicates, and stops on a short page', () => {
    const rows = collectDirectHasilRowsForGroup({
      roomRows: ROOM_ROWS,
      rowsPerPage: 2,
      pages: [
        {
          rows: [
            { no_transaksi: 'X1', tgl_transaksi: '2026-03-11 09:00:00' },
            { no_transaksi: 'X2', tgl_transaksi: '2026-03-11 10:00:00', status_hapus: '1' },
          ],
        },
        {
          rows: [
            { no_transaksi: 'X1', tgl_transaksi: '2026-03-12 09:00:00' },
            { no_transaksi: 'X3', tgl_transaksi: '2026-03-20 09:00:00' },
          ],
        },
        { rows: [{ no_transaksi: 'X4', tgl_transaksi: '2026-03-10' }] },
      ],
    });
    // X2 is soft-deleted, page 2's X1 repeats, X3 falls outside the stay. Pages 1
    // and 2 are full so the sweep continues; page 3 is short, so it is the last.
    expect(rows.map((row) => row['no_transaksi'])).toEqual(['X1', 'X4']);
  });

  it('returns nothing when the group has no readable date range', () => {
    expect(
      collectDirectHasilRowsForGroup({ roomRows: [], pages: [{ rows: [{ no_transaksi: 'X' }] }] }),
    ).toEqual([]);
  });
});

// ── Lab PK ───────────────────────────────────────────────────────

describe('validateHasilLaboratoriumPk', () => {
  it('passes an order with detail lines, a real value, a LIS print and an approval', () => {
    const result = validateHasilLaboratoriumPk({
      noRm: NO_RM,
      noTransaksiLab: LAB_TRX,
      detailRows: { rows: [{ kd_tindakan: 'HB', nama_tindakan: 'HEMOGLOBIN' }] },
      detailHasilRows: { rows: [{ no_referensi: 'REF-2' }, { no_referensi: 'REF-1' }] },
      hasilRows: { rows: [{ hasil: '12.3', status: '' }] },
      lisUrl: 'http://simrs.example.local/lis_new/pdf.php?no_transaksi=' + LAB_TRX,
      hasilData: { status_approve: '1', no_transaksi: LAB_TRX },
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.hasResult).toBe(true);
    expect(result.approve).toBe('1');
    expect(result.needsAttention).toBe(false);
    expect(result.severity).toBe('info');
    expect(result.issues).toEqual([]);
    expect(result.reason).toBe('');
    // References are sorted, not left in payload order.
    expect(result.summary).toContain('ref=REF-1,REF-2');
    expect(result.summary).toContain('hasil_ok=1/1');
  });

  it('accepts a PDF that carries the medrec digits when there is no LIS print', () => {
    const result = validateHasilLaboratoriumPk({
      noRm: NO_RM,
      noTransaksiLab: LAB_TRX,
      detailRows: [{ kd_tindakan: 'HB' }],
      hasilRows: [{ hasil: '12.3' }],
      pdfInfo: { is_pdf: true, size: 20480, text: 'RM 0123456\nHEMOGLOBIN 12.3 g/dL' },
      hasilData: { status_approve: 'APPROVED' },
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('pdf_valid=ya');
  });

  it('rejects a blank LIS template even when the PDF is a real PDF', () => {
    const result = validateHasilLaboratoriumPk({
      noRm: NO_RM,
      noTransaksiLab: LAB_TRX,
      detailRows: [{ kd_tindakan: 'HB' }],
      hasilRows: [{ hasil: '12.3' }],
      pdfInfo: { is_pdf: true, text: 'RM 0123456\n0 TH, 0 BL, 0 HR\nPRINT DATE : :' },
      hasilData: { status_approve: '1' },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('LIS/raw/pdf belum valid');
  });

  it('fails and names what is outstanding when there is no result at all', () => {
    const result = validateHasilLaboratoriumPk({
      noRm: NO_RM,
      noTransaksiLab: LAB_TRX,
      detailRows: [],
      hasilRows: { rows: [{ hasil: '-', status: 'NULL' }] },
      lisUrl: '',
      rawResult: '   ',
      pdfInfo: { is_pdf: false, text: '' },
      hasilData: {},
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('warn');
    expect(result.needsAttention).toBe(true);
    expect(result.severity).toBe('warn');
    expect(result.approve).toBe('unknown');
    expect(result.issues).toEqual([
      'detail history kosong',
      'hasil_ok=0/1',
      'LIS/raw/pdf belum valid',
      'approve=unknown',
    ]);
    expect(result.reason).toContain('detail history kosong');
    expect(result.reason).toContain('approve=unknown');
  });

  it('reports approve=0 rather than unknown once the endpoint answered with data', () => {
    const result = validateHasilLaboratoriumPk({
      noRm: NO_RM,
      noTransaksiLab: LAB_TRX,
      detailRows: [{ kd_tindakan: 'HB' }],
      hasilRows: [{ hasil: '12.3' }],
      rawResult: 'raw hasil',
      hasilData: { status_approve: '0', no_transaksi: LAB_TRX },
    });

    // A complete but unapproved result: the modality says ok, the operator is
    // still warned.
    expect(result.status).toBe('ok');
    expect(result.approve).toBe('0');
    expect(result.needsAttention).toBe(true);
    expect(result.issues).toEqual(['approve=0']);
  });
});

// ── PA ───────────────────────────────────────────────────────────

describe('validateHasilPa', () => {
  it('passes an order with detail lines and a result PDF, yet still needs attention', () => {
    const result = validateHasilPa({
      noTransaksiPa: PA_TRX,
      detailRows: { rows: [{ kd_tindakan: 'PA1' }] },
      pdfInfo: { is_pdf: true, size: 40960, text: 'HASIL PEMERIKSAAN PATOLOGI ANATOMI' },
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.noData).toBe(false);
    // PA has no approval endpoint, so the legacy roll-up warns regardless.
    expect(result.approve).toBe('unknown');
    expect(result.needsAttention).toBe(true);
    expect(result.reason).toBe('perlu cek manual');
  });

  it('fails and names what is outstanding when the PDF says the data is missing', () => {
    const result = validateHasilPa({
      noTransaksiPa: PA_TRX,
      detailRows: [],
      pdfInfo: { is_pdf: false, text: 'Data tidak ada' },
    });

    expect(result.ok).toBe(false);
    expect(result.noData).toBe(true);
    expect(result.issues).toEqual([
      'detail history kosong',
      'pdf hasil tidak ada',
      'PDF membalas data tidak ada',
    ]);
    expect(result.reason).toContain('PDF membalas data tidak ada');
    expect(result.summary).toBe(`PA ${PA_TRX} | detail=0 | pdf=tidak | no_data=ya`);
  });
});

// ── Radiologi ────────────────────────────────────────────────────

describe('validateHasilRadiologi', () => {
  it('passes an approved order whose PDF renders and whose PACS study is known', () => {
    const result = validateHasilRadiologi({
      noTransaksiRad: RAD_TRX,
      detailRows: { rows: [{ acc_number: 'ACC-1', nama_tindakan: 'THORAX AP' }] },
      hasilRows: { rows: [{ deskripsi: 'Cor dan pulmo dalam batas normal' }] },
      berkasRows: [],
      studyUidByAccNumber: { 'ACC-1': { studyiud: '1.2.840.113619.2' } },
      pdfInfo: { is_pdf: true, size: 61440, text: 'EKSPERTISE RADIOLOGI' },
      hasilData: { status_approve: '1' },
    });

    expect(result.ok).toBe(true);
    expect(result.approve).toBe('1');
    expect(result.needsAttention).toBe(false);
    expect(result.summary).toContain('studyuid=1');
    expect(result.summary).toContain('berkas=0');
  });

  it('falls back to the getdatakunjungan row for the approval flag', () => {
    const result = validateHasilRadiologi({
      noTransaksiRad: RAD_TRX,
      detailRows: [{ acc_number: '' }],
      hasilRows: [{ hasil: 'Tidak tampak kelainan' }],
      hasilRowMeta: { no_transaksi: RAD_TRX, status_approve: 'APPROVE' },
      hasilData: undefined,
      pdfInfo: { is_pdf: true, text: 'EKSPERTISE' },
    });

    expect(result.approve).toBe('1');
    expect(result.ok).toBe(true);
  });

  it('fails and names what is outstanding when the PDF is a PHP error page', () => {
    const result = validateHasilRadiologi({
      noTransaksiRad: RAD_TRX,
      detailRows: [{ acc_number: 'ACC-1' }],
      hasilRows: [{ deskripsi: 'Cor normal' }],
      studyUidByAccNumber: { 'ACC-1': { studyiud: '' } },
      pdfInfo: { is_pdf: true, text: 'A PHP Error was encountered\nSeverity: Notice' },
      hasilData: {},
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('warn');
    expect(result.hasResult).toBe(false);
    expect(result.issues).toEqual(['pdf hasil error', 'approve=unknown']);
    expect(result.reason).toContain('pdf hasil error');
  });

  it('fails when there is no hasil, no berkas and no studyuid', () => {
    const result = validateHasilRadiologi({
      noTransaksiRad: RAD_TRX,
      detailRows: [{ acc_number: 'ACC-1' }],
      hasilRows: [{ deskripsi: '-', hasil: 'NULL' }],
      berkasRows: [],
      studyUidByAccNumber: {},
      pdfInfo: { is_pdf: true, text: 'EKSPERTISE' },
      hasilData: { status_approve: '1' },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('hasil/berkas/studyuid kosong');
  });
});

// ── Elektromedik ─────────────────────────────────────────────────

describe('validateHasilElektromedik', () => {
  it('passes an approved order whose detail HTML holds the narrative', () => {
    const result = validateHasilElektromedik({
      noTransaksiElm: ELM_TRX,
      detailRows: { rows: [{ kd_tindakan: 'EKG', nama_tindakan: 'EKG 12 LEAD' }] },
      hasilRows: { rows: [{ hasil: '1', kd_tindakan: 'EKG', kd_item_pemeriksaan: 'ITEM1' }] },
      statusBayar: true,
      pdfInfo: { is_pdf: true, size: 30720, text: `HASIL EKG\nNo transaksi ${ELM_TRX}` },
      detailHtmlByItem: {
        'EKG|ITEM1':
          '<div>DATA HASIL PEMERIKSAAN SUDAH APPROVE</div>' +
          '<textarea id="txtDefaultHtmlArea_hslelm">Sinus rhythm, 78 bpm</textarea>',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.approve).toBe('1');
    expect(result.needsAttention).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.summary).toContain('detail_hasil=1');
    expect(result.summary).toContain('pdf_match_trx=ya');
  });

  it('marks a filled but unapproved narrative as approve=0', () => {
    const result = validateHasilElektromedik({
      noTransaksiElm: ELM_TRX,
      detailRows: [{ kd_tindakan: 'EKG' }],
      hasilRows: [{ hasil: '1', kd_tindakan: 'EKG', kd_item_pemeriksaan: 'ITEM1' }],
      pdfInfo: { is_pdf: true, text: `HASIL EKG ${ELM_TRX}` },
      detailHtmlByItem: {
        'EKG|ITEM1': '<textarea id="txtDefaultHtmlArea_hslelm">Sinus rhythm</textarea>',
      },
    });

    expect(result.approve).toBe('0');
    expect(result.status).toBe('ok');
    expect(result.needsAttention).toBe(true);
    expect(result.issues).toEqual(['approve=0']);
  });

  it('fails a PDF that renders for someone else and has no detail narrative', () => {
    const result = validateHasilElektromedik({
      noTransaksiElm: ELM_TRX,
      detailRows: [{ kd_tindakan: 'EKG' }],
      hasilRows: [{ hasil: '1', kd_tindakan: 'EKG', kd_item_pemeriksaan: 'ITEM1' }],
      pdfInfo: { is_pdf: true, text: 'HASIL EKG\nNo transaksi 61-010326-000001' },
      detailHtmlByItem: { 'EKG|ITEM1': '<div>belum ada hasil</div>' },
    });

    expect(result.ok).toBe(false);
    expect(result.hasResult).toBe(false);
    expect(result.issues).toEqual([
      'detail hasil/pdf belum mengikat transaksi',
      'approve=unknown',
    ]);
    expect(result.reason).toContain('belum mengikat transaksi');
  });

  it('fails and names what is outstanding when there is no result and no PDF', () => {
    const result = validateHasilElektromedik({
      noTransaksiElm: ELM_TRX,
      detailRows: [{ kd_tindakan: 'EKG' }],
      hasilRows: [{ hasil: '0', deskripsi: '', kd_tindakan: 'EKG', kd_item_pemeriksaan: 'ITEM1' }],
    });

    expect(result.ok).toBe(false);
    expect(result.approve).toBe('unknown');
    expect(result.issues).toEqual([
      'hasil_ok=0/1',
      'pdf hasil tidak ada',
      'detail hasil/pdf belum mengikat transaksi',
      'approve=unknown',
    ]);
  });
});

// ── the alert ────────────────────────────────────────────────────

describe('buildPenunjangValidationAlert', () => {
  const clean: PenunjangValidation = {
    ok: true,
    modality: 'Lab PK',
    noTransaksi: LAB_TRX,
    status: 'ok',
    needsAttention: false,
    hasResult: true,
    approve: '1',
    reason: '',
    issues: [],
    summary: `Lab PK ${LAB_TRX} | detail=1`,
    severity: 'info',
    details: [],
  };

  it('raises nothing for an approved, complete result', () => {
    expect(buildPenunjangValidationAlert('R100', clean)).toBeNull();
  });

  it('raises nothing when there is no registration to file it under', () => {
    expect(buildPenunjangValidationAlert('  ', { ...clean, status: 'warn', ok: false })).toBeNull();
  });

  it('raises a WARN carrying the validator issues', () => {
    const alert = buildPenunjangValidationAlert('R100', {
      ...clean,
      ok: false,
      status: 'warn',
      needsAttention: true,
      hasResult: false,
      approve: 'unknown',
      issues: ['detail history kosong', 'approve=unknown'],
      summary: `Lab PK ${LAB_TRX} | detail=0`,
    });

    expect(alert).toEqual({
      reg: 'R100',
      level: 'WARN',
      message: `Lab PK ${LAB_TRX} | detail=0 | issue=detail history kosong; approve=unknown`,
    });
  });

  it('synthesises the issue text when the validator listed none', () => {
    const alert = buildPenunjangValidationAlert('R100', {
      ...clean,
      ok: false,
      status: 'warn',
      needsAttention: true,
      hasResult: false,
      approve: '0',
      issues: [],
      summary: '',
    });

    expect(alert?.message).toBe(
      `Lab PK ${LAB_TRX} | issue=hasil belum lengkap/tidak ada; approve=0`,
    );
  });

  it('prefers the no-data wording for PA and does not add an approve issue', () => {
    const alert = buildPenunjangValidationAlert('R100', {
      ...clean,
      modality: 'PA',
      noTransaksi: PA_TRX,
      ok: false,
      status: 'warn',
      needsAttention: true,
      hasResult: false,
      approve: 'unknown',
      issues: [],
      summary: '',
      noData: true,
    });

    expect(alert?.message).toBe(`PA ${PA_TRX} | issue=data hasil tidak ada`);
  });

  it('still raises for a clean PA, because PA never reports an approval', () => {
    const alert = buildPenunjangValidationAlert('R100', {
      ...clean,
      modality: 'PA',
      noTransaksi: PA_TRX,
      approve: 'unknown',
      needsAttention: true,
      summary: `PA ${PA_TRX} | detail=1 | pdf=ya | no_data=tidak`,
    });

    expect(alert?.message).toBe(`PA ${PA_TRX} | detail=1 | pdf=ya | no_data=tidak`);
  });
});

// ── the group orchestration ──────────────────────────────────────

function stubValidation(candidate: PenunjangCandidate, ok: boolean): PenunjangValidation {
  const approve = candidate.modality === 'PA' ? 'unknown' : ok ? '1' : '0';
  return {
    ok,
    modality: candidate.modality,
    noTransaksi: candidate.noTransaksi,
    status: ok ? 'ok' : 'warn',
    needsAttention: !ok || approve === '0' || approve === 'unknown',
    hasResult: ok,
    approve,
    reason: ok ? '' : 'hasil belum lengkap/tidak ada',
    issues: ok ? [] : ['hasil belum lengkap/tidak ada'],
    summary: `${candidate.modality} ${candidate.noTransaksi}`,
    severity: ok ? 'info' : 'warn',
    details: [],
  };
}

describe('collectPenunjangValidationCandidates', () => {
  it('de-duplicates per modality and keeps the legacy ordering', () => {
    const candidates = collectPenunjangValidationCandidates({
      roomRows: ROOM_ROWS,
      relatedLabPk: [
        { no_transaksi_lab: LAB_TRX, no_transaksi: 'POLI-1' },
        { no_transaksi_lab: LAB_TRX, no_transaksi: 'POLI-1' },
      ],
      directLabRows: [{ no_transaksi: LAB_TRX }, { no_transaksi: '01-110326-000200' }],
      penunjangHistories: {
        pa: [{ no_transaksi: PA_TRX, kd_jenis_pemeriksaan: '2' }, { no_transaksi: '' }],
        rad: [{ no_transaksi: RAD_TRX }],
      },
      directRadRows: [{ no_transaksi: RAD_TRX }, { no_transaksi: '02-120326-000078' }],
      elektromedikHistory: [{ no_transaksi: ELM_TRX }],
    });

    expect(candidates.reg).toBe('R100');
    expect(candidates.labPk.map((item) => item.noTransaksi)).toEqual([
      LAB_TRX,
      '01-110326-000200',
    ]);
    expect(candidates.pa).toHaveLength(1);
    expect(candidates.pa[0]?.kdJenisPemeriksaan).toBe('2');
    expect(candidates.radiologi.map((item) => item.noTransaksi)).toEqual([
      RAD_TRX,
      '02-120326-000078',
    ]);
    expect(candidates.all.map((item) => item.modality)).toEqual([
      'Lab PK',
      'Lab PK',
      'PA',
      'Radiologi',
      'Radiologi',
      'Elektromedik',
    ]);
  });

  it('defaults a missing kd_jenis_pemeriksaan to "1"', () => {
    const candidates = collectPenunjangValidationCandidates({
      roomRows: ROOM_ROWS,
      penunjangHistories: { pa: [{ no_transaksi: PA_TRX }] },
    });
    expect(candidates.pa[0]?.kdJenisPemeriksaan).toBe('1');
  });
});

describe('validatePenunjangResultsForGroup', () => {
  it('skips a group with no penunjang transaction', () => {
    const group = validatePenunjangResultsForGroup({
      roomRows: ROOM_ROWS,
      validate: (candidate) => stubValidation(candidate, true),
    });

    expect(group.status).toBe('skip');
    expect(group.results).toEqual([]);
    expect(group.alerts).toEqual([]);
    expect(group.lines).toContain(
      '   - Hasil        : tidak ada transaksi penunjang yang perlu divalidasi',
    );
  });

  it('reports ok and raises nothing when every result is clean', () => {
    const group = validatePenunjangResultsForGroup({
      roomRows: ROOM_ROWS,
      directLabRows: [{ no_transaksi: LAB_TRX }],
      penunjangHistories: { rad: [{ no_transaksi: RAD_TRX }] },
      validate: (candidate) => stubValidation(candidate, true),
    });

    expect(group.status).toBe('ok');
    expect(group.counts).toEqual({ labPk: 1, pa: 0, radiologi: 1, elektromedik: 0 });
    expect(group.needsAttention).toEqual([]);
    expect(group.alerts).toEqual([]);
    expect(group.lines).toContain('   - Hasil        : semua hasil penunjang yang terkait sudah sesuai');
  });

  it('warns once any result needs attention and files the alerts under the reg', () => {
    const group = validatePenunjangResultsForGroup({
      roomRows: ROOM_ROWS,
      directLabRows: [{ no_transaksi: LAB_TRX }],
      elektromedikHistory: [{ no_transaksi: ELM_TRX }],
      validate: (candidate) => stubValidation(candidate, candidate.modality !== 'Elektromedik'),
    });

    expect(group.status).toBe('warn');
    expect(group.needsAttention.map((item) => item.modality)).toEqual(['Elektromedik']);
    expect(group.alerts).toHaveLength(1);
    expect(group.alerts[0]).toEqual({
      reg: 'R100',
      level: 'WARN',
      message: `Elektromedik ${ELM_TRX} | issue=hasil belum lengkap/tidak ada`,
    });
    expect(group.lines).toContain(
      '   - Hasil        : ditemukan 1 transaksi penunjang yang perlu perhatian',
    );
  });

  it('cannot report ok for a group that has a PA order, even a clean one', () => {
    const group = validatePenunjangResultsForGroup({
      roomRows: ROOM_ROWS,
      penunjangHistories: { pa: [{ no_transaksi: PA_TRX }] },
      validate: (candidate) => stubValidation(candidate, true),
    });

    expect(group.status).toBe('warn');
    expect(group.needsAttention).toHaveLength(1);
    expect(group.alerts).toHaveLength(1);
  });
});
