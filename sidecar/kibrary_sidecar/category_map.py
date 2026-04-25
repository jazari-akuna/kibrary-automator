"""
category_map.py — LCSC category → KSL library suggestion.

Resolution order:
  1. ~/.config/kibrary/category-map.json (user override, if present)
  2. kibrary_sidecar/data/category_map.default.json (bundled default)

``suggest_library(category)`` returns the mapped library name, or the
value of the ``_unknown`` key (``Misc_KSL``) when the category is not
found in the map.
"""

from __future__ import annotations

import json
import logging
from importlib.resources import files
from pathlib import Path

from kibrary_sidecar.settings import _config_root

logger = logging.getLogger(__name__)

_FALLBACK_KEY = "_unknown"
_FALLBACK_LIB = "Misc_KSL"

# Module-level cache so repeated calls within a process reuse the same map.
_cached_map: dict[str, str] | None = None


def _user_map_path() -> Path:
    return _config_root() / "kibrary" / "category-map.json"


def _load_bundled_default() -> dict[str, str]:
    text = (
        files("kibrary_sidecar")
        .joinpath("data/category_map.default.json")
        .read_text(encoding="utf-8")
    )
    return json.loads(text)


def load_map(*, _force_reload: bool = False) -> dict[str, str]:
    """Return the active category → library mapping.

    Reads the user override file when present; otherwise uses the bundled
    default shipped inside the package.  The result is cached in-process
    after the first call unless ``_force_reload=True`` is passed (used by
    tests to isolate state across test functions).
    """
    global _cached_map

    if _cached_map is not None and not _force_reload:
        return _cached_map

    user_path = _user_map_path()
    if user_path.is_file():
        logger.debug("Loading category map from user override: %s", user_path)
        mapping = json.loads(user_path.read_text(encoding="utf-8"))
    else:
        logger.debug("No user category map found; using bundled default.")
        mapping = _load_bundled_default()

    _cached_map = mapping
    return _cached_map


def suggest_library(category: str, *, _force_reload: bool = False) -> str:
    """Return the suggested KSL library name for *category*.

    Falls back to the ``_unknown`` entry (``Misc_KSL``) and logs a
    warning when the category is not present in the map.
    """
    mapping = load_map(_force_reload=_force_reload)
    if category in mapping:
        return mapping[category]

    fallback = mapping.get(_FALLBACK_KEY, _FALLBACK_LIB)
    logger.warning(
        "Unknown LCSC category %r — falling back to %r. "
        "Add a mapping to ~/.config/kibrary/category-map.json to suppress this.",
        category,
        fallback,
    )
    return fallback
