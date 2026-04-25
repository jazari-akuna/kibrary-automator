import { test } from '@playwright/test';
import * as fs from 'node:fs';

test('storybook story snapshot', async ({ page }) => {
  const id = process.env.STORY ?? '';
  if (!id) test.skip(true, 'no STORY env');
  fs.mkdirSync('screenshots', { recursive: true });
  await page.goto(`http://localhost:6006/iframe.html?id=${id}&viewMode=story`);
  await page.waitForSelector('#storybook-root', { timeout: 5000 });
  await page.screenshot({ path: `screenshots/${id}.png`, fullPage: true });
});
