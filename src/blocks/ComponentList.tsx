/**
 * ComponentList — middle pane of the Libraries room.
 *
 * Shows a search bar + checkbox list of components in the selected library.
 * Each row has inline ✎ (edit) and 🗑 (delete) icon stubs.
 * Bulk action toolbar at the bottom (Move/Delete/Re-export stubs).
 */

import { createResource, createSignal, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { currentWorkspace } from '~/state/workspace';
import {
  selectedLib,
  selectedComponent,
  setSelectedComponent,
  multiSelected,
  toggleSelect,
  setMultiSelected,
} from '~/state/librariesRoom';

interface ComponentInfo {
  name: string;
  description: string;
  reference: string;
  value: string;
  footprint: string;
}

interface ComponentListResult {
  components: ComponentInfo[];
}

export default function ComponentList() {
  const [search, setSearch] = createSignal('');

  const [components] = createResource<ComponentListResult | null, string | null>(
    () => {
      const ws = currentWorkspace();
      const lib = selectedLib();
      if (!ws || !lib) return null;
      // Key: combine workspace root + lib name so resource re-fetches on either change
      return `${ws.root}::${lib}`;
    },
    async (key) => {
      if (!key) return null;
      const [wsRoot, libName] = key.split('::');
      return invoke<ComponentListResult>('sidecar_call', {
        method: 'library.list_components',
        params: { lib_dir: `${wsRoot}/${libName}` },
      });
    }
  );

  const filtered = () => {
    const q = search().toLowerCase().trim();
    const all = components()?.components ?? [];
    if (!q) return all;
    return all.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.value.toLowerCase().includes(q)
    );
  };

  const lib = selectedLib;

  return (
    <div class="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div class="px-3 py-2 border-b border-zinc-700 flex-shrink-0">
        <Show
          when={lib()}
          fallback={<span class="text-sm font-medium text-zinc-300">Components</span>}
        >
          <span class="text-sm font-medium text-zinc-300">
            {lib()} ({components()?.components.length ?? '…'})
          </span>
        </Show>
      </div>

      {/* No workspace */}
      <Show when={!currentWorkspace()}>
        <div class="flex-1 flex items-center justify-center px-3">
          <span class="text-xs text-zinc-500">Open a workspace first</span>
        </div>
      </Show>

      {/* No lib selected */}
      <Show when={currentWorkspace() && !lib()}>
        <div class="flex-1 flex items-center justify-center px-3">
          <span class="text-xs text-zinc-500">Select a library</span>
        </div>
      </Show>

      <Show when={currentWorkspace() && lib()}>
        {/* Search bar */}
        <div class="px-3 py-2 border-b border-zinc-700 flex-shrink-0">
          <div class="flex items-center gap-2">
            <span class="text-xs text-zinc-500 flex-shrink-0">Search:</span>
            <input
              type="text"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              placeholder="Filter components…"
              class="flex-1 bg-zinc-800 px-2 py-1 rounded text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-500 placeholder-zinc-600"
            />
          </div>
        </div>

        {/* Loading */}
        <Show when={components.loading}>
          <div class="flex-1 flex items-center justify-center px-3">
            <span class="text-xs text-zinc-400">Loading components…</span>
          </div>
        </Show>

        {/* Error */}
        <Show when={!components.loading && components.error}>
          <div class="flex-1 flex items-center justify-center px-3">
            <span class="text-xs text-red-400">Failed to load components</span>
          </div>
        </Show>

        {/* Component list */}
        <Show when={!components.loading && !components.error}>
          <div class="flex-1 overflow-y-auto">
            <Show
              when={filtered().length > 0}
              fallback={
                <div class="flex items-center justify-center h-16">
                  <span class="text-xs text-zinc-500">No components found</span>
                </div>
              }
            >
              <For each={filtered()}>
                {(comp) => {
                  const isSelected = () => selectedComponent() === comp.name;
                  const isChecked = () => multiSelected().has(comp.name);

                  return (
                    <div
                      class={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors
                        ${isSelected()
                          ? 'bg-zinc-600'
                          : 'hover:bg-zinc-700'
                        }`}
                      onClick={() => setSelectedComponent(comp.name)}
                    >
                      {/* Checkbox */}
                      <input
                        type="checkbox"
                        checked={isChecked()}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelect(comp.name);
                        }}
                        class="flex-shrink-0 accent-zinc-400"
                      />

                      {/* Name + description */}
                      <div class="flex-1 min-w-0">
                        <span class="text-sm text-zinc-200 truncate block">{comp.name}</span>
                        <Show when={comp.description}>
                          <span class="text-xs text-zinc-500 truncate block">{comp.description}</span>
                        </Show>
                      </div>

                      {/* Inline action icons — visible on hover or when selected */}
                      <div class={`flex items-center gap-1 flex-shrink-0 ${isSelected() ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
                        <button
                          title="Rename component (P6)"
                          class="px-1 py-0.5 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-600 text-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            console.log('TODO P6');
                          }}
                        >
                          ✎
                        </button>
                        <button
                          title="Delete component (P6)"
                          class="px-1 py-0.5 rounded text-zinc-400 hover:text-red-400 hover:bg-zinc-600 text-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            console.log('TODO P6');
                          }}
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>

          {/* Bulk actions toolbar */}
          <div class="flex-shrink-0 border-t border-zinc-700 px-3 py-2">
            <div class="flex items-center gap-2">
              <Show when={multiSelected().size > 0}>
                <span class="text-xs text-zinc-400 flex-shrink-0">
                  {multiSelected().size} selected
                </span>
              </Show>
              <Show when={multiSelected().size === 0}>
                <span class="text-xs text-zinc-500 flex-shrink-0">Bulk:</span>
              </Show>
              <button
                class="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors disabled:opacity-40"
                disabled={multiSelected().size === 0}
                onClick={() => console.log('TODO P6')}
              >
                Move…
              </button>
              <button
                class="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-red-700 text-zinc-300 transition-colors disabled:opacity-40"
                disabled={multiSelected().size === 0}
                onClick={() => console.log('TODO P6')}
              >
                Delete
              </button>
              <button
                class="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors"
                onClick={() => console.log('TODO P9')}
              >
                Re-export
              </button>
              <Show when={multiSelected().size > 0}>
                <button
                  class="text-xs px-2 py-1 rounded text-zinc-500 hover:text-zinc-300 transition-colors ml-auto"
                  onClick={() => setMultiSelected(new Set())}
                >
                  Clear
                </button>
              </Show>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
}
