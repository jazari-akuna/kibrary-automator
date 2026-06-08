"""system.* and bootstrap.* handlers."""

from pathlib import Path

from kibrary_sidecar import __version__
from kibrary_sidecar import bootstrap


def system_ping(_: dict) -> dict:
    return {"pong": True}


def system_version(_: dict) -> dict:
    return {"version": __version__}


def bootstrap_detect(p: dict) -> dict:
    candidates = p.get("candidate_paths") or []
    result = bootstrap.detect_python(candidates)
    return {"detected": result}


def bootstrap_install(p: dict) -> dict:
    target = Path(p["target_dir"])
    wheel = Path(p["wheel_path"]) if p.get("wheel_path") else None
    result = bootstrap.install_into_venv(target, wheel)
    return result


REGISTRY = {
    "system.ping": system_ping,
    "system.version": system_version,
    "bootstrap.detect": bootstrap_detect,
    "bootstrap.install": bootstrap_install,
}
