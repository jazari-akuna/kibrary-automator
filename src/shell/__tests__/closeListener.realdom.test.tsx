// @vitest-environment jsdom
/**
 * REAL-DOM regression spec — Shell mounts and registers its window-close
 * listener, AND the registered event name is one that Tauri 2's runtime
 * validator will accept.
 *
 * Bug under regression — "App won't close after Save" v26.5.7-alpha.1
 * → alpha.4:
 *
 *   Shell.tsx had `await listen('app.close-requested', …)` inside an
 *   onMount async block. Tauri 2's event-name validator rejects any name
 *   containing characters outside `[A-Za-z0-9-/:_]` with the runtime error:
 *
 *     "Event name must include only alphanumeric characters, `-`, `/`,
 *      `:` and `_`."
 *
 *   The dotted name failed validation → the underlying `plugin:event|listen`
 *   invoke rejected → the Promise from `listen()` rejected → the catch in
 *   onMount logged a warn and the listener was never installed.  The
 *   close-handler chain was DEAD CODE.  All four prior alpha attempts
 *   patched code that ran on a listener that didn't exist, which is why
 *   their (synthetic) tests passed but the real binary stayed broken.
 *
 *   This test is the empirical-runtime mirror of `eventNameValidity.test.ts`:
 *   it actually mounts Shell, captures the listen() call, and applies the
 *   same regex Tauri 2 uses internally to validate event names.  If anyone
 *   re-introduces a dotted name (or any other rejected character), this
 *   test fails — driving the listener registration path, not greppped
 *   source.
 *
 *   We mock the @tauri-apps/api/event module (not `listen` itself) and
 *   route every listen() call through a recorder that ALSO applies the
 *   Tauri 2 validator and rejects (just like the real runtime would) any
 *   call to a non-conforming name.  That way, a regression to
 *   'app.close-requested' will see Shell's catch block run + the test see
 *   no successfully-registered listener for the close-event name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@solidjs/testing-library';

// Empirically derived from probing Tauri 2's plugin:event|listen runtime
// against the deployed alpha.4 .deb (under Xvfb + tauri-driver). See
// /tmp/kibrary-diag/diag2.ts for the probe; allowed chars confirmed to be
// [A-Za-z0-9_-/:].
const TAURI2_EVENT_NAME_RE = /^[A-Za-z0-9_\-:/]+$/;

interface ListenCall {
  event: string;
  handler: (e: any) => unknown;
  resolved: boolean;
  error?: string;
}

const listenCalls: ListenCall[] = [];

vi.mock('@tauri-apps/api/event', () => ({
  // Mirror the real Tauri runtime: validate the event name BEFORE returning.
  // If invalid, return a rejected Promise (the same behaviour ListenError
  // exhibits in the deployed binary). This is the load-bearing assertion —
  // any dotted name would now fail the listen() call, causing onMount's
  // catch to run, leaving listenCalls without a `resolved:true` entry for
  // the close-event listener.
  listen: async (event: string, handler: (e: any) => unknown) => {
    const call: ListenCall = { event, handler, resolved: false };
    listenCalls.push(call);
    if (!TAURI2_EVENT_NAME_RE.test(event)) {
      const err = `invalid args \`event\` for command \`listen\`: Event name must include only alphanumeric characters, \`-\`, \`/\`, \`:\` and \`_\`.`;
      call.error = err;
      throw new Error(err);
    }
    call.resolved = true;
    return () => {};
  },
  emit: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn(async () => true),
  open: vi.fn(async () => null),
}));

vi.mock('~/state/workspace', () => ({
  firstRun: () => false,
  currentWorkspace: () => null,
  recentWorkspaces: () => [],
  openWorkspace: vi.fn(async () => undefined),
}));

vi.mock('~/state/room', () => ({ room: () => 'add', setRoom: vi.fn() }));

// Stub the heavy descendants Shell renders.
vi.mock('~/shell/LeftRail', () => ({ default: () => null }));
vi.mock('~/shell/Header', () => ({ default: () => null }));
vi.mock('~/shell/BlockHost', () => ({ default: () => null }));
vi.mock('~/shell/ToastHost', () => ({ default: () => null }));
vi.mock('~/blocks/UpdatePrompt', () => ({ default: () => null }));
vi.mock('~/blocks/DropZoneOverlay', () => ({ default: () => null }));
vi.mock('~/blocks/FirstRunWizard', () => ({ default: () => null }));

import Shell from '~/shell/Shell';

beforeEach(() => {
  listenCalls.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('Shell window-close listener — real-DOM registration', () => {
  it('registers a listener for an event name that Tauri 2 accepts', async () => {
    render(() => <Shell />);
    // onMount runs synchronously after mount; the inner async listen()
    // resolves on the microtask queue, so flush.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    // At least one listen() call must have been made for the close-event.
    const closeCalls = listenCalls.filter(c => /close|quit/i.test(c.event));
    expect(
      closeCalls.length,
      'Shell.tsx must register a listener for the window-close event',
    ).toBeGreaterThanOrEqual(1);

    // Each one must have RESOLVED (i.e. the event name passed Tauri 2's
    // validator).  In the alpha.1..alpha.4 bug, listen('app.close-requested')
    // would reject here and `resolved:false` — meaning the close-handler
    // chain in production was dead.
    for (const c of closeCalls) {
      expect(
        c.resolved,
        `listen('${c.event}', …) was REJECTED by Tauri 2's validator: ${c.error ?? '(no error captured)'} ` +
        `— the listener never registered, so the X button cannot trigger the unsaved-edits prompt`,
      ).toBe(true);
      expect(
        TAURI2_EVENT_NAME_RE.test(c.event),
        `event name '${c.event}' must conform to Tauri 2's allowed-chars set [A-Za-z0-9_-/:]`,
      ).toBe(true);
      // The specific dotted name shipped in alpha.1..alpha.4 must never
      // come back.
      expect(c.event).not.toBe('app.close-requested');
    }
  });

  it('regression: validator mock rejects the alpha.1..alpha.4 dotted name', async () => {
    // Sanity-check the mock itself — if someone changes the regex to allow
    // dots, this test fails so the `acceptance` test above can't accidentally
    // pass.
    const { listen } = await import('@tauri-apps/api/event');
    let caught: unknown = null;
    try {
      await listen('app.close-requested', () => {});
    } catch (e) {
      caught = e;
    }
    expect(caught, 'mock validator must reject app.close-requested').not.toBeNull();
    expect(String(caught)).toMatch(/Event name must include only/);
  });
});
