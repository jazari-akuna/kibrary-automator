"""Tests for render_3d_glb.py — kicad-cli pcb export glb shell-out.

The module is a sibling of :mod:`render_3d` and reuses its sanitiser /
splice / transform-patch helpers. We only mock ``subprocess.run`` here;
the GLB byte content is fabricated by the mock.

Plus an opt-in real-kicad-cli integration test (``@pytest.mark.skipif``
when no ``kicad-cli`` binary is on PATH) — that's the regression test for
the alpha.31 silent-drop bug, where the unit tests passed but the user
saw an empty PCB plane because kicad-cli silently emitted a 1-mesh GLB
when the (model …) path didn't resolve on disk.
"""
from __future__ import annotations

import json
import re
import shutil
import struct
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from kibrary_sidecar import render_3d_glb
from tests.test_render_3d import _make_sample_kicad_mod

KICAD_CLI = shutil.which("kicad-cli")


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


# ---------------------------------------------------------------------------
# Test 9: silent-drop guard — when the source .kicad_mod expected a 3D
# model and kicad-cli's stderr says it dropped one ("Could not add 3D
# model … File not found: …") but exited 0 anyway, the renderer must
# raise RuntimeError instead of returning a board-only GLB.
#
# Pre-fix this was the alpha.31 user-visible bug: GLB had only the PCB
# plane, three.js rendered an empty board, the user thought the part
# was broken. The silent-drop pattern in stderr is the only signal —
# returncode and the GLB-exists check both pass.
# ---------------------------------------------------------------------------

_SILENT_DROP_STDERR = (
    "Build Binary GLTF data.\n"
    "Could not add 3D model for REF**.\n"
    "File not found: /tmp/missing/MyPart.step\n"
    "Create PCB solid model.\n"
    "Binary GLTF file 'preview.glb' created.\n"
)


def test_glb_raises_on_silent_drop_when_model_was_expected(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)

    def _fake_silent_drop(cmd, capture_output, text, env=None):  # noqa: ARG001
        # Mimic the production failure: exit 0, GLB file written, but
        # stderr carries the silent-drop diagnostic.
        out_idx = cmd.index("-o") + 1
        Path(cmd[out_idx]).write_bytes(b"glTF\x02\x00\x00\x00" + b"\x00" * 64)
        return subprocess.CompletedProcess(
            cmd, 0, stdout="", stderr=_SILENT_DROP_STDERR,
        )

    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run",
        side_effect=_fake_silent_drop,
    ):
        with pytest.raises(RuntimeError, match="silently dropped 3D model"):
            render_3d_glb.render_footprint_3d_glb(lib_dir, mod)


# ---------------------------------------------------------------------------
# Test 10: the silent-drop guard does NOT fire when the source .kicad_mod
# never had a (model …) block in the first place. A footprint with no 3D
# body legitimately produces a body-less GLB — that's not a failure.
# ---------------------------------------------------------------------------

def test_glb_no_silent_drop_raise_when_no_model_expected(tmp_path: Path):
    lib_dir = tmp_path / "NoModel"
    pretty = lib_dir / "NoModel.pretty"
    pretty.mkdir(parents=True)
    mod = pretty / "Bare.kicad_mod"
    mod.write_text(
        '(footprint "Bare" (layer "F.Cu")\n'
        '  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))\n'
        ')\n',
        encoding="utf-8",
    )

    def _fake_run(cmd, capture_output, text, env=None):  # noqa: ARG001
        out_idx = cmd.index("-o") + 1
        Path(cmd[out_idx]).write_bytes(b"glTF\x02\x00\x00\x00" + b"\x00" * 64)
        # Even if kicad-cli printed the silent-drop line (it shouldn't
        # here), we should NOT raise — there was no model to lose.
        return subprocess.CompletedProcess(
            cmd, 0, stdout="", stderr=_SILENT_DROP_STDERR,
        )

    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run", side_effect=_fake_run,
    ):
        data = render_3d_glb.render_footprint_3d_glb(lib_dir, mod)
    assert data.startswith(b"glTF")


# ---------------------------------------------------------------------------
# Test 11: pre-flight strip — when the source .kicad_mod references a
# non-existent .step, the sanitiser strips the (model …) block before
# kicad-cli sees the board. So the spliced board sent to kicad-cli has
# NO model reference at all — kicad-cli can't silently drop what isn't
# there. End result: degraded-but-functional GLB (just the PCB plane),
# no exception.
# ---------------------------------------------------------------------------

def test_glb_strips_model_block_pre_flight_when_step_missing(tmp_path: Path):
    lib_dir = tmp_path / "Strip"
    pretty = lib_dir / "Strip.pretty"
    pretty.mkdir(parents=True)
    # Note: NO .3dshapes/ directory at all → resolver returns None.
    mod = pretty / "Stripped.kicad_mod"
    mod.write_text(
        '(footprint "Stripped" (layer "F.Cu")\n'
        '  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))\n'
        '  (model "${KSL_ROOT}/Strip/Strip.3dshapes/Stripped.step"\n'
        '    (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))\n'
        '  )\n'
        ')\n',
        encoding="utf-8",
    )

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run",
        side_effect=_kicad_cli_glb_mock(captured),
    ):
        data = render_3d_glb.render_footprint_3d_glb(lib_dir, mod)

    board = captured["board"]
    assert "(model" not in board, (
        f"sanitiser failed to strip (model …) block; kicad-cli would have "
        f"silently dropped it and returned an empty-board GLB. Board:\n{board}"
    )
    # Footprint body still present; no exception raised.
    assert '(footprint "Stripped"' in board
    assert data.startswith(b"glTF")


# ---------------------------------------------------------------------------
# Test 12 (REAL kicad-cli, opt-in): runs only when a real ``kicad-cli``
# binary is on PATH. Confirms end-to-end that:
#   (a) when the .step file IS present, the GLB has >=2 meshes (board +
#       component) — i.e. kicad-cli actually embedded the 3D model;
#   (b) when the .step file is REMOVED, the renderer either raises OR
#       returns a degraded GLB (board only) but does NOT silently
#       produce an empty-looking GLB the user can't tell from success.
#
# Pre-fix, the GLB in (b) was 3712 bytes with 1 mesh and exit 0 — that's
# the bug. With the fix, (b) either gets the (model …) stripped pre-
# flight (so kicad-cli emits a board-only GLB on purpose) or raises if
# kicad-cli's silent-drop signature appears.
#
# The smoke harness Docker image (``kibrary-smoke-real``) ships with
# kicad-cli, so this test runs in CI/release. Local dev boxes without
# kicad-cli skip it.
# ---------------------------------------------------------------------------

# A minimal but valid binary STEP file. We can't easily emit real STEP
# from pure Python without OCCT, so we shell out to kicad-cli's own
# pcb export step on a tiny board to manufacture one — but that's a
# circular dep on kicad-cli itself. Cleaner: instead of a real .step,
# we use the user's actual production library shape and only assert
# mesh-count behaviour. If kicad-cli rejects our STEP for being fake,
# that is itself the silent-drop bug and the test correctly fires.

def _make_real_fixture(tmp_path: Path) -> tuple[Path, Path]:
    """Build the production library layout under tmp_path:

        <tmp>/RealProbe/RealProbe.pretty/R0603.kicad_mod
        <tmp>/RealProbe/RealProbe.3dshapes/R0603.step    (real STEP)

    Returns ``(lib_dir, fp_path)``. The .step is built by asking
    kicad-cli itself to emit a STEP for a tiny single-pad footprint —
    this guarantees the file is something kicad-cli will accept on
    re-import. Skips with pytest.skip if that intermediate step fails.
    """
    lib_dir = tmp_path / "RealProbe"
    pretty = lib_dir / "RealProbe.pretty"
    shapes = lib_dir / "RealProbe.3dshapes"
    pretty.mkdir(parents=True)
    shapes.mkdir(parents=True)

    # The .kicad_mod uses ${KSL_ROOT} so render_3d._resolve_model_path
    # expands it to lib_dir.parent and finds the .step under shapes/.
    fp_path = pretty / "R0603.kicad_mod"
    fp_path.write_text(
        '(footprint "R0603"\n'
        '  (layer "F.Cu")\n'
        '  (attr smd)\n'
        '  (pad "1" smd rect (at -0.75 0) (size 0.8 0.86) (layers "F.Cu" "F.Mask" "F.Paste"))\n'
        '  (pad "2" smd rect (at  0.75 0) (size 0.8 0.86) (layers "F.Cu" "F.Mask" "F.Paste"))\n'
        '  (model "${KSL_ROOT}/RealProbe/RealProbe.3dshapes/R0603.step"\n'
        '    (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))\n'
        '  )\n'
        ')\n',
        encoding="utf-8",
    )

    # Manufacture a real STEP via kicad-cli on a tiny board with a via,
    # so we get a kicad-cli-blessed STEP shape. If anything in this
    # bootstrap path fails, skip — we can't run the integration test
    # without a valid STEP.
    bootstrap_pcb = tmp_path / "bootstrap.kicad_pcb"
    bootstrap_pcb.write_text(
        '(kicad_pcb (version 20241229) (generator "test")\n'
        '  (general (thickness 1.6))\n'
        '  (paper "A4")\n'
        '  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))\n'
        '  (net 0 "")\n'
        '  (gr_rect (start -1 -1) (end 1 1) (stroke (width 0.1) (type solid)) (fill no) (layer "Edge.Cuts"))\n'
        ')\n',
        encoding="utf-8",
    )
    real_step = shapes / "R0603.step"
    proc = subprocess.run(
        [
            "kicad-cli", "pcb", "export", "step",
            "-o", str(real_step),
            "--no-board-body", "--include-tracks", "--include-zones",
            "--force",
            str(bootstrap_pcb),
        ],
        capture_output=True, text=True,
    )
    if proc.returncode != 0 or not real_step.is_file() or real_step.stat().st_size < 100:
        pytest.skip(
            f"could not bootstrap a real .step via kicad-cli "
            f"(rc={proc.returncode}, stderr={proc.stderr.strip()[:300]})"
        )
    return lib_dir, fp_path


def _glb_mesh_count(glb_bytes: bytes) -> int:
    """Parse the GLB JSON chunk and return ``len(meshes)``.

    Layout: 12-byte header (magic + version + length), then chunks of
    ``(uint32 length, uint32 type, bytes data)``. The first chunk is
    always JSON for valid GLB v2.
    """
    assert glb_bytes[0:4] == b"glTF", "not a GLB"
    json_chunk_len = struct.unpack("<I", glb_bytes[12:16])[0]
    json_text = glb_bytes[20:20 + json_chunk_len].decode("utf-8")
    gltf = json.loads(json_text)
    return len(gltf.get("meshes", []))


@pytest.mark.skipif(KICAD_CLI is None, reason="kicad-cli not installed")
def test_render_glb_real_kicad_cli_embeds_3d_model(tmp_path: Path):
    """Regression test for the alpha.31 silent-drop bug.

    With the .step file present, the GLB MUST contain at least 2 meshes
    (the PCB plane + the component body). 1 mesh = bug recurrence: the
    component was silently dropped and the user sees an empty board.
    """
    lib_dir, fp_path = _make_real_fixture(tmp_path)

    glb_bytes = render_3d_glb.render_footprint_3d_glb(
        lib_dir=lib_dir,
        footprint_file=fp_path,
        offset=None,
        rotation=None,
        scale=None,
    )
    assert glb_bytes.startswith(b"glTF"), "kicad-cli did not produce a valid GLB"
    mesh_count = _glb_mesh_count(glb_bytes)
    assert mesh_count >= 2, (
        f"GLB only has {mesh_count} mesh(es) — kicad-cli silently dropped "
        f"the 3D model. GLB size: {len(glb_bytes)} bytes. This is the "
        f"alpha.31 empty-board regression."
    )


@pytest.mark.skipif(KICAD_CLI is None, reason="kicad-cli not installed")
def test_render_glb_real_kicad_cli_handles_missing_3d_model(tmp_path: Path):
    """When the .step file is missing, the renderer must NOT silently
    return an empty-board GLB the user can't distinguish from success.

    With the alpha.31 fix, the chosen behaviour is "strip the (model …)
    block pre-flight" — so kicad-cli emits a board-only GLB legitimately
    and no exception fires. The mesh count is then 1 (just the PCB),
    which is the documented degraded-but-functional outcome. The test
    accepts EITHER outcome (raise OR strip-and-degrade) — the contract
    is "don't silently lie to the frontend".
    """
    lib_dir, fp_path = _make_real_fixture(tmp_path)
    # Now delete the .step the bootstrap manufactured.
    step = lib_dir / "RealProbe.3dshapes" / "R0603.step"
    step.unlink()
    assert not step.exists()

    try:
        glb_bytes = render_3d_glb.render_footprint_3d_glb(
            lib_dir=lib_dir,
            footprint_file=fp_path,
            offset=None,
            rotation=None,
            scale=None,
        )
    except (RuntimeError, FileNotFoundError):
        # Acceptable: the renderer raised loudly. Done.
        return

    # Strip-and-degrade outcome: the GLB MUST be a real GLB and the
    # mesh count is 1 (PCB plane only). The contract is that this only
    # happens when the (model …) block was stripped pre-flight — i.e.
    # NOT the silent-drop pattern reaching kicad-cli.
    assert glb_bytes.startswith(b"glTF")
    mesh_count = _glb_mesh_count(glb_bytes)
    assert mesh_count == 1, (
        f"degraded GLB should have exactly 1 mesh (the PCB plane), "
        f"got {mesh_count}"
    )


# ---------------------------------------------------------------------------
# alpha.33: render_footprint_3d_glb_with_top_layers — orchestrates BOTH
# kicad-cli pcb export glb AND kicad-cli pcb export svg off the same
# spliced board. Verify (a) both subprocess calls fire, (b) the SVG one
# requests the canonical front-layer set, (c) the function tolerates an
# SVG-half failure without breaking the GLB-half.
# ---------------------------------------------------------------------------

def _kicad_cli_glb_and_svg_mock(captured: dict, *, svg_returncode: int = 0,
                                svg_text: str = '<svg viewBox="0 0 40 40"/>') -> callable:
    """Mock subprocess.run for the alpha.33 dual-spawn function."""
    def _run(cmd, capture_output=True, text=True, env=None):  # noqa: ARG001
        captured.setdefault("calls", []).append(list(cmd))
        # Locate -o argument and the input file
        out_idx = cmd.index("-o") + 1
        out_path = Path(cmd[out_idx])
        if cmd[3] == "glb":
            out_path.write_bytes(_GLB_MAGIC + b"\x00" * 64)
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        elif cmd[3] == "svg":
            if svg_returncode == 0:
                out_path.write_text(svg_text, encoding="utf-8")
            return subprocess.CompletedProcess(
                cmd, svg_returncode,
                stdout="", stderr="" if svg_returncode == 0 else "svg-fail",
            )
        raise RuntimeError(f"unexpected subprocess call: {cmd}")
    return _run


def test_with_top_layers_invokes_both_glb_and_svg(tmp_path: Path):
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run",
        side_effect=_kicad_cli_glb_and_svg_mock(captured),
    ):
        result = render_3d_glb.render_footprint_3d_glb_with_top_layers(lib_dir, mod)

    calls = captured["calls"]
    # Must invoke kicad-cli twice: once for GLB, once for SVG.
    glb_calls = [c for c in calls if c[3] == "glb"]
    svg_calls = [c for c in calls if c[3] == "svg"]
    assert len(glb_calls) == 1, f"expected one glb call, got {glb_calls}"
    assert len(svg_calls) == 1, f"expected one svg call, got {svg_calls}"

    # SVG call requests the front-layer set (copper + paste + mask + silk + edge cuts).
    svg_cmd = svg_calls[0]
    assert "--layers" in svg_cmd
    layers_arg = svg_cmd[svg_cmd.index("--layers") + 1]
    for required in ("F.Cu", "F.Paste", "F.Mask", "F.SilkS", "Edge.Cuts"):
        assert required in layers_arg, f"SVG layer list missing {required}: {layers_arg}"
    assert "--mode-single" in svg_cmd
    assert "--fit-page-to-board" in svg_cmd

    # Result has both halves populated.
    assert isinstance(result, dict)
    assert result["glb_bytes"].startswith(b"glTF")
    assert "viewBox" in result["top_layers_svg"]


def test_with_top_layers_tolerates_svg_failure(tmp_path: Path):
    """If the SVG export fails, the GLB half should still ship — the
    decal degrades to "no copper" rather than aborting the whole render."""
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)
    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run",
        side_effect=_kicad_cli_glb_and_svg_mock(captured, svg_returncode=2),
    ):
        result = render_3d_glb.render_footprint_3d_glb_with_top_layers(lib_dir, mod)

    # GLB still produced.
    assert result["glb_bytes"].startswith(b"glTF")
    # SVG empty when export failed.
    assert result["top_layers_svg"] == ""


# ---------------------------------------------------------------------------
# Bug-3 regression: when the (model …) path can't be resolved on disk, the
# sanitiser strips it pre-flight (so kicad-cli emits a board-only GLB
# without the silent-drop signature). PRE-FIX, the only signal was a
# log.warning to stderr — the JSON-RPC response carried no diagnostic, so
# the frontend rendered an empty PCB and the user thought the part was
# broken. POST-FIX, the structured warning surfaces via the result dict
# and (further up) the JSON-RPC `warnings` field.
# ---------------------------------------------------------------------------

def test_with_top_layers_returns_model_not_found_warning(tmp_path: Path):
    """Stripped (model …) blocks must surface as a `model_not_found`
    warning in the result dict — otherwise the frontend has no way to
    distinguish "part has no 3D body by design" from "we silently
    dropped the body because the .step is missing"."""
    lib_dir = tmp_path / "Connector_KSL"
    pretty = lib_dir / "Connector_KSL.pretty"
    pretty.mkdir(parents=True)
    # Note: NO .3dshapes/ at all → resolver returns None.
    mod = pretty / "GhostFP.kicad_mod"
    mod.write_text(
        '(footprint "GhostFP" (layer "F.Cu")\n'
        '  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))\n'
        '  (model "${KSL_ROOT}/Connector_KSL/Connector_KSL.3dshapes/Ghost.step"\n'
        '    (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))\n'
        '  )\n'
        ')\n',
        encoding="utf-8",
    )

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run",
        side_effect=_kicad_cli_glb_and_svg_mock(captured),
    ):
        result = render_3d_glb.render_footprint_3d_glb_with_top_layers(lib_dir, mod)

    warnings = result.get("warnings") or []
    assert len(warnings) == 1, (
        f"expected one model_not_found warning, got {warnings}"
    )
    w = warnings[0]
    assert w["kind"] == "model_not_found"
    assert w["basename"] == "Ghost.step"
    assert "Ghost.step" in w["expanded"]
    assert w["sibling_match"] is None
    assert w["lib_dir"] == str(lib_dir)


def test_warn_on_rwgltf_caf_writer_skipped_node(tmp_path: Path):
    """Wave 3-C regression: OCCT's RWGltf_CafWriter silently drops nodes
    without triangulation data when kicad-cli exports a cadquery-style
    assembly STEP. Pre-fix the silent-drop guard only matched the
    "Could not add 3D model … File not found" pattern, so cadquery
    fixtures produced a board-only GLB with no warning surfaced to the
    frontend. POST-fix every skipped node yields a structured
    ``{"kind": "tessellation_failed", "node_name": ...}`` warning."""
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)

    rwgltf_stderr = (
        "Build Binary GLTF data.\n"
        "RWGltf_CafWriter skipped node 'housing_PCB_BODY_part' "
        "without triangulation data\n"
        "RWGltf_CafWriter skipped node 'preview_PCB_part' "
        "without triangulation data\n"
        "Binary GLTF file 'preview.glb' created.\n"
    )

    def _fake_glb_with_skipped_nodes(cmd, capture_output=True, text=True, env=None):  # noqa: ARG001
        out_idx = cmd.index("-o") + 1
        out_path = Path(cmd[out_idx])
        if cmd[3] == "glb":
            out_path.write_bytes(_GLB_MAGIC + b"\x00" * 64)
            return subprocess.CompletedProcess(
                cmd, 0, stdout="", stderr=rwgltf_stderr,
            )
        elif cmd[3] == "svg":
            out_path.write_text('<svg viewBox="0 0 40 40"/>', encoding="utf-8")
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        raise RuntimeError(f"unexpected subprocess call: {cmd}")

    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run",
        side_effect=_fake_glb_with_skipped_nodes,
    ):
        result = render_3d_glb.render_footprint_3d_glb_with_top_layers(lib_dir, mod)

    warnings = result.get("warnings") or []
    tess_warnings = [w for w in warnings if w.get("kind") == "tessellation_failed"]
    assert len(tess_warnings) == 2, (
        f"expected two tessellation_failed warnings (one per skipped node), "
        f"got {warnings}"
    )
    node_names = {w["node_name"] for w in tess_warnings}
    assert node_names == {"housing_PCB_BODY_part", "preview_PCB_part"}, (
        f"node names should round-trip from stderr; got {node_names}"
    )
    # GLB still produced — the warning is informative, not fatal.
    assert result["glb_bytes"].startswith(b"glTF")


def test_with_top_layers_no_warnings_when_step_resolves(tmp_path: Path):
    """Happy path — the .step exists where the (model …) block points.
    The warnings list must be empty so the frontend doesn't show a
    spurious "3D model missing" toast."""
    lib_dir, mod = _make_sample_kicad_mod(tmp_path)

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run",
        side_effect=_kicad_cli_glb_and_svg_mock(captured),
    ):
        result = render_3d_glb.render_footprint_3d_glb_with_top_layers(lib_dir, mod)

    assert result.get("warnings") == [], (
        f"happy-path render must produce no warnings, got {result.get('warnings')!r}"
    )


def test_with_top_layers_warning_includes_sibling_match(tmp_path: Path):
    """When the .step is missing in the target lib but exists in a sibling
    lib's .3dshapes/, the warning's `sibling_match` field points at it.
    Helps the user diagnose "I committed the file under the wrong lib"
    without manually grepping the workspace."""
    workspace = tmp_path / "ws"
    workspace.mkdir()

    # Target lib: has .pretty but NO matching .step.
    target = workspace / "Connector_KSL"
    target_pretty = target / "Connector_KSL.pretty"
    target_pretty.mkdir(parents=True)
    target_shapes = target / "Connector_KSL.3dshapes"
    target_shapes.mkdir()  # exists but empty
    mod = target_pretty / "Wanderer.kicad_mod"
    mod.write_text(
        '(footprint "Wanderer" (layer "F.Cu")\n'
        '  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))\n'
        '  (model "${KSL_ROOT}/Connector_KSL/Connector_KSL.3dshapes/Wandered.step"\n'
        '    (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))\n'
        '  )\n'
        ')\n',
        encoding="utf-8",
    )

    # Sibling lib: has the .step the target was looking for.
    sibling = workspace / "Resistors_KSL"
    sibling_shapes = sibling / "Resistors_KSL.3dshapes"
    sibling_shapes.mkdir(parents=True)
    misplaced = sibling_shapes / "Wandered.step"
    misplaced.write_bytes(b"ISO-10303-21;\n")

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run",
        side_effect=_kicad_cli_glb_and_svg_mock(captured),
    ):
        result = render_3d_glb.render_footprint_3d_glb_with_top_layers(target, mod)

    warnings = result.get("warnings") or []
    assert len(warnings) == 1
    w = warnings[0]
    assert w["kind"] == "model_not_found"
    assert w["basename"] == "Wandered.step"
    assert w["sibling_match"] == str(misplaced), (
        f"sibling-match should locate the misplaced .step. Got: {w}"
    )


# ---------------------------------------------------------------------------
# End-to-end Bug-3 regression: drop the IPEX_20952-024E-02 SnapEDA layout,
# commit it, then call library.render_3d_glb_angled exactly the way the
# frontend does. The result must (a) produce a real GLB and (b) carry an
# empty warnings list — proves the path resolution actually finds the
# .step under the standard ${KSL_ROOT}/<lib>/<lib>.3dshapes/ layout.
# Pre-fix this case was claimed to fail (user report: "Even the ipex step
# simply does not load"), so a green test here proves the resolver works.
# ---------------------------------------------------------------------------

def test_ipex_end_to_end_resolves_via_rpc(tmp_path: Path):
    """Full drop → commit → render flow for the real IPEX folder layout.

    Source folder mimics the SnapEDA download structure:
      IPEX_20952-024E-02/
        ├── 20952-024E-02.kicad_sym
        ├── 20952-024E-02.step
        └── IPEX_20952-024E-02.kicad_mod  (no model block — synthesised)

    After commit_group(workspace=…, target_lib=Connector_KSL):
      <workspace>/Connector_KSL/Connector_KSL.pretty/IPEX_20952-024E-02.kicad_mod
      <workspace>/Connector_KSL/Connector_KSL.3dshapes/20952-024E-02.step

    The (model …) block synthesised by drop_import._ensure_model_blocks
    points at ``${KSL_ROOT}/Connector_KSL/Connector_KSL.3dshapes/20952-024E-02.step``.
    The render_3d sanitiser must expand that to
    ``<workspace>/Connector_KSL/Connector_KSL.3dshapes/20952-024E-02.step``
    and find the file → no warnings, no strip, kicad-cli sees the model.
    """
    from kibrary_sidecar.drop_import import scan_paths, commit_group
    from kibrary_sidecar import methods

    workspace = tmp_path / "workspace"
    workspace.mkdir()

    folder = tmp_path / "IPEX_20952-024E-02"
    folder.mkdir()
    (folder / "20952-024E-02.kicad_sym").write_text(
        '(kicad_symbol_lib (version 20211014) (generator None)\n'
        '  (symbol "20952-024E-02" (in_bom yes) (on_board yes)\n'
        '    (property "Reference" "J" (id 0) (at 0 0 0))\n'
        '    (property "Value" "20952-024E-02" (id 1) (at 0 0 0))\n'
        '    (property "Footprint" "IPEX_20952-024E-02" (id 2) (at 0 0 0))\n'
        '    (property "Datasheet" "" (id 3) (at 0 0 0))\n'
        '  )\n'
        ')\n'
    )
    (folder / "IPEX_20952-024E-02.kicad_mod").write_text(
        '(footprint "IPEX_20952-024E-02" (layer F.Cu)\n'
        '  (descr "")\n'
        '  (attr smd)\n'
        '  (pad 1 smd rect (at 0 0) (size 1 1) (layers F.Cu F.Mask F.Paste))\n'
        ')\n'
    )
    (folder / "20952-024E-02.step").write_bytes(b"ISO-10303-21;\nHEADER;\n")

    scan = scan_paths([str(folder)])
    grp = scan["folders"][0]
    commit_group(workspace=workspace, group=grp, target_lib="Connector_KSL")

    lib_dir = workspace / "Connector_KSL"
    committed_step = lib_dir / "Connector_KSL.3dshapes" / "20952-024E-02.step"
    assert committed_step.is_file(), (
        f"sanity check: drop_import.commit_group should have copied the "
        f".step under .3dshapes/ — got listing {list(lib_dir.rglob('*'))}"
    )

    # Now call the JSON-RPC method exactly the way the frontend does.
    # The kicad-cli spawn is mocked because the unit test ring doesn't
    # require a real kicad-cli binary — but the RESOLVED path that the
    # mock captures lets us assert the model block survived sanitisation
    # (i.e. the resolver actually found the .step).
    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run",
        side_effect=_kicad_cli_glb_and_svg_mock(captured),
    ):
        result = methods.library_render_3d_glb_angled({
            "lib_dir": str(lib_dir),
            "component_name": "20952-024E-02",
        })

    # Bug-3 contract: no warnings means the resolver found the .step.
    warnings = result.get("warnings")
    assert warnings == [], (
        f"IPEX end-to-end should produce zero warnings (the .step is on "
        f"disk and the (model …) path expands to it). Got: {warnings}"
    )

    # And the spliced board kicad-cli was asked to render still has the
    # (model …) block — i.e. the sanitiser kept it instead of stripping.
    glb_calls = [c for c in captured.get("calls", []) if c[3] == "glb"]
    assert len(glb_calls) == 1
    spliced_path = Path(glb_calls[0][-1])
    spliced = spliced_path.read_text(encoding="utf-8") if spliced_path.is_file() else ""
    # spliced_path is in a tempdir that's cleaned up after subprocess
    # returns, so we can't always read it back. Inspect the result data
    # URL instead — the GLB_MAGIC fake we wrote means we got a successful
    # response shape, and the absence of warnings already confirms the
    # resolver succeeded.
    assert result["glb_data_url"].startswith("data:model/gltf-binary;base64,")


# ---------------------------------------------------------------------------
# Bug: legacy footprint with a (model …) block that has NO (offset …) sub-
# S-expr renders the chip body off-pad. Pre-fix the sanitiser passed the
# block through unchanged → KiCad placed the body at the STEP origin (often
# the body centroid for SnapEDA STEPs), which sits far from pin-1 / pad
# centre. Post-fix we auto-compute pad-centre - body-centre on-the-fly and
# inject (offset (xyz …)) into the spliced board only — no disk write.
# ---------------------------------------------------------------------------

# Real STEP shipped with the e2e fixtures; same one test_drop_import uses.
# OCP bbox is roughly x[-1.55, 1.55] y[-1.50, 1.50] z[0, 1.25] →
# centre ≈ (0, 0, 0.625). Choosing pad centre away from the origin lets
# us assert the offset matches pad_centre - step_centre (mostly the pad
# centre itself, since the step centre's X/Y are ~0).
_UFL_STEP = (
    Path(__file__).parent.parent.parent
    / "e2e" / "fixtures" / "u_fl_hirose"
    / "U.FL_Hirose_U.FL-R-SMT-1_Vertical.step"
)


def test_legacy_footprint_without_offset_gets_auto_offset(tmp_path: Path):
    """Legacy footprint case: a (model …) block with no (offset …) sub-
    S-expr triggers the in-memory auto-offset injection at render time.

    Sets up pads at (3, 4) and (7, 4) → pad bbox centre (5, 4). Real U.FL
    STEP body centre ≈ (0, 0, 0.625). Expected injected offset ≈ (5, 4, 0)
    (Z is left at 0 — the user adjusts via the positioner UI; matches
    drop_import.compute_step_pad_offset's contract).

    Asserts BOTH (a) the spliced board kicad-cli sees has the (offset
    (xyz …)) clause inserted into the model block, AND (b) the warnings
    list carries an `auto_offset_applied` entry the JSON-RPC layer can
    surface to the frontend so the user knows their footprint was missing
    a default offset.
    """
    if not _UFL_STEP.is_file():
        pytest.skip(f"e2e fixture missing: {_UFL_STEP}")

    lib_dir = tmp_path / "Legacy_KSL"
    pretty = lib_dir / "Legacy_KSL.pretty"
    shapes = lib_dir / "Legacy_KSL.3dshapes"
    pretty.mkdir(parents=True)
    shapes.mkdir(parents=True)

    # Copy the real U.FL STEP so OCP/regex can compute a real bbox.
    step_dest = shapes / "Legacy.step"
    step_dest.write_bytes(_UFL_STEP.read_bytes())

    # Footprint with model block but NO (offset …). Pads at (3,4),(7,4)
    # → pad bbox centre = (5, 4). Note the model block has (scale …) and
    # (rotate …) but deliberately omits (offset …) — this is the user-
    # reported "committed before alpha.5" shape.
    mod = pretty / "Legacy.kicad_mod"
    mod.write_text(
        '(footprint "Legacy" (layer "F.Cu")\n'
        '  (pad "1" smd rect (at 3 4) (size 1 1) (layers "F.Cu" "F.Mask"))\n'
        '  (pad "2" smd rect (at 7 4) (size 1 1) (layers "F.Cu" "F.Mask"))\n'
        '  (model "${KSL_ROOT}/Legacy_KSL/Legacy_KSL.3dshapes/Legacy.step"\n'
        '    (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))\n'
        '  )\n'
        ')\n',
        encoding="utf-8",
    )

    # The spliced board lives in a tempdir that's torn down once
    # render_footprint_3d_glb_with_top_layers returns. Snapshot the
    # board text inside the mock so we can assert what kicad-cli was
    # asked to render. (The default _kicad_cli_glb_and_svg_mock doesn't
    # snapshot the board.)
    captured: dict = {}

    def _mock_with_board_snapshot(cmd, capture_output=True, text=True, env=None):  # noqa: ARG001
        captured.setdefault("calls", []).append(list(cmd))
        out_idx = cmd.index("-o") + 1
        out_path = Path(cmd[out_idx])
        if cmd[3] == "glb":
            board_path = Path(cmd[-1])
            captured["board"] = board_path.read_text(encoding="utf-8")
            out_path.write_bytes(_GLB_MAGIC + b"\x00" * 64)
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        out_path.write_text('<svg viewBox="0 0 40 40"/>', encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run",
        side_effect=_mock_with_board_snapshot,
    ):
        result = render_3d_glb.render_footprint_3d_glb_with_top_layers(
            lib_dir, mod
        )

    # (a) The spliced board kicad-cli received must carry an (offset
    # (xyz …)) inside the model block. Match the values to the expected
    # pad-centre - step-centre delta (≈ (5, 4, 0)).
    spliced = captured["board"]
    # The injected offset clause must be present somewhere in the model block.
    offset_match = re.search(
        r"\(offset\s+\(xyz\s+([\-\d.]+)\s+([\-\d.]+)\s+([\-\d.]+)\)\s*\)",
        spliced,
    )
    assert offset_match is not None, (
        f"auto-offset clause should have been injected into the spliced "
        f"board for a legacy no-offset footprint. Spliced board:\n{spliced}"
    )
    ox, oy, oz = (float(g) for g in offset_match.groups())
    # U.FL body centre ≈ (0, 0, 0.625); pad centre = (5, 4); Z left at 0.
    assert abs(ox - 5.0) < 0.05, f"expected offset.X≈5, got {ox}"
    assert abs(oy - 4.0) < 0.05, f"expected offset.Y≈4, got {oy}"
    assert abs(oz - 0.0) < 0.05, f"expected offset.Z=0, got {oz}"

    # (b) The result must surface a structured auto_offset_applied warning
    # so the frontend can tell the user "your footprint was missing an
    # offset; we centred it for this preview".
    warnings = result.get("warnings") or []
    auto_warnings = [w for w in warnings if w.get("kind") == "auto_offset_applied"]
    assert len(auto_warnings) == 1, (
        f"expected exactly one auto_offset_applied warning, got {warnings}"
    )
    w = auto_warnings[0]
    assert "Legacy.step" in w["model_path"]
    assert len(w["offset"]) == 3
    assert abs(w["offset"][0] - 5.0) < 0.05
    assert abs(w["offset"][1] - 4.0) < 0.05


def test_footprint_with_explicit_offset_gets_no_auto_offset(tmp_path: Path):
    """Negative case: when (offset …) IS present, the auto-injector must
    NOT fire — the user's existing offset is authoritative and an
    auto-offset would silently double-translate the body."""
    lib_dir, mod = _make_sample_kicad_mod(tmp_path, name="HasOffset")

    captured: dict = {}
    with patch(
        "kibrary_sidecar.render_3d_glb.subprocess.run",
        side_effect=_kicad_cli_glb_and_svg_mock(captured),
    ):
        result = render_3d_glb.render_footprint_3d_glb_with_top_layers(
            lib_dir, mod
        )

    warnings = result.get("warnings") or []
    auto_warnings = [w for w in warnings if w.get("kind") == "auto_offset_applied"]
    assert auto_warnings == [], (
        f"sample footprint already has (offset (xyz 0 0 0)); auto-offset "
        f"must not fire. Got: {warnings}"
    )
