"""search.* handlers (raph.io parts search proxy)."""

import os
import sys

from kibrary_sidecar import settings as st
from kibrary_sidecar import secrets

from kibrary_sidecar.handlers._common import _search_client


def _search_settings() -> tuple[str, str]:
    # Production: the Rust shell injects KIBRARY_SEARCH_API_KEY (the
    # compile-time-embedded key, deobfuscated at startup) into our environment
    # when spawning us. Fall back to the OS keychain for dev runs where the
    # sidecar is launched directly (no Rust shell to set the env var).
    s = st.read_settings().get("search_raph_io", {})
    api_key = os.environ.get("KIBRARY_SEARCH_API_KEY") or secrets.get_secret(
        "search_raph_io_api_key"
    )
    return api_key, s.get("base_url", "https://search.raph.io")


def search_query(p: dict) -> dict:
    api_key, base_url = _search_settings()
    # alpha.15: forward stock_filter when the frontend passes it. None /
    # absent maps to the default `none` upstream so older self-hosted
    # backends are unaffected.
    return _search_client().search(
        p["q"],
        api_key=api_key,
        base_url=base_url,
        stock_filter=p.get("stock_filter"),
    )


def search_prefetch_photos(p: dict) -> dict:
    """Warm the photo LRU for a batch of LCSCs in one RPC. Frontend calls
    this once per `setResults` so thumbnails land ~one IPC RTT sooner.
    """
    api_key, base_url = _search_settings()
    return _search_client().prefetch_photos(
        p.get("lcscs") or [], api_key=api_key, base_url=base_url
    )


def search_get_part(p: dict) -> dict:
    api_key, base_url = _search_settings()
    part = _search_client().get_part(p["lcsc"], api_key=api_key, base_url=base_url)
    return {"part": part}


def search_fetch_photo(p: dict) -> dict:
    """Proxy the auth-gated photo fetch through Python (bypasses webview CORS).

    See ``search_client.fetch_photo`` for the rationale. Returns either
    ``{'data_url': 'data:image/...'}`` or ``{'error': '...'}``.
    """
    api_key, base_url = _search_settings()
    # Diagnostic for the recurring "thumbnails don't load" bug.  An empty
    # api_key here is the cause every time it has happened; logging the
    # length lets the user confirm at a glance whether the Rust shell's
    # env injection survived to this method call.
    print(
        f"[sidecar] search.fetch_photo lcsc={p.get('lcsc')!r} "
        f"api_key_len={len(api_key) if api_key else 0}",
        file=sys.stderr,
        flush=True,
    )
    return _search_client().fetch_photo(p["lcsc"], api_key=api_key, base_url=base_url)


REGISTRY = {
    "search.query": search_query,
    "search.get_part": search_get_part,
    "search.fetch_photo": search_fetch_photo,
    "search.prefetch_photos": search_prefetch_photos,
}
