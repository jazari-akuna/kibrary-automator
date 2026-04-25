"""
Tests for kibrary_sidecar.secrets.

These tests must NOT require a real OS keychain (Secret Service / Keychain /
Credential Manager).  We inject an in-memory backend by subclassing
``keyring.backend.KeyringBackend`` and monkey-patching ``keyring.set_keyring``
before each test.  This is the officially supported way to override the
backend at runtime without modifying environment variables.
"""

import keyring
import keyring.backend
import pytest

from kibrary_sidecar import secrets


# ---------------------------------------------------------------------------
# In-memory keyring backend (no real OS calls)
# ---------------------------------------------------------------------------

class MemoryKeyring(keyring.backend.KeyringBackend):
    """Tiny dict-backed keyring backend for unit tests."""

    priority = 1  # required by the ABC

    def __init__(self):
        self._store: dict[tuple[str, str], str] = {}

    def set_password(self, service: str, username: str, password: str) -> None:
        self._store[(service, username)] = password

    def get_password(self, service: str, username: str) -> str | None:
        return self._store.get((service, username))

    def delete_password(self, service: str, username: str) -> None:
        key = (service, username)
        if key not in self._store:
            raise keyring.errors.PasswordDeleteError(username)
        del self._store[key]


# ---------------------------------------------------------------------------
# Fixture — fresh in-memory keyring for every test
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def memory_keyring(monkeypatch):
    """Replace the real keyring backend with an in-memory one."""
    backend = MemoryKeyring()
    monkeypatch.setattr(keyring, "get_keyring", lambda: backend)

    # set_keyring / get_password / set_password / delete_password are module-
    # level functions that delegate to the active backend; patch them directly
    # so the secrets module (which imports keyring) sees the right backend.
    monkeypatch.setattr(keyring, "get_password", backend.get_password)
    monkeypatch.setattr(keyring, "set_password", backend.set_password)
    monkeypatch.setattr(keyring, "delete_password", backend.delete_password)

    return backend


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_roundtrip():
    """set_secret then get_secret returns the same value."""
    secrets.set_secret("test_key", "hunter2")
    assert secrets.get_secret("test_key") == "hunter2"


def test_get_returns_empty_when_unset():
    """get_secret returns '' for a key that was never stored."""
    assert secrets.get_secret("does_not_exist") == ""


def test_delete_is_idempotent():
    """Calling delete_secret on a missing key does not raise."""
    secrets.delete_secret("never_stored")  # should not raise
    secrets.set_secret("to_delete", "val")
    secrets.delete_secret("to_delete")
    secrets.delete_secret("to_delete")  # second call also silent
    assert secrets.get_secret("to_delete") == ""


def test_set_empty_value_deletes():
    """set_secret('', ...) or set_secret(None, ...) removes any existing entry."""
    secrets.set_secret("my_key", "original_value")
    assert secrets.get_secret("my_key") == "original_value"

    secrets.set_secret("my_key", "")
    assert secrets.get_secret("my_key") == ""

    secrets.set_secret("my_key", "another")
    secrets.set_secret("my_key", None)
    assert secrets.get_secret("my_key") == ""
