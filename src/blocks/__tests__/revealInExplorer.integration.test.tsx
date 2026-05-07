// @vitest-environment jsdom
/**
 * 26.5.7-alpha.4 reveal-in-explorer:
 *
 * Each component-file surface (Symbol / Footprint / 3D model) must wire
 * the OpenInExplorerButton with the correct on-disk path. This spec
 * mounts each preview block and asserts that clicking the per-file
 * "↗ Open" button dispatches the right `reveal_in_explorer` invoke.
 *
 * The path conventions under test (must match the sidecar's library
 * layout):
 *   - Symbol:    <lib_dir>/<lib_name>.kicad_sym
 *   - Footprint: <lib_dir>/<lib_name>.pretty/<component>.kicad_mod
 *   - 3D model:  <model().resolved_path>  (sidecar-resolved STEP path)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@solidjs/testing-library';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  ask: vi.fn().mockResolvedValue(true),
}));

vi.mock('~/state/toasts', () => ({
  pushToast: vi.fn(),
  toasts: () => [],
}));

import SymbolPreview from '~/blocks/SymbolPreview';
import FootprintPreview from '~/blocks/FootprintPreview';
import Model3DPreview from '~/blocks/Model3DPreview';

interface FakeInfo {
  model_path: string;
  resolved_path?: string;
  file_exists?: boolean | null;
  filename: string;
  format: string;
  offset: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

function fakeInfo(overrides: Partial<FakeInfo> = {}): FakeInfo {
  return {
    model_path: '${KSL_ROOT}/Resistors_KSL/R_10k.step',
    resolved_path: '/ws/Resistors_KSL/Resistors_KSL.3dshapes/R_10k.step',
    file_exists: true,
    filename: 'R_10k.step',
    format: 'STEP',
    offset: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    ...overrides,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => cleanup());

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('SymbolPreview / OpenInExplorerButton wiring', () => {
  it('clicking ↗ on the symbol preview reveals <lib_dir>/<lib_name>.kicad_sym', async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      if (args?.method === 'library.render_symbol_svg') {
        return { svg: '<svg/>' };
      }
      return undefined;
    });

    const { getByTestId } = render(() => (
      <SymbolPreview libDir="/ws/Resistors_KSL" componentName="R_10k_0402" />
    ));

    await tick();
    fireEvent.click(getByTestId('reveal-symbol-in-explorer'));

    expect(invokeMock).toHaveBeenCalledWith(
      'reveal_in_explorer',
      { path: '/ws/Resistors_KSL/Resistors_KSL.kicad_sym' },
    );
  });
});

describe('FootprintPreview / OpenInExplorerButton wiring', () => {
  it('clicking ↗ on the footprint preview reveals <lib_dir>/<lib_name>.pretty/<comp>.kicad_mod', async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      if (args?.method === 'library.render_footprint_svg') {
        return { svg: '<svg/>' };
      }
      return undefined;
    });

    const { getByTestId } = render(() => (
      <FootprintPreview libDir="/ws/Resistors_KSL" componentName="R_10k_0402" />
    ));

    await tick();
    fireEvent.click(getByTestId('reveal-footprint-in-explorer'));

    expect(invokeMock).toHaveBeenCalledWith(
      'reveal_in_explorer',
      {
        path: '/ws/Resistors_KSL/Resistors_KSL.pretty/R_10k_0402.kicad_mod',
      },
    );
  });
});

describe('Model3DPreview / OpenInExplorerButton wiring', () => {
  it('clicking ↗ on the 3D model action row reveals model().resolved_path', async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      if (args?.method === 'library.get_3d_info') {
        return { info: fakeInfo() };
      }
      return undefined;
    });

    const { getByTestId } = render(() => (
      <Model3DPreview libDir="/ws/Resistors_KSL" componentName="R_10k_0402" />
    ));

    // Wait for createResource(get_3d_info) to settle so the action row
    // (which is gated on info()) actually mounts.
    await tick();
    await tick();

    fireEvent.click(getByTestId('reveal-3dmodel-in-explorer'));

    expect(invokeMock).toHaveBeenCalledWith(
      'reveal_in_explorer',
      {
        path: '/ws/Resistors_KSL/Resistors_KSL.3dshapes/R_10k.step',
      },
    );
  });

  it('Model3DPreview ↗ button is disabled when file_exists is false (no spurious invoke)', async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      if (args?.method === 'library.get_3d_info') {
        return { info: fakeInfo({ file_exists: false }) };
      }
      return undefined;
    });

    const { queryByTestId } = render(() => (
      <Model3DPreview libDir="/ws/Resistors_KSL" componentName="R_10k_0402" />
    ));

    await tick();
    await tick();

    // When file_exists === false, the 3D viewer falls back and the
    // action row (View 3D / Replace / Open ↗) does not render. The
    // button-not-found state is the correct guard — clicking it is
    // not even possible. Either the button is absent, or if present
    // it must be disabled. Both states satisfy "no invoke fires".
    const btn = queryByTestId('reveal-3dmodel-in-explorer') as
      | HTMLButtonElement
      | null;
    if (btn !== null) {
      expect(btn.disabled).toBe(true);
      fireEvent.click(btn);
    }
    // Either way: no invoke('reveal_in_explorer', ...) call.
    const revealCalls = invokeMock.mock.calls.filter(
      (c) => c[0] === 'reveal_in_explorer',
    );
    expect(revealCalls).toEqual([]);
  });
});
