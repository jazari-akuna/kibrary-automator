"""Drag-and-drop import.

Two-stage workflow:
  1. ``scan_paths(paths)`` — walks dropped paths (files OR folders),
     classifies by extension, groups files with the same basename stem
     into one ``DroppedGroup``. The frontend keeps these in memory and
     shows a row per group with a LibPicker.
  2. ``commit_group(workspace, group, target_lib, edits)`` — when the
     user picks a target library and clicks Move, stages the group's
     files into LCSC-style layout under ``.kibrary/staging/`` and hands
     off to the existing ``library.commit_to_library`` machinery so the
     create-new vs merge-into branching, footprint-ref rewriting, 3D
     path rewriting, and KiCad lib-table registration are all reused
     instead of duplicated.

Source files are NEVER moved; ``commit_group`` always copies. The user's
original drop folder is left untouched.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Iterable

from kiutils.symbol import SymbolLib

from kibrary_sidecar import library

log = logging.getLogger(__name__)

# Recognised file extensions, lower-case. Anything else falls into `unmatched`.
_SYMBOL_EXTS = {".kicad_sym"}
_FOOTPRINT_EXTS = {".kicad_mod"}
_MODEL_EXTS = {".step", ".stp", ".wrl"}
_RECOGNISED_EXTS = _SYMBOL_EXTS | _FOOTPRINT_EXTS | _MODEL_EXTS


def _classify(path: Path) -> str | None:
    """Return 'symbol' / 'footprint' / 'model' / None for one file path."""
    suf = path.suffix.lower()
    if suf in _SYMBOL_EXTS:
        return "symbol"
    if suf in _FOOTPRINT_EXTS:
        return "footprint"
    if suf in _MODEL_EXTS:
        return "model"
    return None


def _empty_group(name: str, source_dir: str) -> dict:
    return {
        "name": name,
        "symbol_path": None,
        "footprint_path": None,
        "model_paths": [],
        "source_dir": source_dir,
    }


def _scan_dir_into_group(directory: Path, group: dict, unmatched: list[str]) -> bool:
    """Add every recognised file directly inside *directory* (NOT recursively)
    into ``group``. Returns True if any file was added.

    Subdirectories are not recursed here — the caller decides whether
    each subdirectory becomes its own group.
    """
    added = False
    for child in sorted(directory.iterdir()):
        if not child.is_file():
            continue
        kind = _classify(child)
        if kind == "symbol":
            group["symbol_path"] = str(child)
            added = True
        elif kind == "footprint":
            group["footprint_path"] = str(child)
            added = True
        elif kind == "model":
            group["model_paths"].append(str(child))
            added = True
        else:
            unmatched.append(str(child))
    return added


def _walk_folder(directory: Path, folders: list[dict], unmatched: list[str]) -> None:
    """Each folder = one component. Subfolders become their own components.

    Implements the user's spec: "If I drag a folder, you can assume that
    all the files in a same folder are for the same component" — each
    directory's direct children form one group; nested directories
    recurse with the same rule.
    """
    group = _empty_group(name=directory.name, source_dir=str(directory))
    if _scan_dir_into_group(directory, group, unmatched):
        folders.append(group)
    for child in sorted(directory.iterdir()):
        if child.is_dir():
            _walk_folder(child, folders, unmatched)


def scan_paths(paths: list[str]) -> dict:
    """Classify dropped paths into folder-groups + loose files.

    Returns:
        {
          "folders": [DroppedGroup, …],     # one per dropped directory
          "loose_files": [                  # files dropped directly (NOT
            {"kind": "symbol|footprint|model", "path": str},
            …
          ],
          "unmatched": [str, …]
        }

    Grouping rules (per user spec, alpha.3):
      - A dropped FOLDER → one component. All files directly inside it
        belong to that component. Nested subdirectories recurse with
        the same rule (each subdir = its own component).
      - A LOOSE file (dropped directly, not inside a folder) is reported
        in ``loose_files``. The frontend attaches them to the last
        existing component, or starts a new one if none exists.

    Order is preserved: ``folders`` follows the order directories were
    encountered in the drop; ``loose_files`` follows the order they were
    dropped. This stability matters for the sequential-association rule.
    """
    folders: list[dict] = []
    loose_files: list[dict] = []
    unmatched: list[str] = []

    for raw in paths:
        p = Path(raw)
        if not p.exists():
            continue
        if p.is_file():
            kind = _classify(p)
            if kind is None:
                unmatched.append(str(p))
            else:
                loose_files.append({"kind": kind, "path": str(p)})
        elif p.is_dir():
            _walk_folder(p, folders, unmatched)

    return {
        "folders": folders,
        "loose_files": loose_files,
        "unmatched": unmatched,
    }


# ---------------------------------------------------------------------------
# commit_group — copy files into target library via existing commit machinery
# ---------------------------------------------------------------------------


def _stage_group_for_commit(staging_root: Path, group: dict) -> tuple[Path, str]:
    """Lay the dropped group out as if it were an LCSC staged part.

    The existing ``library.commit_to_library`` expects a directory
    ``<staging_root>/<lcsc>/`` containing ``<lcsc>.kicad_sym``,
    ``<lcsc>.pretty/`` and optionally ``<lcsc>.3dshapes/``. We mirror
    that layout under a synthetic ``DROP_<name>`` id so the existing
    create-new / merge-into helpers work without modification.

    Returns ``(staging_part_dir, synthetic_lcsc)``.
    """
    name = group["name"]
    synthetic_lcsc = f"DROP_{name}"
    part_dir = staging_root / synthetic_lcsc

    # Always start from a clean slate — a previous failed commit may have
    # left half-copied files behind.
    if part_dir.exists():
        shutil.rmtree(part_dir)
    part_dir.mkdir(parents=True)

    if group.get("symbol_path"):
        shutil.copy2(group["symbol_path"], part_dir / f"{synthetic_lcsc}.kicad_sym")

    if group.get("footprint_path"):
        pretty = part_dir / f"{synthetic_lcsc}.pretty"
        pretty.mkdir(exist_ok=True)
        # Preserve the dropped footprint's original filename so its
        # internal `(footprint "<name>" …)` token (which KiCad matches
        # against the file basename) keeps lining up.
        shutil.copy2(
            group["footprint_path"],
            pretty / Path(group["footprint_path"]).name,
        )

    model_paths = group.get("model_paths") or []
    if model_paths:
        threed = part_dir / f"{synthetic_lcsc}.3dshapes"
        threed.mkdir(exist_ok=True)
        for src in model_paths:
            shutil.copy2(src, threed / Path(src).name)

    return part_dir, synthetic_lcsc


def _read_committed_component_name(lib_dir: Path, target_lib: str, fallback: str) -> str:
    """Best-effort lookup of the component name actually written to the lib."""
    sym_file = lib_dir / f"{target_lib}.kicad_sym"
    if not sym_file.is_file():
        return fallback
    try:
        sl = SymbolLib().from_file(str(sym_file))
        # Newly merged symbol is appended last; create-new path also leaves
        # only one symbol when starting from a single-symbol drop.
        if sl.symbols:
            return sl.symbols[-1].entryName or fallback
    except Exception as exc:  # noqa: BLE001 — diagnostic, fall back to stem
        log.warning("drop.commit_group: symbol-name lookup failed: %s", exc)
    return fallback


def commit_group(
    workspace: Path,
    group: dict,
    target_lib: str,
    edits: dict | None = None,
) -> dict:
    """Copy a dropped group into ``target_lib`` and return navigation hints.

    The group must have been produced by ``scan_paths`` (or share its
    schema). ``target_lib`` is the destination library name; if the
    library doesn't exist it's created, otherwise the symbol is appended.

    Returns ``{committed_path, component_name, target_lib}`` so the
    frontend's "Open in library" button can pre-select the new entry.
    """
    if not group.get("symbol_path") and not group.get("footprint_path"):
        # Without at least a symbol or footprint there is nothing to
        # commit — a 3D-model-only drop has no library entry to open.
        raise ValueError(
            "Drop group has no symbol or footprint — at least one is required to commit"
        )

    staging_root = workspace / ".kibrary" / "staging"
    staging_root.mkdir(parents=True, exist_ok=True)

    part_dir, synthetic_lcsc = _stage_group_for_commit(staging_root, group)

    try:
        lib_dir = library.commit_to_library(
            workspace=workspace,
            lcsc=synthetic_lcsc,
            staging_part=part_dir,
            target_lib=target_lib,
            edits=edits or {},
        )
    finally:
        # Best-effort cleanup — commit_to_library moves most files out via
        # shutil.move on the create-new path, but the merge-into path
        # leaves the staging dir intact. Either way, drop the staging dir
        # so re-commits start clean and we don't leak disk space.
        if part_dir.exists():
            shutil.rmtree(part_dir, ignore_errors=True)

    component_name = _read_committed_component_name(lib_dir, target_lib, group["name"])

    return {
        "committed_path": str(lib_dir),
        "component_name": component_name,
        "target_lib": target_lib,
    }
