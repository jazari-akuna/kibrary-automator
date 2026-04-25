/**
 * Queue state: tracks per-part download status.
 *
 * Subscribes to the 'download.progress' Tauri event emitted by the sidecar
 * reader task (src-tauri/src/sidecar.rs) and updates item statuses reactively.
 */

import { createSignal } from 'solid-js';
import { listen } from '@tauri-apps/api/event';

export type QueueStatus = 'queued' | 'downloading' | 'ready' | 'failed';

export interface QueueItem {
  lcsc: string;
  status: QueueStatus;
}

const [items, setItems] = createSignal<QueueItem[]>([]);

export { items as queueItems };

/** Add an LCSC to the queue (status: 'queued') if not already present. */
export function enqueue(lcsc: string): void {
  setItems((prev) => {
    if (prev.some((q) => q.lcsc === lcsc)) return prev;
    return [...prev, { lcsc, status: 'queued' }];
  });
}

/** Update the status of a queued item (creates the item if missing). */
export function setStatus(lcsc: string, status: QueueStatus): void {
  setItems((prev) => {
    const idx = prev.findIndex((q) => q.lcsc === lcsc);
    if (idx === -1) return [...prev, { lcsc, status }];
    const next = [...prev];
    next[idx] = { ...next[idx], status };
    return next;
  });
}

/** Remove all items from the queue. */
export function clearQueue(): void {
  setItems([]);
}

// Subscribe to download.progress events from the Tauri backend.
listen<{ lcsc: string; status: QueueStatus }>('download.progress', (e) => {
  setStatus(e.payload.lcsc, e.payload.status);
});
