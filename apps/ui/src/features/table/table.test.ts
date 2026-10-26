import { describe, expect, it } from 'vitest';
import { pageWindow, parsePageInput } from './paging.js';
import { buildPrintHtml, printFontPt } from './print.js';
import { matchSuggestions } from './SuggestInput.js';
import { glyphStateOf, SPINNERS, trackProgressOf, TRAVELLERS, variantOf } from '../run/RunStatusGlyph.js';

describe('table paging', () => {
  it('clamps the page and computes the row window', () => {
    expect(pageWindow(53, 25, 3)).toEqual({ page: 3, pageCount: 3, start: 50, end: 53 });
    expect(pageWindow(53, 25, 9)).toMatchObject({ page: 3 });
    expect(pageWindow(0, 25, 1)).toEqual({ page: 1, pageCount: 1, start: 0, end: 0 });
    expect(pageWindow(53, 'all', 2)).toEqual({ page: 1, pageCount: 1, start: 0, end: 53 });
  });

  it('parses the jump-to-page box', () => {
    expect(parsePageInput('2', 5)).toBe(2);
    expect(parsePageInput('99', 5)).toBe(5);
    expect(parsePageInput('0', 5)).toBe(1);
    expect(parsePageInput('x', 5)).toBeUndefined();
  });
});

describe('suggestion matching', () => {
  it('matches by contains, prefix hits first, and drops the exact value already typed', () => {
    const all = ['Bedah Onkologi', 'onkologi', 'interna', 'bedah onko'];
    expect(matchSuggestions(all, 'onko')).toEqual(['onkologi', 'Bedah Onkologi', 'bedah onko']);
    expect(matchSuggestions(all, 'interna')).toEqual([]);
    expect(matchSuggestions(all, '', 2)).toEqual(['Bedah Onkologi', 'onkologi']);
  });
});

describe('run glyph state', () => {
  it('maps run status to idle / running / paused / done / failed / stopped', () => {
    expect(glyphStateOf(undefined, undefined)).toBe('idle');
    // A reloaded definition keeps the last run id at `created`: it must not walk (spin) forever.
    expect(glyphStateOf('r1', 'created')).toBe('idle');
    expect(glyphStateOf('r1', 'running')).toBe('running');
    expect(glyphStateOf('r1', 'paused')).toBe('paused');
    expect(glyphStateOf('r1', 'completed')).toBe('done');
    expect(glyphStateOf('r1', 'failed')).toBe('failed');
    expect(glyphStateOf('r1', 'cancelled')).toBe('stopped');
  });

  it('places the walker by finished steps, at the finish once the run completes', () => {
    const nodes = { a: { status: 'success' }, b: { status: 'running' }, c: { status: 'pending' }, d: { status: 'skipped' } } as never;
    expect(trackProgressOf(undefined)).toBe(0);
    expect(trackProgressOf({ status: 'running', nodes })).toBe(0.5);
    expect(trackProgressOf({ status: 'completed', nodes })).toBe(1);
  });
});

describe('print view', () => {
  it('scales the font with sheet width and column count', () => {
    expect(printFontPt(277, 8)).toBeGreaterThan(printFontPt(190, 8));
    expect(printFontPt(277, 40)).toBe(6);
    expect(printFontPt(277, 2)).toBe(10);
  });

  it('leaves paper and orientation to the print dialog, drops hidden columns and escapes cells', () => {
    const html = buildPrintHtml(
      { title: 'Iur naik kelas', columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', numeric: true }], rows: [{ a: '<x>', b: '1' }] },
      { hidden: ['b'] },
      '19/10/2026',
    );
    // A page size locks the dialog's Layout/Paper choices (picking one there broke the print).
    expect(html).not.toMatch(/@page\s*\{[^}]*\bsize\s*:/);
    expect(html).toContain('@page { margin:');
    expect(html).toContain('@media print and (orientation: portrait)');
    expect(html).toContain('&lt;x&gt;');
    expect(html).not.toContain('<th class="n">B</th>');
  });

  it('reaches every spinner and traveller across seeds', () => {
    const seen = Array.from({ length: 400 }, (_, i) => variantOf(i / 400));
    expect(new Set(seen.map((v) => v.spinner)).size).toBe(SPINNERS.length);
    expect(new Set(seen.map((v) => v.traveller)).size).toBe(TRAVELLERS.length);
    expect(variantOf(0.999999)).toEqual(variantOf(0.999999));
  });
});
