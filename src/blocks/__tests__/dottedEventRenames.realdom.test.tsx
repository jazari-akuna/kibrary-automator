// @vitest-environment jsdom
/**
 * Regression spec — every dotted Tauri event name that shipped silently
 * broken in 26.5.7-alpha.1..alpha.4 has been renamed to its dash form,
 * AND both the listener side AND the emit side agree on the new name.
 *
 * Bug class — Tauri 2's runtime event-name validator
 * (`/^[A-Za-z0-9_\-:/]+$/`) rejects names containing `.`. The original
 * close-handler bug was just the visible tip; the same dotted pattern
 * was used by:
 *
 *   - 'download.progress'   (sidecar → Queue / workspace probe)
 *   - 'download.done'       (sidecar terminal batch event)
 *   - 'staging.changed'     (Rust file-watcher → Symbol/FootprintPreview)
 *   - 'bootstrap.progress'  (Rust bootstrap_install_direct → Bootstrap UI)
 *
 * For each, this spec drives a real listen() through a mock that mirrors
 * Tauri 2's validator.  If anyone re-introduces a dotted name (or any
 * other rejected character), listen() throws, the recorded handler is
 * never invoked, and the assertion `handler-was-fired` fails.
 *
 * The single source of truth is `~/utils/eventNames` — these tests
 * import the constants object so a developer who forgets to update one
 * side breaks the test suite, not just the runtime app.
 *
 * NOTE — `app-close-requested` already has its own real-DOM regression in
 * `src/shell/__tests__/closeListener.realdom.test.tsx`. Don't duplicate
 * it here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const TAURI2_EVENT_NAME_RE = /^[A-Za-z0-9_\-:/]+$/;

interface ListenCall {
  event: string;
  handler: (e: any) => unknown;
  resolved: boolean;
  error?: string;
}

// vi.mock factories are hoisted above all top-level statements, so they
// can't close over module-level `let` bindings. We stash the mock module
// shape on globalThis (assigned inside the factory) and read it from
// tests after import.
declare global {
  // eslint-disable-next-line no-var
  var __dottedRenameTestState: {
    listenCalls: ListenCall[];
    emit: (event: string, payload?: unknown) => Promise<void>;
  };
}

vi.mock('@tauri-apps/api/event', () => {
  const TAURI2_RE = /^[A-Za-z0-9_\-:/]+$/;
  const calls: ListenCall[] = [];

  const validate = (event: string) => {
    if (!TAURI2_RE.test(event)) {
      throw new Error(
        `invalid args \`event\` for command \`listen\`: Event name must include only alphanumeric characters, ` +
          '`-`, `/`, `:` and `_`.',
      );
    }
  };

  const listenImpl = async (event: string, handler: (e: any) => unknown) => {
    const call: ListenCall = { event, handler, resolved: false };
    calls.push(call);
    try {
      validate(event);
    } catch (e) {
      call.error = String((e as Error).message);
      throw e;
    }
    call.resolved = true;
    return () => {};
  };

  const emitImpl = async (event: string, payload?: unknown) => {
    validate(event);
    for (const call of calls) {
      if (call.event === event && call.resolved) {
        await Promise.resolve(call.handler({ event, payload, id: 0 }));
      }
    }
  };

  globalThis.__dottedRenameTestState = { listenCalls: calls, emit: emitImpl };
  return { listen: listenImpl, emit: emitImpl };
});

import { listen } from '@tauri-apps/api/event';
import { TAURI_EVENT_NAMES } from '~/utils/eventNames';

const listenCalls = (): ListenCall[] => globalThis.__dottedRenameTestState.listenCalls;
const emitFn = (): ((event: string, payload?: unknown) => Promise<void>) =>
  globalThis.__dottedRenameTestState.emit;

beforeEach(() => {
  listenCalls().length = 0;
});

const cases: { key: keyof typeof TAURI_EVENT_NAMES; description: string }[] = [
  { key: 'downloadProgress', description: 'sidecar parts.download → Queue / workspace probe' },
  { key: 'downloadDone', description: 'sidecar terminal batch event' },
  { key: 'stagingChanged', description: 'Rust file-watcher → Symbol/FootprintPreview' },
  { key: 'bootstrapProgress', description: 'Rust bootstrap_install_direct → Bootstrap UI' },
];

describe('Dotted-event-name renames — listen+emit round-trip', () => {
  for (const { key, description } of cases) {
    const name = TAURI_EVENT_NAMES[key];

    it(`${key} ('${name}') passes the Tauri 2 validator (${description})`, () => {
      expect(
        TAURI2_EVENT_NAME_RE.test(name),
        `TAURI_EVENT_NAMES.${key} = '${name}' would be REJECTED by Tauri 2's validator. ` +
          `Was the name reverted to a dotted form?`,
      ).toBe(true);
      expect(
        name.includes('.'),
        `TAURI_EVENT_NAMES.${key} = '${name}' contains '.', which Tauri 2 rejects.`,
      ).toBe(false);
    });

    it(`listener for '${name}' fires when emit('${name}', …) runs`, async () => {
      let received: unknown = null;
      let handlerCalls = 0;

      // listen() must NOT throw — that's the bug we're regressing against.
      // If TAURI_EVENT_NAMES.<key> ever goes back to a dotted form, the
      // mock validator throws here and the assertion fires.
      let listenError: unknown = null;
      try {
        await listen<{ marker: string }>(name, (e) => {
          handlerCalls += 1;
          received = e.payload;
        });
      } catch (e) {
        listenError = e;
      }
      expect(
        listenError,
        `listen('${name}', …) was rejected by the Tauri 2 validator: ${listenError ?? '(none)'}\n` +
          `This is exactly the alpha.1..alpha.4 dead-listener bug class.`,
      ).toBeNull();

      // Emit and assert delivery.
      await emitFn()(name, { marker: key });

      expect(handlerCalls, `handler for '${name}' must fire exactly once`).toBe(1);
      expect(received).toEqual({ marker: key });
    });
  }
});
