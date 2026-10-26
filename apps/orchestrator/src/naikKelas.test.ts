import { describe, expect, it } from 'vitest';
import { MemoryLedger } from '@simrs-flow/audit-ledger';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NaikKelasStore, normalizeKelasRanap, parseCsv, parseNaikKelasSheet, sheetCsvExportUrl } from './naikKelas.js';
import { buildServer } from './server.js';

const HEADER =
  'Timestamp,Nomer Rekam Medis,Nama Pasien,Hak Kelas,Kelas Ranap,Total Billing,Tindakan,Kasus,Dokter,KODE GROUPING,Klaim BPJS,Klaim BPJS Kelas I,Klaim BPJS Kelas II,IUR,Tanggal Kepulangan Pasien';

describe('naik kelas sheet', () => {
  it('only turns Google Sheets links into the fixed CSV export URL', () => {
    expect(sheetCsvExportUrl('https://docs.google.com/spreadsheets/d/1ExampleSheetId_0123456789abcdefXYZ/edit?gid=1520156696#gid=1520156696'))
      .toBe('https://docs.google.com/spreadsheets/d/1ExampleSheetId_0123456789abcdefXYZ/export?format=csv&gid=1520156696');
    expect(sheetCsvExportUrl('https://docs.google.com/spreadsheets/d/1ExampleSheetId_0123456789abcdefXYZ/edit#gid=7'))
      .toMatch(/gid=7$/);
    expect(sheetCsvExportUrl('http://docs.google.com/spreadsheets/d/1ExampleSheetId_0123456789abcdefXYZ/edit')).toBeUndefined();
    expect(sheetCsvExportUrl('https://evil.example/spreadsheets/d/1ExampleSheetId_0123456789abcdefXYZ')).toBeUndefined();
    expect(sheetCsvExportUrl('http://simrs.example.local/x')).toBeUndefined();
    expect(sheetCsvExportUrl('not a url')).toBeUndefined();
  });

  it('parses quoted CSV fields with commas, quotes and newlines', () => {
    expect(parseCsv('a,"b,c","d ""e""","f\ng"\r\n1,2,3,4')).toEqual([['a', 'b,c', 'd "e"', 'f\ng'], ['1', '2', '3', '4']]);
  });

  it('types the form rows, skips blank rows, and reports missing columns', () => {
    const csv = `${HEADER}\n,,,,,,,,,,,,,,\n19/10/2026 14:10:41,0-11-22-33 ,"PASIEN, NY",I,VIP,Rp6.908.402,ct scan,bedah onko,dr. J,\tG-4-23-I,Klaim BPJS,Rp3.710.200,Rp0,Rp2.782.650,16/10/2026`;
    const { rows, missingColumns } = parseNaikKelasSheet(csv);
    expect(missingColumns).toEqual([]);
    expect(rows).toEqual([{
      timestamp: '2026-10-19T14:10:41', noRm: '0-11-22-33', nama: 'PASIEN, NY', hakKelas: 'I', kelasRanap: 'VIP',
      totalBilling: 6908402, tindakan: 'ct scan', kasus: 'bedah onko', dokter: 'dr. J', kodeGrouping: 'G-4-23-I',
      klaimBpjs: 'Klaim BPJS', klaimKelas1: 3710200, klaimKelas2: 0, iur: 2782650, tglPulang: '2026-10-16',
    }]);
    expect(parseNaikKelasSheet('Timestamp,Nomer Rekam Medis\n').missingColumns).toContain('iur');
    // DELUXE is the VIP class; PRESIDENT SUITE is VVIP.
    expect(['VIP', 'DELUXE', 'deluxe', 'President Suite', 'I', '1'].map(normalizeKelasRanap)).toEqual(['VIP', 'VIP', 'VIP', 'VVIP', 'I', 'I']);
  });
});

describe('naik kelas store + routes', () => {
  const SHEET = 'https://docs.google.com/spreadsheets/d/1ExampleSheetId_0123456789abcdefXYZ/edit#gid=0';
  const CSV = `${HEADER}
19/10/2026 14:10:41,0-11-22-33,A,I,VIP,Rp1,x,y,dr,G,Klaim BPJS,Rp1,Rp0,Rp2,16/10/2026`;
  const fakeFetch = (body: string, status = 200) => {
    const urls: string[] = [];
    const fn = (async (url: string) => { urls.push(url); return new Response(body, { status }); }) as typeof fetch;
    return { urls, fn };
  };

  it('serves the stored snapshot and re-reads only when stale', async () => {
    let now = new Date('2026-10-19T08:00:00Z');
    const f = fakeFetch(CSV);
    const store = new NaikKelasStore({ defaultSource: SHEET, fetch: f.fn, now: () => now, refreshHours: 24 });
    expect(store.isStale()).toBe(true);
    await store.refresh('op');
    expect(store.isStale()).toBe(false);
    now = new Date('2026-10-20T07:59:00Z');
    expect(store.isStale()).toBe(false);
    now = new Date('2026-10-20T08:00:00Z');
    expect(store.isStale()).toBe(true);
    expect(store.status()).toMatchObject({ nextAutoRefreshAt: '2026-10-20T08:00:00.000Z', snapshot: { fetchedBy: 'op' } });
    expect(f.urls).toHaveLength(1);
  });

  it('persists the snapshot and source across restarts, and keeps the old snapshot when a read fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'naik-'));
    const file = join(dir, 'naik-kelas.json');
    const ok = new NaikKelasStore({ defaultSource: SHEET, file, fetch: fakeFetch(CSV).fn });
    await ok.refresh('op');
    const reloaded = new NaikKelasStore({ defaultSource: SHEET, file, fetch: fakeFetch('<html>sign in</html>').fn });
    expect(reloaded.status().snapshot?.rows).toHaveLength(1);
    await expect(reloaded.refresh('auto')).rejects.toThrow('sheet_not_public');
    expect(reloaded.status()).toMatchObject({ lastError: { message: 'sheet_not_public' }, snapshot: { fetchedBy: 'op' } });
    await expect(reloaded.setSource('http://simrs.example.local/x', 'op')).rejects.toThrow('source_must_be_google_sheets_url');
  });

  it('routes: reads need an operator, refresh/source need a bearer, bad sources never fetch', async () => {
    const f = fakeFetch(CSV);
    const app = buildServer({ ledger: new MemoryLedger(), qaAuth: { token: 't', operator: 'op' }, naikKelas: new NaikKelasStore({ defaultSource: SHEET, fetch: f.fn }) });
    const AUTH = { authorization: 'Bearer t' };
    expect((await app.inject({ url: '/api/naik-kelas' })).statusCode).toBe(401);
    expect(f.urls).toHaveLength(0);
    const first = await app.inject({ url: '/api/naik-kelas', headers: AUTH });
    expect(first.json().snapshot.rows).toHaveLength(1);
    await app.inject({ url: '/api/naik-kelas', headers: AUTH });
    expect(f.urls).toHaveLength(1); // second view served from the snapshot
    expect((await app.inject({ method: 'POST', url: '/api/naik-kelas/refresh' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/naik-kelas/refresh', headers: AUTH })).statusCode).toBe(200);
    expect(f.urls).toHaveLength(2);
    const bad = await app.inject({ method: 'POST', url: '/api/naik-kelas/source', headers: AUTH, payload: { source: 'http://simrs.example.local/secret' } });
    expect(bad.statusCode).toBe(400);
    expect(f.urls.every((u) => u.startsWith('https://docs.google.com/spreadsheets/d/'))).toBe(true);
  });
});
