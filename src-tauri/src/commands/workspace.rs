use crate::sidecar::Sidecar;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn workspace_open(
    sidecar: State<'_, Arc<Sidecar>>,
    root: String,
) -> Result<Value, String> {
    sidecar.call("workspace.open", json!({ "root": root }))
        .await.map_err(|e| e.to_string())
}
