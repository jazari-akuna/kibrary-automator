/**
 * ComponentMoveModal — modal to move one or more components to another library.
 *
 * Props:
 *   open             — whether the modal is visible
 *   onClose          — called when modal should close
 *   libDir           — absolute path of the source library directory
 *   libName          — display name of the source library
 *   componentName    — single-component scope (mutually exclusive with componentNames)
 *   componentNames   — multi-component scope
 *
 * The modal fetches the list of existing libraries from the workspace, offering
 * them as a dropdown. A "Create new…" option lets the user type a fresh name
 * (backend handles create-vs-merge).
 */

import { createResource, createSignal, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { currentWorkspace } from '~/state/workspace';
import { pushToast } from '~/state/toasts';

interface Props {
  open: boolean;
  onClose: () => void;
  libDir: string;
  libName: string;
  componentName?: string;
  componentNames?: string[];
}

interface LibraryInfo {
  name: string;
  path: string;
}

interface LibraryListResult {
  libraries: LibraryInfo[];
}

const CREATE_NEW_SENTINEL = '__create_new__';

export default function ComponentMoveModal(props: Props) {
  const [selectedDst, setSelectedDst] = createSignal<string>('');
  const [newLibName, setNewLibName] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  // The component names we will operate on
  const names = (): string[] => {
    if (props.componentNames && props.componentNames.length > 0) {
      return props.componentNames;
    }
    if (props.componentName) return [props.componentName];
    return [];
  };

  // Fetch library list when modal opens and workspace is available
  const [libs] = createResource<LibraryListResult | null, string | null>(
    () => (props.open ? (currentWorkspace()?.root ?? null) : null),
    async (root) => {
      if (!root) return null;
      return invoke<LibraryListResult>('sidecar_call', {
        method: 'library.list',
        params: { workspace: root },
      });
    },
  );

  // The actual destination lib name (resolved from dropdown or new-name input)
  const destLibName = (): string => {
    if (selectedDst() === CREATE_NEW_SENTINEL) return newLibName().trim();
    return selectedDst();
  };

  const handleConfirm = async () => {
    const dst = destLibName();
    if (!dst) {
      setError('Select or enter a destination library.');
      return;
    }
    const ws = currentWorkspace();
    if (!ws) {
      setError('No workspace open.');
      return;
    }
    const dstDir = `${ws.root}/${dst}`;

    setBusy(true);
    setError('');
    try {
      // Move components sequentially to keep undo simple
      for (const name of names()) {
        await invoke('sidecar_call', {
          method: 'library.move_component',
          params: {
            src_lib: props.libDir,
            dst_lib: dstDir,
            component_name: name,
          },
        });
      }

      const count = names().length;
      const subject = count === 1 ? `"${names()[0]}"` : `${count} components`;
      pushToast(
        {
          kind: 'success',
          message: `Moved ${subject} to "${dst}"`,
          action: {
            label: 'Undo',
            do: () =>
              invoke('sidecar_call', { method: 'git.undo_last', params: {} }),
          },
        },
        8_000,
      );
      setSelectedDst('');
      setNewLibName('');
      props.onClose();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast({ kind: 'error', message: `Move failed: ${msg}` });
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleClose = () => {
    if (busy()) return;
    setSelectedDst('');
    setNewLibName('');
    setError('');
    props.onClose();
  };

  const otherLibs = () =>
    (libs()?.libraries ?? []).filter((l) => l.name !== props.libName);

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
          <h2 class="text-base font-semibold text-zinc-100">Move component{names().length !== 1 ? 's' : ''}</h2>

          <div class="text-xs text-zinc-400">
            <Show when={names().length === 1}>
              Moving <span class="text-zinc-200">"{names()[0]}"</span> from{' '}
              <span class="text-zinc-200">{props.libName}</span>.
            </Show>
            <Show when={names().length > 1}>
              Moving <span class="text-zinc-200">{names().length} components</span> from{' '}
              <span class="text-zinc-200">{props.libName}</span>.
            </Show>
          </div>

          <div class="flex flex-col gap-2">
            <label class="text-xs text-zinc-400" for="move-dst-select">
              Destination library
            </label>

            <Show when={libs.loading}>
              <span class="text-xs text-zinc-500">Loading libraries…</span>
            </Show>

            <Show when={!libs.loading}>
              <select
                id="move-dst-select"
                value={selectedDst()}
                onChange={(e) => {
                  setSelectedDst(e.currentTarget.value);
                  setError('');
                }}
                class="bg-zinc-700 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400"
              >
                <option value="">— select destination —</option>
                <For each={otherLibs()}>
                  {(lib) => (
                    <option value={lib.name}>{lib.name}</option>
                  )}
                </For>
                <option value={CREATE_NEW_SENTINEL}>Create new…</option>
              </select>
            </Show>

            <Show when={selectedDst() === CREATE_NEW_SENTINEL}>
              <input
                type="text"
                value={newLibName()}
                onInput={(e) => {
                  setNewLibName(e.currentTarget.value);
                  setError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConfirm();
                  if (e.key === 'Escape') handleClose();
                }}
                placeholder="New library name"
                class="bg-zinc-700 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 placeholder-zinc-500"
                autofocus
              />
            </Show>

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
              disabled={busy() || !destLibName()}
            >
              {busy() ? 'Moving…' : 'Move'}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
