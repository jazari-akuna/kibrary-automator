/**
 * ToastHost — fixed bottom-right overlay that renders active toasts.
 *
 * Mount once inside Shell.tsx:
 *   <ToastHost />
 */

import { For, Show, createSignal } from 'solid-js';
import { toasts, dismissToast, type Toast } from '~/state/toasts';

// ---------------------------------------------------------------------------
// Icon helpers
// ---------------------------------------------------------------------------

function IconInfo() {
  return (
    <svg class="w-5 h-5 flex-shrink-0 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
      <path
        fill-rule="evenodd"
        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
        clip-rule="evenodd"
      />
    </svg>
  );
}

function IconSuccess() {
  return (
    <svg class="w-5 h-5 flex-shrink-0 text-green-400" fill="currentColor" viewBox="0 0 20 20">
      <path
        fill-rule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
        clip-rule="evenodd"
      />
    </svg>
  );
}

function IconError() {
  return (
    <svg class="w-5 h-5 flex-shrink-0 text-red-400" fill="currentColor" viewBox="0 0 20 20">
      <path
        fill-rule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
        clip-rule="evenodd"
      />
    </svg>
  );
}

function ToastIcon(props: { kind: Toast['kind'] }) {
  return (
    <>
      {props.kind === 'info' && <IconInfo />}
      {props.kind === 'success' && <IconSuccess />}
      {props.kind === 'error' && <IconError />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Single toast card
// ---------------------------------------------------------------------------

function ToastCard(props: { toast: Toast }) {
  const [busy, setBusy] = createSignal(false);

  async function handleAction() {
    if (!props.toast.action) return;
    setBusy(true);
    try {
      await props.toast.action.do();
      dismissToast(props.toast.id);
    } catch {
      // leave toast visible so user can see it failed
    } finally {
      setBusy(false);
    }
  }

  const borderColor = () => {
    switch (props.toast.kind) {
      case 'success': return 'border-green-500';
      case 'error':   return 'border-red-500';
      default:        return 'border-blue-500';
    }
  };

  return (
    <div
      class={`flex items-start gap-3 w-80 max-w-full bg-zinc-100 dark:bg-zinc-900 border-l-4 ${borderColor()} rounded shadow-lg p-3 text-sm text-zinc-900 dark:text-white animate-fade-in`}
      role="alert"
    >
      <ToastIcon kind={props.toast.kind} />

      <div class="flex-1 min-w-0">
        <p class="break-words">{props.toast.message}</p>

        <Show when={props.toast.action}>
          {(action) => (
            <button
              class="mt-1 text-xs font-semibold underline hover:no-underline disabled:opacity-50"
              disabled={busy()}
              onClick={handleAction}
            >
              {busy() ? 'Working…' : action().label}
            </button>
          )}
        </Show>
      </div>

      <button
        class="flex-shrink-0 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white leading-none"
        aria-label="Dismiss"
        onClick={() => dismissToast(props.toast.id)}
      >
        ×
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Host — fixed overlay, newest toast on top
// ---------------------------------------------------------------------------

export default function ToastHost() {
  return (
    <div
      class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-atomic="false"
    >
      <For each={toasts()}>
        {(t) => (
          <div class="pointer-events-auto">
            <ToastCard toast={t} />
          </div>
        )}
      </For>
    </div>
  );
}
