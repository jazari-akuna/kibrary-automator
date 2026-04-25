"""
OS keychain integration for Kibrary.

Uses the ``keyring`` package which delegates to the appropriate backend:
  - macOS  → Keychain
  - Windows → Credential Manager
  - Linux  → Secret Service (via SecretStorage) when available,
             or a fallback plaintext file keyring otherwise.

All functions are intentionally exception-safe so callers don't have to
guard against a missing / locked keychain.
"""

import logging
import keyring

log = logging.getLogger(__name__)

SERVICE = "kibrary"


def set_secret(name: str, value: str | None) -> None:
    """Store *value* in the OS keychain under (SERVICE, name).

    If *value* is empty or ``None``, any existing entry is deleted instead
    (idempotent — no error if no entry existed).
    """
    if not value:
        delete_secret(name)
        return
    try:
        keyring.set_password(SERVICE, name, value)
    except Exception:
        log.warning("keyring.set_password failed for %r", name, exc_info=True)


def get_secret(name: str) -> str:
    """Return the stored value, or ``''`` if not set or on any error."""
    try:
        result = keyring.get_password(SERVICE, name)
        return result if result is not None else ""
    except Exception:
        log.warning("keyring.get_password failed for %r", name, exc_info=True)
        return ""


def delete_secret(name: str) -> None:
    """Remove the entry for *name* from the keychain.  Idempotent."""
    try:
        keyring.delete_password(SERVICE, name)
    except keyring.errors.PasswordDeleteError:
        # Entry didn't exist — that's fine.
        pass
    except Exception:
        log.warning("keyring.delete_password failed for %r", name, exc_info=True)
