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

import { createEffect, createMemo, createResource, createSignal, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { currentWorkspace } from '~/state/workspace';
import { pushToast } from '~/state/toasts';
import Model3DPositioner from '~/blocks/Model3DPositioner';
import Model3DViewer from '~/blocks/Model3DViewer';
import Model3DViewerGL from '~/blocks/Model3DViewerGL';
import Model3DJogDial from '~/blocks/Model3DJogDial';
import Model3DJogZ from '~/blocks/Model3DJogZ';

type Triple = [number, number, number];

interface Props {
  stagingDir?: string;
  lcsc?: string;
  libDir?: string;
  componentName?: string;
}

interface EditorOpenResult {
  pid: number;
  needs_manual_navigation?: boolean;
  file_hint?: string;
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

  // alpha.25: live-preview state for the interactive viewer. The user's
  // unsaved positioner values flow through these signals into the viewer
  // (and hence into the sidecar's render call as transform overrides),
  // so dragging a value updates the picture without ever touching disk.
  const [liveOffset, setLiveOffset] = createSignal<Triple>([0, 0, 0]);
  const [liveRotation, setLiveRotation] = createSignal<Triple>([0, 0, 0]);
  const [liveScale, setLiveScale] = createSignal<Triple>([1, 1, 1]);
  // Bumped on positioner Save — forces the viewer to re-render even when
  // the live values are byref-identical to the (just-refetched) saved ones.
  const [savedRev, setSavedRev] = createSignal(0);
  // Pulse-shaped jog from the jog-dial / Z column. Cleared by the
  // positioner's onJogConsumed once it's applied the delta.
  const [jogDelta, setJogDelta] = createSignal<
    { axis: 'x' | 'y' | 'z'; amount: number } | null
  >(null);
  // Pulse-shaped absolute-offset reset (jog dial centre button). Carries
  // the new offset triple; cleared by the positioner once it applies it.
  const [forceOffset, setForceOffset] = createSignal<Triple | null>(null);

  // Seed the live signals once the model info loads (and any time the
  // selected component changes — keeps live state in sync with the new
  // baseline rather than carrying the previous component's edits over).
  createEffect(() => {
    const m = info();
    if (m) {
      setLiveOffset(m.offset);
      setLiveRotation(m.rotation);
      setLiveScale(m.scale);
    }
  });

  // alpha.28: prefer the WebGL2 / three.js viewer (60+ fps interactive
  // GLB render). If WebGL2 init fails (older WebKitGTK builds), the GL
  // viewer surfaces an `onWebGLError` callback and we fall back to the
  // existing PNG viewer (kicad-cli pcb render per frame).
  const [useGL, setUseGL] = createSignal(true);

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
    invoke<EditorOpenResult>('sidecar_call', { method: 'editor.open', params })
      .then((r) => {
        const filename = r.file_hint
          ? r.file_hint.split('/').pop() ?? r.file_hint
          : '';
        pushToast({
          kind: 'success',
          message: filename
            ? `Opened footprint editor — ${filename} loaded. Press Alt+3 for the 3D viewer.`
            : `Opened footprint editor (pid ${r.pid}) — press Alt+3 for 3D viewer`,
        });
      })
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
            {/* alpha.25: interactive 3D viewer + jog dial (library mode only
                — staging doesn't yet have a registered KSL_ROOT, so the
                .step's (model) path won't resolve at render time). The
                viewer takes the LIVE positioner values so unsaved edits
                show up in the preview without a disk write. */}
            <Show
              when={isLibraryMode() && model().file_exists !== false}
              fallback={
                <Show when={isLibraryMode()}>
                  <div
                    data-testid="3d-render-fallback"
                    class="flex items-center justify-center h-40 rounded bg-zinc-200 dark:bg-zinc-800 text-xs text-zinc-500 dark:text-zinc-400"
                  >
                    3D render unavailable
                  </div>
                </Show>
              }
            >
              <Show
                when={useGL()}
                fallback={
                  <Model3DViewer
                    libDir={props.libDir!}
                    componentName={props.componentName!}
                    offset={liveOffset()}
                    rotation={liveRotation()}
                    scale={liveScale()}
                    savedRev={savedRev()}
                  />
                }
              >
                <Model3DViewerGL
                  libDir={props.libDir!}
                  componentName={props.componentName!}
                  offset={liveOffset()}
                  rotation={liveRotation()}
                  scale={liveScale()}
                  savedRev={savedRev()}
                  onWebGLError={(reason) => {
                    console.warn('[3D viewer] WebGL2 unavailable; falling back to PNG renderer:', reason);
                    setUseGL(false);
                  }}
                />
              </Show>
              <div class="flex items-start justify-center gap-3 pt-2">
                <Model3DJogDial
                  onJog={(axis, amount) => setJogDelta({ axis, amount })}
                  onReset={() => {
                    // Zero X+Y but preserve Z. Push through both the live
                    // signal (so the viewer snaps immediately) and the
                    // positioner's forceOffset prop (so the form fields
                    // also display 0 and the next Save persists it).
                    const z = liveOffset()[2];
                    const next: Triple = [0, 0, z];
                    setLiveOffset(next);
                    setForceOffset(next);
                  }}
                />
                <Model3DJogZ
                  onJog={(amount) => setJogDelta({ axis: 'z', amount })}
                />
              </div>
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
                onLiveChange={(o, r, s) => {
                  setLiveOffset(o);
                  setLiveRotation(r);
                  setLiveScale(s);
                }}
                jogDelta={jogDelta()}
                onJogConsumed={() => setJogDelta(null)}
                forceOffset={forceOffset()}
                onForceOffsetConsumed={() => setForceOffset(null)}
                onSaved={() => {
                  refetch();
                  setSavedRev((n) => n + 1);
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
