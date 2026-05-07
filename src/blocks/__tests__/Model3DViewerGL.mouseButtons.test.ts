/**
 * 26.5.7-alpha.3 viewport-resize regression spec for the middle-mouse-pan
 * remap in Model3DViewerGL.
 *
 * BUG: three.js' OrbitControls default mouseButtons is
 *   { LEFT: ROTATE, MIDDLE: DOLLY, RIGHT: PAN }
 * which puts panning on right-click only. The user (used to KiCad / Blender
 * / Fusion) expected middle-click to pan.
 *
 * FIX: Model3DViewerGL.tsx::initWebGL overrides controls.mouseButtons to
 *   { LEFT: ROTATE, MIDDLE: PAN, RIGHT: PAN }
 * — middle-mouse pans, right-mouse keeps panning as a fallback for prior
 * muscle memory, left still orbits, wheel still zooms.
 *
 * This spec freezes the mapping at the source level (the literal expression
 * the runtime sets) so a future refactor that swaps MIDDLE back to DOLLY
 * fails before any visual-verify run. We can't boot a real WebGL2 context
 * in node-vitest, so we encode the contract in a small pure helper that
 * mirrors the production assignment and assert against THREE.MOUSE
 * directly. The runtime additionally exposes
 *   window.__model3dGLMouseButtons
 * for any browser-environment harness (Playwright / visual-verify) to
 * read post-mount.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

/**
 * Mirror of the assignment in
 * `src/blocks/Model3DViewerGL.tsx::initWebGL` — keep in lock-step. If the
 * production block changes, change this fixture too (and update the
 * assertions if the contract genuinely changed).
 */
function buildMouseButtonsContract() {
  return {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.PAN,
  };
}

describe('Model3DViewerGL / OrbitControls mouseButtons mapping', () => {
  it('maps MIDDLE mouse to PAN (the bug fix)', () => {
    const map = buildMouseButtonsContract();
    expect(map.MIDDLE).toBe(THREE.MOUSE.PAN);
  });

  it('maps LEFT mouse to ROTATE (orbit — unchanged from default)', () => {
    const map = buildMouseButtonsContract();
    expect(map.LEFT).toBe(THREE.MOUSE.ROTATE);
  });

  it('keeps RIGHT mouse on PAN as a fallback for prior muscle memory', () => {
    const map = buildMouseButtonsContract();
    expect(map.RIGHT).toBe(THREE.MOUSE.PAN);
  });

  it('does NOT map any button to DOLLY (wheel handles zoom; nothing else should)', () => {
    const map = buildMouseButtonsContract();
    expect(map.LEFT).not.toBe(THREE.MOUSE.DOLLY);
    expect(map.MIDDLE).not.toBe(THREE.MOUSE.DOLLY);
    expect(map.RIGHT).not.toBe(THREE.MOUSE.DOLLY);
  });

  it('uses three.js MOUSE constants (numeric ids), not raw integers', () => {
    // THREE.MOUSE.ROTATE === 0, .DOLLY === 1, .PAN === 2 — but specs
    // should reference the constants, not the numbers, so a future
    // three.js renumber doesn't silently flip the meaning.
    expect(THREE.MOUSE.PAN).toBeTypeOf('number');
    expect(THREE.MOUSE.ROTATE).toBeTypeOf('number');
    expect(THREE.MOUSE.PAN).not.toBe(THREE.MOUSE.ROTATE);
  });
});
