import { createSignal, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { enqueue } from '~/state/queue';

interface ParseRow {
  lcsc: string;
  qty: number;
  ok: boolean;
  error: string | null;
}

interface ParseResult {
  rows: ParseRow[];
  format: 'bom' | 'list';
}

export default function Import() {
  const [text, setText] = createSignal('');
  const [parsed, setParsed] = createSignal<ParseResult | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  const onDetect = async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await invoke<ParseResult>('sidecar_call', {
        method: 'parts.parse_input',
        params: { text: text() },
      });
      setParsed(r);
    } catch (e) {
      setErr(String(e));
      setParsed(null);
    } finally {
      setLoading(false);
    }
  };

  const onQueue = () => {
    const p = parsed();
    if (!p) return;
    const ok = p.rows.filter((r) => r.ok);
    enqueue(ok.map((r) => ({ lcsc: r.lcsc, qty: r.qty })));
    setText('');
    setParsed(null);
  };

  return (
    <div class="space-y-2">
      <textarea
        class="w-full h-32 bg-zinc-100 dark:bg-zinc-800 p-2 rounded font-mono text-sm resize-y"
        placeholder={'C1525, 2\nC25804, 5'}
        value={text()}
        onInput={(e) => {
          setText(e.currentTarget.value);
          setParsed(null);
          setErr(null);
        }}
      />
      <div class="flex items-center gap-2 flex-wrap">
        <button
          class="px-3 py-1 bg-zinc-200 dark:bg-zinc-700 rounded text-sm hover:bg-zinc-300 dark:hover:bg-zinc-600 disabled:opacity-50"
          onClick={onDetect}
          disabled={loading() || text().trim() === ''}
        >
          {loading() ? 'Detecting…' : 'Detect'}
        </button>
        <Show when={parsed()}>
          {(p) => (
            <>
              <span class="text-sm text-zinc-600 dark:text-zinc-400">
                {p().format === 'bom' ? 'BOM' : 'List'} —{' '}
                {p().rows.filter((r) => r.ok).length} valid /{' '}
                {p().rows.filter((r) => !r.ok).length} invalid
              </span>
              <Show when={p().rows.some((r) => r.ok)}>
                <button
                  class="px-3 py-1 bg-emerald-600 rounded text-sm hover:bg-emerald-500"
                  onClick={onQueue}
                >
                  Queue all →
                </button>
              </Show>
            </>
          )}
        </Show>
        <Show when={err()}>
          <span class="text-sm text-red-400">{err()}</span>
        </Show>
      </div>
    </div>
  );
}
