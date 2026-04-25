"""lib_scanner.py — scan a KiCad workspace for libraries and component metadata.

Public API
----------
list_libraries(workspace)      → [{name, path, component_count, has_pretty, has_3dshapes}]
list_components(lib_dir)       → [{name, description, reference, value, footprint}]
get_component(lib_dir, name)   → {properties, footprint_path, model3d_path}
"""

from __future__ import annotations

from pathlib import Path

from kiutils.symbol import SymbolLib


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def list_libraries(workspace: Path) -> list[dict]:
    """Return a list of library descriptors found under *workspace*.

    A directory ``<workspace>/<name>/`` is considered a library when it
    contains a file named ``<name>.kicad_sym`` (i.e. the sym file has the
    same stem as the parent directory).

    Each descriptor is a dict with keys:
        name            (str)  — directory / library name
        path            (Path) — absolute path to the library directory
        component_count (int)  — number of top-level symbols in the .kicad_sym
        has_pretty      (bool) — whether a ``<name>.pretty`` sub-directory exists
        has_3dshapes    (bool) — whether a ``<name>.3dshapes`` sub-directory exists
    """
    results: list[dict] = []

    for entry in sorted(workspace.iterdir()):
        if not entry.is_dir():
            continue
        sym_file = entry / f"{entry.name}.kicad_sym"
        if not sym_file.is_file():
            continue

        try:
            lib = SymbolLib.from_file(str(sym_file))
            count = len(lib.symbols)
        except Exception:
            count = 0

        results.append(
            {
                "name": entry.name,
                "path": entry,
                "component_count": count,
                "has_pretty": (entry / f"{entry.name}.pretty").is_dir(),
                "has_3dshapes": (entry / f"{entry.name}.3dshapes").is_dir(),
            }
        )

    return results


def list_components(lib_dir: Path) -> list[dict]:
    """Return metadata for every symbol in the library at *lib_dir*.

    The ``<lib_dir.name>.kicad_sym`` file is read with kiutils.  Each symbol
    produces a dict with keys:
        name        (str) — symbol entryName
        description (str) — value of the "Description" property (empty string if absent)
        reference   (str) — value of the "Reference" property
        value       (str) — value of the "Value" property
        footprint   (str) — value of the "Footprint" property
    """
    sym_file = lib_dir / f"{lib_dir.name}.kicad_sym"
    lib = SymbolLib.from_file(str(sym_file))

    results: list[dict] = []
    for sym in lib.symbols:
        props = {p.key: p.value for p in sym.properties}
        results.append(
            {
                "name": sym.entryName,
                "description": props.get("Description", ""),
                "reference": props.get("Reference", ""),
                "value": props.get("Value", ""),
                "footprint": props.get("Footprint", ""),
            }
        )
    return results


def get_component(lib_dir: Path, component_name: str) -> dict:
    """Return full property dict and resolved file paths for *component_name*.

    Parameters
    ----------
    lib_dir:
        Path to the library directory (must contain ``<lib_dir.name>.kicad_sym``).
    component_name:
        The ``entryName`` of the symbol to look up.

    Returns
    -------
    dict with keys:
        properties     (dict[str, str]) — all symbol properties as key→value
        footprint_path (Path | None)    — path to the matching .kicad_mod file,
                                          or None if the .pretty dir / file is absent
        model3d_path   (Path | None)    — path to the first matching 3D model file
                                          (.step, .stp, .wrl, .glb), or None if absent

    Raises
    ------
    KeyError
        If no symbol with the given name exists in the library.
    """
    sym_file = lib_dir / f"{lib_dir.name}.kicad_sym"
    lib = SymbolLib.from_file(str(sym_file))

    # Find the target symbol (top-level symbols only; skip unit sub-symbols)
    symbol = None
    for sym in lib.symbols:
        if sym.entryName == component_name and sym.unitId is None:
            symbol = sym
            break

    if symbol is None:
        raise KeyError(
            f"Component {component_name!r} not found in library {lib_dir.name!r}"
        )

    properties = {p.key: p.value for p in symbol.properties}

    # Resolve footprint path
    footprint_path: Path | None = _find_footprint(lib_dir, component_name)

    # Resolve 3D model path
    model3d_path: Path | None = _find_3d_model(lib_dir, component_name)

    return {
        "properties": properties,
        "footprint_path": footprint_path,
        "model3d_path": model3d_path,
    }


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

_3D_EXTENSIONS = (".step", ".stp", ".wrl", ".glb")


def _find_footprint(lib_dir: Path, component_name: str) -> Path | None:
    """Return the .kicad_mod file for *component_name* inside the .pretty dir, or None."""
    pretty_dir = lib_dir / f"{lib_dir.name}.pretty"
    if not pretty_dir.is_dir():
        return None
    candidate = pretty_dir / f"{component_name}.kicad_mod"
    if candidate.is_file():
        return candidate
    # Fallback: search all .kicad_mod files in the .pretty dir
    for fp in pretty_dir.glob("*.kicad_mod"):
        if fp.stem == component_name:
            return fp
    return None


def _find_3d_model(lib_dir: Path, component_name: str) -> Path | None:
    """Return the first 3D model file for *component_name* inside .3dshapes, or None."""
    shapes_dir = lib_dir / f"{lib_dir.name}.3dshapes"
    if not shapes_dir.is_dir():
        return None
    for ext in _3D_EXTENSIONS:
        candidate = shapes_dir / f"{component_name}{ext}"
        if candidate.is_file():
            return candidate
    # Fallback: any supported extension with matching stem
    for f in shapes_dir.iterdir():
        if f.stem == component_name and f.suffix.lower() in _3D_EXTENSIONS:
            return f
    return None
