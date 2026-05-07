import { For, Show, createSignal } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import {
  queueItems,
  setStatus,
  setAssetInfo,
  pruneQueue,
  clearQueue,
  dequeue,
} from '~/state/queue';
import { currentWorkspace } from '~/state/workspace';
import { pushToast } from '~/state/toasts';
import { collapseSearchPane } from '~/state/searchPane';
import { formatWarning, type RenderWarning, type ComponentAssets } from '~/blocks/_renderWarnings';

function statusClass(status: string): string {
  switch (status) {
    case 'ready':       return 'bg-emerald-700 text-emerald-100';
    case 'failed':      return 'bg-red-700 text-red-100';
    case 'downloading': return 'bg-amber-600 text-amber-100';
    case 'queued':      return 'bg-zinc-600 text-zinc-200';
    case 'committing':  return 'bg-blue-700 text-blue-100';
    case 'committed':   return 'bg-emerald-900 text-emerald-300';
    default:            return 'bg-zinc-700 text-zinc-300';
  }
}

// Module-level signals so retry() and downloadAll() share download state.
const [isDownloading, setIsDownloading] = createSignal(false);

async function downloadLcscs(lcscs: string[]): Promise<void> {
  const ws = currentWorkspace();
  // Failures surface as toasts so the user always sees feedback —
  // previously a silent return on guard fail looked identical to "nothing
  // happened" and led to "Download all does not work" reports.
  if (!ws) {
    pushToast({ kind: 'error', message: 'Open a workspace first.' });
    return;
  }
  if (lcscs.length === 0) {
    pushToast({
      kind: 'info',
      message: 'Queue is empty — paste LCSC codes above and click Detect.',
    });
    return;
  }

  // Visible diagnostic so future bug reports can be traced through the
  // browser DevTools console without instrumenting fresh.
  console.log('[Queue] dispatching parts.download', {
    lcscs,
    staging_dir: `${ws.root}/.kibrary/staging`,
    concurrency: ws.settings?.concurrency,
  });

  setIsDownloading(true);
  // Optimistically mark as downloading so the UI flips immediately even
  // before the sidecar emits its first progress event.
  for (const lcsc of lcscs) setStatus(lcsc, 'downloading', undefined, 0);

  try {
    // sidecar.parts_download returns { results: { <lcsc>: { ok, error } } }.
    // We use that as the source of truth for terminal status — relying on
    // download-progress events alone is fragile (alpha.10 smoke caught a row
    // stuck at "downloading" because the listen() registration race-lost to
    // the first emit).
    const resp = await invoke<{
      results: Record<
        string,
        {
          ok: boolean;
          error: string | null;
          assets?: ComponentAssets;
          warnings?: RenderWarning[];
        }
      >;
    }>('sidecar_call', {
      method: 'parts.download',
      params: {
        lcscs,
        staging_dir: `${ws.root}/.kibrary/staging`,
        // Default to 4 if settings somehow didn't load — sidecar accepts
        // any positive integer.
        concurrency: ws.settings?.concurrency ?? 4,
      },
    });
    for (const lcsc of lcscs) {
      const r = resp?.results?.[lcsc];
      if (r?.ok) {
        setStatus(lcsc, 'ready', undefined, 100);
      } else {
        setStatus(lcsc, 'failed', r?.error ?? 'unknown error');
      }
      // Always propagate the structured payload — even for ok=true rows
      // we want to surface partial-asset warnings (e.g. "footprint
      // committed but no 3D model"). The empty list short-circuits the
      // banner render, so this is cheap.
      setAssetInfo(lcsc, r?.assets, r?.warnings);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[Queue] parts.download RPC failed:', msg);
    for (const lcsc of lcscs) setStatus(lcsc, 'failed', msg);
    pushToast({ kind: 'error', message: `Download failed: ${msg}` });
  } finally {
    setIsDownloading(false);
  }
}

export default function Queue() {
  const queuedItems = () => queueItems().filter((q) => q.status === 'queued');
  const hasWorkspace = () => currentWorkspace() !== null;
  const downloadAllDisabled = () =>
    !hasWorkspace() || queuedItems().length === 0 || isDownloading();

  // Progress text shown on the "Download all" button while a batch is
  // running: M = total non-queued items currently in the queue (i.e.
  // dispatched), N = how many of those are already downloaded/terminal.
  const downloadProgress = () => {
    const all = queueItems();
    const dispatched = all.filter((q) => q.status !== 'queued');
    const done = dispatched.filter(
      (q) => q.status === 'ready'
        || q.status === 'committed'
        || q.status === 'failed',
    );
    return { n: done.length, m: dispatched.length };
  };

  const downloadAll = () => {
    const lcscs = queuedItems().map((q) => q.lcsc);
    // Auto-collapse the side pane *before* dispatching so the width
    // animation kicks off in the same frame as the request — the user
    // gets instant visual feedback that the click landed (alpha.9 had
    // the opposite problem: silent no-op). Collapse only when there's
    // actually something to download — empty-queue clicks fall through
    // to the toast inside downloadLcscs() and shouldn't move the UI.
    if (lcscs.length > 0) collapseSearchPane();
    return downloadLcscs(lcscs);
  };

  const retry = (lcsc: string) => {
    setStatus(lcsc, 'queued');
    return downloadLcscs([lcsc]);
  };

  const clearDone = () => {
    pruneQueue(['queued', 'downloading', 'ready', 'committing']);
  };

  const hasTerminal = () =>
    queueItems().some((q) => q.status === 'committed' || q.status === 'failed');

  // Aggregate the structured warnings into a single banner that fronts
  // the queue. Pre-fix, a "C6037812 not found" failure surfaced only as
  // a tiny `failed` pill on the row (which the user reasonably read as
  // a network blip, not "this LCSC has no design data anywhere").
  // Banner counts both hard failures and partial-asset warnings so the
  // user always sees a top-of-queue summary they can't miss.
  const warningRows = () =>
    queueItems().filter((q) => (q.warnings?.length ?? 0) > 0);

  return (
    <div class="space-y-2">
      {/* Header row */}
      <div class="flex items-center justify-between gap-2">
        <h2 class="font-semibold text-sm">Queue ({queueItems().length})</h2>
        <div class="flex gap-2">
          <Show when={hasTerminal()}>
            <button
              class="px-2 py-1 text-xs bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 rounded"
              onClick={clearDone}
            >
              Clear done
            </button>
          </Show>
          <button
            class="px-2 py-1 text-xs bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={queueItems().length === 0}
            onClick={() => clearQueue()}
          >
            Clear queue
          </button>
          <Show
            when={!hasWorkspace()}
            fallback={
              // The button is only `disabled` while a batch is in flight,
              // not when the queue is empty — clicking on an empty queue
              // surfaces a "queue is empty" toast inside downloadLcscs()
              // instead of silently no-op'ing. This was the alpha.9
              // "Download all does nothing" trap.
              <button
                data-testid="download-all-btn"
                class="px-2 py-1 text-xs bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={isDownloading()}
                title={
                  queuedItems().length === 0
                    ? 'Paste LCSC codes above and click Detect to populate the queue.'
                    : `Download ${queuedItems().length} queued part(s).`
                }
                onClick={downloadAll}
              >
                <Show
                  when={isDownloading()}
                  fallback={<>Download all</>}
                >
                  Downloading… ({downloadProgress().n} of {downloadProgress().m})
                </Show>
              </button>
            }
          >
            <span title="Open a workspace first">
              <button
                class="px-2 py-1 text-xs bg-zinc-200 dark:bg-zinc-700 rounded opacity-40 cursor-not-allowed"
                disabled
              >
                Download all
              </button>
            </span>
          </Show>
        </div>
      </div>

      {/* Structured warning banner — surfaces "X not found" / "Y missing
          footprint" failures the user previously had to dig out of the
          tiny `failed` pill. Aggregates across rows so the queue gets a
          single top-level summary instead of one banner per row. */}
      <Show when={warningRows().length > 0}>
        <div
          data-testid="queue-warning-banner"
          class="rounded border border-red-700 bg-red-900/40 px-3 py-2 text-xs text-red-200 space-y-1"
          role="alert"
        >
          <p class="font-semibold">
            {warningRows().length} part{warningRows().length === 1 ? '' : 's'} could not be loaded:
          </p>
          <ul class="list-disc pl-5 space-y-0.5">
            <For each={warningRows()}>
              {(row) => (
                <For each={row.warnings ?? []}>
                  {(w) => (
                    <li data-testid="queue-warning-item" data-lcsc={row.lcsc}>
                      {formatWarning(w)}
                    </li>
                  )}
                </For>
              )}
            </For>
          </ul>
        </div>
      </Show>

      {/* Queue rows */}
      <Show
        when={queueItems().length > 0}
        fallback={<p class="text-xs text-zinc-400 dark:text-zinc-500 italic">No items queued.</p>}
      >
        <ul class="font-mono text-sm space-y-1">
          <For each={queueItems()}>
            {(q) => (
              <li
                data-testid="queue-row"
                data-status={q.status}
                class="flex items-center gap-2"
              >
                <span class="w-24 truncate">{q.lcsc}</span>
                <span class={`px-2 py-0.5 rounded text-xs font-sans ${statusClass(q.status)}`}>
                  {q.status}
                </span>
                <Show when={q.status === 'downloading'}>
                  <div
                    class="w-32 h-1 bg-zinc-200 dark:bg-zinc-800 rounded overflow-hidden"
                    role="progressbar"
                    aria-valuenow={q.progress ?? 30}
                    aria-valuemin="0"
                    aria-valuemax="100"
                  >
                    <div
                      class="h-full bg-amber-500 transition-all duration-200"
                      style={{ width: `${q.progress ?? 30}%` }}
                    />
                  </div>
                </Show>
                <Show when={q.status === 'failed'}>
                  <button
                    class="text-xs underline text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200"
                    onClick={() => retry(q.lcsc)}
                  >
                    retry
                  </button>
                </Show>
                <Show when={q.error}>
                  <span class="text-xs text-red-400 truncate max-w-xs" title={q.error}>
                    {q.error}
                  </span>
                </Show>
                <Show when={(q.warnings?.length ?? 0) > 0}>
                  <span
                    data-testid="queue-row-warning-icon"
                    class="text-amber-400 cursor-help"
                    aria-label="Component load warning"
                    title={(q.warnings ?? []).map((w) => formatWarning(w)).join('\n')}
                  >
                    ⚠
                  </span>
                </Show>
                <button
                  class="ml-auto px-1.5 py-0.5 text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded"
                  aria-label="Remove"
                  title="Remove from queue"
                  onClick={() => dequeue(q.lcsc)}
                >
                  ✕
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
