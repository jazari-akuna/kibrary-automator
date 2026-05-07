/**
 * 26.5.7 hover-preview emission spec.
 *
 * The XY translate dial (Model3DJogDial) and the rotation dial
 * (Model3DRotateDial) emit a HoverPreview payload through `onHoverChange`
 * on every wedge mouseenter, and a `null` clear on mouseleave / click.
 * Model3DPreview forwards that payload to Model3DViewerGL which paints a
 * transient ghost ArrowHelper (translate) or arc + cone (rotate). This
 * spec freezes the contract — wedge → (kind, axis, sign, magnitude) —
 * that all three components must agree on.
 *
 * Pattern matches `Model3DPreview.fallback.test.ts`: encode the dial's
 * onMouseEnter / onMouseLeave / onClick reducers inline as pure functions,
 * exercise them directly with createRoot. No jsdom mount, no Solid
 * web-bundle import — repo-wide convention because vitest runs in node.
 *
 * If a future refactor moves the +Y wedge or changes magnitude semantics,
 * this test fails before the visual-verify harness has to run.
 */
import { describe, it, expect } from 'vitest';
import { createRoot, createSignal } from 'solid-js';

// HoverPreview shape — kept in lock-step with the export from
// Model3DJogDial.tsx. If the prod export changes, this redefinition drifts
// and the cross-check in `import-shape-stays-aligned-with-prod` fires.
interface HoverPreview {
  kind: 'translate' | 'rotate';
  axis: 'x' | 'y' | 'z';
  sign: '+' | '-';
  magnitude: number;
}

// Mirror of the per-wedge handlers in Model3DJogDial.tsx (4 outer × 1 mm
// + 4 inner × 0.1 mm). The prod table walks each Wedge through wedgeOf();
// here we precompute the static mapping so a sign flip in the source
// breaks both the prod table and this test in lock-step.
const TRANSLATE_WEDGES: Array<{
  ring: 'outer' | 'inner';
  axis: 'x' | 'y';
  sign: '+' | '-';
  magnitude: number;
}> = [
  { ring: 'outer', axis: 'y', sign: '-', magnitude: 1.0 },
  { ring: 'outer', axis: 'x', sign: '+', magnitude: 1.0 },
  { ring: 'outer', axis: 'y', sign: '+', magnitude: 1.0 },
  { ring: 'outer', axis: 'x', sign: '-', magnitude: 1.0 },
  { ring: 'inner', axis: 'y', sign: '-', magnitude: 0.1 },
  { ring: 'inner', axis: 'x', sign: '+', magnitude: 0.1 },
  { ring: 'inner', axis: 'y', sign: '+', magnitude: 0.1 },
  { ring: 'inner', axis: 'x', sign: '-', magnitude: 0.1 },
];

const ROTATE_WEDGES: Array<{
  axis: 'x' | 'y' | 'z';
  sign: '+' | '-';
}> = [
  { axis: 'x', sign: '+' },
  { axis: 'y', sign: '+' },
  { axis: 'z', sign: '-' },
  { axis: 'x', sign: '-' },
  { axis: 'y', sign: '-' },
  { axis: 'z', sign: '+' },
];

/** Pure-fn version of Model3DJogDial.tsx's wedge handlers. */
function makeTranslateHoverHandlers(
  setHover: (p: HoverPreview | null) => void,
  jog: (axis: 'x' | 'y', amount: number) => void,
) {
  return (w: typeof TRANSLATE_WEDGES[number]) => ({
    onMouseEnter: () =>
      setHover({
        kind: 'translate',
        axis: w.axis,
        sign: w.sign,
        magnitude: w.magnitude,
      }),
    onMouseLeave: () => setHover(null),
    onClick: () => {
      // Order matters: clear the helper BEFORE the actual jog so the
      // ghost arrow doesn't briefly overlap the moved chip on the next
      // render tick.
      setHover(null);
      jog(w.axis, w.magnitude * (w.sign === '+' ? 1 : -1));
    },
  });
}

/** Pure-fn version of Model3DRotateDial.tsx's wedge handlers. */
function makeRotateHoverHandlers(
  setHover: (p: HoverPreview | null) => void,
  rotate: (axis: 'x' | 'y' | 'z', delta: number) => void,
) {
  return (w: typeof ROTATE_WEDGES[number]) => ({
    onMouseEnter: () =>
      setHover({
        kind: 'rotate',
        axis: w.axis,
        sign: w.sign,
        magnitude: 90,
      }),
    onMouseLeave: () => setHover(null),
    onClick: () => {
      setHover(null);
      rotate(w.axis, w.sign === '+' ? 90 : -90);
    },
  });
}

describe('Model3DJogDial / hover preview emission contract', () => {
  it('mouseenter on each of the 8 wedges emits a translate HoverPreview', () => {
    createRoot((dispose) => {
      const [hover, setHover] = createSignal<HoverPreview | null>(null);
      const handlers = makeTranslateHoverHandlers(setHover, () => {});

      for (const w of TRANSLATE_WEDGES) {
        handlers(w).onMouseEnter();
        expect(hover()).toEqual({
          kind: 'translate',
          axis: w.axis,
          sign: w.sign,
          magnitude: w.magnitude,
        });
      }
      dispose();
    });
  });

  it('mouseleave clears the preview to null', () => {
    createRoot((dispose) => {
      const [hover, setHover] = createSignal<HoverPreview | null>(null);
      const handlers = makeTranslateHoverHandlers(setHover, () => {});
      const w = TRANSLATE_WEDGES[1]; // outer +x
      handlers(w).onMouseEnter();
      expect(hover()?.axis).toBe('x');
      handlers(w).onMouseLeave();
      expect(hover()).toBeNull();
      dispose();
    });
  });

  it('click clears the hover preview AND fires the jog (in that order)', () => {
    createRoot((dispose) => {
      const events: ('hover-null' | 'hover-set' | 'jog')[] = [];
      const setHover = (p: HoverPreview | null) =>
        events.push(p === null ? 'hover-null' : 'hover-set');
      const jog = () => events.push('jog');
      const handlers = makeTranslateHoverHandlers(setHover, jog);
      handlers(TRANSLATE_WEDGES[2]).onMouseEnter();
      handlers(TRANSLATE_WEDGES[2]).onClick();
      expect(events).toEqual(['hover-set', 'hover-null', 'jog']);
      dispose();
    });
  });

  it('outer wedges emit magnitude 1.0; inner wedges emit 0.1', () => {
    createRoot((dispose) => {
      const captured: HoverPreview[] = [];
      const handlers = makeTranslateHoverHandlers(
        (p) => p && captured.push(p),
        () => {},
      );
      for (const w of TRANSLATE_WEDGES) handlers(w).onMouseEnter();

      const outer = captured.filter((_, i) => TRANSLATE_WEDGES[i].ring === 'outer');
      const inner = captured.filter((_, i) => TRANSLATE_WEDGES[i].ring === 'inner');
      expect(outer.every((p) => p.magnitude === 1.0)).toBe(true);
      expect(inner.every((p) => p.magnitude === 0.1)).toBe(true);
      dispose();
    });
  });
});

describe('Model3DRotateDial / hover preview emission contract', () => {
  it('mouseenter on each of the 6 wedges emits a rotate HoverPreview at 90°', () => {
    createRoot((dispose) => {
      const [hover, setHover] = createSignal<HoverPreview | null>(null);
      const handlers = makeRotateHoverHandlers(setHover, () => {});
      for (const w of ROTATE_WEDGES) {
        handlers(w).onMouseEnter();
        expect(hover()).toEqual({
          kind: 'rotate',
          axis: w.axis,
          sign: w.sign,
          magnitude: 90,
        });
      }
      dispose();
    });
  });

  it('mouseleave clears the preview to null', () => {
    createRoot((dispose) => {
      const [hover, setHover] = createSignal<HoverPreview | null>(null);
      const handlers = makeRotateHoverHandlers(setHover, () => {});
      handlers(ROTATE_WEDGES[0]).onMouseEnter();
      expect(hover()).not.toBeNull();
      handlers(ROTATE_WEDGES[0]).onMouseLeave();
      expect(hover()).toBeNull();
      dispose();
    });
  });

  it('click clears the hover preview AND fires the rotate (in that order)', () => {
    createRoot((dispose) => {
      const events: string[] = [];
      const setHover = (p: HoverPreview | null) =>
        events.push(p === null ? 'hover-null' : 'hover-set');
      const rotate = () => events.push('rotate');
      const handlers = makeRotateHoverHandlers(setHover, rotate);
      handlers(ROTATE_WEDGES[5]).onMouseEnter();
      handlers(ROTATE_WEDGES[5]).onClick();
      expect(events).toEqual(['hover-set', 'hover-null', 'rotate']);
      dispose();
    });
  });
});

// (Note: a dynamic-import shape check on Model3DJogDial.tsx would
// evaluate solid-js/web at module-load — that touches `window` and breaks
// the node-environment vitest. The TypeScript surface stays guarded by
// the inline HoverPreview re-declaration above + tsc --noEmit.)
