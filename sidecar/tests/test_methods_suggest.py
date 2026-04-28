"""Tests for methods.library_suggest — alpha.18 fuzzy-boost behaviour.

Adds the ≥ 50 % similarity boost: when an existing library is sufficiently
similar to the category-derived name (e.g. `Connector_KSL` for derived
`Connectors_KSL`), the existing library wins as the default suggestion
and the derived name is demoted into `matches` for "create new" UX.
"""

from pathlib import Path

import pytest
from kiutils.symbol import Symbol, SymbolLib

from kibrary_sidecar.methods import library_suggest


# ---------------------------------------------------------------------------
# Helpers — produce minimal library directories under tmp_path
# ---------------------------------------------------------------------------

def _make_lib(workspace: Path, name: str) -> Path:
    lib_dir = workspace / name
    lib_dir.mkdir(parents=True, exist_ok=True)
    sym_path = lib_dir / f"{name}.kicad_sym"
    sym_lib = SymbolLib()
    sym_lib.symbols.append(Symbol.create_new(id="Stub", reference="X", value="x"))
    sym_lib.to_file(str(sym_path))
    return lib_dir


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_no_workspace_returns_derived_only():
    r = library_suggest({"category": "Resistors"})
    assert r["library"]
    assert r["existing"] == []
    assert r["matches"] == []
    assert r["is_existing"] is False


def test_derived_name_already_exists_short_circuits(tmp_path: Path):
    _make_lib(tmp_path, "Resistors_KSL")
    r = library_suggest({"category": "Resistors", "workspace": str(tmp_path)})
    # Derived already exists → no boost, derived stays as the recommendation
    assert r["library"] == "Resistors_KSL"
    assert r["is_existing"] is True


def test_no_existing_libs_no_boost(tmp_path: Path):
    r = library_suggest({"category": "Resistors", "workspace": str(tmp_path)})
    assert r["library"] == "Resistors_KSL"
    assert r["is_existing"] is False
    assert r["existing"] == []


def test_high_similarity_promotes_existing(tmp_path: Path):
    """Connectors_KSL ↔ Connector_KSL is ~94 % similar — boost wins."""
    _make_lib(tmp_path, "Connector_KSL")
    r = library_suggest(
        {"category": "Connectors", "workspace": str(tmp_path)}
    )
    # Category "Connectors" → derived "Connectors_KSL"; existing
    # "Connector_KSL" is >50% similar → boost flips the default.
    assert r["library"] == "Connector_KSL"
    assert r["is_existing"] is True


def test_low_similarity_no_boost(tmp_path: Path):
    """Resistors_KSL vs Caps_KSL is well under 50 % — derived stays default."""
    _make_lib(tmp_path, "Caps_KSL")
    r = library_suggest({"category": "Resistors", "workspace": str(tmp_path)})
    # Derived (Resistors_KSL) wins because Caps_KSL scores too low
    assert r["library"] == "Resistors_KSL"
    assert r["is_existing"] is False
    assert r["existing"] == ["Caps_KSL"]


def test_derived_demoted_into_matches_when_boosted(tmp_path: Path):
    """When the boost flips the recommendation, the derived name surfaces
    in `matches` so the LibPicker dropdown still offers the 'create new'
    branch in case the user wants it."""
    _make_lib(tmp_path, "Connector_KSL")
    r = library_suggest({"category": "Connectors", "workspace": str(tmp_path)})
    # Boost won → derived (Connectors_KSL) is in `matches`.
    assert r["library"] == "Connector_KSL"
    assert "Connectors_KSL" in r["matches"]


def test_higher_score_beats_alphabetical(tmp_path: Path):
    """When two existing libs both clear the threshold, the one closer to
    the derived name wins regardless of alphabetical order."""
    # Connectors_KSL is closer to Connector_KSL than to Conector_KSL
    # (one char vs two). Boost should pick the closer one even though
    # `Conector` is alphabetically earlier.
    _make_lib(tmp_path, "Conector_KSL")
    _make_lib(tmp_path, "Connector_KSL")
    r = library_suggest({"category": "Connectors", "workspace": str(tmp_path)})
    assert r["library"] == "Connector_KSL"


def test_workspace_with_unrelated_libs_no_false_boost(tmp_path: Path):
    """Two libs that share zero meaningful overlap with the derived name
    must NOT trigger a boost just because some characters match."""
    _make_lib(tmp_path, "Misc_KSL")
    _make_lib(tmp_path, "Tools_KSL")
    r = library_suggest({"category": "Resistors", "workspace": str(tmp_path)})
    # Derived = Resistors_KSL. Neither Misc_KSL nor Tools_KSL is similar.
    assert r["library"] == "Resistors_KSL"
    assert r["is_existing"] is False
