import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

const file = (rel: string) => fileURLToPath(new URL(`./packages/${rel}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@simrs-flow/audit-ledger/redaction': file('audit-ledger/src/redaction.ts'),
      '@simrs-flow/workflow-core': pkg('workflow-core'),
      '@simrs-flow/audit-ledger': pkg('audit-ledger'),
      '@simrs-flow/berkas/evaluate': file('berkas/src/evaluate.ts'),
      '@simrs-flow/berkas': pkg('berkas'),
      '@simrs-flow/evomedis-client/endpoints': file('evomedis-client/src/endpoints.ts'),
      '@simrs-flow/evomedis-client': pkg('evomedis-client'),
      // Subpaths before their package: an alias also matches `<key>/...`.
      '@simrs-flow/domain-ranap/contract': file('domain-ranap/src/contract.ts'),
      '@simrs-flow/domain-ranap': pkg('domain-ranap'),
      '@simrs-flow/domain-rajal/contract': file('domain-rajal/src/contract.ts'),
      '@simrs-flow/domain-rajal': pkg('domain-rajal'),
      '@simrs-flow/api-contract': pkg('api-contract'),
      '@simrs-flow/test-fixtures': pkg('test-fixtures'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/**/src/**', 'apps/**/src/**'],
      exclude: ['**/*.test.ts', '**/dist/**'],
    },
  },
});
