# Visual-verify harness — 3D viewer

Programmatically click a jog button on the Model3DViewerGL viewer, take
before/after screenshots and scene snapshots, then assert that the
correct meshes moved (chip up by ≈1 mm, substrate unchanged).

This catches the class of regressions that the existing smoke probes
(see `e2e/specs/download-all.spec.ts` "alpha.28+ probes") cannot —
specifically Bug 2 ("PCB moves instead of chip"), Bug 1 (alignment),
and any future drift in `applyLiveDelta` / `findSubstrateMesh`.

## What gets written

For every fixture, the runner writes to
`<outDir>/<fixture-name>/`:

- `before.png` / `after.png` — WebDriver screenshots
- `before.json` / `after.json` — full SceneSnapshot (per-mesh world position
  + bbox, substrate flag, chip-node flag)
- `diff.json` — `DiffRecord` (per-mesh deltas, added/removed mesh lists,
  GLB reload detection)
- `REPORT.md` — human-readable PASS/FAIL banner, threshold echo, mesh
  table, and screenshot pointers

## Run locally (Linux + Xvfb + tauri-driver)

```sh
# Start the harness (needs the kibrary .deb installed, plus tauri-driver,
# WebKitWebDriver, Xvfb — same prereqs as smoke-ui.sh):
scripts/visual-verify.sh                 # all fixtures
scripts/visual-verify.sh u_fl_hirose     # one fixture
scripts/visual-verify.sh --debug         # keep WebDriver session alive on first FAIL
```

Output lands in `/tmp/visual-verify-out/`.

## Run via Docker (CI / headless dev box)

```sh
mkdir -p .smoke-build
cp src-tauri/target/release/bundle/deb/Kibrary_<VER>_amd64.deb .smoke-build/kibrary.deb
docker build -f Dockerfile.visual-verify -t kibrary-visual-verify .
docker run --rm --network host -v /tmp/visual-verify-out:/out kibrary-visual-verify
```

## Add a new fixture (3-step contract)

1. **Place the footprint in the test workspace.** The harness opens
   `/tmp/e2e-workspace` (or whatever `fixtures.json::workspace` points
   at) via `__kibraryTest.openWorkspace`. The library + footprint must
   exist on disk before the harness navigates to it. Typical recipe:
   `library.commit` from a staging dir, or copy a kicad-cli stock
   footprint into `<workspace>/<lib>/<lib>.pretty/<name>.kicad_mod` plus
   `<workspace>/<lib>/<lib>.3dshapes/<name>.<ext>`.

2. **Append a JSON entry** to `e2e/visual-verify/fixtures.json`:

   ```json
   {
     "name": "usb_c_hro",
     "lib": "VisualVerify_KSL",
     "footprint": "USB_C_HRO",
     "action": "Click jog-z-plus1 — connector body should rise +1mm",
     "expectedSubstrateName": "preview_PCB",
     "jogButtonSelector": "[data-testid=\"jog-z-plus1\"]",
     "assertOverrides": {
       "chipYDeltaRange": [0.0005, 0.002],
       "chipYDeltaMinCount": 1
     }
   }
   ```

   No code changes are needed beyond the JSON entry.

3. **Run the harness.**

   ```sh
   scripts/visual-verify.sh usb_c_hro
   ```

   On FAIL, read `<outDir>/usb_c_hro/REPORT.md` — it tells you exactly
   which mesh moved (or didn't) and by how much.

## File layout

| Path | Purpose |
|------|---------|
| `e2e/lib/webdriver.ts` | Shared WebDriver helpers (jpost/jget/jdel/execScript/execAsync/elClick/screenshot/waitFor) |
| `e2e/visual-verify/runner.ts` | CLI entry; runs fixtures end-to-end |
| `e2e/visual-verify/snapshot-scene.ts` | `buildSnapshotScript()` → browser-injectable JS |
| `e2e/visual-verify/assert.ts` | Pure `computeDiff` + `runAssertions` |
| `e2e/visual-verify/report.ts` | Writes `REPORT.md` + JSON blobs + PNGs |
| `e2e/visual-verify/fixtures.json` | Data-only fixture list |
| `scripts/visual-verify.sh` | Local Xvfb + tauri-driver entry |
| `Dockerfile.visual-verify` | CI image (extends smoke-ui) |

## Action flow & determinism rules (what the runner guarantees)

1. Wait until `__model3dGLChipNodeCount > 0` AND
   `__model3dGLSubstrateName !== ''`.
2. Wait for stability: `chipNodeCount` unchanged across two 50 ms polls
   AND `loadCount` unchanged for 250 ms.
3. Capture BEFORE screenshot + scene snapshot + `loadCount`.
4. Click `fixture.jogButtonSelector` (fall back to
   `__kibraryTest.jogZ(1.0)` if the button is missing — emits a warning
   in the report).
5. `await execAsync(... requestAnimationFrame(... requestAnimationFrame(done)))`
   — guarantees the OrbitControls + applyLiveDelta tick has run.
6. Capture AFTER snapshot + screenshot.
7. Assert `loadCount` is unchanged (else `reloadDetected` flips and the
   report flags "snapshot is stale").
8. Run pure-function assertions; write report.

## Open questions / assumptions

- **`window.__kibraryTest.jogZ` does NOT currently exist** — it is the
  documented fallback contract. If the data-testid auditor (Wave 1
  Agent 3) chooses to expose it, the fallback path becomes useful; until
  then, the fallback always errors and the harness simply demands
  `[data-testid="jog-z-plus1"]` to be present.
- **The `jog-dial` (X / Y) wedges have testids of the form
  `jog-{outer|inner}-{+|-}{x|y}`** (see `src/blocks/Model3DJogDial.tsx`).
  Z-only fixtures are sufficient for the alpha.4 regression; X / Y
  fixtures can be added later by setting `jogButtonSelector`
  accordingly and adjusting `chipYDeltaRange` to the matching axis (the
  current `assert.ts` only checks the Y axis — extending to a generic
  `chipDeltaRange` is a future task).
- **The fixtures themselves (footprints + STEP files) are out of scope
  for this implementer** — Wave 1 Agent 2 (fixture-builder) lands them.
  The seed `u_fl_hirose` entry is a placeholder; running the harness
  before the fixtures land will fail at `navigateToFootprint` (library
  not found) with a clear error message.
- **The Model3DViewerGL test-bag globals are read-only from the
  harness's POV.** No mutation, no monkey-patching — the harness only
  observes.
- **`workspace_open` is reused** (the same call download-all.spec.ts
  uses) — fixtures are expected to live under
  `${workspace}/${lib}/...` on disk before the runner starts.
