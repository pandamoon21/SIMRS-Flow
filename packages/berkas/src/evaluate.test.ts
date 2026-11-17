import { describe, expect, it } from 'vitest';
import { berkasFactsOf, berkasIndexPayload, evaluateBerkas, pageList, type BerkasPagePort } from './evaluate.js';

describe('berkas index payload', () => {
  it('fills the upload-berkas filter for one medrec and period', () => {
    const payload = berkasIndexPayload({ noRm: '0-12-34-56', from: '2026-01-01', to: '2026-01-05', kdInstalasi: '1' });
    expect(payload).toMatchObject({ kd_instalasi: '1', txtperiode1_upld: '2026-01-01', txtperiode2_upld: '2026-01-05', no_medicalrecord: '0-12-34-56', rows: '20' });
  });
});

const page = (n: number, docTypes: string[], extra: Partial<BerkasPagePort> = {}): BerkasPagePort =>
  ({ page: n, source: 'teks', docTypes, labels: docTypes.map((t) => `L:${t}`), ...extra });

describe('berkas facts', () => {
  it('reads radiology, ECG and blood charges, ignoring ECG consumables', () => {
    const facts = berkasFactsOf(['THORAX AP', 'EKG', 'EKG ELEKTRODA DEWASA', 'PRC', 'Visite dokter spesialis', 'thorax ap'], true);
    expect(facts).toEqual({ instalasi: 'ranap', titipan: true, radiologi: ['THORAX AP'], ekg: ['EKG'], darah: ['PRC'] });
  });
});

describe('evaluateBerkas', () => {
  it('requires the base documents and adds what the stay calls for', () => {
    const report = { pages: [page(1, ['resume']), page(9, ['rincian_biaya']), page(13, ['sep']), page(3, ['triase']), page(18, ['ekg'], { source: 'foto', ecgLike: true })] };
    const result = evaluateBerkas(report, { instalasi: 'ranap', titipan: true, radiologi: ['THORAX AP'], ekg: ['EKG'], darah: [] });
    expect(result.checks.map((c) => [c.docType, c.found, c.pages])).toEqual([
      ['sep', true, [13]],
      ['resume', true, [1]],
      ['rincian_biaya', true, [9]],
      ['kamar_penuh', false, []],
      ['radiologi', false, []],
      ['ekg', true, [18]],
    ]);
    expect(result.checks.find((c) => c.docType === 'ekg')).toMatchObject({ probable: true, why: 'ada tagihan EKG' });
    expect(result.missing.map((c) => c.docType)).toEqual(['kamar_penuh', 'radiologi']);
    expect(result.others).toEqual([{ label: 'L:triase', pages: [3] }]);
  });

  it('asks nothing extra for a plain stay', () => {
    const result = evaluateBerkas({ pages: [page(1, ['sep'])] }, { instalasi: 'ranap', titipan: false, radiologi: [], ekg: [], darah: [] });
    expect(result.checks.map((c) => c.docType)).toEqual(['sep', 'resume', 'rincian_biaya']);
  });

  it('asks a rajal visit for its lembar verifikasi instead of a resume', () => {
    const facts = berkasFactsOf(['KONSULTASI DOKTER SPESIALIS', 'THORAX PA'], false, 'rajal');
    const result = evaluateBerkas({ pages: [page(3, ['sep']), page(2, ['rincian_biaya']), page(4, ['verifikasi_rajal'])] }, facts);
    expect(result.checks.map((c) => [c.docType, c.found])).toEqual([
      ['sep', true], ['verifikasi_rajal', true], ['rincian_biaya', true], ['radiologi', false],
    ]);
  });

  it('compresses page lists', () => {
    expect(pageList([34, 35, 36, 40, 1])).toBe('hal. 1, 34–36, 40');
    expect(pageList([])).toBe('');
  });
});
