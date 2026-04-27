import { createSignal, createMemo, For, Show, onCleanup, createEffect } from 'solid-js';
import { Portal } from 'solid-js/web';

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
 *   1. Existing libraries the sidecar pre-matched (badge "match").
 *   2. The category-derived suggested new library name (badge "new")
 *      — unless it already exists, in which case it appears in #1.
 *   3. Every other existing library (filtered by the typed text).
 *
 * Free-text typing creates a new library name on save. Clicking a row
 * fills the input. The popover closes on outside click or Escape.
 *
 * The popover renders into a Portal at document.body root with fixed
 * coordinates derived from the input's bounding rect — earlier alpha.12
 * absolute-positioned it inside an ancestor with overflow-x-auto, which
 * clipped results below the visible row and forced the user to scroll.
 */
export default function LibPicker(props: LibPickerProps) {
  const [open, setOpen] = createSignal(false);
  const [coords, setCoords] = createSignal({ top: 0, left: 0, width: 0 });
  let inputRef: HTMLInputElement | undefined;
  let popoverRef: HTMLDivElement | undefined;

  const recomputeCoords = () => {
    if (!inputRef) return;
    const r = inputRef.getBoundingClientRect();
    setCoords({ top: r.bottom + 4, left: r.left, width: r.width });
  };

  const onDocClick = (e: MouseEvent) => {
    const t = e.target as Node;
    if (inputRef && inputRef.contains(t)) return;
    if (popoverRef && popoverRef.contains(t)) return;
    setOpen(false);
  };
  document.addEventListener('mousedown', onDocClick);
  // Reposition on scroll/resize so the popover tracks the input.
  window.addEventListener('scroll', recomputeCoords, true);
  window.addEventListener('resize', recomputeCoords);
  onCleanup(() => {
    document.removeEventListener('mousedown', onDocClick);
    window.removeEventListener('scroll', recomputeCoords, true);
    window.removeEventListener('resize', recomputeCoords);
  });

  // Recompute coords whenever the popover opens (the input's position may
  // have shifted between opens — table grew, sidebar toggled, etc).
  createEffect(() => {
    if (open()) recomputeCoords();
  });

  const filtered = createMemo(() => {
    const q = props.value.trim().toLowerCase();
    const seen = new Set<string>();
    const items: Array<{ name: string; kind: 'match' | 'existing' | 'new' }> = [];

    const suggestedExists = props.existing.includes(props.suggested);
    if (props.suggested && !suggestedExists && (!q || props.suggested.toLowerCase().includes(q))) {
      items.push({ name: props.suggested, kind: 'new' });
      seen.add(props.suggested);
    }
    for (const m of props.matches) {
      if (seen.has(m)) continue;
      if (q && !m.toLowerCase().includes(q)) continue;
      items.push({ name: m, kind: 'match' });
      seen.add(m);
    }
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
    inputRef?.focus();
  };

  // Cap the popover at half the viewport so it never extends below the
  // window even when the user clicks a row near the bottom of a long table.
  const popoverStyle = () => {
    const c = coords();
    const maxHeight = Math.max(160, Math.floor(window.innerHeight / 2));
    return {
      position: 'fixed' as const,
      top: `${c.top}px`,
      left: `${c.left}px`,
      width: `${c.width}px`,
      'max-height': `${maxHeight}px`,
      'z-index': 50,
    };
  };

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        class="w-56 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-sm font-mono text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
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
        <Portal>
          <div
            ref={popoverRef}
            class="overflow-y-auto bg-zinc-900 border border-zinc-700 rounded shadow-lg"
            style={popoverStyle()}
          >
            <Show
              when={filtered().length > 0}
              fallback={
                <div class="px-2 py-1.5 text-xs text-zinc-500 italic">
                  No match — keep typing to create
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
        </Portal>
      </Show>
    </>
  );
}
