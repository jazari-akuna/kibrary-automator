/// Sidecar bootstrap — run before the main window opens.
///
/// Resolution order:
///
/// 0. Bundled PyInstaller binary in `resource_dir` (release builds only)
/// 1. The value passed in `env_override` (i.e. `KIBRARY_SIDECAR_PYTHON`)
/// 2. `~/.config/kibrary/python.json` cache (cross-platform)
/// 3. `python3` on PATH
/// 4. `python` on PATH
///
/// For each Python candidate the probe command is:
///   `<py> -c "import kibrary_sidecar; print(kibrary_sidecar.__version__)"`
///
/// On the first success a [`BootstrapResult`] is returned and (when the
/// winner was found via PATH rather than the env-var or cache) the result is
/// written back to the cache so subsequent launches are faster.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use tauri::{Emitter, Manager, State};

const PROBE: &str = "import kibrary_sidecar; print(kibrary_sidecar.__version__)";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapResult {
    pub python_path: String,
    pub sidecar_version: String,
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/// On-disk format of `~/.config/kibrary/python.json`.
#[derive(Debug, Serialize, Deserialize)]
struct PythonCache {
    python_path: String,
    sidecar_version: String,
    detected_at: String,
}

/// Resolve the per-OS config directory, mirroring `settings.py`'s
/// `_config_root()`.
fn config_root() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        dirs_home().join("Library").join("Application Support")
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs_home())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux / BSD / etc. — honour XDG_CONFIG_HOME
        std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs_home().join(".config"))
    }
}

fn dirs_home() -> PathBuf {
    // Simple cross-platform home: prefer HOME env var, fall back to /root.
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/root"))
}

fn cache_path() -> PathBuf {
    config_root().join("kibrary").join("python.json")
}

fn read_cache() -> Option<PythonCache> {
    let path = cache_path();
    let data = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

fn write_cache(result: &BootstrapResult) {
    let path = cache_path();
    // Best-effort: create dirs if needed.
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let now = {
        // RFC-3339 timestamp without pulling in `chrono`.
        // std doesn't expose a formatter, so we build one from SystemTime.
        use std::time::{SystemTime, UNIX_EPOCH};
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // Produce a minimal but valid ISO-8601 UTC timestamp: YYYY-MM-DDTHH:MM:SSZ
        let (y, mo, d, h, mi, s) = unix_to_utc(secs);
        format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, mi, s)
    };
    let cache = PythonCache {
        python_path: result.python_path.clone(),
        sidecar_version: result.sidecar_version.clone(),
        detected_at: now,
    };
    if let Ok(json) = serde_json::to_string_pretty(&cache) {
        let _ = std::fs::write(&path, json);
    }
}

/// Convert a UNIX timestamp (seconds since epoch) to (year, month, day, hour,
/// min, sec) in UTC.  Good enough for a cache timestamp — no leap-second
/// handling.
fn unix_to_utc(ts: u64) -> (u64, u8, u8, u8, u8, u8) {
    let s = ts % 60;
    let ts = ts / 60;
    let m = ts % 60;
    let ts = ts / 60;
    let h = ts % 24;
    let days = ts / 24;

    // Compute date from day count (days since 1970-01-01).
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };

    (y, mo as u8, d as u8, h as u8, m as u8, s as u8)
}

// ---------------------------------------------------------------------------
// Probe helper
// ---------------------------------------------------------------------------

/// Run the probe against a single Python candidate.  Returns `Some(version)`
/// on success, `None` otherwise.
fn probe_python(candidate: &str) -> Option<String> {
    let output = Command::new(candidate)
        .args(["-c", PROBE])
        .output()
        .ok()?;

    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !version.is_empty() {
            return Some(version);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Check whether a PyInstaller-bundled `kibrary-sidecar` binary exists inside
/// `resource_dir`.
///
/// Tauri bundles the binary as `kibrary-sidecar-<target-triple>` (from
/// `externalBin` in `tauri.conf.json`), and at runtime exposes it in the app's
/// resource directory.  We probe for the file with and without the target-triple
/// suffix so that both the dev layout (after a manual `cp`) and the installed
/// release layout are handled.
///
/// Returns the path to the executable if found and executable, `None` otherwise.
pub fn try_find_bundled_binary(resource_dir: &std::path::Path) -> Option<PathBuf> {
    // Tauri puts external sidecar binaries next to the main executable on
    // Linux .deb / .rpm (`/usr/bin/`), inside the .app bundle on macOS, and
    // alongside the .exe on Windows. The resource_dir contains data files
    // (icons, wheels, etc.) but NOT the sidecar binary on Linux .deb.
    // So we check several spots. Also check both bare and arch-suffixed names.
    let mut candidates: Vec<PathBuf> = vec![
        resource_dir.join("kibrary-sidecar"),
        resource_dir.join(format!("kibrary-sidecar-{}", std::env::consts::ARCH)),
    ];

    // Add `<exe-dir>/kibrary-sidecar` — this is where Tauri's externalBin
    // ends up on Linux .deb (/usr/bin/) and on Windows (next to .exe).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("kibrary-sidecar"));
            candidates.push(exe_dir.join("kibrary-sidecar.exe")); // Windows
            candidates.push(exe_dir.join(format!("kibrary-sidecar-{}", std::env::consts::ARCH)));
        }
    }

    for path in &candidates {
        if path.exists() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(path) {
                    if meta.permissions().mode() & 0o111 != 0 {
                        eprintln!("[bootstrap] found bundled binary: {}", path.display());
                        return Some(path.clone());
                    }
                }
            }
            #[cfg(not(unix))]
            {
                eprintln!("[bootstrap] found bundled binary: {}", path.display());
                return Some(path.clone());
            }
        }
    }
    None
}

/// Try to find a Python interpreter that has `kibrary_sidecar` installed.
///
/// `env_override` should be the value of the `KIBRARY_SIDECAR_PYTHON`
/// environment variable (pass `None` if unset).
///
/// Returns `Some(BootstrapResult)` on the first successful probe, `None` if
/// nothing works.
pub fn try_resolve_sidecar(env_override: Option<&str>) -> Option<BootstrapResult> {
    // --- 1. Explicit env-var override ---
    if let Some(py) = env_override {
        if !py.is_empty() {
            if let Some(version) = probe_python(py) {
                return Some(BootstrapResult {
                    python_path: py.to_string(),
                    sidecar_version: version,
                });
            }
            // If the user explicitly set the env var and it fails, we still
            // fall through rather than hard-failing — lets them fix via cache
            // or PATH in a pinch.
            eprintln!(
                "[bootstrap] KIBRARY_SIDECAR_PYTHON={py:?} probe failed, trying other candidates"
            );
        }
    }

    // --- 2. Disk cache ---
    if let Some(cache) = read_cache() {
        if !cache.python_path.is_empty() {
            if let Some(version) = probe_python(&cache.python_path) {
                return Some(BootstrapResult {
                    python_path: cache.python_path,
                    sidecar_version: version,
                });
            }
            // Cache is stale — continue searching.
            eprintln!(
                "[bootstrap] cached python {:?} probe failed, searching PATH",
                cache.python_path
            );
        }
    }

    // --- 3 & 4. PATH candidates ---
    let path_candidates = ["python3", "python"];
    for &py in &path_candidates {
        if let Some(version) = probe_python(py) {
            let result = BootstrapResult {
                python_path: py.to_string(),
                sidecar_version: version,
            };
            // Cache the result so next launch skips the PATH scan.
            write_cache(&result);
            return Some(result);
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Tauri managed state
// ---------------------------------------------------------------------------

/// Held in Tauri's state map so that `bootstrap_status` can read it from any
/// command handler.
pub struct BootstrapState {
    pub result: Option<BootstrapResult>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Returns whether the sidecar was resolved at startup and, if so, its version.
///
/// The frontend calls this on mount to decide whether to show `<Shell />` or
/// `<Bootstrap />`.
#[tauri::command]
pub fn bootstrap_status(
    state: State<'_, std::sync::Mutex<BootstrapState>>,
) -> serde_json::Value {
    let s = state.lock().expect("bootstrap state mutex poisoned");
    match &s.result {
        Some(r) => serde_json::json!({
            "python_resolved": true,
            "sidecar_version": r.sidecar_version,
        }),
        None => serde_json::json!({
            "python_resolved": false,
            "sidecar_version": null,
        }),
    }
}

// ---------------------------------------------------------------------------
// bootstrap_install_direct helpers
// ---------------------------------------------------------------------------

/// Return the directory into which the managed venv will be created.
///
/// - Linux / macOS : `~/.local/share/kibrary`
/// - Windows       : `%LOCALAPPDATA%\kibrary`
///
/// The choice mirrors the XDG Base Directory specification for Linux and the
/// Windows convention for app-local data.
fn venv_parent_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs_home().join("AppData").join("Local"));
        Ok(base.join("kibrary"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Honour XDG_DATA_HOME on Linux; macOS uses ~/.local/share as well
        // (diverging from ~/Library for *data* dirs keeps it simple and
        // consistent with the Python sidecar's expectations).
        let base = std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs_home().join(".local").join("share"));
        Ok(base.join("kibrary"))
    }
}

/// Given a venv root, return the path to `pip`.
fn venv_pip(venv: &PathBuf) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("pip.exe")
    } else {
        venv.join("bin").join("pip")
    }
}

/// Given a venv root, return the path to `python`.
fn venv_python(venv: &PathBuf) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

/// Scan `dir` (and `dir/resources/`) for a file matching `kibrary_sidecar-*.whl`
/// and return its path. Tauri's `bundle.resources` glob copies files into a
/// `resources/` subdirectory of the install path on Linux .deb, so we check
/// both the dir itself and that subdirectory.
fn find_wheel(dir: &PathBuf) -> Result<PathBuf, String> {
    let scan_dirs = [dir.clone(), dir.join("resources")];
    let mut last_err = String::new();
    for d in &scan_dirs {
        match std::fs::read_dir(d) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name_str = name.to_string_lossy();
                    if name_str.starts_with("kibrary_sidecar-") && name_str.ends_with(".whl") {
                        return Ok(entry.path());
                    }
                }
            }
            Err(e) => {
                last_err = format!("Cannot read {}: {}", d.display(), e);
            }
        }
    }
    Err(format!(
        "No kibrary_sidecar-*.whl found in {} or {}/resources/. \
         Ensure the wheel is bundled with the application. \
         (last fs error: {})",
        dir.display(),
        dir.display(),
        last_err
    ))
}

/// Progress event payload emitted as `bootstrap.progress`.
#[derive(Serialize, Clone)]
struct BootstrapProgress {
    step: String,
    message: String,
}

/// Run a blocking [`std::process::Command`] and return its stdout on success,
/// or a combined stdout+stderr error string on failure.
fn run_blocking(mut cmd: Command) -> Result<String, String> {
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to launch process: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "Process exited with status {}\nstdout: {}\nstderr: {}",
            output.status, stdout, stderr
        ))
    }
}

// ---------------------------------------------------------------------------
// Real bootstrap_install_direct
// ---------------------------------------------------------------------------

/// Install the bundled `kibrary_sidecar` wheel into a fresh managed venv.
///
/// Steps:
///   1. Resolve the wheel from the app's resource directory.
///   2. Determine the venv path (`~/.local/share/kibrary/venv` on Unix,
///      `%LOCALAPPDATA%\kibrary\venv` on Windows).
///   3. Create the venv: `<python_path> -m venv <venv>`.
///   4. Install the wheel: `<venv>/bin/pip install <wheel>`.
///   5. Probe the installed package version.
///   6. Write the resolved Python path to the cache so subsequent launches
///      skip the PATH scan.
///   7. Return a [`BootstrapResult`].
///
/// Progress events (`bootstrap.progress`) are emitted at each step so the
/// frontend can show live status.
///
/// # Platform notes
/// - On Windows, pip/python live under `<venv>\Scripts\` instead of `<venv>/bin/`.
/// - The install can take 30–60 seconds on a slow network/disk; the command is
///   therefore `async` and the blocking subprocess runs on a dedicated thread
///   via [`tokio::task::spawn_blocking`].
///
/// TODO: Verify end-to-end on each platform (Linux, macOS, Windows) in a
/// full Tauri runtime environment. The resource_dir path may differ between
/// dev (cargo tauri dev) and production builds.
#[tauri::command]
pub async fn bootstrap_install_direct(
    app: tauri::AppHandle,
    python_path: String,
    wheel_filename: Option<String>,
) -> Result<BootstrapResult, String> {
    // -- 1. Resolve wheel path -----------------------------------------------
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Cannot resolve resource dir: {}", e))?;

    let wheel_path = match wheel_filename {
        Some(ref name) => {
            let p = resource_dir.join(name);
            if !p.exists() {
                return Err(format!("Wheel not found: {}", p.display()));
            }
            p
        }
        None => find_wheel(&resource_dir)?,
    };

    let emit_progress = |step: &str, message: &str| {
        let _ = app.emit(
            "bootstrap.progress",
            BootstrapProgress {
                step: step.to_string(),
                message: message.to_string(),
            },
        );
    };

    // -- 2. Resolve venv path -------------------------------------------------
    let venv_dir = venv_parent_dir()?.join("venv");

    emit_progress(
        "creating_venv",
        &format!("Creating virtual environment at {}", venv_dir.display()),
    );

    // -- 3. Create venv -------------------------------------------------------
    // Clone the values we need to move into spawn_blocking.
    let python_path_clone = python_path.clone();
    let venv_dir_clone = venv_dir.clone();
    let wheel_path_clone = wheel_path.clone();
    let app_clone = app.clone();

    tokio::task::spawn_blocking(move || -> Result<BootstrapResult, String> {
        // 3a. Create the venv parent directory if needed.
        if let Some(parent) = venv_dir_clone.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create venv parent dir: {}", e))?;
        }

        // 3b. python -m venv <venv>
        let mut venv_cmd = Command::new(&python_path_clone);
        venv_cmd.args(["-m", "venv", &venv_dir_clone.to_string_lossy()]);
        run_blocking(venv_cmd).map_err(|e| format!("venv creation failed: {}", e))?;

        let pip = venv_pip(&venv_dir_clone);
        let venv_py = venv_python(&venv_dir_clone);

        // -- 4. Install wheel -------------------------------------------------
        let _ = app_clone.emit(
            "bootstrap.progress",
            BootstrapProgress {
                step: "installing".to_string(),
                message: format!("Installing {} …", wheel_path_clone.display()),
            },
        );

        // Install the bundled wheel. Transitive deps (kiutils, JLC2KiCadLib,
        // httpx, GitPython, pydantic, keyring) come from PyPI — we don't
        // pre-bundle the entire dep tree because it would balloon the
        // installer by ~30 MB. Requires internet on first install.
        let mut pip_cmd = Command::new(&pip);
        pip_cmd.args([
            "install",
            &wheel_path_clone.to_string_lossy(),
        ]);
        run_blocking(pip_cmd).map_err(|e| format!("pip install failed: {}", e))?;

        // -- 5. Probe installed version ---------------------------------------
        let _ = app_clone.emit(
            "bootstrap.progress",
            BootstrapProgress {
                step: "verifying".to_string(),
                message: "Verifying installation…".to_string(),
            },
        );

        let mut probe_cmd = Command::new(&venv_py);
        probe_cmd.args(["-c", PROBE]);
        let version = run_blocking(probe_cmd)
            .map_err(|e| format!("Post-install probe failed: {}", e))?;

        if version.is_empty() {
            return Err(
                "Post-install probe returned an empty version string. \
                 The wheel may not have installed correctly."
                    .to_string(),
            );
        }

        let resolved_python = venv_py.to_string_lossy().to_string();

        // -- 6. Write cache ---------------------------------------------------
        let result = BootstrapResult {
            python_path: resolved_python,
            sidecar_version: version,
        };
        write_cache(&result);

        Ok(result)
    })
    .await
    .map_err(|e| format!("Async task panicked: {}", e))?
}
