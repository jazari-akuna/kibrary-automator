"""Tests for the angled / live-preview variant of ``render_footprint_3d_png``.

Mirrors :mod:`tests.test_render_3d` but exercises the orbit angles and the
in-memory ``(model …)`` transform override used by the interactive viewer.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import patch

from kibrary_sidecar import render_3d
from tests.test_render_3d import _make_sample_kicad_mod, _kicad_cli_mock


# ---------------------------------------------------------------------------
# Test 1: orbit angles flow through to kicad-cli's --rotate.
# ---------------------------------------------------------------------------

def test_angled_passes_rotate_arg(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    out_png = tmp_path / "out.png"

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d.subprocess.run",
        side_effect=_kicad_cli_mock(captured),
    ):
        render_3d.render_footprint_3d_png_angled(
            lib_dir, mod, out_png, azimuth=42, elevation=-10
        )

    cmd = captured["cmd"]
    assert "--rotate" in cmd
    assert cmd[cmd.index("--rotate") + 1] == "-10,0,42"
    # Sanity: the rest of the kicad-cli shape still matches the static renderer.
    assert cmd[0] == "kicad-cli"
    assert "--side" in cmd and cmd[cmd.index("--side") + 1] == "top"
    assert "--perspective" in cmd


# ---------------------------------------------------------------------------
# Test 2: transform override patches the (model …) block in the spliced board.
# ---------------------------------------------------------------------------

def test_angled_patches_model_transform(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    out_png = tmp_path / "out.png"

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d.subprocess.run",
        side_effect=_kicad_cli_mock(captured),
    ):
        render_3d.render_footprint_3d_png_angled(
            lib_dir, mod, out_png,
            offset=(1, 2, 3),
            rotation=(10, 20, 30),
            scale=(1.5, 1.5, 1.5),
        )

    board = captured.get("board", "")
    assert "(offset (xyz 1 2 3))" in board
    assert "(rotate (xyz 10 20 30))" in board
    assert "(scale (xyz 1.5 1.5 1.5))" in board
    # The original baseline values must be gone (otherwise the patch silently
    # left a duplicate or didn't replace the right block).
    assert "(offset (xyz 0 0 0))" not in board
    assert "(rotate (xyz 0 0 0))" not in board
    assert "(scale (xyz 1 1 1))" not in board


# ---------------------------------------------------------------------------
# Test 3: no override → original transform survives unchanged.
# ---------------------------------------------------------------------------

def test_angled_no_override_keeps_original_transform(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    out_png = tmp_path / "out.png"

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d.subprocess.run",
        side_effect=_kicad_cli_mock(captured),
    ):
        render_3d.render_footprint_3d_png_angled(lib_dir, mod, out_png)

    board = captured.get("board", "")
    # _make_sample_kicad_mod seeds (offset 0 0 0) (scale 1 1 1) (rotate 0 0 0).
    assert "(offset (xyz 0 0 0))" in board
    assert "(rotate (xyz 0 0 0))" in board
    assert "(scale (xyz 1 1 1))" in board


# ---------------------------------------------------------------------------
# Test 4: partial override (only offset, no rotation/scale) is treated as
# "no override" — the API requires all-or-nothing to keep the call site simple.
# ---------------------------------------------------------------------------

def test_angled_partial_override_is_ignored(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    out_png = tmp_path / "out.png"

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d.subprocess.run",
        side_effect=_kicad_cli_mock(captured),
    ):
        render_3d.render_footprint_3d_png_angled(
            lib_dir, mod, out_png, offset=(9, 9, 9),  # no rotation/scale
        )

    board = captured.get("board", "")
    # Original values intact — partial override silently ignored.
    assert "(offset (xyz 0 0 0))" in board
    assert "(offset (xyz 9 9 9))" not in board


# ---------------------------------------------------------------------------
# Test 5: kicad-cli failure surfaces as RuntimeError carrying stderr.
# ---------------------------------------------------------------------------

def test_angled_kicad_cli_failure_raises(tmp_path: Path):
    import pytest
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    out_png = tmp_path / "out.png"

    def _fake_fail(cmd, capture_output, text, env=None):  # noqa: ARG001
        return subprocess.CompletedProcess(
            cmd, 5, stdout="", stderr="Failed to load board"
        )

    with patch("kibrary_sidecar.render_3d.subprocess.run", side_effect=_fake_fail):
        with pytest.raises(RuntimeError, match="Failed to load board"):
            render_3d.render_footprint_3d_png_angled(lib_dir, mod, out_png)


# ---------------------------------------------------------------------------
# Test 6: _patch_model_transform is a no-op when there is no (model …) block.
# Important so an angled render of a footprint without a 3D model doesn't
# crash — we want the (probably empty) PCB-only render to fall through.
# ---------------------------------------------------------------------------

def test_patch_model_transform_no_model_block():
    text = '(footprint "Foo" (layer "F.Cu") (fp_circle (center 0 0) (end 1 0)))'
    out = render_3d._patch_model_transform(text, (1, 2, 3), (10, 20, 30), (1.5, 1.5, 1.5))
    assert out == text


# ---------------------------------------------------------------------------
# Test 7: zoom kwarg flows through to kicad-cli's --zoom <factor>.
# The 3D viewer uses this to actually move the camera (not just CSS-scale
# the PNG), so the assertion is strict on a non-default value.
# ---------------------------------------------------------------------------

def test_render_passes_zoom_arg(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    out_png = tmp_path / "out.png"

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d.subprocess.run",
        side_effect=_kicad_cli_mock(captured),
    ):
        render_3d.render_footprint_3d_png_angled(
            lib_dir, mod, out_png, zoom=2.5,
        )

    cmd = captured["cmd"]
    assert "--zoom" in cmd
    assert cmd[cmd.index("--zoom") + 1] == "2.5"


# ---------------------------------------------------------------------------
# Test 8: quality kwarg flows through to kicad-cli's --quality.
# The interactive renderer drops to ``basic`` during drag and ramps back up
# on release, so we need to confirm a non-default value is forwarded verbatim.
# ---------------------------------------------------------------------------

def test_render_passes_quality_arg(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    out_png = tmp_path / "out.png"

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d.subprocess.run",
        side_effect=_kicad_cli_mock(captured),
    ):
        render_3d.render_footprint_3d_png_angled(
            lib_dir, mod, out_png, quality="high",
        )

    cmd = captured["cmd"]
    assert "--quality" in cmd
    assert cmd[cmd.index("--quality") + 1] == "high"


# ---------------------------------------------------------------------------
# Test 9: default zoom is always passed explicitly (--zoom 1) so kicad-cli's
# behaviour is deterministic and never relies on its own internal default.
# ---------------------------------------------------------------------------

def test_render_default_zoom_is_1(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    out_png = tmp_path / "out.png"

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d.subprocess.run",
        side_effect=_kicad_cli_mock(captured),
    ):
        render_3d.render_footprint_3d_png_angled(lib_dir, mod, out_png)

    cmd = captured["cmd"]
    assert "--zoom" in cmd
    assert cmd[cmd.index("--zoom") + 1] == "1.0"


# ---------------------------------------------------------------------------
# Test 10: default quality is always passed explicitly (--quality basic).
# ---------------------------------------------------------------------------

def test_render_default_quality_is_basic(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    out_png = tmp_path / "out.png"

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d.subprocess.run",
        side_effect=_kicad_cli_mock(captured),
    ):
        render_3d.render_footprint_3d_png_angled(lib_dir, mod, out_png)

    cmd = captured["cmd"]
    assert "--quality" in cmd
    assert cmd[cmd.index("--quality") + 1] == "basic"


# ---------------------------------------------------------------------------
# Test 11: zero or negative zoom is rejected up-front with ValueError —
# kicad-cli accepts these silently and produces a black/garbage render,
# so we filter at the sidecar boundary.
# ---------------------------------------------------------------------------

def test_render_rejects_zero_or_negative_zoom(tmp_path: Path):
    import pytest
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    out_png = tmp_path / "out.png"

    with pytest.raises(ValueError, match="zoom"):
        render_3d.render_footprint_3d_png_angled(lib_dir, mod, out_png, zoom=0)

    with pytest.raises(ValueError, match="zoom"):
        render_3d.render_footprint_3d_png_angled(lib_dir, mod, out_png, zoom=-1)


# ---------------------------------------------------------------------------
# Test 12: unknown quality value is rejected with ValueError before any
# subprocess is spawned. kicad-cli's accepted set is fixed
# {basic, high, user, job_settings}.
# ---------------------------------------------------------------------------

def test_render_rejects_unknown_quality(tmp_path: Path):
    import pytest
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    out_png = tmp_path / "out.png"

    with pytest.raises(ValueError, match="quality"):
        render_3d.render_footprint_3d_png_angled(
            lib_dir, mod, out_png, quality="ultra",
        )
