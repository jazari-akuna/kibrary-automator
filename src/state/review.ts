/**
 * Sequential review state.
 *
 * Exposes a `currentIndex` signal and derived `currentItem()` that resolves
 * to the first 'ready' queue item at or after the current index.
 *
 * Actions:
 *   next()                  — advance past the current item
 *   prev()                  — step back one position
 *   discard(lcsc)           — mark item failed and advance
 *   commitCurrent(targetLib)— call library.commit RPC, push success toast w/ Undo,
 *                             mark item committed, advance to next
 */

import { createSignal, createMemo } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { queueItems, setStatus } from '~/state/queue';
import { currentWorkspace } from '~/state/workspace';
import { pushToast } from '~/state/toasts';

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

const [currentIndex, setCurrentIndex] = createSignal(0);

export { currentIndex };

// ---------------------------------------------------------------------------
// Derived: first ready item at or after currentIndex
// ---------------------------------------------------------------------------

export const currentItem = createMemo(() => {
  const items = queueItems();
  const start = currentIndex();

  // Search from start forward
  for (let i = start; i < items.length; i++) {
    if (items[i].status === 'ready') return items[i];
  }

  // Wrap: search from 0 up to start
  for (let i = 0; i < start && i < items.length; i++) {
    if (items[i].status === 'ready') return items[i];
  }

  return null;
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Advance to the next position in the queue (does not skip ready-check). */
export function next(): void {
  const len = queueItems().length;
  if (len === 0) return;
  setCurrentIndex((i) => (i + 1) % len);
}

/** Step back one position in the queue. */
export function prev(): void {
  const len = queueItems().length;
  if (len === 0) return;
  setCurrentIndex((i) => (i - 1 + len) % len);
}

/**
 * Mark the given LCSC as failed (discarded) and advance to next position.
 * The item remains in the queue so the user can see it failed.
 */
export function discard(lcsc: string): void {
  setStatus(lcsc, 'failed', 'Discarded by user');
  next();
}

/**
 * Commit the current item to `targetLib`.
 * On success: marks item committed, pushes a success toast with an Undo action,
 * and advances to the next ready item.
 * On failure: marks item failed and re-throws so callers can show an error.
 */
export async function commitCurrent(targetLib: string): Promise<void> {
  const item = currentItem();
  const ws = currentWorkspace();

  if (!item || !ws) return;

  const { lcsc } = item;
  const stagingDir = `${ws.root}/.kibrary/staging`;

  setStatus(lcsc, 'committing');

  try {
    await invoke('sidecar_call', {
      method: 'library.commit',
      params: {
        workspace: ws.root,
        lcsc,
        staging_dir: stagingDir,
        target_lib: targetLib,
      },
    });

    setStatus(lcsc, 'committed');

    pushToast({
      kind: 'success',
      message: `${lcsc} committed to ${targetLib}`,
      action: {
        label: 'Undo',
        do: async () => {
          await invoke('sidecar_call', {
            method: 'git.undo_last',
            params: { workspace: ws.root },
          });
        },
      },
    });

    next();
  } catch (e) {
    const msg = String(e);
    setStatus(lcsc, 'failed', msg);
    throw e;
  }
}
