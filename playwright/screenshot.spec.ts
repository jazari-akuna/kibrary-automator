import { test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const route = process.env.ROUTE ?? '/';
const outDir = 'screenshots';

test('snapshot route', async ({ page }) => {
  fs.mkdirSync(outDir, { recursive: true });
  await page.goto(route);
  await page.waitForLoadState('networkidle');
  const safe = route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'index';
  await page.screenshot({ path: path.join(outDir, `${safe}.png`), fullPage: true });
});
