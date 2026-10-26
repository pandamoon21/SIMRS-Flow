/**
 * Which claim document a bundle page is. Pure: text in, ids out.
 *
 * Text pages: only *title lines* count — short lines near the top with no
 * digits once a form code ("RM 12.1", "FORM. 9.1") is stripped — and a pattern
 * must start the line. That keeps continuation pages out: a charge row such as
 * "EKG ELEKTRODA DEWASA 3 7 400" or "TINDAKAN PROSEDUR USG" is not a title.
 * Penunjang result pages (elektromedik/radiologi) carry no title at all; their
 * table "NAMA PEMERIKSAAN | HASIL PEMERIKSAAN" names the exam in its first row.
 *
 * Patterns come from a sample of 25 live ranap bundles (619 pages, 2026-10-20;
 * docs/berkas-ocr.md). OCR'd photo pages use a looser match over all their text.
 */

export type DocType =
  | 'sep'
  | 'resume'
  | 'rincian_biaya'
  | 'rincian_obat'
  | 'lab'
  | 'radiologi'
  | 'ekg'
  | 'kamar_penuh'
  | 'rencana_inap'
  | 'ket_dirawat'
  | 'ket_emergency'
  | 'ket_kematian'
  | 'persetujuan'
  | 'triase'
  | 'laporan_operasi'
  | 'laporan_anestesi'
  | 'crossmatch'
  | 'laporan_polisi'
  | 'observasi'
  | 'verifikasi_rajal'
  | 'eklaim';

export const DOC_LABELS: Record<DocType, string> = {
  sep: 'SEP (Surat Eligibilitas Peserta)',
  resume: 'Ringkasan pulang / resume medis',
  rincian_biaya: 'Perincian biaya',
  rincian_obat: 'Perincian obat',
  lab: 'Hasil laboratorium',
  radiologi: 'Hasil radiologi (rontgen/USG)',
  ekg: 'Hasil EKG',
  kamar_penuh: 'Surat keterangan kamar penuh',
  rencana_inap: 'Surat rencana inap',
  ket_dirawat: 'Surat keterangan dirawat',
  ket_emergency: 'Surat keterangan emergency',
  ket_kematian: 'Surat keterangan kematian',
  persetujuan: 'Persetujuan rawat inap / tindakan',
  triase: 'Triase',
  laporan_operasi: 'Laporan operasi / tindakan',
  laporan_anestesi: 'Laporan anestesi',
  crossmatch: 'Formulir bank darah / crossmatch',
  laporan_polisi: 'Laporan polisi',
  observasi: 'Lembar observasi',
  verifikasi_rajal: 'Lembar verifikasi rawat jalan',
  eklaim: 'Lembar e-klaim (INA-CBG)',
};

/** Anchored at the start of a title line; first match names the page. */
const TITLE_PATTERNS: ReadonlyArray<[DocType, RegExp]> = [
  ['sep', /^SURAT ELEG[IL]+BILITAS PESERTA/],
  ['kamar_penuh', /^SURAT KETERANGAN (KAMAR|RUANG(AN)?|TEMPAT TIDUR) (SUDAH )?PENUH|^(KAMAR|RUANG(AN)?) PENUH/],
  ['resume', /^(RINGKASAN PULANG|RINGKASAN MEDIS|RESUME (MEDIS|PASIEN|PULANG))/],
  ['rincian_biaya', /^P?ERINCIAN BIAYA|^RINCIAN BIAYA/],
  ['rincian_obat', /^P?ERINCIAN OBAT|^RINCIAN OBAT/],
  ['lab', /^HASIL (PEMERIKSAAN )?(LABORATORIUM|HISTOPATOLOGI)|^LABORATORIUM PATOLOGI/],
  ['radiologi', /^(HASIL (PEMERIKSAAN )?)?(RADIOLOGI|RONTGEN|THORA[XK]|USG|ULTRASONOGRAFI|CT ?SCAN)\b|^E[KX]SPERTISE/],
  ['ekg', /^(HASIL )?(PEMERIKSAAN )?(EKG|ECG|ELE[CK]TROKARDIOGRA)/],
  ['rencana_inap', /^SURAT (RENCANA|PERINTAH) (RAWAT )?INAP/],
  ['ket_kematian', /^SURAT KETERANGAN KEMATIAN/],
  ['ket_emergency', /^SURAT KETERANGAN (EMERGENCY|GAWAT DARURAT)/],
  ['ket_dirawat', /^SURAT KETERANGAN (DIRAWAT|RAWAT INAP)/],
  ['persetujuan', /^(FORM )?PERSETUJUAN (RAWAT INAP|UMUM|TINDAKAN)|^GENERAL CONSENT/],
  ['triase', /^TRIA(GE|SE)\b/],
  ['laporan_operasi', /^LAPORAN (OPERASI|TINDAKAN)/],
  ['laporan_anestesi', /^LAPORAN ANESTESI/],
  // Rajal bundles (sample of 8 live, 2026-10-20): e-klaim sheet, perincian,
  // SEP, this sheet, perincian obat, then penunjang/photos.
  ['verifikasi_rajal', /^LEMBAR VERIFIKASI RAWAT JALAN/],
  ['eklaim', /^KEMENTERIAN KESEHATAN REPUBLIK INDONESIA/],
];

/** Exam names in a penunjang result table row → document type. */
const EXAM_PATTERNS: ReadonlyArray<[DocType, RegExp]> = [
  ['ekg', /\b(EKG|ECG|ELE[CK]TROKARDIOGRA)/],
  ['radiologi', /\b(USG|RONTGEN|RO\b|THORA[XK]|FOTO|CT ?SCAN|X ?RAY|BNO|MSCT|MRI)/],
];

/** Photos (OCR text, any position, first match only). */
const OCR_PATTERNS: ReadonlyArray<[DocType, RegExp]> = [
  ['crossmatch', /CROSS ?MATCH|BANK DARAH|PERMINTAAN DARAH/],
  ['laporan_polisi', /LAPORAN POLISI|KEPOLISIAN/],
  ['observasi', /LEMBAR OBSERVASI/],
  ['kamar_penuh', /(KAMAR|RUANG(AN)?|TEMPAT TIDUR) (SUDAH )?PENUH/],
  ['ekg', /\b(EKG|ECG)\b|ELE[CK]TROKARDIOGRA/],
  ['radiologi', /RADIOLOG|RONTGEN|THORA[XK]|E[KX]SPERTISE/],
  ['sep', /SURAT ELEG[IL]+BILITAS PESERTA/],
  ['resume', /RINGKASAN PULANG|RESUME MEDIS/],
  ['lab', /HASIL PEMERIKSAAN (LABORATORIUM|HISTOPATOLOGI)/],
];

/** Leading lines that may hold a title. */
export const TITLE_SCAN_LINES = 25;
const MAX_TITLE_WORDS = 8;

const normalise = (text: string) => text.toUpperCase().replace(/[^A-Z0-9 \n]/g, ' ').replace(/[ \t]+/g, ' ');
const linesOf = (text: string) => normalise(text).split('\n').map((line) => line.trim()).filter(Boolean);

/** Title-like lines: near the top, short, no digits once a form code is stripped. */
export function titleLines(text: string): string[] {
  return linesOf(text)
    .slice(0, TITLE_SCAN_LINES)
    .map((line) => line.replace(/^(RM|FORM)\s*[\d ]+\s*(FORM\s+)?/, ''))
    .filter((line) => line && !/\d/.test(line) && line.split(' ').length <= MAX_TITLE_WORDS);
}

/** First rows of a "NAMA PEMERIKSAAN | HASIL PEMERIKSAAN" table, if the page has one. */
export function examRows(text: string): string[] {
  const lines = linesOf(text);
  const head = lines.findIndex((line) => line.includes('NAMA PEMERIKSAAN') && line.includes('HASIL'));
  if (head < 0) return [];
  return lines.slice(head + 1, head + 6).filter((line) => /^\d+ /.test(line)).map((line) => line.replace(/^\d+ /, ''));
}

/** Document types of a page with a text layer (usually one). */
export function classifyTextPage(text: string): DocType[] {
  const found: DocType[] = [];
  for (const line of titleLines(text)) {
    const hit = TITLE_PATTERNS.find(([, pattern]) => pattern.test(line));
    if (hit && !found.includes(hit[0])) found.push(hit[0]);
  }
  // A bill continuation page lists category lines ("RADIOLOGI", "LABORATORIUM
  // PATOLOGI KLINIK") that look like titles; with "SUB TOTAL" on the page it can
  // only be a perincian, whose own title sits on the first page.
  if (/\bSUB TOTAL\b/.test(normalise(text)) && !(found[0] === 'rincian_biaya' || found[0] === 'rincian_obat')) return [];
  if (found.length > 0) return found.slice(0, 1);
  for (const row of examRows(text)) {
    const hit = EXAM_PATTERNS.find(([, pattern]) => pattern.test(row));
    if (hit && !found.includes(hit[0])) found.push(hit[0]);
  }
  return found;
}

/** A photo page after OCR: first type found anywhere in the text (titles of forms sit in side columns). */
export function classifyOcrText(text: string): DocType[] {
  const flat = normalise(text);
  const hit = OCR_PATTERNS.find(([, pattern]) => pattern.test(flat));
  return hit ? [hit[0]] : [];
}
