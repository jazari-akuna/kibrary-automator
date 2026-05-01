import { createSignal, createEffect, For, Show, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';

/**
 * Custom dropdown that replaces native `<select>` for cases where WebKitGTK
 * refuses to honour CSS on `<option>` (the popup is rendered by GTK's combo
 * widget and respects only the OS GTK theme — so dark mode users see white
 * text on white background no matter what `option { @apply ... }` rules
 * we ship in styles.css).
 *
 * Behaviour:
 *   - Closed state: a button showing the current label and a caret.
 *   - Open state: an absolutely-positioned panel listing every option, plus
 *     an optional `extraItem` (used for the "Browse for your own…" entry on
 *     the KiCad install picker).
 *   - Outside-click / Escape closes.
 *   - ArrowUp / ArrowDown / Enter for keyboard navigation.
 *
 * Styling matches the rest of kibrary: zinc-100/zinc-900 in light mode,
 * zinc-800/zinc-100 in dark mode, with `bg-zinc-200` / `bg-zinc-700` hover.
 */
export interface DropdownOption<T> {
  value: T;
  label: string;
}

export interface DropdownProps<T> {
  value: T;
  options: DropdownOption<T>[];
  onChange: (v: T) => void;
  placeholder?: string;
  /** testid for the closed-state button (so existing smoke probes keep working). */
  testId?: string;
  /** Optional extra row at the bottom of the panel (e.g. "Browse…"). */
  extraItem?: { label: string; onSelect: () => void; testId?: string };
  /** Disable the trigger. */
  disabled?: boolean;
  /** Tailwind class overrides for the trigger button. */
  class?: string;
}

export default function Dropdown<T>(props: DropdownProps<T>) {
  const [open, setOpen] = createSignal(false);
  const [coords, setCoords] = createSignal({ top: 0, left: 0, width: 0 });
  const [highlighted, setHighlighted] = createSignal(0);
  let triggerRef: HTMLButtonElement | undefined;
  let panelRef: HTMLDivElement | undefined;

  const recomputeCoords = () => {
    if (!triggerRef) return;
    const r = triggerRef.getBoundingClientRect();
    setCoords({ top: r.bottom + 4, left: r.left, width: r.width });
  };

  const currentLabel = () => {
    const m = props.options.find((o) => o.value === props.value);
    return m ? m.label : props.placeholder ?? '';
  };

  const totalRows = () => props.options.length + (props.extraItem ? 1 : 0);

  const onDocPointer = (e: MouseEvent) => {
    const t = e.target as Node;
    if (triggerRef && triggerRef.contains(t)) return;
    if (panelRef && panelRef.contains(t)) return;
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!open()) return;
    if (e.key === 'Escape') {
      setOpen(false);
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      setHighlighted((h) => Math.min(totalRows() - 1, h + 1));
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowUp') {
      setHighlighted((h) => Math.max(0, h - 1));
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') {
      const i = highlighted();
      if (i < props.options.length) {
        props.onChange(props.options[i].value);
        setOpen(false);
      } else if (props.extraItem) {
        props.extraItem.onSelect();
        setOpen(false);
      }
      e.preventDefault();
    }
  };

  document.addEventListener('mousedown', onDocPointer);
  document.addEventListener('keydown', onKey);
  window.addEventListener('scroll', recomputeCoords, true);
  window.addEventListener('resize', recomputeCoords);
  onCleanup(() => {
    document.removeEventListener('mousedown', onDocPointer);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('scroll', recomputeCoords, true);
    window.removeEventListener('resize', recomputeCoords);
  });

  createEffect(() => {
    if (open()) {
      recomputeCoords();
      // Highlight the currently-selected row on open.
      const idx = props.options.findIndex((o) => o.value === props.value);
      setHighlighted(idx >= 0 ? idx : 0);
    }
  });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid={props.testId}
        disabled={props.disabled}
        class={
          props.class ??
          'w-full text-left bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 ' +
            'border border-zinc-300 dark:border-zinc-700 px-2 py-1 rounded mt-1 ' +
            'flex items-center justify-between disabled:opacity-50'
        }
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => setOpen((o) => !o)}
      >
        <span class="truncate">{currentLabel()}</span>
        <span class="ml-2 text-xs opacity-70" aria-hidden="true">
          {open() ? '▲' : '▼'}
        </span>
      </button>

      <Show when={open()}>
        <Portal>
          <div
            ref={panelRef}
            role="listbox"
            data-testid={props.testId ? `${props.testId}-panel` : undefined}
            class="fixed z-50 max-h-64 overflow-auto rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-lg"
            style={{
              top: `${coords().top}px`,
              left: `${coords().left}px`,
              width: `${coords().width}px`,
            }}
          >
            <For each={props.options}>
              {(opt, i) => {
                const isSel = () => opt.value === props.value;
                const isHi = () => i() === highlighted();
                return (
                  <div
                    role="option"
                    data-testid={
                      props.testId
                        ? `${props.testId}-option-${i()}`
                        : undefined
                    }
                    aria-selected={isSel()}
                    classList={{
                      'px-2 py-1 cursor-pointer text-zinc-900 dark:text-zinc-100': true,
                      'bg-zinc-200 dark:bg-zinc-700': isHi() || isSel(),
                      'hover:bg-zinc-200 dark:hover:bg-zinc-700': true,
                    }}
                    onMouseEnter={() => setHighlighted(i())}
                    onMouseDown={(e) => {
                      // mousedown so we beat the document mousedown handler
                      // that closes on outside click.
                      e.preventDefault();
                      props.onChange(opt.value);
                      setOpen(false);
                    }}
                  >
                    {opt.label}
                  </div>
                );
              }}
            </For>
            <Show when={props.extraItem}>
              {(_) => {
                const extra = props.extraItem!;
                const i = props.options.length;
                const isHi = () => highlighted() === i;
                return (
                  <div
                    role="option"
                    data-testid={extra.testId}
                    classList={{
                      'px-2 py-1 cursor-pointer border-t border-zinc-300 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 italic': true,
                      'bg-zinc-200 dark:bg-zinc-700': isHi(),
                      'hover:bg-zinc-200 dark:hover:bg-zinc-700': true,
                    }}
                    onMouseEnter={() => setHighlighted(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      extra.onSelect();
                      setOpen(false);
                    }}
                  >
                    {extra.label}
                  </div>
                );
              }}
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  );
}
