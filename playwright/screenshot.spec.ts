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
          search_raph_io: { enabled: false, base_url: 'https://search.raph.io', api_key: '' },
        },
      };
    },

    'settings.set': function () { return {}; },
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

test('snapshot route', async ({ page }) => {
  fs.mkdirSync(outDir, { recursive: true });

  // Inject the Tauri mock before any page scripts execute.
  await page.addInitScript({ content: tauriInitScript });

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
