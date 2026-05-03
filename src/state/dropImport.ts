/**
 * Drag-drop import staging state.
 *
 * Holds groups of files the user dropped onto the app window, BEFORE they
 * get committed to a library. The DropZoneOverlay calls `applyScanResult`
 * after the sidecar has classified the dropped paths; DropImportList
 * renders one row per group with a LibPicker; on commit the row removes
 * itself via `removeGroup`.
 *
 * Sequential association rule (alpha.3, per user spec):
 *   - A dropped FOLDER becomes its own group.
 *   - A LOOSE file (dropped directly, not inside a folder) attaches to
 *     the LAST existing group. If no group exists yet, a new one is
 *     created named after the file's stem.
 *
 * In-memory only — dropped state does NOT persist across app restarts.
 * Source files on disk are untouched, so a user can re-drop after restart.
 */

import { createSignal } from 'solid-js';

export interface DroppedGroup {
  /** Display label + group key. Folder name for folder drops, file stem for loose. */
  name: string;
  /** Absolute path to the .kicad_sym file, or null if none yet. */
  symbol_path: string | null;
  /** Absolute path to the .kicad_mod file, or null if none yet. */
  footprint_path: string | null;
  /** Absolute paths to .step / .stp / .wrl files. May be empty. */
  model_paths: string[];
  /** Source folder for display (parent dir of any file in the group). */
  source_dir: string;
}

export interface LooseFile {
  kind: 'symbol' | 'footprint' | 'model';
  path: string;
}

export interface ScanResult {
  folders: DroppedGroup[];
  loose_files: LooseFile[];
  unmatched: string[];
}

const [groups, setGroups] = createSignal<DroppedGroup[]>([]);

export { groups as droppedGroups };

function basenameStem(p: string): string {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function dirname(p: string): string {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return slash >= 0 ? p.slice(0, slash) : '.';
}

/** Add scanned folder-groups + sequentially attach loose files. */
export function applyScanResult(result: ScanResult): void {
  setGroups((prev) => {
    let next = [...prev];

    // Each folder is appended as a new group, deduped by name (re-drop replaces).
    for (const folder of result.folders) {
      const existingIdx = next.findIndex((g) => g.name === folder.name);
      if (existingIdx >= 0) next[existingIdx] = folder;
      else next.push(folder);
    }

    // Loose files attach to the LAST group. If no group exists, create one
    // named after the first file's stem.
    if (result.loose_files.length > 0) {
      let target: DroppedGroup;
      if (next.length === 0) {
        const first = result.loose_files[0];
        target = {
          name: basenameStem(first.path),
          symbol_path: null,
          footprint_path: null,
          model_paths: [],
          source_dir: dirname(first.path),
        };
        next = [...next, target];
      } else {
        // Mutate a copy of the last group in place (createSignal needs a new ref).
        const lastIdx = next.length - 1;
        target = { ...next[lastIdx] };
        next = [...next.slice(0, lastIdx), target];
      }
      for (const f of result.loose_files) {
        if (f.kind === 'symbol') target.symbol_path = f.path;
        else if (f.kind === 'footprint') target.footprint_path = f.path;
        else if (f.kind === 'model') {
          if (!target.model_paths.includes(f.path)) {
            target.model_paths = [...target.model_paths, f.path];
          }
        }
      }
    }

    return next;
  });
}

/** Direct injection — used by tests / smoke probes that bypass scan_paths. */
export function addGroups(fresh: DroppedGroup[]): void {
  if (fresh.length === 0) return;
  setGroups((prev) => {
    const byName = new Map<string, DroppedGroup>();
    for (const g of prev) byName.set(g.name, g);
    for (const g of fresh) byName.set(g.name, g);
    return Array.from(byName.values());
  });
}

/** Remove one group by name (called after commit OR by user clicking ×). */
export function removeGroup(name: string): void {
  setGroups((prev) => prev.filter((g) => g.name !== name));
}

/** Wipe all dropped groups (e.g. workspace switch). */
export function clearDroppedGroups(): void {
  setGroups([]);
}

/** Returns true if a group is ready to commit (has BOTH sym + fp). */
export function isCommittable(g: DroppedGroup): boolean {
  return !!g.symbol_path && !!g.footprint_path;
}

if (typeof window !== 'undefined') {
  const bag = ((window as any).__kibraryTest = (window as any).__kibraryTest ?? {});
  bag.addDroppedGroups = addGroups;
  bag.applyScanResult = applyScanResult;
  bag.getDroppedGroups = () => groups();
  bag.removeDroppedGroup = removeGroup;
  bag.clearDroppedGroups = clearDroppedGroups;
}
