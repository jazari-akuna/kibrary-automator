# Changelog

All notable changes to Kibrary are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning is **CalVer with semver-compatible suffixes**: `YY.M.D-alpha.N` (e.g. `26.4.26-alpha.1` = first alpha build of 2026-04-26). Pre-release counter goes in the `-alpha.N` suffix; bump it for additional builds the same day.

## [26.4.27-alpha.3] — 2026-04-27

### Fixed
- **Libraries / Settings rooms unreachable after picking a workspace folder.** Root cause: the FirstRunWizard renders as a `fixed inset-0 z-40` modal overlay; freshly picked folders always trigger first_run, and the wizard could not be completed because no KiCad install was pre-selected, so its "Get Started" button was disabled.
- **First-run wizard now auto-selects the first detected KiCad install.** A `createEffect` watches the `kicad.detect` resource; once a non-empty list resolves and no selection has been made, the first install becomes the chosen target.
- **Search-result thumbnails now render for real.** `search.raph.io` only allow-lists `http://localhost:3000` for CORS, so JS `fetch()` from the Tauri webview origin (`http://tauri.localhost`) silently failed preflight and `<AuthedThumbnail>` quietly errored into the grey fallback. Photo fetches now go through a new sidecar method `search.fetch_photo` that proxies the request server-side and returns a `data:` URL — no CORS, no Bearer header in the browser.

### Added
- **Per-item "✕" button on each queued LCSC** (`src/blocks/Queue.tsx`) backed by a new `dequeue(lcsc)` export.
- **"Clear queue" button** in the queue header — disabled when empty, nukes everything when clicked.
- **"Visit search.raph.io ↗" link** to the right of the SearchPanel header so users discover the source service.
- **Regression test suite** (`playwright/regressions.spec.ts`): one Playwright test per user-reported UI bug, all green. Boots the SolidJS app with a configurable Tauri-IPC mock and exercises the actual click flow.

## [26.4.27-alpha.2] — 2026-04-27

### Fixed
- **"Open folder…" button now opens the picker.** Tauri 2 silently denies plugin commands without explicit capability files; the missing `dialog:default` permission meant `dialog.open` rejected on every click. Added `src-tauri/capabilities/default.json` granting `core:default`, `dialog:default`, `updater:default`. `pickAndOpen()` now also surfaces errors via `console.error` instead of swallowing them.

### Changed
- **search.raph.io API key is now bundled with the app.** End users no longer see (or need) an API-key field in Settings. The key is XOR-obfuscated at build time, embedded in the Rust binary (`build.rs` + `embedded_secrets.rs`), and injected into the sidecar process via `KIBRARY_SEARCH_API_KEY`. The Tauri `sidecar_call` bridge intercepts `secrets.get`/`secrets.set` for that name and serves/swallows them locally so the keychain code path is never hit. Build with `KIBRARY_SEARCH_API_KEY=<key> pnpm tauri build` to bake your subscription in.

### Internal
- Untracked `sidecar/.build-venv/` so PyInstaller-modified pip stubs stop dirtying every screenshot regen.

## [26.4.27-alpha.1] — 2026-04-27

### Fixed
- **Search-result thumbnails now load.** The public `/api/parts/:lcsc/photo` endpoint moved under the auth-gated `/api/kibrary/` prefix, which a plain `<img src>` cannot authenticate against. Thumbnails are now fetched with the user's Bearer token and rendered via a `blob:` URL, with cleanup on result-list refresh.

## [26.4.26-alpha.1] — 2026-04-26

First alpha release. Combines what the development plans called P1 (MVP), P2 (Library Management), and P3 (polish).

### Added — main flow (Add room)
- Paste-based BOM/list import with auto-format detection (`C1525,2\nC25804,5` BOM vs `C1525, C25804, C9999` list)
- Parallel `JLC2KiCadLib` downloads with per-part status badges and one-click Retry
- Three review modes — sequential, pick, bulk-assign — switchable per-batch
- In-app property editor (Description / Reference / Value / Datasheet / Footprint) with debounced 400 ms autosave
- Read-only `kicanvas` symbol & footprint previews
- "Edit in KiCad" button that spawns the real eeschema/pcbnew editors with a file watcher that refreshes the in-app preview after save
- Optional `search.raph.io` integration with thumbnails + one-click `+ Add` to queue
- Library auto-suggestion from LCSC category (~40 categories → ~18 KSL libraries)
- Per-save git auto-commit with templated message and 30-second Undo toast (`git reset --hard HEAD~1`)
- KiCad install detection on Linux/Flatpak/macOS/Windows
- KiCad library table registration (`sym-lib-table` + `fp-lib-table`)

### Added — Library Management room
- 3-pane browser: library tree (with component counts) | searchable component list | detail pane
- Component operations: rename, move between libraries, delete — each with confirmation toast + Undo
- Bulk operations: select multiple, move/delete in batch
- "Re-export to KiCad" button registers all (or selected) libraries with the active KiCad install
- Library metadata editor (description / license / maintainer / version bumps)
- Per-component footprint thumbnails rendered with `kicad-cli fp export svg` at download time, with a "Render missing icons" backfill button for pre-existing libraries

### Added — sidecar bootstrap
- First-launch detection of Python + `kibrary_sidecar` availability
- Bundled Python sidecar via PyInstaller (single ~23 MB binary, no Python required on the user's system)
- Bootstrap UI for fallback installation: auto-install from bundled wheel, manual `pip install` instructions, or browse to a custom Python path
- Direct Rust→pip install (creates venv at `~/.local/share/kibrary/venv`, installs from bundled wheel, probes the version)

### Added — STEP 3D models
- `library.get_3d_info` returns the footprint's `(model …)` offset/rotation/scale via `kiutils`
- `Model3DPreview` renders that data as an info card (no fake placeholder cube)
- "View 3D in KiCad" button opens the footprint editor — press Alt+3 in KiCad for the real 3D viewer
- "Replace 3D model…" button — file picker filtered to .step/.stp/.wrl/.glb, copies the file into the lib's `.3dshapes/` folder, updates the footprint's `(model …)` line

### Added — security
- search.raph.io API key stored in the OS-native keychain (Keychain on macOS, Credential Manager on Windows, libsecret on Linux) via Python's `keyring` package — never written to settings.json
- Auto-migration: if an existing settings.json had `api_key` in plaintext, it is moved to the keychain on first read and stripped from disk

### Added — polish
- Light/dark theme toggle (Tailwind `dark:` variants), with pre-paint script to avoid flash, signal-driven persistence in localStorage with OS-preference fallback
- GitHub-releases auto-update via `tauri-plugin-updater` — non-modal banner, progress bar, one-click download + restart
- Per-workspace settings file (`.kibrary/workspace.json`) with git tracking config, KiCad target, concurrency
- First-run wizard (3 panes: workspace → KiCad install → git tracking)
- Toast notification system with auto-dismiss + action buttons

### Added — packaging
- Linux: AppImage, .deb, .rpm produced by `cargo tauri build`
- Linux: Flatpak manifest at `flatpak/io.raph.kibrary.yml` (build with `flatpak-builder`)
- macOS: ad-hoc signing (`signingIdentity: "-"`) — free, no Apple Developer Program. Users right-click → Open the first time.
- Windows: see `docs/SIGNING.md` for SignPath Foundation (free for OSS) or Azure Trusted Signing setup
- Auto-update infrastructure: minisign Ed25519 key + `latest.json` endpoint pointing at GitHub Releases
- AppImage GPG-signed for users who want to verify

### Architecture
- **Tauri 2** Rust shell (~15 MB system-webview binary)
- **SolidJS** + Tailwind frontend, organized as 22 lazy-loaded blocks via a registry
- **Python sidecar** (`kibrary_sidecar`, 41 RPC endpoints) communicating over JSON-RPC on stdin/stdout
- All app state in human-readable JSON files; no SQLite

### Tests & quality
- 155 sidecar pytest tests (parser, downloader, library ops, kiutils round-trip, git ops, kicad install detection, secrets, icons, etc.)
- `pnpm typecheck` clean
- `cargo check` clean

### Maintainer-only setup before publishing this tag
See `docs/SHIP-P2.md` for the full checklist. Two manual GitHub steps:

1. Add private signing keys to repo secrets (one-time): `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `GPG_PRIVATE_KEY`, `GPG_PASSPHRASE`. See `keys/README.md`.
2. Restore `.github/workflows/release.yml` from `docs/release-workflow.yml.example` using a credential with `workflow` scope.

[26.4.27-alpha.3]: https://github.com/jazari-akuna/kibrary-automator/releases/tag/v26.4.27-alpha.3
[26.4.27-alpha.2]: https://github.com/jazari-akuna/kibrary-automator/releases/tag/v26.4.27-alpha.2
[26.4.27-alpha.1]: https://github.com/jazari-akuna/kibrary-automator/releases/tag/v26.4.27-alpha.1
[26.4.26-alpha.1]: https://github.com/jazari-akuna/kibrary-automator/releases/tag/v26.4.26-alpha.1
