# Sidecar RPC protocol (v1)

Transport: line-delimited JSON over the sidecar's stdin (requests) and
stdout (responses). One JSON object per line. The sidecar's stderr is for
human-readable logs only.

## Request envelope
{ "id": 42, "method": "namespace.action", "params": { ... } }

## Success response
{ "id": 42, "ok": true, "result": { ... } }

## Error response
{ "id": 42, "ok": false, "error": { "code": "STRING", "message": "..." } }

## Notification (sidecar → Rust, no response expected)
{ "event": "namespace.event", "params": { ... } }

## Methods (P1)
- `system.ping` → `{ pong: true }`
- `system.version` → `{ version: "0.1.0" }`
- `parts.parse_input(text: str)` → `{ rows: [{lcsc, qty, ok, error?}], format: "bom"|"list" }`
- `parts.download(lcscs: list[str], staging_dir: str, concurrency: int)` →
   notifications: `download.progress`, `download.done`
- `parts.read_meta(staging_dir: str, lcsc: str)` → `{ meta: ... }`
- `parts.write_meta(staging_dir: str, lcsc: str, meta: ...)` → `{ ok: true }`
- `library.commit(workspace: str, lcsc: str, target_lib: str, edits: ...)` → `{ committed_path: str }`
- `git.commit(workspace: str, message: str, paths: list[str])` → `{ sha: str }`
- `kicad.detect()` → `{ installs: [...] }`
- `kicad.register(install_id: str, lib_name: str, lib_dir: str)` → `{ ok: true }`
- `search.query(q: str)` → `{ results: [...] }` (P1: only if API key set)
