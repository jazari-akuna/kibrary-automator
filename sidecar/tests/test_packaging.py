import zipfile
from pathlib import Path

import pytest

from kibrary_sidecar.packaging import package_workspace


def _build_workspace(root: Path) -> Path:
    """Create a fake workspace with a library + junk that must be excluded."""
    root.mkdir(parents=True, exist_ok=True)

    # A real library directory with distributable assets.
    lib = root / "Resistors_KSL"
    lib.mkdir()
    (lib / "Resistors_KSL.kicad_sym").write_text("(kicad_symbol_lib)\n")
    pretty = lib / "Resistors_KSL.pretty"
    pretty.mkdir()
    (pretty / "R0603.kicad_mod").write_text("(footprint)\n")

    # Top-level metadata that SHOULD be included.
    (root / "repository.json").write_text('{"libraries": []}')

    # --- junk that must be excluded -------------------------------------
    git = root / ".git"
    git.mkdir()
    (git / "config").write_text("[core]\n")

    kib = root / ".kibrary"
    (kib / "staging").mkdir(parents=True)
    (kib / "staging" / "C123.tmp").write_text("scratch")

    pyc_dir = lib / "__pycache__"
    pyc_dir.mkdir()
    (pyc_dir / "mod.cpython-311.pyc").write_text("bytecode")

    (lib / "stale.pyc").write_text("bytecode")
    (root / ".DS_Store").write_text("junk")

    return root


def test_package_workspace_includes_library_files(tmp_path: Path):
    ws = _build_workspace(tmp_path / "myrepo")
    result = package_workspace(ws, None)
    out_path = Path(result["path"])
    assert out_path.is_file()

    with zipfile.ZipFile(out_path) as zf:
        names = set(zf.namelist())

    assert "Resistors_KSL/Resistors_KSL.kicad_sym" in names
    assert "Resistors_KSL/Resistors_KSL.pretty/R0603.kicad_mod" in names
    assert "repository.json" in names


def test_package_workspace_excludes_junk(tmp_path: Path):
    ws = _build_workspace(tmp_path / "myrepo")
    result = package_workspace(ws, None)
    out_path = Path(result["path"])

    with zipfile.ZipFile(out_path) as zf:
        names = zf.namelist()

    for name in names:
        assert ".git/" not in name and not name.startswith(".git/"), name
        assert ".kibrary/" not in name and not name.startswith(".kibrary/"), name
        assert "__pycache__" not in name, name
        assert not name.endswith(".pyc"), name
        assert ".DS_Store" not in name, name


def test_package_workspace_returns_file_count(tmp_path: Path):
    ws = _build_workspace(tmp_path / "myrepo")
    result = package_workspace(ws, None)
    # 3 distributable files: sym, mod, repository.json
    assert result["file_count"] == 3
    with zipfile.ZipFile(Path(result["path"])) as zf:
        assert len(zf.namelist()) == result["file_count"]


def test_package_workspace_default_output_path(tmp_path: Path):
    ws = _build_workspace(tmp_path / "myrepo")
    result = package_workspace(ws, None)
    # Default: <workspace>/<workspace_name>.zip
    assert Path(result["path"]) == ws / "myrepo.zip"


def test_package_workspace_custom_output_path(tmp_path: Path):
    ws = _build_workspace(tmp_path / "myrepo")
    out = tmp_path / "dist" / "custom.zip"
    result = package_workspace(ws, out)
    assert Path(result["path"]) == out
    assert out.is_file()


def test_package_workspace_does_not_zip_itself(tmp_path: Path):
    """The output .zip placed inside the workspace must not appear in its own
    archive (otherwise repeated runs balloon the archive)."""
    ws = _build_workspace(tmp_path / "myrepo")
    # First run writes <ws>/myrepo.zip; a second run must not include it.
    package_workspace(ws, None)
    result = package_workspace(ws, None)
    with zipfile.ZipFile(Path(result["path"])) as zf:
        assert "myrepo.zip" not in zf.namelist()


def test_package_workspace_missing_dir_raises(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        package_workspace(tmp_path / "nope", None)
