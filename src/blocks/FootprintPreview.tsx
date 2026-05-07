import { createMemo, createResource, onCleanup, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { currentWorkspace } from '~/state/workspace';
import { pushToast } from '~/state/toasts';
// 26.5.7-alpha.4 reveal-in-explorer:
import OpenInExplorerButton from '~/blocks/OpenInExplorerButton';
import { TAURI_EVENT_NAMES } from '~/utils/eventNames';

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

interface EditorOpenResult {
  pid: number;
  needs_manual_navigation?: boolean;
  file_hint?: string;
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
  const unlisten = listen<{ path: string; lcsc: string }>(TAURI_EVENT_NAMES.stagingChanged, (e) => {
    if (e.payload.lcsc === matchKey()) refetch();
  });
  onCleanup(() => { unlisten.then((fn) => fn()); });

  const svgDataUrl = () => {
    const svg = svgRes()?.svg;
    if (!svg) return '';
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  };

  // 26.5.7-alpha.5 reveal-in-explorer:
  // The .kicad_mod filename can DIFFER from the symbol's component_name
  // — JLC2KiCadLib (and SnapEDA imports) name the symbol after the MPN
  // but write the footprint file under the package / land-pattern name
  // recorded in the symbol's `Footprint` property. Computing the path
  // as `<lib>.pretty/<componentName>.kicad_mod` produced ENOENT for
  // those components (user-reported on Connector_KSL: symbol
  // "10164227-1001A1RLF" ↔ file "CONN-SMD_100P-P0.40_10164227-1001A1RLF.kicad_mod").
  //
  // The sidecar already resolves this correctly via lib_scanner._find_footprint
  // (honours the symbol's Footprint property, falls back to stem match,
  // then to internal-header scan). We surface that resolution by
  // calling `library.get_component`, which returns `footprint_path` as
  // an absolute string. For staging mode the JLC2KiCadLib layout puts
  // a single .kicad_mod under a per-LCSC `.pretty/` subdir — the
  // previous code missed that subdir entirely.
  const [resolvedFpPath] = createResource(
    () => (isLibraryMode() && props.libDir && props.componentName
      ? `lib:${props.libDir}:${props.componentName}`
      : null),
    async (key) => {
      if (!key) return null;
      const sep = key.indexOf(':', 4);
      const dir = key.slice(4, sep);
      const name = key.slice(sep + 1);
      try {
        const r = await invoke<{ footprint_path: string | null }>('sidecar_call', {
          method: 'library.get_component',
          params: { lib_dir: dir, component_name: name },
        });
        return r.footprint_path ?? null;
      } catch {
        return null;
      }
    },
  );

  const revealPath = () => {
    if (isLibraryMode()) {
      // Wait for the sidecar resolution; null until it lands. The
      // OpenInExplorerButton renders disabled while null, which is
      // the right UX (no spurious wrong-path invokes).
      return resolvedFpPath() ?? null;
    }
    if (props.stagingDir && props.lcsc) {
      // Staging layout (matches sidecar files._resolve_kicad_mod):
      // <staging>/<lcsc>/<lcsc>.pretty/<lcsc>.kicad_mod (JLC2KiCadLib
      // names the staged file after the LCSC, but it lives inside a
      // per-part .pretty/ subdir — the previous string omitted the
      // subdir, so the path resolved to a non-existent location).
      return `${props.stagingDir}/${props.lcsc}/${props.lcsc}.pretty/${props.lcsc}.kicad_mod`;
    }
    return null;
  };

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-zinc-300">Footprint Preview</span>
        <div class="flex items-center gap-2">
        {/* 26.5.7-alpha.4 reveal-in-explorer: */}
        <OpenInExplorerButton
          path={revealPath()}
          testid="reveal-footprint-in-explorer"
        />
        <button
          data-testid="edit-footprint-in-kicad"
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
            invoke<EditorOpenResult>('sidecar_call', { method: 'editor.open', params })
              .then((r) => {
                const filename = r.file_hint
                  ? r.file_hint.split('/').pop() ?? r.file_hint
                  : '';
                pushToast({
                  kind: 'success',
                  message: filename
                    ? `Opened footprint editor in KiCad — ${filename} loaded`
                    : `Opened footprint editor in KiCad (pid ${r.pid})`,
                });
              })
              .catch((e: unknown) => {
                const reason = e instanceof Error ? e.message : String(e);
                console.error('[editor] open footprint failed:', e);
                pushToast({ kind: 'error', message: `Open footprint failed: ${reason}` });
              });
          }}
        >
          ✎ Edit in KiCad
        </button>
        </div>
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
