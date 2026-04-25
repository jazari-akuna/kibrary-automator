import { createResource, createSignal, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

interface Props {
  stagingDir: string;
  lcsc: string;
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
  const symPath = () => `${props.stagingDir}/${props.lcsc}/${props.lcsc}.kicad_sym`;

  const [propsData] = createResource<PropsResult>(() =>
    invoke<PropsResult>('sidecar_call', {
      method: 'parts.read_props',
      params: { sym_path: symPath() },
    })
  );

  const [metaData] = createResource<MetaResult>(() =>
    invoke<MetaResult>('sidecar_call', {
      method: 'parts.read_meta',
      params: { staging_dir: props.stagingDir, lcsc: props.lcsc },
    })
  );

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
      fallback={<p class="text-sm text-zinc-400">Loading properties…</p>}
    >
      <div class="space-y-4 max-w-xl">
        <div class="flex items-center justify-between">
          <h2 class="text-base font-medium text-zinc-200">{props.lcsc}</h2>
          <span class="text-xs text-zinc-400">
            {saveStatus() === 'saving' && 'Saving…'}
            {saveStatus() === 'saved' && 'Saved ✓'}
            {typeof saveStatus() === 'object' &&
              `Save failed: ${(saveStatus() as { error: string }).error}`}
          </span>
        </div>

        {EDITABLE_FIELDS.map(({ key, label }) => (
          <label class="block">
            <span class="text-sm text-zinc-400">{label}</span>
            <input
              type="text"
              value={currentValue(key)}
              onInput={(e) => handleInput(key, e.currentTarget.value)}
              class="block w-full bg-zinc-800 px-2 py-1 rounded mt-1 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-zinc-500"
            />
          </label>
        ))}
      </div>
    </Show>
  );
}
