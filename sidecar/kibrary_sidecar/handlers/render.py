"""SVG / PNG / GLB rendering handlers for committed libraries and staged parts.

These map to ``library.render_*`` and ``parts.render_*`` method names. Heavy
render dependencies (kiutils, kicad-cli wrappers) are imported lazily inside
each handler so importing this module stays light.
"""

from pathlib import Path

from kibrary_sidecar.handlers._common import _lib_scanner


def library_render_symbol_svg(p: dict) -> dict:
    """Render a single symbol from a committed library to SVG via kicad-cli.

    alpha.18: replaces the kicanvas-embed render path because WebGL2 is
    unreliable in webkit2gtk on Linux (renders blank/cyan even when the
    custom element loads cleanly). kicad-cli produces the same vector data
    eeschema would show, then the UI displays it as a plain ``<img>``.
    """
    from kibrary_sidecar import svg_render
    lib_dir = Path(p["lib_dir"])
    sym_path = lib_dir / f"{lib_dir.name}.kicad_sym"
    svg = svg_render.render_symbol_svg(sym_path, p["component_name"])
    return {"svg": svg}


def library_render_footprint_svg(p: dict) -> dict:
    """Render a single footprint from a committed library to SVG via kicad-cli.

    Delegates the symbol → footprint-file resolution to ``lib_scanner._find_footprint``
    (it honours the symbol's ``Footprint`` property), then passes the file
    stem to kicad-cli — empirically kicad-cli matches ``--footprint X`` by
    file basename in the .pretty dir, not by the internal name.
    """
    from kibrary_sidecar import svg_render
    lib_scanner = _lib_scanner()
    lib_dir = Path(p["lib_dir"])
    component_name = p["component_name"]
    pretty = lib_dir / f"{lib_dir.name}.pretty"
    candidate_path = lib_scanner._find_footprint(lib_dir, component_name)  # type: ignore[attr-defined]
    if candidate_path is None:
        # Build a useful diagnostic: what Footprint prop did the symbol declare,
        # and what files do we actually see in .pretty?
        fp_name_hint = lib_scanner._footprint_name_from_symbol(  # type: ignore[attr-defined]
            lib_dir, component_name
        )
        existing = sorted(p.name for p in pretty.glob("*.kicad_mod")) if pretty.is_dir() else []
        existing_summary = (
            ", ".join(existing[:6]) + (f" (+{len(existing)-6} more)" if len(existing) > 6 else "")
            if existing else "<no .kicad_mod files>"
        )
        raise FileNotFoundError(
            f"No .kicad_mod could be matched for symbol {component_name!r}. "
            f"Footprint property: {fp_name_hint or '<missing/empty>'}. "
            f"Files in {pretty.name}: {existing_summary}"
        )
    svg = svg_render.render_footprint_svg(pretty, candidate_path.stem)
    return {"svg": svg}


def parts_render_symbol_svg(p: dict) -> dict:
    """Render the staged symbol for a part (Add room) to SVG via kicad-cli."""
    from kibrary_sidecar import svg_render
    staging_part = Path(p["staging_dir"]) / p["lcsc"]
    sym_path = staging_part / f"{p['lcsc']}.kicad_sym"
    # JLC2KiCadLib names the symbol after the manufacturer part / title;
    # auto-detect the entry name by reading the first symbol in the file
    # rather than assuming it matches the LCSC.
    from kiutils.symbol import SymbolLib
    lib = SymbolLib.from_file(str(sym_path))
    if not lib.symbols:
        raise FileNotFoundError(f"No symbols in {sym_path}")
    component_name = lib.symbols[0].entryName
    svg = svg_render.render_symbol_svg(sym_path, component_name)
    return {"svg": svg}


def parts_render_footprint_svg(p: dict) -> dict:
    """Render the staged footprint for a part to SVG via kicad-cli."""
    from kibrary_sidecar import svg_render
    staging_part = Path(p["staging_dir"]) / p["lcsc"]
    pretty = staging_part / f"{p['lcsc']}.pretty"
    if not pretty.is_dir():
        raise FileNotFoundError(f"No .pretty dir in {staging_part}")
    # Pick the first .kicad_mod and use its stem as the footprint name.
    mods = sorted(pretty.glob("*.kicad_mod"))
    if not mods:
        raise FileNotFoundError(f"No .kicad_mod in {pretty}")
    svg = svg_render.render_footprint_svg(pretty, mods[0].stem)
    return {"svg": svg}


def library_render_3d_png(p: dict) -> dict:
    """Render a footprint's 3D view to PNG via kicad-cli pcb render and
    return the PNG bytes as a base64 data URL the frontend can drop into
    ``<img src=…>``.
    """
    from kibrary_sidecar import render_3d
    import base64
    import tempfile
    lib_scanner = _lib_scanner()
    lib_dir = Path(p["lib_dir"])
    component_name = p["component_name"]
    fp_path = lib_scanner._find_footprint(lib_dir, component_name)  # type: ignore[attr-defined]
    if fp_path is None:
        raise FileNotFoundError(
            f"No .kicad_mod for symbol {component_name!r} in {lib_dir}"
        )
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        render_3d.render_footprint_3d_png(
            lib_dir=lib_dir,
            footprint_file=fp_path,
            output_png=tmp_path,
            side=p.get("side", "top"),
            width=p.get("width", 600),
            height=p.get("height", 400),
        )
        b64 = base64.b64encode(tmp_path.read_bytes()).decode("ascii")
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass
    return {"png_data_url": f"data:image/png;base64,{b64}"}


def library_render_3d_png_angled(p: dict) -> dict:
    """Live-preview variant of ``library.render_3d_png``.

    Accepts orbit angles (azimuth/elevation) and an optional in-memory
    transform override (offset/rotation/scale). The override is applied
    to the spliced board before kicad-cli sees it, so the user can drag
    positioner values around without disk writes between every tick.
    """
    from kibrary_sidecar import render_3d
    import base64
    import tempfile
    lib_scanner = _lib_scanner()
    lib_dir = Path(p["lib_dir"])
    component_name = p["component_name"]
    fp_path = lib_scanner._find_footprint(lib_dir, component_name)  # type: ignore[attr-defined]
    if fp_path is None:
        raise FileNotFoundError(
            f"No .kicad_mod for symbol {component_name!r} in {lib_dir}"
        )
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        render_3d.render_footprint_3d_png_angled(
            lib_dir=lib_dir,
            footprint_file=fp_path,
            output_png=tmp_path,
            azimuth=float(p.get("azimuth", -25.0)),
            elevation=float(p.get("elevation", -25.0)),
            offset=tuple(p["offset"]) if "offset" in p else None,
            rotation=tuple(p["rotation"]) if "rotation" in p else None,
            scale=tuple(p["scale"]) if "scale" in p else None,
            width=int(p.get("width", 600)),
            height=int(p.get("height", 400)),
            zoom=float(p.get("zoom", 1.0)),
            quality=str(p.get("quality", "basic")),
        )
        b64 = base64.b64encode(tmp_path.read_bytes()).decode("ascii")
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass
    return {"png_data_url": f"data:image/png;base64,{b64}"}


def library_render_3d_glb_angled(p: dict) -> dict:
    """alpha.28: GLB-based variant of ``library.render_3d_png_angled``.

    Renders the spliced board to a binary glTF (GLB) via
    ``kicad-cli pcb export glb`` and returns it as a base64 data URL the
    frontend can hand to three.js's ``GLTFLoader.parse``. The camera lives
    in the browser now (three.js + OrbitControls), so this RPC takes no
    azimuth/elevation/zoom/width/height — only the transform-override
    inputs (offset/rotation/scale) for the live-preview path.

    Compared to the PNG path:

    * ~185 ms one-time cost per board (same kicad-cli spawn floor) instead
      of ~200 ms PER FRAME.
    * Once loaded, three.js renders + orbits + zooms at 60+ fps in pure
      WebGL — no further sidecar calls until the user commits a transform
      change (Save button).
    """
    from kibrary_sidecar import render_3d_glb
    import base64
    lib_scanner = _lib_scanner()
    lib_dir = Path(p["lib_dir"])
    component_name = p["component_name"]
    fp_path = lib_scanner._find_footprint(lib_dir, component_name)  # type: ignore[attr-defined]
    if fp_path is None:
        raise FileNotFoundError(
            f"No .kicad_mod for symbol {component_name!r} in {lib_dir}"
        )
    bundle = render_3d_glb.render_footprint_3d_glb_with_top_layers(
        lib_dir=lib_dir,
        footprint_file=fp_path,
        offset=tuple(p["offset"]) if "offset" in p else None,
        rotation=tuple(p["rotation"]) if "rotation" in p else None,
        scale=tuple(p["scale"]) if "scale" in p else None,
    )
    glb_b64 = base64.b64encode(bundle["glb_bytes"]).decode("ascii")
    # alpha.33: SVG decal of the front layers — kicad-cli pcb export glb
    # doesn't include copper/pads/silkscreen, so the viewer paints this
    # SVG on top of the substrate. Empty string when SVG export failed
    # (viewer falls back to no decal).
    svg_text = bundle.get("top_layers_svg") or ""
    svg_b64 = base64.b64encode(svg_text.encode("utf-8")).decode("ascii") if svg_text else ""
    # Bug-3 fix: surface structured "model file not found" diagnostics
    # from the sanitiser so the frontend can tell the user "3D body
    # missing because <path>" instead of silently rendering a board-only
    # GLB. Always present (empty list when there's nothing to report).
    warnings = bundle.get("warnings") or []
    return {
        "glb_data_url": f"data:model/gltf-binary;base64,{glb_b64}",
        "top_layers_svg_data_url": (
            f"data:image/svg+xml;base64,{svg_b64}" if svg_b64 else ""
        ),
        "warnings": warnings,
    }


REGISTRY = {
    "library.render_symbol_svg": library_render_symbol_svg,
    "library.render_footprint_svg": library_render_footprint_svg,
    "parts.render_symbol_svg": parts_render_symbol_svg,
    "parts.render_footprint_svg": parts_render_footprint_svg,
    "library.render_3d_png": library_render_3d_png,
    "library.render_3d_png_angled": library_render_3d_png_angled,
    "library.render_3d_glb_angled": library_render_3d_glb_angled,
}
