"""HTTP client for search.raph.io.

Functions return structured dicts / None rather than raising so that callers
can use the results directly without try/except boilerplate.

Performance notes
-----------------
A module-scoped ``httpx.Client`` is reused across calls so the TLS handshake
to ``search.raph.io`` is amortised across N parallel ``fetch_photo`` calls
(SearchPanel routinely fires 5-10 of these in a burst).  ``httpx.Client`` is
thread-safe for concurrent ``get()`` calls; the connection pool is the win.

A small LRU cache on ``fetch_photo`` covers the "user re-types the same
query" case — the upstream JPEG hasn't changed, no point re-fetching and
re-base64-encoding 50 KB.
"""
from __future__ import annotations

import base64
import threading
from collections import OrderedDict

import httpx


# ---------------------------------------------------------------------------
# Module-scoped HTTP client (connection pool reuse).
#
# httpx.Client lazily opens connections; the first call pays the TLS cost,
# every subsequent call reuses the keepalive connection.  We never close it
# — the sidecar process owns its lifetime.
# ---------------------------------------------------------------------------
_CLIENT: httpx.Client | None = None
_CLIENT_LOCK = threading.Lock()


def _client() -> httpx.Client:
    global _CLIENT
    if _CLIENT is None:
        with _CLIENT_LOCK:
            if _CLIENT is None:
                _CLIENT = httpx.Client(
                    timeout=10.0,
                    limits=httpx.Limits(
                        max_connections=16,
                        max_keepalive_connections=8,
                    ),
                )
    return _CLIENT


# ---------------------------------------------------------------------------
# Photo LRU cache (lcsc → data_url).
#
# Cap to PHOTO_CACHE_MAX entries to bound memory; each entry is ~70 KB
# (50 KB JPEG + 33% base64 overhead) so 256 entries ≈ 18 MB worst case.
# ---------------------------------------------------------------------------
PHOTO_CACHE_MAX = 256
_photo_cache: "OrderedDict[str, str]" = OrderedDict()
_photo_cache_lock = threading.Lock()


def _cache_get(lcsc: str) -> str | None:
    with _photo_cache_lock:
        if lcsc in _photo_cache:
            _photo_cache.move_to_end(lcsc)
            return _photo_cache[lcsc]
    return None


def _cache_put(lcsc: str, data_url: str) -> None:
    with _photo_cache_lock:
        _photo_cache[lcsc] = data_url
        _photo_cache.move_to_end(lcsc)
        while len(_photo_cache) > PHOTO_CACHE_MAX:
            _photo_cache.popitem(last=False)


def _cache_clear() -> None:
    """Test helper — wipe the LRU between cases that assert HTTP calls."""
    with _photo_cache_lock:
        _photo_cache.clear()


def search(
    query: str,
    api_key: str,
    base_url: str = "https://search.raph.io",
    timeout: float = 5.0,
) -> dict:
    """Search for parts matching *query*.

    Returns ``{'results': [...]}`` on success, or
    ``{'results': [], 'error': '...'}`` on any failure.
    Returns ``{'results': []}`` immediately if *api_key* is empty
    (graceful degradation — user hasn't configured search yet).
    """
    if not api_key:
        return {"results": []}

    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        response = _client().get(
            f"{base_url}/api/search",
            params={"q": query},
            headers=headers,
            timeout=timeout,
        )
        response.raise_for_status()
        return response.json()
    except httpx.HTTPStatusError as exc:
        return {"results": [], "error": str(exc)}
    except httpx.HTTPError as exc:
        return {"results": [], "error": str(exc)}


def fetch_photo(
    lcsc: str,
    api_key: str,
    base_url: str = "https://search.raph.io",
    timeout: float = 10.0,
) -> dict:
    """Fetch the auth-gated thumbnail for *lcsc* and return it as a data URL.

    Browser ``fetch()`` from a Tauri webview to ``search.raph.io`` is blocked
    by CORS (the server only allow-lists ``http://localhost:3000``), so we
    proxy the request through Python where no CORS rules apply. The frontend
    receives a self-contained ``data:image/...;base64,...`` URL it can drop
    straight into ``<img src>`` — no Bearer header, no blob lifecycle.

    Returns ``{'data_url': '...'}`` on success, ``{'error': '...'}`` on
    failure, or ``{'data_url': None}`` if *api_key* is empty.

    A successful fetch is cached in-process (LRU, 256 entries) so re-typing
    the same query doesn't re-hit the upstream.
    """
    if not api_key:
        return {"data_url": None}

    cached = _cache_get(lcsc)
    if cached is not None:
        return {"data_url": cached}

    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        response = _client().get(
            f"{base_url}/api/kibrary/parts/{lcsc}/photo",
            headers=headers,
            timeout=timeout,
        )
        if response.status_code == 404:
            return {"data_url": None}
        response.raise_for_status()
        content_type = response.headers.get("content-type", "image/jpeg")
        b64 = base64.b64encode(response.content).decode("ascii")
        data_url = f"data:{content_type};base64,{b64}"
        _cache_put(lcsc, data_url)
        return {"data_url": data_url}
    except httpx.HTTPError as exc:
        return {"error": str(exc)}


def get_part(
    lcsc: str,
    api_key: str,
    base_url: str = "https://search.raph.io",
    timeout: float = 5.0,
) -> dict | None:
    """Fetch part metadata from ``/api/parts/<lcsc>``.

    Returns the part metadata dict on success, or ``None`` if:
    - *api_key* is empty
    - the part is not found (404)
    - the server is unreachable / returns any error
    """
    if not api_key:
        return None

    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        response = _client().get(
            f"{base_url}/api/parts/{lcsc}",
            headers=headers,
            timeout=timeout,
        )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()
    except httpx.HTTPError:
        return None
