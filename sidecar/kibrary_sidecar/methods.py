from kibrary_sidecar import __version__
from kibrary_sidecar import workspace as ws


def system_ping(_: dict) -> dict:
    return {"pong": True}


def system_version(_: dict) -> dict:
    return {"version": __version__}


def workspace_open(p: dict) -> dict:
    return ws.open_workspace(p["root"])


def workspace_settings(p: dict) -> dict:
    return {"settings": ws.read_workspace_settings(p["root"])}


REGISTRY = {
    "system.ping": system_ping,
    "system.version": system_version,
    "workspace.open": workspace_open,
    "workspace.settings": workspace_settings,
}
