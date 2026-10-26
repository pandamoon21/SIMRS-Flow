import { describe, it, expect } from 'vitest';
import {
  safeInt,
  parseCurrencyInt,
  normalizeTextKey,
  compactTextKey,
  parseJsonText,
  sortedRows,
  rowLogLabel,
  rowsLogLabel,
  normalizeNoRmInput,
  normalizeTanggalInput,
  stripHtmlText,
  extractTextareaText,
} from './scalars.js';

describe('safeInt', () => {
  it('reads whole numbers and falls back on everything else', () => {
    const cases: Array<[unknown, number]> = [
      ['42', 42],
      ['  42  ', 42],
      ['+42', 42],
      ['-7', -7],
      ['007', 7],
      [42, 42],
      [0, 0],
      // int(str(value)) raises for all of these, so the fallback wins.
      ['3.5', 0],
      [3.5, 0],
      ['1e3', 0],
      ['0x10', 0],
      ['1 000', 0],
      ['', 0],
      ['abc', 0],
      [null, 0],
      [undefined, 0],
      [true, 0],
    ];
    for (const [input, expected] of cases) {
      expect(safeInt(input), String(input)).toBe(expected);
    }
  });

  it('honours a custom fallback', () => {
    expect(safeInt('abc', 5)).toBe(5);
    expect(safeInt(null, -1)).toBe(-1);
    expect(safeInt('12', -1)).toBe(12);
  });
});

describe('parseCurrencyInt', () => {
  it('drops every non-digit, which flattens Indonesian money strings', () => {
    const cases: Array<[unknown, number]> = [
      ['Rp 1.250.000', 1_250_000],
      ['Rp1.250.000', 1_250_000],
      ['1,250,000', 1_250_000],
      ['1 250 000', 1_250_000],
      ['150000', 150_000],
      [150_000, 150_000],
      ['Rp 0', 0],
      ['-5.000', -5_000],
      ['Rp -5.000', -5_000],
      // A decimal tail is *not* respected — it becomes trailing digits. This is
      // the legacy behaviour and the callers compare equally-mangled values.
      ['Rp 1.250.000,00', 125_000_000],
      ['1250,50', 125_050],
    ];
    for (const [input, expected] of cases) {
      expect(parseCurrencyInt(input), String(input)).toBe(expected);
    }
  });

  it('falls back when nothing integer-shaped survives', () => {
    for (const input of ['', '-', 'Rp -', 'Rp.', 'abc', '1-2', '5-', '--5', null, undefined, 0, false]) {
      expect(parseCurrencyInt(input), String(input)).toBe(0);
    }
    expect(parseCurrencyInt('', -1)).toBe(-1);
    expect(parseCurrencyInt('1-2', -1)).toBe(-1);
  });
});

describe('normalizeTextKey / compactTextKey', () => {
  it('flattens punctuation to spaces, or removes it entirely', () => {
    const cases: Array<[unknown, string, string]> = [
      ['R. INAP/VIP-1', 'R INAP VIP 1', 'RINAPVIP1'],
      ['by. ny. siti', 'BY NY SITI', 'BYNYSITI'],
      ['  multazam   platinum  ', 'MULTAZAM PLATINUM', 'MULTAZAMPLATINUM'],
      ['ISO-1/A', 'ISO 1 A', 'ISO1A'],
      ['', '', ''],
      [null, '', ''],
      [0, '', ''],
      ['---', '', ''],
    ];
    for (const [input, spaced, compact] of cases) {
      expect(normalizeTextKey(input), String(input)).toBe(spaced);
      expect(compactTextKey(input), String(input)).toBe(compact);
    }
  });
});

describe('parseJsonText', () => {
  it('passes decoded values through untouched', () => {
    const object = { a: 1 };
    const list = [1, 2];
    expect(parseJsonText(object)).toBe(object);
    expect(parseJsonText(list)).toBe(list);
  });

  it('decodes JSON text and falls back on anything else', () => {
    expect(parseJsonText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonText('  [1,2]  ')).toEqual([1, 2]);
    expect(parseJsonText('123')).toBe(123);
    expect(parseJsonText('null')).toBeNull();
    expect(parseJsonText('not json')).toBeUndefined();
    expect(parseJsonText('')).toBeUndefined();
    expect(parseJsonText(null)).toBeUndefined();
    const fallback = { fallback: true };
    expect(parseJsonText('not json', fallback)).toBe(fallback);
    expect(parseJsonText('', fallback)).toBe(fallback);
  });
});

describe('sortedRows', () => {
  it('sorts by date, then urut_tindakan numerically, then input order', () => {
    const rows = [
      { id: 'c', tgl_jam: '2026-03-11 08:00:00', urut_tindakan: '1' },
      { id: 'b', tgl_jam: '2026-03-10 08:00:00', urut_tindakan: '10' },
      { id: 'a', tgl_jam: '2026-03-10 08:00:00', urut_tindakan: '2' },
      { id: 'undated-1', tgl_jam: 'garbage', urut_tindakan: '1' },
      { id: 'undated-2', urut_tindakan: '1' },
      { id: 'd', tgl_transaksi: '2026-03-12', urut_tindakan: '1' },
    ];
    expect(sortedRows(rows).map((row) => row.id)).toEqual([
      'a', // 10 Mar, urut 2 — numeric compare, so 2 precedes 10
      'b', // 10 Mar, urut 10
      'c', // 11 Mar
      'd', // 12 Mar via the tgl_transaksi fallback key
      'undated-1', // datetime.max sentinel: undated rows land last…
      'undated-2', // …in their original order
    ]);
  });

  it('does not mutate the input array', () => {
    const rows = [{ tgl_jam: '2026-03-11' }, { tgl_jam: '2026-03-10' }];
    const sorted = sortedRows(rows);
    expect(rows[0]!['tgl_jam']).toBe('2026-03-11');
    expect(sorted[0]!['tgl_jam']).toBe('2026-03-10');
    expect(sorted).not.toBe(rows);
  });
});

describe('rowLogLabel / rowsLogLabel', () => {
  it('renders a row, dashing out whatever is missing', () => {
    expect(
      rowLogLabel({
        nama_tindakan: 'VISITE DOKTER SPESIALIS',
        kd_tindakan: 'V01',
        urut_tindakan: '3',
        tgl_jam: '2026-03-10 08:00:00',
        qty: 1,
        harga: 150_000,
      }),
    ).toBe(
      'nama=VISITE DOKTER SPESIALIS, kd=V01, urut=3, tgl=2026-03-10 08:00:00, qty=1, harga=150000',
    );
    expect(rowLogLabel({})).toBe('nama=-, kd=-, urut=-, tgl=-, qty=-, harga=-');
    expect(rowLogLabel({ tgl_transaksi: '2026-03-10' })).toContain('tgl=2026-03-10');
  });

  it('joins rows with a double pipe', () => {
    const label = rowsLogLabel([{ kd_tindakan: 'A' }, { kd_tindakan: 'B' }]);
    expect(label.split(' || ')).toHaveLength(2);
    expect(label).toContain('kd=A');
    expect(label).toContain('kd=B');
    expect(rowsLogLabel([])).toBe('');
  });
});

describe('normalizeNoRmInput', () => {
  it('canonicalises every accepted separator to 0-12-34-56', () => {
    for (const input of [
      '123456',
      '0123456',
      '0-12-34-56',
      '0 12 34 56',
      '0.12.34.56',
      '0/12/34/56',
      '  0123456  ',
    ]) {
      expect(normalizeNoRmInput(input), input).toBe('0-12-34-56');
    }
  });

  it('throws the operator-facing message for each rejection', () => {
    for (const input of ['', '   ', null, undefined]) {
      expect(() => normalizeNoRmInput(input), String(input)).toThrow('No RM kosong.');
    }
    for (const input of ['RM123456', '123456a', 'abc']) {
      expect(() => normalizeNoRmInput(input), input).toThrow(
        'No RM tidak boleh mengandung huruf. Gunakan format seperti 123456, 0123456, atau 0-12-34-56.',
      );
    }
    for (const input of ['123456#', '0_12_34_56', '123456*']) {
      expect(() => normalizeNoRmInput(input), input).toThrow(
        'Format No RM tidak dikenali. Gunakan angka dengan separator umum seperti spasi, strip, slash, atau titik.',
      );
    }
    for (const input of ['12345', '1123456', '01234561', '0']) {
      expect(() => normalizeNoRmInput(input), input).toThrow(
        'No RM harus berisi 6 digit tanpa nol depan atau 7 digit dengan nol depan. Contoh valid: 123456, 0123456, 0-12-34-56.',
      );
    }
  });
});

describe('normalizeTanggalInput', () => {
  it('reads eight bare digits as YYYYMMDD first, DDMMYYYY second', () => {
    expect(normalizeTanggalInput('20260310')).toBe('2026-03-10');
    expect(normalizeTanggalInput('10032026')).toBe('2026-03-10');
    // Day-first also wins for a US-style separator form — a faithful quirk.
    expect(normalizeTanggalInput('03-10-2026')).toBe('2026-10-03');
  });

  it('accepts the flexible formats', () => {
    const cases: Array<[string, string]> = [
      ['2026-03-10', '2026-03-10'],
      ['10-03-2026', '2026-03-10'],
      ['10/03/2026', '2026-03-10'],
      ['2026/03/10', '2026-03-10'],
      ['10 Mar 2026', '2026-03-10'],
      ['10-Mar-2026', '2026-03-10'],
      ['2026-03-10 08:15:00', '2026-03-10'],
      ['  2026-3-1  ', '2026-03-01'],
    ];
    for (const [input, expected] of cases) {
      expect(normalizeTanggalInput(input), input).toBe(expected);
    }
  });

  it('throws for empty and unrecognised dates', () => {
    for (const input of ['', '   ', null, undefined]) {
      expect(() => normalizeTanggalInput(input), String(input)).toThrow('Tanggal kosong.');
    }
    for (const input of ['besok', '2026-13-40', '31-02-2026', '99999999', '2026']) {
      expect(() => normalizeTanggalInput(input), input).toThrow(
        'Format tanggal tidak dikenali. Gunakan format seperti 2026-03-10, 20260310, atau 10-03-2026.',
      );
    }
  });
});

describe('stripHtmlText', () => {
  it('drops script/style bodies, then tags, then collapses whitespace', () => {
    expect(stripHtmlText('<script>var a = 1;</script><b>Hi</b>')).toBe('Hi');
    expect(stripHtmlText('<STYLE type="text/css">.a{color:red}</STYLE>Teks')).toBe('Teks');
    expect(stripHtmlText('<p>Baris 1</p>\n\n<p>Baris  2</p>')).toBe('Baris 1 Baris 2');
    expect(stripHtmlText('<td>a</td><td>b</td>')).toBe('a b');
    expect(stripHtmlText(null)).toBe('');
    expect(stripHtmlText('')).toBe('');
  });

  it('resolves entities after stripping tags, so encoded markup survives', () => {
    expect(stripHtmlText('&lt;b&gt;bold&lt;/b&gt;')).toBe('<b>bold</b>');
    expect(stripHtmlText('Suhu 37&deg;C &amp; nadi 80')).toBe('Suhu 37°C & nadi 80');
    expect(stripHtmlText('a&nbsp;b')).toBe('a b');
    expect(stripHtmlText('&#65;&#x42;')).toBe('AB');
    // Unknown entities are left verbatim rather than mangled.
    expect(stripHtmlText('&tidakada;')).toBe('&tidakada;');
  });
});

describe('extractTextareaText', () => {
  it('returns the first textarea, or the one with the requested id', () => {
    const html = '<textarea id="a" rows="4">Isi A</textarea><textarea id=\'b\'>Isi B</textarea>';
    expect(extractTextareaText(html)).toBe('Isi A');
    expect(extractTextareaText(html, 'a')).toBe('Isi A');
    expect(extractTextareaText(html, 'b')).toBe('Isi B');
  });

  it('strips markup inside the textarea', () => {
    expect(extractTextareaText('<textarea id="cppt">Isi <b>CPPT</b>\n  baris 2</textarea>', 'cppt')).toBe(
      'Isi CPPT baris 2',
    );
  });

  it('escapes the id, so it is matched literally', () => {
    const html = '<textarea id="a.b[0]">X</textarea>';
    expect(extractTextareaText(html, 'a.b[0]')).toBe('X');
    expect(extractTextareaText(html, 'axbx0x')).toBe('');
  });

  it('returns empty when there is no such textarea', () => {
    expect(extractTextareaText('')).toBe('');
    expect(extractTextareaText('<div>no textarea</div>')).toBe('');
    expect(extractTextareaText('<textarea id="a">Isi A</textarea>', 'zz')).toBe('');
    expect(extractTextareaText('<textarea id="a"></textarea>', 'a')).toBe('');
  });
});
