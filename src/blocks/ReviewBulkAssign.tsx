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

import { createSignal, createEffect, Index, Show, untrack } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { queueItems, setStatus, dequeue } from '~/state/queue';
import { currentWorkspace } from '~/state/workspace';
import { refreshLcscIndex } from '~/state/lcscIndex';
import { setRoom } from '~/state/room';
import { setSelectedLib, setSelectedComponent } from '~/state/librariesRoom';
import LibPicker from '~/components/LibPicker';
import { formatWarning } from '~/blocks/_renderWarnings';

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
  // Inline-edit autosave lifecycle (Reference/Description edits flushed to
  // the staging .kicad_sym via parts.write_props). Distinct from `saveState`
  // which tracks the commit-to-library lifecycle.
  editSaveState: RowSaveState;
  // alpha.22: post-commit destination so the "Open in library" button knows
  // where to navigate after the row is saved.
  committedLib?: string;
  committedComponent?: string;
  // Advisory: this LCSC already exists somewhere in the workspace (per
  // library.check_duplicate). Non-blocking — we still allow commit; we just
  // surface a "⚠ already in <library>" note so the user can avoid an
  // accidental duplicate. `duplicateLib` is the library that already holds
  // it; `null`/empty means no duplicate (or the check hasn't resolved yet).
  duplicateLib?: string | null;
}

interface DuplicateResult {
  duplicate: boolean;
  library: string | null;
  component_name: string | null;
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

// Advisory duplicate check — purely informational, so a failure must never
// block the row from loading or committing. On any error we report "no
// duplicate" (null) and the advisory simply doesn't render.
async function fetchDuplicate(workspace: string, lcsc: string): Promise<string | null> {
  try {
    const r = await invoke<DuplicateResult>('sidecar_call', {
      method: 'library.check_duplicate',
      params: { workspace, lcsc },
    });
    return r?.duplicate ? r.library : null;
  } catch {
    return null;
  }
}

export default function ReviewBulkAssign() {
  const workspace = () => currentWorkspace();

  const [rows, setRows] = createSignal<RowState[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [loadErr, setLoadErr] = createSignal<string | null>(null);

  // alpha.22+: keep COMMITTING + COMMITTED rows visible alongside ready ones
  // so (a) the user sees the saving spinner mid-flight and (b) the row stays
  // visible after save with a "saved" pill + Open-in-library button.
  //
  // alpha.23 critical fix: 'committing' MUST be in this filter or the row
  // briefly disappears mid-save → createEffect rebuilds with no prev row to
  // preserve from → when the row reappears as 'committed' it has saveState
  // 'idle' (no pill, no button). User reported this as "no Open-in-library
  // link" because the saved-pill never rendered.
  const visibleItems = () =>
    queueItems().filter(
      (q) => q.status === 'ready' || q.status === 'committing' || q.status === 'committed',
    );

  createEffect(() => {
    const ws = workspace();
    const items = visibleItems();
    if (!ws || items.length === 0) {
      setRows([]);
      return;
    }

    const stagingDir = `${ws.root}/.kibrary/staging`;
    setLoading(true);
    setLoadErr(null);

    // Snapshot prior rows so we preserve saveState='ok' + committed* fields
    // across re-runs (status changes from ready → committed during save).
    // untrack — we WRITE to rows() inside this effect; reading reactively
    // would loop.
    const prevByLcsc = untrack(() =>
      Object.fromEntries(rows().map((r) => [r.lcsc, r])),
    );

    Promise.all(
      items.map(async ({ lcsc }) => {
        const prev = prevByLcsc[lcsc];
        // Preserve any row whose user-driven save lifecycle is in flight or
        // complete. Re-running fetchMeta / fetchSuggest mid-save discards
        // the saving spinner (alpha.23 bug); after save it discards the
        // saved pill + committedLib/Component → no Open-in-library button.
        if (prev && prev.saveState !== 'idle') return prev;

        let meta: PartMeta;
        try {
          meta = await fetchMeta(stagingDir, lcsc);
        } catch {
          meta = { lcsc };
        }

        const [suggest, duplicateLib] = await Promise.all([
          fetchSuggest(meta.category ?? '', ws.root),
          fetchDuplicate(ws.root, lcsc),
        ]);
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
          editSaveState: 'idle' as RowSaveState,
          duplicateLib,
        } as RowState;
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

  // ------------------------------------------------------------------------
  // Inline Reference/Description editing.
  //
  // Edits update `row.edits[key]` (and mirror the visible Description column
  // for the Description key) and are flushed to the staged `.kicad_sym` via
  // parts.write_props, debounced ~400ms — mirroring PropertyEditor's
  // autosave. row.edits is ALSO passed at commit time (belt-and-suspenders:
  // both the staged file and the commit-time edits carry the change), so a
  // failed debounce flush is non-fatal — the commit still applies the edit.
  // ------------------------------------------------------------------------
  const editDebounce = new Map<string, ReturnType<typeof setTimeout>>();

  function editField(lcsc: string, key: string, value: string) {
    const ws = workspace();
    setRows((prev) =>
      prev.map((r) => {
        if (r.lcsc !== lcsc) return r;
        const nextEdits = { ...r.edits, [key]: value };
        return {
          ...r,
          edits: nextEdits,
          // Keep the visible Description column in sync with the edit.
          description: key === 'Description' ? value : r.description,
        };
      }),
    );

    if (!ws) return;
    const symPath = `${ws.root}/.kibrary/staging/${lcsc}/${lcsc}.kicad_sym`;

    const existing = editDebounce.get(lcsc);
    if (existing !== undefined) clearTimeout(existing);
    editDebounce.set(
      lcsc,
      setTimeout(async () => {
        editDebounce.delete(lcsc);
        const row = untrack(() => rows().find((r) => r.lcsc === lcsc));
        if (!row) return;
        updateRow(lcsc, { editSaveState: 'saving' });
        try {
          await invoke('sidecar_call', {
            method: 'parts.write_props',
            params: { sym_path: symPath, edits: row.edits },
          });
          updateRow(lcsc, { editSaveState: 'ok' });
        } catch (e) {
          console.warn('[BulkAssign] inline write_props failed (non-fatal):', e);
          updateRow(lcsc, { editSaveState: 'error' });
        }
      }, 400),
    );
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
        if (row.saveState === 'ok') return;  // skip already-saved rows
        const targetLib = row.overrideLib.trim() || row.suggestedLib;
        updateRow(row.lcsc, { saveState: 'saving', errorMsg: '' });
        setStatus(row.lcsc, 'committing');
        try {
          const result = await invoke<{
            committed_path: string;
            target_lib?: string;
            component_name?: string | null;
          }>('sidecar_call', {
            method: 'library.commit',
            params: {
              workspace: ws.root,
              lcsc: row.lcsc,
              staging_dir: stagingDir,
              target_lib: targetLib,
              edits: row.edits,
            },
          });
          updateRow(row.lcsc, {
            saveState: 'ok',
            committedLib: result.target_lib ?? targetLib,
            committedComponent: result.component_name ?? row.lcsc,
          });
          setStatus(row.lcsc, 'committed');
        } catch (e) {
          const msg = String(e);
          updateRow(row.lcsc, { saveState: 'error', errorMsg: msg });
          setStatus(row.lcsc, 'failed', msg);
        }
      }),
    );

    // alpha.17: warm the LCSC-in-library index so newly-committed parts
    // surface the "In library" pill in subsequent searches. We refresh once
    // per saveAll() (not per-row) — Promise.all has resolved, so this picks
    // up every successful commit in a single round-trip. Fire-and-forget.
    if (rows().some((r) => r.saveState === 'ok')) {
      refreshLcscIndex(ws.root);
    }
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

        <Show when={!loading() && visibleItems().length === 0}>
          <p class="text-sm text-zinc-500 italic">No ready items in queue.</p>
        </Show>

        <Show when={!loading() && rows().length > 0}>
          <div class="overflow-x-auto">
            <table class="w-full text-sm border-collapse">
              <thead>
                <tr class="text-left text-zinc-400 text-xs border-b border-zinc-700">
                  <th class="pb-1 pr-3 font-medium">LCSC</th>
                  <th class="pb-1 pr-3 font-medium">Reference</th>
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
                  {(row) => {
                    // Locate the underlying queue row so we can surface
                    // its structured warnings (the C6037812 case lands
                    // here as `assets={symbol:false, footprint:false,
                    // model_3d:false}` with a `component_load_failed`
                    // warning attached to the queue item).
                    const queueRow = () =>
                      queueItems().find((q) => q.lcsc === row().lcsc);
                    const rowWarnings = () => queueRow()?.warnings ?? [];
                    return (
                    <tr class="border-b border-zinc-800 align-middle" data-testid="bulk-row" data-lcsc={row().lcsc}>
                      <td class="py-1.5 pr-3 font-mono">
                        <span class="inline-flex items-center gap-1.5 flex-wrap">
                          {row().lcsc}
                          <Show when={rowWarnings().length > 0}>
                            <span
                              data-testid="bulk-row-warning-icon"
                              class="text-amber-400 cursor-help"
                              aria-label="Component load warning"
                              title={rowWarnings().map((w) => formatWarning(w)).join('\n')}
                            >
                              ⚠
                            </span>
                          </Show>
                          {/* Non-blocking duplicate advisory — this LCSC is
                              already in another library. Commit is still
                              allowed; we just flag it so the user doesn't
                              create an accidental duplicate. */}
                          <Show when={row().duplicateLib}>
                            <span
                              data-testid="bulk-row-duplicate-badge"
                              class="px-1.5 py-0.5 rounded text-[10px] font-sans text-amber-300 bg-amber-900/40 border border-amber-700 cursor-help whitespace-nowrap"
                              aria-label={`Already in library ${row().duplicateLib}`}
                              title={`This LCSC code is already in the "${row().duplicateLib}" library. Saving will create a duplicate.`}
                            >
                              ⚠ already in {row().duplicateLib}
                            </span>
                          </Show>
                        </span>
                      </td>
                      <td class="py-1.5 pr-3">
                        <input
                          type="text"
                          data-testid="bulk-edit-reference"
                          class="w-20 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-xs font-mono text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-500 disabled:opacity-50"
                          placeholder="Ref"
                          aria-label={`Reference for ${row().lcsc}`}
                          disabled={row().saveState === 'saving' || row().saveState === 'ok'}
                          value={row().edits.Reference ?? ''}
                          onInput={(e) => editField(row().lcsc, 'Reference', e.currentTarget.value)}
                        />
                      </td>
                      <td class="py-1.5 pr-3">
                        <div class="flex items-center gap-1.5">
                          <input
                            type="text"
                            data-testid="bulk-edit-description"
                            class="w-full min-w-[10rem] bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-500 disabled:opacity-50"
                            placeholder="Description"
                            aria-label={`Description for ${row().lcsc}`}
                            disabled={row().saveState === 'saving' || row().saveState === 'ok'}
                            value={row().edits.Description ?? row().description}
                            onInput={(e) => editField(row().lcsc, 'Description', e.currentTarget.value)}
                          />
                          {/* Inline-edit autosave indicator — same visual
                              language as the commit Status column. */}
                          <Show when={row().editSaveState === 'saving'}>
                            <span class="text-blue-400 text-xs animate-pulse" data-testid="bulk-edit-saving">…</span>
                          </Show>
                          <Show when={row().editSaveState === 'ok'}>
                            <span class="text-emerald-400 text-xs" data-testid="bulk-edit-saved" title="Saved to staging">✓</span>
                          </Show>
                          <Show when={row().editSaveState === 'error'}>
                            <span class="text-amber-400 text-xs" data-testid="bulk-edit-error" title="Staging save failed (will still apply at commit)">!</span>
                          </Show>
                        </div>
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
                      <td class="py-1.5 pr-3 text-center">
                        <Show when={row().saveState === 'saving'}>
                          <span class="text-blue-400 text-xs animate-pulse">…</span>
                        </Show>
                        <Show when={row().saveState === 'ok'}>
                          <span class="inline-flex items-center gap-1.5">
                            <span
                              class="px-1.5 py-0.5 rounded text-[10px] font-sans bg-emerald-700 text-emerald-100"
                              data-testid="bulk-saved-pill"
                            >
                              saved
                            </span>
                            <button
                              type="button"
                              data-testid="bulk-open-in-library"
                              class="text-xs px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200"
                              onClick={() => {
                                if (row().committedLib) setSelectedLib(row().committedLib!);
                                if (row().committedComponent)
                                  setSelectedComponent(row().committedComponent!);
                                setRoom('libraries');
                              }}
                            >
                              Open in library
                            </button>
                          </span>
                        </Show>
                        <Show when={row().saveState === 'error'}>
                          <span class="text-red-400 text-xs" title={row().errorMsg}>✗ {row().errorMsg.slice(0, 60)}</span>
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
                    );
                  }}
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
