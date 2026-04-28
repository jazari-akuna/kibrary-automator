"""kicad_register.py — KiCad library table registration (Task 29).

Manages entries in KiCad's sym-lib-table and fp-lib-table S-expression files.
File format:
  (sym_lib_table
    (lib (name "MyLib")(type "KiCad")(uri "/path/to/MyLib.kicad_sym")(options "")(descr ""))
  )

Also manages KiCad's path-variable map under ``kicad_common.json``'s
``environment.vars`` — kibrary commits 3D model paths as
``${KSL_ROOT}/<lib>/<lib>.3dshapes/<file>``, so KSL_ROOT must point at
the workspace root for KiCad's PCB editor / 3D viewer to find them.

Ported from legacy kibrary_automator.py:add_library_to_table /
install_libraries_to_kicad.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _backup(table_path: Path) -> str | None:
    """Copy *table_path* to <table_path>.backup if no backup exists yet.

    Returns the backup path string, or None if the backup already existed.
    """
    backup = Path(str(table_path) + ".backup")
    if not backup.exists():
        shutil.copy2(table_path, backup)
        return str(backup)
    return None


def _has_entry(lines: list[str], lib_name: str) -> bool:
    """Return True if *lib_name* is already present in *lines*."""
    token = f'(name "{lib_name}")'
    return any(token in line for line in lines)


def _insert_entry(table_path: Path, lib_name: str, lib_type: str, lib_uri: str,
                  lib_desc: str = "") -> bool:
    """Add a single entry to *table_path*.  Returns True if added, False if
    the entry already existed or the file was malformed.

    Backs up the file before the first modification.
    """
    lines = table_path.read_text().splitlines(keepends=True)

    if _has_entry(lines, lib_name):
        return False

    # The closing ')' must be the last non-empty token
    if not lines or lines[-1].strip() != ")":
        raise ValueError(
            f"Malformed KiCad table file (last line must be ')'): {table_path}"
        )

    _backup(table_path)

    new_entry = (
        f'  (lib (name "{lib_name}")(type "{lib_type}")'
        f'(uri "{lib_uri}")(options "")(descr "{lib_desc}"))\n'
    )
    lines.insert(-1, new_entry)
    table_path.write_text("".join(lines))
    return True


def _remove_entry(table_path: Path, lib_name: str) -> bool:
    """Remove the entry for *lib_name* from *table_path*.  Returns True if
    something was removed.
    """
    token = f'(name "{lib_name}")'
    lines = table_path.read_text().splitlines(keepends=True)
    new_lines = [ln for ln in lines if token not in ln]
    if len(new_lines) == len(lines):
        return False
    _backup(table_path)
    table_path.write_text("".join(new_lines))
    return True


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def register_library(install: dict, lib_name: str, lib_dir: Path) -> dict:
    """Add a library entry to install['sym_table'] and install['fp_table'].

    Derives:
    - Symbol file : ``lib_dir / "<lib_name>.kicad_sym"``
    - Footprint dir: ``lib_dir / "<lib_name>.pretty"``

    Only adds the footprint entry when the ``.pretty`` directory exists.

    Returns:
        {
            "sym_added": bool,
            "fp_added": bool,
            "backup_path": str | None,  # path of sym_table backup (first one)
        }

    Idempotent: duplicate entries are never written.
    """
    sym_table = Path(install["sym_table"])
    fp_table = Path(install["fp_table"])

    sym_uri = str(lib_dir / f"{lib_name}.kicad_sym")
    sym_desc = f"Local library: {lib_name}"

    # Snapshot whether a backup already exists before we start
    sym_backup_existed = Path(str(sym_table) + ".backup").exists()

    sym_added = _insert_entry(sym_table, lib_name, "KiCad", sym_uri, sym_desc)

    backup_path: str | None = None
    if sym_added and not sym_backup_existed:
        backup_path = str(sym_table) + ".backup"

    # Footprint — only register when the .pretty dir is present
    fp_added = False
    fp_dir = lib_dir / f"{lib_name}.pretty"
    if fp_dir.is_dir():
        fp_desc = f"Local footprint library: {lib_name}"
        fp_added = _insert_entry(fp_table, lib_name, "KiCad", str(fp_dir), fp_desc)

    return {"sym_added": sym_added, "fp_added": fp_added, "backup_path": backup_path}


def set_path_var(install: dict, name: str, value: str) -> bool:
    """Set a KiCad path variable under ``environment.vars`` in
    ``kicad_common.json``. Returns True iff the file was modified.

    KiCad's PCB editor / 3D viewer resolves ``${VAR_NAME}`` references in
    footprint model paths through this map. kibrary commits 3D model paths
    as ``${KSL_ROOT}/<lib>/<lib>.3dshapes/<file>`` so KSL_ROOT must be set
    to the workspace root.

    Idempotent: if the var already has the same value, no write occurs.
    Backs up ``kicad_common.json`` to ``.backup`` on first modification.
    """
    config_dir = install.get("config_dir")
    if not config_dir:
        return False
    common_path = Path(config_dir) / "kicad_common.json"
    if not common_path.is_file():
        return False
    try:
        data = json.loads(common_path.read_text(encoding="utf-8"))
    except Exception:
        return False
    env = data.setdefault("environment", {})
    vars_ = env.get("vars")
    if vars_ is None or not isinstance(vars_, dict):
        vars_ = {}
        env["vars"] = vars_
    if vars_.get(name) == value:
        return False
    backup = Path(str(common_path) + ".backup")
    if not backup.exists():
        shutil.copy2(common_path, backup)
    vars_[name] = value
    common_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return True


def list_registered(install: dict) -> list[str]:
    """Return the list of library names currently in the sym-lib-table."""
    sym_table = Path(install["sym_table"])
    names: list[str] = []
    for line in sym_table.read_text().splitlines():
        stripped = line.strip()
        if not stripped.startswith("(lib "):
            continue
        # Extract the name value between (name "...")
        start = stripped.find('(name "')
        if start == -1:
            continue
        start += len('(name "')
        end = stripped.find('")', start)
        if end == -1:
            continue
        names.append(stripped[start:end])
    return names


def unregister_library(install: dict, lib_name: str) -> dict:
    """Remove the entry for *lib_name* from both tables.

    Returns:
        {"sym_removed": bool, "fp_removed": bool}
    """
    sym_table = Path(install["sym_table"])
    fp_table = Path(install["fp_table"])

    sym_removed = _remove_entry(sym_table, lib_name)
    fp_removed = _remove_entry(fp_table, lib_name)

    return {"sym_removed": sym_removed, "fp_removed": fp_removed}
