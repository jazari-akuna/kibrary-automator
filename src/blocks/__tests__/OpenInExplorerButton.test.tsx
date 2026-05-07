// @vitest-environment jsdom
/**
 * 26.5.7-alpha.4 reveal-in-explorer:
 *
 * Mount the real OpenInExplorerButton, click it, assert the Tauri
 * `invoke` was called with the documented `(command, args)` shape:
 *
 *     invoke('reveal_in_explorer', { path: <abs-path> })
 *
 * The Rust side is covered by its own unit tests (per-OS argv assertions
 * + a Linux integration test that actually spawns dbus-send). This spec
 * is the wire-protocol guard so a future refactor that renames the
 * command, drops the `path` key, or stops passing the absolute path
 * fails loudly here instead of silently breaking the feature in prod.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@solidjs/testing-library';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}));

// Toasts module reads window — mocking keeps the test focused on the
// invoke call and avoids dragging the toast reactive store into scope.
vi.mock('~/state/toasts', () => ({
  pushToast: vi.fn(),
  toasts: () => [],
}));

import OpenInExplorerButton from '~/blocks/OpenInExplorerButton';

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('OpenInExplorerButton', () => {
  it('clicking calls invoke("reveal_in_explorer", { path }) with the absolute path', () => {
    const { getByTestId } = render(() => (
      <OpenInExplorerButton path="/ws/Resistors_KSL/Resistors_KSL.kicad_sym" />
    ));
    fireEvent.click(getByTestId('open-in-explorer'));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      'reveal_in_explorer',
      { path: '/ws/Resistors_KSL/Resistors_KSL.kicad_sym' },
    );
  });

  it('uses the testid override when supplied (so callers can disambiguate)', () => {
    const { getByTestId } = render(() => (
      <OpenInExplorerButton
        path="/foo/bar.kicad_mod"
        testid="reveal-footprint-in-explorer"
      />
    ));
    fireEvent.click(getByTestId('reveal-footprint-in-explorer'));
    expect(invokeMock).toHaveBeenCalledWith(
      'reveal_in_explorer',
      { path: '/foo/bar.kicad_mod' },
    );
  });

  it('does NOT invoke when path is null (button is disabled)', () => {
    const { getByTestId } = render(() => (
      <OpenInExplorerButton path={null} />
    ));
    const btn = getByTestId('open-in-explorer') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    // The disabled attribute alone doesn't always block JSDOM-fired clicks,
    // but our handler short-circuits on !path. Either path → no invoke.
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('does NOT invoke when path is undefined (button is disabled)', () => {
    const { getByTestId } = render(() => (
      <OpenInExplorerButton path={undefined} />
    ));
    const btn = getByTestId('open-in-explorer') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('renders a tooltip — Linux WebKitGTK userAgent → "Show in file manager"', () => {
    // jsdom's default userAgent contains neither Mac nor Windows tokens →
    // detectOSTooltip returns the Linux phrasing.
    const { getByTestId } = render(() => (
      <OpenInExplorerButton path="/x/y.kicad_sym" />
    ));
    const btn = getByTestId('open-in-explorer') as HTMLButtonElement;
    expect(btn.title).toBe('Show in file manager');
  });

  it('clicking propagates the path stopPropagation — does NOT bubble to a parent click handler', () => {
    const parentClick = vi.fn();
    const { getByTestId } = render(() => (
      <div onClick={parentClick}>
        <OpenInExplorerButton path="/a/b/c.step" />
      </div>
    ));
    fireEvent.click(getByTestId('open-in-explorer'));
    // Selecting a file row's reveal button must NOT also re-select the row,
    // double-fire its onClick, etc. — that's what stopPropagation in the
    // handler is for.
    expect(parentClick).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('renders an inline SVG icon (file-with-arrow), NOT the bare ↗ Unicode glyph', () => {
    // 26.5.7-alpha.5: replaced "↗" with a lucide-style file-output SVG so
    // the button reads as "open this FILE" rather than a generic link.
    // This spec guards against a regression to the Unicode glyph.
    const { getByTestId } = render(() => (
      <OpenInExplorerButton path="/x/y.kicad_sym" />
    ));
    const btn = getByTestId('open-in-explorer');
    const icon = getByTestId('open-in-explorer-icon');
    expect(icon.tagName.toLowerCase()).toBe('svg');
    // Guard: the icon must be a child of the button.
    expect(btn.contains(icon)).toBe(true);
    // No stray "↗" glyph text inside the button.
    expect(btn.textContent ?? '').not.toContain('↗');
  });
});
