# Kibrary Automator — Desktop App Redesign

**Status:** Design approved 2026-04-25, pending user review of written spec.
**Authors:** raphaelcasimir.inge@gmail.com (user), Claude (Opus 4.7).
**Replaces:** the existing `kibrary_automator.py` CLI in this repo (kept alongside through P1, removed at end of P2).

**Scope of this document:** Full vision through P3. **Implementation plans are scoped per phase** — `docs/superpowers/plans/p1-*.md` covers only P1 work, and so on. This spec is the shared reference all phase plans cite.

---

## 1. Goals & non-goals

### 1.1 Goals
- Replace the interactive Python CLI with a **modern, fast-launching, cross-OS desktop app** that automates the JLCPCB → KiCad library workflow.
- Let the user **paste lists or BOMs of LCSC part numbers**, download them in parallel, **review/edit before commit**, and **commit each save to git automatically**.
- **Auto-suggest target libraries** based on LCSC categories (data sourced from `search.raph.io`).
- Be **fully usable without `search.raph.io`** — that integration is a helper, not a dependency.
- Phase 2: provide a **library management room** for browsing, editing, renaming, moving, and deleting committed components.
- Be developable on a **headless Linux server** (Claude must be able to screenshot the UI itself).

### 1.2 Non-goals
- Replicating KiCad's symbol/footprint editor inside this app. We hand off to KiCad's editors for graphical edits.
- Becoming a parts-search engine in our own right. Search lives in `search.raph.io`.
- Supporting EDA tools other than KiCad.
- Distributing pre-built libraries — we are a *tool* for users to build their own.

### 1.3 Success criteria for P1 (MVP)
- User pastes 5 LCSC numbers, hits one button, has 5 commits in their library repo + libraries registered in KiCad, in under 90 seconds, on Linux/macOS/Windows.
- App cold-launches in <200 ms.
- All app state lives in human-readable JSON files the user can hand-edit.
- New UI "blocks" can be added by dropping a file into a registry — no shell modifications.

---

## 2. Architecture

### 2.1 Process model

```
┌────────────────────────────────────────────────────────────┐
│  Kibrary.app  (single binary per OS)                       │
│                                                            │
│   Frontend (SolidJS + Tailwind + Vite)                     │
│      │   tauri.invoke('cmd', payload)                      │
│      ▼                                                     │
│   Rust core (Tauri)  ── owns: window, FS, settings,        │
│      │                       recent workspaces,            │
│      │                       Python sidecar lifecycle      │
│      │   JSON-RPC over stdin/stdout                        │
│      ▼                                                     │
│   Python sidecar (PyInstaller single-file binary)          │
│      ├── kibrary_core/   ← parsing, merging via kiutils    │
│      ├── jlc_runner.py   ← wraps JLC2KiCadLib              │
│      └── search_client.py ← HTTPS to search.raph.io        │
└────────────────────────────────────────────────────────────┘

External:
  • JLC2KiCadLib (bundled in venv inside the sidecar)
  • search.raph.io HTTPS API (optional)
  • KiCad config files on disk (sym-lib-table, fp-lib-table)
  • KiCad GUI binaries (spawned for symbol/footprint/3D edits)
```

### 2.2 Why this stack
- **Tauri**: ~15 MB bundle, cold launch ~80 ms, native system webview, cross-OS. Beats Electron on launch and bundle, beats native Qt on UI fidelity for the previews-heavy UX.
- **SolidJS**: ~7 KB runtime, no virtual DOM, fastest in the React-family lineup. Best fit for "launch extremely fast."
- **Python sidecar**: lets us reuse `kiutils` (mature KiCad-format library) and `JLC2KiCadLib` (already a Python tool) without re-implementing in Rust.
- **JSON-RPC over stdin/stdout** between Rust and Python: low overhead, no port conflicts, no firewall warnings.

### 2.3 Repo layout

```
kibrary-automator/
├── src-tauri/                ← Rust shell
│   ├── src/main.rs
│   ├── src/commands/         ← invokable from frontend
│   ├── src/sidecar.rs        ← spawn + lifecycle of Python
│   └── tauri.conf.json
├── src/                      ← SolidJS frontend
│   ├── App.tsx
│   ├── shell/                ← rooms, layout, sidebar
│   ├── blocks/               ← pluggable blocks (see §4.4)
│   │   ├── registry.ts
│   │   ├── SearchPanel.tsx
│   │   ├── StagingTray.tsx
│   │   └── ...
│   └── api/                  ← thin wrappers around tauri.invoke
├── sidecar/                  ← Python
│   ├── pyproject.toml
│   ├── kibrary_core/
│   │   ├── parser.py         ← kiutils wrappers
│   │   ├── library.py        ← create / merge / commit
│   │   ├── git.py
│   │   └── kicad_install.py  ← detect + register libs
│   ├── jlc_runner.py
│   ├── search_client.py
│   └── rpc.py                ← stdin/stdout JSON-RPC server
├── docs/superpowers/specs/   ← design docs
├── docs/superpowers/plans/   ← per-phase implementation plans
├── Dockerfile.dev            ← headless dev environment
├── kibrary_automator.py      ← legacy CLI, kept until P2
└── README.md
```

---

## 3. Workspace & data model

### 3.1 Workspace concept (VS Code style)
- A **workspace** is a folder = the user's KiCad library repo.
- App tracks **recent workspaces** in global settings; opening one becomes the current context.
- All per-workspace state lives in `<workspace>/.kibrary/` and is git-ignored.

### 3.2 On-disk layout per workspace

```
<workspace>/                    ← user's library repo (e.g. kicad-shared-libs)
│
├── .kibrary/                   ← app-managed, git-ignored
│   ├── staging/                ← in-progress downloads, pre-commit
│   │   ├── C1525/
│   │   │   ├── C1525.kicad_sym
│   │   │   ├── C1525.pretty/
│   │   │   ├── C1525.3dshapes/
│   │   │   └── meta.json       ← editable description, ref, target lib
│   │   └── C25804/...
│   ├── workspace.json          ← per-workspace settings
│   └── cache/                  ← thumbnails fetched from search.raph.io
│
├── Resistors_KSL/              ← committed libraries (unchanged convention)
├── Capacitors_KSL/
├── repository.json
└── ...
```

### 3.3 Global app data
Tauri's `app_data_dir`:
- Linux: `~/.config/kibrary/`
- macOS: `~/Library/Application Support/kibrary/`
- Windows: `%APPDATA%\kibrary\`

Files:
- `settings.json` — theme, recent workspaces, search.raph.io API key, default concurrency
- `kicad-installs.json` — cached KiCad detection results
- `category-map.json` — LCSC category → KSL library mapping (see §7)

### 3.4 Per-workspace settings file (`workspace.json`)

```json
{
  "version": 1,
  "kicad_target": "flatpak-9.0",
  "git": {
    "enabled": true,
    "auto_commit": true,
    "commit_template": "Add {lcsc} ({description}) to {library}"
  },
  "concurrency": 4
}
```

### 3.5 Per-staged-part state (`meta.json`)

```json
{
  "lcsc": "C1525",
  "status": "ready",
  "downloaded_at": "2026-04-25T18:33:11Z",
  "category": "Resistors",
  "subcategory": "Chip Resistor - Surface Mount",
  "suggested_library": "Resistors_KSL",
  "target_library": "Resistors_KSL",
  "edits": {
    "description": "10kΩ 0402 thick film",
    "reference": "R?",
    "datasheet": "https://..."
  }
}
```

Status values: `queued | downloading | ready | committing | committed | failed`.

---

## 4. UX — block-based shell

### 4.1 Three rooms (left rail)

```
┌─────────┬───────────────────────────────────────────────┐
│ Kibrary │  Header: workspace selector ─ KiCad target    │
│         │  ────────────────────────────────────────────  │
│  ◉ Add  │                                               │
│  ◉ Libs │       (room content here)                     │
│  ◉ Set  │                                               │
│ recents │                                               │
└─────────┴───────────────────────────────────────────────┘
```

- **Add** — the core flow (P1).
- **Libraries** — manage committed libs (P2).
- **Settings** — workspace + global settings.

### 4.2 Add room — block layout

```
┌──── Search panel (block, optional) ──┐  ┌──── Import block ────┐
│ [search.raph.io query...]            │  │  textarea (paste)    │
│ ┌──┐ C1525 10kΩ 0402  +Add           │  │  Detected: 3 parts   │
│ │📷│ C25804 100nF 0402 +Add          │  │  [Queue all →]       │
│ └──┘ ...                             │  └──────────────────────┘
└──────────────────────────────────────┘

┌──── Queue / Review block ────────────────────────────────────┐
│ Mode: ◉ Sequential  ○ Pick from list  ○ Bulk assign         │
│ ────────────────────────────────────────────────────────────  │
│ (mode-specific UI: editor pane, grid, or table)             │
└──────────────────────────────────────────────────────────────┘
```

### 4.3 Editing model — in-app vs KiCad handoff

| Edit | Where | How |
|---|---|---|
| Description, reference, value, datasheet, library target, tags | **In-app form fields** | Sidecar parses `.kicad_sym` via `kiutils`, frontend shows fields, autosaves |
| Symbol graphics, pins, geometry | **KiCad Symbol Editor** | App spawns it pointed at staged file |
| Footprint pads, courtyard, silkscreen | **KiCad Footprint Editor** | App spawns it pointed at `.kicad_mod` |
| 3D model offset / rotation / scale | **KiCad Footprint Editor** (3D properties) | Same handoff |

In-app **previews** (always visible, read-only):
- Symbol + footprint: `kicanvas` (WebGL2, MIT-licensed) embedded as `<KiCanvas src=…/>` Solid component.
- 3D: `three.js` loading `.step` / `.wrl` directly.

**File-watch loop:**
```
User clicks ✎ on symbol preview
  → Tauri spawns the appropriate KiCad editor binary
    (exact invocation resolved at runtime — see §4.3.1)
  → User edits, saves
  → Rust fs-watcher (notify crate) sees mtime change
  → Sidecar re-parses → frontend re-renders kicanvas preview
```

#### 4.3.1 KiCad editor invocation (exact commands resolved per install)
KiCad's CLI surface differs across versions and packaging. The sidecar resolves the right binary at runtime from the cached `kicad-installs.json`. Approximate invocations:

| Edit target | Linux (regular) | Linux (Flatpak) | macOS | Windows |
|---|---|---|---|---|
| Symbol | `eeschema --symbol-editor <file>` (KiCad 7+) | `flatpak run --command=eeschema org.kicad.KiCad --symbol-editor <file>` | `/Applications/KiCad/KiCad.app/Contents/MacOS/eeschema --symbol-editor <file>` | `"C:\Program Files\KiCad\<ver>\bin\eeschema.exe" --symbol-editor <file>` |
| Footprint / 3D offset | `pcbnew --footprint-editor <file>` | analogous | analogous | analogous |

The exact flags may shift between KiCad 7/8/9; the `kicad_install.py` module maintains a per-version invocation table. This is implementation detail — captured here so the implementor knows it's a real piece of work, not a one-line subprocess call.

### 4.4 Block registry pattern

```ts
// src/blocks/registry.ts
export const blocks = {
  'search-panel':   () => import('./SearchPanel'),
  'import':         () => import('./Import'),
  'queue':          () => import('./Queue'),
  'symbol-preview': () => import('./SymbolPreview'),
  'fp-preview':     () => import('./FootprintPreview'),
  '3d-preview':     () => import('./Model3DPreview'),
  'diff-preview':   () => import('./DiffPreview'),       // P2
  'bom':            () => import('./BomBlock'),          // P3
};
```

Adding a new block: create file in `src/blocks/`, add one line in `registry.ts`. Rooms reference blocks by ID in JSON layout config.

---

## 5. Input flow — paste-based, parallel download

### 5.1 The single import block
One textarea accepts:
- **CSV BOM**: `C234324, 2\nC393943, 5\nC12345` (LCSC, qty per line)
- **Bulk list**: `C234324, C393943, C12345` (just LCSC numbers, comma-separated)

### 5.2 Parser rules (in sidecar)
- **Step 1 — split on newlines.** If the input has 2+ non-empty lines, treat it as a BOM (one part per line, line tokens = `LCSC` or `LCSC, qty`).
- **Step 2 — single-line input.** If the input has only one non-empty line, treat the whole line as a comma-separated list of LCSCs with qty=1 each (regardless of how many commas it contains).
- This resolves the ambiguity of `C123, 5` on its own line: single-line input is *always* a list, so `C123, 5` becomes one valid LCSC + one invalid token (highlighted).
- Whitespace tolerant. Ignores blank lines and `#` comments.
- Validates `^C\d+$` per token. Invalid tokens are highlighted with line numbers; valid ones still queue.
- **Override:** if the input matches the strict CSV pattern `^C\d+,\s*\d+$` per non-empty line (every line has exactly LCSC + integer qty), it is always interpreted as a BOM, even if there's only one line.

### 5.3 Parallel download
- Default **4 concurrent** `JLC2KiCadLib` invocations (configurable in `workspace.json`).
- Each download isolated in `.kibrary/staging/<LCSC>/` (per-part dir, no collisions).
- Per-part status transitions; failed parts get a "Retry" button. Not all-or-nothing.

### 5.4 Live progress
```
C234324  ━━━━━━━━━━ ready    [Review] [Commit]
C393943  ━━━━━━━╸    78%
C12345   ━╸           queued
```

---

## 6. Review modes

Three modes, selectable from the queue header per batch:

| Mode | Best for | Flow |
|---|---|---|
| **Sequential** | Mixed batch, careful review | One part fills the editor pane. `[Skip] [Discard] [Commit & next]`. Walks the queue. |
| **Pick from list** | Cherry-pick | Grid/list of cards. Click any → opens editor. Jump around freely. |
| **Bulk assign** | Trusted parts, fast lane | All parts in a table. Each row = LCSC, suggested lib (auto), override dropdown. One `[Save all to libraries]` button. No symbol/footprint review. |

### 6.1 Bulk assign table

```
LCSC      Description           Suggested lib       Override
C234324   10kΩ 0402 thick film  Resistors_KSL  ✓    [▼]
C393943   100nF 0402 X7R        Capacitors_KSL ✓    [▼]
C12345    STM32G030F6P6         MCU_KSL        ✓    [▼ create new...]
                                          [Save all 3 to libraries]
```

### 6.2 Editor pane (used by Sequential and Pick modes)
- In-app form fields for properties (autosaves to `meta.json`).
- Three preview blocks: symbol, footprint, 3D — each with an `✎ Edit in KiCad` button.
- Target library dropdown with "create new" option.
- `[Discard]` removes from staging. `[Commit to library]` runs the commit pipeline (§9).

---

## 7. Library auto-suggestion (LCSC category → KSL)

### 7.1 Source of truth
`/root/jlc-search/ingest/src/jlcpcb-shared.ts` — 49 canonical category entries (incl. legacy renames). JLCPCB has 2-level hierarchy (`category`, `subcategory`); we use `category` for library, `subcategory` only for tags.

### 7.2 Mapping file
`~/.config/kibrary/category-map.json`, ships with sensible defaults, user-editable in Settings:

```json
{
  "Resistors":                           "Resistors_KSL",
  "Capacitors":                          "Capacitors_KSL",
  "Inductors, Coils, Chokes":            "Inductors_KSL",
  "Diodes":                              "Diodes_KSL",
  "Transistors / Thyristors":            "Transistors_KSL",
  "Embedded Processors & Controllers":   "MCU_KSL",
  "Power Management (PMIC)":             "PowerMgmt_KSL",
  "Power Management":                    "PowerMgmt_KSL",
  "Amplifiers / Comparators":            "Amplifiers_KSL",
  "Logic":                               "Logic_KSL",
  "Memory":                              "Memory_KSL",
  "Connectors":                          "Connectors_KSL",
  "Switches":                            "Switches_KSL",
  "Crystals, Oscillators, Resonators":   "Oscillators_KSL",
  "Clock/Timing":                        "Oscillators_KSL",
  "Circuit Protection":                  "Protection_KSL",
  "Fuses":                               "Protection_KSL",
  "Sensors":                             "Sensors_KSL",
  "Magnetic Sensors":                    "Sensors_KSL",
  "Data Acquisition":                    "DataAcq_KSL",
  "Interface":                           "Interface_KSL",
  "Signal Isolation Devices":            "Interface_KSL",
  "Optoisolators":                       "Interface_KSL",
  "Optoelectronics":                     "Optoelectronic_KSL",
  "LED Drivers":                         "Optoelectronic_KSL",
  "Filters":                             "Filters_KSL",
  "RF and Wireless":                     "RF_KSL",
  "IoT/Communication Modules":           "RF_KSL",
  "Power Modules":                       "Power_KSL",
  "Motor Driver ICs":                    "MotorDriver_KSL",
  "Audio Products / Vibration Motors":   "Audio_KSL",
  "Buzzers & Speakers & Microphones":    "Audio_KSL",
  "Displays":                            "Display_KSL",
  "Relays":                              "Relays_KSL",
  "Silicon Carbide (SiC) Devices":       "SiC_Devices_KSL",
  "Gallium Nitride (GaN) Devices":       "GaN_Devices_KSL",
  "Industrial Control Electrical":       "Industrial_KSL",
  "_unknown":                            "Misc_KSL"
}
```

### 7.3 Resolution algorithm
1. Sidecar fetches part metadata from `search.raph.io` API → `{category, subcategory}`.
2. Look up `category` in `category-map.json`. Match → suggested lib.
3. No match → `Misc_KSL`, log a warning, prompt user to add a mapping.
4. User can override per-part in the bulk-assign table or sequential editor.

### 7.4 Edge cases (per category research)
- **Deprecated category names** → all aliased to current names in the mapping file.
- **New/unknown categories** → fall through to `Misc_KSL`.
- **Mechanical / non-schematic categories** (Hardware Fasteners, Wires & Cables, Consumables, Battery Products, Development Boards) → all routed to `Misc_KSL`.
- **SiC / GaN** → start as separate libs, easy to merge later by editing the map.

---

## 8. search.raph.io integration (fully optional)

### 8.1 UI placement
Collapsible side panel next to the import block. Toggle on/off in the top bar even when API key is set (per-session privacy).

### 8.2 Endpoints used (existing in jlc-search)
| Endpoint | Purpose |
|---|---|
| `GET /api/search?q=...` | Search panel results |
| `GET /api/parts/:lcsc` | Detail metadata for staging (drives auto-categorize) |
| `GET /api/parts/:lcsc/photo` | Thumbnails in search & staging |

### 8.3 Endpoints to add (separate jlc-search work, out of scope here)
| Endpoint | Purpose |
|---|---|
| `GET /api/parts/batch?lcsc=C1,C2,C3` | One round-trip per queue, not N |

### 8.4 Auth
API key in `~/.config/kibrary/settings.json`, sent as `Authorization: Bearer ...`. Empty key:
- Search panel hidden.
- Category lookup falls back to `Misc_KSL` + a "set API key for auto-categorize" hint.
- Paste-box and full pipeline still work.

### 8.5 Offline behavior
If `search.raph.io` unreachable: search panel shows "Offline — paste LCSC codes manually." All other functionality unchanged.

---

## 9. Git tracking & first-run

### 9.1 Setting (in `workspace.json`)
```json
{
  "git": {
    "enabled": true,
    "auto_commit": true,
    "commit_template": "Add {lcsc} ({description}) to {library}"
  }
}
```

### 9.2 First-run wizard (3 panes, per workspace)
1. Pick library workspace folder (or use the one launched against).
2. Detect KiCad install (auto-fills, user confirms).
3. Choose git tracking mode:
   - Auto-commit each save (default)
   - Track but commit manually
   - Disable git tracking

The same three toggles live in Settings → always editable.

### 9.3 Per-save flow when auto-commit on
```
User clicks "Commit to library"
  → sidecar writes files into <Library>_KSL/
  → updates repository.json
  → git add <Library>_KSL/ repository.json
  → git commit -m "Add C1525 (10kΩ 0402) to Resistors_KSL"
  → frontend toast: "Committed C1525 → Resistors_KSL  [↩ Undo]"
```
Undo = `git reset --hard HEAD~1`, only available for ~30 s, only if HEAD matches what we just made.

### 9.4 Edge cases
- Workspace not a git repo → first-run wizard offers `[Initialize git repo]` button, or pick "Disable git tracking."
- Working tree dirty when committing → app shows the existing diff and asks "Commit our changes anyway? Or commit existing changes first?"
- Detached HEAD / bisect / rebase in progress → app refuses to auto-commit, shows reason in toast.

---

## 10. Library management (Phase 2)

### 10.1 Room 2 layout
```
┌─ Libraries (12) ───┐ ┌─ Resistors_KSL (47 components) ──────┐
│ ▸ Capacitors_KSL 18│ │ Search: [10k_____]                  │
│ ▾ Resistors_KSL  47│ │  ☐ R_10k_0402     10kΩ 0402  ✎ 🗑   │
│   • R_10k_0402     │ │  ☐ R_4k7_0402     4.7kΩ 0402 ✎ 🗑   │
│ ▸ MCU_KSL         5│ │ Bulk: [Move…] [Delete] [Re-export]  │
│ + New library      │ │ [Detail pane: previews + props]     │
└────────────────────┘ └─────────────────────────────────────┘
```

### 10.2 Operations (each = one git commit when auto-commit on)
| Op | Implementation |
|---|---|
| Rename component | `kiutils` rewrites `(symbol "...")`, updates fp ref, updates 3D path |
| Move to other library | Cut+paste between `.kicad_sym` files, copy `.kicad_mod` and `.3dshapes` files |
| Edit properties | Same in-app form as Room 1 staging |
| Edit symbol/footprint/3D | Hand off to KiCad editor (same as Room 1) |
| Delete | Remove from `.kicad_sym`, delete fp + 3D files |
| Re-export to KiCad | Re-run install logic into `sym-lib-table` / `fp-lib-table` |
| Rename library | Folder rename + update `repository.json`, `metadata.json`, all internal refs |

### 10.3 New blocks introduced in P2
- **Diff preview** — S-expr-aware diff of `.kicad_sym` before commit (via `kiutils`).
- **Library metadata editor** — `metadata.json` exposed as a form (description, license, maintainer, version bump).

---

## 11. Phasing

| Phase | Scope | "Done" looks like |
|---|---|---|
| **P1 — MVP** | Tauri+Solid+sidecar shell, paste-import, parallel download, sequential+bulk review, in-app property edit, kicanvas previews, KiCad editor handoff, commit-to-library, KiCad install registration, first-run wizard, git auto-commit | One workspace, one batch import, ends with parts in KiCad ready to use |
| **P2 — Library mgmt** | Room 2 (browse/edit/move/rename/delete), library-level metadata editor, S-expr-aware diff preview block | Existing libraries fully manageable from the GUI |
| **P3 — Polish** | search.raph.io batch endpoint, BOM block, JLC stock-check block, auto-update, signed installers (mac/win), light/dark theme | Production-grade ship |

---

## 12. Headless development environment

### 12.1 Dockerfile.dev (ships with repo)
Concrete starting point — implementor will refine versions and pin digests during P1 task 1:
```dockerfile
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl git ca-certificates pkg-config \
    libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev libsoup-3.0-dev \
    libayatana-appindicator3-dev librsvg2-dev \
    xvfb webkit2gtk-driver \
    python3.12 python3.12-venv python3-pip \
    kicad \
    && rm -rf /var/lib/apt/lists/*

# Node + pnpm via Volta (single-binary install, no shell rc edits)
RUN curl https://get.volta.sh | bash -s -- --skip-setup
ENV VOLTA_HOME=/root/.volta
ENV PATH=$VOLTA_HOME/bin:$PATH
RUN volta install node@20 pnpm

# Rust + cargo via rustup
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH=/root/.cargo/bin:$PATH

# Tauri WebDriver + Playwright Chromium for headless screenshots
RUN cargo install tauri-driver
RUN pnpm dlx playwright install --with-deps chromium

WORKDIR /workspace
CMD ["bash"]
```

### 12.2 Repo scripts Claude calls during UI work
| Script | What it does |
|---|---|
| `pnpm dev` | Vite dev server on `:5173` (no Tauri) |
| `pnpm screenshot <route>` | Headless Chromium → opens `http://localhost:5173<route>` → PNG to `screenshots/` |
| `pnpm storybook` | Storybook on `:6006` for per-block dev |
| `pnpm screenshot:story <id>` | PNG of one Storybook story |
| `pnpm tauri:dev:headless` | `xvfb-run cargo tauri dev` |
| `pnpm tauri:e2e` | `tauri-driver` + Playwright tests, full shell with screenshots |

### 12.3 Hooks (Claude Code project settings)
- `PreToolUse` on Write/Edit of `src/blocks/*.tsx` → reminder to run `pnpm screenshot:story <block>` after.
- `Stop` hook → run `pnpm typecheck && pnpm lint && pnpm test:visual` before letting Claude declare done.

### 12.4 Loop
Claude runs `docker compose up dev -d`, then `docker exec ... pnpm screenshot /add`, then `Read screenshots/add.png`, sees the result, iterates. No human needed in the loop.

---

## 13. Claude autonomy strategy

### 13.1 Tools per task type
| Approach | Use it for | Why |
|---|---|---|
| Plain Claude Code with the spec + plan | Day-to-day work, Rust commands, Solid components, Python sidecar functions | Spec + per-phase plan = enough scaffolding for sustained autonomy |
| `feature-dev` skill | Each numbered task in the implementation plan | Right shape: explore → architect → implement → review |
| Subagents (`Explore`) | Codebase-wide questions ("where is X used?") | Cheap, parallelizable, protects main context |
| `subagent-driven-development` | When a phase has 6+ independent tasks | Fan out parallel work after spec stabilizes |
| `code-reviewer` agent | After each major task / before merging to main | Independent eyes catch what the implementer missed |
| Hooks (via `update-config`) | `PreToolUse` for `cargo`/`pnpm`/`pip` to enforce formatting/lints; `Stop` hook to run typecheck | Background quality gate without prompting |

### 13.2 Recommended Claude prompt template per task (in CLAUDE.md)
```
Read the spec at docs/superpowers/specs/2026-04-25-kibrary-redesign.md
Read the plan at docs/superpowers/plans/<phase>-<task>.md
Implement <task>. Use feature-dev skill. After implementation, request 
code-review. Run `pnpm test && cargo test && pytest sidecar/`.
For UI tasks: also run `pnpm screenshot:story <block>` and Read the PNG 
before declaring done.
Stop only when tests pass and review approved.
```

---

## 14. Open questions (to resolve in implementation plan)
- Choice between PyInstaller, PyOxidizer, or Nuitka for the Python sidecar binary (impacts size and build complexity).
- Code-signing strategy for macOS and Windows distributables.
- Whether to ship `kicanvas` as an npm dep or vendored — depends on bundler ergonomics.
- Granularity of the JSON-RPC protocol between Rust and Python (one giant `invoke` method vs. many).
- Auto-update channel: GitHub Releases vs. self-hosted.
