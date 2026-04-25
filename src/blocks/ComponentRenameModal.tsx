/**
 * ComponentRenameModal — modal to rename a single component in a library.
 *
 * Props:
 *   open          — whether the modal is visible
 *   onClose       — called when modal should close (after confirm or cancel)
 *   libDir        — absolute path to the library directory
 *   libName       — display name of the library
 *   componentName — the component being renamed
 */

import { createSignal, Show } from 'solid-js';
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

const VALID_NAME = /^[A-Za-z0-9_]+$/;

export default function ComponentRenameModal(props: Props) {
  const [newName, setNewName] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  const oldName = () => props.componentName ?? '';

  const validate = (): string => {
    const n = newName().trim();
    if (!n) return 'Name cannot be empty.';
    if (!VALID_NAME.test(n)) return 'Name must match ^[A-Za-z0-9_]+$.';
    if (n === oldName()) return 'New name must differ from the current name.';
    return '';
  };

  const handleConfirm = async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await invoke('sidecar_call', {
        method: 'library.rename_component',
        params: {
          lib_dir: props.libDir,
          old_name: oldName(),
          new_name: newName().trim(),
        },
      });
      pushToast(
        {
          kind: 'success',
          message: `Renamed "${oldName()}" → "${newName().trim()}"`,
          action: {
            label: 'Undo',
            do: () =>
              invoke('sidecar_call', { method: 'git.undo_last', params: {} }),
          },
        },
        8_000,
      );
      setNewName('');
      props.onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast({ kind: 'error', message: `Rename failed: ${msg}` });
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleClose = () => {
    if (busy()) return;
    setNewName('');
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
          <h2 class="text-base font-semibold text-zinc-100">Rename component</h2>

          <div class="flex flex-col gap-1">
            <label class="text-xs text-zinc-400">
              Current name: <span class="text-zinc-200">{oldName()}</span>
            </label>
            <label class="text-xs text-zinc-400" for="rename-input">
              New name
            </label>
            <input
              id="rename-input"
              type="text"
              value={newName()}
              onInput={(e) => {
                setNewName(e.currentTarget.value);
                setError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirm();
                if (e.key === 'Escape') handleClose();
              }}
              placeholder="e.g. R_10k_0402_v2"
              class="bg-zinc-700 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 placeholder-zinc-500"
              autofocus
            />
            <Show when={error()}>
              <span class="text-xs text-red-400">{error()}</span>
            </Show>
          </div>

          <div class="flex justify-end gap-2 pt-1">
            <button
              class="px-3 py-1.5 text-sm rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors"
              onClick={handleClose}
              disabled={busy()}
            >
              Cancel
            </button>
            <button
              class="px-3 py-1.5 text-sm rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors disabled:opacity-50"
              onClick={handleConfirm}
              disabled={busy() || !newName().trim()}
            >
              {busy() ? 'Renaming…' : 'Rename'}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
