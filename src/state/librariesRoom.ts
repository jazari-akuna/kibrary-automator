/**
 * Libraries room state.
 *
 * selectedLib       — the library name currently expanded/selected in the tree
 * selectedComponent — the component name currently selected in the component list
 * multiSelected     — the set of component names currently checked (multi-select)
 *
 * toggleSelect adds/removes a name from multiSelected.
 */

import { createSignal } from 'solid-js';

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

const [selectedLib, setSelectedLib] = createSignal<string | null>(null);
const [selectedComponent, setSelectedComponent] = createSignal<string | null>(null);
const [multiSelected, setMultiSelected] = createSignal<Set<string>>(new Set());

export { selectedLib, setSelectedLib };
export { selectedComponent, setSelectedComponent };
export { multiSelected, setMultiSelected };

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Toggle a component name in/out of the multi-select set. */
export function toggleSelect(name: string): void {
  setMultiSelected((prev) => {
    const next = new Set(prev);
    if (next.has(name)) {
      next.delete(name);
    } else {
      next.add(name);
    }
    return next;
  });
}
