"""library.* handlers (committed-library CRUD, props, 3D metadata, icons).

SVG/PNG/GLB rendering for committed libraries lives in
:mod:`kibrary_sidecar.handlers.render`.
"""

import difflib
import logging
from pathlib import Path

from kibrary_sidecar import workspace as ws
from kibrary_sidecar import category_map
from kibrary_sidecar import git_ops
from kibrary_sidecar import files
from kibrary_sidecar import icons as icons_mod

from kibrary_sidecar.handlers._common import (
    _lib_scanner,
    _lib_ops,
    _model3d_ops,
    _symfile,
    _library,
    _sexpr_diff,
)

log = logging.getLogger(__name__)


def library_read_props(p: dict) -> dict:
    """Read properties for a single component out of a multi-symbol library
    file. Library mode counterpart of parts.read_props (which reads the first
    symbol in a single-symbol staged file)."""
    lib_dir = Path(p["lib_dir"])
    sym_path = lib_dir / f"{lib_dir.name}.kicad_sym"
    return {"properties": _symfile().read_properties_named(sym_path, p["component_name"])}


def library_write_props(p: dict) -> dict:
    """Update properties for a single component in a multi-symbol library
    file (in place). Library mode counterpart of parts.write_props."""
    lib_dir = Path(p["lib_dir"])
    sym_path = lib_dir / f"{lib_dir.name}.kicad_sym"
    _symfile().write_properties_named(sym_path, p["component_name"], p["edits"])
    return {"ok": True}


def library_get_3d_info(p: dict) -> dict:
    """Returns the parsed (model ...) data from the part's first .kicad_mod,
    or {info: null} if the footprint has no model block.
    Accepts both staging-style (staging_dir + lcsc) and library-style
    (lib_dir + component_name) parameters."""
    if "lib_dir" in p:
        info = files.get_3d_info(
            lib_dir=Path(p["lib_dir"]), component_name=p["component_name"]
        )
    else:
        info = files.get_3d_info(Path(p["staging_dir"]), p["lcsc"])
    return {"info": info}


def library_suggest(p: dict) -> dict:
    """Suggest a library name for a part by category, optionally matching
    against libraries already present in *workspace*.

    Returns:
        library      (str)         — the recommended library name
        is_existing  (bool)        — True if `library` already exists in workspace
        existing     (list[str])   — all existing library names (for the picker)
        matches      (list[str])   — existing libs that fuzzy-match the suggestion,
                                      sorted by relevance (best match first)

    Fuzzy boost (alpha.18): when an existing lib is ≥ 50 % similar to the
    category-derived name (e.g. ``Connector_KSL`` for derived
    ``Connectors_KSL``), promote that existing lib to the recommended
    ``library`` field. The original derived name still surfaces in
    ``matches`` so the LibPicker dropdown lets the user pick "create new"
    if the boost mis-fires.

    `workspace` is optional for backwards compat with old callers — when
    omitted, only the category-derived name comes back (no matching).
    """
    derived = category_map.suggest_library(p.get("category", ""))
    workspace_path = p.get("workspace")
    if not workspace_path:
        return {"library": derived, "is_existing": False, "existing": [], "matches": []}

    try:
        existing_libs = _lib_scanner().list_libraries(Path(workspace_path))
        existing_names = sorted({lib["name"] for lib in existing_libs})
    except Exception as exc:
        log.warning("library.suggest: list_libraries failed: %s", exc)
        return {"library": derived, "is_existing": False, "existing": [], "matches": []}

    # Substring matches: case-insensitive prefix or substring on the derived
    # name without the _KSL suffix (so `Resistors_KSL` matches `Resistors`,
    # `Resistors_v2`, `MyResistors`). Cheap O(n) scan — workspaces have <1000 libs.
    needle = derived.lower().replace("_ksl", "")
    matches = sorted(
        (n for n in existing_names if needle in n.lower() and n != derived),
        key=lambda n: (not n.lower().startswith(needle), len(n)),
    )

    # Fuzzy boost: when one of the existing libs is sufficiently similar to
    # the derived name, that's the lib the user almost certainly wants. We
    # score on the de-suffixed form ONLY — every kibrary lib ends in `_KSL`
    # so the suffix is shared noise that artificially inflates ratios for
    # unrelated libs (`Resistors_KSL` ↔ `Tools_KSL` would score > 0.5
    # purely from the shared 4-character suffix). De-suffixing makes the
    # ratio reflect actual semantic similarity: `Connectors` ↔ `Connector`
    # scores 0.95, `Resistors` ↔ `Tools` scores 0.28.
    def _score(a: str, b: str) -> float:
        a_bare = a.lower().replace("_ksl", "")
        b_bare = b.lower().replace("_ksl", "")
        return difflib.SequenceMatcher(None, a_bare, b_bare).ratio()

    is_existing = derived in existing_names
    boost: str | None = None
    if not is_existing and existing_names:
        scored = [(name, _score(derived, name)) for name in existing_names]
        # Sort by score desc, then alphabetical for stable tie-break.
        scored.sort(key=lambda t: (-t[1], t[0]))
        best_name, best_score = scored[0]
        if best_score > 0.5:
            boost = best_name

    if boost is not None:
        # Demote the original derived name into matches so the LibPicker
        # still offers it as a "create new" option, and surface it before
        # other less-relevant existing matches.
        recommended = boost
        boosted_matches = [derived] + [m for m in matches if m != boost]
        return {
            "library": recommended,
            "is_existing": True,
            "existing": existing_names,
            "matches": boosted_matches,
        }

    return {
        "library": derived,
        "is_existing": is_existing,
        "existing": existing_names,
        "matches": matches,
    }


def library_check_duplicate(p: dict) -> dict:
    """Advisory pre-commit duplicate check (CLI parity).

    Returns ``{duplicate: bool, library: str|None, component_name: str|None}``
    so the UI can warn "this LCSC already exists in library X" before the user
    commits. Does NOT change commit semantics — see library.check_duplicate.
    """
    return _library().check_duplicate(Path(p["workspace"]), p["lcsc"])


def library_commit(p: dict) -> dict:
    """Commit a staged part to a target library, then optionally git-commit
    the change per the workspace's git settings.
    """
    workspace = Path(p["workspace"])
    lcsc = p["lcsc"]
    staging_part = Path(p["staging_dir"]) / lcsc
    target_lib = p["target_lib"]
    edits = p.get("edits", {})

    committed_path = _library().commit_to_library(
        workspace, lcsc, staging_part, target_lib, edits
    )

    settings_data = ws.read_workspace_settings(str(workspace))
    git_cfg = settings_data.get("git", {}) if settings_data else {}
    sha = None
    if git_cfg.get("enabled") and git_cfg.get("auto_commit"):
        template = git_cfg.get(
            "commit_template", "Add {lcsc} ({description}) to {library}"
        )
        message = template.format(
            lcsc=lcsc,
            description=edits.get("Description", lcsc),
            library=target_lib,
        )
        paths_to_stage = [
            str(committed_path.relative_to(workspace)),
            "repository.json",
        ]
        sha = git_ops.auto_commit(workspace, message, paths_to_stage, enabled=True)

    # alpha.22: surface the post-commit symbol entryName so the frontend can
    # navigate to it in the Libraries room. JLC2KiCadLib names symbols by MPN
    # (e.g. 0603WAF1002T5E) — the LCSC alone isn't enough to pick the row.
    component_name: str | None = None
    try:
        from kiutils.symbol import SymbolLib
        sym_file = committed_path / f"{committed_path.name}.kicad_sym"
        sym_lib = SymbolLib.from_file(str(sym_file))
        # The just-committed symbol is typically the last one merged; we
        # match by LCSC (entryName ^C\d+$ OR LCSC property == lcsc).
        for sym in sym_lib.symbols:
            if sym.unitId is not None:
                continue
            if sym.entryName == lcsc:
                component_name = sym.entryName
                break
            for prop in sym.properties:
                if prop.key == "LCSC" and prop.value == lcsc:
                    component_name = sym.entryName
                    break
            if component_name:
                break
    except Exception as exc:  # noqa: BLE001 — diagnostic only
        log.warning("library.commit: could not resolve component_name: %s", exc)

    return {
        "committed_path": str(committed_path),
        "git_sha": sha,
        "target_lib": target_lib,
        "component_name": component_name,
    }


def library_list(p: dict) -> dict:
    return {"libraries": _lib_scanner().list_libraries(Path(p["workspace"]))}


def library_list_components(p: dict) -> dict:
    return {"components": _lib_scanner().list_components(Path(p["lib_dir"]))}


def library_lcsc_index(p: dict) -> dict:
    return {"index": _lib_scanner().lcsc_index(Path(p["workspace"]))}


def library_get_component(p: dict) -> dict:
    return _lib_scanner().get_component(Path(p["lib_dir"]), p["component_name"])


def library_rename_component(p: dict) -> dict:
    _lib_ops().rename_component(Path(p["lib_dir"]), p["old_name"], p["new_name"])
    return {"ok": True}


def library_delete_component(p: dict) -> dict:
    _lib_ops().delete_component(Path(p["lib_dir"]), p["component_name"])
    return {"ok": True}


def library_move_component(p: dict) -> dict:
    _lib_ops().move_component(Path(p["src_lib"]), Path(p["dst_lib"]), p["component_name"])
    return {"ok": True}


def library_rename_library(p: dict) -> dict:
    _lib_ops().rename_library(Path(p["workspace"]), p["old"], p["new"])
    return {"ok": True}


def library_update_metadata(p: dict) -> dict:
    _lib_ops().update_library_metadata(Path(p["lib_dir"]), p["metadata"])
    return {"ok": True}


def library_diff(p: dict) -> dict:
    return {"changes": _sexpr_diff().diff_kicad_sym(p["before"], p["after"])}


def library_replace_3d(p: dict) -> dict:
    dst = _model3d_ops().replace_3d_model(
        Path(p["lib_dir"]), p["component_name"], Path(p["new_step_path"])
    )
    return {"path": str(dst)}


def library_add_3d(p: dict) -> dict:
    dst = _model3d_ops().add_3d_model(
        Path(p["lib_dir"]), p["component_name"], Path(p["src_path"])
    )
    return {"path": str(dst)}


def library_read_file_content(p: dict) -> dict:
    """Return the text content of a single component's symbol or footprint
    file from a committed library directory (the Libraries-room equivalent of
    ``parts.read_file`` for staging)."""
    return {
        "content": files.read_library_file(
            Path(p["lib_dir"]), p["component_name"], p["kind"]
        )
    }


def library_set_3d_offset(p: dict) -> dict:
    """Update the offset / rotation / scale of the first 3D model block in
    a committed component's ``.kicad_mod``."""
    _model3d_ops().set_3d_offset(
        Path(p["lib_dir"]),
        p["component_name"],
        offset=tuple(p.get("offset", [0, 0, 0])),
        rotation=tuple(p.get("rotation", [0, 0, 0])),
        scale=tuple(p.get("scale", [1, 1, 1])),
    )
    return {"ok": True}


def library_get_component_icon(p: dict) -> dict:
    """SVG content for a committed component's icon."""
    icons_dir = Path(p["lib_dir"]) / f"{Path(p['lib_dir']).name}.icons"
    icon_path = icons_dir / f"{p['component_name']}.svg"
    return {"svg": icon_path.read_text() if icon_path.is_file() else None}


def library_backfill_icons(p: dict) -> dict:
    """Walk workspace's _KSL libs and render missing icons."""
    return icons_mod.backfill_icons(Path(p["workspace"]))


REGISTRY = {
    "library.read_props": library_read_props,
    "library.write_props": library_write_props,
    "library.suggest": library_suggest,
    "library.check_duplicate": library_check_duplicate,
    "library.commit": library_commit,
    "library.list": library_list,
    "library.list_components": library_list_components,
    "library.lcsc_index": library_lcsc_index,
    "library.get_component": library_get_component,
    "library.rename_component": library_rename_component,
    "library.delete_component": library_delete_component,
    "library.move_component": library_move_component,
    "library.rename_library": library_rename_library,
    "library.update_metadata": library_update_metadata,
    "library.diff": library_diff,
    "library.replace_3d": library_replace_3d,
    "library.add_3d": library_add_3d,
    "library.get_3d_info": library_get_3d_info,
    "library.read_file_content": library_read_file_content,
    "library.set_3d_offset": library_set_3d_offset,
    "library.get_component_icon": library_get_component_icon,
    "library.backfill_icons": library_backfill_icons,
}
