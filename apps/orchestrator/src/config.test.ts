import { describe, expect, it } from 'vitest';
import { accessUrls, corsOriginsFromEnv, lanAddresses, safeUrl } from './config.js';

describe('orchestrator config', () => {
  it('allows both localhost names for the dev UI by default', () => {
    expect(corsOriginsFromEnv(undefined)).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
  });

  it('shows a SIMRS URL without credentials, query or hash', () => {
    expect(safeUrl('http://user:pw@simrs.example.local/evoMedis/index.php?sess=abc#x')).toBe('http://simrs.example.local/evoMedis/index.php');
    expect(safeUrl('not a url')).toBeUndefined();
    expect(safeUrl(undefined)).toBeUndefined();
  });

  it('lists LAN access URLs only when the bind is not loopback', () => {
    const nets = {
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }, { family: 'IPv6', internal: false, address: 'fe80::1' }],
      wifi: [{ family: 4, internal: false, address: '10.0.0.5' }],
    };
    expect(lanAddresses(nets)).toEqual(['192.168.1.20', '10.0.0.5']);
    expect(accessUrls('127.0.0.1', 4500, nets)).toEqual({ loopbackOnly: true, urls: ['http://127.0.0.1:4500/'] });
    expect(accessUrls('0.0.0.0', 4500, nets)).toEqual({ loopbackOnly: false, urls: ['http://192.168.1.20:4500/', 'http://10.0.0.5:4500/'] });
    expect(accessUrls('192.168.1.20', 80, nets).urls).toEqual(['http://192.168.1.20:80/']);
  });
});

describe('storage stats for Settings', () => {
  it('counts files and bytes, and reports a missing location as undefined', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { dirStats, fileStats } = await import('./config.js');
    const dir = mkdtempSync(join(tmpdir(), 'simrs-flow-stats-'));
    try {
      writeFileSync(join(dir, 'a.jsonl'), '12345');
      writeFileSync(join(dir, 'b.jsonl'), '1');
      writeFileSync(join(dir, 'note.txt'), 'xx');
      expect(dirStats(dir, '.jsonl')).toEqual({ files: 2, bytes: 6 });
      expect(dirStats(dir)).toEqual({ files: 3, bytes: 8 });
      expect(fileStats(join(dir, 'a.jsonl'))?.bytes).toBe(5);
      expect(dirStats(join(dir, 'missing'))).toBeUndefined();
      expect(fileStats(join(dir, 'missing.json'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
