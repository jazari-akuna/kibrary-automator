/**
 * Regression tests for the unsaved-3D-position-edits flag.
 *
 * Ensures:
 *   1. computeIsDirty returns false when live values match the baseline
 *      exactly OR are within the per-axis epsilon (no false positives from
 *      float-roundtrip noise).
 *   2. computeIsDirty returns true when ANY of offset / rotation / scale
 *      drifts past its epsilon.
 *   3. confirmDiscardIfDirty short-circuits to true (no dialog) when the
 *      flag is clear — so the close handler / library-switch flow doesn't
 *      surface a prompt for users who haven't touched anything.
 *
 * The Tauri-runtime parts (the actual ask() dialog, the window-close
 * round-trip) are exercised by the smoke-ui Playwright suite — those
 * paths can't run in jsdom because they need a real Tauri webview.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeIsDirty,
  confirmDiscardIfDirty,
  isDirty,
  setIsDirty,
  type Triple,
} from '~/state/dirty';

const ZERO: Triple = [0, 0, 0];
const ONE: Triple = [1, 1, 1];

describe('computeIsDirty', () => {
  it('returns false when every triple matches its baseline exactly', () => {
    expect(computeIsDirty(ZERO, ZERO, ZERO, ZERO, ONE, ONE)).toBe(false);
  });

  it('returns false for sub-µm offset drift (float roundtrip noise)', () => {
    const live: Triple = [0.0000001, 0, 0];
    expect(computeIsDirty(live, ZERO, ZERO, ZERO, ONE, ONE)).toBe(false);
  });

  it('returns false for sub-0.1° rotation drift', () => {
    const live: Triple = [0.05, 0, 0];
    expect(computeIsDirty(ZERO, ZERO, live, ZERO, ONE, ONE)).toBe(false);
  });

  it('flags a 2µm X-offset edit as dirty', () => {
    // 2µm = 0.002mm — well above the 1µm epsilon.
    const live: Triple = [0.002, 0, 0];
    expect(computeIsDirty(live, ZERO, ZERO, ZERO, ONE, ONE)).toBe(true);
  });

  it('flags a 1° rotation edit on Z as dirty', () => {
    const live: Triple = [0, 0, 1];
    expect(computeIsDirty(ZERO, ZERO, live, ZERO, ONE, ONE)).toBe(true);
  });

  it('flags a 0.01 scale edit on Y as dirty', () => {
    const live: Triple = [1, 1.01, 1];
    expect(computeIsDirty(ZERO, ZERO, ZERO, ZERO, live, ONE)).toBe(true);
  });

  it('flags any single-axis drift even when the other two match', () => {
    // X moved past epsilon, Y and Z exactly match.
    const liveOff: Triple = [0.005, 0, 0];
    expect(computeIsDirty(liveOff, ZERO, ZERO, ZERO, ONE, ONE)).toBe(true);
  });

  it('treats a saved baseline that is non-zero as the comparison anchor', () => {
    // Baseline rotation is [0, 90, 0] (a recentred PCB part). Live matches.
    const baseline: Triple = [0, 90, 0];
    expect(computeIsDirty(ZERO, ZERO, baseline, baseline, ONE, ONE)).toBe(
      false,
    );
    // Now the user nudges Y rotation by 1° — should flag dirty.
    const drifted: Triple = [0, 91, 0];
    expect(computeIsDirty(ZERO, ZERO, drifted, baseline, ONE, ONE)).toBe(true);
  });
});

describe('confirmDiscardIfDirty', () => {
  beforeEach(() => setIsDirty(false));

  it('returns true synchronously when nothing is dirty (no dialog)', async () => {
    expect(isDirty()).toBe(false);
    // If this tried to open a Tauri dialog under jsdom, the dynamic import
    // of @tauri-apps/plugin-dialog would either throw or hang. The
    // short-circuit on !isDirty() is what makes this test pass.
    await expect(confirmDiscardIfDirty('quit')).resolves.toBe(true);
    await expect(confirmDiscardIfDirty('switch')).resolves.toBe(true);
  });
});

describe('isDirty signal', () => {
  it('round-trips through setIsDirty', () => {
    setIsDirty(false);
    expect(isDirty()).toBe(false);
    setIsDirty(true);
    expect(isDirty()).toBe(true);
    setIsDirty(false);
    expect(isDirty()).toBe(false);
  });
});
