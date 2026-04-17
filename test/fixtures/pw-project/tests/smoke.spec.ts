import { test, expect } from '@playwright/test';

test('smoke: button is visible', { tag: ['@smoke'] }, async ({ page }) => {
  await page.setContent('<button>Click me</button>');
  await expect(page.locator('button')).toBeVisible();
});
