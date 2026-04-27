/**
 * Regression suite — one failing test per bug the user reported.
 *
 * Each test boots the SolidJS frontend with a Tauri-IPC mock, exercises the
 * exact user flow that surfaced the bug, and asserts on visible UI state.
 *
 * The tests share a common `mountApp` helper that installs the same Tauri
 * mock used by `screenshot.spec.ts`. Per-test overrides (e.g. forcing a
 * first-run workspace, returning a real API key) layer on top.
 *
 * Run with: pnpm exec playwright test playwright/regressions.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Tauri IPC mock factory.
//
// Returns the JS to inject before any page script runs. The handlers map
// closely mirrors `screenshot.spec.ts` but accepts overrides so each test
// can swap in different responses (e.g. first_run = true to surface the
// FirstRunWizard, kicad_installs = [...] to test auto-select, etc).
// ---------------------------------------------------------------------------
interface MockOpts {
  firstRun?: boolean;
  apiKey?: string;
  kicadInstalls?: Array<{ kind: string; binary: string; version: string }>;
}

function buildTauriInitScript(opts: MockOpts = {}): string {
  const {
    firstRun = false,
    apiKey = 'screenshot-fake-key',
    kicadInstalls = [
      { kind: 'native', binary: '/usr/bin/kicad', version: '8.0.4' },
      { kind: 'flatpak', binary: 'flatpak run org.kicad.KiCad', version: '8.0.4' },
    ],
  } = opts;

  return `
(function () {
  const FAKE_WORKSPACE = '/tmp/kib-regression-ws';
  const FIRST_RUN = ${JSON.stringify(firstRun)};
  const API_KEY = ${JSON.stringify(apiKey)};
  const KICAD_INSTALLS = ${JSON.stringify(kicadInstalls)};

  const sidecarHandlers = {
    'library.list': () => ({ libraries: [] }),
    'library.list_components': () => ({ components: [] }),
    'kicad_install.list': () => ({ installs: KICAD_INSTALLS }),
    // FirstRunWizard uses kicad.detect (the sidecar's actual JSON-RPC name).
    // Reuse the same fixture so tests written against either method work.
    'kicad.detect': () => ({ installs: KICAD_INSTALLS }),
    'settings.get': () => ({
      settings: {
        theme: 'dark',
        concurrency: 4,
        search_raph_io: { enabled: true, base_url: 'https://search.raph.io' },
      },
    }),
    'settings.set': () => ({}),
    // Import.tsx Detect handler: parses textarea content and shows the
    // "Queue all →" button. Treat every non-empty line as a valid LCSC.
    'parts.parse_input': (params) => {
      const text = (params && params.text) || '';
      const rows = String(text)
        .split(/\\r?\\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((line) => {
          const [lcsc, qty] = line.split(',').map((x) => x.trim());
          return { lcsc, qty: qty ? Number(qty) : 1, ok: /^C\\d+$/.test(lcsc) };
        });
      return { format: 'list', rows };
    },
    'workspace.get_settings': () => ({ settings: { kicad_target: null } }),
    'workspace.set_settings': () => ({}),
    'secrets.get': (params) =>
      params.name === 'search_raph_io_api_key' ? { value: API_KEY } : { value: '' },
    'secrets.set': () => ({}),
    'search.query': (params) => ({
      results: [
        { lcsc: 'C25804', mpn: '0603WAF1002T5E', manufacturer: 'UNI-ROYAL',
          description: '10kΩ ±1% 100mW 0603 Thick Film Resistor',
          photo_url: 'https://search.raph.io/api/kibrary/parts/C25804/photo' },
        { lcsc: 'C1525', mpn: 'CL05B104KO5NNNC', manufacturer: 'Samsung',
          description: '100nF 16V X7R ±10% 0402 MLCC',
          photo_url: 'https://search.raph.io/api/kibrary/parts/C1525/photo' },
      ],
    }),
    // Sidecar-proxied photo fetch (bypasses webview CORS). Tracked via
    // window.__photoFetches so tests can assert it was actually called
    // with the expected lcsc.
    'search.fetch_photo': (params) => {
      (window).__photoFetches = (window).__photoFetches || [];
      (window).__photoFetches.push(params);
      // 1x1 red PNG, base64-encoded.
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Zy7d3MAAAAASUVORK5CYII=';
      return { data_url: 'data:image/png;base64,' + png };
    },
  };

  async function invoke(cmd, payload) {
    if (cmd === 'bootstrap_status') return { python_resolved: true, sidecar_version: '0.0.0-test' };
    if (cmd === 'workspace_open') {
      return { root: FAKE_WORKSPACE, settings: { kicad_target: null }, first_run: FIRST_RUN };
    }
    if (cmd === 'watch_workspace') return null;
    if (cmd && (cmd.startsWith('plugin:updater') || cmd.startsWith('plugin:event'))) return null;
    if (cmd && cmd.startsWith('plugin:dialog')) {
      // Simulate the directory picker resolving to FAKE_WORKSPACE.
      return FAKE_WORKSPACE;
    }
    if (cmd && cmd.startsWith('plugin:shell')) {
      // Swallow shell-plugin invocations (openUrl etc.) and record them so
      // tests can assert the click handler fired without an actual browser
      // opening on the headless CI box.
      (window).__shellCalls = (window).__shellCalls || [];
      (window).__shellCalls.push(payload);
      return null;
    }
    if (cmd === 'sidecar_call') {
      const method = payload && payload.method;
      const params = (payload && payload.params) || {};
      const handler = sidecarHandlers[method];
      if (handler) return handler(params);
      console.warn('[regression-mock] Unhandled sidecar_call method:', method);
      return {};
    }
    console.warn('[regression-mock] Unhandled Tauri command:', cmd);
    return null;
  }

  const callbacks = new Map();
  function transformCallback(cb, once) {
    const id = Math.floor(Math.random() * 0xFFFFFF);
    callbacks.set(id, { cb, once });
    return id;
  }

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback,
    runCallback: (id, data) => {
      const e = callbacks.get(id);
      if (e) { if (e.once) callbacks.delete(id); e.cb(data); }
    },
    unregisterCallback: (id) => callbacks.delete(id),
    callbacks,
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {};
  localStorage.setItem('recents', JSON.stringify([FAKE_WORKSPACE]));
})();
`;
}

async function mountApp(page: Page, opts: MockOpts = {}) {
  await page.addInitScript({ content: buildTauriInitScript(opts) });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
}

// ---------------------------------------------------------------------------
// Bug 1 — opening a workspace must not lock the user out of Libraries/Settings.
// ---------------------------------------------------------------------------
test('bug 1 — Libraries room reachable after Open folder', async ({ page }) => {
  await mountApp(page, { firstRun: false });

  // Click "Open folder…" — mock resolves to FAKE_WORKSPACE.
  await page.getByRole('button', { name: /open folder/i }).click();
  await page.waitForTimeout(300);

  // Now Libraries button should still respond to clicks.
  await page.getByRole('button', { name: /^Libraries$/, exact: true }).click();
  await page.waitForTimeout(200);

  // Assert that something Libraries-room-specific is visible. The room shows
  // a tree heading or "Open a workspace first" (we have one open, so the tree
  // should be present).
  await expect(
    page.locator('text=/library|Resistors_KSL|tree/i').first(),
  ).toBeVisible({ timeout: 3000 });
});

test('bug 2 — Settings room reachable after Open folder', async ({ page }) => {
  await mountApp(page, { firstRun: false });

  await page.getByRole('button', { name: /open folder/i }).click();
  await page.waitForTimeout(300);

  await page.getByRole('button', { name: /^Settings$/, exact: true }).click();
  await page.waitForTimeout(200);

  // The Settings room renders a heading and a Concurrency input — target
  // the heading specifically to avoid strict-mode collisions with the
  // sidebar button that also reads "Settings".
  await expect(page.getByRole('heading', { name: /^Settings$/ })).toBeVisible({ timeout: 3000 });
  await expect(page.getByText(/concurrency/i)).toBeVisible({ timeout: 3000 });
});

// ---------------------------------------------------------------------------
// Bug 3 — first-run wizard must auto-select the first detected KiCad install.
// ---------------------------------------------------------------------------
test('bug 3 — wizard auto-selects first detected KiCad install', async ({ page }) => {
  await mountApp(page, { firstRun: true });

  // Surface the wizard by opening a workspace (the directory picker mock
  // resolves immediately to FAKE_WORKSPACE, and our workspace_open handler
  // returns first_run = true here).
  await page.getByRole('button', { name: /open folder/i }).click();
  await page.waitForTimeout(500);

  // Wizard should be visible and the first install should be pre-selected
  // (radio checked / button highlighted / equivalent visible state).
  await expect(page.locator('text=/kicad/i').first()).toBeVisible();
  // The Get-started button should be enabled (not disabled-because-no-install).
  const cta = page.getByRole('button', { name: /get started|continue|next/i }).first();
  await expect(cta).toBeEnabled();
});

// ---------------------------------------------------------------------------
// Bug 4 — each queued item must have an unqueue ("✕") button.
// ---------------------------------------------------------------------------
test('bug 4 — queued items can be removed individually', async ({ page }) => {
  await mountApp(page);
  // Get to the Add room.
  await page.getByRole('button', { name: /^Add$/, exact: true }).click();
  await page.waitForTimeout(200);

  // Paste two LCSCs, detect, then queue them.
  const textarea = page.locator('textarea').first();
  await textarea.fill('C25804\nC1525');
  await page.getByRole('button', { name: /^detect$/i }).click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: /queue all/i }).click();
  await page.waitForTimeout(200);

  // Both should be in the queue.
  await expect(page.locator('li', { hasText: 'C25804' })).toBeVisible();
  await expect(page.locator('li', { hasText: 'C1525' })).toBeVisible();

  // Each row should have a remove button. Click the one for C25804.
  const c25804Row = page.locator('li', { hasText: 'C25804' });
  await c25804Row.getByRole('button', { name: /remove|✕|×/i }).click();
  await page.waitForTimeout(200);

  await expect(page.locator('li', { hasText: 'C25804' })).toHaveCount(0);
  await expect(page.locator('li', { hasText: 'C1525' })).toBeVisible();
});

// ---------------------------------------------------------------------------
// Bug 4b — there must also be a "Clear queue" button that nukes everything.
// ---------------------------------------------------------------------------
test('bug 4b — Clear queue button removes all items', async ({ page }) => {
  await mountApp(page);
  await page.getByRole('button', { name: /^Add$/, exact: true }).click();
  await page.waitForTimeout(200);

  const textarea = page.locator('textarea').first();
  await textarea.fill('C25804\nC1525\nC19920');
  await page.getByRole('button', { name: /^detect$/i }).click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: /queue all/i }).click();
  await page.waitForTimeout(200);

  await expect(page.locator('li', { hasText: 'C25804' })).toBeVisible();
  await expect(page.locator('li', { hasText: 'C1525' })).toBeVisible();
  await expect(page.locator('li', { hasText: 'C19920' })).toBeVisible();

  await page.getByRole('button', { name: /clear queue/i }).click();
  await page.waitForTimeout(200);

  await expect(page.locator('li', { hasText: 'C25804' })).toHaveCount(0);
  await expect(page.locator('li', { hasText: 'C1525' })).toHaveCount(0);
  await expect(page.locator('li', { hasText: 'C19920' })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Bug 5 — SearchPanel header must include a "Visit search.raph.io" link.
// ---------------------------------------------------------------------------
test('bug 5 — SearchPanel has visit-site link in header', async ({ page }) => {
  await mountApp(page);
  await page.getByRole('button', { name: /^Add$/, exact: true }).click();
  await page.waitForTimeout(300);

  // Link/button positioned to the right of the "Search Parts" heading.
  const link = page.getByRole('link', { name: /search\.raph\.io/i });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', /search\.raph\.io/);
  await expect(link).toHaveAttribute('target', '_blank');

  // When the user has typed a query, the href should reactively carry it
  // forward as ?q=<encoded query> so they land on the pre-filtered web view.
  const searchInput = page.getByPlaceholder(/MPN.*description.*LCSC/i).first();
  await searchInput.fill('esp32');
  await page.waitForTimeout(300);
  await expect(link).toHaveAttribute('href', /\?q=esp32/);

  // Clicking the link must actually invoke the shell plugin (Tauri 2
  // webviews don't open target="_blank" via the OS browser otherwise).
  await link.click();
  const shellCalls = await page.evaluate(
    () => (window as unknown as { __shellCalls?: unknown[] }).__shellCalls?.length ?? 0,
  );
  expect(shellCalls).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// Bug 6 — search-result thumbnails actually render an image, not the grey box.
//
// Root cause (alpha.2): AuthedThumbnail used `fetch()` from JS to
// https://search.raph.io, which is blocked by the server's CORS policy
// (only `http://localhost:3000` is allow-listed). The preflight failed,
// the resource entered an errored state, and `<Show when={blobUrl()}>`
// fell through to the grey fallback `<div>`.
//
// Fix: photo fetches now go through the Python sidecar via the new
// `search.fetch_photo` method, which returns a `data:` URL. No CORS, no
// Bearer header in JS, and tests can assert via the mock that the right
// lcsc was requested.
// ---------------------------------------------------------------------------
test('bug 6 — thumbnails render with embedded API key', async ({ page }) => {
  // Belt-and-braces: a direct fetch should NOT happen any more (the bug).
  // If anything still hits the photo endpoint, fail loudly so we don't
  // silently regress back to the CORS-blocked code path.
  await page.route('**/api/kibrary/parts/*/photo', async (route) => {
    throw new Error(
      'Direct fetch to /api/kibrary/parts/*/photo escaped the sidecar proxy — ' +
        'this is the alpha.2 CORS bug regressing.',
    );
  });

  await mountApp(page, { apiKey: 'real-looking-key' });
  await page.getByRole('button', { name: /^Add$/, exact: true }).click();
  await page.waitForTimeout(300);

  const searchInput = page.getByPlaceholder(/MPN.*description.*LCSC/i).first();
  await searchInput.fill('10k');
  await page.waitForTimeout(800);

  // At least one img should have a non-empty src that actually resolves.
  const imgs = page.locator('li img');
  await expect(imgs.first()).toBeVisible({ timeout: 3000 });

  // The src should be a data: URL (proves the sidecar-proxied path ran).
  const src = await imgs.first().getAttribute('src');
  expect(src).toMatch(/^data:image\//);

  // And the sidecar must have been called with the right lcsc — the
  // mock pushes onto window.__photoFetches.
  const fetched: Array<{ lcsc: string }> = await page.evaluate(
    () => (window as unknown as { __photoFetches?: Array<{ lcsc: string }> }).__photoFetches ?? [],
  );
  expect(fetched.length).toBeGreaterThan(0);
  expect(fetched.map((f) => f.lcsc)).toContain('C25804');
});
