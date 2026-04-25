//! Filesystem watcher for the staging directory.
//!
//! Task 28: watches a workspace's `.kibrary/staging/` directory for file
//! modifications and emits a `staging.changed` Tauri event to the frontend.
//!
//! The emitted payload is `{ path: String, lcsc: String }` where `lcsc` is
//! the name of the immediate parent directory of the changed file (i.e. the
//! LCSC part identifier that kibrary uses as directory names).
//!
//! # Usage
//!
//! The frontend calls the `watch_workspace` Tauri command once a workspace is
//! opened.  The watcher replaces any previously active watcher (the old one is
//! dropped when its `InotifyWatcher` goes out of scope inside the spawned
//! task).

use anyhow::Result;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

// ---------------------------------------------------------------------------
// Event payload
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
struct StagingChangedPayload {
    path: String,
    lcsc: String,
}

// ---------------------------------------------------------------------------
// State — holds the active watcher so it lives as long as the Tauri app
// ---------------------------------------------------------------------------

/// Tauri-managed state: the currently active watcher (if any).
pub struct WatcherState(pub Mutex<Option<RecommendedWatcher>>);

impl WatcherState {
    pub fn new() -> Self {
        WatcherState(Mutex::new(None))
    }
}

// ---------------------------------------------------------------------------
// Core watcher logic
// ---------------------------------------------------------------------------

/// Start watching `path` for file modifications, emitting `staging.changed`
/// events via the Tauri `app` handle.
///
/// Returns a [`RecommendedWatcher`] that must be kept alive for as long as
/// watching is desired.  Dropping it stops the watcher.
pub fn start_watching(path: PathBuf, app: AppHandle) -> Result<RecommendedWatcher> {
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let event = match res {
            Ok(e) => e,
            Err(_) => return,
        };

        // Only react to data-modification events (writes, renames-into, etc.)
        let is_modify = matches!(
            event.kind,
            EventKind::Modify(_) | EventKind::Create(_)
        );
        if !is_modify {
            return;
        }

        for changed_path in event.paths {
            // Extract the LCSC identifier: the immediate parent directory name.
            let lcsc = changed_path
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();

            let payload = StagingChangedPayload {
                path: changed_path.to_string_lossy().into_owned(),
                lcsc,
            };

            // Emit to the frontend (best-effort — ignore if window is closed).
            let _ = app.emit("staging.changed", payload);
        }
    })?;

    watcher.watch(&path, RecursiveMode::Recursive)?;
    Ok(watcher)
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

/// Tauri command: start watching `<workspace>/.kibrary/staging`.
///
/// Called from the frontend after `openWorkspace` succeeds.  Replaces any
/// previously active watcher.
#[tauri::command]
pub async fn watch_workspace(
    workspace: String,
    app: AppHandle,
    state: State<'_, WatcherState>,
) -> Result<(), String> {
    let staging_path = PathBuf::from(&workspace)
        .join(".kibrary")
        .join("staging");

    // If the staging dir doesn't exist yet, create it so the watcher can
    // start successfully (it will be created on first download anyway).
    if !staging_path.exists() {
        std::fs::create_dir_all(&staging_path).map_err(|e| e.to_string())?;
    }

    let watcher = start_watching(staging_path, app).map_err(|e| e.to_string())?;

    // Store the new watcher (drops — and thus stops — the old one).
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = Some(watcher);

    Ok(())
}
