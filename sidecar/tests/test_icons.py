"""Tests for kibrary_sidecar.icons."""

from pathlib import Path
from unittest.mock import MagicMock, patch
import subprocess

import pytest

from kibrary_sidecar.icons import render_footprint_icon, render_for_part


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_pretty(base: Path, lcsc: str) -> Path:
    """Create a minimal .pretty directory with one .kicad_mod file."""
    pretty = base / f"{lcsc}.pretty"
    pretty.mkdir(parents=True, exist_ok=True)
    (pretty / f"{lcsc}.kicad_mod").write_text(
        f'(footprint "{lcsc}" (layer "F.Cu"))\n'
    )
    return pretty


# ---------------------------------------------------------------------------
# Test 1: render_footprint_icon invokes kicad-cli with correct args
# ---------------------------------------------------------------------------

def test_render_footprint_icon_invokes_kicad_cli(tmp_path: Path):
    """mock subprocess.run; assert kicad-cli command and key arguments."""
    pretty_dir = _make_pretty(tmp_path, "C1234")
    out_path = tmp_path / "C1234.icon.svg"

    # We need the mock to actually create an SVG file in the tmp_dir that
    # render_footprint_icon uses internally, otherwise it raises FileNotFoundError.
    # We capture the call and write the expected SVG ourselves.
    captured: list[list[str]] = []

    def fake_run(cmd, **kwargs):
        captured.append(cmd)
        # cmd[-1] is the pretty_dir; the temp dir is at cmd[cmd.index('--output') + 1]
        output_dir_idx = cmd.index("--output") + 1
        output_dir = Path(cmd[output_dir_idx])
        footprint_name_idx = cmd.index("--footprint") + 1
        fp_name = cmd[footprint_name_idx]
        # Write a fake SVG where kicad-cli would put it
        (output_dir / f"{fp_name}.svg").write_text("<svg/>")
        result = MagicMock()
        result.returncode = 0
        return result

    with patch("kibrary_sidecar.icons.subprocess.run", side_effect=fake_run):
        render_footprint_icon(pretty_dir, "C1234", out_path)

    assert len(captured) == 1
    cmd = captured[0]

    # Must call kicad-cli
    assert cmd[0] == "kicad-cli"
    assert cmd[1] == "fp"
    assert cmd[2] == "export"
    assert cmd[3] == "svg"

    # --footprint flag
    assert "--footprint" in cmd
    fp_idx = cmd.index("--footprint")
    assert cmd[fp_idx + 1] == "C1234"

    # --layers flag
    assert "--layers" in cmd

    # --output flag
    assert "--output" in cmd

    # The pretty_dir is the last positional argument
    assert cmd[-1] == str(pretty_dir)

    # Output path was created
    assert out_path.is_file()
    assert out_path.read_text() == "<svg/>"


# ---------------------------------------------------------------------------
# Test 2: render_for_part returns None when no .pretty dir
# ---------------------------------------------------------------------------

def test_render_for_part_returns_none_when_no_pretty_dir(tmp_path: Path):
    """If <part_dir>/<lcsc>.pretty doesn't exist, return None without error."""
    part_dir = tmp_path / "C9999"
    part_dir.mkdir()
    # No .pretty directory created

    result = render_for_part(part_dir, "C9999")

    assert result is None


# ---------------------------------------------------------------------------
# Test 3: render_for_part returns None when kicad-cli fails
# ---------------------------------------------------------------------------

def test_render_for_part_returns_none_when_kicad_cli_fails(tmp_path: Path):
    """When subprocess exits with code 1, render_for_part returns None."""
    part_dir = tmp_path / "C8888"
    _make_pretty(part_dir, "C8888")

    def fake_run_fail(cmd, **kwargs):
        raise subprocess.CalledProcessError(1, cmd)

    with patch("kibrary_sidecar.icons.subprocess.run", side_effect=fake_run_fail):
        result = render_for_part(part_dir, "C8888")

    assert result is None


# ---------------------------------------------------------------------------
# Test 4: render_for_part returns Path on success
# ---------------------------------------------------------------------------

def test_render_for_part_returns_path_on_success(tmp_path: Path):
    """When kicad-cli succeeds, render_for_part returns the SVG path."""
    part_dir = tmp_path / "C7777"
    _make_pretty(part_dir, "C7777")

    def fake_run_ok(cmd, **kwargs):
        output_dir_idx = cmd.index("--output") + 1
        output_dir = Path(cmd[output_dir_idx])
        fp_name_idx = cmd.index("--footprint") + 1
        fp_name = cmd[fp_name_idx]
        (output_dir / f"{fp_name}.svg").write_text("<svg>C7777</svg>")
        result = MagicMock()
        result.returncode = 0
        return result

    with patch("kibrary_sidecar.icons.subprocess.run", side_effect=fake_run_ok):
        result = render_for_part(part_dir, "C7777")

    expected = part_dir / "C7777.icon.svg"
    assert result == expected
    assert expected.is_file()
    assert expected.read_text() == "<svg>C7777</svg>"


# ---------------------------------------------------------------------------
# Test 5: render_for_part returns None when no .kicad_mod in .pretty dir
# ---------------------------------------------------------------------------

def test_render_for_part_returns_none_when_no_kicad_mod(tmp_path: Path):
    """If the .pretty dir exists but is empty, return None."""
    part_dir = tmp_path / "C6666"
    pretty = part_dir / "C6666.pretty"
    pretty.mkdir(parents=True)
    # No .kicad_mod files

    result = render_for_part(part_dir, "C6666")

    assert result is None


# ---------------------------------------------------------------------------
# Test 6: render_footprint_icon raises CalledProcessError on failure
# ---------------------------------------------------------------------------

def test_render_footprint_icon_raises_on_failure(tmp_path: Path):
    """render_footprint_icon propagates CalledProcessError from kicad-cli."""
    pretty_dir = _make_pretty(tmp_path, "C5555")
    out_path = tmp_path / "C5555.icon.svg"

    def fake_run_fail(cmd, **kwargs):
        raise subprocess.CalledProcessError(1, cmd, stderr=b"kicad-cli error")

    with patch("kibrary_sidecar.icons.subprocess.run", side_effect=fake_run_fail):
        with pytest.raises(subprocess.CalledProcessError):
            render_footprint_icon(pretty_dir, "C5555", out_path)
