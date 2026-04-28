from pathlib import Path

from kiutils.symbol import SymbolLib, Property


def read_properties(path: Path) -> dict[str, str]:
    """Return a dict of property key→value for the first symbol in a .kicad_sym file."""
    lib = SymbolLib().from_file(str(path))
    if not lib.symbols:
        return {}
    sym = lib.symbols[0]
    return {p.key: p.value for p in sym.properties}


def write_properties(path: Path, edits: dict[str, str]) -> None:
    """Update (or add) properties on the first symbol in a .kicad_sym file, then save."""
    lib = SymbolLib().from_file(str(path))
    if not lib.symbols:
        return
    sym = lib.symbols[0]
    by_key = {p.key: p for p in sym.properties}
    for k, v in edits.items():
        if k in by_key:
            by_key[k].value = v
        else:
            sym.properties.append(Property(key=k, value=v))
    lib.to_file(str(path))


def read_properties_named(path: Path, component_name: str) -> dict[str, str]:
    """Return key→value for the symbol named *component_name* in a multi-symbol
    library file. Skips unit sub-symbols. Returns {} if the symbol is missing.
    """
    lib = SymbolLib().from_file(str(path))
    for sym in lib.symbols:
        if sym.entryName == component_name and sym.unitId is None:
            return {p.key: p.value for p in sym.properties}
    return {}


def write_properties_named(
    path: Path, component_name: str, edits: dict[str, str]
) -> None:
    """Update (or add) properties on the symbol named *component_name* in a
    multi-symbol library file, then save. No-op if the symbol is missing.
    """
    lib = SymbolLib().from_file(str(path))
    target = None
    for sym in lib.symbols:
        if sym.entryName == component_name and sym.unitId is None:
            target = sym
            break
    if target is None:
        return
    by_key = {p.key: p for p in target.properties}
    for k, v in edits.items():
        if k in by_key:
            by_key[k].value = v
        else:
            target.properties.append(Property(key=k, value=v))
    lib.to_file(str(path))
