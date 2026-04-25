# Shipping P2 (v0.2.0)

Library Management room + sidecar bootstrap + STEP browse/replace + GitHub-releases auto-update + per-platform signing.

## Pre-release verification

- [ ] `cd sidecar && .venv/bin/pytest tests/ -v` → 142+/142+ green
- [ ] `pnpm typecheck` → clean
- [ ] `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo check` → clean
- [ ] Smoke test on a real workspace:
  - [ ] Switch to Libraries room — see all `_KSL` libs with component counts
  - [ ] Pick a library — component list populates with descriptions
  - [ ] Pick a component — symbol/footprint/3D previews render in detail pane
  - [ ] ✎ inline button opens the rename modal
  - [ ] 🗑 inline button opens the delete modal
  - [ ] Bulk select 2+ components, click Move… — modal allows picking a target lib
  - [ ] Re-export button registers libs with KiCad (verify entries in `sym-lib-table`)
  - [ ] In Add room: ✎ Edit in KiCad on a staged part opens the right editor; saving in KiCad refreshes the in-app preview within 2s
  - [ ] Replace 3D model button on a staged or library component opens the file picker, copies the file, updates the footprint's (model ...) line
  - [ ] First-run on a fresh workspace shows the wizard
  - [ ] If sidecar is missing (test by setting `KIBRARY_SIDECAR_PYTHON=/nonexistent`), the Bootstrap UI appears with the three install modes

## One-time secret/cert setup (required before tagging)

These steps require maintainer credentials and cannot be automated:

### Tauri updater Ed25519 signing key — **DONE**
- [x] Generated at `keys/kibrary-updater.key` (private, gitignored) + `keys/kibrary-updater.key.pub` (public, in repo).
- [x] Public key already pasted into `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
- [ ] **Add to GitHub repo secrets** (one-time, in the GH UI):
  - `TAURI_SIGNING_PRIVATE_KEY` = full contents of `keys/kibrary-updater.key`
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = empty string (key has no passphrase)

### GPG key for AppImage signing — **DONE**
- [x] Generated at `keys/appimage-signing-private.asc` (private, gitignored) + `keys/appimage-signing-public.asc` (public, in repo).
- [x] Identity: `Kibrary Release Signing <raphaelcasimir.inge@gmail.com>`, fingerprint `ED37847C4ED3376CA28546538E0FDC9F2E542C63`, no passphrase, 2-year expiry.
- [ ] **Add to GitHub repo secrets**:
  - `GPG_PRIVATE_KEY` = full contents of `keys/appimage-signing-private.asc`
  - `GPG_PASSPHRASE` = empty string

### macOS signing — none required (ad-hoc)
- [x] `tauri.conf.json` already has `bundle.macOS.signingIdentity: "-"` (ad-hoc).
- [x] No Apple Developer Program enrollment needed; no annual fee.
- [ ] Document the user-facing first-launch step in release notes: "right-click → Open" the first time, OR `xattr -d com.apple.quarantine` for browser-downloaded copies.
- See `docs/SIGNING.md` for the full rationale.

### Windows signing (recommended path: SignPath Foundation, free for OSS)
- [ ] Apply at https://signpath.io/solutions/open-source-community
- [ ] Wait for approval (typically a few weeks)
- [ ] Once approved, add the SignPath GitHub Action to `.github/workflows/release.yml` (replace the basic Windows signing step). See SignPath's docs for the exact action snippet.
- [ ] Alternative if SignPath is too slow: Azure Trusted Signing (~$120/yr) — see `docs/SIGNING.md` for config.

### Linux distribution — Flatpak manifest **DONE**
- [x] Flatpak manifest at `flatpak/io.raph.kibrary.yml` with permissions: home filesystem (workspaces), network (search.raph.io / JLC2KiCadLib), wayland/x11/dri (display), `org.freedesktop.secrets` (keychain), `org.freedesktop.Flatpak` (KiCad handoff via flatpak-spawn).
- [x] Companion `.desktop` and `.metainfo.xml` files written.
- [ ] Build locally to test:
  ```bash
  flatpak install --user flathub org.gnome.Platform//47 org.gnome.Sdk//47
  flatpak-builder --user --force-clean --install build-dir flatpak/io.raph.kibrary.yml
  flatpak run io.raph.kibrary
  ```
- [ ] (Optional) Submit to Flathub for one-click install on GNOME/KDE — see https://docs.flathub.org/docs/for-app-authors/submission.

### CI workflow
- [ ] Copy the workflow template back into `.github/workflows/`:
  ```bash
  cp docs/release-workflow.yml.example .github/workflows/release.yml
  ```
  (The credential pushing this commit must have GitHub `workflow` scope.)

## Version bump

- [ ] `package.json` → `0.2.0`
- [ ] `src-tauri/Cargo.toml` → `0.2.0`
- [ ] `src-tauri/tauri.conf.json` → `0.2.0`
- [ ] `sidecar/pyproject.toml` → `0.2.0`
- [ ] `sidecar/kibrary_sidecar/__init__.py` → `0.2.0`

## Build & release

- [ ] `pnpm install` (refresh lockfile)
- [ ] `bash sidecar/build-binary.sh` (compile the PyInstaller sidecar binary)
  - Verify the binary exists at `sidecar/dist/kibrary-sidecar-<triple>` before proceeding
  - Smoke-test: `echo '{"id":1,"method":"system.ping","params":{}}' | ./sidecar/dist/kibrary-sidecar-<triple>` should print `{"id":1,"ok":true,"result":{"pong":true}}`
  - Expected size: 30–80 MB single file
- [ ] `bash scripts/build-wheel.sh` (bundle the sidecar wheel — still needed for the Python fallback bootstrap path)
- [ ] Locally test `pnpm tauri build` per OS to catch issues before CI
- [ ] Tag `v0.2.0` on `main` and push — release workflow drafts the GitHub Release with all platform binaries + `latest.json`
- [ ] Edit the draft release notes (see template in this doc, below)
- [ ] Publish

## Release notes template

```markdown
## v0.2.0 — Library Management

The Add flow from v0.1.0 now has a companion: the Libraries room. Browse,
edit, move, rename, and delete components in your already-committed
libraries — every action a single git commit, undoable.

### What's new

- **Libraries room** — 3-pane browser (tree | components | detail). All
  the previews and property editor from the Add room reused here.
- **Component operations** — rename, move between libraries, delete with
  confirmation, all with toast + Undo.
- **Library metadata editor** — description, license, maintainer, version
  bumps.
- **Re-export to KiCad** — one button to register every library with your
  active KiCad install.
- **Replace 3D model** — pick a STEP/STP/WRL/GLB from disk to replace or
  add a component's 3D model. Footprint's (model ...) line updated
  automatically.
- **GitHub-releases auto-update** — non-modal banner appears when a new
  version is available; one-click download + restart.
- **Sidecar bootstrap** — clean install flow when Python isn't set up.
- **Signed installers** — macOS notarized, Windows code-signed, Linux
  AppImage GPG-signed. (Pre-requisite secrets must be configured by the
  maintainer before tagging — see SHIP-P2.md.)

### Limitations

- macOS users see a one-time "right-click → Open" prompt on first launch
  (we use ad-hoc signing rather than the $99/yr Apple Developer path).

See `docs/superpowers/specs/2026-04-25-kibrary-redesign.md` for the design
and `docs/superpowers/plans/2026-04-26-p2-extras.md` for the implementation
plan executed in this release.
```

## Post-release

- [ ] Update README "Project status" — P2 → released, P3 → planned
- [ ] Open milestone for v0.3.0 with remaining items: Flathub manifest, light/dark theme polish, additional QoL — feature-complete after P3.
