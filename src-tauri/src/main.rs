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
    // P12: instead of panicking when no sidecar is found, we store the
    // Option<BootstrapResult> as managed state.  The frontend reads
    // `bootstrap_status` on mount and renders <Bootstrap /> when the sidecar
    // is missing.  The panic message is preserved as a log line so users who
    // run from a terminal get an actionable hint.
    let env_override = std::env::var("KIBRARY_SIDECAR_PYTHON").ok();
    let bootstrap_result = bootstrap::try_resolve_sidecar(env_override.as_deref());

    if bootstrap_result.is_none() {
        eprintln!(
            "[bootstrap] kibrary_sidecar not found — set KIBRARY_SIDECAR_PYTHON or \
             install via: python3 -m pip install kibrary-sidecar\n\
             The app will open the setup screen so you can install it from the UI."
        );
    }

    // Spawn the sidecar only when bootstrap succeeded.
    let sidecar_opt: Option<Arc<sidecar::Sidecar>> = match &bootstrap_result {
        Some(r) => {
            eprintln!(
                "[bootstrap] using python={:?} sidecar_version={}",
                r.python_path, r.sidecar_version
            );
            match sidecar::Sidecar::spawn(&r.python_path, "kibrary_sidecar").await {
                Ok(sc) => Some(Arc::new(sc)),
                Err(e) => {
                    eprintln!("[bootstrap] sidecar spawn failed: {e}");
                    None
                }
            }
        }
        None => None,
    };

    let bootstrap_state = bootstrap::BootstrapState { result: bootstrap_result };

    let mut builder = tauri::Builder::default()
        .setup(|app| {
            APP_HANDLE.set(app.handle().clone()).unwrap();
            Ok(())
        })
        .manage(bootstrap_state)
        // Watcher state: starts inactive; activated by the `watch_workspace` command.
        .manage(watcher::WatcherState::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    // Manage the sidecar only when it was successfully spawned.
    if let Some(sc) = sidecar_opt {
        builder = builder.manage(sc);
    }

    builder
        .invoke_handler(tauri::generate_handler![
            commands::sidecar_ping,
            commands::sidecar_version,
            commands::sidecar_call,
            commands::workspace_open,
            watcher::watch_workspace,
            bootstrap::bootstrap_status,
            bootstrap::bootstrap_install_direct,
        ])
        .run(tauri::generate_context!())?;
    Ok(())
}
