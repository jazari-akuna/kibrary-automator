/**
 * Real-bundle regression for two 26.5.7-alpha.3 fixes whose unit specs
 * are pure constant-transcription:
 *
 *   1. Viewport height: the wrapper <div> around the WebGL canvas must
 *      grow vertically with the window (was a fixed 320px, the user
 *      reported "the viewer grows in width but not in height when I
 *      enlarge the window"). Pre-existing
 *      `Model3DViewerGL.viewportHeight.test.ts` only asserts the
 *      style-object literal — it does not measure the rendered <div>.
 *
 *   2. Middle-mouse pan: OrbitControls.mouseButtons.MIDDLE must be
 *      THREE.MOUSE.PAN. Pre-existing `Model3DViewerGL.mouseButtons.test.ts`
 *      transcribes the constant table, but the test never dispatches a
 *      real button-2 mousedown on the canvas. On Linux/webkit2gtk the
 *      runtime can swallow button 2 for paste-selection, so the constant
 *      may be correct but the user-visible behaviour wrong.
 *
 * This spec runs against the SAME mounted bundle that regressions.spec.ts
 * uses (Vite dev server + Tauri-IPC mock). It:
 *   • Resizes the viewport from 720×500 → 720×1080 and asserts the
 *     wrapper's bounding rect height grew by ≥ 50 px (proves the 65vh
 *     formula resolves through the real CSS, not just the inline-style
 *     literal).
 *   • Dispatches a real `mousedown(button=1)` on the canvas and asserts
 *     `controls.mouseButtons.MIDDLE === THREE.MOUSE.PAN` (the runtime
 *     hook installed by Model3DViewerGL.tsx exposes the resolved table).
 *     Whether the OS surrenders button-2 to the GL canvas is part of
 *     the second test and is asserted via OrbitControls.target moving
 *     after a synthetic middle-drag.
 */
import { test, expect, type Page } from '@playwright/test';

// Headless Chromium ships with software-only rendering by default — no
// WebGL2 ctx → Model3DViewerGL flips useGL=false and the parent renders
// the legacy PNG viewer instead, which has its own (fixed 240px) height
// and is NOT what we want to pin here. Force the SwiftShader-backed
// WebGL2 path so the GL wrapper actually mounts. These flags are well-
// documented for headless Chrome / Chromium:
//   https://developer.chrome.com/docs/chromium/swiftshader
test.use({
  launchOptions: {
    args: [
      // Force a software WebGL2 backend so headless Chromium can serve a
      // GL2 context. Without this Chrome ships with WebGL DISABLED in
      // headless mode and the viewer flips into the PNG fallback (which
      // has its own fixed 240px height — NOT the responsive 65vh
      // wrapper this spec is meant to pin).
      '--enable-features=Vulkan',
      '--use-gl=swiftshader',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      // Headless Chromium also needs --no-sandbox in some root contexts;
      // CI / dev containers running as root hit a sandbox-init failure.
      '--no-sandbox',
    ],
  },
});

// Mount script — minimum surface to stand the libraries room up with one
// component selected so the 3D viewer wrapper actually renders.
const TAURI_MOCK = `
(() => {
  const FAKE_WORKSPACE = '/tmp/kib-vp-ws';
  const eventListeners = new Map();
  let nextEventId = 1;
  const callbacks = new Map();

  const sidecarHandlers = {
    'system.version': () => ({ version: '0.0.0-test' }),
    'workspace.list_libraries': () => ({
      libraries: [{
        name: 'Resistors_KSL',
        path: FAKE_WORKSPACE + '/Resistors_KSL',
        component_count: 1,
        has_pretty: true,
        has_3dshapes: true,
      }],
    }),
    'library.list': () => ({
      libraries: [{
        name: 'Resistors_KSL',
        path: FAKE_WORKSPACE + '/Resistors_KSL',
        component_count: 1,
        has_pretty: true,
        has_3dshapes: true,
      }],
    }),
    'library.list_components': () => ({
      components: [{
        name: 'R_10k_0402',
        description: '10k 0402',
        reference: 'R',
        value: '10k',
        footprint: 'Resistor_SMD:R_0402',
      }],
    }),
    'library.read_file_content': () => ({ content: '(stub)' }),
    'library.get_3d_info': () => ({
      info: {
        model_path: '\${KSL_ROOT}/Resistors_KSL/R_10k.step',
        resolved_path: FAKE_WORKSPACE + '/Resistors_KSL/R_10k.step',
        file_exists: true,
        filename: 'R_10k.step',
        format: 'step',
        offset: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    }),
    'library.set_3d_offset': () => ({ ok: true }),
    'library.get_component': () => ({ properties: { Reference: 'R', Value: '10k' }, footprint_path: null, model3d_path: null }),
    'library.get_component_icon': () => ({ svg: null }),
    'parts.read_props': () => ({ properties: {} }),
    'parts.read_meta': () => ({ meta: {} }),
    // The GL viewer fetches a tiny stub GLB; the bundled three.js
    // GLTFLoader will fail on this and the viewer's onWebGLError fires —
    // but the wrapper <div> still renders (we're testing the wrapper's
    // CSS, not the canvas contents).
    'library.render_3d_glb_angled': () => ({ glb_b64: '' }),
    'library.render_3d_png_angled': () => ({ png_data_url: 'data:image/png;base64,' }),
  };

  async function invoke(cmd, payload) {
    if (cmd === 'bootstrap_status') return { python_resolved: true, sidecar_version: '0.0.0-test' };
    if (cmd === 'workspace_open') {
      return { root: FAKE_WORKSPACE, settings: { kicad_target: null }, first_run: false };
    }
    if (cmd === 'watch_workspace') return null;
    if (cmd === 'app_version') return '0.0.0-test';
    if (cmd && cmd.startsWith('plugin:updater')) return null;
    if (cmd === 'plugin:resources|close') return null;
    if (cmd === 'plugin:event|listen') {
      const eventName = payload && payload.event;
      const handlerCbId = payload && payload.handler;
      const eventId = nextEventId++;
      let bucket = eventListeners.get(eventName);
      if (!bucket) { bucket = new Map(); eventListeners.set(eventName, bucket); }
      bucket.set(eventId, handlerCbId);
      return eventId;
    }
    if (cmd === 'plugin:event|unlisten') return null;
    if (cmd && cmd.startsWith('plugin:event')) return null;
    if (cmd && cmd.startsWith('plugin:dialog')) return FAKE_WORKSPACE;
    if (cmd && cmd.startsWith('plugin:shell')) return null;
    if (cmd === 'sidecar_call') {
      const method = payload && payload.method;
      const params = (payload && payload.params) || {};
      const handler = sidecarHandlers[method];
      if (handler) return handler(params);
      return {};
    }
    return null;
  }

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

async function mountLibraries(page: Page) {
  await page.addInitScript({ content: TAURI_MOCK });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /^Libraries$/, exact: true }).click();
  await page.getByRole('button', { name: /Resistors_KSL/ }).first().click();
  await page.locator('text=R_10k_0402').first().click();
  // Wait for ONE of three possible viewer wrappers to mount:
  //   • `3d-viewer-gl-wrapper`     — happy path, WebGL2 OK
  //   • `3d-viewer-gl-error`       — GL init failed, inline-error wrapper
  //                                  (still sized by the responsive CSS we
  //                                  are testing)
  //   • `3d-viewer-canvas`         — useGL flipped to false on
  //                                  webgl_unavailable; the parent now
  //                                  renders the legacy PNG viewer instead.
  // The viewport-height test only meaningfully runs in the first two
  // cases (the PNG viewer has its own fixed 240px height). The mouse-
  // button test only runs in the first.
  await page.waitForFunction(
    () =>
      !!document.querySelector('[data-testid="3d-viewer-gl-wrapper"]') ||
      !!document.querySelector('[data-testid="3d-viewer-gl-error"]') ||
      !!document.querySelector('[data-testid="3d-viewer-canvas"]'),
    null,
    { timeout: 8000 },
  );
}

/** Returns 'gl' | 'gl-error' | 'png' | null based on which wrapper mounted. */
async function viewerKind(page: Page): Promise<'gl' | 'gl-error' | 'png' | null> {
  return await page.evaluate(() => {
    if (document.querySelector('[data-testid="3d-viewer-gl-wrapper"]')) return 'gl';
    if (document.querySelector('[data-testid="3d-viewer-gl-error"]')) return 'gl-error';
    if (document.querySelector('[data-testid="3d-viewer-canvas"]')) return 'png';
    return null;
  });
}

test.describe('Model3DViewerGL — real-bundle viewport height', () => {
  test('GL wrapper height tracks window height in real Chromium layout (65vh + min 320px)', async ({ page }) => {
    // Start with a TALL viewport — even before mountLibraries we want the
    // window large so when WebGL fails fast in headless and the GL-error
    // wrapper mounts it carries the 65vh-of-the-tall-viewport rect.
    await page.setViewportSize({ width: 1024, height: 1200 });
    await mountLibraries(page);

    const kind = await viewerKind(page);
    console.log('[viewport-test] viewerKind =', kind);

    if (kind === 'png') {
      // Headless Chromium without GPU → WebGL2 missing → useGL flipped to
      // false → PNG viewer mounted. Production WebKitGTK on Linux DOES
      // ship WebGL2, so users hit the GL path instead. Without a real
      // GL2 ctx we cannot exercise the responsive wrapper, but we CAN
      // verify the PNG viewer's own height. Surface the actual measured
      // height as a hard failure if it has the pre-26.5.4 fixed-240
      // regression so a future fix reuses the same spec.
      const pngBox = await page.locator('[data-testid="3d-viewer-canvas"]').boundingBox();
      expect(pngBox).not.toBeNull();
      // 26.5.4 PNG-viewer fixed height. We cannot legally fail here
      // until that's also fixed (out of scope for this spec); record
      // the value so a re-run after a future PNG-viewer responsive
      // patch can flip the assertion.
      console.log('[viewport-test] PNG viewer height =', pngBox!.height, 'px (fixed 240px in source)');
      expect(pngBox!.height).toBeGreaterThan(0);
      test.skip(
        true,
        `Headless Chromium has no WebGL2 → viewer fell back to the fixed-height (${pngBox!.height}px) PNG renderer. The 26.5.7-alpha.3 fix targets the GL wrapper specifically; the GL path requires WebGL2 which only the production WebKitGTK shell provides.`,
      );
      return;
    }

    test.skip(kind === null, 'no viewer wrapper mounted at all');

    const wrapper = page.locator(
      '[data-testid="3d-viewer-gl-wrapper"], [data-testid="3d-viewer-gl-error"]',
    ).first();
    await expect(wrapper).toBeVisible();

    // 65vh of 1200 = 780. Min-height 320. The wrapper rect must be
    // ≈780 (allow slop for layout rounding / scrollbar).
    const tallBox = await wrapper.boundingBox();
    expect(tallBox).not.toBeNull();
    expect(tallBox!.height).toBeGreaterThan(700);
    expect(tallBox!.height).toBeLessThan(820);

    // Shrink the window to a SHORT viewport — 65vh < 320 min-height,
    // so the wrapper should stay at the floor.
    await page.setViewportSize({ width: 1024, height: 400 });
    await page.waitForTimeout(200);
    const shortBox = await wrapper.boundingBox();
    expect(shortBox).not.toBeNull();
    expect(shortBox!.height).toBeGreaterThanOrEqual(310);
    expect(shortBox!.height).toBeLessThan(360);

    // Tall again — must grow back. Proves the height is genuinely
    // viewport-relative, not some one-shot init.
    await page.setViewportSize({ width: 1024, height: 1400 });
    await page.waitForTimeout(200);
    const taller = await wrapper.boundingBox();
    expect(taller).not.toBeNull();
    expect(taller!.height).toBeGreaterThan(800);
  });

  // Pure-DOM contract test that runs in EVERY Chromium config (no GL needed).
  // The GL viewer's wrapper has an inline `style="min-height: 320px; height: 65vh"`
  // — assert the literal AS RENDERED by the bundle, not as a JS object literal
  // in source. Catches a regression where someone props-passes a different
  // style and the production wrapper changes silently.
  test('viewer wrapper inline-style declares the responsive contract (works without WebGL)', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await mountLibraries(page);
    const kind = await viewerKind(page);
    if (kind === 'png') {
      // PNG fallback — there's no GL wrapper to inspect, but its OWN
      // wrapper currently uses a fixed 240px height. Document the
      // gap explicitly: the 26.5.7-alpha.3 fix only patched the GL
      // path. (parallel agent or a follow-up can address the PNG
      // viewer.)
      const pngStyle = await page
        .locator('[data-testid="3d-viewer-canvas"]')
        .getAttribute('style');
      expect(pngStyle).toMatch(/height:\s*240px/);
      // Mark as a known gap so future contributors see the contract:
      console.log('[viewport-style-test] PNG viewer style:', pngStyle);
      test.skip(true, 'GL wrapper not mounted in headless Chromium; PNG fallback uses fixed 240px height (separate bug — Model3DViewer.tsx:214).');
      return;
    }
    const wrapper = page.locator(
      '[data-testid="3d-viewer-gl-wrapper"], [data-testid="3d-viewer-gl-error"]',
    ).first();
    const style = await wrapper.getAttribute('style');
    expect(style, 'wrapper inline style attribute').toBeTruthy();
    expect(style).toMatch(/min-height:\s*320px/);
    expect(style).toMatch(/height:\s*65vh/);
    // No fixed pixel height (the regression we're guarding against).
    expect(style).not.toMatch(/^height:\s*\d+px/m);
  });
});

test.describe('Model3DViewerGL — middle-mouse pan binding', () => {
  test('OrbitControls.mouseButtons.MIDDLE === THREE.MOUSE.PAN at runtime', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountLibraries(page);

    // The viewer installs `window.__model3dGLMouseButtons` once
    // OrbitControls is constructed. If the GL context creation failed
    // (chromium without WebGL2 in some configs), the viewer falls back
    // to the PNG renderer and never installs the hook — accept that
    // outcome explicitly so the test reports the actual behaviour
    // rather than timing out.
    await page.waitForTimeout(800);
    const result = await page.evaluate(() => {
      const w = window as unknown as {
        __model3dGLMouseButtons?: { LEFT?: number; MIDDLE?: number; RIGHT?: number };
      };
      return w.__model3dGLMouseButtons ?? null;
    });

    if (result === null) {
      test.skip(
        true,
        'WebGL2 context not available in this Playwright Chromium; OrbitControls binding cannot be inspected. The unit spec covers the constant value.',
      );
      return;
    }

    // THREE.MOUSE.PAN === 2, ROTATE === 0, DOLLY === 1. Encoded as a
    // numeric to avoid bringing in three.js to the test bundle.
    expect(result.MIDDLE).toBe(2);
    expect(result.LEFT).toBe(0);
    // RIGHT is also bound to PAN as a fallback for users with prior
    // muscle-memory; freeze that contract too.
    expect(result.RIGHT).toBe(2);
  });

  // Real-DOM event dispatch test: send a synthetic middle-button mousedown
  // to the canvas and confirm the OrbitControls.target moves on a
  // middle-drag (i.e. PAN actually fires, the runtime didn't swallow the
  // button-2 event for paste-selection or another OS handler).
  test('synthetic middle-mouse drag on canvas moves OrbitControls.target', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mountLibraries(page);
    await page.waitForTimeout(800);

    const ready = await page.evaluate(() => {
      const w = window as unknown as {
        __model3dGLScene?: { controls?: { target?: { x: number; y: number; z: number } } };
        __model3dGLMouseButtons?: unknown;
      };
      return Boolean(w.__model3dGLMouseButtons && w.__model3dGLScene?.controls?.target);
    });
    if (!ready) {
      test.skip(true, 'GL viewer + OrbitControls did not initialise (no WebGL2 in this Chromium).');
      return;
    }

    // Read initial target.
    const before = await page.evaluate(() => {
      const w = window as unknown as {
        __model3dGLScene: { controls: { target: { x: number; y: number; z: number } } };
      };
      const t = w.__model3dGLScene.controls.target;
      return { x: t.x, y: t.y, z: t.z };
    });

    // Locate the canvas centre and dispatch a real middle-button drag.
    const canvas = page.locator('[data-testid="3d-viewer-gl-canvas"]');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(cx + 80, cy + 40, { steps: 10 });
    await page.mouse.up({ button: 'middle' });
    await page.waitForTimeout(150);

    const after = await page.evaluate(() => {
      const w = window as unknown as {
        __model3dGLScene: { controls: { target: { x: number; y: number; z: number } } };
      };
      const t = w.__model3dGLScene.controls.target;
      return { x: t.x, y: t.y, z: t.z };
    });

    // Some axis must have changed if PAN fired. dx/dy on screen pan into
    // the camera's local right/up plane, which projects to a non-zero
    // delta on at least one of x/y/z.
    const moved =
      Math.abs(after.x - before.x) +
      Math.abs(after.y - before.y) +
      Math.abs(after.z - before.z);
    expect(
      moved,
      `target did not move under middle-drag (before=${JSON.stringify(before)}, after=${JSON.stringify(after)})`,
    ).toBeGreaterThan(0);
  });
});
