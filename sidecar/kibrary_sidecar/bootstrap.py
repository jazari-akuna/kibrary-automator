"""Sidecar bootstrap helpers.

Provides three functions used by the Rust bootstrap layer (via subprocess):
- detect_python: find a python with kibrary_sidecar installed
- install_into_venv: create a venv and install kibrary_sidecar into it
- cached_python_path: read the previously resolved python path from disk cache
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Optional


_PROBE_CODE = "import kibrary_sidecar; print(kibrary_sidecar.__version__)"
_CONFIG_FILE = Path.home() / ".config" / "kibrary" / "python.json"
_PYPI_PACKAGE = "kibrary-sidecar"


def detect_python(candidate_paths: list[str] | None = None) -> dict | None:
    """Try ``python3`` on PATH plus any *candidate_paths*.

    For each candidate, runs::

        <py> -c "import kibrary_sidecar; print(kibrary_sidecar.__version__)"

    and captures the result.

    Returns the first candidate where the import succeeds::

        {"python_path": str, "sidecar_version": str}

    or ``None`` if no candidate has the package installed.
    """
    candidates: list[str] = ["python3"] + (candidate_paths or [])

    # De-duplicate while preserving order, but don't skip explicit candidates
    # entirely — if the caller passes only one entry that equals "python3" we
    # still want to try it once.
    seen: set[str] = set()
    ordered: list[str] = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            ordered.append(c)

    for py in ordered:
        try:
            result = subprocess.run(
                [py, "-c", _PROBE_CODE],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (FileNotFoundError, OSError):
            # Binary doesn't exist or can't be executed — skip.
            continue

        if result.returncode == 0:
            version = result.stdout.strip()
            return {"python_path": py, "sidecar_version": version}

    return None


def install_into_venv(
    target_dir: Path,
    wheel_path: Path | None = None,
    python_for_venv: str = "python3",
) -> dict:
    """Create a virtualenv at *target_dir* and pip-install kibrary_sidecar.

    If *wheel_path* is given, install from that local ``.whl`` file;
    otherwise install from PyPI using the ``kibrary-sidecar`` package name.

    Returns::

        {"python_path": str, "sidecar_version": str, "log": str}

    Raises :class:`subprocess.CalledProcessError` on failure (caller should
    catch and report).
    """
    target_dir = Path(target_dir)
    log_lines: list[str] = []

    # 1. Create the virtualenv.
    venv_cmd = [python_for_venv, "-m", "venv", str(target_dir)]
    log_lines.append(f"+ {' '.join(venv_cmd)}")
    subprocess.check_call(venv_cmd, text=True)

    # 2. Resolve the venv's pip and python paths.
    venv_pip = str(target_dir / "bin" / "pip")
    venv_python = str(target_dir / "bin" / "python")

    # 3. Install the package.
    install_target = str(wheel_path) if wheel_path is not None else _PYPI_PACKAGE
    pip_cmd = [venv_pip, "install", install_target]
    log_lines.append(f"+ {' '.join(pip_cmd)}")
    subprocess.check_call(pip_cmd, text=True)

    # 4. Verify the install and retrieve the version.
    probe = subprocess.run(
        [venv_python, "-c", _PROBE_CODE],
        capture_output=True,
        text=True,
        timeout=10,
    )
    version = probe.stdout.strip() if probe.returncode == 0 else "unknown"
    log_lines.append(f"kibrary_sidecar version: {version}")

    return {
        "python_path": venv_python,
        "sidecar_version": version,
        "log": "\n".join(log_lines),
    }


def cached_python_path() -> Optional[Path]:
    """Return the python path stored in ``~/.config/kibrary/python.json``.

    Returns ``None`` if the file does not exist or cannot be parsed.
    """
    config_file = Path.home() / ".config" / "kibrary" / "python.json"
    if not config_file.exists():
        return None
    try:
        data = json.loads(config_file.read_text())
        return Path(data["python_path"])
    except (json.JSONDecodeError, KeyError, OSError):
        return None
