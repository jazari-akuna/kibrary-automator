import { createResource, createSignal, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { pushToast } from '~/state/toasts';

interface Props {
  // Staging mode (Add room) — both required
  stagingDir?: string;
  lcsc?: string;
  // Library mode (Libraries room) — both required
  libDir?: string;
  componentName?: string;
}

interface PropsResult {
  properties: Record<string, string>;
}

interface MetaResult {
  meta: Record<string, unknown>;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | { error: string };

const EDITABLE_FIELDS = [
  { key: 'Description', label: 'Description' },
  { key: 'Reference',   label: 'Reference'   },
  { key: 'Value',       label: 'Value'        },
  { key: 'Datasheet',   label: 'Datasheet'    },
  { key: 'Footprint',   label: 'Footprint'    },
] as const;

export default function PropertyEditor(props: Props) {
  const isLibraryMode = () => Boolean(props.libDir && props.componentName);
  const symPath = () => `${props.stagingDir}/${props.lcsc}/${props.lcsc}.kicad_sym`;

  const [propsData] = createResource<PropsResult>(() => {
    if (isLibraryMode()) {
      return invoke<PropsResult>('sidecar_call', {
        method: 'library.read_props',
        params: { lib_dir: props.libDir, component_name: props.componentName },
      });
    }
    return invoke<PropsResult>('sidecar_call', {
      method: 'parts.read_props',
      params: { sym_path: symPath() },
    });
  });

  const [metaData] = createResource<MetaResult>(() => {
    if (isLibraryMode()) {
      // Library mode: no per-component meta.json (the merged lib has no
      // per-symbol staging meta). Resolve immediately so the loading guard
      // releases — the meta.edits override only matters for staging.
      return Promise.resolve({ meta: {} } as MetaResult);
    }
    return invoke<MetaResult>('sidecar_call', {
      method: 'parts.read_meta',
      params: { staging_dir: props.stagingDir, lcsc: props.lcsc },
    });
  });

  // Local edits on top of fetched properties
  const [edits, setEdits] = createSignal<Record<string, string>>({});
  const [saveStatus, setSaveStatus] = createSignal<SaveStatus>('idle');
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const currentValue = (key: string): string => {
    const localEdits = edits();
    if (key in localEdits) return localEdits[key];
    return propsData()?.properties?.[key] ?? '';
  };

  const scheduleAutosave = () => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      debounceTimer = undefined;
      const changed = edits();
      if (Object.keys(changed).length === 0) return;
      setSaveStatus('saving');
      try {
        if (isLibraryMode()) {
          await invoke('sidecar_call', {
            method: 'library.write_props',
            params: {
              lib_dir: props.libDir,
              component_name: props.componentName,
              edits: changed,
            },
          });
        } else {
          await invoke('sidecar_call', {
            method: 'parts.write_props',
            params: { sym_path: symPath(), edits: changed },
          });
          await invoke('sidecar_call', {
            method: 'parts.write_meta',
            params: {
              staging_dir: props.stagingDir,
              lcsc: props.lcsc,
              meta: { edits: changed },
            },
          });
        }
        setSaveStatus('saved');
        // Clear "Saved ✓" indicator after 2 s
        setTimeout(() => setSaveStatus('idle'), 2000);
      } catch (e) {
        setSaveStatus({ error: String(e) });
      }
    }, 400);
  };

  const handleInput = (key: string, value: string) => {
    setEdits((prev) => ({ ...prev, [key]: value }));
    scheduleAutosave();
  };

  return (
    <Show
      when={!propsData.loading && !metaData.loading}
      fallback={<p class="text-sm text-zinc-600 dark:text-zinc-400">Loading properties…</p>}
    >
      <div class="space-y-4 max-w-xl">
        <div class="flex items-center justify-between">
          <h2 class="text-base font-medium text-zinc-700 dark:text-zinc-200">{props.componentName ?? props.lcsc}</h2>
          <span class="text-xs text-zinc-600 dark:text-zinc-400">
            {saveStatus() === 'saving' && 'Saving…'}
            {saveStatus() === 'saved' && 'Saved ✓'}
            {typeof saveStatus() === 'object' &&
              `Save failed: ${(saveStatus() as { error: string }).error}`}
          </span>
        </div>

        {EDITABLE_FIELDS.map(({ key, label }) => (
          <label class="block">
            <span class="text-sm text-zinc-600 dark:text-zinc-400">{label}</span>
            <Show
              when={key === 'Datasheet'}
              fallback={
                <input
                  type="text"
                  value={currentValue(key)}
                  onInput={(e) => handleInput(key, e.currentTarget.value)}
                  class="block w-full bg-zinc-100 dark:bg-zinc-800 px-2 py-1 rounded mt-1 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
                />
              }
            >
              {/* Datasheet field: input + Open-in-browser button (only
                  enabled for http(s):// URLs to avoid opening file://
                  paths or arbitrary scheme handlers). */}
              <div class="flex items-center gap-2 mt-1">
                <input
                  type="url"
                  value={currentValue(key)}
                  onInput={(e) => handleInput(key, e.currentTarget.value)}
                  class="block w-full bg-zinc-100 dark:bg-zinc-800 px-2 py-1 rounded text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500"
                />
                <button
                  type="button"
                  data-testid="open-datasheet"
                  disabled={!/^https?:\/\//i.test(currentValue('Datasheet').trim())}
                  title={
                    /^https?:\/\//i.test(currentValue('Datasheet').trim())
                      ? `Open ${currentValue('Datasheet').trim()} in your default browser`
                      : 'Set a https://… URL to enable'
                  }
                  onClick={() => {
                    const url = currentValue('Datasheet').trim();
                    if (!/^https?:\/\//i.test(url)) return;
                    openUrl(url).catch((e: unknown) => {
                      const reason = e instanceof Error ? e.message : String(e);
                      pushToast({
                        kind: 'error',
                        message: `Open datasheet failed: ${reason}`,
                      });
                    });
                  }}
                  class="shrink-0 text-xs px-2 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Open ↗
                </button>
              </div>
            </Show>
          </label>
        ))}
      </div>
    </Show>
  );
}
