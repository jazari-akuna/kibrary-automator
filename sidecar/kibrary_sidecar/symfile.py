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
