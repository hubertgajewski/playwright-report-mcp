import { defineConfig, configDefaults } from 'vitest/config';
import { fileURLToPath } from 'url';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    exclude: [
      ...configDefaults.exclude,
      '**/dist/**',
      'test/e2e.test.ts',
      'test/fixtures/pw-project/**',
    ],
    env: {
      // Default allowlist (unset → ".") authorizes only the repo root, which
      // vitest uses as its cwd. Pin results.json to the fixture setup.ts writes
      // so tools read it regardless of the per-call workingDirectory.
      PW_RESULTS_FILE: fileURLToPath(
        new URL('./test/fixtures/test-results/results.json', import.meta.url)
      ),
    },
    coverage: {
      provider: 'v8',
      include: ['index.ts'],
      reporter: ['text', 'json', 'json-summary', 'html'],
      thresholds: {
        branches: 85,
      },
    },
  },
});
