"""model3d_ops.py — 3D model replace/add operations for KiCad libraries.

Task P13 (P2 plan, Phase 2C — External STEP browse/replace).

Supported 3D model formats: .step, .stp, .wrl, .glb
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path

from kiutils.footprint import Footprint, Model

# The ${KSL_ROOT} environment-variable convention used for 3D model paths.
_KSL_ROOT = "${KSL_ROOT}"

# Extensions we accept as 3D model sources.
_SUPPORTED_EXTS = frozenset({".step", ".stp", ".wrl", ".glb"})


# ---------------------------------------------------------------------------
# Robust (model …) block reader/writer — bypasses kiutils for the
# offset/rotate/scale round-trip.
#
# Why bypass kiutils:
#
# * ``kiutils.Footprint.from_file`` ultimately calls
#   ``kiutils.footprint.Model.from_sexpr`` which ASSERTS ``len(exp) >= 5``
#   (path + 3 sub-S-exprs). KiCad accepts ``(model PATH (offset …))``
#   alone, ``(model PATH (scale …) (rotate …))``, or any other partial
#   combination — kiutils refuses to parse them. The user-reported bug
#   "values not saved correctly when 3D view reloads" reproduces here:
#   on a legacy / SnapEDA footprint missing one of the sub-blocks,
#   ``set_3d_offset`` raises and the dial state then drifts out of sync
#   with the on-disk values.
#
# * ``kiutils.Footprint.to_file`` rewrites the ENTIRE footprint —
#   destroying UUIDs, embedded_fonts, generator_version, multi-line
#   formatting etc. We only want to rewrite the (offset/scale/rotate)
#   sub-S-exprs inside the FIRST (model …) block.
#
# These helpers locate the first ``(model …)`` block by paren-depth scan,
# then read or rewrite the three sub-S-exprs in place. Missing sub-S-exprs
# are inserted (write side) or default to (0,0,0)/(1,1,1) (read side).
# ---------------------------------------------------------------------------


_MODEL_OPEN_RE = re.compile(r'\(model\b', re.IGNORECASE)
_MODEL_PATH_RE = re.compile(
    r'\(model\s+("[^"]+"|[^\s\(\)]+)',
    flags=re.IGNORECASE,
)
# Capture the X/Y/Z numbers from a (offset|scale|rotate) sub-S-expr. Both
# the inline form ``(offset (xyz 1 2 3))`` and KiCad's multi-line form
# (``(offset\n\t(xyz 1 2 3)\n)``) are matched; ``\s+`` straddles newlines.
_XYZ_NUM = r"-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?"
_OFFSET_RE = re.compile(
    rf"\(offset\s+\(xyz\s+({_XYZ_NUM})\s+({_XYZ_NUM})\s+({_XYZ_NUM})\s*\)\s*\)",
    re.IGNORECASE,
)
_SCALE_RE = re.compile(
    rf"\(scale\s+\(xyz\s+({_XYZ_NUM})\s+({_XYZ_NUM})\s+({_XYZ_NUM})\s*\)\s*\)",
    re.IGNORECASE,
)
_ROTATE_RE = re.compile(
    rf"\(rotate\s+\(xyz\s+({_XYZ_NUM})\s+({_XYZ_NUM})\s+({_XYZ_NUM})\s*\)\s*\)",
    re.IGNORECASE,
)


Triple = tuple[float, float, float]


def _find_first_model_block(text: str) -> tuple[int, int] | None:
    """Locate the first ``(model …)`` block in *text* and return
    ``(start_idx, end_idx)`` (half-open, end is the index AFTER the
    matching close paren). Returns ``None`` when no block is present."""
    m = _MODEL_OPEN_RE.search(text)
    if m is None:
        return None
    start = m.start()
    depth = 0
    for i in range(start, len(text)):
        ch = text[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return start, i + 1
    return None  # unbalanced — caller treats as no block


def read_model_transform(
    text: str,
) -> tuple[str, Triple, Triple, Triple] | None:
    """Read the first ``(model …)`` block's path + offset/rotate/scale.

    Returns ``(path, offset, rotation, scale)`` or ``None`` when no model
    block exists. Missing sub-S-exprs default to ``(0, 0, 0)`` for offset
    and rotation, ``(1, 1, 1)`` for scale — matching KiCad's interpretation
    of the omitted form.

    Path is returned with surrounding quotes stripped if quoted.
    """
    span = _find_first_model_block(text)
    if span is None:
        return None
    block = text[span[0]:span[1]]

    pm = _MODEL_PATH_RE.match(block)
    if pm is None:
        return None
    raw_path = pm.group(1)
    path = raw_path[1:-1] if raw_path.startswith('"') else raw_path

    def _parse(rx: re.Pattern, default: Triple) -> Triple:
        m = rx.search(block)
        if m is None:
            return default
        return (float(m.group(1)), float(m.group(2)), float(m.group(3)))

    offset = _parse(_OFFSET_RE, (0.0, 0.0, 0.0))
    rotation = _parse(_ROTATE_RE, (0.0, 0.0, 0.0))
    scale = _parse(_SCALE_RE, (1.0, 1.0, 1.0))
    return path, offset, rotation, scale


def write_model_transform(
    text: str,
    offset: Triple,
    rotation: Triple,
    scale: Triple,
) -> str:
    """Rewrite the first ``(model …)`` block's offset/rotate/scale.

    Each sub-S-expr is replaced if present, inserted otherwise — the
    write is therefore tolerant of the legacy/SnapEDA shapes that omit
    one or more of (offset/scale/rotate). The model path and any other
    sub-S-exprs (``(opacity …)``, ``hide`` flag, ``(name …)`` etc.) are
    preserved. Indentation of inserted blocks mirrors the closest existing
    sub-S-expr's indent, falling back to a single tab so kicad-cli's
    tokenizer doesn't see an inconsistent layout.
    """
    span = _find_first_model_block(text)
    if span is None:
        return text
    start, end = span
    block = text[start:end]

    # Determine the indent used for sub-S-exprs in this block — pick
    # the indent of the first sub-S-expr after the path, falling back
    # to a single tab. This keeps re-emitted blocks visually consistent
    # with the source file's existing style (KiCad emits multi-line
    # tabs; some hand-written files use 2 spaces).
    indent_match = re.search(r"\n([\t ]+)\(", block)
    indent = indent_match.group(1) if indent_match else "\t\t"

    def _make(name: str, vals: Triple) -> str:
        return f"({name} (xyz {vals[0]} {vals[1]} {vals[2]}))"

    def _replace_or_insert(
        block_text: str, rx: re.Pattern, name: str, vals: Triple,
    ) -> str:
        new_clause = _make(name, vals)
        if rx.search(block_text):
            return rx.sub(new_clause, block_text, count=1)
        # Insert immediately before the closing ')' of the (model …) block.
        # Preserve a trailing newline + indent to keep the close paren on
        # its own line (KiCad-canonical layout).
        # Find the rightmost ')' (the close of the model block).
        rstrip = block_text.rstrip()
        if rstrip.endswith(")"):
            inner = rstrip[:-1].rstrip("\n").rstrip(" \t")
            tail = block_text[len(rstrip):]
            return f"{inner}\n{indent}{new_clause}\n{indent[:-1] or ''})" + tail
        return block_text  # malformed — skip insertion silently

    # Rotate is replaced/inserted last so its insertion sits AFTER offset
    # and scale (the KiCad-canonical order is offset / scale / rotate).
    block = _replace_or_insert(block, _OFFSET_RE, "offset", offset)
    block = _replace_or_insert(block, _SCALE_RE, "scale", scale)
    block = _replace_or_insert(block, _ROTATE_RE, "rotate", rotation)
    return text[:start] + block + text[end:]


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

    Uses an in-place regex rewrite (see :func:`write_model_transform`) so
    the rest of the footprint S-expression — UUIDs, embedded_fonts, layer
    aliases, multi-line formatting — is preserved verbatim. Tolerates
    legacy / SnapEDA model blocks that omit one or more of
    ``(offset)``/``(scale)``/``(rotate)``.

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

    text = mod_path.read_text(encoding="utf-8")
    if _find_first_model_block(text) is None:
        raise ValueError(f"no 3D model block in {mod_path}")
    new_text = write_model_transform(text, offset, rotation, scale)
    mod_path.write_text(new_text, encoding="utf-8")


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
