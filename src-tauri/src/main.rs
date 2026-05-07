#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bootstrap;
mod embedded_secrets;
mod protocol;
mod sidecar;
mod commands;
mod watcher;

use std::sync::Arc;
use once_cell::sync::OnceCell;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

/// Global AppHandle — set once during `.setup()`, used by the sidecar reader
/// task to emit Tauri events for incoming notifications.
pub static APP_HANDLE: OnceCell<AppHandle> = OnceCell::new();

/// Latched once the user has confirmed "Discard" in the unsaved-edits prompt
/// (or via the explicit quit_app command after the app handed control back).
///
/// Since v26.5.7-alpha.3 `confirm_quit` uses `app.exit(0)` which directly
/// sets `ControlFlow::Exit` (with a `std::process::exit` fallback) — so the
/// latch is no longer strictly required for the happy path. It's kept as
/// defense-in-depth: if any other code path emits `CloseRequested` while
/// the exit is propagating through the event loop, the prevent-close
/// handler must let that close through instead of re-prompting the user
/// (whose intent is already "yes, exit").
pub static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

// NOTE: do NOT mark this `#[tokio::main]`. Tauri owns the async runtime
// (tauri::async_runtime — currently tokio under the hood), and `tauri::Builder::run()`
// drives it. If we set up a tokio runtime here too, `block_on` inside `.setup()`
// panics with "Cannot start a runtime from within a runtime".
fn main() -> anyhow::Result<()> {
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
    //
    // P-sidecar-bin: Before Python probing, .setup() checks for a bundled
    // PyInstaller binary in resource_dir and uses it when found.  The python
    // fallback path below only runs in dev or when no binary is bundled.
    let env_override = std::env::var("KIBRARY_SIDECAR_PYTHON").ok();
    let bootstrap_result = bootstrap::try_resolve_sidecar(env_override.as_deref());

    if bootstrap_result.is_none() {
        eprintln!(
            "[bootstrap] no Python kibrary_sidecar found on PATH/cache; will try the \
             bundled sidecar binary next, otherwise the in-app setup screen will appear."
        );
    }

    // Both the bundled binary check and the Python-fallback spawn happen inside
    // .setup() where AppHandle (and therefore resource_dir) is available.
    // tauri::async_runtime::block_on is used for the async spawn calls.
    let bootstrap_state = std::sync::Mutex::new(
        bootstrap::BootstrapState { result: bootstrap_result.clone() }
    );
    let bootstrap_result_for_setup = bootstrap_result;

    let builder = tauri::Builder::default()
        .setup(move |app| {
            APP_HANDLE.set(app.handle().clone()).unwrap();

            // --- 0. Try bundled PyInstaller binary ---
            let bundled: Option<Arc<sidecar::Sidecar>> =
                if let Ok(res_dir) = app.path().resource_dir() {
                    if let Some(bin_path) = bootstrap::try_find_bundled_binary(&res_dir) {
                        eprintln!(
                            "[bootstrap] spawning bundled binary: {}",
                            bin_path.display()
                        );
                        let bin_str = bin_path.to_string_lossy().to_string();
                        match tauri::async_runtime::block_on(
                            sidecar::Sidecar::spawn_binary(&bin_str),
                        ) {
                            Ok(sc) => {
                                eprintln!("[bootstrap] bundled binary spawned successfully");
                                // Mark bootstrap_status as resolved so the frontend doesn't
                                // show the install screen when a bundled binary is running.
                                if let Some(state) = app.try_state::<std::sync::Mutex<bootstrap::BootstrapState>>() {
                                    if let Ok(mut s) = state.lock() {
                                        s.result = Some(bootstrap::BootstrapResult {
                                            python_path: bin_str.clone(),
                                            sidecar_version: "bundled".to_string(),
                                        });
                                    }
                                }
                                Some(Arc::new(sc))
                            }
                            Err(e) => {
                                eprintln!("[bootstrap] bundled binary spawn failed: {e}");
                                None
                            }
                        }
                    } else {
                        None
                    }
                } else {
                    None
                };

            // --- 1-4. Python fallback (only when bundled binary was not found) ---
            let sidecar_opt: Option<Arc<sidecar::Sidecar>> = if bundled.is_some() {
                bundled
            } else {
                match &bootstrap_result_for_setup {
                    Some(r) => {
                        eprintln!(
                            "[bootstrap] using python={:?} sidecar_version={}",
                            r.python_path, r.sidecar_version
                        );
                        match tauri::async_runtime::block_on(
                            sidecar::Sidecar::spawn(&r.python_path, "kibrary_sidecar"),
                        ) {
                            Ok(sc) => Some(Arc::new(sc)),
                            Err(e) => {
                                eprintln!("[bootstrap] python sidecar spawn failed: {e}");
                                None
                            }
                        }
                    }
                    None => None,
                }
            };

            if let Some(sc) = sidecar_opt {
                app.manage(sc);
            }

            Ok(())
        })
        .manage(bootstrap_state) // std::sync::Mutex<BootstrapState>
        // Watcher state: starts inactive; activated by the `watch_workspace` command.
        .manage(watcher::WatcherState::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init());

    builder
        .on_window_event(|window, event| {
            // Intercept the user's window-close request (X button, Cmd-Q,
            // wm-delete) to give the frontend a chance to surface a
            // "discard unsaved 3D position edits?" prompt. The Rust side
            // doesn't know what's dirty; it just delegates to the webview.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if QUIT_CONFIRMED.load(Ordering::SeqCst) {
                    // The frontend (or quit_app command) already cleared
                    // the gate — let the close proceed normally.
                    return;
                }
                api.prevent_close();
                let _ = window.emit("app.close-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_version,
            commands::quit_app,
            commands::confirm_quit,
            commands::sidecar_ping,
            commands::sidecar_version,
            commands::sidecar_call,
            commands::workspace_open,
            commands::reveal_in_explorer,
            watcher::watch_workspace,
            bootstrap::bootstrap_status,
            bootstrap::bootstrap_install_direct,
        ])
        .run(tauri::generate_context!())?;
    Ok(())
}
