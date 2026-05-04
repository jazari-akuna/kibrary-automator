"""render_3d.py — Render a single KiCad footprint as a 3D PNG via kicad-cli.

Used by the 3D card in the Library view to produce an inline preview of
the part with its STEP model loaded.

Pipeline
--------
``kicad-cli pcb render`` is the only kicad-cli sub-command that emits a
3D PNG, but it requires a fully-formed ``.kicad_pcb`` (just feeding it a
``.kicad_mod`` doesn't work). To keep the call site simple, this module:

1. Sanitises the ``.kicad_mod`` so kicad-cli's pcb loader will accept it
   when embedded in a board:

   * Legacy layer aliases such as ``User.Comments`` → ``Cmts.User`` (in
     both bare and quoted forms). Without this, ``kicad-cli fp upgrade``
     and the pcb loader rescue them to the literal ``"Rescue"`` layer,
     which the pcb loader then rejects with "Failed to load board".
   * ``(model …)`` paths are rewritten to absolute filesystem paths,
     resolving ``${KSL_ROOT}`` (committed-library form) or treating bare
     ``./foo.step`` as a staging-form sibling of the .pretty.

2. Splices the sanitised footprint S-expression directly into a static
   empty-board template (just before the closing ``)`` of the
   ``(kicad_pcb …)`` form). This avoids a separate pcbnew Python dep,
   which previously had to shell out to ``python3 -c`` because pcbnew
   isn't pip-installable, and which had a Pgm()-not-initialised
   assertion path that produced boards kicad-cli couldn't load.

3. Runs ``kicad-cli pcb render`` against the spliced board.

LD_LIBRARY_PATH handling mirrors :mod:`svg_render` — see its module
docstring for the PyInstaller leak it works around.
"""
from __future__ import annotations

import logging
import os
import platform
import re
import subprocess
import tempfile
from pathlib import Path

from kibrary_sidecar.svg_render import _system_env

log = logging.getLogger(__name__)


def render_footprint_3d_png(
    lib_dir: Path,
    footprint_file: Path,
    output_png: Path,
    *,
    side: str = "top",
    width: int = 600,
    height: int = 400,
) -> None:
    """Render a footprint's 3D view to PNG via ``kicad-cli pcb render``.

    Parameters
    ----------
    lib_dir:
        The committed library directory (e.g. ``<workspace>/Connector_KSL``)
        OR a staging part directory (e.g. ``.../staging/C2950``). In both
        layouts the .3dshapes/ sits alongside the .pretty/.
    footprint_file:
        Path to the ``.kicad_mod`` file to render.
    output_png:
        Destination for the rendered PNG. Parent dir is created if needed.
    side:
        ``"top"`` for an isometric top view (the default — uses kicad-cli's
        ``--rotate`` for a slight tilt so 3D bodies are visible above the
        PCB). Pass ``"flat"`` for a strict orthographic top-down render
        (no rotate). Other values pass straight through to kicad-cli.
    width, height:
        Image dimensions in pixels.

    Raises
    ------
    RuntimeError
        kicad-cli exited non-zero (the stderr is included in the message).
    FileNotFoundError
        kicad-cli produced no PNG at the expected path.
    """
    if not footprint_file.is_file():
        raise FileNotFoundError(
            f"render_footprint_3d_png: footprint file not found: {footprint_file}"
        )

    output_png.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp_dir_str:
        tmp_dir = Path(tmp_dir_str)
        # 1. Sanitise + splice into the empty-board template.
        sanitised = _sanitise_footprint(footprint_file, lib_dir)
        board_path = tmp_dir / "preview.kicad_pcb"
        board_path.write_text(_splice_into_template(sanitised), encoding="utf-8")

        fp_name = footprint_file.stem

        # 2. Render.
        cmd = [
            "kicad-cli",
            "pcb",
            "render",
            "--output", str(output_png),
            "--width", str(width),
            "--height", str(height),
            "--quality", "basic",
        ]
        if side == "flat":
            cmd += ["--side", "top"]
        elif side == "top":
            # Isometric-ish top — slight tilt so 3D bodies are visible
            # above the PCB. Matches eeschema's default 3D view angle.
            cmd += [
                "--side", "top",
                "--rotate", "-25,0,-25",
                "--perspective",
            ]
        else:
            cmd += ["--side", side]

        cmd.append(str(board_path))

        log.debug("Rendering 3D PNG: %s", " ".join(cmd))
        proc = subprocess.run(cmd, capture_output=True, text=True, env=_system_env())
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "").strip()
            raise RuntimeError(
                f"kicad-cli pcb render failed (exit {proc.returncode}) "
                f"for footprint {fp_name!r}: {err}"
            )

        if not output_png.is_file():
            raise FileNotFoundError(
                f"kicad-cli produced no PNG at {output_png} "
                f"for footprint {fp_name!r}"
            )


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------

# Regex for any (model "..." …) or (model ./foo.step …) form, capturing the
# path argument in group(2). The path may be quoted or bare (no whitespace).
_MODEL_PATH_RE = re.compile(
    r'(\(model\s+)("[^"]+"|[^\s\(\)]+)',
    flags=re.IGNORECASE,
)

# Legacy layer aliases. ``kicad-cli fp upgrade`` and the pcb loader rescue
# unknown-by-canonical-name layers to the literal ``"Rescue"`` layer, which
# the pcb loader then refuses to render. JLC2KiCadLib emits the legacy
# aliases (e.g. ``"User.Comments"``) in both bare and quoted form, so we
# rewrite both shapes back to the canonical name before splice.
_LAYER_ALIASES = {
    "User.Comments": "Cmts.User",
    "User.Drawings": "Dwgs.User",
    "User.Eco1":     "Eco1.User",
    "User.Eco2":     "Eco2.User",
}


def _sanitise_footprint(
    footprint_file: Path,
    lib_dir: Path,
    *,
    override_offset: tuple[float, float, float] | None = None,
    override_rotation: tuple[float, float, float] | None = None,
    override_scale: tuple[float, float, float] | None = None,
) -> str:
    """Read the .kicad_mod and return a string ready to splice into a board.

    Thin wrapper over :func:`_sanitise_footprint_with_warnings` for callers
    that don't care about diagnostic warnings (e.g. the PNG path, which
    has no structured-error channel back to the frontend).
    """
    text, _warnings = _sanitise_footprint_with_warnings(
        footprint_file,
        lib_dir,
        override_offset=override_offset,
        override_rotation=override_rotation,
        override_scale=override_scale,
    )
    return text


def _sanitise_footprint_with_warnings(
    footprint_file: Path,
    lib_dir: Path,
    *,
    override_offset: tuple[float, float, float] | None = None,
    override_rotation: tuple[float, float, float] | None = None,
    override_scale: tuple[float, float, float] | None = None,
) -> tuple[str, list[dict]]:
    """Read the .kicad_mod and return ``(text, warnings)``.

    * Legacy layer aliases (bare and quoted) → canonical name.
    * ``(model …)`` paths → absolute filesystem paths (``${KSL_ROOT}``
      expanded, ``./foo.step`` resolved against ``lib_dir/*.3dshapes``).
    * For ``(model …)`` blocks WITHOUT an ``(offset …)`` sub-S-expr, an
      auto-offset is computed (STEP body bbox centred over pad bbox
      centre) and injected into the block in-memory. Mirrors the logic
      ``drop_import.compute_step_pad_offset`` runs at commit time, but
      applies to legacy footprints committed before that machinery
      existed (the "chip body sits on its side / off-centre" case from
      the user report). Surfaces as ``{"kind": "auto_offset_applied",
      "model_path": …, "offset": [x, y, z]}`` in the warnings list.
    * Optional offset/rotation/scale overrides — when ALL three are
      provided, the first ``(model …)`` block's transform sub-S-exprs are
      rewritten in-memory. Used by the live-preview renderer so the user
      can drag values around without writing to disk on every tick.

    Each warning is a dict describing a (model …) resolution event the
    user might want to see — currently:

    * ``{"kind": "model_not_found", "token": <raw>, "expanded": <str>,
       "basename": <str>, "sibling_match": <str|None>, "lib_dir": <str>}``
      — the (model …) block was stripped because the .step couldn't be
      located. ``sibling_match`` is set when the same basename exists in
      a sibling library's ``.3dshapes/`` (likely mis-targeted commit).
    * ``{"kind": "auto_offset_applied", "model_path": <str>,
       "offset": [x, y, z]}`` — the block had no ``(offset …)`` so a
      pad-centre-on-body-centre offset was injected in-memory.
    """
    text = footprint_file.read_text(encoding="utf-8")
    for alias, canonical in _LAYER_ALIASES.items():
        text = re.sub(
            rf'\(layer\s+{re.escape(alias)}\)',
            f'(layer "{canonical}")',
            text,
        )
        text = re.sub(
            rf'\(layer\s+"{re.escape(alias)}"\)',
            f'(layer "{canonical}")',
            text,
        )
    text, warnings = _rewrite_or_strip_model_blocks_with_warnings(
        text, lib_dir, footprint_file=footprint_file
    )
    if (
        override_offset is not None
        and override_rotation is not None
        and override_scale is not None
    ):
        text = _patch_model_transform(
            text, override_offset, override_rotation, override_scale
        )
    return text, warnings


def _rewrite_or_strip_model_blocks(text: str, lib_dir: Path) -> str:
    """Backward-compatible wrapper that drops the warnings list.

    Prefer :func:`_rewrite_or_strip_model_blocks_with_warnings` in new
    code — the structured warnings let the JSON-RPC layer surface a
    "model file not found" diagnostic to the frontend instead of
    silently emitting a board-only GLB.
    """
    new_text, _ = _rewrite_or_strip_model_blocks_with_warnings(text, lib_dir)
    return new_text


def _rewrite_or_strip_model_blocks_with_warnings(
    text: str, lib_dir: Path, *, footprint_file: Path | None = None,
) -> tuple[str, list[dict]]:
    """Rewrite each ``(model …)`` path to absolute, OR strip the whole
    block when the resolved path doesn't exist on disk.

    Returns ``(new_text, warnings)`` where each warning is a structured
    dict the call site (and ultimately the JSON-RPC response) can use to
    tell the user why their 3D body is missing.

    When ``footprint_file`` is supplied AND a ``(model …)`` block lacks
    an ``(offset …)`` sub-S-expr, an auto-offset is computed (STEP body
    bbox centred over the footprint pad bbox) and injected in-memory.
    This fixes legacy footprints whose authors omitted the offset field —
    SnapEDA STEPs often centre at the body centroid rather than the pin-1
    corner, so without an offset the body floats off-pad. Emits a
    ``{"kind": "auto_offset_applied", ...}`` warning per injection.

    Stripping is the safe choice: ``kicad-cli pcb export glb`` silently
    drops a missing-file 3D model and emits a board-plane-only GLB with
    exit 0 (see :func:`_resolve_model_path` docstring). By removing the
    block here we give kicad-cli nothing to fail on; the warnings list
    is how the user finds out.

    Uses a paren-depth scanner because nested S-exprs (``(offset …)``,
    ``(scale …)``, ``(rotate …)``) can't be balanced with a flat regex.
    """
    out_parts: list[str] = []
    warnings: list[dict] = []
    i = 0
    while i < len(text):
        match = _MODEL_PATH_RE.search(text, i)
        if match is None:
            out_parts.append(text[i:])
            break
        # group(1) is "(model "; the opening paren is its first char.
        block_start = match.start(1)
        # Sanity: the matched prefix MUST start with '('. If the regex
        # ever changes shape, abort cleanly rather than corrupt input.
        if text[block_start] != "(":  # pragma: no cover - defensive
            out_parts.append(text[i:match.end(2)])
            i = match.end(2)
            continue
        out_parts.append(text[i:block_start])

        # Walk the (model …) block to its closing paren.
        depth = 0
        end = block_start
        for j in range(block_start, len(text)):
            ch = text[j]
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    end = j + 1
                    break
        else:
            # Unbalanced — emit as-is and stop scanning.
            out_parts.append(text[block_start:])
            i = len(text)
            break

        token = match.group(2)
        resolved = _resolve_model_path(token, lib_dir)
        if resolved is None:
            raw_token = token.strip().strip('"').strip("'")
            expanded = _expand_model_env_vars(raw_token, lib_dir)
            basename = Path(expanded).name
            sibling_match = _find_basename_in_sibling_libs(lib_dir, basename)
            warnings.append({
                "kind": "model_not_found",
                "token": token,
                "expanded": expanded,
                "basename": basename,
                "sibling_match": sibling_match,
                "lib_dir": str(lib_dir),
            })
            log.warning(
                "render_3d: stripping (model …) block — file not found "
                "on disk for token %r (lib_dir=%s, expanded=%s, "
                "sibling_match=%s). kicad-cli would silently drop this "
                "model and produce an empty-board GLB.",
                token, lib_dir, expanded, sibling_match,
            )
            # Skip the entire block. Also swallow the trailing newline +
            # leading whitespace if present so we don't leave a blank line.
            while end < len(text) and text[end] in " \t":
                end += 1
            if end < len(text) and text[end] == "\n":
                end += 1
            i = end
            continue

        # Rewrite the path token in-place inside the block.
        block = text[block_start:end]
        prefix_in_block = match.group(1)  # "(model "
        new_block = block.replace(
            prefix_in_block + token,
            prefix_in_block + '"' + resolved + '"',
            1,
        )

        # Auto-offset injection: legacy footprints (committed before
        # drop_import.compute_step_pad_offset existed) often have a
        # (model …) block with NO (offset …) sub-S-expr. SnapEDA STEPs
        # are typically centred at the body centroid, NOT pin-1, so
        # without an offset the body floats off the pads. Compute the
        # same pad-centre-on-body-centre offset drop_import would have
        # injected at commit time, but only in-memory — never write to
        # disk. Skip when the caller didn't pass a footprint_file
        # (defensive — happens via the legacy _rewrite_or_strip path).
        if (
            footprint_file is not None
            and not _OFFSET_SUBEXPR_RE.search(new_block)
        ):
            try:
                # Lazy import: drop_import → library, breaks any future
                # cycle between the two modules.
                from kibrary_sidecar.drop_import import compute_step_pad_offset
                ox, oy, oz = compute_step_pad_offset(resolved, footprint_file)
            except Exception as exc:  # noqa: BLE001 — degrade gracefully
                log.warning(
                    "render_3d: auto-offset compute failed for %s in %s: %s "
                    "— rendering with original (no-offset) transform",
                    resolved, footprint_file, exc,
                )
                ox = oy = oz = 0.0
            new_block = _inject_offset_into_model_block(
                new_block, (ox, oy, oz)
            )
            warnings.append({
                "kind": "auto_offset_applied",
                "model_path": resolved,
                "offset": [ox, oy, oz],
            })
            log.info(
                "render_3d: injected auto-offset (%.4f, %.4f, %.4f) for "
                "model %s — block had no (offset …) field",
                ox, oy, oz, resolved,
            )

        out_parts.append(new_block)
        i = end

    return "".join(out_parts), warnings


# Match a top-level (offset (xyz …)) sub-S-expr inside a (model …) block.
# Accepts the inline form ``(offset (xyz 1 2 3))`` and the multi-line
# form KiCad's own footprint editor emits:
#     (offset
#       (xyz 1 2 3)
#     )
# Anchored on ``(offset`` followed by whitespace (incl. newlines) +
# ``(xyz`` to avoid false matches on a hypothetical ``(offset_foo …)``.
_OFFSET_SUBEXPR_RE = re.compile(r"\(offset\s+\(xyz\b", re.IGNORECASE)


def _inject_offset_into_model_block(
    block: str, offset: tuple[float, float, float]
) -> str:
    """Insert an ``(offset (xyz …))`` clause near the start of *block*.

    Inserts immediately after the ``(model "<path>"`` prefix, on a new
    line indented with one tab — matches the KiCad-emitted formatting
    so kicad-cli's tokenizer accepts it cleanly. Caller must already
    have verified there is no existing ``(offset …)`` sub-S-expr.
    """
    # Find the path token's closing quote so we insert AFTER the path
    # but BEFORE any existing (scale …) / (rotate …) sub-S-exprs. The
    # path is always the first arg in (model "…" …).
    m = re.match(r'\(model\s+("[^"]+"|[^\s\(\)]+)', block)
    if m is None:  # pragma: no cover - defensive; loop only enters with a match
        return block
    after_path = m.end()
    ox, oy, oz = offset
    insertion = f"\n\t\t(offset (xyz {ox} {oy} {oz}))"
    return block[:after_path] + insertion + block[after_path:]


def _find_basename_in_sibling_libs(lib_dir: Path, basename: str) -> str | None:
    """Search every sibling library's ``.3dshapes/`` for *basename*.

    Helps diagnose the common drag-and-drop misfire where the .step
    landed in another library's ``.3dshapes/`` (e.g. user picked the
    wrong target lib at commit time, or a previous commit synced the
    file under the wrong KSL_ROOT subdir). Returns the absolute path of
    the first match, or ``None`` if no sibling has it.

    The "workspace" we walk is ``lib_dir.parent`` — i.e. KSL_ROOT under
    the standard committed-library convention. Skips ``lib_dir`` itself
    (the caller already searched there).
    """
    try:
        ws_root = lib_dir.parent
        if not ws_root.is_dir():
            return None
        for sibling in sorted(ws_root.iterdir()):
            if not sibling.is_dir() or sibling == lib_dir:
                continue
            for shapes_dir in sibling.glob("*.3dshapes"):
                cand = shapes_dir / basename
                if cand.is_file():
                    return str(cand)
    except OSError:
        return None
    return None


def footprint_has_model_block(footprint_file: Path) -> bool:
    """Return True iff the .kicad_mod source contains any ``(model …)``.

    Used by the GLB renderer to decide whether kicad-cli's ``Could not
    add 3D model`` stderr line is a hard failure (we expected a model
    and kicad-cli silently dropped it) or just a benign no-op (the
    sanitiser stripped the block because the .step was missing, so
    there's nothing for kicad-cli to drop).
    """
    try:
        text = footprint_file.read_text(encoding="utf-8")
    except OSError:
        return False
    return _MODEL_PATH_RE.search(text) is not None


def count_model_blocks(footprint_file: Path) -> int:
    """Return the number of ``(model …)`` blocks in the .kicad_mod source.

    Wave 06-IPEX fix C: ``render_footprint_3d_glb_with_top_layers``
    compares this count against the warnings list. If the warning list
    reports that EVERY expected model was dropped (``model_not_found``
    in the sanitiser, ``tessellation_failed`` in kicad-cli) then the
    GLB contains only the auto-generated PCB substrate — no chip body
    the user can actually see. Raising in that case lets the frontend's
    existing asset-error overlay fire on a hard render failure instead
    of leaving the user with a green PCB and an amber warning they
    might dismiss without realising the chip is missing.
    """
    try:
        text = footprint_file.read_text(encoding="utf-8")
    except OSError:
        return 0
    return len(_MODEL_PATH_RE.findall(text))


def _patch_model_transform(
    text: str,
    offset: tuple[float, float, float],
    rotation: tuple[float, float, float],
    scale: tuple[float, float, float],
) -> str:
    """Rewrite the first ``(model …)`` block's offset/rotate/scale.

    Uses a paren-depth scanner to bound the model block (regex can't
    reliably balance nested S-exprs), then sub-S-expr regex inside that
    slice. No-op when the footprint has no model block.
    """
    idx = text.find("(model")
    if idx == -1:
        return text
    depth = 0
    end = idx
    for i in range(idx, len(text)):
        ch = text[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    block = text[idx:end]
    block = re.sub(
        r"\(offset\s+\(xyz[^)]*\)\s*\)",
        f"(offset (xyz {offset[0]} {offset[1]} {offset[2]}))",
        block,
    )
    block = re.sub(
        r"\(rotate\s+\(xyz[^)]*\)\s*\)",
        f"(rotate (xyz {rotation[0]} {rotation[1]} {rotation[2]}))",
        block,
    )
    block = re.sub(
        r"\(scale\s+\(xyz[^)]*\)\s*\)",
        f"(scale (xyz {scale[0]} {scale[1]} {scale[2]}))",
        block,
    )
    return text[:idx] + block + text[end:]


_VALID_QUALITIES = {"basic", "high", "user", "job_settings"}


def render_footprint_3d_png_angled(
    lib_dir: Path,
    footprint_file: Path,
    output_png: Path,
    *,
    azimuth: float = -25.0,
    elevation: float = -25.0,
    offset: tuple[float, float, float] | None = None,
    rotation: tuple[float, float, float] | None = None,
    scale: tuple[float, float, float] | None = None,
    width: int = 600,
    height: int = 400,
    zoom: float = 1.0,
    quality: str = "basic",
) -> None:
    """Variant of :func:`render_footprint_3d_png` for the interactive viewer.

    Differs from the static renderer in two ways:
    1. The orbit is ``--rotate {elevation},0,{azimuth}`` instead of the
       hardcoded ``-25,0,-25``, so drag-to-orbit works without disk writes.
    2. When all three of offset/rotation/scale are passed, the spliced
       board is mutated in memory before kicad-cli sees it — the user's
       unsaved positioner values render live without touching the file.

    The ``zoom`` (camera ``--zoom`` factor, kicad-cli default 1.0) and
    ``quality`` (``--quality basic|high|user|job_settings``) knobs let the
    interactive viewer drop to a faster/lower-fidelity render during drag
    and ramp back up on release. Both are always passed to kicad-cli (even
    at their defaults) so the invocation is deterministic.
    """
    if zoom <= 0:
        raise ValueError(
            f"render_footprint_3d_png_angled: zoom must be positive, got {zoom!r}"
        )
    if quality not in _VALID_QUALITIES:
        raise ValueError(
            f"render_footprint_3d_png_angled: quality must be one of "
            f"{sorted(_VALID_QUALITIES)!r}, got {quality!r}"
        )

    if not footprint_file.is_file():
        raise FileNotFoundError(
            f"render_footprint_3d_png_angled: footprint file not found: {footprint_file}"
        )

    output_png.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp_dir_str:
        tmp_dir = Path(tmp_dir_str)
        sanitised = _sanitise_footprint(
            footprint_file,
            lib_dir,
            override_offset=offset,
            override_rotation=rotation,
            override_scale=scale,
        )
        board_path = tmp_dir / "preview.kicad_pcb"
        board_path.write_text(_splice_into_template(sanitised), encoding="utf-8")

        fp_name = footprint_file.stem

        cmd = [
            "kicad-cli",
            "pcb",
            "render",
            "--output", str(output_png),
            "--width", str(width),
            "--height", str(height),
            "--quality", quality,
            "--zoom", str(zoom),
            "--side", "top",
            "--rotate", f"{elevation},0,{azimuth}",
            "--perspective",
            str(board_path),
        ]

        log.debug("Rendering 3D PNG (angled): %s", " ".join(cmd))
        proc = subprocess.run(cmd, capture_output=True, text=True, env=_system_env())
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "").strip()
            raise RuntimeError(
                f"kicad-cli pcb render failed (exit {proc.returncode}) "
                f"for footprint {fp_name!r}: {err}"
            )

        if not output_png.is_file():
            raise FileNotFoundError(
                f"kicad-cli produced no PNG at {output_png} "
                f"for footprint {fp_name!r}"
            )


def _kicad_default_3dmodel_dir(major: int) -> Path | None:
    """Return the OS-appropriate default ``share/kicad/3dmodels`` dir for
    KiCad *major* version, or ``None`` if it can't be located.

    The actual lookup is best-effort: when the env var ``KICAD{major}_3DMODEL_DIR``
    is unset (the common case in headless containers without KiCad's
    asset bundle installed), this provides the OS-default directory KiCad
    itself would use. Returns ``None`` when the directory doesn't exist on
    disk, so substitution gracefully falls through to the glob fallback.
    """
    system = platform.system()
    if system == "Linux":
        candidate = Path("/usr/share/kicad/3dmodels")
    elif system == "Darwin":
        candidate = Path(
            "/Applications/KiCad/KiCad.app/Contents/SharedSupport/3dmodels"
        )
    elif system == "Windows":
        candidate = Path(
            rf"C:\Program Files\KiCad\{major}.0\share\kicad\3dmodels"
        )
    else:
        return None
    return candidate if candidate.is_dir() else None


def _model_env_substitutions(lib_dir: Path) -> dict[str, str]:
    """Build the KiCad-style env-var substitution table for model paths.

    Mirrors the variables the KiCad path resolver itself recognises plus
    kibrary's own ``${KSL_ROOT}``. Keys map ``VAR_NAME`` → resolved
    filesystem path. Variables whose value is ``None`` (env unset and no
    OS default available) are omitted so a non-match falls through to the
    glob fallback rather than producing a spurious ``${VAR}`` literal.

    Note: ``${KSL_ROOT}`` resolves to ``lib_dir.parent``. This assumes
    lib_dir is a direct child of the workspace (the committed-library
    layout). For staging layouts where lib_dir might live a level deeper,
    callers should still pass the committed-library equivalent so this
    convention holds.
    """
    table: dict[str, str | None] = {
        "KSL_ROOT": str(lib_dir.parent),
        "KICAD9_3DMODEL_DIR": (
            os.environ.get("KICAD9_3DMODEL_DIR")
            or (str(d) if (d := _kicad_default_3dmodel_dir(9)) else None)
        ),
        "KICAD8_3DMODEL_DIR": (
            os.environ.get("KICAD8_3DMODEL_DIR")
            or (str(d) if (d := _kicad_default_3dmodel_dir(8)) else None)
        ),
        "KICAD_USER_3DMODEL_DIR": os.environ.get("KICAD_USER_3DMODEL_DIR"),
        # KiCad project-relative: by convention the "project" for a
        # standalone .kicad_mod render is the library directory itself.
        "KIPRJMOD": str(lib_dir),
    }
    return {k: v for k, v in table.items() if v}


def _expand_model_env_vars(raw: str, lib_dir: Path) -> str:
    """Substitute ``${VAR}`` (KiCad's preferred form) tokens in *raw*.

    Only the bracketed ``${VAR_NAME}`` form is handled — KiCad's own
    docs and emitted footprints standardise on it. Bare ``$VAR`` and
    Windows ``%VAR%`` are intentionally NOT substituted to avoid false
    matches against shell-style fragments inside legitimate paths.

    The legacy ``$KSL_ROOT`` (no braces) form is preserved as a special
    case for backward compatibility with kibrary-committed libraries
    written before the alpha.21 standardisation.
    """
    table = _model_env_substitutions(lib_dir)
    out = raw
    for var_name, value in table.items():
        out = out.replace(f"${{{var_name}}}", value)
    # Backward compat: the legacy un-braced form for KSL_ROOT only.
    if "KSL_ROOT" in table:
        out = out.replace("$KSL_ROOT", table["KSL_ROOT"])
    return out


def _resolve_model_path(raw: str, lib_dir: Path) -> str | None:
    """Turn a ``(model …)`` path argument into an absolute filesystem path.

    Accepts the path token as kicad-cli sees it (quoted or bare) and
    returns just the resolved string (no surrounding quotes).

    Returns ``None`` when no candidate path exists on disk. The caller
    (:func:`_sanitise_footprint`) interprets that as "strip the entire
    ``(model …)`` block", because ``kicad-cli pcb export glb`` SILENTLY
    DROPS missing-file 3D models (returncode=0, stderr ``Could not add
    3D model``) — leaving a GLB that contains only the PCB plane. The
    user then sees an empty board with no chip body. By stripping the
    block ahead of time we get a deterministic degraded-but-functional
    GLB, and the GLB-render shell-out can additionally raise loudly if
    it ever sees the silent-drop pattern in stderr.

    Resolution rules
    ----------------
    * ``${KSL_ROOT}/<lib>/<lib>.3dshapes/foo.step`` → expanded to
      ``<lib_dir.parent>/<lib>/<lib>.3dshapes/foo.step``.
    * ``${KICAD9_3DMODEL_DIR}/...`` / ``${KICAD8_3DMODEL_DIR}/...`` /
      ``${KICAD_USER_3DMODEL_DIR}/...`` — KiCad's own stock-library env
      vars; falls back to the OS-default dir when the env var is unset.
    * ``${KIPRJMOD}/...`` — KiCad project-relative; resolves under
      ``lib_dir``.
    * ``./foo.step`` or ``foo.step`` (staging form) → ``<lib_dir>/<lcsc>.3dshapes/foo.step``
      (we look for any ``*.3dshapes`` dir under lib_dir and pick the first
      that contains ``foo.step``).
    * Already-absolute paths pass through if they exist on disk.
    * Last-ditch dir-name-mismatch fallback: when an absolute path
      doesn't resolve, search any ``*.3dshapes/`` subdir of ``lib_dir``
      for a file with the same basename (catches legacy JLC2KiCadLib
      output where the dir is named after the LCSC but the .kicad_mod
      references a library-named dir).
    * If no candidate exists, returns ``None``.
    """
    raw = raw.strip().strip('"').strip("'")
    expanded = _expand_model_env_vars(raw, lib_dir)

    p = Path(expanded)
    if p.is_absolute():
        if p.is_file():
            return str(p)
        # Absolute but missing — try the dir-name-mismatch fallback
        # before giving up. Catches legacy JLC2KiCadLib output where
        # the .kicad_mod references e.g. ``Foo_KSL.3dshapes/X.step`` but
        # the file actually sits at ``C25804.3dshapes/X.step``.
        basename = p.name
        for shapes_dir in sorted(lib_dir.glob("*.3dshapes")):
            cand = shapes_dir / basename
            if cand.is_file():
                log.warning(
                    "_resolve_model_path: matched %s under %s via "
                    "dir-name fallback (orig URI: %s)",
                    cand, shapes_dir, raw,
                )
                return str(cand)
        return None

    bare = expanded.lstrip("./").lstrip(".\\")
    bare_name = Path(bare).name

    for shapes_dir in sorted(lib_dir.glob("*.3dshapes")):
        cand = shapes_dir / bare_name
        if cand.is_file():
            return str(cand)

    # Final fallback: lib_dir/<bare> as a literal sibling, but only if
    # it actually exists. The pre-fix code unconditionally returned this
    # path, which let a missing-file (model …) reach kicad-cli — which
    # then silently dropped the body and produced an empty-board GLB.
    fallback = (lib_dir / bare).resolve()
    if fallback.is_file():
        return str(fallback)

    return None


def _splice_into_template(footprint_text: str) -> str:
    """Insert *footprint_text* (a ``(footprint …)`` S-expression) into the
    static empty-board template, just before the closing ``)`` of the
    outer ``(kicad_pcb …)`` form.
    """
    template = _EMPTY_BOARD_TEMPLATE.rstrip()
    assert template.endswith(")"), "empty board template must end with )"
    body = template[:-1].rstrip()
    return body + "\n" + footprint_text.strip() + "\n)\n"


# A complete empty .kicad_pcb (KiCad 9.0 format, version 20241229),
# generated once by ``pcbnew.SaveBoard(p, pcbnew.NewBoard(p))`` and
# embedded here to avoid depending on the system pcbnew Python module at
# render time. The (layers) table defines all canonical layer names so a
# spliced footprint that references e.g. ``"Cmts.User"`` resolves cleanly.
_EMPTY_BOARD_TEMPLATE = """\
(kicad_pcb
\t(version 20241229)
\t(generator "pcbnew")
\t(generator_version "9.0")
\t(general
\t\t(thickness 1.6)
\t\t(legacy_teardrops no)
\t)
\t(paper "A4")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(2 "B.Cu" signal)
\t\t(9 "F.Adhes" user "F.Adhesive")
\t\t(11 "B.Adhes" user "B.Adhesive")
\t\t(13 "F.Paste" user)
\t\t(15 "B.Paste" user)
\t\t(5 "F.SilkS" user "F.Silkscreen")
\t\t(7 "B.SilkS" user "B.Silkscreen")
\t\t(1 "F.Mask" user)
\t\t(3 "B.Mask" user)
\t\t(17 "Dwgs.User" user "User.Drawings")
\t\t(19 "Cmts.User" user "User.Comments")
\t\t(21 "Eco1.User" user "User.Eco1")
\t\t(23 "Eco2.User" user "User.Eco2")
\t\t(25 "Edge.Cuts" user)
\t\t(27 "Margin" user)
\t\t(31 "F.CrtYd" user "F.Courtyard")
\t\t(29 "B.CrtYd" user "B.Courtyard")
\t\t(35 "F.Fab" user)
\t\t(33 "B.Fab" user)
\t\t(39 "User.1" user)
\t\t(41 "User.2" user)
\t\t(43 "User.3" user)
\t\t(45 "User.4" user)
\t)
\t(setup
\t\t(pad_to_mask_clearance 0)
\t\t(allow_soldermask_bridges_in_footprints no)
\t\t(tenting front back)
\t\t(pcbplotparams
\t\t\t(layerselection 0x00000000_00000000_55555555_5755f5ff)
\t\t\t(plot_on_all_layers_selection 0x00000000_00000000_00000000_00000000)
\t\t\t(disableapertmacros no)
\t\t\t(usegerberextensions no)
\t\t\t(usegerberattributes yes)
\t\t\t(usegerberadvancedattributes yes)
\t\t\t(creategerberjobfile yes)
\t\t\t(dashed_line_dash_ratio 12.000000)
\t\t\t(dashed_line_gap_ratio 3.000000)
\t\t\t(svgprecision 4)
\t\t\t(plotframeref no)
\t\t\t(mode 1)
\t\t\t(useauxorigin no)
\t\t\t(hpglpennumber 1)
\t\t\t(hpglpenspeed 20)
\t\t\t(hpglpendiameter 15.000000)
\t\t\t(pdf_front_fp_property_popups yes)
\t\t\t(pdf_back_fp_property_popups yes)
\t\t\t(pdf_metadata yes)
\t\t\t(pdf_single_document no)
\t\t\t(dxfpolygonmode yes)
\t\t\t(dxfimperialunits yes)
\t\t\t(dxfusepcbnewfont yes)
\t\t\t(psnegative no)
\t\t\t(psa4output no)
\t\t\t(plot_black_and_white yes)
\t\t\t(sketchpadsonfab no)
\t\t\t(plotpadnumbers no)
\t\t\t(hidednponfab no)
\t\t\t(sketchdnponfab yes)
\t\t\t(crossoutdnponfab yes)
\t\t\t(subtractmaskfromsilk no)
\t\t\t(outputformat 1)
\t\t\t(mirror no)
\t\t\t(drillshape 1)
\t\t\t(scaleselection 1)
\t\t\t(outputdirectory "")
\t\t)
\t)
\t(net 0 "")
\t(embedded_fonts no)
\t(gr_rect (start -20 -20) (end 20 20) (stroke (width 0.1) (type solid)) (fill no) (layer "Edge.Cuts"))
)
"""
