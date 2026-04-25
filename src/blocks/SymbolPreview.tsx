import { createResource, onCleanup, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { currentWorkspace } from '~/state/workspace';

interface Props {
  stagingDir: string;
  lcsc: string;
}

interface ReadFileResult {
  content: string;
}

export default function SymbolPreview(props: Props) {
  const [file, { refetch }] = createResource<ReadFileResult>(() =>
    invoke<ReadFileResult>('sidecar_call', {
      method: 'parts.read_file',
      params: { staging_dir: props.stagingDir, lcsc: props.lcsc, kind: 'sym' },
    })
  );

  // Refetch when KiCad's external editor saves changes to our file.
  const symPath = () => `${props.stagingDir}/${props.lcsc}/${props.lcsc}.kicad_sym`;
  const unlisten = listen<{ path: string; lcsc: string }>('staging.changed', (e) => {
    if (e.payload.path === symPath() || e.payload.lcsc === props.lcsc) refetch();
  });
  onCleanup(() => { unlisten.then((fn) => fn()); });

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-zinc-300">Symbol Preview</span>
        <button
          class="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300"
          onClick={() => {
            const ws = currentWorkspace();
            invoke('sidecar_call', {
              method: 'editor.open',
              params: {
                workspace: ws?.root,
                staging_dir: props.stagingDir,
                lcsc: props.lcsc,
                kind: 'symbol',
              },
            }).catch((e) => console.error('[editor] open symbol failed:', e));
          }}
        >
          ✎ Edit in KiCad
        </button>
      </div>

      <Show
        when={!file.loading}
        fallback={
          <div class="flex items-center justify-center h-48 rounded bg-zinc-800 text-sm text-zinc-400">
            Loading…
          </div>
        }
      >
        <Show
          when={!file.error && file()?.content}
          fallback={
            <div class="flex items-center justify-center h-48 rounded bg-zinc-800 text-sm text-zinc-500">
              Preview unavailable
            </div>
          }
        >
          <div class="rounded overflow-hidden" style={{ height: '320px' }}>
            <kicanvas-embed controls="basic" style={{ width: '100%', height: '100%' }}>
              <kicanvas-source>{file()!.content}</kicanvas-source>
            </kicanvas-embed>
          </div>
        </Show>
      </Show>
    </div>
  );
}
