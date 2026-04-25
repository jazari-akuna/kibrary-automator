"""S-expression diff preview module (Task P3).

Compares two .kicad_sym file contents and returns a structured list of changes
at the symbol and property level.
"""

from __future__ import annotations

import tempfile
import os
from typing import Any

from kiutils.symbol import SymbolLib


def _parse(content: str) -> SymbolLib:
    """Parse a .kicad_sym content string into a SymbolLib by writing to a temp file."""
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".kicad_sym", delete=False, encoding="utf-8"
    ) as fh:
        fh.write(content)
        tmp_path = fh.name
    try:
        lib = SymbolLib.from_file(tmp_path)
    finally:
        os.unlink(tmp_path)
    return lib


def _symbol_map(lib: SymbolLib) -> dict[str, dict[str, str]]:
    """Build {symbol_name: {property_key: property_value}} for every top-level symbol."""
    result: dict[str, dict[str, str]] = {}
    for sym in lib.symbols:
        # Only index top-level symbols (unitId is None for top-level)
        if sym.unitId is not None:
            continue
        name = sym.entryName
        result[name] = {p.key: p.value for p in sym.properties}
    return result


def diff_kicad_sym(before: str, after: str) -> list[dict]:
    """Return a list of changes between two .kicad_sym file contents.

    Each entry:
        {type: 'added'|'removed'|'modified', path: str, before?: str, after?: str}

    ``path`` is a dotted path into the s-expression structure, e.g.:
        'symbol[R_10k_0402]'                         (whole-symbol addition/removal)
        'symbol[R_10k_0402].property[Description]'   (property-level change)

    Returns an empty list when before == after (fast-path shortcut) or when the
    parsed structures are semantically identical.
    """
    if before == after:
        return []

    lib_before = _parse(before)
    lib_after = _parse(after)

    map_before = _symbol_map(lib_before)
    map_after = _symbol_map(lib_after)

    changes: list[dict] = []

    # Symbol-level additions and removals
    added_symbols = set(map_after) - set(map_before)
    removed_symbols = set(map_before) - set(map_after)

    for name in added_symbols:
        changes.append(
            {"type": "added", "path": f"symbol[{name}]"}
        )

    for name in removed_symbols:
        changes.append(
            {"type": "removed", "path": f"symbol[{name}]"}
        )

    # Property-level diffs for symbols present in both versions
    common_symbols = set(map_before) & set(map_after)
    for name in sorted(common_symbols):
        props_before = map_before[name]
        props_after = map_after[name]

        added_props = set(props_after) - set(props_before)
        removed_props = set(props_before) - set(props_after)
        common_props = set(props_before) & set(props_after)

        for key in sorted(added_props):
            changes.append(
                {
                    "type": "added",
                    "path": f"symbol[{name}].property[{key}]",
                    "after": props_after[key],
                }
            )

        for key in sorted(removed_props):
            changes.append(
                {
                    "type": "removed",
                    "path": f"symbol[{name}].property[{key}]",
                    "before": props_before[key],
                }
            )

        for key in sorted(common_props):
            v_before = props_before[key]
            v_after = props_after[key]
            if v_before != v_after:
                changes.append(
                    {
                        "type": "modified",
                        "path": f"symbol[{name}].property[{key}]",
                        "before": v_before,
                        "after": v_after,
                    }
                )

    return changes
