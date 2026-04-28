"""lib_scanner.py — scan a KiCad workspace for libraries and component metadata.

Public API
----------
list_libraries(workspace)      → [{name, path, component_count, has_pretty, has_3dshapes}]
list_components(lib_dir)       → [{name, description, reference, value, footprint}]
get_component(lib_dir, name)   → {properties, footprint_path, model3d_path}
lcsc_index(workspace)          → {lcsc: {library, component_name}} for "already in library" UI hint
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from kiutils.symbol import SymbolLib

log = logging.getLogger(__name__)

_LCSC_RE = re.compile(r"^C\d+$")


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
        # Skip unit sub-symbols (entries like `MyPart_0_1`, `MyPart_1_1`).
        # They share an entryName base with the parent and aren't renderable
        # via `kicad-cli sym export svg --symbol <name>` — kicad-cli expects
        # the top-level symbol. Including them in this list is what made the
        # alpha.18 renderer fail with "exit 1" when the user clicked one.
        if sym.unitId is not None:
            continue
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


def lcsc_index(workspace: Path) -> dict[str, dict]:
    """Return a flat map ``{lcsc: {library, component_name}}`` for every symbol
    in the workspace whose LCSC code can be determined.

    A symbol claims an LCSC code if **either**:
      - its ``entryName`` matches ``^C\\d+$`` (the kibrary-default after commit), OR
      - it has a property whose key is exactly ``"LCSC"`` and whose value
        matches ``^C\\d+$`` (covers parts the user renamed in LibPicker but
        whose JLC2KiCadLib-set ``LCSC`` property survives).

    Libraries are walked in alphabetical order (matching ``list_libraries``).
    On collision, the alphabetically-first library wins (stable across runs).

    Per-file errors (missing/corrupt ``.kicad_sym``) are logged and skipped;
    they never propagate up — the index is best-effort.
    """
    index: dict[str, dict] = {}

    for lib in list_libraries(workspace):
        lib_name = lib["name"]
        sym_file = lib["path"] / f"{lib_name}.kicad_sym"
        try:
            sym_lib = SymbolLib.from_file(str(sym_file))
        except Exception as exc:
            log.warning("lcsc_index: skipping unreadable %s: %s", sym_file, exc)
            continue

        for sym in sym_lib.symbols:
            # Skip unit sub-symbols — they share an entryName with the parent
            # and would silently dedupe via dict assignment, but being explicit
            # protects against future first-write-wins changes.
            if sym.unitId is not None:
                continue

            entry_name = sym.entryName
            lcsc: str | None = None

            if entry_name and _LCSC_RE.match(entry_name):
                lcsc = entry_name
            else:
                for prop in sym.properties:
                    if prop.key == "LCSC" and prop.value and _LCSC_RE.match(prop.value):
                        lcsc = prop.value
                        break

            if lcsc is None:
                continue

            # First-write-wins: alphabetically-first library claims the LCSC.
            if lcsc not in index:
                index[lcsc] = {
                    "library": lib_name,
                    "component_name": entry_name,
                }

    return index


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

_3D_EXTENSIONS = (".step", ".stp", ".wrl", ".glb")


def _find_footprint(lib_dir: Path, component_name: str) -> Path | None:
    """Return the .kicad_mod file backing *component_name*, or None.

    Resolves via the symbol's ``Footprint`` property when present —
    JLC2KiCadLib names symbols by MPN (e.g. ``0603WAF1002T5E``) but
    footprint files by package (e.g. ``R0603.kicad_mod``), so a literal
    ``<component_name>.kicad_mod`` lookup misses them.

    Resolution order:

    1. Symbol's ``Footprint`` property → ``<lib>:<fp_name>`` →
       ``<pretty>/<fp_name>.kicad_mod``  (correct path post-commit)
    2. ``<pretty>/<component_name>.kicad_mod``  (synthetic / hand-named)
    3. Any ``.kicad_mod`` whose stem equals ``component_name``
    4. Any ``.kicad_mod`` whose internal ``(footprint "X" …)`` /
       ``(module "X" …)`` header matches the Footprint property or symbol name.
       (Catches user-edited libs where the file was renamed but the
       internal header still has the original package name.)
    """
    pretty_dir = lib_dir / f"{lib_dir.name}.pretty"
    if not pretty_dir.is_dir():
        return None

    fp_name = _footprint_name_from_symbol(lib_dir, component_name)
    if fp_name:
        candidate = pretty_dir / f"{fp_name}.kicad_mod"
        if candidate.is_file():
            return candidate

    candidate = pretty_dir / f"{component_name}.kicad_mod"
    if candidate.is_file():
        return candidate

    for fp in pretty_dir.glob("*.kicad_mod"):
        if fp.stem == component_name:
            return fp

    # Last-resort: scan internal headers
    import re
    needle_set = {component_name}
    if fp_name:
        needle_set.add(fp_name)
    pattern = re.compile(r'\((?:footprint|module)\s+"([^"]+)"')
    for fp in pretty_dir.glob("*.kicad_mod"):
        try:
            head = fp.read_text(encoding="utf-8", errors="replace")[:2000]
        except OSError:
            continue
        m = pattern.search(head)
        if m and m.group(1) in needle_set:
            return fp

    return None


def _footprint_name_from_symbol(lib_dir: Path, component_name: str) -> str | None:
    """Return the footprint name from the symbol's ``Footprint`` property
    (stripped of the ``<library>:`` prefix), or None if absent / unreadable.
    """
    sym_file = lib_dir / f"{lib_dir.name}.kicad_sym"
    if not sym_file.is_file():
        return None
    try:
        sym_lib = SymbolLib.from_file(str(sym_file))
    except Exception:
        return None
    for sym in sym_lib.symbols:
        if sym.entryName == component_name and sym.unitId is None:
            for prop in sym.properties:
                if prop.key == "Footprint" and prop.value:
                    val = prop.value
                    return val.split(":", 1)[-1] if ":" in val else val
            return None
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
