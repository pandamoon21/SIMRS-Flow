import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

const file = (rel: string) => fileURLToPath(new URL(`../../packages/${rel}`, import.meta.url));

// Stamp the login screen with the root package version + branch + short SHA so a
// deployed bundle is identifiable at a glance.
const rootPkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
const gitStamp = (() => {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    const sha = execSync('git rev-parse --short HEAD').toString().trim();
    return `${branch}@${sha}`;
  } catch {
    return 'unknown';
  }
})();

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_BUILD_STAMP': JSON.stringify(`v${rootPkg.version ?? '0.0.0'} · ${gitStamp}`),
  },
  resolve: {
    alias: {
      '@simrs-flow/audit-ledger/redaction': file('audit-ledger/src/redaction.ts'),
      '@simrs-flow/workflow-core': pkg('workflow-core'),
      // Pure required-document rules, reached through the domain packages.
      '@simrs-flow/berkas/evaluate': file('berkas/src/evaluate.ts'),
      // Node-only (OCR); aliased for parity, never imported by the UI bundle.
      '@simrs-flow/berkas': pkg('berkas'),
      '@simrs-flow/test-fixtures': pkg('test-fixtures'),
      '@simrs-flow/evomedis-client': pkg('evomedis-client'),
      '@simrs-flow/domain-ranap': pkg('domain-ranap'),
      '@simrs-flow/domain-rajal': pkg('domain-rajal'),
    },
  },
  build: {
    rollupOptions: {
      // Our workspace packages are pure modules reached through barrel index
      // files; without this a top-level `new Map(...)` kept the whole rajal
      // executor (server-only logic) in the browser bundle.
      treeshake: { moduleSideEffects: (id) => !/[\\/]packages[\\/][^\\/]+[\\/]src[\\/].+\.ts$/.test(id) },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Dev UI reachable from other LAN PCs too; it proxies /api to this host.
    host: true,
    proxy: {
      // QA_API_PROXY: a second stack (e.g. QA on :4511) beside the operator's own.
      '/api': process.env.QA_API_PROXY ?? 'http://127.0.0.1:4500',
    },
  },
});
