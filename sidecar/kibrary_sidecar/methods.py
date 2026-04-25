from kibrary_sidecar import __version__


def system_ping(_: dict) -> dict:
    return {"pong": True}


def system_version(_: dict) -> dict:
    return {"version": __version__}


REGISTRY = {
    "system.ping": system_ping,
    "system.version": system_version,
}
