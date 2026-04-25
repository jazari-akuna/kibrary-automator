/**
 * ReviewSequential — Task 21 sequential review mode block.
 *
 * Shows the current "ready" queue item for review:
 *   - Top: 3-column preview grid (symbol / footprint / 3D)
 *   - Middle: PropertyEditor
 *   - Footer: target-library dropdown + navigation/action buttons
 *
 * Registered as 'review-sequential' by the manager (not touched here).
 */

import { createSignal, createResource, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import BlockHost from '~/shell/BlockHost';
import { currentItem, next, prev, discard, commitCurrent } from '~/state/review';
import { currentWorkspace } from '~/state/workspace';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PartMeta {
  lcsc: string;
  description?: string;
  suggested_lib?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FALLBACK_LIB = 'Misc_KSL';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ReviewSequential() {
  const workspace = () => currentWorkspace();
  const item = () => currentItem();

  // Derived staging dir
  const stagingDir = () => {
    const ws = workspace();
    return ws ? `${ws.root}/.kibrary/staging` : '';
  };

  // Load meta for the current item to get the suggested lib.
  // Source is a string key (or undefined) so the overload is unambiguous.
  type MetaSource = { lcsc: string; sd: string };

  const metaSource = (): MetaSource | undefined => {
    const it = item();
    const sd = stagingDir();
    if (!it || !sd) return undefined;
    return { lcsc: it.lcsc, sd };
  };

  const [meta] = createResource<PartMeta | null, MetaSource>(
    metaSource,
    async (args: MetaSource) => {
      try {
        return await invoke<PartMeta>('sidecar_call', {
          method: 'parts.read_meta',
          params: { staging_dir: args.sd, lcsc: args.lcsc },
        });
      } catch {
        return null;
      }
    },
  );

  // Target library: initialised from meta.suggested_lib when meta loads
  const suggestedLib = () => meta()?.suggested_lib ?? FALLBACK_LIB;
  const [targetLib, setTargetLib] = createSignal('');

  // Sync targetLib when suggested changes (on item change)
  let lastLcsc = '';
  const effectiveTarget = () => {
    const it = item();
    if (!it) return FALLBACK_LIB;
    // Reset selection when the item changes
    if (it.lcsc !== lastLcsc) {
      lastLcsc = it.lcsc;
      setTargetLib('');     // will fall back to suggestedLib()
    }
    return targetLib() || suggestedLib();
  };

  // Commit state
  const [committing, setCommitting] = createSignal(false);
  const [commitError, setCommitError] = createSignal<string | null>(null);

  const handleCommit = async () => {
    setCommitting(true);
    setCommitError(null);
    try {
      await commitCurrent(effectiveTarget());
    } catch (e) {
      setCommitError(String(e));
    } finally {
      setCommitting(false);
    }
  };

  const handleDiscard = () => {
    const it = item();
    if (it) discard(it.lcsc);
    setCommitError(null);
  };

  const handleSkip = () => {
    next();
    setCommitError(null);
  };

  const handlePrev = () => {
    prev();
    setCommitError(null);
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div class="flex flex-col gap-4 h-full">
      {/* No workspace guard */}
      <Show when={!workspace()}>
        <p class="text-sm text-zinc-400 italic">Open a workspace first.</p>
      </Show>

      <Show when={workspace()}>
        {/* No ready items */}
        <Show when={!item()}>
          <div class="flex flex-col items-center justify-center flex-1 gap-2 py-16">
            <p class="text-sm text-zinc-400 italic">No items to review.</p>
            <p class="text-xs text-zinc-600">
              Add parts to the queue and wait for them to finish downloading.
            </p>
          </div>
        </Show>

        {/* Review UI */}
        <Show when={item()}>
          {/* Item heading */}
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-semibold text-zinc-200">
              Sequential Review —{' '}
              <span class="font-mono text-zinc-100">{item()!.lcsc}</span>
            </h2>
            <span class="text-xs text-zinc-500">
              {meta.loading ? 'Loading meta…' : (meta()?.description ?? '')}
            </span>
          </div>

          {/* 3-column preview grid */}
          <div class="grid grid-cols-3 gap-3 min-h-0">
            <div class="min-w-0">
              <BlockHost
                id="symbol-preview"
                data={{ stagingDir: stagingDir(), lcsc: item()!.lcsc }}
              />
            </div>
            <div class="min-w-0">
              <BlockHost
                id="footprint-preview"
                data={{ stagingDir: stagingDir(), lcsc: item()!.lcsc }}
              />
            </div>
            <div class="min-w-0">
              <BlockHost
                id="3d-preview"
                data={{ stagingDir: stagingDir(), lcsc: item()!.lcsc }}
              />
            </div>
          </div>

          {/* Property editor */}
          <BlockHost
            id="property-editor"
            data={{ stagingDir: stagingDir(), lcsc: item()!.lcsc }}
          />

          {/* Footer: library picker + actions */}
          <div class="border-t border-zinc-800 pt-3 flex flex-wrap items-center gap-3">
            {/* Target library selector */}
            <div class="flex items-center gap-2 flex-1 min-w-0">
              <label class="text-xs text-zinc-400 shrink-0">Library</label>
              <input
                type="text"
                class="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm font-mono text-zinc-100 flex-1 min-w-0 focus:outline-none focus:ring-1 focus:ring-zinc-500"
                placeholder={suggestedLib()}
                value={targetLib() || suggestedLib()}
                onInput={(e) => setTargetLib(e.currentTarget.value.trim())}
              />
            </div>

            {/* Navigation & action buttons */}
            <div class="flex items-center gap-2 shrink-0">
              <button
                class="px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={handlePrev}
                disabled={committing()}
              >
                ← Prev
              </button>

              <button
                class="px-3 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={handleSkip}
                disabled={committing()}
              >
                Skip
              </button>

              <button
                class="px-3 py-1.5 rounded bg-red-800 hover:bg-red-700 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={handleDiscard}
                disabled={committing()}
              >
                Discard
              </button>

              <button
                class="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={handleCommit}
                disabled={committing()}
              >
                {committing() ? 'Committing…' : 'Commit & next →'}
              </button>
            </div>
          </div>

          {/* Commit error */}
          <Show when={commitError()}>
            <p class="text-xs text-red-400">{commitError()}</p>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
