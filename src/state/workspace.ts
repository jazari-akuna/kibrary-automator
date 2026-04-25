import { createSignal } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

export interface Workspace { root: string; settings: any; }

const [current, setCurrent] = createSignal<Workspace | null>(null);
const [recents, setRecents] = createSignal<string[]>(
  JSON.parse(localStorage.getItem('recents') ?? '[]')
);

export { current as currentWorkspace, recents as recentWorkspaces };

export async function openWorkspace(path: string) {
  const ws = await invoke<Workspace>('workspace_open', { root: path });
  setCurrent(ws);
  const next = [path, ...recents().filter((p) => p !== path)].slice(0, 10);
  setRecents(next);
  localStorage.setItem('recents', JSON.stringify(next));
}

export async function pickAndOpen() {
  const path = await openDialog({ directory: true, multiple: false });
  if (typeof path === 'string') await openWorkspace(path);
}
