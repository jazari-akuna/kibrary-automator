"""
Tests for kibrary_sidecar.category_map (Task 22, spec §7.2–7.3).

Each test isolates the module-level cache by passing _force_reload=True
so that monkeypatched env vars are picked up cleanly.
"""

import json
from pathlib import Path

from kibrary_sidecar.category_map import load_map, suggest_library


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _reload_suggest(category: str) -> str:
    """Shorthand: force-reload the map then suggest."""
    return suggest_library(category, _force_reload=True)


# ---------------------------------------------------------------------------
# Plan-mandated tests (Steps 22.1 / 22.2)
# ---------------------------------------------------------------------------

def test_known_category_routes_to_lib(tmp_path, monkeypatch):
    """A well-known category must resolve to its KSL library."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    assert _reload_suggest("Resistors") == "Resistors_KSL"


def test_unknown_falls_back_to_misc(tmp_path, monkeypatch):
    """An unrecognised category must fall back to Misc_KSL."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    assert _reload_suggest("Definitely Not A Category") == "Misc_KSL"


# ---------------------------------------------------------------------------
# Additional spec coverage
# ---------------------------------------------------------------------------

def test_legacy_alias_works(tmp_path, monkeypatch):
    """Deprecated alias 'Clock/Timing' must resolve to Oscillators_KSL."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    assert _reload_suggest("Clock/Timing") == "Oscillators_KSL"


def test_user_override_takes_precedence(tmp_path, monkeypatch):
    """A user-supplied category-map.json must override the bundled default."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))

    # Write a minimal override into the XDG config dir
    kibrary_dir = tmp_path / "kibrary"
    kibrary_dir.mkdir(parents=True)
    user_map = {
        "Resistors": "MyResistors_KSL",
        "_unknown": "Misc_KSL",
    }
    (kibrary_dir / "category-map.json").write_text(
        json.dumps(user_map), encoding="utf-8"
    )

    # The overridden entry takes priority
    assert _reload_suggest("Resistors") == "MyResistors_KSL"

    # Categories not in the user map fall through to _unknown
    assert _reload_suggest("Capacitors") == "Misc_KSL"


# ---------------------------------------------------------------------------
# Extra coverage: spot-check several entries from spec §7.2
# ---------------------------------------------------------------------------

def test_bundled_default_spot_checks(tmp_path, monkeypatch):
    """Verify a representative slice of the bundled default map."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))

    cases = [
        ("Capacitors",                        "Capacitors_KSL"),
        ("Diodes",                            "Diodes_KSL"),
        ("Connectors",                        "Connectors_KSL"),
        ("Power Management",                  "PowerMgmt_KSL"),   # legacy alias
        ("Power Management (PMIC)",           "PowerMgmt_KSL"),   # canonical name
        ("Crystals, Oscillators, Resonators", "Oscillators_KSL"),
        ("Optoelectronics",                   "Optoelectronic_KSL"),
        ("Silicon Carbide (SiC) Devices",     "SiC_Devices_KSL"),
    ]
    for category, expected in cases:
        assert _reload_suggest(category) == expected, (
            f"suggest_library({category!r}) should be {expected!r}"
        )


def test_load_map_returns_dict(tmp_path, monkeypatch):
    """load_map() must always return a non-empty dict."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    mapping = load_map(_force_reload=True)
    assert isinstance(mapping, dict)
    assert len(mapping) > 0
    assert "_unknown" in mapping
