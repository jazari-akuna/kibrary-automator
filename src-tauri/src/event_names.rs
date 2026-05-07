//! Single source of truth for every Tauri event name emitted by the Rust
//! backend. Mirrored on the frontend in `src/utils/eventNames.ts` and on
//! the Python sidecar in `sidecar/kibrary_sidecar/event_names.py`.
//!
//! WHY — Tauri 2's runtime event-name validator (`plugin:event|emit` and
//! `plugin:event|listen`) is `^[A-Za-z0-9_\-:/]+$`. Any name containing
//! `.` is rejected with "Event name must include only alphanumeric
//! characters, `-`, `/`, `:` and `_`.". The 26.5.7-alpha.1..alpha.4 line
//! shipped dotted names (`app.close-requested`, `staging.changed`,
//! `bootstrap.progress`, `download.progress`); `listen()` rejected
//! silently, leaving those features as dead code. See
//! `src/blocks/__tests__/eventNameValidity.test.ts` for the regression
//! spec that greps the entire codebase and asserts conformance.
//!
//! INVARIANT — every constant here must match its frontend +
//! sidecar twin EXACTLY. The vitest `event-name conformance` block walks
//! all three files and fails CI if they ever diverge.

/// `WindowEvent::CloseRequested` → frontend window-close guard (Shell.tsx).
pub const APP_CLOSE_REQUESTED: &str = "app-close-requested";

/// File-watcher → SymbolPreview / FootprintPreview auto-refetch.
pub const STAGING_CHANGED: &str = "staging-changed";

/// `bootstrap_install_direct` live progress events (Bootstrap.tsx).
pub const BOOTSTRAP_PROGRESS: &str = "bootstrap-progress";

/// Sidecar parts.download per-part progress (forwarded by sidecar.rs as the
/// dynamic event name on the inbound JSON `event` field). The sidecar
/// Python file MUST emit this same string. Carried as a Rust constant so
/// the cross-side conformance test in `eventNameValidity.test.ts` can
/// assert the three sources agree.
#[allow(dead_code)]
pub const DOWNLOAD_PROGRESS: &str = "download-progress";

/// Sidecar parts.download terminal event for the batch. Same comment as
/// above — Rust never emits this directly, the Python sidecar does.
#[allow(dead_code)]
pub const DOWNLOAD_DONE: &str = "download-done";
