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


def _seed_dir_with_svg(svg_text: str = '<svg>x</svg>'):
    """Patch kicad-cli to drop a single .svg in the tmp output dir."""
    def _fake_run(cmd, check, capture_output):  # noqa: ARG001 — match real signature
        # cmd[-2] is `--output <tmp_dir>` ... actually find by flag.
        out_dir = None
        for i, a in enumerate(cmd):
            if a == "--output" and i + 1 < len(cmd):
                out_dir = Path(cmd[i + 1])
                break
        # Find the symbol/footprint name to make the filename right.
        name = None
        for flag in ("--symbol", "--footprint"):
            if flag in cmd:
                name = cmd[cmd.index(flag) + 1]
                break
        assert out_dir is not None
        (out_dir / f"{name or 'out'}.svg").write_text(svg_text, encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, b"", b"")
    return _fake_run


def test_render_symbol_invokes_kicad_cli_correctly(tmp_path: Path):
    sym = tmp_path / "Demo.kicad_sym"
    sym.write_text("(kicad_symbol_lib)\n")  # content is irrelevant, kicad-cli is mocked

    captured = {}
    def _spy(cmd, check, capture_output):  # noqa: ARG001
        captured["cmd"] = list(cmd)
        # Simulate kicad-cli writing the SVG.
        out_dir = Path(cmd[cmd.index("--output") + 1])
        (out_dir / "C25804.svg").write_text("<svg>OK</svg>", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, b"", b"")

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
    def _spy(cmd, check, capture_output):  # noqa: ARG001
        captured["cmd"] = list(cmd)
        out_dir = Path(cmd[cmd.index("--output") + 1])
        (out_dir / "C25804.svg").write_text("<svg>FP</svg>", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, b"", b"")

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

    with patch(
        "subprocess.run",
        side_effect=subprocess.CalledProcessError(1, "kicad-cli", b"", b"err"),
    ):
        with pytest.raises(subprocess.CalledProcessError):
            svg_render.render_symbol_svg(sym, "C25804")


def test_render_symbol_raises_when_no_svg_produced(tmp_path: Path):
    sym = tmp_path / "Demo.kicad_sym"
    sym.write_text("(kicad_symbol_lib)\n")

    def _no_output(cmd, check, capture_output):  # noqa: ARG001
        # Don't write anything; simulate kicad-cli silently producing nothing.
        return subprocess.CompletedProcess(cmd, 0, b"", b"")

    with patch("subprocess.run", side_effect=_no_output):
        with pytest.raises(FileNotFoundError):
            svg_render.render_symbol_svg(sym, "C25804")


def test_render_symbol_picks_most_recent_svg_by_mtime(tmp_path: Path):
    """kicad-cli versions disagree on output filename; pick the freshest .svg."""
    sym = tmp_path / "Demo.kicad_sym"
    sym.write_text("(kicad_symbol_lib)\n")

    def _two_svgs(cmd, check, capture_output):  # noqa: ARG001
        import time
        out_dir = Path(cmd[cmd.index("--output") + 1])
        old = out_dir / "stale.svg"
        old.write_text("OLD", encoding="utf-8")
        time.sleep(0.02)  # ensure mtime differs
        new = out_dir / "C25804.svg"
        new.write_text("NEW", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, b"", b"")

    with patch("subprocess.run", side_effect=_two_svgs):
        svg = svg_render.render_symbol_svg(sym, "C25804")
    assert svg == "NEW"
