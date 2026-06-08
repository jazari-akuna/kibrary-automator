// @vitest-environment jsdom
/**
 * Non-blocking duplicate advisory in the Bulk-Assign review table.
 *
 * The sidecar exposes `library.check_duplicate { workspace, lcsc }` →
 * `{ duplicate, library, component_name }`. ReviewBulkAssign calls it once
 * per row as rows load and renders a small "⚠ already in <library>" badge
 * when the LCSC already exists somewhere in the workspace. It is purely
 * advisory — commit must still proceed regardless.
 *
 * Mock convention mirrors ReviewBulkAssign.inlineEdit.test.tsx: a single
 * hoisted invokeMock dispatching on `args.method`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@solidjs/testing-library';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('~/state/toasts', () => ({
  pushToast: vi.fn(),
  toasts: () => [],
}));

vi.mock('~/state/lcscIndex', () => ({
  refreshLcscIndex: vi.fn(),
}));

import { openWorkspace } from '~/state/workspace';
import { enqueue, setStatus, clearQueue } from '~/state/queue';
import ReviewBulkAssign from '~/blocks/ReviewBulkAssign';

const WS_ROOT = '/tmp/ws';

// A row whose LCSC the sidecar reports as a DUPLICATE.
const DUP_LCSC = 'C25804';
// A row whose LCSC is NOT a duplicate.
const FRESH_LCSC = 'C11111';
const DUP_LIBRARY = 'Resistors_v2';

async function baseInvoke(cmd: string, args: any) {
  if (cmd !== 'sidecar_call') return null;
  const m = args?.method;
  if (m === 'parts.read_meta') {
    return {
      meta: {
        lcsc: args.params.lcsc,
        description: 'RES 10k 0402',
        category: 'Resistors',
        footprint: 'R_0402',
        edits: {},
      },
    };
  }
  if (m === 'library.suggest') {
    return { library: 'Resistors_KSL', is_existing: false, existing: [], matches: [] };
  }
  if (m === 'library.check_duplicate') {
    if (args.params.lcsc === DUP_LCSC) {
      return { duplicate: true, library: DUP_LIBRARY, component_name: DUP_LCSC };
    }
    return { duplicate: false, library: null, component_name: null };
  }
  if (m === 'parts.write_props') return { ok: true };
  if (m === 'library.commit') {
    return {
      committed_path: `${WS_ROOT}/Resistors_KSL`,
      target_lib: 'Resistors_KSL',
      component_name: args.params.lcsc,
    };
  }
  return null;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(baseInvoke);
  clearQueue();
  invokeMock.mockImplementationOnce(async (_cmd: string) => ({
    root: WS_ROOT,
    settings: {},
    first_run: false,
  }));
  await openWorkspace(WS_ROOT);
  invokeMock.mockImplementation(baseInvoke);
});

afterEach(() => {
  cleanup();
  clearQueue();
});

describe('ReviewBulkAssign / duplicate advisory', () => {
  it('renders a "already in <library>" advisory for a row the sidecar reports as duplicate', async () => {
    enqueue([{ lcsc: DUP_LCSC, qty: 1 }]);
    setStatus(DUP_LCSC, 'ready');

    const { getByTestId } = render(() => <ReviewBulkAssign />);

    await waitFor(
      () => {
        const badge = getByTestId('bulk-row-duplicate-badge');
        expect(badge).toBeTruthy();
        expect(badge.textContent).toContain(DUP_LIBRARY);
        expect(badge.textContent).toContain('already in');
      },
      { timeout: 1000 },
    );
  });

  it('does NOT render the advisory for a non-duplicate row', async () => {
    enqueue([{ lcsc: FRESH_LCSC, qty: 1 }]);
    setStatus(FRESH_LCSC, 'ready');

    const { queryByTestId, getByTestId } = render(() => <ReviewBulkAssign />);

    // Wait until the row itself has rendered, then assert no badge.
    await waitFor(() => expect(getByTestId('bulk-row')).toBeTruthy(), {
      timeout: 1000,
    });
    // Give the duplicate check time to resolve (it would have set the badge).
    await tick(50);
    expect(queryByTestId('bulk-row-duplicate-badge')).toBeNull();
  });

  it('still commits a duplicate row (advisory is non-blocking)', async () => {
    enqueue([{ lcsc: DUP_LCSC, qty: 1 }]);
    setStatus(DUP_LCSC, 'ready');

    const { getByTestId } = render(() => <ReviewBulkAssign />);

    // Wait for the advisory to confirm the row is flagged as a duplicate.
    await waitFor(() => expect(getByTestId('bulk-row-duplicate-badge')).toBeTruthy(), {
      timeout: 1000,
    });

    // Save anyway — commit must proceed for the flagged row.
    fireEvent.click(getByTestId('bulk-save-all'));

    await waitFor(
      () => {
        const commit = invokeMock.mock.calls.find(
          (c) => c[1]?.method === 'library.commit' && c[1]?.params?.lcsc === DUP_LCSC,
        );
        expect(commit).toBeTruthy();
      },
      { timeout: 1000 },
    );

    // And the saved pill renders → commit succeeded despite the advisory.
    await waitFor(() => expect(getByTestId('bulk-saved-pill')).toBeTruthy(), {
      timeout: 1000,
    });
  });
});
