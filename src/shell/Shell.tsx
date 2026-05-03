import { Switch, Match, Show, lazy, onMount } from 'solid-js';
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
