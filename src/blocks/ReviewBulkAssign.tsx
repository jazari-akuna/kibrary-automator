/**
 * ReviewBulkAssign — Task 22 Solid block.
 *
 * For each 'ready' queue item:
 *  1. Read meta via parts.read_meta  → description + suggested_lib
 *  2. If suggested_lib absent, call library.suggest({category}) → default Misc_KSL
 *
 * Renders a table with per-row override dropdowns and a "Save all N" button
 * that calls library.commit for each item.
 */

import { createSignal, createEffect, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { queueItems, setStatus } from '~/state/queue';
import { currentWorkspace } from '~/state/workspace';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PartMeta {
  lcsc: string;
  description?: string;
  category?: string;
  suggested_lib?: string;
  edits?: Record<string, string>;
  [key: string]: unknown;
}

type RowSaveState = 'idle' | 'saving' | 'ok' | 'error';

interface RowState {
  lcsc: string;
  description: string;
  suggestedLib: string;
  overrideLib: string;   // what the user picked / typed
  newLibInput: string;   // text box value when "Create new…" is active
  showNewInput: boolean; // whether the "Create new…" text input is visible
  edits: Record<string, string>;
  saveState: RowSaveState;
  errorMsg: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FALLBACK_LIB = 'Misc_KSL';

async function fetchMeta(
  stagingDir: string,
  lcsc: string,
): Promise<PartMeta> {
  return invoke<PartMeta>('sidecar_call', {
    method: 'parts.read_meta',
    params: { staging_dir: stagingDir, lcsc },
  });
}

async function fetchSuggestedLib(category: string): Promise<string> {
  try {
    const result = await invoke<{ library: string }>('sidecar_call', {
      method: 'library.suggest',
      params: { category },
    });
    return result.library ?? FALLBACK_LIB;
  } catch {
    return FALLBACK_LIB;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ReviewBulkAssign() {
  const workspace = () => currentWorkspace();

  // rows is a plain signal over an array; we mutate individual entries
  // by replacing the full array (fine for O(n) table of typical BOM size).
  const [rows, setRows] = createSignal<RowState[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [loadErr, setLoadErr] = createSignal<string | null>(null);

  // Derive ready items from the queue
  const readyItems = () => queueItems().filter((q) => q.status === 'ready');

  // Re-load row data whenever the set of ready LCSCs changes
  createEffect(() => {
    const ws = workspace();
    const items = readyItems();
    if (!ws || items.length === 0) {
      setRows([]);
      return;
    }

    const stagingDir = `${ws.root}/.kibrary/staging`;
    setLoading(true);
    setLoadErr(null);

    Promise.all(
      items.map(async ({ lcsc }) => {
        let meta: PartMeta;
        try {
          meta = await fetchMeta(stagingDir, lcsc);
        } catch {
          meta = { lcsc };
        }

        let suggestedLib = meta.suggested_lib ?? '';
        if (!suggestedLib) {
          suggestedLib = await fetchSuggestedLib(meta.category ?? '');
        }

        const row: RowState = {
          lcsc,
          description: (meta.description as string) ?? '',
          suggestedLib,
          overrideLib: suggestedLib,
          newLibInput: '',
          showNewInput: false,
          edits: (meta.edits as Record<string, string>) ?? {},
          saveState: 'idle',
          errorMsg: '',
        };
        return row;
      }),
    )
      .then((built) => {
        setRows(built);
        setLoading(false);
      })
      .catch((e) => {
        setLoadErr(String(e));
        setLoading(false);
      });
  });

  // ---------------------------------------------------------------------------
  // Row mutators
  // ---------------------------------------------------------------------------

  function updateRow(lcsc: string, patch: Partial<RowState>) {
    setRows((prev) =>
      prev.map((r) => (r.lcsc === lcsc ? { ...r, ...patch } : r)),
    );
  }

  function onDropdownChange(lcsc: string, value: string) {
    if (value === '__new__') {
      updateRow(lcsc, { showNewInput: true, overrideLib: lcsc });
    } else {
      updateRow(lcsc, { showNewInput: false, overrideLib: value, newLibInput: '' });
    }
  }

  function onNewLibInput(lcsc: string, value: string) {
    updateRow(lcsc, { newLibInput: value, overrideLib: value || lcsc });
  }

  function onNewLibBlur(lcsc: string) {
    const row = rows().find((r) => r.lcsc === lcsc);
    if (!row) return;
    const finalLib = row.newLibInput.trim() || row.suggestedLib;
    updateRow(lcsc, { overrideLib: finalLib, newLibInput: finalLib });
  }

  // ---------------------------------------------------------------------------
  // Save logic
  // ---------------------------------------------------------------------------

  const anySaving = () => rows().some((r) => r.saveState === 'saving');

  const saveAll = async () => {
    const ws = workspace();
    if (!ws) return;

    const stagingDir = `${ws.root}/.kibrary/staging`;

    await Promise.all(
      rows().map(async (row) => {
        const targetLib = row.showNewInput
          ? (row.newLibInput.trim() || row.suggestedLib)
          : row.overrideLib;

        updateRow(row.lcsc, { saveState: 'saving', errorMsg: '' });
        setStatus(row.lcsc, 'committing');

        try {
          await invoke('sidecar_call', {
            method: 'library.commit',
            params: {
              workspace: ws.root,
              lcsc: row.lcsc,
              staging_dir: stagingDir,
              target_lib: targetLib,
              edits: row.edits,
            },
          });
          updateRow(row.lcsc, { saveState: 'ok' });
          setStatus(row.lcsc, 'committed');
        } catch (e) {
          const msg = String(e);
          updateRow(row.lcsc, { saveState: 'error', errorMsg: msg });
          setStatus(row.lcsc, 'failed', msg);
        }
      }),
    );
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div class="space-y-3">
      <h2 class="font-semibold text-sm">Bulk Assign to Libraries</h2>

      {/* No workspace guard */}
      <Show when={!workspace()}>
        <p class="text-sm text-zinc-400 italic">Open a workspace first.</p>
      </Show>

      <Show when={workspace()}>
        {/* Loading state */}
        <Show when={loading()}>
          <p class="text-sm text-zinc-400 italic">Loading part metadata…</p>
        </Show>

        {/* Load error */}
        <Show when={loadErr()}>
          <p class="text-sm text-red-400">Error loading metadata: {loadErr()}</p>
        </Show>

        {/* No ready items */}
        <Show when={!loading() && readyItems().length === 0}>
          <p class="text-sm text-zinc-500 italic">No ready items in queue.</p>
        </Show>

        {/* Table */}
        <Show when={!loading() && rows().length > 0}>
          <div class="overflow-x-auto">
            <table class="w-full text-sm border-collapse">
              <thead>
                <tr class="text-left text-zinc-400 text-xs border-b border-zinc-700">
                  <th class="pb-1 pr-3 font-medium">LCSC</th>
                  <th class="pb-1 pr-3 font-medium">Description</th>
                  <th class="pb-1 pr-3 font-medium">Suggested lib</th>
                  <th class="pb-1 pr-3 font-medium">Override</th>
                  <th class="pb-1 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>
                  {(row) => (
                    <tr class="border-b border-zinc-800 align-middle">
                      {/* LCSC */}
                      <td class="py-1.5 pr-3 font-mono">{row.lcsc}</td>

                      {/* Description */}
                      <td class="py-1.5 pr-3 text-zinc-300 max-w-xs truncate" title={row.description}>
                        {row.description || <span class="text-zinc-600 italic">—</span>}
                      </td>

                      {/* Suggested lib */}
                      <td class="py-1.5 pr-3 font-mono text-zinc-400">{row.suggestedLib}</td>

                      {/* Override dropdown + optional text input */}
                      <td class="py-1.5 pr-3">
                        <div class="flex items-center gap-2">
                          <select
                            class="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-sm"
                            value={row.showNewInput ? '__new__' : row.overrideLib}
                            disabled={row.saveState === 'saving' || row.saveState === 'ok'}
                            onChange={(e) => onDropdownChange(row.lcsc, e.currentTarget.value)}
                          >
                            <option value={row.suggestedLib}>{row.suggestedLib}</option>
                            <option value="__new__">Create new…</option>
                          </select>

                          <Show when={row.showNewInput}>
                            <input
                              type="text"
                              class="bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-sm font-mono w-44"
                              placeholder="LibraryName_KSL"
                              value={row.newLibInput}
                              onInput={(e) => onNewLibInput(row.lcsc, e.currentTarget.value)}
                              onBlur={() => onNewLibBlur(row.lcsc)}
                            />
                          </Show>
                        </div>
                      </td>

                      {/* Per-row save status icon */}
                      <td class="py-1.5 text-center w-8">
                        <Show when={row.saveState === 'saving'}>
                          <span class="text-blue-400 text-xs animate-pulse">…</span>
                        </Show>
                        <Show when={row.saveState === 'ok'}>
                          <span class="text-emerald-400 text-xs">✓</span>
                        </Show>
                        <Show when={row.saveState === 'error'}>
                          <span class="text-red-400 text-xs" title={row.errorMsg}>✗</span>
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>

          {/* Save all button */}
          <div class="flex items-center gap-3 pt-1">
            <button
              class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              disabled={anySaving()}
              onClick={saveAll}
            >
              Save all {rows().length} to libraries
            </button>

            {/* Aggregate error count */}
            <Show when={rows().some((r) => r.saveState === 'error')}>
              <span class="text-sm text-red-400">
                {rows().filter((r) => r.saveState === 'error').length} failed
              </span>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}
