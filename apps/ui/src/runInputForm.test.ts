import { describe, expect, it } from 'vitest';
import { RAJAL_DEFAULT_PAYMENT_CONFIG } from '@simrs-flow/domain-rajal';
import {
  buildRajalInput,
  buildRanapInput,
  clampToleranceDays,
  filterClinicOptions,
  mergeClinicOptions,
  applyRajalFetch,
  removeClinic,
  keepPatientsForClinics,
  rmMatches,
  RANAP_VERIFY_OFF,
  rajalMaxPatients,
  splitList,
  treatmentGroupsFromRows,
} from './features/forms/RunInputForm.js';

describe('RunInputForm helpers', () => {
  it('splits comma and newline separated operator lists', () => {
    expect(splitList('012345, 067890\n111222')).toEqual(['012345', '067890', '111222']);
  });

  it('keeps a clinic option visible while it is being typed in full', () => {
    const options = ['ANAK', 'DALAM', 'BEDAH'];
    // The token being typed is the search query, not a selection — "DALAM" must
    // stay visible even when typed in full (it only hides once committed by a comma).
    expect(filterClinicOptions(options, 'DALAM')).toContain('DALAM');
    expect(filterClinicOptions(options, 'DAL')).toContain('DALAM');
    // A committed token (before a comma) IS a selection and is hidden.
    expect(filterClinicOptions(options, 'DALAM, B')).not.toContain('DALAM');
    expect(filterClinicOptions(options, 'DALAM, B')).toContain('BEDAH');
  });

  it('adds live report poli headings without duplicating a static clinic', () => {
    const merged = mergeClinicOptions(['DALAM', 'BEDAH'], ['POLI DALAM', 'POLI GIGI PROSTODONSIA', ' ']);
    expect(merged).toEqual(['BEDAH', 'DALAM', 'POLI GIGI PROSTODONSIA']);
  });

  it('fills the list form from the unpaid report (legacy doFetch) and edits poli chips', () => {
    const base = { mode: 'list' as const, patientIds: '0-1', clinics: 'MATA', date: '2026-10-19', acceptedPenjaminKeywords: '', tindakanIncludeKeywords: '', tindakanExcludeKeywords: '', tindakanMinCount: '' };
    const report = { patientIds: ['0-90-00-04', '0-90-00-05'], clinics: ['POLI DALAM', 'POLI PENYAKIT DALAM GASTROENTEROHEPATOLOGI'] };
    const all = applyRajalFetch(base, report, '2026-10-01', '2026-10-19');
    expect(all.patientIds).toBe('0-90-00-04\n0-90-00-05');
    expect(all.clinics).toBe('POLI DALAM, POLI PENYAKIT DALAM GASTROENTEROHEPATOLOGI');
    expect(buildRajalInput(all).input).toMatchObject({ date: '2026-10-01', dateFrom: '2026-10-01', dateTo: '2026-10-19' });
    // "Poli terpilih" keeps the operator's chips.
    expect(applyRajalFetch({ ...base, fetchScope: 'selected' }, report, '2026-10-01', '2026-10-19').clinics).toBe('MATA');
    expect(removeClinic(all.clinics, 'POLI DALAM')).toBe('POLI PENYAKIT DALAM GASTROENTEROHEPATOLOGI');
    // Titles that differ only by spacing must not become two identical chips.
    expect(applyRajalFetch(base, { ...report, clinics: ['DALAM', 'DALAM ', ' MATA'] }, '2026-10-01', '2026-10-19').clinics).toBe('DALAM, MATA');
    expect(buildRajalInput({ ...base, dateTo: '2026-10-01' }).error).toMatch(/Tanggal sampai/);
  });

  it('rajal write switches: Verifikasi / Tampung bayar off reach the input and the badge; on is the default shape', () => {
    const base = { mode: 'list' as const, patientIds: '0-1', clinics: 'MATA', date: '2026-10-19', acceptedPenjaminKeywords: '', tindakanIncludeKeywords: '', tindakanExcludeKeywords: '', tindakanMinCount: '' };
    const on = buildRajalInput({ ...base, enableVerifikasi: true, enableTampungBayar: true });
    expect(on.input).not.toHaveProperty('enableVerifikasi');
    expect(on.input).not.toHaveProperty('enableTampungBayar');
    const off = buildRajalInput({ ...base, enableVerifikasi: false, enableTampungBayar: false });
    expect(off.input).toMatchObject({ enableVerifikasi: false, enableTampungBayar: false });
    expect(off.summary).toMatch(/tanpa verifikasi · tanpa tampung bayar$/);
  });

  it('drops fetched No. RM whose only poli was removed, keeping typed ones', () => {
    const byRm = { '0-1': ['POLI DALAM'], '0-2': ['POLI MATA'], '0-3': ['POLI DALAM', 'POLI MATA'] };
    expect(keepPatientsForClinics('0-1\n0-2\n0-3\n9-9', 'POLI MATA', byRm)).toBe('0-2\n0-3\n9-9');
    // Chips spelled as static keys still match the report headings.
    expect(keepPatientsForClinics('0-1\n0-2', 'DALAM', byRm)).toBe('0-1');
    expect(keepPatientsForClinics('0-1\n0-2\n9-9', '', byRm)).toBe('9-9');
  });

  it('finds a No. RM by digits with or without dashes', () => {
    expect(rmMatches('0-12-34-56', '123456')).toBe(true);
    expect(rmMatches('0-12-34-56', '0-12-34-56')).toBe(true);
    expect(rmMatches('0-12-34-56', '12-34')).toBe(true);
    expect(rmMatches('0-12-34-57', '123456')).toBe(false);
    expect(rmMatches('0-12-34-56', '')).toBe(true);
  });

  it('clamps ranap tolerance days to the backend-supported window', () => {
    expect(clampToleranceDays('')).toBe(3);
    expect(clampToleranceDays('-5')).toBe(0);
    expect(clampToleranceDays('100')).toBe(14);
  });

  it('builds a ranap input from No. RM and tanggal', () => {
    const result = buildRanapInput({
      noRm: ' 012345 ',
      tanggal: '2026-06-19',
      toleranceDays: '4',
      acceptedPenjaminKeywords: 'BPJS PBI, BPJS NON PBI',
    });

    expect(result.error).toBeUndefined();
    expect(result.input).toEqual({
      noRm: '012345',
      patientIds: ['012345'],
      tanggal: '2026-06-19',
      toleranceDays: 4,
      acceptedPenjaminKeywords: ['BPJS PBI', 'BPJS NON PBI'],
      // Omitted switches fall back to the legacy defaults, all off.
      debugMode: false,
      skipVerifikasiSep: false,
      enableTampungBayar: false,
    });
  });

  it('carries the ranap run switches and names them in the summary', () => {
    const result = buildRanapInput({
      noRm: '012345',
      tanggal: '2026-06-19',
      toleranceDays: '3',
      acceptedPenjaminKeywords: '',
      debugMode: true,
      skipVerifikasiSep: true,
      enableTampungBayar: true,
      userProses: '  naufal a  ',
    });

    expect(result.error).toBeUndefined();
    expect(result.input).toMatchObject({
      debugMode: true,
      skipVerifikasiSep: true,
      enableTampungBayar: true,
      userProses: 'naufal a',
    });
    // The operator must be able to see the risky switches without opening the panel.
    expect(result.summary).toContain('debug');
    expect(result.summary).toContain('skip SEP');
    expect(result.summary).toContain('tampung bayar');
  });

  it('refuses more than one ranap No. RM instead of silently billing only the first', () => {
    const result = buildRanapInput({
      noRm: '0-90-00-09\n0-90-00-10',
      tanggal: '2026-06-19',
      toleranceDays: '3',
      acceptedPenjaminKeywords: '',
    });

    expect(result.error).toMatch(/satu pasien per run/);
    expect(result.input).toBeUndefined();
  });

  it('rejects rajal input without patient IDs', () => {
    const result = buildRajalInput({
      patientIds: '   ',
      clinics: 'PENYAKIT DALAM',
      date: '2026-06-19',
      acceptedPenjaminKeywords: 'BPJS PBI',
      tindakanIncludeKeywords: '',
      tindakanExcludeKeywords: '',
      tindakanMinCount: '',
    });

    expect(result.error).toMatch(/No\. RM/);
    expect(result.input).toBeUndefined();
  });

  it('builds a rajal batch input', () => {
    const result = buildRajalInput({
      patientIds: '012345\n067890',
      clinics: 'PENYAKIT DALAM, BEDAH',
      date: '2026-06-19',
      acceptedPenjaminKeywords: '',
      tindakanIncludeKeywords: '',
      tindakanExcludeKeywords: '',
      tindakanMinCount: '',
    });

    expect(result.error).toBeUndefined();
    expect(result.input).toEqual({
      patientIds: ['012345', '067890'],
      clinics: ['PENYAKIT DALAM', 'BEDAH'],
      date: '2026-06-19',
      acceptedPenjaminKeywords: undefined,
      tindakanIncludeKeywords: undefined,
      tindakanExcludeKeywords: undefined,
      tindakanMinCount: undefined,
      paymentConfig: RAJAL_DEFAULT_PAYMENT_CONFIG,
    });
  });

  it('includes optional rajal tindakan filters and payment config when populated', () => {
    const result = buildRajalInput({
      patientIds: '012345',
      clinics: 'PENYAKIT DALAM',
      date: '2026-06-19',
      acceptedPenjaminKeywords: 'BPJS PBI',
      tindakanIncludeKeywords: 'BIAYA OBAT, KONSULTASI',
      tindakanExcludeKeywords: 'PENDAFTARAN PASIEN',
      tindakanMinCount: '2',
      paymentShift: '2',
      paymentType: '11',
      paymentPayerCode: '14',
    });

    expect(result.error).toBeUndefined();
    expect(result.input).toMatchObject({
      tindakanIncludeKeywords: ['BIAYA OBAT', 'KONSULTASI'],
      tindakanExcludeKeywords: ['PENDAFTARAN PASIEN'],
      tindakanMinCount: 2,
      paymentConfig: { shift: '2', type: '11', payerCode: '14' },
    });
  });

  it('normalizes legacy rajal payment labels to backend codes', () => {
    const result = buildRajalInput({
      patientIds: '012345',
      clinics: 'PENYAKIT DALAM',
      date: '2026-06-19',
      acceptedPenjaminKeywords: '',
      tindakanIncludeKeywords: '',
      tindakanExcludeKeywords: '',
      tindakanMinCount: '',
      paymentShift: 'Shift 3',
      paymentType: 'QRIS',
      paymentPayerCode: ' 14 ',
    });

    expect(result.error).toBeUndefined();
    expect(result.input).toMatchObject({ paymentConfig: { shift: '3', type: '11', payerCode: '14' } });
  });

  it('parses per-row rajal treatment filters', () => {
    const result = buildRajalInput({
      patientIds: '012345',
      clinics: 'PENYAKIT DALAM',
      date: '2026-06-19',
      acceptedPenjaminKeywords: 'BPJS PBI',
      tindakanIncludeKeywords: 'BIAYA OBAT\nKONSULTASI',
      tindakanExcludeKeywords: 'PENDAFTARAN PASIEN\nADMINISTRASI',
      tindakanMinCount: '',
    });

    expect(result.error).toBeUndefined();
    expect(result.input).toMatchObject({
      tindakanIncludeKeywords: ['BIAYA OBAT', 'KONSULTASI'],
      tindakanExcludeKeywords: ['PENDAFTARAN PASIEN', 'ADMINISTRASI'],
    });
  });

  it('emits the legacy AND/OR treatment groups for a picked template', () => {
    // "Pendaftaran + Obat" means A=registration AND B=obat. Two include keywords
    // alone would satisfy neither group and the operator would believe the
    // template was enforced.
    const result = buildRajalInput({
      patientIds: '012345',
      clinics: 'ANAK',
      date: '2026-06-19',
      acceptedPenjaminKeywords: '',
      tindakanIncludeKeywords: 'PENDAFTARAN PASIEN\nBIAYA OBAT',
      tindakanExcludeKeywords: '',
      tindakanMinCount: '',
      treatmentTemplateId: 'obat',
    });

    expect(result.error).toBeUndefined();
    expect(result.input).toMatchObject({
      treatmentGroups: [
        { group: 'A', key: 'registration', name: 'PENDAFTARAN PASIEN' },
        { group: 'B', key: 'obat', name: 'BIAYA OBAT' },
      ],
    });
  });

  it('drops the treatment groups once the operator edits the template text by hand', () => {
    const result = buildRajalInput({
      patientIds: '012345',
      clinics: 'ANAK',
      date: '2026-06-19',
      acceptedPenjaminKeywords: '',
      tindakanIncludeKeywords: 'PENDAFTARAN PASIEN',
      tindakanExcludeKeywords: '',
      tindakanMinCount: '',
      treatmentTemplateId: undefined,
    });

    expect(result.error).toBeUndefined();
    expect(result.input).not.toHaveProperty('treatmentGroups');
  });

  it('carries the skip list as legacy skipTreatments', () => {
    const result = buildRajalInput({
      patientIds: '012345',
      clinics: 'ANAK',
      date: '2026-06-19',
      acceptedPenjaminKeywords: '',
      tindakanIncludeKeywords: '',
      tindakanExcludeKeywords: 'ODC\nKEMOTERAPI',
      tindakanMinCount: '',
    });

    expect(result.input).toMatchObject({ skipTreatments: ['ODC', 'KEMOTERAPI'] });
  });

  it('names the typed-list mode in the summary badge', () => {
    // The two modes reach very different batch sizes, so the badge has to say
    // which one produced the input without the operator opening the panel.
    const result = buildRajalInput({
      patientIds: '012345',
      clinics: 'PENYAKIT DALAM',
      date: '2026-06-19',
      acceptedPenjaminKeywords: '',
      tindakanIncludeKeywords: '',
      tindakanExcludeKeywords: '',
      tindakanMinCount: '',
    });

    expect(result.summary).toBe('Rajal daftar No. RM · 1 pasien, 1 poli @ 2026-06-19');
    expect(result.input).not.toHaveProperty('discovery');
  });

  it('builds a rajal auto-fetch input from the period and report filters', () => {
    const result = buildRajalInput({
      mode: 'discover',
      // A typed list left over from the other mode must not leak into the run.
      patientIds: '012345\n067890',
      clinics: '',
      date: '2026-06-19',
      acceptedPenjaminKeywords: 'BPJS PBI',
      tindakanIncludeKeywords: '',
      tindakanExcludeKeywords: '',
      tindakanMinCount: '',
      discoverInstalasi: '14',
      discoverFrom: '2026-06-01',
      discoverTo: '2026-06-30',
      discoverPenjamin: ' BPJS ',
      discoverUnit: ' MATA, DALAM ',
      discoverMaxPatients: '25',
    });

    expect(result.error).toBeUndefined();
    expect(result.input).toEqual({
      // The period start doubles as `date`; the effective range comes from the
      // discovery period, exactly as legacy's autosaveCfg copies it.
      date: '2026-06-01',
      discovery: {
        instalasi: '14',
        from: '2026-06-01',
        to: '2026-06-30',
        penjamin: 'BPJS',
        unit: 'MATA, DALAM',
        maxPatients: 25,
      },
      acceptedPenjaminKeywords: ['BPJS PBI'],
      tindakanIncludeKeywords: undefined,
      tindakanExcludeKeywords: undefined,
      tindakanMinCount: undefined,
      paymentConfig: RAJAL_DEFAULT_PAYMENT_CONFIG,
    });
    expect(result.summary).toBe(
      'Rajal cari otomatis 2026-06-01 → 2026-06-30 · Penunjang, penjamin "BPJS", unit "MATA, DALAM", poli dari laporan · maks 25 pasien',
    );
  });

  it('carries a narrowing poli list into the auto-fetch input', () => {
    const result = buildRajalInput({
      mode: 'discover',
      patientIds: '',
      clinics: 'MATA',
      date: '2026-06-19',
      acceptedPenjaminKeywords: '',
      tindakanIncludeKeywords: '',
      tindakanExcludeKeywords: '',
      tindakanMinCount: '',
      discoverFrom: '2026-06-01',
      discoverTo: '2026-06-01',
    });

    expect(result.error).toBeUndefined();
    // No instalasi picked falls back to legacy's default, `1` (Rawat Jalan),
    // and an unset cap means no limit.
    expect(result.input).toMatchObject({ clinics: ['MATA'], discovery: { instalasi: '1' } });
    expect((result.input as { discovery: object }).discovery).not.toHaveProperty('maxPatients');
    expect(result.summary).toContain('1 poli dipilih');
    expect(result.summary).not.toContain('maks');
  });

  it('rejects an auto-fetch input whose period is missing or backwards', () => {
    const base = {
      mode: 'discover' as const,
      patientIds: '',
      clinics: '',
      date: '2026-06-19',
      acceptedPenjaminKeywords: '',
      tindakanIncludeKeywords: '',
      tindakanExcludeKeywords: '',
      tindakanMinCount: '',
    };

    expect(buildRajalInput({ ...base, discoverFrom: '', discoverTo: '2026-06-30' }).error).toMatch(/Periode/);
    expect(
      buildRajalInput({ ...base, discoverFrom: '2026-06-30', discoverTo: '2026-06-01' }).error,
    ).toMatch(/terbalik/);
    expect(buildRajalInput({ ...base, discoverFrom: '2026-13-01', discoverTo: '2026-06-30' }).input).toBeUndefined();
  });

  it('treats an empty or invalid discovered-batch cap as no limit', () => {
    expect(rajalMaxPatients(undefined)).toBeUndefined();
    expect(rajalMaxPatients('')).toBeUndefined();
    expect(rajalMaxPatients('0')).toBeUndefined();
    expect(rajalMaxPatients('-4')).toBeUndefined();
    expect(rajalMaxPatients('12')).toBe(12);
  });

  it('keeps rajal enabled node overrides with the built input', () => {
    const result = buildRajalInput(
      {
        patientIds: '012345',
        clinics: 'PENYAKIT DALAM',
        date: '2026-06-19',
        acceptedPenjaminKeywords: '',
        tindakanIncludeKeywords: '',
        tindakanExcludeKeywords: '',
        tindakanMinCount: '',
      },
      { validate_radiology: false, validate_lab: true },
    );

    expect(result.error).toBeUndefined();
    expect(result.enabled).toEqual({ validate_radiology: false, validate_lab: true });
  });
});

describe('run setup switches', () => {
  const rows = [
    { enabled: true, name: 'PENDAFTARAN PASIEN', group: 'A' },
    { enabled: false, name: 'KONSULTASI', group: 'A' },
    { enabled: true, name: 'BIAYA OBAT', group: 'B' },
    { enabled: true, name: '  ', group: 'B' },
  ];
  it('turns ticked treatment rows into OR / AND / per-group requirements', () => {
    expect(treatmentGroupsFromRows(rows, 'or').map((g) => g.group)).toEqual(['A', 'A']);
    expect(treatmentGroupsFromRows(rows, 'and').map((g) => g.group)).toEqual(['A', 'B']);
    expect(treatmentGroupsFromRows(rows, 'group')).toEqual([
      { group: 'A', key: 'pendaftaran_pasien', name: 'PENDAFTARAN PASIEN' },
      { group: 'B', key: 'biaya_obat', name: 'BIAYA OBAT' },
    ]);
  });

  it('feeds the row editors and the SEP switch into the rajal input', () => {
    const result = buildRajalInput({
      patientIds: '0-01-23-45', clinics: 'DALAM', date: '2026-10-18', acceptedPenjaminKeywords: '',
      tindakanIncludeKeywords: 'IGNORED', tindakanExcludeKeywords: 'IGNORED', tindakanMinCount: '',
      requiredRows: rows, requiredLogic: 'and',
      skipRows: [{ enabled: true, name: 'ODC', group: 'A' }, { enabled: false, name: 'HD', group: 'A' }],
      sepCheckRequired: false,
    });
    expect(result.input).toMatchObject({
      tindakanIncludeKeywords: ['PENDAFTARAN PASIEN', 'BIAYA OBAT'],
      tindakanExcludeKeywords: ['ODC'],
      skipTreatments: ['ODC'],
      sepCheckRequired: false,
    });
    expect((result.input as { treatmentGroups?: unknown[] }).treatmentGroups).toHaveLength(2);
  });

  it('runs ranap checks only when verification is off, and drops tampung bayar with it', () => {
    const base = { noRm: '0-01-23-45', tanggal: '2026-10-18', toleranceDays: '3', acceptedPenjaminKeywords: '' };
    const off = buildRanapInput({ ...base, enableVerifikasi: false, enableTampungBayar: true });
    expect(off.enabled).toEqual(RANAP_VERIFY_OFF);
    expect(off.input).toMatchObject({ enableTampungBayar: false });
    expect(off.summary).toMatch(/tanpa verifikasi/);
    expect(buildRanapInput({ ...base, enableTampungBayar: true }).enabled).toBeUndefined();
  });

  it('switches the opt-in berkas notice on through the enabled map, alone or with checks-only', () => {
    const base = { noRm: '0-01-23-45', tanggal: '2026-10-18', toleranceDays: '3', acceptedPenjaminKeywords: '' };
    const berkas = buildRanapInput({ ...base, cekBerkas: true });
    expect(berkas.enabled).toEqual({ check_berkas: true });
    expect(berkas.summary).toMatch(/cek berkas/);
    expect(buildRanapInput({ ...base, cekBerkas: true, enableVerifikasi: false }).enabled).toEqual({ ...RANAP_VERIFY_OFF, check_berkas: true });
    expect(buildRanapInput({ ...base, cekBerkas: false }).enabled).toBeUndefined();
  });
});
