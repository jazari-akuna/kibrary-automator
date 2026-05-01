"""Tests for render_3d_glb.py — kicad-cli pcb export glb shell-out.

The module is a sibling of :mod:`render_3d` and reuses its sanitiser /
splice / transform-patch helpers. We only mock ``subprocess.run`` here;
the GLB byte content is fabricated by the mock.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from kibrary_sidecar import render_3d_glb
from tests.test_render_3d import _make_sample_kicad_mod


# ---------------------------------------------------------------------------
# Mock helper — kicad-cli pcb export glb writes binary glTF v2 bytes to -o.
# Captures the command + the spliced board file so tests can assert what
# was sent to kicad-cli.
# ---------------------------------------------------------------------------

# Binary glTF v2 magic: ASCII "glTF" + uint32 version=2 (little-endian).
_GLB_MAGIC = b"glTF\x02\x00\x00\x00"


def _kicad_cli_glb_mock(captured: dict):
    """Mock ``subprocess.run`` for the single ``kicad-cli pcb export glb``
    invocation render_3d_glb makes. Captures the argv + the spliced board
    text so tests can assert both, and writes a fake GLB at the -o path
    so the post-check passes."""
    def _run(cmd, capture_output=True, text=True, env=None):  # noqa: ARG001
        if cmd[0] == "kicad-cli":
            captured["cmd"] = list(cmd)
            captured["env"] = dict(env) if env is not None else None
            # Snapshot the spliced board so tests can assert what was
            # sent to kicad-cli (e.g. transform-override patch verified
            # by reading the (model …) block back from this file).
            board_path = Path(cmd[-1])
            if board_path.is_file():
                captured["board"] = board_path.read_text(encoding="utf-8")
            # -o sits two positions after "glb". Locate by flag to be
            # robust to argv ordering changes.
            out_idx = cmd.index("-o") + 1
            # Fabricate a minimal GLB: header + zero-length JSON+BIN
            # chunks would be more faithful, but the function only
            # reads bytes back — the magic prefix is what tests check.
            Path(cmd[out_idx]).write_bytes(_GLB_MAGIC + b"\x00" * 64)
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        raise RuntimeError(f"unexpected subprocess call: {cmd}")
    return _run


# ---------------------------------------------------------------------------
# Test 1: argv shape — kicad-cli pcb export glb -o <out> <board>.
# ---------------------------------------------------------------------------

def test_glb_invokes_pcb_export_glb(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run",
        side_effect=_kicad_cli_glb_mock(captured),
    ):
        render_3d_glb.render_footprint_3d_glb(lib_dir, mod)

    cmd = captured["cmd"]
    assert cmd[0] == "kicad-cli"
    assert cmd[1] == "pcb"
    assert cmd[2] == "export"
    assert cmd[3] == "glb"
    assert "-o" in cmd
    out_idx = cmd.index("-o") + 1
    assert cmd[out_idx].endswith(".glb")
    # Last positional is the spliced .kicad_pcb the splice helper wrote.
    assert cmd[-1].endswith(".kicad_pcb")


# ---------------------------------------------------------------------------
# Test 2: returned bytes start with the binary glTF magic header.
# ---------------------------------------------------------------------------

def test_glb_returns_bytes_with_glb_magic(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run",
        side_effect=_kicad_cli_glb_mock(captured),
    ):
        data = render_3d_glb.render_footprint_3d_glb(lib_dir, mod)

    assert isinstance(data, bytes)
    assert len(data) > 0
    # The 4-byte magic is the contract three.js's GLTFLoader sniffs to
    # decide between glTF (JSON) and GLB (binary). If we ever switch to
    # the JSON glTF variant this assertion will catch it loudly.
    assert data.startswith(b"glTF"), (
        f"GLB bytes should start with 'glTF' magic, got: {data[:8]!r}"
    )


# ---------------------------------------------------------------------------
# Test 3: kicad-cli failure surfaces as RuntimeError carrying stderr.
# ---------------------------------------------------------------------------

def test_glb_kicad_cli_failure_raises(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)

    def _fake_fail(cmd, capture_output, text, env=None):  # noqa: ARG001
        return subprocess.CompletedProcess(
            cmd, 7, stdout="", stderr="Failed to load board"
        )

    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run", side_effect=_fake_fail
    ):
        with pytest.raises(RuntimeError, match="Failed to load board"):
            render_3d_glb.render_footprint_3d_glb(lib_dir, mod)


# ---------------------------------------------------------------------------
# Test 4: transform override patches the (model …) block in the spliced
# board (mirrors test_angled_patches_model_transform). Requires all three
# of offset/rotation/scale — the underlying _sanitise_footprint silently
# ignores partial overrides.
# ---------------------------------------------------------------------------

def test_glb_patches_model_transform_when_overridden(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run",
        side_effect=_kicad_cli_glb_mock(captured),
    ):
        render_3d_glb.render_footprint_3d_glb(
            lib_dir,
            mod,
            offset=(1, 2, 3),
            rotation=(10, 20, 30),
            scale=(1.5, 1.5, 1.5),
        )

    board = captured.get("board", "")
    assert "(offset (xyz 1 2 3))" in board
    assert "(rotate (xyz 10 20 30))" in board
    assert "(scale (xyz 1.5 1.5 1.5))" in board
    # Original baseline values must be gone — otherwise the patch silently
    # left a duplicate or didn't replace the right block.
    assert "(offset (xyz 0 0 0))" not in board
    assert "(rotate (xyz 0 0 0))" not in board
    assert "(scale (xyz 1 1 1))" not in board


# ---------------------------------------------------------------------------
# Test 5: no override → original transform survives unchanged. Mirrors
# test_angled_no_override_keeps_original_transform.
# ---------------------------------------------------------------------------

def test_glb_no_overrides_keeps_original_transform(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run",
        side_effect=_kicad_cli_glb_mock(captured),
    ):
        render_3d_glb.render_footprint_3d_glb(lib_dir, mod)

    board = captured.get("board", "")
    # _make_sample_kicad_mod seeds (offset 0 0 0) (scale 1 1 1) (rotate 0 0 0).
    assert "(offset (xyz 0 0 0))" in board
    assert "(rotate (xyz 0 0 0))" in board
    assert "(scale (xyz 1 1 1))" in board


# ---------------------------------------------------------------------------
# Test 6: missing footprint file — raise FileNotFoundError before any
# subprocess work.
# ---------------------------------------------------------------------------

def test_glb_raises_when_footprint_file_missing(tmp_path: Path):
    lib_dir = tmp_path / "lib"
    lib_dir.mkdir()
    bogus = lib_dir / "missing.kicad_mod"

    with pytest.raises(FileNotFoundError):
        render_3d_glb.render_footprint_3d_glb(lib_dir, bogus)


# ---------------------------------------------------------------------------
# Test 7: env scrub — LD_LIBRARY_PATH_ORIG is restored to LD_LIBRARY_PATH
# so kicad-cli doesn't inherit PyInstaller's bundled libs.
# ---------------------------------------------------------------------------

def test_glb_strips_pyinstaller_ld_library_path(tmp_path: Path, monkeypatch):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)

    monkeypatch.setenv("LD_LIBRARY_PATH", "/tmp/_MEIxxxx")
    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/usr/lib/x86_64-linux-gnu")

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run",
        side_effect=_kicad_cli_glb_mock(captured),
    ):
        render_3d_glb.render_footprint_3d_glb(lib_dir, mod)

    env = captured["env"]
    assert env.get("LD_LIBRARY_PATH") == "/usr/lib/x86_64-linux-gnu"
    assert "LD_LIBRARY_PATH_ORIG" not in env


# ---------------------------------------------------------------------------
# Test 8: the GLB pipeline reuses render_3d's _splice_into_template, so the
# spliced board it sends to kicad-cli must carry the static Edge.Cuts
# outline. Without it, ``kicad-cli pcb export glb`` derives the substrate
# from the footprint bounding box and the resulting GLB has a tiny PCB
# plane — the exact bug this guards against.
# ---------------------------------------------------------------------------

def test_glb_spliced_board_has_edge_cuts_outline(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path, name="OutlineProbe")

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run",
        side_effect=_kicad_cli_glb_mock(captured),
    ):
        render_3d_glb.render_footprint_3d_glb(lib_dir, mod)

    board = captured.get("board", "")
    assert '(layer "Edge.Cuts")' in board
    assert "gr_rect" in board
    assert "(start -20 -20)" in board
    assert "(end 20 20)" in board
