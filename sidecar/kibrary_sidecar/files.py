"""Read raw KiCad part files from the staging directory.

Supported kinds:
  "sym" – <staging_dir>/<lcsc>/<lcsc>.kicad_sym
  "fp"  – first .kicad_mod found inside <staging_dir>/<lcsc>/<lcsc>.pretty/
  "3d"  – first .step (or .wrl) found inside <staging_dir>/<lcsc>/<lcsc>.3dshapes/
"""

from __future__ import annotations

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


def get_3d_info(
    staging_dir: Path | None = None,
    lcsc: str | None = None,
    *,
    lib_dir: Path | None = None,
    component_name: str | None = None,
) -> dict | None:
    """Return parsed 3D model info from a footprint's ``(model ...)`` block.

    Two calling conventions are supported:

    *Staging layout* (used by the Review room)::

        get_3d_info(staging_dir, lcsc)
        # footprint is at: <staging_dir>/<lcsc>/<lcsc>.pretty/<first .kicad_mod>

    *Library layout* (used by the Library room)::

        get_3d_info(lib_dir=lib_dir, component_name=component_name)
        # footprint is at: <lib_dir>/<lib_dir.name>.pretty/<component_name>.kicad_mod

    Returns a dict::

        {
            "model_path": "${KSL_ROOT}/lib/lib.3dshapes/file.step",
            "filename":   "file.step",
            "format":     "step",           # lower-case, without leading dot
            "offset":     [x, y, z],        # mm
            "rotation":   [x, y, z],        # degrees
            "scale":      [x, y, z],
        }

    Returns ``None`` when the footprint has no ``(model ...)`` block or when
    the footprint file cannot be found / parsed.
    """
    from kiutils.footprint import Footprint

    mod_path = _resolve_kicad_mod(staging_dir, lcsc, lib_dir, component_name)
    if mod_path is None or not mod_path.is_file():
        return None

    try:
        fp = Footprint().from_file(str(mod_path))
    except Exception:
        return None

    if not fp.models:
        return None

    model = fp.models[0]
    filename = Path(model.path.replace("\\", "/")).name
    fmt = Path(filename).suffix.lstrip(".").lower()

    return {
        "model_path": model.path,
        "filename": filename,
        "format": fmt,
        "offset": [model.pos.X, model.pos.Y, model.pos.Z],
        "rotation": [model.rotate.X, model.rotate.Y, model.rotate.Z],
        "scale": [model.scale.X, model.scale.Y, model.scale.Z],
    }


def _resolve_kicad_mod(
    staging_dir: Path | None,
    lcsc: str | None,
    lib_dir: Path | None,
    component_name: str | None,
) -> Path | None:
    """Resolve the path to the first ``.kicad_mod`` file.

    Handles both calling conventions for :func:`get_3d_info`.
    """
    if staging_dir is not None and lcsc is not None:
        pretty_dir = Path(staging_dir) / lcsc / f"{lcsc}.pretty"
        if not pretty_dir.is_dir():
            return None
        mods = sorted(pretty_dir.glob("*.kicad_mod"))
        return mods[0] if mods else None

    if lib_dir is not None and component_name is not None:
        lib_dir = Path(lib_dir)
        pretty_dir = lib_dir / f"{lib_dir.name}.pretty"
        mod_path = pretty_dir / f"{component_name}.kicad_mod"
        return mod_path if mod_path.is_file() else None

    return None


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
