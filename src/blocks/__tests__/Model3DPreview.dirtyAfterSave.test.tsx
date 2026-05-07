// @vitest-environment jsdom
/**
 * REAL-DOM regression spec for the close-after-save bug — the "test
 * theatre" pre-existing closeHandler.test.ts replays an inline copy of
 * the Shell.tsx handler and never mounts a single component. This file
 * mounts the real Model3DPreview, drives it through the actual Save
 * flow with a mocked Tauri invoke, and asserts the global isDirty()
 * flag returns to FALSE after the save round-trips.
 *
 * The hypothesis under test (per the candid review):
 *   1. positioner mutates the live signals → isDirty becomes true ✓
 *   2. Save calls library.set_3d_offset, then refetch() pulls a new
 *      info() → effect should recompute and clear isDirty
 *   3. but float-equality / reactive-effect ordering may leave
 *      isDirty=true post-refetch, causing close-after-save to prompt
 *      indefinitely.
 *
 * If step 3 reproduces, the test fails — and the fix is an explicit
 * setIsDirty(false) inside the Save success path before/after refetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@solidjs/testing-library';

// --------------------------------------------------------------------------
// Tauri mock — Model3DPreview reaches the Python sidecar via
// invoke('sidecar_call', ...). The mock dispatches by `method` so we can
// drive `library.get_3d_info` (initial + refetch) and `library.set_3d_offset`
// (Save) independently. Hoisting at the top so vi.mock receives them.
// --------------------------------------------------------------------------

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  ask: vi.fn().mockResolvedValue(true),
}));

// Toasts module reads window — fine in jsdom — but pushToast triggers
// reactive state in Solid. Mocking it keeps the test focused on the
// dirty-flag round-trip.
vi.mock('~/state/toasts', () => ({
  pushToast: vi.fn(),
  toasts: () => [],
}));

import { isDirty, setIsDirty } from '~/state/dirty';
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
    resolved_path: '/tmp/lib/Resistors_KSL/R_10k.step',
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
  setIsDirty(false);
});

afterEach(() => {
  cleanup();
  setIsDirty(false);
});

// Allow effects + microtask resolutions to flush.
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('Model3DPreview / dirty flag round-trips through Save', () => {
  it('isDirty becomes false after Save round-trips through library.set_3d_offset + refetch', async () => {
    // Mutable backing for the saved state — the second get_3d_info call
    // (the refetch after Save) returns whatever the prior set_3d_offset
    // would have written.
    let saved: [number, number, number] = [0, 0, 0];

    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      if (args?.method === 'library.get_3d_info') {
        return { info: fakeInfo({ offset: [...saved] as any }) };
      }
      if (args?.method === 'library.set_3d_offset') {
        saved = [...args.params.offset] as any;
        return { ok: true };
      }
      // The viewer's PNG / GLB render calls aren't relevant to this
      // dirty-flag spec; satisfy whichever render path the GL viewer's
      // WebGL2-unavailable fallback chooses with a benign placeholder.
      if (args?.method === 'library.render_3d_png_angled') {
        return { png_data_url: 'data:image/png;base64,' };
      }
      if (args?.method === 'library.render_3d_glb_angled') {
        return { glb_b64: '' };
      }
      return null;
    });

    const { getByTestId } = render(() => (
      <Model3DPreview libDir="/tmp/lib/Resistors_KSL" componentName="R_10k" />
    ));

    // Wait for the initial fetch + the seed-from-info effect to settle.
    await tick(50);
    expect(isDirty()).toBe(false);

    // Mutate the offset X input → live signal flows in → dirty = true.
    const offsetX = getByTestId('positioner-offset-x') as HTMLInputElement;
    fireEvent.input(offsetX, { target: { value: '1.5' } });
    await tick(0);
    expect(isDirty()).toBe(true);

    // Click Save. invoke('library.set_3d_offset') resolves, the parent's
    // onSaved handler calls refetch() + bumps savedRev, the dirty effect
    // re-runs against the new info().offset = [1.5, 0, 0] vs live [1.5,0,0]
    // and should collapse dirty back to false.
    const saveBtn = getByTestId('positioner-save');
    fireEvent.click(saveBtn);

    // Allow the await invoke + Promise.resolve refetch + reactive effect
    // chain to settle. 50 ms is generous; if the bug exists this still
    // fails because the flag never clears regardless of how long we wait.
    await tick(80);

    expect(
      isDirty(),
      'After a successful Save the global unsaved-edits flag must be false — otherwise the Tauri close-handler will prompt forever.',
    ).toBe(false);
  });

  it('isDirty clears IMMEDIATELY after Save resolves — even before refetch lands (race-window guard)', async () => {
    // The race window: user clicks Save → set_3d_offset resolves → onSaved
    // fires → refetch() kicks off a NEW async get_3d_info call. If the
    // user clicks the X button before that refetch resolves, the close
    // handler reads isDirty() and must see FALSE (not "still true because
    // the new baseline hasn't landed yet"). This test deliberately blocks
    // the refetch promise — the dirty flag must clear via the explicit
    // setIsDirty(false) in onSaved, NOT via the createEffect that fires
    // post-refetch.
    let resolveRefetch: (v: unknown) => void = () => {};
    let saveSettled = false;
    let setOffset: [number, number, number] = [0, 0, 0];

    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      if (args?.method === 'library.get_3d_info') {
        // First call (initial) resolves immediately; second call (refetch)
        // hangs until the test releases it.
        if (saveSettled) {
          return await new Promise((r) => { resolveRefetch = r; });
        }
        return { info: fakeInfo({ offset: [...setOffset] as any }) };
      }
      if (args?.method === 'library.set_3d_offset') {
        setOffset = [...args.params.offset] as any;
        saveSettled = true;
        return { ok: true };
      }
      if (args?.method === 'library.render_3d_png_angled') {
        return { png_data_url: 'data:image/png;base64,' };
      }
      if (args?.method === 'library.render_3d_glb_angled') {
        return { glb_b64: '' };
      }
      return null;
    });

    const { getByTestId } = render(() => (
      <Model3DPreview libDir="/tmp/lib/Resistors_KSL" componentName="R_10k" />
    ));
    await tick(50);

    fireEvent.input(getByTestId('positioner-offset-x'), { target: { value: '0.9' } });
    await tick(0);
    expect(isDirty()).toBe(true);

    fireEvent.click(getByTestId('positioner-save'));
    // Allow set_3d_offset's promise to resolve and onSaved to fire, but
    // NOT the (still-pending) refetch.
    await tick(20);

    // refetch is suspended — info() has not been refreshed yet — but
    // isDirty must already read false because of the immediate clear.
    expect(
      isDirty(),
      'isDirty must clear synchronously inside onSaved, not wait for the refetch round-trip',
    ).toBe(false);

    // Now release the refetch and confirm the flag stays false (no
    // bouncing back to true after the new info() lands).
    resolveRefetch({ info: fakeInfo({ offset: [...setOffset] as any }) });
    await tick(40);
    expect(isDirty()).toBe(false);
  });

  it('confirmDiscardIfDirty("quit") returns true without prompting after a successful Save', async () => {
    // This is the actual chain that fires when the user clicks the X
    // post-Save: Shell's listener calls confirmDiscardIfDirty('quit').
    // If isDirty() === false, it must short-circuit to true and NEVER
    // touch the (mocked) ask() dialog.
    let saved: [number, number, number] = [0, 0, 0];
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      if (args?.method === 'library.get_3d_info') {
        return { info: fakeInfo({ offset: [...saved] as any }) };
      }
      if (args?.method === 'library.set_3d_offset') {
        saved = [...args.params.offset] as any;
        return { ok: true };
      }
      if (args?.method === 'library.render_3d_png_angled') {
        return { png_data_url: 'data:image/png;base64,' };
      }
      if (args?.method === 'library.render_3d_glb_angled') {
        return { glb_b64: '' };
      }
      return null;
    });

    const { getByTestId } = render(() => (
      <Model3DPreview libDir="/tmp/lib/Resistors_KSL" componentName="R_10k" />
    ));
    await tick(50);

    fireEvent.input(getByTestId('positioner-offset-x'), { target: { value: '0.7' } });
    await tick(0);
    fireEvent.click(getByTestId('positioner-save'));
    await tick(80);

    // Now invoke the SAME function the X-button listener uses.
    const { confirmDiscardIfDirty } = await import('~/state/dirty');
    const { ask } = await import('@tauri-apps/plugin-dialog');
    const askMock = vi.mocked(ask);
    askMock.mockClear();

    const ok = await confirmDiscardIfDirty('quit');
    expect(ok).toBe(true);
    expect(askMock).not.toHaveBeenCalled(); // no dialog shown — clean quit
  });

  it('isDirty stays true if Save fails (sidecar throws) — Cancel must still work', async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: any) => {
      if (args?.method === 'library.get_3d_info') {
        return { info: fakeInfo() };
      }
      if (args?.method === 'library.set_3d_offset') {
        throw new Error('sidecar exploded');
      }
      if (args?.method === 'library.render_3d_png_angled') {
        return { png_data_url: 'data:image/png;base64,' };
      }
      if (args?.method === 'library.render_3d_glb_angled') {
        return { glb_b64: '' };
      }
      return null;
    });

    const { getByTestId } = render(() => (
      <Model3DPreview libDir="/tmp/lib/Resistors_KSL" componentName="R_10k" />
    ));
    await tick(50);

    const offsetX = getByTestId('positioner-offset-x') as HTMLInputElement;
    fireEvent.input(offsetX, { target: { value: '0.5' } });
    await tick(0);
    expect(isDirty()).toBe(true);

    fireEvent.click(getByTestId('positioner-save'));
    await tick(80);

    // Save threw → dirty must persist so the user can retry / cancel.
    expect(isDirty()).toBe(true);
  });
});
