"""KiCad editor spawner — Task 28.

Spawns the appropriate KiCad editor binary for a given file kind,
returning immediately with the child PID.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def open_editor(install: dict, kind: str, file_path: Path) -> dict:
    """Spawn the KiCad editor binary appropriate for *kind*.

    Parameters
    ----------
    install:
        An install dict as returned by ``kicad_install.detect_installs()``
        / ``cached_installs()``.  Must contain ``eeschema_bin`` (for
        ``'symbol'``) or ``pcbnew_bin`` (for ``'footprint'``).  The bin
        value may be either a plain ``str`` or a ``list[str]`` (Flatpak
        case, e.g. ``['flatpak', 'run', '--command=eeschema',
        'org.kicad.KiCad']``).
    kind:
        One of ``'symbol'`` or ``'footprint'``.
    file_path:
        Absolute path to the ``.kicad_sym`` / ``.kicad_mod`` file to open.

    Returns
    -------
    dict
        ``{'pid': int}`` — the PID of the spawned process.

    Raises
    ------
    ValueError
        If *kind* is not ``'symbol'`` or ``'footprint'``.
    """
    if kind == "symbol":
        raw_bin = install["eeschema_bin"]
        flag = "--symbol-editor"
    elif kind == "footprint":
        raw_bin = install["pcbnew_bin"]
        flag = "--footprint-editor"
    else:
        raise ValueError(f"Unknown editor kind {kind!r}. Expected 'symbol' or 'footprint'.")

    # Build the argv list.  The bin may be a string (native) or a list
    # (Flatpak, where it encodes e.g. ['flatpak', 'run', '--command=eeschema',
    # 'org.kicad.KiCad']).
    if isinstance(raw_bin, list):
        argv = raw_bin + [flag, str(file_path)]
    else:
        argv = [raw_bin, flag, str(file_path)]

    # Spawn detached so we return immediately without waiting for the editor
    # to close.  DETACHED_PROCESS (0x00000008) is Windows-only; use the raw
    # integer so the constant can be referenced safely on POSIX too.
    _DETACHED_PROCESS = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)

    if sys.platform == "win32":
        proc = subprocess.Popen(
            argv,
            creationflags=_DETACHED_PROCESS,
        )
    else:
        proc = subprocess.Popen(
            argv,
            start_new_session=True,
        )

    return {"pid": proc.pid}
