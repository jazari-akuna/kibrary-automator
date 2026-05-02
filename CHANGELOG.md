# Changelog

All notable changes to Kibrary are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning is **CalVer with semver-compatible suffixes**: `YY.M.D-alpha.N` (e.g. `26.4.26-alpha.1` = first alpha build of 2026-04-26). Pre-release counter goes in the `-alpha.N` suffix; bump it for additional builds the same day.

## [26.4.27-alpha.32] — 2026-05-02

### Fixed
- **The footprint STILL wasn't rendering on the PCB** — alpha.31's fix only addressed the silent-drop case where `_resolve_model_path` returned None. But the resolver itself was too narrow: it only knew about `${KSL_ROOT}` and the `lib_dir/*.3dshapes/` glob. Footprints whose `(model …)` block referenced `${KICAD9_3DMODEL_DIR}` (the stock KiCad 9 model dir — used by every stock symbol kibrary doesn't manage), `${KICAD8_3DMODEL_DIR}`, `${KICAD_USER_3DMODEL_DIR}`, or `${KIPRJMOD}` all hit the resolver's "no candidate" path → the model block got stripped → user saw an empty PCB plane. Added a substitution table covering all five env vars (with OS-aware default fallbacks for the system dirs) and a "directory-name mismatch" last-ditch fallback that scans `lib_dir.glob("*.3dshapes")` by basename — catches the case where the `.kicad_mod` references `Foo_KSL.3dshapes/X.step` but the file actually lives at `<lcsc>.3dshapes/X.step` (legacy JLC2KiCadLib output).
- **"Thickness seems inverted"** was actually a camera near-plane clipping bug. The viewer's `camera.near` was clamped to `0.01 m = 10 mm`. The chip body in a typical kicad-cli GLB is ~0.45 mm thick. When the user wheel-zoomed in, the chip fell behind the near plane and disappeared while the much-thicker board stayed visible — perceived as "the thickness inverted". Fix: drop the 10 mm floor; compute `near = max(minFeatureSize / 100, 1e-5)` from the smallest mesh dimension. For a 0.45 mm chip that's 4.5 µm — three orders of magnitude under chip thickness, so the chip never clips at any zoom.
- **Camera was at metres-scale "(40, 40, 40)" looking at a 4 cm board.** Initial position was 1700× too far away. Even after `frameCameraTo` ran post-load, the framing was to the WHOLE board bbox (`maxDim * 3`), making the chip render as ~3 pixels at typical viewport sizes — perceptually invisible. Fix: initial position now `(0.12, 0.10, 0.12)` (~12 cm), and `frameCameraTo` now identifies the smallest mesh as the component, frames `dist = max(componentMaxDim * 6, 0.02)` so the chip is the focal subject with the board still in frame.

### Added
- **Smoke probe `glb-loaded` strengthened to recursive Mesh count + position-buffer sanity.** The previous probe used `scene.children.length` — but `gltf.scene` always lands as exactly one Group regardless of internal mesh count, so a board-only GLB (chip silently dropped) passed the probe. New probe `s.traverse(o => isMesh)` counts actual meshes and asserts ≥ 2 + > 100 vertex positions. The error message now names the suspect: "kicad-cli likely silently dropped the 3D model — check (model …) path resolution."
- **New smoke probe `chip-bbox-sanity`** computes per-mesh bounding boxes, sorts by max dim, and asserts the smallest mesh (chip) has max dim < 10 mm AND the largest mesh (board) has max dim > 20 mm. Locks in both "chip present with real geometry" AND "alpha.30's 40 mm Edge.Cuts outline didn't regress".

### Notes
- 7 new sidecar tests in `test_render_3d.py` cover each new env-var substitution, the OS-default fallback paths, and the dir-name-mismatch last-ditch search. Total sidecar: **262 passed** (was 255).
- Hidden assumption flagged by the implementer agent: `KSL_ROOT` is mapped to `lib_dir.parent`, which works for committed libraries laid out as `<workspace>/<lib_name>/...` but NOT for staging at `<workspace>/staging/<lcsc>/...`. Documented in the new helper docstring; not fixed in this release because no current callsite exercises that path.
- Camera math for a typical R0603 fixture: `dist = max(0.00162 m × 6, 0.02 m) = 0.02 m` (chip clearly resolved, full 4 cm board still in frame); `near = 0.45 mm / 4 / 100 = 4.5 µm`; `far = 40 mm × 100 = 4 m`.

## [26.4.27-alpha.31] — 2026-04-29

### Fixed
- **The 3D viewer was rendering an empty PCB plane with no component on it.** Root cause discovered by inspecting actual `kicad-cli pcb export glb` output in the smoke Docker image: when the footprint's `(model …)` path doesn't resolve to a file on disk, kicad-cli silently drops the 3D model from the GLB *and exits with code 0*. The sidecar was checking only `returncode`, so it shipped a single-mesh GLB (board only — 3712 bytes vs the 169 kB you get when the model is present) and the user saw an empty plane. Two-layer fix: `_resolve_model_path` now verifies `is_file()` for every candidate (returning `None` on miss instead of an unverified path); `_sanitise_footprint` strips the `(model …)` block when the resolver returns None (degraded-but-functional GLB instead of a silent failure); `render_footprint_3d_glb` adds a stderr backstop that scans for `Could not add 3D model.*?File not found:` and raises `RuntimeError` if kicad-cli silently drops a model the sanitiser DID embed (catches kicad-cli bugs we don't yet know about).
- **GLB textures rendered "dark and wrong" — the alpha.30 IBL fix only made them lighter, didn't address the root cause.** The actual problem is data-side: kicad-cli's GLB encodes the IC body geometry as `metalness=1.0` with `baseColorFactor=(0.5,0.5,0.5)` and no metalness map (a fully-metallic surface has zero diffuse — renders black without IBL, like chrome with IBL), and encodes the PCB substrate / soldermask with `alphaMode: BLEND, opacity≈0.85` (three.js's GLTFLoader sets `transparent=true, depthWrite=false` per glTF spec, breaking depth sort so deeper geometry leaks through closer pixels). Neither encoding is what kicad-cli intends visually — the metalness=1.0 is OCCT's default for "unknown shading" and the BLEND opacity is a kicad-cli artifact, not real transparency. Fix: after every successful GLTFLoader.parse, traverse the loaded scene and (a) force-opaque any material with opacity ≥ 0.7, (b) demote any `metalness > 0.9` material with no metalnessMap to matte plastic (`metalness=0.1, roughness≥0.6`). The alpha.30 IBL + ACES tone mapping setup STAYS — those are correct best-practice and are now actually doing useful work on properly-typed materials.

### Notes
- The integration test gap is closed: previous `test_render_3d_glb.py` mocked `subprocess.run` for everything, which is why this regression shipped. Two new `@pytest.mark.skipif(KICAD_CLI is None)` integration tests now spawn real kicad-cli inside the test (skips locally when no binary; runs in CI/smoke Docker images where kicad-cli is installed) and assert the GLB has BOTH a board mesh AND a component mesh by parsing the JSON chunk and counting meshes. Total sidecar tests: **255 passed, 2 skipped**.
- New smoke probe `alpha.31 material-fixup`: walks `window.__model3dGLScene` after GLB load and counts materials still flagged `transparent + opacity ≥ 0.7` (would mean the fix-up was skipped) and materials still `metalness > 0.9` without a metalnessMap (same). Both must be 0 — locks in the regression for any future refactor that removes the traversal.
- Sidecar default behaviour when a `(model …)` path is unresolvable: **strip and continue** (degraded GLB, board-only, no chip). The user sees the board plane but knows something's missing instead of staring at a render that successfully published despite the missing geometry. The stderr backstop handles the case where kicad-cli drops a model the sidecar BELIEVED resolved — that one raises hard.

## [26.4.27-alpha.30] — 2026-04-29

### Fixed
- **3D viewer textures looked dark and materials looked wrong.** The alpha.29 three.js setup was *minimum-viable* lighting — one ambient + one directional. glTF materials exported by `kicad-cli pcb export glb` are physically-based (metallic-roughness) and *expect* image-based lighting (IBL) to look natural; without an environment map, metals render black and dielectrics (the green soldermask, the plastic component bodies) come out flat and muddy. Fix: synthesise a neutral studio HDRI via three.js's bundled `RoomEnvironment`, prefilter it through `PMREMGenerator`, and feed the result to `scene.environment`. Pair that with the proper output pipeline (`outputColorSpace = SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping`, `toneMappingExposure = 1.0`) so glTF's linear-space textures aren't double-gamma-corrected. The single ambient + directional is replaced with a key/fill directional pair (5,8,5 at 1.5 + -5,8,-5 at 0.8) so the shadow side reads as "lit by sky" instead of pitch-black.
- **PCB substrate plane was too small.** The empty-board template had no `Edge.Cuts` outline, so kicad-cli auto-derived a board size from the bounding box of the spliced footprint plus minimal margin — the part appeared to BE the board instead of sitting ON it. Added a 40 mm × 40 mm centred `(gr_rect (start -20 -20) (end 20 20) … (layer "Edge.Cuts"))` to `_EMPTY_BOARD_TEMPLATE` so any 0402 / 0805 / SOIC part visibly sits on a generous green plane. Same template is shared between the PNG and GLB paths via `_splice_into_template` import, so the fix lands once.

### Notes
- 4 new sidecar tests in `test_render_3d.py` + `test_render_3d_glb.py` lock in the outline (`(layer "Edge.Cuts")` marker, gr_rect coords, symmetry about origin, presence in the spliced board for both PNG and GLB pipelines). Total sidecar tests: **248 passed**.
- Bundle delta from the lighting fix: `Model3DPreview` chunk grew **+1.07 kB gzipped** (RoomEnvironment + PMREMGenerator are part of three.js / examples — no new npm dep).
- `scene.environment` is disposed on viewer unmount alongside the PMREM-generated cubemap so the IBL texture doesn't leak GPU memory across remounts.
- `toneMappingExposure = 1.0` is a starting value. If subsequent feedback says "still dark" or "too hot", the one-line lever is to bump or lower this constant — IBL tuning is qualitative.
- No new smoke probe — IBL effects are visual-quality, not behavioural; existing `glb-loaded` + `orbit-no-sidecar-call` probes still validate the load and interaction paths. A human eyeball check is the actual confirmation; if a regression is found, screenshot diff against the alpha.30 baseline can lock in the lighting in the future.

## [26.4.27-alpha.29] — 2026-04-29

### Fixed
- **3D viewer is now 60 fps WebGL instead of ~5 fps server-rendered PNG.** The previous architecture spawned `kicad-cli pcb render` per frame; measured at ~190 ms per spawn (kicad-cli's own internal "render time" is 2 ms — the rest is process spawn, library load, and scene setup). No amount of resolution tuning, GPU env tricks, or `--quality basic` could break that floor. Switched to `kicad-cli pcb export glb` (binary glTF) which fires *once per board change* (~185 ms one-shot), and pure client-side three.js + OrbitControls + GLTFLoader takes over for orbit / zoom / pan in WebGL2 at the user's GPU's native frame rate. Live offset / rotation / scale tweaks are applied as a `Matrix4` delta directly on the loaded mesh — no GLB re-export until the user clicks Save. **The fastest safe knob is the one you can stop turning.**

### Added
- **`Model3DViewerGL` (new):** three.js scene with `WebGLRenderer({antialias:true,alpha:true})`, `PerspectiveCamera`, `OrbitControls` (drag = orbit, wheel = zoom, right-drag = pan, with damping enabled for smooth feel), `GLTFLoader`, ambient + directional lighting. ResizeObserver keeps camera aspect synced. WebGL2 feature-test on mount: if the runtime can't initialise WebGL2, an `onWebGLError` callback bubbles up to `Model3DPreview` which falls back to the existing PNG viewer (zero behavioural regression for users on environments where WebGL2 is unreliable). Auto-frames the camera to the loaded model's bounding box.
- **`render_footprint_3d_glb` (new sidecar function):** mirrors `render_footprint_3d_png_angled`'s sanitiser/splice/transform-patch pipeline, then shells out `kicad-cli pcb export glb -o … <board>` and returns the binary GLB bytes. RPC `library.render_3d_glb_angled` returns `{glb_data_url: "data:model/gltf-binary;base64,…"}`. The previous PNG RPCs are preserved — they still drive the static library list thumbnails and the PNG fallback path.

### Notes
- **Bundle size:** the Model3DPreview chunk grew from 16 kB → 638 kB (gzip 5.6 kB → 165 kB). The bulk is three.js core + GLTFLoader + OrbitControls. Acceptable in exchange for a 12× frame-rate improvement on a feature the user explicitly demanded.
- **PNG path retained:** `Model3DViewer.tsx`, `library.render_3d_png` and `library.render_3d_png_angled` are still wired and invoked when WebGL2 initialisation fails. The smoke harness gates the alpha.25/26/27 PNG probes (`viewer-mounts`, `wheel-zoom`, `tier-flip`, `chain-when-idle rerender`, `3D positioner save → rerender`) behind `if (runPngProbes)` and falls through to a new alpha.29 GL probe set when the GL canvas is detected.
- **Smoke probes (alpha.29):** `glcanvas-mounts` (asserts `<canvas data-testid="3d-viewer-gl-canvas">` exists with a non-zero WebGL2 context buffer); `glb-loaded` (polls `window.__model3dGLScene.children.length` until the loader inserts the mesh); `orbit-no-sidecar-call` (snapshots `window.__model3dGLLoadCount`, simulates a synthetic mouse drag across the canvas, asserts the count did NOT increase — proving orbit is GPU-only and never round-trips through kicad-cli).
- **Test surface:** 7 new sidecar tests in `test_render_3d_glb.py` (argv shape, GLB magic header, kicad-cli failure capture, transform override patching with/without overrides, missing-footprint guard, env scrub). Total sidecar test count: 244 passed.
- **The smoke run is the real validator.** Local tsc + build + sidecar tests all clean, but only the release script's docker-driven smoke against real WebKitGTK can prove the GLTFLoader path actually mounts a mesh end-to-end. If WebGL2 is unavailable in the smoke env, the gated PNG probes run instead — either way the harness asserts something useful.

## [26.4.27-alpha.28] — 2026-04-29

### Fixed
- **Settings dropdowns were STILL unreadable in dark mode** despite the alpha.26 global `<select>` / `<option>` CSS rules. WebKitGTK delegates the native `<option>` popup to GTK's combo widget, which respects the OS GTK theme and ignores page CSS — so the alpha.26 rules took on the closed-state `<select>` button but the popup itself still rendered with system colours. Replaced both Settings dropdowns (Theme picker, KiCad install picker) with a small custom Solid `<Dropdown>` component built from a `<button>` + portal-mounted `<div role="listbox">`. Now every option is a styled `<div>`, fully dark-mode aware, with keyboard nav (Up/Down/Enter/Esc) and outside-click close.

### Added
- **"Browse for your own…" KiCad install option.** The KiCad install dropdown gains an extra row at the bottom (and a fallback standalone Browse button when no install is auto-detected) that opens a Tauri file dialog (`@tauri-apps/plugin-dialog`'s `open()`), then calls a new sidecar method `kicad.register_custom_install` with the picked path. The sidecar validates the binary by running it with `--version`, parses the KiCad version string, locates the companion `kicad` launcher / eeschema / pcbnew binaries in the same directory, and persists the install in `~/.config/kibrary/kicad-custom-installs.json` (separate from the auto-detect cache so customs survive a refresh). On success the picker auto-selects the freshly registered install and toasts the install id; on rejection (binary doesn't exist, isn't executable, or doesn't look like KiCad) the rejection reason is surfaced verbatim in an error toast.

### Notes
- 11 new tests in `test_kicad_install.py` cover: success path, rejection of non-KiCad binaries, missing-file / non-executable rejections, persistence across reload, dedup by id and by `kicad_cli_bin` path, two same-version installs from different prefixes coexist, env-scrub via `_system_env()` (alpha.21 PyInstaller fix), and dict-shape parity with `detect_installs()`. Total sidecar test count: **237 passed**.
- The new `<Dropdown>` is reusable: closed state is a focusable `<button>` carrying the trigger's `data-testid` (so the existing `kicad-install-select` smoke testid still resolves), open state is a portal-mounted listbox so it escapes any overflow-clipped ancestor.
- Smoke probe `alpha.28 Settings dropdown contrast + browse-kicad`: forces dark mode, opens the theme dropdown, asserts `getComputedStyle(option).color !== getComputedStyle(option).backgroundColor` and that the panel background is not in the white range — locks in that the white-on-white regression cannot return. Also asserts `[data-testid="kicad-browse"]` resolves (the dialog itself is OS-modal so we don't actually click it).
- 3D viewer perf research uncovered a clean 30 fps path (`kicad-cli pcb export glb` once + three.js + WebGL2 OrbitControls). That work is in flight on a parallel agent and will land separately as alpha.29 — design saved at `/tmp/3d-perf-proposal.md`.

## [26.4.27-alpha.27] — 2026-04-29

### Fixed
- **3D viewer zoom now re-renders the scene from a closer/farther camera.** Replaced the alpha.26 CSS `transform: scale(…)` (which just stretched the same PNG, so the image got blurrier the more you zoomed in and you couldn't usefully dezoom past 1.0) with a real sidecar zoom: the `library.render_3d_png_angled` RPC now passes `--zoom <factor>` to `kicad-cli pcb render`. The clamp range is `[0.25, 5.0]` — well past the default view in both directions — and quality is preserved at every step because each frame is a fresh ray-traced render, not a stretched bitmap.
- **3D viewer drag now renders continuously instead of "render once after motion stops".** The alpha.25/26 implementation used a 100 ms debounce: every mousemove reset the timer, so if the user kept moving for more than 100 ms (i.e. always), the timer never fired and you only ever saw a render after you let go — which felt like 0–2 fps. Replaced with a chain-when-idle scheduler: at most one render is in flight at a time, and the moment a render returns we immediately fire the next one if any tracked signal moved during the round-trip. Stale results from in-flight requests the user has already moved past are discarded by request-id. Effective frame rate is now bounded only by kicad-cli itself.
- **Drag uses a low-resolution tier (300×200, basic quality) and snaps back to high-res (600×400) on release.** `--quality basic` is already the default kicad-cli setting; the cost was almost entirely pixels. 4× fewer pixels during interactive orbit gives a 2-3× per-frame speedup, and the high-res render fires automatically when `dragStart` clears (the createEffect tracks the dragging signal, so the tier switch is just one more dependency).

### Added
- Sidecar `render_footprint_3d_png_angled` accepts `zoom: float = 1.0` and `quality: "basic"|"high"|"user"|"job_settings" = "basic"`, validated up front (`zoom <= 0` and unknown quality strings both raise `ValueError`). 6 new tests in `test_render_3d_angled.py` lock in the argv shape (`--zoom 1.0`, `--quality basic`) and the validation paths.
- Frontend `<img data-tier="low|high">` attribute exposes the active resolution tier so the smoke harness can prove the drag-tier switch fires.

### Notes
- The 100 ms debounce, the `transform: scale(...)` CSS hack, and the wrapper-attached mousemove listeners are all gone — replaced by `inFlight`/`dirty`/`reqId` state and window-attached drag listeners.
- Smoke probes updated: alpha.26 `wheel-zoom` was amended for the new contract — asserts `data-zoom` moves up on zoom-in, drops below 1.0 on dezoom-out, that the `<img>`'s `src` *changes* between the two extremes (proving sidecar re-rendered), and that no `transform: scale(...)` remains on the element. New `tier-flip` probe asserts `data-tier` is `'high'` at idle, flips to `'low'` on synthetic mousedown, and returns to `'high'` after mouseup.

## [26.4.27-alpha.26] — 2026-04-29

### Fixed
- **3D viewer drag selected page text and felt jagged.** Mousedown over the viewer didn't `preventDefault`, so the browser started a text selection anchored at the press point and extended it as the cursor moved — every selection-extend triggered layout/paint and the orbit felt laggy. Mousemove was also bound on the wrapper, so a fast drag whose cursor left the canvas desynced. Now `mousedown` calls `preventDefault()` and the move/up listeners are attached at the **window** level for the duration of the drag — orbit stays smooth even when the cursor wanders far from the viewer, and no text selection is ever started.
- **Native `<select>` dropdowns were unreadable in dark mode.** Existing selects had `dark:bg-zinc-800` but no text colour set; native `<option>` elements had no styling at all. WebKitGTK doesn't cascade body's `text-zinc-100` into native form children, so the popup options inherited the OS default colour and rendered white-on-dark or dark-on-dark depending on the system theme. Added global `@layer base` rules in `styles.css` for `select` + `option` (light + `html.dark` variants) so every dropdown — theme picker, KiCad install picker, ComponentMoveModal — themes correctly without any per-call-site changes.

### Added
- **Mouse-wheel zoom in the 3D viewer.** Scrolling over the viewer now zooms the displayed PNG (CSS `transform: scale(…)` on the `<img>`, clamped to `[0.4, 4.0]`, multiplicative 1.1× / 0.9× per tick). It's a pure-CSS effect — no kicad-cli round-trip per scroll tick — so zoom is instant. `e.preventDefault()` blocks the underlying page from scrolling.
- **Centre Reset on the jog dial.** The inert `+` glyph at the jog-dial centre is now a smaller (`r=22`) interactive Reset button (`data-testid="jog-reset"`, role="button", Space/Enter keyboard activation) that zeroes the live X+Y offset on click — Z is preserved. The recovered space lets the two concentric rings grow significantly: outer ±1mm wedges went from 16 px wide to 26 px; inner ±0.1mm wedges went from 15 px wide to 28 px. Wedge labels and font sizes were rebalanced to fit the wider rings.

### Notes
- Reset wiring uses a new `forceOffset` pulse-shaped prop on `Model3DPositioner` (mirrors the existing `jogDelta` consume pattern) so the positioner inputs snap to the new value, the live signal updates the viewer immediately, and the next Save persists it through `model3d_ops.set_3d_offset`.
- New smoke probes in alpha.26: `wheel-zoom` (3 zoom-in + 5 zoom-out wheel events, asserts `data-zoom` attr crosses up then down and `transform: scale(...)` is applied to the img), `no-text-select` (synthetic mousedown/move/up over the canvas, asserts `window.getSelection().toString() === ''` afterwards), `center-reset` (jog +X twice, click `jog-reset`, assert positioner X and Y both go to 0).

## [26.4.27-alpha.25] — 2026-04-29

### Added
- **Interactive 3D viewer with mouse-drag orbit + live re-render on positioner change.** The Library room's 3D card now mounts a draggable `<Model3DViewer>` (azimuth/elevation tracked locally, debounced 100ms re-render through a new `library.render_3d_png_angled` RPC) instead of the static `pcb render` PNG. As you tweak Offset/Rotation/Scale in the positioner, the viewer streams the live values into kicad-cli (sidecar patches the `(model …)` block in-memory before render — original `.kicad_mod` is untouched) so you see the new pose without committing. Save still writes through `model3d_ops.set_3d_offset` as before.
- **CNC-style concentric jog dial for X/Y offset + Z column.** A pure-SVG `<Model3DJogDial>` (4 outer wedges = ±1 mm, 4 inner wedges = ±0.1 mm, cardinal axes only) and `<Model3DJogZ>` (±1 / ±0.1 column) sit next to the viewer. Click a wedge → the positioner advances by that delta and broadcasts the new value to the viewer, which re-renders within the 100 ms debounce. Arrow keys jog by 0.1 mm; Shift+Arrow by 1 mm.

### Fixed
- **Edit-in-KiCad opened the wrong KiCad apps.** `eeschema --symbol-editor` and `pcbnew --footprint-editor` are *fake* CLI flags in KiCad 9 — `wxCmdLineParser` silently consumes them, so eeschema opens as the schematic editor and pcbnew opens as the PCB editor (which then refuses to load a `.kicad_mod` because of the extension mismatch). `editor.open` now uses `kicad --frame=fpedit <file>` for footprints (the real, undocumented invocation) and `kicad` (no flag) for symbols — KiCad 9 has no CLI form that loads a `.kicad_sym` straight into the Symbol Editor, so the sidecar surfaces `needs_manual_navigation=true` and the frontend toasts "click Symbol Editor → File → Open Library → `<file>`" so the user knows what to do. `kicad_install.py` now publishes the `kicad` launcher binary (Flatpak: `flatpak run --command=kicad org.kicad.KiCad`); `editor.py` *refuses* to fall back to the broken eeschema/pcbnew flags if the launcher is missing.

### Notes
- New sidecar test file `test_render_3d_angled.py` (6 cases) covers `--rotate elevation,0,azimuth` arg shape, in-memory `(model …)` patching for partial / full / no overrides, kicad-cli failure surfacing, and the no-`(model)`-block no-op case.
- `test_editor.py` rewritten: native + Flatpak install fixtures gain `kicad_bin`; tests assert the exact argv (`[kicad_bin, "--frame=fpedit", file]` for footprint, `[kicad_bin]` for symbol) and that `RuntimeError` fires when `kicad_bin` is `None`.
- Smoke harness adds `alpha.25 viewer + jog dial` probe: asserts the viewer `<img>` mounts, jog X+ click changes the positioner X value AND triggers a viewer re-render (img bytes change), drag-orbit on the canvas re-renders, and jog Z+ updates Z. The earlier alpha.23 "3D PNG re-renders on positioner save" probe was retargeted from `[data-testid="3d-render-png"]` to `[data-testid="3d-viewer-img"]` since the static PNG element is gone.

## [26.4.27-alpha.24] — 2026-04-29

### Fixed
- **Edit-in-KiCad spawned eeschema/pcbnew but they immediately died with `OPENSSL_3.2.0 not found`.** Same alpha.21-class PyInstaller `LD_LIBRARY_PATH` leak we patched for kicad-cli — but `editor.py`'s `subprocess.Popen` had no `env=` argument, so the spawned KiCad GUI inherited the bundled `_MEIPASS` dir, libcurl loaded PyInstaller's older libssl, and KiCad aborted before drawing a window. The frontend cheerfully showed "Opened symbol in KiCad (pid …)" while KiCad was already dead. Now passes `env=_system_env()` (same scrub as svg_render / render_3d), with a unit test that locks the regression in.

### Added
- **Open-Datasheet button next to the Datasheet property field.** When the Datasheet value is a `https://…` (or `http://`) URL, an "Open ↗" button to the right of the input launches it in the OS default browser via Tauri's `plugin-shell` `open()`. Disabled (with a hint tooltip) when the field is empty or doesn't look like a web URL — guards against `file://`, custom-scheme handlers, or arbitrary executable paths the user might paste.

### Notes
- Smoke harness adds `alpha.24 Open Datasheet button probe` that types a URL into the Datasheet input via the React-style value setter (so SolidJS reactive sees it), asserts the button transitions disabled→enabled, and confirms the button's `title` attribute reflects the URL — this catches both the disabled-state regression and the URL-binding regression.

## [26.4.27-alpha.23] — 2026-04-29

### Fixed
- **Edit-in-KiCad buttons did nothing on click (silent no-op).** SymbolPreview / FootprintPreview / Model3DPreview's editor buttons routed through `editor.open` but only logged failures to the console — the user never saw anything happen. They now `pushToast` a success ("Opened symbol in KiCad (pid …)") on spawn and an error toast on failure (the most common failure being "No KiCad install detected — install KiCad first" if the user hasn't picked one in Settings).
- **3D PNG didn't refresh after offset / rotation / scale was saved.** The renderedPng resource was keyed only on `lib_dir + component_name`, so saving new positioner values left the on-screen PNG stale. Added a `renderRev` signal that bumps in the positioner's `onSaved` callback and is part of the resource key, so the resource invalidates and re-renders against the freshly-written `.kicad_mod`.
- **Saved-pill + Open-in-library button never appeared after clicking Save all.** The Bulk-Assign `visibleItems` filter included `'ready'` and `'committed'` but NOT the transient `'committing'` state — the row vanished mid-save, the createEffect rebuild had no prev row to preserve, and when the row reappeared as `'committed'` it had `saveState='idle'` (no pill, no button). Filter now includes `'committing'`, AND the createEffect preserves any prev row with non-`'idle'` saveState (covers `'saving'`, `'ok'`, `'error'`).
- **`set_3d_offset` failed with FileNotFoundError on JLC2KiCadLib parts.** Same alpha.20-class bug: looked for `<symbol_name>.kicad_mod` (e.g. `0603WAF1002T5E.kicad_mod`) instead of the actual file `R0603.kicad_mod`. `model3d_ops.set_3d_offset` and `_update_kicad_mod` now route through `lib_scanner._find_footprint`, which honours the symbol's `Footprint` property.

### Added
- **"In library: Foo_KSL" pill in search results is now clickable.** Clicking jumps to Libraries → Foo_KSL → that component, so the user can immediately edit a part they've already added — matching the long-standing "Open in library" behaviour from the saved-pill in Bulk-Assign.
- **View-3D-in-KiCad button is now available in library mode** (was hidden behind `<Show when={!isLibraryMode()}>`). It opens pcbnew's footprint editor on the committed `.kicad_mod`; press Alt+3 inside for KiCad's interactive 3D viewer.

### Notes
- Smoke harness now exercises ALL of these via real click flows (not just DOM presence): Save-all → poll for `bulk-saved-pill` → click `bulk-open-in-library` → assert "Libraries (N)" header; click `lcsc-in-library-pill` → assert nav; click `edit-symbol-in-kicad` → assert toast (success OR error — both are user feedback); click positioner Save with bumped Z rotation → assert `<img data-testid="3d-render-png">`'s `src` bytes change.
- The user-reported regression ("no Open-in-library link") was reproduced inside the headless smoke before the fix landed and is locked in by the new `bulk-saved-pill` + `bulk-open-in-library` probe.

## [26.4.27-alpha.22] — 2026-04-28

### Added
- **3D preview renders for real now.** The 3D card in the Library view now shows an actual `kicad-cli pcb render` PNG of the footprint with its STEP body loaded — not just the offset/rotation table. Implementation builds a temporary `.kicad_pcb` by splicing the sanitised `.kicad_mod` directly into a static empty-board template (no pcbnew dependency, no `python3 -c` round-trip — those produced boards kicad-cli refused to load due to a `Pgm()`-not-initialised codepath in scripted pcbnew).
- **Saved-pill + Open-in-library after commit.** Committed rows in the Review/Bulk-Assign table no longer disappear; instead they show a "saved" pill plus an **Open in library** button that jumps to Libraries → `<lib>` → `<component>`, where you can edit offsets, replace 3D models, or open the symbol/footprint in KiCad — all without re-staging.
- **Edit-in-KiCad buttons in library mode.** SymbolPreview and FootprintPreview now expose the **Edit in KiCad** button regardless of staging vs library context (previously buttons were only visible in staging mode).

### Fixed
- **PropertyEditor stuck on "Loading properties…" in library mode.** It was calling `parts.read_meta` with a staging-mode path. Library mode now routes through `library.read_props` / `library.write_props` against the committed `.kicad_sym`.
- **Legacy layer aliases broke 3D render on real JLC2KiCadLib output.** `kicad-cli pcb render` rejects boards whose embedded footprints reference legacy layer names like `(layer "User.Comments")` (it rescues unknown names to `"Rescue"`, then refuses to load). The new render path rewrites both bare and quoted forms (`User.Comments → Cmts.User`, `User.Drawings → Dwgs.User`, etc.) before splicing.

### Notes
- The previous `pcbnew`/`python3 -c` board-build pipeline is gone — the sidecar no longer needs the system pcbnew Python module at runtime, simplifying the bundled-deb shape.
- `render_3d.py` unit tests were rewritten to mock only `subprocess.run` (kicad-cli) — no more `_dual_subprocess_mock`. 8 tests cover command shape, error capture, FileNotFoundError, model-path resolution, layer-alias rewrites in both forms, spliced-board structure validity, env scrub, and missing-footprint guard.

## [26.4.27-alpha.21] — 2026-04-28

### Fixed
- **Symbol preview failed with `OPENSSL_3.2.0 not found` on the user's machine.** The PyInstaller-bundled sidecar sets `LD_LIBRARY_PATH` to its `_MEIPASS` extraction dir (which contains the libssl/libcrypto frozen at build time). When the sidecar shells out to system kicad-cli, that env var leaks in — kicad-cli's libcurl loads PyInstaller's bundled libssl, finds it doesn't export `OPENSSL_3.2.0`, and aborts. PyInstaller exposes the unmodified value as `LD_LIBRARY_PATH_ORIG`; we now restore it (or unset it entirely) before spawning kicad-cli for both symbol/footprint render and footprint-icon thumbnail generation. Same treatment for `DYLD_LIBRARY_PATH` on macOS.
- **Footprint preview "No .kicad_mod could be matched" was a dead-end error.** When the symbol's `Footprint` property pointed somewhere that didn't resolve and no fallback matched, the user got `No .kicad_mod could be matched for symbol 'X' in <path>` with no clue what to fix. Improved error: now shows the Footprint property kibrary saw and lists the actual files in the `.pretty` directory (truncated past 6) so the user can spot the mismatch. Also added a fourth fallback that scans every `.kicad_mod` in the dir and matches by *internal* `(footprint "X" …)` / `(module "X" …)` header — picks up libraries where the file was renamed but the embedded name still matches.
- **3D Model card showed literal `${KSL_ROOT}/...` instead of the resolved workspace path.** `library.get_3d_info` now returns `resolved_path` (with `${KSL_ROOT}` expanded to the workspace root) and `file_exists` (whether the .step/.wrl actually lives there). Model3DPreview displays the resolved path, and surfaces a *⚠ Model file not found at this path* warning when `file_exists` is false — so when the .step is missing on disk the user knows that's why pcbnew's 3D viewer shows nothing.
- **`KSL_ROOT` was never registered with KiCad.** kibrary commits 3D paths as `${KSL_ROOT}/<lib>/<lib>.3dshapes/<file>` — but unless KiCad's `kicad_common.json` has `environment.vars.KSL_ROOT = <workspace_root>`, neither pcbnew nor the 3D viewer can resolve them. Auto-register now writes that path variable on every `library.commit` (idempotent — same-value writes are skipped, file is backed up to `.backup` on first modification). Original CLI parity restored.

### Notes
- The diagnostic `Files in <pretty>:` summary truncates past 6 entries to keep the toast readable. Full list is logged to the sidecar stderr.
- README screenshots regenerated to show the resolved path (`/tmp/e2e-workspace/...`) instead of the previous literal `${KSL_ROOT}`.

## [26.4.27-alpha.20] — 2026-04-28

### Fixed
- **3D Model card showed "No 3D model attached" on every committed component** even when JLC2KiCadLib had downloaded the `.step` and `library.commit` had rewritten the `(model …)` path to `${KSL_ROOT}/<lib>/<lib>.3dshapes/<file>`. Same root cause as the alpha.18.1 footprint render bug: `files.get_3d_info` looked for `<MPN>.kicad_mod` (e.g. `0603WAF1002T5E.kicad_mod`) but committed footprints are named after the package (e.g. `R0603.kicad_mod`). Refactored `lib_scanner._find_footprint` to honour the symbol's `Footprint` property — `<library>:<footprint_name>` — and look up `<pretty>/<footprint_name>.kicad_mod` first, then fall back to the literal-name lookup. Both `library_render_footprint_svg` and `_resolve_kicad_mod` now route through this single resolver, so the symbol↔footprint name mismatch is fixed everywhere it appeared.
- **Smoke spec now asserts the 3D card.** The REAL-WORLD probe (alpha.18.1) was checking only the symbol + footprint `<img>` mounts; it didn't catch that the 3D card was always falling into the empty state. Probe now calls `library.get_3d_info` directly + asserts the DOM doesn't contain the literal "No 3D model attached" string + screenshots `renderers-3d-info.png` after scrolling the card into view.

### Notes
- README updated with two new screenshots — `docs/screenshot-preview-symbol-footprint.png` (kicad-cli SVG render of the resistor symbol + footprint) and `docs/screenshot-preview-3d-model.png` (3D Model card with STEP filename, offset/rotation/scale, full `${KSL_ROOT}` path) — captured directly from the smoke run on a real `library.commit`-ed component, not synthetic seeds.
- The sidecar's resolver does NOT touch the staging-mode path (`get_3d_info(staging_dir, lcsc)`) — that one already worked because staged parts have a single `.kicad_mod` and we glob the `.pretty` dir.
- 3D model is *displayed as info* (filename, format, position, full path) — not 3D-rendered. KiCad's `kicad-cli pcb render` requires a fully-formed `.kicad_pcb` skeleton that's still pending. Click **View 3D in KiCad** in staging mode to open the footprint editor; press Alt+3 there for the actual 3D viewer.

## [26.4.27-alpha.19] — 2026-04-28

### Fixed
- **Footprint renderer was using the symbol name as the footprint name.** alpha.18 shipped with a smoke test that hand-renamed `<package>.kicad_mod` → `C25804.kicad_mod` in the seed library, so kicad-cli matched it by filename and the test passed even though the production code path was broken. On a real committed library the .kicad_mod file keeps its package name (e.g. `R0603.kicad_mod`), the symbol's entry name is the MPN (e.g. `0603WAF1002T5E`), and asking kicad-cli for `--footprint 0603WAF1002T5E` fails because no such file exists. The handler now reads the symbol's `Footprint` property (`<library>:<footprint_name>`), strips the prefix, and passes the actual footprint name. Empirically verified: kicad-cli matches by FILE basename in the .pretty dir, not the internal `(footprint "name" ...)` header — so the strategy is "pass the file stem".
- **Unit sub-symbols leaked into the Libraries tree.** `lib_scanner.list_components` was returning every entry in the .kicad_sym, including the `_0_1`/`_1_1` unit definitions that share an entryName base with their parent. Clicking one called `kicad-cli sym export svg --symbol <name>_0_1`, which kicad-cli rejects with "There is no symbol selected to save" because units aren't standalone exports. List now filters by `unitId is None`, matching what `lcsc_index` already did.
- **kicad-cli stderr was swallowed.** Failed renders surfaced as `subprocess.CalledProcessError: ... returned non-zero exit status 1` in the UI — no clue what kicad-cli was complaining about. Code now captures stdout/stderr and raises a `RuntimeError` with the actual diagnostic ("There is no symbol selected to save", "Footprint X not found", etc.). When the renderer fails for the user reading this changelog, the `Preview failed:` message now says *why*.
- **LibPicker labelled fuzzy-boost-demoted derived name as "match" when it doesn't exist yet.** alpha.18's fuzzy boost demotes the category-derived name (e.g. `Connectors_KSL`) into `matches[]` when an existing close match (`Connector_KSL`) wins. But `Connectors_KSL` doesn't exist in the workspace — picking it would *create* a new library — so the amber **match** badge was wrong. LibPicker now checks workspace membership when assigning the badge: existing → `match`, not-existing → `new`.

### Notes
- The smoke spec now includes a REAL-WORLD probe (`renderers-real-world.png`) that actually commits a downloaded JLC part via `library.commit` and renders the resulting committed library by its MPN-named symbol — exactly the path that broke in alpha.18. Synthetic seeds remain (alpha.17 pill probe needs them) but they no longer mask production code paths.
- 3D model previews are still pending — `kicad-cli pcb render` exists and works on real PCBs, but requires a fully-formed `.kicad_pcb` skeleton wrapping the footprint that's hard to hand-write reliably. Deferred to a later alpha.

## [26.4.27-alpha.18] — 2026-04-28

### Added
- **Fuzzy library suggestion (≥50% boost).** When the category-derived library name closely resembles an existing library, the `library.suggest` RPC promotes the existing one to the top of the LibPicker. Example: a workspace already containing `Connector_KSL` (singular) and a part categorised as "Connectors" (plural-derived `Connectors_KSL`) now defaults to `Connector_KSL` instead of silently creating a near-duplicate library. Scoring uses `difflib.SequenceMatcher` on the de-suffixed names (`_KSL` is shared noise across all kibrary libs and was inflating ratios for unrelated pairs); threshold is 0.5 — empirically separates `Connectors↔Connector` (0.95) from `Resistors↔Tools` (0.28). The original derived name still surfaces in `matches` so the user can pick "create new" if the boost mis-fires. 8 unit tests + a smoke-ui end-to-end probe assert the boost fires for similar pairs and stays quiet for unrelated ones.
- **KiCad install detection + Settings picker.** Sidecar's `kicad.detect` RPC (already shipped) now auto-picks the first detected install on first run and persists the choice in `settings.kicad_install`. New RPCs `kicad.get_active` / `kicad.set_active` let the UI read/write the active install. New "KiCad install" card in Settings shows a `<select>` dropdown of all detected installs (populated from `kicad.detect`) or — when no install is found — a muted warning telling the user to install KiCad and restart kibrary. The card explains the practical effect: new libraries are auto-linked to this install's `sym-lib-table` + `fp-lib-table`. 10 unit tests + a smoke-ui probe assert the card renders in both states.
- **Auto-register libraries on commit.** `library.commit` now calls `kicad_register.register_library(active_install, target_lib, lib_dir)` after a successful commit, mirroring the original CLI script's behaviour: kibrary writes the new library into the active KiCad install's `sym-lib-table` + `fp-lib-table` so the symbols + footprints appear immediately in eeschema/pcbnew without manual library-table editing. Failures (no active install, file lock, malformed table) are swallowed so they never abort the commit — kibrary logs the warning and the user can register manually. 3 unit tests cover the no-install, with-install, and exception-swallowed paths.

### Fixed
- **Renderers (Symbol + Footprint preview) now actually render.** alpha.0 through alpha.17 used `kicanvas-embed` (a WebGL2-based KiCad-format renderer) which rendered solid cyan in webkit2gtk under Xvfb, and intermittently on user machines, because webkit2gtk's GL context doesn't reliably get DRI3 acceleration. Replaced kicanvas with `kicad-cli sym/fp export svg` — kicad-cli was already a hard dependency for footprint thumbnails (see `icons.py`), so the only new code is `svg_render.py` (~50 LOC) that shells out, picks the freshest `.svg` from the temp dir to be tolerant of kicad-cli version-dependent output filenames, and returns the SVG text. SymbolPreview/FootprintPreview now embed the result via `<img src="data:image/svg+xml;base64,...">` — same data:URL trick as the photo thumbnails. No WebGL anywhere. 5 unit tests mock subprocess.run and assert the kicad-cli command shape; smoke-ui's renderer probe drives the app to Libraries → Existing_KSL → C25804, asserts both `<img data-testid="symbol-preview-svg">` and `<img data-testid="footprint-preview-svg">` mount with `data:image/svg+xml` URLs (lengths 14690 / 13006 in the smoke run), and screenshots `renderers-libraries-room.png` for visual review. Removed `public/kicanvas.js` (475KB), `dist/kicanvas.js`, `src/kicanvas.d.ts`, and the `<script>` tag in `index.html`.
- **`test_icons.py` matched stale `--output-dir` flag.** The icons module was switched to `--output` in `b086ccf` (KiCad 9.0 rejects `--output-dir`) but the unit tests were not updated, so the test suite has been failing on `main` since that commit. Tests now match the actual flag.

### Notes
- `library.suggest` signature is unchanged for callers — same `{library, is_existing, existing, matches}` return shape; the boost just changes which name lands in `library` vs `matches`.
- The `kicad.detect` auto-pick clears stale install ids when the previously-active install no longer exists (e.g. user uninstalled KiCad 8 after kibrary cached the id) so settings can never get "stuck" pointing at a missing install.
- Sidecar test count: 197 → 204 (+7 from svg_render + suggest + active_install + register; 2 fixed icon tests).

## [26.4.27-alpha.17] — 2026-04-28

### Added
- **Duplicate / already-existing component indicator.** Search results now carry a muted slate `In library: <name>` pill inline next to their LCSC code when that LCSC is already present in some library of the open workspace. Hovering the pill surfaces the in-library symbol's `component_name` (useful when the part was renamed in LibPicker). The indicator is purely informational — the **+ Add** button still fires, so re-downloading a part remains a single click away. New sidecar RPC `library.lcsc_index(workspace) → { lcsc: { library, component_name } }` walks every `*.kicad_sym` once and claims a symbol via either an `entryName` matching `^C\d+$` (kibrary's default after commit) or a property keyed exactly `LCSC` (handles parts the user renamed but whose JLC2KiCadLib-set property survived). Index is rebuilt on workspace open / program launch and after every successful commit (bulk-assign and sequential), all fire-and-forget so the UI never blocks on it; on RPC failure the previous index is kept silently. New `src/state/lcscIndex.ts` module exposes the signal + `refreshLcscIndex(workspace)` helper, plus `__kibraryTest.lcscIndex()` / `__kibraryTest.refreshLcscIndex(ws)` hooks for the smoke harness.

### Notes
- 7 new sidecar unit tests cover empty workspace, LCSC-named symbols, renamed symbols with the `LCSC` property, no-match symbols, multi-library collision (alphabetical-first wins), corrupt `.kicad_sym` skipped, and unit sub-symbols not double-counted. Smoke-ui plants a synthetic `Existing_KSL` library on disk mid-run, force-refreshes the in-app index via the test hook, then drives the search input and asserts both the DOM `[data-testid="lcsc-in-library-pill"]` element appears and its text names the seeded library — screenshot `lcsc-in-library-pill.png` is captured for visual review.

## [26.4.27-alpha.16] — 2026-04-28

### Fixed
- **Search-pane toggle no longer crowds adjacent buttons.** alpha.15 positioned the open-state toggle as `absolute top-0 right-0` of the pane body; on the user's screen it sat tight against the `search.raph.io` pill and visually competed with neighbouring controls. Toggle is now an inline flex item in the pane title row's right-side group, so the layout is fully linear and the button has its own column. Same `[data-testid="search-pane-toggle"]` testid; same chevron iconography; behaviour unchanged.
- **Stock filtering — server-side request + client safety net.** SearchPanel forwards `stockFilter=lcsc|jlc|both` per alpha.15's API prompt. Both LCSC + JLC stock checkboxes default to **on** so a fresh install gets useful results immediately. Smoke-ui's end-to-end probe of `stockFilter=both` revealed the server's `both` clause isn't strictly AND-enforced (returns rows where one source is out of stock — see `jlc-search/updated_api_prompt.md`'s status update for the empirical evidence), so the client-side predicate stays as defence-in-depth. Single-source `lcsc` / `jlc` modes are correct server-side; the predicate is a no-op for those.

### Changed
- **LibPicker shows the green `new` badge for any user-typed unknown library name.** Previously the empty-list fallback only said *"No match — keep typing to create &lt;name&gt;"* — informational text, no actionable cue. Now the typed text appears as a clickable row with the same emerald **new** badge the suggested-from-category entry uses, so it's visually obvious that pressing it creates the library.
- **Removed the *Suggested* column from Bulk Assign.** It duplicated info the LibPicker already surfaces (the suggested name is the input's default value AND the badged top entry in its dropdown). Saves ~140 px of horizontal real estate per row, helps the table fit at 1280 viewport without truncation.

### Notes
- Smoke-ui captures four screenshots: `add-room-empty.png` (pristine state — verifies toggle isn't crowding), `stock-dropdown.png` (verifies both checkboxes default-on, no toggle collision), `bulk-assign-filled.png` (post-download with collapsed pane + reclaimed width), `libpicker-new-badge.png` (typed-text "new" affordance). Each is asserted on by the spec — the build refuses to ship if any state breaks.
- The `stockFilter=both` server probe in smoke-ui logs a warning rather than fails when the configured `search.raph.io` returns mixed-stock rows — the kibrary client trusts the server. If your self-hosted server hasn't merged the change yet, tick the boxes off and on again to fall back to single-source `lcsc`/`jlc` filters which the older API has supported since alpha.13.

## [26.4.27-alpha.15] — 2026-04-28

### Added
- **Search Parts is now a collapsible right-side pane.** Default state: open at 360px (400px ≥1600 viewport) with the same Stock filter + search.raph.io link as before. Collapsed state: a 40px vertical rail with a chevron toggle and a rotated "Search Parts" label. Width animates over 200ms via Tailwind `transition-[width]`. Manual state persists via `localStorage('kibrary.searchPaneOpen')`. New testid `[data-testid="search-pane-toggle"]` exposes the toggle to e2e + screen readers (`aria-expanded`, `aria-controls`).
- **Auto-collapse on Download all.** Clicking Download all with a non-empty queue now synchronously collapses the search pane via `collapseSearchPane()` so Bulk Assign reclaims the freed ~320px before the first byte downloads. Manual toggle still wins after — auto-collapse fires once per click, never re-opens.
- **Sidecar `search.prefetch_photos` RPC.** A single round-trip warms the photo LRU for the first 6 results in parallel (vs N IPC calls one-per-row before). Frontend kicks it off the moment `setResults` lands so thumbnails settle while the DOM lays out.

### Changed
- **Add-room layout.** Two-column shell: fluid main column (Import + Queue + Bulk Assign stacked) on the left; sticky right pane (Search) that animates between open/collapsed widths. Bulk Assign no longer sits in its own bottom row — it stays directly under Queue and grows horizontally when the pane collapses, so the table's first row is now above the fold for a single-part download (was buried in alpha.14).
- **Search responsiveness, mirroring search.raph.io's web UI.**
  - Debounce window: 250ms → 80ms (matches `useSearch.ts:7`).
  - "Searching…" indicator now flips synchronously on input (was gated behind the debounce → felt dead for the first quarter-second).
  - Monotonic `requestSeq` race guard: a slow `STM` response can no longer stomp a fresh `STM32` one. (Tauri 2 has no AbortController forwarding into Rust, hence the counter rather than `signal`.)
  - First-paint thumbnail prefetch (see Added) replaces N independent IPCs with one batched call.
  - Sidecar httpx pool bumped 16→32 (8→16 keepalive); split connect/read timeouts (`connect=2.0, read=10.0`) so DNS hiccups fail fast instead of stalling the burst.
  - Auto-focus the input on mount; restore last query from `localStorage('kibrary.search.lastQuery')`.
- **Stock filter is now server-side.** SearchPanel forwards the LCSC/JLC checkbox combination as `stockFilter=lcsc|jlc|both` on the `/api/search` request (omits the param when both off — fully backwards-compatible). The previous client-side `filteredResults()` predicate is kept as a SAFETY NET so older self-hosted jlc-search servers (which don't recognize `stockFilter=both`) still produce a correct list. Wins: server returns only the relevant subset, pagination no longer hides matches, less bandwidth, no lag while the browser drops half the rows. Requires the new `stockFilter=both` value on the server — see `jlc-search/updated_api_prompt.md` written for the JLC-side maintainers.

### Notes
- `stockFilter=both` is brand-new on the API (the existing values `none|lcsc|jlc|any` were already accepted). Until that lands, "both checkboxes ticked" still works correctly because the client-side safety-net filter catches what the server failed to filter — but server-side bandwidth/pagination wins only kick in after the server upgrade.
- UX-loop process: alpha.15 went through three subagents (UX spec → 3 implementers in one round → UX sign-off) on real Tauri-webview-under-Xvfb screenshots. UX reviewer verdict: **APPROVE WITH POLISH** — three cosmetic items deferred to alpha.16: (1) collapsed-rail toggle button could use a border for affordance parity with the open-state button, (2) rotated "Search Parts" label needs `px-1` so it isn't pinned to the viewport edge, (3) tighten the chevron→label gap on the rail to read as one unit.

## [26.4.27-alpha.14] — 2026-04-27

### Added
- **Cancel/delete a downloaded part before committing.** Each row in *Bulk Assign to Libraries* now has a ✕ button (right-most column) that calls the new `parts.delete_staged` sidecar method to `rmtree(<workspace>/.kibrary/staging/<lcsc>)` *and* removes the queue entry. Previously the queue's own ✕ only dropped the row from the in-memory queue, leaving the staged files behind to clutter the workspace and forcing a manual `rm -rf` to retry a part. Idempotent — clicking ✕ on a row whose staging dir is already gone still cleanly dismisses the row.
- **Footprint name shown for each part.** Bulk Assign now displays the `.kicad_mod` filename JLC2KiCadLib produced (e.g. `R0603`, `LQFP-48_7x7mm_P0.5mm`) so users can confirm the package before picking a library. Captured at download time by reading `<lcsc>.pretty/*.kicad_mod` and persisted to `meta.json`'s new `footprint` key. Falls back to em-dash for parts whose footprint couldn't be determined.
- **Stock filter on the Search panel.** New **Stock** button opens a dropdown with two checkboxes — *In stock at LCSC* and *In stock at JLC*. Either, neither, or both can be active. Filter is purely client-side over the data already returned by `search.raph.io/api/search`, which now includes `stock` and `jlc_stock` numeric fields per result. Empty-state copy distinguishes "no matches" from "N matches filtered out by Stock" so users don't think their query broke.

### Changed
- **Add-room layout: Bulk Assign promoted to full width.** Previously: three-column grid with Bulk Assign squeezed under Import+Queue (≈2/3 width), forcing horizontal scrolling for the new Footprint and ✕ columns. Now: top row keeps Import + Queue (left, 2 cols) and Search (right, 1 col), but Search ends at the bottom of Queue rather than scrolling next to a tall table; Bulk Assign moves to its own full-width row below. Matches the user's "search module ends before the table" feedback.

### Notes
- No `search.raph.io` API change required for the stock filter — `stock` and `jlc_stock` are already in the `/api/search` response. If the JLC-app side ever wants to *narrow* search server-side (e.g. for paginated results where client-side filtering hides half the page), the API would need a `?in_stock=lcsc,jlc` query param; not pursued in this release.

## [26.4.27-alpha.13] — 2026-04-27

### Fixed
- **LibPicker no longer steals focus on every keystroke.** Typing into the Bulk-Assign library search defocused the input after each character — only the first letter actually landed. Cause: `ReviewBulkAssign` used `<For each={rows()}>` and `updateRow` returned brand-new row objects on every change, so SolidJS's identity-keyed `<For>` recreated the entire `<tr>` DOM (including the `<input>`) per keystroke. Switched to `<Index>` which keys on position, keeping the input element alive across updates so focus + caret + typing all persist.
- **LibPicker popover no longer clipped by the table.** Results extended below the visible row and forced scrolling because the popover was `position: absolute` inside an ancestor with `overflow-x-auto`. Now renders into a `<Portal>` at document body root with `position: fixed` coordinates derived from the input's bounding rect, capped at half the viewport height. Repositions on scroll/resize/open. Adds `e2e/specs/download-all.spec.ts` regression test that multi-char-types into the picker and asserts the full string lands.

## [26.4.27-alpha.12] — 2026-04-27

### Fixed
- **Thumbnails work again.** alpha.11 shipped with the search.raph.io API key missing its leading `-`, so `/api/kibrary/parts/<lcsc>/photo` 401'd and every part rendered as a red broken-image icon. Smoke-real and smoke-ui both passed because neither exercised the thumbnail path. `release.sh` now decodes the just-built binary's embedded key and probes the live `/photo` endpoint before publishing — any 401 aborts the release. The smoke-ui spec also asserts `search.fetch_photo` returns a data URL via the sidecar so the regression can't recur silently.
- **Bulk-Assign to Libraries: complete rebuild.** Four problems in one cell:
  1. **Contrast.** The native `<select>` rendered light-grey `<option>` text on a white background even in dark theme — `<option>` styling can't be controlled by parent CSS. Replaced with a custom SolidJS `LibPicker` (`src/components/LibPicker.tsx`) that uses themable `<button>` rows.
  2. **Existing libraries weren't listed.** The old picker hard-coded only two options (the suggestion + "Create new…"). New picker calls `library.suggest({category, workspace})` which now also returns the full set of existing library names + sidecar-pre-matched candidates.
  3. **No search.** Picker was a 2-option `<select>` with no filter. New `LibPicker` is a text input with a filtered popover — type to narrow, click to pick, free-text creates new.
  4. **Every part defaulted to `Misc_KSL`.** The download flow never wrote `category` to `meta.json`, so `library.suggest` got an empty category and fell back to the catch-all on every part. The downloader now best-effort-fetches `category/subcategory/description/mpn/manufacturer/package` from `search.raph.io/api/parts/<lcsc>` after each successful download and writes `meta.json`. Resistors → `Resistors_KSL`, MCUs → `MCU_KSL`, etc., per `category_map.default.json`. The smoke-ui spec asserts the C25804 (a Resistor) gets a non-`Misc_*` suggestion.

### Added
- **`scripts/release.sh` verify-key step.** XOR-decodes the embedded `search_api_key.bin`, hits the live `/api/kibrary/parts/C25804/photo` endpoint, refuses to publish on any non-200. Catches the alpha.11 class of bug at build time.
- **`src/components/LibPicker.tsx`** — a small searchable combobox component reused by ReviewBulkAssign. Three label kinds: `new` (suggested category-derived name), `match` (sidecar-fuzzy-matched existing lib), `exists` (every other existing lib in the workspace).
- **`library.suggest` is now workspace-aware.** Returns `{library, is_existing, existing, matches}`. Old single-key callers still work (back-compat: `existing` defaults to empty list).

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
