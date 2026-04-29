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

interface Props {
  onJog: (axis: 'x' | 'y', amount: number) => void;
}

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

// Quadrant centres (12 o'clock = +Y per the architect spec).
//   +Y: 315→45 (passes through 0)
//   +X: 45→135
//   −Y: 135→225
//   −X: 225→315
const OUTER_WEDGES: Wedge[] = [
  { a1: 315, a2: 45, axis: 'y', sign: '+', ring: 'outer', label: '+Y' },
  { a1: 45,  a2: 135, axis: 'x', sign: '+', ring: 'outer', label: '+X' },
  { a1: 135, a2: 225, axis: 'y', sign: '-', ring: 'outer', label: '−Y' },
  { a1: 225, a2: 315, axis: 'x', sign: '-', ring: 'outer', label: '−X' },
];
const INNER_WEDGES: Wedge[] = [
  { a1: 315, a2: 45, axis: 'y', sign: '+', ring: 'inner', label: '↑' },
  { a1: 45,  a2: 135, axis: 'x', sign: '+', ring: 'inner', label: '→' },
  { a1: 135, a2: 225, axis: 'y', sign: '-', ring: 'inner', label: '↓' },
  { a1: 225, a2: 315, axis: 'x', sign: '-', ring: 'inner', label: '←' },
];

const OUTER_R = 84;
const OUTER_R_INNER = 68;
const INNER_R = 63;
const INNER_R_INNER = 48;

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
    const big = e.shiftKey ? 1.0 : 0.1;
    let axis: 'x' | 'y' | null = null;
    let amount = 0;
    switch (e.key) {
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
    const labelR = isOuter ? 76 : 55;
    const [lx, ly] = polar(midAngle(w.a1, w.a2), labelR);
    const fill = isOuter ? '#3b82f6' : '#64748b';
    const fontSize = isOuter ? 11 : 9;
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
          onClick={() => props.onJog(w.axis, delta)}
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

  return (
    <svg
      data-testid="jog-dial"
      tabIndex={0}
      role="group"
      aria-label="XY offset jog dial. Click outer wedges for ±1mm steps, inner wedges for ±0.1mm. Arrow keys for inner steps, Shift+Arrow for outer."
      onKeyDown={handleKey}
      viewBox="0 0 180 180"
      width="160"
      height="160"
      class="focus:outline-none focus:ring-2 focus:ring-blue-400 rounded-full"
    >
      <For each={OUTER_WEDGES}>{wedgeOf}</For>
      <For each={INNER_WEDGES}>{wedgeOf}</For>
      {/* Centre disk — purely decorative, no interaction. */}
      <circle cx={CX} cy={CY} r={44} fill="#1e293b" stroke="white" stroke-opacity="0.2" stroke-width="1" />
      <text
        x={CX}
        y={CY}
        fill="white"
        font-size="14"
        text-anchor="middle"
        dominant-baseline="middle"
        style={{ 'pointer-events': 'none', 'user-select': 'none', opacity: 0.7 }}
      >
        +
      </text>
    </svg>
  );
}
