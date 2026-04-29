"""Tests for kibrary_sidecar.editor — KiCad editor spawner.

All tests patch ``subprocess.Popen`` so no real binary is ever executed.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from kibrary_sidecar.editor import open_editor

# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

FAKE_SYM_FILE = Path("/tmp/fake/C12345/C12345.kicad_sym")
FAKE_FP_FILE = Path("/tmp/fake/C12345/C12345.kicad_mod")

NATIVE_INSTALL = {
    "id": "linux-9.0",
    "type": "linux",
    "version": "9.0",
    "kicad_bin": "/usr/bin/kicad",
    "eeschema_bin": "/usr/bin/eeschema",
    "pcbnew_bin": "/usr/bin/pcbnew",
}

FLATPAK_INSTALL = {
    "id": "flatpak-9.0",
    "type": "flatpak",
    "version": "9.0",
    "kicad_bin": ["flatpak", "run", "--command=kicad", "org.kicad.KiCad"],
    "eeschema_bin": ["flatpak", "run", "--command=eeschema", "org.kicad.KiCad"],
    "pcbnew_bin": ["flatpak", "run", "--command=pcbnew", "org.kicad.KiCad"],
}


def _mock_popen(pid: int = 42) -> MagicMock:
    mock_proc = MagicMock()
    mock_proc.pid = pid
    return mock_proc


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_open_editor_symbol_opens_kicad_launcher(monkeypatch):
    """open_editor('symbol') opens the kicad project manager (no CLI flag
    in KiCad 9 loads a .kicad_sym into the Symbol Editor). The frontend
    is expected to surface a toast pointing at the file path."""
    mock_proc = _mock_popen(101)

    with patch("kibrary_sidecar.editor.subprocess.Popen", return_value=mock_proc) as mock_popen:
        result = open_editor(NATIVE_INSTALL, "symbol", FAKE_SYM_FILE)

    assert result["pid"] == 101
    assert result["needs_manual_navigation"] is True
    assert result["file_hint"] == str(FAKE_SYM_FILE)

    argv = mock_popen.call_args[0][0]
    # Just the launcher — no flag, no file path (KiCad 9 won't accept one
    # for the symbol editor).
    assert argv == ["/usr/bin/kicad"]


def test_open_editor_footprint_uses_kicad_launcher_with_fpedit_frame(monkeypatch):
    """open_editor('footprint') invokes the kicad project manager with
    ``--frame=fpedit <file>``. This opens the Footprint Editor with the
    file pre-loaded. The standalone ``pcbnew --footprint-editor`` form
    is broken in KiCad 9 (flag silently swallowed)."""
    mock_proc = _mock_popen(202)

    with patch("kibrary_sidecar.editor.subprocess.Popen", return_value=mock_proc) as mock_popen:
        result = open_editor(NATIVE_INSTALL, "footprint", FAKE_FP_FILE)

    assert result["pid"] == 202
    assert result["needs_manual_navigation"] is False
    assert result["file_hint"] == str(FAKE_FP_FILE)

    argv = mock_popen.call_args[0][0]
    assert argv == ["/usr/bin/kicad", "--frame=fpedit", str(FAKE_FP_FILE)]


def test_open_editor_flatpak_uses_command_chain(monkeypatch):
    """When the bin is a list (Flatpak), Popen receives the full chain.
    Symbol case = launcher only (no flag, no file)."""
    mock_proc = _mock_popen(303)

    with patch("kibrary_sidecar.editor.subprocess.Popen", return_value=mock_proc) as mock_popen:
        result = open_editor(FLATPAK_INSTALL, "symbol", FAKE_SYM_FILE)

    assert result["pid"] == 303
    assert result["needs_manual_navigation"] is True

    argv = mock_popen.call_args[0][0]
    assert argv == ["flatpak", "run", "--command=kicad", "org.kicad.KiCad"]


def test_open_editor_flatpak_footprint_uses_command_chain(monkeypatch):
    """Flatpak footprint also builds the full chain + ``--frame=fpedit``."""
    mock_proc = _mock_popen(404)

    with patch("kibrary_sidecar.editor.subprocess.Popen", return_value=mock_proc) as mock_popen:
        result = open_editor(FLATPAK_INSTALL, "footprint", FAKE_FP_FILE)

    assert result["pid"] == 404
    assert result["needs_manual_navigation"] is False

    argv = mock_popen.call_args[0][0]
    assert argv == [
        "flatpak", "run", "--command=kicad", "org.kicad.KiCad",
        "--frame=fpedit", str(FAKE_FP_FILE),
    ]


def test_open_editor_invalid_kind_raises(monkeypatch):
    """An unknown kind must raise ValueError."""
    with patch("kibrary_sidecar.editor.subprocess.Popen"):
        with pytest.raises(ValueError, match="Unknown editor kind"):
            open_editor(NATIVE_INSTALL, "schematic", FAKE_SYM_FILE)


def test_open_editor_returns_pid(monkeypatch):
    """Return dict must have a 'pid' key matching the process PID, plus
    the new ``needs_manual_navigation`` and ``file_hint`` fields."""
    mock_proc = _mock_popen(999)

    with patch("kibrary_sidecar.editor.subprocess.Popen", return_value=mock_proc):
        result = open_editor(NATIVE_INSTALL, "symbol", FAKE_SYM_FILE)

    assert "pid" in result
    assert result["pid"] == 999
    assert result["needs_manual_navigation"] is True
    assert result["file_hint"] == str(FAKE_SYM_FILE)


def test_open_editor_detach_flag_on_posix(monkeypatch):
    """On POSIX, Popen must use start_new_session=True (not DETACHED_PROCESS)."""
    monkeypatch.setattr("kibrary_sidecar.editor.sys.platform", "linux")

    mock_proc = _mock_popen(555)

    with patch("kibrary_sidecar.editor.subprocess.Popen", return_value=mock_proc) as mock_popen:
        open_editor(NATIVE_INSTALL, "symbol", FAKE_SYM_FILE)

    kwargs = mock_popen.call_args[1]
    assert kwargs.get("start_new_session") is True
    assert "creationflags" not in kwargs


def test_open_editor_detach_flag_on_windows(monkeypatch):
    """On Windows, Popen must use creationflags=DETACHED_PROCESS (0x00000008)."""
    monkeypatch.setattr("kibrary_sidecar.editor.sys.platform", "win32")

    mock_proc = _mock_popen(666)

    with patch("kibrary_sidecar.editor.subprocess.Popen", return_value=mock_proc) as mock_popen:
        open_editor(NATIVE_INSTALL, "symbol", FAKE_SYM_FILE)

    kwargs = mock_popen.call_args[1]
    # DETACHED_PROCESS = 0x00000008; use raw value so this test works on POSIX too.
    assert kwargs.get("creationflags") == 0x00000008
    assert "start_new_session" not in kwargs


def test_open_editor_raises_when_kicad_launcher_missing(monkeypatch):
    """An install without ``kicad_bin`` must raise RuntimeError. We
    explicitly do NOT silently fall back to ``eeschema``/``pcbnew`` —
    those binaries' editor flags don't work in KiCad 9."""
    install = {**NATIVE_INSTALL, "kicad_bin": None}

    with patch("kibrary_sidecar.editor.subprocess.Popen"):
        with pytest.raises(RuntimeError, match="kicad.*launcher"):
            open_editor(install, "symbol", FAKE_SYM_FILE)
        with pytest.raises(RuntimeError, match="kicad.*launcher"):
            open_editor(install, "footprint", FAKE_FP_FILE)


# ---------------------------------------------------------------------------
# alpha.24 regression: PyInstaller LD_LIBRARY_PATH leak into spawned KiCad
# ---------------------------------------------------------------------------

def test_open_editor_strips_pyinstaller_ld_library_path(monkeypatch):
    """When the bundled sidecar (PyInstaller) sets LD_LIBRARY_PATH to its
    _MEIPASS dir, spawned eeschema/pcbnew must NOT inherit it — their
    libcurl would otherwise load PyInstaller's older libssl and abort
    with 'OPENSSL_3.2.0 not found'. PyInstaller exposes the unmodified
    value as LD_LIBRARY_PATH_ORIG; _system_env() restores it.
    """
    monkeypatch.setenv("LD_LIBRARY_PATH", "/tmp/_MEIxxxx")
    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/usr/lib/x86_64-linux-gnu")

    mock_proc = _mock_popen(777)
    with patch("kibrary_sidecar.editor.subprocess.Popen", return_value=mock_proc) as mock_popen:
        open_editor(NATIVE_INSTALL, "symbol", FAKE_SYM_FILE)

    kwargs = mock_popen.call_args[1]
    env = kwargs.get("env")
    assert env is not None, "open_editor must pass env= to Popen, not inherit"
    assert env.get("LD_LIBRARY_PATH") == "/usr/lib/x86_64-linux-gnu"
    assert "LD_LIBRARY_PATH_ORIG" not in env
