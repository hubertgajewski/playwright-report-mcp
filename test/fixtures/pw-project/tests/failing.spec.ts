import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

test('deliberately fails with attachment', async ({ page }, testInfo) => {
  await page.setContent('<p>test page</p>');
  mkdirSync(testInfo.outputDir, { recursive: true });
  const filePath = join(testInfo.outputDir, 'error-details.txt');
  writeFileSync(filePath, 'This test deliberately fails for MCP e2e testing.\n');
  await testInfo.attach('error-details', { path: filePath, contentType: 'text/plain' });
  expect(1).toBe(2);
});
