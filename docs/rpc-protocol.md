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
- `library.commit(workspace: str, lcsc: str, staging_dir: str, target_lib: str, edits: dict)` → `{ committed_path: str, git_sha: str | null }` — runs `git_ops.auto_commit` automatically when workspace.json's `git.auto_commit` is true; there is no separate `git.commit` RPC.
- `parts.read_props(sym_path: str)` → `{ properties: { Reference, Value, Footprint, Datasheet, Description, ... } }`
- `parts.write_props(sym_path: str, edits: dict)` → `{ ok: true }`
- `parts.read_file(staging_dir, lcsc, kind)` → `{ content: str }` where kind ∈ {"sym","fp","3d"}
- `parts.list_dir(staging_dir, lcsc, subdir?)` → `{ files: [str] }`
- `library.suggest(category: str)` → `{ library: str }`
- `git.init(workspace)` / `git.is_safe(workspace)` / `git.undo_last(workspace, expected_sha)`
- `kicad.detect()` / `kicad.refresh()` → `{ installs: [...] }`
- `kicad.register(install: dict, lib_name: str, lib_dir: str)` → `{ sym_added: bool, fp_added: bool, backup_path: str | None }`
- `kicad.unregister(install, lib_name)` / `kicad.list_registered(install)`
- `editor.open(workspace, staging_dir, lcsc, kind)` → `{ pid: int }` — kind ∈ {"symbol","footprint"}; resolves the active KiCad install and spawns the right editor binary
- `workspace.set_settings(root, settings)` → `{ ok: true }`
- `search.query(q: str)` / `search.get_part(lcsc)` (P1: only when search.raph.io API key is set)
