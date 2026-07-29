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
from pathlib import Path

APP_NAME    = "kibrary-automator"
PYTHON_DEPS = ("rich", "JLC2KiCadLib")
MIN_PY      = (3, 10)  # JLC2KiCadLib uses zip(strict=) / match — needs 3.10+

# Defaults for the user-tunable settings; override them in the config file
# (their YAML keys are in parentheses — see `kibrary_automator.py config`).
LIB_SUFFIX    = "_KSL"          # (lib_suffix)  suffix for new library names
GH_USER       = "jazari-akuna"  # (github_user) used in package metadata
MODEL_ENV_VAR = "${KSL_ROOT}"   # (model_var)   KiCad path variable for 3D models


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


def _interpreter_version(exe: str) -> tuple | None:
    try:
        out = subprocess.run(
            [exe, "-c", "import sys;print(sys.version_info[0],sys.version_info[1])"],
            capture_output=True, text=True, timeout=5)
        if out.returncode == 0:
            return tuple(int(x) for x in out.stdout.split())
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None


def _find_python(min_ver: tuple) -> str | None:
    """Locate a Python interpreter >= min_ver (the current one, else search PATH)."""
    if sys.version_info[:2] >= min_ver:
        return sys.executable
    import shutil
    names = [f"python3.{m}" for m in range(20, min_ver[1] - 1, -1)] + ["python3"]
    prefixes = ["", "/opt/homebrew/bin/", "/usr/local/bin/",
                "/opt/local/bin/", "/usr/bin/"]
    seen, cands = set(), []
    for name in names:
        for pre in prefixes:
            p = pre + name
            resolved = shutil.which(p) or (p if os.path.isfile(p) else None)
            if resolved and resolved not in seen:
                seen.add(resolved)
                cands.append(resolved)
    for exe in cands:
        v = _interpreter_version(exe)
        if v and v >= min_ver:
            return exe
    return None


def _install_environment(stamp: Path, want: str) -> None:
    venv = venv_dir()
    need = f"{MIN_PY[0]}.{MIN_PY[1]}"
    base = _find_python(MIN_PY)
    if not base:
        hint = ("brew install python@3.12" if sys.platform == "darwin"
                else "sudo apt install python3.12" if sys.platform.startswith("linux")
                else "install a newer Python from python.org")
        sys.exit(f"{APP_NAME} needs Python {need}+ (JLC2KiCadLib requires it), "
                 f"but none was found.\nInstall one — e.g. `{hint}` — and retry.")

    print(f"First launch: setting up the {APP_NAME} environment.")

    # Rebuild if the venv is missing or was built with a too-old Python.
    existing = venv_binary("python")
    cur = _interpreter_version(str(existing)) if existing.is_file() else None
    if existing.is_file() and (cur is None or cur < MIN_PY):
        old = f"{cur[0]}.{cur[1]}" if cur else "unknown"
        print(f"→ Existing environment uses Python {old} (< {need}) — rebuilding.")
        shutil.rmtree(venv, ignore_errors=True)

    if not venv_binary("python").is_file():
        print(f"→ Creating virtual environment at {venv} "
              f"(Python {need}+ from {base}) ...")
        venv.parent.mkdir(parents=True, exist_ok=True)
        _run_or_die([base, "-m", "venv", str(venv)],
                    "creating the virtual environment")

    python = venv_binary("python")
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


def _venv_ready(stamp: Path, want: str) -> bool:
    """The venv exists, has the wanted deps, and is a new-enough Python."""
    python = venv_binary("python")
    if not (python.is_file() and stamp.is_file()
            and stamp.read_text().strip() == want):
        return False
    v = _interpreter_version(str(python))
    return bool(v and v >= MIN_PY)


def _bootstrap() -> None:
    """Make sure we are running inside the app venv with all dependencies."""
    if sys.version_info < (3, 8):
        sys.exit(f"{APP_NAME} needs Python 3.8 or newer.")
    if os.environ.get("KIBRARY_BOOTSTRAPPED") == "1":
        return

    stamp = venv_dir() / ".deps"
    want = ",".join(PYTHON_DEPS)
    if not _venv_ready(stamp, want):
        _install_environment(stamp, want)
    python = venv_binary("python")

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
    try:
        _bootstrap()
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(130)

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


def _read_raw_key() -> str:
    """Read one keypress from the terminal without waiting for Enter."""
    if os.name == "nt":
        import msvcrt
        ch = msvcrt.getwch()
    else:
        import termios
        import tty
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            ch = sys.stdin.read(1)
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)
    if ch == "\x03":               # raw mode swallows Ctrl+C — re-raise it
        raise KeyboardInterrupt
    if ch in ("\x04", "\x1a", ""):  # Ctrl+D / Ctrl+Z
        raise EOFError
    return ch


def ask_key(prompt: str, choices: list[str], default: str) -> str:
    """One-keypress choice (Enter = default), so single-digit menus don't
    need Enter. Falls back to a regular prompt when stdin is not a terminal
    or a choice needs more than one key."""
    if not sys.stdin.isatty() or any(len(c) != 1 for c in choices):
        return Prompt.ask(prompt, choices=choices, default=default,
                          show_choices=False)
    console.print(f"{prompt} [magenta]\\[{'/'.join(choices)}][/] "
                  f"[cyan]({default})[/]: ", end="")
    while True:
        ch = _read_raw_key()
        if ch in ("\r", "\n"):
            ch = default
        if ch in choices:
            console.print(ch)
            return ch


def ask_yn(question: str, default: bool = False) -> bool:
    if not sys.stdin.isatty():
        return Confirm.ask(question, default=default)
    return ask_key(question, ["y", "n"], "y" if default else "n") == "y"


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


SETTING_COMMENTS = {
    "library_root": "Path to your KiCad library repository",
    "lib_suffix":   "Suffix appended to new library names",
    "github_user":  "GitHub username used in package metadata",
    "model_var":    "KiCad path variable used for 3D-model paths in footprints",
}


def default_settings() -> dict:
    return {
        "lib_suffix": LIB_SUFFIX,
        "github_user": GH_USER,
        "model_var": MODEL_ENV_VAR,
    }


def apply_settings(cfg: dict) -> None:
    """Override the default settings with values from the config file."""
    global LIB_SUFFIX, GH_USER, MODEL_ENV_VAR
    LIB_SUFFIX    = cfg.get("lib_suffix", LIB_SUFFIX)
    GH_USER       = cfg.get("github_user", GH_USER)
    MODEL_ENV_VAR = cfg.get("model_var", MODEL_ENV_VAR)


def save_config(cfg: dict) -> None:
    """Write the config, seeding every tunable so it is visible and editable."""
    path = config_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    cfg = {**default_settings(), **cfg}
    lines = [
        f"# {APP_NAME} configuration",
        "# Edit freely — one `key: value` per line.",
        "",
    ]
    for key in sorted(cfg):
        if key in SETTING_COMMENTS:
            lines.append(f"# {SETTING_COMMENTS[key]}")
        lines.append(f"{key}: {cfg[key]}")
        lines.append("")
    path.write_text("\n".join(lines))
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
        if ask_yn(f"{escape(str(root))} does not exist. Create it?",
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
    pairs = [(left[i] if i < len(left) else None,
              right[i] if i < len(right) else None) for i in range(rows)]

    # Very tall symbols get their middle rows elided so the preview stays
    # at the top of the screen instead of filling it.
    max_rows, keep = 24, 10
    hidden = rows - 2 * keep if rows > max_rows else 0
    if hidden:
        pairs = pairs[:keep] + [None] + pairs[-keep:]
    elision = f"⋮ {hidden} more ⋮" if hidden else ""

    lw = max((len(p["name"]) for p in left), default=0)
    rw = max((len(p["name"]) for p in right), default=0)
    body_w = max(len(name) + 4, len(elision) + 2, 12)
    lpw = 4 + 1 + lw + 1               # "{num:>4} {name:>{lw}} "
    mid = (len(pairs) - 1) // 2
    if hidden and pairs[mid] is None:
        mid += 1

    lines = [" " * lpw + "┌" + "─" * body_w + "┐"]
    for i, pair in enumerate(pairs):
        if pair is None:
            lines.append(" " * lpw + "│" + elision.center(body_w) + "│")
            continue
        lp, rp = pair
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
    grid  = [[" "] * cols for _ in range(rows_n)]
    owner = [[None] * cols for _ in range(rows_n)]  # pad index, or SHARED
    SHARED = -1

    def cell_span(lo: float, hi: float, scale: float, n: int) -> tuple[int, int]:
        """Cells covered by [lo, hi] (mm), ignoring sliver overlaps.

        A cell only counts when the pad covers at least 30% of it, so rows
        of physically aligned pads always land on the same cells instead of
        randomly bleeding into neighbors and producing ragged bars.
        """
        lo_c, hi_c = lo * scale, hi * scale
        c0 = min(max(int(lo_c), 0), n - 1)
        c1 = min(max(int(hi_c), 0), n - 1)
        if c1 > c0 and hi_c - c1 < 0.3:
            c1 -= 1
        if c1 > c0 and c0 + 1 - lo_c < 0.3:
            c0 += 1
        return c0, c1

    rects = []
    for i, p in enumerate(pads):
        c0, c1 = cell_span(p["x"] - p["w"] / 2 - min_x,
                           p["x"] + p["w"] / 2 - min_x, s, cols)
        r0, r1 = cell_span(p["y"] - p["h"] / 2 - min_y,
                           p["y"] + p["h"] / 2 - min_y, s / 2, rows_n)
        rects.append((c0, c1, r0, r1))
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                grid[r][c] = "▒"
                owner[r][c] = i if owner[r][c] in (None, i) else SHARED

    # A pad gets its number drawn only on cells it owns exclusively, so
    # dense footprints show clean pad bars instead of overlapping digits.
    labelled = set()
    labelled_nums = set()
    for i, p in enumerate(pads):
        label = p["num"]
        c0, c1, r0, r1 = rects[i]
        pad_w = c1 - c0 + 1
        if not label or pad_w < max(len(label), 2):
            continue
        rr = (r0 + r1) // 2
        cc = (c0 + c1 + 1 - len(label)) // 2
        cells = [(rr, cc + k) for k in range(len(label))]
        if any(owner[r][c] != i or (r, c) in labelled for r, c in cells):
            continue
        if r1 > r0:
            # tall pad: give the number its own clear row inside the pad
            for c in range(c0, c1 + 1):
                if owner[rr][c] == i:
                    grid[rr][c] = " "
        for (r, c), ch in zip(cells, label):
            grid[r][c] = ch
        labelled.update(cells)
        labelled_nums.add(label)
    in_pad_nums = set(labelled_nums)

    # Dense parts cannot fit numbers inside their pads; mark at least the
    # first pins (1-4) in the free space next to them, so the start and
    # direction of the numbering stay visible.
    missing = [(i, p) for i, p in enumerate(pads)
               if p["num"] in ("1", "2", "3", "4")
               and p["num"] not in labelled_nums]
    if missing:
        grid.insert(0, [" "] * cols)
        grid.append([" "] * cols)
        mid_row = (len(grid) - 1) / 2
        callout_cells = set()

        def try_callout(num: str, spots: list, strict: bool) -> bool:
            for r, c in spots:
                if not (0 <= r < len(grid) and 0 <= c < cols):
                    continue
                if grid[r][c] != " ":
                    continue
                left  = grid[r][c - 1] if c > 0 else " "
                right = grid[r][c + 1] if c < cols - 1 else " "
                if strict and (left != " " or right != " "):
                    continue
                # never let two callout digits touch and read as one number
                if (r, c - 1) in callout_cells or (r, c + 1) in callout_cells:
                    continue
                grid[r][c] = num
                callout_cells.add((r, c))
                return True
            return False

        for i, p in sorted(missing, key=lambda ip: int(ip[1]["num"])):
            c0, c1, r0, r1 = rects[i]
            r0, r1 = r0 + 1, r1 + 1            # account for the margin row
            cp = (c0 + c1) // 2
            outward = [(r0 - 1, cp), (r1 + 1, cp)]
            if (r0 + r1) / 2 > mid_row:        # pad in bottom half → below first
                outward.reverse()
            spots = [(r, c + dc) for r, c in outward for dc in (0, -1, 1, -2, 2)]
            if try_callout(p["num"], spots, True) \
                    or try_callout(p["num"], spots, False):
                labelled_nums.add(p["num"])

    # drop margin rows that ended up unused
    while grid and all(ch == " " for ch in grid[0]):
        grid.pop(0)
    while grid and all(ch == " " for ch in grid[-1]):
        grid.pop()

    footer = f"{len(pads)} pads · {span_x:.1f} × {span_y:.1f} mm"
    pin1 = next((p for p in pads if p["num"] == "1"), None)
    if pin1 and "1" not in in_pad_nums:
        fx = (pin1["x"] - min_x) / span_x
        fy = (pin1["y"] - min_y) / span_y  # footprint +y points down
        horiz = "left" if fx < 1 / 3 else "right" if fx > 2 / 3 else "center"
        vert = "top" if fy < 1 / 3 else "bottom" if fy > 2 / 3 else "middle"
        footer += f" · pin 1: {vert} {horiz}"

    all_nums = {p["num"] for p in pads if p["num"]}
    if all_nums - labelled_nums:
        footer += "\n(too dense to number all pins — showing pins 1-4 only)"

    canvas = "\n".join("".join(r).rstrip() for r in grid)
    return f"{canvas}\n\n{footer}"


def show_component_preview(comp: dict) -> None:
    """Clear the screen and show symbol + footprint at the top."""
    sym_str = render_symbol(comp["sym"])
    sym_view = Text(sym_str)
    fp_file = next((f for f in sorted(comp["pretty"].iterdir())
                    if f.suffix == ".kicad_mod"), None)
    # Give the footprint whatever width remains next to the symbol panel.
    sym_w = max((len(ln) for ln in sym_str.splitlines()), default=0)
    fp_width = max(30, min(76, console.width - sym_w - 14))
    fp_view = Text(render_footprint(fp_file, width=fp_width)
                   if fp_file else "(no footprint)")

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


def find_download_leftovers(root: Path) -> list[Path]:
    """Transient download artifacts sitting loose in the library root.

    Finished libraries live inside their own folders, so any symbol file,
    .pretty/.3dshapes folder, or model file at the top level is a leftover
    from an unfinished download.
    """
    loose_suffixes = (".kicad_sym", ".kicad_mod", ".wrl", ".step", ".stp", ".3ds")
    out = []
    for entry in root.iterdir():
        if entry.is_file() and entry.suffix.lower() in loose_suffixes:
            out.append(entry)
        elif entry.is_dir() and entry.suffix in (".pretty", ".3dshapes"):
            out.append(entry)
    return sorted(out)


def remove_paths(paths) -> None:
    for entry in paths:
        if entry.is_dir():
            shutil.rmtree(entry)
        elif entry.is_file():
            entry.unlink()


def remove_new_entries(root: Path, before: set) -> None:
    """Delete entries created in the library root since the snapshot."""
    remove_paths(set(root.iterdir()) - before)


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

def symbol_property(sym_file: Path, name: str) -> str:
    m = re.search(r'\(property\s+"%s"\s+"([^"]*)"' % re.escape(name),
                  sym_file.read_text())
    return m.group(1) if m else ""


_lcsc_cache: dict = {}


def lcsc_detail(part: str) -> dict:
    """Fetch (and cache) LCSC's product-detail record for a part."""
    if part in _lcsc_cache:
        return _lcsc_cache[part]
    import urllib.request
    req = urllib.request.Request(
        f"https://wmsc.lcsc.com/ftps/wm/product/detail?productCode={part}",
        headers={"User-Agent": "Mozilla/5.0"})
    result = {}
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            result = (json.loads(resp.read().decode()).get("result") or {})
    except Exception:
        pass
    _lcsc_cache[part] = result
    return result


def easyeda_description(part: str) -> str:
    """EasyEDA's short description for a part (fallback source)."""
    import urllib.request
    req = urllib.request.Request(
        f"https://easyeda.com/api/products/{part}/components?version=6.4.19.5",
        headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return ((json.loads(resp.read().decode()).get("result") or {})
                    .get("description") or "").strip()
    except Exception:
        return ""


def resolve_description(part: str) -> str:
    """Best human-readable description for a part (JLC2KiCadLib leaves it blank)."""
    r = lcsc_detail(part)
    for key in ("productIntroEn", "productDescEn", "productNameEn",
                "productKeyAttributes"):
        val = (r.get(key) or "").strip()
        if val:
            return val
    return easyeda_description(part)


def resolve_datasheet_url(part: str) -> str | None:
    """Ask LCSC for the part's datasheet PDF."""
    return lcsc_detail(part).get("pdfUrl") or None


def url_ok(url: str) -> bool:
    """Check that a URL actually resolves before linking it.

    LCSC redirects unknown resources to its homepage instead of 404ing,
    so a redirect that lands on a bare domain root counts as broken.
    """
    import urllib.parse
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            landed = urllib.parse.urlsplit(resp.geturl()).path
            return resp.status == 200 and landed not in ("", "/")
    except Exception:
        return False


def ensure_datasheet(sym_file: Path, part: str | None = None) -> None:
    """Make sure the symbol's Datasheet field links an actual datasheet.

    JLC2KiCadLib copies whatever link the EasyEDA footprint author entered —
    often a product page, sometimes nothing. When the field is not a PDF,
    resolve the real datasheet via LCSC (falling back to the product page).
    """
    current = symbol_property(sym_file, "Datasheet")
    if ".pdf" in current.lower():
        return
    part = part or symbol_property(sym_file, "LCSC")
    if not part:
        return
    with console.status("Resolving datasheet link..."):
        url = resolve_datasheet_url(part)
        if url and not url_ok(url):
            url = None
        if not url and not current:
            fallback = f"https://www.lcsc.com/product-detail/{part}.html"
            url = fallback if url_ok(fallback) else None
    if not url or url == current:
        return
    text = sym_file.read_text()
    new = re.sub(r'\(property\s+"Datasheet"\s+"[^"]*"',
                 f'(property "Datasheet" "{url}"', text, count=1)
    if new != text:
        sym_file.write_text(new)
        say(f"Datasheet: {escape(url)}")


def edit_symbol_description(sym_file: Path, part: str | None = None) -> None:
    lines = sym_file.read_text().splitlines()

    curr = next(
        (m.group(1)
         for ln in lines
         if (m := re.match(r'\s*\(property\s+"Description"\s+"([^"]*)"', ln))),
        ""
    )
    # JLC2KiCadLib leaves Description empty — pull one from the API as the default.
    part = part or symbol_property(sym_file, "LCSC")
    if not curr and part:
        with console.status("Resolving description..."):
            curr = resolve_description(part)
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


def normalise_model_offset(text: str) -> tuple[str, str | None]:
    """Turn JLC2KiCadLib's inch `(at (xyz ...))` into an explicit mm `(offset ...)`.

    JLC2KiCadLib emits the legacy `(module ...)` format, where the 3D-model
    placement node is `at` and KiCad reads it in INCHES -- see
    PCB_PARSER::parse3DModel, which multiplies it by 25.4. In the modern
    `(footprint ...)` format the same thing is spelled `offset` and read in
    MILLIMETRES. The converter's inch value is usually right, so the download
    renders correctly; the problem is that the file cannot say which unit it
    meant, and the next person to nudge the number by hand types millimetres
    and moves the model 25.4x too far. That is how a connector ended up 1.9 mm
    below the surface of a 1.6 mm board with nothing in DRC, ERC or the netlist
    to show for it.

    Converting on the way in costs nothing (the rendered position is
    identical, the value is just written in the unit it will be read in) and
    the ambiguity can never reach the library. Returns the new text and a
    human-readable note when something changed.
    """
    notes = []
    pos = 0
    while True:
        start = text.find("(model", pos)
        if start < 0:
            break
        depth, i = 0, start
        while i < len(text):
            if text[i] == "(":
                depth += 1
            elif text[i] == ")":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        block, end = text[start:i + 1], i + 1
        at = re.search(r'\(at\s*\(xyz\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s*\)\s*\)',
                       block)
        if not at:
            pos = end
            continue
        mm = tuple(float(v) * 25.4 for v in at.groups())
        new = (block[:at.start()]
               + "(offset (xyz {:.9g} {:.9g} {:.9g}))".format(*mm)
               + block[at.end():])
        notes.append("model offset (at (xyz {} {} {})) [inches] -> "
                     "(offset (xyz {:.9g} {:.9g} {:.9g})) [mm]"
                     .format(*at.groups(), *mm))
        text = text[:start] + new + text[end:]
        pos = start + len(new)
    return text, ("; ".join(notes) if notes else None)


def update_footprint_3d_paths(fp_dir: Path, model_dir: Path | None) -> None:
    """Rewrite footprint 3D-model paths to use the MODEL_ENV_VAR root, and
    restate the model offset in millimetres (see normalise_model_offset)."""
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
        text, note = normalise_model_offset("".join(out))
        fp.write_text(text)
        if note:
            console.print(f"[dim]{fp.name}: {note}[/dim]")


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
            if ask_yn(f"Component {escape(name)} exists in "
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
    sel = ask_key("Select", [str(i) for i in range(1, len(libs) + 2)], "1")
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


def choose_kicad_installation(configs: list[dict]) -> dict:
    if len(configs) == 1:
        return configs[0]
    console.print()
    say("Detected KiCad installations:")
    for i, cfg in enumerate(configs, 1):
        console.print(f"  [bold]{i}[/] - {cfg['type']} KiCad {cfg['version']} "
                      f"[dim]({escape(str(cfg['config_dir']))})[/]")
    sel = ask_key("Select installation",
                  [str(i) for i in range(1, len(configs) + 1)], "1")
    return configs[int(sel) - 1]


def install_libraries_to_kicad(root: Path) -> None:
    """Register every library in the repo with the chosen KiCad install."""
    configs = detect_kicad_installations()
    if not configs:
        warn("No KiCad installation detected.")
        return

    selected = choose_kicad_installation(configs)
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
# Commands
# ---------------------------------------------------------------------------

def process_component(root: Path, comp: dict, part: str | None = None) -> None:
    """Interactive pipeline: preview, describe, designate, file into a library."""
    show_component_preview(comp)
    ensure_datasheet(comp["sym"], part)
    edit_symbol_description(comp["sym"], part)
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
    """Register the libraries in KiCad — always, no questions asked."""
    console.print()
    install_libraries_to_kicad(root)


def cmd_add(root: Path, parts: list[str]) -> None:
    jlc_exe = jlc_executable()

    # Leftovers from a previous (aborted) run are handled first.
    leftovers = find_download_leftovers(root)
    if leftovers:
        say(f"Found previously downloaded files in {escape(str(root))}:")
        for p in leftovers:
            console.print(f"  [dim]{escape(p.name)}[/]")
        comp = find_local_component(root)
        if comp:
            console.print("  [bold]1[/] - Add the component to a library")
            console.print("  [bold]2[/] - Clean up (delete these files)")
            if ask_key("Select", ["1", "2"], "1") == "1":
                process_component(root, comp)
                if not parts and not ask_yn("Add another component?",
                                            default=False):
                    finish_actions(root)
                    return
            else:
                remove_paths(leftovers)
                say("Cleaned up.")
        else:
            warn("These files do not form a single component and would "
                 "break part detection.")
            if not ask_yn("Clean up (delete these files)?", default=True):
                sys.exit("Cannot continue with stray files in the library root.")
            remove_paths(leftovers)
            say("Cleaned up.")

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
            process_component(root, comp, part)
        parts = []
        if not ask_yn("Add another component?", default=False):
            break

    finish_actions(root)


def cmd_interactive(root: Path) -> None:
    if find_download_leftovers(root):
        cmd_add(root, [])
        return
    console.print()
    say("No local components found. Choose an option:")
    console.print("  [bold]1[/] - Download JLCPCB parts and create library")
    console.print("  [bold]2[/] - Install existing libraries to KiCad")
    choice = ask_key("Select", ["1", "2"], "1")
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

    p_cfg = sub.add_parser("config", help="show the stored configuration")
    p_cfg.add_argument("--reset", action="store_true",
                       help="ask for the library location again")
    return parser


# Library root of the current run, for the Ctrl+C cleanup offer.
_active_root: Path | None = None


def offer_cleanup_on_exit() -> None:
    """After Ctrl+C, offer to delete partially downloaded component files."""
    try:
        root = _active_root
        if root is None:
            stored = load_config().get("library_root")
            if not stored:
                return
            root = Path(stored).expanduser()
        if not root.is_dir():
            return
        leftovers = find_download_leftovers(root)
        if not leftovers:
            return
        console.print()
        say("Downloaded component files remain in the library repository:")
        for p in leftovers:
            console.print(f"  [dim]{escape(p.name)}[/]")
        if ask_yn("Clean them up before quitting?", default=True):
            remove_paths(leftovers)
            say("Cleaned up.")
        else:
            say("Kept — the next launch will offer to add or clean them.")
    except (KeyboardInterrupt, EOFError):
        console.print()


def main() -> None:
    # Convenience: `kibrary_automator.py C1525 C2040` implies `add`.
    argv = sys.argv[1:]
    commands = {"add", "install", "config"}
    if argv and not argv[0].startswith("-") and argv[0] not in commands:
        argv = ["add"] + argv

    args = build_parser().parse_args(argv)
    apply_settings(load_config())

    if args.command == "config":
        cmd_config(args.reset)
        return

    global _active_root
    root = _active_root = resolve_library_root(args.library_root)
    say(f"Library repository: {escape(str(root))}")

    if args.command == "add":
        cmd_add(root, args.parts)
    elif args.command == "install":
        install_libraries_to_kicad(root)
    else:
        cmd_interactive(root)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        console.print("\n[dim]Interrupted.[/]")
        offer_cleanup_on_exit()
        sys.exit(130)
    except EOFError:
        console.print("\n[dim]Input closed — exiting.[/]")
        sys.exit(1)
