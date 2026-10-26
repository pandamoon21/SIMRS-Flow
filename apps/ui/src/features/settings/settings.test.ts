import { describe, expect, it } from 'vitest';
import { storageRows, uptimeLabel } from './SettingsHealth.js';

describe('Settings storage table', () => {
  it('says plainly what is lost on restart and what is on disk', () => {
    const memory = storageRows({ ok: true, ts: 't', auditPersistent: false }, undefined);
    expect(memory[0]).toMatchObject({ persistent: false, content: 'hilang saat orchestrator restart', env: ['AUDIT_LEDGER_DIR'] });
    expect(memory.find((row) => row.name.startsWith('Rekapitulasi'))?.content).toContain('DEMO');

    const disk = storageRows(
      { ok: true, ts: 't', auditPersistent: true, storage: { auditDir: 'D:/audit', audit: { files: 3, bytes: 2048 }, naikKelasFile: 'D:/iur.json' } },
      { source: 's', defaultSource: 's', refreshHours: 12, refreshing: false, snapshot: { rows: [{}, {}] as never, fetchedAt: '2026-10-20T01:00:00.000Z', fetchedBy: 'op', missingColumns: [] } as never },
    );
    expect(disk[0]).toMatchObject({ persistent: true, location: 'D:/audit', content: '3 run · 2.0 KB' });
    expect(disk[2]?.content).toMatch(/^2 baris · diambil /);
    expect(disk[2]?.note).toContain('12 jam');
    const berkas = storageRows({ ok: true, ts: 't', storage: { berkasCacheDir: 'D:/berkas', berkas: { files: 4, bytes: 4096 } } }, undefined);
    expect(berkas.find((row) => row.env.includes('BERKAS_CACHE_DIR'))).toMatchObject({ persistent: true, location: 'D:/berkas', content: '4 file · 4.0 KB' });
  });

  it('reads uptime in whole units', () => {
    expect(uptimeLabel(30)).toBe('baru saja');
    expect(uptimeLabel(3 * 3600 + 12 * 60)).toBe('3 jam 12 menit');
    expect(uptimeLabel(2 * 86400 + 4 * 3600)).toBe('2 hari 4 jam');
  });
});
