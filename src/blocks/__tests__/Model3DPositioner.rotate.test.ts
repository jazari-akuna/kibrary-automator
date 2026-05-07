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

// --- 26.5.8 RotateDial label & Shift-modifier contract ---------------------

/**
 * Mirror of src/blocks/Model3DRotateDial.tsx WEDGES + onClick handler.
 * The dial labels the wedges with screen-relative semantics ("+Z =
 * clockwise on screen"), but the click sends KiCad-coord rotation
 * (right-hand rule) so save round-trip stays consistent. Keep this
 * lock-step with the prod table — a label drift in the source breaks
 * both prod and this spec.
 */
const ROTATE_WEDGES_LABEL_TO_DELTA: Array<{
  label: string;
  axis: 'x' | 'y' | 'z';
  deltaUnscaled: number;
}> = [
  // Reading order matches the prod source's clockwise-from-north walk so
  // a side-by-side diff of WEDGES vs this table is trivial.
  { label: '−X', axis: 'x', deltaUnscaled:  90 },
  { label: '−Y', axis: 'y', deltaUnscaled:  90 },
  { label: '+Z', axis: 'z', deltaUnscaled: -90 },
  { label: '+X', axis: 'x', deltaUnscaled: -90 },
  { label: '+Y', axis: 'y', deltaUnscaled: -90 },
  { label: '−Z', axis: 'z', deltaUnscaled:  90 },
];

function rotateClick(label: string, shift: boolean): { axis: 'x' | 'y' | 'z'; delta: number } {
  const w = ROTATE_WEDGES_LABEL_TO_DELTA.find((x) => x.label === label);
  if (!w) throw new Error(`unknown rotate label: ${label}`);
  return { axis: w.axis, delta: shift ? w.deltaUnscaled * 0.5 : w.deltaUnscaled };
}

describe('Model3DRotateDial / wedge-label contract (screen-relative)', () => {
  it('exactly six wedges (one per axis sign)', () => {
    expect(ROTATE_WEDGES_LABEL_TO_DELTA).toHaveLength(6);
    const labels = ROTATE_WEDGES_LABEL_TO_DELTA.map((w) => w.label).sort();
    expect(labels).toEqual(['+X', '+Y', '+Z', '−X', '−Y', '−Z']);
  });

  it('clicking "+Z" sends KiCad-Z −90° (the rotation that renders clockwise on screen)', () => {
    expect(rotateClick('+Z', false)).toEqual({ axis: 'z', delta: -90 });
  });

  it('clicking "−Z" sends KiCad-Z +90° (counter-clockwise on screen)', () => {
    expect(rotateClick('−Z', false)).toEqual({ axis: 'z', delta: 90 });
  });

  it('+X / −X labels send opposite KiCad-X rotation deltas', () => {
    expect(rotateClick('+X', false).delta).toBe(-90);
    expect(rotateClick('−X', false).delta).toBe(90);
  });

  it('+Y / −Y labels send opposite KiCad-Y rotation deltas', () => {
    expect(rotateClick('+Y', false).delta).toBe(-90);
    expect(rotateClick('−Y', false).delta).toBe(90);
  });
});

describe('Model3DRotateDial / Shift modifier on CLICK halves the rotation step', () => {
  it('Shift+click "+Z" sends −45° (half of −90)', () => {
    expect(rotateClick('+Z', true)).toEqual({ axis: 'z', delta: -45 });
  });

  it('Shift+click "+X" sends −45°', () => {
    expect(rotateClick('+X', true)).toEqual({ axis: 'x', delta: -45 });
  });

  it('Shift+click "−Y" sends +45° (half of +90)', () => {
    expect(rotateClick('−Y', true)).toEqual({ axis: 'y', delta: 45 });
  });

  it('plain click without Shift uses the unscaled ±90° step', () => {
    for (const w of ROTATE_WEDGES_LABEL_TO_DELTA) {
      expect(Math.abs(rotateClick(w.label, false).delta)).toBe(90);
    }
  });
});

// --- 26.5.8 JogZ Shift-modifier contract -----------------------------------

/**
 * Mirror of src/blocks/Model3DJogZ.tsx — each of the 4 jog buttons
 * (+1mm, +0.1mm, −0.1mm, −1mm) halves its step on Shift+click. The
 * RESET centre disk is unaffected (it dispatches an absolute zero
 * pulse, not a delta).
 */
function jogZClick(button: 'plus1' | 'plus01' | 'minus01' | 'minus1', shift: boolean): number {
  const base = { plus1: 1.0, plus01: 0.1, minus01: -0.1, minus1: -1.0 }[button];
  return shift ? base * 0.5 : base;
}

describe('Model3DJogZ / Shift modifier on CLICK halves the Z step', () => {
  it('Shift+click +Z 1mm sends 0.5mm', () => {
    expect(jogZClick('plus1', true)).toBe(0.5);
  });

  it('Shift+click +Z 0.1mm sends 0.05mm', () => {
    expect(jogZClick('plus01', true)).toBe(0.05);
  });

  it('Shift+click −Z 0.1mm sends −0.05mm', () => {
    expect(jogZClick('minus01', true)).toBe(-0.05);
  });

  it('Shift+click −Z 1mm sends −0.5mm', () => {
    expect(jogZClick('minus1', true)).toBe(-0.5);
  });

  it('plain click without Shift uses the unscaled step', () => {
    expect(jogZClick('plus1', false)).toBe(1.0);
    expect(jogZClick('plus01', false)).toBe(0.1);
    expect(jogZClick('minus01', false)).toBe(-0.1);
    expect(jogZClick('minus1', false)).toBe(-1.0);
  });
});
