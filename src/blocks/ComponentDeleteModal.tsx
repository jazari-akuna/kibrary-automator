/**
 * ComponentDeleteModal — confirmation modal for deleting one or more components.
 *
 * Props:
 *   open             — whether the modal is visible
 *   onClose          — called when modal should close
 *   libDir           — absolute path to the library directory
 *   libName          — display name of the library
 *   componentName    — single-component scope
 *   componentNames   — multi-component scope
 *
 * Shows a simple confirmation message (diff preview is deferred to P3 polish).
 * The confirm button is deliberately destructive (red).
 * Components are deleted sequentially to keep undo simple.
 */

import { createSignal, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { pushToast } from '~/state/toasts';

interface Props {
  open: boolean;
  onClose: () => void;
  libDir: string;
  libName: string;
  componentName?: string;
  componentNames?: string[];
}

export default function ComponentDeleteModal(props: Props) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  const names = (): string[] => {
    if (props.componentNames && props.componentNames.length > 0) {
      return props.componentNames;
    }
    if (props.componentName) return [props.componentName];
    return [];
  };

  const handleConfirm = async () => {
    setBusy(true);
    setError('');
    try {
      // Delete sequentially so a single undo reverts all in one git operation
      for (const name of names()) {
        await invoke('sidecar_call', {
          method: 'library.delete_component',
          params: {
            lib_dir: props.libDir,
            component_name: name,
          },
        });
      }

      const count = names().length;
      const subject = count === 1 ? `"${names()[0]}"` : `${count} components`;
      pushToast(
        {
          kind: 'success',
          message: `Deleted ${subject} from "${props.libName}"`,
          action: {
            label: 'Undo',
            do: () =>
              invoke('sidecar_call', { method: 'git.undo_last', params: {} }),
          },
        },
        8_000,
      );
      props.onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast({ kind: 'error', message: `Delete failed: ${msg}` });
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleClose = () => {
    if (busy()) return;
    setError('');
    props.onClose();
  };

  return (
    <Show when={props.open}>
      {/* Backdrop */}
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        onClick={handleClose}
      >
        {/* Card */}
        <div
          class="bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl p-6 w-96 flex flex-col gap-4"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 class="text-base font-semibold text-zinc-100">
            Delete component{names().length !== 1 ? 's' : ''}
          </h2>

          {/* Confirmation message */}
          <div class="text-sm text-zinc-300">
            <Show when={names().length === 1}>
              This will permanently delete{' '}
              <span class="font-medium text-zinc-100">"{names()[0]}"</span> from{' '}
              <span class="font-medium text-zinc-100">{props.libName}</span>.
            </Show>
            <Show when={names().length > 1}>
              This will permanently delete{' '}
              <span class="font-medium text-zinc-100">{names().length} components</span> from{' '}
              <span class="font-medium text-zinc-100">{props.libName}</span>:
              <ul class="mt-2 ml-4 list-disc text-xs text-zinc-400 max-h-32 overflow-y-auto">
                <For each={names()}>
                  {(name) => <li>{name}</li>}
                </For>
              </ul>
            </Show>
          </div>

          <p class="text-xs text-zinc-500">
            You can undo this action immediately after if needed.
          </p>

          <Show when={error()}>
            <span class="text-xs text-red-400">{error()}</span>
          </Show>

          <div class="flex justify-end gap-2 pt-1">
            <button
              class="px-3 py-1.5 text-sm rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors"
              onClick={handleClose}
              disabled={busy()}
            >
              Cancel
            </button>
            <button
              class="px-3 py-1.5 text-sm rounded bg-red-700 hover:bg-red-600 text-white transition-colors disabled:opacity-50"
              onClick={handleConfirm}
              disabled={busy() || names().length === 0}
            >
              {busy() ? 'Deleting…' : `Delete${names().length > 1 ? ` (${names().length})` : ''}`}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
