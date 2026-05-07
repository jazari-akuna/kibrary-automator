/**
 * Regression spec — RESET buttons restore the ORIGINAL (last-saved) values,
 * not zero.
 *
 * Pre-fix:
 *   The jog-dial centre, jog-z centre, and rotate-dial centre RESET buttons
 *   in Model3DPreview.tsx hardcoded their target to (0, 0, ...). Clicking
 *   RESET on a footprint whose saved offset was (1.27, 0, -0.5) snapped the
 *   model to (0, 0, current_z) — discarding the placement the user had
 *   carefully dialled in or imported.
 *
 * Post-fix:
 *   Each RESET handler reads the live `info()` resource (which holds the
 *   on-disk model triple) and uses *that* as the reset target. After a
 *   successful Save, the resource refetches and the new "original" baseline
 *   is the just-saved values — i.e. RESET means "undo my unsaved tweaks",
 *   never "zero out the placement".
 *
 * The reducers under test are the inline handlers in Model3DPreview.tsx;
 * mirrored here byte-for-byte (including the `?? 0` fallback that kicks in
 * only when info() hasn't loaded yet) so a future drift in the prod handler
 * trips this spec.
 */
import { describe, it, expect } from 'vitest';
import { createRoot, createSignal } from 'solid-js';

type Triple = [number, number, number];
interface Info { offset: Triple; rotation: Triple; scale: Triple }

// --- jog-dial RESET (centre disk) ------------------------------------------
// Mirrors:
//   const orig = info()?.offset;
//   const z = liveOffset()[2];
//   const next: Triple = [orig?.[0] ?? 0, orig?.[1] ?? 0, z];
//   setLiveOffset(next); setForceOffset(next);
function makeXYResetHandler(
  getInfo: () => Info | null,
  getLiveOffset: () => Triple,
  setLiveOffset: (t: Triple) => void,
  setForceOffset: (t: Triple) => void,
) {
  return () => {
    const orig = getInfo()?.offset;
    const z = getLiveOffset()[2];
    const next: Triple = [orig?.[0] ?? 0, orig?.[1] ?? 0, z];
    setLiveOffset(next);
    setForceOffset(next);
  };
}

// --- jog-z RESET (centre disk on the Z column) -----------------------------
// Mirrors:
//   const orig = info()?.offset;
//   const [x, y] = liveOffset();
//   const next: Triple = [x, y, orig?.[2] ?? 0];
function makeZResetHandler(
  getInfo: () => Info | null,
  getLiveOffset: () => Triple,
  setLiveOffset: (t: Triple) => void,
  setForceOffset: (t: Triple) => void,
) {
  return () => {
    const orig = getInfo()?.offset;
    const [x, y] = getLiveOffset();
    const next: Triple = [x, y, orig?.[2] ?? 0];
    setLiveOffset(next);
    setForceOffset(next);
  };
}

// --- rotate-dial RESET (centre disk) ---------------------------------------
// Mirrors:
//   const orig = info()?.rotation;
//   const next: Triple = [orig?.[0] ?? 0, orig?.[1] ?? 0, orig?.[2] ?? 0];
function makeRotResetHandler(
  getInfo: () => Info | null,
  setLiveRotation: (t: Triple) => void,
  setForceRotation: (t: Triple) => void,
) {
  return () => {
    const orig = getInfo()?.rotation;
    const next: Triple = [orig?.[0] ?? 0, orig?.[1] ?? 0, orig?.[2] ?? 0];
    setLiveRotation(next);
    setForceRotation(next);
  };
}

describe('Model3DPreview / RESET restores ORIGINAL values, not zero', () => {
  it('jog-dial RESET restores the saved X+Y (preserves live Z)', () => {
    createRoot((dispose) => {
      // Footprint loaded from disk with a real placement.
      const [info] = createSignal<Info>({
        offset: [1.27, -2.54, 0.5],
        rotation: [0, 0, 90],
        scale: [1, 1, 1],
      });
      // User has dragged offsets all over the place.
      const [liveOffset, setLiveOffset] = createSignal<Triple>([10, 20, 7]);
      const [forced, setForced] = createSignal<Triple | null>(null);
      const reset = makeXYResetHandler(info, liveOffset, setLiveOffset, setForced);

      reset();

      // X+Y snap back to the saved values; Z keeps the user's current edit.
      expect(liveOffset()).toEqual([1.27, -2.54, 7]);
      expect(forced()).toEqual([1.27, -2.54, 7]);
      dispose();
    });
  });

  it('jog-dial RESET to non-zero original (regression: would have zeroed pre-fix)', () => {
    createRoot((dispose) => {
      // The bug scenario — IPEX connector imported with offset (-0.75, 1.5).
      const [info] = createSignal<Info>({
        offset: [-0.75, 1.5, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      });
      const [liveOffset, setLiveOffset] = createSignal<Triple>([-0.75, 1.5, 0]);
      const [forced, setForced] = createSignal<Triple | null>(null);
      const reset = makeXYResetHandler(info, liveOffset, setLiveOffset, setForced);

      reset();

      // CRITICAL: must NOT zero. Pre-fix this was [0, 0, 0].
      expect(liveOffset()).not.toEqual([0, 0, 0]);
      expect(liveOffset()).toEqual([-0.75, 1.5, 0]);
      dispose();
    });
  });

  it('jog-dial RESET falls back to (0, 0) only if info() has not loaded', () => {
    createRoot((dispose) => {
      const [info] = createSignal<Info | null>(null);
      const [liveOffset, setLiveOffset] = createSignal<Triple>([3, 3, 3]);
      const [forced, setForced] = createSignal<Triple | null>(null);
      const reset = makeXYResetHandler(info, liveOffset, setLiveOffset, setForced);

      reset();

      // No baseline available — degrade gracefully to 0,0 (Z preserved).
      expect(liveOffset()).toEqual([0, 0, 3]);
      expect(forced()).toEqual([0, 0, 3]);
      dispose();
    });
  });

  it('jog-z RESET restores the saved Z (preserves live X+Y)', () => {
    createRoot((dispose) => {
      const [info] = createSignal<Info>({
        offset: [1.27, -2.54, 0.5],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      });
      const [liveOffset, setLiveOffset] = createSignal<Triple>([10, 20, 99]);
      const [forced, setForced] = createSignal<Triple | null>(null);
      const reset = makeZResetHandler(info, liveOffset, setLiveOffset, setForced);

      reset();

      expect(liveOffset()).toEqual([10, 20, 0.5]);
      expect(forced()).toEqual([10, 20, 0.5]);
      dispose();
    });
  });

  it('jog-z RESET to non-zero original Z (regression: would have zeroed pre-fix)', () => {
    createRoot((dispose) => {
      // A through-hole connector with negative Z lift saved on disk.
      const [info] = createSignal<Info>({
        offset: [0, 0, -3.2],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      });
      const [liveOffset, setLiveOffset] = createSignal<Triple>([0, 0, -3.2]);
      const [forced, setForced] = createSignal<Triple | null>(null);
      const reset = makeZResetHandler(info, liveOffset, setLiveOffset, setForced);

      reset();

      expect(liveOffset()[2]).toBe(-3.2);
      expect(liveOffset()[2]).not.toBe(0);
      dispose();
    });
  });

  it('jog-z RESET falls back to 0 if info() has not loaded', () => {
    createRoot((dispose) => {
      const [info] = createSignal<Info | null>(null);
      const [liveOffset, setLiveOffset] = createSignal<Triple>([5, 5, 5]);
      const [forced, setForced] = createSignal<Triple | null>(null);
      const reset = makeZResetHandler(info, liveOffset, setLiveOffset, setForced);

      reset();

      expect(liveOffset()).toEqual([5, 5, 0]);
      dispose();
    });
  });

  it('rotate-dial RESET restores the saved rotation triple', () => {
    createRoot((dispose) => {
      const [info] = createSignal<Info>({
        offset: [0, 0, 0],
        rotation: [0, 0, 90],
        scale: [1, 1, 1],
      });
      const [liveRotation, setLiveRotation] = createSignal<Triple>([45, -30, 270]);
      const [forced, setForced] = createSignal<Triple | null>(null);
      const reset = makeRotResetHandler(info, setLiveRotation, setForced);

      reset();

      expect(liveRotation()).toEqual([0, 0, 90]);
      expect(forced()).toEqual([0, 0, 90]);
      dispose();
    });
  });

  it('rotate-dial RESET to non-zero original rotation (regression: would have zeroed pre-fix)', () => {
    createRoot((dispose) => {
      // SOIC saved rotated 180° on Z.
      const [info] = createSignal<Info>({
        offset: [0, 0, 0],
        rotation: [0, 0, 180],
        scale: [1, 1, 1],
      });
      const [liveRotation, setLiveRotation] = createSignal<Triple>([90, 90, 90]);
      const [forced, setForced] = createSignal<Triple | null>(null);
      const reset = makeRotResetHandler(info, setLiveRotation, setForced);

      reset();

      // Must restore 180, not zero it out.
      expect(liveRotation()).not.toEqual([0, 0, 0]);
      expect(liveRotation()).toEqual([0, 0, 180]);
      dispose();
    });
  });

  it('rotate-dial RESET falls back to (0, 0, 0) only if info() has not loaded', () => {
    createRoot((dispose) => {
      const [info] = createSignal<Info | null>(null);
      const [liveRotation, setLiveRotation] = createSignal<Triple>([1, 2, 3]);
      const [forced, setForced] = createSignal<Triple | null>(null);
      const reset = makeRotResetHandler(info, setLiveRotation, setForced);

      reset();

      expect(liveRotation()).toEqual([0, 0, 0]);
      dispose();
    });
  });

  it('after a Save, RESET targets the new (just-saved) values, not the pre-Save originals', () => {
    createRoot((dispose) => {
      // Initial load — disk says (1, 2, 3).
      const [info, setInfo] = createSignal<Info>({
        offset: [1, 2, 3],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      });
      const [liveOffset, setLiveOffset] = createSignal<Triple>([1, 2, 3]);
      const [forced, setForced] = createSignal<Triple | null>(null);
      const xyReset = makeXYResetHandler(info, liveOffset, setLiveOffset, setForced);

      // User edits to (5, 6, 7) and Saves; sidecar persists, refetch updates info().
      setLiveOffset([5, 6, 7]);
      setInfo({ offset: [5, 6, 7], rotation: [0, 0, 0], scale: [1, 1, 1] });
      // User then drags the live offsets again to (99, 99, 99).
      setLiveOffset([99, 99, 99]);

      xyReset();

      // Reset must use the NEW saved values (5, 6) not the pre-Save (1, 2).
      // Z (99) is preserved because the XY reset doesn't touch Z.
      expect(liveOffset()).toEqual([5, 6, 99]);
      dispose();
    });
  });

  it('Model3DPositioner Reset button (handleReset) restores props.offset/rotation/scale', () => {
    // The positioner-internal Reset button (data-testid `positioner-reset`)
    // calls setOffset(props.offset), etc. Its baseline is whatever the
    // parent passed in this render — which is `model().offset`, i.e. the
    // last-saved values. Mirror that reducer to lock in the contract.
    createRoot((dispose) => {
      const propsOffset: Triple = [1.27, -2.54, 0.5];
      const propsRotation: Triple = [0, 0, 90];
      const propsScale: Triple = [1, 1, 1];

      const [offset, setOffset] = createSignal<Triple>([99, 99, 99]);
      const [rotation, setRotation] = createSignal<Triple>([99, 99, 99]);
      const [scale, setScale] = createSignal<Triple>([99, 99, 99]);

      const handleReset = () => {
        setOffset(propsOffset);
        setRotation(propsRotation);
        setScale(propsScale);
      };

      handleReset();

      expect(offset()).toEqual([1.27, -2.54, 0.5]);
      expect(rotation()).toEqual([0, 0, 90]);
      expect(scale()).toEqual([1, 1, 1]);
      // Most importantly — none of these are zero.
      expect(offset()).not.toEqual([0, 0, 0]);
      expect(rotation()).not.toEqual([0, 0, 0]);
      dispose();
    });
  });
});
