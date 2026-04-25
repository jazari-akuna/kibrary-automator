"""library.py — commit a staged part into a KiCad symbol library.

Ported from the legacy kibrary_automator.py (create_library / merge_into),
using kiutils for clean symbol and footprint manipulation instead of raw
regex hacks where possible.
"""
from __future__ import annotations

import json
import logging
import re
import shutil
from pathlib import Path

from kiutils.symbol import SymbolLib

from kibrary_sidecar.symfile import write_properties

log = logging.getLogger(__name__)

# The ${KSL_ROOT} environment-variable convention used for 3D model paths.
_KSL_ROOT = "${KSL_ROOT}"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def commit_to_library(
    workspace: Path,
    lcsc: str,
    staging_part: Path,
    target_lib: str,
    edits: dict,
) -> Path:
    """Commit a staged part into *target_lib* inside *workspace*.

    Parameters
    ----------
    workspace:
        Root directory of the KiCad library workspace (e.g. ``/home/user/ksl``).
    lcsc:
        LCSC part number used to name the staging artefacts
        (``<lcsc>.kicad_sym``, ``<lcsc>.pretty/``, ``<lcsc>.3dshapes/``).
    staging_part:
        Path to the staging directory that contains the artefacts for *lcsc*.
    target_lib:
        Target library name, e.g. ``Resistors_KSL``.  The directory
        ``<workspace>/<target_lib>/`` will be created if it doesn't exist.
    edits:
        Property overrides applied via :func:`symfile.write_properties`
        (keys: ``Description``, ``Reference``, ``Value``, ``Datasheet``, …).

    Returns
    -------
    Path
        The library directory ``<workspace>/<target_lib>/``.
    """
    lib_dir = workspace / target_lib
    if lib_dir.exists():
        _merge_into(
            workspace=workspace,
            lcsc=lcsc,
            staging_part=staging_part,
            lib_dir=lib_dir,
            target_lib=target_lib,
            edits=edits,
        )
    else:
        _create_new(
            workspace=workspace,
            lcsc=lcsc,
            staging_part=staging_part,
            lib_dir=lib_dir,
            target_lib=target_lib,
            edits=edits,
        )
    return lib_dir


# ---------------------------------------------------------------------------
# CREATE-NEW path
# ---------------------------------------------------------------------------

def _create_new(
    workspace: Path,
    lcsc: str,
    staging_part: Path,
    lib_dir: Path,
    target_lib: str,
    edits: dict,
) -> None:
    lib_dir.mkdir(parents=True, exist_ok=True)

    # --- move symbol ---
    src_sym = staging_part / f"{lcsc}.kicad_sym"
    dst_sym = lib_dir / f"{target_lib}.kicad_sym"
    shutil.move(str(src_sym), dst_sym)

    # --- move .pretty footprint dir ---
    src_pretty = staging_part / f"{lcsc}.pretty"
    dst_pretty = lib_dir / f"{target_lib}.pretty"
    shutil.move(str(src_pretty), dst_pretty)

    # --- move .3dshapes dir (optional) ---
    src_3d = staging_part / f"{lcsc}.3dshapes"
    dst_3d = lib_dir / f"{target_lib}.3dshapes" if src_3d.is_dir() else None
    if src_3d.is_dir():
        shutil.move(str(src_3d), dst_3d)

    # --- apply edits ---
    if edits:
        write_properties(dst_sym, edits)

    # --- update symbol's Footprint property (e.g. ".:C_0402" → "Resistors_KSL:C_0402") ---
    _update_symbol_footprint_refs(dst_sym, target_lib)

    # --- update 3D model paths in .kicad_mod files ---
    if dst_3d is not None:
        _update_footprint_3d_paths(dst_pretty, target_lib, target_lib + ".3dshapes")

    # --- render / copy icon ---
    try:
        component_name = SymbolLib().from_file(str(dst_sym)).symbols[0].entryName
    except Exception:
        component_name = lcsc
    _copy_or_render_icon(staging_part, lcsc, lib_dir, target_lib, dst_pretty, component_name)

    # --- generate metadata.json (PCM format) ---
    _write_metadata(lib_dir, target_lib, has_3d=dst_3d is not None)

    # --- append to repository.json ---
    _append_repository(workspace, target_lib)


# ---------------------------------------------------------------------------
# MERGE-INTO path
# ---------------------------------------------------------------------------

def _merge_into(
    workspace: Path,
    lcsc: str,
    staging_part: Path,
    lib_dir: Path,
    target_lib: str,
    edits: dict,
) -> None:
    dst_sym = lib_dir / f"{target_lib}.kicad_sym"
    dst_pretty = lib_dir / f"{target_lib}.pretty"

    # --- merge symbol via kiutils ---
    src_sym = staging_part / f"{lcsc}.kicad_sym"
    existing_lib = SymbolLib().from_file(str(dst_sym))
    new_lib = SymbolLib().from_file(str(src_sym))
    for sym in new_lib.symbols:
        existing_lib.symbols.append(sym)
    existing_lib.to_file(str(dst_sym))

    # --- copy .kicad_mod files into existing .pretty dir ---
    src_pretty = staging_part / f"{lcsc}.pretty"
    dst_pretty.mkdir(exist_ok=True)
    for mod_file in src_pretty.glob("*.kicad_mod"):
        shutil.copy2(str(mod_file), dst_pretty / mod_file.name)

    # --- copy 3D models if staging has them ---
    src_3d = staging_part / f"{lcsc}.3dshapes"
    if src_3d.is_dir():
        dst_3d = lib_dir / f"{target_lib}.3dshapes"
        dst_3d.mkdir(exist_ok=True)
        for model_file in src_3d.iterdir():
            shutil.copy2(str(model_file), dst_3d / model_file.name)
        _update_footprint_3d_paths(dst_pretty, target_lib, target_lib + ".3dshapes")

    # --- apply edits to the (now merged) sym file ---
    if edits:
        write_properties(dst_sym, edits)

    # --- update footprint refs ---
    _update_symbol_footprint_refs(dst_sym, target_lib)

    # --- render / copy icon ---
    try:
        # The newly merged symbol is the last one in the file
        merged_lib = SymbolLib().from_file(str(dst_sym))
        component_name = merged_lib.symbols[-1].entryName
    except Exception:
        component_name = lcsc
    _copy_or_render_icon(staging_part, lcsc, lib_dir, target_lib, dst_pretty, component_name)

    # NOTE: repository.json is NOT re-appended on merge.


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _update_symbol_footprint_refs(sym_path: Path, target_lib: str) -> None:
    """Rewrite Footprint property values like ``".:Foo"`` → ``"<target_lib>:Foo"``.

    kiutils stores property values as plain strings, so we update them
    directly.  We use kiutils so that the write round-trips cleanly.
    """
    lib = SymbolLib().from_file(str(sym_path))
    changed = False
    for sym in lib.symbols:
        for prop in sym.properties:
            if prop.key == "Footprint" and prop.value:
                new_val = _rewrite_footprint_ref(prop.value, target_lib)
                if new_val != prop.value:
                    prop.value = new_val
                    changed = True
    if changed:
        lib.to_file(str(sym_path))


def _rewrite_footprint_ref(value: str, target_lib: str) -> str:
    """Replace the library part of a footprint reference with *target_lib*.

    Handles:
    - ``".:Foo"``      → ``"<target_lib>:Foo"``
    - ``".:Foo"``      → ``"<target_lib>:Foo"``
    - ``".Foo"``       → ``"<target_lib>:Foo"``
    - ``"OldLib:Foo"`` → left unchanged (already namespaced)
    """
    # Strip leading ".:" or "." prefix
    m = re.match(r'^\.[:./\\]*(.*)', value)
    if m:
        return f"{target_lib}:{m.group(1)}"
    return value


def _update_footprint_3d_paths(
    pretty_dir: Path,
    target_lib: str,
    shapes_dir_name: str,
) -> None:
    """Rewrite 3D model paths inside each ``.kicad_mod`` file.

    Uses kiutils ``Footprint`` / ``Model`` to update paths cleanly for
    footprints that parse correctly.  Falls back to a regex line-rewrite
    for files that kiutils cannot parse (e.g. bare-token paths without
    the full offset/scale/rotate sub-expressions).

    The resulting paths follow the ``${KSL_ROOT}/<target_lib>/<shapes_dir_name>/<file>``
    convention.
    """
    if not pretty_dir.is_dir():
        return

    for mod_path in pretty_dir.glob("*.kicad_mod"):
        _rewrite_3d_in_kicad_mod(mod_path, target_lib, shapes_dir_name)


def _rewrite_3d_in_kicad_mod(
    mod_path: Path,
    target_lib: str,
    shapes_dir_name: str,
) -> None:
    """Update 3D model paths in a single ``.kicad_mod`` file.

    Tries kiutils first; falls back to regex line rewriting.
    """
    try:
        from kiutils.footprint import Footprint
        fp = Footprint().from_file(str(mod_path))
        changed = False
        for model in fp.models:
            if _KSL_ROOT not in model.path:
                bare = _bare_filename(model.path)
                model.path = f"{_KSL_ROOT}/{target_lib}/{shapes_dir_name}/{bare}"
                changed = True
        if changed:
            fp.to_file(str(mod_path))
    except Exception:
        # Fallback: regex line rewrite (matches the legacy CLI approach)
        _regex_rewrite_3d_paths(mod_path, target_lib, shapes_dir_name)


def _bare_filename(path_str: str) -> str:
    """Extract the bare filename from a possibly-relative model path."""
    # Strip leading ./ ../ \ etc and keep the last path component
    # e.g.  "./C_0402_1005Metric.wrl"  →  "C_0402_1005Metric.wrl"
    #        "C_0402_1005Metric.wrl"   →  "C_0402_1005Metric.wrl"
    return Path(path_str.replace("\\", "/")).name or path_str


def _regex_rewrite_3d_paths(
    mod_path: Path,
    target_lib: str,
    shapes_dir_name: str,
) -> None:
    """Regex-based fallback for 3D path rewriting (port of the legacy CLI)."""
    lines = mod_path.read_text().splitlines(keepends=True)
    out = []
    for ln in lines:
        if ln.lstrip().startswith("(model ") and _KSL_ROOT not in ln:
            m = re.match(r'\s*\(model\s+[./\\]*([^"\s)]+)', ln)
            if m:
                fn3d = m.group(1)
                ln = f"  (model {_KSL_ROOT}/{target_lib}/{shapes_dir_name}/{fn3d}\n"
        out.append(ln)
    mod_path.write_text("".join(out))


def _copy_or_render_icon(
    staging_part: Path,
    lcsc: str,
    lib_dir: Path,
    target_lib: str,
    dst_pretty: Path,
    component_name: str,
) -> None:
    """Copy a pre-rendered staging icon, or render one now from the library .pretty.

    Best-effort — never raises, logs failures.
    """
    try:
        from kibrary_sidecar import icons  # local import avoids circular at module load

        icons_dir = lib_dir / f"{target_lib}.icons"
        icons_dir.mkdir(parents=True, exist_ok=True)
        icon_dst = icons_dir / f"{component_name}.svg"

        # Prefer the pre-rendered staging icon
        staging_icon = staging_part / f"{lcsc}.icon.svg"
        if staging_icon.is_file():
            shutil.copy2(str(staging_icon), icon_dst)
            log.debug("Copied staging icon %s → %s", staging_icon, icon_dst)
            return

        # Fall back: render now from the library's .pretty dir
        mods = sorted(dst_pretty.glob("*.kicad_mod")) if dst_pretty.is_dir() else []
        if mods:
            footprint_name = mods[0].stem
            icons.render_footprint_icon(dst_pretty, footprint_name, icon_dst)
            log.info("Rendered icon for %s → %s", component_name, icon_dst)
    except Exception as exc:
        log.warning("Icon copy/render failed for %s (non-fatal): %s", component_name, exc)


def _write_metadata(lib_dir: Path, target_lib: str, has_3d: bool) -> None:
    """Write a PCM-format ``metadata.json`` for the library."""
    meta = {
        "$schema": "https://go.kicad.org/pcm/schemas/v1",
        "name": target_lib,
        "description": target_lib,
        "identifier": f"com.kibrary.kicad-shared-libs.{target_lib}",
        "type": "library",
        "license": "CC-BY-SA-4.0",
        "author": {"name": "Unknown"},
        "maintainer": {"name": "kibrary-automator"},
        "content": {
            "symbols": [f"{target_lib}.kicad_sym"],
            "footprints": [f"{target_lib}.pretty"],
            "3dmodels": ([f"{target_lib}.3dshapes"] if has_3d else []),
        },
        "versions": [
            {"version": "1.0.0", "status": "stable", "kicad_version": "9.0"}
        ],
    }
    (lib_dir / "metadata.json").write_text(json.dumps(meta, indent=2))


def _append_repository(workspace: Path, target_lib: str) -> None:
    """Append ``{"path": "<target_lib>/metadata.json"}`` to ``repository.json``."""
    repo_path = workspace / "repository.json"
    if repo_path.is_file():
        repo = json.loads(repo_path.read_text())
    else:
        repo = {"packages": []}
    repo.setdefault("packages", []).append({"path": f"{target_lib}/metadata.json"})
    repo_path.write_text(json.dumps(repo, indent=2))
