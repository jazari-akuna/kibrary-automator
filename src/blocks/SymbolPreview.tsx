import { createMemo, createResource, onCleanup, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { currentWorkspace } from '~/state/workspace';

/**
 * SymbolPreview — alpha.18: renders the symbol as an SVG returned by the
 * sidecar (which shells out to ``kicad-cli sym export svg``). The previous
 * implementation embedded ``<kicanvas-embed>`` which depends on WebGL2 in
 * webkit2gtk and rendered blank/cyan in a meaningful fraction of Linux
 * Tauri environments. The kicad-cli path produces the exact same vector
 * art eeschema would display and only needs an ``<img>`` to render.
 *
 * Two calling conventions:
 *
 *   Staging mode (Add / Review rooms):
 *     <SymbolPreview stagingDir="/path/to/staging" lcsc="C25804" />
 *     → `parts.render_symbol_svg`
 *
 *   Library mode (Libraries room):
 *     <SymbolPreview libDir="/ws/Resistors_KSL" componentName="R_10k_0402" />
 *     → `library.render_symbol_svg`
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

export default function SymbolPreview(props: Props) {
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
          method: 'library.render_symbol_svg',
          params: { lib_dir: props.libDir, component_name: props.componentName },
        });
      }
      return invoke<SvgResult>('sidecar_call', {
        method: 'parts.render_symbol_svg',
        params: { staging_dir: props.stagingDir, lcsc: props.lcsc },
      });
    },
  );

  // Refetch when KiCad's external editor saves changes to our file.
  const symPath = () =>
    isLibraryMode()
      ? `${props.libDir}/${props.libDir!.split('/').pop()}.kicad_sym`
      : `${props.stagingDir}/${props.lcsc}/${props.lcsc}.kicad_sym`;
  const matchKey = () => (isLibraryMode() ? props.componentName : props.lcsc);
  const unlisten = listen<{ path: string; lcsc: string }>('staging.changed', (e) => {
    if (e.payload.path === symPath() || e.payload.lcsc === matchKey()) refetch();
  });
  onCleanup(() => { unlisten.then((fn) => fn()); });

  // Wrap the SVG in a data URL so we can use a plain <img>. This avoids
  // bringing user-supplied markup into the SolidJS reactive tree (no XSS
  // surface) and lets the browser cache repeat fetches naturally.
  const svgDataUrl = () => {
    const svg = svgRes()?.svg;
    if (!svg) return '';
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  };

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-zinc-300">Symbol Preview</span>
        <button
          class="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300"
          onClick={() => {
            const ws = currentWorkspace();
            const params = isLibraryMode()
              ? {
                  workspace: ws?.root,
                  lib_dir: props.libDir,
                  component_name: props.componentName,
                  kind: 'symbol',
                }
              : {
                  workspace: ws?.root,
                  staging_dir: props.stagingDir,
                  lcsc: props.lcsc,
                  kind: 'symbol',
                };
            invoke('sidecar_call', { method: 'editor.open', params })
              .catch((e) => console.error('[editor] open symbol failed:', e));
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
              data-testid="symbol-preview-fallback"
              class="flex items-center justify-center h-48 rounded bg-zinc-800 text-sm text-zinc-500"
            >
              {svgRes.error ? `Preview failed: ${String(svgRes.error)}` : 'Preview unavailable'}
            </div>
          }
        >
          <div class="rounded overflow-hidden bg-white" style={{ height: '320px' }}>
            <img
              data-testid="symbol-preview-svg"
              src={svgDataUrl()}
              alt={`Symbol ${props.componentName ?? props.lcsc}`}
              style={{ width: '100%', height: '100%', 'object-fit': 'contain' }}
            />
          </div>
        </Show>
      </Show>
    </div>
  );
}
