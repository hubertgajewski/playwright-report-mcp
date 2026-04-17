import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e.test.ts'],
    // Each e2e test can take up to 3 minutes (one full Playwright browser run)
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Run in a forked process to avoid stdio interference with the MCP subprocess
    pool: 'forks',
  },
});
