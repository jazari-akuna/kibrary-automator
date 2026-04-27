use crate::embedded_secrets;
use crate::sidecar::Sidecar;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

/// Returns the Tauri-shell binary version (the Rust crate's package version,
/// not the frontend bundle version nor the Python sidecar version). Used by
/// the Settings room's Versions card so users can quickly see which native
/// shell is running when they file a bug report.
#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
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
