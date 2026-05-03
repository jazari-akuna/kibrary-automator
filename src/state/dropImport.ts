/**
 * Drag-drop import staging state.
 *
 * Holds groups of files the user dropped onto the app window, BEFORE they
 * get committed to a library. The DropZoneOverlay calls `addGroups` after
 * the sidecar has classified the dropped paths; DropImportList renders
 * one row per group with a LibPicker; on commit the row removes itself
 * via `removeGroup`.
 *
 * In-memory only — dropped state does NOT persist across app restarts.
 * If the user closes the app with un-committed drops, they're gone (the
 * source files on disk are untouched, so the user can re-drop them).
 */

import { createSignal } from 'solid-js';

export interface DroppedGroup {
  /** Basename stem shared by the files. Display label + group key. */
  name: string;
  /** Absolute path to the .kicad_sym file, or null if none was dropped. */
  symbol_path: string | null;
  /** Absolute path to the .kicad_mod file, or null if none was dropped. */
  footprint_path: string | null;
  /** Absolute paths to .step / .stp / .wrl files. May be empty. */
  model_paths: string[];
  /** Source folder for display (parent dir of any file in the group). */
  source_dir: string;
}

const [groups, setGroups] = createSignal<DroppedGroup[]>([]);

export { groups as droppedGroups };

/** Append new groups, deduping by name (a re-drop of the same stem replaces). */
export function addGroups(fresh: DroppedGroup[]): void {
  if (fresh.length === 0) return;
  setGroups((prev) => {
    const byName = new Map<string, DroppedGroup>();
    for (const g of prev) byName.set(g.name, g);
    for (const g of fresh) byName.set(g.name, g);
    return Array.from(byName.values());
  });
}

/** Remove one group by name (called after a successful commit). */
export function removeGroup(name: string): void {
  setGroups((prev) => prev.filter((g) => g.name !== name));
}

/** Wipe all dropped groups (e.g. workspace switch). */
export function clearDroppedGroups(): void {
  setGroups([]);
}

if (typeof window !== 'undefined') {
  const bag = ((window as any).__kibraryTest = (window as any).__kibraryTest ?? {});
  bag.addDroppedGroups = addGroups;
  bag.getDroppedGroups = () => groups();
  bag.clearDroppedGroups = clearDroppedGroups;
}
