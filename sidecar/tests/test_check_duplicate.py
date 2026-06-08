"""Unit 3: duplicate-symbol detection at commit (CLI parity, TDD).

The legacy CLI warned the user before adding a symbol that already existed
elsewhere in the workspace. ``library.commit_to_library`` merges silently, so
we add a NON-DESTRUCTIVE pre-commit check the UI can call before committing:

    library.check_duplicate({workspace, lcsc})
      -> {duplicate: bool, library: str|None, component_name: str|None}

It is purely advisory — it does not touch or change commit behaviour. The
detection reuses ``lib_scanner.lcsc_index`` which already maps
``{lcsc: {library, component_name}}``.
"""

from pathlib import Path

from kiutils.symbol import Symbol, SymbolLib


def _make_lib_dir(workspace: Path, lib_name: str, symbols: list[tuple[str, str, str]]) -> Path:
    """Create a minimal <lib_name>/<lib_name>.kicad_sym under *workspace*."""
    lib_dir = workspace / lib_name
    lib_dir.mkdir(parents=True, exist_ok=True)
    lib = SymbolLib()
    for entry_name, ref, val in symbols:
        lib.symbols.append(Symbol.create_new(id=entry_name, reference=ref, value=val))
    lib.to_file(str(lib_dir / f"{lib_name}.kicad_sym"))
    return lib_dir


# ---------------------------------------------------------------------------
# library.check_duplicate (function)
# ---------------------------------------------------------------------------

def test_check_duplicate_reports_existing(tmp_path: Path):
    from kibrary_sidecar.library import check_duplicate

    _make_lib_dir(
        tmp_path,
        "Resistors_KSL",
        [("C25804", "R", "10k 0402"), ("C12345", "R", "4.7k 0402")],
    )

    res = check_duplicate(tmp_path, "C25804")
    assert res["duplicate"] is True
    assert res["library"] == "Resistors_KSL"
    assert res["component_name"] == "C25804"


def test_check_duplicate_reports_none_for_unknown_lcsc(tmp_path: Path):
    from kibrary_sidecar.library import check_duplicate

    _make_lib_dir(tmp_path, "Resistors_KSL", [("C25804", "R", "10k 0402")])

    res = check_duplicate(tmp_path, "C99999999")
    assert res["duplicate"] is False
    assert res["library"] is None
    assert res["component_name"] is None


def test_check_duplicate_empty_workspace(tmp_path: Path):
    from kibrary_sidecar.library import check_duplicate

    res = check_duplicate(tmp_path, "C25804")
    assert res == {"duplicate": False, "library": None, "component_name": None}


# ---------------------------------------------------------------------------
# RPC registration + handler (methods.library_check_duplicate)
# ---------------------------------------------------------------------------

def test_rpc_registered():
    from kibrary_sidecar.methods import REGISTRY

    assert "library.check_duplicate" in REGISTRY
    assert callable(REGISTRY["library.check_duplicate"])


def test_rpc_handler_returns_shape(tmp_path: Path):
    from kibrary_sidecar.methods import library_check_duplicate

    _make_lib_dir(tmp_path, "Caps_KSL", [("C12345", "C", "100nF")])

    hit = library_check_duplicate({"workspace": str(tmp_path), "lcsc": "C12345"})
    assert hit == {
        "duplicate": True,
        "library": "Caps_KSL",
        "component_name": "C12345",
    }

    miss = library_check_duplicate({"workspace": str(tmp_path), "lcsc": "C404"})
    assert miss == {"duplicate": False, "library": None, "component_name": None}
