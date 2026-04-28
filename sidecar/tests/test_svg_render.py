"""Tests for svg_render.py — alpha.18 kicad-cli SVG rendering.

Most assertions mock the subprocess so we don't shell out to kicad-cli on
every test run, but we DO verify the command line we hand to kicad-cli is
the one the binary actually accepts (validated empirically against KiCad
9.0 in the smoke environment).
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from kibrary_sidecar import svg_render


def _ok_proc(cmd):
    return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")


def test_render_symbol_invokes_kicad_cli_correctly(tmp_path: Path):
    sym = tmp_path / "Demo.kicad_sym"
    sym.write_text("(kicad_symbol_lib)\n")  # content is irrelevant, kicad-cli is mocked

    captured = {}
    def _spy(cmd, capture_output, text, env=None):  # noqa: ARG001
        captured["cmd"] = list(cmd)
        # Simulate kicad-cli writing the SVG.
        out_dir = Path(cmd[cmd.index("--output") + 1])
        (out_dir / "C25804.svg").write_text("<svg>OK</svg>", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    with patch("subprocess.run", side_effect=_spy):
        svg = svg_render.render_symbol_svg(sym, "C25804")
    assert "<svg>OK</svg>" in svg
    cmd = captured["cmd"]
    # Must use `sym export svg --symbol <name>` form
    assert cmd[:4] == ["kicad-cli", "sym", "export", "svg"]
    assert "--symbol" in cmd and cmd[cmd.index("--symbol") + 1] == "C25804"
    assert "--output" in cmd
    assert str(sym) in cmd


def test_render_footprint_invokes_kicad_cli_correctly(tmp_path: Path):
    pretty = tmp_path / "Demo.pretty"
    pretty.mkdir()

    captured = {}
    def _spy(cmd, capture_output, text, env=None):  # noqa: ARG001
        captured["cmd"] = list(cmd)
        out_dir = Path(cmd[cmd.index("--output") + 1])
        (out_dir / "C25804.svg").write_text("<svg>FP</svg>", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    with patch("subprocess.run", side_effect=_spy):
        svg = svg_render.render_footprint_svg(pretty, "C25804")
    assert "<svg>FP</svg>" in svg
    cmd = captured["cmd"]
    assert cmd[:4] == ["kicad-cli", "fp", "export", "svg"]
    assert "--footprint" in cmd and cmd[cmd.index("--footprint") + 1] == "C25804"
    assert "--layers" in cmd
    assert str(pretty) in cmd


def test_render_symbol_raises_when_kicad_cli_fails(tmp_path: Path):
    sym = tmp_path / "Demo.kicad_sym"
    sym.write_text("(kicad_symbol_lib)\n")

    def _fail(cmd, capture_output, text, env=None):  # noqa: ARG001
        return subprocess.CompletedProcess(
            cmd, 1, stdout="", stderr="symbol 'C25804' not found in library"
        )

    with patch("subprocess.run", side_effect=_fail):
        with pytest.raises(RuntimeError, match="symbol 'C25804' not found"):
            svg_render.render_symbol_svg(sym, "C25804")


def test_render_symbol_raises_when_no_svg_produced(tmp_path: Path):
    sym = tmp_path / "Demo.kicad_sym"
    sym.write_text("(kicad_symbol_lib)\n")

    def _no_output(cmd, capture_output, text, env=None):  # noqa: ARG001
        # Don't write anything; simulate kicad-cli silently producing nothing.
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    with patch("subprocess.run", side_effect=_no_output):
        with pytest.raises(FileNotFoundError):
            svg_render.render_symbol_svg(sym, "C25804")


def test_render_symbol_picks_most_recent_svg_by_mtime(tmp_path: Path):
    """kicad-cli versions disagree on output filename; pick the freshest .svg."""
    sym = tmp_path / "Demo.kicad_sym"
    sym.write_text("(kicad_symbol_lib)\n")

    def _two_svgs(cmd, capture_output, text, env=None):  # noqa: ARG001
        import time
        out_dir = Path(cmd[cmd.index("--output") + 1])
        old = out_dir / "stale.svg"
        old.write_text("OLD", encoding="utf-8")
        time.sleep(0.02)  # ensure mtime differs
        new = out_dir / "C25804.svg"
        new.write_text("NEW", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    with patch("subprocess.run", side_effect=_two_svgs):
        svg = svg_render.render_symbol_svg(sym, "C25804")
    assert svg == "NEW"
