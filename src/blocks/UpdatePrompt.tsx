/**
 * UpdatePrompt — fixed top banner shown when a new app version is available.
 *
 * On mount: calls checkForUpdate(). If an update is found, renders a non-modal
 * banner at the top of the viewport. Dismissed (until next launch) via a
 * sessionStorage flag.
 *
 * Mount order in Shell.tsx:
 *   <UpdatePrompt />   ← before ToastHost so toasts stack on top
 *   <ToastHost />
 */

import { createSignal, Show } from 'solid-js';
import { onMount } from 'solid-js';
import { type Update } from '@tauri-apps/plugin-updater';
import { checkForUpdate, downloadAndInstall, quitApp } from '~/api/updater';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase =
  | 'idle'        // no update (or dismissed)
  | 'available'   // update found, banner visible
  | 'downloading' // [Update now] clicked, progress bar running
  | 'ready';      // download complete, prompt to restart

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function ProgressBar(props: { value: number }) {
  // value: 0–100 (or -1 for indeterminate)
  return (
    <div class="w-full h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded overflow-hidden">
      <div
        class="h-full bg-green-500 transition-all duration-200"
        style={{ width: props.value < 0 ? '100%' : `${props.value}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function UpdatePrompt() {
  const [phase, setPhase] = createSignal<Phase>('idle');
  const [update, setUpdate] = createSignal<Update | null>(null);
  const [progress, setProgress] = createSignal(-1); // -1 = indeterminate
  const [restarting, setRestarting] = createSignal(false);

  onMount(async () => {
    // Don't show again if dismissed this session
    if (sessionStorage.getItem('update-dismissed') === '1') return;

    try {
      const u = await checkForUpdate();
      if (!u) return;
      setUpdate(u);
      setPhase('available');
    } catch {
      // Offline or server unreachable — silently skip
    }
  });

  const handleUpdateNow = async () => {
    const u = update();
    if (!u) return;

    setPhase('downloading');
    setProgress(-1);

    let total: number | undefined;
    let received = 0;

    try {
      await u.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength;
          setProgress(total ? 0 : -1);
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength;
          if (total) {
            setProgress(Math.round((received / total) * 100));
          }
        } else if (event.event === 'Finished') {
          setProgress(100);
        }
      });
      setPhase('ready');
    } catch {
      // On failure, go back to 'available' so the user can retry
      setPhase('available');
    }
  };

  const handleQuit = async () => {
    setRestarting(true);
    try {
      await quitApp();
      // If we got here, the process didn't exit — surface that so the user
      // isn't left staring at a frozen "Restarting…" button.
      setRestarting(false);
    } catch {
      setRestarting(false);
    }
  };

  const handleDismiss = () => {
    sessionStorage.setItem('update-dismissed', '1');
    setPhase('idle');
  };

  return (
    <Show when={phase() !== 'idle'}>
      <div
        class="fixed top-0 left-0 right-0 z-50 bg-zinc-100 dark:bg-zinc-900 border-l-4 border-green-600 px-4 py-2 flex items-center gap-3 text-sm text-zinc-900 dark:text-white shadow-lg"
        role="status"
        aria-live="polite"
      >
        {/* Message area */}
        <div class="flex-1 min-w-0">
          <Show when={phase() === 'available'}>
            <span>
              Update&nbsp;
              <span class="font-semibold text-green-400">v{update()?.version}</span>
              &nbsp;available.
            </span>
          </Show>

          <Show when={phase() === 'downloading'}>
            <div class="space-y-1">
              <span class="text-zinc-700 dark:text-zinc-300">
                Downloading update v{update()?.version}…
                {progress() >= 0 && <span class="ml-1 text-zinc-600 dark:text-zinc-400">{progress()}%</span>}
              </span>
              <ProgressBar value={progress()} />
            </div>
          </Show>

          <Show when={phase() === 'ready'}>
            <span class="text-green-400">
              Update installed. Quit Kibrary and re-open it to apply.
            </span>
          </Show>
        </div>

        {/* Actions */}
        <div class="flex items-center gap-2 flex-shrink-0">
          <Show when={phase() === 'available'}>
            <button
              class="px-3 py-1 bg-green-600 hover:bg-green-500 text-white text-xs font-semibold rounded transition-colors"
              onClick={handleUpdateNow}
            >
              Update now
            </button>
            <button
              class="px-3 py-1 bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-300 text-xs rounded transition-colors"
              onClick={handleDismiss}
            >
              Later
            </button>
          </Show>

          <Show when={phase() === 'ready'}>
            <button
              class="px-3 py-1 bg-green-600 hover:bg-green-500 text-white text-xs font-semibold rounded transition-colors disabled:opacity-50"
              onClick={handleQuit}
              disabled={restarting()}
            >
              {restarting() ? 'Quitting…' : 'Quit Kibrary'}
            </button>
          </Show>
        </div>

        {/* Dismiss (×) — hide during active download */}
        <Show when={phase() !== 'downloading'}>
          <button
            class="flex-shrink-0 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white text-lg leading-none ml-1"
            aria-label="Dismiss update banner"
            onClick={handleDismiss}
          >
            ×
          </button>
        </Show>
      </div>
    </Show>
  );
}
