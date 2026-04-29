"""model3d_ops.py — 3D model replace/add operations for KiCad libraries.

Task P13 (P2 plan, Phase 2C — External STEP browse/replace).

Supported 3D model formats: .step, .stp, .wrl, .glb
"""
from __future__ import annotations

import shutil
from pathlib import Path

from kiutils.footprint import Footprint, Model

# The ${KSL_ROOT} environment-variable convention used for 3D model paths.
_KSL_ROOT = "${KSL_ROOT}"

# Extensions we accept as 3D model sources.
_SUPPORTED_EXTS = frozenset({".step", ".stp", ".wrl", ".glb"})


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def replace_3d_model(lib_dir: Path, component_name: str, new_step_path: Path) -> Path:
    """Copy *new_step_path* into *lib_dir*'s ``.3dshapes/`` folder, named
    ``<component_name>.<original_ext>`` (e.g. component ``R_10k_0402`` + a
    ``.step`` source → ``R_10k_0402.step`` inside the 3dshapes folder).

    Replaces any existing 3D model for this component (different extensions
    mapped to same component get cleaned up — if ``R_10k_0402.wrl`` existed
    and we're replacing with ``.step``, delete the ``.wrl`` too).

    Updates the matching ``.kicad_mod`` file's ``(model ...)`` line to point
    at the new path using the ``${KSL_ROOT}`` convention.  If no
    ``(model ...)`` block exists, one is added with default
    offset/rotation/scale.

    Returns the destination path.

    Raises
    ------
    FileNotFoundError
        If *new_step_path* does not exist, or if *lib_dir* does not exist.
    ValueError
        If the source file's extension is not in the supported set
        (``.step``, ``.stp``, ``.wrl``, ``.glb``).
    """
    _validate_inputs(lib_dir, new_step_path)

    ext = new_step_path.suffix.lower()
    lib_name = lib_dir.name

    # Ensure 3dshapes directory exists.
    shapes_dir = lib_dir / f"{lib_name}.3dshapes"
    shapes_dir.mkdir(exist_ok=True)

    # Remove any existing 3D model files for this component (any extension).
    _remove_existing_models(shapes_dir, component_name)

    # Copy the new source file to the destination.
    dst = shapes_dir / f"{component_name}{ext}"
    shutil.copy2(str(new_step_path), dst)

    # Update the .kicad_mod model path.
    _update_kicad_mod(lib_dir, lib_name, component_name, ext)

    return dst


def set_3d_offset(
    lib_dir: Path,
    component_name: str,
    offset: tuple[float, float, float],
    rotation: tuple[float, float, float],
    scale: tuple[float, float, float],
) -> None:
    """Update the offset / rotation / scale of the first ``(model ...)``
    block in the component's ``.kicad_mod``.

    Library layout (committed):
        <lib_dir>/<lib_name>.pretty/<component>.kicad_mod

    Raises
    ------
    FileNotFoundError
        If the ``.kicad_mod`` file does not exist.
    ValueError
        If the footprint has no ``(model ...)`` block to update.
    """
    # Resolve the footprint via _find_footprint, which honours the symbol's
    # Footprint property (`<lib>:<fp_name>`) — JLC2KiCadLib names the symbol
    # by MPN but the .kicad_mod by package, so a literal `<symbol>.kicad_mod`
    # lookup misses (the user-reported alpha.23 3D rerender regression).
    from kibrary_sidecar import lib_scanner
    mod_path = lib_scanner._find_footprint(lib_dir, component_name)  # type: ignore[attr-defined]
    if mod_path is None:
        # Fall back to the literal name, then surface an informative error.
        pretty = lib_dir / f"{lib_dir.name}.pretty"
        candidate = pretty / f"{component_name}.kicad_mod"
        if not candidate.exists():
            raise FileNotFoundError(
                f"set_3d_offset: no .kicad_mod for symbol {component_name!r} "
                f"in {lib_dir} (looked for both Footprint-property match "
                f"and {candidate.name})"
            )
        mod_path = candidate

    fp = Footprint().from_file(str(mod_path))
    if not fp.models:
        raise ValueError(f"no 3D model block in {mod_path}")

    m = fp.models[0]
    m.pos.X, m.pos.Y, m.pos.Z = offset
    m.rotate.X, m.rotate.Y, m.rotate.Z = rotation
    m.scale.X, m.scale.Y, m.scale.Z = scale
    fp.to_file(str(mod_path))


def add_3d_model(lib_dir: Path, component_name: str, src_path: Path) -> Path:
    """Same as :func:`replace_3d_model`, but intended for a component that
    previously had no 3D model.  Functionally identical — provided as a
    separate name for caller clarity.

    Returns the destination path.
    """
    return replace_3d_model(lib_dir, component_name, src_path)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _validate_inputs(lib_dir: Path, src_path: Path) -> None:
    """Validate both paths and the source extension."""
    if not lib_dir.exists():
        raise FileNotFoundError(f"Library directory not found: {lib_dir}")

    if not src_path.exists():
        raise FileNotFoundError(f"Source 3D model file not found: {src_path}")

    ext = src_path.suffix.lower()
    if ext not in _SUPPORTED_EXTS:
        raise ValueError(
            f"Unsupported 3D model extension {ext!r}. "
            f"Supported extensions: {sorted(_SUPPORTED_EXTS)}"
        )


def _remove_existing_models(shapes_dir: Path, component_name: str) -> None:
    """Delete all files named ``<component_name>.<any-ext>`` in *shapes_dir*."""
    for existing in shapes_dir.glob(f"{component_name}.*"):
        existing.unlink()


def _update_kicad_mod(
    lib_dir: Path,
    lib_name: str,
    component_name: str,
    ext: str,
) -> None:
    """Update (or add) the ``(model ...)`` entry in the component's
    ``.kicad_mod`` file to use the ``${KSL_ROOT}`` convention.
    """
    # Honour Footprint-property ↔ file-stem mismatch (JLC2KiCadLib MPN
    # symbol vs package-named .kicad_mod) — same fallback as set_3d_offset.
    from kibrary_sidecar import lib_scanner
    mod_path = lib_scanner._find_footprint(lib_dir, component_name)  # type: ignore[attr-defined]
    if mod_path is None:
        pretty_dir = lib_dir / f"{lib_name}.pretty"
        candidate = pretty_dir / f"{component_name}.kicad_mod"
        if not candidate.exists():
            # Nothing to update — silently skip.
            return
        mod_path = candidate

    new_model_path = (
        f"{_KSL_ROOT}/{lib_name}/{lib_name}.3dshapes/{component_name}{ext}"
    )

    try:
        fp = Footprint().from_file(str(mod_path))
        if fp.models:
            # Update the first model entry (the one for this component).
            fp.models[0].path = new_model_path
        else:
            # No model block — add one with default offset/rotation/scale.
            fp.models.append(Model(path=new_model_path))
        fp.to_file(str(mod_path))
    except Exception:
        # Fallback: regex-based line rewrite for files kiutils cannot parse.
        _regex_set_model_path(mod_path, new_model_path)


def _regex_set_model_path(mod_path: Path, new_model_path: str) -> None:
    """Regex fallback: replace or append the ``(model ...)`` line."""
    import re

    content = mod_path.read_text()

    model_block = (
        f"  (model {new_model_path}\n"
        f"    (offset (xyz 0 0 0))\n"
        f"    (scale (xyz 1 1 1))\n"
        f"    (rotate (xyz 0 0 0))\n"
        f"  )\n"
    )

    # If a (model ...) block already exists, replace it.
    pattern = re.compile(
        r'\s*\(model\b.*?(?=\n\s*\(|\Z)',
        re.DOTALL,
    )
    if re.search(r'\(model\b', content):
        content = pattern.sub("\n" + model_block.rstrip(), content, count=1)
    else:
        # Append before the closing paren of the footprint.
        content = content.rstrip().rstrip(")").rstrip() + "\n" + model_block + ")\n"

    mod_path.write_text(content)
