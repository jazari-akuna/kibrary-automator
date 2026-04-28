import { createMemo, createResource, onCleanup, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { currentWorkspace } from '~/state/workspace';

/**
 * FootprintPreview — alpha.18: renders kicad-cli-exported SVG inside an
 * <img>. See SymbolPreview for the rationale (kicanvas-embed depended on
 * WebGL2 in webkit2gtk and rendered blank/cyan in too many environments).
 */
interface Props {
  stagingDir?: string;
  lcsc?: string;
  libDir?: string;
  componentName?: string;
}

interface SvgResult {
  svg: string;
}

export default function FootprintPreview(props: Props) {
  const isLibraryMode = () => Boolean(props.libDir && props.componentName);

  const key = createMemo(() =>
    isLibraryMode()
      ? `lib:${props.libDir}:${props.componentName}`
      : `staging:${props.stagingDir}:${props.lcsc}`,
  );

  const [svgRes, { refetch }] = createResource<SvgResult, string>(
    key,
    () => {
      if (isLibraryMode()) {
        return invoke<SvgResult>('sidecar_call', {
          method: 'library.render_footprint_svg',
          params: { lib_dir: props.libDir, component_name: props.componentName },
        });
      }
      return invoke<SvgResult>('sidecar_call', {
        method: 'parts.render_footprint_svg',
        params: { staging_dir: props.stagingDir, lcsc: props.lcsc },
      });
    },
  );

  // Refetch when KiCad's external editor saves changes to anything in this part dir.
  const matchKey = () => (isLibraryMode() ? props.componentName : props.lcsc);
  const unlisten = listen<{ path: string; lcsc: string }>('staging.changed', (e) => {
    if (e.payload.lcsc === matchKey()) refetch();
  });
  onCleanup(() => { unlisten.then((fn) => fn()); });

  const svgDataUrl = () => {
    const svg = svgRes()?.svg;
    if (!svg) return '';
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  };

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-zinc-300">Footprint Preview</span>
        <button
          class="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300"
          onClick={() => {
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
                  kind: 'footprint',
                };
            invoke('sidecar_call', { method: 'editor.open', params })
              .catch((e) => console.error('[editor] open footprint failed:', e));
          }}
        >
          ✎ Edit in KiCad
        </button>
      </div>

      <Show
        when={!svgRes.loading}
        fallback={
          <div class="flex items-center justify-center h-48 rounded bg-zinc-800 text-sm text-zinc-400">
            Loading…
          </div>
        }
      >
        <Show
          when={!svgRes.error && svgRes()?.svg}
          fallback={
            <div
              data-testid="footprint-preview-fallback"
              class="flex items-center justify-center h-48 rounded bg-zinc-800 text-sm text-zinc-500"
            >
              {svgRes.error ? `Preview failed: ${String(svgRes.error)}` : 'Preview unavailable'}
            </div>
          }
        >
          <div class="rounded overflow-hidden bg-white" style={{ height: '320px' }}>
            <img
              data-testid="footprint-preview-svg"
              src={svgDataUrl()}
              alt={`Footprint ${props.componentName ?? props.lcsc}`}
              style={{ width: '100%', height: '100%', 'object-fit': 'contain' }}
            />
          </div>
        </Show>
      </Show>
    </div>
  );
}
