/**
 * _dialGeometry — pure SVG geometry helpers shared by the two jog dials
 * (Model3DJogDial = XY translate, Model3DRotateDial = rotation).
 *
 * Both dials draw cardinal "wedges" — annular sectors between an inner and
 * outer radius — and place a label at the wedge's mid-angle. The geometry is
 * identical; only the dials' centre point, radii, wedge tables and axis/sign
 * semantics differ. Those stay in each dial. This module owns ONLY the pure
 * math so the two copies can't silently drift apart.
 *
 * Angle convention (shared by both dials): degrees measured CLOCKWISE from
 * north (12 o'clock = 0°). `polar` returns SVG canvas coordinates (y grows
 * downward) so callers can plug the result straight into path data.
 */

/** A point on an SVG canvas — `[x, y]`, y growing downward. */
export type Point = [number, number];

/** The centre of a dial in canvas coordinates. */
export interface Center {
  cx: number;
  cy: number;
}

/**
 * Convert an angle (clockwise from north) + radius into a canvas point,
 * relative to the supplied dial centre.
 *
 *   north (0°)  → (cx, cy - radius)   straight up
 *   east  (90°) → (cx + radius, cy)   to the right
 */
export function polar(center: Center, angleDeg: number, radius: number): Point {
  const rad = (angleDeg * Math.PI) / 180;
  return [center.cx + radius * Math.sin(rad), center.cy - radius * Math.cos(rad)];
}

/**
 * Build the SVG path `d` string for one annular-sector wedge spanning
 * [a1, a2] (clockwise) between `rInner` and `rOuter`.
 *
 * Each cardinal wedge spans 90° (translate dial) or 60° (rotate dial);
 * passing a wraparound span such as a1=315, a2=45 still draws the short
 * clockwise arc because the arc command uses sweep-flag=1, so the math is
 * uniform regardless of wrap.
 */
export function wedgePath(
  center: Center,
  a1: number,
  a2: number,
  rOuter: number,
  rInner: number,
): string {
  const [ox1, oy1] = polar(center, a1, rOuter);
  const [ox2, oy2] = polar(center, a2, rOuter);
  const [ix2, iy2] = polar(center, a2, rInner);
  const [ix1, iy1] = polar(center, a1, rInner);
  return [
    `M ${ox1} ${oy1}`,
    `A ${rOuter} ${rOuter} 0 0 1 ${ox2} ${oy2}`,
    `L ${ix2} ${iy2}`,
    `A ${rInner} ${rInner} 0 0 0 ${ix1} ${iy1}`,
    'Z',
  ].join(' ');
}

/**
 * Mid-angle of a wedge span, used to place its label. For a wraparound
 * span (a2 < a1, e.g. 315 → 45) the midpoint is 0 (north), not 180.
 */
export function midAngle(a1: number, a2: number): number {
  if (a2 < a1) return ((a1 + a2 + 360) / 2) % 360;
  return (a1 + a2) / 2;
}
