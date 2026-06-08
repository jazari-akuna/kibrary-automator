/**
 * Unit spec for the chip-classification decision helper extracted from
 * Model3DViewerGL.tsx.
 *
 * Background: when the GLB classifier finds zero movable chip nodes the
 * position/rotation jogs silently do nothing. Previously this only
 * produced a console.warn; now it drives a visible on-canvas banner. The
 * full WebGL viewer is impractical to mount headless, so we extract the
 * "did classification find chips?" decision into this pure helper and pin
 * the empty-chip case → warning-state mapping here. The overlay + signal
 * wiring in Model3DViewerGL.tsx is covered by tsc + the existing viewer
 * tests staying green.
 */
import { describe, it, expect } from 'vitest';
import { classifierFoundNoChips } from '../_chipClassification';

describe('_chipClassification / classifierFoundNoChips', () => {
  it('maps zero chip nodes → no-movable-part warning state', () => {
    expect(classifierFoundNoChips(0)).toBe(true);
  });

  it('treats a single chip node as a valid (movable) model', () => {
    expect(classifierFoundNoChips(1)).toBe(false);
  });

  it('treats many chip nodes as valid', () => {
    expect(classifierFoundNoChips(5)).toBe(false);
  });

  it('defensively treats a negative count as "no chips" (warning state)', () => {
    expect(classifierFoundNoChips(-1)).toBe(true);
  });
});
