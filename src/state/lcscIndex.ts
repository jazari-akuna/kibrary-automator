// alpha.17: duplicate / already-existing component indicator.
//
// Tracks which LCSC codes are already present in any library of the current
// workspace, so the SearchPanel can show a muted "In library: <name>" pill
// next to results the user has previously committed.
//
// Refresh policy: fire-and-forget on workspace open and after every commit
// success. Errors silently keep the previous index — the worst case is a
// stale pill, which is exactly the status quo (no pill at all) before this
// feature.

import { createSignal } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

export type LcscIndexEntry = { library: string; component_name: string };
export type LcscIndex = Record<string, LcscIndexEntry>;

const [lcscIndex, setLcscIndex] = createSignal<LcscIndex>({});

export { lcscIndex };

interface LcscIndexResponse {
  index: LcscIndex;
}

/** Fire-and-forget: caller does NOT await. Failure keeps the previous index. */
export function refreshLcscIndex(workspace: string): void {
  invoke<LcscIndexResponse>('sidecar_call', {
    method: 'library.lcsc_index',
    params: { workspace },
  })
    .then((r) => setLcscIndex(r?.index ?? {}))
    .catch((e) => {
      console.warn('[lcsc-index] refresh failed (keeping previous):', e);
    });
}

// Test hook so e2e specs can inspect the live index without round-tripping.
if (typeof window !== 'undefined') {
  (window as any).__kibraryTest = (window as any).__kibraryTest ?? {};
  (window as any).__kibraryTest.lcscIndex = () => lcscIndex();
  (window as any).__kibraryTest.refreshLcscIndex = refreshLcscIndex;
}
