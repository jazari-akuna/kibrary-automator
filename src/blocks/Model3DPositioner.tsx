/**
 * Model3DPositioner — inline 3D model offset / rotation / scale editor.
 *
 * Replaces the read-only display table inside Model3DPreview with editable
 * inputs.  Calls `library.set_3d_offset` to persist changes; the parent
 * is expected to refetch `library.get_3d_info` on success.
 *
 * Used in the Libraries room only — staging-mode footprints don't have a
 * stable lib_dir to write back into.
 */

import { createEffect, createSignal } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { pushToast } from '~/state/toasts';

type Triple = [number, number, number];

interface Props {
  libDir: string;
  componentName: string;
  /** Initial values from library.get_3d_info. */
  offset: Triple;
  rotation: Triple;
  scale: Triple;
  /** Called after a successful save so the parent can refetch the model info. */
  onSaved?: () => void;
  /** Called whenever the user mutates a buffer (typing, jog click, etc.) so the
   *  parent can feed the unsaved values into the live 3D preview without a
   *  disk write. */
  onLiveChange?: (offset: Triple, rotation: Triple, scale: Triple) => void;
  /** Pulse-shaped: when the parent jog dial fires, set this; the positioner
   *  applies it to the appropriate axis then calls onJogConsumed so the
   *  parent can clear it (preventing the same jog from re-applying on every
   *  parent re-render). */
  jogDelta?: { axis: 'x' | 'y' | 'z'; amount: number } | null;
  onJogConsumed?: () => void;
}

const ZERO: Triple = [0, 0, 0];
const ONE: Triple = [1, 1, 1];

function num(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

export default function Model3DPositioner(props: Props) {
  // Local edit buffers — initialised from props, reset by Reset, replaced
  // in-place when a Save round-trips and the parent re-mounts us with
  // new prop values.
  const [offset, setOffset] = createSignal<Triple>(props.offset);
  const [rotation, setRotation] = createSignal<Triple>(props.rotation);
  const [scale, setScale] = createSignal<Triple>(props.scale);
  const [busy, setBusy] = createSignal(false);

  // Keep local buffers in sync if the parent refetches and the props change.
  createEffect(() => {
    setOffset(props.offset);
    setRotation(props.rotation);
    setScale(props.scale);
  });

  // Live preview: any local buffer change pings the parent so the 3D
  // viewer can re-render with the unsaved values. Tracked deps are the
  // signals themselves (not the props) — running on the initial pass is
  // fine, the viewer's debounce smooths out the redundant tick.
  createEffect(() => {
    props.onLiveChange?.(offset(), rotation(), scale());
  });

  // Apply jog pulses from the parent (dial / Z column). We mutate the
  // axis in place and then ack via onJogConsumed so a stale jogDelta
  // can't re-apply on the next parent render.
  createEffect(() => {
    const j = props.jogDelta;
    if (!j) return;
    if (j.axis === 'x' || j.axis === 'y' || j.axis === 'z') {
      const idx = { x: 0, y: 1, z: 2 }[j.axis];
      const next = [...offset()] as Triple;
      next[idx] = +(next[idx] + j.amount).toFixed(3);
      setOffset(next);
    }
    props.onJogConsumed?.();
  });

  const handleReset = () => {
    setOffset(props.offset);
    setRotation(props.rotation);
    setScale(props.scale);
  };

  const handleSave = async () => {
    setBusy(true);
    try {
      await invoke('sidecar_call', {
        method: 'library.set_3d_offset',
        params: {
          lib_dir: props.libDir,
          component_name: props.componentName,
          offset: offset(),
          rotation: rotation(),
          scale: scale(),
        },
      });
      pushToast({ kind: 'success', message: '3D position saved' });
      props.onSaved?.();
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      pushToast({ kind: 'error', message: `Save failed: ${reason}` });
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    'w-20 bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded text-xs text-right ' +
    'font-mono text-zinc-900 dark:text-zinc-100 border border-zinc-300 dark:border-zinc-700 ' +
    'focus:outline-none focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-500';

  const renderRow = (
    label: string,
    unit: string,
    step: string,
    val: () => Triple,
    setVal: (v: Triple) => void,
    prefix: 'offset' | 'rotation' | 'scale',
  ) => (
    <div class="flex items-center gap-2">
      <span class="text-xs text-zinc-500 dark:text-zinc-400 w-20">{label}</span>
      <span class="text-xs text-zinc-500 dark:text-zinc-500 w-10">{unit}</span>
      {(['X', 'Y', 'Z'] as const).map((axis, i) => (
        <label class="flex items-center gap-1">
          <span class="text-xs text-zinc-400 dark:text-zinc-500">{axis}</span>
          <input
            type="number"
            step={step}
            class={inputCls}
            value={val()[i]}
            data-testid={`positioner-${prefix}-${axis.toLowerCase()}`}
            onInput={(e) => {
              const next = [...val()] as Triple;
              next[i] = num(e.currentTarget.value);
              setVal(next);
            }}
          />
        </label>
      ))}
    </div>
  );

  return (
    <div class="space-y-1.5">
      <span class="text-xs font-medium text-zinc-600 dark:text-zinc-400">3D Position</span>
      {renderRow('Offset', 'mm', '0.01', offset, (v) => setOffset(v), 'offset')}
      {renderRow('Rotation', '°', '0.1', rotation, (v) => setRotation(v), 'rotation')}
      {renderRow('Scale', '', '0.01', scale, (v) => setScale(v), 'scale')}
      <div class="flex items-center gap-2 pt-1">
        <button
          onClick={handleReset}
          disabled={busy()}
          class="text-xs px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-200 transition-colors disabled:opacity-50"
        >
          Reset
        </button>
        <button
          onClick={handleSave}
          disabled={busy()}
          class="text-xs px-2 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors disabled:opacity-50"
        >
          {busy() ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// Sensible defaults exposed for callers that need to render the panel
// without an existing model block.
export { ZERO as DEFAULT_OFFSET, ZERO as DEFAULT_ROTATION, ONE as DEFAULT_SCALE };
