/**
 * searchPane — global open/closed state for the Add-room "Search Parts"
 * side pane.
 *
 * The pane is open by default; user toggle preference is persisted to
 * localStorage('kibrary.searchPaneOpen'). Clicking "Download all" with a
 * non-empty queue calls collapseSearchPane() *before* dispatching the
 * download, so the table reflows to full width while the network request
 * is still in flight (instant visual feedback — see ux-spec-v1).
 *
 * Auto-collapse overwrites the persisted preference (the user explicitly
 * asked for downloads to start; they want the room to focus on the
 * Bulk-Assign table). Manual toggles persist normally.
 */

import { createSignal, createEffect } from 'solid-js';

const STORAGE_KEY = 'kibrary.searchPaneOpen';

function detectInitial(): boolean {
  // Hydrate before mount so the first render doesn't flash open→closed.
  // SSR / non-browser environments fall back to "open" (the default).
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'false') return false;
    if (raw === 'true') return true;
  } catch {
    /* localStorage unavailable — treat as default-open */
  }
  return true;
}

const [searchPaneOpen, setSearchPaneOpenRaw] = createSignal<boolean>(detectInitial());

createEffect(() => {
  try {
    localStorage.setItem(STORAGE_KEY, searchPaneOpen() ? 'true' : 'false');
  } catch {
    /* ignore quota / private-mode failures */
  }
});

export { searchPaneOpen };

export function setSearchPaneOpen(open: boolean): void {
  setSearchPaneOpenRaw(open);
}

export function toggleSearchPane(): void {
  setSearchPaneOpenRaw((v) => !v);
}

/**
 * Collapse the pane. Called from Queue.tsx the moment a user clicks
 * "Download all" with a non-empty queue. Intentionally synchronous — the
 * caller dispatches the download immediately after, so width-animation
 * starts in the same frame as the network request.
 */
export function collapseSearchPane(): void {
  setSearchPaneOpenRaw(false);
}
