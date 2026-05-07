/**
 * Model3DRotateDial — pure-SVG rotation jog dial for the 3D positioner.
 *
 * Six 60° wedges around a single ring give the user one-click ±90°
 * rotation jogs around each chip-body axis (X, Y, Z). The centre disk
 * resets all three rotation axes to zero — typing into the rotation
 * X/Y/Z inputs of Model3DPositioner remains the precise-fine-grained
 * path; this dial is the CNC-style coarse jog.
 *
 * Wedge layout (clockwise from north). LABELS use the user's screen-
 * relative mental model — "+Z = clockwise on screen". KiCad's right-hand
 * rule has +Z (vertical out of board) rotation going COUNTER-clockwise
 * when viewed from above, which is the opposite of how users describe
 * "+90° rotation". So the wedges that internally send `+90°` are
 * labelled "−" and vice versa; the (axis, sign) data still drives the
 * underlying KiCad-coord rotation so save round-trip stays consistent.
 *
 *      −X   (0°-60°)    [internally axis='x', sign='+', sends +90° KiCad]
 *      −Y   (60°-120°)  [internally axis='y', sign='+', sends +90°]
 *      +Z   (120°-180°) [internally axis='z', sign='-', sends −90° KiCad
 *                        which renders as clockwise-on-screen — what the
 *                        user calls "+Z"]
 *      +X   (180°-240°) [axis='x', sign='-']
 *      +Y   (240°-300°) [axis='y', sign='-']
 *      −Z   (300°-360°) [axis='z', sign='+']
 *
 * Opposing-sign wedges sit diametrically across the ring so the visual
 * mapping matches a physical rotary knob. Pure SVG for the same reason
 * as Model3DJogDial — reliable on Linux webkit2gtk without a canvas.
 */

import { For } from 'solid-js';
import type { HoverPreview } from './Model3DJogDial';

type Axis = 'x' | 'y' | 'z';

interface Props {
  /** Fired when a wedge is clicked; the delta is always ±90 degrees. */
  onRotate: (axis: Axis, deltaDeg: number) => void;
  /** Click the centre disk to zero all three rotation axes. */
  onReset: () => void;
  /** Hover a wedge → ghost rotation arc on the viewer; leave / click → null. */
  onHoverChange?: (preview: HoverPreview | null) => void;
}

const CX = 70;
const CY = 70;

function polar(angleDeg: number, radius: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [CX + radius * Math.sin(rad), CY - radius * Math.cos(rad)];
}

interface Wedge {
  a1: number;
  a2: number;
  axis: Axis;
  sign: '+' | '-';
  label: string;
}

// 6 wedges × 60° each. Opposing-sign pairs are 180° apart by construction.
// 26.5.8: labels swapped relative to internal `sign` field — see top-of-
// file rationale. The (axis, sign) data is the KiCad-coord rotation that
// the click sends to the positioner; the label tells the user what the
// visible chip rotation will look like (e.g. "+Z" = clockwise yaw).
const WEDGES: Wedge[] = [
  { a1: 0,   a2: 60,  axis: 'x', sign: '+', label: '−X' },
  { a1: 60,  a2: 120, axis: 'y', sign: '+', label: '−Y' },
  { a1: 120, a2: 180, axis: 'z', sign: '-', label: '+Z' },
  { a1: 180, a2: 240, axis: 'x', sign: '-', label: '+X' },
  { a1: 240, a2: 300, axis: 'y', sign: '-', label: '+Y' },
  { a1: 300, a2: 360, axis: 'z', sign: '+', label: '−Z' },
];

// Smaller than the XY dial so the two can sit side-by-side without
// dominating the panel.
const OUTER_R = 64;
const INNER_R = 26;
const RESET_R = 22;

function wedgePath(a1: number, a2: number, rOuter: number, rInner: number): string {
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
  if (a2 < a1) return ((a1 + a2 + 360) / 2) % 360;
  return (a1 + a2) / 2;
}

export default function Model3DRotateDial(props: Props) {
  const handleResetKey = (e: KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      props.onReset();
    }
  };

  const wedgeOf = (w: Wedge) => {
    const path = wedgePath(w.a1, w.a2, OUTER_R, INNER_R);
    const labelR = (OUTER_R + INNER_R) / 2;
    const [lx, ly] = polar(midAngle(w.a1, w.a2), labelR);
    // Distinct hue from the XY dial (blue/slate) so users can tell at a
    // glance which dial they're aiming at.
    const fill = w.sign === '+' ? '#a855f7' : '#7c3aed';
    const delta = w.sign === '+' ? 90 : -90;
    return (
      <>
        <path
          d={path}
          fill={fill}
          stroke="white"
          stroke-opacity="0.2"
          stroke-width="1"
          class="opacity-80 hover:opacity-100 cursor-pointer transition-opacity"
          data-testid={`rotate-${w.sign}${w.axis}`}
          onMouseEnter={() =>
            props.onHoverChange?.({
              kind: 'rotate',
              axis: w.axis,
              sign: w.sign,
              magnitude: 90,
            })
          }
          onMouseLeave={() => props.onHoverChange?.(null)}
          onClick={(e) => {
            props.onHoverChange?.(null);
            // Shift-click halves the rotation step: 90° → 45°. Mirrors
            // the translate dial's Shift-click behaviour for consistency.
            const scaled = e.shiftKey ? delta * 0.5 : delta;
            props.onRotate(w.axis, scaled);
          }}
        />
        <text
          x={lx}
          y={ly}
          fill="white"
          font-size="11"
          font-weight="600"
          text-anchor="middle"
          dominant-baseline="middle"
          style={{ 'pointer-events': 'none', 'user-select': 'none' }}
        >
          {w.label}
        </text>
      </>
    );
  };

  return (
    <div class="flex flex-col items-center gap-1">
      <span
        data-testid="rotate-dial-label"
        class="text-[10px] font-medium uppercase tracking-wider text-zinc-600 dark:text-zinc-300 select-none"
      >
        Rotation
      </span>
    <svg
      data-testid="rotate-dial"
      role="group"
      aria-label="Rotation jog dial. Click a wedge to rotate the chip body 90° around that axis. Hold Shift while clicking for a 45° step. Centre disk resets all rotations to zero."
      viewBox="0 0 140 140"
      width="120"
      height="120"
      class="focus:outline-none focus:ring-2 focus:ring-purple-400 rounded-full"
    >
      <For each={WEDGES}>{wedgeOf}</For>
      {/* Centre disk — clickable Reset that zeroes X/Y/Z rotation. */}
      <g
        tabIndex={0}
        role="button"
        aria-label="Reset all rotations to zero"
        onClick={() => props.onReset()}
        onKeyDown={handleResetKey}
        class="opacity-80 hover:opacity-100 transition-opacity focus:outline-none"
        style={{ cursor: 'pointer' }}
      >
        <circle
          data-testid="rotate-reset"
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
          font-size="8"
          font-weight="600"
          text-anchor="middle"
          dominant-baseline="middle"
          style={{ 'pointer-events': 'none', 'user-select': 'none', 'letter-spacing': '0.05em' }}
        >
          RESET
        </text>
      </g>
    </svg>
    </div>
  );
}
