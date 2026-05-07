/**
 * Queue state: tracks per-part download/commit lifecycle.
 *
 * Subscribes to the 'download.progress' Tauri event emitted by the sidecar
 * reader task (src-tauri/src/sidecar.rs) and updates item statuses reactively.
 */

import { createSignal } from 'solid-js';
import { listen } from '@tauri-apps/api/event';
import type { RenderWarning, ComponentAssets } from '~/blocks/_renderWarnings';

export type QueueStatus =
  | 'queued'
  | 'downloading'
  | 'ready'
  | 'committing'
  | 'committed'
  | 'failed';

export interface QueueItem {
  lcsc: string;
  qty: number;
  status: QueueStatus;
  error?: string;
  /** 0–100 download progress; only meaningful while status === 'downloading'. */
  progress?: number;
  /** Per-asset existence flags from the sidecar (post-fix for the
   *  C6037812 silent-failure bug). Only set after a download attempt. */
  assets?: ComponentAssets;
  /** Structured warnings emitted by parts.download — empty when the part
   *  downloaded cleanly. The UI uses these to render the "not found" /
   *  "partially missing" banners next to a row. */
  warnings?: RenderWarning[];
}

const [items, setItems] = createSignal<QueueItem[]>([]);

export { items as queueItems };

/** Add one or more LCSCs to the queue (status: 'queued'). De-duplicates. */
export function enqueue(parts: { lcsc: string; qty: number }[]): void {
  setItems((prev) => {
    const known = new Set(prev.map((q) => q.lcsc));
    const fresh = parts
      .filter((p) => !known.has(p.lcsc))
      .map((p) => ({ lcsc: p.lcsc, qty: p.qty, status: 'queued' as const }));
    return [...prev, ...fresh];
  });
}

/** Update the status (and optional error message / progress %) of a queued item. */
export function setStatus(
  lcsc: string,
  status: QueueStatus,
  error?: string,
  progress?: number,
): void {
  setItems((prev) => {
    const idx = prev.findIndex((q) => q.lcsc === lcsc);
    if (idx === -1) return [...prev, { lcsc, qty: 1, status, error, progress }];
    const next = [...prev];
    next[idx] = { ...next[idx], status, error, progress };
    return next;
  });
}

/** Attach the structured per-asset payload to a queue row. Called once
 *  when the sidecar's terminal `download.progress` event arrives (or
 *  directly from the Queue block after parts.download resolves) — the
 *  UI uses this to render "X not found" / "missing footprint" banners
 *  on the row instead of failing silently. */
export function setAssetInfo(
  lcsc: string,
  assets: ComponentAssets | undefined,
  warnings: RenderWarning[] | undefined,
): void {
  setItems((prev) => {
    const idx = prev.findIndex((q) => q.lcsc === lcsc);
    if (idx === -1) return prev;
    const next = [...prev];
    next[idx] = { ...next[idx], assets, warnings };
    return next;
  });
}

/** Remove all items from the queue. */
export function clearQueue(): void {
  setItems([]);
}

/** Remove a single item from the queue by LCSC. */
export function dequeue(lcsc: string): void {
  setItems((prev) => prev.filter((q) => q.lcsc !== lcsc));
}

/** Remove items whose status is in `keep` (e.g. clear out failed/committed). */
export function pruneQueue(keep: QueueStatus[]): void {
  setItems((prev) => prev.filter((q) => keep.includes(q.status)));
}

// Subscribe to download.progress events from the Tauri backend.
listen<{
  lcsc: string;
  status: QueueStatus;
  error?: string;
  progress?: number;
  assets?: ComponentAssets;
  warnings?: RenderWarning[];
}>('download.progress', (e) => {
  setStatus(e.payload.lcsc, e.payload.status, e.payload.error, e.payload.progress);
  // Terminal events (ready/failed) carry assets + warnings — propagate
  // them so the row's banner has the structured data it needs to format
  // a useful message instead of just "failed".
  if (e.payload.assets || e.payload.warnings) {
    setAssetInfo(e.payload.lcsc, e.payload.assets, e.payload.warnings);
  }
});
