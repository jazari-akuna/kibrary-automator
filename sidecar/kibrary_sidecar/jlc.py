import shutil
import subprocess
from pathlib import Path


def _resolve_binary() -> str:
    return shutil.which("JLC2KiCadLib") or "JLC2KiCadLib"


def download_one(lcsc: str, target_dir: Path) -> tuple[bool, str | None]:
    target_dir.mkdir(parents=True, exist_ok=True)
    cmd = [_resolve_binary(), lcsc,
           "-dir", str(target_dir),
           "-symbol_lib_dir", str(target_dir),
           "-footprint_lib", str(target_dir),
           "-model_dir", str(target_dir)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        return False, proc.stderr.strip() or f"exit code {proc.returncode}"
    return True, None
