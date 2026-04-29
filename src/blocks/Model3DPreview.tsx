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

import { createMemo, createResource, createSignal, Show } from 'solid-js';
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
  resolved_path?: string;
  file_exists?: boolean | null;
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

  // alpha.22: in library mode, also render the actual 3D PNG via kicad-cli
  // pcb render. This is more expensive than reading the (model …) info, so
  // gate it on library mode + a present model. The render reflects the
  // (model …) (offset|rotate|scale) values currently on disk, so re-fetch
  // when the positioner saves new values (renderRev bumps each save).
  const [renderRev, setRenderRev] = createSignal(0);
  const [renderedPng] = createResource(
    () => (isLibraryMode() && info() ? `${key()}#${renderRev()}` : null),
    async (k: string | null) => {
      if (!k) return null;
      try {
        const r = await invoke<{ png_data_url: string }>('sidecar_call', {
          method: 'library.render_3d_png',
          params: { lib_dir: props.libDir, component_name: props.componentName },
        });
        return r.png_data_url;
      } catch (e) {
        console.warn('[3D render] failed:', e);
        return null;
      }
    },
  );

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  const handleView3D = () => {
    const ws = currentWorkspace();
    const params = isLibraryMode()
      ? {
          workspace: ws?.root,
          lib_dir: props.libDir,
          component_name: props.componentName,
          kind: 'footprint',
        }
      : {
          workspace: ws?.root,
          staging_dir: props.stagingDir,
          lcsc: props.lcsc,
          // The 3D viewer is accessed inside the footprint editor via Alt+3
          kind: 'footprint',
        };
    invoke<{ pid: number }>('sidecar_call', { method: 'editor.open', params })
      .then((r) =>
        pushToast({
          kind: 'success',
          message: `Opened footprint editor (pid ${r.pid}) — press Alt+3 for 3D viewer`,
        }),
      )
      .catch((e: unknown) => {
        const reason = e instanceof Error ? e.message : String(e);
        console.error('[editor] open footprint (for 3D view) failed:', e);
        pushToast({ kind: 'error', message: `Open footprint failed: ${reason}` });
      });
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
            {/* alpha.22: render actual 3D PNG (library mode only — staging
                doesn't yet have a registered KSL_ROOT, so the .step's
                (model) path won't resolve at render time). */}
            <Show when={isLibraryMode()}>
              <Show
                when={!renderedPng.loading && renderedPng()}
                fallback={
                  <div
                    data-testid="3d-render-fallback"
                    class="flex items-center justify-center h-40 rounded bg-zinc-200 dark:bg-zinc-800 text-xs text-zinc-500 dark:text-zinc-400"
                  >
                    {renderedPng.loading ? 'Rendering 3D…' : '3D render unavailable'}
                  </div>
                }
              >
                <div class="rounded overflow-hidden bg-white dark:bg-zinc-950">
                  <img
                    data-testid="3d-render-png"
                    src={renderedPng() ?? ''}
                    alt={`3D render of ${model().filename}`}
                    style={{ width: '100%', height: '240px', 'object-fit': 'contain' }}
                  />
                </div>
              </Show>
            </Show>

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
                onSaved={() => {
                  refetch();
                  setRenderRev((n) => n + 1);
                }}
              />
            </Show>

            {/* Full path — resolved (${KSL_ROOT} expanded) so the user
                sees a real on-disk path. Also flag if the .step file
                doesn't actually exist where the .kicad_mod points. */}
            <p
              class="text-xs font-mono text-zinc-500 dark:text-zinc-500 truncate"
              title={model().resolved_path || model().model_path}
            >
              {model().resolved_path || model().model_path}
            </p>
            <Show when={model().file_exists === false}>
              <p class="text-xs text-amber-600 dark:text-amber-400">
                ⚠ Model file not found at this path
              </p>
            </Show>

            {/* Actions */}
            <div class="flex items-center gap-2 pt-1">
              <button
                data-testid="view-3d-in-kicad"
                onClick={handleView3D}
                title="Opens the footprint editor — press Alt+3 for the 3D viewer"
                class="text-xs px-2 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors"
              >
                View 3D in KiCad
              </button>
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
