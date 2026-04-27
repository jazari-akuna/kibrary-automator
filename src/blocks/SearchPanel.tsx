/**
 * SearchPanel — Task 32 Solid block (alpha.15: side pane + perf).
 *
 * Provides a search-as-you-type interface backed by search.raph.io.
 * Gracefully hides when no API key is configured.
 *
 * Behaviour (spec §8 + alpha.15 perf spec):
 *  - On mount: fetch api_key from OS keychain and base_url from settings;
 *    auto-focus the input and restore last query from localStorage.
 *  - Debounced (80 ms) text input calls sidecar_call('search.query', { q }).
 *    "Searching…" indicator fires synchronously on input — not after the
 *    debounce — so the input never feels dead.
 *  - Stock filter is sent as `stockFilter=lcsc|jlc|both` so the server
 *    narrows the result set; an additional client-side predicate stays
 *    as a safety net so older self-hosted servers that don't grok `both`
 *    still display the right rows.
 *  - Race control: each runSearch() bumps a monotonic requestId; stale
 *    responses are dropped. Tauri 2.x doesn't pipe AbortSignal into the
 *    Rust side, so the request still completes server-side — but we
 *    refuse to render its result.
 *  - On result arrival, prefetch the first 6 photos in one sidecar
 *    round-trip (search.prefetch_photos) so thumbnails settle ~one IPC
 *    RTT sooner than they would on per-row demand.
 *  - Side-pane: when collapsed (40px rail) renders only the toggle and a
 *    rotated label; when open renders normal contents. The toggle button
 *    keeps a stable testid (`search-pane-toggle`) regardless of state.
 */

import { createSignal, createResource, createEffect, For, Show, onMount } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
// `open` from plugin-shell opens a URL/path in the OS default app. Aliased
// to `openUrl` for readability at the call site (and to match the Tauri 1.x
// name some docs still reference).
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { enqueue } from '~/state/queue';
import { searchPaneOpen, toggleSearchPane } from '~/state/searchPane';

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
  // search.raph.io stock fields. Numbers (0 = out of stock).
  stock?: number;
  jlc_stock?: number;
  [key: string]: unknown;
}

interface SearchResponse {
  results: SearchResult[];
  error?: string;
}

// ---------------------------------------------------------------------------
// AuthedThumbnail — fetch the auth-gated photo via the sidecar proxy.
//
// Why not plain `fetch()` from the webview?  search.raph.io's CORS policy
// only allow-lists `http://localhost:3000`, so a direct browser fetch from
// a Tauri webview origin (or the Vite dev server) fails the preflight and
// the `<img>` ends up with no src — which is exactly the grey-placeholder
// bug the user reported. Routing through the Python sidecar bypasses CORS
// entirely (it's a server-side request) and keeps the embedded API key out
// of JS land. The sidecar returns a self-contained `data:` URL that drops
// straight into `<img src>` with no blob lifecycle to manage.
// ---------------------------------------------------------------------------

interface AuthedThumbnailProps {
  lcsc: string;
  alt: string;
}

interface PhotoResponse {
  data_url?: string | null;
  error?: string;
}

// Module-scoped photo cache — lives across SearchPanel mounts and across
// every result row that happens to share an LCSC.  createResource alone
// memoises within one component instance, but a fresh search query that
// returns the same LCSC will create a new resource and re-fire unless we
// dedupe at this level.  The sidecar also has its own LRU; this just
// avoids the IPC roundtrip entirely on a cache hit.
//
// We cache the in-flight Promise (not the resolved value) so two
// thumbnails for the same LCSC mounted at the same instant share a
// single sidecar call.
//
// CONTRACT: keyed on bare LCSC. Do NOT key on the search query (alpha.13's
// "thumbnails persist across queries" UX depends on bare-LCSC reuse).
const photoCache = new Map<string, Promise<PhotoResponse>>();

function fetchPhoto(lcsc: string): Promise<PhotoResponse> {
  const hit = photoCache.get(lcsc);
  if (hit) return hit;
  const p = invoke<PhotoResponse>('sidecar_call', {
    method: 'search.fetch_photo',
    params: { lcsc },
  }).catch((e) => {
    // Don't poison the cache on transient errors — let the next mount retry.
    photoCache.delete(lcsc);
    throw e;
  });
  photoCache.set(lcsc, p);
  return p;
}

/**
 * Fan out a batch photo prefetch in one sidecar call. The sidecar warms its
 * server-side LRU; the client cache fills row-by-row as <AuthedThumbnail>
 * mounts hit `fetchPhoto(lcsc)` and find the in-flight promise we created
 * here. If the sidecar doesn't implement `search.prefetch_photos`, fall
 * back to firing the per-LCSC calls in parallel — same latency floor, just
 * one IPC per photo instead of one IPC total.
 */
function prefetchPhotos(lcscs: string[]): void {
  const fresh = lcscs.filter((l) => l && !photoCache.has(l));
  if (fresh.length === 0) return;
  // Kick off the per-LCSC promises immediately so any thumbnail that mounts
  // before the batch RPC returns can dedupe via photoCache.
  for (const lcsc of fresh) {
    fetchPhoto(lcsc).catch(() => {
      /* fetchPhoto already cleared the cache entry on error */
    });
  }
  // Optionally also call the batch warmer to seed the sidecar LRU in one
  // round-trip. Best-effort — older sidecars without the method just throw
  // "method not found" which we swallow.
  invoke('sidecar_call', {
    method: 'search.prefetch_photos',
    params: { lcscs: fresh },
  }).catch(() => {
    /* old sidecar — per-LCSC calls above will still fill the cache */
  });
}

function AuthedThumbnail(props: AuthedThumbnailProps) {
  const [photo] = createResource(() => props.lcsc, fetchPhoto);

  // Failure modes the fallback distinguishes (alpha.3 user feedback: a
  // silent grey square is indistinguishable from "still loading"):
  //   • photo() undefined           — request still in flight, render nothing
  //   • photo().error truthy        — sidecar errored (e.g. server 5xx, no key)
  //                                   show a "!" so the user knows it's broken
  //                                   and the title surfaces the message
  //   • photo().data_url === null   — server returned 404 (no photo for part)
  //                                   render a quiet empty square (correct UX)
  //   • photo().data_url is string  — render the <img>
  const fallback = () => {
    const p = photo();
    if (!p) return <div class="w-full h-full" />;
    if (p.error) {
      return (
        <div
          class="w-full h-full flex items-center justify-center text-red-500 text-xs"
          title={`Photo fetch failed: ${p.error}`}
          aria-label={`Photo fetch failed: ${p.error}`}
        >
          !
        </div>
      );
    }
    return <div class="w-full h-full" />;
  };

  return (
    <Show when={photo()?.data_url} fallback={fallback()}>
      <img
        src={photo()!.data_url!}
        alt={props.alt}
        class="w-full h-full object-contain"
        loading="lazy"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
      />
    </Show>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const QUERY_STORAGE_KEY = 'kibrary.search.lastQuery';

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
  const initialQuery = (() => {
    try { return localStorage.getItem(QUERY_STORAGE_KEY) ?? ''; } catch { return ''; }
  })();
  const [query, setQuery] = createSignal(initialQuery);

  // Reactive URL for the "search.raph.io" pill: forwards the current query
  // when present (so users land on the pre-filtered web view), otherwise
  // points at the bare base URL.
  const targetUrl = () => {
    const q = query().trim();
    return q === '' ? baseUrl() : `${baseUrl()}/?q=${encodeURIComponent(q)}`;
  };
  const [results, setResults] = createSignal<SearchResult[]>([]);
  const [searchError, setSearchError] = createSignal<string | null>(null);
  const [searching, setSearching] = createSignal(false);

  // Stock filter — server-side via stockFilter=lcsc|jlc|both (alpha.15).
  // Client-side predicate stays as a defence-in-depth safety net so older
  // self-hosted servers that don't accept the param still get filtered.
  const [stockOpen, setStockOpen] = createSignal(false);
  const [requireLcsc, setRequireLcsc] = createSignal(false);
  const [requireJlc, setRequireJlc] = createSignal(false);
  const stockActive = () => requireLcsc() || requireJlc();
  const stockFilterParam = (): 'lcsc' | 'jlc' | 'both' | undefined => {
    if (requireLcsc() && requireJlc()) return 'both';
    if (requireLcsc()) return 'lcsc';
    if (requireJlc()) return 'jlc';
    return undefined;
  };
  const filteredResults = () => {
    const all = results();
    if (!stockActive()) return all;
    return all.filter((r) => {
      if (requireLcsc() && (r.stock ?? 0) <= 0) return false;
      if (requireJlc() && (r.jlc_stock ?? 0) <= 0) return false;
      return true;
    });
  };

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  // Monotonic request id — each runSearch() increments this and tags its
  // own response. Late responses with a stale id get dropped. Tauri 2.x
  // doesn't pipe AbortSignal into the Rust side so the request still runs
  // server-side; we just refuse to render its result.
  let requestSeq = 0;
  let inputRef: HTMLInputElement | undefined;

  const runSearch = async (q: string, stockFilter: string | undefined) => {
    if (!q.trim()) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    const myId = ++requestSeq;
    setSearchError(null);
    try {
      const params: Record<string, unknown> = { q };
      // Only forward stockFilter when a checkbox is on. Older sidecars
      // ignore unknown params; older self-hosted servers fall back to
      // `none` for unrecognised values, so this stays backwards-safe.
      if (stockFilter) params.stock_filter = stockFilter;
      const resp = await invoke<SearchResponse>('sidecar_call', {
        method: 'search.query',
        params,
      });
      // Race guard: if a newer request started while we were waiting,
      // drop this response on the floor.
      if (myId !== requestSeq) return;
      if (resp.error) {
        setSearchError(resp.error);
        setResults([]);
      } else {
        // Dedupe by lcsc — search.raph.io already does this, but the
        // <For> below is keyed on lcsc and would crash on duplicates.
        const seen = new Set<string>();
        const deduped = (resp.results ?? []).filter((r) => {
          if (!r?.lcsc || seen.has(r.lcsc)) return false;
          seen.add(r.lcsc);
          return true;
        });
        setResults(deduped);
        // Warm the photo cache for the first six visible rows in one
        // sidecar batch (perf spec change #5/#8).
        prefetchPhotos(deduped.slice(0, 6).map((r) => r.lcsc));
      }
    } catch (e) {
      if (myId !== requestSeq) return;
      setSearchError(String(e));
      setResults([]);
    } finally {
      if (myId === requestSeq) setSearching(false);
    }
  };

  const onInput = (value: string) => {
    setQuery(value);
    try { localStorage.setItem(QUERY_STORAGE_KEY, value); } catch { /* ignore */ }
    // Fire the "Searching…" indicator synchronously — the input feels
    // alive within ~16 ms, not after the 80 ms debounce. Empty queries
    // skip both the indicator and the request.
    if (value.trim() === '') {
      setSearching(false);
      setResults([]);
      setSearchError(null);
      // Bump the seq so any in-flight stale response gets dropped.
      ++requestSeq;
      return;
    }
    setSearching(true);
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      runSearch(value, stockFilterParam());
    }, 80);
  };

  // Re-run search when stock toggles flip — the server-side filter is
  // tied to the request, so toggling needs a fresh fetch (the safety-net
  // client filter handles older servers that ignore the param).
  createEffect(() => {
    // Track signals for reactivity.
    const sf = stockFilterParam();
    const q = query();
    if (q.trim() === '') return;
    // No debounce here — toggle is a deliberate single click, not a burst.
    runSearch(q, sf);
  });

  onMount(() => {
    // Auto-focus + restore last query (perf spec change #7). Re-running
    // search happens via the createEffect above which fires on initial
    // signal read.
    inputRef?.focus();
    if (initialQuery.trim() !== '') {
      setSearching(true);
      runSearch(initialQuery, stockFilterParam());
    }
  });

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
        {/* Collapsed rail: 40px wide vertical bar with rotated label. */}
        <Show when={!searchPaneOpen()}>
          <div class="flex flex-col items-center pt-2 pb-2">
            <button
              type="button"
              data-testid="search-pane-toggle"
              aria-label="Expand search pane"
              aria-expanded="false"
              aria-controls="search-pane-body"
              onClick={() => toggleSearchPane()}
              class="h-8 w-8 rounded-md border border-neutral-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:bg-neutral-50 dark:hover:bg-zinc-700 active:bg-neutral-100 flex items-center justify-center text-zinc-700 dark:text-zinc-200 focus-visible:ring-2 focus-visible:ring-emerald-500 focus:outline-none"
            >
              {/* chevron-left "<<" — clicks expand */}
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4" aria-hidden="true">
                <polyline points="11 17 6 12 11 7" />
                <polyline points="18 17 13 12 18 7" />
              </svg>
            </button>
            <span
              class="mt-3 text-xs text-neutral-500 dark:text-zinc-500 tracking-wide select-none"
              style={{ 'writing-mode': 'vertical-rl', transform: 'rotate(180deg)' }}
            >
              Search Parts
            </span>
          </div>
        </Show>

        {/* Open state: full panel with search + results. The container
            stays mounted across collapse/expand so query/results signals
            don't reset; we just hide the body via <Show>. */}
        <Show when={searchPaneOpen()}>
          <div id="search-pane-body" class="relative space-y-2 transition-opacity duration-150 px-1">
            <div class="flex items-center justify-between pr-10">
              <h2 class="font-semibold text-sm">Search Parts</h2>
              <a
                href={targetUrl()}
                target="_blank"
                rel="noopener noreferrer"
                onClick={async (e) => {
                  // Tauri 2 webviews don't open target="_blank" via the OS
                  // browser by default — the click is a no-op unless we route
                  // through the shell plugin's openUrl. Keep the href so right-
                  // click "Copy link" and screen-readers still see the URL.
                  e.preventDefault();
                  await openUrl(targetUrl());
                }}
                class="group inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 ring-1 ring-inset ring-zinc-200 dark:ring-zinc-700 shadow-sm hover:bg-white dark:hover:bg-zinc-700/70 hover:text-emerald-700 dark:hover:text-emerald-400 hover:ring-emerald-500/40 hover:shadow transition-all duration-150"
              >
                <span>search.raph.io</span>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="w-3 h-3 opacity-70 group-hover:opacity-100 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                  aria-hidden="true"
                >
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            </div>

            {/* Collapse toggle — pinned top-right of the open pane. */}
            <button
              type="button"
              data-testid="search-pane-toggle"
              aria-label="Collapse search pane"
              aria-expanded="true"
              aria-controls="search-pane-body"
              onClick={() => {
                // Blur input first so the on-screen IME / focus ring doesn't
                // get stranded on a hidden element after the width animates.
                inputRef?.blur();
                toggleSearchPane();
              }}
              class="absolute top-0 right-0 h-8 w-8 rounded-md border border-neutral-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:bg-neutral-50 dark:hover:bg-zinc-700 active:bg-neutral-100 flex items-center justify-center text-zinc-700 dark:text-zinc-200 focus-visible:ring-2 focus-visible:ring-emerald-500 focus:outline-none"
            >
              {/* chevron-right ">>" — clicks collapse */}
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4" aria-hidden="true">
                <polyline points="13 17 18 12 13 7" />
                <polyline points="6 17 11 12 6 7" />
              </svg>
            </button>

            {/* Search input + Stock filter */}
            <div class="flex items-stretch gap-2">
              <input
                ref={inputRef}
                type="text"
                class="flex-1 min-w-0 bg-zinc-100 dark:bg-zinc-800 px-3 py-1.5 rounded text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
                placeholder="MPN, description, LCSC…"
                value={query()}
                onInput={(e) => onInput(e.currentTarget.value)}
              />
              <div class="relative">
                <button
                  type="button"
                  data-testid="stock-btn"
                  class="px-3 py-1.5 rounded text-sm font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                  classList={{ 'ring-1 ring-emerald-500 text-emerald-700 dark:text-emerald-400': stockActive() }}
                  aria-label="Filter by in-stock"
                  title="Filter results by in-stock parts"
                  onClick={() => setStockOpen((v) => !v)}
                >
                  Stock
                </button>
                <Show when={stockOpen()}>
                  <div class="absolute right-0 top-full mt-1 z-10 w-44 bg-zinc-900 border border-zinc-700 rounded shadow-lg p-2 space-y-1">
                    <label class="flex items-center gap-2 text-xs text-zinc-200 cursor-pointer">
                      <input
                        type="checkbox"
                        data-testid="stock-lcsc"
                        checked={requireLcsc()}
                        onChange={(e) => setRequireLcsc(e.currentTarget.checked)}
                      />
                      <span>LCSC in stock</span>
                    </label>
                    <label class="flex items-center gap-2 text-xs text-zinc-200 cursor-pointer">
                      <input
                        type="checkbox"
                        data-testid="stock-jlc"
                        checked={requireJlc()}
                        onChange={(e) => setRequireJlc(e.currentTarget.checked)}
                      />
                      <span>JLC in stock</span>
                    </label>
                  </div>
                </Show>
              </div>
            </div>

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

            {/* All results were filtered out by Stock toggles — surface that
                instead of showing an empty list, otherwise the user thinks
                their query had no matches. */}
            <Show when={!searching() && !searchError() && results().length > 0 && filteredResults().length === 0}>
              <p class="text-xs text-zinc-400 dark:text-zinc-500 italic">
                All {results().length} matches filtered out by Stock — toggle off to see them.
              </p>
            </Show>

            {/* Result cards — scrollable list, ~6 cards visible.
                Use keyed <For> on lcsc so a Stock toggle that re-narrows the
                array doesn't unmount/remount rows whose lcsc still appears
                (perf spec change #4 — preserves <AuthedThumbnail> instances
                so the photo resource isn't recreated). */}
            <Show when={filteredResults().length > 0}>
              <ul
                class="space-y-1.5 overflow-y-auto"
                style={{ 'max-height': '480px' }}
              >
                <For each={filteredResults()}>
                  {(result) => (
                    <li class="flex items-center gap-3 bg-zinc-100 dark:bg-zinc-800 rounded px-3 py-2 min-h-[80px]">
                      {/* Thumbnail */}
                      <div class="flex-shrink-0 w-14 h-14 bg-zinc-200 dark:bg-zinc-700 rounded overflow-hidden flex items-center justify-center">
                        <AuthedThumbnail lcsc={result.lcsc} alt={result.lcsc} />
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
    </Show>
  );
}
