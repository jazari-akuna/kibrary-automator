/**
 * Regression spec for the C6037812 silent-failure bug.
 *
 * Pre-fix:
 *   ``parts.download`` returned only ``{ok, error}`` per row. When easyeda.com
 *   responded with ``success: False`` for an LCSC, JLC2KiCadLib quietly
 *   created NO files, the sidecar reported ``ok=True``, and the user saw
 *   the queue row flip to "ready" even though symbol/footprint/3D were
 *   all missing. Clicking "Save all" then committed an empty library.
 *
 * Post-fix:
 *   ``parts.download`` results carry ``assets`` (per-file booleans) and
 *   ``warnings`` (structured failure objects). The Queue block forwards
 *   them into the queue-state via ``setAssetInfo`` and renders a
 *   top-of-queue banner + per-row ⚠ icon driven by ``formatWarning``.
 *
 * This spec covers the formatter contract for the new warning kinds and
 * the queue-state plumbing — the actual DOM render is exercised by the
 * Playwright spec ``component-load-failure.spec.ts``.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the Tauri event listener before the queue module loads so the
// module-level `listen()` call doesn't blow up under jsdom.
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import {
  queueItems,
  enqueue,
  setStatus,
  setAssetInfo,
  clearQueue,
} from '~/state/queue';
import { formatWarning, type RenderWarning } from '../_renderWarnings';

describe('queue / setAssetInfo', () => {
  beforeEach(() => {
    clearQueue();
  });

  it('attaches assets+warnings to the matching row without changing status', () => {
    enqueue([{ lcsc: 'C6037812', qty: 1 }]);
    setStatus('C6037812', 'failed', 'not found');

    const warning: RenderWarning = {
      kind: 'component_load_failed',
      lcsc: 'C6037812',
      missing: ['symbol', 'footprint', '3D model'],
      assets: { symbol: false, footprint: false, model_3d: false },
      reason: "Component 'C6037812' not found in source library",
    };
    setAssetInfo(
      'C6037812',
      { symbol: false, footprint: false, model_3d: false },
      [warning],
    );

    const row = queueItems().find((q) => q.lcsc === 'C6037812')!;
    expect(row).toBeDefined();
    expect(row.status).toBe('failed');
    expect(row.assets).toEqual({ symbol: false, footprint: false, model_3d: false });
    expect(row.warnings).toHaveLength(1);
    expect(row.warnings![0].kind).toBe('component_load_failed');
  });

  it('is a no-op when the LCSC is not in the queue', () => {
    setAssetInfo(
      'CUNKNOWN',
      { symbol: true, footprint: true, model_3d: true },
      [],
    );
    expect(queueItems()).toEqual([]);
  });

  it('preserves prior fields when updating only assets+warnings', () => {
    enqueue([{ lcsc: 'C25804', qty: 5 }]);
    setStatus('C25804', 'ready', undefined, 100);

    setAssetInfo(
      'C25804',
      { symbol: true, footprint: true, model_3d: true },
      [],
    );

    const row = queueItems().find((q) => q.lcsc === 'C25804')!;
    expect(row.qty).toBe(5);
    expect(row.status).toBe('ready');
    expect(row.progress).toBe(100);
    expect(row.warnings).toEqual([]);
  });

  it('formats the banner string for a C6037812-class failure', () => {
    const w: RenderWarning = {
      kind: 'component_load_failed',
      lcsc: 'C6037812',
      missing: ['symbol', 'footprint', '3D model'],
      reason: 'easyeda.com returned no design data',
    };
    const out = formatWarning(w);
    // The banner-line shape the queue-warning-banner renders. Pinned so a
    // refactor of formatWarning that drops the LCSC or reason gets
    // caught.
    expect(out).toMatch(/C6037812.*not found.*easyeda/);
  });
});

// -------------------------------------------------------------------
// Banner-render decision contract — pure logic, no Solid mount needed.
// -------------------------------------------------------------------

describe('queue-warning-banner / render decision', () => {
  type Row = { warnings?: RenderWarning[] };

  function shouldRenderBanner(rows: Row[]): boolean {
    return rows.some((r) => (r.warnings?.length ?? 0) > 0);
  }

  it('renders the banner when at least one row has warnings', () => {
    expect(
      shouldRenderBanner([
        { warnings: [{ kind: 'component_load_failed', lcsc: 'C6037812' }] },
        { warnings: [] },
      ]),
    ).toBe(true);
  });

  it('does not render the banner when all rows are clean', () => {
    expect(shouldRenderBanner([{ warnings: [] }, { warnings: undefined }])).toBe(
      false,
    );
  });

  it('does not render for an empty queue', () => {
    expect(shouldRenderBanner([])).toBe(false);
  });

  it('renders even for an ok=true row that has a partial-asset warning', () => {
    expect(
      shouldRenderBanner([
        {
          warnings: [
            {
              kind: 'component_load_partial',
              lcsc: 'Cpartial',
              missing: ['3D model'],
            },
          ],
        },
      ]),
    ).toBe(true);
  });
});
