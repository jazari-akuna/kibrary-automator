/**
 * DropZoneOverlay — listens to the Tauri webview's drag-drop events and
 * routes any dropped files through the sidecar `drop.scan_paths` method
 * into `droppedGroups`. While a drag is in flight, paints a translucent
 * full-window overlay so the user sees a drop target.
 *
 * Mounted unconditionally in Shell — the overlay is invisible until a
 * drag enters the window. After a drop completes, navigates to the Add
 * room so the user immediately sees the new rows in DropImportList.
 *
 * Tauri 2's `getCurrentWebview().onDragDropEvent` delivers OS-level paths
 * (absolute) without needing the `tauri-plugin-fs` capability — the paths
 * are passed straight through to the Python sidecar, which already has
 * full FS access.
 */

import { createSignal, onMount, onCleanup, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { applyScanResult, type ScanResult } from '~/state/dropImport';
import { setRoom } from '~/state/room';
import { currentWorkspace } from '~/state/workspace';

export default function DropZoneOverlay() {
  const [hovering, setHovering] = createSignal(false);
  const [scanning, setScanning] = createSignal(false);
  const [lastError, setLastError] = createSignal('');
  const [lastUnmatched, setLastUnmatched] = createSignal<string[]>([]);

  let unlisten: (() => void) | undefined;

  onMount(async () => {
    try {
      unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
        const p = event.payload;
        if (p.type === 'over') {
          setHovering(true);
        } else if (p.type === 'leave') {
          setHovering(false);
        } else if (p.type === 'drop') {
          setHovering(false);
          await handleDrop(p.paths);
        }
      });
    } catch (e) {
      // running in a non-Tauri context (e.g. vite dev server preview) —
      // overlay simply stays inert
      console.warn('[DropZoneOverlay] Tauri drag-drop wiring failed:', e);
    }
  });

  onCleanup(() => {
    unlisten?.();
  });

  const handleDrop = async (paths: string[]) => {
    if (paths.length === 0) return;
    if (!currentWorkspace()) {
      setLastError('Open a workspace before dropping files');
      return;
    }
    setScanning(true);
    setLastError('');
    try {
      const result = await invoke<ScanResult>('sidecar_call', {
        method: 'drop.scan_paths',
        params: { paths },
      });
      const hasContent = result.folders.length > 0 || result.loose_files.length > 0;
      if (hasContent) {
        applyScanResult(result);
        setRoom('add');
      }
      setLastUnmatched(result.unmatched);
      if (!hasContent && result.unmatched.length > 0) {
        setLastError(`No KiCad files found in ${result.unmatched.length} dropped item(s)`);
      }
    } catch (e) {
      setLastError(`Drop failed: ${String(e)}`);
    } finally {
      setScanning(false);
    }
  };

  return (
    <>
      <Show when={hovering() || scanning()}>
        <div
          class="fixed inset-0 z-[100] pointer-events-none flex items-center justify-center bg-emerald-500/20 border-4 border-dashed border-emerald-400"
          data-testid="drop-zone-overlay"
        >
          <div class="bg-zinc-900/90 px-6 py-4 rounded-lg shadow-xl text-emerald-200 font-mono text-sm">
            <Show when={scanning()} fallback={<span>Drop KiCad files / folders to import</span>}>
              <span>Scanning dropped files…</span>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={lastError()}>
        <div class="fixed bottom-4 right-4 z-[110] bg-red-900/90 text-red-100 px-3 py-2 rounded shadow-lg text-xs max-w-sm">
          {lastError()}
          <button
            class="ml-2 text-red-300 hover:text-red-100"
            onClick={() => setLastError('')}
            aria-label="Dismiss"
          >×</button>
        </div>
      </Show>

      <Show when={lastUnmatched().length > 0 && !lastError()}>
        <div class="fixed bottom-4 right-4 z-[110] bg-amber-900/90 text-amber-100 px-3 py-2 rounded shadow-lg text-xs max-w-sm">
          Skipped {lastUnmatched().length} unrecognised file(s)
          <button
            class="ml-2 text-amber-300 hover:text-amber-100"
            onClick={() => setLastUnmatched([])}
            aria-label="Dismiss"
          >×</button>
        </div>
      </Show>
    </>
  );
}
