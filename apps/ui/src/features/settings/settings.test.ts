import { describe, expect, it } from 'vitest';
import { statusChecks, storageRows, uptimeLabel } from './SettingsHealth.js';
import type { NaikKelasStatus } from '../naikKelas/naikKelas.js';

const NOW = Date.parse('2026-10-27T06:00:00.000Z');
const naik = (fetchedAt: string, extra: Partial<NaikKelasStatus> = {}): NaikKelasStatus =>
  ({ source: 's', defaultSource: 's', refreshHours: 12, refreshing: false, snapshot: { rows: [{}, {}], fetchedAt, fetchedBy: 'op', missingColumns: [] }, ...extra }) as never;

describe('Settings storage table', () => {
  it('says plainly what is lost on restart and what is on disk', () => {
    const memory = storageRows({ ok: true, ts: 't', auditPersistent: false }, undefined);
    expect(memory[0]).toMatchObject({ persistent: false, content: 'hilang saat orchestrator restart', env: ['AUDIT_LEDGER_DIR'] });
    expect(memory.find((row) => row.name === 'Catatan tim')).toMatchObject({ persistent: false, content: 'hilang saat restart' });

    const disk = storageRows(
      { ok: true, ts: 't', auditPersistent: true, storage: { auditDir: 'D:/audit', audit: { files: 3, bytes: 2048 }, naikKelasFile: 'D:/iur.json', notesFile: 'D:/notes.json', notes: { bytes: 300, modifiedAt: 't' } } },
      naik('2026-10-20T01:00:00.000Z'),
    );
    expect(disk[0]).toMatchObject({ persistent: true, location: 'D:/audit', content: '3 run · 2.0 KB' });
    expect(disk[2]?.content).toMatch(/^2 baris · diambil /);
    expect(disk[2]?.note).toContain('12 jam');
    expect(disk.find((row) => row.name === 'Catatan tim')).toMatchObject({ persistent: true, location: 'D:/notes.json', content: 'tersimpan · 300 B' });
  });

  it('reads uptime in whole units', () => {
    expect(uptimeLabel(30)).toBe('baru saja');
    expect(uptimeLabel(3 * 3600 + 12 * 60)).toBe('3 jam 12 menit');
    expect(uptimeLabel(2 * 86400 + 4 * 3600)).toBe('2 hari 4 jam');
  });
});

describe('Settings status checks', () => {
  const healthy = {
    ok: true, ts: 't', auditPersistent: true, storage: { audit: { files: 5, bytes: 10 } },
    host: { name: 'PC-SERVER', platform: 'win32/x64', node: 'v22', startedAt: '2026-10-27T05:00:00.000Z', uptimeSec: 3600 },
    policy: { criticalApprovals: 1 as const, autoApproveWrites: true, qaLogin: false },
  };
  const tone = (checks: ReturnType<typeof statusChecks>) => Object.fromEntries(checks.map((c) => [c.id, c.tone]));

  it('is all OK when everything a run needs works', () => {
    const checks = statusChecks({ health: healthy, simrs: { configured: true, reachable: true, status: 302, ms: 80, host: 'simrs.example.local', checkedAt: 't' }, operator: 'op1', naik: naik('2026-10-27T02:00:00.000Z'), now: NOW });
    expect(tone(checks)).toEqual({ app: 'ok', simrs: 'ok', login: 'ok', history: 'ok', iur: 'ok', write: 'ok' });
    expect(checks.find((c) => c.id === 'iur')?.value).toBe('2 baris · 4 jam lalu');
  });

  it('says what to do when something is wrong', () => {
    const checks = statusChecks({
      health: { ...healthy, auditPersistent: false, policy: { ...healthy.policy, qaLogin: true } },
      simrs: { configured: true, reachable: false, host: 'simrs.example.local', error: 'tidak menjawab dalam 5 detik', checkedAt: 't' },
      naik: naik('2026-10-20T00:00:00.000Z'),
      now: NOW,
    });
    expect(tone(checks)).toMatchObject({ simrs: 'bad', history: 'bad', iur: 'warn', write: 'bad', login: 'wait' });
    expect(checks.find((c) => c.id === 'simrs')?.hint).toContain('tidak menjawab dalam 5 detik');
    expect(checks.find((c) => c.id === 'history')?.hint).toContain('AUDIT_LEDGER_DIR');
    expect(checks.find((c) => c.id === 'write')?.hint).toContain('QA_AUTH_TOKEN');
  });

  it('flags a slow SIMRS and an unreachable app', () => {
    expect(statusChecks({ health: healthy, simrs: { configured: true, reachable: true, ms: 3500, host: 'h', checkedAt: 't' }, now: NOW }).find((c) => c.id === 'simrs')).toMatchObject({ tone: 'warn', value: 'lambat · 3500 ms' });
    expect(statusChecks({ healthError: 'fetch failed', now: NOW })[0]).toMatchObject({ id: 'app', tone: 'bad' });
  });
});

describe('naik kelas error text', () => {
  it('turns the server codes into operator words', async () => {
    const { naikKelasErrorText } = await import('../naikKelas/naikKelas.js');
    expect(naikKelasErrorText('source_must_be_google_sheets_url')).toBe('link sumber bukan link Google Sheets');
    expect(naikKelasErrorText('sheet_http_404')).toBe('Google Sheets menjawab HTTP 404');
    expect(naikKelasErrorText('sheet_not_public')).toContain('Siapa saja yang memiliki link');
  });
});
