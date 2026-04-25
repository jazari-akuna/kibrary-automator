import { createResource, createSignal, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { theme, setTheme, type Theme } from '~/state/theme';

interface Settings {
  theme: string;
  search_raph_io: { enabled: boolean; base_url: string };
  concurrency: number;
}

export default function RoomSettings() {
  const [data, { mutate }] = createResource(() =>
    invoke<{ settings: Settings }>('sidecar_call', { method: 'settings.get', params: {} })
  );

  // API key is stored in the OS keychain — fetched separately.
  const [apiKey, setApiKey] = createSignal('');
  createResource(() =>
    invoke<{ value: string }>('sidecar_call', { method: 'secrets.get', params: { name: 'search_raph_io_api_key' } })
      .then((r) => setApiKey(r.value ?? ''))
      .catch(() => setApiKey(''))
  );

  const save = async (s: Settings) => {
    await invoke('sidecar_call', { method: 'settings.set', params: { settings: s } });
    mutate({ settings: s });
  };

  const saveApiKey = async (value: string) => {
    setApiKey(value);
    await invoke('sidecar_call', {
      method: 'secrets.set',
      params: { name: 'search_raph_io_api_key', value },
    });
    // Keep search_raph_io.enabled in sync with whether a key is present.
    if (data()) {
      const s = data()!.settings;
      await save({ ...s, search_raph_io: { ...s.search_raph_io, enabled: !!value } });
    }
  };

  return (
    <Show when={data()}>{(d) => {
      const s = d().settings;
      return (
        <div class="max-w-xl space-y-4">
          <h2 class="text-xl">Settings</h2>
          <label class="block">
            <span class="text-sm">Theme</span>
            <select value={theme()} onChange={(e) => setTheme(e.currentTarget.value as Theme)}
              class="block bg-zinc-100 dark:bg-zinc-800 px-2 py-1 rounded mt-1">
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label class="block">
            <span class="text-sm text-zinc-600 dark:text-zinc-400">Concurrency</span>
            <input type="number" min="1" max="16" value={s.concurrency}
              class="block bg-zinc-100 dark:bg-zinc-800 px-2 py-1 rounded mt-1"
              onChange={(e) => save({ ...s, concurrency: +e.currentTarget.value })}/>
          </label>
          <label class="block">
            <span class="text-sm text-zinc-600 dark:text-zinc-400">search.raph.io API key</span>
            <input type="password" value={apiKey()}
              class="block bg-zinc-100 dark:bg-zinc-800 px-2 py-1 rounded mt-1 w-96"
              onChange={(e) => saveApiKey(e.currentTarget.value)}/>
            <span class="text-xs text-zinc-500 mt-1 block">
              Stored in OS keychain (not in plain config).
            </span>
          </label>
        </div>
      );
    }}</Show>
  );
}
