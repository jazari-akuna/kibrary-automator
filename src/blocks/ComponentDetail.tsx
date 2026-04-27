/**
 * ComponentDetail — right pane of the Libraries room.
 *
 * Composes PropertyEditor + SymbolPreview + FootprintPreview + Model3DPreview
 * for the selected component in the selected library.
 *
 * The preview blocks are dual-mode (staging vs library). Here we always pass
 * the library-mode props (libDir, componentName) so the blocks call
 * `library.read_file_content` / `library.get_3d_info` against the committed
 * library layout:
 *   <lib_dir>/<lib>.kicad_sym                    (merged symbol library)
 *   <lib_dir>/<lib>.pretty/<component>.kicad_mod (per-component footprint)
 *   <lib_dir>/<lib>.3dshapes/<component>.<ext>   (per-component 3D model)
 *
 * PropertyEditor still expects (stagingDir, lcsc) for now — the underlying
 * `parts.read_props` happens to work because that handler reads
 * `${stagingDir}/${lcsc}/${lcsc}.kicad_sym`, which doesn't exist in committed
 * libraries.  TODO: route PropertyEditor through a library-mode RPC too.
 */

import { createResource, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { currentWorkspace } from '~/state/workspace';
import { selectedLib, selectedComponent } from '~/state/librariesRoom';
import PropertyEditor from '~/blocks/PropertyEditor';
import SymbolPreview from '~/blocks/SymbolPreview';
import FootprintPreview from '~/blocks/FootprintPreview';
import Model3DPreview from '~/blocks/Model3DPreview';

interface ComponentDetail {
  properties: Record<string, string>;
  footprint_path: string | null;
  model3d_path: string | null;
}

interface ComponentDetailResult {
  component: ComponentDetail;
}

export default function ComponentDetail() {
  const ws = currentWorkspace;
  const lib = selectedLib;
  const comp = selectedComponent;

  // Derive the lib_dir from workspace root + selected lib name
  const libDir = () => {
    const workspace = ws();
    const libName = lib();
    if (!workspace || !libName) return null;
    return `${workspace.root}/${libName}`;
  };

  // Fetch component details when selection changes
  const [_detail] = createResource<ComponentDetailResult | null, string | null>(
    () => {
      const dir = libDir();
      const name = comp();
      if (!dir || !name) return null;
      return `${dir}::${name}`;
    },
    async (key) => {
      if (!key) return null;
      const sep = key.indexOf('::');
      const dir = key.slice(0, sep);
      const name = key.slice(sep + 2);
      return invoke<ComponentDetailResult>('sidecar_call', {
        method: 'library.get_component',
        params: { lib_dir: dir, component_name: name },
      });
    }
  );

  return (
    <div class="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div class="px-3 py-2 border-b border-zinc-300 dark:border-zinc-700 flex-shrink-0">
        <Show
          when={comp()}
          fallback={<span class="text-sm font-medium text-zinc-700 dark:text-zinc-300">Detail</span>}
        >
          <span class="text-sm font-medium text-zinc-700 dark:text-zinc-300">{comp()}</span>
        </Show>
      </div>

      {/* No workspace */}
      <Show when={!currentWorkspace()}>
        <div class="flex-1 flex items-center justify-center px-3">
          <span class="text-xs text-zinc-400 dark:text-zinc-500">Open a workspace first</span>
        </div>
      </Show>

      {/* No selection */}
      <Show when={currentWorkspace() && !comp()}>
        <div class="flex-1 flex items-center justify-center px-3">
          <span class="text-xs text-zinc-400 dark:text-zinc-500">Select a component</span>
        </div>
      </Show>

      {/* Detail panes */}
      <Show when={currentWorkspace() && comp() && libDir()}>
        <div class="flex-1 overflow-y-auto px-3 py-3 space-y-6">
          {/* Symbol Preview */}
          <SymbolPreview
            libDir={libDir()!}
            componentName={comp()!}
          />

          {/* Footprint Preview */}
          <FootprintPreview
            libDir={libDir()!}
            componentName={comp()!}
          />

          {/* 3D Model Preview (Replace + positioner are inside the block) */}
          <Model3DPreview
            libDir={libDir()!}
            componentName={comp()!}
          />

          {/* Property Editor */}
          <div class="border-t border-zinc-300 dark:border-zinc-700 pt-4">
            <PropertyEditor
              stagingDir={libDir()!}
              lcsc={comp()!}
            />
          </div>
        </div>
      </Show>
    </div>
  );
}
