/**
 * Model3DPreview — KiCad 3D model info card.
 *
 * Two calling conventions:
 *
 *   Staging mode (Add / Review rooms):
 *     <Model3DPreview stagingDir="/staging" lcsc="C25804" />
 *
 *   Library mode (Libraries room):
 *     <Model3DPreview libDir="/ws/Resistors_KSL" componentName="R_10k_0402" />
 *
 * Calls `library.get_3d_info` to read the footprint's (model ...) block via
 * kiutils and renders an info card with offset/rotation/scale values plus
 * buttons to open KiCad's 3D viewer or replace the 3D model file.
 *
 * In library mode, the read-only offset/rotation/scale table is replaced
 * with an editable Model3DPositioner block.
 */

import { createMemo, createResource, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { currentWorkspace } from '~/state/workspace';
import { pushToast } from '~/state/toasts';
import Model3DPositioner from '~/blocks/Model3DPositioner';

interface Props {
  stagingDir?: string;
  lcsc?: string;
  libDir?: string;
  componentName?: string;
}

interface Model3DInfo {
  model_path: string;
  filename: string;
  format: string;
  offset: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export default function Model3DPreview(props: Props) {
  const isLibraryMode = () => Boolean(props.libDir && props.componentName);

  // --------------------------------------------------------------------------
  // Data — fetched via sidecar RPC
  // --------------------------------------------------------------------------

  // Use a memo as the source signal so re-renders on prop changes retrigger the fetch.
  const key = createMemo(() =>
    isLibraryMode()
      ? `lib:${props.libDir}:${props.componentName}`
      : `staging:${props.stagingDir}:${props.lcsc}`,
  );

  const [info, { refetch }] = createResource<Model3DInfo | null, string>(
    key,
    () =>
      invoke<{ info: Model3DInfo | null }>('sidecar_call', {
        method: 'library.get_3d_info',
        params: isLibraryMode()
          ? { lib_dir: props.libDir, component_name: props.componentName }
          : { staging_dir: props.stagingDir, lcsc: props.lcsc },
      })
        .then((r) => r?.info ?? null)
        .catch(() => null),
  );

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  const handleView3D = () => {
    if (isLibraryMode()) {
      // Library mode doesn't yet have a kicad-launch helper for
      // committed footprints — surface a toast rather than fire a
      // staging-shaped editor.open that would fail.
      pushToast({
        kind: 'info',
        message: 'Open the library in KiCad to view this model in 3D',
      });
      return;
    }
    const ws = currentWorkspace();
    invoke('sidecar_call', {
      method: 'editor.open',
      params: {
        workspace: ws?.root,
        staging_dir: props.stagingDir,
        lcsc: props.lcsc,
        // The 3D viewer is accessed inside the footprint editor via Alt+3
        kind: 'footprint',
      },
    }).catch((e: unknown) =>
      console.error('[editor] open footprint (for 3D view) failed:', e),
    );
  };

  const handleReplace3D = async () => {
    const picked = await openDialog({
      title: 'Select 3D model',
      filters: [{ name: '3D Models', extensions: ['step', 'stp', 'wrl', 'glb'] }],
      multiple: false,
    });
    if (typeof picked !== 'string') return;

    const lib_dir = isLibraryMode() ? props.libDir! : `${props.stagingDir}/${props.lcsc}`;
    const component_name = isLibraryMode() ? props.componentName! : props.lcsc!;

    try {
      const result = await invoke<{ path: string }>('sidecar_call', {
        method: 'library.replace_3d',
        params: {
          lib_dir,
          component_name,
          new_step_path: picked,
        },
      });
      const filename = result.path.split('/').pop() ?? result.path;
      pushToast({ kind: 'success', message: `Replaced 3D model: ${filename}` });
      refetch();
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      pushToast({ kind: 'error', message: `Replace failed: ${reason}` });
    }
  };

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div class="rounded border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 p-3 space-y-3">
      {/* Card header */}
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-zinc-700 dark:text-zinc-300">3D Model</span>
        <Show when={info()}>
          {(model) => (
            <span class="text-xs font-mono uppercase tracking-wide px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300">
              {model().format}
            </span>
          )}
        </Show>
      </div>

      {/* Loading state */}
      <Show when={info.loading}>
        <p class="text-xs text-zinc-400 dark:text-zinc-500">Loading…</p>
      </Show>

      {/* Model found */}
      <Show when={!info.loading && info()}>
        {(model) => (
          <div class="space-y-2">
            {/* Filename */}
            <p class="text-sm text-zinc-900 dark:text-zinc-100 font-mono truncate" title={model().filename}>
              {model().filename}
            </p>

            {/* Editable positioner (library mode) or read-only table (staging mode) */}
            <Show
              when={isLibraryMode()}
              fallback={
                <div class="grid grid-cols-[auto_1fr_1fr_1fr] gap-x-3 gap-y-1 text-xs">
                  <span class="text-zinc-500 dark:text-zinc-500 self-center">Offset</span>
                  <span class="font-mono text-zinc-700 dark:text-zinc-300 text-right">{model().offset[0].toFixed(3)} mm</span>
                  <span class="font-mono text-zinc-700 dark:text-zinc-300 text-right">{model().offset[1].toFixed(3)} mm</span>
                  <span class="font-mono text-zinc-700 dark:text-zinc-300 text-right">{model().offset[2].toFixed(3)} mm</span>

                  <span class="text-zinc-500 dark:text-zinc-500 self-center">Rotation</span>
                  <span class="font-mono text-zinc-700 dark:text-zinc-300 text-right">{model().rotation[0].toFixed(1)}°</span>
                  <span class="font-mono text-zinc-700 dark:text-zinc-300 text-right">{model().rotation[1].toFixed(1)}°</span>
                  <span class="font-mono text-zinc-700 dark:text-zinc-300 text-right">{model().rotation[2].toFixed(1)}°</span>

                  <span class="text-zinc-500 dark:text-zinc-500 self-center">Scale</span>
                  <span class="font-mono text-zinc-700 dark:text-zinc-300 text-right">{model().scale[0].toFixed(2)}</span>
                  <span class="font-mono text-zinc-700 dark:text-zinc-300 text-right">{model().scale[1].toFixed(2)}</span>
                  <span class="font-mono text-zinc-700 dark:text-zinc-300 text-right">{model().scale[2].toFixed(2)}</span>
                </div>
              }
            >
              <Model3DPositioner
                libDir={props.libDir!}
                componentName={props.componentName!}
                offset={model().offset}
                rotation={model().rotation}
                scale={model().scale}
                onSaved={() => refetch()}
              />
            </Show>

            {/* Full path */}
            <p
              class="text-xs font-mono text-zinc-500 dark:text-zinc-500 truncate"
              title={model().model_path}
            >
              {model().model_path}
            </p>

            {/* Actions */}
            <div class="flex items-center gap-2 pt-1">
              <Show when={!isLibraryMode()}>
                <button
                  onClick={handleView3D}
                  title="Opens the footprint editor — press Alt+3 for the 3D viewer"
                  class="text-xs px-2 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors"
                >
                  View 3D in KiCad
                </button>
              </Show>
              <button
                onClick={handleReplace3D}
                class="text-xs px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-200 transition-colors"
              >
                Replace 3D model…
              </button>
            </div>
          </div>
        )}
      </Show>

      {/* Empty state — no model block */}
      <Show when={!info.loading && info() === null}>
        <div class="space-y-2">
          <p class="text-sm text-zinc-500 dark:text-zinc-500">No 3D model attached.</p>
          <button
            onClick={handleReplace3D}
            class="text-xs px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-200 transition-colors"
          >
            Add 3D model…
          </button>
        </div>
      </Show>
    </div>
  );
}
