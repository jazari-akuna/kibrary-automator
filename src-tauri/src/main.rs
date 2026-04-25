#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bootstrap;
mod protocol;
mod sidecar;
mod commands;
mod watcher;

use std::sync::Arc;
use once_cell::sync::OnceCell;
use tauri::AppHandle;

/// Global AppHandle — set once during `.setup()`, used by the sidecar reader
/// task to emit Tauri events for incoming notifications.
pub static APP_HANDLE: OnceCell<AppHandle> = OnceCell::new();

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // P2 / Task P10 — resolve the Python interpreter *before* opening the
    // main window.  Resolution order (see bootstrap::try_resolve_sidecar):
    //   1. KIBRARY_SIDECAR_PYTHON env var
    //   2. ~/.config/kibrary/python.json disk cache
    //   3. python3 on PATH
    //   4. python on PATH
    //
    // If none of these work we panic with an actionable message.
    // Task P12 will replace the panic with a real bootstrap UI window.
    let env_override = std::env::var("KIBRARY_SIDECAR_PYTHON").ok();
    let bootstrap_result =
        bootstrap::try_resolve_sidecar(env_override.as_deref()).unwrap_or_else(|| {
            panic!(
                "kibrary_sidecar not found — set KIBRARY_SIDECAR_PYTHON or install per the README"
            );
        });

    let python_path = bootstrap_result.python_path;
    eprintln!(
        "[bootstrap] using python={python_path:?} sidecar_version={}",
        bootstrap_result.sidecar_version
    );

    let sc = Arc::new(sidecar::Sidecar::spawn(&python_path, "kibrary_sidecar").await?);

    tauri::Builder::default()
        .setup(|app| {
            APP_HANDLE.set(app.handle().clone()).unwrap();
            Ok(())
        })
        .manage(sc)
        // Watcher state: starts inactive; activated by the `watch_workspace` command.
        .manage(watcher::WatcherState::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::sidecar_ping,
            commands::sidecar_version,
            commands::sidecar_call,
            commands::workspace_open,
            watcher::watch_workspace,
        ])
        .run(tauri::generate_context!())?;
    Ok(())
}
