import json
import shutil
from pathlib import Path


def _path(staging_part: Path) -> Path:
    return staging_part / "meta.json"


def write_meta(staging_part: Path, meta: dict) -> None:
    staging_part.mkdir(parents=True, exist_ok=True)
    _path(staging_part).write_text(json.dumps(meta, indent=2))


def read_meta(staging_part: Path) -> dict | None:
    p = _path(staging_part)
    if not p.is_file():
        return None
    return json.loads(p.read_text())


def delete_staged(staging_part: Path) -> bool:
    """Remove a staged part directory and everything in it.

    Returns True if the directory existed and was removed, False if it
    was already absent (idempotent — safe to call after a manual cleanup).
    """
    if not staging_part.is_dir():
        return False
    shutil.rmtree(staging_part)
    return True


def footprint_name(staging_part: Path) -> str | None:
    """Return the stem of the first .kicad_mod file in the part's .pretty
    directory (the footprint identifier JLC2KiCadLib produced for this
    part). Used by ReviewBulkAssign so the user can see WHICH footprint
    they're about to commit. None if no .pretty dir or no .kicad_mod
    inside it.
    """
    lcsc = staging_part.name
    pretty = staging_part / f"{lcsc}.pretty"
    if not pretty.is_dir():
        return None
    for fp in sorted(pretty.glob("*.kicad_mod")):
        return fp.stem
    return None
