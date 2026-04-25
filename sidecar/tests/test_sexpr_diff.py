"""Tests for kibrary_sidecar.sexpr_diff — S-expression diff preview module (Task P3, TDD).

Tests are intentionally written BEFORE the implementation so they drive the API.
Each test builds before/after .kicad_sym content strings using kiutils directly,
then asserts on the list[dict] returned by diff_kicad_sym.
"""

from __future__ import annotations

from kiutils.symbol import Property, Symbol, SymbolLib

import pytest

from kibrary_sidecar.sexpr_diff import diff_kicad_sym


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_lib(*symbols: Symbol) -> str:
    """Build a kicad_sym string containing the given Symbol objects."""
    lib = SymbolLib()
    lib.version = "20231120"
    lib.generator = "test"
    lib.symbols = list(symbols)
    return lib.to_sexpr()


def _sym(name: str, **props: str) -> Symbol:
    """Create a Symbol with the given entryName and property key=value pairs."""
    sym = Symbol(entryName=name, inBom=True, onBoard=True)
    for i, (k, v) in enumerate(props.items()):
        sym.properties.append(Property(key=k, value=v, id=i))
    return sym


def _change_types(changes: list[dict]) -> list[str]:
    return [c["type"] for c in changes]


def _paths(changes: list[dict]) -> list[str]:
    return [c["path"] for c in changes]


# ---------------------------------------------------------------------------
# Test 1: no change → empty list
# ---------------------------------------------------------------------------

def test_diff_no_change_returns_empty():
    sym = _sym("R_10k", Reference="R", Value="10k", Description="10k resistor 0402")
    content = _make_lib(sym)
    result = diff_kicad_sym(content, content)
    assert result == [], f"Expected empty list, got {result}"


# ---------------------------------------------------------------------------
# Test 2: added property (Description present only in after)
# ---------------------------------------------------------------------------

def test_diff_added_property():
    before_sym = _sym("R_10k", Reference="R", Value="10k")
    after_sym = _sym("R_10k", Reference="R", Value="10k", Description="10k 0402")

    result = diff_kicad_sym(_make_lib(before_sym), _make_lib(after_sym))

    assert len(result) == 1
    change = result[0]
    assert change["type"] == "added"
    assert "R_10k" in change["path"]
    assert "Description" in change["path"]
    assert change.get("after") == "10k 0402"
    assert "before" not in change


# ---------------------------------------------------------------------------
# Test 3: removed property
# ---------------------------------------------------------------------------

def test_diff_removed_property():
    before_sym = _sym("R_10k", Reference="R", Value="10k", Description="10k 0402")
    after_sym = _sym("R_10k", Reference="R", Value="10k")

    result = diff_kicad_sym(_make_lib(before_sym), _make_lib(after_sym))

    assert len(result) == 1
    change = result[0]
    assert change["type"] == "removed"
    assert "R_10k" in change["path"]
    assert "Description" in change["path"]
    assert change.get("before") == "10k 0402"
    assert "after" not in change


# ---------------------------------------------------------------------------
# Test 4: modified value (same property key, different value)
# ---------------------------------------------------------------------------

def test_diff_modified_value():
    before_sym = _sym("R_10k", Reference="R", Value="10k", Description="old description")
    after_sym = _sym("R_10k", Reference="R", Value="10k", Description="new description")

    result = diff_kicad_sym(_make_lib(before_sym), _make_lib(after_sym))

    assert len(result) == 1
    change = result[0]
    assert change["type"] == "modified"
    assert "R_10k" in change["path"]
    assert "Description" in change["path"]
    assert change["before"] == "old description"
    assert change["after"] == "new description"


# ---------------------------------------------------------------------------
# Test 5: added symbol (whole symbol new in after)
# ---------------------------------------------------------------------------

def test_diff_added_symbol():
    sym_a = _sym("R_10k", Reference="R", Value="10k")
    sym_b = _sym("C_100n", Reference="C", Value="100n")

    before = _make_lib(sym_a)
    after = _make_lib(sym_a, sym_b)

    result = diff_kicad_sym(before, after)

    assert len(result) == 1
    change = result[0]
    assert change["type"] == "added"
    assert "C_100n" in change["path"]
    # Symbol-level additions have no before
    assert "before" not in change


# ---------------------------------------------------------------------------
# Test 6: removed symbol
# ---------------------------------------------------------------------------

def test_diff_removed_symbol():
    sym_a = _sym("R_10k", Reference="R", Value="10k")
    sym_b = _sym("C_100n", Reference="C", Value="100n")

    before = _make_lib(sym_a, sym_b)
    after = _make_lib(sym_a)

    result = diff_kicad_sym(before, after)

    assert len(result) == 1
    change = result[0]
    assert change["type"] == "removed"
    assert "C_100n" in change["path"]
    # Symbol-level removals have no after
    assert "after" not in change


# ---------------------------------------------------------------------------
# Test 7: multiple mixed changes across multiple symbols
# ---------------------------------------------------------------------------

def test_diff_multiple_changes():
    """Modify a property in sym_a, add sym_c entirely, no change to sym_b."""
    sym_a_before = _sym("R_10k", Reference="R", Value="10k", Description="old")
    sym_a_after = _sym("R_10k", Reference="R", Value="10k", Description="new")
    sym_b = _sym("C_100n", Reference="C", Value="100n")
    sym_c = _sym("L_1uH", Reference="L", Value="1uH")

    before = _make_lib(sym_a_before, sym_b)
    after = _make_lib(sym_a_after, sym_b, sym_c)

    result = diff_kicad_sym(before, after)

    # Exactly 2 changes: modification in R_10k + addition of L_1uH
    assert len(result) == 2

    types = _change_types(result)
    assert "modified" in types
    assert "added" in types

    mod = next(c for c in result if c["type"] == "modified")
    assert "R_10k" in mod["path"]

    add = next(c for c in result if c["type"] == "added")
    assert "L_1uH" in add["path"]
