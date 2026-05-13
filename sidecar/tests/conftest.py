import pytest


@pytest.fixture(autouse=True)
def _stable_kicad_cli_command(monkeypatch):
    """Keep renderer unit tests independent of the developer's KiCad settings."""
    from kibrary_sidecar import render_3d, render_3d_glb, svg_render

    bare = lambda: ["kicad-cli"]
    monkeypatch.setattr(svg_render, "kicad_cli_cmd", bare)
    monkeypatch.setattr(render_3d, "kicad_cli_cmd", bare)
    monkeypatch.setattr(render_3d_glb, "kicad_cli_cmd", bare)
