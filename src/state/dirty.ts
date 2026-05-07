/**
 * Global "unsaved positioner edits" state.
 *
 * Model3DPreview owns the live offset / rotation / scale signals plus the
 * baseline pulled from disk via `library.get_3d_info`. When the live values
 * drift away from the baseline by more than a small epsilon, the user has
 * unsaved work and we must warn before:
 *
 *   1. closing the window  (Tauri CloseRequested handler)
 *   2. switching to a different library / component in the Libraries pane
 *
 * The signals here are the single source of truth for both surfaces.
 *
 * Why a global module rather than prop-drilling?
 *   The Tauri close handler runs in Rust and reaches the frontend through a
 *   window event. There's no React/Solid component tree to thread props
 *   through — the listener needs a stable, module-scoped accessor.
 */

import { createSignal } from 'solid-js';

export type Triple = [number, number, number];

// Offset epsilon: 1 µm. KiCad stores model offsets in mm with 3-decimal
// fidelity in the .kicad_mod file; anything below 1 µm is round-trip
// noise from float→string→float and should not count as a real edit.
const OFFSET_EPS = 1e-3;
// Rotation epsilon: 0.1°. The positioner's rotation input has step="0.1",
// so anything tighter than that is sub-pixel float noise.
const ROTATION_EPS = 0.1;
// Scale epsilon: 1e-4 (positioner step is 0.01 — give us a 100× safety
// margin against float noise without missing a real 0.01 edit).
const SCALE_EPS = 1e-4;

function tripleDiffersBy(a: Triple, b: Triple, eps: number): boolean {
  return (
    Math.abs(a[0] - b[0]) > eps ||
    Math.abs(a[1] - b[1]) > eps ||
    Math.abs(a[2] - b[2]) > eps
  );
}

/**
 * Pure helper — exported for unit tests. Returns true iff any of the three
 * triples differ from their saved baseline by more than the per-axis epsilon.
 */
export function computeIsDirty(
  liveOffset: Triple,
  savedOffset: Triple,
  liveRotation: Triple,
  savedRotation: Triple,
  liveScale: Triple,
  savedScale: Triple,
): boolean {
  return (
    tripleDiffersBy(liveOffset, savedOffset, OFFSET_EPS) ||
    tripleDiffersBy(liveRotation, savedRotation, ROTATION_EPS) ||
    tripleDiffersBy(liveScale, savedScale, SCALE_EPS)
  );
}

const [isDirty, setIsDirty] = createSignal(false);

export { isDirty, setIsDirty };

// Test/debug hook — same pattern as librariesRoom.ts. Lets the smoke /
// Playwright harness flip the flag without mounting Model3DPreview.
if (typeof window !== 'undefined') {
  const bag = ((window as any).__kibraryTest = (window as any).__kibraryTest ?? {});
  bag.getIsDirty = () => isDirty();
  bag.setIsDirty = (v: boolean) => setIsDirty(v);
}

/**
 * Show a "Discard / Cancel" confirmation when there are unsaved edits.
 * Returns true when it's safe to proceed (no edits, OR user picked Discard).
 * Returns false when the user picked Cancel and we must abort the action.
 *
 * The dialog is the Tauri OS-native ask() — works on Linux/macOS/Windows
 * without any custom modal markup, and survives the window-close path
 * where the webview may be tearing down its component tree.
 */
export async function confirmDiscardIfDirty(
  context: 'quit' | 'switch',
): Promise<boolean> {
  if (!isDirty()) return true;
  // Lazy-import so vitest unit tests that import this module don't try to
  // resolve the Tauri plugin (which needs the Tauri runtime context).
  const { ask } = await import('@tauri-apps/plugin-dialog');
  const message =
    context === 'quit'
      ? 'You have unsaved 3D position changes. Discard them and quit?'
      : 'You have unsaved 3D position changes. Discard them and switch component?';
  const ok = await ask(message, {
    title: 'Unsaved changes',
    kind: 'warning',
    okLabel: 'Discard',
    cancelLabel: 'Cancel',
  });
  return ok === true;
}
