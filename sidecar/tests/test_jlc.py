from unittest.mock import patch, MagicMock
from pathlib import Path

from kibrary_sidecar.jlc import (
    download_one,
    _download_via_subprocess,
    _resolve_binary,
    _build_args,
    _move_3d_models_to_3dshapes,
)


# ---------------------------------------------------------------------------
# CLI fallback path (legacy contract: subprocess invoked with the right argv)
# ---------------------------------------------------------------------------

def test_download_via_subprocess_runs_jlc2kicadlib(tmp_path: Path):
    with patch("kibrary_sidecar.jlc.subprocess.run") as r:
        r.return_value = MagicMock(returncode=0, stdout="", stderr="")
        ok, err = _download_via_subprocess("C1525", tmp_path / "C1525")
    assert ok is True
    assert err is None
    args = r.call_args[0][0]
    assert "JLC2KiCadLib" in args[0] or args[0].endswith("JLC2KiCadLib")
    assert "C1525" in args


def test_download_via_subprocess_returns_failure_on_nonzero_exit(tmp_path: Path):
    with patch("kibrary_sidecar.jlc.subprocess.run") as r:
        r.return_value = MagicMock(returncode=2, stdout="", stderr="boom")
        ok, err = _download_via_subprocess("C9999", tmp_path / "C9999")
    assert ok is False
    assert "boom" in (err or "")


# ---------------------------------------------------------------------------
# In-process API path (the path PyInstaller bundles use in production)
# ---------------------------------------------------------------------------

def test_download_one_uses_python_api_when_importable(tmp_path: Path):
    """
    download_one() must drive JLC2KiCadLib via add_component(), not via
    subprocess, when the package is importable. This is the prod path.
    """
    fake_add = MagicMock()
    # Pretend the package is importable AND record the call.
    with patch("JLC2KiCadLib.JLC2KiCadLib.add_component", fake_add), \
         patch("kibrary_sidecar.jlc.subprocess.run") as run:
        ok, err = download_one("C25804", tmp_path / "C25804")
    assert ok is True, err
    assert err is None
    # Critical: subprocess must NOT have been called.
    run.assert_not_called()
    # And add_component must have been called with the right LCSC.
    assert fake_add.call_count == 1
    call_lcsc = fake_add.call_args[0][0]
    assert call_lcsc == "C25804"


def test_download_one_emits_progress_callbacks(tmp_path: Path):
    """download_one passes 10 then 70 to the progress callback."""
    seen: list[int] = []

    def progress(pct: int) -> None:
        seen.append(pct)

    with patch("JLC2KiCadLib.JLC2KiCadLib.add_component", MagicMock()):
        ok, err = download_one("C1", tmp_path / "C1", progress=progress)

    assert ok is True, err
    assert 10 in seen
    assert 70 in seen


def test_download_one_returns_clear_error_on_api_exception(tmp_path: Path):
    """If add_component raises, download_one returns ok=False with a useful message."""
    with patch(
        "JLC2KiCadLib.JLC2KiCadLib.add_component",
        side_effect=RuntimeError("upstream 503"),
    ):
        ok, err = download_one("C0", tmp_path / "C0")
    assert ok is False
    assert err is not None
    assert "RuntimeError" in err
    assert "upstream 503" in err


# ---------------------------------------------------------------------------
# Bug 16 (alpha.7): file layout must match what the frontend expects.
#
# JLC2KiCadLib is happy to silently produce nested or wrongly-named output
# (because it treats *_lib_dir as relative-to-output_dir, even when given
# absolutes). This test pins the contract that download_one() produces the
# exact paths read_part_file() / get_3d_info() / SymbolPreview / etc. read.
# ---------------------------------------------------------------------------

def test_build_args_uses_relative_paths_to_avoid_self_nesting():
    """Regression: passing absolute paths to symbol_lib_dir/footprint_lib/model_dir
    causes JLC2KiCadLib to nest the path on itself. Must be '.' or a subdir
    name, never an absolute path."""
    args = _build_args(Path("/abs/staging/C25804"), "C25804")
    assert args.symbol_lib_dir == "."
    assert args.model_dir == "."
    assert args.footprint_lib == "C25804.pretty"
    assert args.symbol_lib == "C25804"


def test_move_3d_models_relocates_step_and_wrl(tmp_path: Path):
    """3D models JLC drops in <lcsc>.pretty/ must be moved into <lcsc>.3dshapes/."""
    pretty = tmp_path / "C25804.pretty"
    pretty.mkdir()
    (pretty / "R0603.kicad_mod").write_text("(footprint stuff)")
    (pretty / "R0603.step").write_bytes(b"ISO-10303-21\n...binary...\n")
    (pretty / "R0603.wrl").write_text("#VRML V2.0 utf8\n")

    _move_3d_models_to_3dshapes(tmp_path, "C25804")

    # .step and .wrl moved out
    assert not (pretty / "R0603.step").exists()
    assert not (pretty / "R0603.wrl").exists()
    assert (tmp_path / "C25804.3dshapes" / "R0603.step").exists()
    assert (tmp_path / "C25804.3dshapes" / "R0603.wrl").exists()
    # .kicad_mod stays put
    assert (pretty / "R0603.kicad_mod").exists()


def test_move_3d_models_no_op_when_pretty_missing(tmp_path: Path):
    """When the .pretty dir doesn't exist (e.g. footprint creation skipped),
    the move is a quiet no-op rather than an error."""
    _move_3d_models_to_3dshapes(tmp_path, "C25804")  # must not raise
    assert not (tmp_path / "C25804.3dshapes").exists()


def test_jlc_resolves_or_returns_clear_error():
    """
    _resolve_binary() either returns a working path OR a sentinel string.
    Pin the resolution contract: it must always return a *string* (never
    None), so callers can pass it to subprocess without further guarding.
    """
    result = _resolve_binary()
    assert isinstance(result, str)
    assert result, "_resolve_binary() must never return an empty string"
    # Either it's a real on-PATH binary, or it's the literal sentinel.
    assert result.endswith("JLC2KiCadLib")


def test_download_one_clear_error_when_neither_api_nor_cli_available(tmp_path: Path, monkeypatch):
    """
    If JLC2KiCadLib is not importable AND not on PATH, download_one
    returns a clear error string explaining the situation rather than
    crashing.
    """
    # Make the API import fail by hiding the module.
    import sys
    real_pkg = sys.modules.pop("JLC2KiCadLib", None)
    real_sub = sys.modules.pop("JLC2KiCadLib.JLC2KiCadLib", None)
    try:
        # Force ImportError by inserting a sentinel that errors on any attribute access.
        class _Boom:
            def __getattr__(self, name):
                raise ImportError("forced-missing")
        sys.modules["JLC2KiCadLib"] = _Boom()  # type: ignore
        sys.modules["JLC2KiCadLib.JLC2KiCadLib"] = _Boom()  # type: ignore

        # And also pretend the CLI shim is not on PATH.
        monkeypatch.setattr("kibrary_sidecar.jlc.shutil.which", lambda _: None)

        ok, err = download_one("C0", tmp_path / "C0")
        assert ok is False
        assert err is not None
        assert "JLC2KiCadLib" in err
    finally:
        # Restore real modules.
        if real_pkg is not None:
            sys.modules["JLC2KiCadLib"] = real_pkg
        else:
            sys.modules.pop("JLC2KiCadLib", None)
        if real_sub is not None:
            sys.modules["JLC2KiCadLib.JLC2KiCadLib"] = real_sub
        else:
            sys.modules.pop("JLC2KiCadLib.JLC2KiCadLib", None)
