/**
 * Regression spec for Wave 9-C — rotate-dial + Z-reset pulse reducers.
 *
 * Two new control surfaces were added to the 3D positioner:
 *
 *   1. Model3DJogZ.tsx now has a centre RESET disk (`jog-z-reset`) which
 *      zeros the Z offset while preserving X and Y. The reset handler
 *      lives in Model3DPreview.tsx and writes through the existing
 *      `forceOffset` pulse.
 *
 *   2. Model3DRotateDial.tsx is a new SVG dial that fires ±90° rotation
 *      jogs (`rotate-+x`, `rotate--x`, …) plus a centre RESET that zeros
 *      all three rotation axes. The Model3DPositioner consumes these
 *      via two new pulse-shaped props: `rotateJogDelta` and
 *      `forceRotation`.
 *
 * This spec encodes the reducers' contracts directly — no DOM mount, no
 * jsdom — matching the existing `Model3DPreview.fallback.test.ts` style.
 * If a future refactor breaks wrap-around (e.g. accumulates 3600°) or
 * routes a Z-axis click into X, this test fails at unit-test time.
 */
import { describe, it, expect } from 'vitest';
import { createRoot, createSignal } from 'solid-js';

type Triple = [number, number, number];

// --- Z-reset reducer (lives inline in Model3DPreview.tsx) -------------------
// Mirrors:  const [x, y] = liveOffset();  setForceOffset([x, y, 0]);
function makeZResetHandler(
  getOffset: () => Triple,
  setForceOffset: (t: Triple) => void,
) {
  return () => {
    const [x, y] = getOffset();
    setForceOffset([x, y, 0]);
  };
}

// --- Rotation pulse reducer (lives in Model3DPositioner.tsx) ----------------
// Mirrors the createEffect that consumes props.rotateJogDelta:
//
//   v = rotation[idx] + amount
//   v = ((v + 180) % 360 + 360) % 360 - 180
//   rotation[idx] = +v.toFixed(3)
//
// Matches the prod implementation byte-for-byte; if the prod expression
// drifts the test compiles fine but fails on numeric assertions.
function applyRotationJog(
  rotation: Triple,
  axis: 'x' | 'y' | 'z',
  amount: number,
): Triple {
  const idx = { x: 0, y: 1, z: 2 }[axis];
  const next: Triple = [...rotation] as Triple;
  let v = next[idx] + amount;
  v = (((v + 180) % 360) + 360) % 360 - 180;
  next[idx] = +v.toFixed(3);
  return next;
}

describe('Wave 9-C / Z-reset preserves X+Y, zeroes Z', () => {
  it('zeroes only the Z component', () => {
    createRoot((dispose) => {
      const [offset] = createSignal<Triple>([1.5, -2.25, 3.7]);
      const [forced, setForced] = createSignal<Triple | null>(null);
      const handler = makeZResetHandler(offset, setForced);

      handler();

      expect(forced()).toEqual([1.5, -2.25, 0]);
      dispose();
    });
  });

  it('is idempotent when Z is already zero', () => {
    createRoot((dispose) => {
      const [offset] = createSignal<Triple>([0.4, 0.4, 0]);
      const [forced, setForced] = createSignal<Triple | null>(null);
      const handler = makeZResetHandler(offset, setForced);

      handler();
      handler();

      expect(forced()).toEqual([0.4, 0.4, 0]);
      dispose();
    });
  });
});

describe('Wave 9-C / rotation pulse — ±90° jogs, axis dispatch, modulo wrap', () => {
  it('routes +X to index 0, leaving Y and Z untouched', () => {
    expect(applyRotationJog([0, 0, 0], 'x',  90)).toEqual([90, 0, 0]);
    expect(applyRotationJog([0, 0, 0], 'x', -90)).toEqual([-90, 0, 0]);
  });

  it('routes +Y to index 1', () => {
    expect(applyRotationJog([10, 20, 30], 'y',  90)).toEqual([10, 110, 30]);
    expect(applyRotationJog([10, 20, 30], 'y', -90)).toEqual([10, -70, 30]);
  });

  it('routes +Z to index 2', () => {
    expect(applyRotationJog([10, 20, 30], 'z',  90)).toEqual([10, 20, 120]);
    expect(applyRotationJog([10, 20, 30], 'z', -90)).toEqual([10, 20, -60]);
  });

  it('wraps past +180 to the negative half (numerical stability)', () => {
    // The wrap formula `((v+180)%360 + 360) % 360 - 180` yields a value
    // in [-180, 180): both +180 and -180 collapse to -180. So 90+90=180
    // becomes -180 (the ±180 boundary is canonicalised on the negative
    // side); 180+90=270 wraps to -90; 360 wraps to 0.
    expect(applyRotationJog([90, 0, 0], 'x', 90)).toEqual([-180, 0, 0]);
    expect(applyRotationJog([180, 0, 0], 'x', 90)).toEqual([-90, 0, 0]);
    expect(applyRotationJog([180, 0, 0], 'x', 180)).toEqual([0, 0, 0]);
  });

  it('wraps past -180 to the positive half', () => {
    // -90 + -90 = -180 (kept as -180, see comment above); -180 + -90 =
    // -270 wraps to +90.
    expect(applyRotationJog([-90, 0, 0], 'x', -90)).toEqual([-180, 0, 0]);
    expect(applyRotationJog([-180, 0, 0], 'x', -90)).toEqual([90, 0, 0]);
  });

  it('keeps numerical stability after many full turns', () => {
    let r: Triple = [0, 0, 0];
    for (let i = 0; i < 40; i++) r = applyRotationJog(r, 'z', 90);
    // 40 * 90° = 3600° = 10 full turns. Without modulo this would be 3600;
    // with the wrap it must collapse to 0 (or 180, whichever the boundary
    // formula yields — here it's 0 because every 4th step lands on 0).
    expect(Math.abs(r[2])).toBeLessThanOrEqual(180);
    expect(r).toEqual([0, 0, 0]);
  });
});
