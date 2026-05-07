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
  it('clicking the Open button uses footprint_path returned by library.get_component (NOT componentName + .kicad_mod)', async () => {
    // Regression: the previous implementation computed the path as
    // <lib>/<lib>.pretty/<componentName>.kicad_mod. JLC2KiCadLib names
    // symbols by MPN but writes footprint files under the package / land
    // pattern (recorded in the symbol's Footprint property), so the
    // sidecar resolves them via lib_scanner._find_footprint. We must use
    // the sidecar-resolved path or we ENOENT in real workspaces.
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      if (args?.method === 'library.render_footprint_svg') {
        return { svg: '<svg/>' };
      }
      if (args?.method === 'library.get_component') {
        return {
          properties: {},
          footprint_path:
            '/ws/Connector_KSL/Connector_KSL.pretty/CONN-SMD_100P-P0.40_10164227-1001A1RLF.kicad_mod',
          model3d_path: null,
        };
      }
      return undefined;
    });

    const { getByTestId } = render(() => (
      <FootprintPreview
        libDir="/ws/Connector_KSL"
        componentName="10164227-1001A1RLF"
      />
    ));

    // Two ticks: one for render_footprint_svg, one for get_component.
    await tick();
    await tick();
    fireEvent.click(getByTestId('reveal-footprint-in-explorer'));

    expect(invokeMock).toHaveBeenCalledWith(
      'reveal_in_explorer',
      {
        // Note: the file basename is the package name, NOT the MPN
        // componentName — that's the whole point of this regression spec.
        path: '/ws/Connector_KSL/Connector_KSL.pretty/CONN-SMD_100P-P0.40_10164227-1001A1RLF.kicad_mod',
      },
    );
  });

  it('clicking the Open button on a same-stem case (component name == filename)', async () => {
    // Hand-named libraries where component_name and filename agree —
    // get_component still returns the absolute path; we trust it
    // verbatim instead of re-deriving in JS.
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      if (args?.method === 'library.render_footprint_svg') {
        return { svg: '<svg/>' };
      }
      if (args?.method === 'library.get_component') {
        return {
          properties: {},
          footprint_path:
            '/ws/Resistors_KSL/Resistors_KSL.pretty/R_10k_0402.kicad_mod',
          model3d_path: null,
        };
      }
      return undefined;
    });

    const { getByTestId } = render(() => (
      <FootprintPreview libDir="/ws/Resistors_KSL" componentName="R_10k_0402" />
    ));

    await tick();
    await tick();
    fireEvent.click(getByTestId('reveal-footprint-in-explorer'));

    expect(invokeMock).toHaveBeenCalledWith(
      'reveal_in_explorer',
      {
        path: '/ws/Resistors_KSL/Resistors_KSL.pretty/R_10k_0402.kicad_mod',
      },
    );
  });

  it('staging-mode footprint reveal includes the per-LCSC .pretty/ subdir', async () => {
    // Regression: the previous string was
    // `${stagingDir}/${lcsc}/${lcsc}.kicad_mod` — but JLC2KiCadLib
    // stages footprints under <lcsc>/<lcsc>.pretty/<lcsc>.kicad_mod
    // (matches the sidecar's files._resolve_kicad_mod). The omitted
    // .pretty/ subdir always ENOENT'd in staging.
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      if (args?.method === 'parts.render_footprint_svg') {
        return { svg: '<svg/>' };
      }
      return undefined;
    });

    const { getByTestId } = render(() => (
      <FootprintPreview stagingDir="/staging" lcsc="C25804" />
    ));

    await tick();
    fireEvent.click(getByTestId('reveal-footprint-in-explorer'));

    expect(invokeMock).toHaveBeenCalledWith(
      'reveal_in_explorer',
      { path: '/staging/C25804/C25804.pretty/C25804.kicad_mod' },
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

  it('Model3DPreview ↗ button stays VISIBLE and clickable when file_exists===false', async () => {
    // 26.5.7-alpha.5: previously the button was force-disabled (path=null)
    // whenever the .kicad_mod's (model …) path no longer existed on disk.
    // That made the button "disappear" visually next to the blue "View 3D"
    // CTA — the user reported it as missing. Behaviour change: render the
    // button anyway with model().resolved_path so the user can navigate to
    // the parent .3dshapes dir; the Rust reveal_in_explorer surfaces a
    // friendly toast if the path itself is gone.
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      if (args?.method === 'library.get_3d_info') {
        return { info: fakeInfo({ file_exists: false }) };
      }
      return undefined;
    });

    const { getByTestId } = render(() => (
      <Model3DPreview libDir="/ws/Resistors_KSL" componentName="R_10k_0402" />
    ));

    await tick();
    await tick();

    const btn = getByTestId('reveal-3dmodel-in-explorer') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);

    // Even with file_exists===false, the click forwards the resolved path —
    // the Rust handler decides whether to spawn or toast-error.
    expect(invokeMock).toHaveBeenCalledWith(
      'reveal_in_explorer',
      { path: '/ws/Resistors_KSL/Resistors_KSL.3dshapes/R_10k.step' },
    );
  });

  it('Model3DPreview ↗ button always renders inside the action row (regression: was missing in alpha.4)', async () => {
    // The button must be a sibling of "View 3D in KiCad" / "Replace 3D
    // model…" — NOT nested inside the file_exists Show. If a future
    // refactor accidentally moves it back inside the viewer-gate Show,
    // this test fails with `view-3d-in-kicad` present but
    // `reveal-3dmodel-in-explorer` absent.
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      if (args?.method === 'library.get_3d_info') {
        return { info: fakeInfo() };
      }
      return undefined;
    });

    const { getByTestId } = render(() => (
      <Model3DPreview libDir="/ws/Resistors_KSL" componentName="R_10k_0402" />
    ));

    await tick();
    await tick();

    expect(getByTestId('view-3d-in-kicad')).toBeTruthy();
    expect(getByTestId('reveal-3dmodel-in-explorer')).toBeTruthy();
  });
});
