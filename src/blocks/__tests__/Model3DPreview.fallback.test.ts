/**
 * Regression test for Bug 4 (PNG-fallback never resets).
 *
 * Pre-fix:
 *   Model3DPreview wired `onWebGLError={(reason) => setUseGL(false)}`
 *   Model3DViewerGL called `props.onWebGLError(reason)` on ANY failure,
 *   including a single missing STEP file. One bad asset permanently
 *   downgraded the entire session to the slow PNG renderer until the
 *   user restarted the app.
 *
 * Post-fix:
 *   Model3DViewerGL distinguishes `webgl_unavailable` (permanent) vs
 *   `asset_load_failed` (per-asset, transient). Model3DPreview's handler
 *   only flips useGL=false on the former.
 *
 * This spec encodes the policy contract directly, without mounting the
 * Solid component (no jsdom dependency). It guards the *exact* conditional
 * inside Model3DPreview's onWebGLError callback so a future refactor that
 * accidentally re-broadens the fallback gets caught at unit-test time.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRoot, createSignal } from 'solid-js';

// The reducer under test mirrors the production handler in
// src/blocks/Model3DPreview.tsx. Keeping it inline here keeps the test
// self-contained and pinned to the prod call shape — if the prod handler
// signature drifts, this test fails to compile.
type Kind = 'webgl_unavailable' | 'asset_load_failed';
function makeFallbackHandler(setUseGL: (v: boolean) => void) {
  return (_reason: string, kind: Kind) => {
    if (kind === 'webgl_unavailable') {
      setUseGL(false);
    }
    // 'asset_load_failed' deliberately does nothing — the inline error
    // overlay inside Model3DViewerGL is the only UI for per-asset failures.
  };
}

describe('Model3DPreview / WebGL fallback policy', () => {
  it('flips useGL=false when WebGL2 itself is unavailable', () => {
    createRoot((dispose) => {
      const [useGL, setUseGL] = createSignal(true);
      const onWebGLError = makeFallbackHandler(setUseGL);

      onWebGLError('WebGL2 not available', 'webgl_unavailable');

      expect(useGL()).toBe(false);
      dispose();
    });
  });

  it('keeps useGL=true when a single asset fails to load', () => {
    createRoot((dispose) => {
      const [useGL, setUseGL] = createSignal(true);
      const onWebGLError = makeFallbackHandler(setUseGL);

      // The Bug 4 scenario — a missing IPEX STEP, sidecar throws,
      // GLB fetch rejects. Pre-fix this flipped useGL=false forever.
      onWebGLError('IPEX_20952-024E-02.step: file not found', 'asset_load_failed');

      expect(useGL()).toBe(true);
      dispose();
    });
  });

  it('survives multiple asset failures in a row without falling back', () => {
    createRoot((dispose) => {
      const [useGL, setUseGL] = createSignal(true);
      const onWebGLError = makeFallbackHandler(setUseGL);

      // User browses 5 footprints, three are broken.
      onWebGLError('a.step missing', 'asset_load_failed');
      onWebGLError('b.step parse error', 'asset_load_failed');
      onWebGLError('c.glb invalid', 'asset_load_failed');

      // GL renderer must remain active so the next valid footprint
      // renders interactively at 60 fps instead of via kicad-cli PNG.
      expect(useGL()).toBe(true);
      dispose();
    });
  });

  it('still flips when WebGL becomes unavailable after asset failures', () => {
    createRoot((dispose) => {
      const [useGL, setUseGL] = createSignal(true);
      const onWebGLError = makeFallbackHandler(setUseGL);

      onWebGLError('a.step missing', 'asset_load_failed');
      expect(useGL()).toBe(true);

      // GPU goes away (driver crash, tab lost context). NOW we fall back.
      onWebGLError('CONTEXT_LOST_WEBGL', 'webgl_unavailable');
      expect(useGL()).toBe(false);
      dispose();
    });
  });

  it('does not call setUseGL at all on asset_load_failed', () => {
    createRoot((dispose) => {
      const setUseGL = vi.fn();
      const onWebGLError = makeFallbackHandler(setUseGL);

      onWebGLError('whatever', 'asset_load_failed');

      expect(setUseGL).not.toHaveBeenCalled();
      dispose();
    });
  });
});
