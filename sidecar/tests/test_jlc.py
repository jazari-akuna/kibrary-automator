from unittest.mock import patch, MagicMock
from pathlib import Path
from kibrary_sidecar.jlc import download_one


def test_download_one_runs_jlc2kicadlib(tmp_path: Path):
    with patch("kibrary_sidecar.jlc.subprocess.run") as r:
        r.return_value = MagicMock(returncode=0, stdout="", stderr="")
        ok, err = download_one("C1525", tmp_path / "C1525")
    assert ok is True
    assert err is None
    assert (tmp_path / "C1525").is_dir()
    args = r.call_args[0][0]
    assert "JLC2KiCadLib" in args[0] or args[0].endswith("JLC2KiCadLib")
    assert "C1525" in args


def test_download_one_returns_failure_on_nonzero_exit(tmp_path):
    with patch("kibrary_sidecar.jlc.subprocess.run") as r:
        r.return_value = MagicMock(returncode=2, stdout="", stderr="boom")
        ok, err = download_one("C9999", tmp_path / "C9999")
    assert ok is False
    assert "boom" in (err or "")
