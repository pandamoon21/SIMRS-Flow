import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function corsOriginsFromEnv(value = env('ORCHESTRATOR_CORS_ORIGINS')): string[] {
  return (value ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Strip credentials, query and hash: Settings shows where SIMRS is, never how to sign in to it. */
export function safeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

type Nets = Record<string, ReadonlyArray<{ family: string | number; internal: boolean; address: string }> | undefined>;

/** This host's non-loopback IPv4 addresses (the ones other LAN PCs can reach). */
export function lanAddresses(nets: Nets): string[] {
  return Object.values(nets)
    .flatMap((list) => list ?? [])
    .filter((net) => (net.family === 'IPv4' || net.family === 4) && !net.internal)
    .map((net) => net.address);
}

/** URLs an operator types to open the app: loopback-only binds are reachable from this PC alone. */
export function accessUrls(listenHost: string, port: number, nets: Nets): { loopbackOnly: boolean; urls: string[] } {
  if (['127.0.0.1', 'localhost', '::1'].includes(listenHost)) return { loopbackOnly: true, urls: [`http://127.0.0.1:${port}/`] };
  const hosts = ['0.0.0.0', '::'].includes(listenHost) ? lanAddresses(nets) : [listenHost];
  return { loopbackOnly: false, urls: hosts.map((host) => `http://${host}:${port}/`) };
}

/** Files and bytes directly in `dir` (optionally only `ext`); undefined when the folder does not exist yet. */
export function dirStats(dir: string, ext?: string): { files: number; bytes: number } | undefined {
  try {
    let files = 0;
    let bytes = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || (ext && !entry.name.endsWith(ext))) continue;
      files += 1;
      bytes += statSync(join(dir, entry.name)).size;
    }
    return { files, bytes };
  } catch {
    return undefined;
  }
}

/** Size and last write of one file; undefined when it does not exist yet. */
export function fileStats(file: string): { bytes: number; modifiedAt: string } | undefined {
  try {
    const stat = statSync(file);
    return stat.isFile() ? { bytes: stat.size, modifiedAt: stat.mtime.toISOString() } : undefined;
  } catch {
    return undefined;
  }
}
