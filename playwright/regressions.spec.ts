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
  /** Bug 7: artificial delay (ms) on every search.fetch_photo call to
   *  simulate slow upstream and prove fetches run in parallel, not serially. */
  photoDelayMs?: number;
  /** Bug 7: override the default 2-result search.query payload. */
  searchResults?: Array<{ lcsc: string; mpn: string; description: string }>;
  /** Bug 8: override the recents list seeded into localStorage. When omitted,
   *  the default ['/tmp/kib-regression-ws'] is seeded for backwards compat. */
  recents?: string[];
  /** Bug 9: version returned by the mocked sidecar `system.version` handler. */
  sidecarVersion?: string;
  /** Bug 9: version returned by the mocked Tauri `app_version` command. */
  appVersion?: string;
  /** Bug 10: when set, plugin:updater check returns this fake update payload
   *  instead of `null`. Tests can use it to drive the "update available" UI. */
  fakeUpdate?: { version: string } | null;
  /** Bugs 13-15: parts.download handler behaviour. 'throw' rejects the RPC,
   *  'slow' simulates per-part download.progress events with a delay before
   *  resolving. Default is the no-op handler (resolves with empty results). */
  partsDownloadMode?: 'ok' | 'throw' | 'slow' | 'progress50';
  /** Bugs 11/12: extra per-test sidecar handlers. Each entry overrides the
   *  default handler for that method. The body is serialised verbatim — pass
   *  the raw source of a `function (params) { ... }` (or arrow). Keeping it as
   *  a string lets each test bake its own bespoke fixtures without bloating
   *  the shared base mock. */
  extraHandlers?: Record<string, string>;
}

function buildTauriInitScript(opts: MockOpts = {}): string {
  const {
    firstRun = false,
    apiKey = 'screenshot-fake-key',
    kicadInstalls = [
      { kind: 'native', binary: '/usr/bin/kicad', version: '8.0.4' },
      { kind: 'flatpak', binary: 'flatpak run org.kicad.KiCad', version: '8.0.4' },
    ],
    photoDelayMs = 0,
    searchResults,
    recents,
    sidecarVersion = '26.4.27-test-sc',
    appVersion = '26.4.27-test',
    fakeUpdate = null,
    partsDownloadMode = 'ok',
    extraHandlers = {},
  } = opts;

  // Build the JS literal for the extra-handlers map. Each entry maps a
  // sidecar method name to the verbatim source of a function expression.
  const extraHandlersLiteral =
    '{' +
    Object.entries(extraHandlers)
      .map(([m, body]) => `${JSON.stringify(m)}: (${body})`)
      .join(',') +
    '}';

  return `
(function () {
  const FAKE_WORKSPACE = '/tmp/kib-regression-ws';
  const FIRST_RUN = ${JSON.stringify(firstRun)};
  const API_KEY = ${JSON.stringify(apiKey)};
  const KICAD_INSTALLS = ${JSON.stringify(kicadInstalls)};
  const PHOTO_DELAY_MS = ${JSON.stringify(photoDelayMs)};
  const SEARCH_RESULTS_OVERRIDE = ${JSON.stringify(searchResults ?? null)};
  const RECENTS = ${JSON.stringify(recents ?? null)};
  const SIDECAR_VERSION = ${JSON.stringify(sidecarVersion)};
  const APP_VERSION = ${JSON.stringify(appVersion)};
  const FAKE_UPDATE = ${JSON.stringify(fakeUpdate)};
  const PARTS_DOWNLOAD_MODE = ${JSON.stringify(partsDownloadMode)};

  // Map<event-name, Map<eventId, transformedCallbackId>> — populated by
  // plugin:event|listen calls and read by window.__emitTauri to dispatch
  // events to all registered handlers. Mirrors the runtime contract.
  const eventListeners = new Map();
  let nextEventId = 1;

  const sidecarHandlers = {
    'library.list': () => ({ libraries: [] }),
    'library.list_components': () => ({ components: [] }),
    'kicad_install.list': () => ({ installs: KICAD_INSTALLS }),
    // FirstRunWizard uses kicad.detect (the sidecar's actual JSON-RPC name).
    // Reuse the same fixture so tests written against either method work.
    'kicad.detect': () => ({ installs: KICAD_INSTALLS }),
    // Bug 9: Settings room's Versions card shows the sidecar version here.
    'system.version': () => ({ version: SIDECAR_VERSION }),
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
    'search.query': (params) => {
      if (SEARCH_RESULTS_OVERRIDE) {
        return { results: SEARCH_RESULTS_OVERRIDE };
      }
      return {
        results: [
          { lcsc: 'C25804', mpn: '0603WAF1002T5E', manufacturer: 'UNI-ROYAL',
            description: '10kΩ ±1% 100mW 0603 Thick Film Resistor',
            photo_url: 'https://search.raph.io/api/kibrary/parts/C25804/photo' },
          { lcsc: 'C1525', mpn: 'CL05B104KO5NNNC', manufacturer: 'Samsung',
            description: '100nF 16V X7R ±10% 0402 MLCC',
            photo_url: 'https://search.raph.io/api/kibrary/parts/C1525/photo' },
        ],
      };
    },
    // Sidecar-proxied photo fetch (bypasses webview CORS). Tracked via
    // window.__photoFetches so tests can assert it was actually called
    // with the expected lcsc.  When PHOTO_DELAY_MS > 0 the handler returns
    // a Promise that resolves after the delay, simulating slow upstream
    // — bug 7 uses this to prove parallel dispatch.
    'search.fetch_photo': (params) => {
      (window).__photoFetches = (window).__photoFetches || [];
      (window).__photoFetches.push({ ...params, t: performance.now() });
      // 1x1 red PNG, base64-encoded.
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Zy7d3MAAAAASUVORK5CYII=';
      const payload = { data_url: 'data:image/png;base64,' + png };
      if (PHOTO_DELAY_MS > 0) {
        return new Promise((resolve) => setTimeout(() => resolve(payload), PHOTO_DELAY_MS));
      }
      return payload;
    },
  };

  async function invoke(cmd, payload) {
    if (cmd === 'bootstrap_status') return { python_resolved: true, sidecar_version: '0.0.0-test' };
    if (cmd === 'workspace_open') {
      return { root: FAKE_WORKSPACE, settings: { kicad_target: null }, first_run: FIRST_RUN };
    }
    if (cmd === 'watch_workspace') return null;
    // Bug 9: Settings room's Versions card calls this Tauri command for the
    // native shell version.
    if (cmd === 'app_version') return APP_VERSION;
    if (cmd && cmd.startsWith('plugin:updater')) {
      // Bug 10: emulate the updater plugin check IPC. The JS binding
      // contract: returns metadata when an update exists, null otherwise
      // (see plugin-updater dist-js index.js). The Update constructor reads
      // .rid, .currentVersion, .version, .date, .body, .rawJson.
      if (cmd === 'plugin:updater|check') {
        if (FAKE_UPDATE) {
          return {
            rid: 1,
            currentVersion: APP_VERSION,
            version: FAKE_UPDATE.version,
            date: null,
            body: null,
            rawJson: {},
          };
        }
        return null;
      }
      return null;
    }
    if (cmd === 'plugin:resources|close') return null;
    if (cmd && cmd.startsWith('plugin:event')) return null;
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
  // Bug 8: tests can override the recents list (or pass [] for the empty
  // case). Default keeps the previous behaviour so existing tests continue
  // to pass.
  localStorage.setItem('recents', JSON.stringify(RECENTS ?? [FAKE_WORKSPACE]));
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
  // Empty recents → no auto-open (bug 8) → "Open folder…" button is visible
  // so we can exercise the manual-pick flow this test was written for.
  await mountApp(page, { firstRun: false, recents: [] });

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
  // Empty recents → no auto-open (bug 8) → "Open folder…" button is visible.
  await mountApp(page, { firstRun: false, recents: [] });

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
  // Empty recents → no auto-open (bug 8) → manually click Open folder. With
  // firstRun=true the workspace_open mock returns first_run=true, surfacing
  // the FirstRunWizard for the assertions below.
  await mountApp(page, { firstRun: true, recents: [] });

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

// ---------------------------------------------------------------------------
// Bug 7 — multiple thumbnails load in parallel.
//
// Root cause (alpha.4): the Python sidecar's RPC server (rpc.py) was a
// single-threaded loop that read one request, ran the handler to
// completion, then read the next. Five thumbnails meant five sequential
// HTTPS roundtrips to search.raph.io — easily a couple of seconds on a
// noisy network even though each fetch is independent.
//
// Fix: rpc.py now dispatches handlers on a small ThreadPoolExecutor so
// independent I/O-bound calls overlap. search_client also reuses a
// module-scoped httpx.Client (TLS handshake amortised) and caches photos
// in an in-process LRU; the frontend additionally dedupes via a Map.
//
// This test mocks search.fetch_photo with a 200ms delay and asserts that
// 5 thumbnails are all visible within ~500ms of the search resolving.
// Serial fetching would take ~1000ms+ and fail the assertion.
// ---------------------------------------------------------------------------
test('bug 7 — multiple thumbnails load in parallel', async ({ page }) => {
  const fiveResults = [
    { lcsc: 'C25804', mpn: 'MPN-1', description: 'Part 1' },
    { lcsc: 'C1525', mpn: 'MPN-2', description: 'Part 2' },
    { lcsc: 'C19920', mpn: 'MPN-3', description: 'Part 3' },
    { lcsc: 'C99999', mpn: 'MPN-4', description: 'Part 4' },
    { lcsc: 'C77777', mpn: 'MPN-5', description: 'Part 5' },
  ];

  await mountApp(page, {
    apiKey: 'real-looking-key',
    photoDelayMs: 200,
    searchResults: fiveResults,
  });
  await page.getByRole('button', { name: /^Add$/, exact: true }).click();
  await page.waitForTimeout(200);

  const searchInput = page.getByPlaceholder(/MPN.*description.*LCSC/i).first();
  await searchInput.fill('parallel-test');

  // Wait for the 5 result rows to appear (search.query is debounced 250 ms
  // in SearchPanel + zero-delay mock; result list materialises shortly
  // after the input event). Once the rows exist we start the parallel
  // clock.
  const rows = page.locator('ul li', { hasText: /MPN-/ });
  await expect(rows).toHaveCount(5, { timeout: 2000 });

  const startedAt = await page.evaluate(() => performance.now());

  // All 5 <img> tags must materialise within 500ms — round-trip is 200ms
  // per call. Parallel ≈ max(200ms) + overhead. Serial would be
  // 5 × 200ms = 1000ms+ and fail this assertion.
  const imgs = page.locator('li img');
  await expect(imgs).toHaveCount(5, { timeout: 500 });

  const elapsed = await page.evaluate((s) => performance.now() - s, startedAt);
  expect(
    elapsed,
    `5 thumbnails took ${elapsed.toFixed(0)}ms — expected < 500ms (proving ` +
      `parallel dispatch). Anything ≥ 1000ms means the sidecar is back to ` +
      `serial fetches, which is the alpha.4 perf bug regressing.`,
  ).toBeLessThan(500);

  // Sanity: the sidecar mock saw 5 calls AND they were issued in a tight
  // burst (last-issued − first-issued < 50ms). Serial dispatch would
  // spread them by 200ms+ each.
  const fetches: Array<{ lcsc: string; t: number }> = await page.evaluate(
    () =>
      (window as unknown as { __photoFetches?: Array<{ lcsc: string; t: number }> })
        .__photoFetches ?? [],
  );
  expect(fetches.length).toBe(5);
  const ts = fetches.map((f) => f.t).sort((a, b) => a - b);
  const burstSpan = ts[ts.length - 1] - ts[0];
  expect(
    burstSpan,
    `fetch dispatch spread over ${burstSpan.toFixed(0)}ms — expected a tight ` +
      `burst (< 50ms). A wider spread means the frontend is awaiting each ` +
      `call before issuing the next.`,
  ).toBeLessThan(50);
});

// ---------------------------------------------------------------------------
// Bug 8 — last workspace must auto-open on app launch.
//
// Root cause: Shell.tsx had no onMount that called openWorkspace(recents()[0]).
// Recent paths were shown as clickable buttons in the WorkspacePicker but
// nothing acted on them. Fix: Shell now invokes openWorkspace on the first
// recent path (try/catch — failures fall back to the picker).
// ---------------------------------------------------------------------------
test('bug 8 — last workspace auto-opens on launch', async ({ page }) => {
  await mountApp(page, { recents: ['/tmp/kib-regression-ws'] });

  // The workspace path appears in the header (WorkspacePicker, "Show when
  // currentWorkspace()" branch) once auto-open succeeds. Before the fix this
  // path would only render after a manual click.
  await expect(page.locator('header').getByText('/tmp/kib-regression-ws')).toBeVisible({
    timeout: 3000,
  });

  // The "Open folder…" button (rendered by WorkspacePicker's fallback branch)
  // should NOT be visible — we have a workspace open.
  await expect(page.getByRole('button', { name: /open folder/i })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Bug 9 — Settings room shows the three independent version stamps.
// ---------------------------------------------------------------------------
test('bug 9 — Settings shows three versions', async ({ page }) => {
  await mountApp(page, {
    appVersion: '26.4.27-shell-test',
    sidecarVersion: '26.4.27-sc-test',
  });

  await page.getByRole('button', { name: /^Settings$/, exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Settings$/ })).toBeVisible({ timeout: 3000 });

  // All three labels render.
  await expect(page.getByText(/^Frontend:/)).toBeVisible();
  await expect(page.getByText(/^Tauri shell:/)).toBeVisible();
  await expect(page.getByText(/^Sidecar:/)).toBeVisible();

  // And the values are non-empty (the resources resolved).
  const frontend = await page.getByTestId('version-frontend').textContent();
  const tauri = await page.getByTestId('version-tauri').textContent();
  const sidecar = await page.getByTestId('version-sidecar').textContent();
  expect(frontend?.trim().length ?? 0).toBeGreaterThan(0);
  expect(tauri?.trim()).toBe('26.4.27-shell-test');
  expect(sidecar?.trim()).toBe('26.4.27-sc-test');
});

// ---------------------------------------------------------------------------
// Bug 10 — Settings room offers a manual "Check for updates" button.
// ---------------------------------------------------------------------------
test('bug 10 — Settings has Check-for-updates button', async ({ page }) => {
  await mountApp(page);
  await page.getByRole('button', { name: /^Settings$/, exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Settings$/ })).toBeVisible({ timeout: 3000 });

  const btn = page.getByRole('button', { name: /check.*update/i });
  await expect(btn).toBeVisible();

  // Click it — the mock's plugin:updater|check returns null (no update), so
  // the UI should land on "You're up to date".
  await btn.click();
  await expect(page.getByText(/up to date/i)).toBeVisible({ timeout: 3000 });
});
