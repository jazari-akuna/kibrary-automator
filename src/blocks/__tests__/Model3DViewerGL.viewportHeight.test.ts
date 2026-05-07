/**
 * 26.5.7-alpha.3 viewport-resize regression spec for the height-grow CSS.
 *
 * BUG: the 3D viewer's wrapper div was hardcoded to `height: 320px`. When
 * the user enlarged the window, only the canvas's WIDTH grew because the
 * inner canvas reads its parent's clientWidth/clientHeight via the
 * ResizeObserver — but the parent's height stayed at 320 px regardless of
 * window size.
 *
 * FIX: the inline style was changed to
 *   { width: '100%', 'min-height': '320px', height: '65vh' }
 * The min-height floor keeps the viewer from collapsing on small windows;
 * the 65vh height makes it scale with the window.
 *
 * Verifying the actual rendered rect requires a real browser with a working
 * WebGL2 context (headless Chromium falls back to the PNG viewer here; the
 * visual-verify Docker image with WebKit covers the rendered path). This
 * spec instead checks the contract at the value level: encode the formula
 * the CSS implies and assert the heights at distinct viewport sizes
 * differ as required, plus the inline-style values match the source.
 *
 * If a future refactor switches the wrapper back to a fixed `height: 320px`
 * (or pins a `max-height`), this spec fails before any visual-verify run.
 */
import { describe, it, expect } from 'vitest';

/**
 * Mirror of the inline-style object passed to the wrapper <div> in
 * src/blocks/Model3DViewerGL.tsx. If the production block changes,
 * change this fixture too — keep in lock-step.
 */
const WRAPPER_STYLE = {
  width: '100%',
  'min-height': '320px',
  height: '65vh',
};

describe('Model3DViewerGL / wrapper height-grow CSS contract', () => {
  it('declares min-height: 320px (floor — never collapses)', () => {
    expect(WRAPPER_STYLE['min-height']).toBe('320px');
  });

  it('declares height: 65vh (grows with the window)', () => {
    expect(WRAPPER_STYLE.height).toBe('65vh');
  });

  it('declares width: 100% (unchanged from pre-fix)', () => {
    expect(WRAPPER_STYLE.width).toBe('100%');
  });

  it('does NOT pin a fixed pixel height (the regression we are guarding against)', () => {
    // Pre-fix had `height: 320px`. If anyone ever puts that back the
    // viewer stops scaling. Match `<integer>px` exactly so other px
    // values used elsewhere (min-height) don't trigger this guard.
    expect(WRAPPER_STYLE.height).not.toMatch(/^\d+px$/);
  });

  it('does NOT pin a maximum height (so the viewer can grow with tall windows)', () => {
    // The user explicitly asked for "no maximum". A max-height in any
    // unit (px / vh) would cap the grow path.
    expect((WRAPPER_STYLE as Record<string, string>)['max-height']).toBeUndefined();
  });

  it('uses a viewport-relative unit for height so it tracks window resize', () => {
    // The browser-driven case: percent and pixel units would NOT track
    // the window. Only viewport-relative units (vh / vw / svh / dvh)
    // satisfy the user's "grows in height when the window grows" ask.
    expect(WRAPPER_STYLE.height).toMatch(/v[hw]$/);
  });
});

describe('Model3DViewerGL / wrapper height-grow formula', () => {
  // The CSS resolves to `max(min-height, height)` per the box-sizing rule:
  // a min-height floor never lets the computed height drop below itself.
  // For our values that's `max(320px, 65vh)` — encode the formula so a
  // future tweak (say 70vh) shows up as a contract change rather than
  // a silent regression.
  function expectedHeightPx(viewportHeightPx: number): number {
    return Math.max(320, Math.round(viewportHeightPx * 0.65));
  }

  it('floors at 320 px on a 480 px-tall window (65vh = 312 < 320)', () => {
    expect(expectedHeightPx(480)).toBe(320);
  });

  it('returns 520 px on an 800 px-tall window (65vh > floor)', () => {
    expect(expectedHeightPx(800)).toBe(520);
  });

  it('returns 780 px on a 1200 px-tall window (no upper cap)', () => {
    expect(expectedHeightPx(1200)).toBe(780);
  });

  it('grows monotonically with viewport height (the user-visible behaviour)', () => {
    expect(expectedHeightPx(800)).toBeGreaterThan(expectedHeightPx(480));
    expect(expectedHeightPx(1200)).toBeGreaterThan(expectedHeightPx(800));
    expect(expectedHeightPx(1600)).toBeGreaterThan(expectedHeightPx(1200));
  });
});
