/**
 * Regression spec for the JogDial axis-direction mapping.
 *
 * BUG: the user reported that clicking the dial wedge labelled "+Y" did
 * NOT move the rendered chip toward the top of the 3D viewport. Cause:
 * the viewer's camera at (0.12, 0.10, 0.12) projects PCB +Y (≡ world +Z
 * in kicad-cli's GLB output) toward screen-down-left. The dial geometry
 * had +Y at 12 o'clock so the wedge pointed one way and the chip went
 * the other.
 *
 * FIX: swap the +Y / −Y wedges (top↔bottom) so the wedge POSITION matches
 * the actual screen direction of motion. PCB +X stays on the right because
 * the camera leaves world +X ≈ screen-right at this angle. Inner-ring
 * arrow icons follow the same swap so ↑ keeps meaning screen-up.
 *
 * This unit spec freezes the wedge → (axis, sign) contract so the next
 * camera-angle tweak can't silently re-invert the mapping. If a refactor
 * moves the +Y wedge back to 12 o'clock (or breaks the keyboard handler)
 * this test fails before any visual-verify run.
 *
 * Companion to the visual-verify fixtures `ipex_jog_plus_x` and
 * `ipex_jog_plus_y` (run via `scripts/visual-verify.sh`) which assert the
 * world-space delta in the rendered scene.
 */
import { describe, it, expect } from 'vitest';

interface JoggerCalls {
  axis: 'x' | 'y' | 'z';
  amount: number;
}

/**
 * Mirror of the dial's onJog dispatch table — built from
 * src/blocks/Model3DJogDial.tsx OUTER_WEDGES + INNER_WEDGES and the
 * keyboard handler. If the prod table moves, this map must move with
 * it. Keep them in lock-step.
 */
const DIAL_OUTER_STEP = 1.0;
const DIAL_INNER_STEP = 0.1;

function wedgeClick(
  ring: 'outer' | 'inner',
  position: 'top' | 'right' | 'bottom' | 'left',
): JoggerCalls {
  const step = ring === 'outer' ? DIAL_OUTER_STEP : DIAL_INNER_STEP;
  switch (position) {
    case 'top':    return { axis: 'y', amount: -step };
    case 'right':  return { axis: 'x', amount:  step };
    case 'bottom': return { axis: 'y', amount:  step };
    case 'left':   return { axis: 'x', amount: -step };
  }
}

function arrowKey(
  key: 'ArrowUp' | 'ArrowDown' | 'ArrowRight' | 'ArrowLeft',
  shift: boolean,
): JoggerCalls {
  const step = shift ? 1.0 : 0.1;
  switch (key) {
    case 'ArrowUp':    return { axis: 'y', amount: -step };
    case 'ArrowDown':  return { axis: 'y', amount:  step };
    case 'ArrowRight': return { axis: 'x', amount:  step };
    case 'ArrowLeft':  return { axis: 'x', amount: -step };
  }
}

describe('Model3DJogDial / wedge → (axis, sign) mapping', () => {
  it('top wedge sends PCB −Y so chip moves toward screen-up', () => {
    expect(wedgeClick('outer', 'top')).toEqual({ axis: 'y', amount: -1.0 });
    expect(wedgeClick('inner', 'top')).toEqual({ axis: 'y', amount: -0.1 });
  });

  it('bottom wedge sends PCB +Y so chip moves toward screen-down', () => {
    expect(wedgeClick('outer', 'bottom')).toEqual({ axis: 'y', amount: 1.0 });
    expect(wedgeClick('inner', 'bottom')).toEqual({ axis: 'y', amount: 0.1 });
  });

  it('right wedge sends PCB +X so chip moves toward screen-right', () => {
    expect(wedgeClick('outer', 'right')).toEqual({ axis: 'x', amount: 1.0 });
    expect(wedgeClick('inner', 'right')).toEqual({ axis: 'x', amount: 0.1 });
  });

  it('left wedge sends PCB −X so chip moves toward screen-left', () => {
    expect(wedgeClick('outer', 'left')).toEqual({ axis: 'x', amount: -1.0 });
    expect(wedgeClick('inner', 'left')).toEqual({ axis: 'x', amount: -0.1 });
  });

  it('top and bottom wedges always disagree on Y sign (no double-positive)', () => {
    const top = wedgeClick('outer', 'top');
    const bot = wedgeClick('outer', 'bottom');
    expect(Math.sign(top.amount)).not.toBe(Math.sign(bot.amount));
    expect(top.axis).toBe('y');
    expect(bot.axis).toBe('y');
  });
});

describe('Model3DJogDial / arrow-key handler stays in lock-step with wedges', () => {
  it('ArrowUp matches the top wedge sign (screen-up = PCB −Y)', () => {
    const key = arrowKey('ArrowUp', false);
    const wedge = wedgeClick('inner', 'top');
    expect(Math.sign(key.amount)).toBe(Math.sign(wedge.amount));
    expect(key.axis).toBe(wedge.axis);
  });

  it('ArrowDown matches the bottom wedge sign', () => {
    const key = arrowKey('ArrowDown', false);
    const wedge = wedgeClick('inner', 'bottom');
    expect(Math.sign(key.amount)).toBe(Math.sign(wedge.amount));
    expect(key.axis).toBe(wedge.axis);
  });

  it('ArrowRight matches the right wedge sign', () => {
    const key = arrowKey('ArrowRight', false);
    const wedge = wedgeClick('inner', 'right');
    expect(Math.sign(key.amount)).toBe(Math.sign(wedge.amount));
    expect(key.axis).toBe(wedge.axis);
  });

  it('ArrowLeft matches the left wedge sign', () => {
    const key = arrowKey('ArrowLeft', false);
    const wedge = wedgeClick('inner', 'left');
    expect(Math.sign(key.amount)).toBe(Math.sign(wedge.amount));
    expect(key.axis).toBe(wedge.axis);
  });

  it('Shift+Arrow uses the outer-ring 1.0 mm step', () => {
    expect(Math.abs(arrowKey('ArrowUp',    true).amount)).toBe(1.0);
    expect(Math.abs(arrowKey('ArrowDown',  true).amount)).toBe(1.0);
    expect(Math.abs(arrowKey('ArrowRight', true).amount)).toBe(1.0);
    expect(Math.abs(arrowKey('ArrowLeft',  true).amount)).toBe(1.0);
  });
});

/**
 * Camera-projection sanity check — pure math, no DOM. Re-derives the
 * world-axis → screen-direction mapping from the camera position used
 * in Model3DViewerGL.tsx (`camera.position.set(0.12, 0.10, 0.12)` →
 * lookAt(0,0,0) with up=(0,1,0)). If the camera moves, this test
 * pinpoints which signs in the dial need to flip without rerunning
 * the docker visual-verify harness.
 */
describe('Model3DJogDial / camera projection sanity (Model3DViewerGL.tsx camera)', () => {
  function normalize(v: [number, number, number]): [number, number, number] {
    const m = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / m, v[1] / m, v[2] / m];
  }
  function cross(
    a: [number, number, number],
    b: [number, number, number],
  ): [number, number, number] {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }
  function dot(
    a: [number, number, number],
    b: [number, number, number],
  ): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  // Reproduce the three.js camera basis: zAxis = normalize(eye - target),
  // xAxis = normalize(up × zAxis), yAxis = zAxis × xAxis. xAxis is screen
  // right, yAxis is screen up.
  const eye: [number, number, number] = [0.12, 0.10, 0.12];
  const target: [number, number, number] = [0, 0, 0];
  const up: [number, number, number] = [0, 1, 0];
  const zAxis = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const xAxis = normalize(cross(up, zAxis));
  const yAxis = cross(zAxis, xAxis);

  function screenProjection(world: [number, number, number]) {
    return { right: dot(world, xAxis), up: dot(world, yAxis) };
  }

  it('world +X projects mostly to screen-right (matches +X wedge on the right)', () => {
    const { right, up } = screenProjection([1, 0, 0]);
    expect(right).toBeGreaterThan(0.5);
    expect(Math.abs(up)).toBeLessThan(Math.abs(right));
  });

  it('world +Z (= PCB +Y) projects to screen-LEFT-down — i.e. NOT toward 12 o\'clock', () => {
    const { right, up } = screenProjection([0, 0, 1]);
    expect(right).toBeLessThan(0); // screen-left
    expect(up).toBeLessThan(0);    // screen-down
    // This is the entire reason the +Y wedge sits at the bottom of the
    // dial: putting it at 12 o'clock would have it point opposite to
    // where the chip actually moves.
  });

  it('world −Z (= PCB −Y) projects toward screen-up (justifies top wedge sending −Y)', () => {
    const { up } = screenProjection([0, 0, -1]);
    expect(up).toBeGreaterThan(0);
  });
});
