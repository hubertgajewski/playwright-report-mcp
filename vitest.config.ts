import { defineConfig, configDefaults } from 'vitest/config';
import { fileURLToPath } from 'url';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    exclude: [...configDefaults.exclude, '**/dist/**', 'test/e2e.test.ts', 'test/fixtures/pw-project/**'],
    env: {
      PW_DIR: fileURLToPath(new URL('./test/fixtures', import.meta.url)),
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
