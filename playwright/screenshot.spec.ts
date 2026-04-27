import { test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const route = process.env.ROUTE ?? '/';
const room = process.env.ROOM ?? '';
const outDir = 'screenshots';

// ---------------------------------------------------------------------------
// Tauri IPC mock — injected before the SolidJS app mounts.
//
// The @tauri-apps/api/core `invoke` function reads
// `window.__TAURI_INTERNALS__.invoke`, so patching that object is enough to
// intercept every invoke() call made by the app.
//
// Responses are keyed on the Tauri command name.  For `sidecar_call` we
// dispatch further on `payload.method`.
// ---------------------------------------------------------------------------
const tauriInitScript = `
(function () {
  const FAKE_WORKSPACE = '/tmp/kib-screenshot-ws';

  // Canned sidecar_call responses, keyed by method name.
  const sidecarHandlers = {
    'library.list': function () {
      return {
        libraries: [
          { name: 'Resistors_KSL',   path: FAKE_WORKSPACE + '/Resistors_KSL',   component_count: 3, has_pretty: true,  has_3dshapes: false },
          { name: 'Capacitors_KSL',  path: FAKE_WORKSPACE + '/Capacitors_KSL',  component_count: 2, has_pretty: true,  has_3dshapes: false },
          { name: 'MCU_KSL',         path: FAKE_WORKSPACE + '/MCU_KSL',          component_count: 1, has_pretty: false, has_3dshapes: false },
        ],
      };
    },

    'library.list_components': function (params) {
      const byLib = {
        'Resistors_KSL':  [
          { name: 'R_10k_0402', description: '10k Resistor 0402 (sample)', reference: 'R', value: 'R_10k_0402', footprint: 'Resistor_SMD:R_0402' },
          { name: 'R_4k7_0402',  description: '4.7k Resistor 0402 (sample)', reference: 'R', value: 'R_4k7_0402', footprint: 'Resistor_SMD:R_0402' },
          { name: 'R_100_0603',  description: '100R Resistor 0603 (sample)', reference: 'R', value: 'R_100_0603', footprint: 'Resistor_SMD:R_0603' },
        ],
        'Capacitors_KSL': [
          { name: 'C_100nF_0402', description: '100nF MLCC 0402 (sample)', reference: 'C', value: 'C_100nF_0402', footprint: 'Capacitor_SMD:C_0402' },
          { name: 'C_10uF_0805',  description: '10uF MLCC 0805 (sample)',  reference: 'C', value: 'C_10uF_0805',  footprint: 'Capacitor_SMD:C_0805' },
        ],
        'MCU_KSL': [
          { name: 'STM32G030F6P6', description: 'STM32G030F6P6 (sample)', reference: 'U', value: 'STM32G030F6P6', footprint: 'Package_SO:TSSOP-20' },
        ],
      };
      // params.lib_dir ends with the library name
      const libName = params.lib_dir.split('/').pop();
      return { components: byLib[libName] || [] };
    },

    'settings.get': function () {
      return {
        settings: {
          theme: 'dark',
          concurrency: 4,
          search_raph_io: { enabled: true, base_url: 'https://search.raph.io' },
        },
      };
    },

    'settings.set': function () { return {}; },

    // Pretend a search.raph.io API key is set so the SearchPanel renders.
    'secrets.get': function (params) {
      if (params.name === 'search_raph_io_api_key') return { value: 'screenshot-fake-key' };
      return { value: '' };
    },

    // Realistic search results that match what search.raph.io actually returns
    // (the photo_url field uses the real public endpoint so screenshots load
    // actual product images).
    'search.query': function (params) {
      const q = (params.q || '').toLowerCase();
      // Default fixture set; in practice the search panel debounces and only
      // queries when the user types something.
      const all = [
        {
          lcsc: 'C25804',
          mpn: '0603WAF1002T5E',
          manufacturer: 'UNI-ROYAL',
          description: '10kΩ ±1% 100mW 0603 Thick Film Resistor',
          photo_url: 'https://search.raph.io/api/kibrary/parts/C25804/photo',
          in_stock: true,
        },
        {
          lcsc: 'C1525',
          mpn: 'CL05B104KO5NNNC',
          manufacturer: 'Samsung Electro-Mechanics',
          description: '100nF 16V X7R ±10% 0402 MLCC',
          photo_url: 'https://search.raph.io/api/kibrary/parts/C1525/photo',
          in_stock: true,
        },
        {
          lcsc: 'C19920',
          mpn: 'STM32G030F6P6',
          manufacturer: 'STMicroelectronics',
          description: 'STM32G030F6P6 ARM Cortex-M0+ 32KB Flash 8KB SRAM TSSOP-20',
          photo_url: 'https://search.raph.io/api/kibrary/parts/C19920/photo',
          in_stock: true,
        },
      ];
      // Screenshot fixture: return the full diverse result set whenever any
      // text is typed, so the screenshot shows resistor + cap + MCU thumbnails
      // side by side rather than narrowing to a single hit.
      return { results: all };
    },

    // AuthedThumbnail in the new SearchPanel calls search.fetch_photo via
    // sidecar_call (not a plain HTTP fetch — that path was retired because
    // search.raph.io's CORS only allows localhost:3000). The mock dispatches
    // on LCSC and returns a hand-drawn SVG matching the actual product so
    // README screenshots render real-looking photos.
    'search.fetch_photo': function (params) {
      const lcsc = (params && params.lcsc) || '';
      const svgs = {
        C25804: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" fill="#f4f1ea"/><rect x="40" y="62" width="80" height="36" rx="3" fill="#1a1a1a"/><rect x="40" y="62" width="14" height="36" fill="#9a9a9a"/><rect x="106" y="62" width="14" height="36" fill="#9a9a9a"/><text x="80" y="86" text-anchor="middle" fill="#f4f1ea" font-family="Arial,sans-serif" font-weight="700" font-size="13">10K</text></svg>',
        C1525: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" fill="#f4f1ea"/><rect x="58" y="68" width="44" height="24" rx="2" fill="#7a4a25"/><rect x="58" y="68" width="9" height="24" fill="#c9c9c9"/><rect x="93" y="68" width="9" height="24" fill="#c9c9c9"/></svg>',
        C19920: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" fill="#f4f1ea"/><rect x="44" y="46" width="72" height="68" rx="2" fill="#1a1a1a"/><text x="80" y="82" text-anchor="middle" fill="#dcdcdc" font-family="Arial,sans-serif" font-weight="600" font-size="9">STM32</text><text x="80" y="94" text-anchor="middle" fill="#dcdcdc" font-family="Arial,sans-serif" font-weight="600" font-size="9">G030F6</text><g fill="#c9c9c9"><rect x="36" y="50" width="8" height="3"/><rect x="36" y="60" width="8" height="3"/><rect x="36" y="70" width="8" height="3"/><rect x="36" y="80" width="8" height="3"/><rect x="36" y="90" width="8" height="3"/><rect x="36" y="100" width="8" height="3"/><rect x="116" y="50" width="8" height="3"/><rect x="116" y="60" width="8" height="3"/><rect x="116" y="70" width="8" height="3"/><rect x="116" y="80" width="8" height="3"/><rect x="116" y="90" width="8" height="3"/><rect x="116" y="100" width="8" height="3"/></g></svg>',
      };
      const svg = svgs[lcsc] || ('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" fill="#f4f1ea"/><text x="80" y="86" text-anchor="middle" fill="#666" font-family="Arial,sans-serif" font-size="14">' + lcsc + '</text></svg>');
      return { data_url: 'data:image/svg+xml;base64,' + btoa(svg) };
    },
  };

  // Minimal invoke shim.
  async function invoke(cmd, payload) {
    // -----------------------------------------------------------------------
    // bootstrap_status — tell the app Python is ready so Shell renders.
    // -----------------------------------------------------------------------
    if (cmd === 'bootstrap_status') {
      return { python_resolved: true, sidecar_version: '0.0.0-screenshot' };
    }

    // -----------------------------------------------------------------------
    // workspace_open — return a fake workspace object.
    // -----------------------------------------------------------------------
    if (cmd === 'workspace_open') {
      return {
        root: FAKE_WORKSPACE,
        settings: { kicad_target: null },
        first_run: false,
      };
    }

    // -----------------------------------------------------------------------
    // watch_workspace — fire-and-forget watcher; just resolve.
    // -----------------------------------------------------------------------
    if (cmd === 'watch_workspace') {
      return null;
    }

    // -----------------------------------------------------------------------
    // plugin:updater|* — updater plugin calls; silently resolve.
    // -----------------------------------------------------------------------
    if (cmd && cmd.startsWith('plugin:updater')) {
      return null;
    }

    // -----------------------------------------------------------------------
    // plugin:event|* — event plugin; silently resolve.
    // -----------------------------------------------------------------------
    if (cmd && cmd.startsWith('plugin:event')) {
      return null;
    }

    // -----------------------------------------------------------------------
    // sidecar_call — dispatch on method.
    // -----------------------------------------------------------------------
    if (cmd === 'sidecar_call') {
      const method = payload && payload.method;
      const params = (payload && payload.params) || {};
      const handler = sidecarHandlers[method];
      if (handler) return handler(params);
      console.warn('[mock] Unhandled sidecar_call method:', method);
      return {};
    }

    console.warn('[mock] Unhandled Tauri command:', cmd);
    return null;
  }

  // Minimal transformCallback (needed by some Tauri internals).
  const callbacks = new Map();
  function transformCallback(cb, once) {
    const id = Math.floor(Math.random() * 0xFFFFFF);
    callbacks.set(id, { cb, once });
    return id;
  }
  function runCallback(id, data) {
    const entry = callbacks.get(id);
    if (entry) {
      if (entry.once) callbacks.delete(id);
      entry.cb(data);
    }
  }

  // Install into window.__TAURI_INTERNALS__ before any app code runs.
  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback,
    runCallback,
    unregisterCallback: (id) => callbacks.delete(id),
    callbacks,
    metadata: {
      currentWindow:  { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {};

  // Pre-populate recent workspaces so WorkspacePicker shows the fake path.
  localStorage.setItem('recents', JSON.stringify([FAKE_WORKSPACE]));
})();
`;

// ---------------------------------------------------------------------------
// Per-LCSC fake product photos (SVG, served by Playwright's network mock).
//
// SearchPanel's <AuthedThumbnail> calls
//   fetch('https://search.raph.io/api/kibrary/parts/<LCSC>/photo',
//         { headers: { Authorization: 'Bearer <key>' } })
// and renders the response as a blob URL. With a fake API key the real server
// would 401, so we intercept the request below and return a hand-drawn SVG
// that resembles the actual JLCPCB product photo for that LCSC code.
// ---------------------------------------------------------------------------
const fakePhotoSvgs: Record<string, string> = {
  // C25804 — UNI-ROYAL 10kΩ 0603 thick-film resistor (small beige rectangle
  // with black ends + "10K" silkscreen).
  C25804: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
    <rect width="160" height="160" fill="#f4f1ea"/>
    <rect x="40" y="62" width="80" height="36" rx="3" fill="#1a1a1a"/>
    <rect x="40" y="62" width="14" height="36" fill="#9a9a9a"/>
    <rect x="106" y="62" width="14" height="36" fill="#9a9a9a"/>
    <text x="80" y="86" text-anchor="middle" fill="#f4f1ea" font-family="Arial,sans-serif" font-weight="700" font-size="13">10K</text>
  </svg>`,

  // C1525 — Samsung CL05B104KO5NNNC 100nF 0402 MLCC (small brown rectangle).
  C1525: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
    <rect width="160" height="160" fill="#f4f1ea"/>
    <rect x="58" y="68" width="44" height="24" rx="2" fill="#7a4a25"/>
    <rect x="58" y="68" width="9" height="24" fill="#c9c9c9"/>
    <rect x="93" y="68" width="9" height="24" fill="#c9c9c9"/>
  </svg>`,

  // C19920 — STMicro STM32G030F6P6, TSSOP-20 (black SOIC body with pins).
  C19920: `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
    <rect width="160" height="160" fill="#f4f1ea"/>
    <rect x="44" y="46" width="72" height="68" rx="2" fill="#1a1a1a"/>
    <circle cx="54" cy="56" r="2.5" fill="#666"/>
    <text x="80" y="82" text-anchor="middle" fill="#dcdcdc" font-family="Arial,sans-serif" font-weight="600" font-size="9">STM32</text>
    <text x="80" y="94" text-anchor="middle" fill="#dcdcdc" font-family="Arial,sans-serif" font-weight="600" font-size="9">G030F6</text>
    <g fill="#c9c9c9">
      <rect x="36" y="50" width="8" height="3"/>
      <rect x="36" y="57" width="8" height="3"/>
      <rect x="36" y="64" width="8" height="3"/>
      <rect x="36" y="71" width="8" height="3"/>
      <rect x="36" y="78" width="8" height="3"/>
      <rect x="36" y="85" width="8" height="3"/>
      <rect x="36" y="92" width="8" height="3"/>
      <rect x="36" y="99" width="8" height="3"/>
      <rect x="36" y="106" width="8" height="3"/>
      <rect x="116" y="50" width="8" height="3"/>
      <rect x="116" y="57" width="8" height="3"/>
      <rect x="116" y="64" width="8" height="3"/>
      <rect x="116" y="71" width="8" height="3"/>
      <rect x="116" y="78" width="8" height="3"/>
      <rect x="116" y="85" width="8" height="3"/>
      <rect x="116" y="92" width="8" height="3"/>
      <rect x="116" y="99" width="8" height="3"/>
      <rect x="116" y="106" width="8" height="3"/>
    </g>
  </svg>`,
};

function fallbackPhotoSvg(lcsc: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
    <rect width="160" height="160" fill="#f4f1ea"/>
    <text x="80" y="86" text-anchor="middle" fill="#666" font-family="Arial,sans-serif" font-size="14">${lcsc}</text>
  </svg>`;
}

test('snapshot route', async ({ page }) => {
  fs.mkdirSync(outDir, { recursive: true });

  // Inject the Tauri mock before any page scripts execute.
  await page.addInitScript({ content: tauriInitScript });

  // Intercept thumbnail HTTP requests and serve a hand-drawn SVG matching
  // the LCSC code, so screenshots look polished without needing a real key.
  await page.route('**/api/kibrary/parts/*/photo', async (route, request) => {
    const m = request.url().match(/\/parts\/([^/?]+)\/photo/);
    const lcsc = m?.[1] ?? 'C0';
    const svg = fakePhotoSvgs[lcsc] ?? fallbackPhotoSvg(lcsc);
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg });
  });

  await page.goto(route);
  await page.waitForLoadState('networkidle');

  // -------------------------------------------------------------------------
  // Click the room button in the left rail if ROOM is specified.
  // -------------------------------------------------------------------------
  if (room) {
    const label = room.charAt(0).toUpperCase() + room.slice(1); // e.g. 'add' -> 'Add'
    const btn = page.getByRole('button', { name: label, exact: true });
    await btn.waitFor({ state: 'visible', timeout: 5000 });
    await btn.click();
    // Give Solid's reactive system a moment to settle after the click.
    await page.waitForTimeout(300);

    // For the Add room, type something into the search panel so results
    // appear in the screenshot.
    if (room === 'add') {
      const searchInput = page.getByPlaceholder(/MPN.*description.*LCSC/i).first();
      const present = await searchInput.isVisible().catch(() => false);
      if (present) {
        await searchInput.fill('10k');
        // SearchPanel debounces 250 ms before firing the query;
        // wait for any product images from search.raph.io to load too.
        await page.waitForTimeout(800);
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
    }

    // For the Libraries room, open the fake workspace first so the tree
    // populates with mock data rather than showing "Open a workspace first".
    if (room === 'libraries') {
      // The WorkspacePicker in the header shows recent paths as underlined links.
      // Clicking /tmp/kib-screenshot-ws calls openWorkspace() → invoke('workspace_open')
      // which our mock handles, setting currentWorkspace() to the fake workspace.
      const recentBtn = page.getByRole('button', { name: '/tmp/kib-screenshot-ws', exact: true });
      const recentBtnExists = await recentBtn.isVisible().catch(() => false);
      if (recentBtnExists) {
        await recentBtn.click();
        // Wait for the library tree to populate.
        await page.waitForSelector('text=Resistors_KSL', { timeout: 5000 }).catch(() => {
          console.warn('[screenshot] Library tree did not populate in time — capturing anyway');
        });
        // Also click the first library to show components in the middle pane.
        const resistorsBtn = page.getByRole('button', { name: /Resistors_KSL/ }).first();
        await resistorsBtn.click().catch(() => {});
        await page.waitForTimeout(400);
      } else {
        console.warn('[screenshot] Recent workspace button not visible — capturing empty state');
      }
    }
  }

  // Build filename: <route-safe>[-<room>].png
  const routeSafe = route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'index';
  const suffix = room ? `-${room}` : '';
  const filename = `${routeSafe}${suffix}.png`;

  await page.screenshot({ path: path.join(outDir, filename), fullPage: true });
  console.log(`Saved ${path.join(outDir, filename)}`);
});
