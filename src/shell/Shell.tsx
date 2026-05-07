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
  // when the user picks Discard (or there are no edits) we call confirm_quit
  // which destroys the main window — Rust's destroy() bypasses CloseRequested
  // so there's no risk of looping back into the prevent-close handler.
  //
  // Re-entrancy guard (`closing`): if the user clicks the X button multiple
  // times in quick succession, the Tauri event re-emits each time. Without
  // this guard each click queues another `confirmDiscardIfDirty()` and
  // potentially another invoke('confirm_quit'). Stacking native `ask()`
  // dialogs and racing destroy() calls was the user-visible "after saving
  // the app does not want to close anymore" bug in v26.5.7-alpha.1 — the
  // first click's ask() dialog was already pending so subsequent clicks
  // either piled more dialogs on top or no-op'd while the first awaited.
  //
  // Registered via onMount so the listen() Promise resolves *after* mount
  // (not racing the Tauri event loop's first emit at startup).
  let unlistenClose: (() => void) | undefined;
  let closing = false;
  onMount(async () => {
    try {
      unlistenClose = await listen('app.close-requested', async () => {
        if (closing) return;
        closing = true;
        try {
          const ok = await confirmDiscardIfDirty('quit');
          if (ok) {
            await invoke('confirm_quit');
          } else {
            // User cancelled — release the guard so a subsequent X-click
            // can re-prompt.
            closing = false;
          }
        } catch (e) {
          console.error('[shell] confirm_quit failed:', e);
          closing = false;
        }
      });
    } catch (e) {
      console.warn('[shell] close-requested listen failed:', e);
    }
  });
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
