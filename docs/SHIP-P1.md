# Shipping P1 (v0.1.0)

Checklist for cutting the first release of the Kibrary desktop app.

## Pre-release verification

- [ ] All P1 tests pass:
  - [ ] `cd sidecar && .venv/bin/pytest tests/ -v` → 99/99 green
  - [ ] `pnpm typecheck` → clean
  - [ ] `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo check` → clean
- [ ] Smoke test the desktop app on a real workspace (clone `kicad-shared-libs`, paste 2 LCSCs, walk through bulk assign and sequential review, confirm git auto-commits land)
- [ ] Verify "Edit in KiCad" handoff opens the right editor on at least one of: Linux Flatpak, Linux regular, macOS, Windows
- [ ] Verify the file watcher refreshes the in-app preview after an external KiCad save
- [ ] Verify first-run wizard appears for a fresh workspace and is dismissible
- [ ] Confirm `search.raph.io` panel hides cleanly when no API key is set

## Version bump

- [ ] `package.json`: bump `version` to `0.1.0`
- [ ] `src-tauri/Cargo.toml`: bump `version` to `0.1.0`
- [ ] `src-tauri/tauri.conf.json`: bump `version` to `0.1.0`
- [ ] `sidecar/pyproject.toml`: bump `version` to `0.1.0`
- [ ] `sidecar/kibrary_sidecar/__init__.py`: bump `__version__` to `0.1.0`

## Build

- [ ] `pnpm install` (refresh lockfile)
- [ ] `pnpm tauri build` per OS:
  - [ ] **Linux**: produces `.AppImage` and `.deb` under `src-tauri/target/release/bundle/`
  - [ ] **macOS**: produces `.dmg` and `.app` (universal2 if possible)
  - [ ] **Windows**: produces `.msi` and `.exe`
- [ ] Sanity-check each artifact: launch on the target OS, confirm window opens, sidecar responds (the SidecarStatus block reads `system.version`)

## Release

- [ ] Tag `v0.1.0` on `main`
- [ ] Push tag — release workflow (added in P2 alongside auto-update) will draft a GitHub Release
- [ ] Edit the draft release notes; copy from this template:

```markdown
## v0.1.0 — first MVP release

Kibrary is now a desktop app. Paste LCSC codes from JLCPCB, watch them
download in parallel, review/edit each before commit, and have everything
land in your library repo as one git commit per part.

### What's in
- 25 RPC endpoints (sidecar)
- 16 frontend blocks (Solid)
- Three review modes: sequential, bulk-assign, pick (defer)
- KiCad install detection on Linux/Flatpak/macOS/Windows
- Library auto-suggestion from LCSC category
- Optional search.raph.io integration
- First-run wizard for new workspaces

### Known limitations (deferred to P2/P3)
- Library management room (browse / edit / move / delete already-committed
  parts) ships in P2.
- 3D STEP rendering inside the app is a placeholder cube; use KiCad's
  footprint editor for real 3D viewing/positioning.
- Python sidecar requires `python3` + the `kibrary_sidecar` package on PATH.
  Bundled wheel + auto-install bootstrap ships in P2.
- Signed installers ship in P2 — for now, expect Gatekeeper / SmartScreen
  warnings on first launch.
- Auto-update via GitHub Releases ships in P2.

See `docs/superpowers/specs/2026-04-25-kibrary-redesign.md` for the
full design and `docs/superpowers/plans/2026-04-25-p1-mvp.md` for the
implementation plan executed in this release.
```

- [ ] Publish the release
- [ ] Smoke-test the published artifact on a clean machine

## Post-release

- [ ] Update README "Project status" section: P1 → released, P2 → in progress
- [ ] Open milestone for v0.2.0 with the P2 plan tasks
