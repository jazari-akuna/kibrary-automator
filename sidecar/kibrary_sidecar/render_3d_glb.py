"""render_3d_glb.py — Render a single KiCad footprint as a binary glTF (GLB)
via ``kicad-cli pcb export glb``.

This is the server side of the alpha.28 30fps 3D viewer rewrite. The
existing PNG path (:mod:`render_3d`) shells out to ``kicad-cli pcb render``
*per frame* (~200 ms per spawn → caps at ~5 fps). By exporting the
spliced board to GLB **once**, the frontend's three.js viewer can render
+ orbit + zoom in pure WebGL at 60+ fps with no further sidecar calls
until the user *commits* a transform change.

Pipeline mirrors :mod:`render_3d`:

1. Sanitise the ``.kicad_mod`` (legacy layer aliases → canonical, ``(model
   …)`` paths → absolute) via :func:`render_3d._sanitise_footprint`.
2. Splice the sanitised footprint into the empty-board template via
   :func:`render_3d._splice_into_template`.
3. Optionally patch the first ``(model …)`` block's offset/rotation/scale
   via :func:`render_3d._patch_model_transform`. None means "use the
   original transform"; a value overrides it.
4. Shell out: ``kicad-cli pcb export glb -o <out.glb> <board.kicad_pcb>``.
5. Read the GLB bytes back and return them.

LD_LIBRARY_PATH handling reuses :func:`svg_render._system_env` — the same
PyInstaller scrub the PNG path uses.
"""
from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

from kibrary_sidecar.render_3d import (
    _patch_model_transform,
    _sanitise_footprint,
    _splice_into_template,
)
from kibrary_sidecar.svg_render import _system_env

log = logging.getLogger(__name__)


def render_footprint_3d_glb(
    lib_dir: Path,
    footprint_file: Path,
    *,
    offset: tuple[float, float, float] | None = None,
    rotation: tuple[float, float, float] | None = None,
    scale: tuple[float, float, float] | None = None,
) -> bytes:
    """Render a footprint to a binary glTF (GLB) and return the raw bytes.

    Parameters
    ----------
    lib_dir:
        Committed library directory (or staging part directory). Used by
        the shared sanitiser to resolve ``${KSL_ROOT}`` and ``./foo.step``
        forms in the ``(model …)`` path.
    footprint_file:
        Path to the ``.kicad_mod`` file to render.
    offset, rotation, scale:
        Optional in-memory override for the first ``(model …)`` block's
        transform. ``None`` means "leave the original transform alone";
        passing all three rewrites the spliced board so the user's
        unsaved positioner edits show up in the GLB without writing the
        ``.kicad_mod`` to disk first. Mirrors
        :func:`render_3d.render_footprint_3d_png_angled`'s semantics:
        all-or-nothing — partial overrides are ignored.

    Returns
    -------
    bytes
        Raw GLB bytes. The file starts with the binary glTF v2 magic
        header ``b'glTF\\x02\\x00\\x00\\x00'`` (4-byte magic + 4-byte
        version little-endian).

    Raises
    ------
    FileNotFoundError
        ``footprint_file`` doesn't exist, OR kicad-cli returned 0 but
        produced no GLB at the expected path.
    RuntimeError
        ``kicad-cli pcb export glb`` exited non-zero. The captured
        stderr is included in the exception message.
    """
    if not footprint_file.is_file():
        raise FileNotFoundError(
            f"render_footprint_3d_glb: footprint file not found: {footprint_file}"
        )

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

        out_glb = tmp_dir / "preview.glb"
        fp_name = footprint_file.stem

        cmd = [
            "kicad-cli",
            "pcb",
            "export",
            "glb",
            "-o",
            str(out_glb),
            str(board_path),
        ]

        log.debug("Rendering 3D GLB: %s", " ".join(cmd))
        proc = subprocess.run(
            cmd, capture_output=True, text=True, env=_system_env()
        )
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "").strip()
            raise RuntimeError(
                f"kicad-cli pcb export glb failed (exit {proc.returncode}) "
                f"for footprint {fp_name!r}: {err}"
            )

        if not out_glb.is_file():
            raise FileNotFoundError(
                f"kicad-cli produced no GLB at {out_glb} "
                f"for footprint {fp_name!r}"
            )

        return out_glb.read_bytes()


# Re-export the helpers we delegate to so call sites that want to patch
# the transform path directly (e.g. tests) can do so via a single module.
__all__ = [
    "render_footprint_3d_glb",
    "_sanitise_footprint",
    "_splice_into_template",
    "_patch_model_transform",
]
