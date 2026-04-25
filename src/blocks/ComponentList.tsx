/**
 * ComponentList — middle pane of the Libraries room.
 *
 * Shows a search bar + checkbox list of components in the selected library.
 * Each row has inline ✎ (rename) and 🗑 (delete) icon buttons.
 * Bulk action toolbar at the bottom (Move/Delete/Re-export).
 *
 * P6: Rename, Move, and Delete modals are wired up here.
 *     Re-export is fully implemented (P9).
 */

import { createResource, createSignal, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { currentWorkspace } from '~/state/workspace';
import { pushToast } from '~/state/toasts';
import {
  selectedLib,
  selectedComponent,
  setSelectedComponent,
  multiSelected,
  toggleSelect,
  setMultiSelected,
} from '~/state/librariesRoom';
import ComponentRenameModal from '~/blocks/ComponentRenameModal';
import ComponentMoveModal from '~/blocks/ComponentMoveModal';
import ComponentDeleteModal from '~/blocks/ComponentDeleteModal';

// ---------------------------------------------------------------------------
// Types used by the Re-export flow
// ---------------------------------------------------------------------------

interface KiCadInstall {
  id: string;
  type: string;
  version: string;
  config_dir: string;
  sym_table: string;
  fp_table: string;
  kicad_bin: string | null;
  eeschema_bin: string | null;
  pcbnew_bin: string | null;
}

interface LibraryInfo {
  name: string;
  /** Absolute path to the library directory (returned as a string by the sidecar). */
  path: string;
}

// ---------------------------------------------------------------------------
// Re-export helper
// ---------------------------------------------------------------------------

/**
 * Re-export one or more libraries to the workspace's configured KiCad install.
 *
 * Scoping rules (P9 spec):
 *   - If `multiSelected` has items → export only the currently selected lib
 *   - Otherwise                   → export ALL libs in the workspace
 */
async function reExportLibraries(
  wsRoot: string,
  kicadTarget: string | null | undefined,
  currentLib: string | null,
  selectedComponents: Set<string>,
): Promise<void> {
  // Guard: no KiCad target configured
  if (!kicadTarget) {
    pushToast({ kind: 'error', message: 'No KiCad install configured. Set one in Settings.' });
    return;
  }

  // Step 1: detect installs and find the matching one
  let install: KiCadInstall | undefined;
  try {
    const detected = await invoke<{ installs: KiCadInstall[] }>('sidecar_call', {
      method: 'kicad.detect',
      params: {},
    });
    install = detected.installs.find((i) => i.id === kicadTarget);
  } catch (e) {
    pushToast({ kind: 'error', message: `KiCad detection failed: ${e}` });
    return;
  }

  if (!install) {
    pushToast({
      kind: 'error',
      message: `KiCad install "${kicadTarget}" not found. Try re-running the setup wizard.`,
    });
    return;
  }

  // Step 2: determine which libs to export
  let libs: { name: string; path: string }[];

  if (selectedComponents.size > 0 && currentLib) {
    // Components are selected → export their parent lib only
    libs = [{ name: currentLib, path: `${wsRoot}/${currentLib}` }];
  } else {
    // Nothing selected → export all libs in the workspace
    try {
      const result = await invoke<{ libraries: LibraryInfo[] }>('sidecar_call', {
        method: 'library.list',
        params: { workspace: wsRoot },
      });
      libs = result.libraries.map((l) => ({ name: l.name, path: String(l.path) }));
    } catch (e) {
      pushToast({ kind: 'error', message: `Failed to list libraries: ${e}` });
      return;
    }
  }

  if (libs.length === 0) {
    pushToast({ kind: 'info', message: 'No libraries found to export.' });
    return;
  }

  // Step 3: register each lib, collecting failures
  const failures: string[] = [];
  for (const lib of libs) {
    try {
      await invoke('sidecar_call', {
        method: 'kicad.register',
        params: { install, lib_name: lib.name, lib_dir: lib.path },
      });
    } catch (e) {
      failures.push(`${lib.name}: ${e}`);
    }
  }

  // Step 4: report results
  const successCount = libs.length - failures.length;
  if (failures.length > 0) {
    pushToast({
      kind: 'error',
      message: `Re-exported ${successCount}/${libs.length} libraries. Failures: ${failures.join('; ')}`,
    });
  } else {
    pushToast({
      kind: 'success',
      message: `Re-exported ${successCount} ${successCount === 1 ? 'library' : 'libraries'} to KiCad`,
    });
  }
}

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

type ModalKind = 'rename' | 'move' | 'delete' | null;

// ---------------------------------------------------------------------------
// Icon helpers
// ---------------------------------------------------------------------------

/** Generic component icon shown when no SVG thumbnail is available. */
function DefaultIcon() {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      class="w-full h-full"
    >
      {/* Body rectangle */}
      <rect x="8" y="10" width="16" height="12" rx="1" stroke="#71717a" stroke-width="1.5" />
      {/* Left lead */}
      <line x1="4" y1="16" x2="8" y2="16" stroke="#71717a" stroke-width="1.5" stroke-linecap="round" />
      {/* Right lead */}
      <line x1="24" y1="16" x2="28" y2="16" stroke="#71717a" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  );
}

interface IconGetResult {
  svg: string | null;
}

export default function ComponentList() {
  const [search, setSearch] = createSignal('');
  const [reExporting, setReExporting] = createSignal(false);
  const [backfilling, setBackfilling] = createSignal(false);

  // Modal state — single signal tracks which (if any) modal is open
  const [openModal, setOpenModal] = createSignal<ModalKind>(null);
  // For inline (single-component) actions; null means bulk selection is the scope
  const [modalTarget, setModalTarget] = createSignal<string | null>(null);

  const [components, { refetch }] = createResource<ComponentListResult | null, string | null>(
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

  // Absolute path for the currently selected library
  const libDir = () => {
    const ws = currentWorkspace();
    const libName = lib();
    if (!ws || !libName) return '';
    return `${ws.root}/${libName}`;
  };

  // Components in the bulk selection
  const bulkNames = () => Array.from(multiSelected());

  // The names the open modal should operate on
  const modalNames = (): string[] => {
    const target = modalTarget();
    if (target !== null) return [target];
    return bulkNames();
  };

  // Close any modal and refetch the component list to stay current
  const handleModalClose = () => {
    setOpenModal(null);
    setModalTarget(null);
    refetch();
  };

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

                  // Fetch icon SVG — keyed on lib_dir + component_name
                  const [iconData] = createResource<IconGetResult | null, string>(
                    () => {
                      const dir = libDir();
                      if (!dir) return '';
                      return `${dir}::${comp.name}`;
                    },
                    async (key) => {
                      if (!key) return null;
                      const [dir, name] = key.split('::');
                      try {
                        return await invoke<IconGetResult>('sidecar_call', {
                          method: 'library.get_component_icon',
                          params: { lib_dir: dir, component_name: name },
                        });
                      } catch {
                        return null;
                      }
                    },
                  );

                  const icon = () => iconData()?.svg ?? null;

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

                      {/* SVG thumbnail */}
                      <div class="w-8 h-8 bg-zinc-800 rounded flex-shrink-0 flex items-center justify-center overflow-hidden">
                        <Show when={icon()} fallback={<DefaultIcon />}>
                          <div innerHTML={icon()!} class="w-full h-full" />
                        </Show>
                      </div>

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
                          title="Rename component"
                          class="px-1 py-0.5 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-600 text-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setModalTarget(comp.name);
                            setOpenModal('rename');
                          }}
                        >
                          ✎
                        </button>
                        <button
                          title="Delete component"
                          class="px-1 py-0.5 rounded text-zinc-400 hover:text-red-400 hover:bg-zinc-600 text-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setModalTarget(comp.name);
                            setOpenModal('delete');
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
                onClick={() => {
                  setModalTarget(null);
                  setOpenModal('move');
                }}
              >
                Move…
              </button>
              <button
                class="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-red-700 text-zinc-300 transition-colors disabled:opacity-40"
                disabled={multiSelected().size === 0}
                onClick={() => {
                  setModalTarget(null);
                  setOpenModal('delete');
                }}
              >
                Delete
              </button>
              <button
                class="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors disabled:opacity-40"
                disabled={reExporting()}
                onClick={async () => {
                  const ws = currentWorkspace();
                  if (!ws) {
                    pushToast({ kind: 'error', message: 'No workspace open.' });
                    return;
                  }
                  setReExporting(true);
                  try {
                    await reExportLibraries(
                      ws.root,
                      ws.settings?.kicad_target,
                      selectedLib(),
                      multiSelected(),
                    );
                  } finally {
                    setReExporting(false);
                  }
                }}
              >
                {reExporting() ? 'Exporting…' : 'Re-export'}
              </button>
              <button
                class="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors disabled:opacity-40"
                disabled={backfilling()}
                onClick={async () => {
                  const ws = currentWorkspace();
                  if (!ws) {
                    pushToast({ kind: 'error', message: 'No workspace open.' });
                    return;
                  }
                  setBackfilling(true);
                  try {
                    const result = await invoke<{
                      libs_processed: number;
                      icons_rendered: number;
                      errors: string[];
                    }>('sidecar_call', {
                      method: 'library.backfill_icons',
                      params: { workspace: ws.root },
                    });
                    if (result.errors.length > 0) {
                      pushToast({
                        kind: 'error',
                        message: `Rendered ${result.icons_rendered} icons (${result.errors.length} errors)`,
                      });
                    } else {
                      pushToast({
                        kind: 'success',
                        message: `Rendered ${result.icons_rendered} icons across ${result.libs_processed} libraries`,
                      });
                    }
                    refetch();
                  } catch (e) {
                    pushToast({ kind: 'error', message: `Backfill failed: ${e}` });
                  } finally {
                    setBackfilling(false);
                  }
                }}
              >
                {backfilling() ? 'Rendering…' : 'Render missing icons'}
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

      {/* ------------------------------------------------------------------ */}
      {/* Modals — rendered at root level so they float above all content     */}
      {/* ------------------------------------------------------------------ */}

      {/* Rename — single-component scope only */}
      <ComponentRenameModal
        open={openModal() === 'rename'}
        onClose={handleModalClose}
        libDir={libDir()}
        libName={lib() ?? ''}
        componentName={modalNames()[0]}
      />

      {/* Move — single or bulk */}
      <ComponentMoveModal
        open={openModal() === 'move'}
        onClose={handleModalClose}
        libDir={libDir()}
        libName={lib() ?? ''}
        componentName={modalTarget() !== null ? modalTarget()! : undefined}
        componentNames={modalTarget() === null ? bulkNames() : undefined}
      />

      {/* Delete — single or bulk */}
      <ComponentDeleteModal
        open={openModal() === 'delete'}
        onClose={handleModalClose}
        libDir={libDir()}
        libName={lib() ?? ''}
        componentName={modalTarget() !== null ? modalTarget()! : undefined}
        componentNames={modalTarget() === null ? bulkNames() : undefined}
      />
    </div>
  );
}
