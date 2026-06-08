// @vitest-environment jsdom
/**
 * Inline Reference + Description editing in the Bulk-Assign review table.
 *
 * Mounts the real ReviewBulkAssign block with a mocked Tauri `invoke`,
 * seeds one 'ready' queue row, then:
 *   - edits the Reference and Description inputs and asserts the staged
 *     `.kicad_sym` is updated via `parts.write_props` (debounced) with the
 *     edited keys;
 *   - clicks "Save all" and asserts the `library.commit` invoke carries the
 *     edited `edits` payload.
 *
 * Mock convention mirrors Model3DPreview.dirtyAfterSave.test.tsx: a single
 * hoisted invokeMock dispatching on `args.method`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}));

// queue.ts + workspace.ts call listen() at module load — stub before import.
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('~/state/toasts', () => ({
  pushToast: vi.fn(),
  toasts: () => [],
}));

// lcscIndex.refreshLcscIndex fires invoke after a successful save — stub it
// so it doesn't pollute the assertion on the commit call.
vi.mock('~/state/lcscIndex', () => ({
  refreshLcscIndex: vi.fn(),
}));

import { openWorkspace } from '~/state/workspace';
import { enqueue, setStatus, clearQueue } from '~/state/queue';
import ReviewBulkAssign from '~/blocks/ReviewBulkAssign';

const WS_ROOT = '/tmp/ws';
const STAGING = `${WS_ROOT}/.kibrary/staging`;
const LCSC = 'C25804';

async function baseInvoke(cmd: string, args: any) {
  // Non-sidecar Tauri commands (watch_workspace, etc.) — return a resolved
  // promise so fire-and-forget `.catch()` callers don't blow up.
  if (cmd !== 'sidecar_call') return null;
  const m = args?.method;
  if (m === 'parts.read_meta') {
    return { meta: { lcsc: LCSC, description: 'RES 10k 0402', category: 'Resistors', footprint: 'R_0402', edits: {} } };
  }
  if (m === 'library.suggest') {
    return { library: 'Resistors_KSL', is_existing: false, existing: [], matches: [] };
  }
  if (m === 'parts.write_props') return { ok: true };
  if (m === 'parts.write_meta') return { ok: true };
  if (m === 'library.commit') {
    return { committed_path: `${WS_ROOT}/Resistors_KSL`, target_lib: 'Resistors_KSL', component_name: LCSC };
  }
  return null;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(baseInvoke);
  clearQueue();
  // openWorkspace resolves via the mocked workspace_open invoke.
  invokeMock.mockImplementationOnce(async (_cmd: string) => ({
    root: WS_ROOT,
    settings: {},
    first_run: false,
  }));
  await openWorkspace(WS_ROOT);
  invokeMock.mockImplementation(baseInvoke);
  enqueue([{ lcsc: LCSC, qty: 1 }]);
  setStatus(LCSC, 'ready');
});

afterEach(() => {
  cleanup();
  clearQueue();
});

describe('ReviewBulkAssign / inline Reference + Description editing', () => {
  it('renders editable Reference + Description inputs for a ready row', async () => {
    const { getByTestId } = render(() => <ReviewBulkAssign />);
    await tick(30);
    expect(getByTestId('bulk-edit-reference')).toBeTruthy();
    expect(getByTestId('bulk-edit-description')).toBeTruthy();
  });

  it('editing Reference persists to staging via parts.write_props with the Reference key', async () => {
    const { getByTestId } = render(() => <ReviewBulkAssign />);
    await tick(30);

    const refInput = getByTestId('bulk-edit-reference') as HTMLInputElement;
    fireEvent.input(refInput, { target: { value: 'R99' } });

    await waitFor(
      () => {
        const call = invokeMock.mock.calls.find(
          (c) => c[1]?.method === 'parts.write_props',
        );
        expect(call).toBeTruthy();
        expect(call![1].params.sym_path).toBe(`${STAGING}/${LCSC}/${LCSC}.kicad_sym`);
        expect(call![1].params.edits.Reference).toBe('R99');
      },
      { timeout: 1000 },
    );
  });

  it('editing Description persists via parts.write_props and keeps the visible value in sync', async () => {
    const { getByTestId } = render(() => <ReviewBulkAssign />);
    await tick(30);

    const descInput = getByTestId('bulk-edit-description') as HTMLInputElement;
    fireEvent.input(descInput, { target: { value: 'RES 22k 0402' } });
    expect(descInput.value).toBe('RES 22k 0402');

    await waitFor(
      () => {
        const call = invokeMock.mock.calls.find(
          (c) => c[1]?.method === 'parts.write_props' && c[1]?.params?.edits?.Description,
        );
        expect(call).toBeTruthy();
        expect(call![1].params.edits.Description).toBe('RES 22k 0402');
      },
      { timeout: 1000 },
    );
  });

  it('Save all sends the edited edits in the library.commit payload', async () => {
    const { getByTestId } = render(() => <ReviewBulkAssign />);
    await tick(30);

    fireEvent.input(getByTestId('bulk-edit-reference'), { target: { value: 'R99' } });
    fireEvent.input(getByTestId('bulk-edit-description'), { target: { value: 'RES 22k 0402' } });
    await tick(500); // let the debounced write settle

    fireEvent.click(getByTestId('bulk-save-all'));

    await waitFor(
      () => {
        const commit = invokeMock.mock.calls.find((c) => c[1]?.method === 'library.commit');
        expect(commit).toBeTruthy();
        expect(commit![1].params.edits.Reference).toBe('R99');
        expect(commit![1].params.edits.Description).toBe('RES 22k 0402');
      },
      { timeout: 1000 },
    );
  });
});
