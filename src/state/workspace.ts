import { createSignal } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { refreshLcscIndex } from './lcscIndex';
import { TAURI_EVENT_NAMES } from '~/utils/eventNames';

export interface Workspace { root: string; settings: any; }

interface WorkspaceOpenResult extends Workspace {
  first_run: boolean;
}

function readRecents(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem('recents') ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function writeRecents(paths: string[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem('recents', JSON.stringify(paths));
  } catch {
    // Recents are a convenience cache; workspace open must still succeed.
  }
}

const [current, setCurrent] = createSignal<Workspace | null>(null);
const [recents, setRecents] = createSignal<string[]>(readRecents());
const [firstRun, setFirstRun] = createSignal(false);

export { current as currentWorkspace, recents as recentWorkspaces, firstRun };

export function dismissFirstRun() {
  setFirstRun(false);
}

export async function openWorkspace(path: string) {
  const result = await invoke<WorkspaceOpenResult>('workspace_open', { root: path });
  const { first_run, ...ws } = result;
  setCurrent(ws);
  if (first_run) setFirstRun(true);
  const next = [path, ...recents().filter((p) => p !== path)].slice(0, 10);
  setRecents(next);
  writeRecents(next);
  // Start the fs watcher for the staging directory (T28).
  // Fire-and-forget: watcher failure is non-fatal (no staging dir yet is OK).
  invoke('watch_workspace', { workspace: path }).catch((e) =>
    console.warn('[watcher] watch_workspace failed:', e)
  );

  // alpha.17: warm the LCSC-in-library index in the background so the
  // SearchPanel can flag duplicates as soon as the user starts typing.
  refreshLcscIndex(path);
}

// Expose to WebDriver tests so they can drive workspace open without going
// through the native dialog. Calling __TAURI_INTERNALS__.invoke('workspace_open')
// directly bypasses setCurrent() and leaves the SolidJS signal stale.
//
// Also exposes a probe so tests can check Tauri-event delivery: if the row
// stays "downloading" but events do arrive (capturedEvents > 0) then the
// bug is in queue.ts; if no events arrive then the Rust→webview emit path
// is broken. Either way the smoke test surfaces it.
if (typeof window !== 'undefined') {
  // Merge into the existing test bag (other state modules — e.g. lcscIndex.ts —
  // also publish hooks here). Earlier alphas overwrote the object outright,
  // which silently dropped keys whose modules happened to load first.
  const bag = ((window as any).__kibraryTest = (window as any).__kibraryTest ?? {});
  bag.openWorkspace = openWorkspace;
  bag.capturedProgress = bag.capturedProgress ?? ([] as any[]);
  bag.armProgressCapture = async () => {
    const { listen } = await import('@tauri-apps/api/event');
    await listen(TAURI_EVENT_NAMES.downloadProgress, (e: any) => {
      bag.capturedProgress.push(e.payload);
    });
  };
}

export async function pickAndOpen() {
  try {
    const path = await openDialog({ directory: true, multiple: false });
    if (typeof path === 'string') await openWorkspace(path);
  } catch (e) {
    console.error('[workspace] pickAndOpen failed:', e);
    throw e;
  }
}
