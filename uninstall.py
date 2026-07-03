#!/usr/bin/env python3
"""Uninstall kibrary-automator.

Removes what the tool created on this machine:
  1. its private virtualenv and configuration directory, and
  2. the library entries it registered in KiCad's sym-lib-table /
     fp-lib-table files (entries whose uri points inside your configured
     library repository).

Your KiCad library repository itself — the folder holding the *_KSL
libraries — is NEVER touched.

Pure standard library, Python 3.8+: it works even when the app's private
virtualenv is broken or half-deleted.

Usage:
  python3 uninstall.py         # asks [y/N] before every removal
  python3 uninstall.py --yes   # no questions asked
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
from pathlib import Path

APP_NAME = "kibrary-automator"


# ---------------------------------------------------------------------------
# Well-known paths (must mirror kibrary_automator.py exactly)
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


def kicad_config_bases() -> list:
    """Candidate KiCad settings directories per platform/packaging."""
    if sys.platform == "darwin":
        return [("macOS", Path.home() / "Library/Preferences/kicad")]
    return [
        ("Flatpak", Path.home() / ".var/app/org.kicad.KiCad/config/kicad"),
        ("Regular", Path.home() / ".config/kicad"),
    ]


def find_library_tables() -> list:
    """Every sym-lib-table / fp-lib-table of every detected KiCad version."""
    tables = []
    for kind, base in kicad_config_bases():
        if not base.is_dir():
            continue
        for version_dir in sorted(d for d in base.iterdir() if d.is_dir()):
            for name in ("sym-lib-table", "fp-lib-table"):
                table = version_dir / name
                if table.is_file():
                    tables.append((f"{kind} KiCad {version_dir.name}", table))
    return tables


# ---------------------------------------------------------------------------
# Configuration file (same flat `key: value` YAML the main script writes)
# ---------------------------------------------------------------------------

def load_config() -> dict:
    cfg = {}
    path = config_file()
    if not path.is_file():
        return cfg
    try:
        text = path.read_text()
    except (OSError, UnicodeDecodeError):
        return cfg
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition(":")
        if sep:
            cfg[key.strip()] = value.strip().strip("'\"")
    return cfg


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def confirm(question: str, assume_yes: bool) -> bool:
    if assume_yes:
        print(f"{question} [y/N]: y  (--yes)")
        return True
    answer = input(f"{question} [y/N]: ").strip().lower()
    return answer in ("y", "yes")


def plural(n: int, word: str = "entry") -> str:
    if word == "entry":
        return "entry" if n == 1 else "entries"
    return word if n == 1 else word + "s"


# ---------------------------------------------------------------------------
# KiCad library-table cleanup
# ---------------------------------------------------------------------------

_URI_RE  = re.compile(r'\(\s*uri\s+(?:"([^"]*)"|([^\s()]+))\s*\)')
_NAME_RE = re.compile(r'\(\s*name\s+(?:"([^"]*)"|([^\s()]+))\s*\)')


def _norm(path: Path) -> Path:
    try:
        return path.expanduser().resolve()
    except (OSError, RuntimeError):
        return path.expanduser().absolute()


def uri_points_into(uri: str, root: Path) -> bool:
    """True when the table entry's uri targets a file inside library_root."""
    expanded = os.path.expandvars(os.path.expanduser(uri))
    if "${" in expanded:
        return False  # unresolved KiCad path variable — not one of ours
    try:
        _norm(Path(expanded)).relative_to(_norm(root))
        return True
    except ValueError:
        return False


def clean_table(label: str, table: Path, root: Path, assume_yes: bool):
    """Remove our `(lib ...)` lines from one table.

    Returns a list of removed entry names, [] when the table has none of
    ours, or None when the user declined the removal.
    """
    try:
        lines = table.read_text().splitlines(keepends=True)
    except (OSError, UnicodeDecodeError) as exc:
        print(f"  ! Cannot read {table}: {exc}")
        return []

    doomed = []  # (line index, entry name, uri)
    for i, line in enumerate(lines):
        if not line.lstrip().startswith("(lib"):
            continue
        m = _URI_RE.search(line)
        uri = (m.group(1) or m.group(2)) if m else None
        if not uri or not uri_points_into(uri, root):
            continue
        nm = _NAME_RE.search(line)
        name = (nm.group(1) or nm.group(2)) if nm else "?"
        doomed.append((i, name, uri))

    if not doomed:
        return []

    print(f"\n{label} — {table}")
    print(f"  {APP_NAME} {plural(len(doomed))} found:")
    for _, name, uri in doomed:
        print(f"    - {name}  ({uri})")
    if not confirm(f"Remove {len(doomed)} {plural(len(doomed))} "
                   f"from {table.name}?", assume_yes):
        print("  Kept.")
        return None

    doomed_idx = {i for i, _, _ in doomed}
    table.write_text(
        "".join(ln for i, ln in enumerate(lines) if i not in doomed_idx))
    print(f"  Removed {len(doomed)} {plural(len(doomed))}.")
    return [name for _, name, _ in doomed]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description=f"Uninstall {APP_NAME}: delete its private virtualenv "
                    "and configuration, and de-register its libraries from "
                    "KiCad. Your library repository is never deleted.")
    parser.add_argument("-y", "--yes", action="store_true",
                        help="answer yes to every prompt")
    args = parser.parse_args()

    print(f"{APP_NAME} uninstaller")
    print("=" * (len(APP_NAME) + 12))

    removed = []
    kept = []

    # -- Step 1: read the config BEFORE anything gets deleted ---------------
    library_root = load_config().get("library_root")

    # -- Step 2: de-register our entries from KiCad's library tables --------
    if library_root:
        root = Path(library_root).expanduser()
        print(f"\nConfigured library repository: {root}")
        tables = find_library_tables()
        if not tables:
            print("No KiCad library tables found — nothing to de-register.")
        matched_any = False
        for label, table in tables:
            result = clean_table(label, table, root, args.yes)
            if result is None:
                matched_any = True
                kept.append(f"{table} ({APP_NAME} entries left in place)")
            elif result:
                matched_any = True
                removed.append(f"{len(result)} {plural(len(result))} from "
                               f"{table}: {', '.join(result)}")
        if tables and not matched_any:
            print(f"No {APP_NAME} entries found in any KiCad library table.")
    else:
        print(f"\nNo configuration found at {config_file()} — skipping the "
              "KiCad library-table cleanup (cannot tell which entries were "
              "installed by the tool).")

    # -- Step 3: delete the private venv / config / data directories --------
    cdir, ddir = config_dir(), data_dir()
    if cdir == ddir:
        targets = [(cdir, "configuration + private virtualenv")]
    else:
        targets = [(cdir, "configuration"),
                   (ddir, "data / private virtualenv")]

    print()
    for directory, what in targets:
        if not directory.exists():
            print(f"{directory} — already absent.")
            continue
        if confirm(f"Delete {directory} ({what})?", args.yes):
            try:
                shutil.rmtree(directory)
                removed.append(f"{directory} ({what})")
                print("  Deleted.")
            except OSError as exc:
                print(f"  ! Could not delete: {exc}")
                kept.append(f"{directory} (deletion failed: {exc})")
        else:
            print("  Kept.")
            kept.append(f"{directory} ({what})")

    # -- The one thing this script never touches -----------------------------
    if library_root:
        kept.append(f"{Path(library_root).expanduser()} "
                    "(your library repository)")

    # -- Summary -------------------------------------------------------------
    print("\nSummary")
    print("-------")
    print("Removed:")
    for item in removed:
        print(f"  - {item}")
    if not removed:
        print("  (nothing)")
    print("Kept:")
    for item in kept:
        print(f"  - {item}")
    if not kept:
        print("  (nothing)")
    print("\nNote: your KiCad libraries themselves are never deleted by "
          "this script.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted — nothing further was changed.")
        sys.exit(130)
    except EOFError:
        print("\nInput closed — nothing further was changed.")
        sys.exit(1)
