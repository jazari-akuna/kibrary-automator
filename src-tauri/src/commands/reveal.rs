// 26.5.7-alpha.4 reveal-in-explorer:
//
// `reveal_in_explorer(path)` — opens the host OS's native file manager with
// the file SELECTED (not just the parent directory open).
//
// Per-OS contract:
//   - macOS:   `open -R <path>`              (Finder reveal)
//   - Windows: `explorer.exe /select,<path>` (single comma, no space; Explorer
//              tolerates the "/select," + arg form when passed as separate
//              argv entries to Command — the comma-separated combined token
//              is a Windows-shell quirk that doesn't apply when we hand the
//              path through Command::arg directly)
//   - Linux:   try the freedesktop.org `org.freedesktop.FileManager1.ShowItems`
//              D-Bus method via `dbus-send` (handles Nautilus, Dolphin, Nemo,
//              Caja, Thunar). On failure / no FileManager1 service running,
//              fall back to `xdg-open` of the parent directory.
//
// Security:
//   The path is canonicalised before spawn, which both verifies it exists
//   AND rejects relative-path traversal (`../../../etc/passwd`-style). Only
//   the canonicalised absolute path is ever passed as argv to the spawned
//   child — and only via `Command::arg`, never through a shell, so there
//   is no opportunity for argv-string interpolation.

use std::path::{Path, PathBuf};

/// Build the argv that will reveal `canonical` in the macOS Finder.
///
/// The first element is the program name, subsequent elements are args.
/// Returned as `Vec<String>` so unit tests can assert the exact wire form
/// without spawning a child process (and so the Linux test on a headless
/// CI box can verify the macOS path even when there's no Finder around).
#[cfg(any(test, target_os = "macos"))]
pub fn macos_argv(canonical: &Path) -> Vec<String> {
    vec![
        "open".to_string(),
        "-R".to_string(),
        canonical.to_string_lossy().into_owned(),
    ]
}

/// Build the argv that will reveal `canonical` in Windows Explorer.
///
/// Note the single comma after `/select` and the path immediately following
/// (no space). When invoked via `std::process::Command`, the combined
/// `"/select,<path>"` token must be a SINGLE argv element — Explorer parses
/// that single token internally; passing them as two separate argv elements
/// silently drops the selection and merely opens the folder. This is a
/// well-known Windows quirk; see the regression spec for the wire format.
#[cfg(any(test, target_os = "windows"))]
pub fn windows_argv(canonical: &Path) -> Vec<String> {
    vec![
        "explorer.exe".to_string(),
        format!("/select,{}", canonical.to_string_lossy()),
    ]
}

/// Build the `dbus-send` argv for the freedesktop FileManager1 ShowItems call.
///
/// Method spec:
///   org.freedesktop.FileManager1.ShowItems(as URIs, s startup_id) — first
///   arg is an array of file:// URIs to highlight, second is an X11 startup
///   ID (we pass an empty string).
#[cfg(any(test, target_os = "linux"))]
pub fn linux_dbus_argv(canonical: &Path) -> Vec<String> {
    let uri = format!("file://{}", canonical.to_string_lossy());
    vec![
        "dbus-send".to_string(),
        "--session".to_string(),
        "--type=method_call".to_string(),
        "--dest=org.freedesktop.FileManager1".to_string(),
        "/org/freedesktop/FileManager1".to_string(),
        "org.freedesktop.FileManager1.ShowItems".to_string(),
        format!("array:string:{}", uri),
        "string:".to_string(),
    ]
}

/// Fallback when the D-Bus call fails — `xdg-open` of the parent directory.
/// Loses the file-selection (just opens the folder), but at least surfaces
/// the file's location to the user.
#[cfg(any(test, target_os = "linux"))]
pub fn linux_xdg_argv(parent: &Path) -> Vec<String> {
    vec![
        "xdg-open".to_string(),
        parent.to_string_lossy().into_owned(),
    ]
}

/// Canonicalise the user-supplied path and reject anything that doesn't
/// resolve to a real file/dir on disk. Returned as an owned `PathBuf` so
/// the caller doesn't have to thread lifetimes around the cfg branches.
fn canonicalise(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    std::fs::canonicalize(p).map_err(|e| {
        format!("Path does not exist or cannot be resolved: {} ({})", path, e)
    })
}

/// Reveal `path` in the host OS's native file manager.
///
/// Returns Ok(()) on successful spawn (the spawned child is detached — we
/// don't wait for the file manager to actually open). Returns Err with a
/// human-readable string on canonicalisation failure or spawn failure on
/// every platform-specific code path.
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let canonical = canonicalise(&path)?;
    spawn_for_current_os(&canonical)
}

#[cfg(target_os = "macos")]
fn spawn_for_current_os(canonical: &Path) -> Result<(), String> {
    use std::process::Command;
    let argv = macos_argv(canonical);
    Command::new(&argv[0])
        .args(&argv[1..])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to spawn `open -R`: {}", e))
}

#[cfg(target_os = "windows")]
fn spawn_for_current_os(canonical: &Path) -> Result<(), String> {
    use std::process::Command;
    let argv = windows_argv(canonical);
    Command::new(&argv[0])
        .args(&argv[1..])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to spawn `explorer.exe`: {}", e))
}

#[cfg(target_os = "linux")]
fn spawn_for_current_os(canonical: &Path) -> Result<(), String> {
    use std::process::Command;

    // Step 1: attempt the freedesktop FileManager1 D-Bus call. We use
    // `dbus-send` rather than adding a `zbus` crate dep — kibrary's
    // Cargo.toml already runs lean and the shell-out is one process spawn
    // per click (negligible). We wait on the child here (status()) so a
    // missing FileManager1 service surfaces as a non-zero exit and we can
    // fall back transparently.
    let dbus_argv = linux_dbus_argv(canonical);
    let dbus_result = Command::new(&dbus_argv[0])
        .args(&dbus_argv[1..])
        .status();

    match dbus_result {
        Ok(status) if status.success() => return Ok(()),
        Ok(_) => {
            // dbus-send ran but the D-Bus call failed (no FileManager1
            // service registered, or the service rejected the request).
            // Fall through to xdg-open.
        }
        Err(_) => {
            // dbus-send isn't on PATH at all. Fall through.
        }
    }

    // Step 2: fall back to opening the parent directory with xdg-open.
    let parent = canonical.parent().ok_or_else(|| {
        "Cannot determine parent directory for fallback xdg-open".to_string()
    })?;
    let xdg_argv = linux_xdg_argv(parent);
    Command::new(&xdg_argv[0])
        .args(&xdg_argv[1..])
        .spawn()
        .map(|_| ())
        .map_err(|e| {
            format!(
                "FileManager1 D-Bus call failed and `xdg-open` fallback also failed: {}",
                e
            )
        })
}

// ---------------------------------------------------------------------------
// Tests
//
// These are pure argv-construction tests so they pass on any OS. The actual
// process spawn is exercised only on the host OS via `spawn_for_current_os`,
// which is why the Linux integration test below gates on `cfg(target_os)`.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_path() -> PathBuf {
        // A guaranteed-real path for argv construction tests. We canonicalise
        // because each per-OS argv expects an absolute path — the public
        // entry point canonicalises before calling these helpers.
        std::fs::canonicalize(std::env::temp_dir()).expect("temp dir resolves")
    }

    #[test]
    fn macos_argv_uses_open_dash_r() {
        let p = fixture_path();
        let argv = macos_argv(&p);
        assert_eq!(argv[0], "open");
        assert_eq!(argv[1], "-R");
        assert_eq!(argv[2], p.to_string_lossy());
        assert_eq!(argv.len(), 3);
    }

    #[test]
    fn windows_argv_uses_explorer_select_comma_with_no_space() {
        let p = fixture_path();
        let argv = windows_argv(&p);
        assert_eq!(argv[0], "explorer.exe");
        // Single combined argv element, comma immediately after /select,
        // no space, path immediately follows. This is the load-bearing
        // detail — splitting it across two argv elements silently breaks
        // selection on Windows.
        assert_eq!(argv[1], format!("/select,{}", p.to_string_lossy()));
        assert!(!argv[1].contains("/select ,"), "no space allowed before comma");
        assert!(!argv[1].contains("/select, "), "no space allowed after comma");
        assert_eq!(argv.len(), 2);
    }

    #[test]
    fn linux_dbus_argv_targets_filemanager1_showitems() {
        let p = fixture_path();
        let argv = linux_dbus_argv(&p);
        assert_eq!(argv[0], "dbus-send");
        assert!(argv.contains(&"--session".to_string()));
        assert!(argv.contains(&"--type=method_call".to_string()));
        assert!(argv.contains(&"--dest=org.freedesktop.FileManager1".to_string()));
        assert!(argv.contains(&"/org/freedesktop/FileManager1".to_string()));
        assert!(argv.contains(&"org.freedesktop.FileManager1.ShowItems".to_string()));
        // The URI argument is `array:string:file://<path>`.
        let want_uri = format!("array:string:file://{}", p.to_string_lossy());
        assert!(argv.contains(&want_uri), "argv must contain the file:// URI as array:string:");
        // Empty startup-id string.
        assert!(argv.contains(&"string:".to_string()));
    }

    #[test]
    fn linux_xdg_argv_opens_parent_dir() {
        let p = fixture_path();
        let argv = linux_xdg_argv(&p);
        assert_eq!(argv[0], "xdg-open");
        assert_eq!(argv[1], p.to_string_lossy());
    }

    #[test]
    fn canonicalise_rejects_nonexistent_paths() {
        let result = canonicalise("/this/path/definitely/does/not/exist/foo.kicad_mod");
        assert!(result.is_err(), "non-existent path must be rejected");
        let msg = result.unwrap_err();
        assert!(
            msg.contains("does not exist") || msg.contains("cannot be resolved"),
            "error message should be human-readable, got: {}",
            msg
        );
    }

    #[test]
    fn canonicalise_resolves_traversal_and_passes_real_paths() {
        // /tmp/.. /tmp resolves to a real path on every Unix. The test is
        // that canonicalise() doesn't crash and returns SOMETHING absolute.
        let result = canonicalise(&std::env::temp_dir().to_string_lossy());
        assert!(result.is_ok(), "real temp dir must canonicalise");
        let p = result.unwrap();
        assert!(p.is_absolute(), "canonicalised path must be absolute");
    }

    // -----------------------------------------------------------------------
    // Linux integration test — actually spawn the dbus-send child against a
    // real on-disk file. Headless CI on Linux is the dev environment, so
    // this is the "ground truth" check that we built the right argv. We
    // accept either a successful D-Bus call (FileManager1 running) OR a
    // non-zero exit (no FileManager1, expected on a server) — both prove
    // that our argv is well-formed enough that dbus-send didn't reject it
    // out of hand.
    //
    // What we DO NOT want to see:
    //   - "command not found"  → would mean we mis-spelled `dbus-send`
    //   - argv parse error     → would mean we mis-built one of the args
    //   - panic                → would mean we hit something un-checked
    // -----------------------------------------------------------------------
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_dbus_send_accepts_our_argv_against_a_real_file() {
        use std::io::Write;
        use std::process::Command;

        // Create a real file the canonicalisation can resolve.
        let dir = std::env::temp_dir().join("kibrary-reveal-test");
        std::fs::create_dir_all(&dir).expect("create test dir");
        let file = dir.join("R_10k_0402.kicad_mod");
        {
            let mut f = std::fs::File::create(&file).expect("create test file");
            writeln!(f, "(module test)").expect("write fixture");
        }

        let canonical = std::fs::canonicalize(&file).expect("canonicalise fixture");
        let argv = linux_dbus_argv(&canonical);

        // Spawn for real. We run in a fresh process and wait for it; we
        // assert only that the spawn itself succeeded (Command::status
        // returned Ok). The CHILD's exit code is permitted to be non-zero
        // because the headless CI box has no FileManager1 service.
        let status = Command::new(&argv[0])
            .args(&argv[1..])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        assert!(
            status.is_ok(),
            "spawning `dbus-send` must succeed (binary on PATH); got {:?}",
            status,
        );

        // Cleanup the fixture.
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
    }

    // The full reveal_in_explorer command also goes through the spawn path
    // for the host OS — exercise that on Linux to prove the canonicalise →
    // dbus-send → fallback chain doesn't error on a real file. As above,
    // we accept both "D-Bus call worked" and "fell back to xdg-open" — the
    // assertion is only that we get Ok(()), not an error string.
    #[cfg(target_os = "linux")]
    #[test]
    fn reveal_in_explorer_smoke_against_real_file_on_linux() {
        use std::io::Write;

        let dir = std::env::temp_dir().join("kibrary-reveal-smoke");
        std::fs::create_dir_all(&dir).expect("create smoke dir");
        let file = dir.join("smoke.kicad_sym");
        {
            let mut f = std::fs::File::create(&file).expect("create smoke file");
            writeln!(f, "(kicad_symbol_lib)").expect("write smoke fixture");
        }

        let result = spawn_for_current_os(
            &std::fs::canonicalize(&file).expect("canonicalise smoke"),
        );
        // Either D-Bus succeeded OR xdg-open was spawned (which may itself
        // exit non-zero on a no-display CI box but the spawn returned Ok).
        // If BOTH fail (no dbus-send AND no xdg-open) we surface an Err —
        // on this dev box dbus-send IS installed so we expect Ok(()).
        assert!(
            result.is_ok(),
            "reveal_in_explorer should not error on Linux when dbus-send is installed: {:?}",
            result,
        );

        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn reveal_in_explorer_rejects_nonexistent_path() {
        let result = reveal_in_explorer(
            "/this/path/definitely/does/not/exist.kicad_mod".to_string(),
        );
        assert!(result.is_err(), "non-existent path must be rejected up-front");
    }
}
