#!/usr/bin/env python3
"""kibrary-automator — turn JLCPCB part numbers into organized KiCad libraries.

Run it from anywhere: the location of your KiCad library repository is asked
once on first run and remembered in a human-readable YAML config file
(see `kibrary_automator.py config` for its location).

Subcommands:
  add [PART ...]   download JLCPCB parts and add them to a library (default)
  install          register the repository's libraries in KiCad
  package          zip the repository for a GitHub release
  config           show (or --reset) the stored configuration
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

APP_NAME      = "kibrary-automator"
LIB_SUFFIX    = "_KSL"          # suffix appended to new library names
GH_USER       = "jazari-akuna"  # GitHub username used in package metadata
MODEL_ENV_VAR = "${KSL_ROOT}"   # KiCad path variable for 3D-model roots


# ---------------------------------------------------------------------------
# Configuration file (flat key/value YAML, no external dependencies)
# ---------------------------------------------------------------------------

def config_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    base = os.environ.get("XDG_CONFIG_HOME", "") or str(Path.home() / ".config")
    return Path(base) / APP_NAME


def data_dir() -> Path:
    if sys.platform == "darwin":
        return config_dir()
    base = os.environ.get("XDG_DATA_HOME", "") or str(Path.home() / ".local/share")
    return Path(base) / APP_NAME


def config_file() -> Path:
    return config_dir() / "config.yaml"


def load_config() -> dict:
    """Read the config file. Only flat `key: value` pairs are supported."""
    cfg = {}
    path = config_file()
    if not path.is_file():
        return cfg
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition(":")
        if sep:
            cfg[key.strip()] = value.strip().strip("'\"")
    return cfg


def save_config(cfg: dict) -> None:
    path = config_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"# {APP_NAME} configuration",
        "# Edit freely — one `key: value` per line.",
        "",
    ]
    lines += [f"{key}: {value}" for key, value in sorted(cfg.items())]
    path.write_text("\n".join(lines) + "\n")
    print(f"→ Configuration saved to {path}")


def prompt_for_library_root() -> Path:
    print("\nWhere is your KiCad library repository?")
    print("(the folder that holds — or will hold — your *_KSL libraries)")
    while True:
        raw = input("Library path: ").strip()
        if not raw:
            print("→ Please enter a path.")
            continue
        root = Path(raw).expanduser().resolve()
        if root.is_dir():
            return root
        if root.exists():
            print(f"→ {root} exists but is not a directory.")
            continue
        ans = input(f"→ {root} does not exist. Create it? [y/N]: ").lower()
        if ans == "y":
            root.mkdir(parents=True)
            return root


def resolve_library_root(override: str | None) -> Path:
    """Return the library repository path, asking and saving it on first run."""
    if override:
        root = Path(override).expanduser().resolve()
        if not root.is_dir():
            sys.exit(f"Error: --library-root {root} is not a directory.")
        return root

    cfg = load_config()
    stored = cfg.get("library_root")
    if stored:
        root = Path(stored).expanduser()
        if root.is_dir():
            return root
        print(f"→ Configured library path no longer exists: {root}")

    root = prompt_for_library_root()
    cfg["library_root"] = str(root)
    save_config(cfg)
    return root


# ---------------------------------------------------------------------------
# JLC2KiCadLib management (installed into a private virtualenv)
# ---------------------------------------------------------------------------

def jlc_venv_dir() -> Path:
    return data_dir() / "jlc_venv"


def venv_binary(venv: Path, name: str) -> Path:
    return venv / ("Scripts" if os.name == "nt" else "bin") / name


def find_jlc2kicadlib(root: Path) -> Path | None:
    """Return a working JLC2KiCadLib executable, or None.

    Checks the app-owned venv first, then a legacy `.jlc_venv` created by
    older versions of this script inside the library repository.
    """
    candidates = [
        venv_binary(jlc_venv_dir(), "JLC2KiCadLib"),
        venv_binary(root / ".jlc_venv", "JLC2KiCadLib"),
    ]
    for exe in candidates:
        if not exe.is_file():
            continue
        try:
            result = subprocess.run([str(exe), "--version"],
                                    capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                return exe
        except (OSError, subprocess.TimeoutExpired):
            pass
    return None


def install_jlc2kicadlib() -> bool:
    """Create the private venv (if needed) and pip-install JLC2KiCadLib."""
    venv = jlc_venv_dir()
    python = venv_binary(venv, "python")

    print(f"\n→ Installing JLC2KiCadLib into {venv} ...")
    try:
        if not venv.is_dir():
            print("→ Creating virtual environment...")
            result = subprocess.run([sys.executable, "-m", "venv", str(venv)],
                                    capture_output=True, text=True)
            if result.returncode != 0:
                print("→ Error creating venv:")
                print(result.stderr)
                return False

        if not python.is_file():
            print(f"→ Error: python not found at {python}")
            print(f"→ The venv may be corrupted. Delete {venv} and try again.")
            return False

        print("→ Ensuring pip is available...")
        result = subprocess.run([str(python), "-m", "ensurepip", "--upgrade"],
                                capture_output=True, text=True)
        if result.returncode != 0:
            print("→ Warning: ensurepip failed, trying to continue anyway")
            print(result.stderr)

        print("→ Installing JLC2KiCadLib (this may take a minute)...")
        result = subprocess.run([str(python), "-m", "pip", "install", "JLC2KiCadLib"],
                                capture_output=True, text=True)
        if result.returncode != 0:
            print("→ Error installing JLC2KiCadLib:")
            print(result.stderr)
            return False

        print("→ JLC2KiCadLib installed successfully!")
        return True
    except Exception as e:
        print(f"→ Unexpected error during installation: {e}")
        if sys.platform.startswith("linux"):
            print("→ You may need the venv module first:")
            print("→   sudo apt install python3-venv python3-pip")
        else:
            print("→ Make sure your Python installation includes the venv module.")
        print("→ Then try running this script again.")
        return False


def ensure_jlc2kicadlib(root: Path) -> Path:
    """Return the JLC2KiCadLib executable, offering to install it if missing."""
    exe = find_jlc2kicadlib(root)
    if exe:
        print(f"→ JLC2KiCadLib found at: {exe}")
        return exe

    print("→ JLC2KiCadLib is required but not installed.")
    ans = input("→ Install JLC2KiCadLib now? [Y/n]: ").lower()
    if ans and ans != "y":
        sys.exit("Cannot proceed without JLC2KiCadLib. Exiting.")
    if not install_jlc2kicadlib():
        sys.exit(1)
    exe = find_jlc2kicadlib(root)
    if not exe:
        sys.exit("Installation verification failed. Please check the venv setup.")
    print(f"→ JLC2KiCadLib is now installed at: {exe}")
    return exe


# ---------------------------------------------------------------------------
# Part download and raw-asset organization
# ---------------------------------------------------------------------------

def download_parts(parts: list[str], jlc_exe: Path, root: Path,
                   retries: int = 3, delay: int = 2) -> tuple[list, list]:
    """Download each part into the library root, retrying per part.

    Returns (succeeded, failed) lists of part numbers.
    """
    succeeded, failed = [], []
    for part in parts:
        cmd = [str(jlc_exe), part,
               "-dir", ".", "-symbol_lib_dir", ".", "-footprint_lib", ".",
               "-model_dir", "."]
        ok = False
        for attempt in range(1, retries + 1):
            try:
                subprocess.check_call(cmd, cwd=root)
                ok = True
                break
            except subprocess.CalledProcessError:
                if attempt < retries:
                    print(f"→ {part}: attempt {attempt}/{retries} failed, "
                          f"retrying in {delay}s...")
                    time.sleep(delay)
                else:
                    print(f"→ {part}: all {retries} attempts failed "
                          "(JLC2KiCadLib API error)")
        (succeeded if ok else failed).append(part)
    return succeeded, failed


def wrap_assets(root: Path) -> None:
    """Move loose footprints and 3D models into .pretty / .3dshapes folders."""
    for entry in list(root.iterdir()):
        if not entry.is_file():
            continue
        if entry.suffix == ".kicad_mod":
            dest = root / f"{entry.stem}.pretty"
        elif entry.suffix.lower() in (".wrl", ".step", ".stp", ".3ds"):
            dest = root / f"{entry.stem}.3dshapes"
        else:
            continue
        dest.mkdir(exist_ok=True)
        shutil.move(str(entry), dest / entry.name)


def find_local_component(root: Path) -> dict | None:
    """Detect exactly one freshly downloaded component in the library root."""
    syms  = [p for p in root.iterdir() if p.suffix == ".kicad_sym" and p.is_file()]
    prets = [p for p in root.iterdir() if p.suffix == ".pretty" and p.is_dir()]
    if len(syms) != 1 or len(prets) != 1:
        return None
    comp = {"sym": syms[0], "pretty": prets[0]}
    models = [p for p in root.iterdir() if p.suffix == ".3dshapes" and p.is_dir()]
    if models:
        comp["models"] = models[0]
    return comp


def cleanup_downloads(comp: dict) -> None:
    print("Cleaning up…")
    if comp["sym"].is_file():
        comp["sym"].unlink()
    if comp["pretty"].is_dir():
        shutil.rmtree(comp["pretty"])
    models = comp.get("models")
    if models and models.is_dir():
        shutil.rmtree(models)


# ---------------------------------------------------------------------------
# Symbol-file editing
# ---------------------------------------------------------------------------

def edit_symbol_description(sym_file: Path) -> None:
    lines = sym_file.read_text().splitlines()

    curr = next(
        (m.group(1)
         for ln in lines
         if (m := re.match(r'\s*\(property\s+"Description"\s+"([^"]*)"', ln))),
        ""
    )
    ans = input(f"Component description [{curr}]: ").strip() or curr

    # If a Description property exists, replace it in place.
    if any('(property "Description"' in ln for ln in lines):
        out = []
        for ln in lines:
            if '(property "Description"' in ln:
                ln = re.sub(r'\(property\s+"Description"\s+"[^"]*"',
                            f'(property "Description" "{ans}"', ln)
            out.append(ln)
        sym_file.write_text("\n".join(out) + "\n")
        print(f"→ Description set to: {ans}")
        return

    # Otherwise insert one at the end of the first (symbol …) block.
    start = next((i for i, ln in enumerate(lines)
                  if ln.lstrip().startswith("(symbol ")), None)
    if start is None:
        sys.exit("Cannot find a symbol block to insert Description into.")

    depth = lines[start].count("(") - lines[start].count(")")
    end = None
    for j in range(start + 1, len(lines)):
        depth += lines[j].count("(") - lines[j].count(")")
        if depth == 0:
            end = j
            break
    if end is None:
        sys.exit("Malformed symbol: unbalanced parentheses.")

    # Match the indentation of the existing properties.
    prop_indent = next(
        (m.group(1) for ln in lines[start + 1:end]
         if (m := re.match(r'^(\s*)\(property\s+"', ln))),
        "")
    if not prop_indent:
        prop_indent = re.match(r'^(\s*)', lines[start]).group(1) + "  "

    i1 = prop_indent + "  "
    i2 = prop_indent + "    "
    block = [
        f'{prop_indent}(property "Description" "{ans}"',
        f'{i1}(at 0 0 0)',
        f'{i1}(effects',
        f'{i2}(font (size 1.27 1.27))',
        f'{i2}(hide yes)',
        f'{i1})',
        f'{prop_indent})',
    ]
    out = lines[:end] + block + lines[end:]
    sym_file.write_text("\n".join(out) + "\n")
    print(f"→ Description set to: {ans}")


def set_default_designator(sym_file: Path) -> None:
    lines = sym_file.read_text().splitlines()
    cur = next(
        (m.group(1)
         for ln in lines
         if (m := re.match(r'\s*\(property\s+"Reference"\s+"([^"]+)"', ln))),
        ""
    )
    ans = input(f"Default reference [{cur}]: ").strip().upper()
    new = ans or cur
    if new and not new.endswith("?"):
        new += "?"
    out = []
    for ln in lines:
        if '(property "Reference"' in ln:
            ln = re.sub(r'\(property\s+"Reference"\s+"[^"]+"',
                        f'(property "Reference" "{new}"', ln)
        out.append(ln)
    sym_file.write_text("\n".join(out) + "\n")
    print(f"→ Reference set to: {new}")


def update_symbol_paths(sym_file: Path, lib_name: str, model_dir: Path | None) -> None:
    """Point the symbol's footprint/model references at the final library.

    Only footprint/model lines are touched, so free-text properties such as
    a description of ".1uF" are left alone.
    """
    out = []
    for ln in sym_file.read_text().splitlines(keepends=True):
        stripped = ln.lstrip()
        if stripped.startswith('(property "Footprint"'):
            ln = ln.replace('".:', f'"{lib_name}:').replace('".', f'"{lib_name}:')
        if model_dir and f"{model_dir.name}/" not in ln \
                and (stripped.startswith("(model")
                     or stripped.startswith('(property "Footprint"')):
            ln = ln.replace("3dshapes/", f"{model_dir.name}/")
        out.append(ln)
    sym_file.write_text("".join(out))


def update_footprint_3d_paths(fp_dir: Path, model_dir: Path | None) -> None:
    """Rewrite footprint 3D-model paths to use the MODEL_ENV_VAR root."""
    if not model_dir or not fp_dir.is_dir():
        return
    lib_folder = model_dir.parent.name
    base3d     = model_dir.name
    for fp in fp_dir.iterdir():
        if fp.suffix != ".kicad_mod":
            continue
        out = []
        for ln in fp.read_text().splitlines(keepends=True):
            if ln.lstrip().startswith("(model ") and MODEL_ENV_VAR not in ln:
                m = re.match(r'(\s*)\(model\s+"?([^"\s)]+)', ln)
                if m:
                    indent, old_path = m.groups()
                    model_name = old_path.replace("\\", "/").rstrip("/").rpartition("/")[2]
                    ln = (f"{indent}(model {MODEL_ENV_VAR}/{lib_folder}/"
                          f"{base3d}/{model_name}\n")
            out.append(ln)
        fp.write_text("".join(out))


# ---------------------------------------------------------------------------
# Library management
# ---------------------------------------------------------------------------

def list_libraries(root: Path) -> list[str]:
    """Names of library folders in the repo (containing <name>.kicad_sym)."""
    return sorted(
        d.name for d in root.iterdir()
        if d.is_dir() and (d / f"{d.name}.kicad_sym").is_file()
    )


def check_duplicate(root: Path, comp: dict) -> None:
    lines = comp["sym"].read_text().splitlines()
    name = next((re.match(r'\(symbol\s+"([^"]+)"', ln.lstrip()).group(1)
                 for ln in lines if ln.lstrip().startswith("(symbol ")), None)
    if not name:
        return
    for lib in list_libraries(root):
        lib_sym = root / lib / f"{lib}.kicad_sym"
        if f'(symbol "{name}"' in lib_sym.read_text():
            ans = input(f"Component {name} exists in '{lib}'. "
                        "Add anyway? [y/N]: ").lower()
            if ans != "y":
                print("→ Aborting.")
                cleanup_downloads(comp)
                sys.exit(0)
            return


def choose_library(root: Path) -> str | None:
    """Pick an existing library to merge into, or None to create a new one."""
    libs = list_libraries(root)
    choices = ["Create new library"] + libs
    print("\nAdd to an existing library or create a new one:")
    for i, name in enumerate(choices, 1):
        print(f" {i} - {name}")
    sel = input("Select [1]: ").strip()
    if not sel or not sel.isdigit():
        return None
    idx = int(sel)
    if idx < 1 or idx > len(choices):
        print("Invalid choice → defaulting to create new")
        return None
    if idx == 1:
        return None
    return libs[idx - 2]


def merge_into(root: Path, lib: str, comp: dict) -> None:
    print(f"Merging '{comp['sym'].name}' into '{lib}'")
    lib_dir = root / lib
    lib_sym = lib_dir / f"{lib}.kicad_sym"
    lines = lib_sym.read_text().splitlines()
    if lines[-1].strip() != ")":
        sys.exit(f"Bad format in {lib_sym}")
    header = lines[:-1]
    new = comp["sym"].read_text().splitlines()
    start = next(i for i, ln in enumerate(new)
                 if ln.lstrip().startswith("(symbol "))
    inner = new[start:-1]
    merged = header + [""] + ["  " + ln for ln in inner] + [")"]
    lib_sym.write_text("\n".join(merged) + "\n")

    dst_fp = lib_dir / f"{lib}.pretty"
    for fp in comp["pretty"].iterdir():
        if fp.suffix == ".kicad_mod":
            shutil.copy(fp, dst_fp)

    dst_3d = None
    if comp.get("models"):
        dst_3d = lib_dir / f"{lib}.3dshapes"
        dst_3d.mkdir(exist_ok=True)
        for model in comp["models"].iterdir():
            shutil.copy(model, dst_3d)

    update_symbol_paths(lib_sym, lib, dst_3d)
    update_footprint_3d_paths(dst_fp, dst_3d)
    print("→ Merge done.")


def create_library(root: Path, comp: dict) -> None:
    default = comp["sym"].stem + LIB_SUFFIX
    name = input(f"Library name [{default}]: ").strip() or default
    if not name.endswith(LIB_SUFFIX):
        name += LIB_SUFFIX

    lib_dir = root / name
    lib_dir.mkdir(exist_ok=True)
    dst_sym = lib_dir / f"{name}.kicad_sym"
    dst_fp  = lib_dir / f"{name}.pretty"
    shutil.move(str(comp["sym"]), dst_sym)
    shutil.move(str(comp["pretty"]), dst_fp)

    dst_models = None
    if comp.get("models"):
        dst_models = lib_dir / f"{name}.3dshapes"
        shutil.move(str(comp["models"]), dst_models)

    update_symbol_paths(dst_sym, name, dst_models)
    update_footprint_3d_paths(dst_fp, dst_models)

    lib_desc = input(f"Library description [{name}]: ").strip() or name
    meta = {
        "$schema": "https://go.kicad.org/pcm/schemas/v1",
        "name": name, "description": lib_desc,
        "identifier": f"com.github.{GH_USER}.kicad-shared-libs.{name}",
        "type": "library", "license": "CC-BY-SA-4.0",
        "author": {"name": "Unknown"}, "maintainer": {"name": GH_USER},
        "content": {
            "symbols": [f"{name}.kicad_sym"],
            "footprints": [f"{name}.pretty"],
            "3dmodels": [f"{name}.3dshapes"] if dst_models else [],
        },
        "versions": [{"version": "1.0.0", "status": "stable",
                      "kicad_version": "9.0"}],
    }
    (lib_dir / "metadata.json").write_text(json.dumps(meta, indent=2))

    repo_json = root / "repository.json"
    if repo_json.is_file():
        repo = json.loads(repo_json.read_text())
    else:
        print("repository.json not found → creating new one")
        repo = {"packages": []}
    repo.setdefault("packages", []).append({"path": f"{name}/metadata.json"})
    repo_json.write_text(json.dumps(repo, indent=2))
    print(f"→ Created library '{name}'.")


# ---------------------------------------------------------------------------
# KiCad integration
# ---------------------------------------------------------------------------

def kicad_config_bases() -> list[tuple[str, Path]]:
    """Candidate KiCad settings directories per platform/packaging."""
    if sys.platform == "darwin":
        return [("macOS", Path.home() / "Library/Preferences/kicad")]
    return [
        ("Flatpak", Path.home() / ".var/app/org.kicad.KiCad/config/kicad"),
        ("Regular", Path.home() / ".config/kicad"),
    ]


def detect_kicad_installations() -> list[dict]:
    """Find KiCad settings folders that contain both library tables."""
    found = []
    for kind, base in kicad_config_bases():
        if not base.is_dir():
            continue
        versions = sorted((d for d in base.iterdir() if d.is_dir()),
                          key=lambda d: d.name, reverse=True)
        for version_dir in versions:
            sym_table = version_dir / "sym-lib-table"
            fp_table  = version_dir / "fp-lib-table"
            if sym_table.is_file() and fp_table.is_file():
                found.append({
                    "type": kind,
                    "version": version_dir.name,
                    "config_dir": version_dir,
                    "sym_table": sym_table,
                    "fp_table": fp_table,
                })
    return found


def backup_library_table(table_path: Path) -> None:
    backup = table_path.with_name(table_path.name + ".backup")
    if not backup.exists():
        shutil.copy2(table_path, backup)
        print(f"→ Backup created: {backup}")


def add_library_to_table(table_path: Path, lib_name: str, lib_uri: Path,
                         lib_desc: str = "") -> bool:
    """Append a library entry to a sym-lib-table or fp-lib-table."""
    backup_library_table(table_path)

    lines = table_path.read_text().splitlines(keepends=True)
    if any(f'(name "{lib_name}")' in ln for ln in lines):
        print(f"→ Library '{lib_name}' already exists in {table_path.name}")
        return False

    if not lines or lines[-1].strip() != ")":
        print(f"→ Error: Malformed {table_path.name} file")
        return False

    entry = (f'  (lib (name "{lib_name}")(type "KiCad")(uri "{lib_uri}")'
             f'(options "")(descr "{lib_desc}"))\n')
    lines.insert(-1, entry)
    table_path.write_text("".join(lines))
    print(f"→ Added '{lib_name}' to {table_path.name}")
    return True


def choose_kicad_installation(configs: list[dict]) -> dict | None:
    print("\nDetected KiCad installations:")
    for i, cfg in enumerate(configs, 1):
        print(f" {i} - {cfg['type']} KiCad {cfg['version']} ({cfg['config_dir']})")

    if len(configs) == 1:
        cfg = configs[0]
        ans = input(f"Install libraries to {cfg['type']} KiCad "
                    f"{cfg['version']}? [Y/n]: ").lower()
        if ans and ans != "y":
            print("→ Installation cancelled.")
            return None
        return cfg

    sel = input("Select installation [1]: ").strip()
    if not sel:
        return configs[0]
    if not sel.isdigit() or not 1 <= int(sel) <= len(configs):
        print("→ Invalid choice")
        return None
    return configs[int(sel) - 1]


def install_libraries_to_kicad(root: Path) -> None:
    """Register every library in the repo with the chosen KiCad install."""
    configs = detect_kicad_installations()
    if not configs:
        print("→ No KiCad installation detected.")
        return

    selected = choose_kicad_installation(configs)
    if not selected:
        return
    print(f"→ Installing to {selected['type']} KiCad {selected['version']}")

    libs = list_libraries(root)
    if not libs:
        print(f"→ No libraries found in {root}")
        return
    print(f"→ Found {len(libs)} libraries: {', '.join(libs)}")

    installed = 0
    for lib in libs:
        lib_dir = root / lib
        sym_uri = lib_dir / f"{lib}.kicad_sym"
        if add_library_to_table(selected["sym_table"], lib, sym_uri,
                                f"Local library: {lib}"):
            installed += 1
        fp_dir = lib_dir / f"{lib}.pretty"
        if fp_dir.is_dir():
            add_library_to_table(selected["fp_table"], lib, fp_dir,
                                 f"Local footprint library: {lib}")

    print(f"→ Installation complete! Added {installed} libraries to KiCad.")
    print("→ Restart KiCad to see the new libraries.")


# ---------------------------------------------------------------------------
# Packaging
# ---------------------------------------------------------------------------

def package_repo(root: Path) -> None:
    out = root / (root.name + ".zip")
    print(f"Zipping repo → {out.name}")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for dirpath, _, filenames in os.walk(root):
            if ".git" in dirpath:
                continue
            for fn in filenames:
                if fn.endswith((".pyc", "~")) or fn == out.name:
                    continue
                p = Path(dirpath) / fn
                zf.write(p, p.relative_to(root))
    print("→ Done.")


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def process_component(root: Path, comp: dict) -> None:
    """Interactive pipeline: describe, designate, then file into a library."""
    edit_symbol_description(comp["sym"])
    set_default_designator(comp["sym"])
    check_duplicate(root, comp)
    lib = choose_library(root)
    if lib:
        merge_into(root, lib, comp)
    else:
        create_library(root, comp)
    cleanup_downloads(comp)

    print("\nAdditional actions:")
    if input("Install libraries to KiCad? [y/N]: ").lower() == "y":
        install_libraries_to_kicad(root)
    if input("Create GitHub-release zip now? [y/N]: ").lower() == "y":
        package_repo(root)


def cmd_add(root: Path, parts: list[str]) -> None:
    # Leftovers from a previous (aborted) run are handled first.
    comp = find_local_component(root)
    if comp:
        print(f"→ Found existing component in {root}, processing it first.")
        process_component(root, comp)
        if not parts:
            return

    jlc_exe = ensure_jlc2kicadlib(root)
    if not parts:
        parts = input("Enter JLCPCB part#s: ").split()
    if not parts:
        sys.exit("No parts specified.")

    succeeded, failed = download_parts(parts, jlc_exe, root)
    if failed:
        print(f"→ Failed to download: {', '.join(failed)}")
    if not succeeded:
        sys.exit("Error: all parts failed to download.")
    if failed:
        print(f"→ Continuing with successfully downloaded parts: "
              f"{', '.join(succeeded)}")

    wrap_assets(root)
    comp = find_local_component(root)
    if not comp:
        sys.exit("Error: no component.")
    process_component(root, comp)


def cmd_interactive(root: Path) -> None:
    comp = find_local_component(root)
    if comp:
        process_component(root, comp)
        return
    print("\nNo local components found. Choose an option:")
    print(" 1 - Download JLCPCB parts and create library")
    print(" 2 - Install existing libraries to KiCad")
    choice = input("Select [1]: ").strip()
    if choice in ("", "1"):
        cmd_add(root, [])
    elif choice == "2":
        install_libraries_to_kicad(root)
    else:
        sys.exit("Invalid choice.")


def cmd_config(reset: bool) -> None:
    path = config_file()
    if reset:
        cfg = load_config()
        cfg["library_root"] = str(prompt_for_library_root())
        save_config(cfg)
        return
    if not path.is_file():
        print(f"No configuration yet (will be created at {path} on first run).")
        return
    print(f"Configuration file: {path}\n")
    print(path.read_text(), end="")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=Path(sys.argv[0]).name,
        description="Turn JLCPCB part numbers into organized KiCad libraries.")
    parser.add_argument("--library-root", metavar="PATH",
                        help="use this library repository instead of the "
                             "configured one (not saved)")
    sub = parser.add_subparsers(dest="command")

    p_add = sub.add_parser("add", help="download JLCPCB parts and add them "
                                       "to a library (default)")
    p_add.add_argument("parts", nargs="*", metavar="PART",
                       help="JLCPCB part numbers (asked interactively if omitted)")

    sub.add_parser("install", help="register the repository's libraries in KiCad")
    sub.add_parser("package", help="zip the repository for a GitHub release")

    p_cfg = sub.add_parser("config", help="show the stored configuration")
    p_cfg.add_argument("--reset", action="store_true",
                       help="ask for the library location again")
    return parser


def main() -> None:
    # Convenience: `kibrary_automator.py C1525 C2040` implies `add`.
    argv = sys.argv[1:]
    commands = {"add", "install", "package", "config"}
    if argv and not argv[0].startswith("-") and argv[0] not in commands:
        argv = ["add"] + argv

    args = build_parser().parse_args(argv)

    if args.command == "config":
        cmd_config(args.reset)
        return

    root = resolve_library_root(args.library_root)
    print(f"→ Library repository: {root}")

    if args.command == "add":
        cmd_add(root, args.parts)
    elif args.command == "install":
        install_libraries_to_kicad(root)
    elif args.command == "package":
        package_repo(root)
    else:
        cmd_interactive(root)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n→ Interrupted.")
        sys.exit(130)
