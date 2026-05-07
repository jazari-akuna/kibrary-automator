import { Switch, Match, Show, lazy, onCleanup, onMount } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import LeftRail from './LeftRail';
import Header from './Header';
import { room } from '~/state/room';
import BlockHost from './BlockHost';
import ToastHost from './ToastHost';
import {
  firstRun,
  currentWorkspace,
  recentWorkspaces,
  openWorkspace,
} from '~/state/workspace';
import { confirmDiscardIfDirty } from '~/state/dirty';
import UpdatePrompt from '~/blocks/UpdatePrompt';
import DropZoneOverlay from '~/blocks/DropZoneOverlay';

const FirstRunWizard = lazy(() => import('~/blocks/FirstRunWizard'));

export default function Shell() {
  // Bug 8 — auto-open the most recent workspace on launch.
  //
  // The header shows the last-opened workspace path because it's persisted to
  // localStorage, but nothing actually re-opens it. Without a workspace, the
  // Libraries / Settings rooms render empty stubs and the user has to click
  // their recent path manually every launch.
  //
  // Fire once on mount; if it fails (path no longer exists, sidecar errors,
  // …) leave currentWorkspace null so the WorkspacePicker stays visible.
  onMount(async () => {
    if (currentWorkspace()) return;
    const recents = recentWorkspaces();
    if (recents.length === 0) return;
    try {
      await openWorkspace(recents[0]);
    } catch (e) {
      console.warn('[shell] auto-open of last workspace failed:', e);
    }
  });

  // Window-close guard: Rust intercepts CloseRequested, prevents the close,
  // and emits 'app.close-requested'. We surface the unsaved-edits prompt;
  // if the user picks Discard we call confirm_quit which latches the
  // "ok to quit" flag in Rust and re-closes the window.
  let unlistenClose: (() => void) | undefined;
  listen('app.close-requested', async () => {
    const ok = await confirmDiscardIfDirty('quit');
    if (ok) {
      try {
        await invoke('confirm_quit');
      } catch (e) {
        console.error('[shell] confirm_quit failed:', e);
      }
    }
  })
    .then((unlisten) => {
      unlistenClose = unlisten;
    })
    .catch((e) => console.warn('[shell] close-requested listen failed:', e));
  onCleanup(() => unlistenClose?.());

  return (
    <div class="h-screen flex flex-col">
      <Header />
      <div class="flex flex-1 min-h-0">
        <LeftRail />
        <main class="flex-1 overflow-auto p-4">
          <Switch>
            <Match when={room() === 'add'}>
              <BlockHost id="room-add" />
            </Match>
            <Match when={room() === 'libraries'}>
              <BlockHost id="room-libraries" />
            </Match>
            <Match when={room() === 'settings'}>
              <BlockHost id="room-settings" />
            </Match>
          </Switch>
        </main>
      </div>
      <UpdatePrompt />
      <DropZoneOverlay />
      <ToastHost />
      <Show when={firstRun()}>
        <FirstRunWizard />
      </Show>
    </div>
  );
}
