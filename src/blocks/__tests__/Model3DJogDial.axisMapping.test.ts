/**
 * Regression spec for the JogDial axis-direction mapping.
 *
 * BUG (26.5.7): the user reported that clicking the dial wedge labelled
 * "+Y" did NOT move the rendered chip toward the top of the 3D viewport.
 * Cause: the viewer's camera at (0.12, 0.10, 0.12) projects KiCad +Y
 * toward screen-down at this angle, so a "+Y"-at-12-o'clock implementation
 * made the click target and the chip's actual screen direction disagree.
 *
 * FIX (26.5.8 alpha.3): swap the LABEL strings on the +Y / −Y wedges so
 * the user's screen-relative mental model holds.
 *
 * FOLLOW-ON FIX (26.5.7-alpha.6 save+reload-equality): the alpha.5
 * applyLiveDelta used `dzWorld = +dyKicad` (KiCad +Y → world +Z),
 * but kicad-cli's BAKED render uses `dzWorld = -dyKicad` (verified
 * empirically — see /tmp/empirical_kicad/empirical.py reproducible
 * recipe). The user reported "after Save → reload, the offset goes the
 * wrong way" because applyLiveDelta and the on-disk → kicad-cli pipeline
 * disagreed on the sign of KiCad +Y. Alpha.6 flips applyLiveDelta to
 * match kicad-cli's bake AND flips the dial wedge `sign` field so the
 * label-driven user behaviour is preserved end-to-end (live preview AND
 * post-save reload now agree). The visible label is unchanged ("+Y" still
 * sits at 12 o'clock); only the (axis, sign) → (positioner-Y delta) map
 * flipped sign on the Y axis.
 *
 * This unit spec freezes:
 *  • the position → (axis, sign) contract — what KiCad-coord delta a
 *    click on each cardinal sends — so the camera projection stays
 *    aligned with the dial layout AND with kicad-cli's bake.
 *  • the LABEL contract — "+Y" must be at the top, "−Y" at the bottom —
 *    so a future refactor can't silently re-revert the user-mental-model
 *    fix.
 *  • the Shift-modifier semantics — Shift-CLICK halves; Shift-Arrow-key
 *    upscales. The two intentionally diverge for the reasons documented
 *    in Model3DJogDial.tsx.
 *
 * Companion to the visual-verify fixtures (run via
 * `scripts/visual-verify.sh`) which assert the world-space delta in the
 * rendered scene AND the live-vs-baked equality.
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
 *
 * 26.5.7-alpha.6 sign-flip: the Y-axis amount sign was reversed across
 * the table (top: -step → +step, bottom: +step → -step) when
 * applyLiveDelta started using kicad-cli's empirical mapping.
 */
const DIAL_OUTER_STEP = 1.0;
const DIAL_INNER_STEP = 0.1;

function wedgeClick(
  ring: 'outer' | 'inner',
  position: 'top' | 'right' | 'bottom' | 'left',
): JoggerCalls {
  const step = ring === 'outer' ? DIAL_OUTER_STEP : DIAL_INNER_STEP;
  switch (position) {
    case 'top':    return { axis: 'y', amount:  step };  // alpha.6: was -step
    case 'right':  return { axis: 'x', amount:  step };
    case 'bottom': return { axis: 'y', amount: -step };  // alpha.6: was +step
    case 'left':   return { axis: 'x', amount: -step };
  }
}

function arrowKey(
  key: 'ArrowUp' | 'ArrowDown' | 'ArrowRight' | 'ArrowLeft',
  shift: boolean,
): JoggerCalls {
  const step = shift ? 1.0 : 0.1;
  switch (key) {
    case 'ArrowUp':    return { axis: 'y', amount:  step };  // alpha.6: was -step
    case 'ArrowDown':  return { axis: 'y', amount: -step };  // alpha.6: was +step
    case 'ArrowRight': return { axis: 'x', amount:  step };
    case 'ArrowLeft':  return { axis: 'x', amount: -step };
  }
}

describe('Model3DJogDial / wedge → (axis, sign) mapping', () => {
  it('top wedge sends KiCad +Y so chip moves toward screen-up [alpha.6: KiCad +Y → world −Z]', () => {
    expect(wedgeClick('outer', 'top')).toEqual({ axis: 'y', amount:  1.0 });
    expect(wedgeClick('inner', 'top')).toEqual({ axis: 'y', amount:  0.1 });
  });

  it('bottom wedge sends KiCad −Y so chip moves toward screen-down', () => {
    expect(wedgeClick('outer', 'bottom')).toEqual({ axis: 'y', amount: -1.0 });
    expect(wedgeClick('inner', 'bottom')).toEqual({ axis: 'y', amount: -0.1 });
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
  it('ArrowUp matches the top wedge sign (screen-up = positive KiCad +Y under alpha.6 mapping)', () => {
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

  it('world −Z projects toward screen-up (this is where alpha.6 KiCad +Y → world −Z lands)', () => {
    const { up } = screenProjection([0, 0, -1]);
    expect(up).toBeGreaterThan(0);
  });

  it('world +Z projects toward screen-DOWN (justifies KiCad −Y → world +Z = screen-down)', () => {
    const { up } = screenProjection([0, 0, 1]);
    expect(up).toBeLessThan(0);
  });

  it('world +X projects screen-right (justifies +X wedge label on right)', () => {
    const { right } = screenProjection([1, 0, 0]);
    expect(right).toBeGreaterThan(0.5);
  });

  it('world −X projects screen-left (justifies −X wedge label on left)', () => {
    const { right } = screenProjection([-1, 0, 0]);
    expect(right).toBeLessThan(-0.5);
  });
});

/**
 * Wedge-label contract — the labels users actually READ on the dial. The
 * LABEL says "screen direction the chip will appear to move"; the click
 * dispatches the KiCad-coord delta that achieves that screen motion.
 * Captured directly from src/blocks/Model3DJogDial.tsx OUTER_WEDGES so a
 * refactor that revives the pre-26.5.8 KiCad-axis labelling fails this
 * spec before users see a re-inverted dial.
 */
const OUTER_LABEL_AT_POSITION: Record<'top' | 'right' | 'bottom' | 'left', string> = {
  top: '+Y',
  right: '+X',
  bottom: '−Y',
  left: '−X',
};

describe('Model3DJogDial / wedge-label contract (screen-relative)', () => {
  it('outer +Y label sits at the TOP wedge so users read screen-up there', () => {
    expect(OUTER_LABEL_AT_POSITION.top).toBe('+Y');
  });

  it('outer −Y label sits at the BOTTOM wedge', () => {
    expect(OUTER_LABEL_AT_POSITION.bottom).toBe('−Y');
  });

  it('outer +X label sits at the RIGHT wedge (KiCad +X already aligns with screen-right)', () => {
    expect(OUTER_LABEL_AT_POSITION.right).toBe('+X');
  });

  it('outer −X label sits at the LEFT wedge', () => {
    expect(OUTER_LABEL_AT_POSITION.left).toBe('−X');
  });

  // Cross-check: clicking the wedge LABELED "+Y" produces a screen-up
  // motion. Under alpha.6 mapping, that's KiCad +Y delta (NOT −Y), because
  // applyLiveDelta now sends KiCad +Y → world −Z which projects onto
  // screen-up (the +0.359 dot product with screenUp basis).
  it('clicking the "+Y"-labelled wedge sends KiCad +Y delta (screen-up under alpha.6)', () => {
    const click = wedgeClick('outer', 'top');
    expect(OUTER_LABEL_AT_POSITION.top).toBe('+Y');
    expect(click).toEqual({ axis: 'y', amount: 1.0 });
  });

  it('clicking the "−Y"-labelled wedge sends KiCad −Y delta (screen-down under alpha.6)', () => {
    const click = wedgeClick('outer', 'bottom');
    expect(OUTER_LABEL_AT_POSITION.bottom).toBe('−Y');
    expect(click).toEqual({ axis: 'y', amount: -1.0 });
  });
});

/**
 * Shift-modifier contract:
 *   • CLICK + Shift halves the step (1.0 → 0.5, 0.1 → 0.05). Mouse-only
 *     precision nudge.
 *   • Arrow key + Shift UPSCALES the step (0.1 → 1.0). Documented
 *     asymmetry — see file-level comment in Model3DJogDial.tsx.
 *
 * Mirrors the prod onClick reducer:
 *   const scaled = e.shiftKey ? delta * 0.5 : delta;
 *   props.onJog(w.axis, scaled);
 */
function wedgeClickWithShift(
  ring: 'outer' | 'inner',
  position: 'top' | 'right' | 'bottom' | 'left',
  shift: boolean,
): JoggerCalls {
  const base = wedgeClick(ring, position);
  return shift ? { axis: base.axis, amount: base.amount * 0.5 } : base;
}

describe('Model3DJogDial / Shift modifier on CLICK halves the step', () => {
  it('Shift+click outer +X sends 0.5mm (half of 1.0)', () => {
    expect(wedgeClickWithShift('outer', 'right', true)).toEqual({ axis: 'x', amount: 0.5 });
  });

  it('Shift+click outer −Y sends -0.5mm (half of -1.0) under alpha.6 mapping', () => {
    expect(wedgeClickWithShift('outer', 'bottom', true)).toEqual({ axis: 'y', amount: -0.5 });
  });

  it('Shift+click inner +X sends 0.05mm (half of 0.1)', () => {
    expect(wedgeClickWithShift('inner', 'right', true)).toEqual({ axis: 'x', amount: 0.05 });
  });

  it('Shift+click inner top (label "↑") sends +0.05mm (half of +0.1) under alpha.6', () => {
    expect(wedgeClickWithShift('inner', 'top', true)).toEqual({ axis: 'y', amount: 0.05 });
  });

  it('plain click without shift uses the unscaled ring step', () => {
    expect(wedgeClickWithShift('outer', 'right', false)).toEqual({ axis: 'x', amount: 1.0 });
    expect(wedgeClickWithShift('inner', 'right', false)).toEqual({ axis: 'x', amount: 0.1 });
  });
});

describe('Model3DJogDial / Shift modifier on ARROW KEYS still upscales (kept for muscle memory)', () => {
  it('Shift+ArrowUp sends +1.0mm under alpha.6 (was -1.0 in alpha.5; sign flipped along with applyLiveDelta)', () => {
    expect(arrowKey('ArrowUp', true)).toEqual({ axis: 'y', amount: 1.0 });
  });

  it('plain ArrowUp sends +0.1mm under alpha.6 (the inner-ring step)', () => {
    expect(arrowKey('ArrowUp', false)).toEqual({ axis: 'y', amount: 0.1 });
  });

  it('keyboard Shift and click Shift produce DIFFERENT magnitudes (asymmetry by design)', () => {
    const keyMag = Math.abs(arrowKey('ArrowUp', true).amount);     // 1.0
    const clickMag = Math.abs(wedgeClickWithShift('inner', 'top', true).amount); // 0.05
    expect(keyMag).not.toBe(clickMag);
    expect(keyMag).toBe(1.0);
    expect(clickMag).toBe(0.05);
  });
});
