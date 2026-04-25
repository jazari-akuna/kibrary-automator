/// Sidecar bootstrap — run before the main window opens.
///
/// Searches for a Python interpreter that has `kibrary_sidecar` installed,
/// in this priority order:
///
/// 1. The value passed in `env_override` (i.e. `KIBRARY_SIDECAR_PYTHON`)
/// 2. `~/.config/kibrary/python.json` cache (cross-platform)
/// 3. `python3` on PATH
/// 4. `python` on PATH
///
/// For each candidate the probe command is:
///   `<py> -c "import kibrary_sidecar; print(kibrary_sidecar.__version__)"`
///
/// On the first success a [`BootstrapResult`] is returned and (when the
/// winner was found via PATH rather than the env-var or cache) the result is
/// written back to the cache so subsequent launches are faster.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use tauri::State;

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
pub fn bootstrap_status(state: State<'_, BootstrapState>) -> serde_json::Value {
    match &state.result {
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

/// Attempt to install the bundled wheel by shelling out directly to pip.
///
/// **P2 stub** — returns an error.  The Bootstrap UI displays a friendly
/// "manual install required" message on this error, which is the intended
/// P2 behaviour.  A real implementation will be wired in P3.
#[tauri::command]
pub fn bootstrap_install_direct(
    _python_path: String,
    _wheel_path: String,
) -> Result<(), String> {
    Err("Automatic install is not yet implemented in this build. \
         Please install manually: python3 -m pip install kibrary-sidecar".to_string())
}
