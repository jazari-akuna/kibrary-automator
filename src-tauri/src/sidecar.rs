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

pub struct Sidecar {
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>,
    next_id: AtomicU64,
    _child: Child,
}

impl Sidecar {
    pub async fn spawn(python_path: &str, module: &str) -> Result<Self> {
        let mut child = Command::new(python_path)
            .args(["-m", module])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_for_reader = pending.clone();

        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if let Ok(resp) = serde_json::from_str::<Response>(&line) {
                    if let Some(tx) = pending_for_reader.lock().await.remove(&resp.id) {
                        let _ = tx.send(resp);
                    }
                } else if let Ok(_n) = serde_json::from_str::<Notification>(&line) {
                    // Notifications handled in Task 16; no-op for now
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
