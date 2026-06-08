"""settings.* and secrets.* handlers."""

from kibrary_sidecar import settings as st
from kibrary_sidecar import secrets


def settings_get(_: dict) -> dict:
    return {"settings": st.read_settings()}


def settings_set(p: dict) -> dict:
    st.write_settings(p["settings"])
    return {"ok": True}


def secrets_get(p: dict) -> dict:
    return {"value": secrets.get_secret(p["name"])}


def secrets_set(p: dict) -> dict:
    secrets.set_secret(p["name"], p["value"])
    return {"ok": True}


def secrets_delete(p: dict) -> dict:
    secrets.delete_secret(p["name"])
    return {"ok": True}


REGISTRY = {
    "settings.get": settings_get,
    "settings.set": settings_set,
    "secrets.get": secrets_get,
    "secrets.set": secrets_set,
    "secrets.delete": secrets_delete,
}
