import { defineConfig, configDefaults } from 'vitest/config';
import { fileURLToPath } from 'url';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    exclude: [...configDefaults.exclude, '**/dist/**'],
    env: {
      PW_DIR: fileURLToPath(new URL('./test/fixtures', import.meta.url)),
    },
  },
});
