import { createSignal, createMemo, For, Show, onCleanup } from 'solid-js';

export interface LibPickerProps {
  /** Current text in the input — also the chosen library name. */
  value: string;
  /** All existing library names in the workspace. */
  existing: string[];
  /** Suggested new library name (category-derived, e.g. `Resistors_KSL`). */
  suggested: string;
  /** Existing names the sidecar pre-matched as similar to `suggested`. */
  matches: string[];
  /** Disable input + popover (e.g. while a save is in flight). */
  disabled?: boolean;
  /** Called when the user picks an option or types into the input. */
  onChange: (value: string) => void;
}

/**
 * Searchable library picker — a text input that opens a popover listing:
 *
 *   1. Existing libraries the sidecar pre-matched (badge "exists").
 *   2. The category-derived suggested new library name (badge "new")
 *      — unless it already exists, in which case it appears in #1.
 *   3. Every other existing library (filtered by the typed text).
 *
 * Free-text typing creates a new library name on save. Clicking a row
 * fills the input. The popover closes on outside click or Escape.
 *
 * Replaces a native `<select>` for three reasons that bit alpha.11:
 *   - <option> can't be styled (light grey on white in dark theme)
 *   - The previous picker only showed 2 options (suggested + "Create new")
 *     and never listed existing libraries
 *   - No filter — unusable past ~10 libs
 */
export default function LibPicker(props: LibPickerProps) {
  const [open, setOpen] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  const onDocClick = (e: MouseEvent) => {
    if (!containerRef) return;
    if (!containerRef.contains(e.target as Node)) setOpen(false);
  };
  document.addEventListener('mousedown', onDocClick);
  onCleanup(() => document.removeEventListener('mousedown', onDocClick));

  const filtered = createMemo(() => {
    const q = props.value.trim().toLowerCase();
    const seen = new Set<string>();
    const items: Array<{ name: string; kind: 'match' | 'existing' | 'new' }> = [];

    // Always show the suggested-new at the top so the user can accept it
    // with one click — but only if it isn't already in `matches`.
    const suggestedExists = props.existing.includes(props.suggested);
    if (props.suggested && !suggestedExists && (!q || props.suggested.toLowerCase().includes(q))) {
      items.push({ name: props.suggested, kind: 'new' });
      seen.add(props.suggested);
    }

    // Pre-matched existing libs (sidecar already ranked these).
    for (const m of props.matches) {
      if (seen.has(m)) continue;
      if (q && !m.toLowerCase().includes(q)) continue;
      items.push({ name: m, kind: 'match' });
      seen.add(m);
    }

    // Remaining existing libs that match the query.
    for (const e of props.existing) {
      if (seen.has(e)) continue;
      if (q && !e.toLowerCase().includes(q)) continue;
      items.push({ name: e, kind: suggestedExists && e === props.suggested ? 'match' : 'existing' });
      seen.add(e);
    }
    return items;
  });

  const pick = (name: string) => {
    props.onChange(name);
    setOpen(false);
  };

  return (
    <div ref={containerRef} class="relative w-56">
      <input
        type="text"
        class="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-sm font-mono text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
        value={props.value}
        disabled={props.disabled}
        placeholder="search or type new…"
        onFocus={() => setOpen(true)}
        onInput={(e) => {
          props.onChange(e.currentTarget.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      />

      <Show when={open() && !props.disabled}>
        <div class="absolute z-20 left-0 right-0 mt-1 max-h-64 overflow-y-auto bg-zinc-900 border border-zinc-700 rounded shadow-lg">
          <Show
            when={filtered().length > 0}
            fallback={
              <div class="px-2 py-1.5 text-xs text-zinc-500 italic">
                No match — press Enter to create
                <span class="font-mono text-zinc-300"> {props.value || '<name>'}</span>
              </div>
            }
          >
            <For each={filtered()}>
              {(item) => (
                <button
                  type="button"
                  class="w-full text-left px-2 py-1.5 text-sm font-mono text-zinc-100 hover:bg-zinc-800 flex items-center justify-between gap-2"
                  onClick={() => pick(item.name)}
                >
                  <span class="truncate">{item.name}</span>
                  <Show when={item.kind === 'new'}>
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-sans bg-emerald-700 text-emerald-100">new</span>
                  </Show>
                  <Show when={item.kind === 'match'}>
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-sans bg-amber-700 text-amber-100">match</span>
                  </Show>
                  <Show when={item.kind === 'existing'}>
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-sans bg-zinc-700 text-zinc-300">exists</span>
                  </Show>
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
}
