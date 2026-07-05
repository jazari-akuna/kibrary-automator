# KiCad Library Automator

**Turn JLCPCB / LCSC part numbers into organized, installed KiCad libraries — from one terminal command.**

`kibrary_automator.py` downloads a part with [JLC2KiCadLib](https://github.com/TousstNicolas/JLC2KiCad_lib), shows you a preview of the symbol and footprint, fills in its description and datasheet from the LCSC API, files it into a `*_KSL` library (new or existing), and registers that library with your KiCad install — all in one interactive pass.

It is a single self-contained Python script. On first launch it builds its own private virtualenv (Rich + JLC2KiCadLib); there is nothing to `pip install` by hand.

---

## Quick start

```bash
git clone https://github.com/your-username/kibrary-automator.git

# Run it from anywhere. First launch sets up its environment, then asks
# once where your KiCad library repository lives (remembered from then on).
python3 kibrary-automator/kibrary_automator.py add C1525 C25804 R25604
```

Part numbers can also be typed interactively if you omit them. Bare part numbers imply `add`, so `kibrary_automator.py C1525` works too.

For each part the tool:

1. **Downloads** the symbol, footprint and 3D model.
2. **Previews** them at the top of the screen — the schematic symbol with pin names/numbers on the left, the footprint pad layout on the right.
3. **Fills in the description** (from the LCSC/EasyEDA API — JLC2KiCadLib leaves it blank) and **the datasheet link** (resolved to a real PDF and validated), offering both as editable defaults.
4. Asks for a **reference designator** and whether to **create a new library or merge** into an existing one.
5. When you're done, **installs the libraries into KiCad** automatically.

Between parts it asks *"Add another component?"* so you can process a whole batch in one run. Single-digit menus and y/n prompts respond to a single keypress — no Enter needed.

---

## Commands

```
kibrary_automator.py [--library-root PATH] [command]

  add [PART ...]   download JLCPCB/LCSC parts and add them to a library (default)
  install          register the repository's libraries in KiCad
  config           show the stored configuration (--reset to change the path)
```

- `--library-root PATH` overrides the configured repository for a single run (not saved).
- Running with no command drops into an interactive menu.

### Companion scripts

```bash
python3 fill_datasheets.py [--dry-run]   # backfill missing datasheet links across all libraries
python3 uninstall.py [--yes]             # remove the venv, config, and this tool's KiCad table entries
```

`fill_datasheets.py` sweeps every library in the repository and resolves any symbol whose datasheet field isn't a real PDF (validated before writing). New downloads already get this automatically; the script fixes up older libraries.

`uninstall.py` removes the private virtualenv, the config directory, and the library entries this tool added to KiCad's `sym-lib-table` / `fp-lib-table` (other entries are preserved). **Your library repository is never touched.**

---

## What it produces

Each library is a self-contained folder:

```
YourLibrary_KSL/
├── YourLibrary_KSL.kicad_sym      # symbols (one file, multiple parts)
├── YourLibrary_KSL.pretty/        # footprints (.kicad_mod)
├── YourLibrary_KSL.3dshapes/      # 3D models (.step / .wrl)
└── metadata.json                  # KiCad Package Manager metadata
```

3D-model paths use the `${KSL_ROOT}` KiCad path variable so the library stays relocatable. Point `KSL_ROOT` at the folder holding your libraries in KiCad's *Preferences → Configure Paths*.

---

## Configuration

Settings live in a human-readable YAML file, created on first run:

| Platform | Config file |
|----------|-------------|
| **Linux** | `~/.config/kibrary-automator/config.yaml` |
| **macOS** | `~/Library/Application Support/kibrary-automator/config.yaml` |

```yaml
# kibrary-automator configuration
# Edit freely — one `key: value` per line.

# Path to your KiCad library repository
library_root: /home/you/kicad-shared-libs

# Suffix appended to new library names
lib_suffix: _KSL

# GitHub username used in package metadata
github_user: your-username

# KiCad path variable used for 3D-model paths in footprints
model_var: ${KSL_ROOT}
```

Every setting is written to the file with its default, so there is nothing to edit in the script. View it with `config`, change the library path with `config --reset`.

---

## KiCad integration

The tool auto-detects your KiCad settings directory and adds each library to both the symbol and footprint tables, backing them up first and skipping anything already registered.

| Installation | Path | Status |
|--------------|------|--------|
| **macOS** | `~/Library/Preferences/kicad/<ver>/` | ✅ |
| **Linux (regular)** | `~/.config/kicad/<ver>/` | ✅ |
| **Linux (Flatpak)** | `~/.var/app/org.kicad.KiCad/config/kicad/<ver>/` | ✅ |
| **Multiple versions** | auto-detected | ✅ pick one |
| **Windows** | `%APPDATA%\kicad\` | 🔄 planned |

Targets KiCad 9 library formats. Restart KiCad after an install to see new libraries.

---

## Safety & robustness

- **Backups** of the library tables before any edit; installs are idempotent.
- **Duplicate detection** — warns before adding a symbol name that already exists.
- **Interrupted-download cleanup** — leftover or partial files are detected on the next launch (and on Ctrl+C) and you're asked to add or remove them, so they can't silently break future runs.
- **Graceful exit** on Ctrl+C and closed input.

---

## Requirements

- **Python 3.8+** to launch. The private virtualenv is built with **Python 3.10+** (required by JLC2KiCadLib). If the interpreter you launch with is older, the tool finds a newer `python3.x` on your system and rebuilds the environment with it automatically.
- Installed on first launch, into the private venv: **[Rich](https://github.com/Textualize/rich)** (interface) and **[JLC2KiCadLib](https://github.com/TousstNicolas/JLC2KiCad_lib)** (part conversion).
- **KiCad** for the install step. Internet access for downloads and datasheet/description resolution.

---

## License

See [LICENSE.md](LICENSE.md).
