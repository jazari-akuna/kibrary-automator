/**
 * LibraryTree — left pane of the Libraries room.
 *
 * Shows a collapsible list of libraries with component counts.
 * Selecting a library updates selectedLib state.
 * "+ New library" is a P6 stub.
 */

import { createResource, createSignal, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { currentWorkspace } from '~/state/workspace';
import { selectedLib, setSelectedLib, setSelectedComponent, setMultiSelected } from '~/state/librariesRoom';

interface LibraryInfo {
  name: string;
  path: string;
  component_count: number;
  has_pretty: boolean;
  has_3dshapes: boolean;
}

interface LibraryListResult {
  libraries: LibraryInfo[];
}

export default function LibraryTree() {
  const ws = currentWorkspace();

  const [libs] = createResource<LibraryListResult | null, string | null>(
    () => currentWorkspace()?.root ?? null,
    async (root) => {
      if (!root) return null;
      return invoke<LibraryListResult>('sidecar_call', {
        method: 'library.list',
        params: { workspace: root },
      });
    }
  );

  // Track which libraries are expanded (collapsed by default)
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());

  const toggleExpand = (name: string) => {
    setExpanded((prev) => {
      const next = new Set<string>(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const selectLib = (name: string) => {
    setSelectedLib(name);
    setSelectedComponent(null);
    setMultiSelected(new Set<string>());
    // Also expand the selected library
    setExpanded((prev) => {
      const next = new Set<string>(prev);
      next.add(name);
      return next;
    });
  };

  return (
    <div class="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div class="px-3 py-2 border-b border-zinc-700 flex-shrink-0">
        <Show
          when={!libs.loading && libs()}
          fallback={
            <span class="text-sm font-medium text-zinc-300">Libraries</span>
          }
        >
          <span class="text-sm font-medium text-zinc-300">
            Libraries ({libs()?.libraries.length ?? 0})
          </span>
        </Show>
      </div>

      {/* No workspace */}
      <Show when={!currentWorkspace()}>
        <div class="flex-1 flex items-center justify-center px-3">
          <span class="text-xs text-zinc-500">Open a workspace first</span>
        </div>
      </Show>

      {/* Loading */}
      <Show when={currentWorkspace() && libs.loading}>
        <div class="flex-1 flex items-center justify-center px-3">
          <span class="text-xs text-zinc-400">Loading libraries…</span>
        </div>
      </Show>

      {/* Error */}
      <Show when={currentWorkspace() && !libs.loading && libs.error}>
        <div class="flex-1 flex items-center justify-center px-3">
          <span class="text-xs text-red-400">Failed to load libraries</span>
        </div>
      </Show>

      {/* Library list */}
      <Show when={currentWorkspace() && !libs.loading && !libs.error && libs()}>
        <div class="flex-1 overflow-y-auto py-1">
          <For each={libs()!.libraries}>
            {(lib) => {
              const isExpanded = () => expanded().has(lib.name);
              const isSelected = () => selectedLib() === lib.name;

              return (
                <div>
                  {/* Library row */}
                  <button
                    class={`w-full flex items-center gap-1 px-3 py-1.5 text-sm text-left transition-colors
                      ${isSelected()
                        ? 'bg-zinc-600 text-zinc-100'
                        : 'text-zinc-300 hover:bg-zinc-700'
                      }`}
                    onClick={() => {
                      selectLib(lib.name);
                      toggleExpand(lib.name);
                    }}
                  >
                    <span class="text-zinc-400 w-3 flex-shrink-0">
                      {isExpanded() ? '▾' : '▸'}
                    </span>
                    <span class="flex-1 truncate">{lib.name}</span>
                    <span class="text-xs text-zinc-500 flex-shrink-0">{lib.component_count}</span>
                  </button>

                  {/* Expanded sub-row (selected indicator) */}
                  <Show when={isExpanded() && isSelected()}>
                    <div class="pl-7 pr-3 py-0.5">
                      <span class="text-xs text-zinc-500">
                        {lib.component_count} component{lib.component_count !== 1 ? 's' : ''}
                        {lib.has_pretty ? ' · footprints' : ''}
                        {lib.has_3dshapes ? ' · 3D' : ''}
                      </span>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>

        {/* + New library stub */}
        <div class="flex-shrink-0 border-t border-zinc-700">
          <button
            class="w-full px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 text-left transition-colors"
            onClick={() => console.log('TODO P6')}
          >
            + New library
          </button>
        </div>
      </Show>
    </div>
  );
}
