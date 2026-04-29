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
    "id": "linux-8.0",
    "type": "linux",
    "version": "8.0",
    "eeschema_bin": "/usr/bin/eeschema",
    "pcbnew_bin": "/usr/bin/pcbnew",
}

FLATPAK_INSTALL = {
    "id": "flatpak-8.0",
    "type": "flatpak",
    "version": "8.0",
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


def test_open_editor_symbol_uses_eeschema_with_flag(monkeypatch):
    """open_editor('symbol') must call eeschema with --symbol-editor <file>."""
    mock_proc = _mock_popen(101)

    with patch("kibrary_sidecar.editor.subprocess.Popen", return_value=mock_proc) as mock_popen:
        result = open_editor(NATIVE_INSTALL, "symbol", FAKE_SYM_FILE)

    assert result == {"pid": 101}

    call_args = mock_popen.call_args
    argv = call_args[0][0]  # first positional arg → the command list
    assert argv[0] == "/usr/bin/eeschema"
    assert "--symbol-editor" in argv
    assert str(FAKE_SYM_FILE) in argv


def test_open_editor_footprint_uses_pcbnew_with_flag(monkeypatch):
    """open_editor('footprint') must call pcbnew with --footprint-editor <file>."""
    mock_proc = _mock_popen(202)

    with patch("kibrary_sidecar.editor.subprocess.Popen", return_value=mock_proc) as mock_popen:
        result = open_editor(NATIVE_INSTALL, "footprint", FAKE_FP_FILE)

    assert result == {"pid": 202}

    argv = mock_popen.call_args[0][0]
    assert argv[0] == "/usr/bin/pcbnew"
    assert "--footprint-editor" in argv
    assert str(FAKE_FP_FILE) in argv


def test_open_editor_flatpak_uses_command_chain(monkeypatch):
    """When the bin is a list (Flatpak), Popen receives the full chain + flag + path."""
    mock_proc = _mock_popen(303)

    with patch("kibrary_sidecar.editor.subprocess.Popen", return_value=mock_proc) as mock_popen:
        result = open_editor(FLATPAK_INSTALL, "symbol", FAKE_SYM_FILE)

    assert result == {"pid": 303}

    argv = mock_popen.call_args[0][0]
    # The Flatpak prefix must appear at the start
    assert argv[:4] == ["flatpak", "run", "--command=eeschema", "org.kicad.KiCad"]
    assert "--symbol-editor" in argv
    assert str(FAKE_SYM_FILE) in argv


def test_open_editor_flatpak_footprint_uses_command_chain(monkeypatch):
    """Flatpak footprint also builds the full chain."""
    mock_proc = _mock_popen(404)

    with patch("kibrary_sidecar.editor.subprocess.Popen", return_value=mock_proc) as mock_popen:
        result = open_editor(FLATPAK_INSTALL, "footprint", FAKE_FP_FILE)

    assert result == {"pid": 404}

    argv = mock_popen.call_args[0][0]
    assert argv[:4] == ["flatpak", "run", "--command=pcbnew", "org.kicad.KiCad"]
    assert "--footprint-editor" in argv
    assert str(FAKE_FP_FILE) in argv


def test_open_editor_invalid_kind_raises(monkeypatch):
    """An unknown kind must raise ValueError."""
    with patch("kibrary_sidecar.editor.subprocess.Popen"):
        with pytest.raises(ValueError, match="Unknown editor kind"):
            open_editor(NATIVE_INSTALL, "schematic", FAKE_SYM_FILE)


def test_open_editor_returns_pid(monkeypatch):
    """Return dict must have a 'pid' key matching the process PID."""
    mock_proc = _mock_popen(999)

    with patch("kibrary_sidecar.editor.subprocess.Popen", return_value=mock_proc):
        result = open_editor(NATIVE_INSTALL, "symbol", FAKE_SYM_FILE)

    assert "pid" in result
    assert result["pid"] == 999


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
