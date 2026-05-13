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
/// Triggers a guaranteed app-level exit via `app.exit(0)` — which fires
/// `RunEvent::ExitRequested` and, if anything goes wrong, falls back to
/// `std::process::exit(0)` (see tauri::App::exit).
///
/// Why not `window.close()` or `window.destroy()`?
///
/// • `window.close()` re-emits `CloseRequested`, which our `prevent_close`
///   handler intercepts again — the latch is meant to break that loop, but
///   on Linux/GTK the ordering between the atomic store and the event-loop
///   dispatch was racy and the user saw "the app does not want to close
///   anymore" (regressed in v26.5.7-alpha.1).
///
/// • `window.destroy()` sends `WindowMessage::Destroy` to tauri-runtime-wry,
///   which calls `on_window_close()` — that only sets the runtime's
///   `WindowWrapper.inner = None`, it does NOT remove the wrapper from the
///   `windows` map and it does NOT set `ControlFlow::Exit`. The OS-level
///   GTK window is only torn down when the inner Arc actually drops, which
///   may be deferred indefinitely if the webview holds a clone. In that
///   case the process keeps running with a zombie window — "no prompts,
///   needs to be killed" (user-reported regression in v26.5.7-alpha.2).
///
/// `app.exit(0)` sends `Message::RequestExit` which sets
/// `ControlFlow::Exit` directly, and the std::process::exit fallback is
/// guaranteed to terminate even if the runtime is wedged.
///
/// `QUIT_CONFIRMED` is kept as defense-in-depth: if anything emits
/// `CloseRequested` between this command running and the exit propagating,
/// the prevent-close handler in main.rs lets that close through unprompted.
#[tauri::command]
pub fn confirm_quit(app: tauri::AppHandle) -> Result<(), String> {
    QUIT_CONFIRMED.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
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
        let key = embedded_secrets::search_api_key();
        if !key.is_empty() {
            return Ok(json!({ "value": key }));
        }
    }
    // Writes to the same key are no-ops — there's nothing to store.
    if method == "secrets.set" && params.get("name").and_then(Value::as_str)
        == Some("search_raph_io_api_key")
    {
        if !embedded_secrets::search_api_key().is_empty() {
            return Ok(json!({}));
        }
    }

    sidecar.call(&method, params).await.map_err(|e| e.to_string())
}
