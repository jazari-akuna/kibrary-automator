/**
 * ComponentDetail — right pane of the Libraries room.
 *
 * Composes PropertyEditor + SymbolPreview + FootprintPreview + Model3DPreview
 * for the selected component in the selected library.
 *
 * The P1 preview blocks expect (stagingDir, lcsc) props, so we derive a
 * virtual stagingDir from the library directory and use the component name
 * as the lcsc key. This means the blocks will attempt to read files at
 * <lib_dir>/<component_name>/<component_name>.kicad_sym etc., which matches
 * the per-component layout inside committed KSL libraries.
 *
 * PropertyEditor uses parts.read_props / parts.write_props which expect a
 * sym_path; it constructs that as `${stagingDir}/${lcsc}/${lcsc}.kicad_sym`.
 * For committed library components the sym is at <lib_dir>/<component>/<component>.kicad_sym
 * — that maps correctly when stagingDir = lib_dir.
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
  const [detail] = createResource<ComponentDetailResult | null, string | null>(
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
      <div class="px-3 py-2 border-b border-zinc-700 flex-shrink-0">
        <Show
          when={comp()}
          fallback={<span class="text-sm font-medium text-zinc-300">Detail</span>}
        >
          <span class="text-sm font-medium text-zinc-300">{comp()}</span>
        </Show>
      </div>

      {/* No workspace */}
      <Show when={!currentWorkspace()}>
        <div class="flex-1 flex items-center justify-center px-3">
          <span class="text-xs text-zinc-500">Open a workspace first</span>
        </div>
      </Show>

      {/* No selection */}
      <Show when={currentWorkspace() && !comp()}>
        <div class="flex-1 flex items-center justify-center px-3">
          <span class="text-xs text-zinc-500">Select a component</span>
        </div>
      </Show>

      {/* Detail panes */}
      <Show when={currentWorkspace() && comp() && libDir()}>
        <div class="flex-1 overflow-y-auto px-3 py-3 space-y-6">
          {/* Symbol Preview */}
          <SymbolPreview
            stagingDir={libDir()!}
            lcsc={comp()!}
          />

          {/* Footprint Preview */}
          <FootprintPreview
            stagingDir={libDir()!}
            lcsc={comp()!}
          />

          {/* 3D Model Preview */}
          <Model3DPreview
            stagingDir={libDir()!}
            lcsc={comp()!}
          />

          {/* Property Editor */}
          <div class="border-t border-zinc-700 pt-4">
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
