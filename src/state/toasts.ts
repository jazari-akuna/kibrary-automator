/**
 * Toast notification state.
 *
 * Usage:
 *   import { pushToast, dismissToast, toasts } from '~/state/toasts';
 *
 *   pushToast({ kind: 'success', message: 'Done!' });
 *   pushToast({ kind: 'error', message: 'Oops', action: { label: 'Retry', do: retry } }, 10_000);
 */

import { createSignal } from 'solid-js';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
  action?: { label: string; do: () => Promise<void> | void };
  expiresAt: number;
}

const DEFAULT_TTL_MS = 30_000;

let _nextId = 1;
const [_toasts, setToasts] = createSignal<Toast[]>([]);

/** Reactive accessor — use inside Solid components / effects. */
export const toasts = _toasts;

/**
 * Push a new toast. Returns the assigned numeric ID.
 * Auto-dismisses after `ttlMs` milliseconds (default 30 s).
 */
export function pushToast(
  t: Omit<Toast, 'id' | 'expiresAt'>,
  ttlMs: number = DEFAULT_TTL_MS,
): number {
  const id = _nextId++;
  const expiresAt = Date.now() + ttlMs;
  const toast: Toast = { ...t, id, expiresAt };

  setToasts((prev) => [toast, ...prev]);

  setTimeout(() => dismissToast(id), ttlMs);

  return id;
}

/** Remove a toast by ID (called by auto-dismiss or the × button). */
export function dismissToast(id: number): void {
  setToasts((prev) => prev.filter((t) => t.id !== id));
}
