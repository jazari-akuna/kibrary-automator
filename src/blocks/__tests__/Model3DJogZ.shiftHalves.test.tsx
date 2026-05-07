// @vitest-environment jsdom
/**
 * REAL-DOM regression spec for Model3DJogZ shift-click halving.
 *
 * The pre-existing axisMapping test ENCODES the scaling rule in a local
 * helper function and asserts on the helper — the prod component is
 * never mounted. This file mounts the real Model3DJogZ Solid component
 * and dispatches real DOM click events with `shiftKey: true`, so a
 * regression that drops the `e.shiftKey` check from the onClick handler
 * (or forgets to wire the `scale()` helper) fails this spec.
 *
 * Contract under regression:
 *   • plain click on "+Z 1mm" → onJog(1.0)
 *   • shift-click on "+Z 1mm" → onJog(0.5)
 *   • plain click on "+Z 0.1mm" → onJog(0.1)
 *   • shift-click on "+Z 0.1mm" → onJog(0.05)
 *   • symmetric for the −Z buttons.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@solidjs/testing-library';
import Model3DJogZ from '~/blocks/Model3DJogZ';

afterEach(() => cleanup());

describe('Model3DJogZ / Shift-click halves the step', () => {
  it('plain click on "+Z 1mm" dispatches onJog(1.0)', () => {
    const onJog = vi.fn();
    const { getByTestId } = render(() => (
      <Model3DJogZ onJog={onJog} onReset={() => {}} />
    ));
    fireEvent.click(getByTestId('jog-z-plus1'));
    expect(onJog).toHaveBeenCalledTimes(1);
    expect(onJog).toHaveBeenCalledWith(1.0);
  });

  it('shift-click on "+Z 1mm" dispatches onJog(0.5) — HALF the step, not the un-shifted 1.0', () => {
    const onJog = vi.fn();
    const { getByTestId } = render(() => (
      <Model3DJogZ onJog={onJog} onReset={() => {}} />
    ));
    fireEvent.click(getByTestId('jog-z-plus1'), { shiftKey: true });
    expect(onJog).toHaveBeenCalledTimes(1);
    expect(onJog).toHaveBeenCalledWith(0.5);
  });

  it('shift-click on "+Z 0.1mm" dispatches onJog(0.05)', () => {
    const onJog = vi.fn();
    const { getByTestId } = render(() => (
      <Model3DJogZ onJog={onJog} onReset={() => {}} />
    ));
    fireEvent.click(getByTestId('jog-z-plus01'), { shiftKey: true });
    expect(onJog).toHaveBeenCalledWith(0.05);
  });

  it('shift-click on "−Z 1mm" dispatches onJog(-0.5) — sign preserved', () => {
    const onJog = vi.fn();
    const { getByTestId } = render(() => (
      <Model3DJogZ onJog={onJog} onReset={() => {}} />
    ));
    fireEvent.click(getByTestId('jog-z-minus1'), { shiftKey: true });
    expect(onJog).toHaveBeenCalledWith(-0.5);
  });

  it('shift-click on "−Z 0.1mm" dispatches onJog(-0.05)', () => {
    const onJog = vi.fn();
    const { getByTestId } = render(() => (
      <Model3DJogZ onJog={onJog} onReset={() => {}} />
    ));
    fireEvent.click(getByTestId('jog-z-minus01'), { shiftKey: true });
    expect(onJog).toHaveBeenCalledWith(-0.05);
  });

  it('plain (non-shift) click on "−Z 0.1mm" still dispatches the un-halved -0.1', () => {
    const onJog = vi.fn();
    const { getByTestId } = render(() => (
      <Model3DJogZ onJog={onJog} onReset={() => {}} />
    ));
    fireEvent.click(getByTestId('jog-z-minus01'));
    expect(onJog).toHaveBeenCalledWith(-0.1);
  });

  it('clicking the Z reset disk fires onReset (not onJog)', () => {
    const onJog = vi.fn();
    const onReset = vi.fn();
    const { getByTestId } = render(() => (
      <Model3DJogZ onJog={onJog} onReset={onReset} />
    ));
    fireEvent.click(getByTestId('jog-z-reset'));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onJog).not.toHaveBeenCalled();
  });
});
