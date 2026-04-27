use anyhow::{anyhow, Result};
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

use crate::protocol::{Notification, Request, Response};
use crate::APP_HANDLE;

/// Build a [`Command`] that spawns the sidecar with `KIBRARY_SEARCH_API_KEY`
/// injected.  Centralised so both the bundled-binary and Python-fallback
/// spawn paths share the *exact* same env-injection logic — the recurring
/// "thumbnails don't load" bug was previously caused by the env var being
/// silently empty for one path; sharing a builder makes that impossible to
/// regress without touching this function.
///
/// Logs the embedded key length to stderr (never the key itself) so users
/// can self-diagnose builds that were performed without the build-time
/// `KIBRARY_SEARCH_API_KEY` env var.
fn build_command(program: &str, args: &[&str]) -> Command {
    let key = crate::embedded_secrets::search_api_key();
    eprintln!(
        "[bootstrap] embedded search key length: {} (spawning {})",
        key.len(),
        program
    );
    let mut cmd = Command::new(program);
    if !args.is_empty() {
        cmd.args(args);
    }
    cmd.env("KIBRARY_SEARCH_API_KEY", key)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

pub struct Sidecar {
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>,
    next_id: AtomicU64,
    _child: Child,
}

impl Sidecar {
    /// Wire up stdin/stdout/stderr I/O for an already-spawned child process.
    ///
    /// Shared by [`spawn_binary`] and [`spawn`] so the reader loop, the
    /// stderr-forwarding loop, and the pending-map logic live in exactly
    /// one place.
    ///
    /// Stderr forwarding is required for two reasons:
    ///   1. Diagnostic output (`[sidecar] startup …`, `[sidecar] fetch_photo …`)
    ///      from `kibrary_sidecar/__main__.py` and `methods.py` would otherwise
    ///      vanish into a piped pipe nobody reads.  When users report
    ///      "thumbnails don't load", `kibrary 2>&1 | grep \[sidecar\]` is
    ///      now the one-liner that proves whether the env var got through.
    ///   2. A piped-but-unread stderr deadlocks the child once the pipe
    ///      buffer fills (~64 KiB on Linux).  This wasn't biting yet but
    ///      a single noisy `print()` in any handler would have caused it.
    fn wire(mut child: Child) -> Result<Self> {
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| anyhow!("no stderr"))?;

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_for_reader = pending.clone();

        // stdout reader → JSON-RPC responses + Tauri notifications.
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if let Ok(resp) = serde_json::from_str::<Response>(&line) {
                    if let Some(tx) = pending_for_reader.lock().await.remove(&resp.id) {
                        let _ = tx.send(resp);
                    }
                } else if let Ok(n) = serde_json::from_str::<Notification>(&line) {
                    if let Some(handle) = APP_HANDLE.get() {
                        use tauri::Emitter;
                        let _ = handle.emit(&n.event, n.params);
                    }
                }
            }
        });

        // stderr drain → forward to our own stderr with a `[sidecar]` prefix
        // (or pass-through if the line is already prefixed).  This both
        // surfaces diagnostics and prevents the pipe from filling.
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if line.starts_with("[sidecar]") {
                    eprintln!("{line}");
                } else {
                    eprintln!("[sidecar:stderr] {line}");
                }
            }
        });

        Ok(Self {
            stdin: Arc::new(Mutex::new(stdin)),
            pending,
            next_id: AtomicU64::new(1),
            _child: child,
        })
    }

    /// Spawn the sidecar from a pre-built PyInstaller binary.
    ///
    /// The binary must accept JSON-RPC requests on stdin and emit responses on
    /// stdout — identical protocol to the Python `-m kibrary_sidecar` path.
    pub async fn spawn_binary(binary_path: &str) -> Result<Self> {
        let child = build_command(binary_path, &[]).spawn()?;
        Self::wire(child)
    }

    /// Spawn the sidecar via Python module invocation (development / fallback path).
    pub async fn spawn(python_path: &str, module: &str) -> Result<Self> {
        let child = build_command(python_path, &["-m", module]).spawn()?;
        Self::wire(child)
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let req = Request { id, method: method.into(), params };
        let mut line = serde_json::to_string(&req)?;
        line.push('\n');
        self.stdin.lock().await.write_all(line.as_bytes()).await?;
        self.stdin.lock().await.flush().await?;

        let resp = rx.await?;
        if resp.ok {
            Ok(resp.result.unwrap_or(Value::Null))
        } else {
            let e = resp.error.unwrap();
            Err(anyhow!("{}: {}", e.code, e.message))
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// These tests pin down the env-injection contract that the user-visible
// "thumbnails don't load" bug kept regressing.  They DO NOT mock the
// Command builder — they spawn a real `/bin/sh -c 'echo $KIBRARY_SEARCH_API_KEY'`
// child and assert the value the child *actually* received.  Equivalent
// behaviour from the user's POV: if this test passes, search.fetch_photo
// will see the key on the Python side too.
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn build_command_propagates_search_api_key_to_child() {
        // build_command reads `embedded_secrets::search_api_key()`.  In tests
        // that returns whatever was XOR-baked at build time.  If the test
        // harness build was performed without the env var, the embedded
        // value is empty — still fine: we just assert that whatever Rust
        // thinks the key is, the child observes the same string.
        let expected = crate::embedded_secrets::search_api_key();

        let mut cmd = build_command(
            "/bin/sh",
            &["-c", "printf %s \"$KIBRARY_SEARCH_API_KEY\""],
        );
        let mut child = cmd.spawn().expect("spawn /bin/sh");
        let mut stdout = child.stdout.take().unwrap();
        let mut buf = String::new();
        stdout.read_to_string(&mut buf).await.unwrap();
        let _ = child.wait().await;

        assert_eq!(
            buf, expected,
            "Child KIBRARY_SEARCH_API_KEY ({:?}) did not match \
             embedded_secrets::search_api_key() ({:?}) — Command::env() \
             is no longer propagating to the spawned process. \
             This is the alpha.3 thumbnail-load bug regressing.",
            buf, expected
        );
    }

    #[tokio::test]
    async fn build_command_sets_pipes_for_jsonrpc() {
        // Sanity: stdin/stdout/stderr must all be piped, otherwise wire()
        // panics with "no stdin" / "no stdout" / "no stderr".  This guards
        // against someone refactoring build_command and dropping a pipe.
        let mut cmd = build_command("/bin/sh", &["-c", "exit 0"]);
        let mut child = cmd.spawn().expect("spawn");
        assert!(child.stdin.is_some(), "stdin must be piped");
        assert!(child.stdout.is_some(), "stdout must be piped");
        assert!(child.stderr.is_some(), "stderr must be piped");
        let _ = child.wait().await;
    }
}
