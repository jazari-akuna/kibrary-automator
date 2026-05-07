/**
 * Regression spec — full dirty-flag lifecycle through a Save round-trip.
 *
 * Bug under investigation (v26.5.7-alpha.1): "After saving the app does not
 * want to close anymore."
 *
 * The hypothesis under test:
 *   The Model3DPreview dirty-tracking effect must clear the global isDirty
 *   flag after a successful save, once `info()` (the createResource) refetches
 *   and yields the new baseline.  If it doesn't — for instance because of
 *   an effect-ordering race between the seed effect, the positioner sync,
 *   and the dirty effect, OR because the value-mangling round-trip leaves
 *   live ≠ baseline by more than the per-axis epsilon — the dirty flag
 *   stays TRUE forever and every close attempt prompts the user.
 *
 * The Tauri close handler in Shell.tsx does `await confirmDiscardIfDirty()`
 * before invoking `confirm_quit`.  When isDirty is stuck true, that prompt
 * fires every time and the user has to click Discard to actually quit —
 * the visible "app does not want to close" symptom.
 *
 * Solid's `createEffect` is queued onto a microtask; tests use `flush()`
 * (a setTimeout(0)) to drain the queue between actions.
 */
import { describe, it, expect } from 'vitest';
import { createRoot, createSignal, createEffect } from 'solid-js';
import {
  computeIsDirty,
  isDirty,
  setIsDirty,
  type Triple,
} from '~/state/dirty';

// Drain Solid's effect queue.  setTimeout(0) is sufficient — it lets all
// pending microtasks (where Solid schedules its effects) execute first.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

interface Info {
  offset: Triple;
  rotation: Triple;
  scale: Triple;
}

/**
 * Build the exact reactive pipeline used in Model3DPreview.tsx +
 * Model3DPositioner.tsx so the test exercises the same graph that ships
 * in production (seed effect, dirty effect, positioner sync effect,
 * positioner onLiveChange effect).
 */
function buildPipeline(initialInfo: Info | null) {
  const [info, setInfo] = createSignal<Info | null>(initialInfo);
  const [savedRev, setSavedRev] = createSignal(0);
  const [liveOffset, setLiveOffset] = createSignal<Triple>(
    initialInfo?.offset ?? [0, 0, 0],
  );
  const [liveRotation, setLiveRotation] = createSignal<Triple>(
    initialInfo?.rotation ?? [0, 0, 0],
  );
  const [liveScale, setLiveScale] = createSignal<Triple>(
    initialInfo?.scale ?? [1, 1, 1],
  );

  // --- Positioner local buffers (Model3DPositioner.tsx lines 63–65) -------
  const [posOffset, setPosOffset] = createSignal<Triple>(
    initialInfo?.offset ?? [0, 0, 0],
  );
  const [posRotation, setPosRotation] = createSignal<Triple>(
    initialInfo?.rotation ?? [0, 0, 0],
  );
  const [posScale, setPosScale] = createSignal<Triple>(
    initialInfo?.scale ?? [1, 1, 1],
  );

  // --- Preview seed effect (Model3DPreview.tsx lines 113–120) -------------
  createEffect(() => {
    const m = info();
    if (m) {
      setLiveOffset(m.offset);
      setLiveRotation(m.rotation);
      setLiveScale(m.scale);
    }
  });

  // --- Positioner sync effect (Model3DPositioner.tsx lines 69–73) ---------
  // Mirrors props.offset/.rotation/.scale (= info().offset/...) into the
  // positioner's local buffer.  Required because the user might also be
  // editing the buffer directly (number inputs).
  createEffect(() => {
    const m = info();
    if (m) {
      setPosOffset(m.offset);
      setPosRotation(m.rotation);
      setPosScale(m.scale);
    }
  });

  // --- Positioner onLiveChange effect (Model3DPositioner.tsx lines 79–81)
  // Pushes local buffer changes back up to the parent's live signals.
  createEffect(() => {
    setLiveOffset(posOffset());
    setLiveRotation(posRotation());
    setLiveScale(posScale());
  });

  // --- Preview dirty-tracking effect (Model3DPreview.tsx lines 127–144) ---
  createEffect(() => {
    const m = info();
    savedRev();
    if (!m) {
      setIsDirty(false);
      return;
    }
    setIsDirty(
      computeIsDirty(
        liveOffset(),
        m.offset,
        liveRotation(),
        m.rotation,
        liveScale(),
        m.scale,
      ),
    );
  });

  return {
    info,
    setInfo,
    savedRev,
    setSavedRev,
    liveOffset,
    setLiveOffset,
    // The user types into a positioner input — only the positioner buffer
    // moves; the parent's live signal mirror is driven by the onLiveChange
    // effect above.
    userEditOffset: (t: Triple) => setPosOffset(t),
    userEditRotation: (t: Triple) => setPosRotation(t),
    userEditScale: (t: Triple) => setPosScale(t),
  };
}

describe('Model3DPreview dirty-flag lifecycle through Save', () => {
  it('clears isDirty after save → refetch resolves with new baseline', async () => {
    let dispose!: () => void;
    let p!: ReturnType<typeof buildPipeline>;
    createRoot((d) => {
      dispose = d;
      setIsDirty(false);
      p = buildPipeline({ offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    });

    await flush();
    expect(isDirty()).toBe(false);

    // User edits offset to (1.235, 0, 0) via the positioner input.
    p.userEditOffset([1.235, 0, 0]);
    await flush();
    expect(isDirty()).toBe(true);

    // User clicks Save.  In production: invoke succeeds → onSaved fires:
    //   refetch() (async) + setSavedRev(n+1) (sync).
    p.setSavedRev(1);
    await flush();
    // info() is still the OLD baseline (refetch hasn't resolved) — dirty
    // stays true.  This is correct behaviour for the in-flight window.
    expect(isDirty()).toBe(true);

    // Refetch resolves; resource yields new baseline.
    p.setInfo({ offset: [1.235, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    await flush();
    await flush();

    // CRITICAL: dirty MUST converge to false now that the live values
    // match the new baseline.  If this fails, every close attempt after
    // a save will surface an "unsaved changes" prompt — the user-visible
    // "app does not want to close" symptom.
    expect(isDirty()).toBe(false);
    dispose();
  });

  it('clears isDirty when the sidecar round-trip slightly mangles the value', async () => {
    // Even when the parallel agent's "save→reload value-mangling" bug is
    // present, the dirty flag should converge to false because both the
    // seed effect and the positioner sync overwrite the live + buffer
    // signals to the (mangled) returned value.
    let dispose!: () => void;
    let p!: ReturnType<typeof buildPipeline>;
    createRoot((d) => {
      dispose = d;
      setIsDirty(false);
      p = buildPipeline({ offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    });

    await flush();
    p.userEditOffset([1.235, 0, 0]);
    await flush();
    expect(isDirty()).toBe(true);

    // Sidecar returned slightly mangled value (e.g. 1.236 instead of 1.235).
    p.setSavedRev(1);
    p.setInfo({ offset: [1.236, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    await flush();
    await flush();
    expect(isDirty()).toBe(false);
    dispose();
  });

  it('clears isDirty after multiple consecutive saves', async () => {
    let dispose!: () => void;
    let p!: ReturnType<typeof buildPipeline>;
    createRoot((d) => {
      dispose = d;
      setIsDirty(false);
      p = buildPipeline({ offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    });

    await flush();

    // Save 1.
    p.userEditOffset([1, 0, 0]);
    await flush();
    expect(isDirty()).toBe(true);
    p.setSavedRev(1);
    p.setInfo({ offset: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    await flush();
    await flush();
    expect(isDirty()).toBe(false);

    // Save 2.
    p.userEditOffset([2, 0, 0]);
    await flush();
    expect(isDirty()).toBe(true);
    p.setSavedRev(2);
    p.setInfo({ offset: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    await flush();
    await flush();
    expect(isDirty()).toBe(false);

    // Save 3 — rotation only.
    p.userEditRotation([0, 0, 90]);
    await flush();
    expect(isDirty()).toBe(true);
    p.setSavedRev(3);
    p.setInfo({ offset: [2, 0, 0], rotation: [0, 0, 90], scale: [1, 1, 1] });
    await flush();
    await flush();
    expect(isDirty()).toBe(false);
    dispose();
  });

  it('clears isDirty when info() flips to null mid-refetch (sidecar error path)', async () => {
    let dispose!: () => void;
    let p!: ReturnType<typeof buildPipeline>;
    createRoot((d) => {
      dispose = d;
      setIsDirty(false);
      p = buildPipeline({ offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    });

    await flush();
    p.userEditOffset([1.5, 0, 0]);
    await flush();
    expect(isDirty()).toBe(true);

    p.setInfo(null);
    await flush();
    expect(isDirty()).toBe(false);
    dispose();
  });

  it('a savedRev bump alone does NOT spuriously flag isDirty (regression)', async () => {
    // Hardening: when the live signals already match the baseline, bumping
    // savedRev (e.g. a no-op save click) must leave isDirty at false.
    let dispose!: () => void;
    let p!: ReturnType<typeof buildPipeline>;
    createRoot((d) => {
      dispose = d;
      setIsDirty(false);
      p = buildPipeline({ offset: [1.235, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    });

    await flush();
    expect(isDirty()).toBe(false);
    p.setSavedRev(1);
    await flush();
    expect(isDirty()).toBe(false);
    dispose();
  });
});
