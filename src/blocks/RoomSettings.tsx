import { createResource, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

interface Settings {
  theme: string;
  search_raph_io: { enabled: boolean; base_url: string; api_key: string };
  concurrency: number;
}

export default function RoomSettings() {
  const [data, { mutate }] = createResource(() =>
    invoke<{ settings: Settings }>('sidecar_call', { method: 'settings.get', params: {} })
  );
  const save = async (s: Settings) => {
    await invoke('sidecar_call', { method: 'settings.set', params: { settings: s } });
    mutate({ settings: s });
  };
  return (
    <Show when={data()}>{(d) => {
      const s = d().settings;
      return (
        <div class="max-w-xl space-y-4">
          <h2 class="text-xl">Settings</h2>
          <label class="block">
            <span class="text-sm text-zinc-400">Concurrency</span>
            <input type="number" min="1" max="16" value={s.concurrency}
              class="block bg-zinc-800 px-2 py-1 rounded mt-1"
              onChange={(e) => save({ ...s, concurrency: +e.currentTarget.value })}/>
          </label>
          <label class="block">
            <span class="text-sm text-zinc-400">search.raph.io API key</span>
            <input type="password" value={s.search_raph_io.api_key}
              class="block bg-zinc-800 px-2 py-1 rounded mt-1 w-96"
              onChange={(e) => save({ ...s,
                search_raph_io: { ...s.search_raph_io,
                  api_key: e.currentTarget.value,
                  enabled: !!e.currentTarget.value }})}/>
          </label>
        </div>
      );
    }}</Show>
  );
}
