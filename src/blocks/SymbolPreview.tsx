import { createResource, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

interface Props {
  stagingDir: string;
  lcsc: string;
}

interface ReadFileResult {
  content: string;
}

export default function SymbolPreview(props: Props) {
  const [file] = createResource<ReadFileResult>(() =>
    invoke<ReadFileResult>('sidecar_call', {
      method: 'parts.read_file',
      params: { staging_dir: props.stagingDir, lcsc: props.lcsc, kind: 'sym' },
    })
  );

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-zinc-300">Symbol Preview</span>
        <button
          class="text-xs px-2 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-300"
          onClick={() => console.log('editor handoff — wired in T28')}
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
