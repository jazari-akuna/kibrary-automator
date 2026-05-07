/**
 * Single source of truth for every Tauri event name used by the kibrary
 * frontend. Mirrored on the Rust side in `src-tauri/src/event_names.rs`
 * and on the Python sidecar side in `sidecar/kibrary_sidecar/event_names.py`.
 *
 * WHY THIS FILE EXISTS — Tauri 2's runtime event-name validator (probed
 * empirically against the deployed alpha.4 .deb) is:
 *
 *   /^[A-Za-z0-9_\-:/]+$/
 *
 * Any name containing `.` (or any other unlisted punctuation) is rejected
 * by `plugin:event|listen` AND `plugin:event|emit` with:
 *
 *   "Event name must include only alphanumeric characters,
 *    `-`, `/`, `:` and `_`."
 *
 * The whole 26.5.7-alpha.1 → alpha.4 line shipped with `app.close-requested`
 * (and several other dotted names) — `listen()` rejected silently, so the
 * close-handler / staging-watcher / bootstrap-progress / download-progress
 * features were silent dead code in production. See
 * `src/blocks/__tests__/eventNameValidity.test.ts` for the regression spec
 * that greps the entire codebase and asserts every emit/listen name passes
 * the validator.
 *
 * INVARIANT — every name in this object MUST also exist in the matching
 * Rust + Python files. A future build step could codegen them; for now the
 * `eventNameValidity.test.ts` spec asserts cross-side conformance.
 */
export const TAURI_EVENT_NAMES = {
  /** Rust `WindowEvent::CloseRequested` → frontend window-close guard. */
  appCloseRequested: 'app-close-requested',

  /** Sidecar parts.download → frontend Queue.tsx + workspace.ts probes. */
  downloadProgress: 'download-progress',

  /** Sidecar parts.download terminal event when the batch finishes. */
  downloadDone: 'download-done',

  /** Rust file-watcher → SymbolPreview.tsx + FootprintPreview.tsx auto-refetch. */
  stagingChanged: 'staging-changed',

  /** Rust bootstrap_install_direct → Bootstrap.tsx live progress UI. */
  bootstrapProgress: 'bootstrap-progress',
} as const;

export type TauriEventName =
  (typeof TAURI_EVENT_NAMES)[keyof typeof TAURI_EVENT_NAMES];
