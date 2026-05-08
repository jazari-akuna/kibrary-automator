// @vitest-environment jsdom
/**
 * REAL-DOM regression spec for Model3DJogDial wedge clicks.
 *
 * The pre-existing axisMapping spec is "test theatre" — it transcribes
 * the wedge constants from the source file into the test, so the test
 * passes even if the source's wedgeOf() handler is wired wrong (e.g. an
 * onClick that doesn't call props.onJog at all). This file mounts the
 * real Solid component, dispatches real DOM click events on the SVG
 * <path> wedges, and asserts onJog was called with the expected
 * (axis, amount).
 *
 * What we are pinning (post-26.5.8 contract):
 *   The wedge visually LABELLED "+Y" sits at 12 o'clock and a user
 *   click on it must produce screen-up motion. Empirically the camera
 *   at (0.12, 0.10, 0.12) maps that screen-up motion to KiCad-Y −delta,
 *   so onJog must be called with ('y', -1.0). The label-and-handler
 *   pairing is what the user actually sees and clicks; freezing it as
 *   a single contract guarantees a future refactor can't desync the
 *   text glyph from the dispatched delta without failing this spec.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@solidjs/testing-library';
import Model3DJogDial from '~/blocks/Model3DJogDial';

afterEach(() => cleanup());

/**
 * Find the SVG <path> whose visual label-text reads `label`. The dial
 * renders each wedge as a fragment: <path .../><text>label</text>, so
 * the path is the immediately-preceding element of the matching <text>.
 *
 * We search by VISIBLE label rather than data-testid because the
 * data-testid encodes the INTERNAL (axis, sign) tuple — it is the
 * exact thing the 26.5.8 fix swapped, so using it would let a regression
 * silently re-invert the dial without failing the test.
 */
function pathForLabel(container: HTMLElement, label: string): SVGPathElement {
  const text = Array.from(container.querySelectorAll('text')).find(
    (t) => t.textContent === label,
  );
  if (!text) throw new Error(`No <text> with label "${label}" in dial`);
  const prev = text.previousElementSibling;
  if (!prev || prev.tagName.toLowerCase() !== 'path') {
    throw new Error(`Expected <path> sibling of "${label}", got ${prev?.tagName}`);
  }
  return prev as unknown as SVGPathElement;
}

describe('Model3DJogDial / real DOM click → onJog (label-driven)', () => {
  // 26.5.8-alpha.3 contract: click "+Y" → onJog('y', +1.0). Sign flipped from
  // alpha.2 to align with the corrected applyLiveDelta (KiCad +Y → world −Z),
  // so click "+Y" delivers world −Z = screen-up motion AND a +Y on disk that
  // kicad-cli bakes at the same world position.
  it('clicking the visually-LABELLED "+Y" wedge calls onJog("y", +1.0)', () => {
    const onJog = vi.fn();
    const { container } = render(() => (
      <Model3DJogDial onJog={onJog} onReset={() => {}} />
    ));
    fireEvent.click(pathForLabel(container, '+Y'));
    expect(onJog).toHaveBeenCalledTimes(1);
    expect(onJog).toHaveBeenCalledWith('y', 1.0);
  });

  it('clicking the visually-LABELLED "−Y" wedge calls onJog("y", -1.0)', () => {
    const onJog = vi.fn();
    const { container } = render(() => (
      <Model3DJogDial onJog={onJog} onReset={() => {}} />
    ));
    fireEvent.click(pathForLabel(container, '−Y'));
    expect(onJog).toHaveBeenCalledWith('y', -1.0);
  });

  it('clicking the visually-LABELLED "+X" wedge calls onJog("x", +1.0)', () => {
    const onJog = vi.fn();
    const { container } = render(() => (
      <Model3DJogDial onJog={onJog} onReset={() => {}} />
    ));
    fireEvent.click(pathForLabel(container, '+X'));
    expect(onJog).toHaveBeenCalledWith('x', 1.0);
  });

  it('clicking the visually-LABELLED "−X" wedge calls onJog("x", -1.0)', () => {
    const onJog = vi.fn();
    const { container } = render(() => (
      <Model3DJogDial onJog={onJog} onReset={() => {}} />
    ));
    fireEvent.click(pathForLabel(container, '−X'));
    expect(onJog).toHaveBeenCalledWith('x', -1.0);
  });

  it('Shift-click on inner +X (visible glyph "→") dispatches onJog("x", 0.05) — half the 0.1 step', () => {
    const onJog = vi.fn();
    const { container } = render(() => (
      <Model3DJogDial onJog={onJog} onReset={() => {}} />
    ));
    fireEvent.click(pathForLabel(container, '→'), { shiftKey: true });
    expect(onJog).toHaveBeenCalledTimes(1);
    expect(onJog).toHaveBeenCalledWith('x', 0.05);
  });

  it('clicking the centre disk fires onReset (not onJog)', () => {
    const onJog = vi.fn();
    const onReset = vi.fn();
    const { getByTestId } = render(() => (
      <Model3DJogDial onJog={onJog} onReset={onReset} />
    ));
    fireEvent.click(getByTestId('jog-reset'));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onJog).not.toHaveBeenCalled();
  });
});
