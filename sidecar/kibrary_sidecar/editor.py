"""KiCad editor spawner — Task 28.

Spawns the appropriate KiCad editor binary for a given file kind,
returning immediately with the child PID.

NB: when running under a PyInstaller-bundled sidecar binary, the runtime
sets ``LD_LIBRARY_PATH`` to its temp ``_MEIPASS`` directory (which
contains its own libssl/libcrypto). If we spawn KiCad GUI editors with
that env inherited, eeschema/pcbnew's libcurl loads PyInstaller's older
libssl and aborts with ``OPENSSL_3.2.0 not found``. Same fix as
:mod:`svg_render` and :mod:`render_3d` — restore the unmodified env via
``_system_env()`` before exec.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from kibrary_sidecar.svg_render import _system_env


def open_editor(install: dict, kind: str, file_path: Path) -> dict:
    """Spawn KiCad to view/edit *file_path*.

    KiCad 9.0 binary semantics:

    - **Footprint editor**: launched via the ``kicad`` project manager
      with ``--frame=fpedit <file>``. The standalone ``pcbnew`` binary's
      ``--footprint-editor`` flag is silently consumed by
      ``wxCmdLineParser`` and pcbnew opens as the PCB editor instead —
      it then fails to load the ``.kicad_mod`` (extension mismatch).
    - **Symbol editor**: KiCad 9 has NO command-line option to load a
      ``.kicad_sym`` into the Symbol Editor. Best we can do is open the
      ``kicad`` project manager; the caller is expected to surface a
      hint toast naming the file path so the user can navigate to it
      via Symbol Editor → File → Open Library.

    Parameters
    ----------
    install:
        An install dict as returned by ``kicad_install.detect_installs()``
        / ``cached_installs()``. Must contain ``kicad_bin`` (the launcher
        binary). The bin value may be either a plain ``str`` or a
        ``list[str]`` (Flatpak case, e.g. ``['flatpak', 'run',
        '--command=kicad', 'org.kicad.KiCad']``).
    kind:
        One of ``'symbol'`` or ``'footprint'``.
    file_path:
        Absolute path to the ``.kicad_sym`` / ``.kicad_mod`` file to open.

    Returns
    -------
    dict
        ``{'pid': int, 'needs_manual_navigation': bool, 'file_hint': str}``.
        ``needs_manual_navigation`` is True for the symbol case (no CLI
        path loads a .kicad_sym, user has to navigate manually). The
        ``file_hint`` is always the absolute file path so the frontend
        can build a useful toast.

    Raises
    ------
    ValueError
        If *kind* is not ``'symbol'`` or ``'footprint'``.
    RuntimeError
        If the install does not have a ``kicad_bin`` (the launcher
        binary). We never silently fall back to the broken
        ``eeschema --symbol-editor`` / ``pcbnew --footprint-editor``
        forms — those don't work in KiCad 9.
    """
    kicad_bin = install.get("kicad_bin")
    if kind == "footprint":
        if kicad_bin is None:
            raise RuntimeError(
                "open_editor: KiCad 'kicad' launcher binary not found in this install — "
                "footprint editor cannot be opened from kibrary."
            )
        if isinstance(kicad_bin, list):
            argv = kicad_bin + ["--frame=fpedit", str(file_path)]
        else:
            argv = [kicad_bin, "--frame=fpedit", str(file_path)]
    elif kind == "symbol":
        if kicad_bin is None:
            raise RuntimeError(
                "open_editor: KiCad 'kicad' launcher binary not found in this install — "
                "cannot open symbol editor."
            )
        # KiCad 9 has no CLI flag to load a .kicad_sym into the symbol
        # editor. Open the project manager and let the caller toast the
        # file path so the user can navigate Symbol Editor → File → Open.
        if isinstance(kicad_bin, list):
            argv = list(kicad_bin)
        else:
            argv = [kicad_bin]
    else:
        raise ValueError(
            f"Unknown editor kind {kind!r}. Expected 'symbol' or 'footprint'."
        )

    # Spawn detached so we return immediately without waiting for the editor
    # to close. DETACHED_PROCESS (0x00000008) is Windows-only; use the raw
    # integer so the constant can be referenced safely on POSIX too.
    _DETACHED_PROCESS = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)

    env = _system_env()
    if sys.platform == "win32":
        proc = subprocess.Popen(
            argv,
            creationflags=_DETACHED_PROCESS,
            env=env,
        )
    else:
        proc = subprocess.Popen(
            argv,
            start_new_session=True,
            env=env,
        )

    # Tell the frontend what we did so it can build a useful toast.
    return {
        "pid": proc.pid,
        "needs_manual_navigation": kind == "symbol",
        "file_hint": str(file_path),
    }
