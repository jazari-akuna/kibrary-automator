/**
 * ReviewBulkAssign — Task 22 Solid block.
 *
 * For each 'ready' queue item:
 *  1. Read meta via parts.read_meta  → description + suggested_lib + category
 *  2. Call library.suggest({category, workspace}) which returns:
 *       library      — the category-derived suggested name (e.g. Resistors_KSL)
 *       is_existing  — true if `library` already exists in this workspace
 *       existing     — every existing library name in the workspace
 *       matches      — existing libs the sidecar fuzzy-matched against
 *                      the suggestion (e.g. `Resistors_v2`, `MyResistors`)
 *
 * Each row's library cell is a LibPicker — a searchable dropdown over the
 * full existing-libs list with the suggested-new / matched options pinned
 * to the top. Native `<select>` was abandoned in alpha.12 because (a) its
 * `<option>` contrast can't be themed, (b) it can't show existing libs +
 * search at the same time, and (c) every part defaulted to `Misc_KSL`
 * because download never captured the part's category metadata.
 */

import { createSignal, createEffect, Index, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { queueItems, setStatus, dequeue } from '~/state/queue';
import { currentWorkspace } from '~/state/workspace';
import LibPicker from '~/components/LibPicker';

interface PartMeta {
  lcsc: string;
  description?: string;
  category?: string;
  suggested_lib?: string;
  footprint?: string;
  edits?: Record<string, string>;
  [key: string]: unknown;
}

interface SuggestResult {
  library: string;
  is_existing: boolean;
  existing: string[];
  matches: string[];
}

type RowSaveState = 'idle' | 'saving' | 'ok' | 'error';

interface RowState {
  lcsc: string;
  description: string;
  footprint: string;
  suggestedLib: string;
  isExisting: boolean;
  existingLibs: string[];
  matches: string[];
  overrideLib: string;
  edits: Record<string, string>;
  saveState: RowSaveState;
  errorMsg: string;
}

const FALLBACK_LIB = 'Misc_KSL';

async function fetchMeta(stagingDir: string, lcsc: string): Promise<PartMeta> {
  // parts.read_meta returns `{meta: {...} | null}`. The pre-alpha.12 code
  // unwrapped one level too few and ended up with `category=undefined`
  // every time, which is why every part defaulted to Misc_KSL.
  const wrapped = await invoke<{ meta: PartMeta | null }>('sidecar_call', {
    method: 'parts.read_meta',
    params: { staging_dir: stagingDir, lcsc },
  });
  return wrapped?.meta ?? { lcsc };
}

async function fetchSuggest(category: string, workspace: string): Promise<SuggestResult> {
  try {
    return await invoke<SuggestResult>('sidecar_call', {
      method: 'library.suggest',
      params: { category, workspace },
    });
  } catch {
    return { library: FALLBACK_LIB, is_existing: false, existing: [], matches: [] };
  }
}

export default function ReviewBulkAssign() {
  const workspace = () => currentWorkspace();

  const [rows, setRows] = createSignal<RowState[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [loadErr, setLoadErr] = createSignal<string | null>(null);

  const readyItems = () => queueItems().filter((q) => q.status === 'ready');

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

        const suggest = await fetchSuggest(meta.category ?? '', ws.root);
        // Honor an explicit suggested_lib override in meta.json (manual edit)
        // by treating it as the picked value but still showing the workspace
        // existing-libs list for context.
        const suggestedLib = meta.suggested_lib ?? suggest.library;

        return {
          lcsc,
          description: (meta.description as string) ?? '',
          footprint: (meta.footprint as string) ?? '',
          suggestedLib,
          isExisting: suggest.is_existing,
          existingLibs: suggest.existing,
          matches: suggest.matches,
          overrideLib: suggestedLib,
          edits: (meta.edits as Record<string, string>) ?? {},
          saveState: 'idle' as RowSaveState,
          errorMsg: '',
        };
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

  function updateRow(lcsc: string, patch: Partial<RowState>) {
    setRows((prev) => prev.map((r) => (r.lcsc === lcsc ? { ...r, ...patch } : r)));
  }

  /**
   * Cancel a downloaded part: remove its staging dir on disk AND drop the
   * row from the queue. The Queue's own ✕ only does the latter, leaving
   * the staged files behind to clutter `<workspace>/.kibrary/staging`.
   * Best-effort: a delete-staged failure is logged but the queue row is
   * removed regardless so the user isn't stuck with a row they can't
   * dismiss.
   */
  async function cancelRow(lcsc: string) {
    const ws = workspace();
    if (!ws) return;
    try {
      await invoke('sidecar_call', {
        method: 'parts.delete_staged',
        params: { staging_dir: `${ws.root}/.kibrary/staging`, lcsc },
      });
    } catch (e) {
      console.warn('[BulkAssign] delete_staged failed (non-fatal):', e);
    }
    dequeue(lcsc);
  }

  const anySaving = () => rows().some((r) => r.saveState === 'saving');

  const saveAll = async () => {
    const ws = workspace();
    if (!ws) return;
    const stagingDir = `${ws.root}/.kibrary/staging`;

    await Promise.all(
      rows().map(async (row) => {
        const targetLib = row.overrideLib.trim() || row.suggestedLib;
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

  return (
    <div class="space-y-3" data-testid="bulk-assign">
      <h2 class="font-semibold text-sm">Bulk Assign to Libraries</h2>

      <Show when={!workspace()}>
        <p class="text-sm text-zinc-400 italic">Open a workspace first.</p>
      </Show>

      <Show when={workspace()}>
        <Show when={loading()}>
          <p class="text-sm text-zinc-400 italic">Loading part metadata…</p>
        </Show>

        <Show when={loadErr()}>
          <p class="text-sm text-red-400">Error loading metadata: {loadErr()}</p>
        </Show>

        <Show when={!loading() && readyItems().length === 0}>
          <p class="text-sm text-zinc-500 italic">No ready items in queue.</p>
        </Show>

        <Show when={!loading() && rows().length > 0}>
          <div class="overflow-x-auto">
            <table class="w-full text-sm border-collapse">
              <thead>
                <tr class="text-left text-zinc-400 text-xs border-b border-zinc-700">
                  <th class="pb-1 pr-3 font-medium">LCSC</th>
                  <th class="pb-1 pr-3 font-medium">Description</th>
                  <th class="pb-1 pr-3 font-medium">Footprint</th>
                  {/* alpha.16: Suggested column removed — the LibPicker
                      below already shows the suggested name with a green
                      "new" badge. A dedicated column duplicated info. */}
                  <th class="pb-1 pr-3 font-medium">Library</th>
                  <th class="pb-1 pr-3 font-medium">Status</th>
                  <th class="pb-1 font-medium w-8"></th>
                </tr>
              </thead>
              <tbody>
                {/*
                  Use <Index> instead of <For>: updateRow returns new row
                  objects every time, so <For> (which keys on object
                  identity) recreated each <tr> — including <input> —
                  per keystroke and stole focus. <Index> keeps DOM stable
                  by keying on position; only the accessed values update.
                */}
                <Index each={rows()}>
                  {(row) => (
                    <tr class="border-b border-zinc-800 align-middle" data-testid="bulk-row" data-lcsc={row().lcsc}>
                      <td class="py-1.5 pr-3 font-mono">{row().lcsc}</td>
                      <td class="py-1.5 pr-3 text-zinc-300 max-w-xs truncate" title={row().description}>
                        {row().description || <span class="text-zinc-600 italic">—</span>}
                      </td>
                      <td class="py-1.5 pr-3 font-mono text-zinc-400 text-xs" data-testid="bulk-footprint">
                        {row().footprint || <span class="text-zinc-600 italic">—</span>}
                      </td>
                      <td class="py-1.5 pr-3">
                        <LibPicker
                          value={row().overrideLib}
                          existing={row().existingLibs}
                          suggested={row().suggestedLib}
                          matches={row().matches}
                          disabled={row().saveState === 'saving' || row().saveState === 'ok'}
                          onChange={(v) => updateRow(row().lcsc, { overrideLib: v })}
                        />
                      </td>
                      <td class="py-1.5 pr-3 text-center w-8">
                        <Show when={row().saveState === 'saving'}>
                          <span class="text-blue-400 text-xs animate-pulse">…</span>
                        </Show>
                        <Show when={row().saveState === 'ok'}>
                          <span class="text-emerald-400 text-xs">✓</span>
                        </Show>
                        <Show when={row().saveState === 'error'}>
                          <span class="text-red-400 text-xs" title={row().errorMsg}>✗</span>
                        </Show>
                      </td>
                      <td class="py-1.5 text-center w-8">
                        <button
                          type="button"
                          data-testid="bulk-cancel"
                          class="px-1.5 py-0.5 text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded text-sm disabled:opacity-30 disabled:cursor-not-allowed"
                          aria-label={`Cancel and delete staged files for ${row().lcsc}`}
                          title={`Cancel — delete downloaded files for ${row().lcsc}`}
                          disabled={row().saveState === 'saving' || row().saveState === 'ok'}
                          onClick={() => cancelRow(row().lcsc)}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  )}
                </Index>
              </tbody>
            </table>
          </div>

          <div class="flex items-center gap-3 pt-1">
            <button
              data-testid="bulk-save-all"
              class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              disabled={anySaving()}
              onClick={saveAll}
            >
              Save all {rows().length} to libraries
            </button>
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
