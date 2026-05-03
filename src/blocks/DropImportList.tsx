/**
 * DropImportList — "Dropped imports" panel mounted in RoomAdd.
 *
 * One row per group the user has dragged onto the app window. Each row:
 *  - Name (basename stem) + badges showing which file kinds are present
 *  - LibPicker for target library (free-text creates new, dropdown picks
 *    existing — same picker used by ReviewBulkAssign for LCSC parts)
 *  - "Move to library" button → calls drop.commit_group, removes the row
 *  - On success: "Open in library" button navigates to the Libraries room
 *    and pre-selects the library + component (mirrors the post-commit
 *    button in ReviewBulkAssign).
 *
 * Source files are NEVER moved — drop.commit_group copies into the target
 * library directory layout. The user's original files stay where they
 * were dropped from.
 */

import { createSignal, createEffect, For, Show, Index } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { droppedGroups, removeGroup, isCommittable, type DroppedGroup } from '~/state/dropImport';
import { currentWorkspace } from '~/state/workspace';
import { setRoom } from '~/state/room';
import { setSelectedLib, setSelectedComponent } from '~/state/librariesRoom';
import LibPicker from '~/components/LibPicker';

interface LibraryListResult {
  libraries: { name: string }[];
}

type RowSaveState = 'idle' | 'saving' | 'ok' | 'error';

interface RowState {
  name: string;
  targetLib: string;
  saveState: RowSaveState;
  errorMsg: string;
  committedLib?: string;
  committedComponent?: string;
}

export default function DropImportList() {
  const [existingLibs, setExistingLibs] = createSignal<string[]>([]);
  const [rowState, setRowState] = createSignal<Record<string, RowState>>({});

  // Refresh existing libs whenever a drop arrives or the workspace changes,
  // so a freshly-created library from a previous commit shows up in the
  // picker without needing a manual refresh.
  createEffect(() => {
    const ws = currentWorkspace();
    droppedGroups(); // depend on the signal so refresh fires on new drops
    if (!ws) {
      setExistingLibs([]);
      return;
    }
    invoke<LibraryListResult>('sidecar_call', {
      method: 'library.list',
      params: { workspace: ws.root },
    })
      .then((r) => setExistingLibs(r.libraries.map((l) => l.name)))
      .catch(() => setExistingLibs([]));
  });

  const ensureRow = (g: DroppedGroup): RowState => {
    const cur = rowState()[g.name];
    if (cur) return cur;
    const fresh: RowState = {
      name: g.name,
      targetLib: '',
      saveState: 'idle',
      errorMsg: '',
    };
    setRowState((prev) => ({ ...prev, [g.name]: fresh }));
    return fresh;
  };

  const updateRow = (name: string, patch: Partial<RowState>) => {
    setRowState((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }));
  };

  const commit = async (g: DroppedGroup) => {
    const ws = currentWorkspace();
    if (!ws) return;
    const row = ensureRow(g);
    const targetLib = row.targetLib.trim();
    if (!targetLib) {
      updateRow(g.name, { saveState: 'error', errorMsg: 'Pick a target library first' });
      return;
    }
    // alpha.3: enforce the user's "symbol + footprint required" rule —
    // committing partial drops (footprint-only or symbol-only) into an
    // existing library used to silently corrupt the merge or leave files
    // on the floor (the IPEX_20952 bug). The button itself is also
    // disabled below as a defense-in-depth UX guard.
    if (!isCommittable(g)) {
      const missing = [
        !g.symbol_path && '.kicad_sym',
        !g.footprint_path && '.kicad_mod',
      ].filter(Boolean).join(' + ');
      updateRow(g.name, { saveState: 'error', errorMsg: `Missing ${missing}` });
      return;
    }
    updateRow(g.name, { saveState: 'saving', errorMsg: '' });
    try {
      const result = await invoke<{
        committed_path: string;
        component_name: string;
        target_lib: string;
      }>('sidecar_call', {
        method: 'drop.commit_group',
        params: {
          workspace: ws.root,
          group: g,
          target_lib: targetLib,
        },
      });
      updateRow(g.name, {
        saveState: 'ok',
        committedLib: result.target_lib,
        committedComponent: result.component_name,
      });
    } catch (e) {
      updateRow(g.name, { saveState: 'error', errorMsg: String(e) });
    }
  };

  const openInLibrary = (row: RowState, groupName: string) => {
    if (!row.committedLib || !row.committedComponent) return;
    setRoom('libraries');
    setSelectedLib(row.committedLib);
    setSelectedComponent(row.committedComponent);
    removeGroup(groupName);
  };

  return (
    <Show when={droppedGroups().length > 0}>
      <div class="space-y-3" data-testid="drop-import-list">
        <h2 class="font-semibold text-sm">Dropped Imports ({droppedGroups().length})</h2>
        <p class="text-xs text-zinc-500">
          Files dropped onto the window. Pick a target library and commit; the original files are
          left untouched.
        </p>

        <div class="overflow-x-auto">
          <table class="w-full text-sm border-collapse">
            <thead>
              <tr class="text-left text-zinc-400 text-xs border-b border-zinc-700">
                <th class="pb-1 pr-3 font-medium">Name</th>
                <th class="pb-1 pr-3 font-medium">Files</th>
                <th class="pb-1 pr-3 font-medium">Source</th>
                <th class="pb-1 pr-3 font-medium">Library</th>
                <th class="pb-1 pr-3 font-medium">Status</th>
                <th class="pb-1 font-medium w-8"></th>
              </tr>
            </thead>
            <tbody>
              <Index each={droppedGroups()}>
                {(g) => {
                  const grp = () => g();
                  // Keep row state in sync with the group identity. ensureRow
                  // is idempotent so calling it on every render is cheap.
                  createEffect(() => ensureRow(grp()));
                  const row = () => rowState()[grp().name] ?? ensureRow(grp());

                  return (
                    <tr class="border-b border-zinc-800 align-top">
                      <td class="py-2 pr-3 font-mono text-zinc-100">{grp().name}</td>
                      <td class="py-2 pr-3 text-xs">
                        <div class="flex gap-1">
                          <Show when={grp().symbol_path}>
                            <span class="px-1.5 py-0.5 rounded bg-emerald-900 text-emerald-200" title={grp().symbol_path!}>S</span>
                          </Show>
                          <Show when={grp().footprint_path}>
                            <span class="px-1.5 py-0.5 rounded bg-blue-900 text-blue-200" title={grp().footprint_path!}>F</span>
                          </Show>
                          <Show when={grp().model_paths.length > 0}>
                            <span class="px-1.5 py-0.5 rounded bg-amber-900 text-amber-200" title={grp().model_paths.join('\n')}>3D×{grp().model_paths.length}</span>
                          </Show>
                        </div>
                      </td>
                      <td class="py-2 pr-3 text-xs text-zinc-500 font-mono truncate max-w-[200px]" title={grp().source_dir}>
                        {grp().source_dir}
                      </td>
                      <td class="py-2 pr-3">
                        <LibPicker
                          value={row().targetLib}
                          existing={existingLibs()}
                          suggested=""
                          matches={[]}
                          disabled={row().saveState === 'saving' || row().saveState === 'ok'}
                          onChange={(v) => updateRow(grp().name, { targetLib: v })}
                        />
                      </td>
                      <td class="py-2 pr-3 text-xs">
                        <Show when={row().saveState === 'idle'}>
                          <span class="text-zinc-500">—</span>
                        </Show>
                        <Show when={row().saveState === 'saving'}>
                          <span class="text-zinc-400">Saving…</span>
                        </Show>
                        <Show when={row().saveState === 'ok'}>
                          <button
                            class="px-2 py-0.5 rounded bg-emerald-700 text-emerald-100 hover:bg-emerald-600 text-xs"
                            onClick={() => openInLibrary(row(), grp().name)}
                          >
                            Open in library
                          </button>
                        </Show>
                        <Show when={row().saveState === 'error'}>
                          <span class="text-red-400" title={row().errorMsg}>{row().errorMsg.slice(0, 40)}</span>
                        </Show>
                      </td>
                      <td class="py-2 text-xs">
                        <div class="flex items-center gap-1">
                          <Show when={row().saveState !== 'ok'}>
                            <button
                              class="px-2 py-0.5 rounded bg-zinc-700 text-zinc-100 hover:bg-zinc-600 disabled:opacity-30 disabled:cursor-not-allowed text-xs"
                              disabled={
                                row().saveState === 'saving' ||
                                !row().targetLib.trim() ||
                                !isCommittable(grp())
                              }
                              title={
                                !isCommittable(grp())
                                  ? `Need both .kicad_sym and .kicad_mod (missing ${
                                      [!grp().symbol_path && 'symbol', !grp().footprint_path && 'footprint']
                                        .filter(Boolean)
                                        .join(' + ')
                                    })`
                                  : 'Move into target library'
                              }
                              onClick={() => commit(grp())}
                            >
                              Move
                            </button>
                          </Show>
                          {/* alpha.3: per-row × button so the user can
                              dismiss a wrongly-grouped row without having
                              to commit it — applies to ANY state. */}
                          <button
                            class="px-1.5 py-0.5 rounded text-zinc-500 hover:bg-zinc-700 hover:text-red-400 text-xs"
                            disabled={row().saveState === 'saving'}
                            title={`Remove ${grp().name} from list (does not delete source files)`}
                            aria-label={`Remove ${grp().name}`}
                            onClick={() => removeGroup(grp().name)}
                          >
                            ×
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }}
              </Index>
            </tbody>
          </table>
        </div>
      </div>
    </Show>
  );
}
