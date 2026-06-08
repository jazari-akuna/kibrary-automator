/**
 * KiCad ↔ three.js coordinate math — the single source of truth.
 * =============================================================================
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The 3D positioner translates/rotates/scales a component while the user drags
 * sliders, and the on-disk storage is in KiCad-PCB coordinates while the live
 * preview is in three.js world coordinates. The mapping between the two spaces
 * was settled empirically over many alpha releases (visual-verify on
 * `synthetic_pcb_named`), and the sign conventions were a recurring source of
 * regressions. This module extracts that math, verbatim, out of
 * `Model3DViewerGL.tsx` so the conventions live in ONE tested place.
 *
 * IMPORTANT: every function here PRESERVES the exact numeric behavior of the
 * viewer as of 26.5.8-alpha.7. The accompanying `coords.test.ts` encodes the
 * current outputs as a regression guard. Do NOT "fix" a sign here — if a sign
 * looks wrong, leave it and document the question (see the rotation-Y note).
 *
 * KiCad-PCB → three.js-world AXIS TABLE (translation)
 * ---------------------------------------------------
 * A +1 mm KiCad-axis jog moves the chip's world position by +0.001 m on the
 * listed world axis (units below):
 *
 *     KiCad +X  →  world +X    (no remap; both are "to the right")
 *     KiCad +Y  →  world −Z    (KiCad's "south on layout sheet" → world depth,
 *                               NEGATED to match how kicad-cli bakes the GLB:
 *                               KiCad Y=+1 lands at world −Z)
 *     KiCad +Z  →  world +Y    (KiCad's "out of board" lands on Y-up)
 *
 * KiCad-PCB → three.js-world AXIS TABLE (rotation)
 * ------------------------------------------------
 *     KiCad rX  →  world rX
 *     KiCad rY  →  world rZ      *** NOTE: NOT negated (see asymmetry) ***
 *     KiCad rZ  →  world rY
 *
 * THE TRANSLATION-vs-ROTATION-Y ASYMMETRY  (the historically dangerous part)
 * --------------------------------------------------------------------------
 * Translation Y flips sign:   dzWorld = −dyKicad      (KiCad +Y → world −Z)
 * Rotation    Y does NOT:     drzWorld =  dryKicad     (KiCad rY → world +rZ)
 *
 * Both Y components map onto the world Z axis (translation→position.z,
 * rotation→euler.z), but only the translation component is negated. This
 * asymmetry is the empirically-settled behavior that makes the on-disk KiCad
 * storage round-trip cleanly through kicad-cli; it was arrived at after the
 * alpha.3/alpha.6 thrash. It is preserved verbatim here.
 *   SUSPICIOUS-BUT-PRESERVED: mathematically one might expect a pure
 *   axis-relabel (KiCad Y→world Z) to use the SAME sign for both translation
 *   and rotation. It does not. This is left as-is on purpose — changing it is
 *   exactly the regression this refactor prevents. See coords.test.ts which
 *   pins both behaviors.
 *
 * UNIT SCALES
 * -----------
 *   translation : positioner emits MILLIMETRES; kicad-cli's GLB unit is
 *                 METRES, so we divide by 1000 (1 mm tick = 0.001 world units).
 *   rotation    : positioner emits DEGREES; three.js Euler is RADIANS, so we
 *                 multiply by Math.PI / 180.
 *   scale       : dimensionless ratio (live / saved); no unit conversion.
 *
 * SCALE AXIS SWAP
 * ---------------
 * Scale follows the same KiCad → world axis swap as translation BUT WITHOUT any
 * sign (a scale factor has no sign to flip):
 *     world.x = kicad.x
 *     world.y = kicad.z
 *     world.z = kicad.y
 * So a "scale Z" slider stretches the chip in its tall axis even though
 * kicad-cli's GLB calls that world Y.
 */

import * as THREE from 'three';

// -----------------------------------------------------------------------------
// Branded semantic types — prevent mixing millimetres with degrees with ratios.
// The brand is erased at runtime (it's a pure type-level tag); the constructor
// helpers exist purely to attach it at a call site without a cast.
// -----------------------------------------------------------------------------

/** A plain 3-tuple, the underlying shape of every coordinate triple here. */
export type Triple = readonly [number, number, number];

/** A translation offset in MILLIMETRES, KiCad-PCB axes. */
export type OffsetMM = Triple & { readonly __brand: 'OffsetMM' };

/** A rotation in DEGREES, KiCad-PCB axes. */
export type RotationDeg = Triple & { readonly __brand: 'RotationDeg' };

/** A rotation in RADIANS, KiCad-PCB axes (rarely needed at call sites). */
export type RotationRad = Triple & { readonly __brand: 'RotationRad' };

/** A dimensionless scale ratio (live / saved), KiCad-PCB axes. */
export type ScaleRatio = Triple & { readonly __brand: 'ScaleRatio' };

/** Construct a branded millimetre offset. */
export function offsetMM(x: number, y: number, z: number): OffsetMM {
  return [x, y, z] as unknown as OffsetMM;
}

/** Construct a branded degree rotation. */
export function rotationDeg(x: number, y: number, z: number): RotationDeg {
  return [x, y, z] as unknown as RotationDeg;
}

/** Construct a branded radian rotation. */
export function rotationRad(x: number, y: number, z: number): RotationRad {
  return [x, y, z] as unknown as RotationRad;
}

/** Construct a branded scale ratio. */
export function scaleRatio(x: number, y: number, z: number): ScaleRatio {
  return [x, y, z] as unknown as ScaleRatio;
}

// -----------------------------------------------------------------------------
// Unit-scale constants (named so the magic numbers are self-documenting).
// -----------------------------------------------------------------------------

/** Millimetres → world metres: kicad-cli's GLB is in metres. */
export const MM_TO_WORLD = 1 / 1000;

/** Degrees → radians for three.js Euler angles. */
export const DEG_TO_RAD = Math.PI / 180;

// -----------------------------------------------------------------------------
// Pure conversions — extracted verbatim from Model3DViewerGL.applyLiveDelta().
// -----------------------------------------------------------------------------

/**
 * KiCad-PCB translation delta (millimetres) → three.js world translation
 * (metres) as a Vector3.
 *
 * Mirrors applyLiveDelta verbatim:
 *   dxWorld =  dxKicad / 1000        (KiCad +X → world +X)
 *   dyWorld =  dzKicad / 1000        (KiCad +Z → world +Y)
 *   dzWorld = -dyKicad / 1000        (KiCad +Y → world −Z; matches kicad-cli bake)
 *
 * @param deltaMM  [dxKicad, dyKicad, dzKicad] in millimetres.
 */
export function kicadTranslationToWorld(deltaMM: Triple): THREE.Vector3 {
  const dxKicad = deltaMM[0] * MM_TO_WORLD;
  const dyKicad = deltaMM[1] * MM_TO_WORLD;
  const dzKicad = deltaMM[2] * MM_TO_WORLD;
  const dxWorld = dxKicad; // KiCad +X → world +X
  const dyWorld = dzKicad; // KiCad +Z → world +Y
  const dzWorld = -dyKicad; // KiCad +Y → world −Z (matches kicad-cli bake)
  return new THREE.Vector3(dxWorld, dyWorld, dzWorld);
}

/**
 * KiCad-PCB rotation delta (degrees) → three.js world Euler (radians, 'XYZ').
 *
 * Mirrors applyLiveDelta verbatim:
 *   drxWorld = drxKicad           (KiCad rX → world rX)
 *   dryWorld = drzKicad           (KiCad rZ → world rY)
 *   drzWorld = dryKicad           (KiCad rY → world rZ — NOT negated; see the
 *                                  asymmetry note at the top of this file)
 *
 * @param deltaDeg  [drxKicad, dryKicad, drzKicad] in degrees.
 */
export function kicadRotationToWorldEuler(deltaDeg: Triple): THREE.Euler {
  const drxKicad = deltaDeg[0] * DEG_TO_RAD;
  const dryKicad = deltaDeg[1] * DEG_TO_RAD;
  const drzKicad = deltaDeg[2] * DEG_TO_RAD;
  const drxWorld = drxKicad;
  const dryWorld = drzKicad;
  const drzWorld = dryKicad;
  return new THREE.Euler(drxWorld, dryWorld, drzWorld, 'XYZ');
}

/**
 * KiCad-PCB scale ratios → three.js world scale Vector3.
 *
 * Mirrors applyLiveDelta verbatim:
 *   sxW = sxK     (world.x = kicad.x)
 *   syW = szK     (world.y = kicad.z)
 *   szW = syK     (world.z = kicad.y)
 *
 * @param ratio  [sxK, syK, szK] dimensionless live/saved ratios.
 */
export function kicadScaleToWorld(ratio: Triple): THREE.Vector3 {
  const sxK = ratio[0];
  const syK = ratio[1];
  const szK = ratio[2];
  const sxW = sxK;
  const syW = szK;
  const szW = syK;
  return new THREE.Vector3(sxW, syW, szW);
}

/**
 * Compute the per-axis scale ratio (live / saved). Mirrors applyLiveDelta:
 * a zero saved value falls back to a ratio of 1 (avoid divide-by-zero / NaN).
 *
 * @param live   live scale triple, KiCad axes.
 * @param saved  saved baseline scale triple, KiCad axes.
 */
export function scaleRatioFrom(live: Triple, saved: Triple): Triple {
  return [
    saved[0] !== 0 ? live[0] / saved[0] : 1,
    saved[1] !== 0 ? live[1] / saved[1] : 1,
    saved[2] !== 0 ? live[2] / saved[2] : 1,
  ];
}

/**
 * Compose the full live-delta Matrix4 from world-space translation, rotation,
 * and scale — exactly as applyLiveDelta does:
 *
 *   new THREE.Matrix4().compose(
 *     offset,
 *     new THREE.Quaternion().setFromEuler(euler),
 *     scale,
 *   )
 *
 * @param offset    world translation (metres) — from kicadTranslationToWorld.
 * @param rotation  world Euler (radians, 'XYZ') — from kicadRotationToWorldEuler.
 * @param scale     world scale — from kicadScaleToWorld.
 */
export function composeDeltaMatrix(
  offset: THREE.Vector3,
  rotation: THREE.Euler,
  scale: THREE.Vector3,
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    offset,
    new THREE.Quaternion().setFromEuler(rotation),
    scale,
  );
}

/**
 * KiCad-axis-letter → world-space unit vector for the translation hover arrow.
 * Mirrors Model3DViewerGL.kicadAxisToWorld verbatim:
 *   KiCad +X → world +X        ( s, 0,  0)
 *   KiCad +Y → world −Z        ( 0, 0, -s)   (26.5.8-alpha.3: KiCad +Y → world −Z)
 *   KiCad +Z → world +Y        ( 0, s,  0)
 * `sign` flips the corresponding component.
 *
 * Note this is the UNIT-vector form (no /1000), used to point a ghost arrow;
 * the directions match kicadTranslationToWorld's signs.
 */
export function kicadAxisToWorld(axis: 'x' | 'y' | 'z', sign: '+' | '-'): THREE.Vector3 {
  const s = sign === '+' ? 1 : -1;
  switch (axis) {
    case 'x':
      return new THREE.Vector3(s, 0, 0);
    case 'y':
      return new THREE.Vector3(0, 0, -s); // 26.5.8-alpha.3: KiCad +Y → world −Z
    case 'z':
      return new THREE.Vector3(0, s, 0);
  }
}
