#!/usr/bin/env python3
"""kibrary-automator — turn JLCPCB part numbers into organized KiCad libraries.

Run it from anywhere: the location of your KiCad library repository is asked
once on first run and remembered in a human-readable YAML config file
(see `kibrary_automator.py config` for its location).

On first launch the script sets up everything it needs by itself: a private
virtualenv containing Rich (for the interface) and JLC2KiCadLib (for the
downloads), then re-executes inside it. No manual installation required.

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
PYTHON_DEPS   = ("rich", "JLC2KiCadLib")


# ---------------------------------------------------------------------------
# Well-known paths
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


def venv_dir() -> Path:
    return data_dir() / "venv"


def venv_binary(name: str) -> Path:
    if os.name == "nt":
        return venv_dir() / "Scripts" / f"{name}.exe"
    return venv_dir() / "bin" / name


# ---------------------------------------------------------------------------
# First-launch bootstrap: create the private venv, install every dependency
# (Rich + JLC2KiCadLib), then re-execute this script inside it.
# ---------------------------------------------------------------------------

def _run_or_die(cmd: list[str], what: str) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"→ Error while {what}:")
        print(result.stderr)
        if sys.platform.startswith("linux"):
            print("→ On Debian/Ubuntu you may need:")
            print("→   sudo apt install python3-venv python3-pip")
        sys.exit(1)


def _install_environment(stamp: Path, want: str) -> None:
    venv = venv_dir()
    python = venv_binary("python")
    print(f"First launch: setting up the {APP_NAME} environment.")

    if not python.is_file():
        print(f"→ Creating virtual environment at {venv} ...")
        venv.parent.mkdir(parents=True, exist_ok=True)
        _run_or_die([sys.executable, "-m", "venv", str(venv)],
                    "creating the virtual environment")

    print("→ Ensuring pip is available...")
    subprocess.run([str(python), "-m", "ensurepip", "--upgrade"],
                   capture_output=True, text=True)

    print(f"→ Installing {', '.join(PYTHON_DEPS)} (one-time, may take a minute)...")
    _run_or_die([str(python), "-m", "pip", "install", "--quiet", *PYTHON_DEPS],
                "installing dependencies")

    if not venv_binary("JLC2KiCadLib").is_file():
        sys.exit("→ JLC2KiCadLib executable missing after install — "
                 f"delete {venv} and try again.")
    stamp.write_text(want)
    print("→ Environment ready!\n")


def _bootstrap() -> None:
    """Make sure we are running inside the app venv with all dependencies."""
    if sys.version_info < (3, 8):
        sys.exit(f"{APP_NAME} needs Python 3.8 or newer.")
    if os.environ.get("KIBRARY_BOOTSTRAPPED") == "1":
        return

    stamp = venv_dir() / ".deps"
    want = ",".join(PYTHON_DEPS)
    python = venv_binary("python")
    if not (python.is_file() and stamp.is_file()
            and stamp.read_text().strip() == want):
        _install_environment(stamp, want)

    env = dict(os.environ, KIBRARY_BOOTSTRAPPED="1")
    sys.stdout.flush()
    sys.stderr.flush()
    argv = [str(python), str(Path(__file__).resolve()), *sys.argv[1:]]
    if os.name == "nt":
        # os.exec* on Windows spawns rather than replaces and mishandles
        # quoting — run the venv python as a child process instead.
        sys.exit(subprocess.run(argv, env=env).returncode)
    os.execve(str(python), argv, env)


if __name__ == "__main__":
    _bootstrap()

try:
    from rich.columns import Columns          # noqa: E402
    from rich.console import Console          # noqa: E402
    from rich.markup import escape            # noqa: E402
    from rich.panel import Panel              # noqa: E402
    from rich.prompt import Confirm, Prompt   # noqa: E402
    from rich.text import Text                # noqa: E402
except ModuleNotFoundError:
    if os.environ.get("KIBRARY_BOOTSTRAPPED") == "1":
        sys.exit(f"The {APP_NAME} environment is broken — "
                 f"delete {venv_dir()} and relaunch to reinstall.")
    raise

console = Console(highlight=False)


def say(msg: str) -> None:
    console.print(f"[bold cyan]→[/] {msg}")


def warn(msg: str) -> None:
    console.print(f"[bold yellow]![/] {msg}")


# ---------------------------------------------------------------------------
# Configuration file (flat key/value YAML, no extra dependencies)
# ---------------------------------------------------------------------------

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
    say(f"Configuration saved to {escape(str(path))}")


def prompt_for_library_root() -> Path:
    console.print()
    say("Where is your KiCad library repository?")
    console.print("  [dim](the folder that holds — or will hold — "
                  f"your *{LIB_SUFFIX} libraries)[/]")
    while True:
        raw = Prompt.ask("Library path").strip()
        if not raw:
            warn("Please enter a path.")
            continue
        root = Path(raw).expanduser().resolve()
        if root.is_dir():
            return root
        if root.exists():
            warn(f"{escape(str(root))} exists but is not a directory.")
            continue
        if Confirm.ask(f"{escape(str(root))} does not exist. Create it?",
                       default=False):
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
        warn(f"Configured library path no longer exists: {escape(str(root))}")

    root = prompt_for_library_root()
    cfg["library_root"] = str(root)
    save_config(cfg)
    return root


# ---------------------------------------------------------------------------
# S-expression parsing (KiCad symbol and footprint files)
# ---------------------------------------------------------------------------

_TOKEN_RE = re.compile(r'"(?:[^"\\]|\\.)*"|[()]|[^\s()"]+')


def parse_sexp(text: str):
    """Parse a KiCad s-expression file into nested lists of strings."""
    tokens = _TOKEN_RE.findall(text)
    pos = 0

    def parse():
        nonlocal pos
        tok = tokens[pos]
        pos += 1
        if tok == "(":
            node = []
            while pos < len(tokens) and tokens[pos] != ")":
                node.append(parse())
            pos += 1  # consume ")"
            return node
        if tok == ")":
            raise ValueError("unbalanced parenthesis")
        if tok.startswith('"'):
            return tok[1:-1].replace('\\"', '"')
        return tok

    return parse()


def sexp_first(node: list, tag: str) -> list | None:
    return next((c for c in node
                 if isinstance(c, list) and c and c[0] == tag), None)


def sexp_find_all(node: list, tag: str) -> list[list]:
    found = []
    for c in node:
        if isinstance(c, list):
            if c and c[0] == tag:
                found.append(c)
            found.extend(sexp_find_all(c, tag))
    return found


# ---------------------------------------------------------------------------
# Component preview (schematic symbol + footprint, rendered as text)
# ---------------------------------------------------------------------------

def extract_pins(symbol_node: list) -> list[dict]:
    pins, seen = [], set()
    for p in sexp_find_all(symbol_node, "pin"):
        at = sexp_first(p, "at")
        if not at or len(at) < 3:
            continue
        name_node = sexp_first(p, "name")
        num_node  = sexp_first(p, "number")
        number = num_node[1] if num_node and len(num_node) > 1 else "?"
        if number in seen:  # alternate units share pin numbers
            continue
        seen.add(number)
        name = name_node[1] if name_node and len(name_node) > 1 else ""
        pins.append({
            "name": "" if name == "~" else name,
            "number": number,
            "x": float(at[1]),
            "y": float(at[2]),
            "angle": (round(float(at[3])) % 360) if len(at) > 3 else 0,
        })
    return pins


def render_symbol(sym_file: Path) -> str:
    """Draw the schematic symbol as a pin-labelled text box."""
    try:
        return _render_symbol(sym_file)
    except Exception:
        return "(symbol preview unavailable)"


def _render_symbol(sym_file: Path) -> str:
    tree = parse_sexp(sym_file.read_text())
    sym = sexp_first(tree, "symbol")
    if not sym or len(sym) < 2:
        return "(no symbol found)"
    name = sym[1]
    pins = extract_pins(sym)
    if not pins:
        return f"{name}\n(no pins)"

    # KiCad pin angle = direction the pin points, toward the body:
    # 0 → body to the right (pin on the left side), 180 → right side,
    # 90 → bottom, 270 → top.
    left   = sorted((p for p in pins if p["angle"] == 0),   key=lambda p: -p["y"])
    right  = sorted((p for p in pins if p["angle"] == 180), key=lambda p: -p["y"])
    bottom = sorted((p for p in pins if p["angle"] == 90),  key=lambda p: p["x"])
    top    = sorted((p for p in pins if p["angle"] == 270), key=lambda p: p["x"])

    rows = max(len(left), len(right), 1)
    lw = max((len(p["name"]) for p in left), default=0)
    rw = max((len(p["name"]) for p in right), default=0)
    body_w = max(len(name) + 4, 12)
    lpw = 4 + 1 + lw + 1               # "{num:>4} {name:>{lw}} "
    mid = (rows - 1) // 2

    lines = [" " * lpw + "┌" + "─" * body_w + "┐"]
    for i in range(rows):
        lp = left[i] if i < len(left) else None
        rp = right[i] if i < len(right) else None
        ls = (f'{lp["number"]:>4} {lp["name"]:>{lw}} ' if lp else " " * lpw)
        interior = name.center(body_w) if i == mid else " " * body_w
        rs = (f' {rp["name"]:<{rw}} {rp["number"]}' if rp else "")
        lines.append(ls + ("┤" if lp else "│") + interior
                     + ("├" if rp else "│") + rs)
    lines.append(" " * lpw + "└" + "─" * body_w + "┘")

    if top:
        lines.insert(0, "  ▲ top: "
                     + "  ".join(f'{p["number"]}:{p["name"] or "~"}' for p in top))
    if bottom:
        lines.append("  ▼ bottom: "
                     + "  ".join(f'{p["number"]}:{p["name"] or "~"}' for p in bottom))
    return "\n".join(lines)


def render_footprint(fp_file: Path, width: int = 34, height: int = 13) -> str:
    """Draw the footprint's pads on a scaled text canvas."""
    try:
        return _render_footprint(fp_file, width, height)
    except Exception:
        return "(footprint preview unavailable)"


def _render_footprint(fp_file: Path, width: int, height: int) -> str:
    tree = parse_sexp(fp_file.read_text())
    pads = []
    for p in sexp_find_all(tree, "pad"):
        at, size = sexp_first(p, "at"), sexp_first(p, "size")
        if not at or not size or len(at) < 3 or len(size) < 3:
            continue
        w, h = float(size[1]), float(size[2])
        rot = round(float(at[3])) if len(at) > 3 else 0
        if rot % 180 == 90:
            w, h = h, w
        pads.append({"num": str(p[1]) if len(p) > 1 else "",
                     "x": float(at[1]), "y": float(at[2]), "w": w, "h": h})
    if not pads:
        return "(no pads found)"

    min_x = min(p["x"] - p["w"] / 2 for p in pads)
    max_x = max(p["x"] + p["w"] / 2 for p in pads)
    min_y = min(p["y"] - p["h"] / 2 for p in pads)
    max_y = max(p["y"] + p["h"] / 2 for p in pads)
    span_x = max(max_x - min_x, 0.01)
    span_y = max(max_y - min_y, 0.01)

    # columns per mm; character cells are ~twice as tall as wide
    s = min((width - 1) / span_x, (height - 1) * 2 / span_y)
    cols = max(int(span_x * s) + 1, 1)
    rows_n = max(int(span_y * s / 2) + 1, 1)
    grid = [[" "] * cols for _ in range(rows_n)]

    def col(x: float) -> int:
        return min(max(int((x - min_x) * s), 0), cols - 1)

    def row(y: float) -> int:
        return min(max(int((y - min_y) * s / 2), 0), rows_n - 1)

    for p in pads:
        c0, c1 = col(p["x"] - p["w"] / 2), col(p["x"] + p["w"] / 2)
        r0, r1 = row(p["y"] - p["h"] / 2), row(p["y"] + p["h"] / 2)
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                grid[r][c] = "▒"
        label = p["num"]
        if label and (c1 - c0 + 1) >= len(label):
            rr = (r0 + r1) // 2
            cc = (c0 + c1 + 1 - len(label)) // 2
            for k, ch in enumerate(label):
                grid[rr][cc + k] = ch

    canvas = "\n".join("".join(r).rstrip() for r in grid)
    return f"{canvas}\n\n{span_x:.1f} × {span_y:.1f} mm"


def show_component_preview(comp: dict) -> None:
    """Clear the screen and show symbol + footprint at the top."""
    sym_view = Text(render_symbol(comp["sym"]))
    fp_file = next((f for f in sorted(comp["pretty"].iterdir())
                    if f.suffix == ".kicad_mod"), None)
    fp_view = Text(render_footprint(fp_file) if fp_file else "(no footprint)")

    console.clear()
    console.print(Columns([
        Panel(sym_view, title="Schematic symbol", border_style="cyan",
              padding=(1, 2)),
        Panel(fp_view, title=f"Footprint — {fp_file.stem}" if fp_file
              else "Footprint", border_style="magenta", padding=(1, 2)),
    ]))
    console.print()


# ---------------------------------------------------------------------------
# Part download and raw-asset organization
# ---------------------------------------------------------------------------

def jlc_executable() -> Path:
    exe = venv_binary("JLC2KiCadLib")
    if not exe.is_file():
        sys.exit(f"JLC2KiCadLib missing from the app environment — "
                 f"delete {venv_dir()} and relaunch to reinstall.")
    return exe


def download_part(part: str, jlc_exe: Path, root: Path,
                  retries: int = 3, delay: int = 2) -> bool:
    """Download one part into the library root, with retries."""
    cmd = [str(jlc_exe), part,
           "-dir", ".", "-symbol_lib_dir", ".", "-footprint_lib", ".",
           "-model_dir", "."]
    last = None
    ok = False
    with console.status(f"Downloading {part}..."):
        for attempt in range(1, retries + 1):
            result = subprocess.run(cmd, cwd=root, capture_output=True, text=True)
            if result.returncode == 0:
                ok = True
                break
            last = result
            if attempt < retries:
                time.sleep(delay)
    if ok:
        console.print(f"[green]✓[/] {part} downloaded")
        return True
    console.print(f"[red]✗[/] {part}: all {retries} attempts failed "
                  "(JLC2KiCadLib error)")
    if last and last.stderr:
        tail = last.stderr.strip().splitlines()[-3:]
        for ln in tail:
            console.print(f"  [dim]{escape(ln)}[/]")
    return False


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


def remove_new_entries(root: Path, before: set) -> None:
    """Delete entries created in the library root since the snapshot."""
    for entry in set(root.iterdir()) - before:
        if entry.is_dir():
            shutil.rmtree(entry)
        elif entry.is_file():
            entry.unlink()


def cleanup_downloads(comp: dict) -> None:
    say("Cleaning up…")
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
    ans = Prompt.ask("Component description", default=curr).strip() or curr

    # If a Description property exists, replace it in place.
    if any('(property "Description"' in ln for ln in lines):
        out = []
        for ln in lines:
            if '(property "Description"' in ln:
                ln = re.sub(r'\(property\s+"Description"\s+"[^"]*"',
                            f'(property "Description" "{ans}"', ln)
            out.append(ln)
        sym_file.write_text("\n".join(out) + "\n")
        say(f"Description set to: {escape(ans)}")
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
    say(f"Description set to: {escape(ans)}")


def set_default_designator(sym_file: Path) -> None:
    lines = sym_file.read_text().splitlines()
    cur = next(
        (m.group(1)
         for ln in lines
         if (m := re.match(r'\s*\(property\s+"Reference"\s+"([^"]+)"', ln))),
        ""
    )
    raw = Prompt.ask("Default reference", default=cur)
    new = cur if raw == cur else raw.strip().upper()
    if new and not new.endswith("?"):
        new += "?"
    out = []
    for ln in lines:
        if '(property "Reference"' in ln:
            ln = re.sub(r'\(property\s+"Reference"\s+"[^"]+"',
                        f'(property "Reference" "{new}"', ln)
        out.append(ln)
    sym_file.write_text("\n".join(out) + "\n")
    say(f"Reference set to: {escape(new)}")


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


def check_duplicate(root: Path, comp: dict) -> bool:
    """Return False (after cleaning up) if the user declines a duplicate."""
    lines = comp["sym"].read_text().splitlines()
    name = next((re.match(r'\(symbol\s+"([^"]+)"', ln.lstrip()).group(1)
                 for ln in lines if ln.lstrip().startswith("(symbol ")), None)
    if not name:
        return True
    for lib in list_libraries(root):
        lib_sym = root / lib / f"{lib}.kicad_sym"
        if f'(symbol "{name}"' in lib_sym.read_text():
            if Confirm.ask(f"Component {escape(name)} exists in "
                           f"'{escape(lib)}'. Add anyway?", default=False):
                return True
            say("Skipping this component.")
            cleanup_downloads(comp)
            return False
    return True


def choose_library(root: Path) -> str | None:
    """Pick an existing library to merge into, or None to create a new one."""
    libs = list_libraries(root)
    console.print()
    say("Add to an existing library or create a new one:")
    console.print("  [bold]1[/] - Create new library")
    for i, name in enumerate(libs, 2):
        console.print(f"  [bold]{i}[/] - {escape(name)}")
    sel = Prompt.ask("Select", choices=[str(i) for i in range(1, len(libs) + 2)],
                     default="1", show_choices=False)
    idx = int(sel)
    return None if idx == 1 else libs[idx - 2]


def merge_into(root: Path, lib: str, comp: dict) -> None:
    say(f"Merging '{escape(comp['sym'].name)}' into '{escape(lib)}'")
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
    say("Merge done.")


def create_library(root: Path, comp: dict) -> None:
    default = comp["sym"].stem + LIB_SUFFIX
    name = Prompt.ask("Library name", default=default).strip() or default
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

    lib_desc = Prompt.ask("Library description", default=name).strip() or name
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
        say("repository.json not found → creating new one")
        repo = {"packages": []}
    repo.setdefault("packages", []).append({"path": f"{name}/metadata.json"})
    repo_json.write_text(json.dumps(repo, indent=2))
    say(f"Created library '{escape(name)}'.")


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
        say(f"Backup created: {escape(str(backup))}")


def add_library_to_table(table_path: Path, lib_name: str, lib_uri: Path,
                         lib_desc: str = "") -> bool:
    """Append a library entry to a sym-lib-table or fp-lib-table."""
    backup_library_table(table_path)

    lines = table_path.read_text().splitlines(keepends=True)
    if any(f'(name "{lib_name}")' in ln for ln in lines):
        say(f"Library '{escape(lib_name)}' already exists in {table_path.name}")
        return False

    if not lines or lines[-1].strip() != ")":
        warn(f"Error: Malformed {table_path.name} file")
        return False

    entry = (f'  (lib (name "{lib_name}")(type "KiCad")(uri "{lib_uri}")'
             f'(options "")(descr "{lib_desc}"))\n')
    lines.insert(-1, entry)
    table_path.write_text("".join(lines))
    say(f"Added '{escape(lib_name)}' to {table_path.name}")
    return True


def choose_kicad_installation(configs: list[dict]) -> dict | None:
    console.print()
    say("Detected KiCad installations:")
    for i, cfg in enumerate(configs, 1):
        console.print(f"  [bold]{i}[/] - {cfg['type']} KiCad {cfg['version']} "
                      f"[dim]({escape(str(cfg['config_dir']))})[/]")

    if len(configs) == 1:
        cfg = configs[0]
        if not Confirm.ask(f"Install libraries to {cfg['type']} KiCad "
                           f"{cfg['version']}?", default=True):
            say("Installation cancelled.")
            return None
        return cfg

    sel = Prompt.ask("Select installation",
                     choices=[str(i) for i in range(1, len(configs) + 1)],
                     default="1", show_choices=False)
    return configs[int(sel) - 1]


def install_libraries_to_kicad(root: Path) -> None:
    """Register every library in the repo with the chosen KiCad install."""
    configs = detect_kicad_installations()
    if not configs:
        warn("No KiCad installation detected.")
        return

    selected = choose_kicad_installation(configs)
    if not selected:
        return
    say(f"Installing to {selected['type']} KiCad {selected['version']}")

    libs = list_libraries(root)
    if not libs:
        warn(f"No libraries found in {escape(str(root))}")
        return
    say(f"Found {len(libs)} libraries: {escape(', '.join(libs))}")

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

    say(f"Installation complete! Added {installed} libraries to KiCad.")
    say("Restart KiCad to see the new libraries.")


# ---------------------------------------------------------------------------
# Packaging
# ---------------------------------------------------------------------------

def package_repo(root: Path) -> None:
    out = root / (root.name + ".zip")
    say(f"Zipping repo → {out.name}")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for dirpath, _, filenames in os.walk(root):
            if ".git" in dirpath:
                continue
            for fn in filenames:
                if fn.endswith((".pyc", "~")) or fn == out.name:
                    continue
                p = Path(dirpath) / fn
                zf.write(p, p.relative_to(root))
    say("Done.")


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def process_component(root: Path, comp: dict) -> None:
    """Interactive pipeline: preview, describe, designate, file into a library."""
    show_component_preview(comp)
    edit_symbol_description(comp["sym"])
    set_default_designator(comp["sym"])
    if not check_duplicate(root, comp):
        return
    lib = choose_library(root)
    if lib:
        merge_into(root, lib, comp)
    else:
        create_library(root, comp)
    cleanup_downloads(comp)


def finish_actions(root: Path) -> None:
    console.print()
    say("Additional actions:")
    if Confirm.ask("Install libraries to KiCad?", default=False):
        install_libraries_to_kicad(root)
    if Confirm.ask("Create GitHub-release zip now?", default=False):
        package_repo(root)


def cmd_add(root: Path, parts: list[str]) -> None:
    jlc_exe = jlc_executable()

    # Leftovers from a previous (aborted) run are handled first.
    leftover = find_local_component(root)
    if leftover:
        say(f"Found existing component in {escape(str(root))}, "
            "processing it first.")
        process_component(root, leftover)
        if not parts and not Confirm.ask("Add another component?", default=False):
            finish_actions(root)
            return

    while True:
        if not parts:
            parts = Prompt.ask("Enter JLCPCB part #s (space-separated)").split()
            if not parts:
                break
        for part in parts:
            before = set(root.iterdir())
            if not download_part(part, jlc_exe, root):
                remove_new_entries(root, before)  # drop partial downloads
                continue
            wrap_assets(root)
            comp = find_local_component(root)
            if not comp:
                warn(f"{part}: downloaded files do not form a single "
                     "component — removing them.")
                remove_new_entries(root, before)
                continue
            process_component(root, comp)
        parts = []
        if not Confirm.ask("Add another component?", default=False):
            break

    finish_actions(root)


def cmd_interactive(root: Path) -> None:
    if find_local_component(root):
        cmd_add(root, [])
        return
    console.print()
    say("No local components found. Choose an option:")
    console.print("  [bold]1[/] - Download JLCPCB parts and create library")
    console.print("  [bold]2[/] - Install existing libraries to KiCad")
    choice = Prompt.ask("Select", choices=["1", "2"], default="1",
                        show_choices=False)
    if choice == "1":
        cmd_add(root, [])
    else:
        install_libraries_to_kicad(root)


def cmd_config(reset: bool) -> None:
    path = config_file()
    if reset:
        cfg = load_config()
        cfg["library_root"] = str(prompt_for_library_root())
        save_config(cfg)
        return
    if not path.is_file():
        say(f"No configuration yet (will be created at {escape(str(path))} "
            "on first run).")
        return
    say(f"Configuration file: {escape(str(path))}\n")
    console.print(escape(path.read_text()), end="")


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
    say(f"Library repository: {escape(str(root))}")

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
        console.print("\n[dim]Interrupted.[/]")
        sys.exit(130)
    except EOFError:
        console.print("\n[dim]Input closed — exiting.[/]")
        sys.exit(1)
