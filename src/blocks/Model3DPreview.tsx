/**
 * Model3DPreview — KiCad 3D model info card.
 *
 * Props: { stagingDir: string; lcsc: string }
 *
 * Calls `library.get_3d_info` to read the footprint's (model ...) block via
 * kiutils and renders an info card with offset/rotation/scale values plus
 * buttons to open KiCad's 3D viewer or replace the 3D model file.
 */

import { createMemo, createResource, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { currentWorkspace } from '~/state/workspace';
import { pushToast } from '~/state/toasts';

interface Props {
  stagingDir: string;
  lcsc: string;
}

interface Model3DInfo {
  model_path: string;
  filename: string;
  format: string;
  offset: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

function fmt(n: number, decimals = 3): string {
  return n.toFixed(decimals);
}

export default function Model3DPreview(props: Props) {
  // --------------------------------------------------------------------------
  // Data — fetched via sidecar RPC
  // --------------------------------------------------------------------------

  // Use a memo as the source signal so re-renders on prop changes retrigger the fetch.
  const key = createMemo(() => `${props.stagingDir}/${props.lcsc}`);

  const [info, { refetch }] = createResource<Model3DInfo | null, string>(
    key,
    (_key) =>
      invoke<Model3DInfo | null>('sidecar_call', {
        method: 'library.get_3d_info',
        params: {
          staging_dir: props.stagingDir,
          lcsc: props.lcsc,
        },
      }).catch(() => null),
  );

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  const handleView3D = () => {
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

    const libDir = `${props.stagingDir}/${props.lcsc}`;
    try {
      const result = await invoke<{ path: string }>('sidecar_call', {
        method: 'library.replace_3d',
        params: {
          lib_dir: libDir,
          component_name: props.lcsc,
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
    <div class="rounded border border-zinc-700 bg-zinc-900 p-3 space-y-3">
      {/* Card header */}
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-zinc-300">3D Model</span>
        <Show when={info()}>
          {(model) => (
            <span class="text-xs font-mono uppercase tracking-wide px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-300">
              {model().format}
            </span>
          )}
        </Show>
      </div>

      {/* Loading state */}
      <Show when={info.loading}>
        <p class="text-xs text-zinc-500">Loading…</p>
      </Show>

      {/* Model found */}
      <Show when={!info.loading && info()}>
        {(model) => (
          <div class="space-y-2">
            {/* Filename */}
            <p class="text-sm text-zinc-100 font-mono truncate" title={model().filename}>
              {model().filename}
            </p>

            {/* Offset / Rotation / Scale table */}
            <div class="grid grid-cols-[auto_1fr_1fr_1fr] gap-x-3 gap-y-1 text-xs">
              <span class="text-zinc-500 self-center">Offset</span>
              <span class="font-mono text-zinc-300 text-right">{fmt(model().offset[0])} mm</span>
              <span class="font-mono text-zinc-300 text-right">{fmt(model().offset[1])} mm</span>
              <span class="font-mono text-zinc-300 text-right">{fmt(model().offset[2])} mm</span>

              <span class="text-zinc-500 self-center">Rotation</span>
              <span class="font-mono text-zinc-300 text-right">{fmt(model().rotation[0], 1)}°</span>
              <span class="font-mono text-zinc-300 text-right">{fmt(model().rotation[1], 1)}°</span>
              <span class="font-mono text-zinc-300 text-right">{fmt(model().rotation[2], 1)}°</span>

              <span class="text-zinc-500 self-center">Scale</span>
              <span class="font-mono text-zinc-300 text-right">{fmt(model().scale[0], 2)}</span>
              <span class="font-mono text-zinc-300 text-right">{fmt(model().scale[1], 2)}</span>
              <span class="font-mono text-zinc-300 text-right">{fmt(model().scale[2], 2)}</span>
            </div>

            {/* Full path */}
            <p
              class="text-xs font-mono text-zinc-500 truncate"
              title={model().model_path}
            >
              {model().model_path}
            </p>

            {/* Actions */}
            <div class="flex items-center gap-2 pt-1">
              <button
                onClick={handleView3D}
                title="Opens the footprint editor — press Alt+3 for the 3D viewer"
                class="text-xs px-2 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors"
              >
                View 3D in KiCad
              </button>
              <button
                onClick={handleReplace3D}
                class="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors"
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
          <p class="text-sm text-zinc-500">No 3D model attached.</p>
          <button
            onClick={handleReplace3D}
            class="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors"
          >
            Add 3D model…
          </button>
        </div>
      </Show>
    </div>
  );
}
