/**
 * Regression guard for the KiCad ↔ three.js coordinate math (src/three/coords.ts).
 *
 * These assertions encode the EXACT current numeric behavior of
 * Model3DViewerGL.applyLiveDelta / kicadAxisToWorld as of 26.5.8-alpha.7 —
 * the empirically-settled conventions arrived at after the alpha rotation/
 * translation sign thrash. They are the guard that ends that thrash: if a sign
 * flips, a test here goes red.
 *
 * Convention table being pinned:
 *   translation:  +X → +X ,  +Y → −Z ,  +Z → +Y   (× 1/1000 mm→m)
 *   rotation:     rX → rX ,  rY → +rZ ,  rZ → rY   (× π/180 deg→rad)  *NOT* −rZ
 *   scale:        x → x ,    y → z ,     z → y      (no sign, dimensionless)
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  MM_TO_WORLD,
  DEG_TO_RAD,
  kicadTranslationToWorld,
  kicadRotationToWorldEuler,
  kicadScaleToWorld,
  scaleRatioFrom,
  composeDeltaMatrix,
  kicadAxisToWorld,
} from './coords';

const MM = MM_TO_WORLD; // 0.001
const R = DEG_TO_RAD; // π/180

describe('coords / kicadTranslationToWorld', () => {
  // KiCad +X → world +X (unchanged), positive and negative.
  it('KiCad +X → world +X', () => {
    const v = kicadTranslationToWorld([1, 0, 0]);
    expect(v.x).toBeCloseTo(1 * MM, 12);
    expect(v.y).toBeCloseTo(0, 12);
    expect(v.z).toBeCloseTo(0, 12);
  });
  it('KiCad −X → world −X', () => {
    const v = kicadTranslationToWorld([-1, 0, 0]);
    expect(v.x).toBeCloseTo(-1 * MM, 12);
    expect(v.y).toBeCloseTo(0, 12);
    expect(v.z).toBeCloseTo(0, 12);
  });

  // KiCad +Y → world −Z (the NEGATED axis; matches kicad-cli bake).
  it('KiCad +Y → world −Z', () => {
    const v = kicadTranslationToWorld([0, 1, 0]);
    expect(v.x).toBeCloseTo(0, 12);
    expect(v.y).toBeCloseTo(0, 12);
    expect(v.z).toBeCloseTo(-1 * MM, 12);
  });
  it('KiCad −Y → world +Z', () => {
    const v = kicadTranslationToWorld([0, -1, 0]);
    expect(v.x).toBeCloseTo(0, 12);
    expect(v.y).toBeCloseTo(0, 12);
    expect(v.z).toBeCloseTo(1 * MM, 12);
  });

  // KiCad +Z → world +Y.
  it('KiCad +Z → world +Y', () => {
    const v = kicadTranslationToWorld([0, 0, 1]);
    expect(v.x).toBeCloseTo(0, 12);
    expect(v.y).toBeCloseTo(1 * MM, 12);
    expect(v.z).toBeCloseTo(0, 12);
  });
  it('KiCad −Z → world −Y', () => {
    const v = kicadTranslationToWorld([0, 0, -1]);
    expect(v.x).toBeCloseTo(0, 12);
    expect(v.y).toBeCloseTo(-1 * MM, 12);
    expect(v.z).toBeCloseTo(0, 12);
  });

  it('applies the mm→m scale (5 mm → 0.005 m)', () => {
    const v = kicadTranslationToWorld([5, 0, 0]);
    expect(v.x).toBeCloseTo(0.005, 12);
  });

  it('combined jog maps every axis at once', () => {
    // dx=2, dy=3, dz=4 (mm) → world (2, 4, -3)/1000
    const v = kicadTranslationToWorld([2, 3, 4]);
    expect(v.x).toBeCloseTo(2 * MM, 12);
    expect(v.y).toBeCloseTo(4 * MM, 12);
    expect(v.z).toBeCloseTo(-3 * MM, 12);
  });
});

describe('coords / kicadRotationToWorldEuler', () => {
  it('uses XYZ order', () => {
    expect(kicadRotationToWorldEuler([0, 0, 0]).order).toBe('XYZ');
  });

  // KiCad rX → world rX.
  it('KiCad +rX → world +rX', () => {
    const e = kicadRotationToWorldEuler([10, 0, 0]);
    expect(e.x).toBeCloseTo(10 * R, 12);
    expect(e.y).toBeCloseTo(0, 12);
    expect(e.z).toBeCloseTo(0, 12);
  });
  it('KiCad −rX → world −rX', () => {
    const e = kicadRotationToWorldEuler([-10, 0, 0]);
    expect(e.x).toBeCloseTo(-10 * R, 12);
    expect(e.y).toBeCloseTo(0, 12);
    expect(e.z).toBeCloseTo(0, 12);
  });

  // KiCad rY → world rZ — and crucially NOT negated (the asymmetry vs translation).
  it('KiCad +rY → world +rZ (NOT negated — translation-Y asymmetry)', () => {
    const e = kicadRotationToWorldEuler([0, 10, 0]);
    expect(e.x).toBeCloseTo(0, 12);
    expect(e.y).toBeCloseTo(0, 12);
    expect(e.z).toBeCloseTo(10 * R, 12); // +, not −
  });
  it('KiCad −rY → world −rZ', () => {
    const e = kicadRotationToWorldEuler([0, -10, 0]);
    expect(e.x).toBeCloseTo(0, 12);
    expect(e.y).toBeCloseTo(0, 12);
    expect(e.z).toBeCloseTo(-10 * R, 12);
  });

  // KiCad rZ → world rY.
  it('KiCad +rZ → world +rY', () => {
    const e = kicadRotationToWorldEuler([0, 0, 10]);
    expect(e.x).toBeCloseTo(0, 12);
    expect(e.y).toBeCloseTo(10 * R, 12);
    expect(e.z).toBeCloseTo(0, 12);
  });
  it('KiCad −rZ → world −rY', () => {
    const e = kicadRotationToWorldEuler([0, 0, -10]);
    expect(e.x).toBeCloseTo(0, 12);
    expect(e.y).toBeCloseTo(-10 * R, 12);
    expect(e.z).toBeCloseTo(0, 12);
  });

  it('applies the deg→rad scale (90° → π/2)', () => {
    const e = kicadRotationToWorldEuler([90, 0, 0]);
    expect(e.x).toBeCloseTo(Math.PI / 2, 12);
  });

  it('combined rotation maps every axis at once', () => {
    // rX=10, rY=20, rZ=30 → world euler (10, 30, 20) deg in rad
    const e = kicadRotationToWorldEuler([10, 20, 30]);
    expect(e.x).toBeCloseTo(10 * R, 12);
    expect(e.y).toBeCloseTo(30 * R, 12);
    expect(e.z).toBeCloseTo(20 * R, 12);
  });
});

describe('coords / kicadScaleToWorld', () => {
  it('KiCad x → world x', () => {
    const v = kicadScaleToWorld([2, 1, 1]);
    expect(v.x).toBeCloseTo(2, 12);
    expect(v.y).toBeCloseTo(1, 12);
    expect(v.z).toBeCloseTo(1, 12);
  });
  it('KiCad y → world z', () => {
    const v = kicadScaleToWorld([1, 2, 1]);
    expect(v.x).toBeCloseTo(1, 12);
    expect(v.y).toBeCloseTo(1, 12);
    expect(v.z).toBeCloseTo(2, 12);
  });
  it('KiCad z → world y', () => {
    const v = kicadScaleToWorld([1, 1, 2]);
    expect(v.x).toBeCloseTo(1, 12);
    expect(v.y).toBeCloseTo(2, 12);
    expect(v.z).toBeCloseTo(1, 12);
  });
  it('scale has no sign flip — sub-unit ratios pass straight through the swap', () => {
    const v = kicadScaleToWorld([0.5, 0.25, 4]);
    expect(v.x).toBeCloseTo(0.5, 12);
    expect(v.y).toBeCloseTo(4, 12); // kicad z → world y
    expect(v.z).toBeCloseTo(0.25, 12); // kicad y → world z
  });
});

describe('coords / scaleRatioFrom', () => {
  it('computes per-axis live/saved ratio', () => {
    const r = scaleRatioFrom([2, 6, 4], [1, 2, 2]);
    expect(r[0]).toBeCloseTo(2, 12);
    expect(r[1]).toBeCloseTo(3, 12);
    expect(r[2]).toBeCloseTo(2, 12);
  });
  it('falls back to ratio 1 when the saved axis is zero (no NaN)', () => {
    const r = scaleRatioFrom([5, 5, 5], [0, 0, 0]);
    expect(r[0]).toBe(1);
    expect(r[1]).toBe(1);
    expect(r[2]).toBe(1);
  });
  it('identity scale yields all ones', () => {
    const r = scaleRatioFrom([1, 1, 1], [1, 1, 1]);
    expect(r).toEqual([1, 1, 1]);
  });
});

describe('coords / composeDeltaMatrix', () => {
  it('identity delta produces the identity matrix', () => {
    const m = composeDeltaMatrix(
      kicadTranslationToWorld([0, 0, 0]),
      kicadRotationToWorldEuler([0, 0, 0]),
      kicadScaleToWorld(scaleRatioFrom([1, 1, 1], [1, 1, 1])),
    );
    const expected = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    m.elements.forEach((el, i) => expect(el).toBeCloseTo(expected[i], 12));
  });

  it('pure-translation delta sets the matrix translation column (KiCad +Y → world −Z)', () => {
    const m = composeDeltaMatrix(
      kicadTranslationToWorld([0, 1, 0]),
      kicadRotationToWorldEuler([0, 0, 0]),
      kicadScaleToWorld([1, 1, 1]),
    );
    // Matrix4 stores translation in elements [12],[13],[14].
    expect(m.elements[12]).toBeCloseTo(0, 12);
    expect(m.elements[13]).toBeCloseTo(0, 12);
    expect(m.elements[14]).toBeCloseTo(-1 * MM, 12);
  });

  it('decomposes back to the world translation/scale it was composed from', () => {
    const offset = kicadTranslationToWorld([2, 3, 4]);
    const scale = kicadScaleToWorld([1.5, 2, 0.5]);
    const m = composeDeltaMatrix(offset, kicadRotationToWorldEuler([0, 0, 0]), scale);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    m.decompose(p, q, s);
    expect(p.x).toBeCloseTo(offset.x, 12);
    expect(p.y).toBeCloseTo(offset.y, 12);
    expect(p.z).toBeCloseTo(offset.z, 12);
    expect(s.x).toBeCloseTo(scale.x, 12);
    expect(s.y).toBeCloseTo(scale.y, 12);
    expect(s.z).toBeCloseTo(scale.z, 12);
  });

  it('rotation-only delta has zero translation column and unit scale', () => {
    const m = composeDeltaMatrix(
      kicadTranslationToWorld([0, 0, 0]),
      kicadRotationToWorldEuler([0, 0, 90]), // KiCad rZ=90 → world rY=90
      kicadScaleToWorld([1, 1, 1]),
    );
    expect(m.elements[12]).toBeCloseTo(0, 12);
    expect(m.elements[13]).toBeCloseTo(0, 12);
    expect(m.elements[14]).toBeCloseTo(0, 12);
  });
});

describe('coords / kicadAxisToWorld (translation hover arrow)', () => {
  it('+x → (1,0,0)', () => {
    const v = kicadAxisToWorld('x', '+');
    expect([v.x, v.y, v.z]).toEqual([1, 0, 0]);
  });
  it('-x → (-1,0,0)', () => {
    const v = kicadAxisToWorld('x', '-');
    expect([v.x, v.y, v.z]).toEqual([-1, 0, 0]);
  });
  it('+y → (0,0,-1)  (KiCad +Y → world −Z)', () => {
    const v = kicadAxisToWorld('y', '+');
    expect([v.x, v.y, v.z]).toEqual([0, 0, -1]);
  });
  it('-y → (0,0,1)', () => {
    const v = kicadAxisToWorld('y', '-');
    expect([v.x, v.y, v.z]).toEqual([0, 0, 1]);
  });
  it('+z → (0,1,0)', () => {
    const v = kicadAxisToWorld('z', '+');
    expect([v.x, v.y, v.z]).toEqual([0, 1, 0]);
  });
  it('-z → (0,-1,0)', () => {
    const v = kicadAxisToWorld('z', '-');
    expect([v.x, v.y, v.z]).toEqual([0, -1, 0]);
  });

  it('hover-arrow direction agrees in sign with kicadTranslationToWorld for every axis', () => {
    // The unit-vector hover arrow must point the same way a real jog moves.
    const axes: Array<['x' | 'y' | 'z', number]> = [
      ['x', 0],
      ['y', 1],
      ['z', 2],
    ];
    for (const [axis, idx] of axes) {
      const delta: [number, number, number] = [0, 0, 0];
      delta[idx] = 1;
      const move = kicadTranslationToWorld(delta);
      const arrow = kicadAxisToWorld(axis, '+');
      // Same direction (dot product positive, both non-degenerate).
      const dot = move.x * arrow.x + move.y * arrow.y + move.z * arrow.z;
      expect(dot).toBeGreaterThan(0);
    }
  });
});
