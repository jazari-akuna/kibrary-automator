/**
 * SearchPanel — Task 32 Solid block.
 *
 * Provides a search-as-you-type interface backed by search.raph.io.
 * Gracefully hides when no API key is configured.
 *
 * Behaviour (spec §8):
 *  - On mount: fetch api_key from OS keychain and base_url from settings.
 *    If api_key is empty → render null.
 *  - Debounced (250 ms) text input calls sidecar_call('search.query', { q }).
 *  - Results rendered as scrollable card list with thumbnail, description, MPN,
 *    and "+ Add" button that calls enqueue().
 *  - Inline error banner on result.error; "No matches" when results empty.
 */

import { createSignal, createResource, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { enqueue } from '~/state/queue';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Settings {
  theme: string;
  search_raph_io: { enabled: boolean; base_url: string };
  concurrency: number;
}

interface SearchResult {
  lcsc: string;
  mpn: string;
  description: string;
  photo_url?: string;
  [key: string]: unknown;
}

interface SearchResponse {
  results: SearchResult[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a photo URL for an LCSC part number. */
function photoUrl(baseUrl: string, lcsc: string): string {
  return `${baseUrl}/api/parts/${lcsc}/photo`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SearchPanel() {
  // Load settings for base_url, and api_key separately from OS keychain.
  const [settingsData] = createResource<{ settings: Settings }>(() =>
    invoke<{ settings: Settings }>('sidecar_call', { method: 'settings.get', params: {} }),
  );

  const [apiKeyData] = createResource<{ value: string }>(() =>
    invoke<{ value: string }>('sidecar_call', {
      method: 'secrets.get',
      params: { name: 'search_raph_io_api_key' },
    }),
  );

  // Reactive derived values.
  const apiKey = () => apiKeyData()?.value ?? '';
  const baseUrl = () =>
    settingsData()?.settings?.search_raph_io?.base_url?.replace(/\/$/, '') ||
    'https://search.raph.io';

  // Search UI state.
  const [query, setQuery] = createSignal('');
  const [results, setResults] = createSignal<SearchResult[]>([]);
  const [searchError, setSearchError] = createSignal<string | null>(null);
  const [searching, setSearching] = createSignal(false);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const runSearch = async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const resp = await invoke<SearchResponse>('sidecar_call', {
        method: 'search.query',
        params: { q },
      });
      if (resp.error) {
        setSearchError(resp.error);
        setResults([]);
      } else {
        setResults(resp.results ?? []);
      }
    } catch (e) {
      setSearchError(String(e));
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const onInput = (value: string) => {
    setQuery(value);
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      runSearch(value);
    }, 250);
  };

  const addToQueue = (result: SearchResult) => {
    enqueue([{ lcsc: result.lcsc, qty: 1 }]);
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // While settings / keychain are still loading, render nothing to avoid flash.
  return (
    <Show when={!settingsData.loading && !apiKeyData.loading}>
      {/* If no API key is set, degrade gracefully — render nothing. */}
      <Show when={apiKey() !== ''}>
        <div class="space-y-2">
          <h2 class="font-semibold text-sm">Search Parts</h2>

          {/* Search input */}
          <input
            type="text"
            class="w-full bg-zinc-100 dark:bg-zinc-800 px-3 py-1.5 rounded text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
            placeholder="MPN, description, LCSC…"
            value={query()}
            onInput={(e) => onInput(e.currentTarget.value)}
          />

          {/* Searching indicator */}
          <Show when={searching()}>
            <p class="text-xs text-zinc-400 dark:text-zinc-500 italic">Searching…</p>
          </Show>

          {/* Error banner */}
          <Show when={searchError()}>
            <div class="px-3 py-2 bg-red-900/50 border border-red-700 rounded text-sm text-red-300">
              {searchError()}
            </div>
          </Show>

          {/* No matches */}
          <Show when={!searching() && !searchError() && query().trim() !== '' && results().length === 0}>
            <p class="text-xs text-zinc-400 dark:text-zinc-500 italic">No matches.</p>
          </Show>

          {/* Result cards — scrollable list, ~6 cards visible */}
          <Show when={results().length > 0}>
            <ul
              class="space-y-1.5 overflow-y-auto"
              style={{ 'max-height': '480px' }}
            >
              <For each={results()}>
                {(result) => (
                  <li class="flex items-center gap-3 bg-zinc-100 dark:bg-zinc-800 rounded px-3 py-2 min-h-[80px]">
                    {/* Thumbnail */}
                    <div class="flex-shrink-0 w-14 h-14 bg-zinc-200 dark:bg-zinc-700 rounded overflow-hidden flex items-center justify-center">
                      <img
                        src={result.photo_url ?? photoUrl(baseUrl(), result.lcsc)}
                        alt={result.lcsc}
                        class="w-full h-full object-contain"
                        loading="lazy"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    </div>

                    {/* Part info */}
                    <div class="flex-1 min-w-0 space-y-0.5">
                      <p class="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate" title={result.mpn}>
                        {result.mpn || result.lcsc}
                      </p>
                      <p class="text-xs text-zinc-600 dark:text-zinc-400 line-clamp-2" title={result.description}>
                        {result.description || <span class="italic text-zinc-600">No description</span>}
                      </p>
                      <p class="text-xs text-zinc-500 dark:text-zinc-600 font-mono">{result.lcsc}</p>
                    </div>

                    {/* Add button */}
                    <button
                      class="flex-shrink-0 px-2.5 py-1 bg-zinc-200 dark:bg-zinc-700 hover:bg-emerald-600 rounded text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:text-white transition-colors"
                      onClick={() => addToQueue(result)}
                    >
                      + Add
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
    </Show>
  );
}
