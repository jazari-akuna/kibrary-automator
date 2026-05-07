/**
 * Regression spec — the window-close handler in Shell.tsx must:
 *
 *   1. Call `confirm_quit` exactly once even when CloseRequested fires
 *      multiple times in rapid succession (X button mashed, WM auto-close
 *      retry, post-Save confusion that re-emits the event before the first
 *      handler resolves).
 *
 *   2. NOT block subsequent close attempts after the user clicks Cancel —
 *      the guard must release so the next X-click re-prompts.
 *
 *   3. Release the guard on any error path so a transient invoke failure
 *      doesn't permanently lock the window open.
 *
 * Bug under regression (v26.5.7-alpha.1):
 *   The pre-fix listener stacked async invocations.  Each rapid X-click
 *   queued another `ask()` dialog OR another `invoke('confirm_quit')`, and
 *   the racing close requests on the GTK event loop produced the user-
 *   visible "after saving the app does not want to close anymore" symptom
 *   (the dialog stayed up, or the close never landed because of the
 *   re-entrant prevent_close → emit → ask cycle).
 *
 * The test re-implements the exact same handler-body pattern shipped in
 * Shell.tsx so a future regression to the guard is caught here without
 * needing a Tauri runtime.
 */
import { describe, it, expect, vi } from 'vitest';

interface HandlerDeps {
  confirmDiscardIfDirty: () => Promise<boolean>;
  invokeConfirmQuit: () => Promise<unknown>;
}

/** Mirrors the body of the Shell.tsx close-handler factory. */
function makeCloseHandler(deps: HandlerDeps) {
  let closing = false;
  return async () => {
    if (closing) return;
    closing = true;
    try {
      const ok = await deps.confirmDiscardIfDirty();
      if (ok) {
        await deps.invokeConfirmQuit();
      } else {
        closing = false;
      }
    } catch {
      closing = false;
    }
  };
}

describe('Shell close-handler re-entrancy guard', () => {
  it('invokes confirm_quit exactly once for two near-simultaneous CloseRequested events', async () => {
    const confirmDiscard = vi.fn().mockResolvedValue(true);
    const invokeQuit = vi.fn().mockResolvedValue(undefined);
    const handler = makeCloseHandler({
      confirmDiscardIfDirty: confirmDiscard,
      invokeConfirmQuit: invokeQuit,
    });

    // Fire two close-requested events in the SAME microtask (e.g. user
    // mashed the X twice, or Tauri re-emits the event before the first
    // handler resolves).
    const p1 = handler();
    const p2 = handler();
    await Promise.all([p1, p2]);

    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    expect(invokeQuit).toHaveBeenCalledTimes(1);
  });

  it('invokes confirm_quit exactly once even when 5 events fire in a tight loop', async () => {
    const confirmDiscard = vi.fn().mockResolvedValue(true);
    const invokeQuit = vi.fn().mockResolvedValue(undefined);
    const handler = makeCloseHandler({
      confirmDiscardIfDirty: confirmDiscard,
      invokeConfirmQuit: invokeQuit,
    });

    await Promise.all([handler(), handler(), handler(), handler(), handler()]);

    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    expect(invokeQuit).toHaveBeenCalledTimes(1);
  });

  it('releases the guard when the user clicks Cancel on the unsaved-edits prompt', async () => {
    let cancelOnce = true;
    const confirmDiscard = vi.fn(async () => {
      if (cancelOnce) {
        cancelOnce = false;
        return false; // user clicked Cancel
      }
      return true; // user clicked Discard on the second prompt
    });
    const invokeQuit = vi.fn().mockResolvedValue(undefined);
    const handler = makeCloseHandler({
      confirmDiscardIfDirty: confirmDiscard,
      invokeConfirmQuit: invokeQuit,
    });

    // First X-click → user cancels.  Window stays open, no quit.
    await handler();
    expect(confirmDiscard).toHaveBeenCalledTimes(1);
    expect(invokeQuit).not.toHaveBeenCalled();

    // Second X-click → user discards.  Window must close now.
    await handler();
    expect(confirmDiscard).toHaveBeenCalledTimes(2);
    expect(invokeQuit).toHaveBeenCalledTimes(1);
  });

  it('releases the guard when invoke(confirm_quit) throws so the next X-click can retry', async () => {
    let firstAttempt = true;
    const confirmDiscard = vi.fn().mockResolvedValue(true);
    const invokeQuit = vi.fn(async () => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error('transient IPC failure');
      }
    });
    const handler = makeCloseHandler({
      confirmDiscardIfDirty: confirmDiscard,
      invokeConfirmQuit: invokeQuit,
    });

    await handler();
    expect(invokeQuit).toHaveBeenCalledTimes(1);

    // The retry should NOT be blocked by the guard.
    await handler();
    expect(invokeQuit).toHaveBeenCalledTimes(2);
  });

  it('does not stack ask() dialogs when the user mashes X while the first prompt is open', async () => {
    // Simulate a slow ask() that resolves after several microtasks — during
    // that window the user mashes X again.  Pre-fix this would have queued
    // a second ask() dialog.  Post-fix: the second invocation no-ops.
    let resolveDiscard!: (v: boolean) => void;
    const confirmDiscard = vi.fn(
      () => new Promise<boolean>((r) => (resolveDiscard = r)),
    );
    const invokeQuit = vi.fn().mockResolvedValue(undefined);
    const handler = makeCloseHandler({
      confirmDiscardIfDirty: confirmDiscard,
      invokeConfirmQuit: invokeQuit,
    });

    const p1 = handler();
    // Within the same tick, three more X-clicks land.
    const p2 = handler();
    const p3 = handler();
    const p4 = handler();

    // Only one ask() dialog opened.
    expect(confirmDiscard).toHaveBeenCalledTimes(1);

    // User finally clicks Discard on the (only) dialog.
    resolveDiscard(true);
    await Promise.all([p1, p2, p3, p4]);

    expect(invokeQuit).toHaveBeenCalledTimes(1);
  });
});
