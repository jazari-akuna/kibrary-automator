from pathlib import Path
from kibrary_sidecar.symfile import read_properties, write_properties

FIX = Path(__file__).parent / "fixtures" / "sample.kicad_sym"


def test_read_returns_known_keys(tmp_path):
    target = tmp_path / "x.kicad_sym"
    target.write_bytes(FIX.read_bytes())
    props = read_properties(target)
    assert "Reference" in props
    assert "Value" in props


def test_write_then_read_roundtrips(tmp_path):
    target = tmp_path / "x.kicad_sym"
    target.write_bytes(FIX.read_bytes())
    write_properties(target, {"Description": "10kΩ 0402 thick film", "Reference": "R?"})
    props = read_properties(target)
    assert props["Description"] == "10kΩ 0402 thick film"
    assert props["Reference"] == "R?"
