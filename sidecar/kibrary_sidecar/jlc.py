"""
JLC2KiCadLib bridge.

We import JLC2KiCadLib's Python API directly (rather than spawning the
console-script ``JLC2KiCadLib`` shim) because PyInstaller bundles the
package's *source* into the onefile binary but does NOT install the
console-script onto PATH inside that binary. Calling the API in-process
also skips the python-startup overhead of the CLI shim.

The package's ``add_component(component_id, args)`` takes an argparse
``Namespace`` with the same attributes as the CLI flags. We construct
that namespace ourselves to avoid argparse round-trips.

Two progress checkpoints are emitted via the optional ``progress`` callback:
  * 10  — JLC2KiCadLib has been called (footprint/symbol fetch beginning)
  * 70  — package returned, post-processing about to start

Final 100% / status flip is emitted by downloader.run_batch on completion.
"""
from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Callable, Optional

log = logging.getLogger(__name__)

# Optional callback signature: (progress: int) -> None, may be None.
ProgressFn = Optional[Callable[[int], None]]


def _resolve_binary() -> str:
    """
    Return a usable identifier for JLC2KiCadLib.

    Order of preference:
      1. The console-script shim if it's on PATH (dev installs).
      2. The literal string ``"JLC2KiCadLib"`` as a sentinel — callers
         that try to ``subprocess.run`` it will get a clear FileNotFound
         (legacy callers / tests still rely on this contract).

    For the in-process Python API we bypass this function entirely; see
    ``download_one``.
    """
    return shutil.which("JLC2KiCadLib") or "JLC2KiCadLib"


def _build_args(target_dir: Path) -> SimpleNamespace:
    """Construct the argparse-compatible Namespace JLC2KiCadLib expects."""
    return SimpleNamespace(
        output_dir=str(target_dir),
        footprint_creation=True,
        symbol_creation=True,
        symbol_lib=None,
        symbol_lib_dir=str(target_dir),
        footprint_lib=str(target_dir),
        models=["STEP"],
        model_dir=str(target_dir),
        skip_existing=False,
        model_base_variable="",
        logging_level="WARNING",
        log_file=False,
    )


def _download_via_api(lcsc: str, target_dir: Path, progress: ProgressFn = None) -> tuple[bool, str | None]:
    """
    Drive JLC2KiCadLib via its public Python API.

    Returns (ok, error_message).
    """
    try:
        # Import lazily so a missing JLC2KiCadLib package surfaces as a
        # clean RuntimeError from this function rather than at module
        # import time (which would break unrelated tests).
        from JLC2KiCadLib.JLC2KiCadLib import add_component  # type: ignore
    except ImportError as exc:
        return False, f"JLC2KiCadLib not importable: {exc}"

    args = _build_args(target_dir)
    if progress is not None:
        try:
            progress(10)
        except Exception:  # pragma: no cover — never let callbacks break us
            log.debug("progress(10) callback raised; ignoring", exc_info=True)

    try:
        add_component(lcsc, args)
    except Exception as exc:  # noqa: BLE001 — third-party can raise anything
        log.exception("JLC2KiCadLib failed for %s", lcsc)
        return False, f"{type(exc).__name__}: {exc}"

    if progress is not None:
        try:
            progress(70)
        except Exception:  # pragma: no cover
            log.debug("progress(70) callback raised; ignoring", exc_info=True)

    return True, None


def _download_via_subprocess(lcsc: str, target_dir: Path) -> tuple[bool, str | None]:
    """
    Legacy code path: spawn the JLC2KiCadLib CLI. Kept for tests and for
    dev environments where the CLI shim is on PATH.
    """
    cmd = [
        _resolve_binary(),
        lcsc,
        "-dir", str(target_dir),
        "-symbol_lib_dir", str(target_dir),
        "-footprint_lib", str(target_dir),
        "-model_dir", str(target_dir),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        return False, proc.stderr.strip() or f"exit code {proc.returncode}"
    return True, None


def download_one(
    lcsc: str,
    target_dir: Path,
    progress: ProgressFn = None,
) -> tuple[bool, str | None]:
    """
    Download symbol/footprint/model for a single LCSC part.

    Prefers the in-process Python API (works inside PyInstaller bundles).
    Falls back to the CLI shim only if the package can't be imported AND
    the CLI is on PATH.

    Args:
      lcsc: JLCPCB component id, e.g. ``"C25804"``.
      target_dir: directory to drop output files into. Will be created.
      progress: optional callback receiving int percentages 0-100.

    Returns:
      (ok, error_message_or_None)
    """
    target_dir.mkdir(parents=True, exist_ok=True)

    # Try the API path first. Capture ImportError separately so the CLI
    # fallback only kicks in if the package is genuinely unavailable.
    try:
        from JLC2KiCadLib.JLC2KiCadLib import add_component  # noqa: F401
        return _download_via_api(lcsc, target_dir, progress=progress)
    except ImportError:
        pass

    # CLI fallback (dev workflows where the package isn't installed but
    # the CLI shim is somehow on PATH — vanishingly rare in production).
    if shutil.which("JLC2KiCadLib"):
        return _download_via_subprocess(lcsc, target_dir)

    return False, (
        "JLC2KiCadLib is not available: neither the Python package nor "
        "the CLI shim could be located. This likely means the sidecar "
        "binary was built without --collect-all JLC2KiCadLib."
    )
