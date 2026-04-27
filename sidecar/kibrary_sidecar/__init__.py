# Resolve the package version from installed metadata, falling back to
# pyproject.toml when the source tree is on `sys.path` without an
# accompanying `pip install`.  This used to be a hard-coded literal
# (`__version__ = "26.4.26-alpha.1"`) which silently drifted out of sync
# with `pyproject.toml` and the wheel filename — the user-visible "sidecar
# version" line in the bootstrap log was wrong by several releases.
def _resolve_version() -> str:
    try:
        from importlib.metadata import version as _pkg_version

        return _pkg_version("kibrary-sidecar")
    except Exception:
        # Fall through to pyproject.toml lookup.
        pass
    # Walk up from this file to find pyproject.toml — works whether we're
    # in the source tree (sidecar/kibrary_sidecar/__init__.py →
    # sidecar/pyproject.toml) or in a PyInstaller-extracted _MEI directory
    # if --add-data shipped pyproject.toml (we don't, but the fallback is
    # cheap to keep).
    try:
        import pathlib
        import re

        here = pathlib.Path(__file__).resolve().parent
        for candidate in [here.parent / "pyproject.toml", here / "pyproject.toml"]:
            if candidate.is_file():
                m = re.search(
                    r'^\s*version\s*=\s*"([^"]+)"',
                    candidate.read_text(),
                    re.MULTILINE,
                )
                if m:
                    return m.group(1)
    except Exception:
        pass
    return "0.0.0+unknown"


__version__ = _resolve_version()
