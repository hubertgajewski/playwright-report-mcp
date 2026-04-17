import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  reporter: [['json', { outputFile: 'test-results/results.json' }]],
  use: {
    headless: true,
    launchOptions: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
