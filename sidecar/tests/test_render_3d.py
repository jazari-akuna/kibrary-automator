"""Tests for render_3d.py — kicad-cli pcb render shell-out.

The implementation no longer depends on pcbnew (it splices the
``.kicad_mod`` directly into a static empty-board template), so these
tests only need to mock ``subprocess.run`` for the kicad-cli call.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from kibrary_sidecar import render_3d


def _make_sample_kicad_mod(tmp_path: Path, name: str = "TestFP") -> tuple[Path, Path]:
    """Create a minimal .pretty + .3dshapes + .kicad_mod under *tmp_path*."""
    lib_dir = tmp_path / "Connector_KSL"
    pretty = lib_dir / "Connector_KSL.pretty"
    shapes = lib_dir / "Connector_KSL.3dshapes"
    pretty.mkdir(parents=True)
    shapes.mkdir(parents=True)

    mod = pretty / f"{name}.kicad_mod"
    mod.write_text(
        f'(footprint "{name}" (layer "F.Cu")\n'
        '  (fp_circle (center 0 0) (end 1 0) (layer User.Comments) (width 0.1))\n'
        '  (fp_line (start 0 0) (end 1 0) (layer "User.Drawings") (width 0.1))\n'
        f'  (model "${{KSL_ROOT}}/Connector_KSL/Connector_KSL.3dshapes/{name}.step"\n'
        '    (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))\n'
        '  )\n'
        ')\n',
        encoding="utf-8",
    )
    (shapes / f"{name}.step").write_text("FAKE_STEP", encoding="utf-8")
    return lib_dir, mod


def _kicad_cli_mock(captured: dict):
    """Mock that handles the single subprocess call render_3d makes:
    ``kicad-cli pcb render``. Captures the command and writes a fake PNG
    to the requested --output path so the post-check passes.
    """
    def _run(cmd, capture_output=True, text=True, env=None):  # noqa: ARG001
        if cmd[0] == "kicad-cli":
            captured["cmd"] = list(cmd)
            captured["env"] = dict(env) if env is not None else None
            # Snapshot the spliced board so tests can assert what was sent
            # to kicad-cli.
            board_path = Path(cmd[-1])
            if board_path.is_file():
                captured["board"] = board_path.read_text(encoding="utf-8")
            out_idx = cmd.index("--output") + 1
            Path(cmd[out_idx]).write_bytes(b"\x89PNG\r\n\x1a\nfake")
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        raise RuntimeError(f"unexpected subprocess call: {cmd}")
    return _run


# ---------------------------------------------------------------------------
# Test 1: command shape
# ---------------------------------------------------------------------------

def test_render_invokes_kicad_cli_with_correct_command(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    out_png = tmp_path / "out" / "test.png"

    captured: dict = {}
    with patch("kibrary_sidecar.render_3d.subprocess.run",
               side_effect=_kicad_cli_mock(captured)):
        render_3d.render_footprint_3d_png(lib_dir, mod, out_png, width=600, height=400)

    cmd = captured["cmd"]
    assert cmd[0] == "kicad-cli"
    assert cmd[1] == "pcb"
    assert cmd[2] == "render"
    assert "--output" in cmd
    assert cmd[cmd.index("--output") + 1] == str(out_png)
    assert "--width" in cmd
    assert cmd[cmd.index("--width") + 1] == "600"
    assert "--height" in cmd
    assert cmd[cmd.index("--height") + 1] == "400"
    assert "--side" in cmd
    assert cmd[cmd.index("--side") + 1] == "top"
    assert cmd[-1].endswith(".kicad_pcb")

    assert out_png.is_file()
    assert out_png.read_bytes().startswith(b"\x89PNG")


# ---------------------------------------------------------------------------
# Test 2: error capture — non-zero kicad-cli exit becomes RuntimeError
# carrying the stderr text.
# ---------------------------------------------------------------------------

def test_render_raises_runtime_error_with_stderr(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    out_png = tmp_path / "out.png"

    def _fake_fail(cmd, capture_output, text, env=None):  # noqa: ARG001
        return subprocess.CompletedProcess(
            cmd, 3, stdout="", stderr="Failed to load board"
        )

    with patch("kibrary_sidecar.render_3d.subprocess.run", side_effect=_fake_fail):
        with pytest.raises(RuntimeError, match="Failed to load board"):
            render_3d.render_footprint_3d_png(lib_dir, mod, out_png)


# ---------------------------------------------------------------------------
# Test 3: file-not-detected — kicad-cli returns 0 but no PNG appears.
# ---------------------------------------------------------------------------

def test_render_raises_filenotfound_when_no_png(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    out_png = tmp_path / "out.png"

    def _fake_silent(cmd, capture_output, text, env=None):  # noqa: ARG001
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    with patch("kibrary_sidecar.render_3d.subprocess.run", side_effect=_fake_silent):
        with pytest.raises(FileNotFoundError):
            render_3d.render_footprint_3d_png(lib_dir, mod, out_png)


# ---------------------------------------------------------------------------
# Test 4: model-path resolution — `${KSL_ROOT}` is expanded to the parent
# of lib_dir, and the spliced board sees an absolute path.
# ---------------------------------------------------------------------------

def test_model_path_expanded_to_absolute(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path, name="MyPart")
    out_png = tmp_path / "out.png"

    captured: dict = {}
    with patch("kibrary_sidecar.render_3d.subprocess.run",
               side_effect=_kicad_cli_mock(captured)):
        render_3d.render_footprint_3d_png(lib_dir, mod, out_png)

    board = captured.get("board", "")
    expected_step = lib_dir / "Connector_KSL.3dshapes" / "MyPart.step"
    assert str(expected_step) in board, (
        f"expected {expected_step!s} in spliced board, got:\n{board[:2000]}"
    )


# ---------------------------------------------------------------------------
# Test 5: legacy layer aliases — the kicad-cli pcb loader rejects
# ``(layer "User.Comments")`` and friends (it rescues them to "Rescue"
# which the loader then refuses), so the sanitiser must rewrite both
# bare and quoted forms to the canonical name BEFORE splice.
# ---------------------------------------------------------------------------

def test_layer_aliases_rewritten_in_spliced_board(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    out_png = tmp_path / "out.png"

    captured: dict = {}
    with patch("kibrary_sidecar.render_3d.subprocess.run",
               side_effect=_kicad_cli_mock(captured)):
        render_3d.render_footprint_3d_png(lib_dir, mod, out_png)

    board = captured.get("board", "")
    # Bare form rewritten
    assert "(layer User.Comments)" not in board
    # Quoted legacy alias rewritten
    assert '(layer "User.Comments")' not in board
    assert '(layer "User.Drawings")' not in board
    # Canonical names appear in the rewritten footprint
    assert '(layer "Cmts.User")' in board
    assert '(layer "Dwgs.User")' in board


# ---------------------------------------------------------------------------
# Test 6: spliced board structure — the footprint must land inside the
# outer (kicad_pcb …) form, the template's (layers) table must be intact,
# and the result must end with the matching closing ).
# ---------------------------------------------------------------------------

def test_spliced_board_well_formed(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path, name="SpliceProbe")
    out_png = tmp_path / "out.png"

    captured: dict = {}
    with patch("kibrary_sidecar.render_3d.subprocess.run",
               side_effect=_kicad_cli_mock(captured)):
        render_3d.render_footprint_3d_png(lib_dir, mod, out_png)

    board = captured["board"]
    assert board.startswith("(kicad_pcb")
    assert board.rstrip().endswith(")")
    # Template's layers table preserved
    assert '(19 "Cmts.User" user "User.Comments")' in board
    # Footprint embedded
    assert '(footprint "SpliceProbe"' in board
    # Top-level paren depth balances to zero
    depth = 0
    in_str = False
    for ch in board:
        if ch == '"':
            in_str = not in_str
        elif not in_str:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                assert depth >= 0
    assert depth == 0


# ---------------------------------------------------------------------------
# Test 7: env scrub — LD_LIBRARY_PATH_ORIG is restored to LD_LIBRARY_PATH
# so kicad-cli doesn't inherit PyInstaller's bundled libs.
# ---------------------------------------------------------------------------

def test_render_strips_pyinstaller_ld_library_path(tmp_path: Path, monkeypatch):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    out_png = tmp_path / "out.png"

    monkeypatch.setenv("LD_LIBRARY_PATH", "/tmp/_MEIxxxx")
    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/usr/lib/x86_64-linux-gnu")

    captured: dict = {}
    with patch("kibrary_sidecar.render_3d.subprocess.run",
               side_effect=_kicad_cli_mock(captured)):
        render_3d.render_footprint_3d_png(lib_dir, mod, out_png)

    env = captured["env"]
    assert env.get("LD_LIBRARY_PATH") == "/usr/lib/x86_64-linux-gnu"
    assert "LD_LIBRARY_PATH_ORIG" not in env


# ---------------------------------------------------------------------------
# Test 8: missing footprint file — raise FileNotFoundError before any
# subprocess work.
# ---------------------------------------------------------------------------

def test_render_raises_when_footprint_file_missing(tmp_path: Path):
    lib_dir = tmp_path / "lib"
    lib_dir.mkdir()
    bogus = lib_dir / "missing.kicad_mod"
    out_png = tmp_path / "out.png"

    with pytest.raises(FileNotFoundError):
        render_3d.render_footprint_3d_png(lib_dir, bogus, out_png)


# ---------------------------------------------------------------------------
# Test 9: empty-board template carries an Edge.Cuts outline so kicad-cli
# does NOT auto-derive the substrate from the footprint bounding box (which
# yields a near-zero margin around the part). A static centered rectangle
# guarantees a generous visual margin in both PNG and GLB renders.
# ---------------------------------------------------------------------------

def test_template_has_edge_cuts_outline():
    board = render_3d._splice_into_template('(footprint "Probe" (layer "F.Cu"))')
    # The static outline must be present on the Edge.Cuts layer.
    assert '(layer "Edge.Cuts")' in board
    assert "gr_rect" in board
    # 40 mm × 40 mm centered at origin → corners at ±20.
    assert "(start -20 -20)" in board
    assert "(end 20 20)" in board


# ---------------------------------------------------------------------------
# Test 10: the static outline must be centered at (0,0) so that any
# spliced footprint (also placed at the origin) sits in the middle of the
# substrate. This catches accidental drift if someone re-tunes the size.
# ---------------------------------------------------------------------------

def test_template_outline_is_centered_at_origin():
    board = render_3d._splice_into_template('(footprint "Probe" (layer "F.Cu"))')
    match = re.search(
        r'\(gr_rect\s+\(start\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\)\s+'
        r'\(end\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\)',
        board,
    )
    assert match is not None, f"gr_rect not found in board:\n{board}"
    sx, sy, ex, ey = (float(g) for g in match.groups())
    # Symmetric about the origin on both axes.
    assert abs(sx) == abs(ex), f"x not symmetric: start={sx} end={ex}"
    assert abs(sy) == abs(ey), f"y not symmetric: start={sy} end={ey}"
    assert sx < 0 < ex, f"x range does not span origin: start={sx} end={ex}"
    assert sy < 0 < ey, f"y range does not span origin: start={sy} end={ey}"
    # And big enough to give a visibly larger PCB than the part: at least
    # 30 mm side, so even a SOIC-16 (~10 mm) has clear margin around it.
    assert (ex - sx) >= 30, f"outline width too small: {ex - sx}"
    assert (ey - sy) >= 30, f"outline height too small: {ey - sy}"


# ---------------------------------------------------------------------------
# Test 11: the Edge.Cuts outline survives the splice — i.e. it must be
# present in the final board text alongside the spliced footprint, and
# top-level paren depth must still balance to zero.
# ---------------------------------------------------------------------------

def test_spliced_board_keeps_edge_cuts_outline(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path, name="OutlineProbe")
    out_png = tmp_path / "out.png"

    captured: dict = {}
    with patch("kibrary_sidecar.render_3d.subprocess.run",
               side_effect=_kicad_cli_mock(captured)):
        render_3d.render_footprint_3d_png(lib_dir, mod, out_png)

    board = captured["board"]
    assert '(layer "Edge.Cuts")' in board
    assert "gr_rect" in board
    assert '(footprint "OutlineProbe"' in board

    # Paren balance still holds after the addition.
    depth = 0
    in_str = False
    for ch in board:
        if ch == '"':
            in_str = not in_str
        elif not in_str:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                assert depth >= 0
    assert depth == 0
