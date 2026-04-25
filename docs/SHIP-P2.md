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

### Tauri updater Ed25519 signing key
```bash
cargo tauri signer generate -w ~/.tauri/kibrary.key
# Note the printed public key
```

- [ ] Paste the public key into `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` (replace the `REPLACE_WITH_TAURI_SIGNER_GENERATE_OUTPUT` placeholder)
- [ ] Add `~/.tauri/kibrary.key` content as GitHub repo secret `TAURI_SIGNING_PRIVATE_KEY`
- [ ] If the key has a passphrase, also add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

### macOS signing
- [ ] Enroll in Apple Developer Program ($99/yr)
- [ ] Generate Developer ID Application certificate from Apple Developer portal
- [ ] Export as `.p12`; base64-encode and add as GitHub secret `APPLE_CERTIFICATE`
- [ ] Add `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`, `APPLE_SIGNING_IDENTITY` (`"Developer ID Application: NAME (TEAMID)"`)
- [ ] Generate App Store Connect API key for notarization; add `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`
- [ ] Update `tauri.conf.json` → `bundle.macOS.signingIdentity` to the same string as `APPLE_SIGNING_IDENTITY`

### Windows signing (recommended path: SignPath Foundation, free for OSS)
- [ ] Apply at https://signpath.io/solutions/open-source-community
- [ ] Wait for approval (typically a few weeks)
- [ ] Once approved, add the SignPath GitHub Action to `.github/workflows/release.yml` (replace the basic Windows signing step). See SignPath's docs for the exact action snippet.
- [ ] Alternative if SignPath is too slow: Azure Trusted Signing (~$120/yr) — see `docs/SIGNING.md` for config.

### Linux distribution
- [ ] Generate a GPG key for AppImage signing if you don't have one: `gpg --full-generate-key`
- [ ] Set `SIGN=1`, `SIGN_KEY=<your-key-id>`, `APPIMAGETOOL_SIGN_PASSPHRASE`, `APPIMAGETOOL_FORCE_SIGN=1` in `release.yml` env. Add `GPG_PRIVATE_KEY` as a secret (export with `gpg --export-secret-keys --armor`).
- [ ] Optionally submit a Flathub manifest for one-click install on GNOME/KDE.

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
- [ ] `bash scripts/build-wheel.sh` (bundle the sidecar wheel)
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

- Bootstrap auto-install path is stubbed for v0.2.0; the in-app option
  shows a friendly "manual install required" message and points at the
  pip command. Direct Rust→pip install is planned for v0.3.0.
- 3D STEP rendering inside the app is still a placeholder cube; use
  KiCad's footprint editor for real 3D viewing/positioning.

See `docs/superpowers/specs/2026-04-25-kibrary-redesign.md` for the design
and `docs/superpowers/plans/2026-04-26-p2-extras.md` for the implementation
plan executed in this release.
```

## Post-release

- [ ] Update README "Project status" — P2 → released, P3 → planned
- [ ] Open milestone for v0.3.0 with remaining items: bootstrap auto-install, STEP rendering, BOM block (if requested), Flathub manifest
