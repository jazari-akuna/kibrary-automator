// 26.5.7-alpha.4 reveal-in-explorer:
//
// Reusable "Open in Explorer" button — invokes the `reveal_in_explorer`
// Tauri command, which opens the host OS's native file manager with the
// given file SELECTED (not just the parent directory open).
//
// Used by SymbolPreview / FootprintPreview / Model3DPreview to surface
// each component-file's on-disk location to the user without leaving
// kibrary. The OS-native file manager is the right tool for "I want to
// inspect / move / share this file" workflows that the in-app pickers
// don't cover.
//
// The button is a small icon-only element (matches the SymbolPreview /
// FootprintPreview "Edit in KiCad" buttons in size/weight) so it can
// sit next to those without dominating the card header.

import { createSignal, onMount, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { pushToast } from '~/state/toasts';

interface Props {
  /**
   * Absolute on-disk path to reveal. The Rust command canonicalises this
   * before spawning, so symlinks / relative-segments are normalised; a
   * path that doesn't exist returns Err and the toast surfaces it.
   */
  path: string | null | undefined;
  /**
   * Optional override — when omitted, the button shows "Open" next to
   * the file-with-arrow icon. Pass a label like "Open .kicad_sym" if
   * the surrounding context doesn't already make clear which file is
   * being revealed.
   */
  label?: string;
  /** Test hook so unit tests can find the button without a string match. */
  testid?: string;
}

/**
 * Resolve the host OS for the tooltip text. Falls back to the Linux
 * tooltip on any unrecognised platform — that's the most generic phrasing
 * ("Show in file manager"). We use `navigator.userAgent` rather than the
 * Tauri `os` plugin because:
 *   1. The plugin call is async — wiring it through createResource for a
 *      tooltip is overkill.
 *   2. `navigator.userAgent` is reliable enough: WebKitGTK identifies as
 *      Linux, WKWebView as Mac, WebView2 as Windows.
 */
function detectOSTooltip(): string {
  if (typeof navigator === 'undefined') return 'Show in file manager';
  const ua = navigator.userAgent || '';
  if (/Mac|iPhone|iPod|iPad/i.test(ua)) return 'Open in Explorer';
  if (/Windows/i.test(ua)) return 'Open in File Explorer';
  return 'Show in file manager';
}

export default function OpenInExplorerButton(props: Props) {
  const [tooltip, setTooltip] = createSignal('Show in file manager');

  onMount(() => {
    setTooltip(detectOSTooltip());
  });

  const disabled = () => !props.path;

  const handleClick = async (e: MouseEvent) => {
    e.stopPropagation();
    const p = props.path;
    if (!p) return;
    try {
      await invoke('reveal_in_explorer', { path: p });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      pushToast({ kind: 'error', message: `Open in Explorer failed: ${reason}` });
    }
  };

  return (
    <button
      data-testid={props.testid ?? 'open-in-explorer'}
      class="text-xs px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
      title={tooltip()}
      disabled={disabled()}
      onClick={handleClick}
    >
      {/* lucide-style "file-output" icon — a document with a small arrow
          pointing out. The previous "↗" Unicode glyph read as a generic
          link-arrow and didn't communicate "this is a file on disk".
          The page-with-arrow shape matches the host-OS file-manager
          metaphor users associate with reveal-in-explorer. Sized to
          match the surrounding "✎ Edit in KiCad" glyph (~14px line). */}
      <svg
        data-testid="open-in-explorer-icon"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="w-3.5 h-3.5"
        aria-hidden="true"
      >
        <path d="M4 7V4a2 2 0 0 1 2-2h9l5 5v13a2 2 0 0 1-2 2h-7" />
        <path d="M14 2v4a2 2 0 0 0 2 2h4" />
        <path d="M2 15h10" />
        <path d="m9 18 3-3-3-3" />
      </svg>
      <Show when={props.label}>{props.label}</Show>
      <Show when={!props.label}>Open</Show>
    </button>
  );
}
