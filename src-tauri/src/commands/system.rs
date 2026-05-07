use crate::embedded_secrets;
use crate::sidecar::Sidecar;
use crate::QUIT_CONFIRMED;
use serde_json::{json, Value};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tauri::State;

/// Returns the Tauri-shell binary version (the Rust crate's package version,
/// not the frontend bundle version nor the Python sidecar version). Used by
/// the Settings room's Versions card so users can quickly see which native
/// shell is running when they file a bug report.
#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Cleanly exit the app. Used by the post-install update flow: after the
/// updater's `downloadAndInstall()` lands the new .deb, the user clicks
/// "Quit Kibrary" and we call this to terminate the running (now-stale)
/// process. Re-launching is intentionally left to the user — auto-relaunch
/// from inside a polkit-mediated install transition is unreliable.
///
/// Also used by the unsaved-edits confirm flow — the frontend calls this
/// after the user picks "Discard" so app.exit() bypasses the close-requested
/// gate (see the QUIT_CONFIRMED latch in main.rs).
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    QUIT_CONFIRMED.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Frontend acks the unsaved-edits prompt (or "no edits, just close").
/// Force-destroys the main window via `window.destroy()` — which, unlike
/// `window.close()`, does NOT re-emit the `CloseRequested` event so the
/// frontend cannot accidentally loop back into the prevent-close handler.
///
/// We also set `QUIT_CONFIRMED` as defense-in-depth: if some other window
/// triggers CloseRequested between this command running and the destroy
/// actually landing on the event loop, the latch lets it through.
///
/// The bug this fixes (v26.5.7-alpha.1): the previous `window.close()`
/// implementation re-fired CloseRequested, relying on the latch to break
/// the loop. On some Linux WMs the latch ordering with the GTK event loop
/// resulted in the close being prevented anyway — the user reported "after
/// saving the app does not want to close anymore". `destroy()` sidesteps
/// the re-emission entirely and is the documented pattern for force-close.
#[tauri::command]
pub fn confirm_quit(window: tauri::Window) -> Result<(), String> {
    QUIT_CONFIRMED.store(true, Ordering::SeqCst);
    window.destroy().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sidecar_ping(sidecar: State<'_, Arc<Sidecar>>) -> Result<Value, String> {
    sidecar.call("system.ping", json!({})).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sidecar_version(sidecar: State<'_, Arc<Sidecar>>) -> Result<Value, String> {
    sidecar.call("system.version", json!({})).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sidecar_call(
    sidecar: State<'_, Arc<Sidecar>>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    // Intercept search.raph.io API key reads — serve the compile-time-embedded
    // key directly so the user is never asked for one. Any other secret name
    // continues to reach the sidecar's keychain handler.
    if method == "secrets.get" && params.get("name").and_then(Value::as_str)
        == Some("search_raph_io_api_key")
    {
        return Ok(json!({ "value": embedded_secrets::search_api_key() }));
    }
    // Writes to the same key are no-ops — there's nothing to store.
    if method == "secrets.set" && params.get("name").and_then(Value::as_str)
        == Some("search_raph_io_api_key")
    {
        return Ok(json!({}));
    }

    sidecar.call(&method, params).await.map_err(|e| e.to_string())
}
