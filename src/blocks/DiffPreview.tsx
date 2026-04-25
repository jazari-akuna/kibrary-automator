import { createResource, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

interface Props {
  before: string;
  after: string;
}

interface DiffChange {
  type: 'added' | 'removed' | 'modified';
  path: string;
  before?: string;
  after?: string;
}

interface DiffResult {
  changes: DiffChange[];
}

/** Rows visible in the left (removed) column. */
interface LeftRow {
  path: string;
  value?: string;
}

/** Rows visible in the right (added) column. */
interface RightRow {
  path: string;
  value?: string;
}

export default function DiffPreview(props: Props) {
  // Use a string key as source so Solid re-fetches when before/after change.
  const [diff] = createResource<DiffResult, string>(
    () => `${props.before}\x00${props.after}`,
    (_key) =>
      invoke<DiffResult>('sidecar_call', {
        method: 'library.diff',
        params: { before: props.before, after: props.after },
      }),
  );

  const leftRows = (): LeftRow[] => {
    const changes = diff()?.changes ?? [];
    return changes
      .filter((c) => c.type === 'removed' || c.type === 'modified')
      .map((c) => ({ path: c.path, value: c.before }));
  };

  const rightRows = (): RightRow[] => {
    const changes = diff()?.changes ?? [];
    return changes
      .filter((c) => c.type === 'added' || c.type === 'modified')
      .map((c) => ({ path: c.path, value: c.after }));
  };

  const isEmpty = () => (diff()?.changes ?? []).length === 0;

  return (
    <div class="flex flex-col gap-2">
      <Show
        when={!diff.loading}
        fallback={
          <div class="flex items-center justify-center h-24 rounded bg-zinc-800 text-sm text-zinc-400">
            Computing diff…
          </div>
        }
      >
        <Show
          when={diff.error}
        >
          <div class="rounded bg-zinc-800 px-3 py-2 text-sm text-red-400 font-mono">
            Diff error: {String(diff.error)}
          </div>
        </Show>

        <Show when={!diff.error}>
          <Show
            when={!isEmpty()}
            fallback={
              <div class="rounded bg-zinc-800 px-3 py-2 text-sm text-zinc-500 italic">
                No changes.
              </div>
            }
          >
            <div class="grid grid-cols-2 rounded overflow-hidden border border-zinc-700 text-sm font-mono">
              {/* Column headers */}
              <div class="bg-red-900/50 px-3 py-1.5 text-xs font-sans font-semibold text-red-300 border-b border-r border-zinc-700">
                Removed
              </div>
              <div class="bg-green-900/50 px-3 py-1.5 text-xs font-sans font-semibold text-green-300 border-b border-zinc-700">
                Added / Modified
              </div>

              {/* Left column — removed + before-side of modifications */}
              <div class="bg-red-900/30 border-r border-zinc-700 divide-y divide-zinc-700/50">
                <For each={leftRows()}>
                  {(row) => (
                    <div class="px-3 py-1.5 text-red-200 whitespace-pre-wrap break-all">
                      <span class="text-red-400">{row.path}</span>
                      <Show when={row.value !== undefined}>
                        <span class="text-zinc-400">:</span>
                        <span class="text-red-200">{row.value}</span>
                      </Show>
                    </div>
                  )}
                </For>
                {/* Pad with blank rows to align heights when counts differ */}
                <Show when={leftRows().length === 0}>
                  <div class="px-3 py-1.5 text-zinc-600 italic text-xs">—</div>
                </Show>
              </div>

              {/* Right column — added + after-side of modifications */}
              <div class="bg-green-900/30 divide-y divide-zinc-700/50">
                <For each={rightRows()}>
                  {(row) => (
                    <div class="px-3 py-1.5 text-green-200 whitespace-pre-wrap break-all">
                      <span class="text-green-400">{row.path}</span>
                      <Show when={row.value !== undefined}>
                        <span class="text-zinc-400">:</span>
                        <span class="text-green-200">{row.value}</span>
                      </Show>
                    </div>
                  )}
                </For>
                <Show when={rightRows().length === 0}>
                  <div class="px-3 py-1.5 text-zinc-600 italic text-xs">—</div>
                </Show>
              </div>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
