import { createSignal } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

export interface Workspace { root: string; settings: any; }

interface WorkspaceOpenResult extends Workspace {
  first_run: boolean;
}

const [current, setCurrent] = createSignal<Workspace | null>(null);
const [recents, setRecents] = createSignal<string[]>(
  JSON.parse(localStorage.getItem('recents') ?? '[]')
);
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
  localStorage.setItem('recents', JSON.stringify(next));
  // Start the fs watcher for the staging directory (T28).
  // Fire-and-forget: watcher failure is non-fatal (no staging dir yet is OK).
  invoke('watch_workspace', { workspace: path }).catch((e) =>
    console.warn('[watcher] watch_workspace failed:', e)
  );
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
