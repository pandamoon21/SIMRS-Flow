import { describe, it, expect } from 'vitest';
import {
  parseDateFlexible,
  parseDateTimeFlexible,
  datePart,
  timePart,
  combineDateTime,
  normalizeUpdateTime,
  buildUpdateDateTime,
  extractDateFromNoTransaksi,
  resolveTargetDateTimeFromHistoryItem,
  iterDateParts,
  startOfDay,
  endOfDay,
  iterDatePartsFromDateTimes,
  secondsOverlapInDate,
  clampToleranceDays,
  expandTargetDates,
  daysBetweenDates,
} from './dates.js';

/** Naive-local wall clock readback, mirroring how the module formats. */
function wall(d: Date | null): string {
  if (!d) return 'null';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

describe('parseDateFlexible', () => {
  it('accepts every format the legacy script accepts', () => {
    const cases: Array<[unknown, string]> = [
      ['2026-03-10', '2026-03-10 00:00:00'], // %Y-%m-%d
      ['10-03-2026', '2026-03-10 00:00:00'], // %d-%m-%Y
      ['2026/03/10', '2026-03-10 00:00:00'], // %Y/%m/%d
      ['10-Mar-2026', '2026-03-10 00:00:00'], // %d-%b-%Y
      ['10 Mar 2026', '2026-03-10 00:00:00'], // %d %b %Y
      ['10 mar 2026', '2026-03-10 00:00:00'], // %b is case-insensitive
      ['2026-3-1', '2026-03-01 00:00:00'], // strptime tolerates unpadded d/m
      ['1-1-2026', '2026-01-01 00:00:00'],
    ];
    for (const [input, expected] of cases) {
      expect(wall(parseDateFlexible(input)), String(input)).toBe(expected);
    }
  });

  it('slices the input to each format width, so trailing time is ignored', () => {
    // The Python parses txt[:len(strftime(fmt))]; that is the only reason a
    // full timestamp is accepted by the bare %Y-%m-%d pattern.
    expect(wall(parseDateFlexible('2026-03-10 08:15:00'))).toBe('2026-03-10 00:00:00');
    expect(wall(parseDateFlexible('2026-03-10T08:15:00.123Z'))).toBe('2026-03-10 00:00:00');
    expect(wall(parseDateFlexible('10-Mar-2026 08:15:00'))).toBe('2026-03-10 00:00:00');
  });

  it('falls back to the datetime parser when no date format matches', () => {
    // %d-%m-%Y with a time cannot survive the 10-char slice, but the datetime
    // parser matches the whole string — and keeps the time.
    expect(wall(parseDateFlexible('1-1-2026 10:30:00'))).toBe('2026-01-01 10:30:00');
  });

  it('returns null for falsy and unparseable input', () => {
    for (const input of [null, undefined, '', 0, false, '   ', 'besok', 'garbage']) {
      expect(parseDateFlexible(input), String(input)).toBeNull();
    }
  });

  it('rejects impossible calendar dates like the datetime constructor does', () => {
    for (const input of ['2026-02-30', '2026-13-01', '2026-00-10', '31-04-2026', '2025-02-29']) {
      expect(parseDateFlexible(input), input).toBeNull();
    }
    expect(wall(parseDateFlexible('2024-02-29'))).toBe('2024-02-29 00:00:00'); // leap year
  });
});

describe('parseDateTimeFlexible', () => {
  it('accepts the eight whole-string formats', () => {
    const cases: Array<[string, string]> = [
      ['2026-03-10 08:15:30', '2026-03-10 08:15:30'],
      ['2026-03-10', '2026-03-10 00:00:00'],
      ['10 Mar 2026 08:15:30', '2026-03-10 08:15:30'],
      ['10 Mar 2026', '2026-03-10 00:00:00'],
      ['10-Mar-2026 08:15:30', '2026-03-10 08:15:30'],
      ['10-Mar-2026', '2026-03-10 00:00:00'],
      ['10-03-2026 08:15:30', '2026-03-10 08:15:30'],
      ['10-03-2026', '2026-03-10 00:00:00'],
      ['2026-03-10 8:5:3', '2026-03-10 08:05:03'], // %H/%M/%S take one or two digits
    ];
    for (const [input, expected] of cases) {
      expect(wall(parseDateTimeFlexible(input)), input).toBe(expected);
    }
  });

  it('retries the first 19 characters for over-long ISO timestamps', () => {
    expect(wall(parseDateTimeFlexible('2026-03-10 08:15:30.123456'))).toBe('2026-03-10 08:15:30');
    // Shorter than 19 chars gets no retry.
    expect(parseDateTimeFlexible('2026-03-10 08:15')).toBeNull();
    // The retry still needs a space separator, so a T-form ISO string fails.
    expect(parseDateTimeFlexible('2026-03-10T08:15:30')).toBeNull();
  });

  it('rejects out-of-range clock fields', () => {
    for (const input of ['2026-03-10 24:00:00', '2026-03-10 08:60:00', '2026-03-10 08:15:60']) {
      expect(parseDateTimeFlexible(input), input).toBeNull();
    }
  });
});

describe('datePart / timePart', () => {
  it('renders the date of anything date-ish', () => {
    expect(datePart('2026-03-10 08:15:30')).toBe('2026-03-10');
    expect(datePart('10-03-2026')).toBe('2026-03-10');
    expect(datePart('10 Mar 2026 08:15:30')).toBe('2026-03-10');
    expect(datePart('')).toBe('');
    expect(datePart(null)).toBe('');
  });

  it('keeps the legacy raw-prefix fallback for unparseable text', () => {
    // _date_part returns str(s).strip()[:10] rather than '' — mangled, not empty.
    expect(datePart('tidak diketahui')).toBe('tidak dike');
    expect(datePart('  abc  ')).toBe('abc');
  });

  it('renders the time, or the fallback when there is none', () => {
    expect(timePart('2026-03-10 08:15:30')).toBe('08:15:30');
    expect(timePart('2026-03-10')).toBe('00:00:00'); // date-only parses at midnight
    expect(timePart('garbage')).toBe('00:00:00');
    expect(timePart('garbage', '00:00:01')).toBe('00:00:01');
    expect(timePart(null, '12:00:00')).toBe('12:00:00');
  });
});

describe('combineDateTime / normalizeUpdateTime / buildUpdateDateTime', () => {
  it('combines, widening HH:MM and truncating to eight characters', () => {
    expect(combineDateTime('2026-03-10')).toBe('2026-03-10 00:00:00');
    expect(combineDateTime('10-03-2026', '08:15')).toBe('2026-03-10 08:15:00');
    expect(combineDateTime('2026-03-10', '08:15:30')).toBe('2026-03-10 08:15:30');
    expect(combineDateTime('2026-03-10', '08:15:30.999')).toBe('2026-03-10 08:15:30');
    expect(combineDateTime('2026-03-10', '')).toBe('2026-03-10 00:00:00');
  });

  it('collapses to empty when there is no date', () => {
    expect(combineDateTime('', '08:15:30')).toBe('');
  });

  it('replaces midnight with the fallback', () => {
    expect(normalizeUpdateTime('')).toBe('00:00:01');
    expect(normalizeUpdateTime('00:00:00')).toBe('00:00:01');
    expect(normalizeUpdateTime('00:00')).toBe('00:00:01'); // widened, then matched
    expect(normalizeUpdateTime('', '12:00:00')).toBe('12:00:00');
    expect(normalizeUpdateTime('08:15')).toBe('08:15:00');
    expect(normalizeUpdateTime('08:15:30.999')).toBe('08:15:30');
    expect(normalizeUpdateTime('00:00:01')).toBe('00:00:01');
  });

  it('stamps the injected clock onto the target date and ignores sourceDateTime', () => {
    const now = new Date(2026, 6, 26, 8, 15, 30);
    expect(buildUpdateDateTime('2026-03-10', '', '00:00:01', now)).toBe('2026-03-10 08:15:30');
    // The Python discards source_datetime entirely — prove the port does too.
    expect(buildUpdateDateTime('2026-03-10', '2020-01-01 23:59:59', '00:00:01', now)).toBe(
      '2026-03-10 08:15:30',
    );
    // Only an exactly-midnight clock falls through to the default time.
    const midnight = new Date(2026, 6, 26, 0, 0, 0);
    expect(buildUpdateDateTime('2026-03-10', '', '00:00:01', midnight)).toBe('2026-03-10 00:00:01');
    expect(buildUpdateDateTime('2026-03-10', '', '12:00:00', midnight)).toBe('2026-03-10 12:00:00');
  });
});

describe('extractDateFromNoTransaksi', () => {
  it('reads DDMMYY out of the second segment', () => {
    expect(extractDateFromNoTransaksi('03-100326-000123')).toBe('2026-03-10');
    expect(extractDateFromNoTransaksi('RJ-010125-9')).toBe('2025-01-01');
    expect(extractDateFromNoTransaksi('ab-311224-1')).toBe('2024-12-31'); // prefix is case-insensitive
    expect(extractDateFromNoTransaksi('  03-100326-000123  ')).toBe('2026-03-10');
  });

  it('returns empty when the id does not carry a date', () => {
    for (const input of ['', null, undefined, '03-1003-000123', '03-10032026-1', 'no dashes']) {
      expect(extractDateFromNoTransaksi(input), String(input)).toBe('');
    }
  });
});

describe('resolveTargetDateTimeFromHistoryItem', () => {
  it('prefers the row date, then tgl_order/tgl_masuk, then the transaction id', () => {
    expect(resolveTargetDateTimeFromHistoryItem({ tgl_transaksi: '10-03-2026 08:15:30' })).toBe(
      '2026-03-10 08:15:30',
    );
    expect(resolveTargetDateTimeFromHistoryItem({ tgl_order: '2026-03-10' })).toBe(
      '2026-03-10 00:00:00',
    );
    expect(resolveTargetDateTimeFromHistoryItem({ tgl_masuk: '2026-03-10 07:00:00' })).toBe(
      '2026-03-10 07:00:00',
    );
    expect(
      resolveTargetDateTimeFromHistoryItem({ tgl_transaksi: '', no_transaksi: '03-100326-000123' }),
    ).toBe('2026-03-10 00:00:01');
    expect(resolveTargetDateTimeFromHistoryItem({})).toBe('');
  });
});

describe('iterDateParts', () => {
  it('lists the inclusive range', () => {
    expect(iterDateParts('2026-03-10', '2026-03-13')).toEqual([
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
    ]);
    expect(iterDateParts('2026-03-10', '2026-03-10')).toEqual(['2026-03-10']);
  });

  it('swaps reversed ends and fills a missing one', () => {
    expect(iterDateParts('2026-03-13', '2026-03-10')).toEqual([
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
    ]);
    expect(iterDateParts('', '2026-03-10')).toEqual(['2026-03-10']);
    expect(iterDateParts('2026-03-10', '')).toEqual(['2026-03-10']);
    expect(iterDateParts('', '')).toEqual([]);
    expect(iterDateParts('garbage', 'juga garbage')).toEqual([]);
  });

  it('crosses month, year and DST boundaries by calendar day', () => {
    expect(iterDateParts('2026-02-27', '2026-03-02')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
    expect(iterDateParts('2024-02-28', '2024-03-01')).toEqual([
      '2024-02-28',
      '2024-02-29',
      '2024-03-01',
    ]);
    expect(iterDateParts('2025-12-30', '2026-01-02')).toEqual([
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
    ]);
    // Spans the European spring-forward Sunday; a naive +86400000ms step would
    // duplicate or skip a day in a DST timezone.
    expect(iterDateParts('2026-03-28', '2026-03-30')).toEqual([
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
    ]);
  });

  it('keeps the time-of-day comparison, which can drop the final day', () => {
    // Faithful quirk: the loop steps whole days from the start instant, so an
    // end whose clock is earlier than the start's is never reached.
    expect(iterDateParts('1-1-2026 10:30:00', '3-1-2026 09:00:00')).toEqual([
      '2026-01-01',
      '2026-01-02',
    ]);
  });
});

describe('startOfDay / endOfDay / iterDatePartsFromDateTimes', () => {
  it('clamps to the day without mutating the input', () => {
    const source = new Date(2026, 2, 10, 8, 15, 30, 123);
    expect(wall(startOfDay(source))).toBe('2026-03-10 00:00:00');
    expect(startOfDay(source).getMilliseconds()).toBe(0);
    expect(wall(endOfDay(source))).toBe('2026-03-10 23:59:59');
    expect(endOfDay(source).getMilliseconds()).toBe(0);
    expect(wall(source)).toBe('2026-03-10 08:15:30');
  });

  it('lists days between two instants', () => {
    const start = new Date(2026, 2, 10, 22, 0, 0);
    const end = new Date(2026, 2, 12, 3, 0, 0);
    expect(iterDatePartsFromDateTimes(start, end)).toEqual([
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
    ]);
    expect(iterDatePartsFromDateTimes(null, end)).toEqual(['2026-03-12']);
    expect(iterDatePartsFromDateTimes(start, null)).toEqual(['2026-03-10']);
    expect(iterDatePartsFromDateTimes(null, null)).toEqual([]);
  });
});

describe('secondsOverlapInDate', () => {
  it('scores a fully covered day as 86399, not 86400', () => {
    // The day is clamped to 23:59:59, so one second is always missing. The
    // room-day allocator is calibrated to that.
    const start = new Date(2026, 2, 9, 12, 0, 0);
    const end = new Date(2026, 2, 12, 12, 0, 0);
    expect(secondsOverlapInDate(start, end, '2026-03-10')).toBe(86_399);
  });

  it('scores partial days from the clamped edges', () => {
    const start = new Date(2026, 2, 10, 22, 0, 0);
    const end = new Date(2026, 2, 11, 2, 30, 0);
    expect(secondsOverlapInDate(start, end, '2026-03-10')).toBe(7_199); // 22:00 → 23:59:59
    expect(secondsOverlapInDate(start, end, '2026-03-11')).toBe(9_000); // 00:00 → 02:30
  });

  it('returns 0 for no overlap, touching edges or an unreadable date', () => {
    const start = new Date(2026, 2, 10, 8, 0, 0);
    const end = new Date(2026, 2, 10, 9, 0, 0);
    expect(secondsOverlapInDate(start, end, '2026-03-11')).toBe(0);
    expect(secondsOverlapInDate(start, end, '2026-03-09')).toBe(0);
    expect(secondsOverlapInDate(start, start, '2026-03-10')).toBe(0); // zero-length
    expect(secondsOverlapInDate(end, start, '2026-03-10')).toBe(0); // reversed
    expect(secondsOverlapInDate(start, end, 'garbage')).toBe(0);
    expect(secondsOverlapInDate(start, end, '')).toBe(0);
  });
});

describe('clampToleranceDays', () => {
  it('forces the window into 0…7', () => {
    const cases: Array<[unknown, number]> = [
      [0, 0],
      [3, 3],
      [7, 7],
      [8, 7],
      [99, 7],
      [-1, 0],
      [-99, 0],
      ['3', 3],
      [' 5 ', 5],
      [3.9, 3], // int() truncates toward zero
      [-0.5, 0],
      ['abc', 0], // Python raises here; the port fails closed to the tightest window
      ['', 0],
      [null, 0],
      [undefined, 0],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
      ['3.9', 0], // int("3.9") raises in Python too
    ];
    for (const [input, expected] of cases) {
      expect(clampToleranceDays(input), String(input)).toBe(expected);
    }
  });
});

describe('expandTargetDates', () => {
  it('sorts the dates and skips rows with no readable date', () => {
    expect(
      expandTargetDates([
        { tgl_transaksi: '2026-03-12 08:00:00' },
        { tgl_order: '10-03-2026' },
        { tgl_masuk: '11 Mar 2026' },
        { tgl_transaksi: 'garbage' },
        {},
      ]),
    ).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
  });

  it('repeats a date once per detail line', () => {
    const rows = [{ tgl_transaksi: '2026-03-11' }, { tgl_transaksi: '2026-03-10' }];
    expect(expandTargetDates(rows, (row) => (row['tgl_transaksi'] === '2026-03-10' ? 3 : 1))).toEqual([
      '2026-03-10',
      '2026-03-10',
      '2026-03-10',
      '2026-03-11',
    ]);
  });

  it('degrades a bad detail count to one', () => {
    const rows = [{ tgl_transaksi: '2026-03-10' }];
    expect(expandTargetDates(rows, () => 0)).toEqual(['2026-03-10']);
    expect(expandTargetDates(rows, () => -5)).toEqual(['2026-03-10']);
    expect(expandTargetDates(rows, () => 2.7)).toEqual(['2026-03-10', '2026-03-10']);
    expect(expandTargetDates(rows, () => Number.NaN)).toEqual(['2026-03-10']);
    expect(
      expandTargetDates(rows, () => {
        throw new Error('detail fetch failed');
      }),
    ).toEqual(['2026-03-10']);
  });
});

describe('daysBetweenDates', () => {
  it('measures whole days regardless of order, format or DST', () => {
    expect(daysBetweenDates('2026-03-10', '2026-03-10')).toBe(0);
    expect(daysBetweenDates('2026-03-10', '2026-03-13')).toBe(3);
    expect(daysBetweenDates('2026-03-13', '2026-03-10')).toBe(3);
    expect(daysBetweenDates('10-03-2026', '2026-03-13')).toBe(3);
    expect(daysBetweenDates('2026-03-10 23:59:00', '2026-03-11 00:01:00')).toBe(1);
    expect(daysBetweenDates('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysBetweenDates('2026-03-28', '2026-03-30')).toBe(2); // DST weekend
  });

  it('fails closed when either side is unreadable', () => {
    expect(daysBetweenDates('garbage', '2026-03-10')).toBe(Number.POSITIVE_INFINITY);
    expect(daysBetweenDates('2026-03-10', '')).toBe(Number.POSITIVE_INFINITY);
  });
});
