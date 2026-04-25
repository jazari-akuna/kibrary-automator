"""icons.py — Render footprint SVG thumbnails via kicad-cli.

Uses ``kicad-cli fp export svg`` to produce per-component icon files.
All public functions are best-effort; failures are logged and return None
so that callers can fall back to a generic icon.
"""
from __future__ import annotations

import logging
import subprocess
import tempfile
import shutil
from pathlib import Path

log = logging.getLogger(__name__)

# Layers exported for the thumbnail — covers copper, paste, mask, silkscreen,
# fab drawings, courtyard, and board edge.
_DEFAULT_LAYERS = "F.Cu,F.Paste,F.Mask,F.Silkscreen,F.Fab,F.CrtYd,Edge.Cuts"


def render_footprint_icon(
    pretty_dir: Path,
    footprint_name: str,
    out_path: Path,
) -> None:
    """Run ``kicad-cli fp export svg`` to produce *out_path*.

    Parameters
    ----------
    pretty_dir:
        Path to the ``.pretty`` directory that contains the footprint.
    footprint_name:
        The footprint name (stem of the ``.kicad_mod`` file, without extension).
    out_path:
        Destination for the rendered SVG.

    Raises
    ------
    subprocess.CalledProcessError
        When kicad-cli exits with a non-zero status.
    FileNotFoundError
        When kicad-cli is not found on PATH (or at any common location).
    """
    # kicad-cli writes the output file into a directory; we use a temp dir to
    # capture whatever file it creates, then move it to out_path.
    with tempfile.TemporaryDirectory() as tmp_dir:
        cmd = [
            "kicad-cli",
            "fp",
            "export",
            "svg",
            "--footprint", footprint_name,
            "--layers", _DEFAULT_LAYERS,
            "--output-dir", tmp_dir,
            str(pretty_dir),
        ]
        log.debug("Rendering icon: %s", " ".join(cmd))
        subprocess.run(cmd, check=True, capture_output=True)

        # kicad-cli names the output file after the footprint
        expected = Path(tmp_dir) / f"{footprint_name}.svg"
        if expected.is_file():
            out_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(expected), out_path)
        else:
            # Some versions may produce a different name — grab any .svg
            svgs = list(Path(tmp_dir).glob("*.svg"))
            if svgs:
                out_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(svgs[0]), out_path)
            else:
                raise FileNotFoundError(
                    f"kicad-cli produced no SVG in {tmp_dir} for footprint {footprint_name!r}"
                )


def render_for_part(part_dir: Path, lcsc: str) -> Path | None:
    """Convenience wrapper: render the footprint icon for a staged part.

    Looks for ``<part_dir>/<lcsc>.pretty/``, finds the first ``.kicad_mod``,
    renders to ``<part_dir>/<lcsc>.icon.svg``, and returns the output path.

    Returns ``None`` if rendering fails or no footprint exists.  Never raises —
    failures are logged so the caller can fall back to a generic icon.
    """
    pretty_dir = part_dir / f"{lcsc}.pretty"
    if not pretty_dir.is_dir():
        log.debug("render_for_part: no .pretty dir at %s", pretty_dir)
        return None

    mods = sorted(pretty_dir.glob("*.kicad_mod"))
    if not mods:
        log.debug("render_for_part: no .kicad_mod files in %s", pretty_dir)
        return None

    footprint_name = mods[0].stem
    out_path = part_dir / f"{lcsc}.icon.svg"

    try:
        render_footprint_icon(pretty_dir, footprint_name, out_path)
        log.info("Rendered icon for %s → %s", lcsc, out_path)
        return out_path
    except Exception as exc:
        log.warning("Icon render failed for %s: %s", lcsc, exc)
        return None


def backfill_icons(workspace: Path) -> dict:
    """Walk workspace's _KSL libs and render missing icons.

    For each library found under *workspace* (directories containing a
    ``<name>.kicad_sym`` file), render an SVG icon for every component that
    does not already have one in ``<lib>/<lib>.icons/<component>.svg``.

    Returns a dict with keys:
        libs_processed  (int)
        icons_rendered  (int)
        errors          (list[str])
    """
    from kibrary_sidecar import lib_scanner  # local import to avoid circular

    libs_processed = 0
    icons_rendered = 0
    errors: list[str] = []

    try:
        libraries = lib_scanner.list_libraries(workspace)
    except Exception as exc:
        return {"libs_processed": 0, "icons_rendered": 0, "errors": [str(exc)]}

    for lib_info in libraries:
        lib_dir = Path(lib_info["path"])
        lib_name = lib_info["name"]
        icons_dir = lib_dir / f"{lib_name}.icons"
        pretty_dir = lib_dir / f"{lib_name}.pretty"

        libs_processed += 1

        if not pretty_dir.is_dir():
            continue

        try:
            components = lib_scanner.list_components(lib_dir)
        except Exception as exc:
            errors.append(f"{lib_name}: failed to list components: {exc}")
            continue

        for comp in components:
            comp_name = comp["name"]
            icon_path = icons_dir / f"{comp_name}.svg"
            if icon_path.is_file():
                continue  # already rendered

            # Try the footprint with the exact component name first
            mod_path = pretty_dir / f"{comp_name}.kicad_mod"
            if not mod_path.is_file():
                # Fall back to any .kicad_mod
                mods = sorted(pretty_dir.glob("*.kicad_mod"))
                if not mods:
                    continue
                mod_path = mods[0]

            footprint_name = mod_path.stem
            try:
                icons_dir.mkdir(parents=True, exist_ok=True)
                render_footprint_icon(pretty_dir, footprint_name, icon_path)
                icons_rendered += 1
                log.info("Backfill: rendered %s → %s", comp_name, icon_path)
            except Exception as exc:
                errors.append(f"{lib_name}/{comp_name}: {exc}")
                log.warning("Backfill failed for %s/%s: %s", lib_name, comp_name, exc)

    return {
        "libs_processed": libs_processed,
        "icons_rendered": icons_rendered,
        "errors": errors,
    }
