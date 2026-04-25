use crate::sidecar::Sidecar;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

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
    sidecar.call(&method, params).await.map_err(|e| e.to_string())
}
