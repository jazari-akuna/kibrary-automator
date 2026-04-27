/**
 * Queue state: tracks per-part download/commit lifecycle.
 *
 * Subscribes to the 'download.progress' Tauri event emitted by the sidecar
 * reader task (src-tauri/src/sidecar.rs) and updates item statuses reactively.
 */

import { createSignal } from 'solid-js';
import { listen } from '@tauri-apps/api/event';

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

/** Update the status (and optional error message) of a queued item. */
export function setStatus(lcsc: string, status: QueueStatus, error?: string): void {
  setItems((prev) => {
    const idx = prev.findIndex((q) => q.lcsc === lcsc);
    if (idx === -1) return [...prev, { lcsc, qty: 1, status, error }];
    const next = [...prev];
    next[idx] = { ...next[idx], status, error };
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
listen<{ lcsc: string; status: QueueStatus; error?: string }>(
  'download.progress',
  (e) => setStatus(e.payload.lcsc, e.payload.status, e.payload.error),
);
