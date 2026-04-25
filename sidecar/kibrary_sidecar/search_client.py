"""HTTP client for search.raph.io.

Functions return structured dicts / None rather than raising so that callers
can use the results directly without try/except boilerplate.
"""
from __future__ import annotations

import httpx


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
        with httpx.Client(timeout=timeout) as client:
            response = client.get(
                f"{base_url}/api/search",
                params={"q": query},
                headers=headers,
            )
            response.raise_for_status()
            return response.json()
    except httpx.HTTPStatusError as exc:
        return {"results": [], "error": str(exc)}
    except httpx.HTTPError as exc:
        return {"results": [], "error": str(exc)}


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
        with httpx.Client(timeout=timeout) as client:
            response = client.get(
                f"{base_url}/api/parts/{lcsc}",
                headers=headers,
            )
            if response.status_code == 404:
                return None
            response.raise_for_status()
            return response.json()
    except httpx.HTTPError:
        return None
