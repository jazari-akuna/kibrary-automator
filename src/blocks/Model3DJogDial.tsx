/**
 * Model3DJogDial — pure-SVG XY jog dial for the 3D positioner.
 *
 * Two concentric rings of 4 cardinal wedges:
 * * outer ring → ±1.0 mm step
 * * inner ring → ±0.1 mm step
 *
 * Click a wedge or use arrow keys to nudge offset on the X / Y axis.
 * Pure SVG — no canvas, no WebGL — to keep rendering reliable on Linux
 * webkit2gtk.
 */

import { For } from 'solid-js';

/**
 * 26.5.7 hover-preview contract: when the user hovers a wedge the dial
 * emits a payload describing the move that a click WOULD perform; the
 * parent forwards that to the 3D viewer which paints a transient ghost
 * ArrowHelper. `null` means "no wedge under the cursor any more" — the
 * viewer wipes the helper. The translate-dial only ever emits axis
 * 'x' | 'y' (Z lives on the separate Model3DJogZ column).
 */
export interface HoverPreview {
  kind: 'translate' | 'rotate';
  axis: 'x' | 'y' | 'z';
  sign: '+' | '-';
  /** Step magnitude (mm for translate, degrees for rotate). */
  magnitude: number;
}

interface Props {
  onJog: (axis: 'x' | 'y', amount: number) => void;
  /** Click the centre disk to zero X and Y offset. */
  onReset: () => void;
  /** Hover a wedge → ghost arrow on the 3D viewer; leave / click → null. */
  onHoverChange?: (preview: HoverPreview | null) => void;
}

/**
 * 26.5.8 shift-modifier semantics for translation step:
 *   • CLICK on a wedge with Shift held → HALF-step (outer 1mm → 0.5mm,
 *     inner 0.1mm → 0.05mm). Mouse-driven precision nudge.
 *   • Keyboard ArrowKeys with Shift held → UPSCALE (0.1mm → 1.0mm). The
 *     keyboard convention predates the dial and matches CAD/3D-app idioms
 *     where Shift-arrow is "big jump"; we keep that to avoid muscle-memory
 *     breakage. The intentional asymmetry is intentional — clicks already
 *     have two ring sizes (outer/inner) for coarse vs fine; Shift halves
 *     the chosen ring. Keyboard has only one default step, so Shift acts
 *     as the multiplier instead.
 */

const CX = 90;
const CY = 90;

// Angle measured clockwise from north (12 o'clock = 0°). Returns canvas
// coordinates so callers can plug straight into SVG path data.
function polar(angleDeg: number, radius: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [CX + radius * Math.sin(rad), CY - radius * Math.cos(rad)];
}

interface Wedge {
  a1: number; // start angle (clockwise from north)
  a2: number; // end angle
  axis: 'x' | 'y';
  sign: '+' | '-';
  ring: 'outer' | 'inner';
  label: string;
}

// Quadrant centres — wedge POSITION matches the screen direction the
// chip actually moves, AND the LABEL matches the user's screen-relative
// mental model (+Y at top = "click here to move chip up on screen").
//
// User mental-model fix (26.5.8): the wedge labels follow standard math
// convention — +Y means UP-on-screen, not KiCad's "+Y is south on the
// layout sheet" convention. The labels were previously KiCad-axis names
// which collided with users' (R, G, B = +X, +Y, +Z = right, up, depth)
// expectation — they read "+Y" at the bottom and reported the dial as
// "all inverted". Empirically (visual-verify):
//   KiCad +X → world +X → screen-RIGHT  (wedge labelled "+X" at 3 o'clock ✓)
//   KiCad +Y → world +Z → screen-LEFT-DOWN (so KiCad-+Y is "screen-down");
//                         we relabel BOTTOM as "−Y" and TOP as "+Y", but
//                         keep the (axis, sign) data intact so the chip
//                         continues to translate in the screen direction
//                         the wedge POSITION already implies. Effectively
//                         label-swap only — click semantics + on-disk
//                         storage unchanged, save round-trip preserved.
//   KiCad +Z → world +Y (handled by Model3DJogZ; vertical axis aligns
//                         with screen-up at this camera angle, so the
//                         Z label was never inverted).
//
// X-axis: PCB +X = world +X ≈ screen-right at this camera angle, so the
// "+X" label stays on the right.
//
// Z (height) is handled by the separate Model3DJogZ column — this dial
// is X/Y only.
const OUTER_WEDGES: Wedge[] = [
  // 26.5.8-alpha.3 save-round-trip fix:
  // applyLiveDelta now maps KiCad +Y → world −Z (NOT +Z). To keep the
  // top wedge "+Y / ↑" still moving the chip toward screen-up under the
  // corrected mapping, top wedge sign must be '+' (so click sends KiCad-Y
  // +delta → world −Z = screen-up); bottom wedge sign is '-'.
  { a1: 315, a2: 45,  axis: 'y', sign: '+', ring: 'outer', label: '+Y' },
  { a1: 45,  a2: 135, axis: 'x', sign: '+', ring: 'outer', label: '+X' },
  { a1: 135, a2: 225, axis: 'y', sign: '-', ring: 'outer', label: '−Y' },
  { a1: 225, a2: 315, axis: 'x', sign: '-', ring: 'outer', label: '−X' },
];
const INNER_WEDGES: Wedge[] = [
  // Inner ring uses arrow icons that match screen direction directly.
  { a1: 315, a2: 45,  axis: 'y', sign: '+', ring: 'inner', label: '↑' },
  { a1: 45,  a2: 135, axis: 'x', sign: '+', ring: 'inner', label: '→' },
  { a1: 135, a2: 225, axis: 'y', sign: '-', ring: 'inner', label: '↓' },
  { a1: 225, a2: 315, axis: 'x', sign: '-', ring: 'inner', label: '←' },
];

// alpha.17: shrunk centre disk to make room for wider rings; the gained
// space went into the ring widths so wedges read more easily on small
// screens. Keep ≈4 px gap between rings so the boundary stays visible.
const OUTER_R = 84;
const OUTER_R_INNER = 58;
const INNER_R = 54;
const INNER_R_INNER = 26;
const RESET_R = 22;

function wedgePath(a1: number, a2: number, rOuter: number, rInner: number): string {
  // Each cardinal wedge spans 90°; passing through a1=315, a2=45 wraps the
  // 0° boundary but the SVG arc with sweep-flag=1 still draws the short
  // (clockwise) arc, so the math is uniform.
  const [ox1, oy1] = polar(a1, rOuter);
  const [ox2, oy2] = polar(a2, rOuter);
  const [ix2, iy2] = polar(a2, rInner);
  const [ix1, iy1] = polar(a1, rInner);
  return [
    `M ${ox1} ${oy1}`,
    `A ${rOuter} ${rOuter} 0 0 1 ${ox2} ${oy2}`,
    `L ${ix2} ${iy2}`,
    `A ${rInner} ${rInner} 0 0 0 ${ix1} ${iy1}`,
    'Z',
  ].join(' ');
}

function midAngle(a1: number, a2: number): number {
  // For wraparound (315 → 45) we want 0, not 180.
  if (a2 < a1) return ((a1 + a2 + 360) / 2) % 360;
  return (a1 + a2) / 2;
}

export default function Model3DJogDial(props: Props) {
  const handleKey = (e: KeyboardEvent) => {
    // Keyboard convention: Shift UPSCALES (0.1 → 1.0). This intentionally
    // diverges from the click handler (where Shift HALVES) — see the
    // shift-modifier semantics block at the top of the file.
    const big = e.shiftKey ? 1.0 : 0.1;
    let axis: 'x' | 'y' | null = null;
    let amount = 0;
    switch (e.key) {
      // 26.5.8-alpha.3: ArrowUp emits PCB-Y +delta (under corrected
      // applyLiveDelta mapping `dzWorld = −dyKicad`, +delta yields world
      // −Z = screen-up). Both directions sign-flipped from alpha.2.
      case 'ArrowUp':    axis = 'y'; amount =  big; break;
      case 'ArrowDown':  axis = 'y'; amount = -big; break;
      case 'ArrowRight': axis = 'x'; amount =  big; break;
      case 'ArrowLeft':  axis = 'x'; amount = -big; break;
    }
    if (axis !== null) {
      e.preventDefault();
      props.onJog(axis, amount);
    }
  };

  const wedgeOf = (w: Wedge) => {
    const isOuter = w.ring === 'outer';
    const path = wedgePath(
      w.a1,
      w.a2,
      isOuter ? OUTER_R : INNER_R,
      isOuter ? OUTER_R_INNER : INNER_R_INNER,
    );
    // Land each label near its ring's mid-radius (outer ≈ 71, inner ≈ 40).
    const labelR = isOuter ? 71 : 40;
    const [lx, ly] = polar(midAngle(w.a1, w.a2), labelR);
    const fill = isOuter ? '#3b82f6' : '#64748b';
    const fontSize = isOuter ? 13 : 11;
    const delta = (isOuter ? 1.0 : 0.1) * (w.sign === '+' ? 1 : -1);
    return (
      <>
        <path
          d={path}
          fill={fill}
          stroke="white"
          stroke-opacity="0.2"
          stroke-width="1"
          class="opacity-80 hover:opacity-100 cursor-pointer transition-opacity"
          data-testid={`jog-${w.ring}-${w.sign}${w.axis}`}
          onMouseEnter={() =>
            props.onHoverChange?.({
              kind: 'translate',
              axis: w.axis,
              sign: w.sign,
              magnitude: Math.abs(delta),
            })
          }
          onMouseLeave={() => props.onHoverChange?.(null)}
          onClick={(e) => {
            // Click consumes the hover (the part is about to actually move
            // — the ghost arrow has done its job and would otherwise linger
            // on top of the now-moved chip).
            props.onHoverChange?.(null);
            // Shift-click HALVES the step for mouse-driven precision nudge
            // (see file-level shift-modifier comment). 1.0mm → 0.5mm,
            // 0.1mm → 0.05mm. Keyboard Shift+Arrow is the opposite — it
            // upscales — because keys have one default step where clicks
            // already have two ring sizes for coarse vs fine.
            const scaled = e.shiftKey ? delta * 0.5 : delta;
            props.onJog(w.axis, scaled);
          }}
        />
        <text
          x={lx}
          y={ly}
          fill="white"
          font-size={String(fontSize)}
          text-anchor="middle"
          dominant-baseline="middle"
          style={{ 'pointer-events': 'none', 'user-select': 'none' }}
        >
          {w.label}
        </text>
      </>
    );
  };

  // The reset button is its own focusable target so keyboard users can
  // tab to it and Space/Enter to zero X+Y. The dial-level Arrow handler
  // still owns the wedges.
  const handleResetKey = (e: KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      props.onReset();
    }
  };

  return (
    <svg
      data-testid="jog-dial"
      tabIndex={0}
      role="group"
      aria-label="XY offset jog dial. Click outer wedges for ±1mm steps, inner wedges for ±0.1mm. Hold Shift while clicking to halve the step (0.5mm or 0.05mm). Arrow keys for inner steps, Shift+Arrow for outer. Click centre to reset."
      onKeyDown={handleKey}
      viewBox="0 0 180 180"
      width="160"
      height="160"
      class="focus:outline-none focus:ring-2 focus:ring-blue-400 rounded-full"
    >
      <For each={OUTER_WEDGES}>{wedgeOf}</For>
      <For each={INNER_WEDGES}>{wedgeOf}</For>
      {/* Centre disk — clickable Reset that zeroes X+Y offset. */}
      <g
        tabIndex={0}
        role="button"
        aria-label="Reset X and Y offset to zero"
        onClick={() => props.onReset()}
        onKeyDown={handleResetKey}
        class="opacity-80 hover:opacity-100 transition-opacity focus:outline-none"
        style={{ cursor: 'pointer' }}
      >
        <circle
          data-testid="jog-reset"
          cx={CX}
          cy={CY}
          r={RESET_R}
          fill="#1e293b"
          stroke="white"
          stroke-opacity="0.2"
          stroke-width="1"
        />
        <text
          x={CX}
          y={CY}
          fill="white"
          font-size="9"
          font-weight="600"
          text-anchor="middle"
          dominant-baseline="middle"
          style={{ 'pointer-events': 'none', 'user-select': 'none', 'letter-spacing': '0.05em' }}
        >
          RESET
        </text>
      </g>
    </svg>
  );
}
