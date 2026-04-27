"""Tests for bootstrap.py — detection and install helpers. Written TDD (tests first)."""
from pathlib import Path
from unittest.mock import MagicMock, call, patch
import json
import subprocess

import pytest

from kibrary_sidecar.bootstrap import (
    cached_python_path,
    detect_python,
    install_into_venv,
)

# ---------------------------------------------------------------------------
# detect_python
# ---------------------------------------------------------------------------


class TestDetectPython:
    """Tests for detect_python()."""

    def test_detect_python_returns_path_when_sidecar_present(self):
        """Use the real .venv python — kibrary_sidecar IS installed there.

        We pass the venv python as the *only* explicit candidate.  The
        function will also prepend 'python3' from PATH, but either way a
        result must come back with a valid sidecar_version.
        """
        venv_python = str(
            Path(__file__).parent.parent / ".venv" / "bin" / "python"
        )
        result = detect_python(candidate_paths=[venv_python])
        assert result is not None
        # Either PATH python3 or the venv python succeeded — both are valid
        assert result["python_path"] in ("python3", venv_python)
        # The exact version is whatever pyproject.toml currently says — we
        # used to hard-code "0.1.0" here, but `__version__` is now sourced
        # from importlib.metadata to fix the alpha.3 stale-version bug, so
        # we just assert it parses as a non-empty PEP-440-ish string.
        assert isinstance(result["sidecar_version"], str)
        assert result["sidecar_version"]
        assert result["sidecar_version"] != "0.0.0+unknown"

    def test_detect_python_returns_none_when_sidecar_missing(self, monkeypatch):
        """Simulate a python that doesn't have kibrary_sidecar installed."""
        # subprocess.run returns non-zero returncode → no candidate succeeds
        mock_run = MagicMock(
            return_value=MagicMock(returncode=1, stdout="", stderr="ModuleNotFoundError")
        )
        monkeypatch.setattr("kibrary_sidecar.bootstrap.subprocess.run", mock_run)
        result = detect_python(candidate_paths=["/usr/bin/python3"])
        assert result is None

    def test_detect_python_tries_candidates_in_order(self, monkeypatch):
        """Candidates tried in order: first that has the package is returned.

        We pass two explicit candidates; only the second has kibrary_sidecar.
        The function also prepends 'python3' from PATH, so we make any call
        for an executable that isn't '/good/python3' fail — this verifies
        that all preceding candidates were tried and rejected.
        """
        def fake_run(cmd, **kwargs):
            if cmd[0] == "/good/python3":
                return MagicMock(returncode=0, stdout="0.1.0\n", stderr="")
            # PATH python3 and /bad/python3 both fail
            return MagicMock(returncode=1, stdout="", stderr="no module")

        monkeypatch.setattr("kibrary_sidecar.bootstrap.subprocess.run", fake_run)
        result = detect_python(
            candidate_paths=["/bad/python3", "/good/python3"]
        )
        assert result is not None
        assert result["python_path"] == "/good/python3"
        assert result["sidecar_version"] == "0.1.0"

    def test_detect_python_checks_path_python3_first(self, monkeypatch):
        """When no candidate_paths given, tries 'python3' (PATH lookup) first."""
        tried = []

        def fake_run(cmd, **kwargs):
            tried.append(cmd[0])
            return MagicMock(returncode=1, stdout="", stderr="no module")

        monkeypatch.setattr("kibrary_sidecar.bootstrap.subprocess.run", fake_run)
        result = detect_python()
        assert result is None
        assert tried[0] == "python3"

    def test_detect_python_strips_whitespace_from_version(self, monkeypatch):
        """Version output is stripped of surrounding whitespace/newlines."""
        mock_run = MagicMock(
            return_value=MagicMock(returncode=0, stdout="  2.0.0\n", stderr="")
        )
        monkeypatch.setattr("kibrary_sidecar.bootstrap.subprocess.run", mock_run)
        result = detect_python(candidate_paths=["/some/python3"])
        assert result is not None
        assert result["sidecar_version"] == "2.0.0"


# ---------------------------------------------------------------------------
# install_into_venv
# ---------------------------------------------------------------------------


class TestInstallIntoVenv:
    """Tests for install_into_venv()."""

    def test_install_into_venv_creates_venv(self, tmp_path, monkeypatch):
        """Assert that the venv creation subprocess call is made."""
        calls_made = []

        def fake_check_call(cmd, **kwargs):
            calls_made.append(cmd)

        def fake_run(cmd, **kwargs):
            return MagicMock(
                returncode=0, stdout="0.1.0\n", stderr="", check=True
            )

        monkeypatch.setattr(
            "kibrary_sidecar.bootstrap.subprocess.check_call", fake_check_call
        )
        monkeypatch.setattr(
            "kibrary_sidecar.bootstrap.subprocess.run", fake_run
        )

        target = tmp_path / "myvenv"
        install_into_venv(target)

        venv_cmd = calls_made[0]
        assert venv_cmd[0] == "python3"
        assert "-m" in venv_cmd
        assert "venv" in venv_cmd
        assert str(target) in venv_cmd

    def test_install_into_venv_uses_local_wheel_when_provided(self, tmp_path, monkeypatch):
        """When wheel_path is given, pip install command includes that path."""
        calls_made = []

        def fake_check_call(cmd, **kwargs):
            calls_made.append(cmd)

        def fake_run(cmd, **kwargs):
            return MagicMock(returncode=0, stdout="0.1.0\n", stderr="")

        monkeypatch.setattr(
            "kibrary_sidecar.bootstrap.subprocess.check_call", fake_check_call
        )
        monkeypatch.setattr(
            "kibrary_sidecar.bootstrap.subprocess.run", fake_run
        )

        wheel = tmp_path / "kibrary_sidecar-0.1.0-py3-none-any.whl"
        wheel.write_bytes(b"")  # dummy file
        target = tmp_path / "myvenv"

        install_into_venv(target, wheel_path=wheel)

        # Second call should be pip install
        pip_cmd = calls_made[1]
        assert "pip" in pip_cmd[-3] or any("pip" in part for part in pip_cmd)
        assert str(wheel) in pip_cmd

    def test_install_into_venv_uses_pypi_when_no_wheel(self, tmp_path, monkeypatch):
        """When no wheel_path given, pip install command uses the package name."""
        calls_made = []

        def fake_check_call(cmd, **kwargs):
            calls_made.append(cmd)

        def fake_run(cmd, **kwargs):
            return MagicMock(returncode=0, stdout="0.1.0\n", stderr="")

        monkeypatch.setattr(
            "kibrary_sidecar.bootstrap.subprocess.check_call", fake_check_call
        )
        monkeypatch.setattr(
            "kibrary_sidecar.bootstrap.subprocess.run", fake_run
        )

        target = tmp_path / "myvenv"
        install_into_venv(target)

        pip_cmd = calls_made[1]
        assert "kibrary-sidecar" in pip_cmd or "kibrary_sidecar" in pip_cmd

    def test_install_into_venv_returns_dict_with_expected_keys(self, tmp_path, monkeypatch):
        """Return value always has python_path, sidecar_version, log keys."""
        monkeypatch.setattr(
            "kibrary_sidecar.bootstrap.subprocess.check_call",
            lambda cmd, **kw: None,
        )
        monkeypatch.setattr(
            "kibrary_sidecar.bootstrap.subprocess.run",
            lambda cmd, **kw: MagicMock(returncode=0, stdout="1.2.3\n", stderr=""),
        )

        target = tmp_path / "venv"
        result = install_into_venv(target)

        assert "python_path" in result
        assert "sidecar_version" in result
        assert "log" in result
        assert result["sidecar_version"] == "1.2.3"

    def test_install_into_venv_raises_on_failure(self, tmp_path, monkeypatch):
        """CalledProcessError propagates to caller when venv creation fails."""
        def bad_check_call(cmd, **kwargs):
            raise subprocess.CalledProcessError(1, cmd)

        monkeypatch.setattr(
            "kibrary_sidecar.bootstrap.subprocess.check_call", bad_check_call
        )

        with pytest.raises(subprocess.CalledProcessError):
            install_into_venv(tmp_path / "venv")


# ---------------------------------------------------------------------------
# cached_python_path
# ---------------------------------------------------------------------------


class TestCachedPythonPath:
    """Tests for cached_python_path()."""

    def test_cached_python_path_returns_none_when_no_config(self, tmp_path, monkeypatch):
        """Returns None when ~/.config/kibrary/python.json does not exist."""
        monkeypatch.setattr(
            "kibrary_sidecar.bootstrap.Path.home",
            staticmethod(lambda: tmp_path),
        )
        result = cached_python_path()
        assert result is None

    def test_cached_python_path_returns_path_when_config_exists(self, tmp_path, monkeypatch):
        """Returns the resolved python path from ~/.config/kibrary/python.json."""
        config_dir = tmp_path / ".config" / "kibrary"
        config_dir.mkdir(parents=True)
        config_file = config_dir / "python.json"
        config_file.write_text(
            json.dumps({"python_path": str(tmp_path / ".venv" / "bin" / "python")})
        )

        monkeypatch.setattr(
            "kibrary_sidecar.bootstrap.Path.home",
            staticmethod(lambda: tmp_path),
        )
        result = cached_python_path()
        assert result == Path(str(tmp_path / ".venv" / "bin" / "python"))
