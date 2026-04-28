"""svg_render.py — Render full-size symbol/footprint SVGs via kicad-cli.

Used by SymbolPreview / FootprintPreview in place of the kicanvas web
component, which depends on WebGL2 in webkit2gtk and renders blank/cyan in
a meaningful fraction of Linux Tauri environments. kicad-cli produces the
same vector data the user would see in eeschema/pcbnew, then the UI
displays it as a plain <img>.

NB: when running under a PyInstaller-bundled sidecar binary, the runtime
sets LD_LIBRARY_PATH to the temp _MEIPASS directory containing its own
libssl/libcrypto. Spawning kicad-cli inherits that env and kicad-cli's
libcurl ends up loading PyInstaller's bundled libssl — which is older
than the system's, so symbols like OPENSSL_3.2.0 resolve incorrectly and
kicad-cli aborts. We restore LD_LIBRARY_PATH_ORIG before exec.
"""
from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from pathlib import Path

log = logging.getLogger(__name__)


def _system_env() -> dict[str, str]:
    """Return an env dict with PyInstaller's runtime overrides undone.

    Strips:
      - LD_LIBRARY_PATH (restored from _ORIG): kicad-cli's libcurl loaded
        the bundled libssl and failed on OPENSSL_3.2.0 symbol.
      - DYLD_LIBRARY_PATH (macOS analogue).
      - PYTHONHOME / PYTHONPATH: when render_3d shells out to system
        python3 to import pcbnew, an inherited PyInstaller PYTHONHOME
        points at the bundle's _MEIPASS dir and breaks system Python's
        site-packages discovery (FootprintLoad silently returns None).
    """
    env = os.environ.copy()
    orig = env.pop("LD_LIBRARY_PATH_ORIG", None)
    if orig is not None:
        env["LD_LIBRARY_PATH"] = orig
    else:
        env.pop("LD_LIBRARY_PATH", None)
    orig_d = env.pop("DYLD_LIBRARY_PATH_ORIG", None)
    if orig_d is not None:
        env["DYLD_LIBRARY_PATH"] = orig_d
    else:
        env.pop("DYLD_LIBRARY_PATH", None)
    env.pop("PYTHONHOME", None)
    env.pop("PYTHONPATH", None)
    return env

# Footprints — full layer set so previews show silkscreen, mask, fab, etc.
# Same as icons.py but expanded with B.Silkscreen and B.Fab so 2-side parts
# show their reverse silk/fab drawings (icons hide them by design).
_FOOTPRINT_LAYERS = (
    "F.Cu,B.Cu,F.Paste,F.Mask,B.Paste,B.Mask,"
    "F.Silkscreen,B.Silkscreen,F.Fab,B.Fab,F.CrtYd,B.CrtYd,Edge.Cuts"
)


def render_symbol_svg(sym_path: Path, component_name: str) -> str:
    """Run ``kicad-cli sym export svg --symbol <component_name> <sym_path>``
    and return the resulting SVG text.

    Parameters
    ----------
    sym_path:
        Path to a ``.kicad_sym`` library file.
    component_name:
        ``entryName`` of the symbol to extract (e.g. ``C25804``).

    Returns
    -------
    str
        The SVG text.

    Raises
    ------
    subprocess.CalledProcessError
        kicad-cli exited non-zero.
    FileNotFoundError
        kicad-cli is missing OR no SVG was produced.
    """
    with tempfile.TemporaryDirectory() as tmp_dir:
        cmd = [
            "kicad-cli",
            "sym",
            "export",
            "svg",
            "--symbol", component_name,
            "--output", tmp_dir,
            str(sym_path),
        ]
        log.debug("Rendering symbol SVG: %s", " ".join(cmd))
        proc = subprocess.run(cmd, capture_output=True, text=True, env=_system_env())
        if proc.returncode != 0:
            # Surface kicad-cli's own diagnostic (it tells you whether the
            # symbol was missing, the file was unreadable, the format was
            # wrong, etc.) — without this the UI just sees "exit 1".
            err = (proc.stderr or proc.stdout or "").strip()
            raise RuntimeError(
                f"kicad-cli sym export svg failed (exit {proc.returncode}) "
                f"for symbol {component_name!r} in {sym_path.name}: {err}"
            )

        # kicad-cli names the output file after the library, e.g.
        # `<sym_path stem>.svg` or `<symbol>.svg` depending on version.
        # Pick the most recent .svg in the temp dir to be tolerant.
        svgs = sorted(
            Path(tmp_dir).glob("*.svg"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if not svgs:
            raise FileNotFoundError(
                f"kicad-cli produced no SVG in {tmp_dir} for "
                f"symbol {component_name!r} in {sym_path}"
            )
        return svgs[0].read_text(encoding="utf-8")


def render_footprint_svg(pretty_dir: Path, footprint_name: str) -> str:
    """Run ``kicad-cli fp export svg --footprint <footprint_name> <pretty_dir>``
    and return the SVG text.

    Same arguments as ``icons.render_footprint_icon`` but with the full
    layer set and returning text instead of writing to a file.
    """
    with tempfile.TemporaryDirectory() as tmp_dir:
        cmd = [
            "kicad-cli",
            "fp",
            "export",
            "svg",
            "--footprint", footprint_name,
            "--layers", _FOOTPRINT_LAYERS,
            "--output", tmp_dir,
            str(pretty_dir),
        ]
        log.debug("Rendering footprint SVG: %s", " ".join(cmd))
        proc = subprocess.run(cmd, capture_output=True, text=True, env=_system_env())
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "").strip()
            raise RuntimeError(
                f"kicad-cli fp export svg failed (exit {proc.returncode}) "
                f"for footprint {footprint_name!r} in {pretty_dir.name}: {err}"
            )

        expected = Path(tmp_dir) / f"{footprint_name}.svg"
        if expected.is_file():
            return expected.read_text(encoding="utf-8")
        # Some versions may produce a different name.
        svgs = list(Path(tmp_dir).glob("*.svg"))
        if not svgs:
            raise FileNotFoundError(
                f"kicad-cli produced no SVG in {tmp_dir} for footprint "
                f"{footprint_name!r} in {pretty_dir}"
            )
        return svgs[0].read_text(encoding="utf-8")
