# Changelog

All notable changes to Kibrary are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning is **CalVer with semver-compatible suffixes**: `YY.M.D-alpha.N` (e.g. `26.4.26-alpha.1` = first alpha build of 2026-04-26). Pre-release counter goes in the `-alpha.N` suffix; bump it for additional builds the same day.

## [26.4.27-alpha.11] — 2026-04-27

### Fixed
- **Queue rows now actually flip from `downloading` → `ready` when a download completes.** alpha.10 (and earlier) relied entirely on `download.progress` Tauri events emitted by the sidecar to drive the UI's terminal status. The new real-UI smoke test caught a row stuck at `downloading` for 240 s even though `C25804.kicad_sym` was on disk in <30 s — the events were silently lost between `sidecar.rs`'s `handle.emit()` and the webview's `listen('download.progress', …)` registration (a top-of-module subscribe race that the smoke surfaced reliably). This is almost certainly what users hit as "Download all does nothing" through alpha.7-9: the download did run and files did land, but the UI never reflected it. Fixed in `Queue.tsx` by treating the `parts.download` JSON-RPC **response** as the source of truth for terminal status (`{results: {<lcsc>: {ok, error}}}`) — the row flips the moment the await resolves, regardless of whether progress notifications arrived. Notifications stay as nice-to-have mid-download progress updates.

### Added
- **`scripts/smoke-ui.sh` + `Dockerfile.smoke-ui`: a real-**UI** integration test.** Spins up Ubuntu 24.04 + the kicad-9.0 PPA + Xvfb + tauri-driver + WebKitWebDriver, installs the freshly-built `.deb`, then drives the **real bundled app** through the full Add-room flow: workspace open → Detect (auto-enqueue) → Download all → assert `data-status="ready"` on the queue row → assert `<staging>/C25804/C25804.kicad_sym` ≥ 100 bytes. Caught the alpha.10 stuck-status bug that `smoke-real` could not (smoke-real exercises only the sidecar's JSON-RPC response, not the webview's event-listener path). `scripts/release.sh` now runs this gate after `smoke-real` and refuses to publish on failure. The spec uses a plain Node WebDriver client because WDIO 9's W3C capability format is incompatible with tauri-driver 2.0.5.
- **`window.__kibraryTest` testability hook in `src/state/workspace.ts`** — exposes `openWorkspace` so the smoke can update the SolidJS workspace signal without touching the native file dialog (which can't be driven headlessly), plus an `armProgressCapture` probe for diagnosing event-channel issues.

## [26.4.27-alpha.10] — 2026-04-27

### Fixed
- **"Download all" no longer silently does nothing on an empty queue.** The Add room's flow used to require three clicks: type LCSC → click **Detect** → click **Queue all** → click **Download all**. Users (reasonably) skipped the middle step, so "Download all" found an empty queue and was disabled, which the button rendered as a faintly grayed-out widget that looked clickable but no-op'd silently. Now: (1) **Detect auto-enqueues** every valid row immediately so a single click is enough; (2) **the Download-all button stays clickable** even when the queue is empty and surfaces a toast — `Queue is empty — paste LCSC codes above and click Detect.` — instead of doing nothing; (3) a `[Queue] dispatching parts.download {…}` console log is emitted so future bug reports can be traced through DevTools without re-instrumenting.
- **Post-update restart now asks the user to quit + relaunch manually.** alpha.7-alpha.9 used `relaunch()` from `@tauri-apps/plugin-process` after install — but the Rust crate isn't installed and the plugin isn't registered, so the call always failed silently. The new flow: install completes → banner says "Update installed. Quit Kibrary and re-open it to apply." → "Quit Kibrary" button calls a small `quit_app` Tauri command (`app.exit(0)`). This avoids the polkit/X11/WebKit transition mess of trying to fork+exec from a process whose binary just got dpkg-replaced. Same change in Settings → Updates card.

## [26.4.27-alpha.9] — 2026-04-27

### Fixed
- **Footprint icons now actually render after `Download all`.** `kicad-cli fp export svg` accepts `--output` (or `-o`); we'd been passing `--output-dir` since day one, so KiCad 9.0 rejected every invocation with `Unknown argument: --output-dir` and exit 1. The error was caught by `render_for_part`'s `except Exception → log.warning` so the sidecar download still reported `ok:true`, but the UI surfaced the missing icon as a download failure for the user. Caught only after alpha.8 because no existing test exercised the real `kicad-cli` — mocks accepted whatever flag we passed.

### Added
- **`scripts/smoke-real.sh` + `Dockerfile.smoke-real`: a real-RPC integration test.** Spins up Ubuntu 24.04 + the official kicad-9.0 PPA + the freshly-built sidecar binary, then exercises `parts.download` + `parts.read_file` against the **real JLCPCB network** for two structurally different parts (C25804 — passive 0603; C193707 — IC LGA-48 with dots/dashes in the footprint name). Verifies on-disk file layout, icon SVG sizes, and RPC content lengths. **`scripts/release.sh` runs this against the freshly-built `.deb` before publishing the GitHub release** — any failure aborts the release. This is the test infrastructure that should have existed before alpha.5 and would have caught alpha.6 (file layout), alpha.7-class issues, and alpha.8 (icon flag).

## [26.4.27-alpha.8] — 2026-04-27

### Fixed
- **Auto-updater now actually installs the new release.** alpha.7 downloaded the update but never installed it on .deb-based systems (every Linux user, since .deb is the primary distribution). Root cause: `tauri-plugin-updater` searches `latest.json` for `<os>-<arch>-<installer>` first (e.g. `linux-x86_64-deb`) before falling back to `<os>-<arch>`. We were only publishing the fallback, with the AppImage URL. The .deb-installed binary's `bundle_type=Deb` makes it call `install_deb(bytes)`, which calls `infer::archive::is_deb(bytes)` — that returns `false` for AppImage bytes, prints a `"update is not a valid deb package"` warning, and silently returns. No UI error.
  Fixed by publishing per-installer platform entries: `linux-x86_64-deb` → .deb URL + .deb.sig, `linux-x86_64-appimage` → AppImage URL + AppImage.sig, `linux-x86_64-rpm` → .rpm URL + .rpm.sig, plus the original `linux-x86_64` fallback.
  Empirically verified end-to-end: downloaded .deb URL has correct `!<arch>\n` magic, `dpkg -i` installs cleanly inside a fresh Ubuntu 24.04 container (`Setting up kibrary (26.4.27-alpha.7) ...`), and `dpkg -l` confirms the package version is now the new one.
- **`scripts/release.sh` verify step now asserts all four installer platform keys are present** in the published `latest.json` and refuses to proceed if any are missing. This prevents the alpha.7-class bug from ever silently shipping again.

## [26.4.27-alpha.7] — 2026-04-27

### Fixed
- **"Download all" actually puts files where the frontend expects them.** alpha.6 fixed the "JLC2KiCadLib not found" bundle issue, but the downloaded files landed at deeply nested wrong paths like `<staging>/C25804/tmp/staging/C25804/0603WAF1002T5E.kicad_sym`, named after the part's MPN instead of the LCSC code. Two stacked bugs:
  1. JLC2KiCadLib treats `symbol_lib_dir`/`footprint_lib`/`model_dir` as **relative to** `output_dir` even when given absolute paths — passing the absolute staging dir for both concatenated the path onto itself.
  2. JLC2KiCadLib names the symbol library file after `symbol_lib` (an arg we'd left blank), and drops .step files inside the .pretty footprint dir.
  Fixed by setting `symbol_lib=<lcsc>`, `symbol_lib_dir="."`, `footprint_lib="<lcsc>.pretty"`, `model_dir="."`, plus a post-processing pass that moves `*.step`/`*.wrl` from the .pretty dir into `<lcsc>.3dshapes/`. End-to-end verified against the real bundled binary downloading C25804: produces `<staging>/C25804/{C25804.kicad_sym, C25804.pretty/R0603.kicad_mod, C25804.3dshapes/R0603.step}`. Symbol + footprint preview RPCs now return real content (1516 bytes / 2407 bytes for C25804). Regressions: `test_build_args_uses_relative_paths_to_avoid_self_nesting`, `test_move_3d_models_relocates_step_and_wrl`, `test_move_3d_models_no_op_when_pretty_missing`.
- **Release script no longer publishes broken `latest.json`.** Two bugs caught by alpha.6:
  1. `gh release create <file>#<label>` does not rename — the suffix is a display label, not a filename. Writing latest.json via `mktemp` plus `#latest.json` produced an asset named `tmp.VMEpJHcBgO`. Fixed: use `mktemp -d` + write the file as `<dir>/latest.json`.
  2. The endpoint verify step used `curl -sILo /dev/null -L` (HEAD with redirects) which returns 404 on the GitHub release-asset CDN's final hop, even though GET returns 200. Tauri-updater uses GET, so the script does too now.

## [26.4.27-alpha.6] — 2026-04-27

### Fixed
- **Workspace now actually opens on launch.** The header showed the recent workspace path but the app stayed on the workspace picker because no `onMount` in `Shell.tsx` was calling `openWorkspace(recents()[0])`. Now the most-recent workspace is restored automatically once the sidecar is ready; if the path is gone or open fails, the picker is shown as a fallback. Regression: `bug 8 — last workspace auto-opens on launch`.
- **Component view now actually previews symbol / footprint files.** `ComponentDetail.tsx` was passing `stagingDir = libDir` to the preview blocks, whose `parts.read_file` RPC expects the staging layout (`<staging>/<lcsc>/<lcsc>.kicad_sym`). Library files live at `<lib_dir>/<lib_name>.kicad_sym` + `<lib_dir>/<lib_name>.pretty/<comp>.kicad_mod`. Preview blocks now accept a dual-mode prop (`stagingDir`/`lcsc` OR `libDir`/`componentName`) and library mode hits a new sidecar RPC `library.read_file_content` that slices a single symbol out of the merged `.kicad_sym` via kiutils. Regression: `bug 11 — symbol preview renders for committed component`.
- **3D model now has full position / rotation / scale controls** instead of just a Replace button. KiCad has no CLI flag to launch its 3D Model Properties dialog directly, so a new in-app `Model3DPositioner` block exposes 9 number inputs (XYZ for offset / rotation / scale) plus Reset and Save. Save calls a new RPC `library.set_3d_offset` that round-trips the first `(model …)` block through `kiutils.Footprint.from_file/.to_file`. Regression: `bug 12 — 3D positioner inputs are editable + Save fires the right RPC`.
- **"Download all" now actually downloads.** The bundled binary was failing silently with `FileNotFoundError: [Errno 2] No such file or directory: 'JLC2KiCadLib'` because PyInstaller's `--collect-all JLC2KiCadLib` bundles the package but **not** the console-script shim — `shutil.which("JLC2KiCadLib")` returned nothing, and the `subprocess.run(...)` blew up before any progress event could fire. `jlc.py` now drives JLC2KiCadLib via its Python API (`add_component()`) with the CLI as a dev-only fallback. The Add room now also surfaces RPC failures via toast, shows `Downloading… (N of M)` on the button while in flight, and renders a per-row progress bar. Regressions: `bug 13/14/15`.

### Added
- **Settings → Versions card.** Shows the Frontend version (compile-time `__APP_VERSION__` from package.json via Vite `define:`), the Tauri shell version (new `app_version` Tauri command reading `app.package_info().version`), and the Python sidecar version (existing `system.version` RPC).
- **Settings → Updates card.** Manual "Check for updates" button driving `checkForUpdate` / `installAndRestart`, with explicit idle / checking / up-to-date / available / installing / error states. Regressions: `bug 9 — Settings shows three versions`, `bug 10 — Settings has Check-for-updates button`.
- **Per-part download progress events** wired from JLC2KiCadLib's internal phase callbacks (0 dispatched → 10 fetching symbol → 70 fetching footprint+3D → 100 done). The 0 and 100 endpoints are synthesised in `downloader.py` because the library only emits at phase boundaries. The frontend `Queue` block now listens for the `progress` field on `download.progress` events and renders a per-row bar.
- **Sidecar tests:** 5 new `test_files.py` tests for `read_library_file` (sym slice / sym missing / fp text / fp missing / invalid kind), 3 new `test_model3d_ops.py` tests for `set_3d_offset` (round-trip / no-model error / missing-mod error), 5 new `test_jlc.py` tests (API path / progress callbacks / error contract / `_resolve_binary` contract / no-API-no-CLI fallback).

## [26.4.27-alpha.5] — 2026-04-27

### Fixed
- **"Visit search.raph.io" pill button now actually opens the URL.** Tauri 2 webviews ignore `target="_blank"` on plain `<a>` tags; the click is now wired through `@tauri-apps/plugin-shell`'s `open()`. The shell plugin Rust dep, JS dep, plugin registration, and `shell:allow-open` capability are all in place.

### Added
- **Pre-fills the user's current query in the URL.** Typing `esp32` in the search box and clicking the pill button now opens `https://search.raph.io/?q=esp32` (URL-encoded), not the bare base URL.

### Performance
- **~5× faster thumbnail loading.** The sidecar's RPC dispatcher was a single-threaded `for raw in sys.stdin` loop, so each `search.fetch_photo` waited on the previous one. Replaced with a `ThreadPoolExecutor` (8 workers, configurable via `KIBRARY_SIDECAR_WORKERS`). 5 sequential 200 ms calls dropped from ~1000 ms to ~202 ms. Stdout writes were already serialised by `_stdout_lock` so the change was a drop-in.
- **Module-scoped `httpx.Client`** in `search_client.py` reuses a connection pool across photo fetches — no more per-call TLS handshake.
- **256-entry LRU cache** on `fetch_photo` (sidecar side) — re-typing a query that resolves to the same LCSCs returns cached `data:` URLs instantly.
- **Frontend in-flight Promise dedup** — concurrent `<AuthedThumbnail>` instances for the same LCSC share one IPC call instead of firing N parallel requests.
- **Regression test `bug 7 — multiple thumbnails load in parallel`** asserts 5 thumbnails render within 500 ms (serial dispatch would take ≥1000 ms and fail).

## [26.4.27-alpha.4] — 2026-04-27

### Fixed
- **Sidecar stderr is now drained and forwarded with `[sidecar:stderr]` / `[sidecar]` prefixes.** Previously the pipe was opened but never read — diagnostic `print()`s vanished, and a single noisy handler would have eventually deadlocked the child once the 64 KiB pipe buffer filled. This was the missing observability that made every "thumbnails don't load" report a guessing game.
- **`__version__` no longer hardcodes `26.4.26-alpha.1`.** Resolved at runtime from `importlib.metadata` with a `pyproject.toml` fallback so the bundled binary's `system.version` reflects the build it shipped in.

### Added
- **Bootstrap log line: `[bootstrap] embedded search key length: <N> (spawning <path>)`.** Prints once per sidecar spawn so a build performed without `KIBRARY_SEARCH_API_KEY` shows `length: 0` immediately at startup.
- **Sidecar startup line: `[sidecar] startup version=… KIBRARY_SEARCH_API_KEY=set key_len=<N>`.** Confirms the env var crossed the Rust→Python boundary.
- **Per-fetch line: `[sidecar] search.fetch_photo lcsc='<C…>' api_key_len=<N>`.** Lets `kibrary 2>&1 | grep '\[sidecar\]'` pinpoint which side of the boundary failed for any specific thumbnail.
- **Visible error indicator** in `<AuthedThumbnail>` — a small red `!` with `title="<error message>"` when `fetch_photo` returns an `error`. Distinguishes "no photo for this part" (silent) from "the request failed" (red badge).
- **Unified `build_command()` helper** in `src-tauri/src/sidecar.rs`: both `spawn_binary` and `spawn` now go through one place that injects `KIBRARY_SEARCH_API_KEY`. Two new Rust unit tests (`build_command_propagates_search_api_key_to_child`, `build_command_sets_pipes_for_jsonrpc`) pin the env-injection contract — refactoring it without `.env(...)` will now fail compilation tests, not silently break thumbnails.
- **Polished pill button** for the "Visit search.raph.io" link in the SearchPanel header — rounded, soft shadow, external-link icon, emerald hover accent.
- **Screenshot mock** updated to handle the new `search.fetch_photo` IPC method so README screenshots actually render product photos again.

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

[26.4.27-alpha.5]: https://github.com/jazari-akuna/kibrary-automator/releases/tag/v26.4.27-alpha.5
[26.4.27-alpha.4]: https://github.com/jazari-akuna/kibrary-automator/releases/tag/v26.4.27-alpha.4
[26.4.27-alpha.3]: https://github.com/jazari-akuna/kibrary-automator/releases/tag/v26.4.27-alpha.3
[26.4.27-alpha.2]: https://github.com/jazari-akuna/kibrary-automator/releases/tag/v26.4.27-alpha.2
[26.4.27-alpha.1]: https://github.com/jazari-akuna/kibrary-automator/releases/tag/v26.4.27-alpha.1
[26.4.26-alpha.1]: https://github.com/jazari-akuna/kibrary-automator/releases/tag/v26.4.26-alpha.1
