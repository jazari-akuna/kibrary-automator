# Changelog

All notable changes to Kibrary are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning is **CalVer with semver-compatible suffixes**: `YY.M.D-alpha.N` (e.g. `26.4.26-alpha.1` = first alpha build of 2026-04-26). Pre-release counter goes in the `-alpha.N` suffix; bump it for additional builds the same day.

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
