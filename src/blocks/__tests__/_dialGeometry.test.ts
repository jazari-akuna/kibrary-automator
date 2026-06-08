/**
 * Unit spec for the shared dial geometry helpers extracted from
 * Model3DJogDial.tsx + Model3DRotateDial.tsx into _dialGeometry.ts.
 *
 * The two dials previously each carried a private copy of polar/wedgePath/
 * midAngle. Extraction must be behaviour-preserving, so these tests pin the
 * pure math against known-angle → known-coordinate values. The existing
 * dial specs (Model3DJogDial.axisMapping.test.ts etc.) cover the axis/sign
 * semantics that stay in the dials.
 */
import { describe, it, expect } from 'vitest';
import { polar, wedgePath, midAngle, type Center } from '../_dialGeometry';

const C: Center = { cx: 90, cy: 90 };

// Floating-point compare helper for the trig results.
function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

describe('_dialGeometry / polar (clockwise from north, SVG y-down)', () => {
  it('north (0°) points straight up: y = cy - radius', () => {
    const [x, y] = polar(C, 0, 50);
    expect(near(x, 90)).toBe(true);
    expect(near(y, 40)).toBe(true);
  });

  it('east (90°) points right: x = cx + radius', () => {
    const [x, y] = polar(C, 90, 50);
    expect(near(x, 140)).toBe(true);
    expect(near(y, 90)).toBe(true);
  });

  it('south (180°) points down: y = cy + radius', () => {
    const [x, y] = polar(C, 180, 50);
    expect(near(x, 90)).toBe(true);
    expect(near(y, 140)).toBe(true);
  });

  it('west (270°) points left: x = cx - radius', () => {
    const [x, y] = polar(C, 270, 50);
    expect(near(x, 40)).toBe(true);
    expect(near(y, 90)).toBe(true);
  });

  it('respects a different centre', () => {
    const [x, y] = polar({ cx: 70, cy: 70 }, 90, 30);
    expect(near(x, 100)).toBe(true);
    expect(near(y, 70)).toBe(true);
  });

  it('zero radius lands on the centre regardless of angle', () => {
    const [x, y] = polar(C, 123, 0);
    expect(near(x, 90)).toBe(true);
    expect(near(y, 90)).toBe(true);
  });
});

describe('_dialGeometry / midAngle', () => {
  it('returns the arithmetic midpoint for an ordered span', () => {
    expect(midAngle(45, 135)).toBe(90);
    expect(midAngle(120, 180)).toBe(150);
  });

  it('returns 0 (north) for the 315→45 wraparound span, not 180', () => {
    expect(midAngle(315, 45)).toBe(0);
  });

  it('handles a 300→360 span at the upper edge', () => {
    expect(midAngle(300, 360)).toBe(330);
  });
});

describe('_dialGeometry / wedgePath', () => {
  it('builds an M/A/L/A/Z annular-sector path with the wedge corners', () => {
    // North-to-east wedge (0°→90°), rOuter=84, rInner=58, centre (90,90).
    const d = wedgePath(C, 0, 90, 84, 58);
    // Start at outer-north corner: polar(0, 84) = (90, 6).
    expect(d.startsWith('M 90 6')).toBe(true);
    // Outer arc to outer-east corner: polar(90, 84) = (174, 90).
    expect(d).toContain('A 84 84 0 0 1 174 90');
    // Line in to inner-east corner: polar(90, 58) = (148, 90).
    expect(d).toContain('L 148 90');
    // Inner arc (reverse sweep) back to inner-north corner: polar(0,58)=(90,32).
    expect(d).toContain('A 58 58 0 0 0 90 32');
    expect(d.endsWith('Z')).toBe(true);
  });

  it('uses sweep-flag 1 for the outer arc and 0 for the inner arc', () => {
    const d = wedgePath(C, 45, 135, 84, 58);
    const outer = d.match(/A 84 84 0 0 (\d)/);
    const inner = d.match(/A 58 58 0 0 (\d)/);
    expect(outer?.[1]).toBe('1');
    expect(inner?.[1]).toBe('0');
  });
});
