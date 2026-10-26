import { describe, it, expect } from 'vitest';

import type { LegacyRow } from './types.js';
import {
  biayaEntryIsOnDischarge,
  buildBiayaObatDetailEntry,
  buildHistoryObatEntry,
  buildObatDetailSignature,
  historyObatMatchesRoom,
  matchHistoryObatToBiayaRows,
  normalizeObatDetailName,
  previewObatDetailNames,
  previewUniqueLogItems,
  sortHistoryObatEntries,
} from './obat.js';

/** Two tablets, Rp 50.000 in total — the discharge prescription. */
const ORDER_DETAIL: readonly LegacyRow[] = [
  { nama_obat: 'AMOXICILLIN 500MG TAB', qty: '10', jumlah: '30000' },
  { nama_obat: 'PARACETAMOL 500MG TAB', qty: '10', jumlah: '20000' },
];

/** Same drugs, different quantities, Rp 55.000 — a loose match only. */
const LOOSE_DETAIL: readonly LegacyRow[] = [
  { nama_obat: 'AMOXICILLIN 500MG TAB', qty: '5', jumlah: '30000' },
  { nama_obat: 'PARACETAMOL 500MG TAB', qty: '5', jumlah: '25000' },
];

/** Half the names overlap — below the 80% coverage floor. */
const HALF_OVERLAP_DETAIL: readonly LegacyRow[] = [
  { nama_obat: 'AMOXICILLIN 500MG TAB', qty: '10', jumlah: '30000' },
  { nama_obat: 'CETIRIZINE 10MG TAB', qty: '10', jumlah: '20000' },
];

/** Same names, but Rp 50.000 apart — beyond the loose money tolerance. */
const PRICE_MISMATCH_DETAIL: readonly LegacyRow[] = [
  { nama_obat: 'AMOXICILLIN 500MG TAB', qty: '5', jumlah: '60000' },
  { nama_obat: 'PARACETAMOL 500MG TAB', qty: '5', jumlah: '40000' },
];

/** A pharmacy-order entry, shaped like `_get_history_obat_entries` builds it. */
function historyEntry(
  noOrder: string,
  orderDate: string,
  detailRows: readonly LegacyRow[],
  ruang = 'MULTAZAM',
): LegacyRow {
  const signature = buildObatDetailSignature(detailRows);
  return {
    no_order: noOrder,
    tgl_order: `${orderDate} 09:00:00`,
    order_date: orderDate,
    ruang,
    detail_rows: [...detailRows],
    ...signature,
    is_take_home: signature.take_home_names.length > 0,
    detail_names: previewObatDetailNames(detailRows, 20),
  };
}

/** A `BIAYA OBAT` charge row plus its (hoisted) detail rows. */
function biayaEntry(
  noReferensi: string,
  tglJam: string,
  detailRows: readonly LegacyRow[],
): LegacyRow {
  return buildBiayaObatDetailEntry(
    { nama_tindakan: 'BIAYA OBAT', no_referensi: noReferensi, tgl_jam: tglJam, urut_tindakan: '4' },
    detailRows,
  );
}

describe('normalizeObatDetailName', () => {
  it('folds case, punctuation and repeated spaces', () => {
    expect(normalizeObatDetailName('Amoxicillin  500mg/5ml (Syr)')).toBe('AMOXICILLIN 500MG 5ML SYR');
    expect(normalizeObatDetailName('  ')).toBe('');
    expect(normalizeObatDetailName(null)).toBe('');
  });
});

describe('buildObatDetailSignature', () => {
  it('sorts both fingerprints and totals the money', () => {
    const signature = buildObatDetailSignature([...ORDER_DETAIL].reverse());
    expect(signature.signature_exact).toBe(
      'AMOXICILLIN 500MG TAB::10||PARACETAMOL 500MG TAB::10',
    );
    expect(signature.signature_names).toBe('AMOXICILLIN 500MG TAB||PARACETAMOL 500MG TAB');
    expect(signature.item_count).toBe(2);
    expect(signature.total_amount).toBe(50000);
    expect(signature.take_home_names).toEqual([
      'PARACETAMOL 500MG TAB',
      'AMOXICILLIN 500MG TAB',
    ]);
  });

  it('recomputes a missing jumlah as harga * qty and floors qty at 1', () => {
    const signature = buildObatDetailSignature([
      { nama_obat: 'CETIRIZINE 10MG TAB', qty: '3', harga: '1.000' },
      { nama_tindakan: 'VITAMIN C TAB', qty: '0', harga: '500' },
    ]);
    expect(signature.total_amount).toBe(3500);
    expect(signature.signature_exact).toBe('CETIRIZINE 10MG TAB::3||VITAMIN C TAB::1');
  });

  it('ignores rows with no readable name and never marks a consumable take-home', () => {
    const signature = buildObatDetailSignature([{ qty: '1' }, { nama_obat: 'INFUS SET RL' }]);
    expect(signature.item_count).toBe(1);
    expect(signature.take_home_names).toEqual([]);
  });
});

describe('previewObatDetailNames', () => {
  it('de-duplicates on the normalized key and keeps the original spelling', () => {
    expect(
      previewObatDetailNames([
        { nama_obat: 'Paracetamol 500mg Tab' },
        { nama_obat: 'PARACETAMOL  500MG   TAB' },
        { nama_tindakan: 'Amoxicillin 500mg Tab' },
        { nama_obat: '   ' },
      ]),
    ).toEqual(['Paracetamol 500mg Tab', 'Amoxicillin 500mg Tab']);
  });

  it('honours the limit', () => {
    expect(previewObatDetailNames(ORDER_DETAIL, 1)).toEqual(['AMOXICILLIN 500MG TAB']);
  });
});

describe('previewUniqueLogItems', () => {
  it('caps the list and appends the overflow suffix', () => {
    expect(previewUniqueLogItems(['a', 'a', 'b', 'c'], 2)).toEqual(['a', 'b', '+1 item lagi']);
    expect(previewUniqueLogItems(['a', 'a', 'b', 'c'], 2, false)).toEqual(['a', 'b']);
    expect(previewUniqueLogItems(['a', 'b'], 2)).toEqual(['a', 'b']);
    expect(previewUniqueLogItems([null, '', '   '])).toEqual([]);
  });
});

describe('buildBiayaObatDetailEntry', () => {
  it('mines the reference date out of no_referensi and previews the details', () => {
    const entry = biayaEntry('16-120326-000123', '2026-03-12 11:30:00', ORDER_DETAIL);
    expect(entry['no_referensi']).toBe('16-120326-000123');
    expect(entry['reference_date']).toBe('2026-03-12');
    expect(entry['current_date']).toBe('2026-03-12');
    expect(entry['is_take_home']).toBe(true);
    expect(entry['detail_names']).toEqual(['AMOXICILLIN 500MG TAB', 'PARACETAMOL 500MG TAB']);
    expect((entry['row'] as LegacyRow)['urut_tindakan']).toBe('4');
  });

  it('tolerates a charge row with no reference and no details', () => {
    const entry = buildBiayaObatDetailEntry({ nama_tindakan: 'BIAYA OBAT' });
    expect(entry['reference_date']).toBe('');
    expect(entry['current_date']).toBe('');
    expect(entry['item_count']).toBe(0);
    expect(entry['is_take_home']).toBe(false);
  });
});

describe('matchHistoryObatToBiayaRows', () => {
  it('matches a pharmacy order to the billing row with the same fingerprint', () => {
    const history = historyEntry('ORD-1', '2026-03-12', ORDER_DETAIL);
    const biaya = biayaEntry('16-120326-000123', '2026-03-12 11:30:00', ORDER_DETAIL);
    const matches = matchHistoryObatToBiayaRows([history], [biaya]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.mode).toBe('exact');
    expect(matches[0]?.history['no_order']).toBe('ORD-1');
    expect(matches[0]?.biaya['no_referensi']).toBe('16-120326-000123');
    expect(matches[0]?.score).toBe(0);
  });

  it('falls back to a loose match on different quantities', () => {
    const history = historyEntry('ORD-1', '2026-03-12', ORDER_DETAIL);
    const biaya = biayaEntry('16-120326-000123', '2026-03-12 11:30:00', LOOSE_DETAIL);
    const matches = matchHistoryObatToBiayaRows([history], [biaya]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.mode).toBe('loose');
  });

  it('does NOT match a near miss: half the names, or a price too far apart', () => {
    const history = historyEntry('ORD-1', '2026-03-12', ORDER_DETAIL);
    expect(
      matchHistoryObatToBiayaRows(
        [history],
        [biayaEntry('16-120326-000123', '2026-03-12 11:30:00', HALF_OVERLAP_DETAIL)],
      ),
    ).toEqual([]);
    expect(
      matchHistoryObatToBiayaRows(
        [history],
        [biayaEntry('16-120326-000124', '2026-03-12 11:30:00', PRICE_MISMATCH_DETAIL)],
      ),
    ).toEqual([]);
  });

  it('spends the exact pass first, leaving nothing for a loose candidate', () => {
    const history = historyEntry('ORD-1', '2026-03-12', ORDER_DETAIL);
    const looseBiaya = biayaEntry('16-110326-000100', '2026-03-11 10:00:00', LOOSE_DETAIL);
    const exactBiaya = biayaEntry('16-120326-000123', '2026-03-12 11:30:00', ORDER_DETAIL);
    const matches = matchHistoryObatToBiayaRows([history], [looseBiaya, exactBiaya]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.mode).toBe('exact');
    expect(matches[0]?.biaya['no_referensi']).toBe('16-120326-000123');
  });

  it('prefers the order closest to the reference date and consumes it once', () => {
    const near = historyEntry('ORD-NEAR', '2026-03-12', ORDER_DETAIL);
    const far = historyEntry('ORD-FAR', '2026-03-14', ORDER_DETAIL);
    const biaya = biayaEntry('16-120326-000123', '2026-03-12 11:30:00', ORDER_DETAIL);
    const matches = matchHistoryObatToBiayaRows([far, near], [biaya]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.history['no_order']).toBe('ORD-NEAR');
  });

  it('leaves the caller entries untouched (no _matched stamping)', () => {
    const history = historyEntry('ORD-1', '2026-03-12', ORDER_DETAIL);
    const biaya = biayaEntry('16-120326-000123', '2026-03-12 11:30:00', ORDER_DETAIL);
    matchHistoryObatToBiayaRows([history], [biaya]);
    expect(biaya['_matched']).toBeUndefined();
  });

  it('returns nothing for empty input', () => {
    expect(matchHistoryObatToBiayaRows([], [])).toEqual([]);
  });
});

describe('buildHistoryObatEntry / sortHistoryObatEntries', () => {
  it('folds the getdetail_historyobat lines into the order entry', () => {
    const entry = buildHistoryObatEntry(
      { no_order: 'OB-1', tgl_order: '2026-03-12 09:00:00', ruang: 'MULTAZAM', nama_pasien: 'IGNORED' },
      ORDER_DETAIL,
    );
    expect(entry['no_order']).toBe('OB-1');
    expect(entry['order_date']).toBe('2026-03-12');
    expect(entry['ruang']).toBe('MULTAZAM');
    expect(entry['signature_exact']).toBe('AMOXICILLIN 500MG TAB::10||PARACETAMOL 500MG TAB::10');
    expect(entry['item_count']).toBe(2);
    expect(entry['total_amount']).toBe(50000);
    expect(entry['is_take_home']).toBe(true);
    expect(entry['detail_names']).toEqual(['AMOXICILLIN 500MG TAB', 'PARACETAMOL 500MG TAB']);
  });

  it('is inert without the detail read — which is why the fetch is not optional', () => {
    // No detail rows means no fingerprint at all: the exact pass has nothing to
    // compare and the loose pass has an empty name set, so `_compatible` refuses
    // every pairing. That was the whole of the name-only behaviour.
    const bare = buildHistoryObatEntry({ no_order: 'OB-1', tgl_order: '2026-03-12 09:00:00' });
    expect(bare['signature_exact']).toBe('');
    expect(bare['signature_names']).toBe('');
    expect(bare['is_take_home']).toBe(false);
    const biaya = biayaEntry('16-120326-000123', '2026-03-12 11:30:00', ORDER_DETAIL);
    expect(matchHistoryObatToBiayaRows([bare], [biaya])).toEqual([]);
  });

  it('orders oldest first, breaking ties on no_order, unparseable dates first', () => {
    const entries = [
      buildHistoryObatEntry({ no_order: 'OB-3', tgl_order: '2026-03-13 09:00:00' }),
      buildHistoryObatEntry({ no_order: 'OB-2', tgl_order: '2026-03-12 09:00:00' }),
      buildHistoryObatEntry({ no_order: 'OB-1', tgl_order: '2026-03-12 09:00:00' }),
      buildHistoryObatEntry({ no_order: 'OB-0', tgl_order: '' }),
    ];
    expect(sortHistoryObatEntries(entries).map((item) => item['no_order'])).toEqual([
      'OB-0',
      'OB-1',
      'OB-2',
      'OB-3',
    ]);
  });

  it('picks the order the item/qty fingerprint names, not the nearest date', () => {
    // Two orders, same two drugs, different quantities. The charge row's
    // `no_referensi` encodes 2026-03-13, so `_score`'s first component
    // (ref_delta) prefers OB-LATER — and a names-only comparison cannot tell
    // them apart, so that is the one it would take. The exact pass runs first
    // and pairs the charge with the order whose quantities actually match.
    const correct = buildHistoryObatEntry(
      { no_order: 'OB-EXACT', tgl_order: '2026-03-12 09:00:00' },
      ORDER_DETAIL,
    );
    const decoy = buildHistoryObatEntry(
      { no_order: 'OB-LATER', tgl_order: '2026-03-13 09:00:00' },
      LOOSE_DETAIL,
    );
    const biaya = biayaEntry('16-130326-000123', '2026-03-13 11:30:00', ORDER_DETAIL);

    const matches = matchHistoryObatToBiayaRows([decoy, correct], [biaya]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.mode).toBe('exact');
    expect(matches[0]?.history['no_order']).toBe('OB-EXACT');

    // Proof the ranking really did favour the decoy: strip both fingerprints
    // (the name-only shape) and nothing matches at all.
    const nameOnly = [decoy, correct].map((entry) => ({
      no_order: entry['no_order'],
      order_date: entry['order_date'],
      tgl_order: entry['tgl_order'],
    }));
    expect(matchHistoryObatToBiayaRows(nameOnly, [biaya])).toEqual([]);
  });
});

describe('historyObatMatchesRoom', () => {
  it('matches on substrings either way and on a room segment', () => {
    expect(historyObatMatchesRoom({ ruang: 'MULTAZAM' }, 'MULTAZAM / KELAS 3')).toBe(true);
    expect(historyObatMatchesRoom({ ruang: 'AL KAUTSAR / SCN' }, 'SCN')).toBe(true);
    expect(historyObatMatchesRoom({ ruang: 'SCN' }, 'AL KAUTSAR / SCN')).toBe(true);
  });

  it('rejects a different room and any blank side', () => {
    expect(historyObatMatchesRoom({ ruang: 'IBS' }, 'MULTAZAM / KELAS 3')).toBe(false);
    expect(historyObatMatchesRoom({ ruang: '' }, 'MULTAZAM / KELAS 3')).toBe(false);
    expect(historyObatMatchesRoom({ ruang: 'MULTAZAM' }, '')).toBe(false);
  });
});

describe('biayaEntryIsOnDischarge', () => {
  const entry = biayaEntry('16-120326-000123', '2026-03-11 11:30:00', ORDER_DETAIL);

  it('matches on the charge timestamp or on the reference date', () => {
    expect(biayaEntryIsOnDischarge(entry, '2026-03-11')).toBe(true); // current_date
    expect(biayaEntryIsOnDischarge(entry, '2026-03-12')).toBe(true); // reference_date
    expect(biayaEntryIsOnDischarge(entry, '2026-03-13')).toBe(false);
  });

  it('never matches without a discharge date', () => {
    expect(biayaEntryIsOnDischarge(entry, '')).toBe(false);
  });
});
