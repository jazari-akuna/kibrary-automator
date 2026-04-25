"""Read raw KiCad part files from the staging directory.

Supported kinds:
  "sym" – <staging_dir>/<lcsc>/<lcsc>.kicad_sym
  "fp"  – first .kicad_mod found inside <staging_dir>/<lcsc>/<lcsc>.pretty/
  "3d"  – first .step (or .wrl) found inside <staging_dir>/<lcsc>/<lcsc>.3dshapes/
"""

from pathlib import Path


def read_part_file(staging_dir: Path, lcsc: str, kind: str) -> str:
    """Return the text content of the requested KiCad part file.

    Parameters
    ----------
    staging_dir:
        Root staging directory (the parent that contains per-LCSC folders).
    lcsc:
        LCSC part number, e.g. ``"C25804"``.
    kind:
        ``"sym"``, ``"fp"``, or ``"3d"``.

    Returns
    -------
    str
        The UTF-8 text content of the file.

    Raises
    ------
    FileNotFoundError
        If the expected file (or directory) does not exist.
    ValueError
        If *kind* is not one of the supported values.
    """
    part_dir = Path(staging_dir) / lcsc

    if kind == "sym":
        path = part_dir / f"{lcsc}.kicad_sym"
        if not path.is_file():
            raise FileNotFoundError(f"Symbol file not found: {path}")
        return path.read_text(encoding="utf-8")

    if kind == "fp":
        pretty_dir = part_dir / f"{lcsc}.pretty"
        if not pretty_dir.is_dir():
            raise FileNotFoundError(f"Footprint directory not found: {pretty_dir}")
        mods = sorted(pretty_dir.glob("*.kicad_mod"))
        if not mods:
            raise FileNotFoundError(
                f"No .kicad_mod files found in: {pretty_dir}"
            )
        return mods[0].read_text(encoding="utf-8")

    if kind == "3d":
        shapes_dir = part_dir / f"{lcsc}.3dshapes"
        if not shapes_dir.is_dir():
            raise FileNotFoundError(f"3D shapes directory not found: {shapes_dir}")
        # Prefer STEP, fall back to WRL
        for ext in ("*.step", "*.stp", "*.wrl"):
            hits = sorted(shapes_dir.glob(ext))
            if hits:
                return hits[0].read_text(encoding="utf-8")
        raise FileNotFoundError(f"No 3D model files found in: {shapes_dir}")

    raise ValueError(f"Unsupported kind {kind!r}; expected 'sym', 'fp', or '3d'")


def list_part_dir(staging_dir: Path, lcsc: str, subdir: str = "") -> list[str]:
    """List filenames in a staged part's directory (or a sub-directory of it).

    Used by the 3D preview block to discover which model file is present
    before reading it.

    Parameters
    ----------
    staging_dir:
        Root staging directory.
    lcsc:
        LCSC part number.
    subdir:
        Optional sub-directory inside the part folder (e.g. ``"C25804.3dshapes"``).
        Empty string lists the part folder itself.

    Returns
    -------
    list[str]
        Sorted list of filenames (no path components). Empty if the directory
        does not exist — callers usually treat that as "no model available."
    """
    target = Path(staging_dir) / lcsc
    if subdir:
        target = target / subdir
    if not target.is_dir():
        return []
    return sorted(p.name for p in target.iterdir() if p.is_file())
