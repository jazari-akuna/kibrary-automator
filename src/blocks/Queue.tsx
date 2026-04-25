import { For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { queueItems, setStatus, pruneQueue } from '~/state/queue';
import { currentWorkspace } from '~/state/workspace';

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

async function downloadLcscs(lcscs: string[]) {
  const ws = currentWorkspace();
  if (!ws || lcscs.length === 0) return;
  await invoke('sidecar_call', {
    method: 'parts.download',
    params: {
      lcscs,
      staging_dir: `${ws.root}/.kibrary/staging`,
      concurrency: ws.settings.concurrency,
    },
  });
}

export default function Queue() {
  const queuedItems = () => queueItems().filter((q) => q.status === 'queued');
  const hasWorkspace = () => currentWorkspace() !== null;
  const downloadAllDisabled = () => !hasWorkspace() || queuedItems().length === 0;

  const downloadAll = () => {
    const lcscs = queuedItems().map((q) => q.lcsc);
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

  return (
    <div class="space-y-2">
      {/* Header row */}
      <div class="flex items-center justify-between gap-2">
        <h2 class="font-semibold text-sm">Queue ({queueItems().length})</h2>
        <div class="flex gap-2">
          <Show when={hasTerminal()}>
            <button
              class="px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 rounded"
              onClick={clearDone}
            >
              Clear done
            </button>
          </Show>
          <Show
            when={!hasWorkspace()}
            fallback={
              <button
                class="px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={downloadAllDisabled()}
                onClick={downloadAll}
              >
                Download all
              </button>
            }
          >
            <span title="Open a workspace first">
              <button
                class="px-2 py-1 text-xs bg-zinc-700 rounded opacity-40 cursor-not-allowed"
                disabled
              >
                Download all
              </button>
            </span>
          </Show>
        </div>
      </div>

      {/* Queue rows */}
      <Show
        when={queueItems().length > 0}
        fallback={<p class="text-xs text-zinc-500 italic">No items queued.</p>}
      >
        <ul class="font-mono text-sm space-y-1">
          <For each={queueItems()}>
            {(q) => (
              <li class="flex items-center gap-2">
                <span class="w-24 truncate">{q.lcsc}</span>
                <span class={`px-2 py-0.5 rounded text-xs font-sans ${statusClass(q.status)}`}>
                  {q.status}
                </span>
                <Show when={q.status === 'failed'}>
                  <button
                    class="text-xs underline text-zinc-400 hover:text-zinc-200"
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
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
