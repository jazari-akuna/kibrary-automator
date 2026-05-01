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

    * Legacy layer aliases (bare and quoted) → canonical name.
    * ``(model …)`` paths → absolute filesystem paths (``${KSL_ROOT}``
      expanded, ``./foo.step`` resolved against ``lib_dir/*.3dshapes``).
    * Optional offset/rotation/scale overrides — when ALL three are
      provided, the first ``(model …)`` block's transform sub-S-exprs are
      rewritten in-memory. Used by the live-preview renderer so the user
      can drag values around without writing to disk on every tick.
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
    text = _rewrite_or_strip_model_blocks(text, lib_dir)
    if (
        override_offset is not None
        and override_rotation is not None
        and override_scale is not None
    ):
        text = _patch_model_transform(
            text, override_offset, override_rotation, override_scale
        )
    return text


def _rewrite_or_strip_model_blocks(text: str, lib_dir: Path) -> str:
    """Rewrite each ``(model …)`` path to absolute, OR strip the whole
    block when the resolved path doesn't exist on disk.

    Stripping is the safe choice: ``kicad-cli pcb export glb`` silently
    drops a missing-file 3D model and emits a board-plane-only GLB with
    exit 0 (see :func:`_resolve_model_path` docstring). By removing the
    block here we give kicad-cli nothing to fail on, AND the call site
    can decide independently whether to warn the user about the missing
    .step.

    Uses a paren-depth scanner because nested S-exprs (``(offset …)``,
    ``(scale …)``, ``(rotate …)``) can't be balanced with a flat regex.
    """
    out_parts: list[str] = []
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

        resolved = _resolve_model_path(match.group(2), lib_dir)
        if resolved is None:
            log.warning(
                "render_3d: stripping (model …) block — file not found "
                "on disk for token %r (lib_dir=%s). kicad-cli would "
                "silently drop this model and produce an empty-board GLB.",
                match.group(2), lib_dir,
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
            prefix_in_block + match.group(2),
            prefix_in_block + '"' + resolved + '"',
            1,
        )
        out_parts.append(new_block)
        i = end

    return "".join(out_parts)


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
    * ``${KSL_ROOT}/<lib>/<lib>.3dshapes/foo.step`` → ``<lib_dir.parent>/<lib>/<lib>.3dshapes/foo.step``
    * ``./foo.step`` or ``foo.step`` (staging form) → ``<lib_dir>/<lcsc>.3dshapes/foo.step``
      (we look for any ``*.3dshapes`` dir under lib_dir and pick the first
      that contains ``foo.step``)
    * Already-absolute paths pass through if they exist on disk.
    * If no candidate exists, returns ``None``.
    """
    raw = raw.strip().strip('"').strip("'")
    ksl_root = str(lib_dir.parent)
    expanded = raw.replace("${KSL_ROOT}", ksl_root).replace("$KSL_ROOT", ksl_root)

    p = Path(expanded)
    if p.is_absolute():
        if p.is_file():
            return str(p)
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
